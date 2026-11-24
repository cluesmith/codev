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
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
// Spec 1658 (M6): fixtures keyed the way the code keys them (Windows canonical, POSIX realpath).
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import { parseAddress } from '@cluesmith/codev-sdk/address';
import { findWorkspaceByAddressName } from '../utils/workspace-address.js';

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

  function seedKnownWorkspace(name: string, addressName: string | null = null): void {
    const db = openDb();
    db.prepare('INSERT INTO known_workspaces (workspace_path, name, address_name) VALUES (?, ?, ?)').run(
      normalizeWorkspacePath(workspacePath),
      name,
      addressName,
    );
    db.close();
  }

  /** Another workspace Tower has registered and has a terminal for: a running one. */
  function seedRunningWorkspace(path: string): void {
    const db = openDb();
    db.prepare('INSERT INTO known_workspaces (workspace_path, name) VALUES (?, ?)').run(path, basename(path));
    db.prepare("INSERT INTO terminal_sessions (id, workspace_path, type) VALUES (?, ?, 'architect')").run(`term-${path}`, path);
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
      // Spec 1940 added the `address` line, after the lines that were there before it.
      expect(
        formatIdentity({
          type: 'builder',
          workspace: 'codev',
          name: 'builder-spir-984',
          architect: 'main',
          address: 'codev:builder-spir-984',
        }),
      ).toBe('workspace: codev\ntype: builder\nname: builder-spir-984\narchitect: main\naddress: codev:builder-spir-984');
      expect(
        formatIdentity({ type: 'architect', workspace: 'codev', name: 'main', address: 'codev:architect:main' }),
      ).toBe('workspace: codev\ntype: architect\nname: main\naddress: codev:architect:main');
    });

    it('says why when there is no address to give, on the same line', () => {
      expect(
        formatIdentity({ type: 'architect', workspace: 'codev', name: 'main', addressUnavailable: 'no name' }),
      ).toBe('workspace: codev\ntype: architect\nname: main\naddress: none (no name)');
    });

    it('emits the JSON schema with architect omitted (not null) when unknown', () => {
      expect(
        identityToJson({ type: 'builder', workspace: 'codev', name: 'b', architect: 'main', address: 'codev:b' }),
      ).toEqual({
        workspace: 'codev',
        type: 'builder',
        name: 'b',
        architect: 'main',
        address: 'codev:b',
      });
      const withoutArchitect = identityToJson({ type: 'builder', workspace: 'codev', name: 'b', address: 'codev:b' });
      expect(withoutArchitect).toEqual({ workspace: 'codev', type: 'builder', name: 'b', address: 'codev:b' });
      expect(JSON.stringify(withoutArchitect)).not.toContain('architect');
    });

    it('emits addressUnavailable in place of address when there is none (never a null address)', () => {
      const payload = identityToJson({ type: 'architect', workspace: 'codev', name: 'main', addressUnavailable: 'no name' });
      expect(payload).toEqual({ workspace: 'codev', type: 'architect', name: 'main', addressUnavailable: 'no name' });
      expect(payload).not.toHaveProperty('address');
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
        address: 'workspace:builder-spir-984',
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

    // Spec 1940: the address is one added line; the lines before it and the exit code are as they were.
    it('adds the address as the last line and changes no line before it', async () => {
      seedBuilder('builder-spir-984', 'main');
      process.chdir(worktreePath);
      await whoami({});
      expect(process.exitCode).toBeUndefined();
      expect(stdout.join('')).toBe(
        'workspace: workspace\ntype: builder\nname: builder-spir-984\narchitect: main\naddress: workspace:builder-spir-984\n',
      );
    });

    it('still exits 0, with the reason on the address line, when the workspace has no address name', async () => {
      seedBuilder('builder-spir-984', 'main');
      seedRunningWorkspace(join(tmpRoot, 'elsewhere', 'workspace'));
      process.chdir(worktreePath);
      await whoami({});
      expect(process.exitCode).toBeUndefined();
      const lines = stdout.join('').trimEnd().split('\n');
      expect(lines.slice(0, 4)).toEqual(['workspace: workspace', 'type: builder', 'name: builder-spir-984', 'architect: main']);
      expect(lines[4]).toMatch(/^address: none \(this workspace has no address name: .*afx workspace name <name>\)$/);
      expect(stderr.join('')).toBe('');
    });
  });

  // Spec 1940: the caller's own address, in the form another workspace on this Tower types.
  describe('the caller\'s own address (Spec 1940)', () => {
    const key = () => normalizeWorkspacePath(workspacePath);

    it.each([
      ['the main architect', 'main', 'workspace:architect:main'],
      ['a named architect', 'review', 'workspace:architect:review'],
    ])('gives %s as <workspace>:architect:<name>', (_who, name, address) => {
      openDb().close();
      process.chdir(workspacePath);
      expect(resolveIdentity(archEnv(name)).address).toBe(address);
    });

    it('gives a builder as <workspace>:<builder id>', () => {
      seedBuilder('builder-spir-984', 'review');
      process.chdir(worktreePath);
      expect(resolveIdentity(noEnv).address).toBe('workspace:builder-spir-984');
    });

    it('uses the workspace\'s explicit address name, not the display name or the directory name', () => {
      seedKnownWorkspace('Display Name', 'core');
      process.chdir(workspacePath);
      const identity = resolveIdentity(archEnv('main'));
      expect(identity.workspace).toBe('Display Name');
      expect(identity.address).toBe('core:architect:main');
    });

    it('is the address the naming rules resolve back to this workspace', () => {
      seedKnownWorkspace('workspace', 'core');
      process.chdir(workspacePath);
      const { address } = resolveIdentity(archEnv('review'));
      const parsed = parseAddress(address!);
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect(parsed.address).toMatchObject({ kind: 'architect', name: 'review' });
      // The workspace part of what whoami printed, looked up the way Tower looks it up.
      expect(
        findWorkspaceByAddressName(parsed.address.workspace!, [{ workspacePath: key(), explicitName: 'core' }], [key()]),
      ).toEqual({ ok: true, workspacePath: key() });
    });

    it('has none while another running workspace shares the directory name, and says how to get one', () => {
      openDb().close();
      seedRunningWorkspace(join(tmpRoot, 'elsewhere', 'workspace'));
      process.chdir(workspacePath);
      const identity = resolveIdentity(archEnv('main'));
      expect(identity).toMatchObject({ type: 'architect', name: 'main' });
      expect(identity.address).toBeUndefined();
      expect(identity.addressUnavailable).toContain('shares the directory name');
      expect(identity.addressUnavailable).toContain('afx workspace name <name>');
    });

    it('keeps its address when the workspace sharing its directory name is not running', () => {
      const db = openDb();
      db.prepare('INSERT INTO known_workspaces (workspace_path, name) VALUES (?, ?)').run(
        join(tmpRoot, 'elsewhere', 'workspace'),
        'workspace',
      );
      db.close();
      process.chdir(workspacePath);
      expect(resolveIdentity(archEnv('main')).address).toBe('workspace:architect:main');
    });

    it('has none when its directory name is another workspace\'s explicit name', () => {
      const db = openDb();
      db.prepare('INSERT INTO known_workspaces (workspace_path, name, address_name) VALUES (?, ?, ?)').run(
        join(tmpRoot, 'other'),
        'other',
        'workspace',
      );
      db.close();
      process.chdir(workspacePath);
      const identity = resolveIdentity(archEnv('main'));
      expect(identity.address).toBeUndefined();
      expect(identity.addressUnavailable).toContain(`is the name of the workspace ${join(tmpRoot, 'other')}`);
    });

    it('has none when the directory name cannot be written in an address', () => {
      const spaced = join(tmpRoot, 'My Notes');
      mkdirSync(join(spaced, '.git'), { recursive: true });
      openDb().close();
      process.chdir(spaced);
      const identity = resolveIdentity(archEnv('main'));
      expect(identity.address).toBeUndefined();
      expect(identity.addressUnavailable).toContain('cannot be written in an address');
    });

    it('says global.db could not be read when it is missing; the identity is unaffected', () => {
      process.chdir(workspacePath);
      const identity = resolveIdentity(archEnv('main'));
      expect(identity).toMatchObject({ type: 'architect', name: 'main' });
      expect(identity.address).toBeUndefined();
      expect(identity.addressUnavailable).toContain('global.db could not be read');
    });

    it('says so when global.db predates workspace names, and does not guess one', () => {
      const db = new Database(dbState.globalDbPath);
      db.exec('CREATE TABLE known_workspaces (workspace_path TEXT PRIMARY KEY, name TEXT NOT NULL)');
      db.close();
      process.chdir(workspacePath);
      const identity = resolveIdentity(archEnv('main'));
      expect(identity.address).toBeUndefined();
      expect(identity.addressUnavailable).toContain('does not hold workspace names yet');
    });

    it('never opens global.db for writing', () => {
      seedKnownWorkspace('workspace', 'core');
      const before = statSync(dbState.globalDbPath).mtimeMs;
      process.chdir(workspacePath);
      resolveIdentity(archEnv('main'));
      expect(statSync(dbState.globalDbPath).mtimeMs).toBe(before);
    });
  });
});
