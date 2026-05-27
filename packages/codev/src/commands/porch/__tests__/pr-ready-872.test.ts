/**
 * Tests for Issue #872 — canonical `pr_ready_for_human` signal.
 *
 * Verifies that porch sets the field on the right transitions across all five
 * bundled protocols (SPIR, ASPIR, PIR, AIR, BUGFIX) and resets it on the right
 * inverse transitions (`pr` gate approved, rollback).
 *
 * The protocol shapes in this file are minimal — only the phases / gates /
 * consultation markers relevant to the PR-creating phase and its predecessor
 * are modeled. They are NOT meant to be runnable copies of the bundled
 * skeleton protocols; they exist solely to exercise porch's state machine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { next } from '../next.js';
import { done, approve, rollback } from '../index.js';
import { writeState, getProjectDir, getStatusPath, readState } from '../state.js';
import { loadProtocol, isPrCreatingPhase } from '../protocol.js';
import type { ProjectState } from '../types.js';

vi.mock('../../../lib/config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../lib/config.js')>();
  return {
    ...original,
    loadConfig: (_workspaceRoot: string) => ({
      porch: { consultation: { models: ['gemini', 'codex'] } },
    }),
  };
});

// ============================================================================
// Helpers
// ============================================================================

function createTestDir(): string {
  const dir = path.join(
    tmpdir(),
    `porch-pr-ready-872-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setupProtocol(testDir: string, protocolName: string, protocol: object): void {
  const protocolDir = path.join(testDir, 'codev', 'protocols', protocolName);
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.writeFileSync(
    path.join(protocolDir, 'protocol.json'),
    JSON.stringify(protocol, null, 2),
  );
}

function setupPrompts(testDir: string, protocolName: string, prompts: Record<string, string>): void {
  const promptsDir = path.join(testDir, 'codev', 'protocols', protocolName, 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true });
  for (const [name, content] of Object.entries(prompts)) {
    fs.writeFileSync(path.join(promptsDir, name), content);
  }
}

function setupState(testDir: string, state: ProjectState): void {
  const statusPath = getStatusPath(testDir, state.id, state.title);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  writeState(statusPath, state);
}

function readStateFor(testDir: string, state: ProjectState): ProjectState {
  return readState(getStatusPath(testDir, state.id, state.title));
}

function writeReviews(
  testDir: string,
  state: ProjectState,
  models: string[],
  verdict: 'APPROVE' | 'REQUEST_CHANGES',
): void {
  const projectDir = getProjectDir(testDir, state.id, state.title);
  fs.mkdirSync(projectDir, { recursive: true });
  for (const model of models) {
    const body = `Review text that is long enough to pass the minimum length threshold for parsing.\n\n---\nVERDICT: ${verdict}\nSUMMARY: Test\nCONFIDENCE: HIGH\n---`;
    const phaseId = state.current_plan_phase || state.phase;
    fs.writeFileSync(
      path.join(projectDir, `${state.id}-${phaseId}-iter${state.iteration}-${model}.txt`),
      body,
    );
  }
}

function makeState(overrides: Partial<ProjectState>): ProjectState {
  return {
    id: '0001',
    title: 'test-feature',
    protocol: 'spir',
    phase: 'review',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Minimal protocol fixtures (one phase preceding `pr`/`review` so the
// state-machine paths under test are reachable from a representative state).
// ============================================================================

// RESEARCH-shape: once-phases with a `consultation` block but `on` is NOT
// `"review"` (it's the bare investigation/critique sense). This phase must
// NOT be classified as PR-creating — otherwise porch would set
// `pr_ready_for_human: true` on RESEARCH builders that aren't producing a PR.
// Architect-side CMAP for #872 iter-1 caught this gap.
const researchShapedProtocol = {
  name: 'research',
  version: '1.0.0',
  phases: [
    {
      id: 'investigate',
      name: 'Investigate',
      type: 'once',
      // Note: NO `on` field — the marker that distinguishes PR-creating from
      // research-style consultation. `type` is "investigation", not "impl".
      consultation: { enabled: true, models: ['codex'], parallel: true, type: 'investigation' },
      transition: { on_complete: 'critique' },
    },
    {
      id: 'critique',
      name: 'Critique',
      type: 'once',
      consultation: { enabled: true, models: ['codex'], parallel: true, type: 'critique' },
      gate: 'research-complete',
      transition: { on_complete: null },
    },
  ],
};

// SPIR/ASPIR/PIR all share the same shape for our purposes: a build_verify
// `review` phase with a `pr` gate. PIR ends there; SPIR/ASPIR continue to
// `verify`. We exercise the pr-gate transition, which is identical across all
// three, so a single fixture is sufficient.
function buildVerifyReviewProtocol(name: string, withVerifyPhase: boolean) {
  const phases: object[] = [
    {
      id: 'review',
      name: 'Review',
      type: 'build_verify',
      build: { prompt: 'review.md', artifact: 'codev/reviews/${PROJECT_ID}-*.md' },
      verify: { type: 'pr', models: ['gemini', 'codex'] },
      max_iterations: 1,
      gate: 'pr',
      next: withVerifyPhase ? 'verify' : null,
    },
  ];
  if (withVerifyPhase) {
    phases.push({ id: 'verify', name: 'Verify', type: 'once', gate: 'verify-approval', next: null });
  }
  return { name, version: '1.0.0', phases };
}

const airProtocol = {
  name: 'air',
  version: '1.0.0',
  phases: [
    {
      id: 'implement',
      name: 'Implement',
      type: 'once',
      checks: { build: { command: 'true' }, tests: { command: 'true' } },
      transition: { on_complete: 'pr' },
    },
    {
      id: 'pr',
      name: 'Create PR',
      type: 'once',
      consultation: { on: 'review', models: ['gemini', 'codex'], type: 'impl' },
      gate: 'pr',
      transition: { on_complete: null },
    },
  ],
};

const bugfixProtocol = {
  name: 'bugfix',
  version: '1.0.0',
  phases: [
    {
      id: 'investigate',
      name: 'Investigate',
      type: 'once',
      transition: { on_complete: 'fix' },
    },
    {
      id: 'fix',
      name: 'Fix',
      type: 'once',
      transition: { on_complete: 'pr' },
    },
    {
      id: 'pr',
      name: 'Create PR',
      type: 'once',
      consultation: { on: 'review', models: ['gemini', 'codex'], type: 'impl' },
      transition: { on_complete: null },
    },
  ],
};

// ============================================================================
// Tests
// ============================================================================

describe('Issue #872 — pr_ready_for_human lifecycle', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // isPrCreatingPhase classifier — must NOT overmatch RESEARCH (iter-2 fix)
  // --------------------------------------------------------------------------

  describe('isPrCreatingPhase classifier (iter-2: narrow consultation.on === "review")', () => {
    it('returns true for AIR pr (consultation.on === "review")', () => {
      setupProtocol(testDir, 'air', airProtocol);
      const protocol = loadProtocol(testDir, 'air');
      expect(isPrCreatingPhase(protocol, 'pr')).toBe(true);
    });

    it('returns true for BUGFIX pr (consultation.on === "review")', () => {
      setupProtocol(testDir, 'bugfix', bugfixProtocol);
      const protocol = loadProtocol(testDir, 'bugfix');
      expect(isPrCreatingPhase(protocol, 'pr')).toBe(true);
    });

    it('returns true for build_verify review with gate=pr (SPIR/ASPIR/PIR shape)', () => {
      const protocol = buildVerifyReviewProtocol('spir', /*withVerifyPhase*/ true);
      setupProtocol(testDir, 'spir', protocol);
      expect(isPrCreatingPhase(loadProtocol(testDir, 'spir'), 'review')).toBe(true);
    });

    it('returns FALSE for RESEARCH investigate (consultation present but on is not "review")', () => {
      // This is the bug architect-side CMAP caught in iter-1: the iter-1
      // classifier matched bare `consultation` presence, which would have
      // misclassified RESEARCH's investigation phase as PR-creating and leaked
      // pr_ready_for_human: true into research state.
      setupProtocol(testDir, 'research', researchShapedProtocol);
      const protocol = loadProtocol(testDir, 'research');
      expect(isPrCreatingPhase(protocol, 'investigate')).toBe(false);
    });

    it('returns FALSE for RESEARCH critique (consultation + gate, but gate is not "pr")', () => {
      setupProtocol(testDir, 'research', researchShapedProtocol);
      const protocol = loadProtocol(testDir, 'research');
      // Critique has a `research-complete` gate, NOT `pr`, and its consultation
      // block has no `on: "review"`. Both classifier markers miss it.
      expect(isPrCreatingPhase(protocol, 'critique')).toBe(false);
    });

    it('returns FALSE for non-PR phases (BUGFIX investigate, AIR implement)', () => {
      setupProtocol(testDir, 'bugfix', bugfixProtocol);
      setupProtocol(testDir, 'air', airProtocol);
      expect(isPrCreatingPhase(loadProtocol(testDir, 'bugfix'), 'investigate')).toBe(false);
      expect(isPrCreatingPhase(loadProtocol(testDir, 'bugfix'), 'fix')).toBe(false);
      expect(isPrCreatingPhase(loadProtocol(testDir, 'air'), 'implement')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // SPIR / ASPIR / PIR: build_verify review phase, gate=pr
  // --------------------------------------------------------------------------

  describe('build_verify review (SPIR/ASPIR/PIR shape)', () => {
    it('sets pr_ready_for_human=true when CMAP completes and the pr gate is requested (SPIR-shaped)', async () => {
      const protocol = buildVerifyReviewProtocol('spir', /*withVerifyPhase*/ true);
      setupProtocol(testDir, 'spir', protocol);
      setupPrompts(testDir, 'spir', { 'review.md': '# Review' });

      const state = makeState({
        protocol: 'spir',
        phase: 'review',
        build_complete: true,
        gates: { pr: { status: 'pending' as const }, 'verify-approval': { status: 'pending' as const } },
      });
      setupState(testDir, state);
      writeReviews(testDir, state, ['gemini', 'codex'], 'APPROVE');

      await next(testDir, '0001');

      const after = readStateFor(testDir, state);
      expect(after.pr_ready_for_human).toBe(true);
      expect(after.gates['pr']?.status).toBe('pending');
      expect(after.gates['pr']?.requested_at).toBeTruthy();
    });

    it('sets pr_ready_for_human=true for terminal PIR-shape (no verify phase)', async () => {
      const protocol = buildVerifyReviewProtocol('pir', /*withVerifyPhase*/ false);
      setupProtocol(testDir, 'pir', protocol);
      setupPrompts(testDir, 'pir', { 'review.md': '# Review' });

      const state = makeState({
        protocol: 'pir',
        phase: 'review',
        build_complete: true,
        gates: { pr: { status: 'pending' as const } },
      });
      setupState(testDir, state);
      writeReviews(testDir, state, ['gemini', 'codex'], 'APPROVE');

      await next(testDir, '0001');

      const after = readStateFor(testDir, state);
      expect(after.pr_ready_for_human).toBe(true);
    });

    it('leaves pr_ready_for_human falsy while CMAP is still in REQUEST_CHANGES rebuttal cycle', async () => {
      const protocol = buildVerifyReviewProtocol('spir', /*withVerifyPhase*/ true);
      setupProtocol(testDir, 'spir', protocol);
      setupPrompts(testDir, 'spir', { 'review.md': '# Review' });

      const state = makeState({
        protocol: 'spir',
        phase: 'review',
        build_complete: true,
        gates: { pr: { status: 'pending' as const } },
      });
      setupState(testDir, state);
      writeReviews(testDir, state, ['gemini', 'codex'], 'REQUEST_CHANGES');

      const result = await next(testDir, '0001');
      // Rebuttal task is emitted; state hasn't transitioned to gate-pending.
      expect(result.status).toBe('tasks');
      expect(result.tasks![0].subject).toContain('rebuttal');

      const after = readStateFor(testDir, state);
      expect(after.pr_ready_for_human).toBeFalsy();
    });
  });

  // --------------------------------------------------------------------------
  // AIR: once-phase pr, gate=pr
  // --------------------------------------------------------------------------

  describe('AIR pr (once-phase with pr gate)', () => {
    it('sets pr_ready_for_human=true when done auto-requests the pr gate', async () => {
      setupProtocol(testDir, 'air', airProtocol);

      const state = makeState({
        protocol: 'air',
        phase: 'pr',
        gates: { pr: { status: 'pending' as const } },
      });
      setupState(testDir, state);

      await done(testDir, '0001');

      const after = readStateFor(testDir, state);
      expect(after.pr_ready_for_human).toBe(true);
      expect(after.gates['pr']?.requested_at).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // BUGFIX: once-phase pr, NO gate (the regression that motivated #872)
  // --------------------------------------------------------------------------

  describe('BUGFIX pr (once-phase, no gate — the #872 regression case)', () => {
    it('sets pr_ready_for_human=true when done advances pr → verified', async () => {
      setupProtocol(testDir, 'bugfix', bugfixProtocol);

      const state = makeState({ id: 'bugfix-0001', protocol: 'bugfix', phase: 'pr', gates: {} });
      setupState(testDir, state);

      await done(testDir, 'bugfix-0001');

      const after = readStateFor(testDir, state);
      expect(after.phase).toBe('verified');
      expect(after.pr_ready_for_human).toBe(true);
    });

    it('does NOT set pr_ready_for_human=true when done advances an earlier (non-pr) phase', async () => {
      setupProtocol(testDir, 'bugfix', bugfixProtocol);

      const state = makeState({ id: 'bugfix-0001', protocol: 'bugfix', phase: 'investigate', gates: {} });
      setupState(testDir, state);

      await done(testDir, 'bugfix-0001');

      const after = readStateFor(testDir, state);
      expect(after.phase).toBe('fix');
      // The investigate → fix transition is unrelated to PR readiness.
      expect(after.pr_ready_for_human).toBeFalsy();
    });
  });

  // --------------------------------------------------------------------------
  // Resets: pr gate approval, rollback
  // --------------------------------------------------------------------------

  describe('reset transitions', () => {
    it('resets pr_ready_for_human=false when the pr gate is approved', async () => {
      const protocol = buildVerifyReviewProtocol('air', /*withVerifyPhase*/ false);
      setupProtocol(testDir, 'air', protocol);
      setupPrompts(testDir, 'air', { 'review.md': '# Review' });

      const state = makeState({
        protocol: 'air',
        phase: 'review',
        pr_ready_for_human: true,
        gates: { pr: { status: 'pending' as const, requested_at: new Date().toISOString() } },
      });
      setupState(testDir, state);

      await approve(testDir, '0001', 'pr', true);

      const after = readStateFor(testDir, state);
      expect(after.pr_ready_for_human).toBe(false);
      expect(after.gates['pr']?.status).toBe('approved');
    });

    it('resets pr_ready_for_human=false on rollback', async () => {
      const protocol = buildVerifyReviewProtocol('spir', /*withVerifyPhase*/ true);
      setupProtocol(testDir, 'spir', protocol);
      setupPrompts(testDir, 'spir', { 'review.md': '# Review' });
      // Add a dummy `specify` phase so we have somewhere to roll back to.
      const protocolWithSpecify = {
        ...protocol,
        phases: [
          { id: 'specify', name: 'Specify', type: 'build_verify', gate: 'spec-approval' },
          ...protocol.phases,
        ],
      };
      setupProtocol(testDir, 'spir', protocolWithSpecify);

      const state = makeState({
        protocol: 'spir',
        phase: 'review',
        pr_ready_for_human: true,
        gates: { pr: { status: 'pending' as const, requested_at: new Date().toISOString() } },
      });
      setupState(testDir, state);

      await rollback(testDir, '0001', 'specify');

      const after = readStateFor(testDir, state);
      expect(after.phase).toBe('specify');
      expect(after.pr_ready_for_human).toBe(false);
    });
  });
});
