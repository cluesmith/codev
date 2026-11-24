/**
 * @cluesmith/codev-workspace-views (Spec 1963): the Work and Decisions views, shared by the browser
 * dashboard and the VS Code extension. Each host supplies a host adapter (`host.ts`) and maps the
 * `--codev-wv-*` theme tokens (`styles.css`).
 */

export type {
  DecisionImageResult,
  DecisionRulingResult,
  DecisionsFetchResult,
  DecisionsViewHost,
  OverviewState,
  WorkViewHost,
} from './host.js';
export { WorkView } from './components/WorkView.js';
export type { FilePanelState, WorkViewSlots } from './components/WorkView.js';
export { DecisionsView } from './components/DecisionsView.js';
