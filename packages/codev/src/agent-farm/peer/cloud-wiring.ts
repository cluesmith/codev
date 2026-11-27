/**
 * The sending Tower's peer machinery as the running Tower wires it (Spec 1967, phases 7 and
 * 9): one cloud client, one peer list, one outbox and one sender per Tower process. Each
 * reads this Tower's registration from `cloud-config.json` on every use, so a new
 * registration needs nothing here.
 *
 * The tunnel module tells this one of each `auth_ok` ({@link onTunnelAuthOk}), lends it the
 * live tunnel session ({@link setTunnelSessionSource}), starts the outbox when Tower starts
 * ({@link startPeerOutbox}) and stops it when Tower stops ({@link shutdownPeerCloud}).
 * Nothing here imports the tunnel module, which route tests replace with a stub.
 */

import os from 'node:os';
import type { PeerSwitchReport, PeerSwitchState } from '@cluesmith/codev-types';
import { getGlobalDb } from '../db/index.js';
import { readCloudConfig, updateCloudConfig } from '../lib/cloud-config.js';
import { loadConfig, resolvePeerSettings } from '../../lib/config.js';
import type { TunnelPeerSession, TunnelRelayStatus } from '../lib/tunnel-client.js';
import type { PeerCloudRouteDeps } from '../servers/peer-routes.js';
import { CloudClient } from './cloud-client.js';
import { Outbox } from './outbox.js';
import { PeerList, type OwnRegistration } from './peer-list.js';
import { Sender } from './sender.js';
import { readSwitch } from './switch.js';

type Log = (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;

let tunnelSession: () => TunnelPeerSession | null = () => null;
let log: Log = () => {};
let wired: { client: CloudClient; list: PeerList } | null = null;
let sending: { outbox: Outbox; sender: Sender } | null = null;
/** What shows mail waiting for a peer (the held-mail indicator), once Tower has started the outbox. */
let onOutboxChanged: () => void = () => {};

/**
 * The test-only environment variable that sets the outbox's back-off base, in milliseconds
 * (plan, "Test layers"): honoured only under `NODE_ENV=test`, as `AF_TEST_DB` is, so the
 * two-Tower tests retry in milliseconds. A value that is not a positive integer fails loudly.
 */
export const TEST_PEER_BACKOFF_ENV = 'AF_TEST_PEER_BACKOFF_MS';

/** The back-off base the outbox runs with: the protocol's, unless a test Tower sets its own. */
export function outboxBackoffBaseMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = env[TEST_PEER_BACKOFF_ENV];
  if (env.NODE_ENV !== 'test' || value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) {
    throw new Error(`${TEST_PEER_BACKOFF_ENV} must be a positive whole number of milliseconds, got "${value}"`);
  }
  return Number(value);
}

/** The tunnel module lends its live session, and the Tower's log, when it starts. */
export function setTunnelSessionSource(source: () => TunnelPeerSession | null, tunnelLog: Log): void {
  tunnelSession = source;
  log = tunnelLog;
}

function ownRegistration(): OwnRegistration | null {
  const config = readCloudConfig();
  if (config === null) return null;
  return {
    serverUrl: config.server_url,
    towerId: config.tower_id,
    towerName: config.tower_name || null,
    deregistered: Boolean(config.deregistered_at),
  };
}

/**
 * A listing's `self.slug` is this Tower's current name (G4), kept where `auth_ok.slug` is.
 * Only for the registration the listing was for: one written since, for another Tower, is
 * left alone.
 */
function adoptOwnName(towerId: string, slug: string): void {
  const current = readCloudConfig();
  if (current === null || current.tower_id !== towerId || current.tower_name === slug) return;
  if (updateCloudConfig(current.api_key, { tower_name: slug })) {
    log('INFO', `Codev Cloud identity changed: slug "${current.tower_name}" → "${slug}" (from its peer list)`);
  }
}

/** This Tower's cloud client and peer list. */
export function peerCloud(): { client: CloudClient; list: PeerList } {
  if (wired !== null) return wired;
  const client: CloudClient = new CloudClient({
    registration: () => {
      const config = readCloudConfig();
      return config === null ? null : { serverUrl: config.server_url, apiKey: config.api_key };
    },
    relayStated: (): boolean => list.relayStated(),
    now: Date.now,
    log: (level, message) => log(level, message),
  });
  const list: PeerList = new PeerList({
    db: getGlobalDb,
    now: Date.now,
    client,
    registration: ownRegistration,
    adoptOwnName,
    log: (level, message) => log(level, message),
  });
  wired = { client, list };
  return wired;
}

