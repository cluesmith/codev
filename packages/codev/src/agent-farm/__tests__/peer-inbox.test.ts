/**
 * Spec 1967, phase 11: `afx inbox` and its routes, for the three kinds of held mail.
 *
 * The CLI commands run against Tower's real `handleRequest`, served on a loopback port by a
 * throwaway server, with the real database statements on an in-memory database seeded with the
 * real schema. The outbox behind it is `peer/cloud-wiring.ts`'s, as production builds it; it is
 * never started, and the cloud config's server URL is plain HTTP on a host that is not this
 * machine, so no call to a cloud is ever made. The drainer is a spy: a released message is
 * delivered through the gate by the drain it schedules, which the mailbox delivery tests and
 * layer B cover. Nothing touches the live Tower or the user's files.
 *
 * What is proven: each kind of held mail is listed in its own group and only there, with why
 * the queues are paused; a remote message names its sender's full address and its owner; a
 * human releases mail held for release (the flag, never through the tunnel) and a drain is
 * scheduled for its agent; a message waiting for a peer is shown with its body and dismissed,
 * so it is never sent, and one whose call is in flight is not; a dismissed remote message
 * answers a later duplicate `refused`, `dismissed`; and a released message's escalation clock
 * starts at its release.
 *
 * Phase 12 adds: a stored sender or owner that does not fit the statement's rules is neither
 * stored nor printed by the list or show; the workspace-scoped outbox route behind the
 * dashboard's popover lists only its own workspace's mail and reaches no other peer route; and
 * a view of many outbox rows reads the queue heads and the messages once.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import * as store from '../peer/store.js';
import { setSwitch } from '../peer/switch.js';
import { encodeMessagePayload } from '../peer/contract.js';
import { handleRequest, type RouteContext } from '../servers/tower-routes.js';
import { peerOutbox } from '../peer/cloud-wiring.js';
import { queueHeads } from '../peer/surfaces.js';
import { TUNNEL_PROXY_HEADER } from '../lib/tunnel-client.js';

const holder = vi.hoisted(() => ({ db: null as unknown as Database.Database, port: 0, workspace: '/work/codev' }));
const drains = vi.hoisted(() => ({ scheduled: [] as Array<[string, string]> }));
const out = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../db/index.js', () => ({ getGlobalDb: () => holder.db, getDb: () => holder.db, closeDb: vi.fn() }));
vi.mock('../lib/cloud-config.js', () => ({
  readCloudConfig: () => ({ tower_id: '01JSELF0000000000000000AAA', tower_name: 'ana-s-mbp', api_key: 'ctk_x', server_url: 'http://cloud.example' }),
}));
vi.mock('../servers/mailbox-wiring.js', async (importActual) => ({
  ...(await importActual<typeof import('../servers/mailbox-wiring.js')>()),
  getMailboxDrainer: () => ({
    scheduleDrain: async (workspacePath: string, toAgent: string) => {
      drains.scheduled.push([workspacePath, toAgent]);
    },
  }),
}));

// The CLI side: its Tower client is the SDK's, pointed at the throwaway server; what it
// prints is collected in order, and `fatal` throws instead of exiting.
vi.mock('../lib/tower-client.js', async () => {
  const { TowerClient } = await import('@cluesmith/codev-sdk/tower-client');
  return {
    DEFAULT_TOWER_PORT: 4100,
    getTowerClient: () => new TowerClient({ host: '127.0.0.1', port: holder.port }),
    encodeWorkspacePath: (p: string) => Buffer.from(p).toString('base64url'),
    decodeWorkspacePath: (p: string) => Buffer.from(p, 'base64url').toString(),
  };
});
vi.mock('../utils/logger.js', () => {
  const push = (kind: string) => (...args: unknown[]) => {
    out.lines.push(`${kind} ${args.map((a) => (Array.isArray(a) ? a.join(' | ') : String(a))).join(' :: ')}`);
  };
  return {
    logger: { info: push('info'), success: push('ok'), warn: push('warn'), error: push('error'), header: push('header'), kv: push('kv'), blank: vi.fn(), row: push('row'), debug: vi.fn() },
    fatal: (message: string) => {
      throw new Error(`FATAL: ${message}`);
    },
  };
});
vi.mock('../utils/config.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/config.js')>()),
  getConfig: () => ({ workspaceRoot: holder.workspace }),
}));

// Stub the rest of the tower-routes import graph (standard route-test preamble).
vi.mock('../servers/tower-cron.js', () => ({
  getAllTasks: vi.fn(() => []),
  executeTask: vi.fn(async () => ({ result: 'success', output: 'ok' })),
  getTaskId: vi.fn((ws: string, name: string) => `${ws}:${name}`),
  loadWorkspaceTasks: vi.fn(() => []),
}));
vi.mock('../servers/tower-instances.js', () => ({
  getInstances: vi.fn(async () => []),
  getKnownWorkspacePaths: vi.fn(() => []),
  getDirectorySuggestions: vi.fn(async () => []),
  launchInstance: vi.fn(async () => ({ success: true })),
  killTerminalWithShellper: vi.fn(async () => true),
  stopInstance: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: vi.fn(() => new Map()),
  getTerminalManager: vi.fn(() => ({ getSession: vi.fn(), listSessions: vi.fn(() => []) })),
  getWorkspaceTerminalsEntry: vi.fn(),
  getNextShellId: vi.fn(),
  saveTerminalSession: vi.fn(),
  isSessionPersistent: vi.fn(),
  deleteTerminalSession: vi.fn(),
  removeTerminalFromRegistry: vi.fn(),
  deleteWorkspaceTerminalSessions: vi.fn(),
  saveFileTab: vi.fn(),
  removeFileTab: vi.fn(),
  getTerminalsForWorkspace: vi.fn(() => []),
  isStartupReconcileSettled: () => true,
  whenStartupReconcileSettled: () => Promise.resolve(),
}));
vi.mock('../servers/tower-messages.js', () => ({
  resolveTarget: vi.fn(),
  broadcastMessage: vi.fn(),
  runningWorkspacePaths: vi.fn(() => []),
  isResolveError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'code' in r),
}));
vi.mock('../utils/server-utils.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/server-utils.js')>()),
  isRequestAllowed: vi.fn(() => true),
}));
vi.mock('../servers/tower-tunnel.js', () => ({
  initTunnel: vi.fn(),
  shutdownTunnel: vi.fn(),
  handleTunnelEndpoint: vi.fn(),
}));
vi.mock('../servers/tower-websocket.js', () => ({ setupUpgradeHandler: vi.fn() }));
vi.mock('../servers/overview.js', () => ({
  OverviewCache: class {
    getOverview = vi.fn(async () => ({ builders: [], pendingPRs: [], backlog: [] }));
    invalidate = vi.fn();
  },
}));
vi.mock('../../terminal/session-manager.js', () => ({ SessionManager: class {} }));
vi.mock('../../terminal/index.js', () => ({ DEFAULT_COLS: 120, defaultSessionOptions: {} }));

import { inboxDismiss, inboxList, inboxRelease, inboxShow } from '../commands/inbox.js';

const WS = '/work/codev';
const OTHER = '/work/other';
const DEVVM = '01JDEVVM0000000000000000AA';
const BODY = 'the body of a message for devvm';

let server: http.Server;
let ctx: RouteContext;
let broadcasts: Array<{ body: string }>;

function makeCtx(): RouteContext {
  broadcasts = [];
  return {
    log: vi.fn(),
    port: 4100,
    version: '9.9.9',
    startedAt: '2026-01-01T00:00:00.000Z',
    templatePath: null,
    reactDashboardPath: '/tmp/dash',
    hasReactDashboard: false,
    getShellperManager: () => null,
    broadcastNotification: (n: { body: string }) => broadcasts.push(n),
    addSseClient: vi.fn(),
    removeSseClient: vi.fn(),
  } as unknown as RouteContext;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${holder.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Mail for a local agent, held at the gate. */
