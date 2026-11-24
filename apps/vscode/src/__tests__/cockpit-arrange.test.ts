/**
 * Spec 1963 scenarios 9, 13 and 14 (host side): *Arrange Cockpit*.
 *
 * The editor area is a fake that models what the layout spike measured in VS Code 1.147.0, plus
 * the behaviour arrange has to work around:
 * - a move that empties a group closes it (`workbench.editor.closeEmptyGroups`, on by default), and
 *   the groups after it are renumbered;
 * - a column beyond the last group opens the groups up to it;
 * - `vscode.setEditorLayout` keeps the first three groups in order and merges the editors of the
 *   rest into the third, where a merged editor becomes the active tab;
 * - `moveEditorToFirstGroup` moves the active editor; `terminal.moveToEditor` moves the panel's
 *   active terminal into the active group;
 * - revealing a webview panel in another group lands it there as a preview tab (VS Code 1.147.0's
 *   `revealWebview` opens it unpinned); a new panel opens pinned; `keepEditor` keeps the active one.
 *
 * Nothing in the fake can close an editor: every editor that existed before an arrange must exist
 * after it, in the same state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResolvableArchitect } from '../open-architect.js';

class TabInputTerminal {}
class TabInputText { constructor(readonly uri: string) {} }
class TabInputWebview { constructor(readonly viewType: string) {} }

class FakeTerminal {
  constructor(readonly name: string) {}
  show(preserveFocus?: boolean) { area.showTerminal(this, preserveFocus ?? false); }
}

class FakeWebviewPanel {
  constructor(readonly title: string) {}
  get viewColumn(): number | undefined { return area.columnOf(this); }
}

type Item =
  | { kind: 'text'; label: string; dirty: boolean }
  | { kind: 'terminal'; terminal: FakeTerminal }
  | { kind: 'webview'; panel: FakeWebviewPanel; preview: boolean };

interface Group { items: Item[]; active: Item | undefined }

/** The editor area and the terminal panel. */
class FakeEditorArea {
  groups: Group[] = [{ items: [], active: undefined }];
  activeGroup: Group = this.groups[0];
  panelTerminals: FakeTerminal[] = [];
  activeTerminal: FakeTerminal | undefined;
  /** Commands the fake ignores, to stand in for a move VS Code did not make. */
  readonly ignored = new Set<string>();

  open(item: Item, column: number): void {
    const group = this.groupAt(column);
    group.items.push(item);
    group.active = item;
  }

  columnOf(panel: FakeWebviewPanel): number | undefined {
    const index = this.groups.findIndex(group => group.items.some(item => item.kind === 'webview' && item.panel === panel));
    return index < 0 ? undefined : index + 1;
  }

  /** The group a column names, opening the groups up to it when it does not exist. */
  groupAt(column: number): Group {
    while (this.groups.length < column) { this.groups.push({ items: [], active: undefined }); }
    return this.groups[column - 1];
  }

  /** Move an item into the group a column names, resolved before the source group can close. */
  moveTo(item: Item, column: number, activate: boolean): void {
    const target = this.groupAt(column);
    const source = this.groups.find(group => group.items.includes(item));
    if (source !== target) {
      if (source) { this.remove(source, item); }
      target.items.push(item);
    }
    target.active = item;
    if (activate) { this.activeGroup = target; }
  }

  showTerminal(terminal: FakeTerminal, preserveFocus: boolean): void {
    this.activeTerminal = terminal;
    const group = this.groups.find(candidate => candidate.items.some(item => item.kind === 'terminal' && item.terminal === terminal));
    if (!group) { return; }
    group.active = group.items.find(item => item.kind === 'terminal' && item.terminal === terminal);
    if (!preserveFocus) { this.activeGroup = group; }
  }

