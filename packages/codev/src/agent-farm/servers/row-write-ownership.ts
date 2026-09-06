/**
 * Per-ROW write ownership (Issue #1481).
 *
 * ## Why a terminal lock is not enough
 *
 * Two body writers can exist for one mailbox row: the ordinary gated delivery, and the timed
 * force that `afx send --interrupt-after` arms. The per-terminal submission lock
 * (`session-submit.ts`) serializes writers on a terminal, but it has one deliberate hole — an
 * operator whose wait ceiling expires proceeds UNSERIALIZED. The force is an operator. So the
 * terminal lock alone cannot promise that a force and a gated delivery of *the same row* never
 * overlap, and overlapping there does not merely interleave two messages: it writes one body
 * twice.
 *
 * The obvious substitute — "the row still reads `held`, so nobody is writing it" — is false, and
 * falsely reassuring. A gated delivery marks its row `delivered` only AFTER its paced write
 * completes, so throughout the write (which for a long body is seconds, not milliseconds) the
 * row reads exactly like an idle one.
 *
 * This module is the missing fact: a synchronous, non-blocking claim on the row itself, taken by
 * whichever writer is about to emit bytes, released once that attempt's outcome is committed.
 *
 * ## Contract
 *
 * - {@link tryAcquireRowWrite} NEVER waits. A writer that cannot have the row writes nothing.
 *   That is what keeps the lock order safe: the force tries this INSIDE the per-terminal lock,
 *   and a blocking acquire there would hold a terminal hostage to a row held elsewhere.
 * - The owner must call {@link RowWriteHandle.settle} exactly once, from a `finally`, with what
 *   actually happened. Waiters registered via {@link whenRowWriteSettles} are then invoked with
 *   that outcome — this is how the force learns whether the delivery it stood aside for
 *   succeeded (cancel), wrote nothing (proceed), or may have written some bytes (proceed, but
 *   disclose the risk).
 * - State is process-local and self-evicting: the map holds only rows with a write in flight.
 */

/**
 * What an owned write attempt turned out to be — the three answers a waiting force needs, and
 * nothing finer. Anything more specific belongs in the row's own audit columns.
 */
export type RowWriteOutcome =
  /**
   * The row reached a TERMINAL state under this attempt (delivered, or resolved by someone
   * else). No further body may ever be written for it: a completed delivery is at-least-once
   * already, and re-writing it is the re-injection loop #1583 exists to prevent.
   */
  | 'terminal'
  /**
   * Nothing was written — the attempt declined or aborted before its first byte, and the row is
   * still held. A waiting force may proceed exactly as if this attempt had never happened.
   */
  | 'no-bytes'
  /**
   * Bytes MAY have reached the terminal but the attempt did not complete (a dropped write, a
   * lock bypass mid-write, or a throw). The row stays held and the ordinary path is still
   * allowed to retry it — so a force may proceed too, but anything it writes may duplicate
   * effects that already landed, and every surface must say so.
   */
  | 'uncertain';

/** The owner's side of a claim. `settle` is idempotent so a `finally` can call it blindly. */
export interface RowWriteHandle {
  settle(outcome: RowWriteOutcome): void;
}

interface Entry {
  waiters: Array<(outcome: RowWriteOutcome) => void>;
}

const owned = new Map<string, Entry>();

/**
 * Claim the right to write this row's body, or `null` if another writer already holds it.
 *
 * Synchronous and non-blocking by design (see the module boundary). Call it as late as possible
 * — after every other precheck, immediately before the first byte — so a writer that was going
 * to abort anyway never blocks the other one.
 */
export function tryAcquireRowWrite(rowId: string): RowWriteHandle | null {
  if (owned.has(rowId)) return null;
  const entry: Entry = { waiters: [] };
  owned.set(rowId, entry);
  let settled = false;
  return {
    settle(outcome: RowWriteOutcome): void {
      if (settled) return;
      settled = true;
      // Identity-guarded, like every other self-evicting map here: a later owner's entry must
      // survive our cleanup.
      if (owned.get(rowId) === entry) owned.delete(rowId);
      const waiters = entry.waiters.splice(0);
      for (const waiter of waiters) {
        // One waiter's throw must not deny the others their answer — a swallowed force
        // continuation would leave that row armed forever with nothing left to fire it.
        try {
          waiter(outcome);
        } catch {
          /* the waiter owns its own diagnostics */
        }
      }
    },
  };
}

/** Whether a body write is in flight for this row right now. */
export function isRowWriteOwned(rowId: string): boolean {
  return owned.has(rowId);
}

/**
 * Register a one-shot continuation for a row that is currently owned.
 *
 * Returns `false` when the row is NOT owned — in which case the caller should just proceed;
 * there is nothing to wait for. Callers must register OUTSIDE any lock they hold, because the
 * continuation runs on the owner's release path and re-entering a held lock from there would
 * deadlock.
 */
export function whenRowWriteSettles(rowId: string, onSettled: (outcome: RowWriteOutcome) => void): boolean {
  const entry = owned.get(rowId);
  if (!entry) return false;
  entry.waiters.push(onSettled);
  return true;
}

/** How many rows have a write in flight. Test/observability only — must drain to 0. */
export function ownedRowWriteCount(): number {
  return owned.size;
}

/** Drop all ownership state. Test-only; a live Tower lets writers release their own claims. */
export function resetRowWriteOwnership(): void {
  owned.clear();
}
