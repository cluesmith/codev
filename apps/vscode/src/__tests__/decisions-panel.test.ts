/**
 * Spec 1963 scenarios 6, 8, 21 and 22 (host side): the Decisions panel.
 * - One panel per window: opening again reveals it; where it is not offered, the command says why.
 * - The webview's visibility is relayed, so its poll (owned by `useDecisions`) stops while hidden.
 * - Each request message is answered once, by the bridge, with its `requestId`; a malformed one is
 *   ignored. Only http(s) links open.
 * - A reply that lands after the panel closed is dropped: no post, no error, no new panel.
 * - A reload restores the panel through its serializer.
 * - No message the host posts carries the Tower key, Tower's URL or its port.
 * - The bundle is inline in the document, read once from `dist/webview`; the webview may load
 *   nothing from the extension. A bundle that cannot be read fails the open, naming the file.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionsDocument } from '@cluesmith/codev-types';

type Listener<T> = (event: T) => void;

class FakeEmitter<T> {
  private listeners: Array<Listener<T>> = [];
  readonly event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(event: T) { for (const l of [...this.listeners]) { l(event); } }
  get count() { return this.listeners.length; }
}

class FakePanel {
  visible = true;
  disposed = false;
  readonly posted: unknown[] = [];
  readonly received = new FakeEmitter<unknown>();
  readonly viewState = new FakeEmitter<void>();
  readonly disposal = new FakeEmitter<void>();
  readonly reveal = vi.fn();
  readonly webview = {
    html: '',
    options: {} as unknown,
    cspSource: 'https://webview.vscode-cdn.net',
    asWebviewUri: (uri: { path: string }) => ({ toString: () => `https://webview.vscode-cdn.net${uri.path}` }),
    postMessage: vi.fn(async (message: unknown) => {
      if (this.disposed) { throw new Error('Webview is disposed'); }
      this.posted.push(message);
      return true;
    }),
    onDidReceiveMessage: this.received.event,
  };
  readonly onDidChangeViewState = this.viewState.event;
  readonly onDidDispose = this.disposal.event;
  dispose() {
    if (this.disposed) { return; }
    this.disposed = true;
    this.disposal.fire();
  }
  /** The webview posts `message` to the host; resolves once the host has handled it. */
  async send(message: unknown) {
    this.received.fire(message);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    this.viewState.fire();
  }
}

const panels: FakePanel[] = [];
const createWebviewPanel = vi.fn((_viewType: string, _title: string, _column: number, _options: unknown) => {
  const panel = new FakePanel();
  panels.push(panel);
  return panel;
});
const showInformationMessage = vi.fn();
const openExternal = vi.fn(async (_uri: unknown) => true);
class TabInputWebview { constructor(readonly viewType: string) {} }
/** The editor area's tabs, by group; empty unless a test puts a restored tab there. */
const tabGroups = {
  all: [] as Array<{ viewColumn: number; tabs: unknown[] }>,
  close: vi.fn(async (_tab: unknown) => true),
};

vi.mock('vscode', () => ({
  EventEmitter: class extends FakeEmitter<void> { dispose() {} },
  window: { createWebviewPanel, showInformationMessage, tabGroups },
  env: { openExternal },
  ViewColumn: { Active: -1 },
  TabInputWebview,
  Uri: {
    parse: (value: string) => ({ toString: () => value }),
    joinPath: (base: { path: string }, ...parts: string[]) => {
      const path = [base.path, ...parts].join('/');
      return { path, fsPath: path };
    },
  },
}));

const { DecisionsPanels } = await import('../workspace-views/decisions-panel.js');
const { DecisionsBridge } = await import('../workspace-views/decisions-bridge.js');
const { TowerClient } = await import('@cluesmith/codev-sdk/tower-client');

/** An extension directory holding the Decisions bundle's two files. */
const EXTENSION_DIR = mkdtempSync(join(tmpdir(), 'codev-decisions-panel-'));
const BUNDLE_SCRIPT = '/* the decisions bundle */ window.decisionsMounted = true;';
const BUNDLE_STYLE = '.decisions-card { outline: none; }';
mkdirSync(join(EXTENSION_DIR, 'dist', 'webview'), { recursive: true });
writeFileSync(join(EXTENSION_DIR, 'dist', 'webview', 'decisions.js'), BUNDLE_SCRIPT);
writeFileSync(join(EXTENSION_DIR, 'dist', 'webview', 'decisions.css'), BUNDLE_STYLE);
afterAll(() => rmSync(EXTENSION_DIR, { recursive: true, force: true }));
const EXTENSION = { path: EXTENSION_DIR };
const DOC: DecisionsDocument = { path: 'codev/decisions.md', version: 'v1', items: [], ruledMarkdown: '', problems: [] };

