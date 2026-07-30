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

  it('prefers status.yaml over the builder id when they disagree', () => {
    // status.yaml is what porch is actually running.
    const ctx = resolveBuilderContext({ fs: fullWorktree(), ...BASE, builderId: 'builder-spir-1273' });
    expect(ctx.protocol).toBe('aspir');
  });

  it('protocolFromStatus returns null when there are no project dirs', () => {
    expect(protocolFromStatus(makeFs({}), WORKTREE)).toBeNull();
  });
});

// ============================================================================
// Porch context
// ============================================================================

describe('porch context (Spec 1273)', () => {
  it('reads phase and current plan phase', () => {
    const porch = readPorchContext(fullWorktree(), WORKTREE);
    expect(porch?.phase).toBe('implement');
    expect(porch?.currentPlanPhase).toBe('phase_4');
    expect(porch?.projectId).toBe('1273');
  });

  it('treats a literal null current_plan_phase as absent', () => {
    const fs = fullWorktree({
      [join(WORKTREE, 'codev', 'projects', '1273-builder-context-reset-should-b', 'status.yaml')]:
        STATUS_YAML.replace('current_plan_phase: phase_4', 'current_plan_phase: null'),
    });
    expect(readPorchContext(fs, WORKTREE)?.currentPlanPhase).toBeNull();
  });

  it('returns null for a non-porch lane instead of throwing', () => {
    // A task or shell builder is a legitimate reset target — it just gets no
    // porch re-entry block. This is a branch, not a gate failure.
    const fs = makeFs({
      [join(WORKTREE, '.builder-prompt.txt')]: BUILDER_PROMPT,
      [join(WORKTREE, '.builder-start.sh')]: LAUNCH_SCRIPT,
    });
    expect(readPorchContext(fs, WORKTREE)).toBeNull();

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
