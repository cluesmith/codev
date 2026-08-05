/**
 * Tower API Client — the CLI's composition of `@cluesmith/codev-sdk`.
 *
 * The sdk client is environment-agnostic and defaults to NO auth (issue
 * #1189); this wrapper is where the CLI's Node entitlements are injected:
 * the disk-backed local key (issuing it if missing, via codev-core) and the
 * `BRIDGE_TOWER_HOST` environment override. Every CLI/Tower call site
 * constructs through this module, so their behavior is identical to the
 * pre-split client. Import path preserved for existing consumers.
 */

import {
  TowerClient as SdkTowerClient,
  type TowerClientOptions,
} from '@cluesmith/codev-sdk/tower-client';
import { DEFAULT_TOWER_PORT } from '@cluesmith/codev-sdk/constants';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';

export class TowerClient extends SdkTowerClient {
  constructor(portOrOptions?: number | TowerClientOptions) {
    let options: TowerClientOptions;
    if (typeof portOrOptions === 'number') {
      options = { port: portOrOptions };
    } else {
      options = portOrOptions ?? {};
    }
    super({
      getAuthKey: ensureLocalKey,
      host: process.env.BRIDGE_TOWER_HOST,
      ...options,
    });
  }
}

export {
  type TowerClientOptions,
  type TowerWorkspace,
  type TowerWorkspaceStatus,
  type TowerHealth,
  type TowerTunnelStatus,
  type TowerStatus,
  type TowerTerminal,
  type TerminalType,
  type HuskCandidate,
  type HuskPreview,
  type HuskSweepResult,
} from '@cluesmith/codev-sdk/tower-client';

export { encodeWorkspacePath, decodeWorkspacePath } from '@cluesmith/codev-sdk/workspace';
export { DEFAULT_TOWER_PORT } from '@cluesmith/codev-sdk/constants';
export { AGENT_FARM_DIR } from '@cluesmith/codev-core/constants';

// ── Default client ─────────────────────────────────────────────

let defaultClient: TowerClient | null = null;

export function getTowerClient(port?: number): TowerClient {
  if (!defaultClient || (port && port !== DEFAULT_TOWER_PORT)) {
    defaultClient = new TowerClient({ port });
  }
  return defaultClient;
}
