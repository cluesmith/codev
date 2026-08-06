/**
 * `TowerClient.sendMessage` wire contract (Spec 1307).
 *
 * This suite exists because of a specific gap: `--delay` travels
 * CLI → SendOptions → TowerClient → HTTP body → Tower. Every hop except this
 * one is covered from `packages/codev`, and this one *cannot* be — the
 * agent-farm `tower-client.ts` is a thin wrapper that resolves to the sdk's
 * built `dist` (post-#1189), so a codev-side test exercises compiled output,
 * not this source.
 *
 * The consequence, before this file existed: deleting `deliverAfter` from the
 * request body left all 4059 codev tests green while `--delay` silently
 * degraded to an immediate send. A feature whose failure mode is "arrives at
 * the wrong time" needs a test that fails when the field stops being sent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TowerClient } from '../tower-client.js';

/** Captured fetch calls, so assertions can read the actual request body. */
interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

let captured: CapturedRequest[] = [];

function mockFetchReturning(payload: Record<string, unknown>, ok = true) {
  return vi.fn(async (url: string, init?: { body?: string }) => {
    captured.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : {},
    });
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
}

describe('TowerClient.sendMessage — delayed delivery wire contract', () => {
  beforeEach(() => {
    captured = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts deliverAfter on the wire when a delay is given', async () => {
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'architect' }));

    const client = new TowerClient();
    await client.sendMessage('architect:main', '/arch-init main', {
      raw: true,
      deliverAfter: 15,
    });

    expect(captured).toHaveLength(1);
    const options = captured[0].body.options as Record<string, unknown>;
    expect(options.deliverAfter).toBe(15);
    expect(options.raw).toBe(true);
  });

  it('omits deliverAfter when no delay is given', async () => {
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'architect' }));

    const client = new TowerClient();
    await client.sendMessage('architect:main', 'now', { raw: true });

    const options = captured[0].body.options as Record<string, unknown>;
    expect(options.deliverAfter).toBeUndefined();
  });

  it('surfaces scheduled from the response', async () => {
    vi.stubGlobal('fetch', mockFetchReturning({
      ok: true, resolvedTo: 'architect', scheduled: true, deferred: false,
    }));

    const client = new TowerClient();
    const result = await client.sendMessage('architect:main', 'later', { deliverAfter: 15 });

    expect(result.ok).toBe(true);
    expect(result.scheduled).toBe(true);
    expect(result.deferred).toBe(false);
  });

  it('surfaces deferred from the response', async () => {
    // Tower buffered it because someone is typing in the target terminal.
    vi.stubGlobal('fetch', mockFetchReturning({
      ok: true, resolvedTo: 'architect', scheduled: false, deferred: true,
    }));

    const client = new TowerClient();
    const result = await client.sendMessage('architect:main', 'hello', {});

    expect(result.deferred).toBe(true);
    expect(result.scheduled).toBe(false);
  });

  it('reports scheduled/deferred as false when the response omits them', async () => {
    // An older Tower does not send these fields. They must read as "no", not
    // as undefined leaking into a truthiness check downstream.
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'architect' }));

    const client = new TowerClient();
    const result = await client.sendMessage('architect:main', 'hello', {});

    expect(result.scheduled).toBe(false);
    expect(result.deferred).toBe(false);
  });

  it('still carries the other send options alongside a delay', async () => {
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'b1' }));

    const client = new TowerClient();
    await client.sendMessage('b1', 'msg', {
      raw: true, noEnter: true, interrupt: true, deliverAfter: 30,
    });

    const options = captured[0].body.options as Record<string, unknown>;
    expect(options).toMatchObject({
      raw: true, noEnter: true, interrupt: true, deliverAfter: 30,
    });
  });

  it('addresses the send endpoint', async () => {
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'architect' }));

    const client = new TowerClient();
    await client.sendMessage('architect:main', 'x', { deliverAfter: 5 });

    expect(captured[0].url).toContain('/api/send');
    expect(captured[0].body.to).toBe('architect:main');
  });
});
