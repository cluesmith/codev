/**
 * Integration tests for ContextualPanelProvider: trigger wiring, post-only-on-transition dedup,
 * ready-message and visibility re-post, and the contextual surface resolution (incl. the terminal
 * exit, multi-diff sub-file navigation, and background-churn guard). The panel is purely contextual —
 * there is no navigation to test.
 *
 * `vscode` and the diff-inject registry are mocked; the surface is driven by setting the mocked
 * active tab / editor / terminal-builder and firing the captured trigger listeners.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ModeDescriptor } from '../contextual-panel/types.js';
import type { AttentionSummary } from '@cluesmith/codev-sdk/builder-helpers';
import type { CodeReviewSummary } from '../contextual-panel/code-review.js';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';

const hoisted = vi.hoisted(() => {
  const state = {
    activeTabInput: undefined as unknown,
    activeEditorFsPath: undefined as string | undefined,
    activeBuilderId: null as string | null,
    diffBuilders: {} as Record<string, string>,
    overviewData: null as unknown,
    queues: {} as Record<string, unknown[]>,
    sentQueues: {} as Record<string, unknown[]>,
    worktrees: {} as Record<string, string>,
    loads: [] as string[],
    executed: [] as unknown[][],
    commandResult: Promise.resolve(undefined) as Promise<unknown>,
    listeners: {} as Record<string, (arg?: unknown) => void>,
  };
  class TabInputText {
    constructor(public uri: { path: string; fsPath: string }) {}
  }
  class TabInputTextDiff {
    constructor(public original: { fsPath: string }, public modified: { fsPath: string }) {}
  }
  class TabInputCustom {
    constructor(public uri: { path: string; fsPath: string }, public viewType: string) {}
  }
  class TabInputTerminal {}
  return { state, TabInputText, TabInputTextDiff, TabInputCustom, TabInputTerminal };
});

vi.mock('vscode', () => {
  const { state, TabInputText, TabInputTextDiff, TabInputCustom, TabInputTerminal } = hoisted;
  const capture = (name: string) => (fn: (arg?: unknown) => void) => {
    state.listeners[name] = fn;
    return { dispose() {} };
  };
  return {
    TabInputText,
    TabInputTextDiff,
    TabInputCustom,
    TabInputTerminal,
    Uri: { joinPath: () => ({ toString: () => 'asset-uri' }) },
    commands: {
      executeCommand: (...args: unknown[]) => {
        state.executed.push(args);
        return state.commandResult;
      },
    },
    window: {
      get activeTextEditor() {
        if (state.activeEditorFsPath === undefined) {
          return undefined;
        }
        return { document: { uri: { fsPath: state.activeEditorFsPath, path: state.activeEditorFsPath } } };
      },
      onDidChangeActiveTerminal: capture('terminal'),
      onDidChangeActiveTextEditor: capture('activeEditor'),
      onDidChangeTextEditorSelection: capture('selection'),
      tabGroups: {
        get activeTabGroup() {
          return { activeTab: { input: state.activeTabInput } };
        },
        onDidChangeTabs: capture('tabs'),
        onDidChangeTabGroups: capture('tabGroups'),
      },
    },
  };
});

vi.mock('../diff-inject-codelens.js', () => ({
  getDiffInjectEntry: (fsPath: string) => {
    const builderId = hoisted.state.diffBuilders[fsPath];
    if (builderId === undefined) {
      return undefined;
    }
    return { fsPath, builderId, relPath: '' };
  },
  getDiffInjectEntries: () =>
    Object.entries(hoisted.state.diffBuilders).map(([fsPath, builderId]) => ({
      fsPath,
      builderId,
      relPath: fsPath.replace(/^\/w\/\.builders\/[^/]+\//, ''),
    })),
  onDidChangeDiffInjectRegistry: (fn: () => void) => {
    hoisted.state.listeners['registry'] = fn;
    return { dispose() {} };
  },
}));

const { ContextualPanelProvider } = await import('../contextual-panel/panel-provider.js');
const vscode = await import('vscode');

interface RenderMessage {
  type: string;
  descriptor: ModeDescriptor;
  attention?: AttentionSummary;
  codeReview?: CodeReviewSummary;
  reviewBuilderId?: string;
}

function makeView() {
  const posted: RenderMessage[] = [];
  let onMessage: ((m: unknown) => void) | undefined;
  let onVisibility: (() => void) | undefined;
  const view = {
    visible: true,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://x',
      asWebviewUri: () => ({ toString: () => 'asset' }),
      postMessage: (message: RenderMessage) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (fn: (m: unknown) => void) => {
        onMessage = fn;
        return { dispose() {} };
      },
    },
    onDidChangeVisibility: (fn: () => void) => {
      onVisibility = fn;
      return { dispose() {} };
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  return {
    view: view as unknown as import('vscode').WebviewView,
    posted,
    fireMessage: (m: unknown) => onMessage?.(m),
    fireVisibility: () => onVisibility?.(),
  };
}

function newProvider() {
  const terminalManager = { getActiveBuilderId: () => hoisted.state.activeBuilderId };
  const overviewCache = {
    getData: () => hoisted.state.overviewData as OverviewData | null,
    onDidChange: (fn: () => void) => {
      hoisted.state.listeners['overview'] = fn;
      return { dispose() {} };
    },
  };
  const reviewQueue = {
    getComments: (builderId: string) => hoisted.state.queues[builderId] ?? [],
    getSent: (builderId: string) => hoisted.state.sentQueues[builderId] ?? [],
    getWorktreePath: (builderId: string) => hoisted.state.worktrees[builderId],
    registerWorktree: (builderId: string, worktreePath: string) => {
      hoisted.state.worktrees[builderId] = worktreePath;
    },
    load: (builderId: string) => {
      hoisted.state.loads.push(builderId);
      return Promise.resolve([]);
    },
    onDidChangeQueue: (fn: (builderId: string) => void) => {
      hoisted.state.listeners['queue'] = fn as (arg?: unknown) => void;
      return { dispose() {} };
    },
  };
  return new ContextualPanelProvider(
    {} as unknown as import('vscode').Uri,
    terminalManager as unknown as import('../terminal-manager.js').TerminalManager,
    overviewCache as unknown as import('../views/overview-data.js').OverviewCache,
    reviewQueue as unknown as import('../review-queue/store.js').ReviewQueueStore,
  );
}

function fireOverviewChange(): void {
  hoisted.state.listeners['overview']?.();
}

/** A minimal `OverviewBuilder` — only the fields `deriveAttention` reads carry real values. */
function builderRow(over: Partial<OverviewBuilder> & { id: string }): OverviewBuilder {
  return {
    issueId: null,
    issueTitle: null,
    phase: 'implement',
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    prReady: false,
    lastDataAt: null,
    ...over,
  } as OverviewBuilder;
}

