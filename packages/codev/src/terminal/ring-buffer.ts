/**
 * Fixed-size circular buffer for storing terminal output lines.
 * Used for reconnection replay — stores last N lines in memory.
 */

/**
 * Ceiling on the incomplete-line partial (#1205). Sits between the 1MB replay
 * seed and the 4MB level at which Tower's partial monitor warns, so a partial
 * that trips this cap is already far past anything a viewer needs.
 */
const MAX_PARTIAL_CHARS = 2 * 1024 * 1024;

/** Bound on how far past a trim point we scan for an ESC to align to. */
const ESC_ALIGN_SCAN_LIMIT = 4096;

/**
 * Nudge a trim offset forward to the next ESC, so the retained tail doesn't
 * begin partway through an escape sequence. Falls back to the raw offset when
 * no ESC is within the scan window.
 */
function alignToEscape(text: string, offset: number): number {
  const found = text.indexOf('\x1b', offset);
  if (found !== -1 && found - offset <= ESC_ALIGN_SCAN_LIMIT) return found;
  return offset;
}

export class RingBuffer {
  private buffer: string[];
  private head: number = 0;
  private count: number = 0;
  private seq: number = 0; // monotonically increasing sequence number
  private partial: string = ''; // incomplete line from previous pushData call

  constructor(
    private readonly capacity: number = 1000,
    private readonly maxPartialChars: number = MAX_PARTIAL_CHARS,
  ) {
    this.buffer = new Array(capacity);
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
   * full-screen-TUI streams (Issue #1047).
   *
   * The `partial` was originally kept whole and unbounded, on the reasoning
   * that a TUI in the alternate screen buffer encodes its state in the
   * cumulative byte stream from the alt-screen-enter onward, so truncating the
   * front would corrupt the replay. That is true, but the growth it licensed
   * was unbounded for the life of the session (#1205), and every layer above
   * already accepts exactly this trade: the replay seed, the send cap, and the
   * frame-skip path are all lossy tail-cuts that rely on the client's
   * post-connect repaint nudge. So the partial is now capped too, with cuts
   * ESC-aligned to avoid starting the tail inside an escape sequence.
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

    // Remainder has no newline — append to the partial (cons-string, O(|data|)).
    if (start < data.length) {
      this.partial += data.slice(start);
      this.trimPartial();
    }
    return this.seq;
  }

  /**
   * Enforce the partial ceiling, keeping the most recent characters.
   *
   * Trimming back to *half* the ceiling rather than exactly to it is what makes
   * this affordable. Cutting to the ceiling would put the partial back over it
   * on the very next append, so every subsequent call would copy the whole
   * multi-megabyte partial: an O(|partial|)-per-call cost on the hot path that
   * #1047 specifically restructured to be O(|data|). Halving amortises the copy
   * over the next half-ceiling of growth, giving O(1) per byte, and bounds the
   * partial at the ceiling rather than letting it drift above it.
   */
  private trimPartial(): void {
    if (this.partial.length <= this.maxPartialChars) return;
    const target = Math.floor(this.maxPartialChars / 2);
    this.partial = this.partial.slice(alignToEscape(this.partial, this.partial.length - target));
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

  /**
   * Get lines starting from a given sequence number (for resume).
   *
   * Note (#1047): `seq` advances only on completed (newline-terminated) lines.
   * A full-screen TUI emits no newlines, so for such a session `seq` stays at
   * whatever the last real line was and a client that is caught up to it gets
   * `[]` here — the in-progress `partial` (the current screen) is NOT replayed
   * on a delta resume. That gap is covered by the client's post-connect repaint
   * nudge, which forces the app to redraw on (re)connect (see
   * `terminal-adapter.ts`). True byte-granular resume for no-newline streams was
   * considered and deliberately descoped (it would require a byte-addressable
   * seq and breaks the existing line-based wire contract); the nudge makes it
   * unnecessary for correctness.
   */
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

  /** Bytes held in the incomplete-line partial (observability, #1047). */
  get partialBytes(): number {
    return this.partial.length;
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
