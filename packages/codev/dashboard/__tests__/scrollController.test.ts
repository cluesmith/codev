/**
 * Unit tests for ScrollController — the unified scroll state machine.
 *
 * Tests cover: phase transitions, safeFit behavior per phase, onScroll filtering,
 * fit suppression, programmatic scroll guard, visibility checks, and disposal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScrollController, type Phase } from '../src/lib/scrollController.js';

// --- Mock factories ---

function createMockTerm() {
  let onScrollCb: (() => void) | null = null;
  return {
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    buffer: {
      active: {
        viewportY: 0,
        baseY: 0,
      },
    },
    onScroll: vi.fn((cb: () => void) => {
      onScrollCb = cb;
      return { dispose: vi.fn() };
    }),
    // Helper to trigger the onScroll callback (simulates xterm firing a scroll event)
    _triggerScroll: () => onScrollCb?.(),
    _getOnScrollDispose: () => (onScrollCb ? vi.fn() : null),
  };
}

function createMockFitAddon() {
  return { fit: vi.fn() };
}

function createMockContainer(visible = true) {
  const el = {
    getBoundingClientRect: vi.fn().mockReturnValue(
      visible
        ? { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0 }
        : { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 }
    ),
  } as unknown as HTMLElement;
  return el;
}

type MockTerm = ReturnType<typeof createMockTerm>;
type MockFitAddon = ReturnType<typeof createMockFitAddon>;

function createController(opts?: {
  term?: MockTerm;
  fitAddon?: MockFitAddon;
  container?: HTMLElement | null;
  debug?: boolean;
}) {
  const term = opts?.term ?? createMockTerm();
  const fitAddon = opts?.fitAddon ?? createMockFitAddon();
  const container = opts?.container !== undefined ? opts.container : createMockContainer();
  const ctrl = new ScrollController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    term: term as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fitAddon: fitAddon as any,
    getContainer: () => container,
    debug: opts?.debug ?? false,
  });
  return { ctrl, term, fitAddon };
}

// --- Tests ---

describe('ScrollController', () => {
  describe('construction and initial state', () => {
    it('starts in initial-load phase', () => {
      const { ctrl } = createController();
      expect(ctrl.phase).toBe('initial-load');
    });

    it('initial state has wasAtBottom=true and zero positions', () => {
      const { ctrl } = createController();
      const s = ctrl.state;
      expect(s.viewportY).toBe(0);
      expect(s.baseY).toBe(0);
      expect(s.wasAtBottom).toBe(true);
      expect(s.fitSuppressed).toBe(false);
      expect(s.isProgrammaticScroll).toBe(false);
    });

    it('subscribes to term.onScroll', () => {
      const term = createMockTerm();
      createController({ term });
      expect(term.onScroll).toHaveBeenCalledOnce();
    });
  });

  describe('phase transitions', () => {
    it('transitions initial-load → buffer-replay via beginReplay', () => {
      const { ctrl } = createController();
      ctrl.beginReplay();
      expect(ctrl.phase).toBe('buffer-replay');
      expect(ctrl.state.fitSuppressed).toBe(true);
    });

    it('transitions buffer-replay → interactive via endReplay', () => {
      const { ctrl } = createController();
      ctrl.beginReplay();
      ctrl.endReplay();
      expect(ctrl.phase).toBe('interactive');
      expect(ctrl.state.fitSuppressed).toBe(false);
      expect(ctrl.state.wasAtBottom).toBe(true);
    });

    it('transitions initial-load → interactive via enterInteractive', () => {
      const { ctrl } = createController();
      ctrl.enterInteractive();
      expect(ctrl.phase).toBe('interactive');
    });

    it('beginReplay warns if not in initial-load', () => {
      const { ctrl } = createController();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      ctrl.enterInteractive();
      ctrl.beginReplay();
      expect(ctrl.phase).toBe('interactive'); // unchanged
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('endReplay warns if not in buffer-replay', () => {
      const { ctrl } = createController();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      ctrl.endReplay();
      expect(ctrl.phase).toBe('initial-load'); // unchanged
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('enterInteractive warns if not in initial-load', () => {
      const { ctrl } = createController();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      ctrl.beginReplay();
      ctrl.enterInteractive();
      expect(ctrl.phase).toBe('buffer-replay'); // unchanged
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('endReplay behavior', () => {
    it('calls scrollToBottom on transition', () => {
      const { ctrl, term } = createController();
      ctrl.beginReplay();
      ctrl.endReplay();
      expect(term.scrollToBottom).toHaveBeenCalled();
    });

    it('triggers safeFit after transition', () => {
      const { ctrl, fitAddon } = createController();
      ctrl.beginReplay();
      fitAddon.fit.mockClear();
      ctrl.endReplay();
      expect(fitAddon.fit).toHaveBeenCalled();
    });
  });

  describe('safeFit', () => {
    it('just fits during initial-load (no scroll preservation)', () => {
      const { ctrl, fitAddon, term } = createController();
      ctrl.safeFit();
      expect(fitAddon.fit).toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();
      expect(term.scrollToLine).not.toHaveBeenCalled();
    });

    it('skips when fit is suppressed (buffer-replay)', () => {
      const { ctrl, fitAddon } = createController();
      ctrl.beginReplay();
      ctrl.safeFit();
      expect(fitAddon.fit).not.toHaveBeenCalled();
    });

    it('skips when container is not visible', () => {
      const { ctrl, fitAddon } = createController({ container: createMockContainer(false) });
      ctrl.enterInteractive();
      ctrl.safeFit();
      expect(fitAddon.fit).not.toHaveBeenCalled();
    });

    it('fits without scroll preservation when no scrollback in interactive', () => {
      const { ctrl, fitAddon, term } = createController();
      ctrl.enterInteractive();
      // No scrollback (baseY=0 in both tracked state and buffer)
      term.buffer.active.baseY = 0;
      fitAddon.fit.mockClear();
      ctrl.safeFit();
      expect(fitAddon.fit).toHaveBeenCalled();
      expect(term.scrollToLine).not.toHaveBeenCalled();
    });

    it('calls scrollToBottom when user was at bottom in interactive', () => {
      const { ctrl, fitAddon, term } = createController();
      ctrl.enterInteractive();

      // Simulate scroll: user is at bottom (viewportY == baseY)
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 500;
      term._triggerScroll();

      term.scrollToBottom.mockClear();
      term.scrollToLine.mockClear();
      fitAddon.fit.mockClear();

      ctrl.safeFit();
      expect(fitAddon.fit).toHaveBeenCalled();
      expect(term.scrollToBottom).toHaveBeenCalled();
      expect(term.scrollToLine).not.toHaveBeenCalled();
    });

    it('calls scrollToLine to restore position when user scrolled up in interactive', () => {
      const { ctrl, fitAddon, term } = createController();
      ctrl.enterInteractive();

      // Simulate scroll: user scrolled up to line 200
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 200;
      term._triggerScroll();

      term.scrollToBottom.mockClear();
      term.scrollToLine.mockClear();
      fitAddon.fit.mockClear();

      ctrl.safeFit();
      expect(fitAddon.fit).toHaveBeenCalled();
      expect(term.scrollToLine).toHaveBeenCalledWith(200);
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('defaults to scrollToBottom when restoreY=0 but scrollback exists', () => {
      const { ctrl, fitAddon, term } = createController();
      ctrl.enterInteractive();

      // Simulate: buffer has scrollback but tracked viewportY is 0 (corrupted)
      term.buffer.active.baseY = 100;
      term.buffer.active.viewportY = 0;
      // Don't trigger scroll — state stays at defaults (viewportY=0, wasAtBottom=true)
      // But set baseY via buffer to simulate scrollback existing

      term.scrollToBottom.mockClear();
      fitAddon.fit.mockClear();

      ctrl.safeFit();
      expect(fitAddon.fit).toHaveBeenCalled();
      // wasAtBottom is true by default, so scrollToBottom
      expect(term.scrollToBottom).toHaveBeenCalled();
    });

    it('skips when suppressFit is active', () => {
      const { ctrl, fitAddon } = createController();
      ctrl.enterInteractive();
      ctrl.suppressFit();
      ctrl.safeFit();
      expect(fitAddon.fit).not.toHaveBeenCalled();
    });

    it('resumes after unsuppressFit', () => {
      const { ctrl, fitAddon } = createController();
      ctrl.enterInteractive();
      ctrl.suppressFit();
      ctrl.unsuppressFit();
      ctrl.safeFit();
      expect(fitAddon.fit).toHaveBeenCalled();
    });
  });

  describe('onScroll handler', () => {
    it('ignores events during initial-load', () => {
      const { ctrl, term } = createController();
      term.buffer.active.baseY = 100;
      term.buffer.active.viewportY = 50;
      term._triggerScroll();
      // State should not have been updated
      expect(ctrl.state.viewportY).toBe(0);
      expect(ctrl.state.baseY).toBe(0);
    });

    it('ignores events during buffer-replay', () => {
      const { ctrl, term } = createController();
      ctrl.beginReplay();
      term.buffer.active.baseY = 100;
      term.buffer.active.viewportY = 50;
      term._triggerScroll();
      expect(ctrl.state.viewportY).toBe(0);
    });

    it('updates state during interactive phase', () => {
      const { ctrl, term } = createController();
      ctrl.enterInteractive();
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 200;
      term._triggerScroll();
      expect(ctrl.state.viewportY).toBe(200);
      expect(ctrl.state.baseY).toBe(500);
      expect(ctrl.state.wasAtBottom).toBe(false);
    });

    it('tracks wasAtBottom correctly when at bottom', () => {
      const { ctrl, term } = createController();
      ctrl.enterInteractive();
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 500;
      term._triggerScroll();
      expect(ctrl.state.wasAtBottom).toBe(true);
    });

    it('ignores events when container is hidden in interactive', () => {
      const { ctrl, term } = createController({ container: createMockContainer(false) });
      ctrl.enterInteractive();
      term.buffer.active.baseY = 100;
      term.buffer.active.viewportY = 50;
      term._triggerScroll();
      expect(ctrl.state.viewportY).toBe(0);
    });

    it('updates state but does not take corrective action during programmatic scroll', () => {
      const { ctrl, term } = createController();
      ctrl.enterInteractive();

      // Set some state first
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 200;
      term._triggerScroll();

      // scrollToBottom sets wasAtBottom explicitly
      ctrl.scrollToBottom();
      expect(ctrl.state.wasAtBottom).toBe(true);
    });

    it('warns on unexpected scroll-to-top in interactive phase', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ctrl, term } = createController();
      ctrl.enterInteractive();

      // User was at line 200
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 200;
      term._triggerScroll();

      // Unexpected scroll to top (viewportY=0 with scrollback)
      term.buffer.active.viewportY = 0;
      term._triggerScroll();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unexpected scroll-to-top'),
        expect.any(String),
      );
      warnSpy.mockRestore();
    });
  });

  describe('programmatic scroll guard', () => {
    it('updates state during programmatic scroll (no corrective action)', () => {
      const term = createMockTerm();
      term.scrollToBottom.mockImplementation(() => {
        // During the scrollToBottom call, xterm fires onScroll with new position
        term.buffer.active.baseY = 500;
        term.buffer.active.viewportY = 500;
        term._triggerScroll();
      });

      const { ctrl } = createController({ term });
      ctrl.enterInteractive();

      // Set up initial state: user scrolled to line 200
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 200;
      term._triggerScroll();
      expect(ctrl.state.viewportY).toBe(200);

      // Call scrollToBottom — the mock triggers onScroll during the call
      ctrl.scrollToBottom();

      // State SHOULD have been updated by the onScroll during programmatic scroll
      expect(ctrl.state.viewportY).toBe(500);
      expect(ctrl.state.baseY).toBe(500);
      expect(ctrl.state.wasAtBottom).toBe(true);
    });

    it('safeFit uses programmatic scroll guard for scrollToBottom', () => {
      const term = createMockTerm();
      let scrollToBotDuringFit = false;
      term.scrollToBottom.mockImplementation(() => {
        scrollToBotDuringFit = true;
        // Simulate xterm firing onScroll when we programmatically scroll
        term.buffer.active.viewportY = 500;
        term._triggerScroll();
      });

      const { ctrl, fitAddon } = createController({ term });
      ctrl.enterInteractive();

      // User was at bottom
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 500;
      term._triggerScroll();

      term.scrollToBottom.mockClear();
      fitAddon.fit.mockClear();

      ctrl.safeFit();
      expect(scrollToBotDuringFit).toBe(true);
    });
  });

  describe('scrollToBottom', () => {
    it('calls term.scrollToBottom and sets wasAtBottom', () => {
      const { ctrl, term } = createController();
      ctrl.enterInteractive();

      // Simulate user scrolled up
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 200;
      term._triggerScroll();
      expect(ctrl.state.wasAtBottom).toBe(false);

      ctrl.scrollToBottom();
      expect(term.scrollToBottom).toHaveBeenCalled();
      expect(ctrl.state.wasAtBottom).toBe(true);
    });
  });

  describe('isContainerVisible', () => {
    it('returns true for visible container', () => {
      const { ctrl } = createController({ container: createMockContainer(true) });
      expect(ctrl.isContainerVisible()).toBe(true);
    });

    it('returns false for hidden container', () => {
      const { ctrl } = createController({ container: createMockContainer(false) });
      expect(ctrl.isContainerVisible()).toBe(false);
    });

    it('returns false when container is null', () => {
      const { ctrl } = createController({ container: null });
      expect(ctrl.isContainerVisible()).toBe(false);
    });
  });

  describe('fit suppression', () => {
    it('suppressFit sets fitSuppressed', () => {
      const { ctrl } = createController();
      ctrl.suppressFit();
      expect(ctrl.state.fitSuppressed).toBe(true);
    });

    it('unsuppressFit clears fitSuppressed', () => {
      const { ctrl } = createController();
      ctrl.suppressFit();
      ctrl.unsuppressFit();
      expect(ctrl.state.fitSuppressed).toBe(false);
    });

    it('beginReplay sets fitSuppressed', () => {
      const { ctrl } = createController();
      ctrl.beginReplay();
      expect(ctrl.state.fitSuppressed).toBe(true);
    });

    it('endReplay clears fitSuppressed', () => {
      const { ctrl } = createController();
      ctrl.beginReplay();
      ctrl.endReplay();
      expect(ctrl.state.fitSuppressed).toBe(false);
    });
  });

  describe('display:none scroll preservation (Issue #560)', () => {
    it('preserves tracked position when container becomes hidden', () => {
      const container = createMockContainer(true);
      const { ctrl, term } = createController({ container });
      ctrl.enterInteractive();

      // User scrolled to line 200
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 200;
      term._triggerScroll();
      expect(ctrl.state.viewportY).toBe(200);

      // Container becomes hidden (display:none)
      (container.getBoundingClientRect as ReturnType<typeof vi.fn>).mockReturnValue({
        width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0,
      });

      // xterm fires onScroll with viewportY=0 during display:none
      term.buffer.active.viewportY = 0;
      term._triggerScroll();

      // Tracked state should NOT have been updated (container was hidden)
      expect(ctrl.state.viewportY).toBe(200);
      expect(ctrl.state.wasAtBottom).toBe(false);
    });

    it('restores position from tracked state when container becomes visible again', () => {
      const container = createMockContainer(true);
      const { ctrl, term, fitAddon } = createController({ container });
      ctrl.enterInteractive();

      // User scrolled to line 200
      term.buffer.active.baseY = 500;
      term.buffer.active.viewportY = 200;
      term._triggerScroll();

      // Container hidden, xterm resets viewportY
      (container.getBoundingClientRect as ReturnType<typeof vi.fn>).mockReturnValue({
        width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0,
      });
      term.buffer.active.viewportY = 0;
      term._triggerScroll();

      // Container visible again
      (container.getBoundingClientRect as ReturnType<typeof vi.fn>).mockReturnValue({
        width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0,
      });

      term.scrollToLine.mockClear();
      fitAddon.fit.mockClear();

      // safeFit should restore to tracked position (200)
      ctrl.safeFit();
      expect(fitAddon.fit).toHaveBeenCalled();
      expect(term.scrollToLine).toHaveBeenCalledWith(200);
    });
  });

  describe('dispose', () => {
    it('disposes the onScroll subscription', () => {
      const term = createMockTerm();
      const disposeFn = vi.fn();
      term.onScroll.mockReturnValue({ dispose: disposeFn });

      const { ctrl } = createController({ term });
      ctrl.dispose();
      expect(disposeFn).toHaveBeenCalled();
    });
  });

  describe('structured logging', () => {
    it('logs to console.debug when debug=true', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const { ctrl, term } = createController({ debug: true });
      ctrl.enterInteractive();

      term.buffer.active.baseY = 100;
      term.buffer.active.viewportY = 50;
      term._triggerScroll();

      expect(debugSpy).toHaveBeenCalled();
      const calls = debugSpy.mock.calls.map(c => c[0]);
      expect(calls.some((c: string) => c.includes('[ScrollController]'))).toBe(true);
      debugSpy.mockRestore();
    });

    it('does not log to console.debug when debug=false', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const { ctrl } = createController({ debug: false });
      ctrl.enterInteractive();
      ctrl.safeFit();

      expect(debugSpy).not.toHaveBeenCalled();
      debugSpy.mockRestore();
    });
  });
});
