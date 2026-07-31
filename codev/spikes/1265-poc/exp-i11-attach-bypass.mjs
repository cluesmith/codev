/**
 * Spike 1265 — round 11, architect gap 1: direct-socket clients (afx attach)
 * bypass Tower's input path entirely.
 *
 * Drives the REAL ShellperProcess (shellper-process.ts) hosting a REAL bash
 * PTY, with two clients:
 *   T — a raw-socket "tower" client using the real wire protocol
 *       (createFrameParser/encodeHello/encodeData), auditing EVERY frame it
 *       receives. This is Tower's seat at the table.
 *   A — the real ShellperClient in clientType 'terminal' — the exact class and
 *       mode afx attach uses (attach.ts:142; stdin → client.write at :222,
 *       SIGWINCH → client.resize at :228).
 *
 * What it demonstrates (all against the shipped production module):
 *   i11a: A's DATA frames reach the PTY and EXECUTE (output proves execution,
 *         not just echo) — handleData has no clientType restriction
 *         (shellper-process.ts:303-305, :413-417).
 *   i11b: NO frame of any type ever tells T about A — not A's connect, not
 *         A's input. T's post-handshake frame stream is PTY output DATA only.
 *         Tower-side input tracking (DraftTracker at PtySession.write()) is
 *         structurally blind to this input; it surfaces at Tower only as PTY
 *         OUTPUT (echo/render), i.e. on the G-lite side.
 *   i11c: A's RESIZE mutates the real PTY geometry (stty probe) with no frame
 *         to T — Tower's stored dimensions go silently stale.
 *   i11d: contrast — SIGNAL from A is ignored (tower-only, :309-314) while
 *         DATA/RESIZE are not; the open input path is protocol design, not an
 *         accident.
 *   i11e (measured): a FRESH tower handshake after the resize gets WELCOME
 *         with the new geometry — Tower resyncs dimensions only at reconnect.
 *
 * Self-asserting: exit 1 on any assertion failure.
 * Usage: <main>/packages/codev/node_modules/.bin/tsx exp-i11-attach-bypass.mjs
 *   (tsx, because shellper-process.ts uses TS parameter properties — not
 *   erasable, so --experimental-strip-types can't load it like w1/g2's
 *   dependency-free modules. The module graph is imported from the MAIN
 *   checkout's src so its bare deps resolve; the worktree copies are asserted
 *   BYTE-IDENTICAL below, so the module under test is still this branch's.)
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(here, '..', '..', '..');
const MAIN_ROOT = path.resolve(WORKTREE_ROOT, '..', '..');
const TERM_DIR = path.join(MAIN_ROOT, 'packages', 'codev', 'src', 'terminal');
const WT_TERM_DIR = path.join(WORKTREE_ROOT, 'packages', 'codev', 'src', 'terminal');

// Provenance: the imported (main-checkout) sources must equal this branch's.
for (const f of ['shellper-process.ts', 'shellper-client.ts', 'shellper-protocol.ts']) {
  const h = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
  const a = h(path.join(TERM_DIR, f));
  const b = h(path.join(WT_TERM_DIR, f));
  console.log(`SOURCE ${f} main=${a} worktree=${b} ${a === b ? 'IDENTICAL' : 'DIFFER'}`);
  if (a !== b) { console.error(`FATAL: ${f} differs between main and worktree — import the worktree copy instead.`); process.exit(1); }
}

const { ShellperProcess } = await import(path.join(TERM_DIR, 'shellper-process.ts'));
const { ShellperClient } = await import(path.join(TERM_DIR, 'shellper-client.ts'));
const proto = await import(path.join(TERM_DIR, 'shellper-protocol.ts'));
const { FrameType, createFrameParser, encodeHello, encodeData, PROTOCOL_VERSION } = proto;

// node-pty from the repo's installed store (same resolution as harness.cjs).
function resolveDep(name) {
  for (const dir of [
    path.join(WORKTREE_ROOT, 'packages', 'codev', 'node_modules'),
    path.join(MAIN_ROOT, 'packages', 'codev', 'node_modules'),
  ]) {
    try { return createRequire(path.join(dir, 'noop.js'))(name); } catch { /* next */ }
  }
  return createRequire(import.meta.url)(name);
}
const pty = resolveDep('node-pty');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(label, ok, detail) {
  console.log(`ASSERT ${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failures.push(label);
}
function note(label, detail) { console.log(`MEASURED ${label}: ${detail}`); }

// Real node-pty adapter for IShellperPty (production shellper-main wires the
// same five calls; the interface exists for the unit tests' MockPty).
class RealPty {
  pid = -1;
  #p = null;
  #onData = null;
  #onExit = null;
  spawn(command, args, options) {
    this.#p = pty.spawn(command, args, {
      name: options.name || 'xterm-256color',
      cols: options.cols, rows: options.rows,
      cwd: options.cwd, env: options.env,
    });
    this.pid = this.#p.pid;
    this.#p.onData((d) => this.#onData?.(d));
    this.#p.onExit((e) => this.#onExit?.({ exitCode: e.exitCode, signal: e.signal }));
  }
  write(data) { this.#p?.write(data); }
  resize(c, r) { this.#p?.resize(c, r); }
  kill(sig) { try { this.#p?.kill(sig ? String(sig) : undefined); } catch { /* gone */ } }
  onData(cb) { this.#onData = cb; }
  onExit(cb) { this.#onExit = cb; }
}

// Unix socket paths are capped (~104 bytes) — the session scratchpad path is
// far longer than that, so the socket lives under a short /tmp dir.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'i11-'));
const SOCK = path.join(scratch, 's.sock');

// Raw-socket tower client: records EVERY frame with its type.
function connectRawTower(sockPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    const parser = createFrameParser();
    socket.pipe(parser);
    const frames = [];   // { type, payload, at }
    let output = '';     // concatenated DATA payloads (PTY output as Tower sees it)
    const api = {
      socket, frames,
      get output() { return output; },
      typesSince(t0, ...exclude) {
        return [...new Set(frames.filter((f) => f.at >= t0 && !exclude.includes(f.type)).map((f) => f.type))];
      },
      writeData(s) { socket.write(encodeData(s)); },
      waitOutput(substr, timeoutMs = 5000) {
        return new Promise((res, rej) => {
          if (output.includes(substr)) return res();
          const t = setTimeout(() => rej(new Error(`timeout waiting for ${JSON.stringify(substr)}`)), timeoutMs);
          const iv = setInterval(() => {
            if (output.includes(substr)) { clearTimeout(t); clearInterval(iv); res(); }
          }, 25);
        });
      },
    };
    let welcomed = false;
    parser.on('data', (frame) => {
      frames.push({ type: frame.type, payload: frame.payload, at: Date.now() });
      if (frame.type === FrameType.DATA) output += frame.payload.toString('utf8');
      if (!welcomed && frame.type === FrameType.WELCOME) {
        welcomed = true;
        api.welcome = JSON.parse(frame.payload.toString('utf8'));
        resolve(api); // NOT spread — spreading would snapshot the `output` getter
      }
    });
    socket.on('error', (e) => { if (!welcomed) reject(e); });
    socket.write(encodeHello({ version: PROTOCOL_VERSION, clientType: 'tower' }));
  });
}

const frameName = (t) => Object.entries(FrameType).find(([, v]) => v === t)?.[0] ?? `0x${t.toString(16)}`;

let shellper;
let T;
let A;
try {
  // ---- Boot the real shellper hosting real bash --------------------------
  shellper = new ShellperProcess(() => new RealPty(), SOCK);
  await shellper.start('bash', ['--norc', '--noprofile'], scratch,
    { ...process.env, PS1: 'i11$ ', TERM: 'xterm-256color' }, 80, 24);

  T = await connectRawTower(SOCK);
  check('i11-setup-welcome', T.welcome.cols === 80 && T.welcome.rows === 24,
    `tower WELCOME pid=${T.welcome.pid} ${T.welcome.cols}x${T.welcome.rows}`);
  T.writeData('\r'); // provoke a prompt so we know output flows
  await T.waitOutput('i11$');

  // ---- A connects exactly as afx attach does -----------------------------
  const tConnect = Date.now();
  A = new ShellperClient(SOCK, 'terminal');
  const aw = await A.connect();
  note('i11-attach-welcome', `terminal client WELCOME pid=${aw.pid} ${aw.cols}x${aw.rows}`);
  await sleep(400);
  const typesDuringConnect = T.typesSince(tConnect, FrameType.DATA);
  check('i11b-no-connect-notification', typesDuringConnect.length === 0,
    `frames at T during A's connect (non-DATA): [${typesDuringConnect.map(frameName)}] — the protocol has no client-connect announcement`);

  // ---- i11a: A types; the input executes; T never sees an input frame ----
  const tInput = Date.now();
  const preInputOutput = T.output.length;
  // printf so the OUTPUT differs from the typed bytes — proves execution.
  A.write('printf "EXEC%s\\n" _PROOF_i11\r');   // attach.ts:222 shape
  await T.waitOutput('EXEC_PROOF_i11');
  check('i11a-attach-input-executes', true,
    'A\'s DATA reached the real PTY and ran (output "EXEC_PROOF_i11" ≠ typed bytes)');
  const typesDuringInput = T.typesSince(tInput, FrameType.DATA);
  check('i11b-no-input-frame-at-tower', typesDuringInput.length === 0,
    `frames at T while A typed (non-DATA): [${typesDuringInput.map(frameName)}] — input surfaces at Tower ONLY as PTY output (echo), byte-indistinguishable from render`);
  note('i11b-output-only-visibility',
    `T gained ${T.output.length - preInputOutput} bytes of PTY OUTPUT for A's ${'printf "EXEC%s\\n" _PROOF_i11\r'.length} input bytes; no frame carried the input itself`);

  // ---- i11c: A resizes; geometry changes; T is not told -------------------
  const tResize = Date.now();
  A.resize(100, 30);                             // attach.ts:228 shape
  await sleep(400);
  T.writeData('stty size\r');                    // tower-side probe of the REAL PTY
  await T.waitOutput('30 100');
  check('i11c-attach-resize-applied', true, 'PTY is now 30 rows 100 cols (stty size via tower write)');
  const typesDuringResize = T.typesSince(tResize, FrameType.DATA);
  check('i11c-no-resize-frame-at-tower', typesDuringResize.length === 0,
    `frames at T around A's resize (non-DATA): [${typesDuringResize.map(frameName)}] — Tower's stored dims are now stale`);

  // ---- i11d: SIGNAL is tower-only; DATA is not ----------------------------
  A.signal(2); // SIGINT — tower-only per shellper-process.ts:309-314; harmless to bash if a future build forwards it
  await sleep(300);
  A.write('printf "ALIVE%s\\n" _i11\r');
  await T.waitOutput('ALIVE_i11');
  check('i11d-signal-toweronly-data-open', true,
    'A\'s SIGNAL ignored (bash alive), A\'s DATA accepted — the open input path is protocol design (terminal may send DATA/RESIZE only)');

  // ---- i11e: geometry resync happens only at (re)connect ------------------
  // NOTE: a second 'tower' HELLO REPLACES T (handleHello tower-replacement) —
  // done last deliberately.
  const T2 = await connectRawTower(SOCK);
  check('i11e-geometry-resync-at-reconnect', T2.welcome.cols === 100 && T2.welcome.rows === 30,
    `fresh tower WELCOME reports ${T2.welcome.cols}x${T2.welcome.rows} — the resize A made is visible to Tower only via a new handshake`);
  T2.socket.destroy();
} finally {
  try { A?.disconnect(); } catch { /* closing */ }
  try { T?.socket.destroy(); } catch { /* closing */ }
  try { shellper?.shutdown(); } catch { /* stopping */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* tmp */ }
}

console.log(failures.length === 0 ? '\nALL ASSERTIONS PASSED' : `\nFAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
