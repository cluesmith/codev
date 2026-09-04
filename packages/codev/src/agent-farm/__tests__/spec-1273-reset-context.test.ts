/**
 * Spec 1273 Phase 4 — builder context resolution.
 *
 * This phase exists because the plan CMAP caught the first draft assuming the
 * builder registry carried protocol, mode and harness. It does not, and the most
 * important test here is the one proving resolution works when
 * `builders.protocol_name` is NULL — the state every SPIR/ASPIR lane is actually
 * in, and the case a registry-based implementation would have failed on while
 * looking correct in review.
 *
 * Every chain must end in a loud abort rather than a default: a guessed protocol
 * or mode produces a plausible-looking re-orientation that quietly reframes the
 * builder, which is precisely the drift R3 exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  resolveBuilderContext,
  readPorchContext,
  protocolFromStatus,
  issueNumberFromPorchId,
  modeFromBuilderPrompt,
  harnessFromLaunchScript,
  ContextResolutionError,
  type ContextFsPort,
} from '../commands/reset/context.js';

// ============================================================================
// Fixtures
// ============================================================================

const WORKTREE = '/ws/.builders/aspir-1273';
const BRANCH = 'builder/aspir-1273';
const BUILDER_ID = 'builder-aspir-1273';

const STATUS_YAML = `id: '1273'
title: builder-context-reset-should-b
protocol: aspir
phase: implement
plan_phases: []
current_plan_phase: phase_4
iteration: 1
`;

const BUILDER_PROMPT = `You are a Builder. Read codev/roles/builder.md for your full role definition.

# ASPIR Builder (strict mode)

You are implementing the feature specified in codev/specs/1273-x.md.

## Mode: STRICT
You are running in STRICT mode.
`;

const LAUNCH_SCRIPT = `#!/bin/bash
cd "${WORKTREE}"
while true; do
  claude --dangerously-skip-permissions --append-system-prompt "$(cat '${WORKTREE}/.builder-role.md')" "$(cat '${WORKTREE}/.builder-prompt.txt')"
  status=$?
done
`;

/** In-memory worktree. `dirs` maps a directory to its immediate subdirectories. */
function makeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): ContextFsPort {
  return {
    exists: (p) => p in files || p in dirs || Object.keys(files).some(f => f.startsWith(`${p}/`)),
    read: (p) => (p in files ? files[p] : null),
    listDirs: (p) => (p in dirs ? dirs[p] : null),
  };
}

