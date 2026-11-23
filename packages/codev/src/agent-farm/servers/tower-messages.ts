/**
 * Message routing, address resolution, and WebSocket message bus for Tower server.
 * Spec 0110: Messaging Infrastructure — Phases 2 & 3
 *
 * Resolves addresses (`[<workspace>:]architect[:<name>]`, `[<workspace>:]<id>`; Spec 1940)
 * to terminal IDs by querying the workspace terminal registry maintained by
 * tower-terminals.ts.
 * Manages WebSocket subscribers and broadcasts structured message frames.
 */

import path from 'node:path';
import type { WebSocket } from 'ws';
import type { AgentAddress } from '@cluesmith/codev-types';
import {
  parseAddress,
  isRemoteAddress,
  stripLeadingZeros,
  CROSS_TOWER_UNAVAILABLE_MESSAGE,
} from '../utils/agent-names.js';
import { getWorkspaceTerminals } from './tower-terminals.js';
import type { WorkspaceTerminals } from './tower-types.js';
import { lookupBuilderSpawningArchitect, getBuilders, getArchitects, getArchitectByName } from '../state.js';
import { DEFAULT_ARCHITECT_NAME } from '../utils/architect-name.js';
import { workspaceKey } from '../utils/workspace-path.js';

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
 * Error from address resolution. `NOT_FOUND`, `AMBIGUOUS` and `NO_CONTEXT` are as they
 * were. Spec 1940 adds three: the text is not an address (`MALFORMED_ADDRESS`), this
 * sender may not name that recipient (`REFUSED`), and the address names a Tower
 * (`CROSS_TOWER_UNAVAILABLE`).
 */
export interface ResolveError {
  code: 'NOT_FOUND' | 'AMBIGUOUS' | 'NO_CONTEXT' | 'MALFORMED_ADDRESS' | 'REFUSED' | 'CROSS_TOWER_UNAVAILABLE';
  message: string;
}

/**
 * Who is asking (Spec 1940). `id` is the sender's local id, as `/api/send`'s `from`
 * carries it. `workspace` is the sender's workspace: the one an address that names no
 * workspace is read in, and the one the sender is looked up in to learn whether it is a
 * builder.
 */
export interface SenderContext {
  id?: string;
  workspace?: string;
}

/**
 * Read address text with the one shared parser. Callers parse once and hand the
 * structured address to {@link resolveTarget} and {@link resolveAgentInRegistry}.
 */
export function parseTarget(target: string): AgentAddress | ResolveError {
  const parsed = parseAddress(target);
  if (parsed.ok) return parsed.address;
  return {
    code: 'MALFORMED_ADDRESS',
    message: `Malformed address: ${parsed.error.message}. Expected ${parsed.error.expected}.`,
  };
}

/**
 * Spec 1658 (M6): the caller's workspace arrives as the sender spelled it (VS Code `c:\`,
 * Git Bash `C:\`); canonicalize it once so the registry, the architect/builder rows and
 * the mailbox all see one key. POSIX: as given.
 */
function canonicalSender(sender: SenderContext): SenderContext {
  return sender.workspace ? { ...sender, workspace: workspaceKey(sender.workspace) } : sender;
}

/** The workspace an address points into, and whether it is the sender's own. */
interface TargetWorkspace {
  workspacePath: string;
  /** What the sender wrote before the agent; absent when the address named no workspace. */
  writtenName?: string;
  /** Is this the sender's own workspace? Affinity and the Spec 755 wording depend on it. */
  isSendersOwn: boolean;
}

/**
 * The one workspace lookup, shared by the live and the registry resolver so they cannot
 * disagree about where an address points. An address that names a Tower is refused here:
 * until stage 2 a Tower delivers only to itself, and does not yet know its own name.
 */
function locateWorkspace(address: AgentAddress, sender: SenderContext): TargetWorkspace | ResolveError {
  if (isRemoteAddress(address)) {
    return { code: 'CROSS_TOWER_UNAVAILABLE', message: CROSS_TOWER_UNAVAILABLE_MESSAGE };
  }
  const sendersWorkspace = sender.workspace;

  if (address.workspace !== undefined) {
    const found = findWorkspaceByBasename(address.workspace);
    if ('code' in found) return found;
    return {
      workspacePath: found.workspacePath,
      writtenName: address.workspace,
      isSendersOwn: found.workspacePath === sendersWorkspace,
    };
  }
  if (!sendersWorkspace) {
    return {
      code: 'NO_CONTEXT',
      message:
        address.kind === 'architect' && address.name !== undefined
          ? 'Cannot resolve architect:<name> address without workspace context.'
          : 'Cannot resolve agent without project context.',
    };
  }
  return { workspacePath: sendersWorkspace, isSendersOwn: true };
}

