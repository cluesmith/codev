/**
 * Message formatting utilities for structured architect/builder messages.
 * Spec 0110: Messaging Infrastructure — Phase 2
 *
 * Shared between CLI (commands/send.ts) and Tower server (tower-routes.ts).
 */

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
