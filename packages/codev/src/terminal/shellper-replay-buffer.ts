/**
 * Standalone replay buffer for the shellper process.
 *
 * Unlike RingBuffer (which stores lines), this stores raw byte chunks
 * to preserve exact terminal output including escape sequences. It evicts
 * the oldest chunks when either the line or the byte ceiling is exceeded;
 * both ceilings are needed, because a full-screen TUI emits almost no
 * newlines and so is bounded only by the byte one (#1205).
 *
 * This module has NO dependencies beyond Node.js built-ins so the shellper
 * process doesn't need to pull in the full package dependency tree.
 * (shellper-protocol.ts is a sibling module under the same constraint.)
 */

import { REPLAY_BUFFER_MAX_BYTES } from './shellper-protocol.js';

const ESC = 0x1b;

/**
 * How far past a byte-driven trim point we scan looking for an ESC to align to.
 * Bounded so alignment can never turn into a long scan over ESC-free data.
 */
const ESC_ALIGN_SCAN_LIMIT = 4096;

/**
 * Nudge a trim offset forward to the next ESC byte, so a cut doesn't land in
 * the middle of an escape sequence and leave the client rendering its tail as
 * literal garbage. Returns `offset` unchanged when no ESC is within the scan
 * window, which is the correct fallback: a raw cut is what we'd have done
 * anyway, and the post-connect repaint nudge covers the rest.
 *
 * Only byte-driven cuts need this. A newline-driven cut lands just past a
 * `\n`, which can never appear inside an escape sequence, so it is already
 * safe and aligning it would discard content for nothing.
 */
function alignToEscape(buf: Buffer, offset: number): number {
  const limit = Math.min(buf.length, offset + ESC_ALIGN_SCAN_LIMIT);
  for (let i = offset; i < limit; i++) {
    if (buf[i] === ESC) return i;
  }
  return offset;
}

function countNewlines(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) count++;
  }
  return count;
}

export class ShellperReplayBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private lineCount = 0;

  /**
   * @param maxLines Maximum number of lines to retain. Lines are delimited
   *   by newline characters in the raw data stream.
   * @param maxBytes Maximum bytes to retain. Required because `maxLines` alone
   *   does not bound anything for a full-screen TUI: such an app redraws in
   *   place via cursor addressing and emits almost no newlines, so the line
   *   ceiling never fires and the buffer grows for the life of the session
   *   (#1205). Defaults to REPLAY_BUFFER_MAX_BYTES.
   */
  constructor(maxLines: number = 10_000, maxBytes: number = REPLAY_BUFFER_MAX_BYTES) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
  }

  /**
   * Append raw PTY output data to the buffer.
   * Evicts oldest chunks if either the line or the byte ceiling is exceeded.
   */
  append(data: Buffer | string): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    if (buf.length === 0) return;

    this.chunks.push(buf);
    this.totalBytes += buf.length;
    this.lineCount += countNewlines(buf);

    this.evict();
  }

  /**
   * Drop the oldest data until both ceilings are satisfied.
   *
   * Trimming from the front can cut mid-escape-sequence or discard an
   * alt-screen-enter, which is why it was rejected in #1047. It is accepted
   * here because every layer above already does exactly this (the send cap,
   * the ring seed, the frame-skip path) and relies on the client's
   * post-connect repaint nudge; an unbounded buffer, by contrast, killed
   * sessions. Byte-driven cuts are ESC-aligned to narrow the window in which
   * a client renders a truncated sequence as literal text.
   */
  private evict(): void {
    while (
      (this.lineCount > this.maxLines || this.totalBytes > this.maxBytes) &&
      this.chunks.length > 1
    ) {
      const oldest = this.chunks[0];
      this.chunks.shift();
      this.totalBytes -= oldest.length;
      this.lineCount -= countNewlines(oldest);
    }

    // A single remaining chunk can still exceed either ceiling on its own.
    if (this.chunks.length !== 1) return;

    // Line ceiling: cut just past the newline that leaves maxLines behind.
    // A newline never appears inside an escape sequence, so this cut is
    // inherently safe and must not be ESC-aligned (that would discard content
    // for no benefit).
    if (this.lineCount > this.maxLines) {
      const chunk = this.chunks[0];
      let linesToSkip = this.lineCount - this.maxLines;
      let offset = 0;
      while (linesToSkip > 0 && offset < chunk.length) {
        if (chunk[offset] === 0x0a) linesToSkip--;
        offset++;
      }
      this.replaceSoleChunk(chunk.subarray(offset));
    }

    // Byte ceiling: keep the tail. This cut can land anywhere, so align it.
    const chunk = this.chunks[0];
    if (chunk.length > this.maxBytes) {
      this.replaceSoleChunk(chunk.subarray(alignToEscape(chunk, chunk.length - this.maxBytes)));
    }
  }

  /**
   * Replace the only chunk with a trimmed version of itself.
   *
   * Copies rather than retaining the `subarray` view: a view keeps the entire
   * original allocation alive, so trimming an oversized chunk down to the
   * ceiling would free none of the memory this class exists to bound. The copy
   * is at most `maxBytes` and only happens on the rare path where a single
   * append exceeded a ceiling by itself.
   */
  private replaceSoleChunk(next: Buffer): void {
    const owned = Buffer.from(next);
    this.chunks[0] = owned;
    this.totalBytes = owned.length;
    this.lineCount = countNewlines(owned);
  }

  /**
   * Get buffered data as a single Buffer, for the REPLAY frame on reconnection.
   *
   * @param maxBytes When given, return at most this many bytes (the most recent
   *   ones). The tail is collected by walking `chunks` backwards and slicing
   *   only the boundary chunk, so the allocation is O(maxBytes) rather than
   *   O(history).
   *
   * That distinction is the whole point (#1205). This runs on *every* client
   * connect, and the caller's cap used to be applied to the result — meaning a
   * multi-GB buffer allocated a multi-GB copy on top of itself at exactly the
   * moment a user opened the terminal, then threw almost all of it away. Peak
   * footprint doubled, and sessions were killed for it. Capping here bounds the
   * spike regardless of how large the buffer has already grown, which also
   * makes this correct for a buffer that accumulated before any byte ceiling
   * existed.
   */
  getReplayData(maxBytes?: number): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    if (maxBytes === undefined || this.totalBytes <= maxBytes) {
      if (this.chunks.length === 1) return this.chunks[0];
      return Buffer.concat(this.chunks, this.totalBytes);
    }
    if (maxBytes <= 0) return Buffer.alloc(0);

    const tail: Buffer[] = [];
    let collected = 0;
    for (let i = this.chunks.length - 1; i >= 0 && collected < maxBytes; i--) {
      const chunk = this.chunks[i];
      const remaining = maxBytes - collected;
      if (chunk.length <= remaining) {
        tail.push(chunk);
        collected += chunk.length;
        continue;
      }
      // Boundary chunk: take only its tail, aligned off a mid-sequence cut.
      const piece = chunk.subarray(alignToEscape(chunk, chunk.length - remaining));
      tail.push(piece);
      collected += piece.length;
    }
    tail.reverse();
    return Buffer.concat(tail, collected);
  }

  /** Current number of bytes stored. */
  get size(): number {
    return this.totalBytes;
  }

  /** Approximate number of lines stored. */
  get lines(): number {
    return this.lineCount;
  }

  /** Clear all buffered data. */
  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.lineCount = 0;
  }
}
