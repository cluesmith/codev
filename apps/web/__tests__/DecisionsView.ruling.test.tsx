/**
 * Spec 1819 Phase 6: ruling from the Decisions tab — options, comment box and Submit on
 * writable cards; drafts keyed by item id that survive new documents; the option-removed
 * notice; held drafts (and Discard); submit success, refusals and in-flight disabling; and
 * the question round-trip.
 *
 * The polling hook is replaced by a stateful fake, so a test can push new documents (as a
 * poll would) and `applyDocument` re-renders with the document a write returned.
 */
import { useCallback, useState } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent, act } from '@testing-library/react';
import type { DecisionItem, DecisionOption, DecisionsDocument, DecisionsRuleRequest } from '@cluesmith/codev-types';
import type { DecisionsState } from '../src/hooks/useDecisions.js';
import type { DecisionRulingResult } from '../src/lib/api.js';

let initialState: DecisionsState = { status: 'loading' };
let pushState: (state: DecisionsState) => void = () => { throw new Error('DecisionsView is not rendered'); };
const applyDocument = vi.fn<(doc: DecisionsDocument) => void>();

function useFakeDecisions() {
  const [state, setState] = useState<DecisionsState>(initialState);
  pushState = setState;
  const apply = useCallback((doc: DecisionsDocument) => {
    applyDocument(doc);
    setState({ status: 'ready', document: doc });
  }, []);
  return { state, applyDocument: apply };
}

vi.mock('../src/hooks/useDecisions.js', () => ({
  useDecisions: () => useFakeDecisions(),
}));

const postDecisionRuling = vi.fn<(request: DecisionsRuleRequest) => Promise<DecisionRulingResult>>();
vi.mock('../src/lib/api.js', () => ({
  postDecisionRuling: (request: DecisionsRuleRequest) => postDecisionRuling(request),
}));

import { DecisionsView } from '../src/components/DecisionsView.js';

const OPTIONS: DecisionOption[] = [
  { word: 'accept', description: 'merge as is', recommended: true },
  { word: 'rework', description: 'send back', recommended: false },
  { word: 'hold', description: '', recommended: false },
];

function makeItem(id: string, question: string, overrides: Partial<DecisionItem> = {}): DecisionItem {
  return {
    id,
    stamp: null,
    question,
    bodyMarkdown: '',
    options: OPTIONS,
    currentRuling: '',
    qa: [],
    fingerprint: `fp-${id}`,
    problems: [],
    writable: true,
    ...overrides,
  };
}

function makeDocument(version: string, ...items: DecisionItem[]): DecisionsDocument {
  return { path: 'codev/state/pending-decisions.md', version, items, ruledMarkdown: '', problems: [] };
}

const MERGE = makeItem('main-12', 'Merge the onboarding scan fix?');
const TIMEOUT = makeItem('ops-3', 'Raise the e2e timeout?');

function show(doc: DecisionsDocument) {
  initialState = { status: 'ready', document: doc };
  return render(<DecisionsView isActive />);
}

function push(state: DecisionsState) {
  act(() => pushState(state));
}

function pushDocument(doc: DecisionsDocument) {
  push({ status: 'ready', document: doc });
}

function card(question: string): HTMLElement {
  return screen.getByRole('article', { name: question });
}

function radio(question: string, word: string): HTMLInputElement {
  const found = within(card(question)).getAllByRole<HTMLInputElement>('radio').find(r => r.value === word);
  if (!found) throw new Error(`no ${word} radio on "${question}"`);
  return found;
}

function commentBox(question: string): HTMLTextAreaElement {
  return within(card(question)).getByRole<HTMLTextAreaElement>('textbox', { name: 'Comment or question' });
}

function submitButton(question: string): HTMLButtonElement {
  return within(card(question)).getByRole<HTMLButtonElement>('button', { name: /^Submit/ });
}

function type(question: string, text: string) {
  fireEvent.change(commentBox(question), { target: { value: text } });
}

function choose(question: string, word: string) {
  fireEvent.click(radio(question, word));
}

async function submit(question: string) {
  await act(async () => { fireEvent.click(submitButton(question)); });
}

function heldCard(id: string): HTMLElement {
  return screen.getByRole('article', { name: `Held draft for ${id}` });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  postDecisionRuling.mockResolvedValue({ kind: 'error', message: 'not stubbed' });
});

afterEach(() => {
  cleanup();
  applyDocument.mockReset();
  postDecisionRuling.mockReset();
});

