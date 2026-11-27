/**
 * Remote messaging at a glance (Spec 1967, Decision 9's status rows): the one line `afx status`
 * prints, and the lines `afx tower status` adds. Both ask Tower's `GET /api/peer/status`, which
 * answers from what Tower already knows and makes no call to Codev Cloud; the two held counts
 * come from the overview, scoped to the workspace as `heldCount` is.
 */

import type { PeerStatusResponse } from '@cluesmith/codev-types';
import type { PeerRouteResult, TowerClient as SdkTowerClient } from '@cluesmith/codev-sdk/tower-client';
import { logger } from '../utils/logger.js';
import { olderTowerError } from '../utils/older-tower.js';

/** The Tower call these lines make. */
export type PeerStatusClient = Pick<SdkTowerClient, 'getPeerStatus'>;

/** How many of my other Towers are online, from the last list this Tower fetched. */
function peersText(peers: PeerStatusResponse['peers']): string {
  if (peers.listedAt === null) return 'peers not listed yet';
  if (peers.listed === 0) return 'no other Towers';
  return `${peers.online} of ${peers.listed} ${peers.listed === 1 ? 'peer' : 'peers'} online`;
}

/**
 * The `afx status` line: the switch, peers online, and this workspace's mail held for release
 * and waiting for a peer.
 */
export function remoteMessagingLine(status: PeerStatusResponse, heldForRelease: number, waitingForPeer: number): string {
  return [
    status.remoteMessaging,
    peersText(status.peers),
    `${heldForRelease} held for release`,
    `${waitingForPeer} waiting for a peer`,
  ].join(' · ');
}

/** Why the status could not be read, as a short value for a `kv` line. */
function unreadable(outcome: Exclude<PeerRouteResult<PeerStatusResponse>, { ok: true }>): string {
  if (outcome.unknownRoute) return 'unknown: this Tower is older than this CLI';
  if (outcome.notRunning) return 'unknown: Tower is not running';
  return `unknown: ${outcome.error}`;
}

/** `afx status`: one line for remote messaging, after the held-mail line. */
export async function renderRemoteMessagingLine(
  client: PeerStatusClient,
  counts: { heldForReleaseCount?: number; waitingForPeerCount?: number } | null,
): Promise<void> {
  const outcome = await client.getPeerStatus();
  if (!outcome.ok) {
    logger.kv('Remote messaging', unreadable(outcome));
    return;
  }
  logger.kv('Remote messaging', remoteMessagingLine(outcome.result, counts?.heldForReleaseCount ?? 0, counts?.waitingForPeerCount ?? 0));
}

/**
 * `afx tower status`: this Tower's name (the cloud's slug while it is connected, which Tower
 * adopts; the stored name otherwise) and the switch. An older Tower says so; one that is not
 * running has already been reported above.
 */
export async function renderTowerRemoteMessaging(client: PeerStatusClient): Promise<void> {
  const outcome = await client.getPeerStatus();
  if (!outcome.ok) {
    if (outcome.notRunning) return;
    logger.blank();
    logger.header('Remote Messaging');
    logger.warn(outcome.unknownRoute ? olderTowerError('has no remote messaging') : outcome.error);
    return;
  }
  const status = outcome.result;
  logger.blank();
  logger.header('Remote Messaging');
  logger.kv('Name', status.towerName ?? 'none: this Tower is not registered with Codev Cloud');
  logger.kv('Remote messaging', status.remoteMessaging === 'on' ? 'on' : 'off (a human turns it on with: afx peer on)');
  logger.kv('Peers', peersText(status.peers));
}
