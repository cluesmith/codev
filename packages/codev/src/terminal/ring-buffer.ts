/**
 * Fixed-size circular buffer for storing terminal output lines.
 * Used for reconnection replay — stores last N lines in memory.
 */

export class RingBuffer {
  private buffer: string[];
  private head: number = 0;
  private count: number = 0;
  private seq: number = 0; // monotonically increasing sequence number

  constructor(private readonly capacity: number = 1000) {
    this.buffer = new Array(capacity);
  }

  /** Push a line into the buffer. Returns the assigned sequence number. */
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

  /** Push raw data, splitting on newlines. Returns last sequence number. */
  pushData(data: string): number {
    const lines = data.split('\n');
    let lastSeq = this.seq;
    for (const line of lines) {
      lastSeq = this.push(line);
    }
    return lastSeq;
  }

  /** Get all stored lines in order. */
  getAll(): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(this.head + i) % this.capacity]);
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

  /** Clear the buffer. */
  clear(): void {
    this.head = 0;
    this.count = 0;
    // Don't reset seq — it should be monotonic
  }
}
