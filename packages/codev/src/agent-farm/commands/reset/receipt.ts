/**
 * The reset receipt gate — invariant R2 (Spec 1273).
 *
 * `afx refresh` clears a builder's context, which is irreversible. The manual
 * version of this flow guarded that step by eyeballing the state file ("ours was
 * 203 lines"). This module replaces the eyeball with evidence: a state file is
 * accepted only if it proves it is *this run's* save, is substantive, and has
 * stopped growing.
 *
 * Freshness comes from a nonce written INSIDE the file, not from mtime. mtime
 * was rejected deliberately: filesystem timestamp granularity and clock skew
 * make it fragile, and it cannot distinguish "rewritten in response to this
 * request" from "touched". A nonce the builder must reproduce can only appear
 * in a file written after the request that carried it.
 *
 * Pure: all filesystem access arrives through injected ports, so every rejection
 * path is testable without a real builder, a real worktree, or real time.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  DEFAULT_MIN_BYTES,
  DEFAULT_STABILITY_WINDOW_MS,
  STATE_FILE_NAME,
} from './constants.js';

// ============================================================================
// Ports
// ============================================================================

/** Filesystem access needed by the gate. Injected so tests need no real files. */
export interface ReceiptFsPort {
  /** Byte length of the file, or null when it does not exist. */
  sizeOf(path: string): number | null;
  /** Full contents, or null when the file does not exist. */
  read(path: string): string | null;
}

// ============================================================================
// Nonce
// ============================================================================

/**
 * Generate a per-run nonce.
 *
 * Short enough that a builder reproduces it without transcription errors, long
 * enough that a stale file from a previous reset cannot collide with it.
 */
export function generateNonce(): string {
  return randomBytes(6).toString('hex');
}

/**
 * The marker line the builder is asked to reproduce verbatim.
 *
 * An HTML comment so it is invisible in rendered markdown but trivially
 * greppable, and harmless if the file is later read by a human.
 */
export function nonceMarker(nonce: string): string {
  return `<!-- codev-reset: ${nonce} -->`;
}

// ============================================================================
// The save-state request
// ============================================================================

/**
 * Build the message asking the builder to write its working state.
 *
 * The checklist is the quality bar. It cannot be enforced programmatically (see
 * `verifyReceipt` — the gate is structural on purpose), so it has to be explicit
 * enough that a builder writing in good faith produces something a cold reader
 * can actually use.
 */
export function buildSaveRequest(nonce: string, statePath: string): string {
  return [
    'CONTEXT REFRESH INCOMING — save your working state now.',
    '',
    `Write your complete working state to \`${statePath}\` (untracked; do not stage or commit it).`,
    '',
    `The file MUST begin with this exact line, reproduced character for character:`,
    '',
    nonceMarker(nonce),
    '',
    'Everything after that line is yours. Write it **for a cold reader** — a competent',
    'agent who wakes up with your worktree, your branch, and no memory of this',
    'conversation. Assume nothing carries over. Cover:',
    '',
    '1. **Role and mission** — what you are building and why.',
    '2. **Position in the protocol** — phase, plan phase, what porch expects next.',
    '3. **Receipts** — what is actually done and verified, with file paths and commit',
    '   hashes. Distinguish "written" from "verified"; a cold reader cannot tell.',
    '4. **In-flight work** — anything started but not finished, and where it stands.',
    '5. **Open questions** — decisions you deferred, and what they hinge on.',
    '6. **Standing orders** — instructions from the architect you are still bound by,',
    '   including anything you were told NOT to do.',
    '7. **Next concrete action** — the single thing to do first after the refresh.',
    '',
    'Do not summarise for brevity. A save that omits a standing order or a receipt',
    'costs more than a long file does. When the file is written, stop and wait.',
  ].join('\n');
}

// ============================================================================
// Verification
// ============================================================================

/** Why a candidate state file was not accepted, or that it was. */
export type ReceiptStatus =
  | 'accepted'
  | 'missing'
  | 'wrong-nonce'
  | 'too-small'
  | 'still-growing';

export interface ReceiptObservation {
  status: ReceiptStatus;
  /** Size at the moment of observation, when the file existed. */
  bytes?: number;
}

