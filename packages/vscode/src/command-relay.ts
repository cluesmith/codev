import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandRequest } from '@cluesmith/codev-types';
import { COMMAND_EVENT } from '@cluesmith/codev-types';
import { parseSseEnvelope, parseSseBody } from './sse-envelope.js';
import type { ConnectionManager } from './connection-manager.js';

/**
 * VSCode as a COMMAND PROVIDER for Tower's command relay.
 *
 * A controller (an external control device or companion app) drives the active
 * provider over Tower's existing channel: Tower pushes a `command` SSE envelope
 * (via connectionManager.onSSEEvent) carrying a CANONICAL VERB, not a VSCode
 * command id.
 *
 * VERB_COMMANDS is how *this* provider implements each verb, and it doubles as
 * the security allowlist: a verb absent from the map is ignored, so a compromised
 * Tower or a stray broadcast cannot drive an arbitrary VSCode command. Another
 * provider (the web dashboard) would implement the same verbs its own way.
 *
 * Self-gates on focus so multi-window setups run a relayed verb exactly once.
 * Never pulls focus.
 */
const VERB_COMMANDS: Record<string, string> = {
  // Builder-scoped verbs (arg: builder id).
  'open-terminal': 'codev.openBuilderById',
  'view-diff': 'codev.viewDiff',
  'open-spec': 'codev.viewSpecFile',
  'open-plan': 'codev.viewPlanFile',
  'open-review': 'codev.viewReviewFile',
  'forward-hunk': 'codev.forwardCurrentHunkToBuilder',
  'forward-file': 'codev.forwardCurrentFileToBuilder',
  'run-dev': 'codev.runWorktreeDev',
  'spawn-builder': 'codev.spawnBuilder',
  // Context verbs (operate on the focused editor; no arg).
  'add-comment': 'codev.addReviewComment',
  'forward-selection': 'codev.forwardSelectionToBuilder',
  // Gate review (arg: builder id). Surfaces the approval modal in the focused
  // window — a deliberate, human-confirmed action, never a silent approve.
  'approve-gate': 'codev.approveGate',
  // Diff-review navigation.
  'diff-next-file': 'codev.diffNextFile',
  'diff-prev-file': 'codev.diffPreviousFile',
  'diff-first-file': 'codev.diffFirstFile',
  'diff-next-hunk': 'workbench.action.compareEditor.nextChange',
  'diff-prev-hunk': 'workbench.action.compareEditor.previousChange',
  'diff-first-hunk': 'codev.diffFirstHunk',
  // Viewport scroll of the focused editor (the Scroll dial). Args carry the
  // built-in editorScroll options { to, by, value, revealCursor }.
  'scroll': 'editorScroll',
  // Workspace verbs (configurable Codev Action key / Dev Server key).
  'focus-workspace': 'codev.focusWorkspaceWindow',
  'open-architect-terminal': 'codev.openArchitectTerminal',
  'open-builder-terminal': 'codev.openBuilderTerminal',
  'send-message': 'codev.sendMessage',
  'refresh-overview': 'codev.refreshOverview',
  'new-shell': 'codev.newShell',
  'workspace-dev-start': 'codev.runWorkspaceDev',
  'workspace-dev-stop': 'codev.stopWorkspaceDev',
};

export function wireCommandProvider(connectionManager: ConnectionManager): vscode.Disposable {
  // Map a canonical verb to this provider's VSCode command and run it. A verb
  // absent from VERB_COMMANDS is ignored (the map is the allowlist).
  const runVerb = async (req: CommandRequest): Promise<void> => {
    // Workspace scope: a single Tower may serve several workspaces, so drop a
    // command addressed to a different one. Only enforced when the command carries
    // a workspace AND this window knows its own (mirrors builder-spawn-handler);
    // absent today, so this is a no-op until a controller populates it.
    const ownWorkspace = connectionManager.getWorkspacePath();
    if (req.workspace && ownWorkspace &&
        path.resolve(req.workspace) !== path.resolve(ownWorkspace)) {
      return;
    }
    // Self-gate on focus: only the focused window runs a relayed verb, so multiple
    // windows on one workspace execute it exactly once (a single active provider).
    // Pending: a "claim active provider" handshake would let an unfocused provider
    // act; until then the focused window wins.
    if (!vscode.window.state.focused) {return;}
    const command = VERB_COMMANDS[req.verb];
    if (!command) {
      return; // unknown verb: ignore silently
    }
    // The verb operands arrive over the wire as `unknown[]`; a non-array (a stray
    // object) would throw on spread, so coerce to an empty arg list.
    const args = Array.isArray(req.args) ? req.args : [];
    // SECURITY: `approve-gate` surfaces the human-confirmation modal; its command
    // ALSO accepts an `{ skipConfirmation }` options arg that runs
    // `porch approve --a-human-explicitly-approved-this` with no human. A controller
    // must never reach that path, so forward ONLY the builder id (first arg) — never
    // a second options object. (Other verbs legitimately take object args, e.g.
    // `scroll`, so this is scoped to the privileged verb, not a blanket filter.)
    const callArgs = req.verb === 'approve-gate' ? args.slice(0, 1) : args;
    try {
      await vscode.commands.executeCommand(command, ...callArgs);
    } catch {
      // command failures surface in VSCode's own UI; nothing to relay back
    }
  };

  return connectionManager.onSSEEvent(({ data }) => {
    const envelope = parseSseEnvelope(data);
    if (!envelope) {return;}
    if (envelope.type === COMMAND_EVENT) {
      const cmd = parseSseBody<CommandRequest>(envelope.body);
      if (cmd) {runVerb(cmd);}
    }
  });
}
