/**
 * `afx send <workspace>:architect:<name>` from the new CLI to a Tower from before Spec 1940:
 * the first thing a user types after upgrading, before Tower has been restarted.
 *
 * That Tower reads the address with its own parser, as a builder called `architect:<name>`
 * in the workspace, and answers that it was not found. The command runs for real here,
 * through the real SDK client, against a transport that answers as that Tower does. It must
 * say the Tower is older and how to restart it, and it must ask the extra question only
 * when a send of the new form has failed that way. (`afx workspace list`, `afx workspace
 * name`: `spec-1940-older-tower.test.ts`. `afx whoami`: `spec-1134-whoami.test.ts`.)
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

interface Request {
  method: string;
  path: string;
  body: { to?: string } | undefined;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A Tower, as a transport. `send` and `addressBook` answer the two routes; `/health` is
 * healthy; anything else is the catch-all 404 every Tower gives a route it does not have.
 */
function towerAnswering(routes: {
  send: (to: string) => Response;
  addressBook?: () => Response;
}): Request[] {
  const requests: Request[] = [];
  transport.fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { to?: string }) : undefined;
    requests.push({ method: init?.method ?? 'GET', path: pathname, body });
    if (pathname === '/health') return json(200, { status: 'healthy' });
    if (pathname === '/api/send') return routes.send(body?.to ?? '');
    if (pathname === '/api/address-book' && routes.addressBook) return routes.addressBook();
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }) as typeof fetch;
  return requests;
}

/**
 * The Tower before Spec 1940: its parser splits on the first colon, so the agent it looks
 * for in the workspace is everything after it. The body is that Tower's own, word for word.
 */
function olderTower(): Request[] {
  return towerAnswering({
    send: (to) => {
      const colon = to.indexOf(':');
      const workspace = colon > 0 ? to.slice(0, colon) : 'codev';
      const agent = colon > 0 ? to.slice(colon + 1) : to;
      return json(404, { error: 'NOT_FOUND', message: `Agent '${agent}' not found in workspace '${workspace}'.` });
    },
  });
}

/** A Tower of this version, in which that architect does not exist. */
function thisTowerWithoutThatArchitect(): Request[] {
  return towerAnswering({
    send: () =>
      json(404, {
        error: 'NOT_FOUND',
        message: "Architect 'review' not found in workspace 'codev'. Architects there: main. Front door: codev:architect.",
      }),
    addressBook: () => json(200, { workspaces: [] }),
  });
}

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const RESTART = 'afx tower stop && afx tower start';
const OLDER =
  '[error] The running Tower is older than this CLI: it does not know an address of the form ' +
  `<workspace>:architect:<name>. Restart Tower to pick up the new version: ${RESTART}`;

describe('Spec 1940: afx send of the new form against a Tower from before it', () => {
  let workspace: string;
  let errors: string[];
  const cwd = process.cwd();
  const architectName = process.env.CODEV_ARCHITECT_NAME;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'spec-1940-older-send-')));
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
    vi.restoreAllMocks();
    process.chdir(cwd);
    if (architectName === undefined) delete process.env.CODEV_ARCHITECT_NAME;
    else process.env.CODEV_ARCHITECT_NAME = architectName;
    rmSync(workspace, { recursive: true, force: true });
  });

  it('says the Tower is older, with the restart commands, and not that the architect was not found', async () => {
    const requests = olderTower();

    await expect(send({ builder: 'codev:architect:review', message: 'hello' })).rejects.toMatchObject({ code: 1 });

    expect(errors).toEqual([OLDER]);
    // Asked as the sender, after the send failed.
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /health',
      'POST /api/send',
      'GET /api/address-book',
    ]);
  });

  it('leaves a genuine not-found alone: a Tower that has an address book knows the form', async () => {
    const requests = thisTowerWithoutThatArchitect();

    await expect(send({ builder: 'codev:architect:review', message: 'hello' })).rejects.toMatchObject({ code: 1 });

    expect(errors).toEqual([
      "[error] Architect 'review' not found in workspace 'codev'. Architects there: main. Front door: codev:architect. (NOT_FOUND)",
    ]);
    expect(requests.map((r) => r.path)).toContain('/api/address-book');
  });

  it.each([
    ['a builder in another workspace', 'codev:spir-42'],
    ["another workspace's front door", 'codev:architect'],
    ['a named architect in this workspace', 'architect:review'],
    ['a builder in this workspace', 'spir-42'],
    ['an address that names a Tower', 'afx://devvm/codev:architect:review'],
  ])('asks nothing more for a form the older Tower already knew: %s', async (_what, to) => {
    const requests = olderTower();

    await expect(send({ builder: to, message: 'hello' })).rejects.toMatchObject({ code: 1 });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not found in workspace');
    expect(errors[0]).not.toContain('older');
    expect(requests.map((r) => r.path)).not.toContain('/api/address-book');
  });

  it('takes only a missing address book for an older Tower: any other failure of that question leaves the not-found', async () => {
    const requests = towerAnswering({
      send: () => json(404, { error: 'NOT_FOUND', message: "Architect 'review' not found in workspace 'codev'." }),
      addressBook: () => json(500, { error: 'INTERNAL', message: 'database is locked' }),
    });

    await expect(send({ builder: 'codev:architect:review', message: 'hello' })).rejects.toMatchObject({ code: 1 });

    expect(errors).toEqual(["[error] Architect 'review' not found in workspace 'codev'. (NOT_FOUND)"]);
    expect(requests.map((r) => r.path)).toContain('/api/address-book');
  });

  it('asks nothing more when the new form fails some other way', async () => {
    const requests = towerAnswering({
      send: () => json(403, { error: 'REFUSED', message: 'builder x may only address its own spawning architect' }),
    });

    await expect(send({ builder: 'codev:architect:review', message: 'hello' })).rejects.toMatchObject({ code: 1 });

    expect(errors).toEqual(['[error] builder x may only address its own spawning architect (REFUSED)']);
    expect(requests.map((r) => r.path)).not.toContain('/api/address-book');
  });

  it('asks nothing more when the send succeeds', async () => {
    const requests = towerAnswering({ send: () => json(200, { ok: true, resolvedTo: 'review', bodyLength: 5 }) });

    await expect(send({ builder: 'codev:architect:review', message: 'hello' })).resolves.toBe('delivered');

    expect(errors).toEqual([]);
    expect(requests.map((r) => r.path)).toEqual(['/health', '/api/send']);
  });
});
