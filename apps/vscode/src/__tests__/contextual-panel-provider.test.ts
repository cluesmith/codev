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

const hoisted = vi.hoisted(() => {
  const state = {
    activeTabInput: undefined as unknown,
    activeEditorFsPath: undefined as string | undefined,
    activeBuilderId: null as string | null,
    diffBuilders: {} as Record<string, string>,
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
  return new ContextualPanelProvider(
    {} as unknown as import('vscode').Uri,
    terminalManager as unknown as import('../terminal-manager.js').TerminalManager,
  );
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
});
