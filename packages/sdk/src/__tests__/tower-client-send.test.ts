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

/**
 * Spec 1940: a failed send carries Tower's code beside the text, so a caller can tell a
 * refusal from a malformed address without matching words in a message.
 */
describe('TowerClient.sendMessage — the error code of a failed send', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function failingWith(status: number, payload: unknown) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, text: async () => text }) as unknown as Response));
  }

  it.each([
    [400, 'MALFORMED_ADDRESS', 'Malformed address: a local address has at most a workspace before `architect`.'],
    [400, 'LOCAL_ADDRESS_ONLY', 'An interrupt takes a local address: [<workspace>:]architect[:<name>] or [<workspace>:]<builder-or-shell-id>.'],
    [403, 'REFUSED', 'builder builder-spir-100 may only address its own spawning architect'],
    [404, 'NOT_FOUND', "Architect 'ghost' not found in workspace 'codev-cloud'."],
    [409, 'AMBIGUOUS', "Project 'codev' is ambiguous"],
    [400, 'INVALID_PARAMS', 'Cannot resolve agent without project context.'],
  ])('a %i %s comes back as errorCode, with the text unchanged', async (status, code, message) => {
    failingWith(status, { error: code, message });

    const result = await new TowerClient().sendMessage('codev-cloud:architect:tunnel', 'hi', { from: 'architect:review' });

    expect(result).toEqual({ ok: false, error: `${message} (${code})`, errorCode: code });
  });

  it('passes the address through as text, for Tower to read', async () => {
    captured = [];
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'tunnel' }));

    await new TowerClient().sendMessage('codev-cloud:architect:tunnel', 'hi');

    expect(captured[0].body.to).toBe('codev-cloud:architect:tunnel');
  });

  it('has no errorCode when the failure body carries none', async () => {
    failingWith(500, 'upstream exploded');
    const result = await new TowerClient().sendMessage('architect', 'hi');
    expect(result).toEqual({ ok: false, error: 'upstream exploded' });
    expect('errorCode' in result).toBe(false);
  });

  it('has no errorCode when Tower could not be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4100'); }));
    const result = await new TowerClient().sendMessage('architect', 'hi');
    expect(result).toEqual({ ok: false, error: 'Tower not running', connectionRefused: true });
    expect('errorCode' in result).toBe(false);
  });

  it('has no errorCode on a send that succeeded', async () => {
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'tunnel' }));
    const result = await new TowerClient().sendMessage('codev-cloud:architect:tunnel', 'hi');
    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });
});

/**
 * Spec 1967: a send to another Tower. It may take longer than a local one to answer, its
 * refusal carries who refused and why, and its answer says where a held message waits.
 */
