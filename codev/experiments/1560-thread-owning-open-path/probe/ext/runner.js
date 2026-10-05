// Probe runner for experiment 1560 — executes inside the Extension Development
// Host (extensionTestsPath). Each route opens a fresh file, opens a composer
// the route's way, then measures the success criteria from notes.md:
//   focus     — is the active text editor a comment input (scheme 'comment')?
//   ownership — does text typed there + editor.action.submitComment (the
//               dial-submit built-in) arrive on the thread object WE created?
//   discard   — does thread.dispose() leave the host editor open?
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOUNT_WAIT = 800;
const SETTLE = 600;

function focusState() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return { activeScheme: null }; }
  return { activeScheme: ed.document.uri.scheme, activeUri: ed.document.uri.toString() };
}

function tabCount() {
  return vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
}

async function openFile(name) {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(300);
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const uri = vscode.Uri.joinPath(folder, name);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
  await sleep(SETTLE);
  return uri;
}

const LINE = 2; // 0-based → editor line 3
const lineRange = () => new vscode.Range(LINE, 0, LINE, 6);
const addCommentArgs = () => ({
  range: { startLineNumber: LINE + 1, startColumn: 1, endLineNumber: LINE + 1, endColumn: 7 },
});

/** Type a marker into the focused comment input and fire the dial-submit built-in. */
async function typeAndSubmit(events, marker) {
  const before = events.length;
  const ed = vscode.window.activeTextEditor;
  let typed = false;
  if (ed && ed.document.uri.scheme === 'comment') {
    typed = await ed.edit((b) => b.insert(new vscode.Position(0, 0), marker));
    await sleep(200);
  }
  await vscode.commands.executeCommand('editor.action.submitComment');
  await sleep(SETTLE);
  return { typed, arrived: events.slice(before) };
}

function describeArrivals(arrived, ownThread, ownComment) {
  return arrived.map((e) => ({
    kind: e.kind,
    text: e.text,
    onOwnedThread: e.thread === ownThread,
    onOwnedComment: ownComment ? e.comment === ownComment : undefined,
  }));
}

async function discardCheck(thread, hostUri) {
  const tabsBefore = tabCount();
  thread.dispose();
  await sleep(SETTLE);
  const ed = vscode.window.activeTextEditor;
  return {
    tabsBefore,
    tabsAfter: tabCount(),
    hostStillOpen: vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === hostUri.toString()),
    activeAfter: ed ? ed.document.uri.scheme : null,
  };
}

function emptyThread(controller, uri, state) {
  const t = controller.createCommentThread(uri, lineRange(), []);
  t.canReply = true;
  t.collapsibleState = state;
  return t;
}

function draftThread(controller, uri, state) {
  const draft = {
    body: '',
    mode: vscode.CommentMode.Editing,
    author: { name: 'probe' },
    contextValue: 'draft',
  };
  const t = controller.createCommentThread(uri, lineRange(), [draft]);
  draft.parent = t;
  t.canReply = false;
  t.contextValue = 'draft-thread';
  t.collapsibleState = state;
  return { t, draft };
}

const Expanded = () => vscode.CommentThreadCollapsibleState.Expanded;
const Collapsed = () => vscode.CommentThreadCollapsibleState.Collapsed;

/** Open a diff editor (builder diffs are diffs) with the file on the modified side. */
async function openDiff(name) {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(300);
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const right = vscode.Uri.joinPath(folder, name);
  const left = vscode.Uri.joinPath(folder, 'base.txt');
  await vscode.commands.executeCommand('vscode.diff', left, right, `probe diff ${name}`);
  await sleep(SETTLE * 2);
  return right;
}

