/**
 * Spec 1967, plan phase 9, layer A: what `afx send` prints for a recipient on another Tower,
 * and how it ends.
 *
 * The command runs for real, through the real SDK client, against a transport that answers
 * as this phase's Tower answers `/api/send` (the route's own answers are asserted in
 * `tower-routes.test.ts`). What is proven:
 *
 * - each outcome of the stage 2 walkthrough, as it prints it: delivered (step 7), held on
 *   this Tower with where and why (the last row of the skipped-step table), held on the
 *   receiving Tower, and every refusal in its own words, exiting non-zero (criterion 5);
 * - what the receiving Tower said (`detail`, contract section 6), after the words this Tower
 *   wrote, for every outcome;
 * - the size of a body for another Tower is left to Tower, which checks it in the contract's
 *   order of refusals (a local recipient is still refused here, before any call);
 * - the stage 1 carry-over hint: `devvm:codev:architect` is malformed, and when `devvm` is
 *   one of my Towers the failure says to write `afx://devvm/codev:architect`. The peer list
 *   is asked only on that failure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { TowerClient as SdkTowerClient } from '@cluesmith/codev-sdk/tower-client';

const transport = vi.hoisted(() => ({ fetchFn: undefined as unknown as typeof fetch }));

vi.mock('../lib/tower-client.js', () => ({
  TowerClient: class extends SdkTowerClient {
    constructor() {
      super({ fetchFn: (...args: Parameters<typeof fetch>) => transport.fetchFn(...args) });
    }
  },
}));

const { send, remoteHeldLine } = await import('../commands/send.js');

const TO = 'afx://devvm/codev:architect:local';
const MESSAGE_ID = '7c1e52aa-4d3b-4e0f-9a51-0b2c8d6e1f30';

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A Tower of this version, as a transport: its liveness route (#1977) answers, and the routes
 * answer as given.
 */
function towerAnswering(routes: { send: (to: string, message: string) => Response; peerTowers?: () => Response }): string[] {
  const paths: string[] = [];
  transport.fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    paths.push(pathname);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { to?: string; message?: string }) : undefined;
    if (pathname === '/health/live') {
      return json(200, { status: 'healthy', version: '3.4.0', startedAt: '2026-11-27T00:00:00.000Z', schemaVersion: 21 });
    }
    if (pathname === '/api/send') return routes.send(body?.to ?? '', body?.message ?? '');
    if (pathname === '/api/peer/towers' && routes.peerTowers) return routes.peerTowers();
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }) as typeof fetch;
  return paths;
}

function refused(refusedBy: string, reason: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json(403, { error: 'REMOTE_REFUSED', message, refusedBy, reason, retryAfterSec: null, mailboxId: null, peer: 'devvm', ...extra });
}

/** `GET /api/peer/towers` with these Towers listed, and this Tower named `mbp`. */
function peerList(names: string[]): Response {
  return json(200, {
    remoteMessaging: 'on',
    towerName: 'mbp',
    tunnel: 'up',
    relay: { state: 'available', why: null },
    listing: { fresh: true, refreshedAt: 1, problem: null, retryAfterSec: null },
    towers: names.map((name, i) => ({ towerId: `t-${i}`, name, online: true, protocols: [1], remoteMessaging: 'on', mayMessage: [] })),
  });
}

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

