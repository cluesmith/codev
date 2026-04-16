import * as vscode from 'vscode';
import { spawn } from 'node:child_process';

/**
 * Codev: Spawn Builder — quick-pick flow for issue + protocol + optional branch.
 */
export async function spawnBuilder(): Promise<void> {
  const issueNumber = await vscode.window.showInputBox({
    prompt: 'Issue number',
    placeHolder: '42',
  });
  if (!issueNumber) { return; }

  const protocol = await vscode.window.showQuickPick(
    ['spir', 'aspir', 'air', 'bugfix', 'tick'],
    { placeHolder: 'Select protocol' },
  );
  if (!protocol) { return; }

  const branch = await vscode.window.showInputBox({
    prompt: 'Branch name (optional — leave empty for new branch)',
    placeHolder: 'feature/my-branch',
  });

  const args = ['spawn', issueNumber, '--protocol', protocol];
  if (branch) {
    args.push('--branch', branch);
  }

  runAfxCommand(args);
}

function runAfxCommand(args: string[]): void {
  const child = spawn('afx', args, { detached: true, stdio: 'ignore' });
  child.unref();
  vscode.window.showInformationMessage(`Codev: Running afx ${args.join(' ')}`);
}
