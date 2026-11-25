/**
 * *Arrange Cockpit* (Spec 1963): the editor area becomes the window's `main` architect on the left
 * and Work over Decisions on the right, each the active tab in its group.
 *
 * It rests on the layout spike (the plan's *Layout spike result*, VS Code 1.147.0):
 * - `vscode.setEditorLayout` keeps every editor. The editors of groups it removes are merged into
 *   the last group (bottom-right). The call is idempotent, so arrange always makes it;
 * - an editor-area terminal moves to the first group with `show()` + `moveEditorToFirstGroup`. A
 *   panel terminal reaches the editor area first with `terminal.moveToEditor`. Both keep the session;
 * - a retained webview panel moves with `reveal(viewColumn)` without reloading. It lands in the new
 *   group as a *preview* tab (VS Code reveals a webview without pinning it), which the next file
 *   opened in that group would replace, closing the panel.
 *
 * **Order.** Moving the only editor out of a group closes that group (`closeEmptyGroups`, on by
 * default), which renumbers the groups after it. So the three are placed in column order *before*
 * the layout is applied, each into a group after the ones already settled:
 * 1. the architect into the first group;
 * 2. with no architect placed, when the first group holds only the Cockpit's own panels, an empty
 *    group is opened to its left. Moving them out would otherwise close the left column;
 * 3. Work into the second group, then Decisions into the third. VS Code opens the groups a column
 *    names when they do not exist yet;
 * 4. the layout, which keeps the groups in order as left | (top / bottom);
 * 5. Decisions is revealed again, over any editors the layout merged into its group, then Work;
 * 6. a panel left as a preview tab is kept (`workbench.action.keepEditor`, which acts on the active
 *    editor, so the panel is focused first); the architect gets focus.
 *
 * Nothing is closed, reloaded or recreated. The user's editors, dirty and untitled ones included,
 * stay open, possibly in another group. An open terminal or panel is the same one, moved.
 *
 * **The architect** is resolved through `openResolvedArchitect` (#1497): always `main`, with no
 * picker. A non-live `main` gets the existing warning, nothing is substituted, and the right side
 * is still arranged. This action opens the architect in the editor area even when
 * `codev.terminalPosition` is `panel`; every other open path keeps honouring that setting. The
 * automatic arrange reads the roster quietly: with Tower down it logs, and shows no error toast.
 *
 * **Which tab is the architect's.** The tab API gives a terminal tab no terminal identity, only its
 * label, which is the terminal's name; showing a panel terminal leaves the editor area's active tab
 * as it was, so activation cannot tell either. The label is unambiguous only while no other terminal
 * has the architect's name (a renamed terminal, or a shell that set its title, carries it in
 * `Terminal.name`). Arrange checks that first and, when another one does, stops before moving
 * an editor and says so, rather than move a terminal it cannot tell apart.
 *
 * Each move is waited for, up to a bound, before the next. A move that does not happen in time stops
 * the arrange with an error naming it. Arrange never acts on an editor it has not confirmed.
 */

import * as vscode from 'vscode';
import { openResolvedArchitect, type ResolvableArchitect } from '../open-architect.js';
import type { PanelPlacement } from '../workspace-views/single-panel.js';

/** left | (top / bottom), in the form `vscode.setEditorLayout` takes. */
export const COCKPIT_LAYOUT = { orientation: 0, groups: [{}, { groups: [{}, {}] }] };

/** The architect the left side always holds. */
export const COCKPIT_ARCHITECT = 'main';

/** How long one move may take to show up before arrange stops and says so. */
const SETTLE_TIMEOUT_MS = 5000;
const SETTLE_POLL_MS = 25;

/** A Work or Decisions panel (`SingleWebviewPanel`): one per window. */
export interface CockpitPanel {
  show(placement?: PanelPlacement): void;
  readonly panel: vscode.WebviewPanel | undefined;
  /** The open panel's editor tab. */
  readonly tab: vscode.Tab | undefined;
  /** Every tab of this kind: the open panel's, and any restored by a reload and not yet revived. */
  readonly tabs: readonly vscode.Tab[];
}

/** Who asked: the command (palette, title bar), or the Cockpit's first show in a window. */
export type ArrangeTrigger = 'command' | 'auto';

