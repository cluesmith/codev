/**
 * The cloud client and the peer list as the running Tower wires them (Spec 1967, phase 7):
 * one of each per Tower process. Both read this Tower's registration from
 * `cloud-config.json` on every use, so a new registration needs nothing here.
 *
 * The tunnel module tells this one of each `auth_ok` ({@link onTunnelAuthOk}) and lends it
 * the live tunnel session ({@link setTunnelSessionSource}). Nothing here imports the tunnel
 * module, which route tests replace with a stub.
 */

import type { PeerSwitchReport, PeerSwitchState } from '@cluesmith/codev-types';
import { getGlobalDb } from '../db/index.js';
import { readCloudConfig, updateCloudConfig } from '../lib/cloud-config.js';
import type { TunnelPeerSession, TunnelRelayStatus } from '../lib/tunnel-client.js';
import type { PeerCloudRouteDeps } from '../servers/peer-routes.js';
import { CloudClient } from './cloud-client.js';
import { PeerList, type OwnRegistration } from './peer-list.js';
import { readSwitch } from './switch.js';

type Log = (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;

let tunnelSession: () => TunnelPeerSession | null = () => null;
let log: Log = () => {};
let wired: { client: CloudClient; list: PeerList } | null = null;

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

/**
 * Each `auth_ok`: the relay it stated is noted, and a pending switch-state report is
 * dropped, since that `auth` stated the switch. If the switch changed after the `auth` was
 * sent, the change is reported now, as one made while connected is.
 */
export function onTunnelAuthOk(relay: TunnelRelayStatus, statedSwitch: PeerSwitchState | null): void {
  const { client, list } = peerCloud();
  list.noteAuthOk(relay);
  client.cancelSwitchReport();
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

/** Tower is stopping: a pending switch-state report is dropped. */
export function shutdownPeerCloud(): void {
  wired?.client.cancelSwitchReport();
}

/** What the peer routes read of the cloud, in production. */
export function peerCloudRouteDeps(): PeerCloudRouteDeps {
  return {
    refreshListing: () => peerCloud().list.refresh('on-demand'),
    relay: () => peerCloud().list.relay(),
    reportSwitch: reportSwitchChange,
    tunnelUp: () => tunnelSession() !== null,
  };
}