/**
 * Is the sender a builder, and if so which architect spawned it? Asked of the SENDER's
 * workspace, wherever the message is going. Three-valued, as
 * {@link lookupBuilderSpawningArchitect} is: a name, `null` for a legacy builder, and
 * `undefined` for a sender that is not a builder. A sender that gave no workspace is
 * matched by its id alone, so leaving the workspace out does not make a builder anything
 * else.
 */
function sendersSpawningArchitect(sender: SenderContext): string | null | undefined {
  if (!sender.id) return undefined;
  return lookupBuilderSpawningArchitect(sender.id, sender.workspace);
}

/** How the sender writes the front door of the workspace an address pointed into. */
function frontDoorAddress(target: TargetWorkspace): string {
  return target.writtenName === undefined ? 'architect' : `${target.writtenName}:architect`;
}

export function crossWorkspaceBuilderErrorMessage(builderId: string, frontDoor: string): string {
  return `${addressSpoofingErrorMessage(builderId)}; reach that workspace through its front door: afx send ${frontDoor} "…"`;
}

/**
 * The builder rule (Spec 755, extended by Spec 1940), shared by both resolvers: a builder
 * may name an architect only if it is its own spawning architect, however the address is
 * written. Returns the refusal, or null when this sender may name `name` in `target`.
 *
 * In its own workspace a builder naming another architect gets Spec 755's refusal,
 * unchanged, with or without the workspace written in front. An architect in any other
 * workspace is never the one that spawned it, whatever it is called, so that is refused
 * with the way in: the workspace's front door.
 */
function refusalToNameArchitect(name: string, target: TargetWorkspace, sender: SenderContext): ResolveError | null {
  const spawningArchitect = sendersSpawningArchitect(sender);
  if (spawningArchitect === undefined || !sender.id) return null; // not a builder
  if (target.isSendersOwn) {
    if (spawningArchitect === name) return null;
    return { code: 'NOT_FOUND', message: addressSpoofingErrorMessage(sender.id) };
  }
  return { code: 'REFUSED', message: crossWorkspaceBuilderErrorMessage(sender.id, frontDoorAddress(target)) };
}

/** What a failed lookup of a named architect tells the sender about the workspace. */
function architectsHint(architectNames: string[], target: TargetWorkspace): string {
  if (architectNames.length === 0) return 'No architect is registered there.';
  return `Architects there: ${architectNames.join(', ')}. Front door: ${frontDoorAddress(target)}.`;
}

/**
 * Resolve an address to a live terminal.
 *
 * 1. {@link locateWorkspace}: the workspace the address names, by basename (several
 *    matches → AMBIGUOUS), else the sender's (none → NO_CONTEXT).
 * 2. Within it: a named architect by name, after the builder rule; bare `architect` by
 *    sender affinity or the front door; anything else as a builder id (exact, then tail;
 *    several tail matches → AMBIGUOUS) and then a shell id.
 *
 * Two questions about the sender are kept apart (Spec 1940). *Permission*, whether it is
 * a builder and which architect it may name, is asked of the sender's own workspace for
 * every target. *Affinity*, whether bare `architect` goes to the architect that spawned
 * it, applies only inside the sender's own workspace: from anywhere else bare `architect`
 * is the front door, `main` or else the first registered, whoever sends.
 */
