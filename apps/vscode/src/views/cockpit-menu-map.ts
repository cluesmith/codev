/**
 * The Cockpit's menu-parity oracle (Spec 1963): where every affordance of the three source views
 * (`codev.workspace`, `codev.agents`, `codev.tower`) lives in the Cockpit. Checked in, so a change on
 * either side is a reviewed diff here; `cockpit-menu-parity.test.ts` holds `package.json` to it.
 *
 * Three kinds of record, one per source affordance:
 * - **menu entries**: every `view/item/context` and `view/title` entry of the source views, with its
 *   text as a snapshot;
 * - **row clicks**: every Workspace-view row that runs a command when clicked;
 * - **welcome content**: every `viewsWelcome` entry of the source views.
 *
 * Each record says where the affordance went: `same` (the same command, group and `when` at the
 * Cockpit's own view, matching the given `viewItem` clause), `relocated` (to named Cockpit menu
 * entries, or to a Cockpit row's own click), or `excluded` (with the reason). Nothing disappears
 * silently. Pure data, no `vscode` import.
 */

/** A `view/item/context` or `view/title` entry as `package.json` declares it. */
export interface MenuEntry {
  location: 'view/item/context' | 'view/title';
  command: string;
  when: string;
  group?: string;
}

/** Where a source affordance lives in the Cockpit. */
export type CockpitPlacement =
  /** The same entry at `view == codev.cockpit`, keyed on this `viewItem` clause. */
  | { same: string }
  /** Moved to these Cockpit menu entries. */
  | { relocated: MenuEntry[] }
  /** Moved to a Cockpit row's own click: rows with this `contextValue` run this command. */
  | { rowClick: { contextValue: RegExp; command: string } }
  /** Moved to a Tower-root state row the Cockpit shows in the same kind of window. */
  | { stateRow: { window: 'auto-connecting' | 'dormant'; label: string; command?: string } }
  /** Not in the Cockpit, and why. */
  | { excluded: string };

export interface MenuRecord {
  source: MenuEntry;
  cockpit: CockpitPlacement;
}

export interface RowClickRecord {
  /** The Workspace-view row, by its `contextValue`. */
  row: string;
  command: string;
  cockpit: CockpitPlacement;
}

export interface WelcomeRecord {
  source: { view: string; contents: string; when: string };
  cockpit: CockpitPlacement;
}

// ── The Cockpit's own entries the records point at ──────────────────────────

const VIEW = 'view == codev.cockpit';
const CURRENT_ROW = `${VIEW} && viewItem =~ /^cockpit-workspace-current(-.*)?$/`;
const ownRow = (rest: string) => `${VIEW} && viewItem =~ /^cockpit-workspace-(current|parent)${rest}$/`;

const ctx = (command: string, when: string, group: string): MenuEntry => ({ location: 'view/item/context', command, when, group });
const title = (command: string, when: string, group: string): MenuEntry => ({ location: 'view/title', command, when, group });

export const COCKPIT_ENTRIES = {
  removeArchitect: ctx('codev.removeArchitect', `${VIEW} && viewItem == cockpit-architect-sibling`, '1_primary@1'),
  spawnInline: ctx('codev.spawnBuilder', CURRENT_ROW, 'inline@3'),
  shellInline: ctx('codev.newShell', CURRENT_ROW, 'inline@4'),
  addArchitectInline: ctx('codev.addArchitect', CURRENT_ROW, 'inline@5'),
  spawn: ctx('codev.spawnBuilder', CURRENT_ROW, '1_workspace@1'),
  shell: ctx('codev.newShell', CURRENT_ROW, '1_workspace@2'),
  addArchitect: ctx('codev.addArchitect', CURRENT_ROW, '1_workspace@3'),
  openWebInterface: ctx('codev.cockpit.openWebInterface', ownRow('(-.*)?'), '2_web@1'),
  startDev: ctx('codev.runWorkspaceDev', ownRow('-dev-start(-devurls)?'), '3_dev@1'),
  stopDev: ctx('codev.stopWorkspaceDev', ownRow('-dev-stop(-devurls)?'), '3_dev@1'),
  stopOtherDev: ctx('codev.stopWorktreeDev', ownRow('-dev-stop-other(-devurls)?'), '3_dev@1'),
  openDevUrl: ctx('codev.openDevUrl', ownRow('(-.*)?-devurls'), '3_dev@2'),
  refresh: title('codev.cockpit.refresh', VIEW, 'navigation@1'),
  accordionOff: title('codev.disableBuildersAutoCollapse', `${VIEW} && codev.buildersAutoCollapse`, 'navigation@2'),
  accordionOn: title('codev.enableBuildersAutoCollapse', `${VIEW} && !codev.buildersAutoCollapse`, 'navigation@2'),
  fileListView: title('codev.disableBuildersFileTreeMode', `${VIEW} && codev.buildersFileViewAsTree`, 'navigation@3'),
  fileTreeView: title('codev.enableBuildersFileTreeMode', `${VIEW} && !codev.buildersFileViewAsTree`, 'navigation@3'),
} as const satisfies Record<string, MenuEntry>;