function heldLocally(toAgent = 'spir-1', workspacePath = WS): string {
  return mailbox.enqueue(holder.db, { workspacePath, toAgent, body: 'local body', formattedMessage: 'local body', fromAgent: 'architect', reason: 'busy' }).id;
}

/** Mail from devvm, as the receiver stores it: held for release, or held at the gate. */
function fromDevvm(options: { releaseHold: boolean; workspacePath?: string; messageId?: string }): string {
  const result = mailbox.enqueueRemote(holder.db, {
    workspacePath: options.workspacePath ?? WS,
    toAgent: 'architect:local',
    body: 'remote body',
    formattedMessage: '[remote] remote body',
    reason: options.releaseHold ? null : 'busy',
    releaseHold: options.releaseHold,
    remote: {
      sender: { towerId: DEVVM, towerSlug: 'devvm', address: { workspace: 'codev', kind: 'architect', name: 'main' } },
      messageId: options.messageId ?? randomUUID(),
      ownerEmail: 'ana@example.com',
      payloadSha256: 'e'.repeat(64),
      sentAt: Date.now(),
    },
  });
  if (!result.accepted) throw new Error('expected a new remote row');
  return result.row.id;
}

/** A message this workspace sent to devvm, waiting here: real payload bytes, with a body. */
function forDevvm(fromWorkspacePath = WS): store.PeerOutboxRow {
  const sentAt = Date.now();
  const encoded = encodeMessagePayload({ sentAt, to: { workspace: 'codev', kind: 'architect', name: 'local' }, from: { workspace: 'codev', kind: 'architect', name: 'main' }, body: BODY });
  if (!encoded.ok) throw new Error('the test payload did not encode');
  return store.insertOutbox(
    holder.db,
    {
      messageId: randomUUID(),
      peerTowerId: DEVVM,
      toAddress: 'afx://devvm/codev:architect:local',
      fromAddress: 'codev:architect:main',
      payload: encoded.bytes,
      sentAt,
      fromWorkspacePath,
      fromAgent: 'architect:main',
    },
    sentAt,
  );
}

