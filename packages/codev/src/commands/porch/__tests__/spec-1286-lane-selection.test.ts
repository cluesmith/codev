/**
 * Spec 1286, Phase 5 — porch lane-selection resolver consolidation.
 *
 * Covers spec scenarios 4 (`modelsByType`), 5 (`byProtocol` / the PIR CMAP-2 cost guard),
 * 6 (the precedence ladder), 7 (`none`/`parent` at every level), 8 (next/done agreement) and
 * 11 (an invalid lane name rejected from BOTH commands).
 *
 * `porch next` and `porch done` each used to carry their own copy of this precedence logic, and the
 * copies had drifted. That is the failure this file exists to prevent: when `next` emits one lane
 * set and `done` demands another, porch deadlocks in a way the user cannot diagnose, because
 * neither command prints the set it derived.
 *
 * Note what became testable. The old suite opens with "resolveConsultationModels is private to
 * next.ts, so we test it indirectly through the config system" — it could only ever assert that
 * config *loaded*, never that porch *resolved*. One shared exported resolver is what turns the
 * precedence ladder into something a test can address directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveConsultationModels } from '../config.js';
import { next } from '../next.js';
import { done } from '../index.js';
import { writeState, getStatusPath } from '../state.js';

const PROTOCOL_LANES = ['gemini', 'codex', 'claude'];

let root: string;
let origHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec1286-lanes-'));
  origHome = process.env.HOME;
  // Point HOME at an empty dir: the user's real ~/.codev/config.json is one of the five layers
  // loadConfig merges, so without this the developer's own lane config decides these assertions.
  process.env.HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>): void {
  const dir = path.join(root, '.codev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
}

/** Declare a protocol on disk so `byProtocol` / `modelsByType` key discovery can validate it. */
function writeProtocol(name: string, verifyTypes: string[]): void {
  const dir = path.join(root, 'codev', 'protocols', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'protocol.json'), JSON.stringify({
    name,
    phases: verifyTypes.map((type) => ({
      id: `phase_${type}`,
      verify: { type, models: PROTOCOL_LANES },
    })),
  }));
}

function resolve(protocol: string, reviewType: string | undefined) {
  return resolveConsultationModels(root, PROTOCOL_LANES, protocol, reviewType);
}

describe('scenario 4 — modelsByType narrows the lanes for one review type', () => {
  beforeEach(() => writeProtocol('spir', ['spec', 'plan', 'impl', 'pr']));

  it('uses the type-scoped list for the matching review type', () => {
    writeConfig({ porch: { consultation: { modelsByType: { impl: ['codex'] } } } });
    expect(resolve('spir', 'impl')).toEqual({ models: ['codex'], mode: 'normal' });
  });

  it('leaves every OTHER review type on the protocol default', () => {
    writeConfig({ porch: { consultation: { modelsByType: { impl: ['codex'] } } } });
    // The narrowing must not leak: a config that quietly reduced `spec` to one lane too would
    // still satisfy the assertion above while silently halving review coverage elsewhere.
    expect(resolve('spir', 'spec').models).toEqual(PROTOCOL_LANES);
    expect(resolve('spir', 'pr').models).toEqual(PROTOCOL_LANES);
  });
});

describe('scenario 5 — byProtocol scoping (the PIR CMAP-2 cost invariant)', () => {
  beforeEach(() => {
    writeProtocol('spir', ['impl']);
    writeProtocol('pir', ['impl']);
  });

  it('scopes a workspace-wide list down for one protocol only', () => {
    // This is the exact shape the spec calls out: a SPIR-tuned three-lane list set project-wide
    // would otherwise silently inflate PIR, whose whole design point is a two-lane footprint.
    writeConfig({
      porch: {
        consultation: {
          models: ['gemini', 'codex', 'claude'],
          byProtocol: { pir: { models: ['gemini', 'codex'] } },
        },
      },
    });

    expect(resolve('pir', 'impl').models).toEqual(['gemini', 'codex']);
    expect(resolve('spir', 'impl').models).toEqual(['gemini', 'codex', 'claude']);
  });
});

