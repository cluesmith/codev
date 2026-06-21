/**
 * No-hardware integration test for the editor + command relay.
 *
 * Boots a real Tower and drives the SSE + REST lifecycle with simulated
 * controller/provider clients: the heartbeat, the editor relay (wants-position,
 * position fan-out, a fire-and-forget scroll), and the command relay (a canonical
 * verb relayed to the provider over SSE).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTower } from './helpers/tower-test-utils.js';
import type { TowerHandle } from './helpers/tower-test-utils.js';

const PORT = 14477;
const BASE = `http://localhost:${PORT}`;

/** Collects parsed editor/command SSE envelopes from a live /api/events stream. */
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
    // Settle so the server has registered this SSE client and the reader is
    // actively pumping before the caller triggers a broadcast.
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

describe('editor + command relay (integration)', () => {
  let tower: TowerHandle;

  beforeAll(async () => {
    tower = await startTower(PORT);
  });

  afterAll(async () => {
    await tower.stop();
  });

  it('acknowledges a heartbeat', async () => {
    const res = await postJson('/api/editor/heartbeat', {});
    expect(await res.json()).toEqual({ ok: true });
  });

  it('broadcasts wants-position to subscribers on first demand', async () => {
    const sse = new SseCollector();
    await sse.waitReady();

    await postJson('/api/editor/wants-position', { wanted: true });
    const ev = await sse.waitFor('editor-wants-position');
    expect(ev.payload).toEqual({ wanted: true });

    sse.close();
  });

  it('fans editor-position reports out to controller subscribers', async () => {
    const sse = new SseCollector();
    await sse.waitReady();

    await postJson('/api/editor/position', {
      value: { visibleStart: 100, visibleEnd: 140, totalLines: 2000, file: 'file:///a.ts' },
    });
    const ev = await sse.waitFor('editor-position');
    expect(ev.payload).toMatchObject({ visibleStart: 100, totalLines: 2000 });

    sse.close();
  });

  it('relays a scroll request to the provider and acks immediately', async () => {
    const sse = new SseCollector();
    await sse.waitReady();

    const ack = await postJson('/api/editor/scroll', {
      action: 'scrollEditor',
      to: 'down',
      by: 'line',
      value: 3,
    }).then((r) => r.json());

    // Tower acks without waiting on the provider (fire-and-forget scroll)...
    expect(ack).toEqual({ ok: true });
    // ...and the request reaches the provider verbatim over SSE.
    const ev = await sse.waitFor('editor-scroll');
    expect(ev.payload).toEqual({ action: 'scrollEditor', to: 'down', by: 'line', value: 3 });

    sse.close();
  });

  it('relays a canonical command verb to the provider', async () => {
    const sse = new SseCollector();
    await sse.waitReady();

    const ack = await postJson('/api/command', { verb: 'view-diff', args: ['0809'] }).then((r) => r.json());
    expect(ack).toEqual({ ok: true });
    const ev = await sse.waitFor('command');
    expect(ev.payload).toEqual({ verb: 'view-diff', args: ['0809'] });

    sse.close();
  });
});