function fullWorktree(overrides: Record<string, string> = {}): ContextFsPort {
  const projectDir = '1273-builder-context-reset-should-b';
  return makeFs(
    {
      [join(WORKTREE, 'codev', 'projects', projectDir, 'status.yaml')]: STATUS_YAML,
      [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
      [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      ...overrides,
    },
    { [join(WORKTREE, 'codev', 'projects')]: [projectDir] },
  );
}

const BASE = { builderId: BUILDER_ID, worktree: WORKTREE, branch: BRANCH };

// ============================================================================
// Protocol
// ============================================================================

describe('protocol resolution (Spec 1273)', () => {
  it('resolves from porch status.yaml when the lane is porch-driven', () => {
    const ctx = resolveBuilderContext({ fs: fullWorktree(), ...BASE });
    expect(ctx.protocol).toBe('aspir');
    expect(ctx.protocolSource).toBe('status.yaml');
  });

  it('resolves correctly for a spec-type builder whose registry protocol_name is NULL', () => {
    // THE case this phase exists for. Nothing in resolution touches the registry,
    // so a NULL protocol_name — the state of every SPIR/ASPIR lane — is a non-event.
    const ctx = resolveBuilderContext({ fs: fullWorktree(), ...BASE });
    expect(ctx.protocol).toBe('aspir');
  });

  it('falls back to the canonical builder id when there is no porch project', () => {
    const fs = makeFs({
      [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
      [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
    });
    const ctx = resolveBuilderContext({ fs, ...BASE });
    expect(ctx.protocol).toBe('aspir');
    expect(ctx.protocolSource).toBe('builder-id');
  });

  it('aborts when neither source names a protocol', () => {
    const fs = makeFs({
      [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
      [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
    });
    expect(() =>
      resolveBuilderContext({ fs, ...BASE, builderId: 'some-legacy-name' }),
    ).toThrow(ContextResolutionError);
  });

  it('prefers status.yaml over the builder id when they agree on ownership', () => {
    // status.yaml is what porch is actually running, so it wins for phase,
    // plan phase and project identity.
    const ctx = resolveBuilderContext({ fs: fullWorktree(), ...BASE });
    expect(ctx.protocol).toBe('aspir');
    expect(ctx.protocolSource).toBe('status.yaml');
  });

  it('treats a PROTOCOL disagreement as "not my project", not as a correction', () => {
    // DELIBERATE REVERSAL of the original phase-4 behaviour, forced by the
    // verify-phase e2e.
    //
    // Before: a project matching on the number won even when its protocol
    // disagreed with the builder id, on the principle that status.yaml is
    // authoritative. That principle is right for a builder's OWN project and
    // wrong as a way of DECIDING which project is its own — and the two cannot
    // both hold, because the signal is identical in each case.
    //
    // Live harm decided it: issue 799 is used by both a PIR project and a
    // bugfix, so `builder-bugfix-799` silently adopted the PIR project's
    // protocol and porch id. A hypothetical id/status protocol disagreement
    // within one project is the cost; adopting a stranger's project is the
    // thing actually happening in this repo.
    const ctx = resolveBuilderContext({
      fs: fullWorktree(),
      ...BASE,
      builderId: 'builder-spir-1273',
    });

    expect(ctx.protocol).toBe('spir');
    expect(ctx.protocolSource).toBe('builder-id');
    expect(ctx.porch).toBeNull();
  });

  it('protocolFromStatus returns null when there are no project dirs', () => {
    expect(protocolFromStatus(makeFs({}), WORKTREE, { builderId: BUILDER_ID })).toBeNull();
  });
});

// ============================================================================
// Porch context
// ============================================================================

describe('porch context (Spec 1273)', () => {
  it('reads phase and current plan phase', () => {
    const porch = readPorchContext(fullWorktree(), WORKTREE, { builderId: BUILDER_ID });
    expect(porch?.phase).toBe('implement');
    expect(porch?.currentPlanPhase).toBe('phase_4');
    expect(porch?.projectId).toBe('1273');
  });

  it('treats a literal null current_plan_phase as absent', () => {
    const fs = fullWorktree({
      [join(WORKTREE, 'codev', 'projects', '1273-builder-context-reset-should-b', 'status.yaml')]:
        STATUS_YAML.replace('current_plan_phase: phase_4', 'current_plan_phase: null'),
    });
    expect(readPorchContext(fs, WORKTREE, { builderId: BUILDER_ID })?.currentPlanPhase).toBeNull();
  });

  it('returns null for a non-porch lane instead of throwing', () => {
    // A task or shell builder is a legitimate reset target — it just gets no
    // porch re-entry block. This is a branch, not a gate failure.
    const fs = makeFs({
      [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
      [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
    });
    expect(readPorchContext(fs, WORKTREE, { builderId: BUILDER_ID })).toBeNull();

    const ctx = resolveBuilderContext({ fs, ...BASE });
    expect(ctx.porch).toBeNull();
  });
});

// ============================================================================
// Mode
// ============================================================================

describe('mode resolution (Spec 1273)', () => {
  it('reads the literal "## Mode: STRICT" line the builder was given', () => {
    expect(modeFromBuilderPrompt(fullWorktree(), WORKTREE)).toBe('strict');
  });

  it('reads SOFT too', () => {
    const fs = fullWorktree({
      [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT.replace('## Mode: STRICT', '## Mode: SOFT'),
    });
    expect(modeFromBuilderPrompt(fs, WORKTREE)).toBe('soft');
  });

  it('lets --mode win over the worktree', () => {
    const ctx = resolveBuilderContext({ fs: fullWorktree(), ...BASE, modeOverride: 'soft' });
    expect(ctx.mode).toBe('soft');
    expect(ctx.modeSource).toBe('flag');
  });

  it('aborts naming --mode when the prompt file has no mode line', () => {
    // Mode is persisted NOWHERE else — resolveMode cannot recover a spawn-time
    // --soft after the fact — so guessing here would silently reframe the builder.
    const fs = fullWorktree({
      [join(WORKTREE, '.builder-prompt.txt')]: 'You are a Builder.\n',
    });
    expect(() => resolveBuilderContext({ fs, ...BASE })).toThrow(/--mode/);
  });

  it('aborts when the prompt file is missing entirely', () => {
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '1273-x', 'status.yaml')]: STATUS_YAML,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['1273-x'] },
    );
    expect(() => resolveBuilderContext({ fs, ...BASE })).toThrow(ContextResolutionError);
  });
});

// ============================================================================
// Harness
// ============================================================================

describe('harness resolution (Spec 1273)', () => {
  it('identifies the harness from the launch script', () => {
    expect(harnessFromLaunchScript(fullWorktree(), WORKTREE)).toBe('claude');
  });

  it('ignores the cd and export lines when scanning', () => {
    expect(harnessFromLaunchScript(fullWorktree(), WORKTREE)).not.toBe('codex');
  });

  it('resolves a claude builder and reports the harness', () => {
    const ctx = resolveBuilderContext({ fs: fullWorktree(), ...BASE });
    expect(ctx.harnessName).toBe('claude');
    expect(ctx.harness.supportsContextReset).toBe(true);
  });

  it('aborts loudly for a harness without in-session reset, naming it', () => {
    const fs = fullWorktree({
      [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT.replace('claude ', 'codex '),
    });
    expect(() => resolveBuilderContext({ fs, ...BASE })).toThrow(/codex/);
    expect(() => resolveBuilderContext({ fs, ...BASE })).toThrow(/no in-session context reset/);
  });

  it('aborts when the launch script names no recognisable harness', () => {
    const fs = fullWorktree({
      [join(WORKTREE, '.builder-start.sh')]: '#!/bin/bash\ncd /tmp\nwhile true; do\n  ./some-agent\ndone\n',
    });
    expect(() => resolveBuilderContext({ fs, ...BASE })).toThrow(/harness/);
  });

  it('aborts when the launch script is missing', () => {
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '1273-x', 'status.yaml')]: STATUS_YAML,
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['1273-x'] },
    );
    expect(() => resolveBuilderContext({ fs, ...BASE })).toThrow(ContextResolutionError);
  });
});

// ============================================================================
// Whole-context behaviour
// ============================================================================

describe('resolveBuilderContext (Spec 1273)', () => {
  it('returns every field R3 requires', () => {
    const ctx = resolveBuilderContext({ fs: fullWorktree(), ...BASE, issueNumber: '1273' });

    expect(ctx.builderId).toBe(BUILDER_ID);
    expect(ctx.worktree).toBe(WORKTREE);
    expect(ctx.branch).toBe(BRANCH);
    expect(ctx.protocol).toBe('aspir');
    expect(ctx.mode).toBe('strict');
    expect(ctx.harnessName).toBe('claude');
    expect(ctx.porch?.phase).toBe('implement');
    expect(ctx.issueNumber).toBe('1273');
  });

  it('reports where protocol and mode came from, so the report is auditable', () => {
    const ctx = resolveBuilderContext({ fs: fullWorktree(), ...BASE });
    expect(ctx.protocolSource).toBe('status.yaml');
    expect(ctx.modeSource).toBe('builder-prompt');
  });

  it('aborts when the worktree does not exist', () => {
    expect(() => resolveBuilderContext({ fs: makeFs({}), ...BASE })).toThrow(/Worktree not found/);
  });

  it('resolves the artifact identity phase 5 needs to rebuild the spawn template context', () => {
    const projectDir = '1273-builder-context-reset-should-b';
    const fs = fullWorktree({
      [join(WORKTREE, 'codev', 'specs', `${projectDir}.md`)]: '# spec',
      [join(WORKTREE, 'codev', 'plans', `${projectDir}.md`)]: '# plan',
    });
    const ctx = resolveBuilderContext({ fs, ...BASE });

    expect(ctx.specName).toBe(projectDir);
    expect(ctx.specPath).toBe(join('codev', 'specs', `${projectDir}.md`));
    expect(ctx.planPath).toBe(join('codev', 'plans', `${projectDir}.md`));
  });

  it('reports a missing plan as null rather than pointing at a file that is not there', () => {
    // A pointer to a nonexistent plan would send a freshly-reset builder — one
    // with no memory to cross-check against — chasing a ghost.
    const projectDir = '1273-builder-context-reset-should-b';
    const fs = fullWorktree({
      [join(WORKTREE, 'codev', 'specs', `${projectDir}.md`)]: '# spec',
    });
    const ctx = resolveBuilderContext({ fs, ...BASE });

    expect(ctx.specPath).toBe(join('codev', 'specs', `${projectDir}.md`));
    expect(ctx.planPath).toBeNull();
  });

  it('has no artifact identity on a non-porch lane', () => {
    const fs = makeFs({
      [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
      [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
    });
    const ctx = resolveBuilderContext({ fs, ...BASE });

    expect(ctx.specName).toBeNull();
    expect(ctx.specPath).toBeNull();
    expect(ctx.planPath).toBeNull();
  });

  it('falls back to the porch project id for the issue number', () => {
    // Issue-driven protocols name the porch project after the issue, so this is
    // the right value when the registry row carries none.
    const ctx = resolveBuilderContext({ fs: fullWorktree(), ...BASE });
    expect(ctx.issueNumber).toBe('1273');
  });

  it('prefers an explicitly supplied issue number over the project id', () => {
    const ctx = resolveBuilderContext({ fs: fullWorktree(), ...BASE, issueNumber: '999' });
    expect(ctx.issueNumber).toBe('999');
  });
});

// ============================================================================
// Custom harnesses
// ============================================================================

describe('custom harness resolution (Spec 1273)', () => {
  const custom = {
    'acme-agent': {
      command: 'acme-agent',
      roleArgs: ['--system', '${ROLE_FILE}'],
      roleScriptFragment: "--system '${ROLE_FILE}'",
    },
  } as any;

  function customWorktree() {
    return fullWorktree({
      [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT.replace('claude ', 'acme-agent '),
    });
  }

  it('recognises a project-defined harness from the launch script', () => {
    expect(harnessFromLaunchScript(customWorktree(), WORKTREE, custom)).toBe('acme-agent');
  });

  it('maps it to a real provider and refuses on the accurate ground', () => {
    // Without custom-harness support the refusal would be "unrecognisable
    // launch command", sending the project to debug its config. The accurate
    // refusal is that this harness cannot clear context in-session.
    expect(() => resolveBuilderContext({ fs: customWorktree(), ...BASE, customHarnesses: custom }))
      .toThrow(/no in-session context reset/);
    expect(() => resolveBuilderContext({ fs: customWorktree(), ...BASE, customHarnesses: custom }))
      .toThrow(/acme-agent/);
  });

  it('still reports an unknown harness as unrecognisable when no config defines it', () => {
    expect(() => resolveBuilderContext({ fs: customWorktree(), ...BASE }))
      .toThrow(/Cannot determine the harness/);
  });

  it('prefers a longer custom name over a builtin substring match', () => {
    const shadowing = { 'claude-experimental': { command: 'claude-experimental', roleArgs: [], roleScriptFragment: '' } } as any;
    const fs = fullWorktree({
      [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT.replace('claude ', 'claude-experimental '),
    });
    expect(harnessFromLaunchScript(fs, WORKTREE, shadowing)).toBe('claude-experimental');
  });
});

// ============================================================================
// Launch-script scanning precision
// ============================================================================

describe('harness detection matches command position only (Spec 1273)', () => {
  it('does not false-positive on a harness name inside a conditional', () => {
    // Naming the wrong harness is not a harmless misread: it either refuses a
    // resettable builder, or — worse — approves typing /clear into one that
    // cannot reset. So detection matches the command, not the whole line.
    const script = [
      '#!/bin/bash',
      `cd "${WORKTREE}"`,
      'if [ "$HARNESS" = "codex" ]; then',
      '  echo "not this one"',
      'fi',
      'while true; do',
      '  claude --append-system-prompt "$(cat role.md)"',
      'done',
    ].join('\n');
    const fs = fullWorktree({ [join(WORKTREE, '.builder-start.sh')]: script });

    expect(harnessFromLaunchScript(fs, WORKTREE)).toBe('claude');
  });

  it('does not treat a variable assignment mentioning a harness as an invocation', () => {
    const script = `#!/bin/bash\nAGENT_KIND=codex\nwhile true; do\n  claude --foo\ndone\n`;
    const fs = fullWorktree({ [join(WORKTREE, '.builder-start.sh')]: script });

    expect(harnessFromLaunchScript(fs, WORKTREE)).toBe('claude');
  });

  it('resolves an absolute path to its basename', () => {
    const script = `#!/bin/bash\nwhile true; do\n  /usr/local/bin/claude --resume abc\ndone\n`;
    const fs = fullWorktree({ [join(WORKTREE, '.builder-start.sh')]: script });

    expect(harnessFromLaunchScript(fs, WORKTREE)).toBe('claude');
  });

  it('sees through an env-var prefix and an exec', () => {
    const script = `#!/bin/bash\nwhile true; do\n  exec FOO=1 claude --resume abc\ndone\n`;
    const fs = fullWorktree({ [join(WORKTREE, '.builder-start.sh')]: script });

    expect(harnessFromLaunchScript(fs, WORKTREE)).toBe('claude');
  });

  it('ignores comments that mention a harness', () => {
    const script = `#!/bin/bash\n# previously ran under codex\nwhile true; do\n  claude --foo\ndone\n`;
    const fs = fullWorktree({ [join(WORKTREE, '.builder-start.sh')]: script });

    expect(harnessFromLaunchScript(fs, WORKTREE)).toBe('claude');
  });

  it('is read-only — no writes anywhere', () => {
    const calls: string[] = [];
    const base = fullWorktree();
    const fs: ContextFsPort = {
      exists: (p) => { calls.push(`exists:${p}`); return base.exists(p); },
      read: (p) => { calls.push(`read:${p}`); return base.read(p); },
      listDirs: (p) => { calls.push(`listDirs:${p}`); return base.listDirs(p); },
    };

    resolveBuilderContext({ fs, ...BASE });

    expect(calls.every(c => /^(exists|read|listDirs):/.test(c))).toBe(true);
  });
});

// ============================================================================
// F1 — the wrong-winner blocker found by the live e2e (2026-07-31)
// ============================================================================

describe('porch project selection is by identity, never by position (Spec 1273 F1)', () => {
  /**
   * A worktree shaped like this repo's real ones.
   *
   * Porch history is committed to `main`, so every worktree inherits every
   * project ever run — 203 of them when this bug was found. The
   * alphabetically-first is a `spider`-era project, and the original
   * implementation returned the first parsable `status.yaml`, so EVERY builder
   * resolved protocol `spider` and died on
   * `Protocol "spider" has no builder-prompt.md`.
   *
   * The fixture reproduces the essential shape: historical dirs sorting before
   * the builder's own, each with a valid but foreign status.yaml.
   */
  function inheritedHistoryWorktree(ownDir = '1273-builder-context-reset-should-b') {
    const historical = [
      '0087-porch-timeout-termination-retries',
      '0088-porch-version-constant',
      '0092-terminal-file-links',
    ];
    const files: Record<string, string> = {
      [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
      [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      [join(WORKTREE, 'codev', 'projects', ownDir, 'status.yaml')]: STATUS_YAML,
    };
    for (const [i, dir] of historical.entries()) {
      files[join(WORKTREE, 'codev', 'projects', dir, 'status.yaml')] =
        `id: '00${87 + i}'\ntitle: ${dir}\nprotocol: spider\nphase: implement\n`;
    }
    return makeFs(files, {
      [join(WORKTREE, 'codev', 'projects')]: [...historical, ownDir],
    });
  }

  it('picks the builder\'s own project, not the alphabetically-first', () => {
    const porch = readPorchContext(inheritedHistoryWorktree(), WORKTREE, {
      builderId: BUILDER_ID,
    });

    expect(porch?.projectId).toBe('1273');
    expect(porch?.protocol).toBe('aspir');
    // The exact regression: `spider` must never be the answer.
    expect(porch?.protocol).not.toBe('spider');
  });

  it('resolves the whole context correctly despite 3 foreign projects', () => {
    const ctx = resolveBuilderContext({ fs: inheritedHistoryWorktree(), ...BASE });
    expect(ctx.protocol).toBe('aspir');
    expect(ctx.protocolSource).toBe('status.yaml');
    expect(ctx.porch?.projectName).toBe('1273-builder-context-reset-should-b');
  });

  it('returns null — not a foreign project — when this builder owns none', () => {
    // The live probe `task-re_v` had no porch project of its own but inherited
    // 203 others. Returning any of them is a confident lie; null is the truth,
    // and phase 5 renders a frame without a porch block for it.
    const porch = readPorchContext(inheritedHistoryWorktree(), WORKTREE, {
      builderId: 'builder-task-re_v',
    });

    expect(porch).toBeNull();
  });

  it('matches on the issue number for an issue-driven lane', () => {
    // The builder's own project carries its own protocol — a bugfix builder's
    // project is a bugfix project. A number match against a project of a
    // DIFFERENT protocol is rejected; see the number-collision suite below.
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '0087-old', 'status.yaml')]:
          "id: '0087'\nprotocol: spider\nphase: implement\n",
        [join(WORKTREE, 'codev', 'projects', '1279-fix-something', 'status.yaml')]:
          "id: '1279'\nprotocol: bugfix\nphase: implement\n",
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['0087-old', '1279-fix-something'] },
    );

    const porch = readPorchContext(fs, WORKTREE, {
      builderId: 'builder-bugfix-1279',
      issueNumber: '1279',
    });
    expect(porch?.projectName).toBe('1279-fix-something');
  });

  it('tolerates leading zeros between the id and the directory name', () => {
    // Project dirs use `0087-…` while porch ids and CLI arguments use `87`
    // (the same split as `afx cleanup -p 466` vs `0466`).
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '0087-old-bugfix', 'status.yaml')]:
          "id: '0087'\nprotocol: bugfix\nphase: implement\n",
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['0087-old-bugfix'] },
    );

    const porch = readPorchContext(fs, WORKTREE, { builderId: 'builder-bugfix-87' });
    expect(porch?.projectName).toBe('0087-old-bugfix');
  });

  it('matches case-insensitively, so a case-sensitive filesystem behaves like macOS', () => {
    // The registry lowercases builder ids while directories preserve case
    // (`builder-task-re_v` vs `.builders/task-RE_V`). macOS hides the mismatch.
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', 'task-RE_V-probe', 'status.yaml')]:
          "id: 'task-RE_V'\nprotocol: task\nphase: implement\n",
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['task-RE_V-probe'] },
    );

    const porch = readPorchContext(fs, WORKTREE, { builderId: 'builder-task-re_v' });
    expect(porch?.projectName).toBe('task-RE_V-probe');
  });
});

