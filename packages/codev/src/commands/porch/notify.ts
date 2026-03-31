/**
 * Porch gate notification — sends `afx send architect` when a gate transitions to pending.
 * Spec 0108: Push-based gate notifications, replacing the poll-based gate watcher.
 */

import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveAfxBinary(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, '../../../bin/afx.js');
}

/**
 * Fire-and-forget notification to the architect terminal when a gate becomes pending.
 * Uses `afx send architect` via execFile (no shell, no injection risk).
 * Errors are logged but never thrown — notification is best-effort.
 */
export function notifyArchitect(projectId: string, gateName: string, worktreeDir: string): void {
  const message = [
    `GATE: ${gateName} (Builder ${projectId})`,
    `Builder ${projectId} is waiting for approval.`,
    `Run: porch approve ${projectId} ${gateName}`,
  ].join('\n');

  const afBinary = resolveAfxBinary();

  execFile(
    process.execPath,
    [afBinary, 'send', 'architect', message, '--raw', '--no-enter'],
    { cwd: worktreeDir, timeout: 10_000 },
    (error) => {
      if (error) {
        console.error(`[porch] Gate notification failed: ${error.message}`);
      }
    }
  );
}