  async execute(command: string, args: unknown[]): Promise<void> {
    if (this.ignored.has(command)) { return; }
    switch (command) {
      case 'vscode.setEditorLayout': {
        expect(args[0]).toEqual({ orientation: 0, groups: [{}, { groups: [{}, {}] }] });
        this.groupAt(3);
        const [first, second, third, ...rest] = this.groups;
        for (const group of rest) {
          third.items.push(...group.items);
          if (group.active) { third.active = group.active; }
        }
        this.groups = [first, second, third];
        if (!this.groups.includes(this.activeGroup)) { this.activeGroup = third; }
        return;
      }
      case 'workbench.action.moveEditorToFirstGroup': {
        const item = this.activeGroup.active;
        if (item) { this.moveTo(item, 1, true); }
        return;
      }
      case 'workbench.action.terminal.moveToEditor': {
        const terminal = this.activeTerminal;
        if (!terminal || !this.panelTerminals.includes(terminal)) { return; }
        this.panelTerminals = this.panelTerminals.filter(t => t !== terminal);
        const item: Item = { kind: 'terminal', terminal };
        this.activeGroup.items.push(item);
        this.activeGroup.active = item;
        return;
      }
      case 'workbench.action.keepEditor': {
        const item = this.activeGroup.active;
        if (item?.kind === 'webview') { item.preview = false; }
        return;
      }
      case 'workbench.action.focusFirstEditorGroup':
        this.activeGroup = this.groups[0];
        return;
      case 'workbench.action.newGroupLeft': {
        const group: Group = { items: [], active: undefined };
        this.groups.splice(this.groups.indexOf(this.activeGroup), 0, group);
        this.activeGroup = group;
        return;
      }
      default:
        throw new Error(`the fake does not know ${command}`);
    }
  }

  /** The `vscode.window.tabGroups` view of the model. */
  get tabGroups() {
    const all = this.groups.map((group, index) => {
      const api = { viewColumn: index + 1, isActive: group === this.activeGroup, tabs: [] as unknown[], activeTab: undefined as unknown };
      api.tabs = group.items.map(item => {
        const tab = {
          label: labelOf(item),
          input: inputOf(item),
          group: api,
          isActive: item === group.active,
          isDirty: item.kind === 'text' && item.dirty,
          isPreview: item.kind === 'webview' && item.preview,
        };
        if (tab.isActive) { api.activeTab = tab; }
        return tab;
      });
      return api;
    });
    return { all, activeTabGroup: all[this.groups.indexOf(this.activeGroup)] };
  }

  /** A comparable picture of the area: each group's labels, its active tab, and the panel. */
  snapshot() {
    return {
      groups: this.groups.map(group => ({ tabs: group.items.map(labelOf), active: group.active ? labelOf(group.active) : null })),
      panel: this.panelTerminals.map(t => t.name),
    };
  }

