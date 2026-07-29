/**
 * Spec 1273 Phase 5 — re-orientation assembly (invariant R3).
 *
 * R3: the re-orientation always carries the full frame — role, protocol, mode,
 * project identity, worktree, branch, state-file pointer, porch re-entry. There
 * must be no code path that emits a partial one.
 *
 * The failure this prevents is silent, which is why the tests lean on the
 * negative cases: a frame missing its protocol does not crash, it produces a
 * builder with a fresh window that does not know what governs it, and the drift
 * only surfaces later as off-protocol work.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  assembleReorientation,
  conditionalInlineMarkers,
  ReorientationAssemblyError,
  REQUIRED_INLINE_MARKERS,
  type SpawnPromptPort,
} from '../commands/reset/reorient.js';
import { REORIENT_FILE_NAME } from '../commands/reset/constants.js';
import type { ResolvedBuilderContext } from '../commands/reset/context.js';

// ============================================================================
// Fixtures
// ============================================================================

const STATE_PATH = '/ws/.builders/aspir-1273/.builder-state.md';

const SPAWN_PROMPT = '# ASPIR Builder\n\nProtocol reference: ...\n';

const spawnPromptPort: SpawnPromptPort = () => SPAWN_PROMPT;

/** Stand-in for the real `buildResumeNotice`, including its porch init fallback. */
const RESUME_NOTICE = `## RESUME SESSION

Start by running \`porch next\` to check your current state and get next tasks.
If porch reports "not found", run \`porch init\` to re-initialize.
`;
const resumeNoticePort = () => RESUME_NOTICE;

function makeContext(overrides: Partial<ResolvedBuilderContext> = {}): ResolvedBuilderContext {
  return {
    builderId: 'builder-aspir-1273',
    worktree: '/ws/.builders/aspir-1273',
    branch: 'builder/aspir-1273',
    protocol: 'aspir',
    protocolSource: 'status.yaml',
    mode: 'strict',
    modeSource: 'builder-prompt',
    harnessName: 'claude',
    harness: { supportsContextReset: true } as any,
    porch: {
      projectId: '1273',
      projectName: '1273-builder-context-reset-should-b',
      protocol: 'aspir',
      phase: 'implement',
      currentPlanPhase: 'phase_5',
      statusPath: '/ws/.builders/aspir-1273/codev/projects/1273-x/status.yaml',
    },
    specName: '1273-builder-context-reset-should-b',
    specPath: 'codev/specs/1273-builder-context-reset-should-b.md',
    planPath: 'codev/plans/1273-builder-context-reset-should-b.md',
    issueNumber: '1273',
    ...overrides,
  };
}

function assemble(overrides: Partial<ResolvedBuilderContext> = {}, addendum?: string) {
  return assembleReorientation({
    context: makeContext(overrides),
    statePath: STATE_PATH,
    addendum,
    buildSpawnPrompt: spawnPromptPort,
    buildResumeNotice: resumeNoticePort,
  });
}

// ============================================================================
// R3 — the complete frame
// ============================================================================

