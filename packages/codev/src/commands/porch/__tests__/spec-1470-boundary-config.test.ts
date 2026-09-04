/**
 * Spec 1470, Phase 1 — context-refresh boundary declaration and validation.
 *
 * These tests drive validation through `loadProtocol` against on-disk fixtures
 * rather than calling `normalizeProtocol` directly. `normalizeProtocol` is not
 * exported, and exporting it purely for tests would widen the module's API to
 * make an internal reachable; going through `loadProtocol` also exercises the
 * path porch actually takes, including JSON parsing and the file resolver.
 *
 * The rejection tests carry the weight here. Porch has no runtime schema
 * validation — `protocol-schema.json` is editor tooling — so this normalizer is
 * the only place an unresolvable boundary can be caught. An uncaught one
 * produces a feature that is configured, reports no error, and silently never
 * fires; and a context refresh that does not happen is invisible by nature,
 * because the builder simply keeps accumulating context.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { loadProtocol } from '../protocol.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A SPIR-shaped protocol: a per_plan_phase phase plus ordinary ones. */
function baseProtocol(contextRefresh?: unknown): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: 'fixture-protocol',
    version: '1.0.0',
    description: 'fixture',
    phases: [
      { id: 'specify', name: 'Specify', type: 'build_verify' },
      { id: 'plan', name: 'Plan', type: 'build_verify' },
      { id: 'implement', name: 'Implement', type: 'per_plan_phase' },
      { id: 'review', name: 'Review', type: 'build_verify' },
    ],
  };
  if (contextRefresh !== undefined) p.context_refresh = contextRefresh;
  return p;
}

/** A protocol with NO per_plan_phase phase — BUGFIX/AIR shaped. */
function flatProtocol(contextRefresh?: unknown): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: 'fixture-protocol',
    version: '1.0.0',
    description: 'fixture',
    phases: [
      { id: 'fix', name: 'Fix', type: 'once' },
      { id: 'review', name: 'Review', type: 'build_verify' },
    ],
  };
  if (contextRefresh !== undefined) p.context_refresh = contextRefresh;
  return p;
}

let testDir: string;

function writeProtocol(json: unknown): void {
  const dir = path.join(testDir, 'codev/protocols/fixture-protocol');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'protocol.json'), JSON.stringify(json, null, 2));
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'porch-1470-'));
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Acceptance: absent key means no refreshes (spec test 1)
// ---------------------------------------------------------------------------

