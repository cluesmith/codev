/**
 * The address book (Spec 1940, Decision 6, stage 1): every workspace on this Tower and
 * its agents, each as the address ONE caller would type, so nobody has to guess one.
 *
 * The listing is true for whoever asks. It does not work out for itself whether an
 * address reaches its agent: it writes the address, reads it back with the shared parser
 * and resolves it as the caller, live terminals and then the registry, exactly as the send
 * route does. So an address marked sendable is one `afx send` accepts from that caller
 * now, and reaches the agent it is printed beside; the listing and the resolver cannot
 * drift apart, because the listing is the resolver's answer.
 *
 * Nothing is hidden: an agent the caller may not name is still listed, with the way in.
 */

import type { AddressBookAgent, AddressBookResponse, AddressBookWorkspace, AgentAddress } from '@cluesmith/codev-types';
import { tryFormatAddress } from '@cluesmith/codev-sdk/address';
import { getTerminalManager, getWorkspaceTerminals } from './tower-terminals.js';
import type { WorkspaceTerminals } from './tower-types.js';
import { getArchitects, getBuilders, getRegisteredWorkspaces } from '../state.js';
import { isSameWorkspace, printableAddressName } from '../utils/workspace-address.js';
import { workspaceKey } from '../utils/workspace-path.js';
import {
  isResolveError,
  parseTarget,
  refusalToAddress,
  resolveAgentInRegistry,
  resolveTarget,
  type SenderContext,
} from './tower-messages.js';

/** An agent Tower knows in a running workspace: registered, on the terminal map, or both. */
interface Seat {
  kind: AddressBookAgent['kind'];
  /** An architect's name, or a builder's or a shell's id. */
  name: string;
  /** Its entry on the terminal map, if it has one. */
  terminalId: string | undefined;
}

/** `known`, then whatever the terminal map holds that `known` does not, in the map's order. */
function seatsOfKind(kind: Seat['kind'], known: string[], onMap: Map<string, string>): Seat[] {
  const names = [...new Set([...known, ...onMap.keys()])];
  return names.map((name) => ({ kind, name, terminalId: onMap.get(name) }));
}

/**
 * Every agent of a running workspace: architects (the front door's order: `main`, then by
 * registration), builders, shells. An architect or a builder comes from its registry row
 * and from the terminal map, since either can be missing: a row with no terminal is an
 * agent between sessions, whose mail is held. A shell exists only as a terminal.
 */
function seatsOf(workspacePath: string, entry: WorkspaceTerminals): Seat[] {
  return [
    ...seatsOfKind('architect', getArchitects(workspacePath).map((a) => a.name), entry.architects),
    ...seatsOfKind('builder', getBuilders(workspacePath).map((b) => b.id), entry.builders),
    ...seatsOfKind('shell', [], entry.shells),
  ];
}

/** The address of a seat, with or without its workspace in front. */
function addressOf(seat: Seat, workspace: string | undefined): AgentAddress {
  const agent: AgentAddress =
    seat.kind === 'architect' ? { kind: 'architect', name: seat.name } : { kind: 'id', name: seat.name };
  return workspace === undefined ? agent : { ...agent, workspace };
}

/** The address as text, or null when it has no text that reads back as itself. */
function textOf(address: AgentAddress): string | null {
  const formatted = tryFormatAddress(address);
  return formatted.ok ? formatted.text : null;
}

/** Whom `text` reaches when `caller` sends to it now, found as the send route finds it. */
function reachedBy(
  text: string,
  caller: SenderContext,
): { workspacePath: string; terminalId: string } | { workspacePath: string; agent: string; isArchitect: boolean } | null {
  const address = parseTarget(text);
  if (isResolveError(address)) return null;
  const live = resolveTarget(address, caller);
  if (!isResolveError(live)) return { workspacePath: live.workspacePath, terminalId: live.terminalId };
  if (live.code !== 'NOT_FOUND') return null;
  const held = resolveAgentInRegistry(address, caller);
  if (isResolveError(held)) return null;
  return { workspacePath: held.workspacePath, agent: held.agent, isArchitect: held.kind === 'architect' };
}

/** Does `text`, sent by `caller` now, reach `seat` in the workspace at `workspacePath`? */
function reaches(text: string, seat: Seat, workspacePath: string, caller: SenderContext): boolean {
  const reached = reachedBy(text, caller);
  if (reached === null || !isSameWorkspace(reached.workspacePath, workspacePath)) return false;
  if ('terminalId' in reached) return reached.terminalId === seat.terminalId;
  // Held for an agent with no terminal: the registry names it, and says which kind it is.
  return reached.agent === seat.name && reached.isArchitect === (seat.kind === 'architect');
}

