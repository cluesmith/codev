import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BuilderSpawnedPayload } from '@cluesmith/codev-types';
import type { ConnectionManager } from './connection-manager.js';
import type { TerminalManager } from './terminal-manager.js';

type AutoOpenMode = 'off' | 'notify' | 'auto';

export class BuilderSpawnHandler {
  private seen = new Set<string>();

  constructor(
    private connectionManager: ConnectionManager,
    private terminalManager: TerminalManager,
    private outputChannel: vscode.OutputChannel,
  ) {}

  handle(_eventType: string, data: string): void {
    // Tower emits events as a JSON-serialized envelope on the SSE `data:` field
    // with no `event:` name, so we must inspect the envelope's `type` ourselves.
    let envelope: { type?: unknown; body?: unknown };
    try {
      envelope = JSON.parse(data);
    } catch {
      return;
    }

    if (envelope.type !== 'builder-spawned') { return; }

    const body = typeof envelope.body === 'string' ? envelope.body : '';
    let payload: BuilderSpawnedPayload;
    try {
      payload = JSON.parse(body);
    } catch {
      this.log('WARN', `Malformed builder-spawned body: ${body.slice(0, 200)}`);
      return;
    }

    if (!payload.terminalId || !payload.roleId || !payload.workspacePath) { return; }

    // path.resolve handles trailing-slash and `..` normalization. Symlink
    // realpath is intentionally skipped — Tower passes canonical paths and
    // realpath would add sync FS I/O on every event.
    const active = this.connectionManager.getWorkspacePath();
    if (active && path.resolve(payload.workspacePath) !== path.resolve(active)) { return; }

    if (this.seen.has(payload.terminalId)) { return; }
    this.seen.add(payload.terminalId);

    const mode = vscode.workspace
      .getConfiguration('codev')
      .get<AutoOpenMode>('autoOpenBuilderTerminal', 'notify');

    if (mode === 'off') { return; }

    if (mode === 'auto') {
      // Background open: never steal focus from the user's current terminal.
      void this.open(payload, false);
      return;
    }

    void vscode.window
      .showInformationMessage(`Builder ${payload.roleId} spawned.`, 'Open Terminal')
      .then((choice) => {
        // Toast click is an explicit user action — focus the new terminal.
        if (choice === 'Open Terminal') { void this.open(payload, true); }
      });
  }

  private async open(payload: BuilderSpawnedPayload, focus: boolean): Promise<void> {
    try {
      await this.terminalManager.openBuilder(
        payload.terminalId,
        payload.roleId,
        `Codev: ${payload.roleId}`,
        focus,
      );
    } catch (err) {
      this.log('ERROR', `Failed to open builder terminal ${payload.roleId}: ${(err as Error).message}`);
    }
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [BuilderSpawn] [${level}] ${message}`);
  }
}