describe('context_refresh: absent key', () => {
  it('yields no boundaries when the key is missing', () => {
    writeProtocol(baseProtocol());
    const protocol = loadProtocol(testDir, 'fixture-protocol');
    expect(protocol.context_refresh).toBeUndefined();
  });

  it('rejects an explicit null rather than treating it as omitted', () => {
    // `null` is a configuration ACT that would silently declare nothing — the
    // same silent no-op the rest of this validation exists to reject — and all
    // three schemas type the key as an object. Omitting the key is the way to
    // declare no boundaries.
    writeProtocol(baseProtocol(null));
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/context_refresh is null/);
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/omit the key/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: a valid declaration parses through
// ---------------------------------------------------------------------------

describe('context_refresh: valid declaration', () => {
  it('parses on_enter and on_plan_phase_advance', () => {
    writeProtocol(
      baseProtocol({ on_enter: ['plan', 'implement', 'review'], on_plan_phase_advance: true }),
    );
    const protocol = loadProtocol(testDir, 'fixture-protocol');
    expect(protocol.context_refresh?.on_enter).toEqual(['plan', 'implement', 'review']);
    expect(protocol.context_refresh?.on_plan_phase_advance).toBe(true);
  });

  it('accepts on_enter alone', () => {
    writeProtocol(baseProtocol({ on_enter: ['review'] }));
    const protocol = loadProtocol(testDir, 'fixture-protocol');
    expect(protocol.context_refresh?.on_enter).toEqual(['review']);
    expect(protocol.context_refresh?.on_plan_phase_advance).toBeUndefined();
  });

  it('accepts on_plan_phase_advance:false on a protocol with no per_plan_phase phase', () => {
    // false declares nothing, so there is no unresolvable boundary to reject.
    writeProtocol(flatProtocol({ on_plan_phase_advance: false }));
    const protocol = loadProtocol(testDir, 'fixture-protocol');
    expect(protocol.context_refresh?.on_plan_phase_advance).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: rejection at load, naming the offending value (spec test 7)
// ---------------------------------------------------------------------------

describe('context_refresh: rejection', () => {
  it('rejects on_enter naming a phase the protocol does not have, and names it', () => {
    writeProtocol(baseProtocol({ on_enter: ['plan', 'deploy'] }));
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/deploy/);
    // The message must also say what IS available, or the author has to guess.
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/implement/);
  });

  it('rejects on_plan_phase_advance:true when no per_plan_phase phase exists', () => {
    writeProtocol(flatProtocol({ on_plan_phase_advance: true }));
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/per_plan_phase/);
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/could never fire/);
  });

  it('rejects a non-array on_enter', () => {
    writeProtocol(baseProtocol({ on_enter: 'plan' }));
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/on_enter must be an array/);
  });

  it('rejects non-string entries inside on_enter', () => {
    writeProtocol(baseProtocol({ on_enter: ['plan', 42] }));
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/must be strings/);
  });

  it('rejects a non-boolean on_plan_phase_advance', () => {
    writeProtocol(baseProtocol({ on_plan_phase_advance: 'yes' }));
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(
      /on_plan_phase_advance must be a boolean/,
    );
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // A typo'd key is indistinguishable from "declared nothing" if skipped,
    // which is exactly the silent no-op this validation exists to prevent.
    writeProtocol(baseProtocol({ on_entry: ['plan'] }));
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/unknown key 'on_entry'/);
  });

  it('rejects duplicate entries in on_enter', () => {
    // Keeps the runtime in step with the schemas' uniqueItems.
    writeProtocol(baseProtocol({ on_enter: ['plan', 'plan'] }));
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/more than once/);
  });

  it('rejects a non-object context_refresh', () => {
    writeProtocol(baseProtocol(['plan']));
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/must be an object/);
  });

  it('names the protocol in every rejection', () => {
    writeProtocol(baseProtocol({ on_enter: ['nope'] }));
    expect(() => loadProtocol(testDir, 'fixture-protocol')).toThrow(/fixture-protocol/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: every shipped protocol still loads (spec test 8)
// ---------------------------------------------------------------------------

describe('shipped protocols', () => {
  // Walk up from this test file to the repo root rather than assuming a cwd,
  // so the test behaves the same under vitest, CI and a builder worktree.
  const repoRoot = path.resolve(__dirname, '../../../../../../');

  function shippedProtocolNames(tree: string): string[] {
    const dir = path.join(repoRoot, tree, 'protocols');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .filter(e => fs.existsSync(path.join(dir, e.name, 'protocol.json')))
      .map(e => e.name);
  }

  it('loads every protocol shipped in codev/', () => {
    const names = shippedProtocolNames('codev');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(() => loadProtocol(repoRoot, name), `protocol '${name}' failed to load`).not.toThrow();
    }
  });

  it('loads every protocol shipped in codev-skeleton/', () => {
    // The four-tier resolver hits codev/ first, so loading by name never parses
    // the skeleton copies — yet for an ADOPTER those copies are the shipped
    // protocols. Parse them directly, from a temp root that has no codev/ tier
    // to shadow them, or a broken skeleton protocol ships undetected.
    const names = shippedProtocolNames('codev-skeleton');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const src = path.join(repoRoot, 'codev-skeleton/protocols', name, 'protocol.json');
      const dest = path.join(testDir, 'codev/protocols', name);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(src, path.join(dest, 'protocol.json'));
      expect(
        () => loadProtocol(testDir, name),
        `skeleton protocol '${name}' failed to load`,
      ).not.toThrow();
    }
  });

  it('declares boundaries for spir and aspir only', () => {
    const withRefresh: string[] = [];
    for (const name of shippedProtocolNames('codev')) {
      const protocol = loadProtocol(repoRoot, name);
      if (protocol.context_refresh) withRefresh.push(protocol.name);
    }
    expect(withRefresh.sort()).toEqual(['aspir', 'spir']);
  });

  it('gives spir and aspir the same four boundaries', () => {
    for (const name of ['spir', 'aspir']) {
      const protocol = loadProtocol(repoRoot, name);
      expect(protocol.context_refresh?.on_enter, name).toEqual(['plan', 'implement', 'review']);
      expect(protocol.context_refresh?.on_plan_phase_advance, name).toBe(true);
    }
  });

  it('keeps codev/ and codev-skeleton/ protocol declarations in step', () => {
    for (const name of ['spir', 'aspir']) {
      const ours = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'codev/protocols', name, 'protocol.json'), 'utf-8'),
      );
      const skeleton = JSON.parse(
        fs.readFileSync(
          path.join(repoRoot, 'codev-skeleton/protocols', name, 'protocol.json'),
          'utf-8',
        ),
      );
      expect(skeleton.context_refresh, name).toEqual(ours.context_refresh);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema parity
// ---------------------------------------------------------------------------

describe('protocol-schema.json copies', () => {
  const repoRoot = path.resolve(__dirname, '../../../../../../');

  // Three copies exist and they are NOT byte-identical to each other: the
  // skeleton root copy is draft 2020-12 while the two protocols/ copies are
  // draft-07, with different `required` sets. That divergence pre-dates this
  // project and is out of scope to reconcile — so parity is asserted on the
  // context_refresh block alone, which is what this project owns.
  const copies = [
    'codev/protocols/protocol-schema.json',
    'codev-skeleton/protocols/protocol-schema.json',
    'codev-skeleton/protocol-schema.json',
  ];

  it('all three describe context_refresh identically', () => {
    const blocks = copies.map(rel => {
      const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf-8'));
      return schema.properties?.context_refresh;
    });
    for (const [i, block] of blocks.entries()) {
      expect(block, `${copies[i]} is missing context_refresh`).toBeDefined();
    }
    expect(blocks[1]).toEqual(blocks[0]);
    expect(blocks[2]).toEqual(blocks[0]);
  });

  it('documents both boundary keys', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, copies[0]), 'utf-8'));
    const props = schema.properties.context_refresh.properties;
    expect(Object.keys(props).sort()).toEqual(['on_enter', 'on_plan_phase_advance']);
    // Pins the schema to the runtime's duplicate rejection.
    expect(props.on_enter.uniqueItems).toBe(true);
    expect(schema.properties.context_refresh.additionalProperties).toBe(false);
  });
});