/** What the CLI printed, from each header to the next: the group it was listed in. */
function groups(): Map<string, string[]> {
  const byHeader = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of out.lines) {
    if (line.startsWith('header ')) {
      current = [];
      byHeader.set(line.slice('header '.length), current);
    } else if (current !== null) {
      current.push(line);
    }
  }
  return byHeader;
}

beforeEach(async () => {
  holder.db = new Database(':memory:');
  holder.db.exec(GLOBAL_SCHEMA);
  holder.workspace = WS;
  // This Tower has listed its peers, so devvm has a name here.
  store.writeListing(
    holder.db,
    {
      relay: { protocols: [1] },
      limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 },
      towers: [{ towerId: DEVVM, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' }],
      fetchedFor: 'http://cloud.example 01JSELF0000000000000000AAA',
    },
    Date.now(),
  );
  drains.scheduled = [];
  out.lines = [];
  ctx = makeCtx();
  server = http.createServer((req, res) => void handleRequest(req, res, ctx));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  holder.port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  holder.db.close();
});

describe('afx inbox: three groups', () => {
  it('lists each kind of held mail in its own group, and only there, with why the queues are paused', async () => {
    const local = heldLocally();
    const remoteAtGate = fromDevvm({ releaseHold: false });
    const forRelease = fromDevvm({ releaseHold: true });
    const waiting = forDevvm();
    // Another workspace's mail of each kind is not this workspace's.
    heldLocally('spir-9', OTHER);
    fromDevvm({ releaseHold: true, workspacePath: OTHER });
    const elsewhere = forDevvm(OTHER);

    await inboxList();

    const listed = groups();
    expect([...listed.keys()]).toEqual(['Waiting for a local agent (2)', 'Held for release (1)', 'Waiting for a peer (1)']);
    const text = (title: string) => (listed.get(title) ?? []).join('\n');
    const where = (id: string) => [...listed.keys()].filter((title) => text(title).includes(id));
    expect(where(local)).toEqual(['Waiting for a local agent (2)']);
    expect(where(remoteAtGate)).toEqual(['Waiting for a local agent (2)']);
    expect(where(forRelease)).toEqual(['Held for release (1)']);
    expect(where(waiting.messageId)).toEqual(['Waiting for a peer (1)']);
    expect(out.lines.join('\n')).not.toContain(elsewhere.messageId);
    // A remote message names its sender as its header does, and the sending Tower's owner.
    expect(text('Held for release (1)')).toContain('afx://devvm/codev:architect:main (ana@example.com) → architect:local');
    expect(text('Held for release (1)')).toContain(
      "info Release one (a human's decision): afx inbox release <id> --a-human-explicitly-approved-this   ·   Dismiss: afx inbox dismiss <id>",
    );
    // The switch is off, so the outbox says nothing leaves, and how a human changes that.
    expect(text('Waiting for a peer (1)')).toContain('architect:main → afx://devvm/codev:architect:local');
    expect(text('Waiting for a peer (1)')).toContain('info Not sent now: remote messaging is off on this Tower. A human turns it on with: afx peer on');
    // The list never carries a body.
    expect(out.lines.join('\n')).not.toContain(BODY);
    expect(out.lines.join('\n')).not.toContain('remote body');
  });

  it('shows no next try while the queues are paused, and says why', async () => {
    setSwitch(holder.db, 'on', Date.now());
    const waiting = forDevvm();
    store.recordOutboxAttempt(holder.db, waiting.messageId, { outcome: 'unavailable', reason: 'tower-offline', nextAttemptAt: Date.now() + 90_000 }, Date.now());
    await inboxList();
    const shown = groups().get('Waiting for a peer (1)')!.join('\n');
    expect(shown).toContain(`row ${waiting.messageId} | 0s | tower-offline | architect:main → afx://devvm/codev:architect:local | —`);
    // Plain HTTP to a host that is not this machine: the cloud has no relay this Tower uses.
    expect(shown).toContain('info Not sent now: this Codev Cloud has no relay, so nothing can reach another Tower through it.');
  });

  it('shows the next try for the head of a queue that runs, and that a call is being made, with no pause line', async () => {
    const head = forDevvm();
    const behind = forDevvm();
    store.recordOutboxAttempt(holder.db, head.messageId, { outcome: 'unavailable', reason: 'tower-offline', nextAttemptAt: Date.now() + 90_000 }, Date.now());
    vi.spyOn(peerOutbox(), 'pausedBecause').mockReturnValue(null);
    await inboxList();
    let shown = groups().get('Waiting for a peer (2)')!;
    expect(shown.find((line) => line.includes(head.messageId))).toMatch(/\| tower-offline \| .* \| in 1m ::/);
    expect(shown.find((line) => line.includes(behind.messageId))).toMatch(/\| queued \| .* \| — ::/);
    expect(shown.some((line) => line.startsWith('info Not sent now'))).toBe(false);
    vi.spyOn(peerOutbox(), 'inFlightFor').mockReturnValue(head.messageId);
    out.lines = [];
    await inboxList();
    shown = groups().get('Waiting for a peer (2)')!;
    expect(shown.find((line) => line.includes(head.messageId))).toMatch(/\| sending now ::/);
  });

  it('says there is no held mail when no group has any', async () => {
    heldLocally('spir-9', OTHER);
    await inboxList();
    expect(out.lines.filter((line) => !line.startsWith('row'))).toEqual(['info No held messages.']);
  });

  it('GET /api/inbox names the sender of remote mail with its owner, and none for local mail', async () => {
    heldLocally();
    fromDevvm({ releaseHold: true });
    const answer = await call('GET', `/api/inbox?workspace=${encodeURIComponent(WS)}`);
    const rows = answer.body as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.reason, r.remoteSender, r.remoteOwnerEmail]).sort()).toEqual([
      ['busy', null, null],
      ['held-for-release', 'afx://devvm/codev:architect:main', 'ana@example.com'],
    ]);
  });
});

