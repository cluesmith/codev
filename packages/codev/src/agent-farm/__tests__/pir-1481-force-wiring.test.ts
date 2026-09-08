/**
 * The PRODUCTION binding for a forced delivery's outcome (Issue #1481).
 *
 * The coordinator's own unit tests assert the `ForcedDeliveryBroadcast` it *hands to the port*.
 * That is one side of a boundary, and it proved to be the wrong side to stop at: the live
 * `makeInterruptPorts` binding converted the frame for the message bus and dropped `outcome` and
 * `priorPartial` on the way, so a `failed` force reached every feed client as an ordinary
 * delivery — visually identical to a clean gated one. Nothing in the coordinator suite could
 * see it, because nothing there ran the conversion.
 *
 * So these tests drive the real `makeInterruptPorts` ports, with the module's two downstream
 * sinks (`broadcastMessage` on the WebSocket bus, and the SSE notification broadcaster) captured,
 * and assert the whole outcome matrix as an operator would receive it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MailboxInterruptOutcome } from '../db/types.js';

const busFrames: any[] = [];

vi.mock('../servers/tower-messages.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    broadcastMessage: (frame: unknown) => {
      busFrames.push(frame);
    },
  };
});

const { makeInterruptPorts, makeDeliveryPorts, setMailboxBroadcaster } = await import(
  '../servers/mailbox-wiring.js'
);

const notices: { type: string; title: string; body: string; workspace?: string }[] = [];
setMailboxBroadcaster((n) => {
  notices.push(n);
});

const WS = '/tmp/pir-1481-force-wiring/acme';
const AGENT = 'pir-1481';

function ports() {
  return makeInterruptPorts(() => {});
}

function forcedFrame(outcome: MailboxInterruptOutcome, priorPartial = false) {
  return {
    workspacePath: WS,
    toAgent: AGENT,
    fromAgent: 'architect',
    fromWorkspace: '/tmp/pir-1481-force-wiring/acme',
    body: 'wrap up and open the PR',
    timestamp: 1_700_000_000_000,
    outcome,
    priorPartial,
  };
}

function outcomeInfo(outcome: MailboxInterruptOutcome, priorPartial = false) {
  return {
    workspacePath: WS,
    toAgent: AGENT,
    mailboxId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    terminalId: '11111111-2222-3333-4444-555555555555',
    outcome,
    priorPartial,
  };
}

beforeEach(() => {
  busFrames.length = 0;
  notices.length = 0;
});

describe('Issue #1481 — the force audit survives the production feed conversion', () => {
  // The matrix Codex's review asked for: every outcome that reaches the bus must carry its own
  // audit, so no consumer can render a force as a clean receipt by ignoring a field it never got.
  const written: MailboxInterruptOutcome[] = [
    'written-unverified',
    'degraded-written-unverified',
    'failed',
    'degraded-failed',
    'claimed',
    'claimed-degraded',
  ];

  // `failed` and `degraded-failed` are in this list on purpose even though the coordinator no
  // longer broadcasts them (CMAP round 5 — a body on the delivery feed reads as receipt, and the
  // outcome rides as optional metadata a consumer may ignore). This is the port's contract, not
  // the coordinator's policy: if anything ever hands the port a failed frame, it must still carry
  // its own audit rather than converting into an indistinguishable ordinary delivery.
  for (const outcome of written) {
    it(`carries forcedOutcome '${outcome}' onto the message bus`, () => {
      ports().broadcast(forcedFrame(outcome));

      expect(busFrames).toHaveLength(1);
      expect(busFrames[0].metadata).toEqual({
        source: 'mailbox',
        forcedOutcome: outcome,
        forcedPriorPartial: false,
      });
      // Still the same delivery frame a gated delivery emits — one event per row, not a
      // parallel force feed a client would have to learn about separately.
      expect(busFrames[0].type).toBe('message');
      expect(busFrames[0].content).toBe('wrap up and open the PR');
      expect(busFrames[0].to).toEqual({ project: 'acme', agent: AGENT });
    });
  }

  it('carries the prior-partial duplicate risk onto the bus as well', () => {
    ports().broadcast(forcedFrame('written-unverified', true));

    expect(busFrames[0].metadata.forcedPriorPartial).toBe(true);
  });

  it('leaves a GATED delivery frame free of force metadata', () => {
    // The audit fields are optional and absent on the ordinary path, so "was this forced?" is
    // answerable from the frame alone — a gated delivery must not acquire a force outcome just
    // because both kinds share one conversion.
    makeDeliveryPorts(() => {}).broadcast({
      type: 'message',
      from: { project: 'acme', agent: 'architect' },
      to: { project: 'acme', agent: AGENT },
      content: 'ordinary gated delivery',
      metadata: { source: 'mailbox' },
      timestamp: 1_700_000_000_000,
    });

    expect(busFrames).toHaveLength(1);
    expect(busFrames[0].metadata).toEqual({ source: 'mailbox' });
    expect(busFrames[0].metadata.forcedOutcome).toBeUndefined();
  });
});

describe('Issue #1481 — the human-facing notice tells the truth about a failed force', () => {
  it('does not claim a failed force was delivered', () => {
    ports().onForceOutcome(outcomeInfo('failed'));

    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('failed');
    // The old wording said the message "was force-delivered" for every non-skipped outcome,
    // including one the terminal rejected.
    expect(notices[0].body).not.toContain('was force-delivered');
    expect(notices[0].body).toContain('REJECTED');
    expect(notices[0].body).toContain('will NOT be delivered or retried');
  });

  it('still says "force-delivered" when bytes actually went out', () => {
    ports().onForceOutcome(outcomeInfo('written-unverified'));

    expect(notices[0].title).toContain('forced');
    expect(notices[0].body).toContain('force-delivered');
    expect(notices[0].body).toContain('what was WRITTEN, not what was received');
  });

  it('reports a degraded failure as a failure, not a delivery', () => {
    ports().onForceOutcome(outcomeInfo('degraded-failed'));

    expect(notices[0].title).toContain('failed');
    expect(notices[0].body).toContain('REJECTED');
  });

  it('discloses a prior partial write on a failed force too', () => {
    ports().onForceOutcome(outcomeInfo('failed', true));

    expect(notices[0].body).toContain('effects may be duplicated');
  });

  it.each([
    'skipped-offline',
    'skipped-session-replaced',
    'skipped-contended',
    'skipped-error',
    'skipped-restart',
  ] as const)(
    'reports %s as skipped, with the body still held',
    (outcome) => {
      ports().onForceOutcome(outcomeInfo(outcome));

      expect(notices[0].title).toContain('skipped');
      expect(notices[0].body).toContain('still held');
      expect(notices[0].body).toContain(outcome);
      expect(notices[0].body).not.toContain('force-delivered');
    },
  );
});
