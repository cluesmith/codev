/**
 * Markup, styles, and client-side script for the "Search Backlog" webview
 * (#920). Kept out of `backlog-search-panel.ts` so that file stays focused on
 * lifecycle, messaging, and host-side filtering — and so the markup/CSS read
 * as markup/CSS (the `/* html *​/` and `/* css *​/` tags light up
 * string-template highlighters).
 *
 * The client script is intentionally small DOM glue: it owns no data, only
 * forwards debounced criteria to the host and renders the rows the host posts
 * back (see the panel's message protocol). Issue body never reaches here.
 */

const STYLES = /* css */ `
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0 12px 12px;
  }
  h1 { font-size: 1.2em; font-weight: 600; margin: 12px 0; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
  label { font-size: 0.85em; opacity: 0.85; }
  select, input, button {
    font-family: inherit; font-size: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px; padding: 3px 6px;
  }
  input#q { flex: 1 1 220px; min-width: 160px; }
  button {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none; cursor: pointer; padding: 4px 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td {
    text-align: left; padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, transparent));
    white-space: nowrap;
  }
  th { cursor: pointer; user-select: none; font-weight: 600; }
  th:hover { color: var(--vscode-textLink-foreground); }
  td.title { white-space: normal; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  td.actions, th.actions { width: 1%; padding: 0 8px; text-align: right; }
  /* Inline row action, mirroring the sidebar's hover-revealed icon at the row's right edge. */
  .row-action {
    background: none; border: none; padding: 2px 4px; cursor: pointer;
    color: var(--vscode-foreground); opacity: 0; font-size: 1.05em; line-height: 1;
  }
  tbody tr:hover .row-action, .row-action:focus-visible { opacity: 0.9; }
  .row-action:hover { color: var(--vscode-textLink-foreground); opacity: 1; }
  footer { margin-top: 10px; font-size: 0.85em; opacity: 0.8; }
  .error { color: var(--vscode-errorForeground); }
  .empty { opacity: 0.7; padding: 16px 8px; }
`;

