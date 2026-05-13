/**
 * Porch terminal notifications — sends `afx send <target>` to deliver
 * messages into a target terminal as PTY input.
 *
 * Currently used only to wake the builder after a gate is approved. The
 * builder's interactive Claude session sits idle at the gate until it
 * receives an input event; without this wake-up it would not call
 * `porch next` and advance.
 *
 * Architect-bound gate notifications were removed deliberately: PIR/SPIR
 * gates are explicit human-decision points (review the plan / review the
 * worktree), surfaced via the VSCode sidebar tree and toast. The
 * architect cannot act on a gate autonomously (approval requires a human
 * `--a-human-explicitly-approved-this` flag), so pushing gate state into
 * its conversation history only adds noise.
 */

import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveAfxBinary(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, '../../../bin/afx.js');
}

export interface NotifyTerminalOptions {
  /** Target terminal — currently always a builder ID (e.g., 'pir-1298'). */
  target: string;
  /** Message text to deliver. */
  message: string;
  /** Working directory — used by afx to resolve the workspace. */
  worktreeDir: string;
}

/** Builder-bound wake-up after a gate is approved. */
export function gateApprovedMessage(gateName: string): string {
  return `Gate ${gateName} approved — please run \`porch next\` to advance.`;
}

/**
 * Fire-and-forget notification to a terminal.
 * Uses `afx send <target>` via execFile (no shell, no injection risk).
 * Errors are logged but never thrown — notification is best-effort.
 */
export function notifyTerminal(opts: NotifyTerminalOptions): void {
  const afBinary = resolveAfxBinary();

  execFile(
    process.execPath,
    [afBinary, 'send', opts.target, opts.message, '--raw'],
    { cwd: opts.worktreeDir, timeout: 10_000 },
    (error) => {
      if (error) {
        console.error(`[porch] notifyTerminal(${opts.target}) failed: ${error.message}`);
      }
    }
  );
}
