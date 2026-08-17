/**
 * Message formatting utilities for structured architect/builder messages.
 * Spec 0110: Messaging Infrastructure — Phase 2
 *
 * Shared between CLI (commands/send.ts) and Tower server (tower-routes.ts).
 */

import { ARCHITECT_NAME_PATTERN, MAX_ARCHITECT_NAME_LENGTH } from './architect-name.js';

/**
 * The header label for an architect-framed message (issue #1478).
 *
 * An architect sender travels as the address form `architect:<name>` (see
 * `commands/send.ts`), which we surface as `ARCHITECT:<name>` so the recipient can
 * tell WHICH architect is directing it — the same attribution builder → architect
 * messages have always carried. Any other sender (a builder → builder send, cron, or
 * an unattributed call) keeps the historical bare `ARCHITECT` label.
 *
 * The name is VALIDATED before interpolation, not merely trimmed: `from` arrives from
 * a `POST /api/send` body, so an unchecked name could forge `### [...] ###` framing in
 * the recipient's composer. `ARCHITECT_NAME_PATTERN` is anchored `[a-z][a-z0-9-]*`, so
 * anything carrying a bracket, newline or space degrades to the bare label rather than
 * reaching the header. (`validateArchitectName` is deliberately NOT used here — it
 * rejects the reserved default `main`, which is the most common real sender.)
 */
export function architectHeaderLabel(sender?: string): string {
  // Case-insensitive prefix, because `parseAddress` treats addresses that way — a
  // hand-rolled `from: 'Architect:main'` must not be labelled a BUILDER. The NAME itself
  // stays strictly validated (the pattern is lowercase-only), so a mixed-case name is
  // not a real architect name and degrades to the bare label.
  if (!sender || !sender.toLowerCase().startsWith('architect:')) return 'ARCHITECT';
  const name = sender.slice('architect:'.length).trim();
  if (name.length > MAX_ARCHITECT_NAME_LENGTH || !ARCHITECT_NAME_PATTERN.test(name)) {
    return 'ARCHITECT';
  }
  return `ARCHITECT:${name}`;
}

/**
 * An agent identity safe to interpolate into `### [...] ###` framing: no newline, no
 * `#`, no bracket, no whitespace. Covers every real id — canonical `builder-<proto>-<n>`,
 * bare worktree names, `architect:<name>`, and the `af-cron` pseudo-sender.
 */
const SAFE_SENDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The role-and-identity label for ANY sender: `ARCHITECT[:<name>]` for an architect,
 * `BUILDER <id>` for everything else (builders, and the `af-cron` pseudo-sender).
 *
 * Without this, the architect → architect path renders an architect under a hardcoded
 * `BUILDER ` prefix — `### [BUILDER architect:main MESSAGE …] ###`, a wrong role paired
 * with a real identity (CMAP round 1, claude). The label follows the sender's shape, so
 * one rule covers every direction.
 *
 * Every branch validates before interpolating, so this is a total chokepoint: the
 * architect branch via {@link architectHeaderLabel}, the builder branch via
 * `SAFE_SENDER_ID`. Without the second check an identity that merely LOOKS architect-
 * shaped (`architect:x] ###…`) fails name validation and lands in the builder branch,
 * where it would forge framing verbatim — the hole predates this change on the
 * builder → architect path, but the chokepoint is the place to close it (CMAP round 2,
 * codex). An unshowable identity degrades to `BUILDER <unknown>`: the recipient sees an
 * unattributed message rather than a forged header.
 */
export function senderHeaderLabel(sender: string): string {
  const bare = sender.toLowerCase();
  if (bare === 'architect' || bare === 'arch') return 'ARCHITECT';
  const architect = architectHeaderLabel(sender);
  if (architect !== 'ARCHITECT') return architect;
  return SAFE_SENDER_ID.test(sender) ? `BUILDER ${sender}` : 'BUILDER <unknown>';
}

/**
 * Format a message from the architect to a builder.
 * Wraps in a structured header/footer unless raw mode is requested.
 *
 * `sender` names the originating agent (issue #1478). It attributes the header when
 * it is an `architect:<name>` identity; raw mode stays unattributed, as before.
 */
export function formatArchitectMessage(
  message: string,
  fileContent?: string,
  raw: boolean = false,
  sender?: string,
): string {
  let content = message;
  if (fileContent) {
    content += '\n\nAttached content:\n```\n' + fileContent + '\n```';
  }

  if (raw) {
    return content;
  }

  const timestamp = new Date().toISOString();
  return `### [${architectHeaderLabel(sender)} INSTRUCTION | ${timestamp}] ###
${content}
###############################`;
}

/**
 * Format a message from a builder to the architect.
 * Wraps in a structured header/footer unless raw mode is requested.
 *
 * `builderId` is the sender's identity; the header names its role from that shape
 * (see {@link senderHeaderLabel}), so an architect → architect send reads
 * `ARCHITECT:<name> MESSAGE` rather than being mislabelled `BUILDER architect:<name>`.
 */
export function formatBuilderMessage(builderId: string, message: string, fileContent?: string, raw: boolean = false): string {
  let content = message;
  if (fileContent) {
    content += '\n\nAttached content:\n```\n' + fileContent + '\n```';
  }

  if (raw) {
    return content;
  }

  const timestamp = new Date().toISOString();
  return `### [${senderHeaderLabel(builderId)} MESSAGE | ${timestamp}] ###
${content}
###############################`;
}
