/**
 * Message formatting utilities for structured architect/builder messages.
 * Spec 0110: Messaging Infrastructure — Phase 2
 *
 * Shared between CLI (commands/send.ts) and Tower server (tower-routes.ts).
 */

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
 * Format a message from the architect to a builder.
 * Wraps in a structured header/footer unless raw mode is requested.
 */
export function formatArchitectMessage(message: string, fileContent?: string, raw: boolean = false): string {
  let content = message;
  if (fileContent) {
    content += '\n\nAttached content:\n```\n' + fileContent + '\n```';
  }

  if (raw) {
    return content;
  }

  const timestamp = new Date().toISOString();
  return `### [ARCHITECT INSTRUCTION | ${timestamp}] ###
${content}
###############################`;
}

/**
 * Format a message the VS Code extension relays on a human's behalf (#1494) to
 * the architect, e.g. the Approve-gate button. The distinct `[USER via VS Code]`
 * header lets the architect tell a button relay apart from a peer-architect
 * instruction or the user typing directly in the pane. Wraps in a structured
 * header/footer unless raw mode is requested.
 */
export function formatUserViaVsCodeMessage(message: string, fileContent?: string, raw: boolean = false): string {
  let content = message;
  if (fileContent) {
    content += '\n\nAttached content:\n```\n' + fileContent + '\n```';
  }

  if (raw) {
    return content;
  }

  const timestamp = new Date().toISOString();
  return `### [USER via VS Code | ${timestamp}] ###
${content}
###############################`;
}

/**
 * Format a message from a builder to the architect.
 * Wraps in a structured header/footer unless raw mode is requested.
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
  return `### [BUILDER ${builderId} MESSAGE | ${timestamp}] ###
${content}
###############################`;
}
