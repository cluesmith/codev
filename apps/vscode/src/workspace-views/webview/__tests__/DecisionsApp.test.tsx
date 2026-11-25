// @vitest-environment jsdom
/**
 * Spec 1963 scenarios 15, 16 and 21 (webview side): the Decisions panel's UI, run through its real
 * postMessage host with a fake extension host answering each request as the bridge would.
 * - Nothing is read until the extension host says the panel is on screen; the poll runs while it
 *   is and stops while it is hidden, though the page itself still reports `visible`.
 * - Submit sends one `decisions/rule` message with the card's id, fingerprint, word and comment;
 *   a refusal shows its message on the card and keeps the draft.
 * - A workspace image arrives as bytes and is shown through an object URL; clicking it opens the
 *   panel's own full-size view, which Close, Escape or a click beside the image closes.
 * - An http(s) link is handed to the extension host to open.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DecisionItem, DecisionsDocument } from '@cluesmith/codev-types';
import type { DecisionsHostMessage, DecisionsWebviewMessage } from '../../messages.js';
import { DecisionsApp, PanelStore } from '../DecisionsApp.js';
import { WebviewDecisionsHost } from '../decisions-host.js';

type Answer = Exclude<DecisionsHostMessage, { type: 'visibility' }>['result'];

function item(id: string, question: string, overrides: Partial<DecisionItem> = {}): DecisionItem {
  return {
    id,
    stamp: null,
    question,
    bodyMarkdown: '',
    options: [
      { word: 'accept', description: 'merge as is', recommended: true },
      { word: 'rework', description: 'send back', recommended: false },
    ],
    currentRuling: '',
    qa: [],
    fingerprint: `fp-${id}`,
    problems: [],
    writable: true,
    ...overrides,
  };
}

function documentOf(version: string, ...items: DecisionItem[]): DecisionsDocument {
  return { path: 'codev/state/pending-decisions.md', version, items, ruledMarkdown: '', problems: [] };
}

const MERGE = item('main-12', 'Merge the onboarding scan fix?');

/** The extension host's side: records what the webview posts and answers each request. */
function mount(answers: {
  read?: () => Answer;
  rule?: () => Answer;
  image?: (path: string) => Answer;
} = {}) {
  const posted: DecisionsWebviewMessage[] = [];
  const store = new PanelStore();
  let host!: WebviewDecisionsHost;
  const reply = (message: DecisionsWebviewMessage) => {
    const answer = (result: Answer, type: Exclude<DecisionsHostMessage, { type: 'visibility' }>['type']) => {
      void Promise.resolve().then(() => act(() => host.receive({ type, requestId: (message as { requestId: number }).requestId, result })));
    };
    if (message.type === 'decisions/read' && answers.read) { answer(answers.read(), 'decisions/read-result'); }
    if (message.type === 'decisions/rule' && answers.rule) { answer(answers.rule(), 'decisions/rule-result'); }
    if (message.type === 'decisions/image' && answers.image) { answer(answers.image(message.path), 'decisions/image-result'); }
  };
  host = new WebviewDecisionsHost(message => { posted.push(message); reply(message); }, image => store.showImage(image));
  render(<DecisionsApp host={host} store={store} />);
  const show = () => act(() => store.setVisible(true));
  const hide = () => act(() => store.setVisible(false));
  const reads = () => posted.filter(m => m.type === 'decisions/read').length;
  return { posted, store, host, show, hide, reads };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('reading and polling', () => {
  it('reads nothing until the extension host says the panel is on screen, then shows the items', async () => {
    const app = mount({ read: () => ({ kind: 'document', document: documentOf('v1', MERGE) }) });
    expect(app.posted).toEqual([]);
    app.show();
    expect(app.posted).toEqual([{ type: 'decisions/read', requestId: 0 }]);
    expect(await screen.findByRole('article', { name: MERGE.question })).toBeTruthy();
  });

  it('polls while on screen and stops while hidden, though the page itself still reports visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const app = mount({ read: () => ({ kind: 'document', document: documentOf('v1', MERGE) }) });
    expect(document.visibilityState).toBe('visible');
    app.show();
    await screen.findByRole('article', { name: MERGE.question });
    expect(app.reads()).toBe(1);

    await act(async () => { vi.advanceTimersByTime(2000); });
    await waitFor(() => expect(app.reads()).toBe(2));

    app.hide();
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(app.reads()).toBe(2);

    app.show();
    await waitFor(() => expect(app.reads()).toBe(3));
  });

  it("shows the extension host's message for no decisions file", async () => {
    const message = 'There is no decisions file at codev/state/pending-decisions.md. To start one, run afx decisions init in this workspace.';
    const app = mount({ read: () => ({ kind: 'not-found', message }) });
    app.show();
    expect((await screen.findByRole('status')).textContent).toBe(message);
  });
});

