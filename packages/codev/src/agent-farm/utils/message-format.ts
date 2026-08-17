/**
 * Message formatting utilities for structured architect/builder messages.
 * Spec 0110: Messaging Infrastructure — Phase 2
 *
 * Shared between CLI (commands/send.ts) and Tower server (tower-routes.ts).
 */

/**
 * The header label for an architect-framed message (issue #1478).
 *
 * An architect sender travels as the address form `architect:<name>` (see
 * `commands/send.ts`), which we surface as `ARCHITECT:<name>` so the recipient can
 * tell WHICH architect is directing it — the same attribution builder → architect
 * messages have always carried. Any other sender (a builder → builder send, cron, or
 * an unattributed call) keeps the historical bare `ARCHITECT` label.
 */
export function architectHeaderLabel(sender?: string): string {
  const name = sender?.startsWith('architect:') ? sender.slice('architect:'.length).trim() : '';
  return name ? `ARCHITECT:${name}` : 'ARCHITECT';
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
