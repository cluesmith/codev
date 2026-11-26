/**
 * Two test Towers connected to the stand-in relay over loopback (Spec 1967, plan phase 2,
 * layer B): the launcher every later two-Tower test runs on.
 *
 * Each Tower is a real built Tower process, started through `startTower` in
 * `tower-test-utils.ts`; spawn, readiness and teardown are not re-implemented here. What
 * this adds is what makes two of them a pair of Towers on one Codev Cloud account. For
 * each Tower the harness owns, writes before the start, and removes at the end:
 *
 * - an agent-farm directory (`CODEV_AGENT_FARM_DIR`) holding `cloud-config.json`, which
 *   points at the stand-in's loopback URL with this Tower's id, slug and key, and the
 *   shared `local-key`. Tower reads the config at startup and connects its tunnel;
 * - a socket directory (`SHELLPER_SOCKET_DIR`) and a throwaway `HOME`, so nothing reads
 *   the owner's `~/.codev` or writes under the real home directory;
 * - `AF_TEST_PEER_BACKOFF_MS`, the test-only retry base a Tower honours under
 *   `NODE_ENV=test` (from plan phase 8), so a retry takes milliseconds.
 *
 * `startTower` spreads these after its own defaults, so they win; it still sets
 * `NODE_ENV=test` and `AF_TEST_DB` from the port. The directories `startTower` makes for
 * itself go unused, and its `stop()` removes them. A restart calls it again with the same
 * port and the same values, so the Tower finds the same directories and database.
 *
 * Also here: workspaces with inert agents, and a CLI runner that runs a command of the
 * CLI in this process against either Tower, switching the mocked Tower port and the
 * database path per call (the pattern of `cross-workspace-addressing.e2e.test.ts`). The
 * built `afx` binary always connects to port 4100, the developer's live Tower, and is
 * never run. A test file wires the runner in with two `vi.mock` calls:
 *
 *   vi.mock('../lib/tower-client.js', async (importOriginal) =>
 *     (await import('./helpers/two-towers.js')).towerClientModuleFor(await importOriginal()));
 *   vi.mock('../db/index.js', async (importOriginal) =>
 *     (await import('./helpers/two-towers.js')).dbModuleFor(await importOriginal()));
 *
 * Nothing here sends through the real Codev Cloud or touches the live Tower on port 4100.
 */

import { vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import Database from 'better-sqlite3';
import { StandInRelay, type StandInAccount, type StandInRelayOptions, type StandInTower } from './stand-in-relay.js';
import {
  createIsolatedAgentFarmDir,
  encodeWorkspacePath,
  isPortListening,
  pidsNamingSocketDir,
  removeIsolatedAgentFarmDir,
  startTower,
  waitFor,
  type TowerHandle,
} from './tower-test-utils.js';
import { socketTempRoot } from './socket-temp-root.js';
import type * as TowerClientModule from '../../lib/tower-client.js';
import type * as DbModule from '../../db/index.js';

/** The retry base the harness gives its Towers, in milliseconds. */
export const HARNESS_PEER_BACKOFF_MS = 50;

/** An inert terminal: it stays alive, reads nothing, and shows no agent composer. */
export const INERT_SCRIPT = 'trap "" INT; while true; do sleep 3600; done';

// ===========================================================================
// One Tower of the pair
// ===========================================================================

export class HarnessTower {
  /** The running process, or `null` between a stop and a start. */
  handle: TowerHandle | null = null;
  /** Fixed by the first start; every restart reuses it. */
  port = 0;
  /** Every handle this Tower has had, so teardown can check what each left behind. */
  readonly handles: TowerHandle[] = [];
  /** Workspaces activated here, deactivated at teardown (which is what ends their shellpers). */
  readonly workspaces: string[] = [];

  constructor(
    /** `a` or `b`, for messages. */
    readonly label: string,
    /** This Tower's row in the stand-in. */
    readonly record: StandInTower,
    readonly agentFarmDir: string,
    readonly socketDir: string,
    readonly home: string,
    private readonly relay: StandInRelay,
  ) {}

  get towerId(): string {
    return this.record.towerId;
  }

  get slug(): string {
    return this.record.slug;
  }

  /** This Tower's own database, in its own agent-farm directory. */
  get dbPath(): string {
    return join(this.agentFarmDir, `test-${this.port}.db`);
  }

  /** What the harness passes `startTower`, the same on every start. */
  get extraEnv(): Record<string, string> {
    return {
      CODEV_AGENT_FARM_DIR: this.agentFarmDir,
      SHELLPER_SOCKET_DIR: this.socketDir,
      HOME: this.home,
      AF_TEST_PEER_BACKOFF_MS: String(HARNESS_PEER_BACKOFF_MS),
    };
  }

  async start(): Promise<void> {
    if (this.handle) throw new Error(`Tower ${this.label} is already running`);
    const handle = await startTower(this.port === 0 ? undefined : this.port, this.extraEnv);
    this.handle = handle;
    this.port = handle.port;
    this.handles.push(handle);
  }

  async stop(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    this.handle = null;
    await handle.stop();
  }

  /**
   * Stop and start again on the same port, directories and database, so what Tower keeps
   * in its database (mail, peer state) is there again. Terminals are not: on startup Tower
   * ends the shellpers of every workspace under a temp directory and forgets their sessions
   * (`isTemporaryWorkspace` in `servers/tower-terminals.ts`), and every workspace here is
   * under one. A test that needs an agent after a restart activates its workspace again.
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** A call to this Tower's HTTP API (the e2e setup adds the local key). */
  fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${path}`, init);
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await this.fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  }

  /** `GET /api/tunnel/status`. */
  async tunnelStatus(): Promise<{ registered: boolean; state: string; towerId?: string; towerName?: string }> {
    return (await this.json<{ registered: boolean; state: string; towerId?: string; towerName?: string }>('GET', '/api/tunnel/status'))
      .body;
  }

  /** Until Tower says its tunnel is connected and the stand-in holds a live session for it. */
  async waitForTunnel(timeoutMs = 30_000): Promise<void> {
    let last = '';
    const connected = await waitFor(
      async () => {
        const status = await this.tunnelStatus().catch((err) => ({ state: `unreachable: ${err}` }));
        last = JSON.stringify(status);
        return status.state === 'connected' && this.relay.session(this.towerId) !== null;
      },
      timeoutMs,
      100,
    );
    if (!connected) throw new Error(`Tower ${this.label}'s tunnel to the stand-in never came up; last status: ${last}`);
  }

  // -------------------------------------------------------------------------
  // Workspaces and inert terminals
  // -------------------------------------------------------------------------

  /** Activate a workspace. The port can accept connections before Tower's instances are ready. */
  async activate(workspacePath: string): Promise<void> {
    let last = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = await this.fetch(`/api/workspaces/${encodeWorkspacePath(workspacePath)}/activate`, { method: 'POST' });
      if (res.ok) {
        if (!this.workspaces.includes(workspacePath)) this.workspaces.push(workspacePath);
        return;
      }
      last = `${res.status} ${await res.text()}`;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Tower ${this.label}: workspace ${workspacePath} did not activate: ${last}`);
  }

  async deactivate(workspacePath: string): Promise<void> {
    const res = await this.fetch(`/api/workspaces/${encodeWorkspacePath(workspacePath)}/deactivate`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Tower ${this.label}: workspace ${workspacePath} did not deactivate: ${res.status}`);
    const index = this.workspaces.indexOf(workspacePath);
    if (index >= 0) this.workspaces.splice(index, 1);
  }

  /** A named architect in a running workspace (it runs the workspace's inert architect command). */
  async addArchitect(workspacePath: string, name: string): Promise<void> {
    const res = await this.json('POST', `/api/workspaces/${encodeWorkspacePath(workspacePath)}/architects`, { name });
    if (res.status >= 300) throw new Error(`Tower ${this.label}: add-architect ${name} failed: ${res.status}`);
  }

  /**
   * A builder as `afx spawn` leaves one: a worktree directory, a live inert terminal, and
   * its row in this Tower's database naming the architect that spawned it. A test Tower has
   * no spawn, so the row is written here, into this Tower's own throwaway database.
   */
  async addBuilder(workspacePath: string, id: string, dirName: string, spawnedBy: string): Promise<string> {
    const worktree = join(workspacePath, '.builders', dirName);
    mkdirSync(worktree, { recursive: true });
    const res = await this.json<unknown>('POST', '/api/terminals', {
      command: '/bin/sh',
      args: ['-c', INERT_SCRIPT],
      cwd: worktree,
      cols: 80,
      rows: 24,
      workspacePath,
      type: 'builder',
      roleId: id,
      persistent: true,
    });
    if (res.status !== 201) throw new Error(`Tower ${this.label}: builder terminal failed: ${res.status} ${JSON.stringify(res.body)}`);
    const db = new Database(this.dbPath);
    try {
      db.prepare(
        `INSERT INTO builders (workspace_path, id, name, worktree, branch, type, status, spawned_by_architect)
         VALUES (?, ?, ?, ?, ?, 'spec', 'implementing', ?)`,
      ).run(workspacePath, id, id, worktree, `builder/${dirName}`, spawnedBy);
    } finally {
      db.close();
    }
    return worktree;
  }

  /** Read this Tower's database (read-only). */
  readDb<T>(read: (db: Database.Database) => T): T {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  }
}

