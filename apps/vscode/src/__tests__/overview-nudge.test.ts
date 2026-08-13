/**
 * #1410 regression: a review-queue mutation or a `codev.diffCodelensMode` change
 * must nudge Tower (`refreshOverview`) so the deck's Send Fb badge + dial mode
 * label refresh deterministically instead of waiting for an unrelated SSE event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  configListeners: [] as Array<(e: { affectsConfiguration: (s: string) => boolean }) => void>,
}));

vi.mock('vscode', () => ({
  Disposable: { from: (...ds: Array<{ dispose?: () => void }>) => ({ dispose: () => ds.forEach((d) => d.dispose?.()) }) },
  workspace: {
    onDidChangeConfiguration: (l: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
      h.configListeners.push(l);
      return { dispose() {} };
    },
  },
}));

const { activateOverviewNudge } = await import('../review-queue/overview-nudge.js');

/** Minimal ReviewQueueStore stand-in exposing the change event + a fire trigger. */
function makeStore() {
  let listener: (() => void) | undefined;
  return {
    store: { onDidChangeQueue: (l: () => void) => { listener = l; return { dispose() {} }; } } as never,
    fireQueueChange: () => listener?.(),
  };
}

function makeConn(refreshOverview = vi.fn(async () => true)) {
  return { conn: { getClient: () => ({ refreshOverview }) } as never, refreshOverview };
}

function fireConfig(section: string) {
  for (const l of h.configListeners) { l({ affectsConfiguration: (s) => s === section }); }
}

describe('activateOverviewNudge (#1410)', () => {
  beforeEach(() => { h.configListeners = []; });

  it('nudges Tower on a queue mutation', () => {
    const { store, fireQueueChange } = makeStore();
    const { conn, refreshOverview } = makeConn();
    activateOverviewNudge(store, conn);
    fireQueueChange();
    expect(refreshOverview).toHaveBeenCalledTimes(1);
  });

  it('nudges Tower when codev.diffCodelensMode changes, but not for an unrelated setting', () => {
    const { store } = makeStore();
    const { conn, refreshOverview } = makeConn();
    activateOverviewNudge(store, conn);
    fireConfig('editor.tabSize');
    expect(refreshOverview).not.toHaveBeenCalled();
    fireConfig('codev.diffCodelensMode');
    expect(refreshOverview).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (no throw) when Tower is not connected', () => {
    const { store, fireQueueChange } = makeStore();
    const conn = { getClient: () => null } as never;
    activateOverviewNudge(store, conn);
    expect(() => fireQueueChange()).not.toThrow();
  });
});
