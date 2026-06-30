import { describe, it, expect } from 'vitest';
import {
  serializeReviewMarker,
  parseReviewMarkers,
  markerInsertionLine,
  markerAppendLine,
  isReviewMarkerLine,
  isEligibleReviewPath,
} from '../review-markers.js';

describe('serializeReviewMarker', () => {
  it('produces the canonical positional form', () => {
    expect(serializeReviewMarker('amr', 'tighten this')).toBe(
      '<!-- REVIEW(@amr): tighten this -->',
    );
  });

  it('normalizes multi-line / collapsed whitespace to a single line', () => {
    expect(serializeReviewMarker('amr', '  line one\n  line two  ')).toBe(
      '<!-- REVIEW(@amr): line one line two -->',
    );
  });

  it('preserves a supplied indent (e.g. inside a list item)', () => {
    expect(serializeReviewMarker('amr', 'note', '    ')).toBe(
      '    <!-- REVIEW(@amr): note -->',
    );
  });
});

describe('parseReviewMarkers', () => {
  it('maps a marker to the line above it (fileLine - 1) and captures author + text', () => {
    // 0: # Heading
    // 1: <!-- REVIEW(@amr): on the heading -->
    const text = '# Heading\n<!-- REVIEW(@amr): on the heading -->';
    expect(parseReviewMarkers(text)).toEqual([
      { author: 'amr', line: 0, text: 'on the heading', raw: '<!-- REVIEW(@amr): on the heading -->' },
    ]);
  });

  it('skips a marker on line 0 (annotates nothing)', () => {
    expect(parseReviewMarkers('<!-- REVIEW(@amr): orphan -->\ntext')).toEqual([]);
  });

  it('anchors a STACK of comments on one block to that block (all to the same line)', () => {
    // Several comments on the same block stack as a run of marker lines; each
    // must skip over the markers above it and resolve to the block, not to the
    // adjacent marker. Otherwise the older comments orphan (no block at their line).
    const text = [
      'Paragraph.', // 0  the block
      '<!-- REVIEW(@a): first -->', // 1 -> skips none above -> line 0
      '<!-- REVIEW(@b): second -->', // 2 -> skips line 1 (marker) -> line 0
    ].join('\n');
    const markers = parseReviewMarkers(text);
    expect(markers.map((m) => [m.author, m.line, m.text])).toEqual([
      ['a', 0, 'first'],
      ['b', 0, 'second'],
    ]);
  });

  it('tolerates @-handles with dots and dashes and extra inner whitespace', () => {
    const text = 'x\n<!--  REVIEW (@a.b-c):   hello   -->';
    expect(parseReviewMarkers(text)).toEqual([
      { author: 'a.b-c', line: 0, text: 'hello', raw: '<!--  REVIEW (@a.b-c):   hello   -->' },
    ]);
  });
});

describe('round-trip (insert → parse)', () => {
  it('a marker written at the insertion line parses back to the annotated line', () => {
    // Author comments on logical line 0 (the heading).
    const original = '# Heading\nbody paragraph';
    const lines = original.split('\n');
    const insertAt = markerInsertionLine(0); // -> 1
    lines.splice(insertAt, 0, serializeReviewMarker('amr', 'fix the title'));
    const written = lines.join('\n');

    const markers = parseReviewMarkers(written);
    expect(markers).toHaveLength(1);
    expect(markers[0].line).toBe(0); // back to the heading
  });
});

describe('markerAppendLine (#1107 — append below an existing thread)', () => {
  it('equals markerInsertionLine when the block has no existing markers', () => {
    const text = '# Heading\nbody paragraph';
    expect(markerAppendLine(text, 0)).toBe(markerInsertionLine(0)); // -> 1
  });

  it('appends AFTER a run of stacked markers so the newest comment is last (regression for #1107)', () => {
    // Block on line 0 with two stacked markers on lines 1 and 2.
    const text = [
      '# Heading',
      serializeReviewMarker('a', 'first'),
      serializeReviewMarker('b', 'second'),
      'body paragraph',
    ].join('\n');
    // markerInsertionLine would prepend at line 1 (top of the thread); append lands at line 3.
    expect(markerInsertionLine(0)).toBe(1);
    const appendAt = markerAppendLine(text, 0);
    expect(appendAt).toBe(3);

    // Writing there keeps the existing two first and the new one last, in file/render order.
    const lines = text.split('\n');
    lines.splice(appendAt, 0, serializeReviewMarker('c', 'third'));
    const markers = parseReviewMarkers(lines.join('\n'));
    expect(markers.map((m) => m.text)).toEqual(['first', 'second', 'third']);
    expect(markers.every((m) => m.line === 0)).toBe(true); // all anchor to the heading
  });

  it('handles a block whose marker run reaches end-of-file', () => {
    const text = ['para', serializeReviewMarker('a', 'only')].join('\n'); // marker on the last line
    expect(markerAppendLine(text, 0)).toBe(2); // just past the run (end of file)
  });
});

describe('isReviewMarkerLine / isEligibleReviewPath', () => {
  it('detects marker lines', () => {
    expect(isReviewMarkerLine('  <!-- REVIEW(@a): x -->')).toBe(true);
    expect(isReviewMarkerLine('not a marker')).toBe(false);
    expect(isReviewMarkerLine('<!-- a normal comment -->')).toBe(false);
  });

  it('gates to codev plans/specs/reviews, normalizing backslashes', () => {
    expect(isEligibleReviewPath('/repo/codev/plans/42-x.md')).toBe(true);
    expect(isEligibleReviewPath('/repo/codev/specs/42-x.md')).toBe(true);
    expect(isEligibleReviewPath('/repo/codev/reviews/42-x.md')).toBe(true);
    expect(isEligibleReviewPath('C:\\repo\\codev\\plans\\42-x.md')).toBe(true);
    expect(isEligibleReviewPath('/repo/README.md')).toBe(false);
    expect(isEligibleReviewPath('/repo/codev/state/x.md')).toBe(false);
  });
});