/** The `viewItem` clause every builder-row entry of the Agents view keys on (all three families). */
const ANY_BUILDER = 'viewItem =~ /^(builder|blocked-builder|awaiting-builder)-/';
const AXIS_EXCLUDED = 'The Cockpit fixes the architect axis (Tower → workspaces → architects → builders), so there is '
  + 'no grouping axis to cycle. Stage and area grouping stay in the Agents view.';

// ── Menu entries: 18 `view/item/context` + 9 `view/title` ──────────────────

export const MENU_RECORDS: readonly MenuRecord[] = [
  // Tower workspace rows: the Cockpit's other workspaces keep the Tower view's contextValues.
  {
    source: ctx('codev.tower.openWorkspace', 'view == codev.tower && viewItem =~ /^tower-workspace-(active|dormant)$/', 'inline@1'),
    cockpit: { same: 'viewItem =~ /^tower-workspace-(active|dormant)$/' },
  },
  {
    source: ctx('codev.tower.deactivateWorkspace', 'view == codev.tower && viewItem == tower-workspace-active', 'inline@2'),
    cockpit: { same: 'viewItem == tower-workspace-active' },
  },
  // Workspace view.
  {
    source: ctx('codev.removeArchitect', 'view == codev.workspace && viewItem == workspace-architect-sibling', '1_primary@1'),
    cockpit: { relocated: [COCKPIT_ENTRIES.removeArchitect] },
  },
  {
    source: ctx('codev.addArchitect', 'view == codev.workspace && viewItem == workspace-architects-root', 'inline@1'),
    cockpit: { relocated: [COCKPIT_ENTRIES.addArchitectInline, COCKPIT_ENTRIES.addArchitect] },
  },
  {
    source: ctx('codev.runWorkspaceDev', 'view == codev.workspace && viewItem == workspace-dev-start', '1_primary@1'),
    cockpit: { relocated: [COCKPIT_ENTRIES.startDev] },
  },
  {
    source: ctx('codev.stopWorkspaceDev', 'view == codev.workspace && viewItem == workspace-dev-stop', '1_primary@1'),
    cockpit: { relocated: [COCKPIT_ENTRIES.stopDev] },
  },
  // Agents builder rows: identical on this window's builder rows.
  {
    source: ctx('codev.approveGate', 'view == codev.agents && viewItem =~ /^blocked-builder-/', 'inline@1'),
    cockpit: { same: 'viewItem =~ /^blocked-builder-/' },
  },
  {
    source: ctx('codev.openBuilderById', `view == codev.agents && ${ANY_BUILDER}`, '1_primary@1'),
    cockpit: { same: ANY_BUILDER },
  },
  {
    source: ctx('codev.approveGate', 'view == codev.agents && viewItem =~ /^blocked-builder-/', '1_primary@2'),
    cockpit: { same: 'viewItem =~ /^blocked-builder-/' },
  },
  {
    source: ctx('codev.viewSpecFile', 'view == codev.agents && viewItem =~ /^(builder|blocked-builder|awaiting-builder)-(spir|aspir)(-review)?$/', '1_primary@3'),
    cockpit: { same: 'viewItem =~ /^(builder|blocked-builder|awaiting-builder)-(spir|aspir)(-review)?$/' },
  },
  {
    source: ctx('codev.viewPlanFile', 'view == codev.agents && viewItem =~ /^(builder|blocked-builder|awaiting-builder)-(spir|aspir|pir)(-review)?$/', '1_primary@4'),
    cockpit: { same: 'viewItem =~ /^(builder|blocked-builder|awaiting-builder)-(spir|aspir|pir)(-review)?$/' },
  },
  {
    source: ctx('codev.viewReviewFile', 'view == codev.agents && viewItem =~ /^(builder|blocked-builder|awaiting-builder)-((spir|aspir|air)(-review)?|pir-review)$/', '1_primary@5'),
    cockpit: { same: 'viewItem =~ /^(builder|blocked-builder|awaiting-builder)-((spir|aspir|air)(-review)?|pir-review)$/' },
  },
  { source: ctx('codev.viewDiff', `view == codev.agents && ${ANY_BUILDER}`, '2_worktree@0'), cockpit: { same: ANY_BUILDER } },
  { source: ctx('codev.openWorktreeWindow', `view == codev.agents && ${ANY_BUILDER}`, '2_worktree@1'), cockpit: { same: ANY_BUILDER } },
  { source: ctx('codev.openWorktreeFolder', `view == codev.agents && ${ANY_BUILDER}`, '2_worktree@2'), cockpit: { same: ANY_BUILDER } },
  { source: ctx('codev.runWorktreeSetup', `view == codev.agents && ${ANY_BUILDER}`, '3_dev@1'), cockpit: { same: ANY_BUILDER } },
  {
    source: ctx('codev.runWorktreeDev', `view == codev.agents && ${ANY_BUILDER} && codev.hasDevCommand`, '3_dev@2'),
    cockpit: { same: ANY_BUILDER },
  },
  {
    source: ctx('codev.stopWorktreeDev', `view == codev.agents && ${ANY_BUILDER} && codev.hasDevCommand`, '3_dev@3'),
    cockpit: { same: ANY_BUILDER },
  },
  // Title bars.
  { source: title('codev.tower.refresh', 'view == codev.tower', 'navigation@1'), cockpit: { relocated: [COCKPIT_ENTRIES.refresh] } },
  { source: title('codev.refreshOverview', 'view == codev.agents', 'navigation@2'), cockpit: { relocated: [COCKPIT_ENTRIES.refresh] } },
  {
    source: title('codev.disableBuildersAutoCollapse', 'view == codev.agents && codev.buildersAutoCollapse', 'navigation@3'),
    cockpit: { relocated: [COCKPIT_ENTRIES.accordionOff] },
  },
  {
    source: title('codev.enableBuildersAutoCollapse', 'view == codev.agents && !codev.buildersAutoCollapse', 'navigation@3'),
    cockpit: { relocated: [COCKPIT_ENTRIES.accordionOn] },
  },
  {
    source: title('codev.disableBuildersFileTreeMode', 'view == codev.agents && codev.buildersFileViewAsTree', 'navigation@4'),
    cockpit: { relocated: [COCKPIT_ENTRIES.fileListView] },
  },
  {
    source: title('codev.enableBuildersFileTreeMode', 'view == codev.agents && !codev.buildersFileViewAsTree', 'navigation@4'),
    cockpit: { relocated: [COCKPIT_ENTRIES.fileTreeView] },
  },
  {
    source: title('codev.agentsCycleGroupFromStage', "view == codev.agents && (!codev.buildersGroupBy || codev.buildersGroupBy == 'stage')", 'navigation@1'),
    cockpit: { excluded: AXIS_EXCLUDED },
  },
  {
    source: title('codev.agentsCycleGroupFromArea', "view == codev.agents && codev.buildersGroupBy == 'area'", 'navigation@1'),
    cockpit: { excluded: AXIS_EXCLUDED },
  },
  {
    source: title('codev.agentsCycleGroupFromArchitect', "view == codev.agents && codev.buildersGroupBy == 'architect'", 'navigation@1'),
    cockpit: { excluded: AXIS_EXCLUDED },
  },
];