describe('ruling', () => {
  const choose = (word: string) => {
    const radio = within(screen.getByRole('article', { name: MERGE.question }))
      .getAllByRole<HTMLInputElement>('radio').find(r => r.value === word)!;
    fireEvent.click(radio);
  };
  const comment = (text: string) => fireEvent.change(
    within(screen.getByRole('article', { name: MERGE.question })).getByRole('textbox', { name: 'Comment or question' }),
    { target: { value: text } },
  );
  const submit = () => fireEvent.click(within(screen.getByRole('article', { name: MERGE.question })).getByRole('button', { name: /^Submit/ }));

  it("posts one ruling with the card's id, fingerprint, word and comment, and shows the document it returns", async () => {
    const ruled = item('main-12', MERGE.question, { currentRuling: 'accept — ship it', writable: true });
    const app = mount({
      read: () => ({ kind: 'document', document: documentOf('v1', MERGE) }),
      rule: () => ({ kind: 'document', document: documentOf('v2', ruled) }),
    });
    app.show();
    await screen.findByRole('article', { name: MERGE.question });
    choose('accept');
    comment('  ship it  ');
    submit();
    const rulings = app.posted.filter(m => m.type === 'decisions/rule');
    expect(rulings).toEqual([{
      type: 'decisions/rule', requestId: 1, request: { id: 'main-12', fingerprint: 'fp-main-12', word: 'accept', comment: 'ship it' },
    }]);
    await waitFor(() => expect(screen.getByRole('article', { name: MERGE.question }).textContent).toContain('accept — ship it'));
  });

  it('shows a refusal on the card and keeps the draft', async () => {
    const message = 'main-12 has changed since you read it, so nothing was written. Review it and rule again.';
    const app = mount({
      read: () => ({ kind: 'document', document: documentOf('v1', MERGE) }),
      rule: () => ({ kind: 'refused', code: 'item-changed', message }),
    });
    app.show();
    await screen.findByRole('article', { name: MERGE.question });
    choose('rework');
    comment('needs tests');
    submit();
    const card = screen.getByRole('article', { name: MERGE.question });
    expect((await within(card).findByRole('alert')).textContent).toBe(message);
    expect(within(card).getByRole<HTMLTextAreaElement>('textbox', { name: 'Comment or question' }).value).toBe('needs tests');
    expect(within(card).getAllByRole<HTMLInputElement>('radio').find(r => r.checked)?.value).toBe('rework');
  });
});

describe('images and links', () => {
  let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
  let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    let next = 0;
    createObjectURL = vi.fn(() => `blob:vscode-webview://panel/${++next}`);
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
  });

  const withImage = item('ui-4', 'Ship the compact layout?', { bodyMarkdown: '![Compact layout](decision-assets/compact.png)' });

  it('asks the extension host for a workspace image and shows its bytes through an object URL', async () => {
    const app = mount({
      read: () => ({ kind: 'document', document: documentOf('v1', withImage) }),
      image: () => ({ kind: 'image', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' }),
    });
    app.show();
    const image = await screen.findByRole<HTMLImageElement>('img', { name: 'Compact layout' });
    await waitFor(() => expect(image.getAttribute('src')).toBe('blob:vscode-webview://panel/1'));
    expect(app.posted.filter(m => m.type === 'decisions/image')).toEqual([{ type: 'decisions/image', requestId: 1, path: 'decision-assets/compact.png' }]);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(4);
  });

  it("shows why an image was not loaded, in the image's place", async () => {
    const message = 'The image ../../x.png is outside the workspace, so it was not read.';
    const app = mount({
      read: () => ({ kind: 'document', document: documentOf('v1', item('ui-5', 'Q?', { bodyMarkdown: '![x](../../x.png)' })) }),
      image: () => ({ kind: 'not-loaded', message }),
    });
    app.show();
    const note = await waitFor(() => {
      const found = screen.getByRole('article', { name: 'Q?' }).querySelector<HTMLElement>('.decisions-image-missing');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(note.textContent).toContain('Image not loaded');
    expect(note.textContent).toContain('../../x.png');
    expect(note.title).toBe(message);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('opens a loaded image full size over the view; Close, Escape and a click beside it each close it', async () => {
    const app = mount({
      read: () => ({ kind: 'document', document: documentOf('v1', withImage) }),
      image: () => ({ kind: 'image', bytes: new Uint8Array([1]), contentType: 'image/png' }),
    });
    app.show();
    const image = await screen.findByRole<HTMLImageElement>('img', { name: 'Compact layout' });
    await waitFor(() => expect(image.getAttribute('src')).toMatch(/^blob:/));
    const open = () => {
      fireEvent.click(image);
      return screen.getByRole('dialog', { name: 'Compact layout' });
    };

    let dialog = open();
    expect(within(dialog).getByRole<HTMLImageElement>('img').getAttribute('src')).toBe(image.getAttribute('src'));
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    dialog = open();
    fireEvent.click(within(dialog).getByRole('img'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.click(dialog.querySelector('.wv-fullsize-body')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    // The view stayed mounted under it.
    expect(screen.getByRole('article', { name: withImage.question })).toBeTruthy();
    expect(app.store.getSnapshot().fullSize).toBeNull();
  });

  it('hands an http(s) link to the extension host and navigates nowhere', async () => {
    const linked = item('ops-3', 'Raise the timeout?', { bodyMarkdown: 'See [the PR](https://github.com/cluesmith/codev/pull/1971).' });
    const app = mount({ read: () => ({ kind: 'document', document: documentOf('v1', linked) }) });
    app.show();
    const link = await screen.findByRole('link', { name: 'the PR' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(app.posted.filter(m => m.type === 'open-external')).toEqual([{ type: 'open-external', url: 'https://github.com/cluesmith/codev/pull/1971' }]);
  });
});
