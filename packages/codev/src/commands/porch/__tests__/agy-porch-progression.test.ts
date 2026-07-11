/**
 * Porch-orchestrated phase-progression test for the agy backend (Spec 778).
 *
 * This is the integration counterpart to agy-skip-progression.test.ts (which pins
 * the verdict-parsing contract in isolation). Here we drive the REAL porch entry
 * point — `next()` — with on-disk review files, so the whole orchestration path is
 * exercised: findReviewFiles → parseVerdict → allApprove → handleVerifyApproved /
 * rebuttal. The gemini lane's review file is the genuine `agySkipContent` artifact
 * produced when `agy` is missing/unauthenticated/timed-out.
 *
 * The core failure this defends against: a skipped gemini lane stalling a SPIR
 * phase. The skip must be non-blocking — porch must advance on the strength of the
 * remaining reviewers (2-way) — yet must NOT mask a genuine REQUEST_CHANGES.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { next } from '../next.js';
import { writeState, getProjectDir, getStatusPath } from '../state.js';
import { _agySkipContent } from '../../consult/index.js';
import type { ProjectState } from '../types.js';

// Pin consultation models to the 3-way default so workspace/global config can't
// leak in and change the lane set (mirrors done-verification.test.ts).
vi.mock('../../../lib/config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../lib/config.js')>();
  return {
    ...original,
    loadConfig: (_workspaceRoot: string) => ({
      porch: { consultation: { models: ['gemini', 'codex', 'claude'] } },
    }),
  };
});

function createTestDir(): string {
  const dir = path.join(tmpdir(), `porch-agy-prog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setupProtocol(testDir: string): void {
  // Single build_verify phase with a 3-way PR-style consult and a `pr` gate.
  // On all-approve, porch requests the `pr` gate (status: gate_pending); on any
  // REQUEST_CHANGES it asks for a rebuttal — exactly the two outcomes we assert.
  const protocol = {
    name: 'agy-prog-proto',
    version: '1.0.0',
    phases: [
      {
        id: 'review',
        name: 'Review',
        type: 'build_verify',
        build: { prompt: 'review.md', artifact: 'codev/reviews/${PROJECT_ID}-*.md' },
        verify: { type: 'pr', models: ['gemini', 'codex', 'claude'] },
        gate: 'pr',
        next: null,
      },
    ],
  };
  const protocolDir = path.join(testDir, 'codev', 'protocols', 'agy-prog-proto');
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(protocol, null, 2));
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: '0778',
    title: 'agy-progression',
    protocol: 'agy-prog-proto',
    phase: 'review',
    plan_phases: [],
    current_plan_phase: null,
    gates: { pr: { status: 'pending' as const } },
    iteration: 1,
    build_complete: true,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Write the three iter-1 review files porch expects, with the given verdicts. */
function writeReviews(
  testDir: string,
  state: ProjectState,
  verdicts: { gemini: string; codex: string; claude: string },
): void {
  const projectDir = getProjectDir(testDir, state.id, state.title);
  fs.mkdirSync(projectDir, { recursive: true });
  const phase = state.current_plan_phase || state.phase;
  const write = (model: string, content: string) =>
    fs.writeFileSync(path.join(projectDir, `${state.id}-${phase}-iter${state.iteration}-${model}.txt`), content);
  write('gemini', verdicts.gemini);
  write('codex', verdicts.codex);
  write('claude', verdicts.claude);
}

const APPROVE = 'Looks correct and complete; nothing blocking here.\n\n---\nVERDICT: APPROVE\nSUMMARY: ok\nCONFIDENCE: HIGH\n---';
const REQUEST = 'A required behavior is missing and must be fixed before merge.\n\n---\nVERDICT: REQUEST_CHANGES\nSUMMARY: missing\nCONFIDENCE: HIGH\n---';

describe('porch progression with a skipped agy/gemini lane (drives next())', () => {
  let testDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = createTestDir();
    setupProtocol(testDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  it('advances (2-way) when gemini is skipped but codex + claude APPROVE', async () => {
    const state = makeState();
    const statusPath = getStatusPath(testDir, state.id, state.title);
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    // gemini lane = the real skip artifact agy emits when unavailable → SKIPPED
    writeReviews(testDir, state, {
      gemini: _agySkipContent('agy CLI not found'),
      codex: APPROVE,
      claude: APPROVE,
    });

    const res = await next(testDir, '0778');

    // Porch advanced: it requested the human `pr` gate, NOT a rebuttal /
    // re-iteration. The skipped lane did not block progression — but the gate
    // message must disclose the reduced coverage instead of claiming a full
    // 3-way approval (entriq #2467).
    expect(res.status).toBe('gate_pending');
    expect(res.gate).toBe('pr');
    const subjects = (res.tasks ?? []).map(t => t.subject).join(' | ');
    expect(subjects).not.toMatch(/rebuttal/i);
    const descriptions = (res.tasks ?? []).map(t => t.description).join('\n');
    expect(descriptions).toMatch(/All effective reviewers approved/);
    expect(descriptions).toMatch(/SKIPPED/);
    expect(descriptions).not.toMatch(/^All reviewers approved!/m);
  });

  it('does NOT advance when EVERY lane skipped (zero real reviews)', async () => {
    const state = makeState();
    const statusPath = getStatusPath(testDir, state.id, state.title);
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    // All three lanes emit skip artifacts — no review actually happened.
    writeReviews(testDir, state, {
      gemini: _agySkipContent('agy CLI not found'),
      codex: _agySkipContent('no response before timeout'),
      claude: _agySkipContent('no response before timeout'),
    });

    const res = await next(testDir, '0778');

    // The gate must not pass on zero evidence, and the remediation is to
    // re-run the consultations — not to write a rebuttal against feedback
    // that does not exist.
    expect(res.status).toBe('tasks');
    expect(res.gate).toBeUndefined();
    const subjects = (res.tasks ?? []).map(t => t.subject).join(' | ');
    expect(subjects).toMatch(/skipped/i);
    expect(subjects).not.toMatch(/rebuttal/i);
  });

  it('does NOT mask a genuine REQUEST_CHANGES (gemini skipped, codex blocks)', async () => {
    const state = makeState();
    const statusPath = getStatusPath(testDir, state.id, state.title);
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, state);

    writeReviews(testDir, state, {
      gemini: _agySkipContent('authentication required (OAuth)'),
      codex: REQUEST,
      claude: APPROVE,
    });

    const res = await next(testDir, '0778');

    // The skip is non-blocking, but a real REQUEST_CHANGES still blocks: porch asks
    // for a rebuttal rather than advancing to the gate.
    expect(res.status).toBe('tasks');
    expect(res.gate).toBeUndefined();
    expect((res.tasks ?? []).map(t => t.subject).join(' | ')).toMatch(/rebuttal/i);
  });
});