// Phase 12 (claude, phase 11 note 1): a stored sender or owner is checked against the rules the
// statement was verified by when it is read back, as the frame's formatter checks it, so neither
// `afx inbox` nor `afx inbox show` prints one nothing checked. Reachable only by something that
// can already write global.db: defence in depth.
describe('remote mail whose stored sender or owner does not fit the statement rules', () => {
  const ESC = '\u001b';
  const RLO = '\u202e';

  async function readBoth(id: string): Promise<Array<{ status: number; text: string }>> {
    const answers = [];
    for (const path of [`/api/inbox?workspace=${encodeURIComponent(WS)}`, `/api/inbox/${id}`]) {
      const response = await fetch(`http://127.0.0.1:${holder.port}${path}`);
      answers.push({ status: response.status, text: await response.text() });
    }
    return answers;
  }

  it('is refused by the list and by show when its Tower name has escape characters, and the name is not printed', async () => {
    const id = fromDevvm({ releaseHold: true });
    const hostile = { towerId: DEVVM, towerSlug: `devvm${ESC}[31mEVIL`, address: null };
    holder.db.prepare('UPDATE mailbox SET remote_sender = ? WHERE id = ?').run(JSON.stringify(hostile), id);
    for (const answer of await readBoth(id)) {
      expect(answer.status).toBe(500);
      expect(answer.text).toContain('slug rule');
      expect(answer.text).not.toContain(ESC);
      expect(answer.text).not.toContain('EVIL');
    }
  });

  it('is refused by the list and by show when its owner has a direction override, and the owner is not printed', async () => {
    const id = fromDevvm({ releaseHold: true });
    holder.db.prepare('UPDATE mailbox SET remote_owner_email = ? WHERE id = ?').run(`ana${RLO}moc.elpmaxe@x`, id);
    for (const answer of await readBoth(id)) {
      expect(answer.status).toBe(500);
      expect(answer.text).toContain('email rule');
      expect(answer.text).not.toContain(RLO);
      expect(answer.text).not.toContain('moc.elpmaxe');
    }
  });

  it('is never stored: the receiver cannot write a sender or owner that does not fit', () => {
    const remote = (over: Record<string, unknown>) => ({
      workspacePath: WS,
      toAgent: 'architect:local',
      body: 'b',
      formattedMessage: 'b',
      reason: null,
      releaseHold: true,
      remote: {
        sender: { towerId: DEVVM, towerSlug: 'devvm', address: null },
        messageId: randomUUID(),
        ownerEmail: 'ana@example.com',
        payloadSha256: 'e'.repeat(64),
        sentAt: Date.now(),
        ...over,
      },
    });
    expect(() => mailbox.enqueueRemote(holder.db, remote({ sender: { towerId: DEVVM, towerSlug: 'Dev VM', address: null } }) as never)).toThrow(/slug rule/);
    expect(() => mailbox.enqueueRemote(holder.db, remote({ ownerEmail: `ana${ESC}@example.com` }) as never)).toThrow(/email rule/);
    expect(holder.db.prepare('SELECT COUNT(*) AS n FROM mailbox').get()).toEqual({ n: 0 });
  });
});

