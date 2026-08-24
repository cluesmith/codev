/**
 * Integration tests for ContextualPanelProvider (Phase 3): trigger wiring, post-only-on-identity-
 * change dedup, ready-message and visibility re-post, and terminal-surface resolution.
 *
 * `vscode` and the diff-inject registry are mocked; the surface is driven by setting the mocked
 * active tab / editor / terminal-builder and firing the captured trigger listeners.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ModeDescriptor } from '../contextual-panel/types.js';

const hoisted = vi.hoisted(() => {
  const state = {
    activeTabInput: undefined as unknown,
    activeEditorFsPath: undefined as string | undefined,
    activeBuilderId: null as string | null,
    diffBuilders: {} as Record<string, string>,
    pendingBuilders: [] as string[],
    overviewBuilderIds: [] as string[],
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
  return { state, TabInputText, TabInputTextDiff, TabInputCustom };
});

vi.mock('vscode', () => {
  const { state, TabInputText, TabInputTextDiff, TabInputCustom } = hoisted;
  const capture = (name: string) => (fn: (arg?: unknown) => void) => {
    state.listeners[name] = fn;
    return { dispose() {} };
  };
  return {
    TabInputText,
    TabInputTextDiff,
    TabInputCustom,
    Uri: { joinPath: () => ({ toString: () => 'asset-uri' }) },
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
  summary?: { builderIds: string[] };
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
  const reviewQueueStore = {
    buildersWithPending: () => hoisted.state.pendingBuilders,
    onDidChangeQueue: (fn: () => void) => {
      hoisted.state.listeners['queue'] = fn;
      return { dispose() {} };
    },
  };
  const overviewCache = {
    getData: () => ({ builders: hoisted.state.overviewBuilderIds.map((id) => ({ id })) }),
    onDidChange: (fn: () => void) => {
      hoisted.state.listeners['overview'] = fn;
      return { dispose() {} };
    },
  };
  return new ContextualPanelProvider(
    {} as unknown as import('vscode').Uri,
    terminalManager as unknown as import('../terminal-manager.js').TerminalManager,
    reviewQueueStore as unknown as import('../review-queue/store.js').ReviewQueueStore,
    overviewCache as unknown as import('../views/overview-data.js').OverviewCache,
  );
}

function artifactTab(path: string): unknown {
  // tsc checks against the real @types/vscode (TabInputText(uri: Uri)); at runtime `vscode` is the
  // mock whose class just stores the object, and classifyTab reads `.uri.path` / `.uri.fsPath`.
  return new vscode.TabInputText({ path, fsPath: path } as unknown as import('vscode').Uri);
}

function diffTab(modifiedPath: string): unknown {
  const uri = (p: string) => ({ path: p, fsPath: p } as unknown as import('vscode').Uri);
  return new vscode.TabInputTextDiff(uri('/orig'), uri(modifiedPath));
}

/** Fire an editor-selection event carrying the active editor (the provider gates focus on it). */
function fireSelection(): void {
  const active = (vscode.window as { activeTextEditor?: unknown }).activeTextEditor;
  hoisted.state.listeners['selection']?.({ textEditor: active });
}

beforeEach(() => {
  hoisted.state.activeTabInput = undefined;
  hoisted.state.activeEditorFsPath = undefined;
  hoisted.state.activeBuilderId = null;
  hoisted.state.diffBuilders = {};
  hoisted.state.pendingBuilders = [];
  hoisted.state.overviewBuilderIds = [];
  hoisted.state.listeners = {};
});

