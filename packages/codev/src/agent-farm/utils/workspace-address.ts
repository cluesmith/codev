/**
 * Workspace address names (Spec 1940, Decision 2, "Workspace names").
 *
 * The name an address uses for a workspace is its explicit name if it has one, otherwise
 * its directory basename, compared lower-cased. Every rule about those names is here and
 * nowhere else: what may be set, which workspace a name refers to, and what a workspace's
 * own name is. Tower and the CLI both call this module, so they cannot disagree.
 *
 * The functions take what they need as arguments and read nothing themselves:
 *
 * - `registered`: every workspace Tower has a row for, running or not, with its explicit
 *   name (`known_workspaces`).
 * - `active`: the paths of the workspaces that are running now (the live terminal map).
 *
 * A running workspace with no row counts as registered and unnamed.
 */

import path from 'node:path';
import { isAddressComponent, isReservedWorkspaceName } from '@cluesmith/codev-sdk/address';
import { workspaceKey } from './workspace-path.js';

/** A workspace Tower knows, and the explicit address name it was given, if any. */
export interface RegisteredWorkspace {
  workspacePath: string;
  /** Lower-cased; `null` when the workspace is addressed by its basename. */
  explicitName: string | null;
}

/** How much of a refused value an error quotes back. */
const MAX_QUOTED_LENGTH = 64;

/** The remedy every naming error points at. */
export const WORKSPACE_NAME_COMMAND = 'afx workspace name <name>';

/** A workspace's directory basename as an address would have to write it. */
function basenameOf(workspacePath: string): string {
  return path.basename(workspacePath).toLowerCase();
}

/** Every workspace Tower knows, by path: the rows, and running workspaces that have none. */
function everyWorkspace(registered: readonly RegisteredWorkspace[], active: Iterable<string>): Map<string, string | null> {
  const all = new Map<string, string | null>();
  for (const row of registered) all.set(row.workspacePath, row.explicitName);
  for (const workspacePath of active) {
    if (!all.has(workspacePath)) all.set(workspacePath, null);
  }
  return all;
}

/** A refused value quoted back: printable ASCII, and cut short. */
function quoted(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > MAX_QUOTED_LENGTH ? `${printable.slice(0, MAX_QUOTED_LENGTH)}...` : printable;
}

/**
 * Do two workspace paths name one workspace? Paths are compared by their key
 * (`workspaceKey`: canonical spelling on Windows, as given on POSIX), never as text, so
 * a path that arrived spelled another way is still recognised.
 */
export function isSameWorkspace(a: string, b: string): boolean {
  return workspaceKey(a) === workspaceKey(b);
}

// ============================================================================
// Setting a name
// ============================================================================

export type NameRefusalCode = 'INVALID_NAME' | 'RESERVED_NAME' | 'NAME_TAKEN';

export type NameValidation =
  | { ok: true; name: string }
  | { ok: false; code: NameRefusalCode; message: string };

/**
 * May `workspacePath` take `proposed` as its explicit name? On success `name` is the form
 * to store (lower-cased).
 *
 * Refused when the name does not fit the address component rule, is a reserved word, or
 * is the address name of any other workspace Tower knows, running or not. So a name is
 * never taken from a workspace that is using it, including one that is stopped.
 *
 * There is no length limit of its own: the spec gives none. What bounds a usable name is
 * the length of an address (`MAX_ADDRESS_LENGTH`), which the parser enforces on a send.
 */
export function validateProposedName(
  proposed: string,
  workspacePath: string,
  registered: readonly RegisteredWorkspace[],
  active: Iterable<string>,
): NameValidation {
  // Lower-cased first: the component rule is written for lower case, and `Core` is `core`.
  const name = proposed.toLowerCase();
  if (!isAddressComponent(name)) {
    return {
      ok: false,
      code: 'INVALID_NAME',
      message:
        `'${quoted(proposed)}' cannot be a workspace name: use letters, digits, '.', '_' and '-', ` +
        'starting with a letter or a digit.',
    };
  }
  if (isReservedWorkspaceName(name)) {
    return {
      ok: false,
      code: 'RESERVED_NAME',
      message: `'${name}' is a reserved word in addresses and cannot be a workspace name.`,
    };
  }
  for (const [otherPath, otherExplicit] of everyWorkspace(registered, active)) {
    if (isSameWorkspace(otherPath, workspacePath)) continue;
    if (otherExplicit === name) {
      return { ok: false, code: 'NAME_TAKEN', message: `'${name}' is already the name of the workspace ${otherPath}.` };
    }
    if (otherExplicit === null && basenameOf(otherPath) === name) {
      return {
        ok: false,
        code: 'NAME_TAKEN',
        message: `'${name}' is already the address of the workspace ${otherPath}, by its directory name.`,
      };
    }
  }
  return { ok: true, name };
}

// ============================================================================
// Which workspace a name refers to
// ============================================================================