// Phase 12: the dashboard's held-mail popover lists mail waiting for a peer through the
// workspace-scoped route, which takes its workspace from the URL prefix alone.
describe('GET /workspace/<base64>/api/peer/outbox', () => {
  const scoped = (workspace: string) => `/workspace/${Buffer.from(workspace).toString('base64url')}/api/peer/outbox`;

  it("lists only that workspace's mail for a peer, whatever workspace the query names, and no body", async () => {
    const mine = forDevvm(WS);
    forDevvm(OTHER);
    const answer = await call('GET', `${scoped(WS)}?workspace=${encodeURIComponent(OTHER)}`);
    expect(answer.status).toBe(200);
    const messages = answer.body.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => [m.id, m.workspacePath, m.to])).toEqual([[mine.messageId, WS, 'afx://devvm/codev:architect:local']]);
    expect(JSON.stringify(answer.body)).not.toContain(BODY);
  });

  it('names the head of each queue in a view of many rows: its next try shows, and the rest show none', async () => {
    const first = forDevvm(WS);
    forDevvm(WS);
    store.recordOutboxAttempt(holder.db, first.messageId, { outcome: 'unavailable', reason: 'tower-offline', nextAttemptAt: Date.now() + 5_000 }, Date.now());
    const answer = await call('GET', scoped(WS));
    const messages = answer.body.messages as Array<{ id: string; nextAttemptAt: number | null }>;
    expect(messages.map((m) => [m.id === first.messageId, m.nextAttemptAt !== null])).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  it('reaches no other peer route under the workspace prefix', async () => {
    for (const [method, route] of [['GET', 'towers'], ['GET', 'panel'], ['PUT', 'switch'], ['GET', 'log']] as const) {
      const response = await fetch(`http://127.0.0.1:${holder.port}${scoped(WS).replace(/outbox$/, route)}`, { method });
      expect([method, route, response.status]).toEqual([method, route, 404]);
    }
  });
});

