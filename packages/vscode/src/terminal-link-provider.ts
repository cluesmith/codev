import * as vscode from 'vscode';
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
  constructor(private terminalManager: TerminalManager) {}

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
    await this.terminalManager.openBuilderByRoleOrId(link.roleId);
  }
}