export function resolveTarget(address: AgentAddress, from: SenderContext = {}): ResolveResult | ResolveError {
  const sender = canonicalSender(from);
  const target = locateWorkspace(address, sender);
  if (isResolveError(target)) return target;
  const { workspacePath } = target;

  const entry = getWorkspaceTerminals().get(workspacePath);
  if (!entry) {
    return {
      code: 'NOT_FOUND',
      message: `Workspace '${workspacePath}' has no registered terminals.`,
    };
  }

  if (address.kind === 'architect') {
    if (address.name !== undefined) {
      const refusal = refusalToNameArchitect(address.name, target, sender);
      if (refusal) return refusal;
      const terminalId = entry.architects.get(address.name);
      if (!terminalId) {
        return {
          code: 'NOT_FOUND',
          message:
            `Architect '${address.name}' not found in workspace '${path.basename(workspacePath)}'. ` +
            architectsHint([...entry.architects.keys()], target),
        };
      }
      return { terminalId, workspacePath, agent: address.name };
    }
    return resolveBareArchitect(entry, target, sender);
  }

  return resolveLocalId(address.name, entry, workspacePath);
}

/**
 * Bare `architect` against live terminals.
 *
 *   - Fast path: a workspace whose only architect is 'main' returns it directly, with no
 *     database read. This is the common case and it is the same answer either way.
 *   - A builder in this workspace: its spawning architect if registered, otherwise
 *     'main', otherwise the Spec 755 legacy-builder / architect-gone errors.
 *   - Anyone else, and every sender from another workspace: 'main', else the first
 *     registered.
 */
function resolveBareArchitect(
  entry: WorkspaceTerminals,
  target: TargetWorkspace,
  sender: SenderContext,
): ResolveResult | ResolveError {
  const { workspacePath } = target;
  if (entry.architects.size === 0) {
    return {
      code: 'NOT_FOUND',
      message: `No architect terminal found in workspace '${path.basename(workspacePath)}'.`,
    };
  }

  // Single-architect fast path: most workspaces have only 'main'. Identical answer to the
  // full resolution path, but skips the database read entirely. Guarantees latency parity
  // for solo-architect users.
  if (entry.architects.size === 1 && entry.architects.has(DEFAULT_ARCHITECT_NAME)) {
    const terminalId = entry.architects.get(DEFAULT_ARCHITECT_NAME)!;
    return { terminalId, workspacePath, agent: 'architect' };
  }

  if (target.isSendersOwn && sender.id) {
    // Builder-context detection via the builder row. Three-valued: "builder with explicit
    // name" / "legacy builder" / "not a builder".
    const spawningArchitect = sendersSpawningArchitect(sender);

    if (spawningArchitect !== undefined) {
      if (spawningArchitect === null) {
        // Legacy builder: row exists, spawnedByArchitect is null. Route to 'main' if
        // present; else fail with the spec's verbatim message.
        const main = entry.architects.get(DEFAULT_ARCHITECT_NAME);
        if (main) return { terminalId: main, workspacePath, agent: 'architect' };
        return {
          code: 'NOT_FOUND',
          message: legacyBuilderErrorMessage(sender.id, [...entry.architects.keys()]),
        };
      }
      // Builder has an explicit spawning architect.
      const own = entry.architects.get(spawningArchitect);
      if (own) return { terminalId: own, workspacePath, agent: 'architect' };
      // Architect-gone fallback: route to 'main' if present; else fail.
      const main = entry.architects.get(DEFAULT_ARCHITECT_NAME);
      if (main) return { terminalId: main, workspacePath, agent: 'architect' };
      return {
        code: 'NOT_FOUND',
        message: architectGoneErrorMessage(sender.id, spawningArchitect, [...entry.architects.keys()]),
      };
    }

    // Issue #1094 defense-in-depth: a sender that LOOKS like a builder id but has no row
    // in its own workspace means affinity routing was silently bypassed, most likely by a
    // non-canonical, unverified builder id (e.g. a bare worktree name). Make it visible
    // instead of quietly delivering to 'main'. A sender in another workspace has no
    // affinity here to bypass, so this is not asked of it.
    if (!entry.architects.has(sender.id) && looksLikeBuilderId(sender.id)) {
      console.warn(
        `[tower] affinity routing bypassed: sender '${sender.id}' looks like a builder id but has ` +
          `no matching row in workspace '${path.basename(workspacePath)}' — routing 'architect' to ` +
          `'main'. The sender may be a non-canonical builder id (issue #1094).`,
      );
    }
  }

  // The front door: 'main' first, then the first registered.
  const terminalId =
    entry.architects.get(DEFAULT_ARCHITECT_NAME) ?? entry.architects.values().next().value!;
  return { terminalId, workspacePath, agent: 'architect' };
}

