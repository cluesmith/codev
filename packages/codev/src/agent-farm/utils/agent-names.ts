/**
 * Agent naming utilities for standardized builder identification.
 * Spec 0110: Messaging Infrastructure — Phase 1
 *
 * Naming convention:
 *   Builder ID:    builder-{protocol}-{id}  (e.g., builder-spir-109)
 *   Worktree path: .builders/{protocol}-{id}[-{slug}]/
 *   Branch name:   builder/{protocol}-{id}[-{slug}]
 *
 * All names are stored and compared in lowercase per spec.
 *
 * `stripLeadingZeros` and `resolveAgentName` live in codev-core so the
 * VS Code extension can use the same matching semantics; we re-export
 * them here so existing agent-farm callsites are unaffected.
 */

import type { BuilderType } from '../types.js';
export { stripLeadingZeros, resolveAgentName } from '@cluesmith/codev-core/agent-names';
import { stripLeadingZeros } from '@cluesmith/codev-core/agent-names';

/**
 * Build a canonical agent name from builder type and ID.
 * Returns lowercase with leading zeros stripped from numeric IDs.
 *
 * Examples:
 *   buildAgentName('spec', '0109')       → 'builder-spir-109'
 *   buildAgentName('bugfix', '42')       → 'builder-bugfix-42'
 *   buildAgentName('task', 'AbCd')       → 'builder-task-abcd'
 *   buildAgentName('protocol', 'AbCd')   → 'builder-experiment-abcd'
 *
 * Note: For 'spec' type, the protocol segment defaults to 'spir'.
 * Use buildAgentNameWithProtocol() when the actual protocol is known.
 */
export function buildAgentName(type: BuilderType, id: string, protocol?: string): string {
  const strippedId = stripLeadingZeros(id);

  // Determine the protocol segment
  let protocolSegment: string;
  switch (type) {
    case 'spec':
      protocolSegment = protocol ?? 'spir';
      break;
    case 'bugfix':
      protocolSegment = 'bugfix';
      break;
    case 'pir':
      protocolSegment = 'pir';
      break;
    case 'task':
      protocolSegment = 'task';
      break;
    case 'protocol':
      protocolSegment = protocol ?? 'protocol';
      break;
    default:
      // shell and worktree don't get builder- prefix names
      return `${type}-${strippedId}`.toLowerCase();
  }

  return `builder-${protocolSegment}-${strippedId}`.toLowerCase();
}

/**
 * Parse a canonical agent name into its components.
 * Returns null if the name doesn't match the expected pattern.
 *
 * Examples:
 *   parseAgentName('builder-spir-109')     → { protocol: 'spir', id: '109' }
 *   parseAgentName('builder-bugfix-42')    → { protocol: 'bugfix', id: '42' }
 *   parseAgentName('architect')            → null
 *   parseAgentName('0109')                 → null
 */
export function parseAgentName(name: string): { protocol: string; id: string } | null {
  const lower = name.toLowerCase();
  const match = lower.match(/^builder-([a-z0-9]+)-(.+)$/);
  if (!match) return null;
  return { protocol: match[1], id: match[2] };
}

/**
 * Parse a target address into project and agent components.
 * Normalizes the agent portion to lowercase.
 *
 * Examples:
 *   parseAddress('architect')                  → { agent: 'architect' }
 *   parseAddress('builder-spir-109')           → { agent: 'builder-spir-109' }
 *   parseAddress('codev-public:architect')     → { project: 'codev-public', agent: 'architect' }
 *   parseAddress('codev-public:builder-spir-109') → { project: 'codev-public', agent: 'builder-spir-109' }
 */
export function parseAddress(target: string): { project?: string; agent: string } {
  const colonIndex = target.indexOf(':');
  if (colonIndex > 0) {
    return {
      project: target.substring(0, colonIndex).toLowerCase(),
      agent: target.substring(colonIndex + 1).toLowerCase(),
    };
  }
  return { agent: target.toLowerCase() };
}