describe('writable cards', () => {
  it('offer one radio per option in order, the first marked recommended, a comment box and Submit', () => {
    show(makeDocument('v1', MERGE));
    const radios = within(card(MERGE.question)).getAllByRole('radio');
    expect(radios.map(r => (r as HTMLInputElement).value)).toEqual(['accept', 'rework', 'hold']);
    // jsdom's name computation puts a space after the <code>; a browser doesn't (the e2e suite checks the exact name).
    expect(radios[0]).toHaveAccessibleName(/^accept ?: merge as is Recommended$/);
    expect(radios[1]).toHaveAccessibleName(/^rework ?: send back$/);
    expect(radios[2]).toHaveAccessibleName('hold');
    expect(radios.every(r => !(r as HTMLInputElement).checked)).toBe(true);
    expect(within(card(MERGE.question)).getByRole('group', { name: 'Your word' })).toBeInTheDocument();
    expect(commentBox(MERGE.question)).toHaveValue('');
    expect(commentBox(MERGE.question).placeholder).toMatch(/question/);
    expect(submitButton(MERGE.question)).toBeDisabled();
  });

  it('read each option inline as "word: what it does" when the words on the Your-word line are bare', () => {
    // The parser fills these descriptions from the body's **Options:** entries; the body is untouched.
    const bare = makeItem('ops-4', 'Raise the limit?', {
      bodyMarkdown: '- **Options:** (a) `raised` = raise the limit now (b) `rotated` = rotate the key',
      options: [
        { word: 'raised', description: 'raise the limit now', recommended: true },
        { word: 'rotated', description: 'rotate the key', recommended: false },
        { word: 'wait', description: '', recommended: false },
      ],
    });
    show(makeDocument('v1', bare));
    const radios = within(card('Raise the limit?')).getAllByRole('radio');
    expect(radios.map(r => r.closest('label')!.textContent)).toEqual([
      ' raised: raise the limit now Recommended',
      ' rotated: rotate the key',
      ' wait',
    ]);
    expect(radios[0]).toHaveAccessibleName(/^raised ?: raise the limit now Recommended$/);
    expect(card('Raise the limit?').querySelector('.decisions-card-body')!.textContent)
      .toContain('Options: (a) raised = raise the limit now (b) rotated = rotate the key');
  });

  it('give a read-only card no controls, only the inert option list', () => {
    show(makeDocument('v1', makeItem('main-12', 'Q', { currentRuling: 'accept', writable: false })));
    expect(within(card('Q')).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(card('Q')).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(card('Q')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(card('Q')).getByRole('list', { name: 'Options' })).toBeInTheDocument();
  });

  it('offer a comment box and Submit on a writable item with no options', () => {
    show(makeDocument('v1', makeItem('main-12', 'Q', { options: [] })));
    expect(within(card('Q')).queryByRole('radio')).not.toBeInTheDocument();
    type('Q', 'go ahead');
    expect(submitButton('Q')).toBeEnabled();
  });

  it('enable Submit once a word is chosen', () => {
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'rework');
    expect(radio(MERGE.question, 'rework')).toBeChecked();
    expect(submitButton(MERGE.question)).toBeEnabled();
  });

  it('enable Submit for a non-blank comment, not a blank one', () => {
    show(makeDocument('v1', MERGE));
    type(MERGE.question, '  \n ');
    expect(submitButton(MERGE.question)).toBeDisabled();
    type(MERGE.question, 'why a new tool?');
    expect(submitButton(MERGE.question)).toBeEnabled();
  });

  it('let the owner clear a chosen word', () => {
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'accept');
    fireEvent.click(within(card(MERGE.question)).getByRole('button', { name: 'Clear choice' }));
    expect(within(card(MERGE.question)).getAllByRole('radio').some(r => (r as HTMLInputElement).checked)).toBe(false);
    expect(submitButton(MERGE.question)).toBeDisabled();
    expect(within(card(MERGE.question)).queryByRole('button', { name: 'Clear choice' })).not.toBeInTheDocument();
  });
});

