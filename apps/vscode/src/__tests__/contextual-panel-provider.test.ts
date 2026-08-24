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
        return { document: { uri: { fsPath: state.activeEditorFsPath } } };
      },
      onDidChangeActiveTerminal: capture('terminal'),
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

function artifactTab(path: string): unknown {
  // tsc checks against the real @types/vscode (TabInputText(uri: Uri)); at runtime `vscode` is the
  // mock whose class just stores the object, and classifyTab reads `.uri.path` / `.uri.fsPath`.
  return new vscode.TabInputText({ path, fsPath: path } as unknown as import('vscode').Uri);
}

beforeEach(() => {
  hoisted.state.activeTabInput = undefined;
  hoisted.state.activeEditorFsPath = undefined;
  hoisted.state.activeBuilderId = null;
  hoisted.state.diffBuilders = {};
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
    hoisted.state.listeners['selection']?.();
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
    hoisted.state.listeners['selection']?.();
    expect(posted[posted.length - 1].descriptor.kind).toBe('attention');
  });
});