/** A minimal `OverviewData` carrying just what the Attention projection consumes. */
function overview(over: Partial<OverviewData>): OverviewData {
  return {
    builders: [],
    heldCount: 0,
    mailboxEscalated: false,
    queuedFeedback: {},
    ...over,
  } as OverviewData;
}

function textTab(path: string): unknown {
  return new vscode.TabInputText({ path, fsPath: path } as unknown as import('vscode').Uri);
}

function diffTab(modifiedPath: string): unknown {
  const uri = (p: string) => ({ path: p, fsPath: p } as unknown as import('vscode').Uri);
  return new vscode.TabInputTextDiff(uri('/orig'), uri(modifiedPath));
}

function fireSelection(): void {
  const active = (vscode.window as { activeTextEditor?: unknown }).activeTextEditor;
  hoisted.state.listeners['selection']?.({ textEditor: active });
}

function last(posted: RenderMessage[]): RenderMessage {
  return posted[posted.length - 1];
}

beforeEach(() => {
  hoisted.state.activeTabInput = undefined;
  hoisted.state.activeEditorFsPath = undefined;
  hoisted.state.activeBuilderId = null;
  hoisted.state.diffBuilders = {};
  hoisted.state.overviewData = null;
  hoisted.state.queues = {};
  hoisted.state.sentQueues = {};
  hoisted.state.worktrees = {};
  hoisted.state.loads = [];
  hoisted.state.executed = [];
  hoisted.state.commandResult = Promise.resolve(undefined);
  hoisted.state.listeners = {};
});