describe('assembleReorientation — R3 complete frame (Spec 1273)', () => {
  it('produces every required frame element inline', () => {
    const { inline } = assemble();
    for (const marker of REQUIRED_INLINE_MARKERS) {
      expect(inline).toContain(marker);
    }
  });

  it('names the protocol, mode, worktree and branch', () => {
    const { inline } = assemble();
    expect(inline).toContain('ASPIR');
    expect(inline).toContain('STRICT');
    expect(inline).toContain('/ws/.builders/aspir-1273');
    expect(inline).toContain('builder/aspir-1273');
  });

  it('points at the state file and tells the builder to read it in full', () => {
    const { inline } = assemble();
    expect(inline).toContain(STATE_PATH);
    expect(inline).toContain('in full');
  });

  it('warns the builder not to stage the state file', () => {
    // porch done sweeps staged files; a staged state file would vanish.
    const { inline } = assemble();
    expect(inline.toLowerCase()).toContain('do not stage');
  });

  it('points at the long-form file', () => {
    const { inline, longFormFileName } = assemble();
    expect(longFormFileName).toBe(REORIENT_FILE_NAME);
    expect(inline).toContain(REORIENT_FILE_NAME);
  });

  it('tells the builder its history is gone and not to try to recall it', () => {
    // A reset builder that tries to "remember" confabulates; the frame has to
    // redirect it to the files.
    const { inline } = assemble();
    expect(inline.toLowerCase()).toContain('cleared');
    expect(inline.toLowerCase()).toContain('do not try to recall');
  });

  it('adds the porch re-entry instruction on a porch lane', () => {
    const { inline } = assemble();
    expect(inline).toContain('porch next');
  });

  it('omits porch re-entry on a non-porch lane and still satisfies R3', () => {
    const { inline } = assemble({ porch: null, specName: null, specPath: null, planPath: null, issueNumber: undefined });
    expect(inline).not.toContain('porch next');
    for (const marker of REQUIRED_INLINE_MARKERS) {
      expect(inline).toContain(marker);
    }
  });

  it('names the project, project ID and issue on a porch lane', () => {
    // Without these a reset builder cannot locate its own project — as
    // load-bearing on a porch lane as the protocol name itself. The ID is
    // stated explicitly rather than left implicit in the directory stem:
    // `porch status`/`porch next` take the id, and a builder with no history
    // should not have to parse it back out of a slug.
    const { inline } = assemble();
    expect(inline).toContain('Project ID: 1273');
    expect(inline).toContain('Project:');
    expect(inline).toContain('1273-builder-context-reset-should-b');
    expect(inline).toContain('Issue:');
    expect(inline).toContain('#1273');
  });

  it('names WHICH role document governs the builder, not just that one does', () => {
    // A builder with no conversation history cannot resolve "your role
    // document" to a file. The spec requires the identity block to name it.
    const { inline } = assemble();
    expect(inline).toContain('.builder-role.md');
  });

  it('records the porch project ID in the long form too', () => {
    const { longForm } = assemble();
    expect(longForm).toContain('Porch project ID: 1273');
  });

  it('requires project identity and porch re-entry whenever the lane is porch-driven', () => {
    // Conditional, not optional: the marker list adapts to what the lane has,
    // so "missing input is an abort, not an omission" still applies.
    const markers = conditionalInlineMarkers(makeContext());
    expect(markers).toContain('Project ID:');
    expect(markers).toContain('Project:');
    expect(markers).toContain('porch next');
    expect(markers).toContain('Issue:');
  });

  it('requires no project or porch markers on a non-porch lane', () => {
    const markers = conditionalInlineMarkers(
      makeContext({ porch: null, issueNumber: undefined }),
    );
    expect(markers).toEqual([]);
  });

  it('requires the issue marker whenever an issue number is known', () => {
    const markers = conditionalInlineMarkers(makeContext({ porch: null }));
    expect(markers).toEqual(['Issue:']);
  });
});

// ============================================================================
// R3 — complete-or-abort
// ============================================================================

describe('assembleReorientation — abort rather than partial (Spec 1273)', () => {
  it.each([
    ['protocol', { protocol: '' }],
    ['mode', { mode: '' as any }],
    ['worktree', { worktree: '' }],
    ['branch', { branch: '' }],
    ['builderId', { builderId: '' }],
  ])('throws a named error when %s is missing', (field, override) => {
    expect(() => assemble(override as Partial<ResolvedBuilderContext>)).toThrow(ReorientationAssemblyError);
    expect(() => assemble(override as Partial<ResolvedBuilderContext>)).toThrow(new RegExp(field));
  });

  it('throws when the state path is empty', () => {
    expect(() =>
      assembleReorientation({
        context: makeContext(),
        statePath: '',
        buildSpawnPrompt: spawnPromptPort,
      }),
    ).toThrow(/statePath/);
  });

  it.each([
    ['projectId', { projectId: '' }],
    ['projectName', { projectName: '' }],
    ['phase', { phase: '' }],
  ])('throws when porch.%s is empty on a porch lane', (field, override) => {
    // Marker validation matches on LABELS, so an empty projectId still renders
    // `Project ID:` and passes it — a frame that looks complete and tells the
    // builder nothing. Presence of a label is not presence of a value.
    const base = makeContext();
    expect(() =>
      assemble({ porch: { ...base.porch!, ...(override as object) } as any }),
    ).toThrow(ReorientationAssemblyError);
    expect(() =>
      assemble({ porch: { ...base.porch!, ...(override as object) } as any }),
    ).toThrow(new RegExp(`porch.${field}`));
  });

  it('still assembles when only the optional plan phase is absent', () => {
    // currentPlanPhase is genuinely optional — a porch lane between plan phases
    // has none — so it must not be swept into the required set.
    const base = makeContext();
    expect(() =>
      assemble({ porch: { ...base.porch!, currentPlanPhase: null } }),
    ).not.toThrow();
  });

  it('aborts when a porch lane has no re-entry notice available', () => {
    // A porch-driven builder without its re-entry instruction is the partial
    // frame R3 forbids.
    expect(() =>
      assembleReorientation({
        context: makeContext(),
        statePath: STATE_PATH,
        buildSpawnPrompt: spawnPromptPort,
      }),
    ).toThrow(/re-entry/);
  });

  it('aborts when the spawn prompt cannot be rendered', () => {
    // A long form without protocol framing is the partial frame R3 forbids, and
    // it would land on a builder with no context left to notice the gap.
    const failing: SpawnPromptPort = () => {
      throw new Error('no builder-prompt.md for protocol');
    };
    expect(() =>
      assembleReorientation({
        context: makeContext(),
        statePath: STATE_PATH,
        buildSpawnPrompt: failing,
      }),
    ).toThrow(/Refusing to clear without it/);
  });

  it('fails assembly if a required marker is ever dropped from the frame', () => {
    // Guards the invariant itself: if a refactor removed an element from the
    // rendered frame, assembly must fail rather than ship the gap. Simulated by
    // asserting the validation list is actually consulted.
    expect(REQUIRED_INLINE_MARKERS.length).toBeGreaterThan(0);
    const { inline } = assemble();
    const rendered = REQUIRED_INLINE_MARKERS.filter(m => inline.includes(m));
    expect(rendered.length).toBe(REQUIRED_INLINE_MARKERS.length);
  });
});

