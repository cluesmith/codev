import * as vscode from 'vscode';
import type { ConnectionManager } from './connection-manager.js';
import type { TerminalManager } from './terminal-manager.js';

// Matches Codev builder role names like `builder-spir-153`, `builder-bugfix-42`.
const BUILDER_REGEX = /\bbuilder-[a-z]+-[a-z0-9]+\b/g;

interface BuilderLink extends vscode.TerminalLink {
  roleId: string;
}

/**
 * Makes builder role names in terminal output clickable.
 * Clicking opens (or focuses) that builder's terminal.
 */
export class BuilderTerminalLinkProvider implements vscode.TerminalLinkProvider<BuilderLink> {
  constructor(
    private connectionManager: ConnectionManager,
    private terminalManager: TerminalManager,
    private outputChannel: vscode.OutputChannel,
  ) {}

  provideTerminalLinks(context: vscode.TerminalLinkContext): BuilderLink[] {
    const links: BuilderLink[] = [];
    BUILDER_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BUILDER_REGEX.exec(context.line)) !== null) {
      links.push({
        startIndex: match.index,
        length: match[0].length,
        tooltip: `Open ${match[0]} terminal`,
        roleId: match[0],
      });
    }
    return links;
  }

  async handleTerminalLink(link: BuilderLink): Promise<void> {
    const client = this.connectionManager.getClient();
    const workspacePath = this.connectionManager.getWorkspacePath();
    if (!client || !workspacePath) {
      vscode.window.showErrorMessage('Codev: Not connected to Tower');
      return;
    }

    try {
      const state = await client.getWorkspaceState(workspacePath);
      const builder = state?.builders?.find(b => b.name === link.roleId || b.id === link.roleId);
      if (!builder?.terminalId) {
        vscode.window.showWarningMessage(`Codev: No active terminal for ${link.roleId}`);
        return;
      }
      await this.terminalManager.openBuilder(builder.terminalId, builder.id, `Codev: ${builder.name}`);
    } catch (err) {
      this.log('ERROR', `Failed to open builder ${link.roleId}: ${(err as Error).message}`);
      vscode.window.showErrorMessage(`Codev: Failed to open ${link.roleId}`);
    }
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [BuilderLinks] [${level}] ${message}`);
  }
}