describe('drafts', () => {
  it('survive a new document that re-orders the items, each staying with its own item', () => {
    show(makeDocument('v1', MERGE, TIMEOUT));
    choose(MERGE.question, 'rework');
    type(MERGE.question, 'accept but not the limit');
    type(TIMEOUT.question, 'split it instead');

    pushDocument(makeDocument('v2',
      { ...TIMEOUT, bodyMarkdown: '- **Context:** new detail.', fingerprint: 'fp-ops-3-v2' },
      MERGE,
    ));

    expect(screen.getAllByRole('article').map(a => within(a).getByRole('heading').textContent)).toEqual([
      TIMEOUT.question,
      MERGE.question,
    ]);
    expect(radio(MERGE.question, 'rework')).toBeChecked();
    expect(commentBox(MERGE.question)).toHaveValue('accept but not the limit');
    expect(commentBox(TIMEOUT.question)).toHaveValue('split it instead');
    expect(within(card(TIMEOUT.question)).queryAllByRole('radio').some(r => (r as HTMLInputElement).checked)).toBe(false);
  });

  it('survive the tab going inactive and coming back', () => {
    const { rerender } = show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'hold');
    type(MERGE.question, 'later');
    rerender(<DecisionsView isActive={false} />);
    rerender(<DecisionsView isActive />);
    expect(radio(MERGE.question, 'hold')).toBeChecked();
    expect(commentBox(MERGE.question)).toHaveValue('later');
  });

  it('survive a transient error that keeps the last document', () => {
    const doc = makeDocument('v1', MERGE);
    show(doc);
    type(MERGE.question, 'still here');
    push({ status: 'error', message: 'Could not reach Tower: Failed to fetch', lastDocument: doc });
    expect(commentBox(MERGE.question)).toHaveValue('still here');
    expect(screen.queryByRole('region', { name: 'Held drafts' })).not.toBeInTheDocument();
  });

  it('drop a chosen word the item no longer offers, say so, and keep the comment', () => {
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'rework');
    type(MERGE.question, 'my comment');

    pushDocument(makeDocument('v2', { ...MERGE, options: [OPTIONS[0], OPTIONS[2]], fingerprint: 'fp-v2' }));

    expect(within(card(MERGE.question)).getAllByRole('radio').some(r => (r as HTMLInputElement).checked)).toBe(false);
    expect(within(card(MERGE.question)).getByRole('status')).toHaveTextContent(
      'The option rework you chose is no longer offered, so your choice was cleared. Your comment is kept.',
    );
    expect(commentBox(MERGE.question)).toHaveValue('my comment');

    choose(MERGE.question, 'hold');
    expect(within(card(MERGE.question)).queryByRole('status')).not.toBeInTheDocument();
  });

  it('name a dropped word without mentioning a comment when there is none', () => {
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'rework');
    pushDocument(makeDocument('v2', { ...MERGE, options: [OPTIONS[0]] }));
    expect(within(card(MERGE.question)).getByRole('status')).toHaveTextContent(
      /^The option rework you chose is no longer offered, so your choice was cleared\.$/,
    );
    expect(submitButton(MERGE.question)).toBeDisabled();
  });
});