/**
 * Is this entry on the terminal map a terminal that takes input now? The send route's own
 * test, so `live` here and a send that is not held `no-live-pty` are the same fact: the
 * session exists (the map keeps an entry for a while after its terminal has exited) and
 * is writable (its process connection is up).
 */
function hasLiveTerminal(terminalId: string): boolean {
  return getTerminalManager().getSession(terminalId)?.writable === true;
}

/**
 * One line of the book. `workspaceName` is the workspace's printable address name, or
 * null; `isCallersOwn` says whether the caller is in this workspace, where an address
 * needs no workspace in front.
 */
function agentEntry(
  seat: Seat,
  workspacePath: string,
  workspaceName: string | null,
  isCallersOwn: boolean,
  caller: SenderContext,
): AddressBookAgent {
  const live = seat.terminalId !== undefined && hasLiveTerminal(seat.terminalId);
  const entry: AddressBookAgent = { kind: seat.kind, name: seat.name, address: null, live, sendable: false };

  // A workspace with no name is reached only from inside, where the short form will do.
  if (workspaceName === null && !isCallersOwn) return entry;
  const address = addressOf(seat, workspaceName ?? undefined);
  const text = textOf(address);
  if (text === null) return entry;
  entry.address = text;

  // The permission check on its own first: it is what tells "you may not name this agent",
  // which has a way in, from "this address reaches someone else", which has none.
  if (refusalToAddress(address, workspacePath, caller) !== null) {
    // In the caller's own workspace that is its own architect; in another, the front door.
    const wayIn = textOf(
      isCallersOwn || workspaceName === null ? { kind: 'architect' } : { kind: 'architect', workspace: workspaceName },
    );
    if (wayIn !== null && reachedBy(wayIn, caller) !== null) entry.reachThrough = wayIn;
    return entry;
  }
  entry.sendable = reaches(text, seat, workspacePath, caller);
  return entry;
}

/** A workspace Tower knows, in the spelling it runs under when it is running. */
interface ListedWorkspace {
  path: string;
  entry: WorkspaceTerminals | undefined;
}

/**
 * Every workspace Tower knows, once each, told apart by key as the naming module tells
 * them: the running ones first, then the registered ones that are not running, each group
 * in path order.
 */
function listedWorkspaces(registeredPaths: string[], terminals: Map<string, WorkspaceTerminals>): ListedWorkspace[] {
  const byKey = new Map<string, ListedWorkspace>();
  for (const [path, entry] of terminals) byKey.set(workspaceKey(path), { path, entry });
  for (const path of registeredPaths) {
    const key = workspaceKey(path);
    if (!byKey.has(key)) byKey.set(key, { path, entry: undefined });
  }
  const inPathOrder = (a: ListedWorkspace, b: ListedWorkspace) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const all = [...byKey.values()];
  return [
    ...all.filter((w) => w.entry !== undefined).sort(inPathOrder),
    ...all.filter((w) => w.entry === undefined).sort(inPathOrder),
  ];
}

/**
 * The address book as `from` sees it. `from` is the caller as `/api/send` knows a sender:
 * its local id and its workspace, either of which may be absent (a person in a plain
 * shell), in which case it is nobody's builder and in no workspace.
 */
export function addressBook(from: SenderContext = {}): AddressBookResponse {
  const caller: SenderContext = from.workspace ? { ...from, workspace: workspaceKey(from.workspace) } : from;
  const registered = getRegisteredWorkspaces();
  const terminals = getWorkspaceTerminals();
  const active = [...terminals.keys()];

  const workspaces = listedWorkspaces(registered.map((w) => w.workspacePath), terminals).map((listed): AddressBookWorkspace => {
    const named = printableAddressName(listed.path, registered, active);
    const isCallersOwn = caller.workspace !== undefined && isSameWorkspace(listed.path, caller.workspace);
    const agents =
      listed.entry === undefined
        ? []
        : seatsOf(listed.path, listed.entry).map((seat) => agentEntry(seat, listed.path, named.name, isCallersOwn, caller));
    const workspace: AddressBookWorkspace = {
      path: listed.path,
      running: listed.entry !== undefined,
      addressName: named.name,
      agents,
    };
    if (named.name === null) workspace.unaddressableReason = named.reason;
    return workspace;
  });
  return { workspaces };
}