describe('ContextualPanelProvider — posting', () => {
  it('posts an initial render descriptor on resolveWebviewView', () => {
    hoisted.state.activeTabInput = artifactTab('/w/codev/specs/x.md');
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('render');
    expect(posted[0].descriptor.kind).toBe('document-review');
  });

  it('re-posts only when the resolved surface identity changes', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/foo.ts'); // non-artifact → attention
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);
    expect(posted[0].descriptor.kind).toBe('attention');

    // Same surface → a selection change posts nothing.
    fireSelection();
    expect(posted).toHaveLength(1);

    // Change the surface → a tab change posts the new descriptor.
    hoisted.state.activeTabInput = artifactTab('/w/codev/plans/x.md');
    hoisted.state.listeners['tabs']?.();
    expect(posted).toHaveLength(2);
    expect(posted[1].descriptor.kind).toBe('document-review');
  });

  it('re-posts the cached descriptor when the view becomes visible again', () => {
    hoisted.state.activeTabInput = artifactTab('/w/codev/specs/x.md');
    const provider = newProvider();
    const { view, posted, fireVisibility } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);
    fireVisibility();
    expect(posted).toHaveLength(2);
    expect(posted[1].descriptor).toEqual(posted[0].descriptor);
  });

  it('re-posts on a ready message and ignores unknown messages', () => {
    hoisted.state.activeTabInput = artifactTab('/w/codev/specs/x.md');
    const provider = newProvider();
    const { view, posted, fireMessage } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);
    fireMessage({ type: 'ready' });
    expect(posted).toHaveLength(2);
    fireMessage({ type: 'not-a-message' });
    fireMessage(undefined);
    expect(posted).toHaveLength(2);
  });

  it('resolves a focused builder terminal to Builder Inspector for that builder', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/foo.ts'); // attention while editor-focused
    hoisted.state.activeBuilderId = 'spir-1049';
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].descriptor.kind).toBe('attention'); // terminal not yet focused

    // Focus the builder terminal.
    hoisted.state.listeners['terminal']?.({});
    const last = posted[posted.length - 1];
    expect(last.descriptor.kind).toBe('builder-inspector');
    expect(last.descriptor.context.builderId).toBe('spir-1049');
  });

  it('resolves a builder diff from the modified (right) side via the registry', () => {
    hoisted.state.diffBuilders['/w/.builders/b/x.ts'] = 'b';
    hoisted.state.activeTabInput = diffTab('/w/.builders/b/x.ts');
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].descriptor.kind).toBe('code-review');
    expect(posted[0].descriptor.context.builderId).toBe('b');
  });

  it('re-resolves when the diff-inject registry populates after the diff opens', () => {
    hoisted.state.activeTabInput = diffTab('/w/.builders/b/x.ts'); // registry still empty
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].descriptor.kind).toBe('attention'); // builder not yet known

    hoisted.state.diffBuilders['/w/.builders/b/x.ts'] = 'b';
    hoisted.state.listeners['registry']?.();
    const last = posted[posted.length - 1];
    expect(last.descriptor.kind).toBe('code-review');
    expect(last.descriptor.context.builderId).toBe('b');
  });

  it('re-posts when switching between two ordinary files that both resolve to Attention', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/a.ts');
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted).toHaveLength(1);
    expect(posted[0].descriptor.kind).toBe('attention');

    hoisted.state.activeTabInput = artifactTab('/w/src/b.ts');
    hoisted.state.listeners['tabs']?.();
    expect(posted).toHaveLength(2); // different surface, even though both are Attention
    expect(posted[1].descriptor.kind).toBe('attention');
  });

  it('re-resolves when navigating between files inside a multi-file diff (active editor changes)', () => {
    // A multi-diff container tab has an untyped input (classifies as `other`); its focused sub-file
    // surfaces as the active editor, and the tab does not change as you move between files.
    hoisted.state.activeTabInput = { multiDiff: true }; // not a TabInput* class → 'other'
    hoisted.state.activeEditorFsPath = '/w/.builders/b/src/a.ts';
    hoisted.state.diffBuilders['/w/.builders/b/src/a.ts'] = 'b';
    hoisted.state.diffBuilders['/w/.builders/b/codev/specs/x.md'] = 'b';
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].descriptor.kind).toBe('code-review');
    expect(posted[0].descriptor.context.builderId).toBe('b');
    expect(posted[0].descriptor.applicability['document-review']).toBe(false); // a.ts is not an artifact

    // Move to a different sub-file that IS an artifact — active editor changes, tab does not.
    hoisted.state.activeEditorFsPath = '/w/.builders/b/codev/specs/x.md';
    hoisted.state.listeners['activeEditor']?.({});
    const last = posted[posted.length - 1];
    expect(last.descriptor.kind).toBe('code-review'); // diff still wins
    expect(last.descriptor.applicability['document-review']).toBe(true); // now an artifact → navigable
  });

  it('does not demote a focused builder terminal on background tab churn', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/a.ts');
    hoisted.state.activeBuilderId = 'b';
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);

    hoisted.state.listeners['terminal']?.({}); // focus terminal → Builder Inspector
    expect(posted[posted.length - 1].descriptor.kind).toBe('builder-inspector');

    // A tab event with the SAME active tab (e.g. a dirty/pin/label change) must not note editor focus.
    hoisted.state.listeners['tabs']?.();
    expect(posted[posted.length - 1].descriptor.kind).toBe('builder-inspector');
  });

  it('returning focus to the editor exits Builder Inspector even though the terminal still exists', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/foo.ts');
    hoisted.state.activeBuilderId = 'spir-1049'; // getActiveBuilderId stays non-null throughout
    const provider = newProvider();
    const { view, posted } = makeView();
    provider.resolveWebviewView(view);

    hoisted.state.listeners['terminal']?.({}); // focus terminal → Builder Inspector
    expect(posted[posted.length - 1].descriptor.kind).toBe('builder-inspector');

    // A selection change means the editor is focused again. The terminal is not gone
    // (getActiveBuilderId is still 'spir-1049'), but last-focus demotes it — the #1497-safe exit.
    fireSelection();
    expect(posted[posted.length - 1].descriptor.kind).toBe('attention');
  });
});

