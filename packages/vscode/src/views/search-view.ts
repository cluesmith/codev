import * as vscode from 'vscode';
import type { SearchState } from './search-state.js';
import { makeNonce, renderSearchHtml } from './search-view-html.js';

/**
 * Counts shape returned by BacklogProvider / BuildersProvider so the
 * search webview can render its `"N of M"` summary line. The `shown`
 * field always reflects the post-filter row count.
 */
export interface SearchCounts {
  total: number;
  shown: number;
}

export interface SearchViewOptions {
  /** Webview view id — `codev.backlogSearch` or `codev.buildersSearch`. */
  viewType: string;
  /** State this view owns and writes into on input. */
  searchState: SearchState;
  /** Pull current `{total, shown}` from the owning TreeView's provider. */
  getCounts: () => SearchCounts;
  /** Input placeholder copy. E.g. `"Search backlog..."`. */
  placeholder: string;
}

/**
 * WebviewViewProvider for a per-view sidebar search input (#891).
 *
 * `extension.ts` instantiates this class twice — one for the Backlog,
 * one for the Builders — each with its own `SearchState`, `getCounts`,
 * and view id. The two are fully independent: typing in one input
 * does not affect the other view's tree.
 *
 * Wiring (per instance):
 * - Webview → extension: `{type:'query', value}` from input keystrokes
 *   (debounced 150ms client-side) flow into `searchState.setQuery`.
 * - Extension → webview: `{type:'summary', text}` updates the summary
 *   line below the input. Pushed whenever the owning provider's
 *   tree-data event fires (query change OR fresh overview data) so
 *   the summary always matches what the user sees in the tree.
 *
 * View visibility is governed by VSCode's standard collapse-section
 * mechanism — the view contribution in package.json sets
 * `"visibility": "collapsed"` so each search section starts collapsed.
 * The matching toggle command on the owning view's title bar focuses
 * this view's input (which also expands the section). No `when:`
 * clause, no context key — the section is always contributed.
 */
export class CodevSearchViewProvider implements vscode.WebviewViewProvider {
  /** Convenience constants so the two view ids live in one place. */
  static readonly BACKLOG_VIEW_TYPE = 'codev.backlogSearch';
  static readonly BUILDERS_VIEW_TYPE = 'codev.buildersSearch';

  readonly viewType: string;
  private readonly searchState: SearchState;
  private readonly getCounts: () => SearchCounts;
  private readonly placeholder: string;
  private view: vscode.WebviewView | undefined;

  constructor(opts: SearchViewOptions) {
    this.viewType = opts.viewType;
    this.searchState = opts.searchState;
    this.getCounts = opts.getCounts;
    this.placeholder = opts.placeholder;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderSearchHtml(webviewView.webview, {
      nonce: makeNonce(),
      placeholder: this.placeholder,
    });

    webviewView.webview.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== 'object') {return;}
      const m = msg as { type?: string; value?: string };
      if (m.type === 'query' && typeof m.value === 'string') {
        this.searchState.setQuery(m.value);
      } else if (m.type === 'ready') {
        this.pushSummary();
      }
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {this.view = undefined;}
    });
  }

  /**
   * Push the current summary text into the webview. Safe to call when
   * the view isn't resolved — it just no-ops. Called by `extension.ts`
   * whenever the owning provider's onDidChangeTreeData fires.
   */
  pushSummary(): void {
    if (!this.view) {return;}
    this.view.webview.postMessage({ type: 'summary', text: this.summaryText() });
  }

  private summaryText(): string {
    if (this.searchState.query.trim() === '') {return '';}
    const c = this.getCounts();
    return `${c.shown} of ${c.total}`;
  }
}