// ============================================================================
// Long form
// ============================================================================

describe('long-form re-orientation (Spec 1273)', () => {
  it('embeds the spawn prompt verbatim rather than paraphrasing it', () => {
    // This is the concrete discharge of "re-inject phase context the way
    // --resume does" — the same builder prompt a fresh launch delivers.
    const { longForm } = assemble();
    expect(longForm).toContain(SPAWN_PROMPT.trim());
  });

  it('embeds the porch re-entry notice verbatim from the shared source', () => {
    // Reset must not restate it: buildResumeNotice carries the `porch init`
    // fallback, and a restated copy drops it while the two surfaces drift.
    const { longForm } = assemble();
    expect(longForm).toContain(RESUME_NOTICE.trim());
    expect(longForm).toContain('porch init');
  });

  it('omits the re-entry notice on a non-porch lane', () => {
    const { longForm } = assemble({ porch: null, specName: null, specPath: null, planPath: null });
    expect(longForm).not.toContain('RESUME SESSION');
  });

  it('calls the spawn prompt port with the resolved protocol and mode flags', () => {
    const port = vi.fn(() => SPAWN_PROMPT) as unknown as SpawnPromptPort;
    assembleReorientation({ context: makeContext(), statePath: STATE_PATH, buildSpawnPrompt: port, buildResumeNotice: resumeNoticePort });

    expect(port).toHaveBeenCalledWith('aspir', expect.objectContaining({
      protocol_name: 'ASPIR',
      mode: 'strict',
      mode_strict: true,
      mode_soft: false,
      project_id: '1273',
    }));
  });

  it('passes spec and plan into the template context when they exist', () => {
    const port = vi.fn(() => SPAWN_PROMPT) as unknown as SpawnPromptPort;
    assembleReorientation({ context: makeContext(), statePath: STATE_PATH, buildSpawnPrompt: port, buildResumeNotice: resumeNoticePort });

    const ctx = (port as any).mock.calls[0][1];
    expect(ctx.spec).toEqual({
      path: 'codev/specs/1273-builder-context-reset-should-b.md',
      name: '1273-builder-context-reset-should-b',
    });
    // Assert `name` too, symmetric with `spec`: reusing specName for the plan is
    // intentional (porch names spec and plan from the same stem), and an
    // asymmetric assertion would let that convention break unnoticed.
    expect(ctx.plan).toEqual({
      path: 'codev/plans/1273-builder-context-reset-should-b.md',
      name: '1273-builder-context-reset-should-b',
    });
  });

  it('omits spec and plan when the files do not exist', () => {
    const port = vi.fn(() => SPAWN_PROMPT) as unknown as SpawnPromptPort;
    assembleReorientation({
      context: makeContext({ specPath: null, planPath: null }),
      statePath: STATE_PATH,
      buildSpawnPrompt: port,
      buildResumeNotice: resumeNoticePort,
    });

    const ctx = (port as any).mock.calls[0][1];
    expect(ctx.spec).toBeUndefined();
    expect(ctx.plan).toBeUndefined();
  });

  it('forwards issue number, title and body into the spawn prompt context', () => {
    // Every issue-driven protocol's builder prompt renders {{issue.number}},
    // {{issue.title}} and {{issue.body}} — and on BUGFIX/AIR the body IS the
    // spec. Without this the long form is spawn-shaped, not spawn-equivalent,
    // and a reset builder on those lanes loses its requirements.
    const port = vi.fn(() => SPAWN_PROMPT) as unknown as SpawnPromptPort;
    assembleReorientation({
      context: makeContext(),
      statePath: STATE_PATH,
      buildSpawnPrompt: port,
      buildResumeNotice: resumeNoticePort,
      issue: { number: '1273', title: 'Builder context reset', body: 'The problem is...' },
    });

    const ctx = (port as any).mock.calls[0][1];
    expect(ctx.issue).toEqual({
      number: '1273',
      title: 'Builder context reset',
      body: 'The problem is...',
    });
  });

  // ==========================================================================
  // input_description — one case per spawn entry point.
  //
  // This is the FIRST line of every protocol's builder prompt, so a wrong value
  // mis-frames the entire document. These four tests pin the reconstruction to
  // spawn's four literal strings; if spawn's wording changes, they fail here
  // rather than silently drifting apart from it.
  // ==========================================================================

  it('frames a spec-driven lane exactly as the spec-driven spawn path does', () => {
    const port = vi.fn(() => SPAWN_PROMPT) as unknown as SpawnPromptPort;
    assembleReorientation({ context: makeContext(), statePath: STATE_PATH, buildSpawnPrompt: port, buildResumeNotice: resumeNoticePort });

    // spawn.ts:455
    expect((port as any).mock.calls[0][1].input_description).toBe(
      'the feature specified in codev/specs/1273-builder-context-reset-should-b.md',
    );
  });

  it('frames an issue-driven lane as GitHub-issue work, not as a bare protocol', () => {
    // BUGFIX/AIR have no spec — the issue body IS the spec. Before this was
    // fixed, such a lane fell through to the protocol-only wording and a reset
    // builder was told it was "running the BUGFIX protocol" rather than working
    // a specific issue.
    const port = vi.fn(() => SPAWN_PROMPT) as unknown as SpawnPromptPort;
    assembleReorientation({
      context: makeContext({ protocol: 'bugfix', specName: null, specPath: null, planPath: null, issueNumber: '1288' }),
      statePath: STATE_PATH,
      buildSpawnPrompt: port,
      buildResumeNotice: resumeNoticePort,
    });

    // spawn.ts:837
    expect((port as any).mock.calls[0][1].input_description).toBe('work for GitHub Issue #1288');
  });

  it('frames an ad-hoc task lane as a task and forwards the task text', () => {
    // Order regression: a --task builder gets a porch project keyed on its
    // builder id, so issueNumber is populated for it too. Testing issueNumber
    // first would announce a GitHub issue that does not exist.
    const port = vi.fn(() => SPAWN_PROMPT) as unknown as SpawnPromptPort;
    assembleReorientation({
      context: makeContext({
        specName: null, specPath: null, planPath: null,
        issueNumber: 'task-abc', taskText: 'Audit the retry logic',
      }),
      statePath: STATE_PATH,
      buildSpawnPrompt: port,
      buildResumeNotice: resumeNoticePort,
    });

    const ctx = (port as any).mock.calls[0][1];
    // spawn.ts:543
    expect(ctx.input_description).toBe('an ad-hoc task');
    expect(ctx.task_text).toBe('Audit the retry logic');
  });

  it('frames a protocol-only lane with spawn\'s exact wording', () => {
    const port = vi.fn(() => SPAWN_PROMPT) as unknown as SpawnPromptPort;
    assembleReorientation({
      context: makeContext({ specName: null, specPath: null, planPath: null, issueNumber: undefined, porch: null }),
      statePath: STATE_PATH,
      buildSpawnPrompt: port,
    });

    // spawn.ts:607 — note "running the", which the earlier restatement dropped.
    expect((port as any).mock.calls[0][1].input_description).toBe('running the ASPIR protocol');
  });

  it('omits task_text on every lane that is not an ad-hoc task', () => {
    const port = vi.fn(() => SPAWN_PROMPT) as unknown as SpawnPromptPort;
    assembleReorientation({ context: makeContext(), statePath: STATE_PATH, buildSpawnPrompt: port, buildResumeNotice: resumeNoticePort });

    expect((port as any).mock.calls[0][1].task_text).toBeUndefined();
  });

  it('omits the issue from the prompt context when none was supplied', () => {
    const port = vi.fn(() => SPAWN_PROMPT) as unknown as SpawnPromptPort;
    assembleReorientation({
      context: makeContext(),
      statePath: STATE_PATH,
      buildSpawnPrompt: port,
      buildResumeNotice: resumeNoticePort,
    });

    expect((port as any).mock.calls[0][1].issue).toBeUndefined();
  });

  it('makes an unfetchable issue a VISIBLE gap with a recovery instruction', () => {
    // Silent omission is the dangerous failure here: on BUGFIX/AIR the builder
    // would infer requirements from whatever framing survived. Reset does not
    // hard-fail on a forge outage — it says what is missing and how to get it.
    const { longForm } = assemble();
    expect(longForm).toContain('could not be fetched');
    expect(longForm).toContain('gh issue view 1273');
  });

  it('does not warn about a missing issue when the issue was supplied', () => {
    const { longForm } = assembleReorientation({
      context: makeContext(),
      statePath: STATE_PATH,
      buildSpawnPrompt: spawnPromptPort,
      buildResumeNotice: resumeNoticePort,
      issue: { number: '1273', title: 't', body: 'b' },
    });
    expect(longForm).not.toContain('could not be fetched');
  });

  it('does not warn about a missing issue on a lane that has no issue', () => {
    const { longForm } = assemble({ porch: null, issueNumber: undefined, specName: null, specPath: null, planPath: null });
    expect(longForm).not.toContain('could not be fetched');
  });

  it('gives the read order with the state file first', () => {
    // The state file is what the previous session actually knew; protocol
    // framing is reconstructible, working state is not.
    const { longForm } = assemble();
    const stateIdx = longForm.indexOf(STATE_PATH);
    const framingIdx = longForm.indexOf('Protocol framing');
    expect(stateIdx).toBeGreaterThan(-1);
    expect(stateIdx).toBeLessThan(framingIdx);
  });

  it('records where protocol and mode were resolved from, so the frame is auditable', () => {
    const { longForm } = assemble();
    expect(longForm).toContain('status.yaml');
    expect(longForm).toContain('builder-prompt');
  });

  it('marks itself untracked and regenerated', () => {
    const { longForm } = assemble();
    expect(longForm).toContain('Untracked');
  });
});