describe('ContextualPanelProvider — contextual posting', () => {
  it('posts an initial render descriptor on resolveWebviewView', () => {
    hoisted.state.activeTabInput = textTab('/w/codev/specs/x.md');
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('render');
    expect(posted[0].descriptor.kind).toBe('document-review');
  });

  it('re-posts only when the resolved render changes', () => {
    hoisted.state.activeTabInput = textTab('/w/src/foo.ts'); // non-artifact → attention
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);
    expect(posted[0].descriptor.kind).toBe('attention');

    fireSelection(); // same surface → nothing
    expect(posted).toHaveLength(1);

    hoisted.state.activeTabInput = textTab('/w/codev/plans/x.md');
    hoisted.state.listeners['tabs']?.();
    expect(posted).toHaveLength(2);
    expect(posted[1].descriptor.kind).toBe('document-review');
  });

  it('re-posts when switching between two ordinary files (both Attention, different surfaces)', () => {
    hoisted.state.activeTabInput = textTab('/w/src/a.ts');
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);
    hoisted.state.activeTabInput = textTab('/w/src/b.ts');
    hoisted.state.listeners['tabs']?.();
    expect(posted).toHaveLength(2);
  });

  it('re-posts the cached descriptor on visibility and on a ready message; ignores unknown messages', () => {
    hoisted.state.activeTabInput = textTab('/w/codev/specs/x.md');
    const provider = newProvider();
    const { view, posted, fireVisibility, fireMessage } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);
    fireVisibility();
    expect(posted).toHaveLength(2);
    expect(posted[1].descriptor).toEqual(posted[0].descriptor);
    fireMessage({ type: 'ready' });
    expect(posted).toHaveLength(3);
    fireMessage({ type: 'nonsense' });
    fireMessage(undefined);
    expect(posted).toHaveLength(3);
  });
});

