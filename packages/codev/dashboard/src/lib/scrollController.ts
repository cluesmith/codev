/**
 * ScrollController — unified scroll state management for Terminal.
 *
 * Replaces three competing mechanisms (safeFit, scroll monitor, post-flush
 * setTimeout) with a single state machine using explicit lifecycle phases.
 *
 * Phases:
 *   initial-load   → terminal mounted, no content yet
 *   buffer-replay  → reconnection replaying buffered content
 *   interactive    → user actively working
 *
 * Spec: codev/specs/627-terminal-scroll-management-nee.md
 */
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

export type Phase = 'initial-load' | 'buffer-replay' | 'interactive';

export interface ScrollControllerOptions {
  term: Terminal;
  fitAddon: FitAddon;
  getContainer: () => HTMLElement | null;
  debug?: boolean;
}

export class ScrollController {
  private readonly term: Terminal;
  private readonly fitAddon: FitAddon;
  private readonly getContainer: () => HTMLElement | null;
  private readonly debug: boolean;

  private _phase: Phase = 'initial-load';
  private _viewportY = 0;
  private _baseY = 0;
  private _wasAtBottom = true;
  private _fitSuppressed = false;
  private _isProgrammaticScroll = false;

  private readonly scrollDisposable: { dispose: () => void };

  constructor(opts: ScrollControllerOptions) {
    this.term = opts.term;
    this.fitAddon = opts.fitAddon;
    this.getContainer = opts.getContainer;
    this.debug = opts.debug ?? false;

    this.scrollDisposable = this.term.onScroll(() => this.handleScroll());
  }

  // --- Public accessors ---

  get phase(): Phase {
    return this._phase;
  }

  get state(): Readonly<{
    phase: Phase;
    viewportY: number;
    baseY: number;
    wasAtBottom: boolean;
    fitSuppressed: boolean;
    isProgrammaticScroll: boolean;
  }> {
    return {
      phase: this._phase,
      viewportY: this._viewportY,
      baseY: this._baseY,
      wasAtBottom: this._wasAtBottom,
      fitSuppressed: this._fitSuppressed,
      isProgrammaticScroll: this._isProgrammaticScroll,
    };
  }

  // --- Phase transitions ---

  beginReplay(): void {
    if (this._phase !== 'initial-load') {
      console.warn('[ScrollController] beginReplay called in phase:', this._phase);
      return;
    }
    this._phase = 'buffer-replay';
    this._fitSuppressed = true;
    this.log('phase', 'initial-load → buffer-replay');
  }

  endReplay(): void {
    if (this._phase !== 'buffer-replay') {
      console.warn('[ScrollController] endReplay called in phase:', this._phase);
      return;
    }
    this._fitSuppressed = false;
    this._phase = 'interactive';
    this._wasAtBottom = true;
    this.log('phase', 'buffer-replay → interactive');

    this.programmaticScroll(() => this.term.scrollToBottom());

    // Trigger a fit now that we're interactive and write is complete
    this.safeFit();
  }

  enterInteractive(): void {
    if (this._phase !== 'initial-load') {
      console.warn('[ScrollController] enterInteractive called in phase:', this._phase);
      return;
    }
    this._phase = 'interactive';
    this.log('phase', 'initial-load → interactive');
  }

  /**
   * Reset the controller back to initial-load phase. Called on reconnection
   * so the replay flow (beginReplay/endReplay) can run again.
   */
  reset(): void {
    this._phase = 'initial-load';
    this._viewportY = 0;
    this._baseY = 0;
    this._wasAtBottom = true;
    this._fitSuppressed = false;
    this._isProgrammaticScroll = false;
    this.log('reset', 'back to initial-load');
  }

  // --- Fit suppression ---

  suppressFit(): void {
    this._fitSuppressed = true;
    this.log('fit', 'suppressed');
  }

  unsuppressFit(): void {
    this._fitSuppressed = false;
    this.log('fit', 'unsuppressed');
  }

  // --- Core operations ---

