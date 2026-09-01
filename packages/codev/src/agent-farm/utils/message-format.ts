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
 */
export function formatArchitectMessage(toAgent: string, message: string, fileContent?: string, raw: boolean = false): string {
  const content = withBody(message, fileContent);

  if (raw) {
    return content;
  }

  const timestamp = new Date().toISOString();
  return `### [ARCHITECT INSTRUCTION${recipient(toAgent)} | ${timestamp}] ###
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
 */
export function formatArchitectToBuilderMessage(toAgent: string, message: string, fileContent?: string, raw: boolean = false): string {
  const frame = formatArchitectMessage(toAgent, message, fileContent, raw);
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
 */
export function formatBuilderMessage(builderId: string, toAgent: string, message: string, fileContent?: string, raw: boolean = false): string {
  const content = withBody(message, fileContent);

  if (raw) {
    return content;
  }

  const timestamp = new Date().toISOString();
  return `### [BUILDER ${builderId} MESSAGE${recipient(toAgent)} | ${timestamp}] ###
${content}
${FOOTER}`;
}
