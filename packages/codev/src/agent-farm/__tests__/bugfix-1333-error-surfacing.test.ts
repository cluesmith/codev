/**
 * Regression test for #1333 — `afx send` surfaced a bare `[error] NOT_FOUND`,
 * dropping the descriptive reason Tower produced. A builder addressing a
 * non-spawning architect (`afx send architect:<name>`) could not tell
 * "no such architect" from "not authorized to address that architect": both
 * showed the same opaque code.
 *
 * Root cause: TowerClient.request() extracted `json.error || json.message`,
 * preferring the machine code and discarding the human `message`. The fix
 * (packages/core/src/tower-client.ts) surfaces the descriptive `message` with
 * the code as a parenthetical suffix, keeping both available.
 *
 * These tests exercise TowerClient via the codev re-export (`../lib/tower-client`)
 * against a stubbed fetch, so they run under codev's vitest — the suite porch's
 * `test` check runs — and validate the built core artifact the CLI consumes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TowerClient } from '../lib/tower-client.js';

/** Minimal fetch Response stand-in for an error body (JSON object or raw text). */
function errorResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: false,
    status,
    text: async () => text,
  } as unknown as Response;
}

function stubFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

/** getAuthKey override keeps the constructor from touching the local key file. */
function client(): TowerClient {
  return new TowerClient({ getAuthKey: () => null });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The two distinct NOT_FOUND reasons Tower generates for `architect:<name>`.
const SPOOFING = 'builder bugfix-1333 may only address its own spawning architect';
const MISSING = "Architect 'codex-architect' not found in workspace 'codev'.";

describe('TowerClient error surfacing (#1333)', () => {
  it('sendMessage surfaces the descriptive spoofing reason with the code, not a bare NOT_FOUND', async () => {
    stubFetch(errorResponse(404, { error: 'NOT_FOUND', message: SPOOFING }));

    const result = await client().sendMessage('architect:codex-architect', 'hi', {
      from: 'bugfix-1333',
    });

    expect(result.ok).toBe(false);
    // Pre-fix this was the bare code 'NOT_FOUND'; the reason is now preserved.
    expect(result.error).toBe(`${SPOOFING} (NOT_FOUND)`);
  });

  it('keeps the spoofing and genuinely-missing NOT_FOUND reasons distinguishable', async () => {
    stubFetch(errorResponse(404, { error: 'NOT_FOUND', message: MISSING }));

    const result = await client().request('/api/send', { method: 'POST' });

    expect(result.error).toBe(`${MISSING} (NOT_FOUND)`);
    // The two NOT_FOUND cases no longer collapse to the same opaque string.
    expect(result.error).not.toContain('may only address');
  });

  it('falls back to the bare code when the response carries no message', async () => {
    stubFetch(errorResponse(503, { error: 'STARTING_UP' }));
    const result = await client().request('/health');
    expect(result.error).toBe('STARTING_UP');
  });

  it('uses the message alone when the response carries no code', async () => {
    stubFetch(errorResponse(500, { message: 'something broke' }));
    const result = await client().request('/x');
    expect(result.error).toBe('something broke');
  });

  it('does not duplicate when code and message are identical', async () => {
    stubFetch(errorResponse(500, { error: 'boom', message: 'boom' }));
    const result = await client().request('/x');
    expect(result.error).toBe('boom');
  });

  it('falls back to the raw body for a non-JSON error response', async () => {
    stubFetch(errorResponse(502, 'Bad Gateway'));
    const result = await client().request('/x');
    expect(result.error).toBe('Bad Gateway');
  });
});