export interface ArrangeCockpitDeps {
  /** Why arranging is not offered in this window (a builder-worktree or no-workspace window), or null. */
  unavailableReason(): string | null;
  /**
   * The workspace's live architects, or undefined when they could not be read: the user was told
   * why, or, when `quiet`, it was logged.
   */
  readArchitects(quiet: boolean): Promise<ResolvableArchitect[] | undefined>;
  /**
   * Open the architect's terminal, or reuse the open one, and focus it (`TerminalManager.openArchitect`
   * with the editor-area override).
   */
  openArchitect(terminalId: string, architectName: string): Promise<void>;
  /** The terminal this window has open for an architect (`TerminalManager.getArchitectTerminal`). */
  architectTerminal(architectName: string): vscode.Terminal | undefined;
  work: CockpitPanel;
  decisions: CockpitPanel;
  log(line: string): void;
}

/** Arrange the editor area. A call made while one is running joins it. */
export class CockpitArranger {
  private inFlight: Promise<boolean> | undefined;

  constructor(private readonly deps: ArrangeCockpitDeps) {}

  /** Resolves whether the editor area was arranged. */
  arrange(trigger: ArrangeTrigger = 'command'): Promise<boolean> {
    this.inFlight ??= arrangeCockpit(this.deps, trigger).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
}

/**
 * Arrange the editor area. Resolves true once it is arranged. Resolves false where it is not
 * offered, or when a move did not happen; in both cases the user is told why.
 */
export async function arrangeCockpit(deps: ArrangeCockpitDeps, trigger: ArrangeTrigger = 'command'): Promise<boolean> {
  const reason = deps.unavailableReason();
  if (reason) {
    void vscode.window.showInformationMessage(reason);
    return false;
  }
  try {
    const architect = await placeArchitect(deps, trigger);
    if (!architect) { await keepLeftColumn(deps); }
    await placePanel(deps.work, vscode.ViewColumn.Two, 'Work');
    await placePanel(deps.decisions, vscode.ViewColumn.Three, 'Decisions');
    await vscode.commands.executeCommand('vscode.setEditorLayout', COCKPIT_LAYOUT);
    deps.decisions.show({ viewColumn: vscode.ViewColumn.Three, preserveFocus: true });
    deps.work.show({ viewColumn: vscode.ViewColumn.Two, preserveFocus: true });
    const panelsPlaced = () => vscode.window.tabGroups.all.length === 3
      && deps.work.panel?.viewColumn === vscode.ViewColumn.Two
      && deps.decisions.panel?.viewColumn === vscode.ViewColumn.Three;
    await settle(panelsPlaced, 'the editor area to take the Cockpit layout');
    await keepPanel(deps.decisions, vscode.ViewColumn.Three, 'Decisions');
    await keepPanel(deps.work, vscode.ViewColumn.Two, 'Work');
    architect?.show(false);
    await settle(
      () => panelsPlaced()
        && !deps.work.tab?.isPreview && !deps.decisions.tab?.isPreview
        && (!architect || terminalTab(architect)?.group.viewColumn === vscode.ViewColumn.One),
      'the editor area to take the Cockpit layout',
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`Arrange Cockpit stopped: ${message}`);
    void vscode.window.showErrorMessage(`Codev: Arrange Cockpit stopped: ${message}.`);
    return false;
  }
}

/**
 * Resolve `main`, open or reuse its terminal, and move it into the first editor group. Returns the
 * terminal, or undefined when there is no architect to place (the user was told why).
 */
async function placeArchitect(deps: ArrangeCockpitDeps, trigger: ArrangeTrigger): Promise<vscode.Terminal | undefined> {
  const architects = await deps.readArchitects(trigger === 'auto');
  if (!architects) { return undefined; }
  const alreadyOpen = deps.architectTerminal(COCKPIT_ARCHITECT);
  const name = await openResolvedArchitect(architects, COCKPIT_ARCHITECT, {
    openArchitect: (terminalId, architectName) => deps.openArchitect(terminalId, architectName),
    warn: (message) => { void vscode.window.showWarningMessage(message); },
  });
  if (!name) { return undefined; }
  const terminal = deps.architectTerminal(name);
  // None: the terminal manager did not open one (too many terminals, no workspace) and said why.
  if (!terminal) { return undefined; }
  // Its tab is found by label, which only this terminal may carry (see the module comment). A
  // terminal just disposed (a stale session reopened) stays listed until VS Code confirms it closed,
  // so a namesake is given the settle bound to go before arrange refuses.
  const namesake = () => vscode.window.terminals.some(other => other !== terminal && other.name === terminal.name);
  if (namesake() && !(await until(() => !namesake()))) {
    throw new Error(`another terminal is also named "${terminal.name}", so the architect's tab cannot be told apart from it; rename or close that terminal and arrange again`);
  }

  if (terminal !== alreadyOpen) {
    // Opened just now, in the editor area (the override): wait for its tab.
    await settle(() => terminalTab(terminal) !== undefined, 'the architect terminal to open');
  } else if (!terminalTab(terminal)) {
    // Open in the panel: into the editor area first. The command moves the panel's active terminal,
    // so the architect must be that terminal before it runs.
    terminal.show(false);
    await settle(() => vscode.window.activeTerminal === terminal, 'the architect terminal to become the active terminal');
    await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
    await settle(() => terminalTab(terminal) !== undefined, 'the architect terminal to move into the editor area');
  }

  if (terminalTab(terminal)?.group.viewColumn !== vscode.ViewColumn.One) {
    // The command moves the active editor, so the architect must be that editor before it runs.
    terminal.show(false);
    await settle(() => isTerminalTab(vscode.window.tabGroups.activeTabGroup.activeTab, terminal), 'the architect terminal to become the active editor');
    await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
    await settle(() => terminalTab(terminal)?.group.viewColumn === vscode.ViewColumn.One, 'the architect terminal to move to the left group');
  }
  return terminal;
}

/**
 * With no architect placed, keep the left column. When the first group holds nothing but the
 * Cockpit's own panels, moving them right would empty it, and VS Code would close it: an empty group
 * is opened to its left first, so the left column stays (empty) and the panels move right.
 */
async function keepLeftColumn(deps: ArrangeCockpitDeps): Promise<void> {
  const first = vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.One);
  if (!first || first.tabs.length === 0) { return; }
  // By tab, not live panel: a tab restored by a reload and not yet revived is the Cockpit's too, and
  // is closed once its panel opens, which would empty the group.
  const panelTabsInFirst = [...deps.work.tabs, ...deps.decisions.tabs]
    .filter(tab => tab.group.viewColumn === vscode.ViewColumn.One).length;
  if (first.tabs.length !== panelTabsInFirst) { return; }
  const groups = vscode.window.tabGroups.all.length;
  await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
  await vscode.commands.executeCommand('workbench.action.newGroupLeft');
  await settle(
    () => vscode.window.tabGroups.all.length === groups + 1
      && vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.One)?.tabs.length === 0,
    'an empty left group to open',
  );
}

