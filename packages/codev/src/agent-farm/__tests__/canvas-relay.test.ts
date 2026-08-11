/**
 * Canvas view registry + target resolution (spec 1401, plan phase 4).
 *
 * Drives the route handler directly with in-memory request/response doubles and an INJECTED
 * clock, so lease expiry is tested by advancing time rather than by sleeping — a test that waits
 * 90 real seconds is a test nobody runs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type * as http from 'node:http';
import {
  handleCanvasRoute,
  initCanvasRelay,
  shutdownCanvasRelay,
  listCanvasViewsForTest,
  CANVAS_VIEW_LEASE_MS,
} from '../servers/canvas-relay.js';

/** A settable clock so lease expiry is a matter of arithmetic, not waiting. */
let now = 1_000_000;
const broadcasts: Array<{ type: string; body: unknown }> = [];

beforeEach(() => {
  now = 1_000_000;
  broadcasts.length = 0;
  initCanvasRelay({
    broadcast: (type, body) => broadcasts.push({ type, body }),
    now: () => now,
  });
});

afterEach(() => shutdownCanvasRelay());

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

function makeReq(method: string, payload?: unknown): http.IncomingMessage {
  let text = '';
  if (payload !== undefined) text = JSON.stringify(payload);
  const stream = Readable.from([text]) as unknown as http.IncomingMessage;
  stream.method = method;
  return stream;
}

function makeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: {} };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(text?: string) {
      if (text) captured.body = JSON.parse(text);
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

async function call(method: string, pathname: string, payload?: unknown): Promise<Captured> {
  const { res, captured } = makeRes();
  await handleCanvasRoute(
    makeReq(method, payload),
    res,
    new URL(`http://localhost:4100${pathname}`),
    { broadcastNotification: () => {} },
  );
  return captured;
}

const WS = '/tmp/ws-canvas-relay';

async function register(file: string, workspace = WS): Promise<string> {
  const out = await call('POST', '/api/canvas/views', { workspace, file });
  expect(out.status).toBe(200);
  return out.body.viewId as string;
}

/** Register and also report the CANONICAL path Tower stored, which is what matching uses. */
async function registerCanonical(
  file: string,
  workspace = WS,
): Promise<{ viewId: string; file: string }> {
  const out = await call('POST', '/api/canvas/views', { workspace, file });
  expect(out.status).toBe(200);
  return { viewId: out.body.viewId as string, file: out.body.file as string };
}

const sendCommand = (payload: unknown) => call('POST', '/api/canvas/command', payload);

describe('canvas view registry', () => {
  it('mints a distinct id per view, including two views of the SAME file', async () => {
    const a = await register('/tmp/doc.md');
    const b = await register('/tmp/doc.md');

    expect(a).not.toBe(b);
    expect(listCanvasViewsForTest()).toHaveLength(2);
  });

  it('unregisters a view, and reports an unknown id', async () => {
    const viewId = await register('/tmp/doc.md');

    expect((await call('DELETE', `/api/canvas/views/${viewId}`)).status).toBe(200);
    expect(listCanvasViewsForTest()).toHaveLength(0);
    expect((await call('DELETE', `/api/canvas/views/${viewId}`)).status).toBe(404);
  });

  it('404s a heartbeat for a view it has forgotten, so the host knows to re-register', async () => {
    const out = await call('POST', '/api/canvas/views/canvas-nope/heartbeat', {});
    expect(out.status).toBe(404);
  });

  it('keeps a view alive across the lease while heartbeats continue', async () => {
    const viewId = await register('/tmp/doc.md');

    for (let i = 0; i < 5; i += 1) {
      now += CANVAS_VIEW_LEASE_MS - 1_000;
      expect((await call('POST', `/api/canvas/views/${viewId}/heartbeat`, {})).status).toBe(200);
    }
    expect(listCanvasViewsForTest()).toHaveLength(1);
  });

  it('expires a view whose host died without unregistering', async () => {
    await register('/tmp/doc.md');

    now += CANVAS_VIEW_LEASE_MS + 1;
    const out = await sendCommand({ workspace: WS, command: 'block-next' });

    expect(out.status).toBe(404);
    expect(out.body.code).toBe('no-canvas');
    expect(listCanvasViewsForTest()).toHaveLength(0);
  });
});

describe('target resolution', () => {
  it('answers no-canvas when nothing is open', async () => {
    const out = await sendCommand({ workspace: WS, command: 'block-next' });

    expect(out.status).toBe(404);
    expect(out.body.code).toBe('no-canvas');
    expect(broadcasts).toHaveLength(0); // nothing delivered, not even to be ignored
  });

  it('answers no-canvas for a workspace with no views, even when another workspace has one', async () => {
    await register('/tmp/doc.md', '/tmp/other-ws');

    const out = await sendCommand({ workspace: WS, command: 'block-next' });
    expect(out.body.code).toBe('no-canvas');
  });

  it('delivers to the only matching view and names it', async () => {
    // Assert against the path Tower canonicalized to, not the spelling we sent: on macOS /tmp is
    // a symlink to /private/tmp, so pinning the pre-canonical spelling would assert the ABSENCE
    // of the canonicalization this route depends on.
    const { viewId, file } = await registerCanonical('/tmp/doc.md');

    const out = await sendCommand({ workspace: WS, command: 'comment-next' });

    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(out.body.target).toEqual({ viewId, file });
    expect(broadcasts).toEqual([
      { type: 'canvas-command', body: { viewId, command: 'comment-next' } },
    ]);
  });

  it('delivers to exactly ONE view when several match, never fanning out', async () => {
    await register('/tmp/doc.md');
    const second = await register('/tmp/doc.md');

    const out = await sendCommand({ workspace: WS, command: 'composer-submit' });

    // Fanning out would post the same comment twice; the newest registration wins the tie.
    expect(broadcasts).toHaveLength(1);
    expect(out.body.target).toMatchObject({ viewId: second });
  });

  it('follows the most recently active view, and focus flips it', async () => {
    const first = await register('/tmp/a.md');
    const second = await register('/tmp/b.md');

    now += 1_000;
    await call('POST', `/api/canvas/views/${first}/heartbeat`, { focused: true });

    const out = await sendCommand({ workspace: WS, command: 'block-next' });
    expect(out.body.target).toMatchObject({ viewId: first });

    now += 1_000;
    await call('POST', `/api/canvas/views/${second}/heartbeat`, { focused: true });
    const after = await sendCommand({ workspace: WS, command: 'block-next' });
    expect(after.body.target).toMatchObject({ viewId: second });
  });

  it('does not let a plain heartbeat steal MRU from a focused view', async () => {
    const focused = await register('/tmp/a.md');
    const other = await register('/tmp/b.md');

    now += 1_000;
    await call('POST', `/api/canvas/views/${focused}/heartbeat`, { focused: true });
    now += 1_000;
    await call('POST', `/api/canvas/views/${other}/heartbeat`, {}); // liveness only

    const out = await sendCommand({ workspace: WS, command: 'block-next' });
    expect(out.body.target).toMatchObject({ viewId: focused });
  });

  it('routes a file-qualified command to that file, both ways', async () => {
    const a = await register('/tmp/a.md');
    const b = await register('/tmp/b.md');

    expect(
      (await sendCommand({ workspace: WS, file: '/tmp/a.md', command: 'block-next' })).body.target,
    ).toMatchObject({ viewId: a });
    expect(
      (await sendCommand({ workspace: WS, file: '/tmp/b.md', command: 'block-next' })).body.target,
    ).toMatchObject({ viewId: b });
  });

  it('answers no-canvas when the workspace has views but not for that file', async () => {
    await register('/tmp/a.md');

    const out = await sendCommand({ workspace: WS, file: '/tmp/missing.md', command: 'block-next' });
    expect(out.body.code).toBe('no-canvas');
  });

  it('matches the same file spelled differently, while keeping the views distinct', async () => {
    const a = await registerCanonical('/tmp/nested/../doc.md');
    const b = await registerCanonical('/tmp/doc.md');

    expect(a.viewId).not.toBe(b.viewId); // two views...
    expect(a.file).toBe(b.file); // ...collapsed to one file identity
    const out = await sendCommand({ workspace: WS, file: '/tmp/./doc.md', command: 'block-next' });
    expect(out.status).toBe(200); // ...which a third spelling also matches
    expect(out.body.target).toMatchObject({ file: b.file });
  });

  it('treats a delivered command as activity, so follow-ups stay on the same view', async () => {
    const first = await register('/tmp/a.md');
    const second = await register('/tmp/b.md');

    now += 1_000;
    await call('POST', `/api/canvas/views/${first}/heartbeat`, { focused: true });
    now += 1_000;
    await sendCommand({ workspace: WS, file: '/tmp/b.md', command: 'block-next' }); // drives `second`

    const followUp = await sendCommand({ workspace: WS, command: 'block-next' });
    expect(followUp.body.target).toMatchObject({ viewId: second });
  });
});

describe('command validation', () => {
  beforeEach(async () => {
    await register('/tmp/doc.md');
  });

  it('rejects an unknown command', async () => {
    const out = await sendCommand({ workspace: WS, command: 'self-destruct' });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('invalid-request');
    expect(broadcasts).toHaveLength(0);
  });

  it('rejects a missing workspace', async () => {
    const out = await sendCommand({ command: 'block-next' });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('invalid-request');
  });

  it('rejects a missing command', async () => {
    const out = await sendCommand({ workspace: WS });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('invalid-request');
  });

  it('accepts count on a traversal command', async () => {
    const out = await sendCommand({ workspace: WS, command: 'block-next', count: 4 });
    expect(out.status).toBe(200);
    expect(broadcasts[0].body).toMatchObject({ command: 'block-next', count: 4 });
  });

  it('omits count from the event when it was not supplied', async () => {
    await sendCommand({ workspace: WS, command: 'block-next' });
    expect(broadcasts[0].body).not.toHaveProperty('count');
  });

  it('rejects count on a non-traversal command', async () => {
    for (const command of ['doc-start', 'composer-open', 'reading-mode-toggle']) {
      const out = await sendCommand({ workspace: WS, command, count: 2 });
      expect(out.status).toBe(400);
      expect(out.body.code).toBe('invalid-request');
    }
  });

  it('rejects a count that is not a positive integer', async () => {
    for (const count of [0, -3, 1.5, '2', null]) {
      const out = await sendCommand({ workspace: WS, command: 'block-next', count });
      expect(out.status).toBe(400);
      expect(out.body.code).toBe('invalid-request');
    }
  });

  it('rejects an unknown canvas route', async () => {
    expect((await call('GET', '/api/canvas/nonsense')).status).toBe(404);
  });

  // A literal `null` is valid JSON, so it parses without throwing and then explodes on the first
  // field read. That would surface as a 500 with no wire `code`, which the error contract forbids.
  it('answers invalid-request for a null or non-object body', async () => {
    for (const payload of [null, 42, 'text', ['a']]) {
      const out = await sendCommand(payload);
      expect(out.status).toBe(400);
      expect(out.body.code).toBe('invalid-request');
    }
  });
});

describe('lease integrity', () => {
  it('does NOT let command traffic keep a dead host\'s view alive', async () => {
    await register('/tmp/doc.md');

    // Drive the view steadily, without any heartbeat: this is exactly the shape of a controller
    // still sending to a host that has died. Delivery is fire-and-forget over SSE and proves
    // nothing about the host, so it must not extend the lease.
    for (let i = 0; i < 4; i += 1) {
      now += CANVAS_VIEW_LEASE_MS / 3;
      await sendCommand({ workspace: WS, command: 'block-next' });
    }

    const out = await sendCommand({ workspace: WS, command: 'block-next' });
    expect(out.status).toBe(404);
    expect(out.body.code).toBe('no-canvas');
    expect(listCanvasViewsForTest()).toHaveLength(0);
  });

  it('does not renew the lease on a malformed heartbeat', async () => {
    const viewId = await register('/tmp/doc.md');

    now += CANVAS_VIEW_LEASE_MS - 1_000;
    const bad = await call('POST', `/api/canvas/views/${viewId}/heartbeat`, null);
    expect(bad.status).toBe(400);

    // The bad heartbeat bought no time, so the view ages out on the original lease.
    now += 2_000;
    expect((await sendCommand({ workspace: WS, command: 'block-next' })).body.code).toBe('no-canvas');
  });

  it('rejects a non-object registration body instead of throwing', async () => {
    const out = await call('POST', '/api/canvas/views', null);
    expect(out.status).toBe(400);
  });
});
