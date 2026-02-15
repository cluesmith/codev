/**
 * Message routing, address resolution, and WebSocket message bus for Tower server.
 * Spec 0110: Messaging Infrastructure — Phases 2 & 3
 *
 * Resolves `[project:]agent` addresses to terminal IDs by querying
 * the workspace terminal registry maintained by tower-terminals.ts.
 * Manages WebSocket subscribers and broadcasts structured message frames.
 */

import path from 'node:path';
import type { WebSocket } from 'ws';
import { parseAddress, stripLeadingZeros } from '../utils/agent-names.js';
import { getWorkspaceTerminals } from './tower-terminals.js';

// ============================================================================
// Message Frame
// ============================================================================

/**
 * Structured message frame broadcast to WebSocket subscribers.
 */
export interface MessageFrame {
  type: 'message';
  timestamp: string;
  from: { project: string; agent: string };
  to: { project: string; agent: string };
  content: string;
  metadata: { raw?: boolean; source?: string };
}

// ============================================================================
// Subscriber Management
// ============================================================================

interface MessageSubscriber {
  ws: WebSocket;
  projectFilter?: string;
}

/** Active WebSocket subscribers for the message bus. */
const messageSubscribers = new Set<MessageSubscriber>();

/**
 * Add a WebSocket subscriber to the message bus.
 * @param ws - The WebSocket connection
 * @param projectFilter - Optional project name to filter messages by
 */
export function addSubscriber(ws: WebSocket, projectFilter?: string): void {
  messageSubscribers.add({ ws, projectFilter });
}

/**
 * Remove a WebSocket subscriber from the message bus.
 * @param ws - The WebSocket connection to remove
 */
export function removeSubscriber(ws: WebSocket): void {
  for (const sub of messageSubscribers) {
    if (sub.ws === ws) {
      messageSubscribers.delete(sub);
      return;
    }
  }
}

/**
 * Get the count of active subscribers (for testing/monitoring).
 */
export function getSubscriberCount(): number {
  return messageSubscribers.size;
}

/**
 * Result of resolving a target address to a terminal.
 */
export interface ResolveResult {
  terminalId: string;
  workspacePath: string;
  agent: string;
}

/**
 * Error from address resolution — distinguishes "not found" from "ambiguous".
 */
export interface ResolveError {
  code: 'NOT_FOUND' | 'AMBIGUOUS' | 'NO_CONTEXT';
  message: string;
}

/**
 * Resolve a `[project:]agent` address to a terminal ID.
 *
 * Resolution logic:
 * 1. Parse target using parseAddress() (case-insensitive)
 * 2. If project specified: find workspace by basename match
 *    - Multiple basename matches → AMBIGUOUS error
 * 3. If no project: use fallbackWorkspace
 *    - Missing fallbackWorkspace → NO_CONTEXT error
 * 4. Within workspace: match agent against architect, then builders map
 *    - Exact match (case-insensitive) first, then tail match
 *    - Multiple tail matches → AMBIGUOUS error
 *
 * @param target - Address string: "agent" or "project:agent"
 * @param fallbackWorkspace - Workspace path when no project: prefix is given
 * @returns ResolveResult on success, ResolveError on failure
 */
export function resolveTarget(
  target: string,
  fallbackWorkspace?: string,
): ResolveResult | ResolveError {
  const { project, agent } = parseAddress(target);

  // Determine the workspace path
  let workspacePath: string;
  if (project) {
    const result = findWorkspaceByBasename(project);
    if ('code' in result) return result;
    workspacePath = result.workspacePath;
  } else {
    if (!fallbackWorkspace) {
      return {
        code: 'NO_CONTEXT',
        message: 'Cannot resolve agent without project context.',
      };
    }
    workspacePath = fallbackWorkspace;
  }

  // Resolve agent within the workspace
  return resolveAgentInWorkspace(agent, workspacePath);
}

/**
 * Find a workspace path by matching the basename of registered workspace paths.
 */