// ============================================================================
// F2 — the task lane could never auto-detect its mode
// ============================================================================

describe('mode resolution for the ad-hoc task lane (Spec 1273 F2)', () => {
  /** A `--task` spawn: bare prompt, no `## Mode:` heading, no porch project. */
  function taskWorktree() {
    return makeFs(
      {
        [join(WORKTREE, '.builder-prompt.txt')]:
          'You are a Builder. Read codev/roles/builder.md for your full role definition.\n\n# Task\n\nBe a probe.',
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: [] },
    );
  }

  it('defaults a no-porch builder to soft instead of hard-erroring', () => {
    // Before this, `afx refresh <task-builder>` could not run at all without an
    // explicit --mode: task spawns never render the `## Mode:` line.
    const ctx = resolveBuilderContext({
      fs: taskWorktree(),
      builderId: 'builder-task-re_v',
      worktree: WORKTREE,
      branch: 'builder/task-RE_V',
      taskText: 'Be a probe.',
    });

    expect(ctx.mode).toBe('soft');
    // The source is recorded, so the report says where it came from rather than
    // implying the worktree stated it.
    expect(ctx.modeSource).toBe('task-default');
  });

  it('still aborts when a PORCH builder is missing its Mode line', () => {
    // The default is scoped to the no-porch lane. A porch-driven builder with no
    // `## Mode:` line is a genuine ambiguity — strict vs soft changes whether
    // porch orchestrates — and must not be guessed.
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '1273-x', 'status.yaml')]: STATUS_YAML,
        [join(WORKTREE, '.builder-prompt.txt')]: 'No mode heading here.',
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['1273-x'] },
    );

    expect(() => resolveBuilderContext({ fs, ...BASE })).toThrow(/Cannot determine the mode/);
  });

  it('lets an explicit --mode win over the task default', () => {
    const ctx = resolveBuilderContext({
      fs: taskWorktree(),
      builderId: 'builder-task-re_v',
      worktree: WORKTREE,
      branch: 'builder/task-RE_V',
      taskText: 'Be a probe.',
      modeOverride: 'strict',
    });
    expect(ctx.mode).toBe('strict');
    expect(ctx.modeSource).toBe('flag');
  });
});