describe('Spec 1967: afx send to an agent on another Tower', () => {
  let workspace: string;
  let printed: string[];
  let errors: string[];
  const cwd = process.cwd();
  const architectName = process.env.CODEV_ARCHITECT_NAME;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'spec-1967-send-cli-')));
    mkdirSync(join(workspace, '.git'));
    process.chdir(workspace);
    process.env.CODEV_ARCHITECT_NAME = 'main';
    printed = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void printed.push(stripVTControlCharacters(args.join(' '))));
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(stripVTControlCharacters(args.join(' '))));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exit(code ?? 0);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    if (architectName === undefined) delete process.env.CODEV_ARCHITECT_NAME;
    else process.env.CODEV_ARCHITECT_NAME = architectName;
    rmSync(workspace, { recursive: true, force: true });
  });

  /** What the command printed on its last line, beyond the header. */
  const lastLine = () => printed.at(-1);

  it('prints a delivery as walkthrough step 7 does', async () => {
    towerAnswering({
      send: () =>
        json(200, {
          ok: true,
          resolvedTo: TO,
          mailboxId: MESSAGE_ID,
          bodyLength: 32,
          delivered: true,
          held: false,
          detail: null,
          remote: { peer: 'devvm', duplicate: false },
        }),
    });

    await expect(send({ builder: TO, message: 'CI is green on the tunnel branch' })).resolves.toBe('delivered');

    expect(lastLine()).toBe(`[ok] Message delivered to ${TO} (32 bytes)`);
    expect(errors).toEqual([]);
  });

  it('prints a message held on this Tower for a peer that is asleep, as the skipped-step table does', async () => {
    towerAnswering({
      send: () =>
        json(200, {
          ok: true,
          resolvedTo: TO,
          mailboxId: MESSAGE_ID,
          bodyLength: 32,
          delivered: false,
          held: true,
          reason: 'tower-offline',
          detail: null,
          remote: { peer: 'devvm', heldWhere: 'this-tower', ahead: 0 },
        }),
    });

    await expect(send({ builder: TO, message: 'CI is green on the tunnel branch' })).resolves.toBe('held');

    expect(lastLine()).toBe(`[info] Message held on this Tower (tower-offline) — mailbox id ${MESSAGE_ID}. It is sent when devvm returns.`);
  });

  it('says where a held message waits and what happens next, for each place and reason', () => {
    expect(remoteHeldLine(TO, { peer: 'devvm', heldWhere: 'this-tower', ahead: 2 }, 'cloud-unreachable', 'm-1')).toBe(
      'Message held on this Tower (cloud-unreachable) — mailbox id m-1. 2 held messages for devvm go before it. ' +
        'It is sent to devvm when it can be, within 30 days.',
    );
    expect(remoteHeldLine(TO, { peer: 'devvm', heldWhere: 'this-tower', ahead: 1 }, 'tower-offline', 'm-1')).toBe(
      'Message held on this Tower (tower-offline) — mailbox id m-1. 1 held message for devvm goes before it. ' +
        'It is sent when devvm returns.',
    );
    expect(remoteHeldLine(TO, { peer: 'devvm', heldWhere: 'recipient' }, 'busy', 'm-1')).toBe(
      `Message held on devvm for ${TO} (busy) — mailbox id m-1. devvm delivers it when the recipient's prompt is clear.`,
    );
    expect(remoteHeldLine(TO, { peer: 'devvm', heldWhere: 'recipient' }, 'held-for-release', 'm-1')).toBe(
      `Message held on devvm for ${TO} (held-for-release) — mailbox id m-1. It waits there until a human on devvm releases it.`,
    );
  });

  it.each([
    ['this-tower', 'remote-off', 'Remote messaging is off on this Tower (mbp). A human turns it on with: afx peer on'],
    ['peer', 'remote-off', 'Refused by devvm: remote messaging is off there.'],
    ['peer', 'no-grant', 'Refused by devvm: mbp has no grant there for codev:architect:local. On devvm: afx peer grant mbp codev:architect:local'],
    ['cloud', 'peer-unsupported', 'Refused by Codev Cloud: devvm does not speak remote messaging. Upgrade Codev on devvm.'],
  ])('prints a refusal by %s (%s) in its own words, and exits non-zero', async (refusedBy, reason, message) => {
    towerAnswering({ send: () => refused(refusedBy, reason, message) });

    await expect(send({ builder: TO, message: 'hi' })).rejects.toMatchObject({ code: 1 });

    expect(errors).toEqual([`[error] ${message}`]);
  });

  it('prints a message stored and held but not sent now in words that say not to send it again, exiting non-zero', async () => {
    const words =
      `Message stored and held on this Tower — mailbox id ${MESSAGE_ID} — but not sent to devvm now: this Tower is stopping. ` +
      'It is sent when that clears. Do not send it again. See or dismiss it with: afx inbox';
    const paths = towerAnswering({
      send: () => json(503, { error: 'REMOTE_HELD_ON_FAULT', message: words, mailboxId: MESSAGE_ID, peer: 'devvm' }),
    });

    await expect(send({ builder: TO, message: 'hi', retry: 3 })).rejects.toMatchObject({ code: 1 });

    expect(errors).toEqual([`[error] ${words}`]);
    // Not sent a second time, whatever --retry allows: only a refused connection is retried.
    expect(paths.filter((path) => path === '/api/send')).toHaveLength(1);
  });

  it('prints what the receiving Tower said, after the words this Tower wrote', async () => {
    towerAnswering({
      send: () =>
        refused('peer', 'remote-off', 'Refused by devvm: remote messaging is off there.', { detail: 'back on Monday' }),
    });
    await expect(send({ builder: TO, message: 'hi' })).rejects.toMatchObject({ code: 1 });
    expect(errors).toEqual(['[error] Refused by devvm: remote messaging is off there. (devvm says: back on Monday)']);

    towerAnswering({
      send: () =>
        json(200, {
          ok: true,
          resolvedTo: TO,
          mailboxId: MESSAGE_ID,
          bodyLength: 2,
          delivered: true,
          held: false,
          detail: null,
          remote: { peer: 'devvm', duplicate: false, detail: 'read at once' },
        }),
    });
    await expect(send({ builder: TO, message: 'hi' })).resolves.toBe('delivered');
    expect(printed.slice(-2)).toEqual([`[ok] Message delivered to ${TO} (2 bytes)`, '[info] devvm says: read at once']);

    towerAnswering({
      send: () =>
        json(200, {
          ok: true,
          resolvedTo: TO,
          mailboxId: MESSAGE_ID,
          bodyLength: 2,
          delivered: false,
          held: true,
          reason: 'busy',
          detail: null,
          remote: { peer: 'devvm', heldWhere: 'recipient', duplicate: false, detail: 'in a long turn' },
        }),
    });
    await expect(send({ builder: TO, message: 'hi' })).resolves.toBe('held');
    expect(printed.at(-1)).toBe('[info] devvm says: in a long turn');
  });

  it("leaves the size of a body for another Tower to Tower's sender, and still refuses a local one before any call", async () => {
    const big = 'x'.repeat(48 * 1024 + 1);
    const paths = towerAnswering({
      send: () => refused('this-tower', 'remote-off', 'Remote messaging is off on this Tower (mbp). A human turns it on with: afx peer on'),
    });
    await expect(send({ builder: TO, message: big })).rejects.toMatchObject({ code: 1 });
    expect(errors).toEqual(['[error] Remote messaging is off on this Tower (mbp). A human turns it on with: afx peer on']);
    expect(paths).toContain('/api/send');

    const local = towerAnswering({ send: () => json(200, { ok: true, resolvedTo: 'main', bodyLength: 1 }) });
    await expect(send({ builder: 'codev:architect', message: big })).rejects.toMatchObject({ code: 1 });
    expect(errors.at(-1)).toMatch(/^\[error\] Message body is 49153 bytes, over the 49152-byte \(48KB\) limit/);
    expect(local).toEqual([]);
  });

  describe('a file for another Tower: its size is left to Tower, as a message is', () => {
    const OFF = 'Remote messaging is off on this Tower (mbp). A human turns it on with: afx peer on';
    const file = (name: string, content: string): string => {
      const path = join(workspace, name);
      writeFileSync(path, content);
      return path;
    };
    const delivered = (bodyLength: number) =>
      json(200, { ok: true, resolvedTo: TO, mailboxId: MESSAGE_ID, bodyLength, delivered: true, held: false, detail: null, remote: { peer: 'devvm', duplicate: false } });

    it('a --message-file over 48 KiB with remote messaging off is refused as off, by Tower', async () => {
      const paths = towerAnswering({ send: () => refused('this-tower', 'remote-off', OFF) });
      await expect(send({ builder: TO, messageFile: file('big.txt', 'x'.repeat(48 * 1024 + 1)) })).rejects.toMatchObject({ code: 1 });
      expect(errors).toEqual([`[error] ${OFF}`]);
      expect(paths).toContain('/api/send');
    });

    it('a --message-file over 48 KiB as written but under it once normalised is sent as written', async () => {
      const crlf = 'x'.repeat(10).concat('\r\n').repeat(4200);
      expect(Buffer.byteLength(crlf)).toBeGreaterThan(48 * 1024);
      const sent: string[] = [];
      towerAnswering({
        send: (_to, message) => {
          sent.push(message);
          return delivered(46_199);
        },
      });
      await expect(send({ builder: TO, messageFile: file('crlf.txt', crlf) })).resolves.toBe('delivered');
      // Only the file's own last line ending is dropped; normalising is the sender's.
      expect(sent).toEqual([crlf.slice(0, -2)]);
      expect(lastLine()).toBe(`[ok] Message delivered to ${TO} (46199 bytes)`);
    });

    it('a --file attachment that takes the body over 48 KiB reaches Tower too', async () => {
      const paths = towerAnswering({ send: () => refused('this-tower', 'remote-off', OFF) });
      await expect(send({ builder: TO, message: 'see attached', file: file('att.txt', 'y'.repeat(48 * 1024)) })).rejects.toMatchObject({ code: 1 });
      expect(errors).toEqual([`[error] ${OFF}`]);
      expect(paths).toContain('/api/send');
    });

    it('a message file and an attachment that each fit, but not in one request, are not sent', async () => {
      const paths = towerAnswering({ send: () => delivered(1) });
      const half = 'x'.repeat(600 * 1024);
      await expect(send({ builder: TO, messageFile: file('msg.txt', half), file: file('att.txt', half) })).rejects.toMatchObject({ code: 1 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^\[error\] Not sent: the request would be 12\d{5} bytes, and Tower reads none over 1048576\.$/);
      expect(paths).not.toContain('/api/send');
    });

    it('a file no request could carry is refused with no call; a local recipient keeps the 48 KiB limit', async () => {
      const paths = towerAnswering({ send: () => delivered(1) });
      await expect(send({ builder: TO, messageFile: file('huge.txt', 'x'.repeat(1024 * 1024 + 1)) })).rejects.toThrow(
        'Message file too large: 1048577 bytes (Tower takes no request over 1048576 bytes)',
      );
      await expect(send({ builder: 'codev:architect', messageFile: file('big.txt', 'x'.repeat(48 * 1024 + 1)) })).rejects.toThrow(
        'Message file too large: 49153 bytes (max 49152 bytes / 48KB)',
      );
      await expect(send({ all: true, messageFile: file('big.txt', 'x'.repeat(48 * 1024 + 1)) })).rejects.toThrow('Message file too large: 49153 bytes');
      expect(paths).not.toContain('/api/send');
    });
  });

  describe('the hint for a Tower written as a second workspace', () => {
    const MALFORMED =
      'Malformed address: a local address has at most a workspace before `architect`. ' +
      'Expected [<workspace>:]architect[:<name>] or [<workspace>:]<builder-or-shell-id>.';
    const malformed = () => json(400, { error: 'MALFORMED_ADDRESS', message: MALFORMED });

    it('says to write the afx:// address when the first component is one of my Towers', async () => {
      const paths = towerAnswering({ send: malformed, peerTowers: () => peerList(['devvm', 'studio']) });

      await expect(send({ builder: 'DevVM:codev:architect:local', message: 'hi' })).rejects.toMatchObject({ code: 1 });

      expect(errors).toEqual([
        '[error] Malformed address: a local address has at most a workspace before `architect`; ' +
          '`devvm` is one of your Towers, so write afx://devvm/codev:architect:local',
      ]);
      expect(paths).toEqual(['/health/live', '/api/send', '/api/peer/towers']);
    });

    it("counts this Tower's own name as one of my Towers", async () => {
      towerAnswering({ send: malformed, peerTowers: () => peerList([]) });

      await expect(send({ builder: 'mbp:codev:architect', message: 'hi' })).rejects.toMatchObject({ code: 1 });

      expect(errors[0]).toContain('`mbp` is one of your Towers, so write afx://mbp/codev:architect');
    });

    it('leaves the error as it is when the first component is not one of my Towers, or the list cannot be had', async () => {
      towerAnswering({ send: malformed, peerTowers: () => peerList(['studio']) });
      await expect(send({ builder: 'devvm:codev:architect', message: 'hi' })).rejects.toMatchObject({ code: 1 });
      towerAnswering({ send: malformed });
      await expect(send({ builder: 'devvm:codev:architect', message: 'hi' })).rejects.toMatchObject({ code: 1 });
      expect(errors).toEqual([`[error] ${MALFORMED} (MALFORMED_ADDRESS)`, `[error] ${MALFORMED} (MALFORMED_ADDRESS)`]);
    });

    it('asks nothing more for any other malformed shape, or a send that did not fail that way', async () => {
      const paths = towerAnswering({ send: malformed, peerTowers: () => peerList(['devvm']) });
      await expect(send({ builder: 'devvm:codev:builder-1:x', message: 'hi' })).rejects.toMatchObject({ code: 1 });
      await expect(send({ builder: 'a:b:c', message: 'hi' })).rejects.toMatchObject({ code: 1 });
      expect(paths).not.toContain('/api/peer/towers');
    });
  });
});
