/**
 * Message formatting utilities for structured architect/builder messages.
 * Spec 0110: Messaging Infrastructure — Phase 2
 *
 * Shared between CLI (commands/send.ts) and Tower server (tower-routes.ts).
 *
 * #1574: every wrapper is **self-attesting** — the header names the RECIPIENT
 * (`→ <toAgent>`) as well as the sender, so an agent reading a frame on its own
 * pane can verify the message was addressed to it. Before this, a misdelivery was
 * invisible to its victim (the one party positioned to detect it), and an agent
 * could confidently assert that builder-addressed traffic had landed on its
 * terminal with nothing on screen able to refute it. `toAgent` is REQUIRED, not
 * optional: a frame that silently omits the recipient is exactly the defect.
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
 * Hard ceiling on a single message BODY, in bytes (Issue #1573).
 *
 * Nothing between the CLI flag and the PTY bytes bounded message size before this: only
 * the generic 1 MiB HTTP body cap and the `--file` attachment cap. A body far past what a
 * composer can absorb is exactly the shape that arrived truncated in #1564 (a ~1,900-char
 * send landing as its final ~30 chars) — and it did so while the sender read
 * `[ok] Message delivered`. So the limit is enforced LOUDLY at both boundaries (the CLI,
 * so the failure is local and immediate, and `POST /api/send`, because the route is
 * public) and the message is NEVER silently truncated.
 *
 * The value matches the pre-existing `--file` attachment bound rather than inventing a
 * second number: `--file` content is appended to the body, so one shared ceiling is the
 * only way the two cannot disagree.
 */
export const MAX_MESSAGE_BYTES = 48 * 1024;

/** The over-limit error text, shared by the CLI precheck and the route (one wording). */
export function messageTooLargeError(bytes: number): string {
  return (
    `Message body is ${bytes} bytes, over the ${MAX_MESSAGE_BYTES}-byte (48KB) limit. ` +
    `A body this large cannot be typed into an agent's composer reliably — it is refused ` +
    `rather than silently truncated. Split it into smaller sends, or write it to a file ` +
    `and send the path for the agent to read.`
  );
}

/**
 * The over-limit error for `message`, or null when it is within the ceiling (Issue #1573).
 *
 * The one place the byte count and the ceiling meet, so every local boundary that sends a body
 * — `afx send`, `afx refresh`'s prompt + `--file` addendum — fails the same way with the same
 * wording, instead of some of them discovering the limit as a 400 from the route.
 */
export function messageLimitError(message: string): string | null {
  const bytes = Buffer.byteLength(message, 'utf8');
  return bytes > MAX_MESSAGE_BYTES ? messageTooLargeError(bytes) : null;
}

/**
 * Recipient segment of a header. Kept in one place so all variants agree.
 *
 * Empty is REFUSED, not rendered. The type system requires `toAgent`, but a
 * required-and-empty string yields `[BUILDER x MESSAGE →  | ts]` — a frame that
 * looks self-attesting and attests to nothing, which is the very defect class
 * #1574 exists to close. Same doctrine `reorient.ts` states for its frame:
 * presence of a label is not presence of a value. Throwing surfaces as a 500 to
 * the sender via `handleRequest`'s catch, BEFORE the row is enqueued — a loud
 * failure, never a bogus frame persisted or delivered.
 */
function recipient(toAgent: string): string {
  if (!toAgent) {
    throw new Error(
      'Cannot format a delivered message frame without a recipient. ' +
        'A frame that names no recipient cannot be verified by the agent reading it (#1574).',
    );
  }
  return ` → ${toAgent}`;
}

/**
 * The reply channel, stated at the point of need (#1574, closing the real #1530
 * defect). A builder instructed to "reply" has no reply affordance in its own
 * terminal — assistant text it types goes nowhere, silently. Porch phase prompts
 * teach `afx send architect`, but a task-lane builder never gets them, and any
 * builder loses them to a `/clear`. Carried on the frame, it survives both.
 */
export const REPLY_HINT = '(reply: afx send architect "…")';

