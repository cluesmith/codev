import * as vscode from 'vscode';
import type { TerminalManager } from './terminal-manager.js';
import type { ConnectionManager } from './connection-manager.js';
import { RECONNECT_LINK_TEXT } from './terminal-adapter.js';
import { openTerminalRef } from './commands/open-terminal-ref.js';

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
    await this.terminalManager.openBuilderByRoleOrId(link.roleId, true);
  }
}

interface ReconnectLink extends vscode.TerminalLink {
  // The terminal whose line carried the affordance. VSCode hands the same link
  // instance back to handleTerminalLink, so we reconnect exactly the terminal
  // that gave up — not merely the active one.
  terminal: vscode.Terminal;
}

/**
 * Makes the reconnect affordance in a terminal's give-up message clickable
 * (#939). The adapter prints `RECONNECT_LINK_TEXT` when it enters the give-up
 * state (#936); clicking it triggers a fresh reconnect chain on that terminal.
 */
export class ReconnectTerminalLinkProvider implements vscode.TerminalLinkProvider<ReconnectLink> {
  constructor(private terminalManager: TerminalManager) {}

  provideTerminalLinks(context: vscode.TerminalLinkContext): ReconnectLink[] {
    const index = context.line.indexOf(RECONNECT_LINK_TEXT);
    if (index === -1) { return []; }
    return [{
      startIndex: index,
      length: RECONNECT_LINK_TEXT.length,
      tooltip: 'Reconnect this terminal',
      terminal: context.terminal,
    }];
  }

  handleTerminalLink(link: ReconnectLink): void {
    this.terminalManager.reconnectByTerminal(link.terminal);
  }
}

interface IssueRefLink extends vscode.TerminalLink {
  number: string;
  isPR: boolean;
}

/**
 * Makes `#N` and `PR #N` references in terminal output clickable (#1412).
 * `PR #N` opens the PR's forge page in the browser; a bare `#N` opens the
 * in-editor issue viewer (or the browser, per `codev.terminalLinks.issueTarget`),
 * falling through to the PR browser-open when the number turns out to be a PR.
 * Claiming the span also stops VSCode's useless fallback word-search over it.
 */
export class IssueRefTerminalLinkProvider implements vscode.TerminalLinkProvider<IssueRefLink> {
  constructor(private connectionManager: ConnectionManager) {}

  provideTerminalLinks(context: vscode.TerminalLinkContext): IssueRefLink[] {
    // Built per call, not shared at module scope: the VSCode d.ts warns that
    // provideTerminalLinks may be re-entered before a prior call resolves, and
    // a shared /g regex's lastIndex would race across those overlapping calls.
    // The optional greedy `PR ` prefix claims the whole `PR #N` span in one
    // match, so the inner `#N` is not separately matched.
    const re = /(?<pr>\bPR\s+)?#(?<num>\d+)/gi;
    const links: IssueRefLink[] = [];
    for (const m of context.line.matchAll(re)) {
      const num = m.groups!.num;
      const isPR = Boolean(m.groups?.pr);
      links.push({
        startIndex: m.index,
        length: m[0].length,
        tooltip: isPR ? `Open PR #${num} in browser` : `Open issue #${num}`,
        number: num,
        isPR,
      });
    }
    return links;
  }

  handleTerminalLink(link: IssueRefLink): Promise<void> {
    return openTerminalRef(this.connectionManager, { number: link.number, isPR: link.isPR });
  }
}
