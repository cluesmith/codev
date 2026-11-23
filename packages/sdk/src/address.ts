/**
 * The one parser and the one formatter for message addresses (Spec 1940).
 *
 * Lives in codev-sdk, beside `agent-names.ts`, so the CLI, Tower and the VS Code
 * extension read and write addresses with the same code. The structured form,
 * `AgentAddress`, is the wire contract in `@cluesmith/codev-types`; text is for people
 * and agents.
 *
 * The grammar (spec Decision 1, candidate G):
 *
 *   address = local | remote
 *   local   = [ workspace ":" ] agent
 *   remote  = "afx://" [ owner "@" ] tower "/" workspace ":" agent
 *   agent   = "architect" [ ":" architect-name ]   ; bare "arch" = bare "architect"
 *           | local-id                             ; a builder id (or a tail), or a shell id
 *
 * Three boundaries, three marks: `@` follows an owner, `//…/` encloses the Tower, `:`
 * separates what is on it. Nothing is found by counting.
 *
 * This module only reads and writes text. It does not know which workspaces, Towers or
 * agents exist: whether an address reaches anyone is the resolver's business.
 */

import type {
  AgentAddress,
  AddressAgent,
  AddressReader,
  AddressParseError,
  AddressParseErrorCode,
  AddressParseResult,
} from '@cluesmith/codev-types';

/** The prefix that marks an address as leaving this Tower. */
export const ADDRESS_SCHEME = 'afx://';

/**
 * Words that cannot be an explicit workspace name, nor the workspace of a remote address:
 * each already means something in the agent position.
 */
export const RESERVED_WORKSPACE_NAMES: readonly string[] = ['architect', 'arch', 'builder'];

/** What a workspace name, an architect name or an id may be in a remote address. */
const COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** A Tower name: letters, digits and hyphens only. */
const TOWER_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** An owner's account handle: as a Tower name, and it starts with a letter (spec Decision 2). */
const OWNER_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
 * The scheme with a slash or the colon missing (`afx:/tower/…`, `afx//tower/…`). Read as a
 * local address these would name a workspace or an id containing a slash, which nothing
 * can have, so they are refused with the shape that was meant. `afx:architect` is not
 * caught: a workspace may be called `afx`.
 */
const MISTYPED_SCHEME = /^afx(:\/|\/\/)/;

/**
 * The longest text read as an address. Nothing valid comes near it; the bound keeps a
 * refusal, which quotes what was wrong, small whatever it was handed.
 */
export const MAX_ADDRESS_LENGTH = 512;
/** The most of a refused value that a parse error quotes back. */
const MAX_QUOTED_LENGTH = 64;

const LOCAL_SHAPE = '[<workspace>:]architect[:<name>] or [<workspace>:]<builder-or-shell-id>';
const REMOTE_SHAPE =
  'afx://[<owner>@]<tower>/<workspace>:architect[:<name>] or afx://[<owner>@]<tower>/<workspace>:<builder-id>';

/**
 * Does `text` fit the component rule (lower-case letters, digits, `.`, `_`, `-`, starting
 * with a letter or digit)? This is the rule for an explicit workspace name and for every
 * part of a remote address after the Tower.
 */
export function isAddressComponent(text: string): boolean {
  return COMPONENT_PATTERN.test(text);
}

/** Is `text` a word that cannot be used as a workspace name in a remote address? */
export function isReservedWorkspaceName(text: string): boolean {
  return RESERVED_WORKSPACE_NAMES.includes(text.toLowerCase());
}

/** Does this address leave the reader's Tower? */
export function isRemoteAddress(address: AgentAddress): boolean {
  return address.tower !== undefined;
}

/**
 * A value that has just failed a component rule, made safe to put in an error message:
 * printable ASCII only, and cut short. The message travels in an HTTP body and is printed
 * on a terminal, and the value is whatever the sender typed.
 */
