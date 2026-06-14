/**
 * Fixed-size circular buffer for storing terminal output lines.
 * Used for reconnection replay — stores last N lines in memory.
 */

/**
 * Maximum bytes retained in the incomplete-line `partial` (Issue #1047).
 * A full-screen TUI (alternate screen buffer) redraws in place with
 * cursor-addressing and carriage returns and emits almost no `\n`, so the
 * `partial` would otherwise grow without bound — turning every `pushData`
 * into an O(n) re-scan (O(n²) over the session) and producing a multi-MB
 * replay payload that overflows the terminal client's backpressure budget.
 * 256 KB is far above any realistic single line yet bounds per-frame work,
 * memory, and the replay payload. Stays well under the VSCode client's 1 MB
 * `MAX_QUEUE` so a replay never trips client backpressure.
 */
export const DEFAULT_MAX_PARTIAL_BYTES = 256 * 1024;

export class RingBuffer {
  private buffer: string[];
  private head: number = 0;
  private count: number = 0;
  private seq: number = 0; // monotonically increasing sequence number
  private partial: string = ''; // incomplete line from previous pushData call
  private readonly maxPartialBytes: number;

  constructor(private readonly capacity: number = 1000, maxPartialBytes: number = DEFAULT_MAX_PARTIAL_BYTES) {
    this.buffer = new Array(capacity);
    if (maxPartialBytes > 0) {
      this.maxPartialBytes = maxPartialBytes;
    } else {
      this.maxPartialBytes = DEFAULT_MAX_PARTIAL_BYTES;
    }
  }

  /** Push a complete line into the buffer. Returns the assigned sequence number. */
  push(line: string): number {
    const index = (this.head + this.count) % this.capacity;
    this.buffer[index] = line;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
    return ++this.seq;
  }

  /**
   * Push raw data, splitting on newlines. Handles partial lines across
   * chunk boundaries: if data doesn't end with \n, the trailing fragment
   * is held and prepended to the next pushData call.
   *
   * Scans only the incoming `data` for newlines (never re-splits the whole
   * accumulated `partial + data`), so per-call work is O(|data|) rather than
   * O(|partial|) — the O(n²) re-scan that pegged Tower's CPU on no-newline
   * TUI streams (Issue #1047). The trailing `partial` is byte-capped: an
   * over-cap unbroken run (a TUI that never emits `\n`) is front-trimmed to
   * the most recent {@link maxPartialBytes}, bounding per-frame work, memory,
   * and the replay payload. Front-trimming (rather than injecting a synthetic
   * newline) avoids corrupting a TUI replay with spurious line feeds; a
   * reconnect drives a full repaint that heals the trimmed prefix.
   *
   * Returns last sequence number.
   */
  pushData(data: string): number {
    let start = 0;
    let nl = data.indexOf('\n');
    while (nl !== -1) {
      // Complete line = held partial (if any) + this segment up to the newline.
      this.push(this.partial + data.slice(start, nl));
      this.partial = '';
      start = nl + 1;
      nl = data.indexOf('\n', start);
    }

    // Remainder has no newline — append to the partial and bound its size.
    if (start < data.length) {
      this.partial += data.slice(start);
      if (this.partial.length > this.maxPartialBytes) {
        this.partial = this.partial.slice(this.partial.length - this.maxPartialBytes);
      }
    }
    return this.seq;
  }

  /** Get all stored lines in order, including any incomplete trailing line. */
  getAll(): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(this.head + i) % this.capacity]);
    }
    if (this.partial) {
      result.push(this.partial);
    }
    return result;
  }

  /** Get lines starting from a given sequence number (for resume). */
  getSince(sinceSeq: number): string[] {
    const linesAvailable = this.count;
    const oldestSeq = this.seq - linesAvailable + 1;
    const startSeq = Math.max(sinceSeq + 1, oldestSeq);
    if (startSeq > this.seq) return [];

    const skip = startSeq - oldestSeq;
    const result: string[] = [];
    for (let i = skip; i < this.count; i++) {
      result.push(this.buffer[(this.head + i) % this.capacity]);
    }
    if (this.partial) {
      result.push(this.partial);
    }
    return result;
  }

  /** Current sequence number (last written). */
  get currentSeq(): number {
    return this.seq;
  }

  /** Number of lines currently stored. */
  get size(): number {
    return this.count;
  }

  /** Clear the buffer and release memory. */
  clear(): void {
    this.buffer = [];
    this.head = 0;
    this.count = 0;
    this.partial = '';
    // Don't reset seq — it should be monotonic
  }
}
