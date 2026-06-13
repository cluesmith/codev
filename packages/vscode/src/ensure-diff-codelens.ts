/**
 * The "Forward to Builder" CodeLens actions (#789) only render in a diff
 * editor when `diffEditor.codeLens` is on — VS Code hides CodeLens in diff
 * editors by default (microsoft/vscode#97640). When a reviewer opens a builder
 * file diff with the setting off, offer a one-click enable rather than letting
 * the feature look silently broken. A "Don't ask again" choice is remembered in
 * globalState so it never nags.
 */

import * as vscode from 'vscode';

const DISMISS_KEY = 'codev.diffCodeLensPromptDismissed';

export async function ensureDiffEditorCodeLens(
  context: vscode.ExtensionContext,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('diffEditor');
  if (cfg.get<boolean>('codeLens')) { return; }
  if (context.globalState.get<boolean>(DISMISS_KEY)) { return; }

  const ENABLE = 'Enable';
  const DISMISS = "Don't ask again";
  const choice = await vscode.window.showInformationMessage(
    'Codev’s "Forward to Builder" actions need CodeLens in diff editors, ' +
      'which VS Code hides by default. Enable it?',
    ENABLE,
    DISMISS,
  );
  if (choice === ENABLE) {
    // `diffEditor.codeLens` is a personal editor-behavior preference, so write
    // it at the user (Global) level. Deliberately NOT Workspace — that would
    // edit the repo's shared, committed `.vscode/settings.json` and force the
    // choice on every collaborator.
    await cfg.update('codeLens', true, vscode.ConfigurationTarget.Global);
  } else if (choice === DISMISS) {
    await context.globalState.update(DISMISS_KEY, true);
  }
}
