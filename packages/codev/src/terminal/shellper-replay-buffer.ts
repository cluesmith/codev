/**
 * Standalone replay buffer for the shellper process.
 *
 * Unlike RingBuffer (which stores lines), this stores raw byte chunks
 * to preserve exact terminal output including escape sequences. It tracks
 * the total bytes stored and evicts oldest chunks when the limit is exceeded.
 *
 * This module has NO dependencies beyond Node.js built-ins so the shellper
 * process doesn't need to pull in the full package dependency tree.
 */

/**
 * Default byte ceiling for the replay buffer (Issue #1047). The line-count
 * cap alone never bounds a full-screen TUI stream that redraws in place and
 * emits no `\n` (lineCount stays 0, so eviction never fires) — the buffer
 * grows unbounded and the REPLAY frame it produces overflows the terminal
 * client's backpressure budget. This byte cap bounds the buffer (and the
 * replay payload) regardless of newline density. A few MB keeps a useful
 * scrollback while staying small enough to replay cheaply, including across
 * a remotely-hosted Tower reconnect.
 */
export const DEFAULT_MAX_REPLAY_BYTES = 2 * 1024 * 1024;

function countNewlines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++;
  }
  return n;
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
   * @param maxBytes Maximum bytes to retain regardless of newline count.
   *   Guards against unbounded growth on no-newline TUI streams (#1047).
   */
  constructor(maxLines: number = 10_000, maxBytes: number = DEFAULT_MAX_REPLAY_BYTES) {
    this.maxLines = maxLines;
    if (maxBytes > 0) {
      this.maxBytes = maxBytes;
    } else {
      this.maxBytes = DEFAULT_MAX_REPLAY_BYTES;
    }
  }

  private exceedsLimit(): boolean {
    return this.lineCount > this.maxLines || this.totalBytes > this.maxBytes;
  }

  /**
   * Append raw PTY output data to the buffer.
   * Evicts oldest data when either the line OR the byte limit is exceeded, so
   * a stream with no newlines is still bounded by bytes (#1047).
   */
  append(data: Buffer | string): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    if (buf.length === 0) return;

    this.chunks.push(buf);
    this.totalBytes += buf.length;
    this.lineCount += countNewlines(buf);

    // Evict whole oldest chunks while either limit is exceeded.
    while (this.exceedsLimit() && this.chunks.length > 1) {
      const oldest = this.chunks.shift()!;
      this.totalBytes -= oldest.length;
      this.lineCount -= countNewlines(oldest);
    }

    // Single remaining chunk still over a limit: trim from the front far enough
    // to satisfy BOTH the line and the byte bound.
    if (this.exceedsLimit() && this.chunks.length === 1) {
      const chunk = this.chunks[0];
      let offset = 0;
      if (this.lineCount > this.maxLines) {
        let linesToSkip = this.lineCount - this.maxLines;
        while (linesToSkip > 0 && offset < chunk.length) {
          if (chunk[offset] === 0x0a) linesToSkip--;
          offset++;
        }
      }
      const byteOffset = chunk.length - this.maxBytes;
      if (byteOffset > offset) {
        offset = byteOffset;
      }
      if (offset > 0) {
        this.chunks[0] = chunk.subarray(offset);
        this.totalBytes = this.chunks[0].length;
        this.lineCount = countNewlines(this.chunks[0]);
      }
    }
  }

  /**
   * Get all buffered data as a single concatenated Buffer.
   * Used for the REPLAY frame on reconnection.
   */
  getReplayData(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    if (this.chunks.length === 1) return this.chunks[0];
    return Buffer.concat(this.chunks);
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
