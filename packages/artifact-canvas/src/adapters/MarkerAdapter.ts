import type { ReviewMarker } from '../types.js';

/**
 * Reads and mutates review markers. Serialization is the implementation's concern (spec D3).
 *
 * In v1 the package calls only `list`; `add` is invoked by host glue code (spec D6 — the
 * overlay emits an `onAddComment` intent and the host performs the text input + write-back).
 *
 * Interface only — implementations live in the host.
 */
export interface MarkerAdapter {
  /** List the review markers currently present in `uri`. */
  list(uri: string): Promise<ReviewMarker[]>;
  /**
   * Write a new review marker. Host-invoked (spec D6); the package never calls this itself in
   * v1. Serialization (positional `<!-- REVIEW(@author): text -->` for the VSCode host, or any
   * other text form) is the implementation's choice.
   */
  add(uri: string, line: number, text: string, author: string): Promise<void>;

  // Reserved for later issues (declared optional so hosts may implement incrementally):
  // addRegion?(uri: string, lineStart: number, lineEnd: number, text: string, author: string): Promise<void>;
  // setCheckbox?(uri: string, line: number, checked: boolean): Promise<void>; // AC-progress (#862)
}