function findWorkspaceByBasename(
  projectName: string,
): { workspacePath: string } | ResolveError {
  const allWorkspaces = getWorkspaceTerminals();
  const matches: string[] = [];

  for (const wsPath of allWorkspaces.keys()) {
    if (path.basename(wsPath).toLowerCase() === projectName) {
      matches.push(wsPath);
    }
  }

  if (matches.length === 0) {
    return {
      code: 'NOT_FOUND',
      message: `Project '${projectName}' not found. No workspace with that basename is registered.`,
    };
  }

  if (matches.length > 1) {
    return {
      code: 'AMBIGUOUS',
      message: `Project '${projectName}' is ambiguous — matches ${matches.length} workspaces: ${matches.join(', ')}`,
    };
  }

  return { workspacePath: matches[0] };
}

/**
 * Resolve an agent name to a terminal ID within a specific workspace.
 *
 * Checks architect first, then builders by exact match, then builders by tail match.
 */
function resolveAgentInWorkspace(
  agent: string,
  workspacePath: string,
): ResolveResult | ResolveError {
  const allWorkspaces = getWorkspaceTerminals();
  const entry = allWorkspaces.get(workspacePath);

  if (!entry) {
    return {
      code: 'NOT_FOUND',
      message: `Workspace '${workspacePath}' has no registered terminals.`,
    };
  }

  // Check architect
  if (agent === 'architect' || agent === 'arch') {
    if (!entry.architect) {
      return {
        code: 'NOT_FOUND',
        message: `No architect terminal found in workspace '${path.basename(workspacePath)}'.`,
      };
    }
    return { terminalId: entry.architect, workspacePath, agent: 'architect' };
  }

  // Check builders — exact match (case-insensitive)
  for (const [builderId, terminalId] of entry.builders) {
    if (builderId.toLowerCase() === agent) {
      return { terminalId, workspacePath, agent: builderId };
    }
  }

  // Check builders — tail match with leading-zero stripping
  const strippedAgent = stripLeadingZeros(agent).toLowerCase();
  const tailMatches: Array<{ builderId: string; terminalId: string }> = [];

  for (const [builderId, terminalId] of entry.builders) {
    if (builderId.toLowerCase().endsWith(`-${strippedAgent}`)) {
      tailMatches.push({ builderId, terminalId });
    }
  }

  if (tailMatches.length === 1) {
    return {
      terminalId: tailMatches[0].terminalId,
      workspacePath,
      agent: tailMatches[0].builderId,
    };
  }

  if (tailMatches.length > 1) {
    const candidates = tailMatches.map(m => m.builderId).join(', ');
    return {
      code: 'AMBIGUOUS',
      message: `Agent '${agent}' is ambiguous — matches ${tailMatches.length} builders: ${candidates}. Use the full name.`,
    };
  }

  // Check shells — exact match
  for (const [shellId, terminalId] of entry.shells) {
    if (shellId.toLowerCase() === agent) {
      return { terminalId, workspacePath, agent: shellId };
    }
  }

  return {
    code: 'NOT_FOUND',
    message: `Agent '${agent}' not found in workspace '${path.basename(workspacePath)}'.`,
  };
}

/**
 * Broadcast a structured message frame to all WebSocket subscribers.
 * Filters by project if the subscriber has a projectFilter set.
 */
export function broadcastMessage(message: MessageFrame): void {
  const payload = JSON.stringify(message);

  for (const sub of messageSubscribers) {
    // Apply project filter: message must involve the filtered project (from or to)
    if (sub.projectFilter) {
      if (message.from.project !== sub.projectFilter && message.to.project !== sub.projectFilter) {
        continue;
      }
    }

    try {
      sub.ws.send(payload);
    } catch {
      // If send fails, subscriber is likely disconnected — remove it
      messageSubscribers.delete(sub);
    }
  }
}

/**
 * Helper to check if a resolve result is an error.
 */
export function isResolveError(result: ResolveResult | ResolveError): result is ResolveError {
  return 'code' in result;
}
