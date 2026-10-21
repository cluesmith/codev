/**
 * Spec 1819 Phases 4–5: DecisionsView — the shell (header, file-level problems, loading /
 * not-found / error states) and the read-only cards (stamps, body, Q&A thread, options,
 * current ruling, item notices, the collapsed `## Ruled` list, container link handling).
 * Ruling from a writable card (Phase 6) is in DecisionsView.ruling.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import type { DecisionItem, DecisionsDocument } from '@cluesmith/codev-types';
import type { DecisionsState } from '../src/hooks/useDecisions.js';

const mockUseDecisions = vi.fn<(isActive: boolean) => { state: DecisionsState; applyDocument: () => void }>();
vi.mock('../src/hooks/useDecisions.js', () => ({
  useDecisions: (isActive: boolean) => mockUseDecisions(isActive),
}));

import { DecisionsView, STAMP_FORMAT, STAMP_TIME_FORMAT } from '../src/components/DecisionsView.js';

/** The viewer's zone for every test here: neither the stamps' zone (PT) nor UTC. */
const VIEWER_TZ = 'America/New_York';

function makeItem(id: string, question: string, overrides: Partial<DecisionItem> = {}): DecisionItem {
  return {
    id,
    stamp: null,
    question,
    bodyMarkdown: '',
    options: [],
    currentRuling: '',
    qa: [],
    fingerprint: `fp-${id}`,
    problems: [],
    writable: true,
    ...overrides,
  };
}

function makeDocument(overrides: Partial<DecisionsDocument> = {}): DecisionsDocument {
  return {
    path: 'codev/state/pending-decisions.md',
    version: 'v1',
    items: [],
    ruledMarkdown: '',
    problems: [],
    ...overrides,
  };
}

function showState(state: DecisionsState) {
  mockUseDecisions.mockReturnValue({ state, applyDocument: () => {} });
  return render(<DecisionsView isActive />);
}

function showItems(...items: DecisionItem[]) {
  return showState({ status: 'ready', document: makeDocument({ items }) });
}

function card(question: string): HTMLElement {
  return screen.getByRole('article', { name: question });
}

beforeAll(() => {
  vi.stubEnv('TZ', VIEWER_TZ);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  cleanup();
  mockUseDecisions.mockReset();
  vi.restoreAllMocks();
});

