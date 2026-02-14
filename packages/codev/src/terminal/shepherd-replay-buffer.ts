/**
 * Standalone replay buffer for the shepherd process.
 *
 * Unlike RingBuffer (which stores lines), this stores raw byte chunks
 * to preserve exact terminal output including escape sequences. It tracks
 * the total bytes stored and evicts oldest chunks when the limit is exceeded.
 *
 * This module has NO dependencies beyond Node.js built-ins so the shepherd
 * process doesn't need to pull in the full package dependency tree.
 */

export class ShepherdReplayBuffer {
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
