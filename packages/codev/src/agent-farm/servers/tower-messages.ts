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
import { lookupBuilderSpawningArchitect, getBuilders, getArchitects, getArchitectByName } from '../state.js';
import { DEFAULT_ARCHITECT_NAME } from '../utils/architect-name.js';

// ============================================================================
// Spec 755 error messages — exported as constants so producer and asserter
// share a single source of truth. Tests assert these texts verbatim; changing
// the wording without updating both sides will break the build.
// ============================================================================

export function legacyBuilderErrorMessage(builderId: string, registered: string[]): string {
  const names = registered.length ? registered.join(', ') : '<none>';
  return `legacy builder ${builderId} has no spawning-architect identity and no 'main' architect is registered (registered: ${names})`;
}

export function architectGoneErrorMessage(
  builderId: string,
  missingArchitect: string,
  registered: string[],
): string {
  const names = registered.length ? registered.join(', ') : '<none>';
  return `builder ${builderId} was spawned by architect ${missingArchitect}, which is no longer registered, and no 'main' architect is registered (registered: ${names})`;
}

export function addressSpoofingErrorMessage(builderId: string): string {
  return `builder ${builderId} may only address its own spawning architect`;
}

/**
 * Heuristic: does `sender` look like a builder identity (canonical
 * `builder-<protocol>-<id>` or the bare worktree form `<protocol>-<id>[-slug]`)
 * rather than an architect? Used only for the issue #1094 defense-in-depth
 * warning. Any `architect`/`arch`-prefixed name (e.g. the numbered architect
 * names `architect-3`) is excluded; the call site additionally suppresses the
 * warning for any currently-registered architect name.
 */
export function looksLikeBuilderId(sender: string): boolean {
  const s = sender.toLowerCase();
  if (s === 'arch' || s.startsWith('architect')) return false;
  return /^builder-[a-z0-9]+-/.test(s) || /-\d+(?:-[a-z0-9-]+)?$/.test(s);
}

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
  metadata: { raw?: boolean; source?: string; escape?: boolean };
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
 * Spec 755: when `sender` is supplied and refers to a builder, sender-affinity
 * routing applies to `architect` and `architect:<name>` targets. Non-builder
 * senders see the legacy main-first behavior, unchanged.
 *
 * @param target - Address string: "agent" or "project:agent"
 * @param fallbackWorkspace - Workspace path when no project: prefix is given
 * @param sender - Optional sender identity (a builder ID or 'architect').
 *                 Enables affinity-aware architect routing per Spec 755.
 * @returns ResolveResult on success, ResolveError on failure
 */
export function resolveTarget(
  target: string,
  fallbackWorkspace?: string,
  sender?: string,
): ResolveResult | ResolveError {
  const { project, agent } = parseAddress(target);

  // Validate: empty or whitespace-only agent is a malformed address
  if (!agent || !agent.trim()) {
    return {
      code: 'NO_CONTEXT' as const,
      message: 'Malformed address: agent name is empty.',
    };
  }

  // Spec 755: `architect:<name>` is a per-architect address WITHIN the
  // current workspace, not a `project:agent` cross-workspace address.
  // parseAddress can't distinguish them (the grammar is overloaded), so we
  // intercept here. The resolver below applies the spoofing check when
  // sender is a builder.
  if (project && project.toLowerCase() === 'architect') {
    if (!fallbackWorkspace) {
      return {
        code: 'NO_CONTEXT',
        message: 'Cannot resolve architect:<name> address without workspace context.',
      };
    }
    return resolveArchitectByName(agent, fallbackWorkspace, sender);
  }

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
  return resolveAgentInWorkspace(agent, workspacePath, sender);
}

/**
 * Resolve `architect:<name>` to a terminal ID within the given workspace.
 *
 * Spec 755 enforcement when sender is a builder:
 *   - If the builder's `spawned_by_architect` matches `<name>`: allowed.
 *   - If it doesn't match: rejected with the spoofing error.
 * Non-builder senders may address any architect by name.
 */
