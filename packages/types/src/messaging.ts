/**
 * Reserved `from` sender identity for messages the VS Code extension relays on a
 * human's behalf, such as the Approve-gate button (#1494).
 *
 * Tower's message formatter recognizes this value and renders a distinct
 * `[USER via VS Code]` header, so the recipient (an architect) can tell a button
 * relay apart from a peer-architect instruction or the user typing in the pane.
 * It is a shared wire contract: the extension sets it as `from`, and Tower's
 * `formatMessageForTarget` matches it. Not a builder id, so it bypasses the
 * builder-spoofing check like any other non-builder sender.
 */
export const VSCODE_USER_SENDER = 'vscode-user';
