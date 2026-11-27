/**
 * The local Tower routes behind `afx peer on|off|list|grants|grant|revoke|limits|show` (Spec 1967).
 *
 * Reached only through `handleRequest`'s key check, like every other route. Most are the
 * receiving Tower's own decisions about who may message whom, made by its owner:
 *
 *   GET  /api/peer/switch         the remote-messaging switch
 *   PUT  /api/peer/switch         turn it on (a human's act) or off; the change is reported to Codev Cloud
 *   GET  /api/peer/towers         my other Towers, from Codev Cloud within its call budget, else cached
 *   GET  /api/peer/grants         this Tower's grants [?tower=<tower-ref>]
 *   POST /api/peer/grants         add grants (a human's act)
 *   POST /api/peer/grants/revoke  remove grants
 *   GET  /api/peer/limits         the limits this Tower enforces itself, and Codev Cloud's
 *   GET  /api/peer/show           what a peer lets this Tower message ?tower=<tower-ref>, asked of it
 *   GET  /api/peer/status         remote messaging at a glance, from what this Tower knows (no cloud call)
 *   GET  /api/peer/outbox         mail from a workspace waiting here for a peer ?workspace=<path>
 *   GET  /api/peer/log            the record of cross-Tower attempts [?tower=<tower-ref>][&limit=<n>]
 *
 * Turning the switch on and adding a grant widen who may put text into an agent's prompt,
 * so each requires `humanApproved: true`, which the CLI sends only for
 * `--a-human-explicitly-approved-this` (Decision 9), and neither is accepted from Codev
 * Cloud's tunnel: they are acts of the owner at this machine, and the dashboard has no
 * control that makes them. Turning the switch off and removing grants only narrow access,
 * and need neither.
 *
 * Everything the handlers read is injected ({@link PeerRouteDeps}), so the tests drive the
 * real handlers over HTTP against a temporary database.
 */

import type http from 'node:http';
import type Database from 'better-sqlite3';
import {
  REMOTE_REFUSED_ERROR,
  type PeerCloudRelay,
  type PeerGrantChange,
  type PeerGrantModeName,
  type PeerGrantResponse,
  type PeerGrantsResponse,
  type PeerGrantView,
  type PeerLimitsResponse,
  type PeerLogResponse,
  type PeerOutboxResponse,
  type PeerRevokeResponse,
  type PeerShowResponse,
  type PeerStatusResponse,
  type PeerSwitchReport,
  type PeerSwitchResponse,
  type PeerSwitchState,
  type PeerTowersResponse,
} from '@cluesmith/codev-types';
import type { ResolvedPeerSettings } from '../../lib/config.js';
import { parseJsonBody } from '../utils/server-utils.js';
import { TUNNEL_PROXY_HEADER } from '../lib/tunnel-client.js';
import {
  describeGrant,
  grantHasTarget,
  peerNameOf,
  resolveGrantTargets,
  resolvePeerTower,
  type GrantRecipientsInput,
  type GrantWorld,
  type OwnTower,
} from '../peer/grants.js';
import { HUMAN_APPROVAL_FLAG, readSwitch, setSwitch } from '../peer/switch.js';
import { withdrawRemoteMail } from '../peer/receiver.js';
import type { PeerListRefresh } from '../peer/peer-list.js';
import type { PeerShowResult } from '../peer/sender.js';
import type { Outbox } from '../peer/outbox.js';
import { clockSkewSince } from '../peer/records.js';
import { heldOutboxForWorkspace, marksByPeer, outboxMessageView, peerNamer, readLog } from '../peer/surfaces.js';
import { countReleasedWaiting } from '../db/mailbox.js';
import {
  listGrants,
  listTowerNames,
  putGrant,
  readListing,
  removeGrant,
  PEER_GRANT_MODES,
  type PeerGrant,
} from '../peer/store.js';

/** The prefix every route here is under. */
export const PEER_ROUTE_PREFIX = '/api/peer/';

