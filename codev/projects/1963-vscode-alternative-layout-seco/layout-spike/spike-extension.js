// Throwaway spike for Spec 1963 Phase 1: checks (a)-(d) of the editor-layout assumptions.
// Writes stage markers + results into OUT; a Playwright driver screenshots each stage.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const OUT = '/private/tmp/claude-501/-Users-mwk-Development-cluesmith-codev--builders-spir-1963/b220eadf-5293-4c67-95a3-546bd584cc12/scratchpad/spike/out';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { started: new Date().toISOString(), vscodeVersion: vscode.version };
const log = (m) => fs.appendFileSync(path.join(OUT, 'spike.log'), `${new Date().toISOString()} ${m}\n`);

async function stage(name) {
  fs.writeFileSync(path.join(OUT, `stage-${name}`), '');
  const ack = path.join(OUT, `stage-${name}.ack`);
  for (let i = 0; i < 60 && !fs.existsSync(ack); i++) await sleep(500);
}

function tabKind(t) {
  const i = t.input;
  if (i instanceof vscode.TabInputText) return 'text';
  if (i instanceof vscode.TabInputTerminal) return 'terminal';
  if (i instanceof vscode.TabInputWebview) return 'webview';
  return 'other';
}
function snapshot() {
  return vscode.window.tabGroups.all.map((g) => ({
    viewColumn: g.viewColumn,
    tabs: g.tabs.map((t) => ({ label: t.label, kind: tabKind(t), dirty: t.isDirty, uri: t.input && t.input.uri ? t.input.uri.toString() : undefined })),
  }));
}
function terminalTabColumn(label) {
  for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) if (tabKind(t) === 'terminal' && t.label === label) return g.viewColumn;
  return null;
}
const RUN = Date.now().toString(36);
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
const LAYOUT = { orientation: 0, groups: [{}, { groups: [{}, {}] }] };

async function caseA(ws) {
  const r = {};
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(500);
  const docs = {};
  for (const [n, col] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(ws, `${n}.txt`));
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: col, preview: false });
    if (n === 'b' || n === 'd' || n === 'e') await ed.edit((e) => e.insert(new vscode.Position(0, 0), `MODIFIED-${n} `));
    docs[n] = doc;
  }
  for (const [label, col] of [['UNTITLED-in-4', 4], ['UNTITLED-in-5', 5]]) {
    const doc = await vscode.workspace.openTextDocument({ content: label, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { viewColumn: col, preview: false });
    docs[label] = doc;
  }
  await sleep(800);
  const before = Object.fromEntries(Object.entries(docs).map(([k, d]) => [k, { uri: d.uri.toString(), dirty: d.isDirty, text: d.getText() }]));
  r.groupsBefore = vscode.window.tabGroups.all.length;
  r.tabsBefore = snapshot();
  await stage('a-before');
  const closed = [];
  const sub = vscode.workspace.onDidCloseTextDocument((d) => closed.push(d.uri.toString()));
  await vscode.commands.executeCommand('vscode.setEditorLayout', LAYOUT);
  await sleep(1500);
  sub.dispose();
  r.groupsAfter = vscode.window.tabGroups.all.length;
  r.layoutAfter = await vscode.commands.executeCommand('vscode.getEditorLayout');
  r.tabsAfter = snapshot();
  const afterTabUris = new Set(r.tabsAfter.flatMap((g) => g.tabs.map((t) => t.uri)));
  r.perDoc = {};
  for (const [k, b] of Object.entries(before)) {
    const d = vscode.workspace.textDocuments.find((x) => x.uri.toString() === b.uri);
    r.perDoc[k] = {
      tabStillOpen: afterTabUris.has(b.uri),
      docStillOpen: !!d,
      dirtyBefore: b.dirty, dirtyAfter: d ? d.isDirty : null,
      textPreserved: d ? d.getText() === b.text : false,
    };
  }
  r.closedDocsDuringLayout = closed;
  r.pass = r.groupsAfter === 3 && closed.length === 0 && Object.values(r.perDoc).every((p) => p.tabStillOpen && p.docStillOpen && p.textPreserved && p.dirtyAfter === p.dirtyBefore);
  await stage('a-after');
  // idempotency: applying again with 3 groups changes nothing
  const snapBefore = JSON.stringify(snapshot());
  await vscode.commands.executeCommand('vscode.setEditorLayout', LAYOUT);
  await sleep(800);
  r.idempotent = JSON.stringify(snapshot()) === snapBefore;
  return r;
}