/** A builder id (exact, then tail with leading zeros stripped) or a shell id, live. */
function resolveLocalId(agent: string, entry: WorkspaceTerminals, workspacePath: string): ResolveResult | ResolveError {
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
 * - A builder id — exact then tail match against `getBuilders(ws)`; ambiguous tail
 *   is still AMBIGUOUS (never guess). Shells are not in the registry.
 * - `architect` / `architect:<name>`, with or without a workspace in front —
 *   resolved to a SPECIFIC architect name via the persisted architect rows, under
 *   the same builder rule and the same affinity rule as the live resolver. Without
 *   the named form here, mail to a named architect in another workspace that is
 *   between sessions would be refused when it should be held (Spec 1940).
 * - Any form with a workspace in front — the workspace comes from the same lookup
 *   the live resolver uses ({@link locateWorkspace}), and the agent is held against
 *   ITS registry. Boundary: that lookup reads the live workspace map, so the target
 *   workspace must be active (its agent's PTY may be dead); a fully-inactive
 *   workspace still NOT_FOUNDs, exactly as the live resolver does.
 *
 * A cleaned-up builder (`afx cleanup`) is deleted from global.db too, so it
 * correctly resolves to NOT_FOUND here — mail is only held for agents that still
 * exist in the registry.
 */
export function resolveAgentInRegistry(
  address: AgentAddress,
  from: SenderContext = {},
): RegistryResolveResult | ResolveError {
  const sender = canonicalSender(from);
  const target = locateWorkspace(address, sender);
  if (isResolveError(target)) return target;
  const ws = target.workspacePath;

  if (address.kind === 'architect') {
    if (address.name === undefined) return resolveRegistryArchitect(target, sender);

    const refusal = refusalToNameArchitect(address.name, target, sender);
    if (refusal) return refusal;
    if (!getArchitectByName(ws, address.name)) {
      return {
        code: 'NOT_FOUND',
        message:
          `Architect '${address.name}' is not registered in workspace '${path.basename(ws)}'. ` +
          architectsHint(getArchitects(ws).map((a) => a.name), target),
      };
    }
    return { workspacePath: ws, agent: address.name, kind: 'architect' };
  }

  // A builder — exact (case-insensitive), then tail match with leading-zero strip.
  const agent = address.name;
  const builders = getBuilders(ws);
  for (const b of builders) {
    if (b.id.toLowerCase() === agent) return { workspacePath: ws, agent: b.id, kind: 'builder' };
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

/**
 * Registry analogue of {@link resolveBareArchitect}, and the same answer: a builder in
 * this workspace gets its spawning architect, else 'main', else the Spec 755 errors;
 * anyone else gets the front door. It must not be more forgiving than the live resolver.
 * The route comes here after the live resolver says NOT_FOUND, and that includes its
 * legacy-builder and architect-gone refusals: answering those with "the first registered"
 * would hold a builder's mail for an architect it has nothing to do with.
 */
function resolveRegistryArchitect(
  target: TargetWorkspace,
  sender: SenderContext,
): RegistryResolveResult | ResolveError {
  const { workspacePath } = target;
  const architects = getArchitects(workspacePath);
  if (architects.length === 0) {
    return { code: 'NOT_FOUND', message: `No architect registered in workspace '${path.basename(workspacePath)}'.` };
  }
  const main = getArchitectByName(workspacePath, DEFAULT_ARCHITECT_NAME);

  const spawning = target.isSendersOwn ? sendersSpawningArchitect(sender) : undefined;
  if (spawning !== undefined && sender.id) {
    // A builder in this workspace.
    if (spawning !== null && getArchitectByName(workspacePath, spawning)) {
      return { workspacePath, agent: spawning, kind: 'architect' };
    }
    if (main) return { workspacePath, agent: DEFAULT_ARCHITECT_NAME, kind: 'architect' };
    const registered = architects.map((a) => a.name);
    return {
      code: 'NOT_FOUND',
      message:
        spawning === null
          ? legacyBuilderErrorMessage(sender.id, registered)
          : architectGoneErrorMessage(sender.id, spawning, registered),
    };
  }

  // The front door: 'main' first, then the first registered.
  return { workspacePath, agent: main ? DEFAULT_ARCHITECT_NAME : architects[0].name, kind: 'architect' };
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
