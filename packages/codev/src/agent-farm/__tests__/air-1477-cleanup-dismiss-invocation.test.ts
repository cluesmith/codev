/**
 * `cleanupBuilder()` actually INVOKES the held-mail dismissal (Issue #1477, refs Spec 1313 round 3).
 *
 * `spec-1313-cleanup-dismiss.test.ts` covers the seam by re-implementing it — it calls
 * `mailbox.dismissHeldForAgent` directly and says outright that "the full `cleanupBuilder` ... is
 * out of scope here". That leaves the call site itself untested: nothing proved that `afx cleanup`
 * reaches the dismissal at all, nor that it passes the NORMALIZED workspace path and the canonical
 * `builder.id` the mailbox actually keyed the rows under.
 *
 * So these tests drive the real exported `cleanup()` end to end with only its side-effecting
 * collaborators stubbed (git, Tower, forge, ps, state writes). `db/mailbox.js` and
 * `utils/workspace-path.js` stay REAL against an in-memory GLOBAL_SCHEMA database, so the
 * assertions are about rows the production code path actually transitioned.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import type { Builder, Config } from '../types.js';

let db: Database.Database | null = null;
/** Flips on to simulate a mailbox/DB hiccup at the dismissal step (must stay non-fatal). */
let dbUnavailable = false;

vi.mock('../db/index.js', () => {
  const ensure = () => {
    if (dbUnavailable) throw new Error('global.db unavailable');
    if (!db) {
      db = new Database(':memory:');
      db.exec(GLOBAL_SCHEMA);
    }
    return db;
  };
  return { getDb: ensure, getGlobalDb: ensure, closeDb: () => {}, closeGlobalDb: () => {} };
});

// `ps` must never run for real here — killShellperProcesses would otherwise signal processes.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: vi.fn() };
});

const mockLoadState = vi.fn();
const mockRemoveBuilder = vi.fn();
vi.mock('../state.js', () => ({
  loadState: (ws: string) => mockLoadState(ws),
  removeBuilder: (id: string, ws?: string) => mockRemoveBuilder(id, ws),
}));

const mockGetConfig = vi.fn<() => Config>();
vi.mock('../utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/index.js')>()),
  getConfig: () => mockGetConfig(),
}));

// Silence the console logger but keep `info` observable — the dismissal's operator-facing line
// is part of what this test asserts. Derived from the real logger's own keys so a new method
// added upstream cannot make this suite fail for an unrelated reason.
const loggerInfo = vi.fn();
vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  const silent = Object.fromEntries(Object.keys(actual.logger).map((k) => [k, vi.fn()]));
  return {
    ...actual,
    logger: { ...silent, info: loggerInfo },
    fatal: (msg: string) => {
      throw new Error(msg);
    },
  };
});

const mockRun = vi.fn(async () => ({ stdout: '', stderr: '' }));
vi.mock('../utils/shell.js', () => ({ run: (...args: unknown[]) => mockRun(...(args as [])) }));

vi.mock('../lib/tower-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tower-client.js')>()),
  TowerClient: class {
    async killTerminal() {
      return false;
    }
    // cleanupBuilder's last step (invalidate Tower's overview cache). Stubbed rather than omitted:
    // a missing method would throw a TypeError into the surrounding catch, silently exercising the
    // Tower-is-down recovery branch instead of the normal path.
    async refreshOverview() {}
  },
}));

vi.mock('../utils/file-tabs.js', () => ({ deleteFileTabsByPathPrefix: () => 0 }));
vi.mock('../../lib/forge.js', () => ({ executeForgeCommand: vi.fn(async () => []) }));

const { cleanup } = await import('../commands/cleanup.js');
const { getGlobalDb } = await import('../db/index.js');
const mailbox = await import('../db/mailbox.js');
const { normalizeWorkspacePath } = await import('../utils/workspace-path.js');

/** A real directory so `normalizeWorkspacePath`'s realpathSync resolves on both sides. */
const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'air-1477-cleanup-')));
/** Exactly what the mailbox keys rows under. */
const WS = normalizeWorkspacePath(workspaceRoot);

