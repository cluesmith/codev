/**
 * Webview entry for the Codev Markdown Preview (#859).
 *
 * Runs inside the `CustomTextEditor` webview (see `../preview-provider.ts`). It
 * mounts `<ArtifactCanvas>` and bridges the package's adapter contract to the
 * extension host over `postMessage`:
 *
 *  - host -> webview `{ type: 'update', content, markers }`: the rendered
 *    (marker-stripped) text + parsed markers. We store them and bump
 *    `refreshKey`, which the canvas treats as the "host without a watcher"
 *    refresh signal (re-read + re-list).
 *  - webview -> host `{ type: 'ready' }`: sent once on mount so the host pushes
 *    the first update.
 *  - webview -> host `{ type: 'addComment', line, text }`: the canvas's comment
 *    intent (0-based line) with the body the inline composer collected (#1107).
 *    The host writes the marker; the resulting document change comes back as
 *    another `update`. (Pre-#1107 the host collected the text via `showInputBox`.)
 *
 * This file is bundled by esbuild as a browser IIFE (`dist/webview/markdown-preview.js`)
 * and is intentionally excluded from the extension's `tsc` typecheck (it targets
 * the DOM, not Node) — same treatment as the backlog-search webview script (#920).
 * No JSX: `ArtifactCanvas` is created via `React.createElement`, so no JSX build
 * config is needed in the extension package.
 */

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArtifactCanvas,
  type CanvasCommandInvocation,
  type CommandAdapter,
  type FileAdapter,
  type MarkerAdapter,
  type ReadingMode,
  type ThemeAdapter,
  type ReviewMarker,
} from '@cluesmith/codev-artifact-canvas';
import '@cluesmith/codev-artifact-canvas/default-theme.css';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../messages.js';

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHostMessage): void };

const vscodeApi = acquireVsCodeApi();
// Host-opaque document id — the host already knows which document this editor is
// bound to, so the value is never interpreted, only required by the prop.
const URI = 'codev:markdown-preview';

const rootElement = document.getElementById('root') as HTMLElement;
// Persisted reading mode (spec 1380 D4): bootstrapped via the initial HTML because this
// script mounts the canvas before the first host message. The canvas coerces anything
// unrecognized to vertical, so a missing/garbage attribute is safe.
const initialReadingMode = rootElement.dataset.readingMode;

let content = '';
let markers: ReviewMarker[] = [];
let refreshKey = 0;

// The host is the source of truth and pushes updates; the canvas reads the
// latest snapshot and re-lists whenever `refreshKey` changes (no live watcher).
const fileAdapter: FileAdapter = {
  read: async () => content,
  watch: () => ({ dispose: () => {} }),
};

const markerAdapter: MarkerAdapter = {
  list: async () => markers,
  // Never called from the webview: the host performs the write-back (spec D6).
  add: async () => {},
};

const themeAdapter: ThemeAdapter = {
  resolve: (token) =>
    getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
  onChange: () => ({ dispose: () => {} }),
};

const root = createRoot(rootElement);

/**
 * Remote command seam (spec 1401). The host owns the transport — it holds the Tower connection
 * and has already decided this panel is the addressee — so the adapter here is just the last
 * hop: hold the canvas's subscriber and hand it whatever arrives.
 *
 * Commands can arrive before the canvas has subscribed (the host pushes as soon as Tower
 * resolves), in which case there is no subscriber to hand it to and the command is dropped
 * rather than queued: a stale navigation replayed later would move the reviewer somewhere they
 * no longer expect.
 */
let onCanvasCommand: ((invocation: CanvasCommandInvocation) => void) | null = null;

function deliverCommand(invocation: CanvasCommandInvocation): void {
  onCanvasCommand?.(invocation);
}

const commandAdapter: CommandAdapter = {
  subscribe(handler) {
    onCanvasCommand = handler;
    return {
      dispose: () => {
        onCanvasCommand = null;
      },
    };
  },
};

function render(): void {
  root.render(
    React.createElement(ArtifactCanvas, {
      uri: URI,
      fileAdapter,
      markerAdapter,
      themeAdapter,
      commandAdapter,
      onAddComment: (line: number, text: string) =>
        vscodeApi.postMessage({ type: 'addComment', line, text }),
      onEditComment: (
        markerLine: number,
        expectedAuthor: string,
        expectedBodyPrefix: string,
        newBody: string,
      ) =>
        vscodeApi.postMessage({
          type: 'editComment',
          markerLine,
          expectedAuthor,
          expectedBodyPrefix,
          newBody,
        }),
      onDeleteComment: (markerLine: number, expectedAuthor: string, expectedBodyPrefix: string) =>
        vscodeApi.postMessage({ type: 'deleteComment', markerLine, expectedAuthor, expectedBodyPrefix }),
      // Reading mode (spec 1380 D4): seed from the bootstrap attribute; forward toggle intents
      // for the host to persist per-user.
      initialReadingMode,
      onReadingModeChange: (mode: ReadingMode) =>
        vscodeApi.postMessage({ type: 'readingModeChange', mode }),
      refreshKey,
    }),
  );
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as HostToWebviewMessage | null;
  if (msg?.type === 'command') {
    // Already addressed to this panel by the host, which matched Tower's resolved `viewId`, so
    // there is nothing left to filter here — just run it (spec 1401).
    if (typeof msg.command === 'string') {
      deliverCommand({ command: msg.command, count: msg.count });
    }
    return;
  }
  if (msg?.type !== 'update') { return; }
  content = msg.content ?? '';
  markers = msg.markers ?? [];
  refreshKey += 1;
  render();
});

render();
vscodeApi.postMessage({ type: 'ready' });
