import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../ArtifactCanvas.js';
import type { AnnotationEntry, ReviewMarker } from '../../types.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Click-to-annotate (#1850, `annotationEntry: 'clickParagraph'`): a plain primary click on prose
 * opens the inline composer for the clicked block, the in-row "+" is never mounted, and only a
 * deliberate click counts (not a selection, not a dismissing click, not a double-click's second
 * click, not a modified click, not links / code / images / cards / the composer).
 */
const DOC = [
  'Plain text with a [link](https://example.com) and `chip` and ![pic](a.png).', // 0
  '<!-- REVIEW(@bob): first -->', // 1
  '',
  'Second paragraph.', // 3
  '',
  '```',
  'code',
  '```',
].join('\n');

const MARKERS: ReviewMarker[] = [
  { author: 'bob', line: 0, text: 'first', raw: '<!-- REVIEW(@bob): first -->', markerLine: 1 },
];

async function mount(annotationEntry?: AnnotationEntry) {
  const onAddComment = vi.fn();
  const onEditComment = vi.fn();
  render(
    <ArtifactCanvas
      uri="x"
      fileAdapter={{ read: vi.fn(async () => DOC), watch: vi.fn(() => ({ dispose: vi.fn() })) }}
      themeAdapter={{ resolve: vi.fn(() => ''), onChange: vi.fn(() => ({ dispose: vi.fn() })) }}
      markerAdapter={{ list: vi.fn(async () => MARKERS), add: vi.fn(async () => {}) }}
      onAddComment={onAddComment}
      onEditComment={onEditComment}
      annotationEntry={annotationEntry}
    />,
  );
  const paras = await waitFor(() => {
    const els = document.querySelectorAll<HTMLElement>('p[data-line]');
    if (els.length < 2) throw new Error('not rendered yet');
    if (!document.querySelector('.codev-canvas-marker-cards')) throw new Error('cards not injected yet');
    return Array.from(els);
  });
  return { first: paras[0], second: paras[1], onAddComment, onEditComment };
}

/** A real click sequence: press, release, click (detail 1 = a single pointer click). */
function click(target: Element, init: MouseEventInit = {}): void {
  fireEvent.mouseDown(target, { button: 0, ...init });
  fireEvent.mouseUp(target, { button: 0, ...init });
  fireEvent.click(target, { button: 0, detail: 1, ...init });
}

const composer = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>('.codev-canvas-comment-composer-input');

async function openComposerLabel(): Promise<string> {
  const ta = await waitFor(() => {
    const el = composer();
    if (!el) throw new Error('composer not open yet');
    return el;
  });
  return ta.getAttribute('aria-label')!;
}

/** Let any state update a click queued settle, then assert nothing opened. */
async function expectNoComposer(): Promise<void> {
  await act(async () => {});
  expect(composer()).toBeNull();
}

function stubSelection(collapsed: () => boolean): void {
  vi.spyOn(window, 'getSelection').mockImplementation(
    () => ({ get isCollapsed() { return collapsed(); } }) as unknown as Selection,
  );
}

describe('annotationEntry: clickParagraph (#1850)', () => {
  it('never mounts the "+", on hover or on focus', async () => {
    const { first, second } = await mount('clickParagraph');
    fireEvent.mouseOver(first);
    fireEvent.mouseMove(first);
    act(() => second.focus());
    expect(document.querySelector('.codev-canvas-add-comment')).toBeNull();
    expect(document.querySelector('.codev-canvas-row-affordance')).toBeNull();
  });

  it('a click on prose opens the composer for the clicked block', async () => {
    const { second } = await mount('clickParagraph');
    click(second);
    expect(await openComposerLabel()).toBe('Add comment on line 4');
  });

  it('submitting emits the add intent for that block', async () => {
    const { second, onAddComment } = await mount('clickParagraph');
    click(second);
    await openComposerLabel();
    fireEvent.change(composer()!, { target: { value: 'tighten this' } });
    fireEvent.keyDown(composer()!, { key: 'Enter', metaKey: true });
    expect(onAddComment).toHaveBeenCalledWith(3, 'tighten this');
  });

  it('ignores clicks on links, inline code, images and code blocks', async () => {
    const { first } = await mount('clickParagraph');
    // jsdom cannot navigate; keep the link click on the page (the canvas never prevents it).
    first.querySelector('a')!.addEventListener('click', (e) => e.preventDefault());
    for (const sel of ['a', 'code', 'img']) click(first.querySelector(sel)!);
    click(document.querySelector('pre')!);
    await expectNoComposer();
  });

  it('ignores clicks on comment cards, and the card edit button still edits', async () => {
    await mount('clickParagraph');
    const cards = document.querySelector('.codev-canvas-marker-cards')!;
    click(cards.querySelector('.codev-canvas-marker-card')!);
    await expectNoComposer();
    click(cards.querySelector('[data-action="edit"]')!);
    expect(await openComposerLabel()).toBe('Edit comment on line 1');
  });

  it('a click inside the open composer never retargets it', async () => {
    const { second } = await mount('clickParagraph');
    click(second);
    await openComposerLabel();
    click(composer()!);
    expect(await openComposerLabel()).toBe('Add comment on line 4');
  });

  it('does not open when the click ends a text selection', async () => {
    const { second } = await mount('clickParagraph');
    stubSelection(() => false);
    click(second);
    await expectNoComposer();
  });

  it('does not open on a click that only dismisses a selection; the next click does', async () => {
    const { second } = await mount('clickParagraph');
    let collapsed = false;
    stubSelection(() => collapsed);
    fireEvent.mouseDown(second, { button: 0 });
    collapsed = true; // the browser collapses the selection as the press's default action
    fireEvent.mouseUp(second, { button: 0 });
    fireEvent.click(second, { button: 0, detail: 1 });
    await expectNoComposer();
    click(second);
    expect(await openComposerLabel()).toBe('Add comment on line 4');
  });

  it('ignores modified clicks and the second click of a double-click', async () => {
    const { second } = await mount('clickParagraph');
    for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) click(second, { [mod]: true });
    fireEvent.click(second, { button: 0, detail: 2 });
    await expectNoComposer();
  });

  it('an empty open composer moves to the next clicked block', async () => {
    const { first, second } = await mount('clickParagraph');
    click(second);
    await openComposerLabel();
    click(first);
    await waitFor(() => expect(composer()?.getAttribute('aria-label')).toBe('Add comment on line 1'));
  });

  it('an open composer holding a draft ignores clicks elsewhere', async () => {
    const { first, second } = await mount('clickParagraph');
    click(second);
    await openComposerLabel();
    fireEvent.change(composer()!, { target: { value: 'half a thought' } });
    click(first);
    await act(async () => {});
    expect(composer()?.getAttribute('aria-label')).toBe('Add comment on line 4');
    expect(composer()?.value).toBe('half a thought');
  });

  it('Enter on a focused block still opens the composer', async () => {
    const { second } = await mount('clickParagraph');
    act(() => second.focus());
    fireEvent.keyDown(second, { key: 'Enter' });
    expect(await openComposerLabel()).toBe('Add comment on line 4');
  });
});

describe('annotationEntry: gutterButton (default)', () => {
  it('a click on prose opens nothing and the "+" still lights on hover', async () => {
    const { second } = await mount();
    click(second);
    await expectNoComposer();
    fireEvent.mouseOver(second);
    expect(document.querySelector('.codev-canvas-add-comment')).not.toBeNull();
  });
});
