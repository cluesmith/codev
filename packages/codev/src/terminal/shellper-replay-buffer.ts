/**
 * Standalone replay buffer for the shellper process.
 *
 * Unlike RingBuffer (which stores lines), this stores raw byte chunks
 * to preserve exact terminal output including escape sequences. It tracks
 * the total bytes stored and evicts oldest chunks when the limit is exceeded.
 *
 * This module has NO dependencies beyond Node.js built-ins so the shellper
 * process doesn't need to pull in the full package dependency tree.
 * (shellper-protocol.ts is a sibling module under the same constraint.)
 */

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
  private lineCount = 0;

  /**
   * @param maxLines Maximum number of lines to retain. Lines are delimited
   *   by newline characters in the raw data stream.
   */
  constructor(maxLines: number = 10_000) {
    this.maxLines = maxLines;
  }

  /**
   * Append raw PTY output data to the buffer.
   * Evicts oldest chunks if the line count exceeds maxLines.
   */
  append(data: Buffer | string): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    if (buf.length === 0) return;

    // Count newlines in this chunk
    let newLines = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) newLines++;
    }

    this.chunks.push(buf);
    this.totalBytes += buf.length;
    this.lineCount += newLines;

    // Evict oldest chunks if we've exceeded the line limit
    while (this.lineCount > this.maxLines && this.chunks.length > 1) {
      const oldest = this.chunks[0];
      let removedLines = 0;
      for (let i = 0; i < oldest.length; i++) {
        if (oldest[i] === 0x0a) removedLines++;
      }
      this.chunks.shift();
      this.totalBytes -= oldest.length;
      this.lineCount -= removedLines;
    }

    // Handle edge case: single chunk exceeds line limit.
    // Trim from the front to keep only the last maxLines lines.
    if (this.lineCount > this.maxLines && this.chunks.length === 1) {
      const chunk = this.chunks[0];
      let linesToSkip = this.lineCount - this.maxLines;
      let offset = 0;
      while (linesToSkip > 0 && offset < chunk.length) {
        if (chunk[offset] === 0x0a) linesToSkip--;
        offset++;
      }
      this.chunks[0] = chunk.subarray(offset);
      this.totalBytes = this.chunks[0].length;
      this.lineCount = this.maxLines;
    }
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
