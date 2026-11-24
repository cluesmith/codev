import * as vscode from 'vscode';
import { spawnCodevCli } from '../cli-process.js';

/**
 * Codev: Spawn Builder.
 *
 * Two entry points:
 *  - No arg (command palette): full flow — issue input → protocol → optional branch.
 *  - `issueArg` provided (Backlog row-click / context menu): the issue is
 *    already known, so jump straight to the protocol pick and spawn. The
 *    branch prompt is skipped too — starting work on a backlog issue means
 *    a fresh branch.
 *
 * `afx spawn` resolves its workspace from its cwd, so it runs in
 * `workspacePath`, this window's Tower workspace (the parent workspace in a
 * builder-worktree window). Without one it refuses before prompting: in the
 * extension host's own cwd it would spawn into whichever project that is.
 */
export async function spawnBuilder(issueArg: string | undefined, workspacePath: string | null): Promise<void> {
  if (!workspacePath) {
    vscode.window.showErrorMessage('Codev: Spawn Builder needs a Codev workspace open in this window.');
    return;
  }
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

  runAfxCommand(args, workspacePath);
}

function runAfxCommand(args: string[], cwd: string): void {
  const child = spawnCodevCli('afx', args, { cwd, detached: true, stdio: 'ignore' });
  child.on('error', (err: NodeJS.ErrnoException) => {
    const reason = err.code === 'ENOENT' ? 'afx was not found on PATH (install @cluesmith/codev)' : err.message;
    vscode.window.showErrorMessage(`Codev: could not run afx: ${reason}`);
  });
  child.unref();
  vscode.window.showInformationMessage(`Codev: Running afx ${args.join(' ')}`);
}