/**
 * The inert program as one executable file. A workspace's architect command is split on
 * whitespace and given further arguments by Tower, so it has to be a single word that
 * ignores whatever follows it.
 */
export function writeInertAgent(dir: string): string {
  const file = join(dir, 'inert-agent.sh');
  writeFileSync(file, `#!/bin/sh\n${INERT_SCRIPT}\n`, { mode: 0o755 });
  return file;
}

/** A workspace directory whose agents all run `agentCommand`. */
export function makeWorkspace(path: string, agentCommand: string): string {
  mkdirSync(join(path, 'codev'), { recursive: true });
  mkdirSync(join(path, '.agent-farm'), { recursive: true });
  mkdirSync(join(path, '.codev'), { recursive: true });
  writeFileSync(
    join(path, '.codev', 'config.json'),
    JSON.stringify({ shell: { architect: agentCommand, builder: 'bash', shell: 'bash' } }),
  );
  return path;
}

// ===========================================================================
// The pair
// ===========================================================================

export interface TwoTowersOptions {
  relay?: StandInRelayOptions;
  /** The two Towers' slugs on the one account. Default `mbp` and `devvm`. */
  slugs?: [string, string];
}

/** What teardown left behind: every list empty is a clean stop. */
export interface TeardownReport {
  /** Tower processes that had not exited. */
  processes: number[];
  /** Shellpers still alive that name one of the Towers' socket directories. */
  shellpers: number[];
  /** Directories that still exist. */
  paths: string[];
  /** Whether the stand-in's port still accepts connections. */
  relayListening: boolean;
}

export interface TwoTowers {
  relay: StandInRelay;
  /** The one account both Towers are on. */
  owner: StandInAccount;
  a: HarnessTower;
  b: HarnessTower;
  /** A directory (its real path) for the test's workspaces, removed at teardown. */
  root: string;
  /** Deactivate every workspace, stop both Towers and the stand-in, remove every directory. */
  stop(): Promise<TeardownReport>;
}

