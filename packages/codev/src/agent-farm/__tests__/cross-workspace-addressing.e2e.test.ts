/**
 * Cross-workspace addressing on a real Tower (Spec 1940, stage 1): the headline path, from
 * the command a person types to the frame the recipient reads.
 *
 *   From one workspace's named architect, `afx send <other-workspace>:architect:<name> "…"`,
 *   see it arrive under a header that says who sent it, and answer with the command the
 *   frame prints.
 *
 * A built Tower is started on its own port, directory and database, and is never connected
 * to Codev Cloud. Every case is driven through the CLI's own commands (`commands/send.ts`,
 * `commands/workspace-name.ts`, `commands/workspace-list.ts`) run in this process as the
 * agent in question: its working directory, and for an architect the name Tower puts in
 * its terminal's environment. Workspace detection, sender identity, the SDK call, the
 * printed result and the exit status are therefore the real ones.
 *
 * Two things are replaced, both of them WHERE and neither of them WHAT: the port the CLI's
 * Tower client connects to, and the file it opens as global.db (this Tower's own). The
 * built `afx` binary cannot be used: it always connects to port 4100, which on a
 * developer's machine is their live Tower.
 *
 * The frames are read from the mailbox as Tower stored them (`formatted_message`, the
 * exact text that is typed into the recipient's terminal). The terminals here are inert
 * shells, so the render gate holds every message: nothing is typed, and what would be is
 * on record.
 *
 * Run by file, after `pnpm build`:
 *
 *   pnpm exec vitest run --config vitest.e2e.config.ts \
 *     src/agent-farm/__tests__/cross-workspace-addressing.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import Database from 'better-sqlite3';
import { startTower, encodeWorkspacePath, pidsNamingSocketDir, type TowerHandle } from './helpers/tower-test-utils.js';

const run = vi.hoisted(() => ({ port: 0, dbPath: '' }));

vi.mock('../lib/tower-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tower-client.js')>();
  class TowerClient extends actual.TowerClient {
    constructor() {
      super(run.port);
    }
  }
  return { ...actual, TowerClient, getTowerClient: () => new TowerClient() };
});
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => run.dbPath };
});

const { send } = await import('../commands/send.js');
const { workspaceName } = await import('../commands/workspace-name.js');
const { workspaceList } = await import('../commands/workspace-list.js');
const { resolveIdentity } = await import('../commands/whoami.js');
const { inboxList } = await import('../commands/inbox.js');

/** An inert terminal: it stays alive, reads nothing, and shows no agent composer. */
const INERT_SCRIPT = 'trap "" INT; while true; do sleep 3600; done';

const BUILDER = 'builder-spir-7';

/** Who runs a command: where its terminal is, and for an architect the name Tower gave it. */
interface Agent {
  cwd: string;
  architect?: string;
}