describe('ContextualPanelProvider — surface resolution', () => {
  it('resolves a builder diff from the modified side via the registry', () => {
    hoisted.state.diffBuilders['/w/.builders/b/x.ts'] = 'b';
    hoisted.state.activeTabInput = diffTab('/w/.builders/b/x.ts');
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].descriptor.kind).toBe('code-review');
    expect(posted[0].descriptor.context.builderId).toBe('b');
  });

  it('re-resolves when the diff-inject registry populates after the diff opens', () => {
    hoisted.state.activeTabInput = diffTab('/w/.builders/b/x.ts');
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].descriptor.kind).toBe('attention');
    hoisted.state.diffBuilders['/w/.builders/b/x.ts'] = 'b';
    hoisted.state.listeners['registry']?.();
    expect(last(posted).descriptor.kind).toBe('code-review');
    expect(last(posted).descriptor.context.builderId).toBe('b');
  });

  it('resolves a focused builder terminal to Builder Inspector, and exits on return to the editor', () => {
    hoisted.state.activeTabInput = textTab('/w/src/foo.ts');
    hoisted.state.activeBuilderId = 'spir-1049';
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].descriptor.kind).toBe('attention');

    hoisted.state.listeners['terminal']?.({});
    expect(last(posted).descriptor.kind).toBe('builder-inspector');
    expect(last(posted).descriptor.context.builderId).toBe('spir-1049');

    // Return focus to the editor: the terminal still exists (getActiveBuilderId stays set), but
    // last-focus demotes it — the #1497-safe exit.
    fireSelection();
    expect(last(posted).descriptor.kind).toBe('attention');
  });

  it('re-activates Builder Inspector when focus returns to the already-active terminal', () => {
    hoisted.state.activeTabInput = textTab('/w/src/foo.ts');
    hoisted.state.activeBuilderId = 'spir-1049';
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);

    hoisted.state.listeners['terminal']?.({}); // enter terminal → Builder Inspector
    fireSelection(); // back to editor → attention
    expect(last(posted).descriptor.kind).toBe('attention');

    // Re-enter the SAME terminal: onDidChangeActiveTerminal does NOT fire (terminal unchanged), but
    // the active editor becomes undefined. With a builder terminal active and a non-custom tab, that
    // is the terminal regaining focus.
    hoisted.state.activeEditorFsPath = undefined;
    hoisted.state.listeners['activeEditor']?.(undefined);
    expect(last(posted).descriptor.kind).toBe('builder-inspector');
  });

  it('re-resolves when navigating between files inside a multi-file diff (active editor changes)', () => {
    hoisted.state.activeTabInput = { multiDiff: true }; // untyped input → 'other'
    hoisted.state.activeEditorFsPath = '/w/.builders/b/a.ts';
    hoisted.state.diffBuilders['/w/.builders/b/a.ts'] = 'b';
    hoisted.state.diffBuilders['/w/.builders/b/c.ts'] = 'c';
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(last(posted).descriptor.context.builderId).toBe('b');
    hoisted.state.activeEditorFsPath = '/w/.builders/b/c.ts';
    hoisted.state.listeners['activeEditor']?.({});
    expect(last(posted).descriptor.context.builderId).toBe('c');
  });

  it('does not demote a focused builder terminal on background tab churn', () => {
    hoisted.state.activeTabInput = textTab('/w/src/a.ts');
    hoisted.state.activeBuilderId = 'b';
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    hoisted.state.listeners['terminal']?.({});
    expect(last(posted).descriptor.kind).toBe('builder-inspector');
    hoisted.state.listeners['tabs']?.(); // same active tab → no demotion
    expect(last(posted).descriptor.kind).toBe('builder-inspector');
  });

  it('does not demote a focused builder terminal when a terminal-in-editor-area tab activates', () => {
    // A terminal moved into the editor area (TabInputTerminal) activating is terminal focus, not
    // editor focus, so it must not read as an editor activation and knock Builder Inspector down.
    hoisted.state.activeTabInput = textTab('/w/src/a.ts');
    hoisted.state.activeBuilderId = 'spir-1049';
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);

    hoisted.state.listeners['terminal']?.({}); // focus the builder terminal → Builder Inspector
    expect(last(posted).descriptor.kind).toBe('builder-inspector');

    // The active tab changes to an editor-area terminal tab (a genuine activation, new resource) —
    // must stay Builder Inspector rather than demote to Attention.
    hoisted.state.activeTabInput = new (vscode as unknown as { TabInputTerminal: new () => unknown }).TabInputTerminal();
    hoisted.state.listeners['tabs']?.();
    expect(last(posted).descriptor.kind).toBe('builder-inspector');
  });
});

