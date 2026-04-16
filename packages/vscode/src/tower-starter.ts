import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { TowerClient } from '@cluesmith/codev-core/tower-client';

/**
 * Auto-start Tower as a detached process.
 * Resolves the afx binary path, spawns it, then polls health until ready.
 */
export async function autoStartTower(
  client: TowerClient,
  workspacePath: string | null,
  outputChannel: vscode.OutputChannel,
): Promise<boolean> {
  const log = (level: string, msg: string) => {
    outputChannel.appendLine(`[${new Date().toISOString()}] [Tower] [${level}] ${msg}`);
  };

  // Check if already running
  if (await client.isRunning()) {
    log('INFO', 'Tower already running');
    return true;
  }

  // Resolve afx path
  const afxPath = resolveAfxPath(workspacePath);
  if (!afxPath) {
    log('ERROR', 'Cannot find afx binary — install @cluesmith/codev globally or check PATH');
    return false;
  }

  log('INFO', `Starting Tower via ${afxPath}`);

  try {
    // Spawn as detached process — Tower outlives VS Code
    const child = spawn(afxPath, ['tower', 'start'], {
      detached: true,
      stdio: 'ignore',
      cwd: workspacePath ?? undefined,
    });
    child.unref();

    // Poll health with backoff (max 10 attempts)
    for (let attempt = 1; attempt <= 10; attempt++) {
      await sleep(500 * attempt);
      if (await client.isRunning()) {
        log('INFO', `Tower started (attempt ${attempt})`);
        return true;
      }
      log('INFO', `Waiting for Tower... (attempt ${attempt}/10)`);
    }

    log('ERROR', 'Tower did not start within timeout');
    return false;
  } catch (err) {
    log('ERROR', `Failed to start Tower: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Resolve the afx binary path.
 * Checks: workspace node_modules/.bin, then global PATH.
 */
function resolveAfxPath(workspacePath: string | null): string | null {
  // Check workspace node_modules/.bin
  if (workspacePath) {
    const localPath = resolve(workspacePath, 'node_modules', '.bin', 'afx');
    if (existsSync(localPath)) {
      return localPath;
    }
  }

  // Fall back to global — assume it's on PATH
  return 'afx';
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
