/**
 * Review-marker codec — the single, host-agnostic home for the on-disk `REVIEW`
 * comment format and the transforms a rendered review surface needs.
 *
 * Background (#859): `@cluesmith/codev-artifact-canvas` renders Codev artifacts
 * (specs/plans/reviews) and lets a reviewer add inline comments. A comment is
 * serialized into the markdown as a positional HTML comment:
 *
 *     <!-- REVIEW(@<author>): <text> -->
 *
 * written on the line **after** the block it annotates. There is no `line=N`
 * attribute. The marker's *position in the file* is the entire line association:
 * a marker annotates the nearest non-marker line above it (so a stack of
 * comments on one block all resolve to that block). This convention
 * matches both the existing VSCode editor Comments-API path
 * (`packages/vscode/src/comments/plan-review.ts`) and the canvas package's own
 * tested adapter contract, so the two authoring surfaces round-trip through the
 * same bytes.
 *
 * This module lives in `core` (not in a host) because the convention is a
 * cross-host contract: the VSCode host consumes it now, and the dashboard /
 * future hosts consume the same functions so they cannot drift. It is pure
 * (no `vscode`, no DOM, no I/O) and therefore safe in both Node and the browser.
 *
 * Hiding markers from the rendered body is NOT done here: the canvas renderer
 * strips full-line HTML comments before parsing (keeping blocks intact and
 * `data-line` accurate), so hosts pass raw document text straight through. This
 * codec is purely the on-disk read/write convention (#1036 is fixed in the
 * renderer, #1042).
 */

/**
 * In-memory model of one review marker. Structurally matches
 * `ReviewMarker` from `@cluesmith/codev-artifact-canvas` (kept as a local
 * declaration so `core` does not depend on the React rendering package).
 */
export interface ReviewMarker {
  author: string;
  /** 0-based logical line the marker annotates (the line *above* the marker). */
  line: number;
  text: string;
  /** Original on-disk marker text, for lossless round-tripping. */
  raw: string;
  /** Reserved for region anchors (unused in v1). */
  lineRange?: { start: number; end: number };
}

/**
 * Eligible artifact paths — the `+` affordance and the canvas editor are gated
 * to these. Shared so the editor path and the canvas host agree on one rule.
 */
export const ELIGIBLE_PATH_REGEX = /\/codev\/(plans|specs|reviews)\//;

/**
 * Per-line marker matcher. Capture groups: [1] indent, [2] author, [3] body.
 * A marker occupies its own line by convention; the body is single-line
 * (whitespace-normalized at write time). Tolerant of surrounding whitespace to
 * stay compatible with markers authored by the editor path and by hand.
 */
const REVIEW_MARKER_RE = /^(\s*)<!--\s*REVIEW\s*\(@([^)]+)\)\s*:\s*([\s\S]*?)\s*-->\s*$/;

/** True if `fsPath` (forward-slash normalized or not) is a review-eligible artifact. */
export function isEligibleReviewPath(fsPath: string): boolean {
  return ELIGIBLE_PATH_REGEX.test(fsPath.replace(/\\/g, '/'));
}

/** True if a single line is a review marker. */
export function isReviewMarkerLine(line: string): boolean {
  return REVIEW_MARKER_RE.test(line);
}

/**
 * Serialize a marker to its canonical on-disk form. The body is
 * whitespace-normalized to a single line (markers are single-line by
 * convention; the canvas/editor decorations assume one line). `indent` is
 * prepended so a marker inside an indented list item keeps the list's
 * indentation.
 */
export function serializeReviewMarker(author: string, body: string, indent = ''): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  return `${indent}<!-- REVIEW(@${author}): ${normalized} -->`;
}

/**
 * The file line a new marker is written to, given the 0-based line it annotates:
 * the line *after* the annotated line. Encoded here so every caller (editor +
 * canvas host) shares one definition of the convention and cannot drift.
 */
export function markerInsertionLine(annotatedLine: number): number {
  return annotatedLine + 1;
}

/**
 * The file line a new marker should be written to so it **appends below** any markers already
 * stacked on `annotatedLine` — i.e. the line after the contiguous run of REVIEW markers that
 * immediately follows the annotated line. With no existing markers this is just
 * `markerInsertionLine(annotatedLine)`. Because markers render in file order (a run all anchors to
 * the block above it), appending after the run makes the newest comment the **last** card in the
 * block's thread. Shared in core so any host that appends to a thread agrees on the convention.
 * Pure (operates on the document text), so it is unit-testable without a host.
 */
export function markerAppendLine(text: string, annotatedLine: number): number {
  const lines = text.split('\n');
  let insertAt = markerInsertionLine(annotatedLine);
  while (insertAt < lines.length && isReviewMarkerLine(lines[insertAt])) {
    insertAt++;
  }
  return insertAt;
}

/**
 * Parse all review markers out of `text` into `ReviewMarker`s, mapping each to
 * the 0-based logical line it annotates: the nearest line ABOVE the marker that
 * is not itself a marker. Skipping over a run of stacked markers means several
 * comments on one block all anchor to that block's start (the canvas renders
 * them as a list) instead of each pointing at the marker above it. A marker, or
 * a run of markers, at the very top of the file annotates nothing and is skipped.
 */
export function parseReviewMarkers(text: string): ReviewMarker[] {
  const out: ReviewMarker[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = REVIEW_MARKER_RE.exec(lines[i]);
    if (!m) { continue; }
    let anchor = i - 1;
    while (anchor >= 0 && isReviewMarkerLine(lines[anchor])) { anchor--; }
    if (anchor < 0) { continue; }
    out.push({ author: m[2], line: anchor, text: m[3], raw: lines[i].trim() });
  }
  return out;
}

