/**
 * Spec 1134 — `afx whoami` identity resolution and output.
 *
 * Covers the spec's test scenarios 1–8, 10, 11 plus the --json shapes:
 * precedence (builder-worktree cwd match → CODEV_ARCHITECT_NAME → fail loud),
 * the #1094 no-fallthrough rule (an unverifiable builder worktree is an
 * error, never a reason to consult the env var), workspace display-name
 * resolution via known_workspaces with basename fallback, and the
 * best-effort architect-row cross-check warning.
 *
 * Fixture pattern mirrors bugfix-774-detect-builder-id.test.ts: redirect
 * getGlobalDbPath() to a per-test temp file, seed via GLOBAL_SCHEMA, and
 * control cwd with process.chdir().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
// Spec 1658 (M6): fixtures keyed the way the code keys them (Windows canonical, POSIX realpath).
import { normalizeWorkspacePath } from '../utils/workspace-path.js';

// Redirect global.db to a per-test temp file (Issue #1118 pattern).
const dbState = vi.hoisted(() => ({ globalDbPath: '' }));
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => dbState.globalDbPath };
});

const { resolveIdentity, formatIdentity, identityToJson, whoami, WhoamiError } = await import(
  '../commands/whoami.js'
);
const { BuilderIdResolutionError } = await import('../commands/send.js');

describe('Spec 1134 — afx whoami', () => {
  let tmpRoot: string;
  let workspacePath: string;
  let worktreePath: string;
  const origCwd = process.cwd();
  const origArchitectName = process.env.CODEV_ARCHITECT_NAME;

  /** Env fixtures: resolveIdentity takes env explicitly. */
  const noEnv: NodeJS.ProcessEnv = {};
  const archEnv = (name: string): NodeJS.ProcessEnv => ({ CODEV_ARCHITECT_NAME: name });

  function openDb(): Database.Database {
    const db = new Database(dbState.globalDbPath);
    db.exec(GLOBAL_SCHEMA);
    return db;
  }

  function seedBuilder(id: string, spawnedByArchitect: string | null): void {
    const db = openDb();
    db.prepare(
      `INSERT INTO builders (workspace_path, id, name, worktree, branch, type, status, spawned_by_architect)
       VALUES (?, ?, ?, ?, ?, 'spec', 'implementing', ?)`,
    ).run(normalizeWorkspacePath(workspacePath), id, id, worktreePath, `builder/${id}`, spawnedByArchitect);
    db.close();
  }

  function seedKnownWorkspace(name: string): void {
    const db = openDb();
    db.prepare('INSERT INTO known_workspaces (workspace_path, name) VALUES (?, ?)').run(
      normalizeWorkspacePath(workspacePath),
      name,
    );
    db.close();
  }

  function seedArchitect(name: string): void {
    const db = openDb();
    db.prepare(
      'INSERT INTO architect (workspace_path, id, pid, port, cmd) VALUES (?, ?, 1234, 0, ?)',
    ).run(normalizeWorkspacePath(workspacePath), name, 'claude');
    db.close();
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'spec-1134-'));
    workspacePath = join(tmpRoot, 'workspace');
    worktreePath = join(workspacePath, '.builders', 'spir-984');
    mkdirSync(worktreePath, { recursive: true });
    // Workspace-root marker so detectWorkspaceRoot() resolves from subdirs.
    mkdirSync(join(workspacePath, '.git'), { recursive: true });

    dbState.globalDbPath = join(tmpRoot, 'global.db');
    delete process.env.CODEV_ARCHITECT_NAME;
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origArchitectName === undefined) delete process.env.CODEV_ARCHITECT_NAME;
    else process.env.CODEV_ARCHITECT_NAME = origArchitectName;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Scenario 1: architect via env, cwd = workspace root.
  it('resolves an architect from CODEV_ARCHITECT_NAME at the workspace root', () => {
    openDb().close(); // db exists but empty — no rows needed for env identity
    process.chdir(workspacePath);
    const identity = resolveIdentity(archEnv('ob-refine'));
    expect(identity).toMatchObject({ type: 'architect', name: 'ob-refine' });
    expect(identity.workspace).toBe(basename(normalizeWorkspacePath(workspacePath)));
  });

  // Scenario 2: builder with recorded spawning architect.
  it('resolves a builder with its spawning architect from global.db', () => {
    seedBuilder('builder-spir-984', 'main');
    process.chdir(worktreePath);
    const identity = resolveIdentity(noEnv);
    expect(identity).toMatchObject({ type: 'builder', name: 'builder-spir-984', architect: 'main' });
  });

  // Scenario 3: legacy row — NULL spawned_by_architect → field omitted.
  it('omits the architect field for a legacy builder row (NULL spawned_by_architect)', () => {
    seedBuilder('builder-spir-984', null);
    process.chdir(worktreePath);
    const identity = resolveIdentity(noEnv);
    expect(identity).toMatchObject({ type: 'builder', name: 'builder-spir-984' });
    expect('architect' in identity).toBe(false);
    expect(identityToJson(identity)).not.toHaveProperty('architect');
  });

  // Scenario 4: unverifiable builder worktree throws; env NOT consulted.
  it('throws BuilderIdResolutionError inside a worktree with no matching row — env is not consulted', () => {
    openDb().close(); // schema exists, but no builder row
    process.chdir(worktreePath);
    // Env var set — the #1094 rule forbids falling through to it.
    expect(() => resolveIdentity(archEnv('main'))).toThrow(BuilderIdResolutionError);
  });

  it('throws BuilderIdResolutionError inside a worktree when global.db is missing', () => {
    process.chdir(worktreePath);
    expect(() => resolveIdentity(archEnv('main'))).toThrow(BuilderIdResolutionError);
  });

  // Scenario 5: no signals at all.
  it('throws WhoamiError from a plain shell (no worktree, no env)', () => {
    process.chdir(tmpRoot);
    expect(() => resolveIdentity(noEnv)).toThrow(WhoamiError);
    expect(() => resolveIdentity(noEnv)).toThrow(/CODEV_ARCHITECT_NAME is not set/);
  });

  // Scenario 6: precedence — builder cwd beats env.
  it('prefers builder identity over CODEV_ARCHITECT_NAME inside a worktree', () => {
    seedBuilder('builder-spir-984', 'main');
    process.chdir(worktreePath);
    const identity = resolveIdentity(archEnv('ob-refine'));
    expect(identity.type).toBe('builder');
    expect(identity.name).toBe('builder-spir-984');
  });

  // Scenario 7: whitespace-only env var is unset.
  it('treats a whitespace-only CODEV_ARCHITECT_NAME as unset', () => {
    process.chdir(tmpRoot);
    expect(() => resolveIdentity(archEnv('   '))).toThrow(WhoamiError);
  });

  // Scenario 8: known_workspaces display name vs basename fallback.
  it('uses the known_workspaces name when registered', () => {
    seedKnownWorkspace('my-codev');
    process.chdir(workspacePath);
    expect(resolveIdentity(archEnv('main')).workspace).toBe('my-codev');
  });

  it('falls back to the directory basename when the workspace is unregistered', () => {
    seedBuilder('builder-spir-984', 'main');
    process.chdir(worktreePath);
    expect(resolveIdentity(noEnv).workspace).toBe(basename(normalizeWorkspacePath(workspacePath)));
  });

  // Scenario 10: architect running whoami from a subdirectory.
  it('resolves the workspace root from a subdirectory cwd (architect)', () => {
    seedKnownWorkspace('my-codev');
    const subdir = join(workspacePath, 'packages', 'codev', 'src');
    mkdirSync(subdir, { recursive: true });
    process.chdir(subdir);
    const identity = resolveIdentity(archEnv('main'));
    expect(identity).toMatchObject({ type: 'architect', name: 'main', workspace: 'my-codev' });
  });

  // Scenario 11: env architect without an architect table row → rowMissing.
  it('flags rowMissing when no architect row matches the env name', () => {
    openDb().close();
    process.chdir(workspacePath);
    const identity = resolveIdentity(archEnv('ghost'));
    expect(identity).toMatchObject({ type: 'architect', name: 'ghost', rowMissing: true });
  });

  it('does not flag rowMissing when the architect row exists', () => {
    seedArchitect('ob-refine');
    process.chdir(workspacePath);
    const identity = resolveIdentity(archEnv('ob-refine'));
    expect(identity.type).toBe('architect');
    expect((identity as { rowMissing?: boolean }).rowMissing).toBeUndefined();
  });

  // Output formats.
  describe('output formats', () => {
    it('formats the human-readable lines exactly as specified', () => {
      expect(
        formatIdentity({ type: 'builder', workspace: 'codev', name: 'builder-spir-984', architect: 'main' }),
      ).toBe('workspace: codev\ntype: builder\nname: builder-spir-984\narchitect: main');
      expect(formatIdentity({ type: 'architect', workspace: 'codev', name: 'main' })).toBe(
        'workspace: codev\ntype: architect\nname: main',
      );
    });

    it('emits the JSON schema with architect omitted (not null) when unknown', () => {
      expect(identityToJson({ type: 'builder', workspace: 'codev', name: 'b', architect: 'main' })).toEqual({
        workspace: 'codev',
        type: 'builder',
        name: 'b',
        architect: 'main',
      });
      const withoutArchitect = identityToJson({ type: 'builder', workspace: 'codev', name: 'b' });
      expect(withoutArchitect).toEqual({ workspace: 'codev', type: 'builder', name: 'b' });
      expect(JSON.stringify(withoutArchitect)).not.toContain('architect');
    });
  });

  // The whoami() command wrapper: exit codes and streams.
  describe('whoami() command', () => {
    let stdout: string[];
    let stderr: string[];

    beforeEach(() => {
      stdout = [];
      stderr = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
    });

    it('prints identity to stdout and exits 0 on success', async () => {
      seedBuilder('builder-spir-984', 'main');
      process.chdir(worktreePath);
      await whoami({});
      expect(process.exitCode).toBeUndefined();
      expect(stdout.join('')).toContain('type: builder');
      expect(stdout.join('')).toContain('architect: main');
    });

    it('prints a parseable JSON object under --json', async () => {
      seedBuilder('builder-spir-984', 'main');
      process.chdir(worktreePath);
      await whoami({ json: true });
      const payload = JSON.parse(stdout.join(''));
      expect(payload).toEqual({
        workspace: basename(normalizeWorkspacePath(workspacePath)),
        type: 'builder',
        name: 'builder-spir-984',
        architect: 'main',
      });
    });

    it('exits 1 with stderr explanation when identity is unknown', async () => {
      process.chdir(tmpRoot);
      await whoami({});
      expect(process.exitCode).toBe(1);
      expect(stderr.join('')).toContain('Cannot determine agent identity');
      expect(stdout.join('')).toBe('');
    });

    it('emits { "error": ... } on stdout AND the explanation on stderr under --json failure', async () => {
      process.chdir(tmpRoot);
      await whoami({ json: true });
      expect(process.exitCode).toBe(1);
      const payload = JSON.parse(stdout.join(''));
      expect(payload).toHaveProperty('error');
      expect(payload.error).toContain('Cannot determine agent identity');
      expect(stderr.join('')).toContain('Cannot determine agent identity');
    });

    it('surfaces the BuilderIdResolutionError message verbatim on the worktree failure path', async () => {
      openDb().close();
      process.chdir(worktreePath);
      await whoami({});
      expect(process.exitCode).toBe(1);
      expect(stderr.join('')).toContain('no matching builder row');
    });

    it('warns on stderr (exit 0) when the architect row is missing', async () => {
      openDb().close();
      process.chdir(workspacePath);
      process.env.CODEV_ARCHITECT_NAME = 'ghost';
      await whoami({});
      expect(process.exitCode).toBeUndefined();
      expect(stderr.join('')).toContain('no matching architect row');
      expect(stdout.join('')).toContain('name: ghost');
    });
  });
});
