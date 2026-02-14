/**
 * Spec 0100: Gate watcher for detecting gate transitions and sending af send notifications.
 *
 * Tracks which gates have been notified (dedup) and sends `af send architect`
 * messages when new gates appear. Uses a dual-map design:
 * - notified: Map<key, timestamp> for dedup
 * - projectKeys: Map<projectPath, Set<key>> for clearing on gate resolution
 */

import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateStatus } from './gate-status.js';

// Strip ANSI escape sequences
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

// Reject control characters that could be injected
const CONTROL_CHAR_RE = /[;\n\r]/;

/**
 * Sanitize a string for use in af send messages.
 * Returns null if the value contains unsafe control characters.
 */
function sanitize(value: string): string | null {
  const stripped = value.replace(ANSI_RE, '').trim();
  if (!stripped || CONTROL_CHAR_RE.test(stripped)) return null;
  return stripped;
}

/**
 * Resolve the path to the `af` CLI binary.
 * Works from both source (src/) and compiled (dist/) contexts.
 */
function resolveAfBinary(): string {
  // From dist/agent-farm/utils/gate-watcher.js → bin/af.js
  // From src/agent-farm/utils/gate-watcher.ts → bin/af.js
  const thisDir = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  // thisDir = .../packages/codev/dist/agent-farm/utils or .../src/agent-farm/utils
  // Navigate up to packages/codev/bin/af.js
  return resolve(thisDir, '../../../bin/af.js');
}

export type LogFn = (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;

export class GateWatcher {
  /** Dedup map: key -> ISO timestamp of first notification */
  private notified = new Map<string, string>();
  /** Index: projectPath -> set of keys in `notified` */
  private projectKeys = new Map<string, Set<string>>();
  /** Logger function */
  private log: LogFn;
  /** Path to af binary */
  private afBinary: string;

  constructor(log: LogFn, afBinary?: string) {
    this.log = log;
    this.afBinary = afBinary ?? resolveAfBinary();
  }

  /**
   * Check gate status for a project and send notification if it's a new gate.
   */
  async checkAndNotify(gateStatus: GateStatus, projectPath: string): Promise<void> {
    if (!gateStatus.hasGate) {
      // Gate resolved — clear all entries for this project
      this.clearProject(projectPath);
      return;
    }

    const { builderId, gateName } = gateStatus;
    if (!builderId || !gateName) return;

    const key = `${projectPath}:${builderId}:${gateName}`;

    // Already notified for this exact gate
    if (this.notified.has(key)) return;

    // Gate changed for this project — clear old entries, add new one
    this.clearProject(projectPath);
    this.notified.set(key, new Date().toISOString());
    const keys = new Set<string>();
    keys.add(key);
    this.projectKeys.set(projectPath, keys);

    // Sanitize before sending
    const safeBuilderId = sanitize(builderId);
    const safeGateName = sanitize(gateName);

    if (!safeBuilderId || !safeGateName) {
      this.log('WARN', `Gate watcher: skipping af send — unsafe gateName or builderId for project ${projectPath}`);
      return;
    }

    const message = [
      `GATE: ${safeGateName} (Builder ${safeBuilderId})`,
      `Builder ${safeBuilderId} is waiting for approval.`,
      `Run: porch approve ${safeBuilderId} ${safeGateName}`,
    ].join('\n');

    await this.sendToArchitect(message, projectPath);
  }

  /**
   * Clear all tracked keys for a project.
   */
  private clearProject(projectPath: string): void {
    const keys = this.projectKeys.get(projectPath);
    if (keys) {
      for (const k of keys) {
        this.notified.delete(k);
      }
      this.projectKeys.delete(projectPath);
    }
  }

  /**
   * Send a message to the architect via af send.
   */
  private sendToArchitect(message: string, projectPath: string): Promise<void> {
    return new Promise<void>((resolve) => {
      execFile(
        process.execPath,
        [this.afBinary, 'send', 'architect', message, '--raw', '--no-enter'],
        { cwd: projectPath, timeout: 10_000 },
        (error) => {
          if (error) {
            this.log('WARN', `Gate watcher: af send failed for ${projectPath}: ${error.message}`);
          }
          resolve();
        }
      );
    });
  }

  /**
   * Reset all state (useful for testing).
   */
  reset(): void {
    this.notified.clear();
    this.projectKeys.clear();
  }
}