function makeTower(label: string, record: StandInTower, relay: StandInRelay, cleanup: string[]): HarnessTower {
  const agentFarmDir = createIsolatedAgentFarmDir();
  writeFileSync(
    join(agentFarmDir, 'cloud-config.json'),
    `${JSON.stringify(
      { tower_id: record.towerId, tower_name: record.slug, api_key: record.apiKey, server_url: relay.url },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  // Under a root short enough for Unix socket paths (see socketTempRoot).
  const socketDir = mkdtempSync(join(socketTempRoot(), 'codev-sock-peer-'));
  const home = mkdtempSync(join(tmpdir(), 'codev-peer-home-'));
  cleanup.push(socketDir, home);
  return new HarnessTower(label, record, agentFarmDir, socketDir, home, relay);
}

/**
 * Start the stand-in, register two Towers on one account in it, and start both Towers
 * against it, one after the other (each `startTower` picks the next free port). Resolves
 * once both tunnels are up.
 */
export async function startTwoTowers(options: TwoTowersOptions = {}): Promise<TwoTowers> {
  const [slugA, slugB] = options.slugs ?? ['mbp', 'devvm'];
  const relay = new StandInRelay(options.relay);
  await relay.start();
  const owner = relay.addAccount({ ownerId: 'usr_harness', ownerEmail: 'owner@example.com' });
  const dirs: string[] = [];
  const a = makeTower('a', relay.addTower({ account: owner, slug: slugA }), relay, dirs);
  const b = makeTower('b', relay.addTower({ account: owner, slug: slugB }), relay, dirs);
  // The temp dir is behind a symlink on macOS (/var → /private/var); Tower keys a
  // workspace by its real path, and the CLI must name the same one.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codev-peer-ws-')));
  dirs.push(root);

  let stopped: Promise<TeardownReport> | null = null;
  const stop = (): Promise<TeardownReport> => (stopped ??= teardown(relay, [a, b], dirs));

  try {
    await a.start();
    await b.start();
    await a.waitForTunnel();
    await b.waitForTunnel();
  } catch (err) {
    await stop();
    throw err;
  }
  return { relay, owner, a, b, root, stop };
}

async function teardown(relay: StandInRelay, towers: HarnessTower[], dirs: string[]): Promise<TeardownReport> {
  for (const tower of towers) {
    // Shellpers outlive Tower by design: deactivating each workspace is what ends them.
    // A failure here is not swallowed silently: the report below is what shows it.
    if (tower.handle) {
      for (const workspacePath of [...tower.workspaces]) await tower.deactivate(workspacePath).catch(() => {});
    }
    await tower.stop();
    removeIsolatedAgentFarmDir(tower.agentFarmDir);
  }
  await relay.stop();

  const socketDirs = towers.map((tower) => tower.socketDir);
  let shellpers = socketDirs.flatMap((dir) => pidsNamingSocketDir(dir));
  for (let i = 0; i < 40 && shellpers.length > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    shellpers = socketDirs.flatMap((dir) => pidsNamingSocketDir(dir));
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

  const handles = towers.flatMap((tower) => tower.handles);
  const candidates = [
    ...towers.map((tower) => tower.agentFarmDir),
    ...dirs,
    ...handles.flatMap((handle) => [handle.socketDir, handle.agentFarmDir]),
  ];
  return {
    processes: handles
      .filter((handle) => handle.process.exitCode === null && handle.process.signalCode === null)
      .map((handle) => handle.process.pid ?? -1),
    shellpers,
    paths: candidates.filter((path) => existsSync(path)),
    relayListening: relay.port !== 0 && (await isPortListening(relay.port)),
  };
}

// ===========================================================================
// The CLI, run in this process against either Tower
// ===========================================================================

/** Where the next CLI command connects and which database it opens. */
export const cliTarget = { port: 0, dbPath: '' };

/** The mocked `lib/tower-client.js`: every client connects to the current target's port. */
export function towerClientModuleFor(actual: typeof TowerClientModule): typeof TowerClientModule {
  class TowerClient extends actual.TowerClient {
    constructor() {
      super(cliTarget.port);
    }
  }
  return { ...actual, TowerClient, getTowerClient: () => new TowerClient() };
}

/** The mocked `db/index.js`: global.db is the current target's own database. */
export function dbModuleFor(actual: typeof DbModule): typeof DbModule {
  return { ...actual, getGlobalDbPath: () => cliTarget.dbPath };
}

/** Who runs a command: where its terminal is, and for an architect the name Tower gave it. */
export interface CliAgent {
  cwd: string;
  architect?: string;
}

export interface CliRun {
  /** `null` when the command returned; the status it exited with otherwise. */
  exitCode: number | null;
  /** What the command returned, when it returned. */
  result: unknown;
  stdout: string[];
  stderr: string[];
}

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function printed(args: unknown[]): string {
  return stripVTControlCharacters(args.map(String).join(' '));
}

/** Commands change the process's working directory and environment: one at a time. */
let cliQueue: Promise<unknown> = Promise.resolve();

/**
 * Run one CLI command as `agent`, against `tower`: its port and its database. Captures what
 * the command prints and how it ends; `process.exit` is caught, not taken.
 */
export function runCli(tower: HarnessTower, agent: CliAgent, command: () => Promise<unknown>): Promise<CliRun> {
  const run = cliQueue.then(() => runCliNow(tower, agent, command));
  cliQueue = run.catch(() => {});
  return run;
}

async function runCliNow(tower: HarnessTower, agent: CliAgent, command: () => Promise<unknown>): Promise<CliRun> {
  if (!tower.handle) throw new Error(`Tower ${tower.label} is not running`);
  cliTarget.port = tower.port;
  cliTarget.dbPath = tower.dbPath;
  const cwd = process.cwd();
  const architectName = process.env.CODEV_ARCHITECT_NAME;
  const out: CliRun = { exitCode: null, result: undefined, stdout: [], stderr: [] };
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => void out.stdout.push(printed(args)));
  const error = vi.spyOn(console, 'error').mockImplementation((...args) => void out.stderr.push(printed(args)));
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.stdout.push(...String(chunk).replace(/\n$/, '').split('\n'));
    return true;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code ?? 0);
  }) as never);
  try {
    process.chdir(agent.cwd);
    if (agent.architect === undefined) delete process.env.CODEV_ARCHITECT_NAME;
    else process.env.CODEV_ARCHITECT_NAME = agent.architect;
    out.result = await command();
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    out.exitCode = err.code;
  } finally {
    process.chdir(cwd);
    if (architectName === undefined) delete process.env.CODEV_ARCHITECT_NAME;
    else process.env.CODEV_ARCHITECT_NAME = architectName;
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
    exit.mockRestore();
  }
  return out;
}