// ── Workspace-view row clicks ──────────────────────────────────────────────

export const ROW_CLICK_RECORDS: readonly RowClickRecord[] = [
  {
    row: 'workspace-architect-main',
    command: 'codev.openArchitectTerminal',
    cockpit: { rowClick: { contextValue: /^cockpit-architect-main$/, command: 'codev.openArchitectTerminal' } },
  },
  {
    row: 'workspace-architect-sibling',
    command: 'codev.openArchitectTerminal',
    cockpit: { rowClick: { contextValue: /^cockpit-architect-sibling$/, command: 'codev.openArchitectTerminal' } },
  },
  { row: 'workspace-web', command: 'vscode.open', cockpit: { relocated: [COCKPIT_ENTRIES.openWebInterface] } },
  { row: 'workspace-spawn', command: 'codev.spawnBuilder', cockpit: { relocated: [COCKPIT_ENTRIES.spawnInline, COCKPIT_ENTRIES.spawn] } },
  { row: 'workspace-shell', command: 'codev.newShell', cockpit: { relocated: [COCKPIT_ENTRIES.shellInline, COCKPIT_ENTRIES.shell] } },
  { row: 'workspace-dev-start', command: 'codev.runWorkspaceDev', cockpit: { relocated: [COCKPIT_ENTRIES.startDev] } },
  { row: 'workspace-dev-stop', command: 'codev.stopWorkspaceDev', cockpit: { relocated: [COCKPIT_ENTRIES.stopDev] } },
  { row: 'workspace-dev-stop-other', command: 'codev.stopWorktreeDev', cockpit: { relocated: [COCKPIT_ENTRIES.stopOtherDev] } },
  // One row per `worktree.devUrls` entry becomes one *Open Dev URL…* entry: it opens the only URL,
  // or picks among several.
  { row: 'workspace-dev-url', command: 'codev.openDevUrl', cockpit: { relocated: [COCKPIT_ENTRIES.openDevUrl] } },
];

