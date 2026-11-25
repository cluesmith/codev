// @vitest-environment jsdom
/**
 * Spec 1963: the webview side of the Decisions panel's messaging. Each request is one message with
 * a fresh `requestId`, resolved by the reply carrying it; nothing ever rejects or hangs on a reply
 * of the wrong shape; an image the view stops waiting for resolves at once and its late reply is
 * ignored.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DecisionsDocument } from '@cluesmith/codev-types';
import type { DecisionsWebviewMessage } from '../../messages.js';
import { visibilityOf, WebviewDecisionsHost } from '../decisions-host.js';

const DOC: DecisionsDocument = { path: 'codev/decisions.md', version: 'v1', items: [], ruledMarkdown: '', problems: [] };

/** jsdom's Blob has no `arrayBuffer()`; FileReader reads it. */
function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function setup() {
  const posted: DecisionsWebviewMessage[] = [];
  const shown = vi.fn();
  const host = new WebviewDecisionsHost(message => posted.push(message), shown);
  return { host, posted, shown };
}

describe('requests and replies', () => {
  it('numbers each request and resolves it with the reply that carries its id, in any order', async () => {
    const { host, posted } = setup();
    const first = host.read();
    const second = host.rule({ id: 'D-1', fingerprint: 'f', word: 'ship' });
    expect(posted).toEqual([
      { type: 'decisions/read', requestId: 0 },
      { type: 'decisions/rule', requestId: 1, request: { id: 'D-1', fingerprint: 'f', word: 'ship' } },
    ]);
    host.receive({ type: 'decisions/rule-result', requestId: 1, result: { kind: 'refused', code: 'item-changed', message: 'changed' } });
    host.receive({ type: 'decisions/read-result', requestId: 0, result: { kind: 'document', document: DOC } });
    expect(await first).toEqual({ kind: 'document', document: DOC });
    expect(await second).toEqual({ kind: 'refused', code: 'item-changed', message: 'changed' });
  });

  it('ignores a duplicate reply, a reply for no request, and anything that is not a reply', async () => {
    const { host } = setup();
    const read = host.read();
    for (const noise of [null, 'x', { type: 'decisions/read-result' }, { type: 'decisions/read-result', requestId: 9, result: { kind: 'document', document: DOC } },
      { type: 'decisions/read-result', requestId: 0, result: 'document' }, { type: 'visibility', visible: true }]) {
      expect(() => host.receive(noise)).not.toThrow();
    }
    host.receive({ type: 'decisions/read-result', requestId: 0, result: { kind: 'error', message: 'first' } });
    host.receive({ type: 'decisions/read-result', requestId: 0, result: { kind: 'error', message: 'second' } });
    expect(await read).toEqual({ kind: 'error', message: 'first' });
  });

  it('resolves a reply of the wrong type as an error, never leaving the request waiting', async () => {
    const { host } = setup();
    const read = host.read();
    const image = host.image('a.png', new AbortController().signal);
    host.receive({ type: 'decisions/rule-result', requestId: 0, result: { kind: 'document', document: DOC } });
    host.receive({ type: 'decisions/read-result', requestId: 1, result: { kind: 'document', document: DOC } });
    expect(await read).toEqual({ kind: 'error', message: 'The extension answered this request with decisions/rule-result.' });
    expect(await image).toEqual({ kind: 'not-loaded', message: 'The extension answered this request with decisions/read-result.' });
  });
});

describe('images', () => {
  it('turns the bytes into a Blob of their type', async () => {
    const { host, posted } = setup();
    const image = host.image('shots/a.png', new AbortController().signal);
    expect(posted).toEqual([{ type: 'decisions/image', requestId: 0, path: 'shots/a.png' }]);
    host.receive({ type: 'decisions/image-result', requestId: 0, result: { kind: 'image', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/svg+xml' } });
    const result = await image;
    expect(result.kind).toBe('image');
    const blob = (result as { blob: Blob }).blob;
    expect(blob.type).toBe('image/svg+xml');
    expect(new Uint8Array(await bytesOf(blob))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('passes on why an image was not loaded', async () => {
    const { host } = setup();
    const image = host.image('../x.png', new AbortController().signal);
    host.receive({ type: 'decisions/image-result', requestId: 0, result: { kind: 'not-loaded', message: 'outside the workspace' } });
    expect(await image).toEqual({ kind: 'not-loaded', message: 'outside the workspace' });
  });

  it('stops waiting when the view aborts, and ignores the late reply', async () => {
    const { host } = setup();
    const controller = new AbortController();
    const image = host.image('a.png', controller.signal);
    controller.abort();
    expect(await image).toEqual({ kind: 'not-loaded', message: 'The image is no longer shown.' });
    expect(() => host.receive({ type: 'decisions/image-result', requestId: 0, result: { kind: 'image', bytes: new Uint8Array([1]), contentType: 'image/png' } })).not.toThrow();
  });

  it('posts nothing for an image already aborted', async () => {
    const { host, posted } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await host.image('a.png', controller.signal)).toEqual({ kind: 'not-loaded', message: 'The image is no longer shown.' });
    expect(posted).toEqual([]);
  });
});

describe('the host actions the view calls', () => {
  it('asks the extension host to open a link, and shows an image in the panel itself', () => {
    const { host, posted, shown } = setup();
    host.openExternal('https://github.com/cluesmith/codev');
    host.showImage({ src: 'blob:x', alt: 'shot' });
    expect(posted).toEqual([{ type: 'open-external', url: 'https://github.com/cluesmith/codev' }]);
    expect(shown).toHaveBeenCalledWith({ src: 'blob:x', alt: 'shot' });
  });

  it('reads a visibility message, and nothing else, as visibility', () => {
    expect(visibilityOf({ type: 'visibility', visible: true })).toBe(true);
    expect(visibilityOf({ type: 'visibility', visible: false })).toBe(false);
    for (const other of [null, { type: 'visibility' }, { type: 'visibility', visible: 'true' }, { type: 'decisions/read-result', visible: true }]) {
      expect(visibilityOf(other)).toBeNull();
    }
  });
});
