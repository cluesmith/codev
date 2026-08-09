import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { TowerClient } from '@cluesmith/codev-sdk/tower-client';
import { readLocalKey } from '@cluesmith/codev-sdk/node';
import { getTowerAddress } from './workspace-detector.js';

/**
 * How long `restartTower` waits for the old Tower to release `/health` after
 * `afx tower stop` (which only SIGTERMs and returns). Mirrors Tower's own
 * `STARTUP_TIMEOUT_MS` (5s) so the stop window matches the start window.
 */
const SHUTDOWN_TIMEOUT_MS = 5000;
/** Poll cadence while waiting for the old Tower to go down. */
const SHUTDOWN_POLL_MS = 250;

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
 * Restart Tower: `afx tower stop`, wait for the old process to exit, then
 * `afx tower start` (reusing `autoStartTower`'s health-poll). Used by the #983
 * preflight when the running Tower version diverges from the installed CLI.
 *
 * Safe to invoke from inside the extension because #991 scoped `afx tower stop`
 * to the listening Tower process — it no longer SIGTERMs the extension host's
 * own established sockets (SSE + terminal WebSockets).
 */
export async function restartTower(
  workspacePath: string | null,
  outputChannel: vscode.OutputChannel,
): Promise<boolean> {
  const log = (level: string, msg: string) => {
    outputChannel.appendLine(`[${new Date().toISOString()}] [Tower] [${level}] ${msg}`);
  };

  const afxPath = resolveAfxPath(workspacePath);
  if (!afxPath) {
    log('ERROR', 'Cannot find afx binary — install @cluesmith/codev globally or check PATH');
    return false;
  }

  log('INFO', 'Restarting Tower (stop + start)');
  try {
    await new Promise<void>((res) => {
      const child = spawn(afxPath, ['tower', 'stop'], {
        stdio: 'ignore',
        cwd: workspacePath ?? undefined,
      });
      child.on('close', () => res());
      child.on('error', () => res());
    });
  } catch (err) {
    log('ERROR', `Failed to stop Tower: ${(err as Error).message}`);
    return false;
  }

  // `afx tower stop` (non-force) only SIGTERMs the daemon and returns
  // immediately — it does not wait for the process to exit, so `/health` keeps
  // answering for a short shutdown window. Poll until it's actually down before
  // starting, otherwise `autoStartTower`'s already-running early-return would
  // skip the start and we'd be left stopped-but-not-restarted.
  //
  // If it never goes down within the window, report failure rather than letting
  // `autoStartTower` see the still-live old process and return a misleading
  // success — a "successful" restart that left the user on the old version is
  // exactly the silent divergence this feature exists to surface.
  const { host, port } = getTowerAddress();
  const client = new TowerClient({ host, port, getAuthKey: readLocalKey });
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (await client.isRunning()) {
    if (Date.now() >= deadline) {
      log('ERROR', `Old Tower still responding ${SHUTDOWN_TIMEOUT_MS}ms after stop — aborting restart`);
      return false;
    }
    await sleep(SHUTDOWN_POLL_MS);
  }

  return autoStartTower(client, workspacePath, outputChannel);
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