describe('the --task --protocol lane keeps its porch project (Spec 1273 verify iter 1)', () => {
  it('matches a porch project id that carries the raw builder- prefix', () => {
    // `spawn --task --protocol X` passes the FULL builderId to porch init
    // (spawn.ts:548) and the sanitiser keeps dashes, so the project id really is
    // `builder-task-<id>`. Matching only the stripped forms orphaned this lane:
    // porch resolved to null and the builder was re-oriented as protocol TASK
    // with no porch re-entry — degraded silently rather than failing loudly.
    const dir = 'builder-task-abc-task-abc';
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '0087-old', 'status.yaml')]:
          "id: '0087'\nprotocol: spider\nphase: implement\n",
        [join(WORKTREE, 'codev', 'projects', dir, 'status.yaml')]:
          "id: 'builder-task-abc'\nprotocol: air\nphase: implement\n",
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['0087-old', dir] },
    );

    const porch = readPorchContext(fs, WORKTREE, { builderId: 'builder-task-abc' });

    expect(porch?.projectId).toBe('builder-task-abc');
    expect(porch?.protocol).toBe('air');
  });

  it('still resolves protocol and porch re-entry for that lane end to end', () => {
    const dir = 'builder-task-abc-task-abc';
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', dir, 'status.yaml')]:
          "id: 'builder-task-abc'\nprotocol: air\nphase: implement\n",
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: [dir] },
    );

    const ctx = resolveBuilderContext({
      fs,
      builderId: 'builder-task-abc',
      worktree: WORKTREE,
      branch: 'builder/task-abc',
    });

    expect(ctx.protocol).toBe('air');
    expect(ctx.protocolSource).toBe('status.yaml');
    expect(ctx.porch).not.toBeNull();
    // Mode comes from the prompt, NOT the task default — this lane has porch.
    expect(ctx.modeSource).toBe('builder-prompt');
    // And no fabricated issue: this lane's porch id is `builder-task-abc`, not
    // an issue number. Falling back to it would render `- Issue: #builder-task-abc`
    // and an unfollowable `gh issue view` in the re-orientation — sending a
    // reset builder to look up requirements that do not exist.
    expect(ctx.issueNumber).toBeUndefined();
  });
});