describe('held drafts', () => {
  it.each([
    [
      'leaves ## Open',
      makeDocument('v2', TIMEOUT),
      'main-12 is no longer under ## Open (main may have moved it to ## Ruled), so this draft was not sent.',
    ],
    [
      'becomes a duplicate',
      makeDocument('v2',
        { ...MERGE, problems: ['duplicate-id'], writable: false },
        { ...MERGE, question: 'Another main-12', problems: ['duplicate-id'], writable: false },
      ),
      'Another open item now has the id main-12, so the tab cannot write to either, and this draft was not sent.',
    ],
    [
      'is ruled from elsewhere',
      makeDocument('v2', { ...MERGE, currentRuling: 'accept', writable: false }),
      'Text has been written under main-12 since you started this draft, so the tab no longer writes to it, and this draft was not sent.',
    ],
    [
      'loses its single Your-word line',
      makeDocument('v2', { ...MERGE, problems: ['your-word-multiple'], writable: false }),
      'The tab can no longer write a ruling for main-12, so this draft was not sent.',
    ],
  ])('hold a draft whose item %s, with the reason, the text, and Discard', (_, doc, reason) => {
    show(makeDocument('v1', MERGE, TIMEOUT));
    choose(MERGE.question, 'rework');
    type(MERGE.question, '  not yet — the tests first.  ');

    pushDocument(doc);

    const held = heldCard('main-12');
    expect(within(held).getByText(MERGE.question)).toBeInTheDocument();
    expect(within(held).getByRole('note')).toHaveTextContent(reason);
    expect(held.querySelector('pre')?.textContent).toBe('rework\n\nnot yet — the tests first.');
    expect(screen.queryByDisplayValue('  not yet — the tests first.  ')).not.toBeInTheDocument();

    fireEvent.click(within(held).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('article', { name: 'Held draft for main-12' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Held drafts' })).not.toBeInTheDocument();
  });

  it('are pointed to from a card that is still shown, which scrolls to them', () => {
    const scrolled: Element[] = [];
    // jsdom does not implement scrollIntoView.
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: Element) { scrolled.push(this); },
    });
    try {
      show(makeDocument('v1', MERGE, TIMEOUT));
      type(MERGE.question, 'my draft');
      pushDocument(makeDocument('v2', { ...MERGE, currentRuling: 'rework', writable: false }, TIMEOUT));

      expect(within(card(MERGE.question)).getByText(/^An unsent draft for this item is held at the top of the tab\./))
        .toBeInTheDocument();
      expect(within(card(TIMEOUT.question)).queryByText(/An unsent draft/)).not.toBeInTheDocument();
      fireEvent.click(within(card(MERGE.question)).getByRole('button', { name: 'Show it' }));
      expect(scrolled).toEqual([heldCard('main-12')]);

      fireEvent.click(within(heldCard('main-12')).getByRole('button', { name: 'Discard' }));
      expect(within(card(MERGE.question)).queryByText(/An unsent draft/)).not.toBeInTheDocument();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('do not hold a draft that holds no text', () => {
    show(makeDocument('v1', MERGE));
    type(MERGE.question, 'x');
    type(MERGE.question, '');
    pushDocument(makeDocument('v2'));
    expect(screen.queryByRole('region', { name: 'Held drafts' })).not.toBeInTheDocument();
  });

  it('stay visible when the file is not found, and stay held when it comes back', () => {
    show(makeDocument('v1', MERGE));
    type(MERGE.question, 'why a new tool?');

    push({ status: 'not-found', message: 'There is no decisions file at codev/state/pending-decisions.md.' });

    expect(screen.getByText('There is no decisions file at codev/state/pending-decisions.md.')).toBeInTheDocument();
    const held = heldCard('main-12');
    expect(within(held).getByRole('note')).toHaveTextContent('The decisions file is gone, so this draft was not sent.');
    expect(held.querySelector('pre')?.textContent).toBe('why a new tool?');

    pushDocument(makeDocument('v2', MERGE));
    expect(heldCard('main-12')).toBeInTheDocument();
    expect(commentBox(MERGE.question)).toHaveValue('');
  });

  it('keep each hold separately when the same item is held twice', () => {
    show(makeDocument('v1', MERGE));
    type(MERGE.question, 'first');
    pushDocument(makeDocument('v2'));
    pushDocument(makeDocument('v3', MERGE));
    type(MERGE.question, 'second');
    pushDocument(makeDocument('v4'));
    expect(screen.getAllByRole('article', { name: 'Held draft for main-12' }).map(a => a.querySelector('pre')?.textContent))
      .toEqual(['first', 'second']);
  });
});

describe('submit', () => {
  it.each([
    ['a word and a comment', 'accept', '  accept but don\'t add the limit.\nThat could backfire.  ',
      { word: 'accept', comment: 'accept but don\'t add the limit.\nThat could backfire.' }],
    ['a word only', 'hold', '', { word: 'hold' }],
    ['a comment only', null, 'why a new tool?', { comment: 'why a new tool?' }],
  ] as const)('sends %s with the item id and fingerprint', async (_, word, comment, expected) => {
    show(makeDocument('v1', MERGE));
    if (word) choose(MERGE.question, word);
    if (comment) type(MERGE.question, comment);
    await submit(MERGE.question);
    expect(postDecisionRuling).toHaveBeenCalledExactlyOnceWith({ id: 'main-12', fingerprint: 'fp-main-12', ...expected });
    const sent = postDecisionRuling.mock.calls[0][0];
    expect(Object.keys(sent).filter(key => sent[key as keyof DecisionsRuleRequest] !== undefined).sort())
      .toEqual(['fingerprint', 'id', ...Object.keys(expected)].sort());
  });

  it('sends the fingerprint of the item as the card now shows it', async () => {
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'accept');
    pushDocument(makeDocument('v2', { ...MERGE, bodyMarkdown: '- **Fix:** reworded.', fingerprint: 'fp-reworded' }));
    await submit(MERGE.question);
    expect(postDecisionRuling).toHaveBeenCalledExactlyOnceWith({ id: 'main-12', fingerprint: 'fp-reworded', word: 'accept' });
  });

  it('locks the card while the submit is in flight', async () => {
    const reply = deferred<DecisionRulingResult>();
    postDecisionRuling.mockReturnValue(reply.promise);
    show(makeDocument('v1', MERGE, TIMEOUT));
    choose(MERGE.question, 'accept');
    type(MERGE.question, 'ship it');
    await submit(MERGE.question);

    expect(submitButton(MERGE.question)).toBeDisabled();
    expect(submitButton(MERGE.question)).toHaveTextContent('Submitting…');
    for (const r of within(card(MERGE.question)).getAllByRole('radio')) expect(r).toBeDisabled();
    expect(within(card(MERGE.question)).getByRole('button', { name: 'Clear choice' })).toBeDisabled();
    expect(commentBox(MERGE.question)).toHaveAttribute('readonly');
    fireEvent.click(submitButton(MERGE.question));
    expect(postDecisionRuling).toHaveBeenCalledTimes(1);

    type(TIMEOUT.question, 'other cards stay usable');
    expect(submitButton(TIMEOUT.question)).toBeEnabled();

    await act(async () => { reply.resolve({ kind: 'refused', code: 'item-changed', message: 'changed' }); });
    expect(submitButton(MERGE.question)).toHaveTextContent('Submit');
    expect(commentBox(MERGE.question)).not.toHaveAttribute('readonly');
  });

  it('renders the returned document at once and clears the draft on success', async () => {
    const ruled = makeDocument('v2', { ...MERGE, currentRuling: 'accept\n\nship it', writable: false, fingerprint: 'fp-ruled' });
    postDecisionRuling.mockResolvedValue({ kind: 'document', document: ruled });
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'accept');
    type(MERGE.question, 'ship it');

    await submit(MERGE.question);

    expect(applyDocument).toHaveBeenCalledExactlyOnceWith(ruled);
    const c = card(MERGE.question);
    expect(c.querySelector('pre.decisions-ruling-text')?.textContent).toBe('accept\n\nship it');
    expect(within(c).getByText(/main will act on it/)).toBeInTheDocument();
    expect(within(c).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Held drafts' })).not.toBeInTheDocument();

    pushDocument(makeDocument('v3', MERGE));
    expect(commentBox(MERGE.question)).toHaveValue('');
    expect(within(card(MERGE.question)).getAllByRole('radio').some(r => (r as HTMLInputElement).checked)).toBe(false);
  });

  it.each([
    ['a refusal', { kind: 'refused', code: 'item-changed', message: 'main-12 changed after you last saw it; nothing was written.' }],
    ['a refusal of the comment', { kind: 'refused', code: 'comment-heading', message: 'The comment contains a heading line.' }],
    ['a transport failure', { kind: 'error', message: 'Could not reach Tower: Failed to fetch' }],
    ['an unexpected response', { kind: 'error', message: 'Unexpected response from Tower (HTTP 401)' }],
  ] as const)('shows %s on the card and keeps the draft', async (_, result) => {
    postDecisionRuling.mockResolvedValue(result);
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'rework');
    type(MERGE.question, 'the tests first');

    await submit(MERGE.question);

    expect(within(card(MERGE.question)).getByRole('alert')).toHaveTextContent(result.message);
    expect(radio(MERGE.question, 'rework')).toBeChecked();
    expect(commentBox(MERGE.question)).toHaveValue('the tests first');
    expect(submitButton(MERGE.question)).toBeEnabled();
    expect(applyDocument).not.toHaveBeenCalled();
  });

  it('shows a thrown send on the card and unlocks it, keeping the draft', async () => {
    postDecisionRuling.mockRejectedValue(new Error('localStorage is not available'));
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'accept');
    type(MERGE.question, 'ship it');

    await submit(MERGE.question);

    expect(within(card(MERGE.question)).getByRole('alert')).toHaveTextContent(
      'The ruling could not be sent: localStorage is not available',
    );
    expect(radio(MERGE.question, 'accept')).toBeChecked();
    expect(commentBox(MERGE.question)).toHaveValue('ship it');
    expect(commentBox(MERGE.question)).not.toHaveAttribute('readonly');
    expect(submitButton(MERGE.question)).toBeEnabled();
  });

  it('clears the last refusal when the owner submits again', async () => {
    const reply = deferred<DecisionRulingResult>();
    postDecisionRuling.mockResolvedValueOnce({ kind: 'refused', code: 'item-changed', message: 'changed' });
    postDecisionRuling.mockReturnValueOnce(reply.promise);
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'accept');
    await submit(MERGE.question);
    expect(within(card(MERGE.question)).getByRole('alert')).toHaveTextContent('changed');
    await submit(MERGE.question);
    expect(within(card(MERGE.question)).queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { reply.resolve({ kind: 'error', message: 'later' }); });
  });

  it('does not hold a draft whose own write a poll shows before the reply lands', async () => {
    const reply = deferred<DecisionRulingResult>();
    postDecisionRuling.mockReturnValue(reply.promise);
    const ruled = makeDocument('v2', { ...MERGE, currentRuling: 'accept', writable: false });
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'accept');
    await submit(MERGE.question);

    pushDocument(ruled);
    expect(screen.queryByRole('region', { name: 'Held drafts' })).not.toBeInTheDocument();

    await act(async () => { reply.resolve({ kind: 'document', document: ruled }); });
    expect(screen.queryByRole('region', { name: 'Held drafts' })).not.toBeInTheDocument();
    expect(card(MERGE.question).querySelector('pre.decisions-ruling-text')?.textContent).toBe('accept');
  });

  it('holds the draft when the write is refused because the item was ruled meanwhile', async () => {
    const reply = deferred<DecisionRulingResult>();
    postDecisionRuling.mockReturnValue(reply.promise);
    show(makeDocument('v1', MERGE));
    choose(MERGE.question, 'accept');
    type(MERGE.question, 'ship it');
    await submit(MERGE.question);

    pushDocument(makeDocument('v2', { ...MERGE, currentRuling: 'rework', writable: false }));
    await act(async () => { reply.resolve({ kind: 'refused', code: 'already-ruled', message: 'main-12 already has a ruling.' }); });

    const held = heldCard('main-12');
    expect(within(held).getByRole('note')).toHaveTextContent('Text has been written under main-12 since you started this draft');
    expect(held.querySelector('pre')?.textContent).toBe('accept\n\nship it');
  });
});

