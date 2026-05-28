import * as vscode from 'vscode';

/**
 * Shared filter state for the sidebar search webview (#891). One instance
 * is constructed in `extension.ts` and passed to BacklogProvider,
 * BuildersProvider, and CodevSearchViewProvider — so a single source of
 * truth drives both views' filtered render and the webview's summary.
 *
 * v1 ships with a single text query and case-insensitive substring match
 * across all caller-supplied fields. Match modes (case-sensitive, whole-
 * word, regex) were deliberately dropped from scope; if a real need
 * surfaces they get added back here without changing consumer wiring.
 *
 * Query is transient — not persisted across workspace reloads (per
 * design decision 3 in `codev/plans/891-vscode-shared-search-webview-a.md`).
 * The 🔍 toggle preference IS persisted, but that lives in
 * `workspaceState` keyed by `codev.searchVisible` in `extension.ts`,
 * not here — SearchState only knows the query.
 */
export class SearchState {
  private _query = '';
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  get query(): string {
    return this._query;
  }

  /**
   * Update the query. Fires `onDidChange` only when the value actually
   * changed — keeps the webview's debounced input from re-firing both
   * providers on every keystroke that didn't move the trimmed value.
   */
  setQuery(q: string): void {
    if (q === this._query) {return;}
    this._query = q;
    this.changeEmitter.fire();
  }

  clear(): void {
    this.setQuery('');
  }

  /**
   * Match the current query against the union of caller-supplied fields.
   * Returns true when the query is empty/whitespace (no filter) or when
   * any field contains the query as a case-folded substring.
   *
   * Undefined / null fields are tolerated — the call sites (backlog,
   * builders) project fields like `item.author` and `b.spawnedByArchitect`
   * that may legitimately be absent.
   */
  matches(fields: Array<string | null | undefined>): boolean {
    const needle = this._query.trim().toLowerCase();
    if (needle === '') {return true;}
    for (const f of fields) {
      if (f && f.toLowerCase().includes(needle)) {return true;}
    }
    return false;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
