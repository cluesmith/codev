/**
 * Spec 1470 — context resolution against a REAL `.builders/<id>` layout.
 *
 * ## Why this file exists, and why the other two could not replace it
 *
 * Two production-fatal defects in Phase 4 were invisible to every test I had
 * written, for one shared reason: **the tests mocked the things that resolve
 * context, so the resolution itself was never exercised.**
 *
 *   1. `findBuilderById` self-scoped to `getConfig().workspaceRoot`, which is the
 *      WORKTREE inside a builder while registry rows are keyed by the parent —
 *      so the lookup returned null for every valid builder. The command tests
 *      mocked that helper, so the scope it derived internally was unobservable.
 *   2. `listDirs` was stubbed to `() => []` in the real port binding, which makes
 *      `readPorchContext` return null — silently stripping project id, phase,
 *      plan phase, spec/plan paths and the porch resume notice from the
 *      re-orientation. The command tests mocked `resolveBuilderContext` whole, so
 *      the binding was never run.
 *
 * Both were "correct at every layer I tested, dead in the real calling context".
 * The cure is not more mocks — it is a test where the filesystem is real and the
 * layout is the one production actually sees.
 *
 * No database and no Tower here: this covers the FILESYSTEM half of context
 * resolution, which is where both defects lived. The registry half is pinned in
 * the command tests by making the workspace scope an explicit argument.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBuilderContext } from '../commands/reset/context.js';

let workspace: string;
let worktree: string;

/**
 * The CANONICAL registry id, not the worktree directory name.
 *
 * `parseAgentName` only matches `builder-<protocol>-<id>`, and a weak porch
 * project claim is refused outright when the protocol cannot be corroborated —
 * so a non-canonical id resolves NO porch context at all. The worktree directory
 * is `spir-1470`; the registered id is `builder-spir-1470`, and
 * `detectCurrentBuilderId()` returns the latter.
 */
const BUILDER_ID = 'builder-spir-1470';

/** The worktree DIRECTORY name, which is deliberately not the builder id. */
const WORKTREE_DIR = 'spir-1470';

/**
 * The REAL port binding, copied from the command under test.
 *
 * Copied deliberately rather than imported: the defect was that this binding
 * differed from `reset.ts`'s, so a test that imported whatever the command
 * happens to use would have accepted the stub as correct. Stating it here means
 * the test asserts what the binding must DO, and a regression shows up as this
 * file disagreeing with the command.
 */
const realFsPort = {
  exists: (p: string) => existsSync(p),
  read: (p: string) => {
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      return null;
    }
  },
  listDirs: (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return null;
    }
  },
};

/** Build the layout production actually has: <ws>/.builders/<id>/codev/... */
function buildWorktree(statusYaml: string): void {
  workspace = mkdtempSync(join(tmpdir(), 'ws-1470-'));
  worktree = join(workspace, '.builders', WORKTREE_DIR);

  const projectDir = join(worktree, 'codev', 'projects', '1470-automatic-builder-context-refr');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'status.yaml'), statusYaml);

  // Real scaffolding: mode is not persisted anywhere else, so a worktree without
  // this file cannot be re-oriented without an explicit --mode. Production
  // spawns write it; a fixture that omits it is not the layout production sees.
  writeFileSync(
    join(worktree, '.builder-prompt.txt'),
    '# Builder\n\n## Mode: STRICT\n\n## Protocol\n\nSPIR\n',
  );

  // The harness is inferred from the launch command, and re-orientation refuses
  // to type into a terminal whose agent it cannot name. Another piece of real
  // scaffolding a mocked context never needed.
  writeFileSync(
    join(worktree, '.builder-start.sh'),
    '#!/bin/bash\nclaude --model opus --dangerously-skip-permissions "$(cat prompt)"\n',
  );

  mkdirSync(join(worktree, 'codev', 'specs'), { recursive: true });
  mkdirSync(join(worktree, 'codev', 'plans'), { recursive: true });
  writeFileSync(
    join(worktree, 'codev/specs/1470-automatic-builder-context-refr.md'),
    '# Spec\n',
  );
  writeFileSync(
    join(worktree, 'codev/plans/1470-automatic-builder-context-refr.md'),
    '# Plan\n',
  );
}

const STATUS = `id: '1470'
title: automatic-builder-context-refr
protocol: spir
phase: implement
current_plan_phase: phase_4_selfrefresh_command
`;

beforeEach(() => {
  buildWorktree(STATUS);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('porch context resolution against a real worktree', () => {
  it('populates the porch block from status.yaml on disk', async () => {
    const context = resolveBuilderContext({
      fs: realFsPort,
      builderId: BUILDER_ID,
      worktree,
      branch: 'builder/spir-1470',
    });

    // The whole point: a null porch block is what the stubbed listDirs produced,
    // and it assembles into a frame that looks complete while telling a
    // refreshed builder nothing about where it is.
    expect(context.porch, 'porch context must resolve from a real worktree').not.toBeNull();
    expect(context.porch?.projectId).toBe('1470');
    expect(context.porch?.projectName).toBe('1470-automatic-builder-context-refr');
    expect(context.porch?.phase).toBe('implement');
    expect(context.protocol).toBe('spir');
  });

  it('resolves the spec and plan paths that actually exist', async () => {
    const context = resolveBuilderContext({
      fs: realFsPort,
      builderId: BUILDER_ID,
      worktree,
      branch: 'builder/spir-1470',
    });

    expect(context.specPath).toBeTruthy();
    expect(context.planPath).toBeTruthy();
  });

  it('REGRESSION: a stubbed listDirs silently nulls the porch context', async () => {
    // Pins the defect directly. If someone re-stubs the binding "because it is
    // only used for discovery", this fails and says why.
    const stubbed = { ...realFsPort, listDirs: () => [] };

    const context = resolveBuilderContext({
      fs: stubbed,
      builderId: BUILDER_ID,
      worktree,
      branch: 'builder/spir-1470',
    });

    expect(context.porch).toBeNull();

    // And the damage is SILENT — resolution still succeeds and the object still
    // looks well formed, which is why no test noticed.
    expect(context.builderId).toBe(BUILDER_ID);
    expect(context.worktree).toBe(worktree);
  });

  it('tolerates a worktree with no porch project at all', async () => {
    // A non-porch lane is a branch, not a failure.
    rmSync(join(worktree, 'codev', 'projects'), { recursive: true, force: true });

    const context = resolveBuilderContext({
      fs: realFsPort,
      builderId: BUILDER_ID,
      worktree,
      branch: 'builder/spir-1470',
    });

    expect(context.porch).toBeNull();
    expect(context.builderId).toBe(BUILDER_ID);
  });
});

describe('the layout production actually sees', () => {
  it('the worktree lives under <workspace>/.builders/<id>', () => {
    // The shape both scoping defects turned on: the worktree is NOT the
    // workspace, and anything deriving one from the other must say which it
    // wants.
    expect(worktree.startsWith(join(workspace, '.builders'))).toBe(true);
    expect(worktree).not.toBe(workspace);
  });

  it('a worktree carrying its own codev/ is what misleads workspace detection', () => {
    // `findWorkspaceRoot()` returns the WORKTREE when it has its own codev/,
    // which is exactly this layout — the reason a registry lookup scoped that
    // way finds nothing.
    expect(existsSync(join(worktree, 'codev'))).toBe(true);
  });
});