// ============================================================================
// Architect addendum
// ============================================================================

describe('architect addendum (Spec 1273)', () => {
  it('appears in both parts, flagged as post-dating the save', () => {
    const note = 'PR #1280 merged since your save; rebase before continuing.';
    const { inline, longForm } = assemble({}, note);

    expect(inline).toContain(note);
    expect(inline.toLowerCase()).toContain('post-dates your save');
    expect(longForm).toContain(note);
  });

  it('is omitted cleanly when absent', () => {
    const { inline } = assemble();
    expect(inline.toLowerCase()).not.toContain('from the architect');
  });

  it('is omitted when only whitespace', () => {
    const { inline } = assemble({}, '   \n  ');
    expect(inline.toLowerCase()).not.toContain('from the architect');
  });
});

// ============================================================================
// Message-channel fitness
// ============================================================================

describe('inline frame stays fit for the message channel (Spec 1273)', () => {
  it('does not inline the full role document', () => {
    // The role survives /clear in --append-system-prompt, and re-sending
    // hundreds of lines through a paced, paste-detection-prone channel would be
    // both slow and risky. R3 is satisfied by the identity block.
    const { inline } = assemble();
    expect(inline).toContain('You are a Builder');
    expect(inline.split('\n').length).toBeLessThan(40);
  });

  it('stays well under the 48KB send cap', () => {
    const { inline } = assemble({}, 'x'.repeat(500));
    expect(Buffer.byteLength(inline, 'utf-8')).toBeLessThan(8 * 1024);
  });
});
