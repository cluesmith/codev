/**
 * EscapeBuffer — accumulates PTY data and ensures escape sequences
 * are never written to xterm split across WebSocket frames.
 *
 * When data arrives, any trailing incomplete escape sequence is held
 * back and prepended to the next chunk. This prevents xterm parsing
 * errors that cause scroll-to-top (Issue #630).
 */
export class EscapeBuffer {
  private pending = '';

  /**
   * Add incoming data and return the portion safe to write to xterm.
   * Any trailing incomplete escape sequence is buffered internally.
   */
  write(data: string): string {
    data = this.pending + data;
    this.pending = '';

    // Find the last ESC in the data
    const lastEsc = data.lastIndexOf('\x1b');
    if (lastEsc === -1) return data;

    // Check if the escape sequence starting at lastEsc is complete
    const tail = data.substring(lastEsc);
    if (isCompleteEscape(tail)) return data;

    // Incomplete escape sequence at the end — buffer it
    this.pending = tail;
    return data.substring(0, lastEsc);
  }

  /**
   * Flush any pending data (e.g., on disconnect or cleanup).
   * Returns empty string if nothing is pending.
   */
  flush(): string {
    const data = this.pending;
    this.pending = '';
    return data;
  }

  /** Whether there is buffered data waiting for completion. */
  get hasPending(): boolean {
    return this.pending.length > 0;
  }
}

/**
 * Check if an escape sequence (starting with ESC) is complete.
 * Returns false for incomplete sequences that need more data.
 */
function isCompleteEscape(seq: string): boolean {
  if (seq.length < 2) return false; // Just ESC — need more data

  const second = seq.charCodeAt(1);

  // CSI: ESC [ <params 0x30-0x3f> <intermediates 0x20-0x2f> <final 0x40-0x7e>
  if (second === 0x5b) {
    for (let i = 2; i < seq.length; i++) {
      const c = seq.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return true; // Final byte found
      // Parameter bytes (0x30-0x3f) and intermediate bytes (0x20-0x2f) continue
      if ((c >= 0x20 && c <= 0x3f)) continue;
      // Unexpected byte — treat as complete to avoid infinite buffering
      return true;
    }
    return false; // No final byte yet
  }

  // OSC: ESC ] ... BEL(0x07) or ST(ESC \)
  if (second === 0x5d) {
    for (let i = 2; i < seq.length; i++) {
      if (seq.charCodeAt(i) === 0x07) return true;
      if (seq.charCodeAt(i) === 0x1b && i + 1 < seq.length && seq.charCodeAt(i + 1) === 0x5c) return true;
    }
    return false;
  }

  // DCS(P), APC(_), PM(^), SOS(X): ESC <intro> ... ST(ESC \)
  if (second === 0x50 || second === 0x5f || second === 0x5e || second === 0x58) {
    for (let i = 2; i < seq.length; i++) {
      if (seq.charCodeAt(i) === 0x1b && i + 1 < seq.length && seq.charCodeAt(i + 1) === 0x5c) return true;
    }
    return false;
  }

  // Two-byte sequences: ESC + single character (0x20-0x7e)
  // Includes: ESC =, ESC >, ESC 7, ESC 8, ESC M, etc.
  if (second >= 0x20 && second <= 0x7e) return true;

  // Anything else — treat as complete to avoid infinite buffering
  return true;
}
