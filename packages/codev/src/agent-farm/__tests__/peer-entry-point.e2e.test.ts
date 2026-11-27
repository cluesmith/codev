/**
 * The peer entry point on real Towers (Spec 1967, plan phase 5, layer B).
 *
 * Two built Towers connected to the stand-in relay over loopback. What only real Tower
 * processes can show:
 * - the handshake a Tower sends: protocol 1 and its switch as the database holds it, stated
 *   again on a reconnect after a human turns it on;
 * - `POST /__tower/peer` on Tower's local port, with the local key and the tunnel marker,
 *   reaches no handler: the path exists only inside the tunnel client;
 * - a forward down the real tunnel is verified by the Tower and handed to its receiver
 *   (phase 6's, which refuses it as `remote-off` while the switch is off); a replay, one from
 *   an earlier session and a `/t/`-style request are not verified;
 * - the session secret appears nowhere in either Tower's output.
 *
 * On demand, after `pnpm build`, never in porch's tests check (a `*.e2e.test.ts` is
 * excluded from the default config):
 *
 *   pnpm exec vitest run --config vitest.e2e.config.ts \
 *     src/agent-farm/__tests__/peer-entry-point.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { startTwoTowers, type TwoTowers } from './helpers/two-towers.js';
import { waitFor } from './helpers/tower-test-utils.js';

const STATEMENT = 'x-codev-peer-statement';
const MAC = 'x-codev-peer-mac';

function secretForms(secret: Buffer): string[] {
  return [secret.toString('base64url'), secret.toString('base64'), secret.toString('hex')];
}

describe('Spec 1967 phase 5: the peer entry point on real Towers', () => {
  let towers: TwoTowers;
  /** Every secret the stand-in has issued to either Tower. */
  const secrets: Buffer[] = [];
  const rememberSecrets = () => {
    for (const tower of [towers.a, towers.b]) {
      const secret = towers.relay.session(tower.towerId)?.secret;
      if (secret && !secrets.some((known) => known.equals(secret))) secrets.push(Buffer.from(secret));
    }
  };

  beforeAll(async () => {
    towers = await startTwoTowers();
    rememberSecrets();
  }, 180_000);

  afterAll(async () => {
    await towers?.stop();
  }, 120_000);

  it('states protocol 1 and the switch (off on a fresh install) in auth, and holds the relay', async () => {
    for (const tower of [towers.a, towers.b]) {
      expect(towers.relay.handshakes.filter((h) => h.towerId === tower.towerId).map((h) => h.peer)).toEqual([
        { protocols: [1], remoteMessaging: 'off' },
      ]);
      expect(towers.relay.session(tower.towerId)?.secret).toHaveLength(32);
    }
  });

  it('POST /__tower/peer on the local port, with the local key and the tunnel marker, reaches no handler', async () => {
    // A genuine statement and MAC, as the stand-in would forward them.
    const forward = await towers.relay.forward(towers.a.towerId);
    for (const [method, path] of [
      ['POST', '/__tower/peer'],
      ['GET', '/__tower/peer'],
      ['POST', '/__tower/peer/x'],
      ['POST', '/__tower/peer?kind=message'],
    ] as const) {
      // The e2e fetch adds the local key to every loopback call.
      const res = await towers.a.fetch(path, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-codev-tunnel-proxy': '1',
          [STATEMENT]: forward.sentHeaders[STATEMENT],
          [MAC]: forward.sentHeaders[MAC],
        },
        body: method === 'POST' ? new Uint8Array(forward.payload) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.text()).toBe('Not found');
    }
  });

  it("verifies a forward down the real tunnel and hands it to the Tower's handler; replays and /t/-style requests are not verified", async () => {
    const { relay, a } = towers;
    const genuine = await relay.forward(a.towerId);
    expect(genuine.status).toBe(200);
    expect(genuine.json).toEqual({ v: 1, outcome: 'refused', reason: 'remote-off' });

    const replayed = await relay.replay(genuine, a.towerId);
    expect(replayed.json).toEqual({ v: 1, outcome: 'not-verified' });

    const wrongSecret = await relay.forward(a.towerId, { secret: randomBytes(32) });
    expect(wrongSecret.json).toEqual({ v: 1, outcome: 'not-verified' });

    const skewed = await relay.forward(a.towerId, { issuedAt: Date.now() - 6 * 60_000 });
    expect(skewed.json).toEqual({ v: 1, outcome: 'refused', reason: 'clock-skew' });

    const proxied = await relay.tunnelRequest(a.towerId, {
      method: 'POST',
      path: '/__tower/peer',
      headers: {
        'content-type': 'application/json',
        'x-codev-tunnel-proxy': '1',
        'codev-tower-key': 'whatever the proxy carried',
        [STATEMENT]: genuine.sentHeaders[STATEMENT],
        [MAC]: randomBytes(32).toString('base64url'),
      },
      body: genuine.payload,
    });
    expect(proxied.status).toBe(200);
    expect(JSON.parse(proxied.body.toString('utf8'))).toEqual({ v: 1, outcome: 'not-verified' });
  });

  it('a human turning the switch on is stated on the next reconnect; a statement from the earlier session then fails', async () => {
    const { relay, a } = towers;
    const before = await relay.forward(a.towerId);

    const on = await a.json<{ state: string; changed: boolean }>('PUT', '/api/peer/switch', { state: 'on', humanApproved: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ state: 'on', changed: true });

    const opened = relay.sessionsOpened(a.towerId);
    relay.dropTunnels(a.towerId);
    expect(await waitFor(async () => relay.sessionsOpened(a.towerId) > opened && relay.session(a.towerId) !== null, 30_000, 50)).toBe(true);
    await a.waitForTunnel();
    rememberSecrets();

    expect(relay.handshakes.filter((h) => h.towerId === a.towerId).map((h) => h.peer).at(-1)).toEqual({
      protocols: [1],
      remoteMessaging: 'on',
    });
    expect((await relay.replay(before, a.towerId)).json).toEqual({ v: 1, outcome: 'not-verified' });
    // The receiver reads the switch as on now, and stops this one at step 11 instead.
    expect((await relay.forward(a.towerId, { statement: { sameOwner: false } })).json).toEqual({
      v: 1,
      outcome: 'refused',
      reason: 'no-grant',
    });
  }, 60_000);

  it("the session secret appears nowhere in either Tower's output", () => {
    expect(secrets.length).toBeGreaterThanOrEqual(3);
    // The harness keeps each Tower's output from its first start.
    const output = [...towers.a.output, ...towers.b.output].join('');
    expect(output).toContain('Codev Cloud relay available');
    for (const secret of secrets) {
      for (const form of secretForms(secret)) expect(output).not.toContain(form);
    }
  });

  it('stops both Towers leaving no process, socket or directory behind', async () => {
    expect(await towers.stop()).toEqual({ processes: [], shellpers: [], paths: [], relayListening: false });
  }, 120_000);
});
