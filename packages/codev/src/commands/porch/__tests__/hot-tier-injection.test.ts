/**
 * Spec 987 — Phase 2: always-on hot-tier injection into porch phase prompts.
 *
 * buildHotTierContext() is the unit prepended verbatim to every phase prompt by
 * buildPhasePrompt(). These tests verify:
 *  - the hot files are injected verbatim when present in the workspace (tier-2), and
 *  - runtime four-tier fallback: a workspace WITHOUT local hot files still gets the
 *    installed-skeleton copy (so an upgraded-but-not-yet-seeded repo never injects empty).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildHotTierContext, buildPhasePrompt } from '../prompts.js';
import { getSkeletonDir } from '../../../lib/skeleton.js';
import type { ProjectState, Protocol } from '../types.js';

// Avoid a real `gh issue view` round-trip when buildPhasePrompt → getProjectSummary runs.
vi.mock('../../../lib/github.js', () => ({
  fetchIssue: vi.fn().mockResolvedValue(null),
}));

const HEADER = '# Always-On Engineering Context (hot tier)';

describe('Spec 987 — hot-tier injection (buildHotTierContext)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-tier-inject-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function seedInstanceHotFiles(): void {
    const dir = path.join(tmp, 'codev', 'resources');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'arch-critical.md'), '# arch-critical\n\nARCH_HOT_MARKER\n');
    fs.writeFileSync(
      path.join(dir, 'lessons-critical.md'),
      '# lessons-critical\n\nLESSONS_HOT_MARKER\n'
    );
  }

  it('injects both hot files verbatim, framed by the always-on header', () => {
    seedInstanceHotFiles();
    const block = buildHotTierContext(tmp);

    expect(block.startsWith(HEADER)).toBe(true);
    expect(block).toContain('ARCH_HOT_MARKER');
    expect(block).toContain('LESSONS_HOT_MARKER');
    // Ends with a separator so it cleanly precedes the phase-prompt body.
    expect(block.trimEnd().endsWith('---')).toBe(true);
  });

  it('falls back to the installed-skeleton copy when the workspace has no local hot files', () => {
    // No codev/resources/*-critical.md in tmp → resolver must reach tier-4 (skeleton).
    const skeletonArch = path.join(getSkeletonDir(), 'resources', 'arch-critical.md');
    expect(
      fs.existsSync(skeletonArch),
      'skeleton hot files missing — run `pnpm build` (copy-skeleton) first'
    ).toBe(true);

    const block = buildHotTierContext(tmp);
    expect(block.startsWith(HEADER)).toBe(true);
    // The skeleton ships the generic STARTER variant; "STARTER:" appears only there,
    // never in the real instance content — proving fallback resolved the skeleton copy.
    expect(block).toContain('STARTER:');
    expect(block).toContain('Map of arch.md');
    expect(block).toContain('Map of lessons-learned.md');
  });

  it('prefers the local workspace copy over the skeleton (tier precedence)', () => {
    seedInstanceHotFiles();
    const block = buildHotTierContext(tmp);
    // Local copies win, so the skeleton STARTER text must NOT appear.
    expect(block).toContain('ARCH_HOT_MARKER');
    expect(block).not.toContain('STARTER:');
  });
});

// Integration: the hot tier is actually prepended by buildPhasePrompt() across phases.
describe('Spec 987 — hot tier is prepended to every assembled phase prompt', () => {
  let tmp: string;

  const protocol = {
    name: 'spir',
    version: '1.0.0',
    phases: [
      {
        id: 'specify',
        name: 'Specify',
        type: 'build_verify',
        build: { prompt: 'specify.md', artifact: 'codev/specs/x.md' },
        verify: { type: 'spec', models: ['codex'] },
        max_iterations: 1,
      },
      {
        id: 'implement',
        name: 'Implement',
        type: 'per_plan_phase',
        build: { prompt: 'implement.md', artifact: 'src/**/*.ts' },
        verify: { type: 'impl', models: ['codex'] },
        max_iterations: 1,
      },
    ],
  } as unknown as Protocol;

  function makeState(phase: string): ProjectState {
    return {
      id: '0001',
      title: 'test-feature',
      protocol: 'spir',
      phase,
      plan_phases: [],
      current_plan_phase: null,
      gates: {},
      iteration: 1,
      build_complete: false,
      history: [],
      started_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    } as unknown as ProjectState;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-tier-prompt-'));
    // Seed local hot files (tier-2) ...
    const res = path.join(tmp, 'codev', 'resources');
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(res, 'arch-critical.md'), '# arch\n\nARCH_HOT_MARKER\n');
    fs.writeFileSync(path.join(res, 'lessons-critical.md'), '# lessons\n\nLESSONS_HOT_MARKER\n');
    // ... and the phase prompt bodies the resolver will load.
    const prompts = path.join(tmp, 'codev', 'protocols', 'spir', 'prompts');
    fs.mkdirSync(prompts, { recursive: true });
    fs.writeFileSync(path.join(prompts, 'specify.md'), 'SPECIFY_BODY');
    fs.writeFileSync(path.join(prompts, 'implement.md'), 'IMPLEMENT_BODY');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    ['specify', 'SPECIFY_BODY'],
    ['implement', 'IMPLEMENT_BODY'],
  ])('prepends both hot files ahead of the %s phase body', async (phase, body) => {
    const prompt = await buildPhasePrompt(tmp, makeState(phase), protocol);

    expect(prompt.startsWith(HEADER)).toBe(true);
    expect(prompt).toContain('ARCH_HOT_MARKER');
    expect(prompt).toContain('LESSONS_HOT_MARKER');
    expect(prompt).toContain(body);
    // Hot tier comes BEFORE the phase-specific body.
    expect(prompt.indexOf(HEADER)).toBeLessThan(prompt.indexOf(body));
  });
});
