/**
 * #1809: Tower never activates a builder worktree, and a startup pass prunes the
 * global.db rows earlier activations left behind.
 *
 * Runs against a real in-memory global.db (GLOBAL_SCHEMA) so the assertions are on
 * the rows Tower actually writes, not on mocked SQL strings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';

const { dbHolder } = vi.hoisted(() => ({
  dbHolder: { db: null as unknown as import('better-sqlite3').Database },
}));

vi.mock('../db/index.js', () => ({
  getGlobalDb: () => dbHolder.db,
  getDb: () => dbHolder.db,
  closeDb: () => {},
}));

import {
  initInstances,
  shutdownInstances,
  launchInstance,
  registerKnownWorkspace,
  getKnownWorkspacePaths,
  getAllKnownWorkspacePaths,
  type InstanceDeps,
} from '../servers/tower-instances.js';
import {
  initTerminals,
  getWorkspaceTerminals,
  pruneBuilderWorktreeWorkspaces,
} from '../servers/tower-terminals.js';

/** A pid that is certainly not running. */
const DEAD_PID = 2_147_483_000;

function makeDeps(overrides: Partial<InstanceDeps> = {}): InstanceDeps {
  return {
    log: vi.fn(),
    workspaceTerminals: new Map(),
    getTerminalManager: vi.fn().mockReturnValue({
      getSession: vi.fn(),
      killSession: vi.fn(),
      createSession: vi.fn().mockResolvedValue({ id: 'arch-1', pid: 1234 }),
      createSessionRaw: vi.fn(),
      listSessions: vi.fn().mockReturnValue([]),
    }),
    shellperManager: null,
    getWorkspaceTerminalsEntry: vi.fn().mockReturnValue({
      architects: new Map(), builders: new Map(), shells: new Map(),
    }),
    saveTerminalSession: vi.fn(),
    deleteTerminalSession: vi.fn(),
    deleteWorkspaceTerminalSessions: vi.fn(),
    deleteFileTabsForWorkspace: vi.fn(),
    getTerminalsForWorkspace: vi.fn().mockResolvedValue({ terminals: [] }),
    ...overrides,
  };
}