describe('scenario 6 — the four-level precedence ladder', () => {
  beforeEach(() => writeProtocol('spir', ['impl']));

  // Each level is spelled with a DISTINCT lane set, so a wrong answer names which level won
  // rather than just failing.
  const full = {
    porch: {
      consultation: {
        models: ['gemini'],
        modelsByType: { impl: ['codex'] },
        byProtocol: {
          spir: {
            models: ['claude'],
            modelsByType: { impl: ['gemini', 'codex', 'claude'] },
          },
        },
      },
    },
  };

  it('most specific wins with all four levels populated', () => {
    writeConfig(full);
    expect(resolve('spir', 'impl').models).toEqual(['gemini', 'codex', 'claude']);
  });

  it('falls through each level in the documented order as levels are removed', () => {
    const byProtocolModels = { ...full.porch.consultation, byProtocol: { spir: { models: ['claude'] } } };
    writeConfig({ porch: { consultation: byProtocolModels } });
    expect(resolve('spir', 'impl').models).toEqual(['claude']);

    const { byProtocol: _dropped, ...noByProtocol } = byProtocolModels;
    writeConfig({ porch: { consultation: noByProtocol } });
    expect(resolve('spir', 'impl').models).toEqual(['codex']);

    writeConfig({ porch: { consultation: { models: ['gemini'] } } });
    expect(resolve('spir', 'impl').models).toEqual(['gemini']);

    writeConfig({});
    expect(resolve('spir', 'impl').models).toEqual(PROTOCOL_LANES);
  });

  it('ignores a type-scoped entry that does not match the review type', () => {
    writeConfig({ porch: { consultation: { models: ['gemini'], modelsByType: { pr: ['codex'] } } } });
    expect(resolve('spir', 'impl').models).toEqual(['gemini']);
  });
});

describe('scenario 7 — none / parent at every level', () => {
  beforeEach(() => {
    writeProtocol('spir', ['impl']);
    writeProtocol('pir', ['impl']);
  });

  it('honours "none" and "parent" at the top level', () => {
    writeConfig({ porch: { consultation: { models: 'none' } } });
    expect(resolve('spir', 'impl')).toEqual({ models: [], mode: 'none' });

    writeConfig({ porch: { consultation: { models: 'parent' } } });
    expect(resolve('spir', 'impl')).toEqual({ models: [], mode: 'parent' });
  });

  it('honours "none" scoped to one protocol, leaving others running', () => {
    writeConfig({
      porch: { consultation: { models: ['gemini', 'codex'], byProtocol: { pir: { models: 'none' } } } },
    });
    expect(resolve('pir', 'impl')).toEqual({ models: [], mode: 'none' });
    expect(resolve('spir', 'impl')).toEqual({ models: ['gemini', 'codex'], mode: 'normal' });
  });

  it('honours "none" scoped to one review type', () => {
    writeConfig({ porch: { consultation: { modelsByType: { impl: 'none' } } } });
    expect(resolve('spir', 'impl')).toEqual({ models: [], mode: 'none' });
    expect(resolve('spir', undefined).models).toEqual(PROTOCOL_LANES);
  });
});

describe('scenario 11 — an invalid lane name is rejected, not silently dropped', () => {
  beforeEach(() => writeProtocol('spir', ['impl']));

  it('rejects a typo in modelsByType, naming the valid lanes', () => {
    writeConfig({ porch: { consultation: { modelsByType: { impl: ['codexx'] } } } });
    expect(() => resolve('spir', 'impl')).toThrow(/codexx/);
    expect(() => resolve('spir', 'impl')).toThrow(/codex/);
  });

  it('rejects a typo scoped under byProtocol', () => {
    writeConfig({ porch: { consultation: { byProtocol: { spir: { models: ['gemeni'] } } } } });
    expect(() => resolve('spir', 'impl')).toThrow(/gemeni/);
  });

  it('throws rather than falling back to protocol defaults', () => {
    // The regression this pins is `porch done`'s deleted `catch`, which turned exactly this error
    // into a silent fall-back — so a typo changed which lanes porch demanded without saying so.
    writeConfig({ porch: { consultation: { models: ['nope'] } } });
    expect(() => resolve('spir', 'impl')).toThrow();
  });
});

describe('scenario 8 — next and done cannot disagree', () => {
  beforeEach(() => {
    writeProtocol('spir', ['impl']);
    writeProtocol('pir', ['impl']);
  });

  it('single-string config yields a real one-lane list, not a bare string', () => {
    // The concrete shape of the old drift: `next` normalized "codex" to ["codex"] while `done`
    // assigned the string through, so `done` iterated its characters looking for review files.
    writeConfig({ porch: { consultation: { models: 'codex' } } });
    const resolved = resolve('spir', 'impl');
    expect(Array.isArray(resolved.models)).toBe(true);
    expect(resolved.models).toEqual(['codex']);
  });
});

