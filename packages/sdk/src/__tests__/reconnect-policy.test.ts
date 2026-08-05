/**
 * Unit tests for the transport-agnostic reconnect policy (#961).
 */
import { describe, it, expect } from 'vitest';
import {
  backoffDelayMs,
  BackoffController,
  classifyUpgradeError,
  WS_CLOSE_SESSION_UNKNOWN,
} from '../reconnect-policy.js';

describe('backoffDelayMs', () => {
  it('produces the exponential curve clamped at the 30s default cap', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('honors a custom base and cap', () => {
    expect(backoffDelayMs(0, { baseMs: 500, capMs: 4000 })).toBe(500);
    expect(backoffDelayMs(3, { baseMs: 500, capMs: 4000 })).toBe(4000);
  });

  it('supports the tunnel curve: jitter, 60s cap', () => {
    // Deterministic RNG → jitter = floor(0.5 * 1000) = 500.
    const opts = { baseMs: 1000, capMs: 60_000, jitterMs: 1000, random: () => 0.5 };
    expect(backoffDelayMs(0, opts)).toBe(1500); // 1000 + 500
    expect(backoffDelayMs(1, opts)).toBe(2500); // 2000 + 500
    expect(backoffDelayMs(5, opts)).toBe(32500); // 32000 + 500, under 60s cap
    expect(backoffDelayMs(6, opts)).toBe(60000); // 64000 + 500 → capped
  });

  it('short-circuits to the floor delay once afterAttempts is reached', () => {
    const opts = {
      baseMs: 1000,
      capMs: 60_000,
      jitterMs: 1000,
      floor: { afterAttempts: 10, delayMs: 300_000 },
      random: () => 0.999,
    };
    // Below the floor: normal curve (capped).
    expect(backoffDelayMs(9, opts)).toBe(60000);
    // At/above the floor: the floor delay, bypassing curve, jitter, and cap.
    expect(backoffDelayMs(10, opts)).toBe(300_000);
    expect(backoffDelayMs(20, opts)).toBe(300_000);
  });

  it('adds no jitter when jitterMs is 0 even with a custom RNG', () => {
    expect(backoffDelayMs(0, { random: () => 0.99 })).toBe(1000);
  });

  it('treats negative attempts as attempt 0', () => {
    expect(backoffDelayMs(-1)).toBe(1000);
  });
});

describe('BackoffController', () => {
  it('starts idle with zero attempts', () => {
    const ctrl = new BackoffController();
    expect(ctrl.status).toBe('idle');
    expect(ctrl.attempt).toBe(0);
  });

  it('reproduces the terminal-adapter give-up sequence (6 retries then give-up)', () => {
    const ctrl = new BackoffController({ maxAttempts: 6 });
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      expect(ctrl.recordFailure()).toBe('retry');
      expect(ctrl.status).toBe('connecting');
      expect(ctrl.attempt).toBe(i + 1); // 1-based for the attempt/max notice
      delays.push(ctrl.nextDelayMs());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);

    // The 7th failure exhausts the budget.
    expect(ctrl.recordFailure()).toBe('give-up');
    expect(ctrl.status).toBe('giving-up');
  });

  it('recordSuccess resets the counter and marks connected', () => {
    const ctrl = new BackoffController({ maxAttempts: 6 });
    ctrl.recordFailure();
    ctrl.recordFailure();
    expect(ctrl.attempt).toBe(2);
    ctrl.recordSuccess();
    expect(ctrl.attempt).toBe(0);
    expect(ctrl.status).toBe('connected');
    // A fresh failure run starts from the base delay again.
    ctrl.recordFailure();
    expect(ctrl.nextDelayMs()).toBe(1000);
  });

  it('reset clears a give-up state for manual reconnect', () => {
    const ctrl = new BackoffController({ maxAttempts: 1 });
    ctrl.recordFailure(); // attempt 1, retry
    expect(ctrl.recordFailure()).toBe('give-up');
    expect(ctrl.status).toBe('giving-up');
    ctrl.reset();
    expect(ctrl.status).toBe('connecting');
    expect(ctrl.attempt).toBe(0);
    expect(ctrl.recordFailure()).toBe('retry');
  });

  it('never gives up when maxAttempts is Infinity (SSE / tunnel)', () => {
    const ctrl = new BackoffController({ maxAttempts: Infinity });
    for (let i = 0; i < 100; i++) {
      expect(ctrl.recordFailure()).toBe('retry');
    }
    expect(ctrl.status).toBe('connecting');
  });

  it('start() and stop() drive the status machine', () => {
    const ctrl = new BackoffController();
    ctrl.start();
    expect(ctrl.status).toBe('connecting');
    ctrl.stop();
    expect(ctrl.status).toBe('idle');
  });
});

describe('classifyUpgradeError', () => {
  it('classifies a 4xx upgrade rejection (string form) as permanent', () => {
    expect(classifyUpgradeError('Unexpected server response: 404')).toBe('permanent');
    expect(classifyUpgradeError('Unexpected server response: 403')).toBe('permanent');
  });

  it('classifies non-4xx / transport blips (string form) as transient', () => {
    expect(classifyUpgradeError('socket hang up')).toBe('transient');
    expect(classifyUpgradeError('Unexpected server response: 502')).toBe('transient');
    expect(classifyUpgradeError('ECONNREFUSED')).toBe('transient');
  });

  it('classifies a numeric 4xx code (object form) as permanent', () => {
    expect(classifyUpgradeError({ code: 404 })).toBe('permanent');
    expect(classifyUpgradeError({ code: 400 })).toBe('permanent');
    expect(classifyUpgradeError({ code: 499 })).toBe('permanent');
  });

  it('classifies non-4xx codes (object form) as transient', () => {
    // 1006 is what a browser sees for a failed upgrade — transient (blind retry).
    expect(classifyUpgradeError({ code: 1006 })).toBe('transient');
    expect(classifyUpgradeError({ code: 500 })).toBe('transient');
    expect(classifyUpgradeError({})).toBe('transient');
  });

  it('classifies the session-unknown WS close code (object form) as permanent', () => {
    expect(WS_CLOSE_SESSION_UNKNOWN).toBe(4404);
    expect(classifyUpgradeError({ code: WS_CLOSE_SESSION_UNKNOWN })).toBe('permanent');
    expect(classifyUpgradeError({ code: 4404 })).toBe('permanent');
  });

  it('classifies normal / other WS close codes (object form) as transient', () => {
    // Normal closes and other app-range codes are not session-unknown.
    expect(classifyUpgradeError({ code: 1000 })).toBe('transient'); // normal closure
    expect(classifyUpgradeError({ code: 1001 })).toBe('transient'); // going away
    expect(classifyUpgradeError({ code: 4500 })).toBe('transient'); // other app-range code
  });

  it('falls back to the message when an object carries no permanent code', () => {
    expect(classifyUpgradeError({ message: 'Unexpected server response: 404' })).toBe('permanent');
    expect(classifyUpgradeError({ code: 1006, message: 'socket hang up' })).toBe('transient');
  });
});
