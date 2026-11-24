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
import { isAddressComponent, isReservedWorkspaceName, tryFormatAddress } from '@cluesmith/codev-sdk/address';
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

/** A workspace Tower knows: registered, running, or both. */
interface KnownWorkspace {
  /** The spelling it runs under when it is running (the key of the live terminal map), else its row's. */
  path: string;
  explicitName: string | null;
  running: boolean;
}

/**
 * Every workspace Tower knows, once each: the rows, and running workspaces that have none.
 * Workspaces are told apart by their key (`workspaceKey`), never by the text of a path, so
 * a row and a running workspace that spell one directory two ways are one workspace, with
 * the row's name.
 *
 * Two ROWS for one directory (two spellings of one Windows path, which boot
 * canonicalization merges, so only a table read before it ran can hold them): the
 * workspace takes the explicit name of the later row that has one, and a later row with
 * no name does not clear an earlier row's. If each row holds a different name, the later
 * row's wins and the earlier name refers to nothing until the rows are merged.
 */
function everyWorkspace(registered: readonly RegisteredWorkspace[], active: Iterable<string>): KnownWorkspace[] {
  const byKey = new Map<string, KnownWorkspace>();
  for (const row of registered) {
    const key = workspaceKey(row.workspacePath);
    byKey.set(key, {
      path: row.workspacePath,
      explicitName: row.explicitName ?? byKey.get(key)?.explicitName ?? null,
      running: false,
    });
  }
  for (const workspacePath of active) {
    const key = workspaceKey(workspacePath);
    byKey.set(key, { path: workspacePath, explicitName: byKey.get(key)?.explicitName ?? null, running: true });
  }
  return [...byKey.values()];
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
 * Also refused: a name that could never be written in an address. The shortest address to
 * a workspace is its front door, `<name>:architect`; if the shared formatter cannot write
 * that and have the shared parser read it back, nobody could ever send to the workspace by
 * this name, and saying so now beats a name that is set and silently useless. The check is
 * the parser's, so the limit it enforces (the length of an address) is the parser's too:
 * there is no number here.
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
  const frontDoor = tryFormatAddress({ kind: 'architect', workspace: name });
  if (!frontDoor.ok) {
    const why = frontDoor.error?.message ?? 'it would be read as another address';
    return {
      ok: false,
      code: 'INVALID_NAME',
      message:
        frontDoor.error?.code === 'ADDRESS_TOO_LONG'
          ? `'${quoted(name)}' is too long to be used in an address: ${why} ` +
            `(the shortest address to this workspace would be <name>:architect).`
          : `'${quoted(name)}' cannot be used in an address: ${why}.`,
    };
  }
  for (const other of everyWorkspace(registered, active)) {
    if (isSameWorkspace(other.path, workspacePath)) continue;
    if (other.explicitName === name) {
      return { ok: false, code: 'NAME_TAKEN', message: `'${name}' is already the name of the workspace ${other.path}.` };
    }
    if (other.explicitName === null && basenameOf(other.path) === name) {
      // Not "is already its address": when this workspace has the same directory name,
      // neither of the two is addressed by it. What is true either way is said.
      return {
        ok: false,
        code: 'NAME_TAKEN',
        message:
          `'${name}' is the directory name of the workspace ${other.path}, which has no name of its own. ` +
          `Choose another name, or first give that workspace one by running \`${WORKSPACE_NAME_COMMAND}\` in it.`,
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
 * The running workspace that `name` refers to, in the spelling it runs under. The name is
 * compared lower-cased, whatever case the caller holds it in.
 *
 * - An explicit name wins, and belongs to its workspace whether or not that workspace is
 *   running. If it is not running the lookup fails saying so: the name is never handed to
 *   another workspace that merely has that basename.
 * - Otherwise the name is matched against the basenames of the running workspaces that
 *   have no explicit name. A workspace with an explicit name no longer answers to its
 *   basename. Two matches fail as ambiguous, naming both paths and the remedy.
 */
export function findWorkspaceByAddressName(
  written: string,
  registered: readonly RegisteredWorkspace[],
  active: Iterable<string>,
): WorkspaceLookup {
  const name = written.toLowerCase();
  const all = everyWorkspace(registered, active);
  const unnamedWithBasename = all.filter((w) => w.explicitName === null && basenameOf(w.path) === name);
  const running = unnamedWithBasename.filter((w) => w.running).map((w) => w.path);

  const holder = all.find((w) => w.explicitName === name);
  if (holder !== undefined) {
    if (holder.running) return { ok: true, workspacePath: holder.path };
    const shadowed = running.length === 0
      ? ''
      : ` ${running.join(', ')} has that directory name but not that name; ` +
        `give it a name of its own by running \`${WORKSPACE_NAME_COMMAND}\` in it.`;
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `Workspace '${name}' (${holder.path}) is not running.${shadowed}`,
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
  const renamed = all.find((w) => w.explicitName !== null && basenameOf(w.path) === name);
  if (renamed !== undefined) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message:
        `Workspace '${name}' not found. ${renamed.path} has that directory name but is addressed as ` +
        `'${renamed.explicitName}'.`,
    };
  }
  // None of these is running: a running one was answered above.
  if (unnamedWithBasename.length > 0) {
    const stopped = unnamedWithBasename.map((w) => w.path).join(', ');
    return { ok: false, code: 'NOT_FOUND', message: `Workspace '${name}' (${stopped}) is not running.` };
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
  const all = everyWorkspace(registered, active);
  const own = all.find((w) => isSameWorkspace(w.path, workspacePath));
  if (own !== undefined && own.explicitName !== null) return { name: own.explicitName, explicit: true };

  const basename = basenameOf(workspacePath);
  const others = all.filter((w) => !isSameWorkspace(w.path, workspacePath));
  const holder = others.find((w) => w.explicitName === basename);
  if (holder !== undefined) {
    return {
      name: null,
      reason:
        `its directory name '${basename}' is the name of the workspace ${holder.path}; ` +
        `give it a name of its own: ${WORKSPACE_NAME_COMMAND}`,
    };
  }
  const sharing = others
    .filter((w) => w.running && w.explicitName === null && basenameOf(w.path) === basename)
    .map((w) => w.path);
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

/**
 * {@link workspaceAddressName}, for a caller about to PRINT the name in an address: a
 * frame, a listing, `afx whoami`. As that function, and one rule more: a directory name
 * outside the address component rule (a space, a capital the file system kept, a colon)
 * is not handed out, because an address printed for someone to paste must need no
 * quoting and must read back as itself. The reason names the remedy, as the others do.
 *
 * An explicit name always fits the rule: it was checked when it was set.
 */
export function printableAddressName(
  workspacePath: string,
  registered: readonly RegisteredWorkspace[],
  active: Iterable<string>,
): WorkspaceAddressName {
  const own = workspaceAddressName(workspacePath, registered, active);
  if (own.name === null || isAddressComponent(own.name)) return own;
  return {
    name: null,
    reason:
      `its directory name '${quoted(own.name)}' cannot be written in an address ` +
      `(letters, digits, '.', '_' and '-' only); give it a name: ${WORKSPACE_NAME_COMMAND}`,
  };
}