describe('scenario 8 — next emits exactly the lanes done enforces (end to end)', () => {
  // Asserting that one shared function equals itself would prove nothing. These drive the REAL
  // `next()` and `done()`, so they would still fail if a future edit reintroduced a private copy
  // in either command — which is the regression the consolidation exists to prevent.

  // `done()` reports a missing review by calling `process.exit(1)`, NOT by throwing (index.ts,
  // the missingModels branch). An unmocked `.rejects.toThrow()` therefore cannot intercept it —
  // it tears down the vitest worker instead, and the suite's green tick means nothing. Found by
  // codex; same convention as done-verification.test.ts.
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  const protocol = {
    name: 'spir',
    version: '1.0.0',
    phases: [{
      id: 'specify',
      name: 'Specify',
      type: 'build_verify',
      build: { prompt: 'specify.md', artifact: 'codev/specs/${PROJECT_ID}-*.md' },
      verify: { type: 'spec', models: PROTOCOL_LANES },
      max_iterations: 1,
      next: null,
    }],
  };

  function setupProject(): void {
    const dir = path.join(root, 'codev', 'protocols', 'spir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'protocol.json'), JSON.stringify(protocol));

    const statusPath = getStatusPath(root, '0001', 'lane-agreement');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, {
      id: '0001',
      title: 'lane-agreement',
      protocol: 'spir',
      phase: 'specify',
      plan_phases: [],
      current_plan_phase: null,
      gates: {},
      iteration: 1,
      build_complete: true, // sit at the verify step, where lanes are chosen
      history: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const specDir = path.join(root, 'codev', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, '0001-lane-agreement.md'), '# spec\n');
  }

  /** The lanes `porch next` actually asks the builder to run, read out of its consult commands. */
  async function lanesFromNext(): Promise<string[]> {
    const response = await next(root, '0001');
    const text = JSON.stringify(response);
    return PROTOCOL_LANES.filter((lane) => text.includes(`consult -m ${lane} `));
  }

  it('narrowed by modelsByType: next emits one lane, and done is satisfied by that one file', async () => {
    setupProject();
    writeConfig({ porch: { consultation: { modelsByType: { spec: ['codex'] } } } });

    expect(await lanesFromNext()).toEqual(['codex']);

    // Satisfy done with exactly what next asked for. If done still wanted three lanes — the old
    // duplicate's behavior — it would reject this as incomplete.
    const projectDir = path.join(root, 'codev', 'projects', '0001-lane-agreement');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-codex.txt'), 'VERDICT: APPROVE\n');

    await expect(done(root, '0001')).resolves.not.toThrow();
  });

  it('unconfigured: next emits all three lanes and done requires all three', async () => {
    setupProject();
    writeConfig({});

    expect(await lanesFromNext()).toEqual(PROTOCOL_LANES);

    // Only two of the three review files — done must refuse, or the narrowing test above proves
    // nothing (a `done` that accepts anything would pass it too).
    const projectDir = path.join(root, 'codev', 'projects', '0001-lane-agreement');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-codex.txt'), 'VERDICT: APPROVE\n');
    fs.writeFileSync(path.join(projectDir, '0001-specify-iter1-claude.txt'), 'VERDICT: APPROVE\n');

    // Specifically the exit-1 verification refusal, not any error: asserting a bare throw would
    // also be satisfied by an unrelated crash during setup.
    await expect(done(root, '0001')).rejects.toThrow('process.exit(1)');
  });

  it('malformed config fails done LOUDLY instead of falling back to protocol defaults', async () => {
    // The phase's one deliberate behavior change, and the only part with real regression risk, so
    // it is pinned through `done()` itself rather than through the resolver alone (claude's point:
    // testing the wrapper cannot prove the deleted `catch` is gone from the call site).
    //
    // Before: `done` swallowed this and quietly demanded the protocol's three lanes, while `next`
    // refused to run at all — a config typo split the two commands with no message explaining why.
    setupProject();
    writeConfig({ porch: { consultation: { models: ['codexx'] } } });

    await expect(done(root, '0001')).rejects.toThrow(/codexx/);
  });
});
