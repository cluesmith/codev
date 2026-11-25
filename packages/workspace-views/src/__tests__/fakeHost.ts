/** Fake hosts for the views' tests: every member a spy, answering what each test sets. */
import { vi } from 'vitest';
import type { DecisionImageResult, DecisionRulingResult, DecisionsFetchResult, DecisionsViewHost, WorkViewHost } from '../host.js';

export function fakeDecisionsHost() {
  return {
    read: vi.fn<() => Promise<DecisionsFetchResult>>(async () => ({ kind: 'error', message: 'read is not set up in this test' })),
    rule: vi.fn<DecisionsViewHost['rule']>(async (): Promise<DecisionRulingResult> => ({ kind: 'error', message: 'rule is not set up in this test' })),
    image: vi.fn<(path: string, signal: AbortSignal) => Promise<DecisionImageResult>>(async () => ({ kind: 'not-loaded', message: 'image is not set up in this test' })),
    openExternal: vi.fn<(url: string) => void>(),
    showImage: vi.fn<(image: { src: string; alt: string }) => void>(),
  } satisfies DecisionsViewHost;
}

export function fakeWorkHost(overrides: Partial<WorkViewHost> = {}): WorkViewHost {
  return {
    overview: { data: null, error: null },
    openBuilder: vi.fn(),
    newShell: vi.fn(),
    refresh: vi.fn(),
    openArtifact: vi.fn(),
    ...overrides,
  };
}
