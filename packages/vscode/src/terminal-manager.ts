import * as vscode from 'vscode';
import { CodevPseudoterminal } from './terminal-adapter.js';
import type { ConnectionManager } from './connection-manager.js';
import { encodeWorkspacePath } from '@cluesmith/codev-core/workspace';

const MAX_TERMINALS = 10;

interface ManagedTerminal {
  terminal: vscode.Terminal;
  pty: CodevPseudoterminal;
  type: 'architect' | 'builder' | 'shell';
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

  constructor(connectionManager: ConnectionManager, outputChannel: vscode.OutputChannel) {
    this.connectionManager = connectionManager;
    this.outputChannel = outputChannel;
  }

  /**
   * Open the architect terminal.
   */
  async openArchitect(terminalId: string): Promise<void> {
    if (this.terminals.has('architect')) {
      // Focus existing
      this.terminals.get('architect')!.terminal.show();
      return;
    }
    await this.openTerminal(terminalId, 'architect', 'Codev: Architect');
  }

  /**
   * Open a builder terminal.
   */
  async openBuilder(terminalId: string, builderId: string, label: string): Promise<void> {
    const key = `builder-${builderId}`;
    if (this.terminals.has(key)) {
      this.terminals.get(key)!.terminal.show();
      return;
    }
    await this.openTerminal(terminalId, 'builder', label, key);
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
    type: 'architect' | 'builder' | 'shell',
    name: string,
    key?: string,
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

    const terminal = vscode.window.createTerminal({ name, pty, location });

    const mapKey = key ?? type;
    this.terminals.set(mapKey, { terminal, pty, type, id: terminalId });

    // Clean up when terminal is closed by user
    const disposable = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        pty.close();
        this.terminals.delete(mapKey);
        disposable.dispose();
      }
    });

    terminal.show(true);
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