/** A grant request is a handful of short strings; anything near this is not one. */
const MAX_BODY_BYTES = 64 * 1024;

/** How many rows `afx peer log` shows unless it asks for more, and the most it may ask for. */
export const PEER_LOG_DEFAULT_LIMIT = 50;
export const PEER_LOG_MAX_LIMIT = 1000;

/** What the routes ask of Codev Cloud and the peer list (`peer/cloud-wiring.ts` in production). */
export interface PeerCloudRouteDeps {
  /** Drop a cached peer list fetched under another registration than this Tower's now. */
  scopeToRegistration(): void;
  /** Fetch the peer list on demand, within the call budget; the cached list stands on any failure. */
  refreshListing(): Promise<PeerListRefresh>;
  /** Whether the cloud has a relay, as this Tower knows it now. */
  relay(): PeerCloudRelay;
  /** Tell the cloud the switch changed, and say what was done. */
  reportSwitch(state: PeerSwitchState): PeerSwitchReport;
  /** Is this Tower's own tunnel up? */
  tunnelUp(): boolean;
  /** Look at held mail now: the switch has just turned on, which may let it leave. */
  wakeOutbox(): void;
  /** Ask a peer what it lets this Tower message (`afx peer show`): one discovery query, never held. */
  show(tower: string): Promise<PeerShowResult>;
  /** The outbox, for what `afx inbox` shows of mail waiting for a peer. */
  outbox(): Pick<Outbox, 'inFlightFor' | 'pausedBecause'>;
}