export type WorkspaceLookup =
  | { ok: true; workspacePath: string }
  | { ok: false; code: 'NOT_FOUND' | 'AMBIGUOUS'; message: string };

/**
 * The running workspace that `name` (lower-cased, as the address parser leaves it) refers
 * to.
 *
 * - An explicit name wins, and belongs to its workspace whether or not that workspace is
 *   running. If it is not running the lookup fails saying so: the name is never handed to
 *   another workspace that merely has that basename.
 * - Otherwise the name is matched against the basenames of the running workspaces that
 *   have no explicit name. A workspace with an explicit name no longer answers to its
 *   basename. Two matches fail as ambiguous, naming both paths and the remedy.
 */
export function findWorkspaceByAddressName(
  name: string,
  registered: readonly RegisteredWorkspace[],
  active: Iterable<string>,
): WorkspaceLookup {
  const activePaths = [...active];
  const all = everyWorkspace(registered, activePaths);
  const unnamedWithBasename = (paths: Iterable<string>): string[] =>
    [...paths].filter((p) => all.get(p) === null && basenameOf(p) === name);
  const running = unnamedWithBasename(activePaths);

  const holder = [...all].find(([, explicit]) => explicit === name)?.[0];
  if (holder !== undefined) {
    if (activePaths.some((p) => isSameWorkspace(p, holder))) return { ok: true, workspacePath: holder };
    const shadowed = running.length === 0
      ? ''
      : ` ${running.join(', ')} has that directory name but not that name; ` +
        `give it a name of its own by running \`${WORKSPACE_NAME_COMMAND}\` in it.`;
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `Workspace '${name}' (${holder}) is not running.${shadowed}`,
    };
  }

  if (running.length === 1) return { ok: true, workspacePath: running[0] };
  if (running.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS',
      message:
        `Workspace '${name}' is ambiguous: ${running.length} workspaces have that directory name: ` +
        `${running.join(', ')}. Give one a name of its own by running \`${WORKSPACE_NAME_COMMAND}\` in it.`,
    };
  }

  // Nothing answers to the name. Say why when Tower knows a workspace it could have meant.
  const renamed = [...all].find(([p, explicit]) => explicit !== null && basenameOf(p) === name);
  if (renamed !== undefined) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `Workspace '${name}' not found. ${renamed[0]} has that directory name but is addressed as '${renamed[1]}'.`,
    };
  }
  const stopped = unnamedWithBasename(all.keys());
  if (stopped.length > 0) {
    return { ok: false, code: 'NOT_FOUND', message: `Workspace '${name}' (${stopped.join(', ')}) is not running.` };
  }
  return {
    ok: false,
    code: 'NOT_FOUND',
    message: `Workspace '${name}' not found. No workspace with that name or directory name is registered.`,
  };
}

// ============================================================================
// A workspace's own name
// ============================================================================

export type WorkspaceAddressName =
  | { name: string; explicit: boolean }
  | { name: null; reason: string };

/**
 * The name other workspaces address `workspacePath` by, or why it has none.
 *
 * It has none when its basename is the explicit name of another workspace (that workspace
 * keeps the name, whichever was registered first), or when another running workspace
 * shares its basename and neither has an explicit name. This is the same answer
 * {@link findWorkspaceByAddressName} gives from the other side: a name returned here
 * resolves to this workspace while it runs, and a workspace with no name is reached by
 * none.
 *
 * A basename is returned as it is, lower-cased. It need not fit the address component
 * rule: a local address matches any basename. A caller about to put the name in an
 * `afx://` address checks it first.
 */
export function workspaceAddressName(
  workspacePath: string,
  registered: readonly RegisteredWorkspace[],
  active: Iterable<string>,
): WorkspaceAddressName {
  const activePaths = [...active];
  const all = everyWorkspace(registered, activePaths);
  const own = [...all].find(([p]) => isSameWorkspace(p, workspacePath));
  if (own !== undefined && own[1] !== null) return { name: own[1], explicit: true };

  const basename = basenameOf(workspacePath);
  const others = [...all].filter(([p]) => !isSameWorkspace(p, workspacePath));
  const holder = others.find(([, explicit]) => explicit === basename);
  if (holder !== undefined) {
    return {
      name: null,
      reason:
        `its directory name '${basename}' is the name of the workspace ${holder[0]}; ` +
        `give it a name of its own: ${WORKSPACE_NAME_COMMAND}`,
    };
  }
  const sharing = others
    .filter(([p, explicit]) => explicit === null && basenameOf(p) === basename)
    .map(([p]) => p)
    .filter((p) => activePaths.some((a) => isSameWorkspace(a, p)));
  if (sharing.length > 0) {
    return {
      name: null,
      reason:
        `it shares the directory name '${basename}' with ${sharing.join(', ')}; ` +
        `give it a name of its own: ${WORKSPACE_NAME_COMMAND}`,
    };
  }
  return { name: basename, explicit: false };
}
