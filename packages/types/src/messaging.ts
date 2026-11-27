/**
 * Reserved `from` sender identity for messages the VS Code extension relays on a
 * human's behalf, such as the Approve-gate button (#1494).
 *
 * Tower's message formatter recognizes this value and renders a distinct
 * `[USER via VS Code]` header, so the recipient (an architect) can tell a button
 * relay apart from a peer-architect instruction or the user typing in the pane.
 * It is a shared wire contract: the extension sets it as `from`, and Tower's
 * `formatMessageForTarget` matches it. Not a builder id, so it bypasses the
 * builder-spoofing check like any other non-builder sender.
 */
export const VSCODE_USER_SENDER = 'vscode-user';

/**
 * Reserved `from` sender identity for the notice Tower sends the hub architect when the
 * owner submits a ruling from the dashboard's Decisions tab (#1828).
 *
 * Like {@link VSCODE_USER_SENDER}, Tower's `formatMessageForTarget` matches it and renders
 * a distinct `[USER via Decisions tab]` header, so the owner's word relayed by the tab is
 * never framed as a builder's message.
 */
export const DECISIONS_TAB_SENDER = 'decisions-tab';

/**
 * A message address in structured form (Spec 1940). This is the wire contract: an address
 * crosses a process boundary as this object, never as text. The text forms
 * (`codev-cloud:architect:tunnel`, `afx://sam@studio/codev:architect:data`) are for people
 * and agents, and are read and written only by the one parser and formatter in
 * `@cluesmith/codev-sdk/address`.
 *
 * Every component is lower-case. A part that is absent means "the same as the reader's":
 * no `owner` is the reader's own account, no `tower` is the reader's own Tower, no
 * `workspace` is the reader's own workspace.
 *
 * - `kind: 'architect'` with no `name` is the bare `architect` form: from a builder in the
 *   same workspace it means that builder's spawning architect, and from anyone else the
 *   workspace's front door (`main`, else the first registered).
 * - `kind: 'architect'` with a `name` is that named architect.
 * - `kind: 'id'` always has a `name`: a builder id (or a tail of one, such as `1940`) or a
 *   shell id, resolved inside the workspace. The type requires it; an object read off the
 *   wire is still checked where it is used.
 */
export type AgentAddress = AddressLocation & AddressAgent;

/** Where the agent is: the parts of an address before the agent. */
export interface AddressLocation {
  /** The account handle of the Tower's owner. Present only for another owner's Tower. */
  owner?: string;
  /** The Tower's name. Present only when the address leaves the reader's Tower. */
  tower?: string;
  /** The workspace's address name. Absent means the reader's workspace. */
  workspace?: string;
}

/** Which agent: an architect, by name or not, or a builder or shell by its id. */
export type AddressAgent =
  | { kind: 'architect'; /** The architect's name. Absent is the bare `architect` form. */ name?: string }
  | { kind: 'id'; /** The builder id (or a tail of one) or the shell id. */ name: string };

/**
 * Where an address is being read from: what the reader may leave out when writing it, and
 * so what a formatter may leave out when printing it for that reader. A Tower that has
 * never connected to Codev Cloud has no `tower` and no `owner`.
 */
export interface AddressReader {
  owner?: string;
  tower?: string;
  workspace?: string;
}

/** Why a piece of text is not an address. One code per shape the parser refuses. */
export type AddressParseErrorCode =
  | 'EMPTY_ADDRESS'
  | 'ADDRESS_TOO_LONG'
  | 'EMPTY_COMPONENT'
  | 'TOO_MANY_BEFORE_ARCHITECT'
  | 'TOO_MANY_AFTER_ARCHITECT'
  | 'TOO_MANY_COMPONENTS'
  | 'INVALID_COMPONENT'
  | 'RESERVED_WORKSPACE'
  | 'REMOTE_BAD_SCHEME'
  | 'REMOTE_NO_WORKSPACE'
  | 'REMOTE_BAD_AUTHORITY'
  | 'REMOTE_PORT'
  | 'REMOTE_QUERY'
  | 'REMOTE_FRAGMENT'
  | 'REMOTE_PERCENT_ENCODING'
  | 'REMOTE_EXTRA_PATH';

/** A refused address: the reason, in words a sender can act on, and the shape expected. */
export interface AddressParseError {
  code: AddressParseErrorCode;
  /** What is wrong with the text that was given. */
  message: string;
  /** The shape an address of this tier must have. */
  expected: string;
}

export type AddressParseResult =
  | { ok: true; address: AgentAddress }
  | { ok: false; error: AddressParseError };

/**
 * A Tower as commands, grants and listings name it (Spec 1940, Decision 1:
 * `tower-ref = [ owner "@" ] tower`). Lower-case. No `owner` means one of the reader's
 * own Towers.
 */
export interface TowerRef {
  owner?: string;
  tower: string;
}

export type TowerRefParseResult =
  | { ok: true; ref: TowerRef }
  | { ok: false; error: AddressParseError };

/**
 * `POST /api/send`'s `error` for a send to another Tower that was refused (Spec 1967): by
 * the sending Tower's own checks, by Codev Cloud, or by the receiving Tower. The answer is a
 * 403 whose `message` is for a person and whose other fields are a {@link RemoteSendRefusal}.
 */
export const REMOTE_REFUSED_ERROR = 'REMOTE_REFUSED';

/** Who refused a send to another Tower. */
export type RemoteRefuser = 'this-tower' | 'cloud' | 'peer';

/** A refused send to another Tower, beside the refusal's `error` and `message`. */
export interface RemoteSendRefusal {
  refusedBy: RemoteRefuser;
  /** The reason as the refusing party named it (contract section 6), or the sending Tower's check. */
  reason: string;
  /** With `rate-limited`, when the refusing party said: seconds until a send may be tried again. */
  retryAfterSec: number | null;
  /** The message's id, when it had been stored on this Tower before it was refused. */
  mailboxId: string | null;
  /** The receiving Tower's current name, once it was known. */
  peer: string | null;
  /**
   * What the receiving Tower said, for a person (contract section 6), with control characters
   * stripped and its length capped by the sending Tower; `null` when it said nothing.
   */
  detail: string | null;
}

/**
 * Where a message held for an agent on another Tower waits (Spec 1967, Decision 5): on the
 * receiving Tower, which delivers it there, or here, on the sending Tower, which sends it
 * when the route to that Tower works again.
 */
export type RemoteHeldWhere = 'recipient' | 'this-tower';

/**
 * A send to another Tower that was not refused, as `POST /api/send` answers it beside the
 * fields every send has (`delivered`, `held`, `reason`, `mailboxId`, `bodyLength`).
 * `resolvedTo` is the recipient's full address, and `mailboxId` the message's id.
 */
export interface RemoteSendAnswer {
  /** The receiving Tower's current name. */
  peer: string;
  /** With `held`: where the message waits. */
  heldWhere?: RemoteHeldWhere;
  /** Held here: how many messages for that Tower are held ahead of this one. */
  ahead?: number;
  /** The receiving Tower had accepted this message before: its first answer was lost. */
  duplicate?: boolean;
  /**
   * What the receiving Tower said, for a person (contract section 6), with control characters
   * stripped and its length capped by the sending Tower. Absent when it said nothing.
   */
  detail?: string;
}
