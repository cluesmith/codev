/**
 * The `TowerClient` peer calls (Spec 1967): `afx peer on|off|grants|grant|revoke|limits`
 * travel CLI → TowerClient → HTTP → Tower. The codev package resolves this client from the
 * sdk's built `dist`, so the requests it puts on the wire, and how it reports each kind of
 * failure, are tested here against the source.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TowerClient } from '../tower-client.js';

interface Captured {
  url: string;
  method?: string;
  body: unknown;
}

function towerAnswering(status: number, payload: unknown): Captured[] {
  const captured: Captured[] = [];
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      captured.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(text),
        text: async () => text,
      } as unknown as Response;
    }),
  );
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TowerClient peer calls', () => {
  it('puts each request on its route, with its method and body', async () => {
    const captured = towerAnswering(200, {});
    const client = new TowerClient();
    await client.getPeerSwitch();
    await client.setPeerSwitch({ state: 'on', humanApproved: true });
    await client.getPeerGrants();
    await client.getPeerGrants('dev vm&x');
    await client.addPeerGrants({ tower: 'devvm', addresses: ['codev:architect:local'], mode: 'hold', humanApproved: true });
    await client.revokePeerGrants({ tower: 'devvm' });
    await client.getPeerLimits();
    expect(captured.map((c) => [c.method ?? 'GET', c.url.replace('http://localhost:4100', ''), c.body])).toEqual([
      ['GET', '/api/peer/switch', undefined],
      ['PUT', '/api/peer/switch', { state: 'on', humanApproved: true }],
      ['GET', '/api/peer/grants', undefined],
      ['GET', '/api/peer/grants?tower=dev+vm%26x', undefined],
      ['POST', '/api/peer/grants', { tower: 'devvm', addresses: ['codev:architect:local'], mode: 'hold', humanApproved: true }],
      ['POST', '/api/peer/grants/revoke', { tower: 'devvm' }],
      ['GET', '/api/peer/limits', undefined],
    ]);
  });

  it("returns Tower's answer as the result", async () => {
    const answer = { state: 'off', changed: true, changedAt: 1, towerName: 'mbp', grantCount: 0 };
    towerAnswering(200, answer);
    expect(await new TowerClient().setPeerSwitch({ state: 'off' })).toEqual({ ok: true, result: answer });
  });

  it("reports a refusal with Tower's reason and code", async () => {
    towerAnswering(403, { error: 'HUMAN_APPROVAL_REQUIRED', message: "Adding a grant is a human's decision." });
    expect(await new TowerClient().addPeerGrants({ tower: 'devvm', all: true })).toEqual({
      ok: false,
      status: 403,
      error: "Adding a grant is a human's decision. (HUMAN_APPROVAL_REQUIRED)",
      errorCode: 'HUMAN_APPROVAL_REQUIRED',
    });
  });

  it('tells a Tower without peer routes (a plain-text 404) apart from a refusal', async () => {
    towerAnswering(404, 'Not found');
    expect(await new TowerClient().getPeerGrants()).toEqual({ ok: false, status: 404, error: 'Not found', unknownRoute: true });
    towerAnswering(404, { error: 'UNKNOWN_TOWER', message: "No Tower named 'nas'." });
    expect(await new TowerClient().getPeerGrants('nas')).toMatchObject({ ok: false, status: 404, errorCode: 'UNKNOWN_TOWER' });
  });

  it('says when nothing is listening', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }),
    );
    expect(await new TowerClient().getPeerLimits()).toMatchObject({ ok: false, status: 0, notRunning: true });
  });
});