describe('a bare project NUMBER is not enough to claim a builder (Spec 1273 verify iter 3)', () => {
  /** Issue 799 really is used by both a PIR project and a bugfix in this repo. */
  function numberCollisionWorktree() {
    return makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '799-vscode-builder-changed-file-ro', 'status.yaml')]:
          "id: '799'\nprotocol: pir\nphase: implement\n",
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['799-vscode-builder-changed-file-ro'] },
    );
  }

  it('does not hand a bugfix builder the PIR project that shares its number', () => {
    // The wrong-winner class, second instance: the first fix stopped
    // alphabetically-first from winning, but a bare-number match still let ONE
    // project claim any builder sharing the digits — across protocols. Verified
    // live on builder-bugfix-799.
    const porch = readPorchContext(numberCollisionWorktree(), WORKTREE, {
      builderId: 'builder-bugfix-799',
      issueNumber: '799',
    });

    expect(porch).toBeNull();
  });

  it('accepts the same number when the protocol agrees', () => {
    const porch = readPorchContext(numberCollisionWorktree(), WORKTREE, {
      builderId: 'builder-pir-799',
      issueNumber: '799',
    });

    expect(porch?.projectName).toBe('799-vscode-builder-changed-file-ro');
    expect(porch?.protocol).toBe('pir');
  });

  it('falls back to the builder id for the protocol, rather than adopting a foreign one', () => {
    // The end-to-end consequence: with no project of its own, the bugfix builder
    // still resolves protocol `bugfix` from its id and simply gets no porch
    // block — a visible absence, not a confident lie.
    const ctx = resolveBuilderContext({
      fs: numberCollisionWorktree(),
      builderId: 'builder-bugfix-799',
      worktree: WORKTREE,
      branch: 'builder/bugfix-799',
      issueNumber: '799',
    });

    expect(ctx.protocol).toBe('bugfix');
    expect(ctx.protocolSource).toBe('builder-id');
    expect(ctx.porch).toBeNull();
  });

  it('still lets a non-numeric project id claim across a protocol mismatch', () => {
    // The --task --protocol lane: id `builder-task-abc` is globally unique, so
    // it needs no corroboration — which matters because its protocol (air)
    // legitimately differs from its id prefix (task).
    const dir = 'builder-task-abc-task-abc';
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', dir, 'status.yaml')]:
          "id: 'builder-task-abc'\nprotocol: air\nphase: implement\n",
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: [dir] },
    );

    expect(readPorchContext(fs, WORKTREE, { builderId: 'builder-task-abc' })?.protocol).toBe('air');
  });

  it('aborts rather than choosing between two equally-strong claims', () => {
    // Picking the "least wrong" of several is the original bug with better
    // manners. If two projects genuinely claim a builder, say so.
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '1273-a', 'status.yaml')]:
          "id: '1273'\nprotocol: aspir\nphase: implement\n",
        [join(WORKTREE, 'codev', 'projects', '1273-b', 'status.yaml')]:
          "id: '1273'\nprotocol: aspir\nphase: review\n",
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['1273-a', '1273-b'] },
    );

    expect(() => readPorchContext(fs, WORKTREE, { builderId: BUILDER_ID })).toThrow(/Ambiguous/);
  });
});

