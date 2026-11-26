/**
 * Issue #1901 × Spec 1940 — `afx send` against a Tower that is up but not answering.
 *
 * Two changes meet in send's failure handling. Spec 1940 asks Tower's version (`GET /api/liveness`,
 * #1999) when a `<workspace>:architect:<name>` send comes back not found, to tell an older Tower. #1901 tells a
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
const alive = () => json(200, { status: 'alive', version: '3.4.0', schemaVersion: 20, startedAt: '2026-11-26T00:00:00.000Z' });
/** A route that answers `first` once, then `rest` every time after. */
const thenAfter = (first: Route, rest: Route): Route => {
  let asked = 0;
  return () => (asked++ === 0 ? first() : rest());
};
/** The not-found an older Tower gives `codev:architect:review` (it reads `architect:review` as a builder). */
const olderNotFound = () =>
  json(404, { error: 'NOT_FOUND', message: "Agent 'architect:review' not found in workspace 'codev'." });

/**
 * A Tower of this version as a transport: each route answers, or throws to stand for no answer.
 * Records the paths asked. It has no `/health` here: the probe of a Tower that has the liveness
 * route must never fall back to the census, busy or not.
 */
function tower(routes: { liveness: Route; send?: Route }): string[] {
  const asked: string[] = [];
  transport.fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    const { pathname } = new URL(String(input));
    asked.push(pathname);
    const route = { '/api/liveness': routes.liveness, '/api/send': routes.send }[pathname];
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

const UNANSWERED_PROBE = /^\[error\] Tower did not answer its liveness probe \(Request timeout\) after \d+ ms; it appears to be up, retry$/;

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
    it('reports an unanswered liveness probe as unresponsive, before any send or version question', async () => {
      const asked = tower({ liveness: noAnswer });

      await sendExpectingExit({ builder: 'codev:architect:review', message: 'hello' });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(UNANSWERED_PROBE);
      expect(asked).toEqual(['/api/liveness', '/api/liveness']);
    });

    it('reports an unanswered version check as unresponsive, not as an older Tower or a not-found', async () => {
      const asked = tower({ liveness: thenAfter(alive, noAnswer), send: olderNotFound });

      await sendExpectingExit({ builder: 'codev:architect:review', message: 'hello' });

      expect(errors).toEqual([
        '[error] Tower did not answer the version check (Request timeout) needed to tell whether ' +
          'codev:architect:review is missing or this Tower predates that address form; it appears to be up, retry',
      ]);
      expect(asked).toEqual(['/api/liveness', '/api/send', '/api/liveness']);
    });

    it('reports an unanswered send as a timeout, and asks the version nothing more', async () => {
      const asked = tower({ liveness: alive, send: noAnswer });

      await sendExpectingExit({ builder: 'codev:architect:review', message: 'hello' });

      expect(errors).toEqual(['[error] Request timeout']);
      expect(asked).toEqual(['/api/liveness', '/api/send']);
    });
  });

  describe('who owns the retry', () => {
    it('without --retry, the health gate retries once: two probes in all', async () => {
      const asked = tower({ liveness: noAnswer });

      await sendExpectingExit({ builder: 'spir-42', message: 'hello' });

      expect(asked).toEqual(['/api/liveness', '/api/liveness']);
      expect(errors.filter((line) => line.startsWith('[retry]'))).toEqual([]);
    });

    it('with --retry N, that budget owns the retrying and the gate probes once per attempt: N + 1 probes', async () => {
      const asked = tower({ liveness: noAnswer });

      await sendExpectingExit({ builder: 'spir-42', message: 'hello', retry: 2 });

      expect(asked).toEqual(['/api/liveness', '/api/liveness', '/api/liveness']);
      const retries = errors.filter((line) => line.startsWith('[retry]'));
      expect(retries).toHaveLength(2);
      expect(retries[0]).toContain('Tower did not answer its liveness probe (Request timeout); nothing has been sent. Retry 1/2');
      expect(errors.at(-1)).toMatch(UNANSWERED_PROBE);
    });
  });
});
