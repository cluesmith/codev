/**
 * Tests for the VSCode editor provider (the editor + command relay).
 *
 * Mocks `vscode` (the established pattern from overview-cache.test.ts) with a
 * controllable window so we can drive focus, the active editor, and the change
 * events, plus a fake ConnectionManager that lets us fire synthetic SSE
 * envelopes and inspect the TowerClient relay calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => {
  const visibleListeners: Array<() => void> = [];
  const activeListeners: Array<() => void> = [];
  const windowListeners: Array<() => void> = [];
  const selectionListeners: Array<() => void> = [];
  const window = {
    state: { focused: true },
    activeTextEditor: undefined as unknown,
    onDidChangeTextEditorVisibleRanges: (l: () => void) => {
      visibleListeners.push(l);
      return { dispose: () => {} };
    },
    onDidChangeActiveTextEditor: (l: () => void) => {
      activeListeners.push(l);
      return { dispose: () => {} };
    },
    onDidChangeWindowState: (l: () => void) => {
      windowListeners.push(l);
      return { dispose: () => {} };
    },
    onDidChangeTextEditorSelection: (l: () => void) => {
      selectionListeners.push(l);
      return { dispose: () => {} };
    },
  };
  return {
    window,
    commands: { executeCommand: vi.fn() },
    Disposable: {
      from: (...ds: Array<{ dispose?: () => void }>) => ({
        dispose: () => ds.forEach((d) => d.dispose?.()),
      }),
    },
    Range: class {
      constructor(public start: unknown, public end: unknown) {}
    },
    TextEditorRevealType: { InCenter: 2 },
    __control: {
      fireVisible: () => visibleListeners.forEach((l) => l()),
      fireActive: () => activeListeners.forEach((l) => l()),
      fireSelection: () => selectionListeners.forEach((l) => l()),
    },
  };
});

// The relay imports getDiffInjectEntry to tell whether the active editor is a
// builder diff; stub it so the test's minimal vscode mock is enough.
vi.mock('../diff-inject-codelens.js', () => ({ getDiffInjectEntry: () => undefined }));

const vscode = (await import('vscode')) as unknown as {
  window: { state: { focused: boolean }; activeTextEditor: unknown };
  commands: { executeCommand: ReturnType<typeof vi.fn> };
  __control: { fireVisible: () => void; fireActive: () => void };
};
const { wireEditorProvider } = await import('../editor-relay.js');

function makeEditor() {
  return {
    visibleRanges: [{ start: { line: 10 }, end: { line: 50 } }],
    document: { lineCount: 800, uri: { toString: () => 'file:///x.ts', fsPath: '/x.ts' } },
    selection: { active: { line: 5, character: 0 }, isEmpty: true },
    revealRange: vi.fn(),
  };
}

function makeConnMgr(client: unknown) {
  let sse: ((e: { type: string; data: string }) => void) | null = null;
  return {
    mgr: {
      onSSEEvent: (l: (e: { type: string; data: string }) => void) => {
        sse = l;
        return { dispose: () => { sse = null; } };
      },
      getClient: () => client,
    },
    // Tower sends {type, title, body:JSON} on the SSE data field, no event: name.
    fire: (type: string, payload: unknown) =>
      sse?.({ type: '', data: JSON.stringify({ type, title: type, body: JSON.stringify(payload) }) }),
  };
}

describe('wireEditorProvider', () => {
  let client: { request: ReturnType<typeof vi.fn> };

  // The relay POSTs via the existing TowerClient.request(path, { method, body }).
  function requestsTo(path: string): unknown[] {
    return client.request.mock.calls.filter((c) => c[0] === path).map((c) => JSON.parse(c[1].body));
  }
  function lastRequestTo(path: string): unknown {
    const all = requestsTo(path);
    return all[all.length - 1];
  }

  beforeEach(() => {
    client = { request: vi.fn().mockResolvedValue({ ok: true }) };
    vscode.window.state.focused = true;
    vscode.window.activeTextEditor = makeEditor();
    vscode.commands.executeCommand.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an initial position when Tower signals wanted:true', () => {
    const { mgr, fire } = makeConnMgr(client);
    const disposable = wireEditorProvider(mgr as never);

    fire('editor-wants-position', { wanted: true });

    expect(lastRequestTo('/api/editor/position')).toEqual({
      value: { visibleStart: 10, visibleEnd: 50, totalLines: 800, file: 'file:///x.ts' },
    });
    disposable.dispose();
  });

  it('throttles visible-range changes to one report per window', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);
    const { mgr, fire } = makeConnMgr(client);
    wireEditorProvider(mgr as never);

    fire('editor-wants-position', { wanted: true }); // initial emit at t=1000
    nowSpy.mockReturnValue(1050);
    vscode.__control.fireVisible(); // within throttle -> dropped
    nowSpy.mockReturnValue(1200);
    vscode.__control.fireVisible(); // past throttle -> emitted

    expect(requestsTo('/api/editor/position')).toHaveLength(2);
  });

  it('does not emit position when the window is not focused', () => {
    vscode.window.state.focused = false;
    const { mgr, fire } = makeConnMgr(client);
    wireEditorProvider(mgr as never);

    fire('editor-wants-position', { wanted: true });
    expect(requestsTo('/api/editor/position')).toHaveLength(0);
  });

  it('executes editorScroll for a scroll command (fire-and-forget, no result posted)', async () => {
    const { mgr, fire } = makeConnMgr(client);
    wireEditorProvider(mgr as never);

    fire('editor-scroll', { action: 'scrollEditor', to: 'down', by: 'line', value: 3 });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('editorScroll', {
      to: 'down',
      by: 'line',
      value: 3,
      revealCursor: false,
    });
  });

  it('recenters on caret without invoking editorScroll', async () => {
    const editor = makeEditor();
    vscode.window.activeTextEditor = editor;
    const { mgr, fire } = makeConnMgr(client);
    wireEditorProvider(mgr as never);

    fire('editor-scroll', { action: 'recenterEditorOnCaret' });
    await new Promise((r) => setTimeout(r, 0));

    expect(editor.revealRange).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('no-ops cleanly when VSCode is not focused (never pulls focus, posts nothing)', async () => {
    vscode.window.state.focused = false;
    const { mgr, fire } = makeConnMgr(client);
    wireEditorProvider(mgr as never);

    fire('editor-scroll', { action: 'scrollEditor', to: 'up', by: 'line', value: 1 });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('maps a canonical verb to its VSCode command and runs it with args', async () => {
    const { mgr, fire } = makeConnMgr(client);
    wireEditorProvider(mgr as never);

    fire('command', { verb: 'open-terminal', args: ['spir-809'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('codev.openBuilderById', 'spir-809');
  });

  it('ignores a verb that is not in the provider map (the allowlist)', async () => {
    const { mgr, fire } = makeConnMgr(client);
    wireEditorProvider(mgr as never);

    fire('command', { verb: 'kill-everything', args: [] });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
