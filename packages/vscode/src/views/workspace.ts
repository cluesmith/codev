import * as vscode from 'vscode';
import { encodeWorkspacePath } from '@cluesmith/codev-core/workspace';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';
import { getTowerAddress } from '../workspace-detector.js';
import { resolveWorkspaceDevTarget } from '../commands/dev-shared.js';

/**
 * Workspace-level entry points: architect terminal, Tower web dashboard,
 * spawn builder, and new shell. Sits at the top of the Codev sidebar so
 * common workspace actions are one click away, not buried in the palette.
 */
export class WorkspaceProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private connectionManager: ConnectionManager,
    private terminalManager: TerminalManager,
  ) {
    connectionManager.onStateChange(() => this.changeEmitter.fire());
    // Re-render when the dev-terminal set changes (start/stop, a swap that
    // killed this workspace's dev, or cleanup) so the conditional "Stop Dev
    // Server" row reflects reality across every path.
    terminalManager.onDidChangeDevTerminals(() => this.changeEmitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];

    const architect = new vscode.TreeItem('Open Architect');
    architect.iconPath = new vscode.ThemeIcon('person');
    architect.tooltip = 'Open the architect terminal';
    architect.contextValue = 'workspace-architect';
    architect.command = {
      command: 'codev.openArchitectTerminal',
      title: 'Open Architect Terminal',
    };
    items.push(architect);

    const webUrl = this.buildDashboardUrl();
    if (webUrl) {
      const web = new vscode.TreeItem('Open Web Interface');
      web.iconPath = new vscode.ThemeIcon('globe');
      web.tooltip = webUrl;
      web.contextValue = 'workspace-web';
      web.command = {
        command: 'vscode.open',
        title: 'Open Tower dashboard in browser',
        arguments: [vscode.Uri.parse(webUrl)],
      };
      items.push(web);
    }

    const spawn = new vscode.TreeItem('Spawn Builder');
    spawn.iconPath = new vscode.ThemeIcon('rocket');
    spawn.tooltip = 'Spawn a new builder for a GitHub issue';
    spawn.contextValue = 'workspace-spawn';
    spawn.command = {
      command: 'codev.spawnBuilder',
      title: 'Spawn Builder',
    };
    items.push(spawn);

    const shell = new vscode.TreeItem('New Shell');
    shell.iconPath = new vscode.ThemeIcon('terminal-new');
    shell.tooltip = 'Open a new shell tab in Tower';
    shell.contextValue = 'workspace-shell';
    shell.command = {
      command: 'codev.newShell',
      title: 'New Shell',
    };
    items.push(shell);

    // Target is whatever folder this VSCode window is rooted at: the main
    // checkout → `main`, a `.builders/<id>/` worktree → that builder. The
    // label stays generic; the tooltip names the resolved target.
    const workspacePath = this.connectionManager.getWorkspacePath();
    const devTarget = workspacePath ? resolveWorkspaceDevTarget(workspacePath) : null;

    const startDev = new vscode.TreeItem('Start Dev Server');
    startDev.iconPath = new vscode.ThemeIcon('play');
    startDev.tooltip = devTarget
      ? `Run worktree.devCommand for this workspace (target: ${devTarget.id})`
      : 'Run worktree.devCommand for this workspace';
    startDev.contextValue = 'workspace-dev-start';
    startDev.command = {
      command: 'codev.runWorkspaceDev',
      title: 'Start Dev Server',
    };
    items.push(startDev);

    // Stop row only while a dev PTY for THIS workspace's target is running.
    const targetDevRunning = !!devTarget && this.terminalManager
      .listDevTerminals()
      .some(d => d.builderId === devTarget.id);
    if (targetDevRunning) {
      const stopDev = new vscode.TreeItem('Stop Dev Server');
      stopDev.iconPath = new vscode.ThemeIcon('debug-stop');
      stopDev.tooltip = `Stop the dev server for this workspace (target: ${devTarget!.id})`;
      stopDev.contextValue = 'workspace-dev-stop';
      stopDev.command = {
        command: 'codev.stopWorkspaceDev',
        title: 'Stop Dev Server',
      };
      items.push(stopDev);
    }

    return items;
  }

  private buildDashboardUrl(): string | null {
    const workspacePath = this.connectionManager.getWorkspacePath();
    if (!workspacePath) { return null; }
    const { host, port } = getTowerAddress();
    return `http://${host}:${port}/workspace/${encodeWorkspacePath(workspacePath)}/`;
  }
}