  /** Every text editor, with its unsaved state. */
  textEditors() {
    return this.groups.flatMap(group => group.items).filter(item => item.kind === 'text')
      .map(item => ({ label: labelOf(item), dirty: (item as { dirty: boolean }).dirty }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  private remove(group: Group, item: Item): void {
    group.items = group.items.filter(candidate => candidate !== item);
    if (group.active === item) { group.active = group.items.at(-1); }
    if (group.items.length === 0 && this.groups.length > 1) {
      this.groups = this.groups.filter(candidate => candidate !== group);
      if (this.activeGroup === group) { this.activeGroup = this.groups[0]; }
    }
  }
}

function labelOf(item: Item): string {
  if (item.kind === 'text') { return item.label; }
  if (item.kind === 'terminal') { return item.terminal.name; }
  return item.panel.title;
}

function inputOf(item: Item): unknown {
  if (item.kind === 'text') { return new TabInputText(item.label); }
  if (item.kind === 'terminal') { return new TabInputTerminal(); }
  return new TabInputWebview(`mainThreadWebview-codev.${item.panel.title.toLowerCase()}`);
}

let area: FakeEditorArea;
const executeCommand = vi.fn(async (command: string, ...args: unknown[]) => area.execute(command, args));
const showInformationMessage = vi.fn();
const showWarningMessage = vi.fn();
const showErrorMessage = vi.fn();

vi.mock('vscode', () => ({
  window: {
    get tabGroups() { return area.tabGroups; },
    get activeTerminal() { return area.activeTerminal; },
    showInformationMessage,
    showWarningMessage,
    showErrorMessage,
  },
  commands: { executeCommand },
  ViewColumn: { Active: -1, One: 1, Two: 2, Three: 3 },
  TabInputTerminal,
  TabInputText,
  TabInputWebview,
}));

const { arrangeCockpit, CockpitArranger, COCKPIT_LAYOUT } = await import('../cockpit/arrange.js');

/** A Work or Decisions panel: `SingleWebviewPanel.show` over the fake area. */
class FakeCockpitPanel {
  created = 0;
  current: FakeWebviewPanel | undefined;
  constructor(readonly title: string) {}
  get panel() { return this.current as never; }
  get tab() {
    const column = this.current?.viewColumn;
    return area.tabGroups.all.find(group => group.viewColumn === column)?.tabs
      .find(tab => (tab as { label: string }).label === this.title) as never;
  }
  show(placement?: { viewColumn: number; preserveFocus: boolean }) {
    const column = placement?.viewColumn ?? 1;
    if (!this.current) {
      this.current = new FakeWebviewPanel(this.title);
      this.created++;
      area.open({ kind: 'webview', panel: this.current, preview: false }, column);
      return;
    }
    const item = area.groups.flatMap(group => group.items).find(i => i.kind === 'webview' && i.panel === this.current)!;
    if (item.kind === 'webview' && this.current.viewColumn !== column) { item.preview = true; }
    area.moveTo(item, column, !(placement?.preserveFocus ?? false));
  }
  /** Whether its tab is a preview tab. */
  get preview() { return (this.tab as { isPreview?: boolean } | undefined)?.isPreview; }
  /** Open the panel in a group before the arrange, as a user would have. */
  openIn(column: number) { this.show({ viewColumn: column, preserveFocus: false }); }
}

const MAIN: ResolvableArchitect = { name: 'main', terminalId: 't-main' };

function setup(opts: { roster?: ResolvableArchitect[] | undefined; reason?: string | null } = {}) {
  const roster = 'roster' in opts ? opts.roster : [MAIN];
  const work = new FakeCockpitPanel('Work');
  const decisions = new FakeCockpitPanel('Decisions');
  const terminals = new Map<string, FakeTerminal>();
  const log: string[] = [];
  const openArchitect = vi.fn(async (_terminalId: string, name: string) => {
    const existing = terminals.get(name);
    if (existing) {
      existing.show(false);
      return;
    }
    // A new terminal opens in the first editor group (the editor-area override) and takes focus.
    const terminal = new FakeTerminal(name === 'main' ? 'Codev: Architect' : `Codev: Architect (${name})`);
    terminals.set(name, terminal);
    area.open({ kind: 'terminal', terminal }, 1);
    terminal.show(false);
  });
  const readArchitects = vi.fn(async () => roster);
  const deps = {
    unavailableReason: () => opts.reason ?? null,
    readArchitects,
    openArchitect,
    architectTerminal: (name: string) => terminals.get(name) as never,
    work,
    decisions,
    log: (line: string) => { log.push(line); },
  };
  /** Seed an architect terminal that is already open, in `column` or (with no column) in the panel. */
  const seedArchitect = (column?: number) => {
    const terminal = new FakeTerminal('Codev: Architect');
    terminals.set('main', terminal);
    if (column === undefined) { area.panelTerminals.push(terminal); } else { area.open({ kind: 'terminal', terminal }, column); }
    return terminal;
  };
  return { deps, work, decisions, terminals, openArchitect, readArchitects, log, seedArchitect };
}

function text(label: string, dirty = false): Item {
  return { kind: 'text', label, dirty };
}

beforeEach(() => {
  area = new FakeEditorArea();
  executeCommand.mockClear();
  showInformationMessage.mockClear();
  showWarningMessage.mockClear();
  showErrorMessage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Arrange Cockpit: the layout', () => {
  it('a fresh window: main | (Work over Decisions), each the active tab in its group, the architect focused', async () => {
    const { deps, openArchitect } = setup();

    await expect(arrangeCockpit(deps)).resolves.toBe(true);

    expect(area.snapshot()).toEqual({
      groups: [
        { tabs: ['Codev: Architect'], active: 'Codev: Architect' },
        { tabs: ['Work'], active: 'Work' },
        { tabs: ['Decisions'], active: 'Decisions' },
      ],
      panel: [],
    });
    expect(area.tabGroups.activeTabGroup.viewColumn).toBe(1);
    expect(openArchitect).toHaveBeenCalledWith('t-main', 'main');
    expect(executeCommand).toHaveBeenCalledWith('vscode.setEditorLayout', COCKPIT_LAYOUT);
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('keeps every editor across five groups, dirty and untitled included; the extra groups merge under Decisions', async () => {
    const { deps } = setup();
    area.open(text('a.ts'), 1);
    area.open(text('b.ts', true), 2);
    area.open(text('c.ts'), 3);
    area.open(text('Untitled-1', true), 4);
    area.open(text('e.ts', true), 5);
    const before = area.textEditors();

    await expect(arrangeCockpit(deps)).resolves.toBe(true);

    expect(area.textEditors()).toEqual(before);
    expect(area.snapshot().groups).toEqual([
      { tabs: ['a.ts', 'Codev: Architect'], active: 'Codev: Architect' },
      { tabs: ['b.ts', 'Work'], active: 'Work' },
      // The merged editors land behind Decisions, which is revealed over them.
      { tabs: ['c.ts', 'Decisions', 'Untitled-1', 'e.ts'], active: 'Decisions' },
    ]);
  });

  it('is idempotent: a re-run moves nothing and opens no second panel or terminal', async () => {
    const { deps, work, decisions, terminals, openArchitect } = setup();
    area.open(text('notes.md', true), 1);
    await arrangeCockpit(deps);
    const arranged = area.snapshot();
    const panels = [work.current, decisions.current];

    await expect(arrangeCockpit(deps)).resolves.toBe(true);

    expect(area.snapshot()).toEqual(arranged);
    expect([work.created, decisions.created]).toEqual([1, 1]);
    // The same panels: a Decisions draft lives in its retained webview, which is never recreated.
    expect([work.current, decisions.current]).toEqual(panels);
    expect(terminals.size).toBe(1);
    expect(openArchitect).toHaveBeenCalledTimes(2);
    expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.moveEditorToFirstGroup');
  });

  it('reuses open panels in the wrong groups: Decisions left of Work ends Work over Decisions', async () => {
    const { deps, work, decisions } = setup();
    area.open(text('a.ts'), 1);
    decisions.openIn(2);
    work.openIn(3);

    await arrangeCockpit(deps);

    expect(area.snapshot().groups).toEqual([
      { tabs: ['a.ts', 'Codev: Architect'], active: 'Codev: Architect' },
      { tabs: ['Work'], active: 'Work' },
      { tabs: ['Decisions'], active: 'Decisions' },
    ]);
    expect([work.created, decisions.created]).toEqual([1, 1]);
  });

  it('keeps a panel the move left as a preview tab, so a file opened in its group cannot replace it; the architect ends focused', async () => {
    const { deps, work, decisions } = setup();
    area.open(text('a.ts'), 1);
    decisions.openIn(2);
    work.openIn(3);

    await arrangeCockpit(deps);

    expect([work.preview, decisions.preview]).toEqual([false, false]);
    expect(executeCommand.mock.calls.filter(([command]) => command === 'workbench.action.keepEditor')).toHaveLength(2);
    expect(area.tabGroups.activeTabGroup.viewColumn).toBe(1);
  });

  it('keeps no panel it opened itself (a new panel opens pinned), and a re-run keeps nothing', async () => {
    const { deps, work, decisions } = setup();

    await arrangeCockpit(deps);
    await arrangeCockpit(deps);

    expect([work.preview, decisions.preview]).toEqual([false, false]);
    expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.keepEditor');
  });

  it('moves an architect terminal open in another group to the left group: the same terminal', async () => {
    const { deps, seedArchitect, terminals } = setup();
    area.open(text('a.ts'), 1);
    area.open(text('b.ts'), 2);
    const architect = seedArchitect(2);

    await arrangeCockpit(deps);

    expect(area.snapshot().groups[0]).toEqual({ tabs: ['a.ts', 'Codev: Architect'], active: 'Codev: Architect' });
    expect(terminals.get('main')).toBe(architect);
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.moveEditorToFirstGroup');
  });

  it('moves the architect out of a group it is alone in before the layout, so the closing group shifts nothing', async () => {
    const { deps, seedArchitect, work } = setup();
    area.open(text('a.ts'), 1);
    seedArchitect(2);
    work.openIn(3);

    await arrangeCockpit(deps);

    expect(area.snapshot().groups).toEqual([
      { tabs: ['a.ts', 'Codev: Architect'], active: 'Codev: Architect' },
      { tabs: ['Work'], active: 'Work' },
      { tabs: ['Decisions'], active: 'Decisions' },
    ]);
  });

  it('moves an architect terminal open in the panel into the editor area, then left: the same terminal', async () => {
    const { deps, seedArchitect, terminals } = setup();
    area.open(text('a.ts'), 1);
    area.open(text('b.ts'), 2);
    area.activeGroup = area.groups[1];
    const architect = seedArchitect();

    await arrangeCockpit(deps);

    expect(executeCommand).toHaveBeenCalledWith('workbench.action.terminal.moveToEditor');
    expect(area.snapshot()).toEqual({
      groups: [
        { tabs: ['a.ts', 'Codev: Architect'], active: 'Codev: Architect' },
        { tabs: ['b.ts', 'Work'], active: 'Work' },
        { tabs: ['Decisions'], active: 'Decisions' },
      ],
      panel: [],
    });
    expect(terminals.get('main')).toBe(architect);
  });
});

describe('Arrange Cockpit: the architect', () => {
  it("delegates to openResolvedArchitect: a non-live main gets the existing warning, nothing is substituted, the right side is arranged", async () => {
    const { deps, openArchitect } = setup({ roster: [{ name: 'web', terminalId: 't-web' }] });
    area.open(text('a.ts'), 1);

    await expect(arrangeCockpit(deps)).resolves.toBe(true);

    expect(showWarningMessage).toHaveBeenCalledWith("Codev: No 'main' architect found — is the workspace activated?");
    expect(openArchitect).not.toHaveBeenCalled();
    expect(area.snapshot().groups).toEqual([
      { tabs: ['a.ts'], active: 'a.ts' },
      { tabs: ['Work'], active: 'Work' },
      { tabs: ['Decisions'], active: 'Decisions' },
    ]);
  });

  it('with the roster unreadable (Tower not connected), the right side is still arranged', async () => {
    const { deps, openArchitect } = setup({ roster: undefined });

    await expect(arrangeCockpit(deps)).resolves.toBe(true);

    expect(openArchitect).not.toHaveBeenCalled();
    expect(area.snapshot().groups.map(group => group.tabs)).toEqual([[], ['Work'], ['Decisions']]);
  });

  it('with no architect and only the Cockpit panels on the left, an empty left group keeps the left column', async () => {
    const { deps, work, decisions } = setup({ roster: undefined });
    work.openIn(1);
    decisions.openIn(1);

    await arrangeCockpit(deps);

    expect(executeCommand).toHaveBeenCalledWith('workbench.action.newGroupLeft');
    expect(area.snapshot().groups).toEqual([
      { tabs: [], active: null },
      { tabs: ['Work'], active: 'Work' },
      { tabs: ['Decisions'], active: 'Decisions' },
    ]);
  });

  it('with no architect but a user editor on the left, no extra group is opened', async () => {
    const { deps, work } = setup({ roster: undefined });
    area.open(text('a.ts'), 1);
    work.openIn(1);

    await arrangeCockpit(deps);

    expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.newGroupLeft');
    expect(area.snapshot().groups.map(group => group.tabs)).toEqual([['a.ts'], ['Work'], ['Decisions']]);
  });
});

describe('Arrange Cockpit: where it is not offered, and failures', () => {
  it('in a builder-worktree or no-workspace window it says why and changes nothing', async () => {
    const reason = "Codev: Arrange Cockpit is not offered in a builder-worktree window. Use it from the parent workspace's window.";
    const { deps, readArchitects, work } = setup({ reason });
    area.open(text('a.ts'), 1);
    const before = area.snapshot();

    await expect(arrangeCockpit(deps)).resolves.toBe(false);

    expect(showInformationMessage).toHaveBeenCalledWith(reason);
    expect(readArchitects).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(work.created).toBe(0);
    expect(area.snapshot()).toEqual(before);
  });

  it('a move that does not happen stops the arrange with an error naming it, before the layout', async () => {
    vi.useFakeTimers();
    const { deps, seedArchitect, log } = setup();
    area.open(text('a.ts'), 1);
    seedArchitect(2);
    area.ignored.add('workbench.action.moveEditorToFirstGroup');

    const result = arrangeCockpit(deps);
    await vi.advanceTimersByTimeAsync(6000);

    await expect(result).resolves.toBe(false);
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Codev: Arrange Cockpit stopped: timed out waiting for the architect terminal to move to the left group.',
    );
    expect(log).toEqual(['Arrange Cockpit stopped: timed out waiting for the architect terminal to move to the left group']);
    expect(executeCommand).not.toHaveBeenCalledWith('vscode.setEditorLayout', COCKPIT_LAYOUT);
  });

  it('a panel that is not kept in time stops the arrange with an error naming it', async () => {
    vi.useFakeTimers();
    const { deps, decisions } = setup();
    decisions.openIn(1);
    area.ignored.add('workbench.action.keepEditor');

    const result = arrangeCockpit(deps);
    await vi.advanceTimersByTimeAsync(6000);

    await expect(result).resolves.toBe(false);
    expect(showErrorMessage).toHaveBeenCalledWith('Codev: Arrange Cockpit stopped: timed out waiting for Decisions to be kept open.');
  });

  it('CockpitArranger: a call made while one is running joins it', async () => {
    const { deps, readArchitects } = setup();
    const arranger = new CockpitArranger(deps);

    const [first, second] = await Promise.all([arranger.arrange(), arranger.arrange()]);

    expect([first, second]).toEqual([true, true]);
    expect(readArchitects).toHaveBeenCalledTimes(1);
    await arranger.arrange();
    expect(readArchitects).toHaveBeenCalledTimes(2);
  });
});