function countRows(table: string, workspacePath: string): number {
  const row = dbHolder.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_path = ?`)
    .get(workspacePath) as { n: number };
  return row.n;
}

function insertKnown(workspacePath: string): void {
  dbHolder.db.prepare('INSERT INTO known_workspaces (workspace_path, name, last_launched_at) VALUES (?, ?, datetime(\'now\'))')
    .run(workspacePath, path.basename(workspacePath));
}

/** The phantom shape seen in the field: `main`, pid 0, no live process behind it. */
function insertArchitect(workspacePath: string): void {
  dbHolder.db.prepare('INSERT INTO architect (workspace_path, id, pid, port, cmd) VALUES (?, \'main\', 0, 0, \'claude\')')
    .run(workspacePath);
}

function insertSession(id: string, workspacePath: string, shellperPid: number | null): void {
  dbHolder.db.prepare(
    'INSERT INTO terminal_sessions (id, workspace_path, type, pid, shellper_socket, shellper_pid) VALUES (?, ?, \'architect\', NULL, ?, ?)',
  ).run(id, workspacePath, shellperPid === null ? null : '/tmp/sock', shellperPid);
}

let tmpRoot: string;

beforeEach(() => {
  dbHolder.db = new Database(':memory:');
  dbHolder.db.exec(GLOBAL_SCHEMA);
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pir-1809-')));
  getWorkspaceTerminals().clear();
});

afterEach(() => {
  shutdownInstances();
  getWorkspaceTerminals().clear();
  dbHolder.db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('launchInstance refuses a builder worktree', () => {
  it('returns a refusal naming the parent, writes no row and spawns no architect', async () => {
    const worktree = path.join(tmpRoot, '.builders', 'pir-1802');
    fs.mkdirSync(path.join(worktree, 'codev'), { recursive: true });
    const deps = makeDeps();
    initInstances(deps);

    const result = await launchInstance(worktree);

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      `Refusing to activate a builder worktree (${worktree}). `
      + `Builder worktrees are managed by their parent workspace; activate ${tmpRoot} instead.`,
    );
    expect(countRows('known_workspaces', worktree)).toBe(0);
    expect(countRows('architect', worktree)).toBe(0);
    expect(deps.getTerminalManager().createSession).not.toHaveBeenCalled();
    expect(deps.getWorkspaceTerminalsEntry).not.toHaveBeenCalled();
  });

  it('refuses a symlink whose real path is inside a worktree', async () => {
    const worktree = path.join(tmpRoot, 'repo', '.builders', '7');
    fs.mkdirSync(path.join(worktree, 'codev'), { recursive: true });
    const link = path.join(tmpRoot, 'innocent-looking');
    fs.symlinkSync(worktree, link);
    initInstances(makeDeps());

    const result = await launchInstance(link);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Refusing to activate a builder worktree/);
    expect(countRows('known_workspaces', worktree)).toBe(0);
    expect(countRows('known_workspaces', link)).toBe(0);
  });

  it('refuses a worktree path even when it does not exist on disk', async () => {
    initInstances(makeDeps());
    const result = await launchInstance('/nowhere/.builders/gone');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Refusing to activate a builder worktree/);
  });
});

describe('known-workspace accessors', () => {
  it('registerKnownWorkspace is a no-op for a builder worktree', () => {
    registerKnownWorkspace(path.join(tmpRoot, '.builders', 'x'));
    registerKnownWorkspace(tmpRoot);

    expect(countRows('known_workspaces', path.join(tmpRoot, '.builders', 'x'))).toBe(0);
    expect(countRows('known_workspaces', tmpRoot)).toBe(1);
  });

  it('the filtered list excludes worktrees; the unfiltered list keeps them for deactivate', () => {
    const worktree = path.join(tmpRoot, '.builders', 'x');
    insertKnown(tmpRoot);
    insertKnown(worktree);
    initInstances(makeDeps());

    expect(getKnownWorkspacePaths()).toEqual([tmpRoot]);
    expect(getAllKnownWorkspacePaths().sort()).toEqual([tmpRoot, worktree].sort());
  });
});

describe('pruneBuilderWorktreeWorkspaces', () => {
  const log = vi.fn();

  beforeEach(() => {
    log.mockReset();
    initTerminals({
      log,
      shellperManager: null,
      registerKnownWorkspace: vi.fn(),
      getKnownWorkspacePaths: vi.fn(() => []),
    });
  });

  it('deletes every row of a dead worktree workspace, including a pid-0 phantom architect', () => {
    const worktree = path.join(tmpRoot, '.builders', 'pir-1802');
    insertKnown(worktree);
    insertArchitect(worktree);
    insertSession('dead-session', worktree, DEAD_PID);

    const result = pruneBuilderWorktreeWorkspaces();

    expect(result).toEqual({ pruned: 1, rowsDeleted: 3, live: [] });
    expect(countRows('known_workspaces', worktree)).toBe(0);
    expect(countRows('architect', worktree)).toBe(0);
    expect(countRows('terminal_sessions', worktree)).toBe(0);
  });

  it('prunes a lone known_workspaces row whose worktree is gone from disk (no architect row)', () => {
    // The field shape after `afx cleanup` + worktree removal: cleanup took the
    // architect row, the known_workspaces row survived pointing at a deleted path.
    // Candidates come from each table independently, and liveness is the only
    // test, so neither an accompanying architect row nor the path existing matters.
    const worktree = path.join(tmpRoot, '.builders', 'removed-lane');
    insertKnown(worktree);
    expect(fs.existsSync(worktree)).toBe(false);

    expect(pruneBuilderWorktreeWorkspaces()).toEqual({ pruned: 1, rowsDeleted: 1, live: [] });
    expect(countRows('known_workspaces', worktree)).toBe(0);
  });

  it('keeps and reports a worktree with a live shellper, never touching it', () => {
    const worktree = path.join(tmpRoot, '.builders', 'live');
    insertKnown(worktree);
    insertArchitect(worktree);
    insertSession('live-session', worktree, process.pid);

    const result = pruneBuilderWorktreeWorkspaces();

    expect(result).toEqual({ pruned: 0, rowsDeleted: 0, live: [worktree] });
    expect(countRows('known_workspaces', worktree)).toBe(1);
    expect(countRows('architect', worktree)).toBe(1);
    // Live by pid but never reattached: stopInstance only kills what the in-memory map holds, so the
    // remedy must NOT be `afx workspace stop` alone — the WARN points at the pid instead.
    const warn = log.mock.calls.find(([level]) => level === 'WARN');
    expect(warn?.[1]).toContain(worktree);
    expect(warn?.[1]).toContain(`Not attached to Tower (live-session pid ${process.pid})`);
    expect(warn?.[1]).toContain('`afx workspace stop` cannot reach these');
    expect(warn?.[1]).not.toContain('Attached terminals');
  });

  it('keeps a worktree that reconcile reattached into the in-memory map', () => {
    const worktree = path.join(tmpRoot, '.builders', 'reattached');
    insertKnown(worktree);
    getWorkspaceTerminals().set(worktree, {
      architects: new Map([['main', 'term-arch']]),
      builders: new Map(),
      shells: new Map(),
      fileTabs: new Map(),
    });

    const result = pruneBuilderWorktreeWorkspaces();

    expect(result.live).toEqual([worktree]);
    expect(countRows('known_workspaces', worktree)).toBe(1);
    // Attached, so `afx workspace stop` (deactivate -> stopInstance) does reach it.
    const warn = log.mock.calls.find(([level]) => level === 'WARN');
    expect(warn?.[1]).toContain('Attached terminals (term-arch): stop them with `afx workspace stop`');
    expect(warn?.[1]).not.toContain('Not attached to Tower');
  });

  it('finds an attached session even when the DB row spells the path differently', () => {
    // The in-memory map is keyed by normalizeWorkspacePath; a non-normalized DB spelling must not
    // hide the live session and get its rows pruned.
    const worktree = path.join(tmpRoot, '.builders', 'spelled');
    insertKnown(`${worktree}/.`);
    getWorkspaceTerminals().set(worktree, {
      architects: new Map([['main', 'term-spelled']]),
      builders: new Map(),
      shells: new Map(),
      fileTabs: new Map(),
    });

    const result = pruneBuilderWorktreeWorkspaces();

    expect(result.live).toEqual([`${worktree}/.`]);
    expect(countRows('known_workspaces', `${worktree}/.`)).toBe(1);
  });

  it('never touches a normal workspace', () => {
    insertKnown(tmpRoot);
    insertArchitect(tmpRoot);

    const result = pruneBuilderWorktreeWorkspaces();

    expect(result).toEqual({ pruned: 0, rowsDeleted: 0, live: [] });
    expect(countRows('known_workspaces', tmpRoot)).toBe(1);
    expect(countRows('architect', tmpRoot)).toBe(1);
  });

  it('logs exactly one INFO count line per pass, even when there is nothing to prune', () => {
    pruneBuilderWorktreeWorkspaces();

    const infos = log.mock.calls.filter(([level]) => level === 'INFO');
    expect(infos).toHaveLength(1);
    expect(infos[0][1]).toBe('Builder-worktree prune: 0 paths pruned, 0 rows deleted, 0 live kept');
  });

  it('a live stray that is later stopped is pruned on the next pass', () => {
    const worktree = path.join(tmpRoot, '.builders', 'stray');
    insertKnown(worktree);
    insertArchitect(worktree);
    insertSession('stray-session', worktree, process.pid);

    expect(pruneBuilderWorktreeWorkspaces().live).toEqual([worktree]);

    // `afx workspace stop` (deactivate) kills the session; its terminal_sessions row
    // goes with it, while stopInstance deliberately keeps the architect row (Spec 786).
    dbHolder.db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run('stray-session');

    expect(pruneBuilderWorktreeWorkspaces()).toEqual({ pruned: 1, rowsDeleted: 2, live: [] });
    expect(countRows('architect', worktree)).toBe(0);
    expect(countRows('known_workspaces', worktree)).toBe(0);
  });
});