describe('TowerClient.sendMessage — a send to another Tower', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A Tower that answers only after `ms`, unless the request is aborted first. */
  function answeringAfter(ms: number): ReturnType<typeof vi.fn> {
    return vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response(JSON.stringify({ ok: true, resolvedTo: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
            ms,
          );
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('The operation was aborted due to timeout'));
          });
        }),
    );
  }

  it('waits longer for an afx:// address than for a local one', async () => {
    const fetchFn = answeringAfter(80);
    const client = new TowerClient({ fetchFn: fetchFn as unknown as typeof fetch, requestTimeoutMs: 20 });
    expect(await client.sendMessage('codev:architect:local', 'hi')).toMatchObject({ ok: false, error: 'Request timeout' });
    expect(await client.sendMessage('afx://devvm/codev:architect:local', 'hi')).toMatchObject({ ok: true });
    // Text that is not an address is Tower's to refuse, on the ordinary timeout.
    expect(await client.sendMessage('afx://devvm', 'hi')).toMatchObject({ ok: false, error: 'Request timeout' });
  });

  it('gives a refusal in its own words, with who refused and why, and no code after the words', async () => {
    const body = {
      error: 'REMOTE_REFUSED',
      message: 'Refused by devvm: remote messaging is off there.',
      refusedBy: 'peer',
      reason: 'remote-off',
      retryAfterSec: null,
      mailboxId: '7c1e52aa-0000-4000-8000-000000000001',
      peer: 'devvm',
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => JSON.stringify(body) }) as unknown as Response));

    const result = await new TowerClient().sendMessage('afx://devvm/codev:architect:local', 'hi');

    expect(result).toEqual({
      ok: false,
      error: 'Refused by devvm: remote messaging is off there.',
      errorCode: 'REMOTE_REFUSED',
      refusal: {
        refusedBy: 'peer',
        reason: 'remote-off',
        retryAfterSec: null,
        mailboxId: '7c1e52aa-0000-4000-8000-000000000001',
        peer: 'devvm',
        detail: null,
      },
    });
  });

  it('passes on what the receiving Tower said, as text only', async () => {
    const answer = (detail: unknown) => ({
      error: 'REMOTE_REFUSED',
      message: 'Refused by devvm: remote messaging is off there.',
      refusedBy: 'peer',
      reason: 'remote-off',
      retryAfterSec: null,
      mailboxId: null,
      peer: 'devvm',
      detail,
    });
    for (const [detail, read] of [['back on Monday', 'back on Monday'], [42, null], [undefined, null]] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => JSON.stringify(answer(detail)) }) as unknown as Response));
      const result = await new TowerClient().sendMessage('afx://devvm/codev:architect', 'hi');
      expect(result.refusal?.detail, String(detail)).toBe(read);
    }
  });

  it('keeps the plain failure when a REMOTE_REFUSED body lacks its fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: 'REMOTE_REFUSED', message: 'no' }) }) as unknown as Response),
    );
    expect(await new TowerClient().sendMessage('afx://devvm/codev:architect', 'hi')).toEqual({
      ok: false,
      error: 'no (REMOTE_REFUSED)',
      errorCode: 'REMOTE_REFUSED',
    });
  });

  it('passes on where a held message waits, and leaves remote out of a local answer', async () => {
    const remote = { peer: 'devvm', heldWhere: 'this-tower', ahead: 1 };
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'afx://devvm/codev:architect', held: true, reason: 'tower-offline', mailboxId: 'm-1', remote }));
    expect(await new TowerClient().sendMessage('afx://devvm/codev:architect', 'hi')).toMatchObject({
      ok: true,
      held: true,
      reason: 'tower-offline',
      mailboxId: 'm-1',
      remote,
    });
    vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'main' }));
    expect(await new TowerClient().sendMessage('architect', 'hi')).not.toHaveProperty('remote');
  });

  it("reads an answer's remote part as the refusal is read: each field only if it has its type", async () => {
    const read = async (remote: unknown) => {
      vi.stubGlobal('fetch', mockFetchReturning({ ok: true, resolvedTo: 'afx://devvm/codev:architect', delivered: true, remote }));
      return (await new TowerClient().sendMessage('afx://devvm/codev:architect', 'hi')).remote;
    };
    expect(await read({ peer: 'devvm', duplicate: true, detail: 'read at once' })).toEqual({ peer: 'devvm', duplicate: true, detail: 'read at once' });
    expect(await read({ peer: 'devvm', heldWhere: 'elsewhere', ahead: '2', duplicate: 'yes', detail: { text: 'hi' } })).toEqual({ peer: 'devvm' });
    // With no peer named, or no object at all, there is no remote part to read.
    expect(await read({ duplicate: false })).toBeUndefined();
    expect(await read('devvm')).toBeUndefined();
  });

  describe('a request larger than Tower reads', () => {
    const CAP = 1024 * 1024;
    let bodies: string[];

    beforeEach(() => {
      bodies = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          bodies.push(String(init?.body));
          return new Response(JSON.stringify({ ok: true, resolvedTo: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }),
      );
    });

    const bytes = (text: string) => new TextEncoder().encode(text).length;
    const TO = 'afx://devvm/codev:architect';

    it('is sent at exactly the ceiling, and not sent one byte past it', async () => {
      await new TowerClient().sendMessage(TO, '', { from: 'architect:main', workspace: '/work/codev' });
      const envelope = bytes(bodies[0]);

      const atCap = await new TowerClient().sendMessage(TO, 'a'.repeat(CAP - envelope), { from: 'architect:main', workspace: '/work/codev' });
      expect(atCap.ok).toBe(true);
      expect(bytes(bodies[1])).toBe(CAP);

      const over = await new TowerClient().sendMessage(TO, 'a'.repeat(CAP - envelope + 1), { from: 'architect:main', workspace: '/work/codev' });
      expect(over).toEqual({
        ok: false,
        error: `Not sent: the request would be ${CAP + 1} bytes, and Tower reads none over ${CAP}.`,
        errorCode: 'REQUEST_TOO_LARGE',
      });
      expect(bodies).toHaveLength(2);
    });

    it('is measured as encoded: a message under the ceiling that escaping takes past it is not sent', async () => {
      const quotes = '"'.repeat(600 * 1024);
      expect(bytes(quotes)).toBeLessThan(CAP);
      const result = await new TowerClient().sendMessage(TO, quotes);
      expect(result).toMatchObject({ ok: false, errorCode: 'REQUEST_TOO_LARGE' });
      expect(result.error).toMatch(/^Not sent: the request would be 12\d{5} bytes, and Tower reads none over 1048576\.$/);
      expect(bodies).toEqual([]);
    });
  });

  it('gives a message stored and held but not sent now in its own words, with nothing after them', async () => {
    const words =
      'Message stored and held on this Tower — mailbox id m-9 — but not sent to devvm now: this Tower is stopping. ' +
      'It is sent when that clears. Do not send it again. See or dismiss it with: afx inbox';
    const body = { error: 'REMOTE_HELD_ON_FAULT', message: words, mailboxId: 'm-9', peer: 'devvm' };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => JSON.stringify(body) }) as unknown as Response));

    expect(await new TowerClient().sendMessage('afx://devvm/codev:architect', 'hi')).toEqual({
      ok: false,
      error: words,
      errorCode: 'REMOTE_HELD_ON_FAULT',
    });
  });
});