  /**
   * Scroll-aware fit: preserves viewport scroll position across fit() calls.
   * Phase-aware behavior:
   *   initial-load:   just fit, no scroll preservation
   *   buffer-replay:  skip (fitSuppressed)
   *   interactive:    fit with scroll position save/restore
   */
  safeFit(): void {
    if (this._fitSuppressed) {
      this.log('safeFit', 'skipped (fit suppressed)');
      return;
    }

    if (!this.isContainerVisible()) {
      this.log('safeFit', 'skipped (container not visible)');
      return;
    }

    if (this._phase === 'initial-load') {
      this.fitAddon.fit();
      this.log('safeFit', 'fit (initial-load, no scroll preservation)');
      return;
    }

    // Interactive phase: preserve scroll position
    const hasScrollback = this._baseY > 0 || (this.term.buffer?.active?.baseY ?? 0) > 0;

    if (!hasScrollback) {
      this.fitAddon.fit();
      this.log('safeFit', 'fit (no scrollback)');
      return;
    }

    const wasAtBottom = this._wasAtBottom;
    const restoreY = this._viewportY;

    this.fitAddon.fit();

    if (wasAtBottom) {
      this.programmaticScroll(() => this.term.scrollToBottom());
      this.log('safeFit', 'fit + scrollToBottom (was at bottom)');
    } else if (restoreY > 0) {
      this.programmaticScroll(() => this.term.scrollToLine(restoreY));
      this.log('safeFit', `fit + scrollToLine(${restoreY})`);
    } else {
      // restoreY=0 with scrollback — likely corrupted state, default to bottom
      console.warn('[ScrollController] restoreY=0 with scrollback — defaulting to bottom');
      this.programmaticScroll(() => this.term.scrollToBottom());
    }
  }

  scrollToBottom(): void {
    this.programmaticScroll(() => this.term.scrollToBottom());
    this._wasAtBottom = true;
    this.log('scrollToBottom', 'explicit');
  }

  isContainerVisible(): boolean {
    const el = this.getContainer();
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  dispose(): void {
    this.scrollDisposable.dispose();
    this.log('dispose', 'cleaned up');
  }

  // --- Internal ---

  private handleScroll(): void {
    // During programmatic scrolls: update internal state but don't take
    // corrective action. This ensures state stays fresh after controller-
    // initiated scrolls (e.g., scrollToLine to same position is a no-op
    // in xterm and won't fire onScroll, so we pre-update in programmaticScroll).
    if (this._isProgrammaticScroll) {
      const baseY = this.term.buffer?.active?.baseY ?? 0;
      const viewportY = this.term.buffer?.active?.viewportY ?? 0;
      this._baseY = baseY;
      this._viewportY = viewportY;
      this._wasAtBottom = !baseY || viewportY >= baseY;
      this.log('onScroll', `programmatic update: viewportY=${viewportY} baseY=${baseY}`);
      return;
    }

    // Ignore during non-interactive phases
    if (this._phase !== 'interactive') {
      this.log('onScroll', `ignored (phase: ${this._phase})`);
      return;
    }

    // Ignore when container is hidden (display:none causes viewportY reset)
    if (!this.isContainerVisible()) {
      this.log('onScroll', 'ignored (container not visible)');
      return;
    }

    const baseY = this.term.buffer?.active?.baseY ?? 0;
    const viewportY = this.term.buffer?.active?.viewportY ?? 0;

    // Detect unexpected scroll-to-top in interactive phase (replaces magic thresholds)
    if (viewportY === 0 && baseY > 0 && this._viewportY > 0) {
      console.warn('[ScrollController] unexpected scroll-to-top in interactive phase:',
        `was viewportY=${this._viewportY}, now viewportY=0, baseY=${baseY}`);
    }

    this._baseY = baseY;
    this._viewportY = viewportY;
    this._wasAtBottom = !baseY || viewportY >= baseY;

    this.log('onScroll', `viewportY=${viewportY} baseY=${baseY} wasAtBottom=${this._wasAtBottom}`);
  }

  private programmaticScroll(fn: () => void): void {
    this._isProgrammaticScroll = true;
    try {
      fn();
    } finally {
      this._isProgrammaticScroll = false;
    }
  }

  private log(action: string, details: string): void {
    if (this.debug) {
      console.debug(`[ScrollController] ${action}: ${details}`);
    }
  }
}
