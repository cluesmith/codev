/**
 * No-hardware integration test for the canvas command channel (spec 1401, plan phase 4).
 *
 * Boots a real Tower and drives the whole REST -> SSE path: a host registers views over HTTP, a
 * controller POSTs a command, and exactly one addressed event reaches the stream. The unit suite
 * covers resolution logic; what only this test can prove is that the route is actually wired into
 * Tower and that the event really reaches a live `/api/events` subscriber.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTower } from './helpers/tower-test-utils.js';
import type { TowerHandle } from './helpers/tower-test-utils.js';

const PORT = 14479;
const BASE = `http://localhost:${PORT}`;
const WORKSPACE = '/tmp/canvas-relay-e2e';

/** Collects parsed SSE envelopes from a live /api/events stream. */
class SseCollector {
  events: Array<{ type: string; payload: unknown }> = [];
  private controller = new AbortController();
  private ready: Promise<void>;

  constructor() {
    this.ready = this.connect();
  }

  private async connect(): Promise<void> {
    const res = await fetch(`${BASE}/api/events`, {
      headers: { Accept: 'text/event-stream' },
      signal: this.controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const pump = async (): Promise<void> => {
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('data:')) {
              data = line.slice(5).trim();
            } else if (line === '' && data) {
              try {
                const env = JSON.parse(data);
                if (typeof env.type === 'string' && typeof env.body === 'string') {
                  this.events.push({ type: env.type, payload: JSON.parse(env.body) });
                }
              } catch {
                // ignore unrelated frames
              }
              data = '';
            }
          }
        }
      } catch {
        // aborted
      }
    };
    pump();
    // Settle so the server has registered this client before the caller triggers a broadcast.
    await new Promise((r) => setTimeout(r, 200));
  }

  waitReady(): Promise<void> {
    return this.ready;
  }

  async waitFor(type: string, timeoutMs = 2000): Promise<{ type: string; payload: unknown }> {
    const start = Date.now();
    for (;;) {
      const found = this.events.find((e) => e.type === type);
      if (found) return found;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for SSE ${type}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  countOf(type: string): number {
    return this.events.filter((e) => e.type === type).length;
  }

  close(): void {
    this.controller.abort();
  }
}

function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function registerView(file: string): Promise<{ viewId: string; file: string }> {
  const res = await postJson('/api/canvas/views', { workspace: WORKSPACE, file });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ viewId: string; file: string }>;
}

describe('canvas command channel (integration)', () => {
  let tower: TowerHandle;

  beforeAll(async () => {
    tower = await startTower(PORT);
  });

  afterAll(async () => {
    await tower.stop();
  });

  it('answers no-canvas when nothing is registered, and emits nothing', async () => {
    const sse = new SseCollector();
    await sse.waitReady();

    const res = await postJson('/api/canvas/command', {
      workspace: WORKSPACE,
      command: 'block-next',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: 'no-canvas' });

    // The absence of an event is the point: nothing was delivered to anyone.
    await new Promise((r) => setTimeout(r, 300));
    expect(sse.countOf('canvas-command')).toBe(0);

    sse.close();
  });

  it('registers a view, relays one addressed command, and unregisters', async () => {
    const sse = new SseCollector();
    await sse.waitReady();

    const view = await registerView('/tmp/canvas-relay-e2e/spec.md');

    const res = await postJson('/api/canvas/command', {
      workspace: WORKSPACE,
      command: 'comment-next',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      target: { viewId: view.viewId, file: view.file },
    });

    const event = await sse.waitFor('canvas-command');
    expect(event.payload).toEqual({ viewId: view.viewId, command: 'comment-next' });

    const gone = await fetch(`${BASE}/api/canvas/views/${view.viewId}`, { method: 'DELETE' });
    expect(gone.status).toBe(200);

    // With the last view gone, the channel reports it rather than silently succeeding.
    const after = await postJson('/api/canvas/command', {
      workspace: WORKSPACE,
      command: 'comment-next',
    });
    expect(after.status).toBe(404);
    expect(await after.json()).toMatchObject({ code: 'no-canvas' });

    sse.close();
  });

  it('addresses exactly one view when two are open on the same file', async () => {
    const sse = new SseCollector();
    await sse.waitReady();

    const first = await registerView('/tmp/canvas-relay-e2e/dup.md');
    const second = await registerView('/tmp/canvas-relay-e2e/dup.md');
    expect(first.viewId).not.toBe(second.viewId);

    const res = await postJson('/api/canvas/command', {
      workspace: WORKSPACE,
      file: '/tmp/canvas-relay-e2e/dup.md',
      command: 'composer-submit',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: { viewId: string } };

    await sse.waitFor('canvas-command');
    await new Promise((r) => setTimeout(r, 300));

    // One event, carrying one view id: a fan-out here would double-post the comment.
    expect(sse.countOf('canvas-command')).toBe(1);
    expect(sse.events.at(-1)?.payload).toMatchObject({ viewId: body.target.viewId });

    for (const v of [first, second]) {
      await fetch(`${BASE}/api/canvas/views/${v.viewId}`, { method: 'DELETE' });
    }
    sse.close();
  });

  it('rejects an unknown command with invalid-request', async () => {
    const view = await registerView('/tmp/canvas-relay-e2e/bad.md');

    const res = await postJson('/api/canvas/command', {
      workspace: WORKSPACE,
      command: 'launch-missiles',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: 'invalid-request' });

    await fetch(`${BASE}/api/canvas/views/${view.viewId}`, { method: 'DELETE' });
  });

  it('404s a heartbeat for an unknown view so a host knows to re-register', async () => {
    const res = await postJson('/api/canvas/views/canvas-does-not-exist/heartbeat', {});
    expect(res.status).toBe(404);
  });
});