/** What the handlers read. Each is called per request, so a test can change the world between calls. */
export interface PeerRouteDeps {
  db: () => Database.Database;
  now: () => number;
  /** This Tower's workspaces and architects now. */
  world: () => GrantWorld;
  /** This Tower's identity with Codev Cloud, when it has one. */
  ownTower: () => OwnTower;
  /** The `peer` settings of the user's config, checked; throws on a malformed value. */
  settings: () => ResolvedPeerSettings;
  /** Codev Cloud, as the sending Tower sees it. */
  cloud: () => PeerCloudRouteDeps;
  log: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A refusal made safe to print: a refusal can quote what the request named, and the CLI
 * prints it on a terminal. Control characters, format characters (bidi overrides, zero
 * widths) and line and paragraph separators become `?`; letters of any script are kept.
 */
function printable(message: string): string {
  return message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await parseJsonBody(req, MAX_BODY_BYTES);
  } catch (err) {
    throw new RequestError(400, 'INVALID_PARAMS', `Request body refused (${(err as Error).message}).`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RequestError(400, 'INVALID_PARAMS', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RequestError(400, 'INVALID_PARAMS', `'${field}' must be a string.`);
  return value;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = optionalString(body, field);
  if (value === undefined) throw new RequestError(400, 'INVALID_PARAMS', `'${field}' is required.`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new RequestError(400, 'INVALID_PARAMS', `'${field}' must be true or false.`);
  return value;
}

function recipientsOf(body: Record<string, unknown>): GrantRecipientsInput {
  const addresses = body.addresses;
  if (addresses !== undefined && (!Array.isArray(addresses) || !addresses.every((a) => typeof a === 'string'))) {
    throw new RequestError(400, 'INVALID_PARAMS', "'addresses' must be an array of strings.");
  }
  return {
    addresses: addresses as string[] | undefined,
    workspace: optionalString(body, 'workspace'),
    all: optionalBoolean(body, 'all'),
  };
}

function isOverTunnel(req: http.IncomingMessage): boolean {
  // Any value counts, as for the shutdown route: for a refusal the wider test is the safe one.
  return req.headers[TUNNEL_PROXY_HEADER] !== undefined;
}

function refuseOverTunnel(act: string): never {
  throw new RequestError(
    403,
    'NOT_OVER_TUNNEL',
    `${act} is done on this Tower's own machine, not through Codev Cloud.`,
  );
}

function requireHuman(approved: boolean | undefined, act: string, command: string): void {
  if (approved !== true) {
    throw new RequestError(403, 'HUMAN_APPROVAL_REQUIRED', `${act} is a human's decision. A human runs: ${command} ${HUMAN_APPROVAL_FLAG}`);
  }
}

export function createPeerRouteHandler(deps: PeerRouteDeps): (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => Promise<void> {
  /** Every grant as the routes report it, read against the world as it is now. */
  const viewsOf = (grants: readonly PeerGrant[]): PeerGrantView[] => {
    const db = deps.db();
    const world = deps.world();
    const listing = readListing(db);
    const names = listTowerNames(db);
    return grants.map((grant) => {
      const described = describeGrant(grant, world);
      return {
        peerTowerId: grant.peerTowerId,
        peerName: peerNameOf(grant.peerTowerId, listing, names),
        scope: grant.scope,
        mode: grant.mode,
        workspacePath: grant.workspacePath,
        workspaceName: described.workspaceName,
        architect: grant.architect,
        recipient: described.recipient,
        reaches: described.reaches,
        matchesNothing: described.matchesNothing,
        createdAt: grant.createdAt,
        updatedAt: grant.updatedAt,
      };
    });
  };

  /**
   * The peer a tower-ref names. A name that is not in the cached list is looked up again
   * after a refresh within the call budget, since the Tower may be new or renamed.
   */
  const peerOf = async (text: string, purpose: 'grant' | 'existing') => {
    const resolve = () => {
      const db = deps.db();
      return resolvePeerTower(text, readListing(db), listTowerNames(db), deps.ownTower(), purpose);
    };
    let resolved = resolve();
    if (!resolved.ok && resolved.code === 'UNKNOWN_TOWER') {
      await deps.cloud().refreshListing();
      resolved = resolve();
    }
    if (!resolved.ok) {
      const status = resolved.code === 'UNKNOWN_TOWER' ? 404 : resolved.code === 'AMBIGUOUS' ? 409 : 400;
      throw new RequestError(status, resolved.code, resolved.message);
    }
    return resolved;
  };

  const switchResponse = (changed: boolean, cloudReport: PeerSwitchReport | null): PeerSwitchResponse => {
    const db = deps.db();
    const setting = readSwitch(db);
    return {
      state: setting.state,
      changed,
      changedAt: setting.changedAt,
      towerName: deps.ownTower().name,
      grantCount: listGrants(db).length,
      cloudReport,
      releasedWaiting: countReleasedWaiting(db),
    };
  };

  /**
   * Tell the cloud of a change made. The switch has changed whatever comes of this, so a
   * failure here is logged and reported, never turned into a failed request.
   */
  const reportSwitch = (state: PeerSwitchState): PeerSwitchReport => {
    try {
      return deps.cloud().reportSwitch(state);
    } catch (err) {
      deps.log('ERROR', `Peer: the switch change could not be reported to Codev Cloud: ${(err as Error).message}`);
      return 'failed';
    }
  };

  function logWithdrawn(count: number): void {
    if (count > 0) deps.log('INFO', `Peer: ${count} held remote message(s) moved to held for release`);
  }

  async function putSwitch(req: http.IncomingMessage): Promise<PeerSwitchResponse> {
    const body = await readObject(req);
    const state = body.state;
    if (state !== 'on' && state !== 'off') {
      throw new RequestError(400, 'INVALID_PARAMS', "'state' must be \"on\" or \"off\".");
    }
    if (state === 'on') {
      if (isOverTunnel(req)) refuseOverTunnel('Turning remote messaging on');
      requireHuman(optionalBoolean(body, 'humanApproved'), 'Turning remote messaging on', 'afx peer on');
    }
    // Switching off withdraws, in the same transaction, every held remote message: it moves to
    // held for release. Switching on releases nothing; a human releases held mail.
    const db = deps.db();
    const now = deps.now();
    const { change, withdrawn } = db.transaction(() => {
      const change = setSwitch(db, state, now);
      return { change, withdrawn: state === 'off' ? withdrawRemoteMail(db, deps.world(), now) : 0 };
    })();
    if (change.changed) deps.log('INFO', `Peer: remote messaging turned ${state}`);
    logWithdrawn(withdrawn);
    const response = switchResponse(change.changed, change.changed ? reportSwitch(state) : null);
    // Mail held here while the switch was off paused, and may leave now.
    if (change.changed && state === 'on') deps.cloud().wakeOutbox();
    return response;
  }

  async function postGrants(req: http.IncomingMessage): Promise<PeerGrantResponse> {
    if (isOverTunnel(req)) refuseOverTunnel('Adding a grant');
    const body = await readObject(req);
    requireHuman(optionalBoolean(body, 'humanApproved'), 'Adding a grant', 'afx peer grant <tower> …');
    const modeValue = body.mode ?? 'deliver';
    if (!(PEER_GRANT_MODES as readonly unknown[]).includes(modeValue)) {
      throw new RequestError(400, 'INVALID_PARAMS', "'mode' must be \"deliver\" or \"hold\".");
    }
    const mode = modeValue as PeerGrantModeName;
    const peer = await peerOf(requiredString(body, 'tower'), 'grant');
    const targets = resolveGrantTargets(recipientsOf(body), deps.world(), 'grant');
    if (!targets.ok) {
      throw new RequestError(targets.code === 'NOT_FOUND' ? 404 : targets.code === 'AMBIGUOUS' ? 409 : 400, targets.code, targets.message);
    }

    const db = deps.db();
    const now = deps.now();
    // A hold grant now covering held mail withdraws it (hold wins), in the same transaction.
    const { written, withdrawn } = db.transaction(() => {
      const written = (targets.targets ?? []).map((target) => {
        const before = listGrants(db, peer.towerId).find((g) => grantHasTarget(g, target));
        if (before && before.mode === mode) return { grant: before, change: 'unchanged' as const };
        const grant = putGrant(db, { peerTowerId: peer.towerId, ...target, mode }, now);
        return { grant, change: before ? ('mode-changed' as const) : ('added' as const) };
      });
      return { written, withdrawn: withdrawRemoteMail(db, deps.world(), now, peer.towerId) };
    })();
    const views = viewsOf(written.map((w) => w.grant));
    const changes: PeerGrantChange[] = written.map((w, i) => ({ grant: views[i], change: w.change }));
    for (const c of changes) {
      if (c.change !== 'unchanged') deps.log('INFO', `Peer: grant ${c.change} for ${peer.name}: ${c.grant.recipient} (${c.grant.mode})`);
    }
    logWithdrawn(withdrawn);
    return { tower: { towerId: peer.towerId, name: peer.name }, changes, remoteMessaging: readSwitch(db).state };
  }

  async function postRevoke(req: http.IncomingMessage): Promise<PeerRevokeResponse> {
    const body = await readObject(req);
    const peer = await peerOf(requiredString(body, 'tower'), 'existing');
    const targets = resolveGrantTargets(recipientsOf(body), deps.world(), 'revoke');
    if (!targets.ok) {
      throw new RequestError(targets.code === 'NOT_FOUND' ? 404 : targets.code === 'AMBIGUOUS' ? 409 : 400, targets.code, targets.message);
    }
    const db = deps.db();
    const existing = listGrants(db, peer.towerId);
    const chosen = targets.targets === null
      ? existing
      : existing.filter((g) => targets.targets!.some((t) => grantHasTarget(g, t)));
    if (chosen.length === 0) {
      throw new RequestError(
        404,
        'NOT_FOUND',
        existing.length === 0
          ? `${peer.name} has no grant on this Tower.`
          : `${peer.name} has no such grant on this Tower. Its grants: afx peer grants ${peer.name}`,
      );
    }
    const removed = viewsOf(chosen);
    // Held mail the remaining grants no longer admit is withdrawn, in the same transaction.
    const withdrawn = db.transaction(() => {
      for (const grant of chosen) removeGrant(db, grant);
      return withdrawRemoteMail(db, deps.world(), deps.now(), peer.towerId);
    })();
    for (const view of removed) deps.log('INFO', `Peer: grant removed for ${peer.name}: ${view.recipient}`);
    logWithdrawn(withdrawn);
    return { tower: { towerId: peer.towerId, name: peer.name }, removed, releasedWaiting: countReleasedWaiting(db, peer.towerId) };
  }

  async function getGrants(url: URL): Promise<PeerGrantsResponse> {
    const tower = url.searchParams.get('tower');
    const peerTowerId = tower === null ? undefined : (await peerOf(tower, 'existing')).towerId;
    const db = deps.db();
    return { remoteMessaging: readSwitch(db).state, grants: viewsOf(listGrants(db, peerTowerId)) };
  }

  /** My other Towers, and what each may message here. Works whatever the switch says. */
  async function getTowers(): Promise<PeerTowersResponse> {
    const cloud = deps.cloud();
    const refresh = await cloud.refreshListing();
    const db = deps.db();
    const views = viewsOf(listGrants(db));
    const marks = marksByPeer(db);
    return {
      remoteMessaging: readSwitch(db).state,
      towerName: deps.ownTower().name,
      tunnel: cloud.tunnelUp() ? 'up' : 'down',
      relay: cloud.relay(),
      listing: {
        fresh: refresh.fresh,
        refreshedAt: refresh.listing.refreshedAt,
        problem: refresh.problem,
        retryAfterSec: refresh.retryAfterSec,
      },
      towers: refresh.listing.towers.map((t) => ({
        towerId: t.towerId,
        name: t.slug,
        online: t.online,
        protocols: t.protocols,
        remoteMessaging: t.remoteMessaging,
        mayMessage: views.filter((v) => v.peerTowerId === t.towerId),
        marks: marks.get(t.towerId) ?? [],
      })),
      clockSkewSince: clockSkewSince(db, deps.now()),
    };
  }

  /** Remote messaging at a glance (`afx status`, `afx tower status`): the cached list only, never a call to the cloud. */
  function getStatus(): PeerStatusResponse {
    const db = deps.db();
    const listing = readListing(db);
    return {
      remoteMessaging: readSwitch(db).state,
      towerName: deps.ownTower().name,
      tunnel: deps.cloud().tunnelUp() ? 'up' : 'down',
      peers: {
        listed: listing.towers.length,
        online: listing.towers.filter((t) => t.online).length,
        listedAt: listing.refreshedAt,
      },
    };
  }

  /** Mail from one workspace waiting here for a peer, oldest first, and why none leaves when the queues are paused. */
  function getOutbox(url: URL): PeerOutboxResponse {
    const workspace = url.searchParams.get('workspace');
    if (workspace === null || workspace === '') throw new RequestError(400, 'INVALID_PARAMS', "'workspace' is required.");
    const db = deps.db();
    const queue = deps.cloud().outbox();
    const nameOf = peerNamer(db);
    return {
      paused: queue.pausedBecause(),
      messages: heldOutboxForWorkspace(db, workspace).map((row) => outboxMessageView(db, row, queue, nameOf)),
    };
  }

  /** The record, newest first, with the marks set now: every peer's, or one peer's. */
  async function getLog(url: URL): Promise<PeerLogResponse> {
    const tower = url.searchParams.get('tower');
    const limitText = url.searchParams.get('limit');
    let limit = PEER_LOG_DEFAULT_LIMIT;
    if (limitText !== null) {
      if (!/^[1-9][0-9]{0,5}$/.test(limitText) || Number(limitText) > PEER_LOG_MAX_LIMIT) {
        throw new RequestError(400, 'INVALID_PARAMS', `'limit' must be a whole number from 1 to ${PEER_LOG_MAX_LIMIT}.`);
      }
      limit = Number(limitText);
    }
    const peerTowerId = tower === null ? undefined : (await peerOf(tower, 'existing')).towerId;
    const db = deps.db();
    const { entries, truncated } = readLog(db, { peerTowerId, limit });
    const nameOf = peerNamer(db);
    const marks = [...marksByPeer(db)]
      .filter(([id]) => peerTowerId === undefined || id === peerTowerId)
      .flatMap(([id, list]) => list.map((mark) => ({ ...mark, peerTowerId: id, peer: nameOf(id) ?? id })));
    return { entries, truncated, marks, clockSkewSince: clockSkewSince(db, deps.now()) };
  }

  /**
   * `afx peer show`: the peer's answer, or its refusal as a send's is (`403 REMOTE_REFUSED`,
   * the words in `message`). A query is never held, so there is nothing in between.
   */
  async function getShow(url: URL, res: http.ServerResponse): Promise<void> {
    const tower = url.searchParams.get('tower');
    if (tower === null) throw new RequestError(400, 'INVALID_PARAMS', "'tower' is required.");
    const shown = await deps.cloud().show(tower);
    if (shown.outcome === 'answered') {
      const body: PeerShowResponse = {
        tower: { towerId: shown.peer.towerId, name: shown.peer.name },
        addresses: shown.addresses,
        truncated: shown.truncated,
      };
      return sendJson(res, 200, body);
    }
    return sendJson(res, 403, {
      error: REMOTE_REFUSED_ERROR,
      message: printable(shown.message),
      refusedBy: shown.by,
      reason: shown.reason,
      retryAfterSec: shown.retryAfterSec,
      peer: shown.peer?.name ?? null,
    });
  }

  function getLimits(): PeerLimitsResponse {
    let settings: ResolvedPeerSettings;
    try {
      settings = deps.settings();
    } catch (err) {
      throw new RequestError(500, 'CONFIG_INVALID', `The peer settings in your Codev config are not valid: ${(err as Error).message}`);
    }
    const listing = readListing(deps.db());
    const cloud = listing.refreshedAt !== null && listing.limits !== null ? { limits: listing.limits, listedAt: listing.refreshedAt } : null;
    return { tower: settings.limits, recordRetentionDays: settings.recordRetentionDays, cloud };
  }

  return async (req, res, url) => {
    const method = req.method ?? 'GET';
    const route = url.pathname.slice(PEER_ROUTE_PREFIX.length);
    try {
      // Every handler below may read the cached peer list; none may read another registration's.
      deps.cloud().scopeToRegistration();
      switch (route) {
        case 'switch':
          if (method === 'GET') return sendJson(res, 200, switchResponse(false, null));
          if (method === 'PUT') return sendJson(res, 200, await putSwitch(req));
          break;
        case 'towers':
          if (method === 'GET') return sendJson(res, 200, await getTowers());
          break;
        case 'grants':
          if (method === 'GET') return sendJson(res, 200, await getGrants(url));
          if (method === 'POST') return sendJson(res, 200, await postGrants(req));
          break;
        case 'grants/revoke':
          if (method === 'POST') return sendJson(res, 200, await postRevoke(req));
          break;
        case 'limits':
          if (method === 'GET') return sendJson(res, 200, getLimits());
          break;
        case 'show':
          if (method === 'GET') return await getShow(url, res);
          break;
        case 'status':
          if (method === 'GET') return sendJson(res, 200, getStatus());
          break;
        case 'outbox':
          if (method === 'GET') return sendJson(res, 200, getOutbox(url));
          break;
        case 'log':
          if (method === 'GET') return sendJson(res, 200, await getLog(url));
          break;
        default:
          return sendJson(res, 404, { error: 'NOT_FOUND', message: `No peer route ${url.pathname}` });
      }
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: `${method} is not allowed on ${url.pathname}` });
    } catch (err) {
      if (err instanceof RequestError) return sendJson(res, err.status, { error: err.code, message: printable(err.message) });
      deps.log('ERROR', `Peer route ${method} ${url.pathname} failed: ${(err as Error).message}`);
      return sendJson(res, 500, { error: 'INTERNAL_ERROR', message: 'The peer route failed; see the Tower log.' });
    }
  };
}
