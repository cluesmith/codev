/**
 * Tests for the builder worktree write-guard (Issue #1018).
 *
 * The guard is emitted into each Claude builder worktree as a self-contained
 * Node hook. These tests exercise the EXACT emitted artifact: they write
 * WORKTREE_WRITE_GUARD_SCRIPT to a temp .cjs and spawn it with fixture stdin,
 * so the tested behavior is the behavior builders get.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  WORKTREE_WRITE_GUARD_SCRIPT,
  buildWorktreeGuardFiles,
  GUARD_SCRIPT_RELPATH,
  GUARD_SETTINGS_RELPATH,
} from '../agent-farm/utils/worktree-write-guard.js';

// IMPORTANT (Issue #1018, CI fix): fixtures must NOT live under the OS temp dir.
// The guard allowlists /tmp and /private/tmp, and on Linux `os.tmpdir()` IS /tmp,
// so a fake "outside-worktree" path placed there would be allowlisted and the
// deny-tests would wrongly pass-as-allow (green on macOS where tmpdir is
// /var/folders, red on Linux CI). Anchoring fixtures under the package's
// node_modules (gitignored, never allowlisted, literal non-symlinked path on
// both platforms) makes the deny-tests platform-independent and exercises the
// same literal-path comparison Linux production hits.
const FIXTURE_HOME = path.join(path.resolve(__dirname, '..', '..'), 'node_modules', '.cguard-fixtures');
const onWindows = process.platform === 'win32';

let base: string;
let mainCheckout: string;
let worktree: string;
let homeDir: string;
let scriptPath: string;

beforeAll(() => {
  fs.mkdirSync(FIXTURE_HOME, { recursive: true });
  base = fs.mkdtempSync(path.join(FIXTURE_HOME, 'cguard-'));
  mainCheckout = path.join(base, 'main');
  worktree = path.join(mainCheckout, '.builders', 'wt');
  homeDir = path.join(base, 'home');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  scriptPath = path.join(base, 'guard.cjs');
  fs.writeFileSync(scriptPath, WORKTREE_WRITE_GUARD_SCRIPT);
});

afterAll(() => {
  fs.rmSync(FIXTURE_HOME, { recursive: true, force: true });
});

interface GuardResult {
  status: number | null;
  denied: boolean;
  reason: string;
}

/**
 * Run the guard with a deterministic env. TMPDIR is deliberately omitted (and
 * fixtures live outside the OS temp dir, see FIXTURE_HOME) so that only the
 * worktree, /tmp, /private/tmp, and $HOME/.claude are allowlisted — nothing else
 * should pass.
 */
function runGuard(
  toolName: string,
  filePath: string | undefined,
  opts: { root?: string; home?: string; cwd?: string; bakeRoot?: boolean; env?: Record<string, string> } = {},
): GuardResult {
  const cwd = opts.cwd ?? opts.root ?? worktree;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: opts.home ?? homeDir,
    ...opts.env,
  };
  const bakeRoot = opts.bakeRoot ?? true;
  if (bakeRoot && opts.root !== null) {
    env.CODEV_WORKTREE_ROOT = opts.root ?? worktree;
  }

  const toolInput: Record<string, unknown> = {};
  if (filePath !== undefined) {
    toolInput.file_path = filePath;
  }

  const res = spawnSync('node', [scriptPath], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
    env,
    encoding: 'utf8',
  });

  let denied = false;
  let reason = '';
  const out = (res.stdout ?? '').trim();
  if (out) {
    const parsed = JSON.parse(out);
    denied = parsed?.hookSpecificOutput?.permissionDecision === 'deny';
    reason = parsed?.hookSpecificOutput?.permissionDecisionReason ?? '';
  }
  return { status: res.status, denied, reason };
}

