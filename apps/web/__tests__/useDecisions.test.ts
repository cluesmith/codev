/**
 * Spec 1819 Phase 4: useDecisions — visibility-aware, non-overlapping,
 * generation-guarded polling of the decisions document.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { DecisionsDocument } from '@cluesmith/codev-types';
import type { DecisionsFetchResult } from '../src/lib/api.js';

const mockFetchDecisions = vi.fn<() => Promise<DecisionsFetchResult>>();
vi.mock('../src/lib/api.js', () => ({
  fetchDecisions: () => mockFetchDecisions(),
}));

import { useDecisions, DECISIONS_POLL_MS } from '../src/hooks/useDecisions.js';

function makeDocument(version: string): DecisionsDocument {
  return { path: 'codev/state/pending-decisions.md', version, items: [], ruledMarkdown: '', problems: [] };
}

function documentResult(version: string): DecisionsFetchResult {
  return { kind: 'document', document: makeDocument(version) };
}

/** A fetch whose answer the test releases by hand. */
function deferred() {
  let resolve!: (result: DecisionsFetchResult) => void;
  const promise = new Promise<DecisionsFetchResult>(r => { resolve = r; });
  return { promise, resolve };
}

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Let resolved fetches settle and React apply their state. */
async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  mockFetchDecisions.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDecisions — fetching and polling', () => {
  it('fetches on activation and shows the document', async () => {
    mockFetchDecisions.mockResolvedValue(documentResult('v1'));
    const { result } = renderHook(() => useDecisions(true));
    expect(result.current.state.status).toBe('loading');
    await flush();
    expect(mockFetchDecisions).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ status: 'ready', document: makeDocument('v1') });
  });

  it('does not fetch while the tab is inactive, and fetches at once when it becomes active', async () => {
    mockFetchDecisions.mockResolvedValue(documentResult('v1'));
    const { result, rerender } = renderHook(({ active }) => useDecisions(active), { initialProps: { active: false } });
    await advance(DECISIONS_POLL_MS * 3);
    expect(mockFetchDecisions).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe('loading');

    rerender({ active: true });
    await flush();
    expect(mockFetchDecisions).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('ready');
  });

  it('polls every DECISIONS_POLL_MS while active and visible', async () => {
    mockFetchDecisions.mockResolvedValue(documentResult('v1'));
    renderHook(() => useDecisions(true));
    await flush();
    expect(mockFetchDecisions).toHaveBeenCalledTimes(1);
    await advance(DECISIONS_POLL_MS);
    expect(mockFetchDecisions).toHaveBeenCalledTimes(2);
    await advance(DECISIONS_POLL_MS);
    expect(mockFetchDecisions).toHaveBeenCalledTimes(3);
  });

  it('stops polling when the tab becomes inactive', async () => {
    mockFetchDecisions.mockResolvedValue(documentResult('v1'));
    const { rerender } = renderHook(({ active }) => useDecisions(active), { initialProps: { active: true } });
    await flush();
    rerender({ active: false });
    await advance(DECISIONS_POLL_MS * 5);
    expect(mockFetchDecisions).toHaveBeenCalledTimes(1);
  });

  it('pauses while the page is hidden and fetches at once when it is visible again', async () => {
    mockFetchDecisions.mockResolvedValue(documentResult('v1'));
    renderHook(() => useDecisions(true));
    await flush();
    expect(mockFetchDecisions).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    await advance(DECISIONS_POLL_MS * 5);
    expect(mockFetchDecisions).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await flush();
    expect(mockFetchDecisions).toHaveBeenCalledTimes(2);
    await advance(DECISIONS_POLL_MS);
    expect(mockFetchDecisions).toHaveBeenCalledTimes(3);
  });

  it('does not start polling when mounted on a hidden page', async () => {
    visibility = 'hidden';
    mockFetchDecisions.mockResolvedValue(documentResult('v1'));
    renderHook(() => useDecisions(true));
    await advance(DECISIONS_POLL_MS * 3);
    expect(mockFetchDecisions).not.toHaveBeenCalled();
  });
});