/**
 * The closing delimiter. The builder-bound variant carries {@link REPLY_HINT} on
 * this SAME line rather than on a trailing one, and that is load-bearing: a fourth
 * line would push the frame past `PACED_WRITE_LINE_THRESHOLD` in `message-write.ts`,
 * moving every short architect→builder message off the single-write path onto the
 * paced line-by-line one. A formatter change must not widen the delivery-write
 * exposure window (#1521/#1573 family) as a side effect, so the frame stays 3 lines
 * and the write path stays byte-identical.
 */
const FOOTER = '###############################';

function withBody(message: string, fileContent?: string): string {
  if (!fileContent) return message;
  return message + '\n\nAttached content:\n```\n' + fileContent + '\n```';
}

/**
 * Format an architect-instruction frame.
 *
 * Carries NO reply hint: this variant also frames the unknown-sender → architect
 * fallback, and telling an architect to reply via `afx send architect` would point
 * it at itself. Builder-bound sends use {@link formatArchitectToBuilderMessage}.
 *
 * Wraps in a structured header/footer unless raw mode is requested.
 *
 * `sender` names the originating agent (issue #1478). It attributes the header when
 * it is an `architect:<name>` identity; raw mode stays unattributed, as before.
 */
export function formatArchitectMessage(
  toAgent: string,
  message: string,
  fileContent?: string,
  raw: boolean = false,
  sender?: string,
): string {
  const content = withBody(message, fileContent);

  if (raw) {
    return content;
  }

  const timestamp = new Date().toISOString();
  return `### [${architectHeaderLabel(sender)} INSTRUCTION${recipient(toAgent)} | ${timestamp}] ###
${content}
${FOOTER}`;
}

/**
 * Format a message from the architect to a BUILDER — the architect-instruction
 * frame with the reply hint on its closing delimiter line (#1574). The hint is
 * keyed to the recipient being a builder, not to who sent it: a builder is the
 * party with no reply affordance of its own, and it is the party that loses its
 * porch prompts to a `/clear`. `--raw` sends are unchanged — no wrapper, so no
 * hint. Line count is unchanged from the plain frame; see {@link FOOTER}.
 *
 * `sender` is passed straight through to {@link formatArchitectMessage} (issue #1478):
 * this variant IS the production any → builder path, so a name that stopped here would
 * never reach the surface the issue is about.
 */
export function formatArchitectToBuilderMessage(
  toAgent: string,
  message: string,
  fileContent?: string,
  raw: boolean = false,
  sender?: string,
): string {
  const frame = formatArchitectMessage(toAgent, message, fileContent, raw, sender);
  if (raw) return frame;
  return frame.slice(0, -FOOTER.length) + `${FOOTER}  ${REPLY_HINT}`;
}

/**
 * Format a message the VS Code extension relays on a human's behalf (#1494) to
 * the architect, e.g. the Approve-gate button. The distinct `[USER via VS Code]`
 * header lets the architect tell a button relay apart from a peer-architect
 * instruction or the user typing directly in the pane. Wraps in a structured
 * header/footer unless raw mode is requested.
 */
export function formatUserViaVsCodeMessage(toAgent: string, message: string, fileContent?: string, raw: boolean = false): string {
  const content = withBody(message, fileContent);

  if (raw) {
    return content;
  }

  const timestamp = new Date().toISOString();
  return `### [USER via VS Code${recipient(toAgent)} | ${timestamp}] ###
${content}
${FOOTER}`;
}

/**
 * Format a message from a builder to the architect.
 * Wraps in a structured header/footer unless raw mode is requested.
 *
 * `builderId` is the sender's identity; the header names its role from that shape
 * (see {@link senderHeaderLabel}), so an architect → architect send reads
 * `ARCHITECT:<name> MESSAGE` rather than being mislabelled `BUILDER architect:<name>`.
 */
export function formatBuilderMessage(builderId: string, toAgent: string, message: string, fileContent?: string, raw: boolean = false): string {
  const content = withBody(message, fileContent);

  if (raw) {
    return content;
  }

  const timestamp = new Date().toISOString();
  return `### [${senderHeaderLabel(builderId)} MESSAGE${recipient(toAgent)} | ${timestamp}] ###
${content}
${FOOTER}`;
}
