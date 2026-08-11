/**
 * Viewer-attach replay routing (PIR #1354).
 *
 * One decision, shared by every WS attach site (Tower's handler and the standalone
 * TerminalManager server), so snapshot-vs-raw routing and its fallback semantics can
 * never diverge between clients:
 *
 * - Delta resume on a normal-buffer session → raw ring lines since `sinceSeq`
 *   (unchanged: it is correct and minimal for scrolling shells, and a snapshot there
 *   would duplicate history the client already renders).
 * - Everything else (fresh attach; resume of an alternate-buffer session, the case
 *   `RingBuffer.getSince` cannot serve) → the serialized O(screen) snapshot.
 * - Any snapshot failure → the raw-ring replay exactly as before this feature, with
 *   the client-side repaint nudge recovering correctness; the reason is logged so
 *   emulation desync is detectable in the field.
 */

import type { PtySession } from './pty-session.js';

export type ReplayClient = { send: (data: Buffer | string) => void };

/** Matches the Tower log signature; WARN is the desync detection signal. */
export type ReplayLog = (level: 'INFO' | 'WARN', msg: string) => void;

export type AttachReplay =
  | { kind: 'snapshot'; data: string }
  | { kind: 'lines'; lines: string[] };

/**
 * Attach `client` to `session` and compute its replay payload. `sinceSeq` is the
 * client's resume sequence number, or null for a fresh attach.
 *
 * The client is always attached by the time this resolves — on the snapshot path
 * inside the same microtask as the token re-check (no output byte can land between
 * snapshot and live stream; see `PtySession.replaySnapshot`).
 */
export async function attachWithReplay(
  session: PtySession,
  client: ReplayClient,
  sinceSeq: number | null,
  log?: ReplayLog,
): Promise<AttachReplay> {
  if (sinceSeq !== null && session.screenBufferType !== 'alternate') {
    return { kind: 'lines', lines: session.attachResume(client, sinceSeq) };
  }

  const snap = await session.replaySnapshot();
  // From here to addClient there must be no await: the byte-partition guarantee.
  if (snap.ok && session.bytesWritten === snap.token) {
    session.addClient(client);
    log?.('INFO', `replay-snapshot session=${session.id} bytes=${snap.data.length}`);
    return { kind: 'snapshot', data: snap.data };
  }

  let reason: string;
  let detail = '';
  if (!snap.ok) {
    reason = snap.reason;
    if (snap.reason === 'serialize-error') {
      detail = ` err=${String((snap.error as Error)?.message ?? snap.error)}`;
    }
  } else {
    // Token drifted between resolution and this continuation — theoretically
    // unreachable (PTY data arrives via macrotasks), kept as a cheap invariant net.
    reason = 'flush-timeout';
  }
  // `no-mirror` is a session that has never produced output — routine, not a desync.
  let level: 'INFO' | 'WARN';
  if (reason === 'no-mirror') {
    level = 'INFO';
  } else {
    level = 'WARN';
  }
  log?.(
    level,
    `replay-snapshot-fallback session=${session.id} reason=${reason} bytesWritten=${session.bytesWritten}${detail}`,
  );

  if (sinceSeq !== null) {
    return { kind: 'lines', lines: session.attachResume(client, sinceSeq) };
  }
  return { kind: 'lines', lines: session.attach(client) };
}
