/**
 * KeyedSerializer (Spec 1313, Phase 4) — per-key FIFO / completion-chaining tests.
 *
 * These pin the property the whole "no blob" guarantee rests on: two operations
 * for the same key never overlap, they run in submission order, and one's failure
 * neither wedges the key nor leaks the caller's rejection.
 */

import { describe, it, expect } from 'vitest';
import { KeyedSerializer } from '../servers/write-queue.js';

/** A deferred with a manual resolve, for driving overlap deterministically. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('KeyedSerializer', () => {
  it('serializes same-key work in submission order (FIFO), never overlapping', async () => {
    const s = new KeyedSerializer();
    const events: string[] = [];
    const a = deferred();
    const b = deferred();

    const p1 = s.run('k', async () => {
      events.push('a:start');
      await a.promise;
      events.push('a:end');
    });
    const p2 = s.run('k', async () => {
      events.push('b:start');
      await b.promise;
      events.push('b:end');
    });

    // Let microtasks flush: only A may have started; B must wait for A to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['a:start']); // B has NOT started — no overlap

    a.resolve();
    await p1;
    // A fully settled; now B starts.
    await Promise.resolve();
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);

    b.resolve();
    await p2;
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs different keys concurrently (no cross-key blocking)', async () => {
    const s = new KeyedSerializer();
    const events: string[] = [];
    const x = deferred();

    const p1 = s.run('k1', async () => {
      events.push('k1:start');
      await x.promise; // k1 blocks…
      events.push('k1:end');
    });
    const p2 = s.run('k2', async () => {
      events.push('k2:start'); // …but k2 must still run
    });

    await p2;
    expect(events).toContain('k2:start'); // k2 finished while k1 is still blocked
    expect(events).not.toContain('k1:end');

    x.resolve();
    await p1;
    expect(events).toContain('k1:end');
  });

  it('a rejected fn does not wedge the key; the successor still runs; caller sees rejection', async () => {
    const s = new KeyedSerializer();
    const ran: string[] = [];

    const p1 = s.run('k', async () => {
      ran.push('a');
      throw new Error('boom');
    });
    const p2 = s.run('k', async () => {
      ran.push('b');
      return 'ok';
    });

    await expect(p1).rejects.toThrow('boom'); // caller observes the rejection
    await expect(p2).resolves.toBe('ok'); // successor unaffected
    expect(ran).toEqual(['a', 'b']);
  });

  it('returns fn results to their own callers', async () => {
    const s = new KeyedSerializer();
    const [r1, r2] = await Promise.all([
      s.run('k', async () => 1),
      s.run('k', async () => 2),
    ]);
    expect([r1, r2]).toEqual([1, 2]);
  });

  it('drops a key once its work settles with no successor (no unbounded growth)', async () => {
    const s = new KeyedSerializer();
    await s.run('k', async () => {});
    // Allow the GC microtask (tail.then) to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(s.isActive('k')).toBe(false);
  });

  it('isActive is true while work is queued/in flight', async () => {
    const s = new KeyedSerializer();
    const d = deferred();
    const p = s.run('k', async () => {
      await d.promise;
    });
    expect(s.isActive('k')).toBe(true);
    d.resolve();
    await p;
  });
});