describe('useDecisions — race safety', () => {
  it('skips ticks while a fetch is in flight, so fetches never overlap', async () => {
    const slow = deferred();
    mockFetchDecisions.mockReturnValueOnce(slow.promise).mockResolvedValue(documentResult('v2'));
    const { result } = renderHook(() => useDecisions(true));
    await advance(DECISIONS_POLL_MS * 4);
    expect(mockFetchDecisions).toHaveBeenCalledTimes(1);

    slow.resolve(documentResult('v1'));
    await flush();
    expect(result.current.state).toEqual({ status: 'ready', document: makeDocument('v1') });

    await advance(DECISIONS_POLL_MS);
    expect(mockFetchDecisions).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual({ status: 'ready', document: makeDocument('v2') });
  });

  it('discards a poll that started before applyDocument and lands after it', async () => {
    mockFetchDecisions.mockResolvedValueOnce(documentResult('v1'));
    const { result } = renderHook(() => useDecisions(true));
    await flush();

    const stale = deferred();
    mockFetchDecisions.mockReturnValueOnce(stale.promise);
    await advance(DECISIONS_POLL_MS);
    expect(mockFetchDecisions).toHaveBeenCalledTimes(2);

    // A successful write answers with the newer document while that poll is in flight.
    act(() => result.current.applyDocument(makeDocument('v3-written')));
    expect(result.current.state).toEqual({ status: 'ready', document: makeDocument('v3-written') });

    // The poll read the file before the write and now answers with the older version.
    stale.resolve(documentResult('v2-before-write'));
    await flush();
    expect(result.current.state).toEqual({ status: 'ready', document: makeDocument('v3-written') });

    // The next poll, started after the write, is applied as usual.
    mockFetchDecisions.mockResolvedValueOnce(documentResult('v4'));
    await advance(DECISIONS_POLL_MS);
    expect(result.current.state).toEqual({ status: 'ready', document: makeDocument('v4') });
  });

  it('keeps the same state object when the version is unchanged', async () => {
    // A fresh document object each time, with the same version.
    mockFetchDecisions.mockImplementation(async () => documentResult('v1'));
    const { result } = renderHook(() => useDecisions(true));
    await flush();
    const first = result.current.state;

    await advance(DECISIONS_POLL_MS * 3);
    expect(mockFetchDecisions).toHaveBeenCalledTimes(4);
    expect(result.current.state).toBe(first);
  });

  it('replaces the document when the version changes', async () => {
    mockFetchDecisions.mockResolvedValueOnce(documentResult('v1')).mockResolvedValue(documentResult('v2'));
    const { result } = renderHook(() => useDecisions(true));
    await flush();
    const first = result.current.state;
    await advance(DECISIONS_POLL_MS);
    expect(result.current.state).not.toBe(first);
    expect(result.current.state).toEqual({ status: 'ready', document: makeDocument('v2') });
  });
});

describe('useDecisions — not-found and error states', () => {
  it('shows not-found when the server says the file is gone, and recovers when it returns', async () => {
    mockFetchDecisions
      .mockResolvedValueOnce(documentResult('v1'))
      .mockResolvedValueOnce({ kind: 'not-found', message: 'There is no decisions file at codev/state/pending-decisions.md.' })
      .mockResolvedValue(documentResult('v2'));
    const { result } = renderHook(() => useDecisions(true));
    await flush();
    await advance(DECISIONS_POLL_MS);
    expect(result.current.state).toEqual({
      status: 'not-found',
      message: 'There is no decisions file at codev/state/pending-decisions.md.',
    });
    await advance(DECISIONS_POLL_MS);
    expect(result.current.state).toEqual({ status: 'ready', document: makeDocument('v2') });
  });

  it('keeps the last document under an error, and clears the error on the next good read', async () => {
    mockFetchDecisions
      .mockResolvedValueOnce(documentResult('v1'))
      .mockResolvedValueOnce({ kind: 'error', message: 'Could not reach Tower: Failed to fetch' })
      .mockResolvedValue(documentResult('v1'));
    const { result } = renderHook(() => useDecisions(true));
    await flush();
    await advance(DECISIONS_POLL_MS);
    expect(result.current.state).toEqual({
      status: 'error',
      message: 'Could not reach Tower: Failed to fetch',
      lastDocument: makeDocument('v1'),
    });
    // Same version as before the error: still a transition back to ready.
    await advance(DECISIONS_POLL_MS);
    expect(result.current.state).toEqual({ status: 'ready', document: makeDocument('v1') });
  });

  it('has no last document for an error before any successful read', async () => {
    mockFetchDecisions.mockResolvedValue({ kind: 'error', message: 'The codev config could not be loaded: bad JSON' });
    const { result } = renderHook(() => useDecisions(true));
    await flush();
    expect(result.current.state).toEqual({
      status: 'error',
      message: 'The codev config could not be loaded: bad JSON',
      lastDocument: null,
    });
  });
});