describe('ContextualPanelProvider — Attention body from the overview cache (#1553)', () => {
  it('carries the projected attention payload on an Attention post', () => {
    hoisted.state.activeTabInput = textTab('/w/src/foo.ts'); // non-artifact → attention
    hoisted.state.overviewData = overview({
      builders: [builderRow({ id: 'pir-1553', issueId: '#1553', blocked: 'plan review', blockedSince: '2026-08-25T00:00:00Z' })],
    });
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);

    expect(posted[0].descriptor.kind).toBe('attention');
    expect(posted[0].attention?.isEmpty).toBe(false);
    expect(posted[0].attention?.pendingGates).toEqual([
      { builderId: 'pir-1553', issueId: '#1553', issueTitle: null, gate: 'plan review', since: '2026-08-25T00:00:00Z' },
    ]);
  });

  it('projects the honest empty summary when nothing needs attention', () => {
    hoisted.state.activeTabInput = textTab('/w/src/foo.ts');
    hoisted.state.overviewData = overview({ builders: [builderRow({ id: 'pir-1553' })] });
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);

    expect(posted[0].descriptor.kind).toBe('attention');
    expect(posted[0].attention?.isEmpty).toBe(true);
  });

  it('omits the attention payload on a non-Attention post', () => {
    hoisted.state.activeTabInput = textTab('/w/codev/specs/x.md'); // artifact → document-review
    hoisted.state.overviewData = overview({ builders: [builderRow({ id: 'pir-1553', blocked: 'plan review' })] });
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);

    expect(posted[0].descriptor.kind).toBe('document-review');
    expect(posted[0].attention).toBeUndefined();
  });

  it('re-posts fresh attention data on an overview-cache change while in Attention mode', () => {
    hoisted.state.activeTabInput = textTab('/w/src/foo.ts');
    hoisted.state.overviewData = overview({ builders: [builderRow({ id: 'pir-1553' })] });
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);
    expect(posted[0].attention?.isEmpty).toBe(true);

    // A gate opens; the cache refreshes (SSE) → the body re-posts with the new roll-up, same surface.
    hoisted.state.overviewData = overview({
      builders: [builderRow({ id: 'pir-1553', blocked: 'dev review' })],
    });
    fireOverviewChange();
    expect(posted).toHaveLength(2);
    expect(posted[1].descriptor.kind).toBe('attention');
    expect(posted[1].attention?.pendingGates[0]?.gate).toBe('dev review');
  });

  it('does not post on an overview-cache change while in a non-Attention mode', () => {
    hoisted.state.activeTabInput = textTab('/w/codev/specs/x.md'); // document-review
    hoisted.state.overviewData = overview({ builders: [] });
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);

    hoisted.state.overviewData = overview({ builders: [builderRow({ id: 'pir-1553', blocked: 'plan review' })] });
    fireOverviewChange();
    expect(posted).toHaveLength(1); // unchanged — the cache does not drive non-Attention modes
  });
});

