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
 * `stripLeadingZeros`, `resolveAgentName` and the address parser live in codev-sdk
 * so the VS Code extension can use the same matching semantics; we re-export
 * them here so existing agent-farm callsites are unaffected.
 */

import type { BuilderType } from '../types.js';
export { stripLeadingZeros, resolveAgentName } from '@cluesmith/codev-sdk/agent-names';
import { stripLeadingZeros } from '@cluesmith/codev-sdk/agent-names';
// The one address parser (Spec 1940), shared with the VS Code extension.
export { parseAddress, isRemoteAddress } from '@cluesmith/codev-sdk/address';
import { parseAddress, isRemoteAddress } from '@cluesmith/codev-sdk/address';

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

/** The builder rule (Spec 755): a builder naming an architect that is not its own. */
export function addressSpoofingErrorMessage(builderId: string): string {
  return `builder ${builderId} may only address its own spawning architect`;
}

/**
 * The builder rule for an architect in another workspace, or on another Tower (Spec 1940,
 * Spec 1967): refused, with the way in, that workspace's front door.
 */
export function crossWorkspaceBuilderErrorMessage(builderId: string, frontDoor: string): string {
  return `${addressSpoofingErrorMessage(builderId)}; reach that workspace through its front door: afx send ${frontDoor} "…"`;
}

/**
 * Why an `afx://` address is refused (Spec 1940, stage 1). Said the same way by Tower, by
 * the cron loader and by the commands that refuse before calling Tower. It holds whether
 * or not the Tower is connected to Codev Cloud.
 */
export const CROSS_TOWER_UNAVAILABLE_MESSAGE =
  'Cross-Tower messaging is not available in this version: an afx:// address cannot be delivered yet. ' +
  'Use a local address: [<workspace>:]architect[:<name>] or [<workspace>:]<builder-or-shell-id>.';

/**
 * Is `target` a well-formed address that names a Tower? A malformed one is not: it is
 * left for Tower to refuse as malformed, with the shape that was expected.
 */
export function namesATower(target: string): boolean {
  const parsed = parseAddress(target);
  return parsed.ok && isRemoteAddress(parsed.address);
}