describe('worktree-write-guard script', () => {
  it('allows a Write inside the worktree', () => {
    const r = runGuard('Write', path.join(worktree, 'codev', 'plans', 'x.md'));
    expect(r.status).toBe(0);
    expect(r.denied).toBe(false);
  });

  it('allows a Write to a new deeply-nested non-existent path inside the worktree', () => {
    const r = runGuard('Write', path.join(worktree, 'a', 'b', 'c', 'new.txt'));
    expect(r.denied).toBe(false);
  });

  it('DENIES a Write to a main-checkout path outside the worktree (the #1018 bug)', () => {
    const r = runGuard('Write', path.join(mainCheckout, 'codev', 'plans', 'x.md'));
    expect(r.status).toBe(0);
    expect(r.denied).toBe(true);
    // The reason names the worktree root so the model can re-root.
    expect(r.reason).toContain(fs.realpathSync(worktree));
  });

  it('DENIES an Edit to a path outside the worktree (Edit is guarded too)', () => {
    const r = runGuard('Edit', path.join(mainCheckout, 'src', 'app.ts'));
    expect(r.denied).toBe(true);
  });

  // POSIX temp roots; on Windows the guard allowlists the host temp dir instead.
  it.skipIf(onWindows)('allows a Write to /tmp (temp allowlist, with macOS symlink normalization)', () => {
    const r = runGuard('Write', '/tmp/codev-guard-scratch/out.txt');
    expect(r.denied).toBe(false);
  });

  it.skipIf(onWindows)('allows a Write to /private/tmp (temp allowlist)', () => {
    const r = runGuard('Write', '/private/tmp/codev-guard-scratch/out.txt');
    expect(r.denied).toBe(false);
  });

  it('allows a Write to $HOME/.claude (builder memory / config)', () => {
    const r = runGuard(
      'Write',
      path.join(homeDir, '.claude', 'projects', 'p', 'memory', 'm.md'),
    );
    expect(r.denied).toBe(false);
  });

  it.runIf(onWindows)('allows a Write under the Windows temp dir (Spec 1658)', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cguard-temp-'));
    try {
      const r = runGuard('Write', path.join(temp, 'out.txt'), { env: { TEMP: temp, TMP: temp } });
      expect(r.denied).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it.runIf(onWindows)('allows a Write to %USERPROFILE%\\.claude and compares paths case-insensitively (Spec 1658)', () => {
    const memory = path.join(homeDir, '.claude', 'projects', 'p', 'memory', 'm.md');
    const r = runGuard('Write', memory, { home: path.join(base, 'no-home'), env: { USERPROFILE: homeDir } });
    expect(r.denied).toBe(false);
    const upper = runGuard('Write', path.join(worktree, 'codev', 'x.md').toUpperCase());
    expect(upper.denied).toBe(false);
    const outside = runGuard('Write', path.join(mainCheckout, 'codev', 'x.md').toUpperCase());
    expect(outside.denied).toBe(true);
  });

  it('allows a non-guarded tool (Bash) regardless of path', () => {
    const r = runGuard('Bash', undefined);
    expect(r.denied).toBe(false);
  });

  it('allows when file_path is missing', () => {
    const r = runGuard('Write', undefined);
    expect(r.denied).toBe(false);
  });

  it('allows on malformed JSON (fail-open)', () => {
    const res = spawnSync('node', [scriptPath], {
      input: 'not json',
      env: { PATH: process.env.PATH ?? '', HOME: homeDir, CODEV_WORKTREE_ROOT: worktree },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect((res.stdout ?? '').trim()).toBe('');
  });

  it('falls back to `git rev-parse` when CODEV_WORKTREE_ROOT is unset', () => {
    const gitRepo = fs.mkdtempSync(path.join(FIXTURE_HOME, 'cguard-git-'));
    try {
      const env = { cwd: gitRepo, stdio: 'pipe' as const };
      execSync('git init -q', env);
      execSync('git config user.email t@t.t', env);
      execSync('git config user.name t', env);
      fs.writeFileSync(path.join(gitRepo, 'seed.txt'), 'seed');
      execSync('git add seed.txt', env);
      execSync('git commit -q -m seed', env);
      execSync('git worktree add -q .builders/wt -b gtest', env);
      const gitWorktree = path.join(gitRepo, '.builders', 'wt');

      // No CODEV_WORKTREE_ROOT: the guard must resolve the worktree via git and
      // still deny a write that lands in the outer checkout.
      const r = runGuard('Write', path.join(gitRepo, 'codev', 'x.md'), {
        cwd: gitWorktree,
        bakeRoot: false,
      });
      expect(r.denied).toBe(true);

      const inside = runGuard('Write', path.join(gitWorktree, 'codev', 'x.md'), {
        cwd: gitWorktree,
        bakeRoot: false,
      });
      expect(inside.denied).toBe(false);
    } finally {
      fs.rmSync(gitRepo, { recursive: true, force: true });
    }
  });
});

describe('buildWorktreeGuardFiles', () => {
  it('returns the guard script and a settings file at the expected paths', () => {
    const files = buildWorktreeGuardFiles('/abs/worktree');
    const relPaths = files.map((f) => f.relativePath).sort();
    expect(relPaths).toEqual([GUARD_SETTINGS_RELPATH, GUARD_SCRIPT_RELPATH].sort());

    const script = files.find((f) => f.relativePath === GUARD_SCRIPT_RELPATH);
    expect(script?.content).toBe(WORKTREE_WRITE_GUARD_SCRIPT);
  });

  it('bakes an absolute CODEV_WORKTREE_ROOT and runs the script via node', () => {
    const files = buildWorktreeGuardFiles('/abs/worktree');
    const settings = files.find((f) => f.relativePath === GUARD_SETTINGS_RELPATH);
    const parsed = JSON.parse(settings!.content);
    const entry = parsed.hooks.PreToolUse[0];
    expect(entry.matcher).toContain('Write');
    expect(entry.matcher).toContain('Edit');
    const command = entry.hooks[0].command;
    expect(command).toContain("CODEV_WORKTREE_ROOT='/abs/worktree'");
    expect(command).toContain(`node '/abs/worktree/${GUARD_SCRIPT_RELPATH}'`);
  });

  it('resolves a relative worktree path to absolute before baking', () => {
    const files = buildWorktreeGuardFiles('relative/wt');
    const settings = files.find((f) => f.relativePath === GUARD_SETTINGS_RELPATH);
    const command = JSON.parse(settings!.content).hooks.PreToolUse[0].hooks[0].command;
    // Forward slashes: the hook runs under Git Bash on Windows (Spec 1658).
    expect(command).toContain(`CODEV_WORKTREE_ROOT='${path.resolve('relative/wt').replace(/\\/g, '/')}'`);
  });
});
