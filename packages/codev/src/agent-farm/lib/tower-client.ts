/**
 * Tower API Client — re-exports from @cluesmith/codev-core
 *
 * All implementation lives in packages/core/src/tower-client.ts.
 * This file preserves the import path for existing consumers.
 */

export {
  TowerClient,
  getTowerClient,
  type TowerClientOptions,
  type TowerWorkspace,
  type TowerWorkspaceStatus,
  type TowerHealth,
  type TowerTunnelStatus,
  type TowerStatus,
  type TowerTerminal,
} from '@cluesmith/codev-core/tower-client';

export { encodeWorkspacePath, decodeWorkspacePath } from '@cluesmith/codev-core/workspace';
export { DEFAULT_TOWER_PORT, AGENT_FARM_DIR } from '@cluesmith/codev-core/constants';