// ============================================================================
// Retroactive codex review of the merged #1308 (2026-07-31)
// ============================================================================

describe('post-merge codex findings (Spec 1273)', () => {
  it('a status.yaml that states a DIFFERENT id is not overruled by its directory name', () => {
    // `codev/projects/1273-old/` holding `id: '999'` belongs to 999, whatever
    // the directory is called. The dir-name fallback previously overruled that,
    // letting a renamed or recycled directory claim a builder — and
    // manufacturing false ambiguities beside the real project.
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '1273-old', 'status.yaml')]:
          "id: '999'\nprotocol: aspir\nphase: implement\n",
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['1273-old'] },
    );

    expect(readPorchContext(fs, WORKTREE, { builderId: BUILDER_ID })).toBeNull();
  });

  it('still falls back to the directory name when the file states no id at all', () => {
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '1273-x', 'status.yaml')]:
          'protocol: aspir\nphase: implement\n',
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['1273-x'] },
    );

    expect(readPorchContext(fs, WORKTREE, { builderId: BUILDER_ID })?.projectName).toBe('1273-x');
  });

  it('rejects a weak claim when the builder id yields no protocol to corroborate with', () => {
    // The previous code's own comment said a noncanonical id "cannot be
    // corroborated and is not trusted" while `if (expectedProtocol && mismatch)`
    // let EVERY weak claim through when expectedProtocol was null. A legacy
    // builder could adopt any historical project sharing its tail.
    const fs = makeFs(
      {
        [join(WORKTREE, 'codev', 'projects', '1273-x', 'status.yaml')]: STATUS_YAML,
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: ['1273-x'] },
    );

    expect(readPorchContext(fs, WORKTREE, { builderId: 'some-legacy-name-1273' })).toBeNull();
  });

  it('recovers a BUGFIX issue number from its <prefix>-<N> porch id', () => {
    // BUGFIX deliberately stores `bugfix-<N>` (spawn.ts:817). The strict /^\d+$/
    // guard threw that identity away when the registry row had none — and on
    // BUGFIX the issue body IS the spec, so the re-orientation lost the
    // requirements it exists to carry.
    expect(issueNumberFromPorchId('bugfix-887')).toBe('887');
    expect(issueNumberFromPorchId('1273')).toBe('1273');
    // But an ad-hoc task id still cannot masquerade as an issue.
    expect(issueNumberFromPorchId('builder-task-abc')).toBeUndefined();
    expect(issueNumberFromPorchId(undefined)).toBeUndefined();
  });

  it('does not treat a --task --protocol builder as bare when porch init failed', () => {
    // initPorchInWorktree is deliberately non-fatal, so that lane can have task
    // text AND no porch. Inferring "bare" from that stripped its real protocol
    // template. The prompt is written BEFORE porch init, so its rendered
    // template — and its `## Mode:` line — is the positive evidence.
    const fs = makeFs(
      {
        [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT, // rendered template, has Mode
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: [] },
    );

    const ctx = resolveBuilderContext({
      fs,
      builderId: 'builder-task-abc',
      worktree: WORKTREE,
      branch: 'builder/task-abc',
      taskText: 'ad-hoc work',
    });

    expect(ctx.isBareTask).toBe(false);
    // And its real mode survives, rather than being defaulted to soft.
    expect(ctx.mode).toBe('strict');
    expect(ctx.modeSource).toBe('builder-prompt');
  });

  it('is bare only with task text AND no rendered template', () => {
    const bare = makeFs(
      {
        [join(WORKTREE, '.builder-prompt.txt')]: 'You are a Builder.\n\n# Task\n\nBe a probe.',
        [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
      },
      { [join(WORKTREE, 'codev', 'projects')]: [] },
    );

    const ctx = resolveBuilderContext({
      fs: bare,
      builderId: 'builder-task-re_v',
      worktree: WORKTREE,
      branch: 'builder/task-RE_V',
      taskText: 'Be a probe.',
    });

    expect(ctx.isBareTask).toBe(true);
  });
});
