import * as vscode from 'vscode';
import { spawn } from 'node:child_process';

/**
 * Codev: Spawn Builder.
 *
 * Two entry points:
 *  - No arg (command palette): full flow — issue input → protocol → optional branch.
 *  - `issueArg` provided (Backlog row-click / context menu): the issue is
 *    already known, so jump straight to the protocol pick and spawn. The
 *    branch prompt is skipped too — starting work on a backlog issue means
 *    a fresh branch.
 */
export async function spawnBuilder(issueArg?: string): Promise<void> {
  let issueNumber = issueArg;
  if (!issueNumber) {
    issueNumber = await vscode.window.showInputBox({
      prompt: 'Issue number',
      placeHolder: '42',
    });
    if (!issueNumber) { return; }
  }

  const protocol = await vscode.window.showQuickPick(
    ['spir', 'aspir', 'pir', 'air', 'bugfix', 'tick'],
    { placeHolder: 'Select protocol' },
  );
  if (!protocol) { return; }

  const args = ['spawn', issueNumber, '--protocol', protocol];

  if (!issueArg) {
    const branch = await vscode.window.showInputBox({
      prompt: 'Branch name (optional — leave empty for new branch)',
      placeHolder: 'feature/my-branch',
    });
    if (branch) {
      args.push('--branch', branch);
    }
  }

  runAfxCommand(args);
}

function runAfxCommand(args: string[]): void {
  const child = spawn('afx', args, { detached: true, stdio: 'ignore' });
  child.unref();
  vscode.window.showInformationMessage(`Codev: Running afx ${args.join(' ')}`);
}
