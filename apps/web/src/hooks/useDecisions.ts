import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchDecisions } from '../lib/api.js';
import type { DecisionsDocument, DecisionsFetchResult } from '../lib/api.js';

/** How often the open, visible Decisions tab re-reads the file. */
export const DECISIONS_POLL_MS = 2000;

/**
 * What the Decisions tab shows. An `error` keeps the last document read, so a
 * transient failure (a tunnel blip) shows a banner instead of unmounting the cards
 * under the owner; `not-found` is the server saying the file is gone, and has none.
 */
export type DecisionsState =
  | { status: 'loading' }
  | { status: 'ready'; document: DecisionsDocument }
  | { status: 'not-found'; message: string }
  | { status: 'error'; message: string; lastDocument: DecisionsDocument | null };

function lastDocumentOf(state: DecisionsState): DecisionsDocument | null {
  if (state.status === 'ready') return state.document;
  if (state.status === 'error') return state.lastDocument;
  return null;
}

/** The next state for a fetch result; `prev` itself when nothing visible changed. */
function nextState(prev: DecisionsState, result: DecisionsFetchResult): DecisionsState {
  switch (result.kind) {
    case 'document':
      if (prev.status === 'ready' && prev.document.version === result.document.version) return prev;
      return { status: 'ready', document: result.document };
    case 'not-found':
      if (prev.status === 'not-found' && prev.message === result.message) return prev;
      return { status: 'not-found', message: result.message };
    case 'error': {
      const lastDocument = lastDocumentOf(prev);
      if (prev.status === 'error' && prev.message === result.message && prev.lastDocument === lastDocument) return prev;
      return { status: 'error', message: result.message, lastDocument };
    }
  }
}

function pageVisible(): boolean {
  return document.visibilityState === 'visible';
}

/**
 * Spec 1819: the decisions document, kept current while the tab is active and the
 * page is visible.
 *
 * - Fetches on activation and when the page becomes visible again, then every
 *   `DECISIONS_POLL_MS`; stops while the tab is inactive or the page hidden.
 * - Never overlaps fetches: a tick while one is in flight is skipped.
 * - Never regresses: every fetch start and every `applyDocument` (the document a
 *   successful write returns) takes a new generation, and a response is applied
 *   only if its generation is still the latest — so a poll that started before a
 *   write and lands after it is dropped rather than overwriting the newer document.
 * - An unchanged `version` leaves the state object as it was, so React bails out
 *   of the update and nothing below re-renders.
 */
export function useDecisions(isActive: boolean) {
  const [state, setState] = useState<DecisionsState>({ status: 'loading' });
  const [visible, setVisible] = useState(pageVisible);
  const generation = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    const onVisibilityChange = () => setVisible(pageVisible());
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const fetchGeneration = ++generation.current;
    try {
      const result = await fetchDecisions();
      if (fetchGeneration === generation.current) {
        setState(prev => nextState(prev, result));
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isActive || !visible) return;
    void load();
    const timer = setInterval(() => { void load(); }, DECISIONS_POLL_MS);
    return () => clearInterval(timer);
  }, [isActive, visible, load]);

  const applyDocument = useCallback((doc: DecisionsDocument) => {
    generation.current++;
    setState(prev => nextState(prev, { kind: 'document', document: doc }));
  }, []);

  return { state, applyDocument };
}