// Phase 12 (claude, phase 11 note 3): a view of many outbox rows reads the queue heads and the
// messages it needs once, rather than once per row.
describe('reading many outbox rows at once', () => {
  const LAB = '01JLAB00000000000000000000';

  /** A message waiting here for another peer than devvm. */
  function forLab(): store.PeerOutboxRow {
    const sentAt = Date.now();
    const encoded = encodeMessagePayload({ sentAt, to: { workspace: 'codev', kind: 'architect', name: 'local' }, from: { workspace: 'codev', kind: 'architect', name: 'main' }, body: BODY });
    if (!encoded.ok) throw new Error('the test payload did not encode');
    return store.insertOutbox(
      holder.db,
      { messageId: randomUUID(), peerTowerId: LAB, toAddress: 'afx://lab/codev:architect:local', fromAddress: 'codev:architect:main', payload: encoded.bytes, sentAt, fromWorkspacePath: WS, fromAgent: 'architect:main' },
      sentAt,
    );
  }

  it("queueHeads names each peer's first held message, and passes over one that has ended", () => {
    const ended = forDevvm();
    const devvmHead = forDevvm();
    forDevvm();
    const labHead = forLab();
    forLab();
    store.resolveOutbox(holder.db, ended.messageId, { state: 'dismissed', outcome: null, reason: null, attempted: false }, Date.now());
    expect([...queueHeads(holder.db)].sort()).toEqual([devvmHead.messageId, labHead.messageId].sort());
  });

  it('getOutboxMany finds every message asked for in one read, and leaves out an id with none', () => {
    const a = forDevvm();
    const b = forLab();
    const found = store.getOutboxMany(holder.db, [a.messageId, 'no-such-message', b.messageId]);
    expect([...found.keys()].sort()).toEqual([a.messageId, b.messageId].sort());
    expect(found.get(b.messageId)?.peerTowerId).toBe(LAB);
    expect(store.getOutboxMany(holder.db, []).size).toBe(0);
  });
});

describe('afx inbox show', () => {
  it("shows remote mail's sender in full, its owner, and how a human releases it", async () => {
    const id = fromDevvm({ releaseHold: true });
    await inboxShow(id);
    expect(out.lines).toContain('kv From → To :: afx://devvm/codev:architect:main → architect:local');
    expect(out.lines).toContain('kv Owner :: ana@example.com');
    expect(out.lines).toContain("kv Release :: a human's decision: afx inbox release " + id + ' --a-human-explicitly-approved-this');
    expect(out.lines).toContain('kv Reason :: held-for-release');
  });

  it('shows a message waiting for a peer, with its body, its next try and why it waits', async () => {
    const waiting = forDevvm();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await inboxShow(waiting.messageId);
    expect(out.lines).toContain(`header Message ${waiting.messageId}`);
    expect(out.lines).toContain('kv Status :: waiting for devvm (queued)');
    expect(out.lines).toContain('kv From → To :: architect:main → afx://devvm/codev:architect:local');
    expect(out.lines).toContain('kv Paused :: Not sent now: remote messaging is off on this Tower. A human turns it on with: afx peer on');
    expect(log).toHaveBeenCalledWith(BODY);
  });

  it('still shows a message for a peer once it has ended, with what it came to', async () => {
    const waiting = forDevvm();
    store.resolveOutbox(holder.db, waiting.messageId, { state: 'refused', outcome: 'refused', reason: 'no-grant', attempted: true }, Date.now());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await inboxShow(waiting.messageId);
    expect(out.lines).toContain('kv Status :: refused (no-grant)');
    expect(out.lines.some((line) => line.startsWith('kv Paused'))).toBe(false);
  });
});

describe('afx inbox release', () => {
  it('is refused without the human flag, before asking Tower, and nothing changes', async () => {
    const id = fromDevvm({ releaseHold: true });
    await expect(inboxRelease(id)).rejects.toThrow(
      `FATAL: Releasing a message is a human's decision. A human runs: afx inbox release ${id} --a-human-explicitly-approved-this`,
    );
    expect(mailbox.getById(holder.db, id)).toMatchObject({ release_hold: 1, released_at: null });
  });

  it('releases with the flag: the message becomes mail for its agent, and a drain through the gate is scheduled', async () => {
    const id = fromDevvm({ releaseHold: true });
    await inboxRelease(id, { humanApproved: true });
    expect(out.lines).toContain(`ok Released message ${id}: it is delivered to architect:local through the gate, once that agent's prompt is clear.`);
    const row = mailbox.getById(holder.db, id)!;
    expect(row).toMatchObject({ status: 'held', release_hold: 0 });
    expect(row.released_at).not.toBeNull();
    expect(drains.scheduled).toEqual([[WS, 'architect:local']]);
    expect(broadcasts.map((b) => b.body)).toEqual(['released']);
    // It is listed with mail for a local agent now, and no longer held for release.
    out.lines = [];
    await inboxList();
    expect([...groups().keys()]).toEqual(['Waiting for a local agent (1)']);
    // A second release finds nothing held for release.
    await expect(inboxRelease(id, { humanApproved: true })).rejects.toThrow(`FATAL: No message held for release with id '${id}'`);
  });

  it('is refused by Tower without the approval, through the tunnel, for any other method, and for local mail', async () => {
    const id = fromDevvm({ releaseHold: true });
    for (const body of [{}, { humanApproved: false }, { humanApproved: 'yes' }]) {
      expect(await call('POST', `/api/inbox/${id}/release`, body)).toMatchObject({ status: 403, body: { error: 'HUMAN_APPROVAL_REQUIRED' } });
    }
    expect(await call('POST', `/api/inbox/${id}/release`, { humanApproved: true }, { [TUNNEL_PROXY_HEADER]: '1' })).toMatchObject({
      status: 403,
      body: { error: 'NOT_OVER_TUNNEL' },
    });
    expect((await call('GET', `/api/inbox/${id}/release`)).status).toBe(405);
    expect(await call('POST', `/api/inbox/${heldLocally()}/release`, { humanApproved: true })).toMatchObject({ status: 404, body: { error: 'NOT_FOUND' } });
    expect(mailbox.getById(holder.db, id)).toMatchObject({ release_hold: 1, released_at: null });
    expect(drains.scheduled).toEqual([]);
  });
});

