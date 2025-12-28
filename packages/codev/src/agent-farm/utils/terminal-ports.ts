/**
 * Terminal port lookup utility (Spec 0062 - Secure Remote Access)
 *
 * Provides the port lookup function used by the dashboard reverse proxy.
 * Extracted to a separate module for testability.
 */

import type { DashboardState } from '../types.js';

/**
 * Get the ttyd port for a given terminal ID
 * Returns null if the terminal is not found
 *
 * Terminal ID formats:
 * - 'architect' -> architect terminal
 * - 'builder-{id}' -> builder terminal
 * - 'util-{id}' -> utility terminal
 */
export function getPortForTerminal(terminalId: string, state: DashboardState): number | null {
  // Architect terminal
  if (terminalId === 'architect') {
    return state.architect?.port || null;
  }

  // Builder terminal (format: builder-{id})
  if (terminalId.startsWith('builder-')) {
    const builderId = terminalId.replace('builder-', '');
    const builder = state.builders.find(b => b.id === builderId);
    return builder?.port || null;
  }

  // Utility terminal (format: util-{id})
  if (terminalId.startsWith('util-')) {
    const utilId = terminalId.replace('util-', '');
    const util = state.utils.find(u => u.id === utilId);
    return util?.port || null;
  }

  return null;
}