describe('DecisionsView shell', () => {
  it('passes isActive through to the polling hook', () => {
    mockUseDecisions.mockReturnValue({ state: { status: 'loading' }, applyDocument: () => {} });
    render(<DecisionsView isActive={false} />);
    expect(mockUseDecisions).toHaveBeenCalledWith(false);
  });

  it('shows a loading message before the first read', () => {
    showState({ status: 'loading' });
    expect(screen.getByText('Loading decisions…')).toBeInTheDocument();
  });

  it('shows one card per open item in file order, plus the path and open count', () => {
    showItems(
      makeItem('main-12', 'Merge the onboarding scan fix?'),
      makeItem('ops-3', 'Raise the e2e timeout · or split the suite?'),
    );
    expect(screen.getByText('codev/state/pending-decisions.md')).toBeInTheDocument();
    expect(screen.getByText('2 open')).toBeInTheDocument();
    const cards = screen.getAllByRole('article');
    expect(cards.map(c => within(c).getByRole('heading').textContent)).toEqual([
      'Merge the onboarding scan fix?',
      'Raise the e2e timeout · or split the suite?',
    ]);
    expect(within(cards[0]).getByText('main-12')).toBeInTheDocument();
    expect(within(cards[1]).getByText('ops-3')).toBeInTheDocument();
  });

  it('says there are no open decisions for an empty ## Open', () => {
    showState({ status: 'ready', document: makeDocument() });
    expect(screen.getByText('0 open')).toBeInTheDocument();
    expect(screen.getByText('No open decisions.')).toBeInTheDocument();
  });

  it('names a missing ## Open section instead of saying there is nothing open', () => {
    showState({ status: 'ready', document: makeDocument({ problems: ['open-missing'] }) });
    expect(screen.getByRole('status')).toHaveTextContent('This file has no ## Open section, so there is nothing to rule on.');
    expect(screen.queryByText('No open decisions.')).not.toBeInTheDocument();
  });

  it('names two ## Open sections, and still shows the items', () => {
    showState({
      status: 'ready',
      document: makeDocument({ problems: ['open-multiple'], items: [makeItem('main-1', 'Q', { writable: false })] }),
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'This file has more than one ## Open section. Every item is read-only until there is one.',
    );
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('names two ## Ruled sections', () => {
    showState({ status: 'ready', document: makeDocument({ problems: ['ruled-multiple'] }) });
    expect(screen.getByRole('status')).toHaveTextContent(
      'This file has more than one ## Ruled section; only the first is read.',
    );
  });

  it('shows the server message when the file is not found, and no cards', () => {
    showState({ status: 'not-found', message: 'There is no decisions file at codev/state/pending-decisions.md.' });
    expect(screen.getByRole('status')).toHaveTextContent('There is no decisions file at codev/state/pending-decisions.md.');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByText('Ruled')).not.toBeInTheDocument();
  });

  it('shows an error before any document was read', () => {
    showState({ status: 'error', message: 'The codev config could not be loaded: bad JSON', lastDocument: null });
    expect(screen.getByRole('alert')).toHaveTextContent('The codev config could not be loaded: bad JSON');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('keeps the last document visible under an error banner', () => {
    showState({
      status: 'error',
      message: 'Could not reach Tower: Failed to fetch',
      lastDocument: makeDocument({ items: [makeItem('main-12', 'Merge the onboarding scan fix?')] }),
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach Tower: Failed to fetch Showing the last version read.');
    expect(within(card('Merge the onboarding scan fix?')).getByText('main-12')).toBeInTheDocument();
  });
});

describe('DecisionsView card stamps', () => {
  it('renders a converted stamp in the viewer zone, with the raw stamp on hover', () => {
    const instant = '2026-07-01T22:05:00.000Z';
    showItems(makeItem('main-12', 'Q', {
      stamp: { raw: '2026-07-01 3:05 pm PT', instant },
    }));
    const time = within(card('Q')).getByText((_, el) => el?.tagName === 'TIME');
    const inViewerZone = new Intl.DateTimeFormat(undefined, { ...STAMP_FORMAT, timeZone: VIEWER_TZ }).format(new Date(instant));
    const inStampZone = new Intl.DateTimeFormat(undefined, { ...STAMP_FORMAT, timeZone: 'America/Los_Angeles' }).format(new Date(instant));
    expect(time).toHaveTextContent(inViewerZone);
    expect(inViewerZone).not.toBe(inStampZone);
    expect(time).toHaveAttribute('title', '2026-07-01 3:05 pm PT');
    expect(time).toHaveAttribute('datetime', instant);
  });

  it.each([
    ['unknown-zone', '2026-10-17 1:30 am IST', 'Not converted: the time zone is not one the tab recognizes'],
    ['nonexistent-time', '2026-03-08 2:30 am PT', 'Not converted: that time does not exist on that date in that zone (the clocks skipped it)'],
    ['ambiguous-time', '2026-11-01 1:30 am PT', 'Not converted: that time happens twice on that date in that zone (the clocks went back)'],
  ] as const)('shows an unconverted stamp verbatim with its reason (%s)', (reason, raw, text) => {
    showItems(makeItem('main-12', 'Q', { stamp: { raw, instant: null, unconvertedReason: reason } }));
    const c = card('Q');
    expect(within(c).getByText(raw, { exact: false })).toHaveTextContent(`${raw}${text}`);
    expect(c.querySelector('time')).toBeNull();
  });

  it('shows a time-only stamp as the converted time alone, with no date (#1836)', () => {
    const instant = '2026-10-20T01:30:00.000Z';
    showItems(makeItem('main-12', 'Q', { stamp: { raw: '6:30 pm', instant, timeOnly: true } }));
    const time = within(card('Q')).getByText((_, el) => el?.tagName === 'TIME');
    const timeAlone = new Intl.DateTimeFormat(undefined, { ...STAMP_TIME_FORMAT, timeZone: VIEWER_TZ }).format(new Date(instant));
    expect(time.textContent).toBe(timeAlone);
    expect(time.textContent).not.toMatch(/Oct|2026/);
    expect(time).toHaveAttribute('title', '6:30 pm');
  });

  it('shows a stamp with no zone known as written, with no warning (#1836)', () => {
    showItems(makeItem('main-12', 'Q', { stamp: { raw: '6:30 pm', instant: null, timeOnly: true } }));
    const c = card('Q');
    expect(c.querySelector('.decisions-stamp')).toHaveTextContent(/^6:30 pm$/);
    expect(c).not.toHaveTextContent('Not converted');
    expect(c.querySelector('.decisions-stamp-flag')).toBeNull();
  });

  it('shows no stamp for a heading without one', () => {
    showItems(makeItem('main-12', 'Q'));
    const c = card('Q');
    expect(c.querySelector('.decisions-stamp')).toBeNull();
  });
});

describe('DecisionsView card content', () => {
  it('renders the body as markdown', () => {
    showItems(makeItem('main-12', 'Q', {
      bodyMarkdown: '- **Problem:** the scan fails after onboarding.\n- **Links:** https://example.com/pr/42',
    }));
    const c = card('Q');
    expect(within(c).getByText('Problem:').tagName).toBe('STRONG');
    expect(within(c).getByRole('link', { name: 'https://example.com/pr/42' })).toHaveAttribute('href', 'https://example.com/pr/42');
  });

  it('shows the question-and-answer thread in file order, with times as written', () => {
    showItems(makeItem('onboarding-3', 'Q', {
      bodyMarkdown: '- **Problem:** the body.',
      qa: [
        { kind: 'asked', time: '6:07 am', markdown: '"why a new tool?"', answered: true },
        { kind: 'answer', name: 'Onboarding', time: '6:09 am', markdown: 'The composer does **not** get the chat tools.' },
        { kind: 'asked', time: '6:20 am', markdown: 'and the cost?', answered: false },
      ],
    }));
    const thread = within(card('Q')).getByRole('list', { name: 'Questions and answers' });
    const entries = within(thread).getAllByRole('listitem');
    expect(entries.map(e => e.querySelector('.decisions-thread-label')?.textContent)).toEqual([
      'You asked6:07 am',
      "Onboarding's answer6:09 am",
      'You asked6:20 am',
    ]);
    expect(within(entries[1]).getByText('not').tagName).toBe('STRONG');
    expect(within(entries[0]).queryByText('Awaiting an answer')).not.toBeInTheDocument();
    expect(within(entries[2]).getByText('Awaiting an answer')).toBeInTheDocument();
    expect(screen.getAllByText('Awaiting an answer')).toHaveLength(1);
    expect(screen.getAllByText('"why a new tool?"')).toHaveLength(1);
  });

  it('shows an answer with no question before it', () => {
    showItems(makeItem('main-12', 'Q', {
      qa: [{ kind: 'answer', name: 'Main', time: '7:00 am', markdown: 'Done already.' }],
    }));
    const thread = within(card('Q')).getByRole('list', { name: 'Questions and answers' });
    expect(within(thread).getByText("Main's answer")).toBeInTheDocument();
    expect(within(thread).getByText('Done already.')).toBeInTheDocument();
  });

  it('shows no thread for an item without one', () => {
    showItems(makeItem('main-12', 'Q', { bodyMarkdown: '- **Context:** none.' }));
    expect(within(card('Q')).queryByRole('list', { name: 'Questions and answers' })).not.toBeInTheDocument();
  });

  it('lists a read-only card\'s options in order with descriptions, the first marked recommended, with no controls', () => {
    showItems(makeItem('main-12', 'Q', {
      options: [
        { word: 'accept', description: 'merge as is', recommended: true },
        { word: 'rework', description: 'send back', recommended: false },
        { word: 'hold', description: '', recommended: false },
      ],
      currentRuling: 'rework',
      writable: false,
    }));
    const options = within(within(card('Q')).getByRole('list', { name: 'Options' })).getAllByRole('listitem');
    expect(options.map(o => o.textContent)).toEqual(['accept: merge as is Recommended', 'rework: send back', 'hold']);
    expect(screen.getAllByText('Recommended')).toHaveLength(1);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows the current ruling verbatim with the neutral note', () => {
    const ruling = 'accept\n\naccept but don\'t add the limit on additional tests.\n\nThat could easily backfire.';
    showItems(makeItem('main-12', 'Q', { currentRuling: ruling, writable: false }));
    const c = card('Q');
    const pre = c.querySelector('pre.decisions-ruling-text');
    expect(pre?.textContent).toBe(ruling);
    expect(within(c).getByText(/You have written under this item, and main will act on it\./)).toHaveTextContent(
      'You have written under this item, and main will act on it. To change it, tell main or edit the file by hand.',
    );
  });

  it('shows a REVIEW-comment ruling as text, not hidden as HTML', () => {
    const ruling = '<!-- REVIEW(@owner): why a new tool? -->';
    showItems(makeItem('main-12', 'Q', { currentRuling: ruling, writable: false }));
    expect(card('Q').querySelector('pre.decisions-ruling-text')?.textContent).toBe(ruling);
  });

  it('shows no current ruling for an unruled item', () => {
    showItems(makeItem('main-12', 'Q'));
    expect(within(card('Q')).queryByText('Written under this item')).not.toBeInTheDocument();
  });

  it('flags every copy of a duplicated id', () => {
    const duplicate = { problems: ['duplicate-id' as const], writable: false };
    showItems(makeItem('main-1', 'First copy', duplicate), makeItem('main-1', 'Second copy', duplicate));
    for (const q of ['First copy', 'Second copy']) {
      expect(within(card(q)).getByRole('note')).toHaveTextContent(
        'Another open item has the same id. Items that share an id are read-only until the ids differ.',
      );
    }
  });

  it.each([
    ['your-word-missing', 'This item has no **Your word:** line, so the tab cannot write a ruling for it.'],
    ['your-word-multiple', 'This item has more than one **Your word:** line, so the tab cannot write a ruling for it.'],
    ['id-missing', 'This heading has no id, so the tab cannot write a ruling for it.'],
  ] as const)('names the %s problem on the card', (problem, text) => {
    showItems(makeItem(problem === 'id-missing' ? '' : 'main-12', 'Q', { problems: [problem], writable: false }));
    expect(within(card('Q')).getByRole('note')).toHaveTextContent(text);
  });

  it('names a card by its id when the heading carries no question, with no empty heading', () => {
    showItems(makeItem('main-12', ''));
    const c = screen.getByRole('article', { name: 'main-12' });
    expect(within(c).queryByRole('heading')).not.toBeInTheDocument();
  });

  it('labels an item without an id', () => {
    showItems(makeItem('', 'Q', { problems: ['id-missing'], writable: false }));
    expect(within(card('Q')).getByText('(no id)')).toBeInTheDocument();
  });
});

describe('DecisionsView ## Ruled', () => {
  it('renders the ruled section as markdown, collapsed by default', () => {
    showState({
      status: 'ready',
      document: makeDocument({
        ruledMarkdown: '- **main-10** · ruled `approve` 11:02 pm · relayed 11:03 pm: merged',
      }),
    });
    const details = screen.getByText('Ruled').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(within(details!).getByText('main-10').tagName).toBe('STRONG');
    expect(within(details!).getByText('approve').tagName).toBe('CODE');
  });

  it('says when nothing has been ruled', () => {
    showState({ status: 'ready', document: makeDocument() });
    const details = screen.getByText('Ruled').closest('details')!;
    expect(within(details).getByText(/Nothing under/)).toHaveTextContent('Nothing under ## Ruled yet.');
  });
});

describe('DecisionsView link handling', () => {
  function showLinks() {
    return showState({
      status: 'ready',
      document: makeDocument({
        items: [makeItem('main-12', 'Q', {
          bodyMarkdown: [
            '- **Links:** https://example.com/pr/42, [the tools](src/composer/tools.ts)',
            '- [mail](mailto:owner@example.com) [top](#top) [**bold link**](HTTPS://example.com/bold)',
          ].join('\n'),
          qa: [{ kind: 'answer', name: 'Main', time: '7:00 am', markdown: 'See http://example.com/answer' }],
        })],
        ruledMarkdown: '- **main-10** · DONE: https://example.com/released',
      }),
    });
  }

  it.each([
    ['https://example.com/pr/42', 'https://example.com/pr/42'],
    ['http://example.com/answer', 'http://example.com/answer'],
    ['https://example.com/released', 'https://example.com/released'],
  ])('opens %s in a new browser tab without navigating the dashboard', (name, href) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const before = window.location.href;
    showLinks();
    const link = screen.getByRole('link', { name });
    // A middle-click or the context menu opens it the same way: in a new tab, without an opener.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(open).toHaveBeenCalledExactlyOnceWith(href, '_blank', 'noopener');
    expect(window.location.href).toBe(before);
  });

  it('opens a link whose text is nested markup, matching the scheme case-insensitively', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    showLinks();
    fireEvent.click(screen.getByText('bold link'));
    expect(open).toHaveBeenCalledExactlyOnceWith('HTTPS://example.com/bold', '_blank', 'noopener');
  });

  it.each(['the tools', 'mail', 'top'])('makes the non-http(s) link "%s" inert', name => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const before = window.location.href;
    showLinks();
    // No href, so there is nothing for a middle-click, the context menu or the keyboard to open.
    const anchor = screen.getByText(name).closest('a')!;
    expect(anchor).not.toHaveAttribute('href');
    expect(screen.queryByRole('link', { name })).toBeNull();
    const notPrevented = fireEvent.click(anchor);
    expect(notPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });

  it('applies the link rule again when the markdown changes', () => {
    const { rerender } = showLinks();
    mockUseDecisions.mockReturnValue({
      state: {
        status: 'ready',
        document: makeDocument({
          items: [makeItem('main-12', 'Q', { bodyMarkdown: '[guide](codev/guide.md) and https://example.com/new' })],
        }),
      },
      applyDocument: () => {},
    });
    rerender(<DecisionsView isActive />);
    expect(screen.getByText('guide').closest('a')).not.toHaveAttribute('href');
    expect(screen.getByRole('link', { name: 'https://example.com/new' })).toHaveAttribute('target', '_blank');
  });

  it('leaves clicks that are not on a link alone', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    showLinks();
    const notPrevented = fireEvent.click(screen.getByRole('heading', { name: 'Q' }));
    expect(notPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});