const CLIENT_SCRIPT = `
  const vscode = acquireVsCodeApi();
  let sortCol = 'age';
  let sortDir = 'desc';

  const $ = (id) => document.getElementById(id);
  const area = $('area'), assignee = $('assignee'), author = $('author');
  const q = $('q'), status = $('status');

  function criteria() {
    return {
      text: q.value,
      area: area.value,
      assignee: assignee.value,
      author: author.value,
      sort: sortCol,
      direction: sortDir,
    };
  }
  function postCriteria() { vscode.postMessage({ type: 'criteria', criteria: criteria() }); }

  let debounce;
  q.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(postCriteria, 150);
  });
  $('search').addEventListener('click', postCriteria);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounce); postCriteria(); } });
  area.addEventListener('change', postCriteria);
  assignee.addEventListener('change', postCriteria);
  author.addEventListener('change', postCriteria);
  status.addEventListener('change', () => vscode.postMessage({ type: 'state', state: status.value }));

  document.querySelectorAll('th[data-col]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-col');
      if (sortCol === col) { sortDir = sortDir === 'asc' ? 'desc' : 'asc'; }
      else { sortCol = col; sortDir = col === 'age' ? 'desc' : 'asc'; }
      renderHeaders();
      postCriteria();
    });
  });

  const LABELS = { id: '#', title: 'Title', area: 'Area', assignee: 'Assignee', age: 'Age' };
  function renderHeaders() {
    document.querySelectorAll('th[data-col]').forEach((th) => {
      const col = th.getAttribute('data-col');
      const arrow = col === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      th.textContent = LABELS[col] + arrow;
    });
  }

  function fillSelect(sel, values, keepLeading) {
    const prev = sel.value;
    // Remove dynamic options, keep the static leading ones (All/Me/etc.).
    while (sel.options.length > keepLeading) { sel.remove(sel.options.length - 1); }
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    }
    // Restore prior selection if still present.
    if ([...sel.options].some(o => o.value === prev)) { sel.value = prev; }
  }

  function renderRows(rows) {
    const tbody = $('rows');
    tbody.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => vscode.postMessage({ type: 'open', id: r.id }));
      const cells = [
        ['num', '#' + r.id],
        ['title', r.title],
        ['area', r.area],
        ['assignee', r.assignee],
        ['num', r.age],
      ];
      for (const [cls, text] of cells) {
        const td = document.createElement('td');
        td.className = cls;
        td.textContent = text;
        tr.appendChild(td);
      }
      // Inline action: reference this issue in the architect chat (id + title),
      // mirroring the sidebar row's hover button. stopPropagation so it doesn't
      // also trigger the row-open.
      const actionTd = document.createElement('td');
      actionTd.className = 'actions';
      const refBtn = document.createElement('button');
      refBtn.className = 'row-action';
      refBtn.textContent = '↪';
      refBtn.title = 'Reference #' + r.id + ' in architect chat';
      refBtn.setAttribute('aria-label', refBtn.title);
      refBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'reference', id: r.id, title: r.title });
      });
      actionTd.appendChild(refBtn);
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    }
    $('empty').hidden = rows.length > 0;
    renderFooter(rows);
  }

  function renderFooter(rows) {
    const byArea = {};
    for (const r of rows) { byArea[r.area] = (byArea[r.area] || 0) + 1; }
    const breakdown = Object.keys(byArea).sort()
      .map(a => byArea[a] + ' in ' + a).join(', ');
    let text = rows.length + ' match' + (rows.length === 1 ? '' : 'es') + ' found';
    if (breakdown) { text += ' · ' + breakdown; }
    $('footer').textContent = text;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'dataset') {
      fillSelect(area, msg.areas, 1);         // keep "All"
      fillSelect(assignee, msg.assignees, 3); // keep All / Me / Unassigned
      fillSelect(author, msg.authors, 2);     // keep Anyone / Me
      const line = $('status-line');
      if (msg.error) { line.textContent = msg.error; line.className = 'error'; }
      else if (msg.capped) { line.textContent = 'Showing the forge limit of ' + msg.total + ' issues — narrow your scope.'; line.className = 'empty'; }
      else { line.textContent = ''; }
    } else if (msg.type === 'results') {
      renderRows(msg.rows);
    }
  });

  renderHeaders();
`;

/** Build the full webview document. A fresh nonce is generated per render and
 *  bound into both the CSP and the single inline `<script>`. */
export function renderBacklogSearchHtml(cspSource: string): string {
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Search Backlog</title>
  <style>${STYLES}</style>
</head>
<body>
  <h1>Search Backlog</h1>
  <div class="row">
    <label>Area <select id="area"><option value="">All</option></select></label>
    <label>Assignee <select id="assignee">
      <option value="">All</option>
      <option value="me">Me</option>
      <option value="unassigned">Unassigned</option>
    </select></label>
    <label>Author <select id="author">
      <option value="">Anyone</option>
      <option value="me">Me</option>
    </select></label>
  </div>
  <div class="row">
    <input id="q" type="text" placeholder="Search title and body…" />
    <label>Status <select id="status">
      <option value="open">Open</option>
      <option value="closed">Closed</option>
      <option value="all">All</option>
    </select></label>
    <button id="search">Search</button>
  </div>
  <div id="status-line" class="error"></div>
  <table>
    <thead>
      <tr>
        <th class="num" data-col="id">#</th>
        <th data-col="title">Title</th>
        <th data-col="area">Area</th>
        <th data-col="assignee">Assignee</th>
        <th data-col="age">Age</th>
        <th class="actions" aria-label="Actions"></th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="empty" class="empty" hidden>No matching issues.</div>
  <footer id="footer"></footer>
  <script nonce="${nonce}">${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
