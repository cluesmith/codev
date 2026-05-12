import * as vscode from 'vscode';
import { CodevPseudoterminal } from './terminal-adapter.js';
import type { ConnectionManager } from './connection-manager.js';
import { encodeWorkspacePath } from '@cluesmith/codev-core/workspace';
import { resolveAgentName } from '@cluesmith/codev-core/agent-names';
import type { TerminalType } from '@cluesmith/codev-core/tower-client';

const MAX_TERMINALS = 10;

interface ManagedTerminal {
  terminal: vscode.Terminal;
  pty: CodevPseudoterminal;
  type: TerminalType;
  id: string;
}

/**
 * Manages VS Code terminal instances backed by Tower PTY sessions.
 * Handles WebSocket pool, editor layout, and terminal lifecycle.
 */
export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private outputChannel: vscode.OutputChannel;
  private connectionManager: ConnectionManager;
  private readonly iconPath: { light: vscode.Uri; dark: vscode.Uri };

  constructor(
    connectionManager: ConnectionManager,
    outputChannel: vscode.OutputChannel,
    extensionUri: vscode.Uri,
  ) {
    this.connectionManager = connectionManager;
    this.outputChannel = outputChannel;
    // Theme-aware icon pair. The single-Uri form rendered as solid black on
    // dark themes (VSCode doesn't resolve currentColor on terminal-tab icons).
    // codev-light.svg has dark fill (visible on light themes), codev-dark.svg
    // has light fill (visible on dark themes).
    this.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'icons', 'codev-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'icons', 'codev-dark.svg'),
    };
  }

  /**
   * Open the architect terminal. `focus` defaults to false so background
   * paths don't steal focus; click paths pass true.
   */
  async openArchitect(terminalId: string, focus = false): Promise<void> {
    const existing = this.terminals.get('architect');
    if (existing) {
      existing.terminal.show(!focus);
      return;
    }
    await this.openTerminal(terminalId, 'architect', 'Codev: Architect', undefined, focus);
  }

  /**
   * Open a builder terminal. If a terminal already exists for this builder
   * but points at a different (stale) Tower session, dispose it before
   * opening a new one — happens when a builder is re-spawned and Tower
   * issues a new terminalId for the same roleId.
   *
   * `focus` defaults to false so background paths (e.g. auto-spawn when
   * the architect spawns a new builder) don't steal focus mid-typing.
   * Explicit user actions — sidebar click, terminal-link click, toast
   * click, command-palette pick — pass `true` to activate the terminal
   * for keyboard input.
   */
  async openBuilder(terminalId: string, builderId: string, label: string, focus = false): Promise<void> {
    const key = `builder-${builderId}`;
    const existing = this.terminals.get(key);
    if (existing) {
      if (existing.id === terminalId) {
        existing.terminal.show(!focus);
        return;
      }
      existing.pty.close();
      existing.terminal.dispose();
      this.terminals.delete(key);
    }
    await this.openTerminal(terminalId, 'builder', label, key, focus);
  }

  /**
   * Resolve a builder by `roleId` or `id` via Tower workspace state, then
   * open its terminal. Used by the sidebar tree views, terminal link
   * provider, and command palette so the lookup logic lives in one place.
   */
  async openBuilderByRoleOrId(roleOrId: string, focus = false): Promise<void> {
    const client = this.connectionManager.getClient();
    const workspacePath = this.connectionManager.getWorkspacePath();
    if (!client || !workspacePath) {
      vscode.window.showErrorMessage('Codev: Not connected to Tower');
      return;
    }
    try {
      const state = await client.getWorkspaceState(workspacePath);
      const builders = state?.builders ?? [];
      // Use resolveAgentName so the bare numeric IDs the sidebar passes
      // (e.g. '153' from OverviewBuilder) tail-match canonical
      // 'builder-spir-153' IDs from Tower's runtime state.
      const { builder, ambiguous } = resolveAgentName(roleOrId, builders);
      if (ambiguous) {
        vscode.window.showWarningMessage(
          `Codev: Multiple builders match "${roleOrId}": ${ambiguous.map(b => b.name).join(', ')}`,
        );
        return;
      }
      if (!builder?.terminalId) {
        vscode.window.showWarningMessage(`Codev: No active terminal for ${roleOrId}`);
        return;
      }
      await this.openBuilder(builder.terminalId, builder.id, `Codev: ${builder.name}`, focus);
    } catch (err) {
      this.log('ERROR', `Failed to open builder ${roleOrId}: ${(err as Error).message}`);
      vscode.window.showErrorMessage(`Codev: Failed to open ${roleOrId}`);
    }
  }

  /**
   * Open a dev-server terminal for a builder's worktree (#690).
   * Keyed `dev-<builderId>` so it lives alongside (not on top of) the
   * builder's own AI terminal at `builder-<id>`. Tab label is set by the
   * caller (server-side `'Dev: <id>'` flows through Tower's terminal name).
   *
   * `focus` defaults to true — `afx dev` / "Run Dev Server" are explicit
   * user actions, so activate the tab so they see the spawning output.
   */
  async openDevTerminal(terminalId: string, builderId: string, builderName: string, focus = true): Promise<void> {
    const key = `dev-${builderId}`;
    const existing = this.terminals.get(key);
    if (existing) {
      if (existing.id === terminalId) {
        existing.terminal.show(!focus);
        return;
      }
      // Stale terminal for the same builder — dispose before re-opening
      existing.pty.close();
      existing.terminal.dispose();
      this.terminals.delete(key);
    }
    // Tab title matches the builder-tab format (`Codev: <name>`) with a
    // `(dev)` suffix so the pairing is obvious in the tab strip.
    await this.openTerminal(terminalId, 'dev', `Codev: ${builderName} (dev)`, key, focus);
  }

  /**
   * Dispose the VSCode terminal tab for a builder's dev server, if any.
   * Used by `codev.stopWorktreeDev` after killing the Tower-side PTY so the
   * user doesn't see a dead "Process exited" tab lingering.
   */
  closeDevTerminal(builderId: string): void {
    const key = `dev-${builderId}`;
    const existing = this.terminals.get(key);
    if (!existing) { return; }
    existing.pty.close();
    existing.terminal.dispose();
    this.terminals.delete(key);
  }

  /**
   * Return { builderId, terminalId } for every dev terminal this VSCode
   * instance has open. Used by `codev.stopWorktreeDev` as the source of
   * truth — more reliable than round-tripping through Tower's label filter
   * (whose preservation through create→list isn't worth depending on, and
   * cross-VSCode-instance discovery is a #690 non-goal anyway).
   */
  listDevTerminals(): Array<{ builderId: string; terminalId: string }> {
    const out: Array<{ builderId: string; terminalId: string }> = [];
    for (const [key, entry] of this.terminals.entries()) {
      if (key.startsWith('dev-')) {
        out.push({ builderId: key.slice('dev-'.length), terminalId: entry.id });
      }
    }
    return out;
  }

  /**
   * Open a shell terminal.
   */
  async openShell(terminalId: string, shellNumber: number): Promise<void> {
    const key = `shell-${shellNumber}`;
    if (this.terminals.has(key)) {
      this.terminals.get(key)!.terminal.show();
      return;
    }
    await this.openTerminal(terminalId, 'shell', `Codev: Shell #${shellNumber}`, key);
  }

  getTerminalCount(): number {
    return this.terminals.size;
  }

  // ── Internal ─────────────────────────────────────────────────

  private async openTerminal(
    terminalId: string,
    type: TerminalType,
    name: string,
    key?: string,
    focus = false,
  ): Promise<void> {
    if (this.terminals.size >= MAX_TERMINALS) {
      vscode.window.showWarningMessage(`Too many terminals (${MAX_TERMINALS} max) — close unused terminals`);
      return;
    }

    const wsUrl = this.buildWsUrl(terminalId);
    if (!wsUrl) {
      vscode.window.showErrorMessage('Cannot open terminal — no workspace detected');
      return;
    }

    const authKey = await this.getAuthKey();
    const pty = new CodevPseudoterminal(wsUrl, authKey, this.outputChannel);
    const position = vscode.workspace.getConfiguration('codev').get<string>('terminalPosition', 'editor');
    const location = position === 'editor'
      ? { viewColumn: type === 'architect' ? vscode.ViewColumn.One : vscode.ViewColumn.Two }
      : vscode.TerminalLocation.Panel;

    const terminal = vscode.window.createTerminal({ name, pty, location, iconPath: this.iconPath });

    const mapKey = key ?? type;
    this.terminals.set(mapKey, { terminal, pty, type, id: terminalId });

    // Clean up when terminal is closed by user. The map-delete is guarded
    // because a stale terminal disposed via openBuilder's re-spawn path can
    // emit onDidCloseTerminal *after* the replacement registers under the
    // same mapKey — without the identity check we'd unmap the live one.
    const disposable = vscode.window.onDidCloseTerminal((t) => {
      if (t !== terminal) { return; }
      pty.close();
      if (this.terminals.get(mapKey)?.terminal === terminal) {
        this.terminals.delete(mapKey);
      }
      disposable.dispose();
    });

    terminal.show(!focus);
  }

  private buildWsUrl(terminalId: string): string | null {
    const workspacePath = this.connectionManager.getWorkspacePath();
    if (!workspacePath) { return null; }

    const config = vscode.workspace.getConfiguration('codev');
    const host = config.get<string>('towerHost', 'localhost');
    const port = config.get<number>('towerPort', 4100);
    const encoded = encodeWorkspacePath(workspacePath);

    return `ws://${host}:${port}/workspace/${encoded}/ws/terminal/${terminalId}`;
  }

  private async getAuthKey(): Promise<string | null> {
    const client = this.connectionManager.getClient();
    if (!client) { return null; }
    // TowerClient's getAuthKey is synchronous
    return (client as any).getAuthKey?.() ?? null;
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [TerminalManager] [${level}] ${message}`);
  }

  dispose(): void {
    for (const [, managed] of this.terminals) {
      managed.pty.close();
      managed.terminal.dispose();
    }
    this.terminals.clear();
  }
}
