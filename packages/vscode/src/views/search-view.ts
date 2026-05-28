import * as vscode from 'vscode';
import type { SearchState } from './search-state.js';
import { makeNonce, renderSearchHtml } from './search-view-html.js';

/**
 * Counts shape returned by BacklogProvider / BuildersProvider so the
 * search webview can render `"N of M backlog · K of L builders"`. The
 * "shown" field always reflects the post-filter row count.
 */
export interface SearchCounts {
  total: number;
  shown: number;
}

/**
 * WebviewViewProvider for the `codev.search` view (#891). Renders a
 * single text input + summary line at the top of the Codev sidebar.
 *
 * Wiring (set up by `extension.ts`):
 * - Webview → extension: `{type:'query', value}` from input keystrokes
 *   (debounced 150ms client-side) flow into `searchState.setQuery`.
 * - Extension → webview: `{type:'summary', text}` updates the summary
 *   line below the input. Pushed whenever EITHER provider's tree-data
 *   event fires (which happens when the query changes OR when fresh
 *   overview data arrives), so the summary always matches what the
 *   user sees in the trees.
 *
 * The view is contributed with `when: "codev.searchVisible"` in
 * package.json — toggling that context key adds/removes the view
 * entirely. When the view is hidden the webview is disposed; on
 * re-show, `resolveWebviewView` is called again with a fresh webview
 * instance, which is why we don't try to cache `view` across hides.
 */
export class CodevSearchViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'codev.search';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly searchState: SearchState,
    private readonly getBacklogCounts: () => SearchCounts,
    private readonly getBuildersCounts: () => SearchCounts,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderSearchHtml(webviewView.webview, makeNonce());

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
   * whenever either provider's onDidChangeTreeData fires.
   */
  pushSummary(): void {
    if (!this.view) {return;}
    this.view.webview.postMessage({ type: 'summary', text: this.summaryText() });
  }

  private summaryText(): string {
    if (this.searchState.query.trim() === '') {return '';}
    const b = this.getBacklogCounts();
    const w = this.getBuildersCounts();
    return `${b.shown} of ${b.total} backlog · ${w.shown} of ${w.total} builders`;
  }
}
