/**
 * The controller surface (`@cluesmith/codev-sdk/controller`): the curated
 * entry point for outside-in Tower integrations (issue #1189, absorbing the
 * `@cluesmith/codev-client` posture). A controller READS overview state and
 * ACTS by POSTing canonical verbs to the command relay; it never spawns or
 * holds Tower state.
 *
 * Everything here re-exports from the sdk's own modules; the subpath exists
 * so integrations depend on a named, reviewable surface rather than the full
 * client. Auth for local Node controllers: inject `readLocalKey` from
 * `@cluesmith/codev-sdk/node` as `getAuthKey`.
 */

export {
  TowerClient,
  COMMAND_ROUTE,
  type TowerClientOptions,
  type TowerWorkspace,
} from './tower-client.js';
export { parseSseText, type SseEnvelope } from './sse.js';
export { DEFAULT_TOWER_PORT } from './constants.js';

/*
 * The overview wire types a controller reads (issue #1357): `getOverview`
 * returns `OverviewData`, so the contract ships with the client — one import,
 * no direct `@cluesmith/codev-types` dependency for integrations. Must stay
 * the `export type` form (erased at build) so the sdk keeps zero runtime
 * dependencies; the import-boundary test pins this.
 */
export type {
  OverviewData,
  OverviewBuilder,
  OverviewPR,
  OverviewBacklogItem,
} from '@cluesmith/codev-types';