export interface VerifyReceiptOptions {
  fs: ReceiptFsPort;
  statePath: string;
  nonce: string;
  minBytes?: number;
  /** A previous observation, for the stability comparison. */
  previous?: ReceiptObservation | null;
  /** ms since `previous` was taken. Stability needs a real gap, not two reads in a row. */
  msSincePrevious?: number;
  stabilityWindowMs?: number;
}

/**
 * Evaluate the state file once.
 *
 * Checks run in escalating order so the reported reason is the *most specific*
 * one true: existence, then freshness, then substance, then stability. A caller
 * polls this and only proceeds on `accepted`.
 *
 * Stability requires agreement between two observations separated by at least
 * `stabilityWindowMs`. Without the time gap, a builder mid-write would look
 * stable simply because two reads landed between the same two `write()` calls.
 */
export function verifyReceipt(options: VerifyReceiptOptions): ReceiptObservation {
  const {
    fs,
    statePath,
    nonce,
    minBytes = DEFAULT_MIN_BYTES,
    previous = null,
    msSincePrevious = 0,
    stabilityWindowMs = DEFAULT_STABILITY_WINDOW_MS,
  } = options;

  const bytes = fs.sizeOf(statePath);
  if (bytes === null) return { status: 'missing' };

  const content = fs.read(statePath);
  if (content === null) return { status: 'missing' };

  // The nonce must appear in the FIRST LINE — not merely somewhere in the file.
  //
  // "Somewhere" is trivially satisfied by echoing the save request back: that
  // text contains the marker and runs ~2KB, so `cp <request> .builder-state.md`
  // cleared every gate — nonce present, over the size floor, stable. That is not
  // an attack, it is what an agent does when it mistakes instructions for a
  // template, and the request already TELLS it the file "MUST begin with this
  // exact line". This enforces what we ask for.
  //
  // Still matched on the nonce TOKEN rather than the exact marker string, so a
  // builder that reproduces the nonce with different comment spacing is still
  // accepted — discarding a real save over whitespace would be a false rejection
  // of work that cost the builder real effort.
  const firstLine = content.split('\n', 1)[0] ?? '';
  if (!firstLine.includes(nonce)) return { status: 'wrong-nonce', bytes };

  if (bytes < minBytes) return { status: 'too-small', bytes };

  const stable =
    previous !== null &&
    previous.bytes === bytes &&
    (previous.status === 'still-growing' || previous.status === 'accepted') &&
    msSincePrevious >= stabilityWindowMs;

  if (!stable) return { status: 'still-growing', bytes };

  return { status: 'accepted', bytes };
}

/**
 * Human-readable explanation of a non-acceptance, for the abort message.
 *
 * Reset aborts loudly rather than clearing on a doubtful file, so the architect
 * needs to know which gate failed — "timed out" alone would not distinguish a
 * builder that never responded from one that wrote a stub.
 */
export function describeReceiptFailure(
  observation: ReceiptObservation,
  statePath: string,
  minBytes = DEFAULT_MIN_BYTES,
): string {
  switch (observation.status) {
    case 'missing':
      return `${statePath} was never written. The builder may not have read the request (if it is wedged mid-turn, retry with --interrupt-first).`;
    case 'wrong-nonce':
      return `${statePath} exists (${observation.bytes} bytes) but does not carry this run's nonce ON ITS FIRST LINE. Either it is stale (left by an earlier refresh) or the nonce appears further down — which happens when the save request is echoed back rather than answered. Refusing to clear on superseded or echoed state.`;
    case 'too-small':
      return `${statePath} carries the nonce but is only ${observation.bytes} bytes (minimum ${minBytes}). That is a stub, not a working-state save. Override with --min-bytes if this is genuinely all there was.`;
    case 'still-growing':
      return `${statePath} was still being written when the wait expired. Refusing to clear on a partial save.`;
    case 'accepted':
      return `${statePath} was accepted.`;
  }
}

/**
 * Absolute path of the state file for a worktree.
 *
 * Uses `path.join` rather than string concatenation: this path is handed to the
 * builder verbatim in the save request, so on Windows a hand-built
 * `C:\repo\wt\` + `/` + name would instruct the builder to write to a path that
 * is not the one the gate then stats. `path.join` also collapses redundant
 * separators, so a trailing slash on the worktree is harmless.
 */
export function stateFilePath(worktreePath: string, fileName = STATE_FILE_NAME): string {
  return join(worktreePath, fileName);
}
