/**
 * Issue #1901 × Spec 1940 — `afx send` against a Tower that is up but not answering.
 *
 * Two changes meet in send's failure handling. Spec 1940 asks the address book when a
 * `<workspace>:architect:<name>` send comes back not found, to tell an older Tower. #1901 tells a
 * Tower that is not running from one that took the connection and did not answer. A busy Tower
 * must read as busy at every step: not "not running", not "older Tower", and not a not-found
 * that nobody could check. And `--retry` must not stack on the health gate's own retry: one loop
 * owns the retrying, and the total number of probes is pinned here.
 *
 * Same harness as `spec-1940-older-tower-send.test.ts`: the real command and the real SDK client,
 * over a transport that answers as the Tower under test does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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

const { send } = await import('../commands/send.js');

type Route = () => Response | Error;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

/** What Node's fetch throws when the 10 s abort fires before Tower answers. */
const noAnswer = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const healthy = () => json(200, { status: 'healthy' });
/** The not-found an older Tower gives `codev:architect:review` (it reads `architect:review` as a builder). */
const olderNotFound = () =>
  json(404, { error: 'NOT_FOUND', message: "Agent 'architect:review' not found in workspace 'codev'." });

/** A Tower as a transport: each route answers, or throws to stand for no answer. Records the paths asked. */
function tower(routes: { health: Route; send?: Route; addressBook?: Route }): string[] {
  const asked: string[] = [];
  transport.fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    const { pathname } = new URL(String(input));
    asked.push(pathname);
    const route = { '/health': routes.health, '/api/send': routes.send, '/api/address-book': routes.addressBook }[pathname];
    if (!route) throw new Error(`unexpected request: ${pathname}`);
    const outcome = route();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as typeof fetch;
  return asked;
}

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const UNANSWERED_HEALTH = /^\[error\] Tower did not answer \/health \(Request timeout\) after \d+ ms; it appears to be up, retry$/;

describe('afx send against a busy Tower (#1901 × Spec 1940)', () => {
  let workspace: string;
  let errors: string[];
  const cwd = process.cwd();
  const architectName = process.env.CODEV_ARCHITECT_NAME;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'bugfix-1901-send-')));
    mkdirSync(join(workspace, '.git'));
    process.chdir(workspace);
    process.env.CODEV_ARCHITECT_NAME = 'main';
    errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(stripVTControlCharacters(args.join(' '))));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exit(code ?? 0);
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.chdir(cwd);
    if (architectName === undefined) delete process.env.CODEV_ARCHITECT_NAME;
    else process.env.CODEV_ARCHITECT_NAME = architectName;
    rmSync(workspace, { recursive: true, force: true });
  });

  /** Run `send`, letting faked retry pauses elapse, and return how it exited. */
  async function sendExpectingExit(options: Parameters<typeof send>[0]): Promise<void> {
    vi.useFakeTimers();
    const settled = expect(send(options)).rejects.toMatchObject({ code: 1 });
    await vi.runAllTimersAsync();
    await settled;
  }

  describe('a three-part address', () => {
    it('reports an unanswered /health as unresponsive, before any send or address-book question', async () => {
      const asked = tower({ health: noAnswer });

      await sendExpectingExit({ builder: 'codev:architect:review', message: 'hello' });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(UNANSWERED_HEALTH);
      expect(asked).toEqual(['/health', '/health']);
    });

    it('reports an unanswered address-book check as unresponsive, not as an older Tower or a not-found', async () => {
      const asked = tower({ health: healthy, send: olderNotFound, addressBook: noAnswer });

      await sendExpectingExit({ builder: 'codev:architect:review', message: 'hello' });

      expect(errors).toEqual([
        '[error] Tower did not answer the address-book check (Request timeout) needed to tell whether ' +
          'codev:architect:review is missing or this Tower predates that address form; it appears to be up, retry',
      ]);
      expect(asked).toEqual(['/health', '/api/send', '/api/address-book']);
    });

    it('reports an unanswered send as a timeout, and asks the address book nothing', async () => {
      const asked = tower({ health: healthy, send: noAnswer });

      await sendExpectingExit({ builder: 'codev:architect:review', message: 'hello' });

      expect(errors).toEqual(['[error] Request timeout']);
      expect(asked).toEqual(['/health', '/api/send']);
    });
  });

  describe('who owns the retry', () => {
    it('without --retry, the health gate retries once: two probes in all', async () => {
      const asked = tower({ health: noAnswer });

      await sendExpectingExit({ builder: 'spir-42', message: 'hello' });

      expect(asked).toEqual(['/health', '/health']);
      expect(errors.filter((line) => line.startsWith('[retry]'))).toEqual([]);
    });

    it('with --retry N, that budget owns the retrying and the gate probes once per attempt: N + 1 probes', async () => {
      const asked = tower({ health: noAnswer });

      await sendExpectingExit({ builder: 'spir-42', message: 'hello', retry: 2 });

      expect(asked).toEqual(['/health', '/health', '/health']);
      const retries = errors.filter((line) => line.startsWith('[retry]'));
      expect(retries).toHaveLength(2);
      expect(retries[0]).toContain('Tower did not answer /health (Request timeout); nothing has been sent. Retry 1/2');
      expect(errors.at(-1)).toMatch(UNANSWERED_HEALTH);
    });
  });
});
