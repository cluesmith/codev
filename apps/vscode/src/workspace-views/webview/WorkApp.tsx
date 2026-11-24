/**
 * The Work panel's webview UI (Spec 1963): the shared Work view, fed by the overview the extension
 * host pushes, with every action a message to the host.
 *
 * - The view gets no dashboard slots, so the affordances VS Code drops (Open Files & Shells, the
 *   file panel, the tip of the day) are not rendered.
 * - Links are the host's: an issue or PR link and a *spec* / *plan* / *review* link each become a
 *   message, so the webview opens nothing itself.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { WorkView } from '@cluesmith/codev-workspace-views';
import type { OverviewState, WorkViewHost } from '@cluesmith/codev-workspace-views/host';
import type { WorkWebviewMessage } from '../messages.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The overview in a `work/overview` message from the host, or undefined for any other message. */
export function workOverviewOf(message: unknown): OverviewState | null | undefined {
  if (!isRecord(message) || message.type !== 'work/overview' || !('overview' in message)) { return undefined; }
  const { overview } = message;
  if (overview === null) { return null; }
  if (isRecord(overview) && 'data' in overview && 'error' in overview) { return overview as unknown as OverviewState; }
  return undefined;
}

/** The overview the host last pushed, outside React so the host's messages can set it. */
export class WorkStore {
  private overview: OverviewState | null = null;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): OverviewState | null => this.overview;

  setOverview(overview: OverviewState | null): void {
    this.overview = overview;
    for (const listener of this.listeners) { listener(); }
  }
}

/** The Work view's host: the pushed overview, and a message to the extension host for each action. */
export function webviewWorkHost(overview: OverviewState | null, post: (message: WorkWebviewMessage) => void): WorkViewHost {
  return {
    overview,
    openBuilder: builder => post({ type: 'work/open-builder', builderId: builder.id }),
    newShell: () => post({ type: 'work/new-shell' }),
    refresh: () => post({ type: 'work/refresh' }),
    openArtifact: path => post({ type: 'work/open-artifact', path }),
    openExternal: url => post({ type: 'open-external', url }),
  };
}

export function WorkApp({ store, post }: { store: WorkStore; post: (message: WorkWebviewMessage) => void }) {
  const overview = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const host = useMemo(() => webviewWorkHost(overview, post), [overview, post]);
  return <WorkView host={host} />;
}