async function caseD(ws) {
  const r = {};
  const panel = vscode.window.createWebviewPanel('spikeD', 'Spike D', { viewColumn: vscode.ViewColumn.Two, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = `<!doctype html><html><body style="font:20px sans-serif;padding:20px"><div id=c>0</div><script>
    const api = acquireVsCodeApi(); const loadId = Math.random().toString(36).slice(2); let n = 0;
    setInterval(() => { n++; document.getElementById('c').textContent = 'loadId ' + loadId + ' · ticks ' + n; }, 100);
    window.addEventListener('message', (e) => { if (e.data === 'ping') api.postMessage({ loadId, n }); });
  </script></body></html>`;
  const ping = () => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ping timeout')), 5000);
    const s = panel.webview.onDidReceiveMessage((m) => { clearTimeout(t); s.dispose(); res(m); });
    panel.webview.postMessage('ping');
  });
  await sleep(1500);
  const p1 = await ping();
  r.columnBefore = panel.viewColumn;
  panel.reveal(vscode.ViewColumn.Three);
  await sleep(1500);
  const p2 = await ping();
  r.columnAfterReveal = panel.viewColumn;
  r.visibleMove = { sameLoad: p1.loadId === p2.loadId, ticksAdvanced: p2.n > p1.n, p1, p2 };
  // hidden move: cover the panel with a text editor in its group, then reveal into group 1
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(ws, 'a.txt'));
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Three, preview: false });
  await sleep(800);
  r.hiddenBeforeReveal = !panel.visible;
  panel.reveal(vscode.ViewColumn.One);
  await sleep(1500);
  const p3 = await ping();
  r.columnAfterHiddenReveal = panel.viewColumn;
  r.hiddenMove = { sameLoad: p1.loadId === p3.loadId, ticksAdvanced: p3.n > p2.n, p3 };
  r.pass = r.columnAfterReveal === 3 && r.visibleMove.sameLoad && r.visibleMove.ticksAdvanced && r.columnAfterHiddenReveal === 1 && r.hiddenMove.sameLoad;
  await stage('d-after');
  r.panel = panel;
  return r;
}

async function makeTerminal(name, location) {
  const t = vscode.window.createTerminal({ name, shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc'], location });
  const pid = await withTimeout(t.processId, 20000, `processId of ${name}`);
  await sleep(1500);
  return { t, pid };
}
function readLog(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

async function caseB() {
  const r = {};
  const logf = path.join(OUT, 'b.log');
  const { t, pid } = await makeTerminal(`spikeB-${RUN}`, { viewColumn: vscode.ViewColumn.Three });
  t.sendText(`echo B1-$$ >> '${logf}'`);
  await sleep(1000);
  r.columnBefore = terminalTabColumn(`spikeB-${RUN}`);
  t.show(false);
  await sleep(500);
  await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
  await sleep(1500);
  r.columnAfter = terminalTabColumn(`spikeB-${RUN}`);
  r.exitStatus = t.exitStatus ? t.exitStatus.code : null;
  r.pidBefore = pid; r.pidAfter = await withTimeout(t.processId, 10000, 'processId after');
  t.sendText(`echo B2-$$ >> '${logf}'`);
  await sleep(1000);
  r.log = readLog(logf);
  const lines = r.log.trim().split('\n');
  r.pass = r.columnBefore === 3 && r.columnAfter === 1 && r.exitStatus === null && r.pidBefore === r.pidAfter
    && lines.length === 2 && lines[0].startsWith('B1-') && lines[1].startsWith('B2-') && lines[0].slice(3) === lines[1].slice(3);
  await stage('b-after');
  return r;
}

async function caseC() {
  const r = {};
  const logf = path.join(OUT, 'c.log');
  const { t, pid } = await makeTerminal(`spikeC-${RUN}`, vscode.TerminalLocation.Panel);
  t.sendText(`echo C1-$$ >> '${logf}'`);
  await sleep(1000);
  r.columnBefore = terminalTabColumn(`spikeC-${RUN}`); // null = in the panel, not an editor tab
  t.show(false);
  await sleep(500);
  await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
  await sleep(1500);
  r.columnAfterMoveToEditor = terminalTabColumn(`spikeC-${RUN}`);
  t.show(false);
  await sleep(500);
  await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
  await sleep(1500);
  r.columnAfterFirstGroup = terminalTabColumn(`spikeC-${RUN}`);
  r.exitStatus = t.exitStatus ? t.exitStatus.code : null;
  r.pidBefore = pid; r.pidAfter = await withTimeout(t.processId, 10000, 'processId after');
  t.sendText(`echo C2-$$ >> '${logf}'`);
  await sleep(1000);
  r.log = readLog(logf);
  const lines = r.log.trim().split('\n');
  r.pass = r.columnBefore === null && r.columnAfterMoveToEditor !== null && r.columnAfterFirstGroup === 1 && r.exitStatus === null
    && r.pidBefore === r.pidAfter && lines.length === 2 && lines[0].slice(3) === lines[1].slice(3);
  await stage('c-after');
  return r;
}

async function run() {
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri;
  log(`activated; ws=${ws} run=${RUN}`);
  await vscode.workspace.getConfiguration('files').update('autoSave', 'off', vscode.ConfigurationTarget.Global);
  results.autoSave = vscode.workspace.getConfiguration('files').get('autoSave');
  results.trusted = vscode.workspace.isTrusted;
  for (const t of vscode.window.terminals) t.dispose();
  log(`autoSave=${results.autoSave} trusted=${results.trusted}`);
  for (const [k, fn] of [['a', caseA], ['d', caseD], ['b', caseB], ['c', caseC]]) {
    try { const r = await fn(ws); delete r.panel; results[k] = r; log(`case ${k} pass=${r.pass}`); }
    catch (e) { results[k] = { error: String(e && e.stack || e) }; log(`case ${k} ERROR ${e}`); }
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  }
  results.finished = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  await stage('done');
}

exports.activate = () => { setTimeout(() => run().catch((e) => log(`run failed ${e}`)), 4000); };
exports.deactivate = () => {};