const routes = {
  async 'DA-diff-reveal-focusReply'(api, file) {
    const uri = await openDiff(file);
    const t = emptyThread(api.controller, uri, Expanded());
    let error = null;
    try { await t.reveal(undefined, { focus: 1 }); } catch (e) { error = String(e && e.message || e); }
    await sleep(SETTLE);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'DA');
    return { error, focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, t) };
  },
  async 'DB-diff-draft-expanded'(api, file) {
    const uri = await openDiff(file);
    const { t, draft } = draftThread(api.controller, uri, Expanded());
    await sleep(MOUNT_WAIT);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'DB');
    const tabsBefore = tabCount();
    t.dispose();
    await sleep(SETTLE);
    return { focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, t, draft), tabsBefore, tabsAfter: tabCount() };
  },
  async 'DH0-diff-create-then-addComment'(api, file) {
    const uri = await openDiff(file);
    const t = emptyThread(api.controller, uri, Expanded());
    await sleep(MOUNT_WAIT);
    await vscode.commands.executeCommand('workbench.action.addComment', addCommentArgs());
    await sleep(SETTLE);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'DH0');
    return { focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, t) };
  },
  // Timing stability: B2 with a SHORT wait, repeated.
  async 'RB-draft-expanded-x5-short-wait'(api, file) {
    const out = [];
    for (let k = 0; k < 5; k++) {
      const uri = await openFile(file);
      const { t, draft } = draftThread(api.controller, uri, Expanded());
      await sleep(250);
      const focus = focusState();
      const sub = await typeAndSubmit(api.events, `RB${k}`);
      const a = describeArrivals(sub.arrived, t, draft);
      out.push({ focused: focus.activeScheme === 'comment', ok: a.length === 1 && a[0].onOwnedThread && a[0].text === `RB${k}` });
      t.dispose();
    }
    return out;
  },
  async 'RA-reveal-x5-no-wait'(api, file) {
    const out = [];
    for (let k = 0; k < 5; k++) {
      const uri = await openFile(file);
      const t = emptyThread(api.controller, uri, Expanded());
      let error = null;
      try { await t.reveal(undefined, { focus: 1 }); } catch (e) { error = String(e && e.message || e); }
      await sleep(250);
      const focus = focusState();
      const sub = await typeAndSubmit(api.events, `RA${k}`);
      const a = describeArrivals(sub.arrived, t);
      out.push({ error, focused: focus.activeScheme === 'comment', ok: a.length === 1 && a[0].onOwnedThread && a[0].text === `RA${k}` });
      t.dispose();
    }
    return out;
  },
  // File-level (range-less) composer — the builder-review fileComment flow.
  async 'FB-file-draft-expanded'(api, file) {
    const uri = await openDiff(file);
    const { t, draft } = draftThread(api.controller, uri, Expanded());
    t.range = undefined;
    await sleep(MOUNT_WAIT);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'FB');
    const a = describeArrivals(sub.arrived, t, draft);
    const rangeAtSubmit = t.range === undefined ? 'undefined' : 'set';
    t.dispose();
    return { focus, arrivals: a, rangeAtSubmit };
  },
  async 'FA-file-reveal-focusReply'(api, file) {
    const uri = await openDiff(file);
    const t = emptyThread(api.controller, uri, Expanded());
    t.range = undefined;
    let error = null;
    try { await t.reveal(undefined, { focus: 1 }); } catch (e) { error = String(e && e.message || e).slice(0, 80); }
    await sleep(SETTLE);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'FA');
    const a = describeArrivals(sub.arrived, t);
    t.dispose();
    return { error, focus, arrivals: a };
  },
  // Escape baselines: does a dial-submit after Escape deliver the escaped text?
  async 'ECTRL-shipped-escape-then-submit'(api, file) {
    await openFile(file);
    await vscode.commands.executeCommand('workbench.action.addComment', addCommentArgs());
    await sleep(SETTLE);
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'comment') { await ed.edit((b) => b.insert(new vscode.Position(0, 0), 'escaped')); }
    await vscode.commands.executeCommand('workbench.action.hideComment');
    await sleep(SETTLE);
    const afterEscape = focusState();
    const sub = await typeAndSubmit(api.events, '+ECTRL');
    return { afterEscape, submitAfterEscape: sub.arrived.map((e) => e.text) };
  },
  async 'EA-reveal-escape-then-submit'(api, file) {
    const uri = await openFile(file);
    const t = emptyThread(api.controller, uri, Expanded());
    try { await t.reveal(undefined, { focus: 1 }); } catch (e) { return { error: String(e.message) }; }
    await sleep(SETTLE);
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'comment') { await ed.edit((b) => b.insert(new vscode.Position(0, 0), 'escaped')); }
    await vscode.commands.executeCommand('workbench.action.hideComment');
    await sleep(SETTLE);
    const afterEscape = focusState();
    const sub = await typeAndSubmit(api.events, '+EA');
    return { afterEscape, submitAfterEscape: sub.arrived.map((e) => e.text) };
  },
  async 'EB2-draft-escape-then-submit-text'(api, file) {
    const uri = await openFile(file);
    const { t } = draftThread(api.controller, uri, Expanded());
    await sleep(MOUNT_WAIT);
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'comment') { await ed.edit((b) => b.insert(new vscode.Position(0, 0), 'escaped')); }
    await vscode.commands.executeCommand('workbench.action.hideComment');
    await sleep(SETTLE);
    const afterEscape = focusState();
    const sub = await typeAndSubmit(api.events, '+EB');
    t.dispose();
    return { afterEscape, submitAfterEscape: sub.arrived.map((e) => e.text) };
  },
  // Escape (native hideComment) on a B draft, then the owned-handle discard.
  async 'EB-draft-escape-then-dispose'(api, file) {
    const uri = await openFile(file);
    const { t } = draftThread(api.controller, uri, Expanded());
    await sleep(MOUNT_WAIT);
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'comment') { await ed.edit((b) => b.insert(new vscode.Position(0, 0), 'escaped')); }
    await vscode.commands.executeCommand('workbench.action.hideComment');
    await sleep(SETTLE);
    const afterEscape = focusState();
    const sub = await typeAndSubmit(api.events, 'EB');
    const discard = await discardCheck(t, uri);
    return { afterEscape, submitAfterEscapeArrivals: sub.arrived.length, discard };
  },

  // H0 — the issue's hypothesis: create (owned) then addComment at the same line.
  async 'H0a-create-expanded-then-addComment-immediately'(api, file) {
    const uri = await openFile(file);
    const t = emptyThread(api.controller, uri, Expanded());
    await vscode.commands.executeCommand('workbench.action.addComment', addCommentArgs());
    await sleep(SETTLE);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'H0a');
    return { focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, t) };
  },
  async 'H0b-create-expanded-wait-mount-then-addComment'(api, file) {
    const uri = await openFile(file);
    const t = emptyThread(api.controller, uri, Expanded());
    await sleep(MOUNT_WAIT);
    await vscode.commands.executeCommand('workbench.action.addComment', addCommentArgs());
    await sleep(SETTLE);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'H0b');
    return { focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, t) };
  },
  async 'H0c-create-collapsed-wait-mount-then-addComment'(api, file) {
    const uri = await openFile(file);
    const t = emptyThread(api.controller, uri, Collapsed());
    await sleep(MOUNT_WAIT);
    await vscode.commands.executeCommand('workbench.action.addComment', addCommentArgs());
    await sleep(SETTLE);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'H0c');
    return { focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, t) };
  },
  // Control: the shipped #1552 path (addComment alone) — focus but no handle.
  async 'CTRL-shipped-addComment-only'(api, file) {
    await openFile(file);
    await vscode.commands.executeCommand('workbench.action.addComment', addCommentArgs());
    await sleep(SETTLE);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'CTRL');
    return { focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, null) };
  },
  // Secondary: built-in focus command on an owned thread.
  async 'C-create-then-focusCommentOnCurrentLine'(api, file) {
    const uri = await openFile(file);
    const t = emptyThread(api.controller, uri, Expanded());
    await sleep(MOUNT_WAIT);
    const ed = vscode.window.activeTextEditor;
    ed.selection = new vscode.Selection(LINE, 0, LINE, 0);
    let error = null;
    try { await vscode.commands.executeCommand('workbench.action.focusCommentOnCurrentLine'); } catch (e) { error = String(e); }
    await sleep(SETTLE);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'C');
    return { error, focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, t) };
  },
  // Recipe A — proposed `commentReveal` API (thread.reveal, focus: Reply).
  async 'A1-create-then-reveal-focusReply'(api, file) {
    const uri = await openFile(file);
    const t = emptyThread(api.controller, uri, Expanded());
    let error = null;
    try { await t.reveal(undefined, { focus: 1 }); } catch (e) { error = String(e && e.message || e); }
    await sleep(SETTLE);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'A1');
    return { error, focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, t) };
  },
  async 'A1-discard'(api, file) {
    const uri = await openFile(file);
    const t = emptyThread(api.controller, uri, Expanded());
    let error = null;
    try { await t.reveal(undefined, { focus: 1 }); } catch (e) { error = String(e && e.message || e); }
    await sleep(SETTLE);
    const focus = focusState();
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'comment') { await ed.edit((b) => b.insert(new vscode.Position(0, 0), 'discard-me')); }
    const discard = await discardCheck(t, uri);
    // After dispose, a dial-submit must not resurrect anything.
    const sub = await typeAndSubmit(api.events, 'A1-post');
    return { error, focus, discard, postDisposeSubmitArrivals: sub.arrived.length };
  },
  // Recipe B — stable API: owned thread whose only comment is an Editing-mode draft.
  async 'B1-draft-collapsed-wait-then-expand'(api, file) {
    const uri = await openFile(file);
    const { t, draft } = draftThread(api.controller, uri, Collapsed());
    await sleep(MOUNT_WAIT);
    t.collapsibleState = Expanded();
    await sleep(SETTLE);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'B1');
    return { focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, t, draft) };
  },
  async 'B2-draft-created-expanded'(api, file) {
    const uri = await openFile(file);
    const { t, draft } = draftThread(api.controller, uri, Expanded());
    await sleep(MOUNT_WAIT);
    const focus = focusState();
    const sub = await typeAndSubmit(api.events, 'B2');
    return { focus, typed: sub.typed, arrivals: describeArrivals(sub.arrived, t, draft) };
  },
  async 'B1-discard'(api, file) {
    const uri = await openFile(file);
    const { t } = draftThread(api.controller, uri, Collapsed());
    await sleep(MOUNT_WAIT);
    t.collapsibleState = Expanded();
    await sleep(SETTLE);
    const focus = focusState();
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'comment') { await ed.edit((b) => b.insert(new vscode.Position(0, 0), 'discard-me')); }
    const discard = await discardCheck(t, uri);
    const sub = await typeAndSubmit(api.events, 'B1-post');
    return { focus, discard, postDisposeSubmitArrivals: sub.arrived.length };
  },
};

async function run() {
  const ext = vscode.extensions.getExtension('codev-probe.probe-1560');
  const api = await ext.activate();
  const results = { host: { appName: vscode.env.appName, version: vscode.version }, routes: {} };
  const only = process.env.PROBE_ROUTES ? process.env.PROBE_ROUTES.split(',') : null;
  const files = ['sample.txt', 'sample2.txt', 'sample3.txt', 'sample4.txt', 'sample5.txt', 'sample6.txt', 'sample7.txt'];
  let i = 0;
  for (const [name, fn] of Object.entries(routes)) {
    if (only && !only.some((p) => name.startsWith(p))) { continue; }
    const file = files[i % files.length];
    i += 1;
    try {
      results.routes[name] = await fn(api, file);
    } catch (e) {
      results.routes[name] = { crashed: String(e && e.stack || e) };
    }
  }
  const out = process.env.PROBE_OUT || path.join(__dirname, 'results.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
}

module.exports = { run };
