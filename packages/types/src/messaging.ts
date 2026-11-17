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

/**
 * Reserved `from` sender identity for the notice Tower sends the hub architect when the
 * owner submits a ruling from the dashboard's Decisions tab (#1828).
 *
 * Like {@link VSCODE_USER_SENDER}, Tower's `formatMessageForTarget` matches it and renders
 * a distinct `[USER via Decisions tab]` header, so the owner's word relayed by the tab is
 * never framed as a builder's message.
 */
export const DECISIONS_TAB_SENDER = 'decisions-tab';
