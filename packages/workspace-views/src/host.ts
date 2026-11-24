/**
 * The host adapters (Spec 1963): everything the Work and Decisions views read or do outside
 * themselves goes through these, so the same components run in the browser dashboard (whose host
 * fetches Tower's routes) and in a VS Code webview (whose host relays to the extension, which holds
 * the Tower connection). The package itself never fetches, and imports nothing host-specific.
 *
 * An optional action is optional on purpose: a control renders only when its host provides the
 * action, so a host never shows a button that does nothing.
 */

import type {
  DecisionsDocument,
  DecisionsRefusalCode,
  DecisionsRuleRequest,
  OverviewBuilder,
  OverviewData,
} from '@cluesmith/codev-types';

/**
 * Spec 1819: the outcome of reading the workspace's decisions file. Never thrown —
 * a refusal or a transport failure is something the Decisions view shows.
 */
export type DecisionsFetchResult =
  | { kind: 'document'; document: DecisionsDocument }
  | { kind: 'not-found'; message: string }
  | { kind: 'error'; message: string };

/**
 * Spec 1819: the outcome of submitting a ruling. Never thrown — the card shows a
 * refusal or a transport failure and keeps the owner's draft.
 */
export type DecisionRulingResult =
  | { kind: 'document'; document: DecisionsDocument }
  | { kind: 'refused'; code: DecisionsRefusalCode; message: string }
  | { kind: 'error'; message: string };

/** #1938: an image an item references, or why it was not loaded. Never thrown. */
export type DecisionImageResult =
  | { kind: 'image'; blob: Blob }
  | { kind: 'not-loaded'; message: string };

/** The overview as the host last read it. */
export interface OverviewState {
  /** The last overview read; null until the first one arrives. */
  data: OverviewData | null;
  /** Why the last read failed, or null. A failed read keeps `data` (the last good one). */
  error: string | null;
}

/** What the Work view shows and does. */
export interface WorkViewHost {
  /**
   * The overview to show, kept current by the host (the dashboard polls; VS Code pushes from the
   * extension's overview cache). Null while the host is still loading: the view shows its loading
   * state until it is not.
   */
  overview: OverviewState | null;
  /** A builder row's *Open*: show that builder's terminal. */
  openBuilder?(builder: OverviewBuilder): void;
  /** *+ Shell*: open a new shell. */
  newShell?(): void;
  /** *Refresh*: re-read the overview, bypassing Tower's overview cache. */
  refresh?(): void;
  /** A Backlog or Recently Closed *spec* / *plan* / *review* link: open that workspace file. */
  openArtifact?(path: string): void;
}

/** What the Decisions view reads and does. */
export interface DecisionsViewHost {
  /** Read the decisions document. */
  read(): Promise<DecisionsFetchResult>;
  /** Write the owner's ruling; success carries the re-parsed document. */
  rule(request: DecisionsRuleRequest): Promise<DecisionRulingResult>;
  /**
   * An image an item names by its workspace path (as written: relative to the decisions file, or
   * `/`-rooted at the workspace). The view aborts `signal` when the image leaves the screen, and
   * ignores a result that arrives after that.
   */
  image(path: string, signal: AbortSignal): Promise<DecisionImageResult>;
  /** Open an http(s) link from an item. Without it, links in items are inert. */
  openExternal?(url: string): void;
  /**
   * Show an image full size: an http(s) URL, or the `blob:` URL of a workspace image the view
   * loaded. Without it, clicking an image does nothing.
   */
  showImage?(image: { src: string; alt: string }): void;
}
