/**
 * Wiring tests for the Search Backlog Quick Pick's type-ahead (issue #1179):
 * dynamic `View Issue #N` / `View PR #N` rows appear/disappear as the typed
 * value changes, and accepting a row routes to the right handler (browser
 * open for dynamic rows, `codev.viewBacklogIssue` for static rows).
 *
 * `search-backlog.ts` imports `vscode` at module load, so we stub it (the
 * open-issue-by-id.test.ts pattern) with a fake `createQuickPick` that records
 * its event handlers for the test to drive. The browser-open helpers are
 * mocked at the module boundary — their fetch/open behavior is covered by
 * their own test files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeQuickPick {
  items: Array<Record<string, unknown>>;
  placeholder: string;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  selectedItems: Array<Record<string, unknown>>;
  onChangeValue?: (value: string) => void;
  onAccept?: () => void;
  onHide?: () => void;
  onDidChangeValue: (fn: (value: string) => void) => void;
  onDidAccept: (fn: () => void) => void;
  onDidHide: (fn: () => void) => void;
  show: () => void;
  hide: () => void;
  dispose: () => void;
}

function makeFakeQuickPick(): FakeQuickPick {
  const picker: FakeQuickPick = {
    items: [],
    placeholder: '',
    matchOnDescription: false,
    matchOnDetail: false,
    selectedItems: [],
    onDidChangeValue: (fn) => { picker.onChangeValue = fn; },
    onDidAccept: (fn) => { picker.onAccept = fn; },
    onDidHide: (fn) => { picker.onHide = fn; },
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
  return picker;
}

let fakePicker: FakeQuickPick;
const createQuickPick = vi.fn(() => fakePicker);
const showInformationMessage = vi.fn();
const executeCommand = vi.fn();
const openIssueInBrowser = vi.fn();
const openPRInBrowser = vi.fn();

vi.mock('vscode', () => ({
  window: { createQuickPick, showInformationMessage },
  commands: { executeCommand },
}));
vi.mock('../commands/open-issue-by-id.js', () => ({ openIssueInBrowser }));
vi.mock('../commands/open-pr-by-id.js', () => ({ openPRInBrowser }));

const { searchBacklog } = await import('../commands/search-backlog.js');

const conn = { getState: () => 'connected' } as never;

function cacheWith(backlog: Array<Record<string, unknown>>) {
  return { getData: () => ({ backlog, currentUser: undefined }) } as never;
}

const BACKLOG = [
  { id: '918', title: 'search backlog', area: 'vscode', hasBuilder: false, assignees: [], createdAt: '2026-05-30T00:00:00.000Z' },
  { id: '920', title: 'search panel', area: 'vscode', hasBuilder: false, assignees: [], createdAt: '2026-05-30T00:00:00.000Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
  fakePicker = makeFakeQuickPick();
});

describe('searchBacklog type-ahead wiring', () => {
  it('shows only static rows before any typing', async () => {
    await searchBacklog(conn, cacheWith(BACKLOG));
    expect(fakePicker.show).toHaveBeenCalled();
    expect(fakePicker.items.map(i => i.label)).toEqual(['#918 search backlog', '#920 search panel']);
  });

  it('prepends View Issue / View PR rows when a bare number is typed', async () => {
    await searchBacklog(conn, cacheWith(BACKLOG));
    fakePicker.onChangeValue!('1350');
    expect(fakePicker.items.map(i => i.label)).toEqual([
      'View Issue #1350',
      'View PR #1350',
      '#918 search backlog',
      '#920 search panel',
    ]);
    expect(fakePicker.items[0].alwaysShow).toBe(true);
    expect(fakePicker.items[1].alwaysShow).toBe(true);
  });

  it('restores the static-only list when the value stops matching the grammar', async () => {
    await searchBacklog(conn, cacheWith(BACKLOG));
    fakePicker.onChangeValue!('1350');
    fakePicker.onChangeValue!('1350 fix');
    expect(fakePicker.items.map(i => i.label)).toEqual(['#918 search backlog', '#920 search panel']);
  });

  it('accepting the dynamic PR row opens the PR in the browser', async () => {
    await searchBacklog(conn, cacheWith(BACKLOG));
    fakePicker.onChangeValue!('view pr 1350');
    fakePicker.selectedItems = [fakePicker.items[0]];
    fakePicker.onAccept!();
    expect(openPRInBrowser).toHaveBeenCalledWith(conn, '1350');
    expect(openIssueInBrowser).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('accepting the dynamic Issue row opens the issue in the browser', async () => {
    await searchBacklog(conn, cacheWith(BACKLOG));
    fakePicker.onChangeValue!('1350');
    fakePicker.selectedItems = [fakePicker.items[0]];
    fakePicker.onAccept!();
    expect(openIssueInBrowser).toHaveBeenCalledWith(conn, '1350');
    expect(openPRInBrowser).not.toHaveBeenCalled();
  });

  it('accepting a static row still opens the in-editor preview', async () => {
    await searchBacklog(conn, cacheWith(BACKLOG));
    fakePicker.selectedItems = [fakePicker.items[1]];
    fakePicker.onAccept!();
    expect(executeCommand).toHaveBeenCalledWith('codev.viewBacklogIssue', '920');
    expect(openIssueInBrowser).not.toHaveBeenCalled();
    expect(openPRInBrowser).not.toHaveBeenCalled();
  });

  it('disposes the picker when it hides', async () => {
    await searchBacklog(conn, cacheWith(BACKLOG));
    fakePicker.onHide!();
    expect(fakePicker.dispose).toHaveBeenCalled();
  });

  it('keeps the informational empty-backlog message (no picker)', async () => {
    await searchBacklog(conn, cacheWith([]));
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    expect(createQuickPick).not.toHaveBeenCalled();
  });
});