function resolveArchitectByName(
  name: string,
  workspacePath: string,
  sender?: string,
): ResolveResult | ResolveError {
  const allWorkspaces = getWorkspaceTerminals();
  const entry = allWorkspaces.get(workspacePath);

  if (!entry) {
    return {
      code: 'NOT_FOUND',
      message: `Workspace '${workspacePath}' has no registered terminals.`,
    };
  }

  // Spoofing check: builder senders can only address their own architect.
  if (sender) {
    const spawningArchitect = lookupBuilderSpawningArchitect(sender, workspacePath);
    if (spawningArchitect !== undefined && spawningArchitect !== name) {
      return {
        code: 'NOT_FOUND',
        message: addressSpoofingErrorMessage(sender),
      };
    }
  }

  const terminalId = entry.architects.get(name);
  if (!terminalId) {
    return {
      code: 'NOT_FOUND',
      message: `Architect '${name}' not found in workspace '${path.basename(workspacePath)}'.`,
    };
  }
  return { terminalId, workspacePath, agent: name };
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
 * Checks architect first (with Spec 755 affinity-aware routing when `sender`
 * is a builder), then builders by exact match, then builders by tail match.
 *
 * Spec 755 architect resolution:
 *   - Fast path: single-architect workspace with name 'main' — return that
 *     terminal directly. Identical to today's behavior; avoids the state.db
 *     read entirely for the common case.
 *   - Builder sender, target 'architect': look up the builder's
 *     spawnedByArchitect. If that architect is registered, route there.
 *     Otherwise fall back to 'main', else error with the spec-mandated
 *     legacy-builder / architect-gone messages.
 *   - Builder sender, target 'architect:<name>': allowed only if <name>
 *     matches the sender's spawnedByArchitect. Otherwise rejected (spoofing).
 *   - Non-builder sender (or no sender), target 'architect': route to 'main'
 *     (or first registered if 'main' is absent). Unchanged from today.
 */
function resolveAgentInWorkspace(
  agent: string,
  workspacePath: string,
  sender?: string,
): ResolveResult | ResolveError {
  const allWorkspaces = getWorkspaceTerminals();
  const entry = allWorkspaces.get(workspacePath);

  if (!entry) {
    return {
      code: 'NOT_FOUND',
      message: `Workspace '${workspacePath}' has no registered terminals.`,
    };
  }

  // Check architect (Spec 755 affinity-aware path).
  if (agent === 'architect' || agent === 'arch') {
    if (entry.architects.size === 0) {
      return {
        code: 'NOT_FOUND',
        message: `No architect terminal found in workspace '${path.basename(workspacePath)}'.`,
      };
    }

    // Single-architect fast path: most workspaces have only 'main'.
    // Identical answer to the full resolution path, but skips the state.db
    // read entirely. Guarantees latency parity for solo-architect users.
    if (entry.architects.size === 1 && entry.architects.has(DEFAULT_ARCHITECT_NAME)) {
      const terminalId = entry.architects.get(DEFAULT_ARCHITECT_NAME)!;
      return { terminalId, workspacePath, agent: 'architect' };
    }

    // Builder-context detection via state.db row presence. Three-valued
    // result distinguishes "builder with explicit name" / "legacy builder"
    // / "not a builder" — see lookupBuilderSpawningArchitect.
    const spawningArchitect = sender ? lookupBuilderSpawningArchitect(sender, workspacePath) : undefined;

    if (spawningArchitect !== undefined && sender) {
      // Sender is a builder.
      if (spawningArchitect === null) {
        // Legacy builder: row exists, spawnedByArchitect is null. Route to
        // 'main' if present; else fail with the spec's verbatim message.
        const main = entry.architects.get(DEFAULT_ARCHITECT_NAME);
        if (main) return { terminalId: main, workspacePath, agent: 'architect' };
        return {
          code: 'NOT_FOUND',
          message: legacyBuilderErrorMessage(sender, [...entry.architects.keys()]),
        };
      }
      // Builder has an explicit spawning architect.
      const target = entry.architects.get(spawningArchitect);
      if (target) return { terminalId: target, workspacePath, agent: 'architect' };
      // Architect-gone fallback: route to 'main' if present; else fail.
      const main = entry.architects.get(DEFAULT_ARCHITECT_NAME);
      if (main) return { terminalId: main, workspacePath, agent: 'architect' };
      return {
        code: 'NOT_FOUND',
        message: architectGoneErrorMessage(sender, spawningArchitect, [...entry.architects.keys()]),
      };
    }

    // Non-builder sender (or no sender): 'main' first, then first registered.
    // Issue #1094 defense-in-depth: a sender that LOOKS like a builder id but
    // had no state.db row (lookupBuilderSpawningArchitect → undefined) means
    // affinity routing was silently bypassed — most likely a non-canonical,
    // unverified builder id (e.g. a bare worktree name). Make it visible
    // instead of quietly delivering to 'main'.
    if (sender && !entry.architects.has(sender) && looksLikeBuilderId(sender)) {
      console.warn(
        `[tower] affinity routing bypassed: sender '${sender}' looks like a builder id but has ` +
          `no matching row in workspace '${path.basename(workspacePath)}' — routing 'architect' to ` +
          `'main'. The sender may be a non-canonical builder id (issue #1094).`,
      );
    }
    const terminalId =
      entry.architects.get(DEFAULT_ARCHITECT_NAME) ?? entry.architects.values().next().value!;
    return { terminalId, workspacePath, agent: 'architect' };
  }

  // `architect:<name>` addressing is handled earlier in resolveTarget via
  // resolveArchitectByName. Reaching this point means the agent is a plain
  // workspace-local name (builder/shell), so we fall through to those.

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
 * A target resolved from the durable agent registry (global.db) rather than the
 * live terminal map — a KNOWN agent that currently has no live PTY. There is no
 * `terminalId` by construction (that is the whole point). Spec 1313 uses this to
 * hold mail (`no-live-pty`) for an agent that exists but is offline (e.g. a
 * builder registered in global.db while Tower is mid-restart) instead of 404ing.
 */
export interface RegistryResolveResult {
  workspacePath: string;
  agent: string;
  /** Whether the resolved agent is an architect vs a builder — drives formatting. */
  kind: 'builder' | 'architect';
}

/**
 * Registry fallback for {@link resolveTarget}'s `NOT_FOUND` case (Spec 1313,
 * Phase 4). When no live terminal matches, resolve the address against the
 * persistent global.db registry so a send to a known-but-offline agent is HELD,
 * not dropped. Deliberately narrower than the live resolver:
 *
 * - Bare `<builder>` (with a workspace context) — exact then tail match against
 *   `getBuilders(ws)`; ambiguous tail is still AMBIGUOUS (never guess).
 * - `architect` / `architect:<name>` — resolved to a SPECIFIC architect name via
 *   the persisted architect rows, preserving the Spec 755 spoofing constraint
 *   (a builder sender may only address its own spawning architect).
 * - `project:<agent>` cross-workspace — the target workspace is resolved by
 *   basename (the same mapping the live resolver uses) and the agent held against
 *   ITS registry, so the mailbox-first hold applies across every address form.
 *   Boundary: workspace resolution reads the live workspace map, so the target
 *   workspace must be active (its agent's PTY may be dead); a fully-inactive
 *   workspace still NOT_FOUNDs, exactly as the live resolver does.
 *
 * A cleaned-up builder (`afx cleanup`) is deleted from global.db too, so it
 * correctly resolves to NOT_FOUND here — mail is only held for agents that still
 * exist in the registry.
 */
export function resolveAgentInRegistry(
  target: string,
  fallbackWorkspace?: string,
  sender?: string,
): RegistryResolveResult | ResolveError {
  const { project, agent } = parseAddress(target);

  if (!agent || !agent.trim()) {
    return { code: 'NO_CONTEXT', message: 'Malformed address: agent name is empty.' };
  }

  // architect:<name> — per-architect address within the workspace (Spec 755).
  if (project && project.toLowerCase() === 'architect') {
    if (!fallbackWorkspace) {
      return { code: 'NO_CONTEXT', message: 'Cannot resolve architect:<name> address without workspace context.' };
    }
    return resolveRegistryArchitectByName(agent, fallbackWorkspace, sender);
  }

  // Determine the workspace to resolve the agent within. An explicit `project:`
  // maps to that workspace by basename (the same mapping the live resolver uses),
  // so a cross-workspace send to a known agent whose PTY is down is held against
  // ITS registry rather than dropped; otherwise the agent resolves within the
  // sender's workspace.
  let ws: string;
  if (project) {
    const wsResult = findWorkspaceByBasename(project);
    if (isResolveError(wsResult)) return wsResult;
    ws = wsResult.workspacePath;
  } else {
    if (!fallbackWorkspace) {
      return { code: 'NO_CONTEXT', message: 'Cannot resolve agent without project context.' };
    }
    ws = fallbackWorkspace;
  }

  // Bare architect / arch.
  if (agent === 'architect' || agent === 'arch') {
    return resolveRegistryArchitect(ws, sender);
  }

  // Bare builder — exact (case-insensitive), then tail match with leading-zero strip.
  const builders = getBuilders(ws);
  const lower = agent.toLowerCase();
  for (const b of builders) {
    if (b.id.toLowerCase() === lower) return { workspacePath: ws, agent: b.id, kind: 'builder' };
  }
  const stripped = stripLeadingZeros(agent).toLowerCase();
  const tail = builders.filter((b) => b.id.toLowerCase().endsWith(`-${stripped}`));
  if (tail.length === 1) return { workspacePath: ws, agent: tail[0].id, kind: 'builder' };
  if (tail.length > 1) {
    return {
      code: 'AMBIGUOUS',
      message: `Agent '${agent}' is ambiguous — matches ${tail.length} registered builders: ${tail.map((b) => b.id).join(', ')}. Use the full name.`,
    };
  }

  return { code: 'NOT_FOUND', message: `Agent '${agent}' is not a live terminal and is not registered in workspace '${path.basename(ws)}'.` };
}

/** Registry analogue of the bare-`architect` affinity resolution (offline hold). */
function resolveRegistryArchitect(
  workspacePath: string,
  sender?: string,
): RegistryResolveResult | ResolveError {
  const architects = getArchitects(workspacePath);
  if (architects.length === 0) {
    return { code: 'NOT_FOUND', message: `No architect registered in workspace '${path.basename(workspacePath)}'.` };
  }
  // Builder sender → its spawning architect if still registered, else 'main'.
  const spawning = sender ? lookupBuilderSpawningArchitect(sender, workspacePath) : undefined;
  if (spawning) {
    if (getArchitectByName(workspacePath, spawning)) return { workspacePath, agent: spawning, kind: 'architect' };
  }
  if (getArchitectByName(workspacePath, DEFAULT_ARCHITECT_NAME)) {
    return { workspacePath, agent: DEFAULT_ARCHITECT_NAME, kind: 'architect' };
  }
  return { workspacePath, agent: architects[0].name, kind: 'architect' };
}

/** Registry analogue of `architect:<name>`, preserving the Spec 755 spoofing check. */
function resolveRegistryArchitectByName(
  name: string,
  workspacePath: string,
  sender?: string,
): RegistryResolveResult | ResolveError {
  if (sender) {
    const spawning = lookupBuilderSpawningArchitect(sender, workspacePath);
    if (spawning !== undefined && spawning !== name) {
      return { code: 'NOT_FOUND', message: addressSpoofingErrorMessage(sender) };
    }
  }
  if (!getArchitectByName(workspacePath, name)) {
    return { code: 'NOT_FOUND', message: `Architect '${name}' is not registered in workspace '${path.basename(workspacePath)}'.` };
  }
  return { workspacePath, agent: name, kind: 'architect' };
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
export function isResolveError<T extends object>(result: T | ResolveError): result is ResolveError {
  return 'code' in result;
}