/** Move a panel to, or open it in, `viewColumn`, without taking focus. */
async function placePanel(panel: CockpitPanel, viewColumn: vscode.ViewColumn, title: string): Promise<void> {
  panel.show({ viewColumn, preserveFocus: true });
  await settle(() => panel.panel?.viewColumn === viewColumn, `${title} to open in editor group ${viewColumn}`);
}

/**
 * Keep a panel that a move left as a preview tab, so opening a file in its group cannot replace it.
 * The command keeps the active editor: the panel is focused first, and confirmed active.
 */
async function keepPanel(panel: CockpitPanel, viewColumn: vscode.ViewColumn, title: string): Promise<void> {
  if (!panel.tab?.isPreview) { return; }
  panel.show({ viewColumn, preserveFocus: false });
  await settle(() => panel.tab?.isActive === true && panel.tab.group.isActive, `${title} to become the active editor`);
  await vscode.commands.executeCommand('workbench.action.keepEditor');
  await settle(() => panel.tab?.isPreview === false, `${title} to be kept open`);
}

/** The editor tab of a terminal, if it is in the editor area. A terminal tab carries the terminal's name. */
function terminalTab(terminal: vscode.Terminal): vscode.Tab | undefined {
  for (const group of vscode.window.tabGroups.all) {
    const tab = group.tabs.find(candidate => isTerminalTab(candidate, terminal));
    if (tab) { return tab; }
  }
  return undefined;
}

function isTerminalTab(tab: vscode.Tab | undefined, terminal: vscode.Terminal): boolean {
  return tab !== undefined && tab.input instanceof vscode.TabInputTerminal && tab.label === terminal.name;
}

/** Wait until `condition` holds, or fail naming `what` did not happen. */
async function settle(condition: () => boolean, what: string): Promise<void> {
  if (!(await until(condition))) { throw new Error(`timed out waiting for ${what}`); }
}

/** Whether `condition` holds within the settle bound. */
async function until(condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() >= deadline) { return false; }
    await new Promise(resolve => setTimeout(resolve, SETTLE_POLL_MS));
  }
  return true;
}
