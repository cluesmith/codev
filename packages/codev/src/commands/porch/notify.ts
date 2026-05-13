/**
 * Porch terminal notifications — sends `afx send <target>` to deliver messages
 * into a target terminal (architect or builder) as PTY input.
 *
 * Used by porch's state machine to notify the architect when a gate becomes
 * pending (Spec 0108) and to wake the builder when a gate is approved.
 */

import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveAfxBinary(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, '../../../bin/afx.js');
}

export interface NotifyTerminalOptions {
  /** Target terminal: 'architect' or a builder ID (e.g., 'pir-1298'). */
  target: string;
  /** Message text to deliver. */
  message: string;
  /** Working directory — used by afx to resolve the workspace. */
  worktreeDir: string;
  /**
   * When true, deliver the message as a draft (typed into the input buffer
   * but Enter is NOT pressed). The receiver sees the text but won't act on
   * it until they manually submit. Used for the architect convention.
   *
   * When false / omitted, the message is submitted immediately so the
   * receiver Claude session processes it on its next turn. Used for builder
   * wake-ups after gate approval.
   */
  draft?: boolean;
}

/** Architect-bound notification when a gate becomes pending. */
export function gatePendingMessage(projectId: string, gateName: string): string {
  return [
    `GATE: ${gateName} (Builder ${projectId})`,
    `Builder ${projectId} is waiting for approval.`,
    `Run: porch approve ${projectId} ${gateName}`,
  ].join('\n');
}

/** Builder-bound wake-up after a gate is approved. */
export function gateApprovedMessage(gateName: string): string {
  return `Gate ${gateName} approved — please run \`porch next\` to advance.`;
}

/**
 * Fire-and-forget notification to a terminal (architect or builder).
 * Uses `afx send <target>` via execFile (no shell, no injection risk).
 * Errors are logged but never thrown — notification is best-effort.
 */
export function notifyTerminal(opts: NotifyTerminalOptions): void {
  const args = ['send', opts.target, opts.message, '--raw'];
  if (opts.draft) args.push('--no-enter');

  const afBinary = resolveAfxBinary();

  execFile(
    process.execPath,
    [afBinary, ...args],
    { cwd: opts.worktreeDir, timeout: 10_000 },
    (error) => {
      if (error) {
        console.error(`[porch] notifyTerminal(${opts.target}) failed: ${error.message}`);
      }
    }
  );
}