describe('ContextualPanelProvider — review-queue body (#1559)', () => {
  const diffPath = '/w/.builders/air-1559/src/x.ts';

  function showDiff(): void {
    hoisted.state.diffBuilders = { [diffPath]: '1559' };
    hoisted.state.activeTabInput = diffTab(diffPath);
    hoisted.state.activeEditorFsPath = diffPath;
  }

  /** Focus the builder terminal whose Tower-canonical id is `terminalId`. */
  function showTerminal(terminalId: string): void {
    hoisted.state.activeBuilderId = terminalId;
    hoisted.state.listeners['terminal']?.({});
  }

  function queued(id: string, body: string): unknown {
    return { id, createdAt: '2026-10-05T00:00:00Z', file: 'src/x.ts', lineRange: { start: 3, end: 3 }, body };
  }

  it("carries the shown builder's queue and its commented files on a Code Review post", () => {
    showDiff();
    hoisted.state.queues = { '1559': [queued('c1', 'rename this')], other: [queued('c2', 'not mine')] };
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);

    expect(posted[0].descriptor.kind).toBe('code-review');
    expect(posted[0].attention).toBeUndefined();
    expect(posted[0].reviewBuilderId).toBe('1559');
    expect(posted[0].codeReview?.comments).toEqual([{ id: 'c1', file: 'src/x.ts', line: 3, ref: 'src/x.ts:L3', body: 'rename this' }]);
    expect(posted[0].codeReview?.files).toEqual([{ relPath: 'src/x.ts', pendingCount: 1, sentCount: 0 }]);
  });

  it('carries sent-unconfirmed comments alongside pending ones', () => {
    showDiff();
    hoisted.state.sentQueues = { '1559': [{ ...(queued('s1', 'sent earlier') as object), sentAt: '2026-10-05T01:00:00Z' }] };
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].codeReview?.sent.map((c) => c.id)).toEqual(['s1']);
    expect(posted[0].codeReview?.isEmpty).toBe(false);
  });

  it('omits the queue payload in Attention / Document Review', () => {
    hoisted.state.activeTabInput = textTab('/w/src/foo.ts');
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].descriptor.kind).toBe('attention');
    expect(posted[0].codeReview).toBeUndefined();
    expect(posted[0].reviewBuilderId).toBeUndefined();
  });

  it("re-posts on the shown builder's queue change, and ignores other builders' changes", () => {
    showDiff();
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);

    hoisted.state.listeners['queue']?.('other');
    expect(posted).toHaveLength(1);

    hoisted.state.queues = { '1559': [queued('c1', 'new comment')] };
    hoisted.state.listeners['queue']?.('1559');
    expect(posted).toHaveLength(2);
    expect(posted[1].codeReview?.comments.map((c) => c.body)).toEqual(['new comment']);
  });

  it('does not post on a queue change while no queue is shown', () => {
    hoisted.state.activeTabInput = textTab('/w/src/foo.ts');
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    hoisted.state.listeners['queue']?.('1559');
    expect(posted).toHaveLength(1);
  });

  describe('Builder Inspector (the queue follows the builder terminal)', () => {
    beforeEach(() => {
      hoisted.state.overviewData = overview({
        builders: [builderRow({ id: '1559', roleId: 'builder-air-1559', worktreePath: '/w/.builders/air-1559' })],
      });
    });

    it('maps the terminal id to the queue key and carries that queue', () => {
      hoisted.state.queues = { '1559': [queued('c1', 'from the diff')] };
      const provider = newProvider();
      const { view, posted } = makeView();
      provider.resolveWebviewView(view);
      showTerminal('builder-air-1559');

      const message = last(posted);
      expect(message.descriptor.kind).toBe('builder-inspector');
      expect(message.descriptor.context.builderId).toBe('builder-air-1559');
      expect(message.reviewBuilderId).toBe('1559');
      expect(message.codeReview?.comments.map((c) => c.id)).toEqual(['c1']);
    });

    it("registers the builder's worktree from the overview and loads its queue once", () => {
      const provider = newProvider();
      const { view } = makeView();
      provider.resolveWebviewView(view);
      showTerminal('builder-air-1559');
      hoisted.state.listeners['queue']?.('1559'); // the load landing re-posts; must not reload

      expect(hoisted.state.worktrees['1559']).toBe('/w/.builders/air-1559');
      expect(hoisted.state.loads).toEqual(['1559']);
    });

    it('carries no queue when the terminal id matches no overview builder', () => {
      const provider = newProvider();
      const { view, posted } = makeView();
      provider.resolveWebviewView(view);
      showTerminal('builder-spir-9999');
      expect(last(posted).descriptor.kind).toBe('builder-inspector');
      expect(last(posted).reviewBuilderId).toBeUndefined();
      expect(last(posted).codeReview).toBeUndefined();
    });

    it('re-posts on an overview change so a late-arriving mapping resolves', () => {
      hoisted.state.overviewData = overview({ builders: [] });
      const provider = newProvider();
      const { view, posted } = makeView();
      provider.resolveWebviewView(view);
      showTerminal('builder-air-1559');
      expect(last(posted).reviewBuilderId).toBeUndefined();

      hoisted.state.overviewData = overview({ builders: [builderRow({ id: '1559', roleId: 'builder-air-1559' })] });
      fireOverviewChange();
      expect(last(posted).reviewBuilderId).toBe('1559');
    });

    it('honors review actions addressed to the mapped queue key', () => {
      const provider = newProvider();
      const { view, fireMessage } = makeView();
      provider.resolveWebviewView(view);
      showTerminal('builder-air-1559');

      fireMessage({ type: 'review-action', action: 'markDelivered', builderId: 'builder-air-1559' }); // terminal id: wrong space
      expect(hoisted.state.executed).toEqual([]);
      fireMessage({ type: 'review-action', action: 'markDelivered', builderId: '1559' });
      expect(hoisted.state.executed).toEqual([['codev.markReviewDelivered', '1559']]);
    });
  });

  describe('inbound messages', () => {
    it('maps each review action to its command; Submit sends pending only', async () => {
      showDiff();
      const provider = newProvider();
      const { view, fireMessage } = makeView();
      provider.resolveWebviewView(view);

      for (const action of ['submit', 'discard', 'resend', 'markDelivered']) {
        fireMessage({ type: 'review-action', action, builderId: '1559' });
        await new Promise((resolve) => setTimeout(resolve, 0)); // let the in-flight guard clear
      }
      expect(hoisted.state.executed).toEqual([
        ['codev.submitReview', '1559', { pendingOnly: true }],
        ['codev.discardReviewComments', '1559'],
        ['codev.resendReview', '1559'],
        ['codev.markReviewDelivered', '1559'],
      ]);
    });

    it('drops repeat clicks while an action is running, then accepts the next one', async () => {
      showDiff();
      let finish: () => void = () => {};
      hoisted.state.commandResult = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const provider = newProvider();
      const { view, fireMessage } = makeView();
      provider.resolveWebviewView(view);

      fireMessage({ type: 'review-action', action: 'submit', builderId: '1559' });
      fireMessage({ type: 'review-action', action: 'submit', builderId: '1559' }); // double click
      expect(hoisted.state.executed).toHaveLength(1);

      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
      hoisted.state.commandResult = Promise.resolve(undefined);
      fireMessage({ type: 'review-action', action: 'discard', builderId: '1559' });
      expect(hoisted.state.executed).toHaveLength(2);
    });

    it('opens a file ref at its line for the shown builder', () => {
      showDiff();
      const provider = newProvider();
      const { view, fireMessage } = makeView();
      provider.resolveWebviewView(view);

      fireMessage({ type: 'open-location', builderId: '1559', relPath: 'src/x.ts', line: 3 });
      fireMessage({ type: 'open-location', builderId: '1559', relPath: 'README.md' });
      expect(hoisted.state.executed).toEqual([
        ['codev.openBuilderFileLocation', { builderId: '1559', relPath: 'src/x.ts', line: 3 }],
        ['codev.openBuilderFileLocation', { builderId: '1559', relPath: 'README.md', line: undefined }],
      ]);
    });

    it('ignores malformed messages, another builder, or a surface showing no queue', () => {
      showDiff();
      const provider = newProvider();
      const { view, fireMessage } = makeView();
      provider.resolveWebviewView(view);

      fireMessage({ type: 'review-action', action: 'submit', builderId: 'other' });
      fireMessage({ type: 'review-action', action: 'toString', builderId: '1559' });
      fireMessage({ type: 'review-action', action: 'submit' });
      fireMessage({ type: 'open-location', builderId: '1559', relPath: 'src/x.ts', line: 0 });
      fireMessage({ type: 'open-location', builderId: 'other', relPath: 'src/x.ts' });
      fireMessage({ type: 'open-location', builderId: '1559', relPath: '../../etc/passwd' });
      fireMessage({ type: 'open-location', builderId: '1559', relPath: 'src/../../escape.ts' });
      fireMessage({ type: 'open-location', builderId: '1559', relPath: '/etc/passwd' });
      fireMessage({ type: 'open-location', builderId: '1559', relPath: 'C:\\Windows\\x' });
      expect(hoisted.state.executed).toEqual([]);

      hoisted.state.activeTabInput = textTab('/w/src/foo.ts');
      hoisted.state.activeEditorFsPath = '/w/src/foo.ts';
      fireSelection(); // → attention
      fireMessage({ type: 'review-action', action: 'submit', builderId: '1559' });
      expect(hoisted.state.executed).toEqual([]);
    });
  });
});
