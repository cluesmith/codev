/**
 * Spec 1658, finding M6: one directory must map to one workspace key on Windows.
 *
 * VS Code hands Tower `c:\repo` (its `uri.fsPath` lower-cases the drive letter)
 * while Git Bash hands Node `C:\repo`; before the fix each spelling became its own
 * workspace, the architect in one and its builders in the other. These tests pin:
 * the Windows canonical form and its fallback chain, the POSIX path staying
 * exactly what it was, the registry map, and the boot canonicalization of stored
 * rows (including what happens when two spellings collide).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { setHostPlatformForTests, resetHostPlatformForTests } from '../../lib/platform.js';
import {
  normalizeWorkspacePath,
  normalizeWorkspacePathWith,
  resetWorkspacePathCacheForTests,
  workspaceKey,
  type WorkspacePathOps,
} from '../utils/workspace-path.js';
import { WorkspaceKeyedMap } from '../servers/tower-terminals.js';
import { canonicalizeWorkspacePathRows } from '../db/canonicalize-workspace-paths.js';
import { livenessFromStartTimes } from '../servers/shellper-husk-sweep.js';
import { GLOBAL_SCHEMA } from '../db/schema.js';

/** Ops that record which calls were made and answer from the given functions. */
function recordingOps(realpath: (p: string) => string, realpathNative: (p: string) => string) {
  const calls: string[] = [];
  const ops: WorkspacePathOps = {
    realpath: (p) => {
      calls.push(`realpath:${p}`);
      return realpath(p);
    },
    realpathNative: (p) => {
      calls.push(`native:${p}`);
      return realpathNative(p);
    },
  };
  return { ops, calls };
}

