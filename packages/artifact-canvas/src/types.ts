/**
 * Core data types for @cluesmith/codev-artifact-canvas.
 *
 * These are the locked public contract from spec-945 (the adapter interfaces live in
 * ./adapters). Field names are part of the contract — do not change shapes without a
 * spec amendment.
 *
 * Contract amendment (#1053): the public `--codev-canvas-*` token vocabulary (spec 945 D4)
 * gained a typography tier — font size/family, line-height, paragraph spacing, an optional
 * prose-width cap, per-level heading sizes, and code font family/size — plus one color token,
 * `--codev-canvas-code-foreground` (inline-code text, paired with the code background for
 * dark-mode contrast). The tokens are CSS custom properties, not a TypeScript shape, so no
 * interface here changed; the vocabulary and its github-markdown-css baseline are documented in
 * `styles/default-theme.css` and the README.
 */

import type { FileAdapter } from './adapters/FileAdapter.js';
import type { MarkerAdapter } from './adapters/MarkerAdapter.js';
import type { ThemeAdapter } from './adapters/ThemeAdapter.js';

/**
 * Disposable handle returned by subscriptions; mirrors VSCode's `Disposable` shape.
 * Implementations MUST make `dispose()` idempotent — calling it more than once is a safe
 * no-op (spec D2).
 */
export interface Disposable {
  dispose(): void;
}

/**
 * In-memory model of a review marker. The package is serialization-agnostic (spec D3): the
 * host's `MarkerAdapter` owns the on-disk byte form; `raw` preserves the original marker text
 * for lossless round-tripping.
 */
export interface ReviewMarker {
  author: string;
  /** 0-based source line, matching the renderer's `data-line` (spec D5). */
  line: number;
  text: string;
  /** The original on-disk marker text (e.g. `<!-- REVIEW(@a): … -->`) for round-tripping. */
  raw: string;
  /** Reserved for region anchors (not used in v1). */
  lineRange?: { start: number; end: number };
}

/**
 * Public props of the React canvas component — the host-facing contract.
 *
 * `onAddComment` is the single canonical comment-intent seam (spec D6): the canvas collects the
 * body via its inline composer (#1107) and calls this with the 0-based line **and** the trimmed
 * text; the host writes the marker via its own `MarkerAdapter.add(...)`. The package never calls
 * `add` itself. (Contract amendment #1107: the seam gained the `text` argument when the text input
 * moved from the host's `showInputBox` into the canvas's inline composer.)
 */
export interface ArtifactCanvasProps {
  /** Host-opaque document identifier; the package never interprets it as a filesystem path. */
  uri: string;
  fileAdapter: FileAdapter;
  markerAdapter: MarkerAdapter;
  themeAdapter: ThemeAdapter;
  /** Comment-intent event (spec D6); `line` is 0-based (spec D5), `text` is the trimmed body (#1107). */
  onAddComment(line: number, text: string): void;
  /** Optional host error sink; the package never throws out of an event handler (spec D2). */
  onError?(err: unknown): void;
  /**
   * Optional refresh token (spec D6). A host **without** a `FileAdapter` watcher forces a
   * re-read + re-list by passing a **new** value here (a number or string) whenever its
   * underlying data changes. Hosts with a watcher can omit it — behavior is unchanged.
   */
  refreshKey?: number | string;
}