describe('ContextualPanelProvider — transient navigation (Phase 4)', () => {
  function lastMessage(posted: RenderMessage[]): RenderMessage {
    return posted[posted.length - 1];
  }

  it('a mode-navigate message shows that mode as a summary with the builder-id stub', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/foo.ts'); // contextual = attention
    hoisted.state.pendingBuilders = ['spir-1049', 'bugfix-1408'];
    const provider = newProvider();
    const { view, posted, fireMessage } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].descriptor.kind).toBe('attention');

    fireMessage({ type: 'mode-navigate', mode: 'code-review' });
    const last = lastMessage(posted);
    expect(last.descriptor.kind).toBe('code-review');
    expect(last.descriptor.level).toBe('summary');
    expect(last.summary?.builderIds).toEqual(['spir-1049', 'bugfix-1408']);
  });

  it('a drill-in message on a known builder shows that builder detail', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/foo.ts');
    hoisted.state.pendingBuilders = ['spir-1049'];
    const provider = newProvider();
    const { view, posted, fireMessage } = makeView();
    provider.resolveWebviewView(view);

    fireMessage({ type: 'drill-in', mode: 'code-review', builderId: 'spir-1049' });
    const last = lastMessage(posted);
    expect(last.descriptor.kind).toBe('code-review');
    expect(last.descriptor.level).toBe('detail');
    expect(last.descriptor.context.builderId).toBe('spir-1049');
  });

  it('ignores navigation to an unknown builder and to an invalid mode', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/foo.ts');
    hoisted.state.pendingBuilders = ['spir-1049'];
    const provider = newProvider();
    const { view, posted, fireMessage } = makeView();
    provider.resolveWebviewView(view);
    const before = posted.length;

    fireMessage({ type: 'drill-in', mode: 'code-review', builderId: 'unknown-builder' });
    fireMessage({ type: 'mode-navigate', mode: 'not-a-mode' });
    fireMessage({ type: 'drill-in', mode: 'code-review' }); // missing builderId
    expect(posted.length).toBe(before); // all ignored, nothing posted
  });

  it('a real surface change clears the transient selection and returns to context', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/foo.ts'); // attention
    hoisted.state.pendingBuilders = ['spir-1049'];
    const provider = newProvider();
    const { view, posted, fireMessage } = makeView();
    provider.resolveWebviewView(view);

    fireMessage({ type: 'mode-navigate', mode: 'code-review' }); // navigate away
    expect(lastMessage(posted).descriptor.kind).toBe('code-review');

    // Open a spec: a genuine surface change clears the manual selection.
    hoisted.state.activeTabInput = artifactTab('/w/codev/specs/x.md');
    hoisted.state.listeners['tabs']?.();
    expect(lastMessage(posted).descriptor.kind).toBe('document-review');
  });

  it('first-navigating Code Review while viewing a worktree artifact scopes to that builder (A2), then zooms out to summary', () => {
    hoisted.state.activeTabInput = artifactTab('/w/.builders/spir-1049/codev/specs/x.md'); // worktree artifact → document-review
    hoisted.state.pendingBuilders = ['spir-1049', 'bugfix-1408'];
    const provider = newProvider();
    const { view, posted, fireMessage } = makeView();
    provider.resolveWebviewView(view);
    expect(posted[0].descriptor.kind).toBe('document-review');

    // First click on Code Review (not currently in it) scopes to the artifact's builder (A2).
    fireMessage({ type: 'mode-navigate', mode: 'code-review' });
    expect(lastMessage(posted).descriptor.level).toBe('detail');
    expect(lastMessage(posted).descriptor.context.builderId).toBe('spir-1049');

    // Clicking the now-active Code Review pill zooms out to the cross-builder summary.
    fireMessage({ type: 'mode-navigate', mode: 'code-review' });
    expect(lastMessage(posted).descriptor.level).toBe('summary');
    expect(lastMessage(posted).summary?.builderIds).toEqual(['spir-1049', 'bugfix-1408']);
  });

  it('clicking the active builder-scoped pill navigates from a drilled-in detail back to its summary', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/foo.ts');
    hoisted.state.pendingBuilders = ['spir-1049'];
    const provider = newProvider();
    const { view, posted, fireMessage } = makeView();
    provider.resolveWebviewView(view);

    fireMessage({ type: 'drill-in', mode: 'code-review', builderId: 'spir-1049' });
    expect(lastMessage(posted).descriptor.level).toBe('detail');

    // Clicking the (active) Code Review pill re-navigates to the mode with no builder → summary.
    fireMessage({ type: 'mode-navigate', mode: 'code-review' });
    expect(lastMessage(posted).descriptor.level).toBe('summary');
    expect(lastMessage(posted).descriptor.context.builderId).toBeUndefined();
  });

  it('re-posts a summary when its builder-id list changes under the panel', () => {
    hoisted.state.activeTabInput = artifactTab('/w/src/foo.ts');
    hoisted.state.pendingBuilders = ['spir-1049'];
    const provider = newProvider();
    const { view, posted, fireMessage } = makeView();
    provider.resolveWebviewView(view);
    fireMessage({ type: 'mode-navigate', mode: 'code-review' });
    const before = posted.length;

    hoisted.state.pendingBuilders = ['spir-1049', 'bugfix-1408'];
    hoisted.state.listeners['queue']?.();
    expect(posted.length).toBe(before + 1);
    expect(lastMessage(posted).summary?.builderIds).toEqual(['spir-1049', 'bugfix-1408']);
  });
});