interface CliRun {
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

/** Run one CLI command as `agent`, capturing what it prints and how it ends. */
async function runAs(agent: Agent, command: () => Promise<unknown>): Promise<CliRun> {
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

/** What `afx send` prints before it sends. Everything after it is the outcome. */
const SEND_BANNER = ['', 'Sending Instruction', '───────────────────'];

/** What `afx send` printed to stdout about the outcome: nothing, when it failed. */
function outcomeLines(sent: CliRun): string[] {
  expect(sent.stdout.slice(0, SEND_BANNER.length)).toEqual(SEND_BANNER);
  return sent.stdout.slice(SEND_BANNER.length);
}

/** `afx send <to> "<message>"`, typed by `agent`. */
function afxSend(agent: Agent, to: string, message: string): Promise<CliRun> {
  return runAs(agent, () => send({ builder: to, message }));
}

interface StoredMail {
  id: string;
  workspace_path: string;
  to_agent: string;
  from_agent: string | null;
  from_workspace: string | null;
  body: string;
  formatted_message: string;
  status: string;
  reason: string | null;
}

function readDb<T>(read: (db: Database.Database) => T): T {
  const db = new Database(run.dbPath, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function mailCount(): number {
  return readDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM mailbox').get() as { n: number }).n);
}

/** The one stored message with this body. Bodies in this file are unique. */
function mailWithBody(body: string): StoredMail {
  const rows = readDb((db) => db.prepare('SELECT * FROM mailbox WHERE body = ?').all(body) as StoredMail[]);
  expect(rows, `messages stored with the body ${JSON.stringify(body)}`).toHaveLength(1);
  return rows[0];
}

/** A frame as its three lines, with the timestamp (the one part that varies) replaced. */
function frameLines(mail: StoredMail): string[] {
  const lines = mail.formatted_message.replace(/\r?\n$/, '').split(/\r?\n/);
  return [lines[0].replace(/ \| [^\]]+\] ###$/, ' | <time>] ###'), ...lines.slice(1)];
}

/** The address in a frame's reply command: what the recipient pastes after `afx send`. */
function replyAddress(mail: StoredMail): string {
  const footer = mail.formatted_message.replace(/\r?\n$/, '').split(/\r?\n/).at(-1)!;
  const match = /\(reply: afx send (\S+) "…"\)$/.exec(footer);
  expect(match, `a reply command on the footer line: ${footer}`).not.toBeNull();
  return match![1];
}

/**
 * The inert program as one executable file. A workspace's architect command is split on
 * whitespace and given further arguments by Tower, so it has to be a single word that
 * ignores whatever follows it.
 */
function writeInertAgent(dir: string): string {
  const file = join(dir, 'inert-agent.sh');
  writeFileSync(file, `#!/bin/sh\n${INERT_SCRIPT}\n`, { mode: 0o755 });
  return file;
}

function makeWorkspace(path: string, architectCommand: string): string {
  mkdirSync(join(path, 'codev'), { recursive: true });
  mkdirSync(join(path, '.agent-farm'), { recursive: true });
  mkdirSync(join(path, '.codev'), { recursive: true });
  writeFileSync(
    join(path, '.codev', 'config.json'),
    JSON.stringify({ shell: { architect: architectCommand, builder: 'bash', shell: 'bash' } }),
  );
  return path;
}

async function tower(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://localhost:${run.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function activate(workspacePath: string): Promise<void> {
  let res: Response | null = null;
  // The port can accept connections before Tower's instances are initialised.
  for (let attempt = 0; attempt < 30; attempt++) {
    res = await tower('POST', `/api/workspaces/${encodeWorkspacePath(workspacePath)}/activate`);
    if (res.ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`workspace ${workspacePath} did not activate: ${res?.status} ${await res?.text()}`);
}

async function deactivate(workspacePath: string): Promise<void> {
  const res = await tower('POST', `/api/workspaces/${encodeWorkspacePath(workspacePath)}/deactivate`);
  if (!res.ok) throw new Error(`workspace ${workspacePath} did not deactivate: ${res.status} ${await res.text()}`);
}

async function addArchitect(workspacePath: string, name: string): Promise<void> {
  const res = await tower('POST', `/api/workspaces/${encodeWorkspacePath(workspacePath)}/architects`, { name });
  if (!res.ok) throw new Error(`add-architect ${name} failed: ${res.status} ${await res.text()}`);
}

/**
 * A builder as `afx spawn` leaves one: a worktree directory, a live terminal, and its row
 * in global.db naming the architect that spawned it. A test Tower has no spawn, so the
 * row is written here, into this Tower's own throwaway database.
 */
async function addBuilder(workspacePath: string, id: string, dirName: string, spawnedBy: string): Promise<string> {
  const worktree = join(workspacePath, '.builders', dirName);
  mkdirSync(worktree, { recursive: true });
  const res = await tower('POST', '/api/terminals', {
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
  if (res.status !== 201) throw new Error(`builder terminal failed: ${res.status} ${await res.text()}`);
  const db = new Database(run.dbPath);
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

/** An architect Tower has registered that has no terminal: between sessions. */
function registerArchitectWithNoTerminal(workspacePath: string, name: string): void {
  const db = new Database(run.dbPath);
  try {
    db.prepare('INSERT INTO architect (workspace_path, id, pid, port, cmd) VALUES (?, ?, 0, 0, ?)').run(
      workspacePath,
      name,
      'sh',
    );
  } finally {
    db.close();
  }
}

describe('Spec 1940: cross-workspace addressing on a real Tower that has never connected to Codev Cloud', () => {
  let handle: TowerHandle;
  let root: string;
  /** `<root>/a/codev`: architects `main` and `review`. */
  let codev: string;
  /** `<root>/codev-cloud`: architects `main` and `tunnel`, the builder, and `data` with no terminal. */
  let cloud: string;
  /** `<root>/b/codev`: a second directory called `codev`, started only for the last cases. */
  let otherCodev: string;
  let builderWorktree: string;
  /** The inert program every workspace here runs as its architect. */
  let inertAgent: string;
  const active: string[] = [];

  const review = (): Agent => ({ cwd: codev, architect: 'review' });
  const tunnel = (): Agent => ({ cwd: cloud, architect: 'tunnel' });
  const builder = (): Agent => ({ cwd: builderWorktree });

  async function start(workspacePath: string): Promise<void> {
    await activate(workspacePath);
    active.push(workspacePath);
  }

  beforeAll(async () => {
    handle = await startTower();
    run.port = handle.port;
    run.dbPath = join(handle.agentFarmDir, `test-${handle.port}.db`);

    // The temp dir is behind a symlink on macOS (/var → /private/var); Tower keys a
    // workspace by its real path, and the CLI must name the same one.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'codev-1940-')));
    inertAgent = writeInertAgent(root);
    codev = makeWorkspace(join(root, 'a', 'codev'), inertAgent);
    cloud = makeWorkspace(join(root, 'codev-cloud'), inertAgent);
    otherCodev = makeWorkspace(join(root, 'b', 'codev'), inertAgent);

    await start(codev);
    await start(cloud);
    await addArchitect(codev, 'review');
    await addArchitect(cloud, 'tunnel');
    builderWorktree = await addBuilder(cloud, BUILDER, 'spir-7', 'main');
    registerArchitectWithNoTerminal(cloud, 'data');

    // Ready when mail to each live agent is held by the gate, not for want of a terminal.
    const probes: Array<[Agent, string]> = [
      [review(), 'architect'],
      [review(), 'codev-cloud:architect:tunnel'],
      [review(), `codev-cloud:${BUILDER}`],
      [tunnel(), 'codev:architect:review'],
      [tunnel(), 'architect'],
    ];
    for (const [index, [agent, to]] of probes.entries()) {
      let ready = false;
      let seen = '';
      for (let attempt = 0; attempt < 60 && !ready; attempt++) {
        const body = `ready? probe ${index} to ${to}, attempt ${attempt}`;
        const probe = await afxSend(agent, to, body);
        ready = probe.exitCode === null && probe.result === 'held' && mailWithBody(body).reason === 'no-profile';
        seen = JSON.stringify(probe);
        if (!ready) await new Promise((r) => setTimeout(r, 500));
      }
      // Says what the last attempt printed: a readiness failure with no reason is a guess.
      if (!ready) throw new Error(`${to} never became a live recipient whose mail the gate holds; last attempt: ${seen}`);
    }
    // The teardown asserts that this list ends empty. Seeing the live shellpers in it now
    // is what makes that assertion mean something.
    expect(pidsNamingSocketDir(handle.socketDir).length).toBeGreaterThan(0);
  }, 180_000);

  afterAll(async () => {
    if (!handle) return;
    // Shellpers outlive Tower by design: deactivating each workspace is what ends them. A
    // failed deactivation is not swallowed: the assertion below is what reports it.
    for (const workspacePath of active) {
      await fetch(`http://localhost:${handle.port}/api/workspaces/${encodeWorkspacePath(workspacePath)}/deactivate`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      }).catch(() => {});
    }
    const { socketDir } = handle;
    await handle.stop();
    if (root) rmSync(root, { recursive: true, force: true });

    let survivors = pidsNamingSocketDir(socketDir);
    for (let i = 0; i < 40 && survivors.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
      survivors = pidsNamingSocketDir(socketDir);
    }
    expect(survivors, `shellpers started by this run's Tower (${socketDir}) are still alive`).toEqual([]);
  }, 120_000);

  it('this Tower has never connected to Codev Cloud', async () => {
    const res = await tower('GET', '/api/tunnel/status');
    expect(res.ok).toBe(true);
    expect(await res.json()).toMatchObject({ registered: false, state: 'disconnected' });
  });

  it('the headline path: a named architect in the other workspace gets the message under a qualified header', async () => {
    const sent = await afxSend(review(), 'codev-cloud:architect:tunnel', 'CI is green on the tunnel branch');

    expect(sent.exitCode).toBeNull();
    expect(sent.result).toBe('held');
    expect(sent.stderr).toEqual([]);
    expect(outcomeLines(sent)[0]).toMatch(/^\[info\] Message held for tunnel \(no-profile.*\) — mailbox id [0-9a-f-]+\. /);

    const mail = mailWithBody('CI is green on the tunnel branch');
    expect(mail).toMatchObject({
      workspace_path: cloud,
      to_agent: 'tunnel',
      from_agent: 'architect:review',
      from_workspace: codev,
      status: 'held',
      reason: 'no-profile',
    });
    expect(frameLines(mail)).toEqual([
      '### [ARCHITECT codev:architect:review MESSAGE → tunnel | <time>] ###',
      'CI is green on the tunnel branch',
      '###############################  (reply: afx send codev:architect:review "…")',
    ]);
  });

  it('the reply command on that frame, run unchanged by the recipient, reaches the original sender', async () => {
    const received = mailWithBody('CI is green on the tunnel branch');
    const to = replyAddress(received);

    const replied = await afxSend(tunnel(), to, 'Thanks, merging the tunnel branch');

    expect(replied.exitCode).toBeNull();
    expect(replied.result).toBe('held');
    const mail = mailWithBody('Thanks, merging the tunnel branch');
    expect(mail).toMatchObject({ workspace_path: codev, to_agent: 'review', from_agent: 'architect:tunnel', from_workspace: cloud });
    // And the answer carries its own way back, so the two can keep talking.
    expect(frameLines(mail)).toEqual([
      '### [ARCHITECT codev-cloud:architect:tunnel MESSAGE → review | <time>] ###',
      'Thanks, merging the tunnel branch',
      '###############################  (reply: afx send codev-cloud:architect:tunnel "…")',
    ]);
    expect(replyAddress(mail)).toBe('codev-cloud:architect:tunnel');
  });

  it('a named architect that is registered but has no live terminal has its mail held no-live-pty', async () => {
    const sent = await afxSend(review(), 'codev-cloud:architect:data', 'For data, when it is back');

    expect(sent.exitCode).toBeNull();
    expect(sent.result).toBe('held');
    expect(outcomeLines(sent)[0]).toMatch(/^\[info\] Message held for data \(no-live-pty.*\) — mailbox id /);
    const mail = mailWithBody('For data, when it is back');
    expect(mail).toMatchObject({ workspace_path: cloud, to_agent: 'data', status: 'held', reason: 'no-live-pty' });
    expect(frameLines(mail)[0]).toBe('### [ARCHITECT codev:architect:review MESSAGE → data | <time>] ###');
  });

  it('a named architect that does not exist fails naming the workspace, its architects and its front door', async () => {
    const before = mailCount();

    const sent = await afxSend(review(), 'codev-cloud:architect:nobody', 'Is anyone there?');

    expect(sent.exitCode).toBe(1);
    expect(outcomeLines(sent)).toEqual([]);
    // The architects named are the ones with a terminal now: `data`, which is registered
    // and between sessions, is not among them, though mail to it is held.
    expect(sent.stderr).toEqual([
      "[error] Architect 'nobody' not found in workspace 'codev-cloud'. " +
        'Architects there: main, tunnel. Front door: codev-cloud:architect. (NOT_FOUND)',
    ]);
    expect(mailCount()).toBe(before);
  });

  it('a builder naming a named architect in another workspace is refused, told the front door, and nothing is stored', async () => {
    const before = mailCount();

    const sent = await afxSend(builder(), 'codev:architect:review', 'A builder writing to review');

    expect(sent.exitCode).toBe(1);
    expect(outcomeLines(sent)).toEqual([]);
    expect(sent.stderr).toEqual([
      `[error] builder ${BUILDER} may only address its own spawning architect; ` +
        'reach that workspace through its front door: afx send codev:architect "…" (REFUSED)',
    ]);
    expect(mailCount()).toBe(before);
  });

  it('the same builder reaches that workspace through its front door, and its own architect as before', async () => {
    const throughFrontDoor = await afxSend(builder(), 'codev:architect', 'For review, from the builder next door');

    expect(throughFrontDoor.exitCode).toBeNull();
    const atFrontDoor = mailWithBody('For review, from the builder next door');
    expect(atFrontDoor).toMatchObject({ workspace_path: codev, to_agent: 'main', from_agent: BUILDER });
    expect(frameLines(atFrontDoor)).toEqual([
      `### [BUILDER codev-cloud:${BUILDER} MESSAGE → main | <time>] ###`,
      'For review, from the builder next door',
      `###############################  (reply: afx send codev-cloud:${BUILDER} "…")`,
    ]);

    // Bare `architect` is still the architect that spawned it, in its own workspace, under
    // the same-workspace frame, which Spec 1940 does not change.
    const home = await afxSend(builder(), 'architect', 'Phase 2 is ready for review');
    expect(home.exitCode).toBeNull();
    const atHome = mailWithBody('Phase 2 is ready for review');
    expect(atHome).toMatchObject({ workspace_path: cloud, to_agent: 'main', from_agent: BUILDER });
    expect(frameLines(atHome)[0]).toBe(`### [BUILDER ${BUILDER} MESSAGE → main | <time>] ###`);
  });

  it('a named architect writing to a builder elsewhere: the builder is told how to answer, and the answer arrives', async () => {
    // `main` is the front door of its workspace, so the front door reaches it.
    await afxSend({ cwd: codev, architect: 'main' }, `codev-cloud:${BUILDER}`, 'From main to the builder');
    const fromMain = mailWithBody('From main to the builder');
    expect(frameLines(fromMain)).toEqual([
      `### [ARCHITECT codev:architect:main INSTRUCTION → ${BUILDER} | <time>] ###`,
      'From main to the builder',
      '###############################  (reply: afx send codev:architect "…")',
    ]);
    const answered = await afxSend(builder(), replyAddress(fromMain), 'The builder answers main');
    expect(answered.exitCode).toBeNull();
    expect(mailWithBody('The builder answers main')).toMatchObject({ workspace_path: codev, to_agent: 'main' });

    // `review` is not: the front door would reach `main`, so no command is printed for it.
    await afxSend(review(), `codev-cloud:${BUILDER}`, 'From review to the builder');
    expect(frameLines(mailWithBody('From review to the builder'))).toEqual([
      `### [ARCHITECT codev:architect:review INSTRUCTION → ${BUILDER} | <time>] ###`,
      'From review to the builder',
      '###############################  (reply through your architect: afx send architect "…")',
    ]);
  });

  it('an afx:// address is refused with the stated reason, and nothing is stored', async () => {
    const before = mailCount();

    const sent = await afxSend(review(), 'afx://devvm/codev:architect', 'To my other Tower');

    expect(sent.exitCode).toBe(1);
    expect(outcomeLines(sent)).toEqual([]);
    expect(sent.stderr).toHaveLength(1);
    expect(sent.stderr[0]).toContain(
      'Cross-Tower messaging is not available in this version: an afx:// address cannot be delivered yet.',
    );
    expect(mailCount()).toBe(before);
  });

  it('afx workspace list, as the builder, prints each address and the way in to the ones it may not name', async () => {
    const listed = await runAs(builder(), () => workspaceList());

    expect(listed.exitCode).toBeNull();
    expect(listed.stderr).toEqual([]);
    const lines = listed.stdout.map((line) => line.replace(/ +/g, ' ').trim());
    expect(lines).toEqual([
      `codev ${codev}`,
      'codev:architect:main live reach through codev:architect',
      'codev:architect:review live reach through codev:architect',
      `codev-cloud ${cloud}`,
      // Its own architect, and the two in its workspace that it may not name.
      'codev-cloud:architect:main live',
      'codev-cloud:architect:data no live terminal reach through architect',
      'codev-cloud:architect:tunnel live reach through architect',
      `codev-cloud:${BUILDER} live`,
    ]);
  });

  describe('a stopped workspace that Tower holds an empty slot for (Issue #1978)', () => {
    /**
     * `<root>/parked/codev-cloud`: started once, so Tower registered it and its architect
     * `main`, then stopped, which keeps that registration. It shares its directory name with
     * the running codev-cloud.
     */
    let parked: string;
    const HELD_WHILE_STOPPED = 'For main in the parked workspace, when it is back';

    /** A person at a plain shell in the parked workspace: no terminal of Tower's. */
    const atParked = (): Agent => ({ cwd: parked });

    beforeAll(async () => {
      parked = makeWorkspace(join(root, 'parked', 'codev-cloud'), inertAgent);
      await activate(parked);
      await deactivate(parked);
      // What a dashboard or extension poll of a stopped workspace does: it asks for the
      // workspace's state, and the route leaves an empty slot on the terminal map.
      const res = await tower('GET', `/workspace/${encodeWorkspacePath(parked)}/api/state`);
      expect(res.ok).toBe(true);
    }, 60_000);

    it('afx workspace list lists it as not running, with no agents, and the running codev-cloud keeps the name', async () => {
      const listed = await runAs(builder(), () => workspaceList());

      expect(listed.exitCode).toBeNull();
      const lines = listed.stdout.map((line) => line.replace(/ +/g, ' ').trim());
      // The running workspaces, exactly as before, then the stopped one, with no agents.
      expect(lines).toEqual([
        `codev ${codev}`,
        'codev:architect:main live reach through codev:architect',
        'codev:architect:review live reach through codev:architect',
        `codev-cloud ${cloud}`,
        'codev-cloud:architect:main live',
        'codev-cloud:architect:data no live terminal reach through architect',
        'codev-cloud:architect:tunnel live reach through architect',
        `codev-cloud:${BUILDER} live`,
        // The running codev-cloud keeps the directory name; the stopped one has none of its own.
        `(no address name) ${parked} not running`,
        `no address name: it shares the directory name 'codev-cloud' with ${cloud}; give it a name of its own: afx workspace name <name>`,
      ]);
    });

    it('the shared directory name still reaches the running workspace: the stopped one is not a second match', async () => {
      const sent = await afxSend(review(), 'codev-cloud:architect:tunnel', 'Tunnel, past the parked namesake');

      expect(sent.exitCode).toBeNull();
      expect(mailWithBody('Tunnel, past the parked namesake')).toMatchObject({ workspace_path: cloud, to_agent: 'tunnel' });
    });

    it('afx whoami gives the address the listing prints for the same agent', async () => {
      const who = await runAs(builder(), async () => resolveIdentity());
      const book = await tower('GET', `/api/address-book?workspace=${encodeURIComponent(cloud)}&from=${BUILDER}`);
      const listed = ((await book.json()) as { workspaces: Array<{ path: string; agents: Array<{ name: string; address: string | null }> }> })
        .workspaces.find((w) => w.path === cloud)!
        .agents.find((a) => a.name === BUILDER)!;

      expect(who.result).toMatchObject({ type: 'builder', name: BUILDER, address: `codev-cloud:${BUILDER}` });
      expect(listed.address).toBe(`codev-cloud:${BUILDER}`);
    });

    it('mail held for its architect while it is stopped stays held, and is listed by afx inbox', async () => {
      // A sender in the workspace itself addresses no workspace, and that path holds mail
      // for a registered agent with no terminal, as it always has.
      const sent = await afxSend(atParked(), 'architect', HELD_WHILE_STOPPED);
      expect(sent.exitCode).toBeNull();
      expect(sent.result).toBe('held');
      const held = mailWithBody(HELD_WHILE_STOPPED);
      expect(held).toMatchObject({ workspace_path: parked, to_agent: 'main', status: 'held', reason: 'no-live-pty' });

      const inbox = await runAs(atParked(), () => inboxList());
      expect(inbox.exitCode).toBeNull();
      expect(inbox.stdout.some((line) => line.includes(held.id) && line.includes('no-live-pty'))).toBe(true);
    });

    it('once it has a name, a send to its registered architect is refused as not running, and nothing is stored', async () => {
      const named = await runAs(atParked(), () => workspaceName({ name: 'parked' }));
      expect(named.exitCode).toBeNull();
      const before = mailCount();

      const sent = await afxSend(review(), 'parked:architect', 'For the parked workspace, by its name');

      expect(sent.exitCode).toBe(1);
      expect(outcomeLines(sent)).toEqual([]);
      expect(sent.stderr).toEqual([`[error] Workspace 'parked' (${parked}) is not running. (NOT_FOUND)`]);
      expect(mailCount()).toBe(before);
      // The mail it already held is untouched by the refusal.
      expect(mailWithBody(HELD_WHILE_STOPPED)).toMatchObject({ status: 'held', reason: 'no-live-pty' });
    });

    it('when the workspace starts, the mail held for its architect is offered to the new terminal', async () => {
      await start(parked);

      // The inert terminal shows no agent composer, so the gate holds the message for that
      // reason now: it was offered to a live terminal, and it is still on record, not dropped.
      let mail = mailWithBody(HELD_WHILE_STOPPED);
      for (let attempt = 0; attempt < 60 && mail.reason === 'no-live-pty'; attempt++) {
        await new Promise((r) => setTimeout(r, 500));
        mail = mailWithBody(HELD_WHILE_STOPPED);
      }
      expect(mail).toMatchObject({ workspace_path: parked, to_agent: 'main', status: 'held', reason: 'no-profile' });
      // And the address that was refused while it was stopped now reaches it.
      const sent = await afxSend(review(), 'parked:architect', 'For the parked workspace, now running');
      expect(sent.exitCode).toBeNull();
      expect(mailWithBody('For the parked workspace, now running')).toMatchObject({ workspace_path: parked, to_agent: 'main' });
    }, 60_000);
  });

  describe('two running workspaces whose directories are both called codev', () => {
    beforeAll(async () => {
      await start(otherCodev);
    }, 60_000);

    it('the shared name fails as ambiguous, listing both, and nothing is stored', async () => {
      const before = mailCount();

      const sent = await afxSend(tunnel(), 'codev:architect:review', 'Which codev is this for?');

      expect(sent.exitCode).toBe(1);
      expect(sent.stderr).toHaveLength(1);
      expect(sent.stderr[0]).toContain("Workspace 'codev' is ambiguous: 2 workspaces have that directory name");
      expect(sent.stderr[0]).toContain(codev);
      expect(sent.stderr[0]).toContain(otherCodev);
      expect(sent.stderr[0]).toContain('afx workspace name <name>');
      expect(mailCount()).toBe(before);
    });

    it('a message FROM such a workspace says its sender has no reply address, and what fixes it', async () => {
      await afxSend(review(), 'codev-cloud:architect:tunnel', 'From a workspace with no name');

      expect(frameLines(mailWithBody('From a workspace with no name'))).toEqual([
        '### [ARCHITECT architect:review (another workspace) MESSAGE → tunnel | <time>] ###',
        'From a workspace with no name',
        "###############################  (no reply address; the sender's workspace needs: afx workspace name <name>)",
      ]);
    });

    it('after afx workspace name gives one of them a name, both resolve', async () => {
      const named = await runAs(review(), () => workspaceName({ name: 'one' }));
      expect(named.exitCode).toBeNull();
      expect(named.stdout).toEqual([
        "[ok] This workspace is now addressed as 'one'.",
        '[info] Another workspace reaches its front door with: afx send one:architect "…"',
      ]);

      const toNamed = await afxSend(tunnel(), 'one:architect:review', 'For review in the workspace now called one');
      expect(toNamed.exitCode).toBeNull();
      expect(mailWithBody('For review in the workspace now called one')).toMatchObject({
        workspace_path: codev,
        to_agent: 'review',
      });

      // The directory name now belongs to the other workspace alone.
      const toOther = await afxSend(tunnel(), 'codev:architect', 'For the other codev');
      expect(toOther.exitCode).toBeNull();
      expect(mailWithBody('For the other codev')).toMatchObject({ workspace_path: otherCodev, to_agent: 'main' });

      // And mail from the named workspace says where to answer, under its new name.
      await afxSend(review(), 'codev-cloud:architect:tunnel', 'From the workspace now called one');
      expect(replyAddress(mailWithBody('From the workspace now called one'))).toBe('one:architect:review');
    });
  });
});
