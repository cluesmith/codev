import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import * as React from 'react';
import { ArtifactCanvas } from '../ArtifactCanvas.js';
import type { ReviewMarker } from '../../types.js';

afterEach(cleanup);

/**
 * #1055: the preview card's edit/delete affordances must emit the intent for the SPECIFIC marker
 * (by its own physical file `markerLine`), so stacked comments are individually addressable. This
 * exercises the card → intent wiring end-to-end in jsdom: a stack of three comments on one block,
 * acting on the second must carry markerLine #2 and its author/body, not the first or third.
 */

// Replica of core's parseReviewMarkers, INCLUDING markerLine (the physical file line) — the field
// that makes the affordances render and gives them their identity.
const RE = /^(\s*)<!--\s*REVIEW\s*\(@([^)]+)\)\s*:\s*([\s\S]*?)\s*-->\s*$/;
function parse(text: string): ReviewMarker[] {
  const lines = text.split('\n');
  const out: ReviewMarker[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RE.exec(lines[i]);
    if (!m) continue;
    let anchor = i - 1;
    while (anchor >= 0 && RE.test(lines[anchor])) anchor--;
    if (anchor < 0) continue;
    out.push({ author: m[2], line: anchor, text: m[3], raw: lines[i].trim(), markerLine: i });
  }
  return out;
}

const STACK = [
  'Paragraph.', // 0  the block
  '<!-- REVIEW(@bob): first -->', // 1
  '<!-- REVIEW(@carol): second -->', // 2
  '<!-- REVIEW(@dave): third -->', // 3
].join('\n');

function renderCanvas(opts: {
  onEditComment?: (markerLine: number, author: string, bodyPrefix: string, newBody: string) => void;
  onDeleteComment?: (markerLine: number, author: string, bodyPrefix: string) => void;
}) {
  const content = STACK;
  const fileAdapter = { read: async () => content, watch: () => ({ dispose: () => {} }) };
  const markerAdapter = { list: async () => parse(content), add: async () => {} };
  const themeAdapter = { resolve: () => '', onChange: () => ({ dispose: () => {} }) };
  return render(
    React.createElement(ArtifactCanvas, {
      uri: 'codev:markdown-preview',
      fileAdapter,
      markerAdapter,
      themeAdapter,
      onAddComment: () => {},
      onEditComment: opts.onEditComment as never,
      onDeleteComment: opts.onDeleteComment,
      refreshKey: 0,
    }),
  );
}

describe('preview card edit/delete affordances (#1055)', () => {
  it('delete on the second-of-three emits markerLine #2 with carol/second', async () => {
    const onDeleteComment = vi.fn();
    renderCanvas({ onDeleteComment });
    await waitFor(() => expect(screen.getByLabelText('Delete comment by carol')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Delete comment by carol'));

    expect(onDeleteComment).toHaveBeenCalledTimes(1);
    expect(onDeleteComment).toHaveBeenCalledWith(2, 'carol', 'second');
  });

  it('edit on the second-of-three opens the composer prefilled and emits markerLine #2', async () => {
    const onEditComment = vi.fn();
    renderCanvas({ onEditComment });
    await waitFor(() => expect(screen.getByLabelText('Edit comment by carol')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Edit comment by carol'));

    // The composer opens seeded with the current body ("second") for the block on line 0 → label "line 1".
    const textarea = (await screen.findByLabelText('Edit comment on line 1')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('second');

    fireEvent.change(textarea, { target: { value: 'second (edited)' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    expect(onEditComment).toHaveBeenCalledTimes(1);
    expect(onEditComment).toHaveBeenCalledWith(2, 'carol', 'second', 'second (edited)');
  });

  it('re-seeds the composer when switching to a DIFFERENT card on the SAME block (no stale text — #1055 codex finding)', async () => {
    const onEditComment = vi.fn();
    renderCanvas({ onEditComment });
    await waitFor(() => expect(screen.getByLabelText('Edit comment by bob')).toBeTruthy());

    // Open the composer on the first card (bob/"first"), without saving.
    fireEvent.click(screen.getByLabelText('Edit comment by bob'));
    let textarea = (await screen.findByLabelText('Edit comment on line 1')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('first');

    // Now click edit on the SECOND card (carol/"second") — same block (line 0), so composingLine is
    // unchanged. Without the remount fix the textarea would still show "first".
    fireEvent.click(screen.getByLabelText('Edit comment by carol'));
    textarea = (await screen.findByLabelText('Edit comment on line 1')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('second');

    // Editing + saving targets carol's marker (#2) with carol's text, not bob's stale "first".
    fireEvent.change(textarea, { target: { value: 'second (edited)' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onEditComment).toHaveBeenCalledWith(2, 'carol', 'second', 'second (edited)');
  });

  it('renders NO affordances when the host provides no edit/delete callbacks (read-only host)', async () => {
    renderCanvas({});
    await waitFor(() => expect(screen.getByLabelText(/comments on line/i)).toBeTruthy());
    expect(screen.queryByLabelText('Delete comment by carol')).toBeNull();
    expect(screen.queryByLabelText('Edit comment by carol')).toBeNull();
  });

  it('shows only delete when only onDeleteComment is provided', async () => {
    renderCanvas({ onDeleteComment: vi.fn() });
    await waitFor(() => expect(screen.getByLabelText('Delete comment by carol')).toBeTruthy());
    expect(screen.queryByLabelText('Edit comment by carol')).toBeNull();
  });
});
