/**
 * Remote command channel (spec 1401, phase 3).
 *
 * Proves that a host driving the canvas through `CommandAdapter` gets the same effects the
 * keyboard produces, that relative commands are well-defined on a view nobody has touched yet,
 * and that `count` repeats traversal commands only.
 *
 * The keyboard equivalents themselves are already covered by the existing suites; what is new
 * here is the remote path, so these tests assert through the adapter rather than through keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../components/ArtifactCanvas.js';
import type { CanvasCommandInvocation, CommandAdapter } from '../adapters/CommandAdapter.js';
import { SAMPLE_ARTIFACT } from './fixtures/sample-artifact.js';
import { createStubHost } from './fixtures/stub-adapters.js';

afterEach(cleanup);

// jsdom doesn't implement scrollIntoView, and every focus move calls it, so install a mock for
// the whole file (same approach as the minimap suite) and restore afterwards.
let originalScrollIntoView: typeof Element.prototype.scrollIntoView;
beforeEach(() => {
  originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

/** A host-side command channel the test drives directly, mirroring what a real host wires up. */
function createCommandChannel() {
  let deliver: ((invocation: CanvasCommandInvocation) => void) | null = null;
  let disposed = false;
  const adapter: CommandAdapter = {
    subscribe(onCommand) {
      deliver = onCommand;
      return {
        dispose: () => {
          disposed = true;
          deliver = null;
        },
      };
    },
  };
  return {
    adapter,
    send(command: CanvasCommandInvocation['command'], count?: number) {
      if (!deliver) throw new Error('canvas never subscribed to the command adapter');
      deliver({ command, count });
    },
    get subscribed() {
      return deliver !== null;
    },
    get disposed() {
      return disposed;
    },
  };
}

function mount(initial = SAMPLE_ARTIFACT) {
  const host = createStubHost(initial);
  const channel = createCommandChannel();
  const onAddComment = vi.fn((line: number, text: string) => {
    void host.markerAdapter.add('artifact://sample.md', line, text, 'reviewer');
  });
  const onReadingModeChange = vi.fn();
  render(
    <ArtifactCanvas
      uri="artifact://sample.md"
      fileAdapter={host.fileAdapter}
      markerAdapter={host.markerAdapter}
      themeAdapter={host.themeAdapter}
      onAddComment={onAddComment}
      onReadingModeChange={onReadingModeChange}
      commandAdapter={channel.adapter}
    />,
  );
  return { host, channel, onAddComment, onReadingModeChange };
}

async function rendered(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-line]');
    if (!el) throw new Error('canvas has not rendered yet');
    return el;
  });
}

function focusedLine(): string | null {
  return document.activeElement?.closest?.('[data-line]')?.getAttribute('data-line') ?? null;
}

function lineOf(text: string): string {
  const el = screen.getByText(text, { exact: false }).closest('[data-line]');
  if (!el) throw new Error(`no [data-line] block for "${text}"`);
  return el.getAttribute('data-line') as string;
}