function fakeBridge() {
  return {
    read: vi.fn(async () => ({ kind: 'document' as const, document: DOC })),
    rule: vi.fn(async () => ({ kind: 'document' as const, document: DOC })),
    image: vi.fn(async () => ({ kind: 'image' as const, bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' })),
  };
}

function setup(opts: { reason?: string | null; bridge?: ReturnType<typeof fakeBridge>; extensionDir?: string } = {}) {
  const bridge = opts.bridge ?? fakeBridge();
  const log = vi.fn();
  const reason = { value: opts.reason ?? null };
  const extensionUri = opts.extensionDir ? { path: opts.extensionDir } : EXTENSION;
  const manager = new DecisionsPanels({ extensionUri: extensionUri as never, bridge, unavailableReason: () => reason.value, log });
  return { manager, bridge, log, reason };
}

beforeEach(() => {
  panels.length = 0;
  tabGroups.all = [];
  tabGroups.close.mockClear();
  createWebviewPanel.mockClear();
  showInformationMessage.mockClear();
  openExternal.mockClear();
});

describe('opening the panel', () => {
  it('creates one retained, script-enabled panel in the active group, its bundle inline and nothing loadable from the extension', () => {
    const { manager } = setup();
    manager.show();
    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(createWebviewPanel).toHaveBeenCalledWith('codev.decisions', 'Decisions', -1, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [],
    });
    const { html } = panels[0].webview;
    expect(html).toMatch(/<script nonce="[^"]+">/);
    expect(html).toContain(`">${BUNDLE_SCRIPT}</script>`);
    expect(html).toMatch(/<style nonce="[^"]+">\.decisions-card \{ outline: none; \}<\/style>/);
    expect(html).not.toMatch(/\bsrc=|\bhref=|webview\.vscode-cdn\.net/);
    expect(html).toContain("default-src 'none'");
    expect(manager.panel).toBe(panels[0]);
  });

  it('reads the bundle once: a later panel in the window reuses it', () => {
    const { manager } = setup();
    manager.show();
    panels[0].dispose();
    writeFileSync(join(EXTENSION_DIR, 'dist', 'webview', 'decisions.js'), 'window.changed = true;');
    try {
      manager.show();
      expect(panels).toHaveLength(2);
      expect(panels[1].webview.html).toContain(BUNDLE_SCRIPT);
    } finally {
      writeFileSync(join(EXTENSION_DIR, 'dist', 'webview', 'decisions.js'), BUNDLE_SCRIPT);
    }
  });

  it('a bundle that cannot be read fails the open loudly, naming the file, and leaves no panel', () => {
    const empty = mkdtempSync(join(tmpdir(), 'codev-decisions-nobundle-'));
    try {
      const { manager, log } = setup({ extensionDir: empty });
      expect(() => manager.show()).toThrow(`the Decisions panel cannot open: its bundle ${empty}/dist/webview/decisions.js could not be read`);
      expect(createWebviewPanel).not.toHaveBeenCalled();
      expect(manager.panel).toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`${empty}/dist/webview/decisions.js`));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reveals the open panel instead of creating a second one, and never reloads it', () => {
    const { manager } = setup();
    manager.show();
    const html = panels[0].webview.html;
    manager.show();
    manager.show();
    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panels[0].reveal).toHaveBeenCalledTimes(2);
    expect(panels[0].reveal).toHaveBeenCalledWith();
    expect(panels[0].webview.html).toBe(html);
  });

  it('opens a new panel once the open one is closed', () => {
    const { manager } = setup();
    manager.show();
    panels[0].dispose();
    expect(manager.panel).toBeUndefined();
    manager.show();
    expect(createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(manager.panel).toBe(panels[1]);
  });

  it('says why, and opens nothing, where Decisions is not offered', () => {
    const { manager } = setup({ reason: 'Codev: Decisions is not offered in a builder-worktree window.' });
    manager.show();
    expect(createWebviewPanel).not.toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenCalledWith('Codev: Decisions is not offered in a builder-worktree window.');
  });
});

describe('visibility: the poll runs only while the panel is on screen', () => {
  it('answers ready with the visibility, and relays every change', async () => {
    const { manager } = setup();
    manager.show();
    const panel = panels[0];
    await panel.send({ type: 'ready' });
    panel.setVisible(false);
    panel.setVisible(true);
    expect(panel.posted).toEqual([
      { type: 'visibility', visible: true },
      { type: 'visibility', visible: false },
      { type: 'visibility', visible: true },
    ]);
  });

  it('runs no timer of its own: nothing is read unless the webview asks', async () => {
    vi.useFakeTimers();
    try {
      const { manager, bridge } = setup();
      manager.show();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bridge.read).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('requests from the webview', () => {
  it('answers a read, a ruling and an image once each, echoing the request id', async () => {
    const { manager, bridge } = setup();
    manager.show();
    const panel = panels[0];
    await panel.send({ type: 'decisions/read', requestId: 4 });
    await panel.send({ type: 'decisions/rule', requestId: 5, request: { id: 'D-1', fingerprint: 'f', word: 'ship', extra: 'dropped' } });
    await panel.send({ type: 'decisions/image', requestId: 6, path: 'shots/a.png' });
    expect(bridge.read).toHaveBeenCalledTimes(1);
    expect(bridge.rule).toHaveBeenCalledWith({ id: 'D-1', fingerprint: 'f', word: 'ship' });
    expect(bridge.image).toHaveBeenCalledWith('shots/a.png');
    expect(panel.posted).toEqual([
      { type: 'decisions/read-result', requestId: 4, result: { kind: 'document', document: DOC } },
      { type: 'decisions/rule-result', requestId: 5, result: { kind: 'document', document: DOC } },
      { type: 'decisions/image-result', requestId: 6, result: { kind: 'image', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' } },
    ]);
  });

  it('ignores a malformed message, saying so in the log', async () => {
    const { manager, bridge, log } = setup();
    manager.show();
    for (const bad of [null, 'read', { type: 'decisions/read' }, { type: 'decisions/rule', requestId: 1, request: { id: '' } },
      { type: 'decisions/image', requestId: 1, path: '' }, { type: 'decisions/delete', requestId: 1 }]) {
      await panels[0].send(bad);
    }
    expect(bridge.read).not.toHaveBeenCalled();
    expect(bridge.rule).not.toHaveBeenCalled();
    expect(bridge.image).not.toHaveBeenCalled();
    expect(panels[0].posted).toEqual([]);
    expect(log).toHaveBeenCalledTimes(6);
  });

  it('opens http(s) links in the browser and refuses every other scheme', async () => {
    const { manager, log } = setup();
    manager.show();
    await panels[0].send({ type: 'open-external', url: 'https://github.com/cluesmith/codev/pull/1971' });
    await panels[0].send({ type: 'open-external', url: 'http://localhost:3000/' });
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://cluesmith.codev-vscode/x', 'command:workbench.action.reloadWindow']) {
      await panels[0].send({ type: 'open-external', url });
    }
    expect(openExternal.mock.calls.map(([uri]) => String(uri))).toEqual([
      'https://github.com/cluesmith/codev/pull/1971', 'http://localhost:3000/',
    ]);
    expect(log).toHaveBeenCalledTimes(4);
  });

  it('drops a reply that lands after the panel closed: no post, no error, no new panel', async () => {
    let release!: (value: { kind: 'document'; document: DecisionsDocument }) => void;
    const bridge = fakeBridge();
    bridge.read.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { manager } = setup({ bridge });
    manager.show();
    const panel = panels[0];
    await panel.send({ type: 'decisions/read', requestId: 1 });
    panel.dispose();
    release({ kind: 'document', document: DOC });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(showInformationMessage).not.toHaveBeenCalled();
    // Its listeners are gone with it.
    expect(panel.received.count).toBe(0);
    expect(panel.viewState.count).toBe(0);
  });
});

describe('restore after a window reload', () => {
  it('adopts the restored panel: it renders the view and answers its webview', async () => {
    const { manager, bridge } = setup();
    const restored = new FakePanel();
    await manager.deserializeWebviewPanel(restored as never);
    expect(restored.webview.options).toEqual({ enableScripts: true, localResourceRoots: [] });
    expect(restored.webview.html).toContain(BUNDLE_SCRIPT);
    await restored.send({ type: 'decisions/read', requestId: 0 });
    expect(bridge.read).toHaveBeenCalledTimes(1);
    manager.show();
    expect(createWebviewPanel).not.toHaveBeenCalled();
    expect(restored.reveal).toHaveBeenCalledTimes(1);
  });

  it('closes a second restored panel, and one restored where Decisions is not offered', async () => {
    const { manager, reason } = setup();
    const first = new FakePanel();
    const second = new FakePanel();
    await manager.deserializeWebviewPanel(first as never);
    await manager.deserializeWebviewPanel(second as never);
    expect(first.disposed).toBe(false);
    expect(second.disposed).toBe(true);

    first.dispose();
    reason.value = 'Codev: Decisions needs a Codev workspace, and this window has none.';
    const third = new FakePanel();
    await manager.deserializeWebviewPanel(third as never);
    expect(third.disposed).toBe(true);
  });

  it('closes a restored panel whose bundle cannot be read, and fails naming the file', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'codev-decisions-nobundle-'));
    try {
      const { manager } = setup({ extensionDir: empty });
      const restored = new FakePanel();
      await expect(manager.deserializeWebviewPanel(restored as never)).rejects.toThrow(`${empty}/dist/webview/decisions.js could not be read`);
      expect(restored.disposed).toBe(true);
      expect(restored.webview.html).toBe('');
      expect(manager.panel).toBeUndefined();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('the Tower key, URL and port never reach the webview (scenario 22, state)', () => {
  const KEY = 'tower-key-1963-do-not-leak';
  const PORT = 18764;

  it('across a read, a refusal, a ruling, an image and the document itself', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const answers = [
      { status: 200, json: { ok: true, document: DOC } },
      { status: 409, json: { ok: false, code: 'item-changed', message: 'D-1 changed; nothing was written.' } },
      { status: 200, bytes: new Uint8Array([0x89, 0x50]), type: 'image/png' },
      { status: 404, json: { ok: false, code: 'not-found', message: 'There is no image at b.png.' } },
    ];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string> });
      const answer = answers.shift()!;
      const text = 'json' in answer ? JSON.stringify(answer.json) : '';
      const bytes = 'bytes' in answer ? answer.bytes! : new TextEncoder().encode(text);
      return {
        ok: answer.status < 300,
        status: answer.status,
        headers: new Headers('type' in answer ? { 'Content-Type': answer.type! } : { 'Content-Type': 'application/json' }),
        text: async () => text,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as unknown as Response;
    });
    const client = new TowerClient({ port: PORT, getAuthKey: () => KEY, fetchFn: fetchFn as never });
    const bridge = new DecisionsBridge({ getState: () => 'connected', getClient: () => client, getWorkspacePath: () => '/work/codev' });
    const manager = new DecisionsPanels({ extensionUri: EXTENSION as never, bridge, unavailableReason: () => null, log: vi.fn() });
    manager.show();
    const panel = panels[0];

    await panel.send({ type: 'ready' });
    await panel.send({ type: 'decisions/read', requestId: 0 });
    await panel.send({ type: 'decisions/rule', requestId: 1, request: { id: 'D-1', fingerprint: 'f', word: 'ship' } });
    await panel.send({ type: 'decisions/image', requestId: 2, path: 'a.png' });
    await panel.send({ type: 'decisions/image', requestId: 3, path: 'b.png' });

    // The host did make keyed requests to Tower's port...
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.url.startsWith(`http://localhost:${PORT}/workspace/`)).toBe(true);
      expect(request.headers['codev-tower-key']).toBe(KEY);
    }
    // ...and none of it reached the webview, in any message or in the document.
    expect(panel.posted.map(m => (m as { type: string }).type)).toEqual([
      'visibility', 'decisions/read-result', 'decisions/rule-result', 'decisions/image-result', 'decisions/image-result',
    ]);
    const everything = JSON.stringify(panel.posted, (_k, v) => (v instanceof Uint8Array ? [...v] : v)) + panel.webview.html;
    for (const secret of [KEY, 'codev-tower-key', `localhost:${PORT}`, String(PORT), '/workspace/']) {
      expect(everything, secret).not.toContain(secret);
    }
  });
});
