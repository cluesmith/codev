/**
 * The controller surface (`@cluesmith/codev-sdk/controller`): the curated
 * entry point for outside-in Tower integrations (issue #1189, absorbing the
 * `@cluesmith/codev-client` posture). A controller READS overview state and
 * ACTS by POSTing canonical verbs to the command relay; it never spawns or
 * holds Tower state.
 *
 * This subpath is a true capability surface (issue #1411): it exposes only the
 * controller capability set — read (overview, workspaces, SSE subscription) and
 * act (`sendCommand`, `sendCanvasCommand`) — via `ControllerClient` and the
 * `createControllerClient` factory, plus the types/constants a controller reads.
 * The full `TowerClient` (host/admin operations included) is deliberately NOT
 * re-exported here; hosts that need it import it from
 * `@cluesmith/codev-sdk/tower-client`. The export list is pinned by a surface
 * test so it can only grow deliberately.
 *
 * Auth for local Node controllers: inject `readLocalKey` from
 * `@cluesmith/codev-sdk/node` as `getAuthKey` when calling the factory.
 */

import { TowerClient, type TowerClientOptions } from './tower-client.js';

export { parseSseText, type SseEnvelope } from './sse.js';
export { type TowerClientOptions, type TowerWorkspace } from './tower-client.js';
export { DEFAULT_TOWER_PORT } from './constants.js';

/**
 * The controller capability surface: exactly the methods a controller needs to
 * READ Tower state (`getOverview`, `listWorkspaces`, `subscribeEvents`) and ACT
 * on it (`sendCommand`, `sendCanvasCommand`). Derived from `TowerClient` with
 * `Pick` so the signatures stay in lockstep with the client, while host/admin
 * operations (`addArchitect`, `killTerminal`, `sweepHusks`, the canvas view
 * registration trio, …) never reach this surface.
 */
export type ControllerClient = Pick<
  TowerClient,
  'getOverview' | 'listWorkspaces' | 'subscribeEvents' | 'sendCommand' | 'sendCanvasCommand'
>;

/**
 * Construct a controller client. Auth and transport arrive as injected adapters
 * via `options` (a local Node controller passes `getAuthKey: readLocalKey` from
 * `@cluesmith/codev-sdk/node`).
 *
 * The full client is built internally, but only the five capability methods are
 * bound onto the returned object — the host/admin methods are absent from it at
 * RUNTIME, not merely hidden by the type. That is what makes this a capability
 * rather than a doc note: a plain-JS or `as any` consumer still cannot reach
 * `killTerminal`, `addArchitect`, `sweepHusks`, or the view-registration trio.
 */
export function createControllerClient(options?: TowerClientOptions): ControllerClient {
  const client = new TowerClient(options);
  return {
    getOverview: client.getOverview.bind(client),
    listWorkspaces: client.listWorkspaces.bind(client),
    subscribeEvents: client.subscribeEvents.bind(client),
    sendCommand: client.sendCommand.bind(client),
    sendCanvasCommand: client.sendCanvasCommand.bind(client),
  };
}

/*
 * The overview wire types a controller reads (issue #1357): `getOverview`
 * returns `OverviewData`, so the contract ships with the surface — one import,
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

/*
 * The canvas command vocabulary and its result shapes (spec 1401), so a controller can drive an
 * open artifact-canvas view and act on the answer without a direct codev-types dependency.
 *
 * `CanvasCommandClientErrorCode` is one member wider than the wire union: it adds `unreachable`,
 * which the client synthesizes when Tower gave no answer at all. A controller must be able to
 * tell that apart from `no-canvas`, or it will report "no canvas open" while Tower is simply
 * down.
 *
 * View registration is deliberately NOT re-exported here. Controllers drive views; hosts own
 * them, and those methods stay on the full client for hosts to reach.
 */
export type {
  CanvasCommand,
  CanvasCommandClientResult,
  CanvasCommandClientErrorCode,
  CanvasCommandErrorCode,
  CanvasCommandTarget,
} from '@cluesmith/codev-types';