describe('question round-trip', () => {
  it('goes read-only with the question, then writable again with the thread once main answers', async () => {
    const asked = makeDocument('v2', {
      ...MERGE, currentRuling: 'why a new tool? Don\'t we have existing tools?', writable: false, fingerprint: 'fp-asked',
    });
    postDecisionRuling.mockResolvedValue({ kind: 'document', document: asked });
    show(makeDocument('v1', MERGE));
    type(MERGE.question, 'why a new tool? Don\'t we have existing tools?');

    await submit(MERGE.question);

    expect(postDecisionRuling).toHaveBeenCalledExactlyOnceWith({
      id: 'main-12', fingerprint: 'fp-main-12', comment: 'why a new tool? Don\'t we have existing tools?',
    });
    let c = card(MERGE.question);
    expect(c.querySelector('pre.decisions-ruling-text')?.textContent).toBe('why a new tool? Don\'t we have existing tools?');
    expect(within(c).getByText(/You have written under this item, and main will act on it\./)).toBeInTheDocument();
    expect(within(c).queryByRole('textbox')).not.toBeInTheDocument();

    pushDocument(makeDocument('v3', {
      ...MERGE,
      fingerprint: 'fp-answered',
      qa: [
        { kind: 'asked', time: '6:07 am', markdown: '"why a new tool? Don\'t we have existing tools?"', answered: true },
        { kind: 'answer', name: 'Onboarding', time: '6:09 am', markdown: 'The composer does not get the chat tool set.' },
      ],
    }));

    c = card(MERGE.question);
    const thread = within(c).getByRole('list', { name: 'Questions and answers' });
    expect(within(thread).getByText('You asked')).toBeInTheDocument();
    expect(within(thread).getByText("Onboarding's answer")).toBeInTheDocument();
    expect(c.querySelector('pre.decisions-ruling-text')).toBeNull();
    expect(commentBox(MERGE.question)).toHaveValue('');
    expect(screen.queryByRole('region', { name: 'Held drafts' })).not.toBeInTheDocument();

    choose(MERGE.question, 'accept');
    await submit(MERGE.question);
    expect(postDecisionRuling).toHaveBeenLastCalledWith({ id: 'main-12', fingerprint: 'fp-answered', word: 'accept' });
  });
});