function quoted(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > MAX_QUOTED_LENGTH ? `${printable.slice(0, MAX_QUOTED_LENGTH)}...` : printable;
}

function fail(code: AddressParseErrorCode, message: string, expected: string): { ok: false; error: AddressParseError } {
  return { ok: false, error: { code, message, expected } };
}

/**
 * Read the part of an address that is the same on every Tower: `[workspace:]agent`.
 * The path of a remote address is, character for character, a local address, so both
 * tiers go through here.
 */
function parseAgentPath(path: string, expected: string): AddressParseResult {
  const parts = path.split(':');
  if (parts.some((part) => part.trim() === '')) {
    return fail('EMPTY_COMPONENT', 'an address cannot have an empty part between or beside its colons', expected);
  }

  // The first `architect` is the kind word. `architect:<x>` therefore always means a
  // named architect, as it does today, and never a workspace called `architect`.
  const kindAt = parts.indexOf('architect');
  if (kindAt >= 0) {
    if (kindAt > 1) {
      return fail(
        'TOO_MANY_BEFORE_ARCHITECT',
        'a local address has at most a workspace before `architect`',
        expected,
      );
    }
    if (parts.length - kindAt - 1 > 1) {
      return fail(
        'TOO_MANY_AFTER_ARCHITECT',
        'at most one part, the architect\'s name, may follow `architect`',
        expected,
      );
    }
    const address: AgentAddress = { kind: 'architect' };
    if (kindAt === 1) address.workspace = parts[0];
    if (parts.length > kindAt + 1) address.name = parts[kindAt + 1];
    return { ok: true, address };
  }

  if (parts.length > 2) {
    return fail(
      'TOO_MANY_COMPONENTS',
      'an address that names a builder or a shell has at most a workspace before the id',
      expected,
    );
  }
  const last = parts[parts.length - 1];
  const address: AgentAddress =
    // `arch` is an alias only where it is the whole agent part (`arch`, `codev:arch`).
    // Before a colon it is a workspace name, so `arch:review` is the id `review` in a
    // workspace called `arch`, as it is today.
    last === 'arch' ? { kind: 'architect' } : { kind: 'id', name: last };
  if (parts.length === 2) address.workspace = parts[0];
  return { ok: true, address };
}

