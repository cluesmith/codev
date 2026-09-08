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

describe('TowerClient.sendMessage — bounded-patience wire contract (Issue #1481)', () => {
  beforeEach(() => {
    captured = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Same failure mode as `--delay` above, one notch worse: if `interruptAfter` stops
  // reaching the wire, the send still succeeds and still holds — the operator is simply
  // never rescued, and nothing anywhere reports that the escalation was dropped.
  it('puts interruptAfter on the wire when a patience budget is given', async () => {
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'spir-9' }));

    const client = new TowerClient();
    await client.sendMessage('spir-9', 'wrap up soon', { interruptAfter: 30 });

    expect(captured).toHaveLength(1);
    const options = captured[0].body.options as Record<string, unknown>;
    expect(options.interruptAfter).toBe(30);
  });

  it('sends a fractional budget unrounded — the server owns the bounds', async () => {
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'spir-9' }));

    const client = new TowerClient();
    await client.sendMessage('spir-9', 'quick', { interruptAfter: 0.5 });

    expect((captured[0].body.options as Record<string, unknown>).interruptAfter).toBe(0.5);
  });

  it('omits interruptAfter when no budget is given', async () => {
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'spir-9' }));

    const client = new TowerClient();
    await client.sendMessage('spir-9', 'now', {});

    expect((captured[0].body.options as Record<string, unknown>).interruptAfter).toBeUndefined();
  });

  it('surfaces interruptAt from a held response', async () => {
    const deadline = Date.now() + 30_000;
    vi.stubGlobal('fetch', mockFetchReturning({
      ok: true, resolvedTo: 'spir-9', held: true, reason: 'busy-line', interruptAt: deadline,
    }));

    const client = new TowerClient();
    const result = await client.sendMessage('spir-9', 'wrap up soon', { interruptAfter: 30 });

    expect(result.held).toBe(true);
    expect(result.interruptAt).toBe(deadline);
  });

  it('leaves interruptAt undefined when the response omits it', async () => {
    // An older Tower, or a message that delivered on the first clean prompt. Either way
    // there is no armed force, and the CLI keys its force warning off exactly this.
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'spir-9', delivered: true }));

    const client = new TowerClient();
    const result = await client.sendMessage('spir-9', 'wrap up soon', { interruptAfter: 30 });

    expect(result.interruptAt).toBeUndefined();
  });

  it('carries interruptAfter alongside the other send options', async () => {
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'b1' }));

    const client = new TowerClient();
    await client.sendMessage('b1', 'msg', { raw: true, noEnter: true, interruptAfter: 45 });

    expect(captured[0].body.options as Record<string, unknown>).toMatchObject({
      raw: true, noEnter: true, interruptAfter: 45,
    });
  });
});