describe('remote command channel', () => {
  it('subscribes on mount and disposes on unmount', async () => {
    const { channel } = mount();
    await rendered();
    expect(channel.subscribed).toBe(true);
    cleanup();
    expect(channel.disposed).toBe(true);
  });

  // The feature's primary scenario: a controller drives a canvas nobody has clicked into, so
  // there is no DOM focus and no hover. Literal keyboard parity would no-op here (the key
  // handlers derive their origin from the event target), which is why the cursor falls back to
  // the topmost visible block.
  it('navigates from a clean, never-focused view', async () => {
    const { channel } = mount();
    await rendered();
    expect(focusedLine()).toBeNull();

    channel.send('block-next');
    expect(focusedLine()).not.toBeNull();
  });

  it('walks blocks forward and back, without wrapping at the edges', async () => {
    const { channel } = mount();
    await rendered();

    channel.send('doc-start');
    const first = focusedLine();
    channel.send('block-prev');
    expect(focusedLine()).toBe(first); // already at the start: a no-op, not a wrap

    channel.send('block-next');
    const second = focusedLine();
    expect(second).not.toBe(first);
    channel.send('block-prev');
    expect(focusedLine()).toBe(first);
  });

  it('jumps to the commented block and to headings', async () => {
    const { channel } = mount();
    await rendered();

    channel.send('doc-start');
    channel.send('comment-next');
    // The fixture's only marker annotates the "## Summary" heading.
    expect(focusedLine()).toBe(lineOf('Summary'));

    channel.send('doc-start');
    channel.send('heading-next');
    expect(focusedLine()).toBe(lineOf('Summary'));
  });

  it('jumps backwards to the previous commented block and heading', async () => {
    const { channel } = mount();
    await rendered();

    channel.send('doc-end');
    channel.send('comment-prev');
    expect(focusedLine()).toBe(lineOf('Summary'));

    channel.send('doc-end');
    channel.send('heading-prev');
    // The last heading before the end of the fixture is "## Requirements".
    expect(focusedLine()).toBe(lineOf('Requirements'));
  });

  it('does not wrap when a backwards jump has nowhere to go', async () => {
    const { channel } = mount();
    await rendered();

    channel.send('doc-start');
    const first = focusedLine();
    channel.send('comment-prev');
    expect(focusedLine()).toBe(first);
    channel.send('heading-prev');
    expect(focusedLine()).toBe(first);
  });

  it('moves to the document start and end', async () => {
    const { channel } = mount();
    await rendered();

    channel.send('doc-end');
    const last = focusedLine();
    channel.send('doc-start');
    const first = focusedLine();
    expect(first).not.toBe(last);
    expect(Number(first)).toBeLessThan(Number(last));
  });

  it('repeats traversal commands with count, clamping at the edge', async () => {
    const { channel } = mount();
    await rendered();

    channel.send('doc-start');
    channel.send('block-next', 3);
    const afterCounted = focusedLine();

    channel.send('doc-start');
    channel.send('block-next');
    channel.send('block-next');
    channel.send('block-next');
    expect(focusedLine()).toBe(afterCounted); // count: 3 === three single steps

    // A count past the end stops at the last block rather than running off it.
    channel.send('doc-start');
    channel.send('block-next', 9999);
    const clamped = focusedLine();
    channel.send('doc-end');
    expect(focusedLine()).toBe(clamped);
  });

  it('ignores count on non-traversal commands rather than rejecting it', async () => {
    const { channel, onReadingModeChange } = mount();
    await rendered();

    // Validation belongs to the sender; a command that reached the canvas already passed it, so
    // the canvas applies the command once and drops the meaningless count.
    channel.send('reading-mode-toggle', 5);
    expect(onReadingModeChange).toHaveBeenCalledTimes(1);
  });

  it('ignores a count that is not a positive integer', async () => {
    const { channel } = mount();
    await rendered();

    channel.send('doc-start');
    channel.send('block-next', 0);
    const afterZero = focusedLine();

    channel.send('doc-start');
    channel.send('block-next');
    expect(focusedLine()).toBe(afterZero); // 0 fell back to a single step
  });

  it('toggles reading mode', async () => {
    const { channel, onReadingModeChange } = mount();
    await rendered();

    channel.send('reading-mode-toggle');
    expect(onReadingModeChange).toHaveBeenLastCalledWith('horizontal');
    channel.send('reading-mode-toggle');
    expect(onReadingModeChange).toHaveBeenLastCalledWith('vertical');
  });

  it('opens the composer on the current block', async () => {
    const { channel } = mount();
    await rendered();

    channel.send('doc-start');
    channel.send('composer-open');
    await waitFor(() => {
      expect(document.querySelector('.codev-canvas-comment-composer')).not.toBeNull();
    });
  });

  // The composer commands are VIEW-scoped, not focus-scoped: a remote driver never moved focus
  // into the textarea, so requiring focus there would make them unusable.
  it('submits the typed draft with focus parked outside the composer', async () => {
    const { channel, onAddComment } = mount();
    await rendered();

    channel.send('doc-start');
    const target = focusedLine();
    channel.send('composer-open');
    const textarea = await waitFor(() => {
      const el = document.querySelector<HTMLTextAreaElement>('.codev-canvas-comment-composer-input');
      if (!el) throw new Error('composer did not open');
      return el;
    });

    fireEvent.change(textarea, { target: { value: 'remote comment' } });
    // Park focus away from the composer, the way a remote-driven session leaves it.
    document.querySelector<HTMLElement>(`[data-line="${target}"]`)?.focus();

    channel.send('composer-submit');
    await waitFor(() => {
      expect(onAddComment).toHaveBeenCalledWith(Number(target), 'remote comment');
    });
    expect(onAddComment).toHaveBeenCalledTimes(1);
  });

  it('cancels an open composer and writes nothing', async () => {
    const { channel, onAddComment } = mount();
    await rendered();

    channel.send('doc-start');
    channel.send('composer-open');
    await waitFor(() => {
      expect(document.querySelector('.codev-canvas-comment-composer')).not.toBeNull();
    });

    channel.send('composer-cancel');
    await waitFor(() => {
      expect(document.querySelector('.codev-canvas-comment-composer')).toBeNull();
    });
    expect(onAddComment).not.toHaveBeenCalled();
  });

  it('treats composer submit and cancel with no composer open as defined no-ops', async () => {
    const { channel, onAddComment } = mount();
    await rendered();

    channel.send('composer-submit');
    channel.send('composer-cancel');
    expect(onAddComment).not.toHaveBeenCalled();
    expect(document.querySelector('.codev-canvas-comment-composer')).toBeNull();
  });

  it('submits nothing when the draft is empty, matching the keyboard', async () => {
    const { channel, onAddComment } = mount();
    await rendered();

    channel.send('doc-start');
    channel.send('composer-open');
    await waitFor(() => {
      expect(document.querySelector('.codev-canvas-comment-composer')).not.toBeNull();
    });

    channel.send('composer-submit');
    expect(onAddComment).not.toHaveBeenCalled();
  });

  // Context-aware composer control (#1420). The canvas resolves open-vs-submit against its own
  // composer state, so one gesture opens then submits without the controller tracking anything.
  it('opens the composer when none is open (composer-open-or-submit)', async () => {
    const { channel } = mount();
    await rendered();

    channel.send('doc-start');
    channel.send('composer-open-or-submit');
    await waitFor(() => {
      expect(document.querySelector('.codev-canvas-comment-composer')).not.toBeNull();
    });
  });

  it('submits the open composer on a second composer-open-or-submit', async () => {
    const { channel, onAddComment } = mount();
    await rendered();

    channel.send('doc-start');
    const target = focusedLine();
    // First press opens at the focused block.
    channel.send('composer-open-or-submit');
    const textarea = await waitFor(() => {
      const el = document.querySelector<HTMLTextAreaElement>('.codev-canvas-comment-composer-input');
      if (!el) throw new Error('composer did not open');
      return el;
    });

    fireEvent.change(textarea, { target: { value: 'dictated comment' } });
    // Park focus away from the composer, the way a remote-driven session leaves it.
    document.querySelector<HTMLElement>(`[data-line="${target}"]`)?.focus();

    // Second press submits — the canvas saw the composer open and routed to submit, not re-open.
    channel.send('composer-open-or-submit');
    await waitFor(() => {
      expect(onAddComment).toHaveBeenCalledWith(Number(target), 'dictated comment');
    });
    expect(onAddComment).toHaveBeenCalledTimes(1);
  });

  // The draft-safety ruling: a press on an open-but-empty composer must neither submit nor discard
  // the draft. Submit is CommentComposer's own no-op on empty, and the open branch is never taken
  // while the composer is open, so the composer stays mounted.
  it('leaves an empty open composer mounted and writes nothing (composer-open-or-submit)', async () => {
    const { channel, onAddComment } = mount();
    await rendered();

    channel.send('doc-start');
    channel.send('composer-open-or-submit');
    await waitFor(() => {
      expect(document.querySelector('.codev-canvas-comment-composer')).not.toBeNull();
    });

    // Composer open, draft empty: the press is a no-op that keeps the composer (and its draft) alive.
    channel.send('composer-open-or-submit');
    expect(onAddComment).not.toHaveBeenCalled();
    expect(document.querySelector('.codev-canvas-comment-composer')).not.toBeNull();
  });

  // Column paging is meaningful only in horizontal mode; jsdom cannot measure column geometry,
  // so the real paging assertion lives in the Playwright suite. What matters here is that the
  // command is safe to send in vertical mode.
  it('leaves column paging a safe no-op in vertical mode', async () => {
    const { channel } = mount();
    const block = await rendered();
    const body = block.closest('.codev-artifact-canvas-body') as HTMLElement;

    channel.send('doc-start');
    const before = focusedLine();
    // A vertical layout can still scroll horizontally (a wide table, a long code line), so give
    // the body a non-zero scroll position and assert paging does not move it. Without the
    // mode check in the action this passes only because jsdom reports zero geometry.
    body.scrollLeft = 40;
    channel.send('column-forward');
    channel.send('column-back');
    expect(body.scrollLeft).toBe(40);
    expect(focusedLine()).toBe(before);
  });

  it('stops a counted command once it stops making progress', async () => {
    const { channel } = mount();
    await rendered();

    // A huge count must not walk a million steps over a handful of blocks. The loop breaks as
    // soon as a step changes nothing, so this returns promptly and lands on the last block.
    channel.send('doc-start');
    const started = Date.now();
    channel.send('block-next', 1_000_000);
    const elapsed = Date.now() - started;
    const landed = focusedLine();

    channel.send('doc-end');
    expect(focusedLine()).toBe(landed);
    expect(elapsed).toBeLessThan(1000);
  });

  it('reports a thrown error through onError instead of escaping the host callback', async () => {
    const host = createStubHost(SAMPLE_ARTIFACT);
    const channel = createCommandChannel();
    const onError = vi.fn();
    // Reading-mode changes are the cheapest place to inject a host failure.
    render(
      <ArtifactCanvas
        uri="artifact://sample.md"
        fileAdapter={host.fileAdapter}
        markerAdapter={host.markerAdapter}
        themeAdapter={host.themeAdapter}
        onAddComment={vi.fn()}
        onReadingModeChange={() => {
          throw new Error('host blew up');
        }}
        onError={onError}
        commandAdapter={channel.adapter}
      />,
    );
    await rendered();

    expect(() => channel.send('reading-mode-toggle')).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  // Guards the stale-closure trap: `canvasActions` is rebuilt every render, so a subscription
  // that captured it once would keep running the FIRST render's actions. Driving the canvas
  // after a state change that re-renders it proves dispatch reads the current ones.
  it('runs current actions after a re-render, not the ones captured at subscribe time', async () => {
    const { channel, onReadingModeChange } = mount();
    await rendered();

    // Re-render by toggling mode, then drive again: a stale closure would still hold the
    // original `readingMode` and report 'horizontal' a second time.
    channel.send('reading-mode-toggle');
    expect(onReadingModeChange).toHaveBeenLastCalledWith('horizontal');
    channel.send('reading-mode-toggle');
    expect(onReadingModeChange).toHaveBeenLastCalledWith('vertical');
    channel.send('reading-mode-toggle');
    expect(onReadingModeChange).toHaveBeenLastCalledWith('horizontal');
  });

  // The spec's non-goal: remote block traversal must not be implemented by hijacking Tab, which
  // also visits the "+" affordance, card actions, the toolbar and links.
  it('does not intercept Tab', async () => {
    const { channel } = mount();
    const block = await rendered();

    channel.send('doc-start');
    const before = focusedLine();
    const handled = fireEvent.keyDown(block, { key: 'Tab' });
    // fireEvent returns false only when preventDefault was called; the canvas must leave Tab to
    // the browser, and focus must not have moved as a side effect.
    expect(handled).toBe(true);
    expect(focusedLine()).toBe(before);
  });

  it('leaves behavior unchanged when no command adapter is supplied', async () => {
    const host = createStubHost(SAMPLE_ARTIFACT);
    render(
      <ArtifactCanvas
        uri="artifact://sample.md"
        fileAdapter={host.fileAdapter}
        markerAdapter={host.markerAdapter}
        themeAdapter={host.themeAdapter}
        onAddComment={vi.fn()}
      />,
    );
    await rendered();
    expect(document.querySelector('[data-line]')).not.toBeNull();
  });
});