function parseRemote(rest: string): AddressParseResult {
  // No escaping or encoding exists. These three are free for later use, so they are
  // refused now and not quietly read as part of a name.
  if (rest.includes('%')) {
    return fail('REMOTE_PERCENT_ENCODING', 'an afx:// address cannot contain percent-encoding', REMOTE_SHAPE);
  }
  if (rest.includes('?')) {
    return fail('REMOTE_QUERY', 'an afx:// address cannot have a query (`?…`)', REMOTE_SHAPE);
  }
  if (rest.includes('#')) {
    return fail('REMOTE_FRAGMENT', 'an afx:// address cannot have a fragment (`#…`)', REMOTE_SHAPE);
  }

  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash + 1);

  const authorityParts = authority.split('@');
  if (authorityParts.length > 2) {
    return fail('REMOTE_BAD_AUTHORITY', 'an afx:// address names at most one owner before `@`', REMOTE_SHAPE);
  }
  const owner = authorityParts.length === 2 ? authorityParts[0] : undefined;
  const tower = authorityParts[authorityParts.length - 1];
  if (tower.includes(':')) {
    return fail('REMOTE_PORT', 'an afx:// address cannot have a port; a Tower is named, not dialled', REMOTE_SHAPE);
  }
  if (owner === '') {
    return fail('EMPTY_COMPONENT', 'the owner before `@` is empty', REMOTE_SHAPE);
  }
  if (tower === '') {
    return fail('EMPTY_COMPONENT', 'an afx:// address must name a Tower', REMOTE_SHAPE);
  }
  if (owner !== undefined && !OWNER_PATTERN.test(owner)) {
    return fail(
      'INVALID_COMPONENT',
      `owner \`${quoted(owner)}\` may contain only lower-case letters, digits and hyphens, and must start with a letter`,
      REMOTE_SHAPE,
    );
  }
  if (!TOWER_PATTERN.test(tower)) {
    return fail(
      'INVALID_COMPONENT',
      `Tower name \`${quoted(tower)}\` may contain only lower-case letters, digits and hyphens`,
      REMOTE_SHAPE,
    );
  }

  if (path === '') {
    return fail('REMOTE_NO_WORKSPACE', 'an afx:// address must name a workspace and an agent after the Tower', REMOTE_SHAPE);
  }
  if (path.includes('/')) {
    return fail(
      'REMOTE_EXTRA_PATH',
      'after the Tower an afx:// address is one colon-separated part, with no further `/`',
      REMOTE_SHAPE,
    );
  }

  const agent = parseAgentPath(path, REMOTE_SHAPE);
  if (!agent.ok) return agent;
  const { workspace, kind, name } = agent.address;

  // A remote address always names the workspace: there is no "sender's workspace" on
  // another Tower.
  if (workspace === undefined) {
    return fail('REMOTE_NO_WORKSPACE', 'an afx:// address must name the workspace before the agent', REMOTE_SHAPE);
  }
  if (isReservedWorkspaceName(workspace)) {
    return fail(
      'RESERVED_WORKSPACE',
      `\`${workspace}\` is a reserved word and cannot name a workspace in an afx:// address; give that workspace an explicit name`,
      REMOTE_SHAPE,
    );
  }
  for (const [label, value] of [['workspace', workspace], [kind === 'architect' ? 'architect name' : 'id', name]] as const) {
    if (value !== undefined && !isAddressComponent(value)) {
      return fail(
        'INVALID_COMPONENT',
        `${label} \`${quoted(value)}\` may contain only lower-case letters, digits, \`.\`, \`_\` and \`-\`, and must start with a letter or digit`,
        REMOTE_SHAPE,
      );
    }
  }

  const address: AgentAddress = { ...agent.address, tower };
  if (owner !== undefined) address.owner = owner;
  return { ok: true, address };
}

/**
 * Read an address. The text is trimmed and lower-cased first, as addresses always have
 * been. Returns the structured form, or the reason the text is not an address together
 * with the shape that was expected.
 *
 * A local address's workspace is NOT checked against the component rule: a workspace is
 * still matched by its directory basename, whatever characters that has, so no address
 * that works today stops working. The component rule governs remote addresses and
 * explicit workspace names.
 */
export function parseAddress(text: string): AddressParseResult {
  const input = text.trim().toLowerCase();
  if (input === '') {
    return fail('EMPTY_ADDRESS', 'the address is empty', LOCAL_SHAPE);
  }
  if (input.length > MAX_ADDRESS_LENGTH) {
    return fail(
      'ADDRESS_TOO_LONG',
      `an address is at most ${MAX_ADDRESS_LENGTH} characters, and this one has ${input.length}`,
      input.startsWith(ADDRESS_SCHEME) || MISTYPED_SCHEME.test(input) ? REMOTE_SHAPE : LOCAL_SHAPE,
    );
  }
  if (input.startsWith(ADDRESS_SCHEME)) {
    return parseRemote(input.slice(ADDRESS_SCHEME.length));
  }
  if (MISTYPED_SCHEME.test(input)) {
    return fail(
      'REMOTE_BAD_SCHEME',
      `an address that leaves this Tower starts with \`${ADDRESS_SCHEME}\` (a colon and two slashes)`,
      REMOTE_SHAPE,
    );
  }
  return parseAgentPath(input, LOCAL_SHAPE);
}

/**
 * Fill in what an address leaves out, from where it is being read: no Tower means the
 * reader's Tower (and so the reader's owner), no owner means the reader's account, no
 * workspace means the reader's workspace. A part the reader does not have either stays
 * absent.
 */
