import streamDeck from '@elgato/streamdeck';
import { TowerClient } from '@cluesmith/codev-client';
import { CodevStore } from './store.js';
import {
  CodevAction,
  BuilderAction,
  DevServerAction,
  FleetSlot,
  ApproveGate,
  ZoomNav,
  PrNav,
  SpawnNav,
  DiffFileNav,
  DiffHunkNav,
  ScrollNav,
} from './actions.js';

/**
 * Plugin entry point. The Elgato runtime launches this as a Node process and
 * hands it the Stream Deck WebSocket port via argv; `connect()` completes the
 * handshake.
 *
 * One CodevStore (Tower client + overview cache + zoom cursor) backs every
 * action. Actions register before `connect()`; the store starts its SSE stream
 * + first fetch after, so a failed initial connection just renders empty/offline
 * rather than blocking the handshake.
 */
const store = new CodevStore({
  client: new TowerClient(),
  openUrl: (url) => streamDeck.system.openUrl(url),
});

const actions = [
  new CodevAction(store),
  new BuilderAction(store),
  new DevServerAction(store),
  new FleetSlot(store),
  new ApproveGate(store),
  new ZoomNav(store),
  new PrNav(store),
  new SpawnNav(store),
  new DiffFileNav(store),
  new DiffHunkNav(store),
  new ScrollNav(store),
];
for (const action of actions) streamDeck.actions.registerAction(action);

// Follow the focused editor provider: the VSCode extension fires a deep link
// (streamdeck://plugins/message/<uuid>/active?workspace=<path>&builder=<id>) when
// its window gains focus / a builder becomes active (diff, terminal, or sidebar
// row), so the plugin re-targets the workspace and builder the user is on. `builder`
// is the builder id (OverviewBuilder.id, or the roleId form for terminals); sync it
// AFTER the workspace so the overview that contains it is loaded.
streamDeck.system.onDidReceiveDeepLink((ev) => {
  const workspace = ev.url.queryParameters.get('workspace');
  const builder = ev.url.queryParameters.get('builder');
  streamDeck.logger.debug(`deep-link active: workspace=${workspace ?? '(none)'} builder=${builder ?? '(none)'}`);
  if (workspace) {
    void store.syncToWorkspace(workspace).then(() => { if (builder) store.syncToBuilder(builder); });
  } else if (builder) {
    store.syncToBuilder(builder);
  }
});

await streamDeck.connect();
void store.start();
