/**
 * The local Tower routes behind `afx peer on|off|grants|grant|revoke|limits` (Spec 1967).
 *
 * Reached only through `handleRequest`'s key check, like every other route. These are the
 * receiving Tower's own decisions about who may message whom, made by its owner:
 *
 *   GET  /api/peer/switch         the remote-messaging switch
 *   PUT  /api/peer/switch         turn it on (a human's act) or off
 *   GET  /api/peer/grants         this Tower's grants [?tower=<tower-ref>]
 *   POST /api/peer/grants         add grants (a human's act)
 *   POST /api/peer/grants/revoke  remove grants
 *   GET  /api/peer/limits         the limits this Tower enforces itself
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
import type {
  PeerGrantChange,
  PeerGrantModeName,
  PeerGrantResponse,
  PeerGrantsResponse,
  PeerGrantView,
  PeerLimitsResponse,
  PeerRevokeResponse,
  PeerSwitchResponse,
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await parseJsonBody(req, MAX_BODY_BYTES);
  } catch (err) {
    throw new RequestError(400, 'INVALID_PARAMS', `Request body is not valid JSON (${(err as Error).message}).`);
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
  return req.headers[TUNNEL_PROXY_HEADER] === '1';
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

  const peerOf = (text: string, purpose: 'grant' | 'existing') => {
    const db = deps.db();
    const resolved = resolvePeerTower(text, readListing(db), listTowerNames(db), deps.ownTower(), purpose);
    if (!resolved.ok) {
      const status = resolved.code === 'UNKNOWN_TOWER' ? 404 : resolved.code === 'AMBIGUOUS' ? 409 : 400;
      throw new RequestError(status, resolved.code, resolved.message);
    }
    return resolved;
  };

  const switchResponse = (changed: boolean): PeerSwitchResponse => {
    const db = deps.db();
    const setting = readSwitch(db);
    return {
      state: setting.state,
      changed,
      changedAt: setting.changedAt,
      towerName: deps.ownTower().name,
      grantCount: listGrants(db).length,
    };
  };

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
    const change = setSwitch(deps.db(), state, deps.now());
    if (change.changed) deps.log('INFO', `Peer: remote messaging turned ${state}`);
    return switchResponse(change.changed);
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
    const peer = peerOf(requiredString(body, 'tower'), 'grant');
    const targets = resolveGrantTargets(recipientsOf(body), deps.world(), 'grant');
    if (!targets.ok) {
      throw new RequestError(targets.code === 'NOT_FOUND' ? 404 : targets.code === 'AMBIGUOUS' ? 409 : 400, targets.code, targets.message);
    }

    const db = deps.db();
    const now = deps.now();
    const written = db.transaction(() =>
      (targets.targets ?? []).map((target) => {
        const before = listGrants(db, peer.towerId).find((g) => grantHasTarget(g, target));
        if (before && before.mode === mode) return { grant: before, change: 'unchanged' as const };
        const grant = putGrant(db, { peerTowerId: peer.towerId, ...target, mode }, now);
        return { grant, change: before ? ('mode-changed' as const) : ('added' as const) };
      }),
    )();
    const views = viewsOf(written.map((w) => w.grant));
    const changes: PeerGrantChange[] = written.map((w, i) => ({ grant: views[i], change: w.change }));
    for (const c of changes) {
      if (c.change !== 'unchanged') deps.log('INFO', `Peer: grant ${c.change} for ${peer.name}: ${c.grant.recipient} (${c.grant.mode})`);
    }
    return { tower: { towerId: peer.towerId, name: peer.name }, changes, remoteMessaging: readSwitch(db).state };
  }

  async function postRevoke(req: http.IncomingMessage): Promise<PeerRevokeResponse> {
    const body = await readObject(req);
    const peer = peerOf(requiredString(body, 'tower'), 'existing');
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
    db.transaction(() => {
      for (const grant of chosen) removeGrant(db, grant);
    })();
    for (const view of removed) deps.log('INFO', `Peer: grant removed for ${peer.name}: ${view.recipient}`);
    return { tower: { towerId: peer.towerId, name: peer.name }, removed };
  }

  function getGrants(url: URL): PeerGrantsResponse {
    const db = deps.db();
    const tower = url.searchParams.get('tower');
    const grants = tower === null ? listGrants(db) : listGrants(db, peerOf(tower, 'existing').towerId);
    return { remoteMessaging: readSwitch(db).state, grants: viewsOf(grants) };
  }

  function getLimits(): PeerLimitsResponse {
    let settings: ResolvedPeerSettings;
    try {
      settings = deps.settings();
    } catch (err) {
      throw new RequestError(500, 'CONFIG_INVALID', `The peer settings in your Codev config are not valid: ${(err as Error).message}`);
    }
    return { tower: settings.limits, recordRetentionDays: settings.recordRetentionDays };
  }

  return async (req, res, url) => {
    const method = req.method ?? 'GET';
    const route = url.pathname.slice(PEER_ROUTE_PREFIX.length);
    try {
      switch (route) {
        case 'switch':
          if (method === 'GET') return sendJson(res, 200, switchResponse(false));
          if (method === 'PUT') return sendJson(res, 200, await putSwitch(req));
          break;
        case 'grants':
          if (method === 'GET') return sendJson(res, 200, getGrants(url));
          if (method === 'POST') return sendJson(res, 200, await postGrants(req));
          break;
        case 'grants/revoke':
          if (method === 'POST') return sendJson(res, 200, await postRevoke(req));
          break;
        case 'limits':
          if (method === 'GET') return sendJson(res, 200, getLimits());
          break;
        default:
          return sendJson(res, 404, { error: 'NOT_FOUND', message: `No peer route ${url.pathname}` });
      }
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: `${method} is not allowed on ${url.pathname}` });
    } catch (err) {
      if (err instanceof RequestError) return sendJson(res, err.status, { error: err.code, message: err.message });
      deps.log('ERROR', `Peer route ${method} ${url.pathname} failed: ${(err as Error).message}`);
      return sendJson(res, 500, { error: 'INTERNAL_ERROR', message: 'The peer route failed; see the Tower log.' });
    }
  };
}