export function completeAddress(address: AgentAddress, reader: AddressReader): AgentAddress {
  const out: AgentAddress = { ...address };
  if (out.tower === undefined) {
    if (reader.tower !== undefined) out.tower = reader.tower;
    if (reader.owner !== undefined) out.owner = reader.owner;
  } else if (out.owner === undefined && reader.owner !== undefined) {
    out.owner = reader.owner;
  }
  if (out.workspace === undefined && reader.workspace !== undefined) out.workspace = reader.workspace;
  return out;
}

/** Do two addresses name the same thing, part for part? */
export function sameAddress(a: AgentAddress, b: AgentAddress): boolean {
  return (
    a.owner === b.owner &&
    a.tower === b.tower &&
    a.workspace === b.workspace &&
    a.kind === b.kind &&
    a.name === b.name
  );
}

/**
 * The agent part of an address, lower-cased. The type says an id always has a name; an
 * object read off the wire may not, so that is checked here and not assumed.
 */
function loweredAgent(address: AddressAgent): AddressAgent {
  const name: unknown = address.name;
  if (address.kind === 'architect') {
    return typeof name === 'string' ? { kind: 'architect', name: name.toLowerCase() } : { kind: 'architect' };
  }
  if (typeof name !== 'string') {
    throw new Error('Cannot format an address of kind `id` that has no id.');
  }
  return { kind: 'id', name: name.toLowerCase() };
}

function agentText(agent: AddressAgent): string {
  if (agent.kind === 'id') return agent.name;
  return agent.name === undefined ? 'architect' : `architect:${agent.name}`;
}

/**
 * Print an address in the shortest form that is correct for `reader`, in four tiers:
 * `architect:review` within a workspace, `codev:architect:review` within a Tower,
 * `afx://mbp/codev:architect:review` to another Tower of the same owner, and
 * `afx://ana@mbp/codev:architect:review` to anyone else. An owner is always printed when
 * the Tower is not the reader's own, even if the reader has a Tower of the same name.
 *
 * The text is checked before it is returned: read back by {@link parseAddress} from the
 * same reader, it must give the address it was made from. An address that has no text
 * form (a local workspace called `architect`, a name containing a colon) throws, so a
 * caller can never print an address that reaches someone else. Callers that hold a name
 * of unknown shape check it with {@link isAddressComponent} first.
 */
export function formatAddress(address: AgentAddress, reader: AddressReader = {}): string {
  const lowered: AgentAddress = loweredAgent(address);
  if (address.owner !== undefined) lowered.owner = address.owner.toLowerCase();
  if (address.tower !== undefined) lowered.tower = address.tower.toLowerCase();
  if (address.workspace !== undefined) lowered.workspace = address.workspace.toLowerCase();

  if (lowered.owner !== undefined && lowered.tower === undefined) {
    throw new Error('Cannot format an address that names an owner and no Tower.');
  }

  const agent = agentText(lowered);
  const showOwner = lowered.owner !== undefined && lowered.owner !== reader.owner;
  const showTower = lowered.tower !== undefined && (showOwner || lowered.tower !== reader.tower);

  let text: string;
  if (showTower) {
    if (lowered.workspace === undefined) {
      throw new Error('Cannot format an address that names a Tower and no workspace.');
    }
    const authority = showOwner ? `${lowered.owner}@${lowered.tower}` : lowered.tower;
    text = `${ADDRESS_SCHEME}${authority}/${lowered.workspace}:${agent}`;
  } else if (lowered.workspace !== undefined && lowered.workspace !== reader.workspace) {
    text = `${lowered.workspace}:${agent}`;
  } else {
    text = agent;
  }

  const readBack = parseAddress(text);
  if (!readBack.ok || !sameAddress(completeAddress(readBack.address, reader), completeAddress(lowered, reader))) {
    throw new Error(
      `Address has no text form that reads back as itself (would print \`${text}\`` +
        (readBack.ok ? '' : `: ${readBack.error.message}`) +
        ').',
    );
  }
  return text;
}