// ── viewsWelcome: `codev.agents` has three; `codev.workspace` and `codev.tower` none ─────────

export const WELCOME_RECORDS: readonly WelcomeRecord[] = [
  {
    source: { view: 'codev.agents', contents: 'Loading Codev…', when: '!codev.stateKnown' },
    cockpit: { stateRow: { window: 'auto-connecting', label: 'Connecting to Tower…' } },
  },
  {
    source: {
      view: 'codev.agents',
      contents: 'Open a folder containing a Codev project to get started.\n[Open Folder](command:workbench.action.files.openFolder)\nTo set up Codev in a project, run `codev init` in its root.',
      when: 'codev.stateKnown && !codev.hasWorkspace && !codev.ideMode',
    },
    // A dormant window (#1144): the state row carries the same link, and its tooltip the same
    // `codev init` hint.
    cockpit: { stateRow: { window: 'dormant', label: 'Not connected to Tower', command: 'workbench.action.files.openFolder' } },
  },
  {
    source: {
      view: 'codev.agents',
      contents: 'Welcome to Codev.\nOpen a project to spawn your first builder.\n[Open Folder](command:workbench.action.files.openFolder)\n[Open Recent](command:workbench.action.openRecent)\nNew here? Install the Codev CLI and learn the spawn flow.\n[Get Started](command:codev.openGettingStarted)',
      when: 'codev.stateKnown && !codev.hasWorkspace && codev.ideMode',
    },
    cockpit: {
      excluded: 'An empty Codev IDE window connects to Tower, so the Cockpit lists every workspace Tower knows, each '
        + "with Open (inline) to open that workspace's window: that is the Cockpit's way into a project. The "
        + "welcome's onboarding links (Open Folder, Open Recent, Get Started) stay on the Agents view, in the same window.",
    },
  },
];