function throwing(): never {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

afterEach(() => {
  resetHostPlatformForTests();
  resetWorkspacePathCacheForTests();
});

describe('normalizeWorkspacePath on POSIX (unchanged behaviour)', () => {
  beforeEach(() => {
    setHostPlatformForTests('linux');
  });

  it('uses only the JS realpath, never the native one, and returns its answer as is', () => {
    const { ops, calls } = recordingOps((p) => `/real${p}`, () => '/native-should-not-be-used');
    expect(normalizeWorkspacePathWith('/Some/Repo', ops)).toBe('/real/Some/Repo');
    expect(calls).toEqual(['realpath:/Some/Repo']);
  });

  it('falls back to path.resolve, keeping the input case, when realpath throws', () => {
    const { ops, calls } = recordingOps(throwing, () => '/native-should-not-be-used');
    expect(normalizeWorkspacePathWith('/Some/Missing/../Repo', ops)).toBe(resolve('/Some/Missing/../Repo'));
    expect(calls).toEqual(['realpath:/Some/Missing/../Repo']);
  });

  it('matches fs.realpathSync for an existing directory and path.resolve for a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm6-posix-'));
    try {
      expect(normalizeWorkspacePath(dir)).toBe(realpathSync(dir));
      const missing = join(dir, 'Not', 'There');
      expect(normalizeWorkspacePath(missing)).toBe(resolve(missing));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('workspaceKey is the identity, so map keys stay exactly as given', () => {
    expect(workspaceKey('c:\\Repo')).toBe('c:\\Repo');
    expect(workspaceKey('/Users/x/Repo')).toBe('/Users/x/Repo');
  });
});

describe('normalizeWorkspacePath on Windows', () => {
  beforeEach(() => {
    setHostPlatformForTests('win32');
  });

  it('returns the native (on-disk) spelling first', () => {
    const { ops, calls } = recordingOps(() => 'c:\\js', () => 'C:\\Repos\\BB\\App');
    expect(normalizeWorkspacePathWith('c:\\repos\\bb\\app', ops)).toBe('C:\\Repos\\BB\\App');
    expect(calls).toEqual(['native:c:\\repos\\bb\\app']);
  });

  it('upper-cases the drive letter when native fails and the JS realpath answers', () => {
    const { ops, calls } = recordingOps((p) => p, throwing);
    expect(normalizeWorkspacePathWith('c:\\repos\\app', ops)).toBe('C:\\repos\\app');
    expect(calls).toEqual(['native:c:\\repos\\app', 'realpath:c:\\repos\\app']);
  });

  it('upper-cases the drive letter when both realpaths fail (missing directory)', () => {
    const { ops } = recordingOps(throwing, throwing);
    expect(normalizeWorkspacePathWith('c:\\repos\\gone\\..\\app', ops)).toBe('C:\\repos\\app');
  });

  it('gives every drive-letter spelling the same key on every branch of the chain', () => {
    const branches: Array<[string, WorkspacePathOps]> = [
      ['native', recordingOps((p) => p, (p) => p).ops],
      ['js', recordingOps((p) => p, throwing).ops],
      ['resolve', recordingOps(throwing, throwing).ops],
    ];
    for (const [, ops] of branches) {
      expect(normalizeWorkspacePathWith('c:\\repo', ops)).toBe(normalizeWorkspacePathWith('C:\\repo', ops));
    }
  });

  it('strips the \\\\?\\ prefixes the native call can return', () => {
    expect(normalizeWorkspacePathWith('c:\\repo', recordingOps(throwing, () => '\\\\?\\C:\\Repo').ops)).toBe('C:\\Repo');
    expect(normalizeWorkspacePathWith('c:\\repo', recordingOps(throwing, () => '\\\\?\\c:\\Repo').ops)).toBe('C:\\Repo');
    expect(
      normalizeWorkspacePathWith('\\\\srv\\share\\repo', recordingOps(throwing, () => '\\\\?\\UNC\\srv\\share\\Repo').ops),
    ).toBe('\\\\srv\\share\\Repo');
  });

  it('keeps an earlier native answer when a later native call fails transiently', () => {
    let nativeUp = true;
    const ops = recordingOps(
      (p) => p,
      () => {
        if (!nativeUp) throwing();
        return 'C:\\Repos\\App';
      },
    ).ops;
    expect(normalizeWorkspacePathWith('c:\\repos\\app', ops)).toBe('C:\\Repos\\App');
    nativeUp = false;
    // Any spelling of the same directory still gets the first answer, not the JS realpath's input case.
    expect(normalizeWorkspacePathWith('C:\\REPOS\\APP', ops)).toBe('C:\\Repos\\App');
    expect(normalizeWorkspacePathWith('c:\\repos\\app', ops)).toBe('C:\\Repos\\App');
  });

  it('leaves a UNC path (no drive letter) as the chain returned it', () => {
    const { ops } = recordingOps(throwing, throwing);
    expect(normalizeWorkspacePathWith('\\\\server\\share\\repo', ops)).toBe(win32.resolve('\\\\server\\share\\repo'));
  });

  it('workspaceKey keeps a path that is not drive-letter or UNC as given (no key invented from the current drive)', () => {
    expect(workspaceKey('/home/user/project')).toBe('/home/user/project');
    expect(workspaceKey('relative\\dir')).toBe('relative\\dir');
    expect(workspaceKey('c:\\nonexistent-m6\\x')).toBe('C:\\nonexistent-m6\\x');
    expect(workspaceKey('c:/nonexistent-m6/x')).toMatch(/^C:/);
  });

  it('workspaceKey canonicalizes, so the registry map treats both spellings as one key', () => {
    const map = new WorkspaceKeyedMap<string>();
    map.set('c:\\nonexistent-m6\\repo', 'entry');
    expect(map.get('C:\\nonexistent-m6\\repo')).toBe('entry');
    expect(map.has('c:\\NONEXISTENT-M6\\repo')).toBe(false); // missing dir: only the drive letter canonicalizes
    expect([...map.keys()]).toEqual(['C:\\nonexistent-m6\\repo']);
    expect(map.delete('c:\\nonexistent-m6\\repo')).toBe(true);
    expect(map.size).toBe(0);
  });
});

describe('WorkspaceKeyedMap on POSIX', () => {
  it('behaves like a plain Map (keys exactly as given)', () => {
    setHostPlatformForTests('darwin');
    const map = new WorkspaceKeyedMap<string>();
    map.set('/Users/x/Repo', 'a');
    expect(map.get('/Users/x/Repo')).toBe('a');
    expect(map.get('/users/x/repo')).toBeUndefined();
  });
});

describe('canonicalizeWorkspacePathRows (boot, Windows)', () => {
  let dir: string;
  let db: Database.Database;
  const LOWER = 'c:\\repos\\app';
  const UPPER = 'C:\\repos\\app';
  let alivePids: Set<number>;
  const opts = {
    canonicalize: (p: string) => p.replace(/^c:/i, 'C:').replace(/\\repos\\app$/i, '\\repos\\app'),
    cronTaskId: (ws: string, name: string) => `id(${ws}|${name})`,
    isAlive: (pid: number) => alivePids.has(pid),
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'm6-db-'));
    mkdirSync(dir, { recursive: true });
    db = new Database(join(dir, 'global.db'));
    db.exec(GLOBAL_SCHEMA);
    alivePids = new Set();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function addArchitect(ws: string, id: string, terminalId: string, startedAt = '2026-11-01 00:00:00') {
    db.prepare("INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id, started_at) VALUES (?, ?, 1, 0, 'claude', ?, ?)").run(ws, id, terminalId, startedAt);
  }
  function addBuilder(ws: string, id: string, worktree: string) {
    db.prepare(
      "INSERT INTO builders (workspace_path, id, name, status, phase, worktree, branch, type) VALUES (?, ?, ?, 'implementing', '', ?, 'b', 'bugfix')",
    ).run(ws, id, id, worktree);
  }
  function addTerminal(ws: string, id: string, type: string, roleId: string, shellperPid: number | null = null) {
    db.prepare('INSERT INTO terminal_sessions (id, workspace_path, type, role_id, shellper_pid) VALUES (?, ?, ?, ?, ?)').run(id, ws, type, roleId, shellperPid);
  }
  function rows(sql: string, ...args: unknown[]) {
    return db.prepare(sql).all(...args);
  }

  it('joins the owner-run split: an architect under c:\\ and its builders under C:\\ end up in one workspace', () => {
    db.prepare("INSERT INTO known_workspaces (workspace_path, name, last_launched_at) VALUES (?, 'app', '2026-11-02 09:00:00')").run(LOWER);
    db.prepare("INSERT INTO known_workspaces (workspace_path, name, last_launched_at) VALUES (?, 'app', '2026-11-01 08:00:00')").run(UPPER);
    addArchitect(LOWER, 'main', 't-arch');
    addTerminal(LOWER, 't-arch', 'architect', 'main');
    addBuilder(UPPER, 'builder-air-142', 'C:\\repos\\app\\.builders\\air-142');
    addTerminal(UPPER, 't-b142', 'builder', 'builder-air-142');
    db.prepare("INSERT INTO mailbox (id, workspace_path, from_workspace, to_agent, body, formatted_message, status, created_at, updated_at) VALUES ('m1', ?, ?, 'architect', 'x', 'x', 'held', 1, 1)").run(LOWER, LOWER);

    const report = canonicalizeWorkspacePathRows(db, opts);

    expect(report.moved).toEqual([{ from: LOWER, to: UPPER }]);
    expect(rows('SELECT workspace_path, last_launched_at FROM known_workspaces')).toEqual([
      { workspace_path: UPPER, last_launched_at: '2026-11-02 09:00:00' },
    ]);
    expect(rows('SELECT DISTINCT workspace_path FROM architect')).toEqual([{ workspace_path: UPPER }]);
    expect(rows('SELECT DISTINCT workspace_path FROM builders')).toEqual([{ workspace_path: UPPER }]);
    expect(rows('SELECT id FROM terminal_sessions WHERE workspace_path = ? ORDER BY id', UPPER)).toEqual([{ id: 't-arch' }, { id: 't-b142' }]);
    expect(rows('SELECT workspace_path, from_workspace FROM mailbox')).toEqual([{ workspace_path: UPPER, from_workspace: UPPER }]);
    expect(report.droppedTerminalIds).toEqual([]);
  });

  it('collision, neither live: the later started_at wins and keeps its own terminal row (no dangling id)', () => {
    addArchitect(UPPER, 'main', 't-canonical', '2026-11-01 00:00:00');
    addTerminal(UPPER, 't-canonical', 'architect', 'main', 101);
    addArchitect(LOWER, 'main', 't-other', '2026-11-02 00:00:00');
    addTerminal(LOWER, 't-other', 'architect', 'main', 102);

    const report = canonicalizeWorkspacePathRows(db, opts);

    expect(rows('SELECT workspace_path, terminal_id FROM architect')).toEqual([{ workspace_path: UPPER, terminal_id: 't-other' }]);
    expect(rows('SELECT id FROM terminal_sessions')).toEqual([{ id: 't-other' }]);
    expect(report.droppedTerminalIds).toEqual(['t-canonical']);
    expect(report.liveDuplicates).toEqual([]);
  });

  it('collision: a LIVE non-canonical session beats a dead canonical one, agent row and terminal together', () => {
    addArchitect(UPPER, 'main', 't-dead', '2026-11-02 00:00:00');
    addTerminal(UPPER, 't-dead', 'architect', 'main', 201);
    addArchitect(LOWER, 'main', 't-live', '2026-11-01 00:00:00');
    addTerminal(LOWER, 't-live', 'architect', 'main', 202);
    alivePids.add(202);

    const report = canonicalizeWorkspacePathRows(db, opts);

    expect(rows('SELECT workspace_path, terminal_id FROM architect')).toEqual([{ workspace_path: UPPER, terminal_id: 't-live' }]);
    expect(rows('SELECT id, workspace_path FROM terminal_sessions')).toEqual([{ id: 't-live', workspace_path: UPPER }]);
    expect(report.droppedTerminalIds).toEqual(['t-dead']);
    expect(report.liveDuplicates).toEqual([]);
  });

  it('collision, BOTH live: no row is deleted and the pair is reported for a human', () => {
    addArchitect(UPPER, 'main', 't-a');
    addTerminal(UPPER, 't-a', 'architect', 'main', 301);
    addArchitect(LOWER, 'main', 't-b');
    addTerminal(LOWER, 't-b', 'architect', 'main', 302);
    alivePids.add(301);
    alivePids.add(302);

    const report = canonicalizeWorkspacePathRows(db, opts);

    expect(rows('SELECT id, workspace_path FROM terminal_sessions ORDER BY id')).toEqual([
      { id: 't-a', workspace_path: UPPER },
      { id: 't-b', workspace_path: UPPER },
    ]);
    expect(report.droppedTerminalIds).toEqual([]);
    expect(report.liveDuplicates).toEqual([{ workspace: UPPER, type: 'architect', roleId: 'main', terminalIds: ['t-a', 't-b'] }]);
  });

  it('collision: a recorded shellper pid now owned by an UNRELATED process (pid reuse) counts as dead', () => {
    // The husk sweep's identity rule, through the same factory Tower uses at boot.
    const startTimes = new Map<number, number>([[401, 50_000]]); // pid 401 now started at t=50s
    const reuseAware = { ...opts, isAlive: livenessFromStartTimes(startTimes, (pid) => pid === 401) };
    // The canonical row is OLDER and its pid looks alive; a bare existence probe would let it win.
    addArchitect(UPPER, 'main', 't-reused', '2026-11-01 00:00:00');
    addTerminal(UPPER, 't-reused', 'architect', 'main', 401);
    db.prepare('UPDATE terminal_sessions SET shellper_start_time = 1000 WHERE id = ?').run('t-reused'); // recorded t=1s
    addArchitect(LOWER, 'main', 't-real', '2026-11-03 00:00:00');
    addTerminal(LOWER, 't-real', 'architect', 'main', 402);
    db.prepare('UPDATE terminal_sessions SET shellper_start_time = 2000 WHERE id = ?').run('t-real');

    const report = canonicalizeWorkspacePathRows(db, reuseAware);

    // 401 was reused, so neither session is genuinely alive: freshness picks the newer agent row,
    // which keeps its own terminal row; the reused one is dropped (its process is NOT ours).
    expect(rows('SELECT terminal_id FROM architect')).toEqual([{ terminal_id: 't-real' }]);
    expect(rows('SELECT id FROM terminal_sessions')).toEqual([{ id: 't-real' }]);
    expect(report.droppedTerminalIds).toEqual(['t-reused']);
    expect(report.liveDuplicates).toEqual([]);
  });

  it('livenessFromStartTimes: missing pid dead, matching start alive, mismatched start dead, no record existence-only', () => {
    const live = livenessFromStartTimes(new Map([[7, 10_000]]), (pid) => pid === 7 || pid === 8);
    expect(live(6, null)).toBe(false);
    expect(live(7, 10_500)).toBe(true);
    expect(live(7, 99_000)).toBe(false);
    expect(live(8, null)).toBe(true);
    expect(live(8, 10_000)).toBe(false); // exists, but its start time cannot be confirmed
  });

  it('two non-canonical spellings collapse onto a third key deterministically (freshness, not row order)', () => {
    const lowerAll = 'c:\\REPOS\\APP';
    addArchitect(LOWER, 'main', 't-old', '2026-11-01 00:00:00');
    addArchitect(lowerAll, 'main', 't-new', '2026-11-03 00:00:00');
    canonicalizeWorkspacePathRows(db, opts);
    expect(rows('SELECT workspace_path, terminal_id FROM architect')).toEqual([{ workspace_path: UPPER, terminal_id: 't-new' }]);
  });

  it('moves a sender spelling that appears only in mailbox.from_workspace', () => {
    db.prepare("INSERT INTO mailbox (id, workspace_path, from_workspace, to_agent, body, formatted_message, status, created_at, updated_at) VALUES ('m2', 'D:\\\\other', ?, 'architect', 'x', 'x', 'held', 1, 1)").run(LOWER);
    canonicalizeWorkspacePathRows(db, opts);
    expect(rows('SELECT from_workspace FROM mailbox')).toEqual([{ from_workspace: UPPER }]);
  });

  it('recomputes a moved cron task id and drops a cron row whose task already exists canonically', () => {
    db.prepare("INSERT INTO cron_tasks (id, workspace_path, task_name) VALUES ('old-a', ?, 'nightly')").run(LOWER);
    db.prepare("INSERT INTO cron_tasks (id, workspace_path, task_name) VALUES ('old-b', ?, 'hourly')").run(LOWER);
    db.prepare("INSERT INTO cron_tasks (id, workspace_path, task_name) VALUES ('keep', ?, 'hourly')").run(UPPER);

    canonicalizeWorkspacePathRows(db, opts);

    expect(rows('SELECT id, workspace_path, task_name FROM cron_tasks ORDER BY task_name')).toEqual([
      { id: 'keep', workspace_path: UPPER, task_name: 'hourly' },
      { id: `id(${UPPER}|nightly)`, workspace_path: UPPER, task_name: 'nightly' },
    ]);
  });

  it('rewrites builder worktree paths to their canonical spelling', () => {
    addBuilder(UPPER, 'builder-air-142', 'c:\\repos\\app\\.builders\\air-142');
    const report = canonicalizeWorkspacePathRows(db, opts);
    expect(rows('SELECT worktree FROM builders')).toEqual([{ worktree: 'C:\\repos\\app\\.builders\\air-142' }]);
    expect(report.worktreesRewritten).toBe(1);
  });

  it('is idempotent: a second run changes nothing', () => {
    addArchitect(LOWER, 'main', 't-arch');
    addBuilder(UPPER, 'b1', 'c:\\repos\\app\\.builders\\b1');
    canonicalizeWorkspacePathRows(db, opts);
    const before = JSON.stringify([rows('SELECT * FROM architect'), rows('SELECT workspace_path, id, worktree FROM builders')]);
    const second = canonicalizeWorkspacePathRows(db, opts);
    expect(second).toEqual({ moved: [], dropped: [], droppedTerminalIds: [], liveDuplicates: [], worktreesRewritten: 0 });
    expect(JSON.stringify([rows('SELECT * FROM architect'), rows('SELECT workspace_path, id, worktree FROM builders')])).toBe(before);
  });

  it('leaves already-canonical rows untouched', () => {
    addArchitect(UPPER, 'main', 't-arch');
    const report = canonicalizeWorkspacePathRows(db, opts);
    expect(report.moved).toEqual([]);
    expect(rows('SELECT workspace_path FROM architect')).toEqual([{ workspace_path: UPPER }]);
  });
});