/** This Tower's outbox and sender, over its cloud client and peer list. */
function peerSending(): { outbox: Outbox; sender: Sender } {
  if (sending !== null) return sending;
  const { client, list } = peerCloud();
  const outbox = new Outbox({
    db: getGlobalDb,
    now: Date.now,
    client,
    list,
    registration: ownRegistration,
    backoffBaseMs: outboxBackoffBaseMs(),
    log: (level, message) => log(level, message),
    onChanged: () => onOutboxChanged(),
  });
  const sender = new Sender({
    db: getGlobalDb,
    now: Date.now,
    registration: ownRegistration,
    list,
    outbox,
    // Tower-global, from the user-global layer, as the mailbox settings are read.
    limits: () => resolvePeerSettings(loadConfig(os.homedir())).limits,
    log: (level, message) => log(level, message),
  });
  sending = { outbox, sender };
  return sending;
}

/** The sender `/api/send` hands an address on another Tower to. */
export function peerSender(): Sender {
  return peerSending().sender;
}

/**
 * Tower has started: every peer's queue resumes from its durable rows. `onChanged` is told
 * whenever mail waiting for a peer is added, sent or resolved.
 */
export function startPeerOutbox(onChanged: () => void): void {
  onOutboxChanged = onChanged;
  peerSending().outbox.start();
}

/**
 * Something changed that may let held mail leave now (the switch turned on, a connection
 * under a registration): every peer with held mail is looked at. Nothing before Tower has
 * started the outbox, or after it stopped.
 */
export function wakePeerOutbox(): void {
  sending?.outbox.wake();
}

/**
 * Each `auth_ok`: the relay it stated is noted, and a pending switch-state report is
 * dropped, since that `auth` stated the switch. If the switch changed after the `auth` was
 * sent, the change is reported now, as one made while connected is. Held mail is looked at,
 * since a connection may follow a new registration or bring a relay. `connectedAs` is the
 * registration the session connected under; an `auth_ok` that arrives after another
 * replaced it does none of this.
 */
export function onTunnelAuthOk(
  relay: TunnelRelayStatus,
  statedSwitch: PeerSwitchState | null,
  connectedAs: Pick<OwnRegistration, 'serverUrl' | 'towerId'>,
): void {
  const { client, list } = peerCloud();
  if (!list.noteAuthOk(relay, connectedAs)) {
    log('INFO', 'Peer: a connection made under a registration since replaced answered; its relay state is not taken in');
    return;
  }
  client.cancelSwitchReport();
  wakePeerOutbox();
  if (relay !== 'available' || statedSwitch === null) return;
  const now = readSwitch(getGlobalDb()).state;
  if (now !== statedSwitch) client.reportSwitch(now);
}

/**
 * Tell the cloud the switch changed (contract section 2): only while the tunnel is up and
 * its session has a relay. Otherwise there is nothing to tell now, and the next `auth`
 * states the switch.
 */
export function reportSwitchChange(state: PeerSwitchState): PeerSwitchReport {
  const config = readCloudConfig();
  if (config === null || config.deregistered_at) return 'not-connected';
  const session = tunnelSession();
  if (session === null) return 'tunnel-down';
  if (session.relay !== 'available') return 'no-relay';
  peerCloud().client.reportSwitch(state);
  return 'reporting';
}

/**
 * Tower is stopping: a pending switch-state report is dropped, and the outbox sends nothing
 * more. A relay call in flight finishes and is applied; held mail stays in its rows.
 */
export function shutdownPeerCloud(): void {
  wired?.client.cancelSwitchReport();
  sending?.outbox.stop();
}

/** What the peer routes read of the cloud, in production. */
export function peerCloudRouteDeps(): PeerCloudRouteDeps {
  return {
    scopeToRegistration: () => peerCloud().list.scopeToRegistration(),
    refreshListing: () => peerCloud().list.refresh('on-demand'),
    relay: () => peerCloud().list.relay(),
    reportSwitch: reportSwitchChange,
    tunnelUp: () => tunnelSession() !== null,
    wakeOutbox: wakePeerOutbox,
  };
}