afterAll(() => {
  db?.close();
  db = null;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function config(overrides: Partial<Config> = {}): Config {
  return {
    workspaceRoot,
    codevDir: join(workspaceRoot, 'codev'), // absent on disk → cleanupPorchState is a no-op
    buildersDir: join(workspaceRoot, '.builders'),
    stateDir: join(workspaceRoot, '.codev'),
    templatesDir: join(workspaceRoot, 'templates'),
    serversDir: join(workspaceRoot, 'servers'),
    bundledRolesDir: join(workspaceRoot, 'roles'),
    terminalBackend: 'node-pty',
    ...overrides,
  };
}

function builder(id: string, overrides: Partial<Builder> = {}): Builder {
  return {
    id,
    name: id,
    status: 'complete',
    phase: 'done',
    // Never created on disk: existsSync() is false, so no worktree/git side effects are reached.
    worktree: join(workspaceRoot, '.builders', id),
    branch: `builder/${id}`,
    type: 'spec',
    ...overrides,
  };
}

const hold = (toAgent: string, now: number) =>
  mailbox.enqueue(getGlobalDb(), { workspacePath: WS, toAgent, body: 'hi', formattedMessage: 'M', reason: 'busy' }, now);

describe('Issue #1477 — cleanup() dismisses the removed builder\'s held mail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbUnavailable = false;
    if (db) db.close();
    db = null;
    getGlobalDb();
    mockGetConfig.mockReturnValue(config());
    mockRun.mockResolvedValue({ stdout: '', stderr: '' });
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: (e: Error | null, out: string) => void) => {
      cb(null, '');
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);
  });

  it('transitions the removed builder\'s held rows to dismissed, leaving a sibling\'s mail alone', async () => {
    const gone1 = hold('air-1477', 1000);
    const gone2 = hold('air-1477', 1100);
    const stays = hold('spir-1313', 1200);
    // Issue #1118: one global.db holds every workspace's rows, and the SAME builder id can exist
    // in two of them. Cleaning up here must not reach into another workspace's mailbox.
    const otherWorkspace = mailbox.enqueue(
      getGlobalDb(),
      { workspacePath: '/somewhere/else', toAgent: 'air-1477', body: 'hi', formattedMessage: 'M', reason: 'busy' },
      1300,
    );
    mockLoadState.mockReturnValue({ builders: [builder('air-1477')], architects: [], utils: [], annotations: [] });

    await cleanup({ project: 'air-1477' });

    // Soft, audit-preserving transition — not a delete.
    expect(mailbox.getById(getGlobalDb(), gone1.id)?.status).toBe('dismissed');
    expect(mailbox.getById(getGlobalDb(), gone2.id)?.status).toBe('dismissed');
    expect(mailbox.getById(getGlobalDb(), stays.id)?.status).toBe('held');
    expect(mailbox.getById(getGlobalDb(), otherWorkspace.id)?.status).toBe('held');

    // The removed builder no longer pins the workspace held count or the starvation alarm.
    expect(mailbox.heldSummaryForWorkspace(getGlobalDb(), WS).byAgent.map((a) => a.toAgent)).toEqual(['spir-1313']);
    // findStarvingAgents is Tower-GLOBAL, so scope to this workspace — the surviving
    // `/somewhere/else` row for the same id is exactly what must NOT have been dismissed.
    const starving = mailbox.findStarvingAgents(getGlobalDb());
    expect(starving.filter((s) => s.workspacePath === WS).map((s) => s.toAgent)).toEqual(['spir-1313']);
    expect(starving.some((s) => s.workspacePath === '/somewhere/else' && s.toAgent === 'air-1477')).toBe(true);

    expect(loggerInfo).toHaveBeenCalledWith('Dismissed 2 held mailbox message(s) for air-1477');
    expect(mockRemoveBuilder).toHaveBeenCalledWith('air-1477', workspaceRoot);
  });

  it('normalizes the configured workspaceRoot to the path the mailbox keyed rows under', async () => {
    // A non-canonical but equivalent workspaceRoot — the round-trip only matches because the
    // call site normalizes. A raw `config.workspaceRoot` would key a different string and dismiss
    // nothing.
    mockGetConfig.mockReturnValue(config({ workspaceRoot: join(workspaceRoot, 'nested', '..') }));
    const held = hold('air-1477', 1000);
    mockLoadState.mockReturnValue({ builders: [builder('air-1477')], architects: [], utils: [], annotations: [] });

    await cleanup({ project: 'air-1477' });

    expect(mailbox.getById(getGlobalDb(), held.id)?.status).toBe('dismissed');
  });

  it('dismisses held mail for an ephemeral (bugfix) builder too — the step is type-agnostic', async () => {
    const held = hold('bugfix-42', 1000);
    mockLoadState.mockReturnValue({
      builders: [builder('bugfix-42', { type: 'bugfix', issueNumber: 42 })],
      architects: [],
      utils: [],
      annotations: [],
    });

    await cleanup({ issue: 42, force: true });

    expect(mailbox.getById(getGlobalDb(), held.id)?.status).toBe('dismissed');
    expect(mockRemoveBuilder).toHaveBeenCalledWith('bugfix-42', workspaceRoot);
  });

  it('is non-fatal: a global.db failure at the dismissal step does not block state cleanup', async () => {
    hold('air-1477', 1000);
    mockLoadState.mockReturnValue({ builders: [builder('air-1477')], architects: [], utils: [], annotations: [] });
    // Blunt on purpose: every `getGlobalDb()` throws, which the earlier file-tab step also
    // absorbs. The dismissal's own `try` is still what this pins — remove it from cleanup.ts and
    // the throw escapes `cleanup()`, failing the assertion below.
    dbUnavailable = true;

    await expect(cleanup({ project: 'air-1477' })).resolves.toBeUndefined();

    dbUnavailable = false;
    expect(mockRemoveBuilder).toHaveBeenCalledWith('air-1477', workspaceRoot);
  });
});