describe('afx inbox dismiss', () => {
  it('dismisses a message waiting for a peer: it is never sent', async () => {
    const waiting = forDevvm();
    await inboxDismiss(waiting.messageId);
    expect(out.lines).toContain(`ok Dismissed message ${waiting.messageId} waiting for devvm: it will not be sent.`);
    expect(store.getOutbox(holder.db, waiting.messageId)).toMatchObject({ state: 'dismissed', attempts: 0 });
    expect(store.listHeldOutbox(holder.db, DEVVM)).toEqual([]);
    expect(broadcasts.map((b) => b.body)).toEqual(['dismissed']);
    await expect(inboxDismiss(waiting.messageId)).rejects.toThrow(`FATAL: No held message with id '${waiting.messageId}'`);
  });

  it('refuses a message whose relay call is in flight: its answer decides it', async () => {
    const waiting = forDevvm();
    vi.spyOn(peerOutbox(), 'inFlightFor').mockImplementation((peer) => (peer === DEVVM ? waiting.messageId : null));
    await expect(inboxDismiss(waiting.messageId)).rejects.toThrow(
      `FATAL: Message '${waiting.messageId}' is being sent to devvm now, and the answer decides it. Look again with: afx inbox`,
    );
    expect(store.getOutbox(holder.db, waiting.messageId)!.state).toBe('held');
  });

  it('dismisses mail held for release; a later duplicate of it from the peer is answered refused, dismissed', async () => {
    const messageId = randomUUID();
    const id = fromDevvm({ releaseHold: true, messageId });
    await inboxDismiss(id);
    expect(out.lines).toContain(`ok Dismissed held message ${id}`);
    expect(mailbox.getById(holder.db, id)!.status).toBe('dismissed');
    expect(store.duplicateAnswer(store.getAccepted(holder.db, DEVVM, messageId)!)).toEqual({ outcome: 'refused', reason: 'dismissed', duplicate: true });
  });
});

describe("a released message's escalation clock", () => {
  it('starts at its release, not at its arrival', () => {
    const age = 10 * 60_000;
    const arrived = Date.UTC(2026, 10, 27, 10, 0, 0);
    const result = mailbox.enqueueRemote(
      holder.db,
      {
        workspacePath: WS,
        toAgent: 'architect:local',
        body: 'b',
        formattedMessage: 'b',
        reason: null,
        releaseHold: true,
        remote: { sender: { towerId: DEVVM, towerSlug: 'devvm', address: null }, messageId: randomUUID(), ownerEmail: null, payloadSha256: 'f'.repeat(64), sentAt: arrived },
      },
      arrived,
    );
    if (!result.accepted) throw new Error('expected a new remote row');
    const releasedAt = arrived + 2 * 60 * 60_000;
    // Held for release, it never escalates.
    expect(mailbox.findEscalatable(holder.db, age, releasedAt)).toEqual([]);
    mailbox.release(holder.db, result.row.id, releasedAt);
    expect(mailbox.findEscalatable(holder.db, age, releasedAt + age - 1)).toEqual([]);
    expect(mailbox.findEscalatable(holder.db, age, releasedAt + age + 1).map((r) => r.id)).toEqual([result.row.id]);
  });
});
