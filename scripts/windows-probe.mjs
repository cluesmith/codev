#!/usr/bin/env node
/**
 * Windows platform probe (Spec 1658, Phase 1).
 *
 * Measures the facts the native-Windows plan rests on, on the host it runs on,
 * and prints them as one JSON report. Not shipped in the package: it is run by
 * the on-demand `windows.yml` workflow (`probe` job) and by hand on a real
 * Windows machine.
 *
 * Usage:
 *   node scripts/windows-probe.mjs [--out report.json] [--deps] [--tower] [--tower-published latest]
 *   node scripts/windows-probe.mjs --survival start   # then close this terminal window
 *   node scripts/windows-probe.mjs --survival check   # from a new terminal
 *
 * Sections:
 *   host        OS, build, arch, Node version
 *   gitBash     Git for Windows bash candidates; the System32 bash.exe (WSL launcher) trap; jq
 *   pathext     PATH/PATHEXT resolution of the commands Codev spawns
 *   pipe        named-pipe listen/connect round trip carrying shellper-style HELLO/WELCOME frames
 *   census      inline PowerShell CIM Win32_Process latency (cold and warm) and field coverage
 *   portOwner   Get-NetTCPConnection port-owner lookup latency
 *   job         whether this process runs inside a job object, and its kill-on-close flag
 *   detached    a detached grandchild survives its launching process exiting
 *   deps        (--deps) native-dependency install behavior: prebuilt binary or node-gyp source build
 *   tower       (--tower) `afx tower start` from this checkout, with the tower log captured
 *   towerPublished (--tower-published <version|latest>) the same, from a global install of the
 *               published @cluesmith/codev into a throwaway prefix (the path users take)
 *
 * Every section catches its own errors, so one failure never hides the rest.
 */

import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function option(name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

async function section(name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    return { name, ok: true, ms: Date.now() - started, ...result };
  } catch (err) {
    let error = String(err);
    if (err && err.stack) error = String(err.stack);
    return { name, ok: false, ms: Date.now() - started, error };
  }
}

/** Run an inline Windows PowerShell 5.1 command (no script file, so execution policy does not apply). */
async function powershell(command, timeoutMs = 60_000) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

function lookupOnPath(command) {
  let exts = [''];
  if (isWin) exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';');
  const hits = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (existsSync(candidate)) hits.push(candidate);
    }
  }
  return hits;
}

function isSystem32(p) {
  const sys = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase();
  const lower = p.toLowerCase();
  return lower.startsWith(path.join(sys, 'system32').toLowerCase())
    || lower.startsWith(path.join(sys, 'sysnative').toLowerCase())
    || lower.includes('\\windowsapps\\');
}

// ---------------------------------------------------------------------------

async function probeHost() {
  let version = null;
  if (typeof os.version === 'function') version = os.version();
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    version,
    node: process.version,
    userprofile: process.env.USERPROFILE ?? null,
    home: process.env.HOME ?? null,
    comspec: process.env.COMSPEC ?? null,
    shell: process.env.SHELL ?? null,
  };
}

async function probeGitBash() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const standard = [
    path.join(programFiles, 'Git', 'bin', 'bash.exe'),
    path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].map((p) => ({ path: p, exists: existsSync(p) }));
  const onPath = lookupOnPath('bash').map((p) => ({ path: p, system32: isSystem32(p) }));
  const firstOnPathIsWslLauncher = onPath.length > 0 && onPath[0].system32;
  let version = null;
  let tools = null;
  const resolved = standard.find((c) => c.exists)?.path ?? onPath.find((c) => !c.system32)?.path ?? null;
  if (resolved) {
    const r = spawnSync(resolved, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    version = (r.stdout ?? '').split(/\r?\n/)[0] || null;
    // The generated .builder-start.sh mints session ids with uuidgen, else /proc/sys/kernel/random/uuid.
    const t = spawnSync(
      resolved,
      ['-c', 'for c in uuidgen jq sed grep head tail sort date curl git; do printf "%s=%s\\n" "$c" "$(command -v $c)"; done;'
        + ' printf "procUuid=%s\\n" "$(cat /proc/sys/kernel/random/uuid 2>/dev/null)"'],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );
    tools = Object.fromEntries(
      (t.stdout ?? '').split(/\r?\n/).filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  }
  return {
    override: process.env.CLAUDE_CODE_GIT_BASH_PATH ?? null,
    standard,
    onPath,
    firstOnPathIsWslLauncher,
    resolved,
    version,
    tools,
    jq: lookupOnPath('jq'),
  };
}

async function probePathext() {
  const commands = ['claude', 'codex', 'agy', 'afx', 'codev', 'npx', 'npm', 'gh', 'git', 'jq', 'codev-ide-server'];
  const out = {};
  for (const c of commands) out[c] = lookupOnPath(c);
  return { pathext: process.env.PATHEXT ?? null, resolved: out };
}

/** Frame: [1-byte type][4-byte BE length][payload], the shellper wire format. */
function frame(type, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

async function probePipe() {
  const HELLO = 0x08;
  const WELCOME = 0x09;
  let name = path.join(os.tmpdir(), `codev-probe-${process.pid}.sock`);
  if (isWin) name = `\\\\.\\pipe\\codev-probe-${os.userInfo().username}-${randomUUID()}`;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 5) return;
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) return;
      const type = buf.readUInt8(0);
      const hello = JSON.parse(buf.subarray(5, 5 + len).toString());
      if (type === HELLO && hello.secret === 'probe-secret') {
        sock.write(frame(WELCOME, { version: 1, pid: process.pid, sessionId: 'probe' }));
      } else {
        sock.destroy();
      }
    });
  });
  const listenStart = Date.now();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(name, resolve);
  });
  const listenMs = Date.now() - listenStart;
  try {
    const roundTrip = await new Promise((resolve, reject) => {
      const started = Date.now();
      const client = net.connect(name);
      const timer = setTimeout(() => { client.destroy(); reject(new Error('pipe round trip timed out')); }, 10_000);
      let buf = Buffer.alloc(0);
      client.on('connect', () => client.write(frame(HELLO, { version: 1, secret: 'probe-secret' })));
      client.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 5) return;
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) return;
        clearTimeout(timer);
        const welcome = JSON.parse(buf.subarray(5, 5 + len).toString());
        client.end();
        resolve({ ms: Date.now() - started, type: buf.readUInt8(0), welcome });
      });
      client.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    return { endpoint: name, listenMs, roundTrip };
  } finally {
    server.close();
  }
}

async function probeCensus() {
  if (!isWin) return { skipped: 'not win32' };
  const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,'
    + '@{n="CreationDate";e={$_.CreationDate.ToUniversalTime().ToString("o")}},WorkingSetSize'
    + ' | ConvertTo-Json -Compress';
  const runs = [];
  let sample = null;
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    const out = await powershell(query);
    runs.push(Date.now() - started);
    if (i === 0) {
      const parsed = JSON.parse(out);
      const list = [parsed].flat();
      const self = list.find((p) => p.ProcessId === process.pid) ?? null;
      sample = {
        count: list.length,
        withCommandLine: list.filter((p) => p.CommandLine).length,
        withCreationDate: list.filter((p) => p.CreationDate).length,
        self,
      };
    }
  }
  return { runsMs: runs, coldMs: runs[0], warmMs: Math.min(...runs.slice(1)), sample };
}

async function probePortOwner() {
  if (!isWin) return { skipped: 'not win32' };
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const started = Date.now();
    const out = await powershell(
      `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess`,
    );
    const owner = parseInt(out.trim().split(/\r?\n/)[0], 10);
    return { port, ms: Date.now() - started, owner, matchesSelf: owner === process.pid };
  } finally {
    server.close();
  }
}

async function probeJob() {
  if (!isWin) return { skipped: 'not win32' };
  // Add-Type needs FullLanguage mode; under Constrained Language Mode this fails, which is itself a finding.
  const script = `
$sig = @'
using System; using System.Runtime.InteropServices;
public static class J {
  [DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll")] public static extern bool QueryInformationJobObject(IntPtr j, int c, IntPtr info, int len, IntPtr ret);
}
'@
Add-Type -TypeDefinition $sig
$h = [J]::OpenProcess(0x1000, $false, ${process.pid})
$in = $false
[void][J]::IsProcessInJob($h, [IntPtr]::Zero, [ref]$in)
$info = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
$ok = [J]::QueryInformationJobObject([IntPtr]::Zero, 9, $info, 144, [IntPtr]::Zero)
$flags = if ($ok) { [Runtime.InteropServices.Marshal]::ReadInt32($info, 16) } else { $null }
@{ languageMode = $ExecutionContext.SessionState.LanguageMode.ToString(); inJob = $in; limitFlags = $flags } | ConvertTo-Json -Compress
`;
  // QueryInformationJobObject(NULL, ...) reports the job of the *calling* PowerShell process, which
  // inherits Node's job, so limitFlags reflects the job this probe runs in.
  const out = JSON.parse(await powershell(script));
  const KILL_ON_JOB_CLOSE = 0x2000;
  const BREAKAWAY_OK = 0x800;
  const SILENT_BREAKAWAY_OK = 0x1000;
  let killOnJobClose = null;
  let breakawayOk = null;
  if (out.limitFlags !== null) {
    killOnJobClose = Boolean(out.limitFlags & KILL_ON_JOB_CLOSE);
    breakawayOk = Boolean(out.limitFlags & (BREAKAWAY_OK | SILENT_BREAKAWAY_OK));
  }
  return { ...out, killOnJobClose, breakawayOk };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A detached grandchild must outlive the process that launched it. */
async function probeDetached() {
  const launcher = `
const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore', windowsHide: true });
c.unref();
process.stdout.write(String(c.pid));
process.exit(0);
`;
  const r = spawnSync(process.execPath, ['-e', launcher], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const pid = parseInt(r.stdout, 10);
  await new Promise((res) => setTimeout(res, 1500));
  const survived = Number.isFinite(pid) && isAlive(pid);
  if (survived) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  return { grandchildPid: pid, survivedLauncherExit: survived };
}

/** True when npm's output shows an install script falling back to a node-gyp source build. */
function sourceBuildAttempted(output) {
  return /node-gyp(\.js)?["']? (rebuild|configure|build)|gyp (info|ERR!|verb)/.test(output);
}

/**
 * Native dependency install behavior. Installs each pinned dependency into a scratch dir with
 * install-script output in the foreground, and reports whether a node-gyp source build was
 * attempted. (npm ignores `npm_config_node_gyp` for a dependency's own `node-gyp rebuild`, so the
 * output is the reliable signal.)
 */
async function probeDeps() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'packages', 'codev', 'package.json'), 'utf8'));
  const deps = ['node-pty', 'better-sqlite3'].map((n) => ({ name: n, range: pkg.dependencies[n] }));
  let npm = 'npm';
  if (isWin) npm = 'npm.cmd';
  const results = [];
  for (const dep of deps) {
    const dir = mkdtempSync(path.join(os.tmpdir(), `codev-probe-${dep.name}-`));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', private: true }));
    const started = Date.now();
    const r = spawnSync(
      npm,
      ['install', '--no-audit', '--no-fund', '--foreground-scripts', `${dep.name}@${dep.range}`],
      { cwd: dir, encoding: 'utf8', shell: isWin, windowsHide: true, timeout: 600_000 },
    );
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const installed = r.status === 0;
    let loads = null;
    let loadError = null;
    if (installed) {
      const l = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(dep.name)})`], { cwd: dir, encoding: 'utf8', windowsHide: true });
      loads = l.status === 0;
      if (!loads) loadError = (l.stderr ?? '').slice(-2000);
    }
    const v = spawnSync(npm, ['view', `${dep.name}@${dep.range}`, 'version', '--json'], { encoding: 'utf8', shell: isWin, windowsHide: true });
    let version = null;
    try { version = [JSON.parse(v.stdout)].flat().pop(); } catch { /* leave null */ }
    let prebuilds = null;
    const pbDir = path.join(dir, 'node_modules', dep.name, 'prebuilds');
    if (existsSync(pbDir)) prebuilds = readdirSync(pbDir);
    let npmTail = null;
    if (!installed) npmTail = output.slice(-3000);
    results.push({
      name: dep.name,
      range: dep.range,
      version,
      abi: process.versions.modules,
      installed,
      ms: Date.now() - started,
      sourceBuildAttempted: sourceBuildAttempted(output),
      loads,
      loadError,
      bundledPrebuilds: prebuilds,
      npmTail,
    });
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  // better-sqlite3 downloads prebuilds from its GitHub release; list which win32 targets exist.
  const sqlite = results.find((r) => r.name === 'better-sqlite3');
  if (sqlite?.version) {
    try {
      const res = await fetch(`https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v${sqlite.version}`);
      const body = await res.json();
      sqlite.releaseWin32Assets = (body.assets ?? []).map((a) => a.name).filter((n) => n.includes('win32'));
    } catch (e) {
      sqlite.releaseWin32Assets = `lookup failed: ${e}`;
    }
  }
  return { results };
}

/** A port nothing is listening on right now. */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Kill a process tree regardless of what `afx tower stop` managed. */
function killTree(pid) {
  if (!Number.isFinite(pid) || !isAlive(pid)) return false;
  if (isWin) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return true;
}

/**
 * Start a Tower with the given afx entry point, capture the outcome and the tower log, then stop
 * it. Isolated from any real install on the machine: a throwaway CODEV_AGENT_FARM_DIR (its own
 * global.db, owner lock and tower.log), a throwaway SHELLPER_SOCKET_DIR, and a free port instead
 * of 4100, so the probe never starts, stops, sweeps, or reconciles against a developer's running
 * Tower or its shellpers. If `afx tower stop` cannot stop it (it cannot on Windows today), the
 * daemon PID from the tower log is killed directly, so the probe never leaks a Tower.
 */
async function runIsolatedTower(afx) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'codev-probe-tower-'));
  const port = String(await freePort());
  // SHELLPER_SOCKET_DIR too: the boot-time orphan sweep is scoped by socket dir, so a shared
  // ~/.codev/run would let this empty-DB Tower treat a live install's shellpers as orphans.
  const env = { ...process.env, CODEV_AGENT_FARM_DIR: stateDir, SHELLPER_SOCKET_DIR: path.join(stateDir, 'run') };
  const logFile = path.join(stateDir, 'tower.log');
  const start = await new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [afx, 'tower', 'start', '--port', port], { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { killTree(child.pid); resolve({ timedOut: true, ms: Date.now() - started, output: out }); }, 120_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ timedOut: false, code, ms: Date.now() - started, output: out }); });
  });
  let towerLog = null;
  if (existsSync(logFile)) towerLog = readFileSync(logFile).toString();
  const stop = spawnSync(process.execPath, [afx, 'tower', 'stop', '--port', port], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  let daemonPid = null;
  const m = (towerLog ?? '').match(/Spawned tower server with PID (\d+)/);
  if (m) daemonPid = parseInt(m[1], 10);
  const daemonAliveAfterStop = daemonPid !== null && isAlive(daemonPid);
  if (daemonAliveAfterStop) killTree(daemonPid);
  await new Promise((res) => setTimeout(res, 500));
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* a just-killed daemon may still hold a handle */ }
  let logTail = null;
  if (towerLog) logTail = towerLog.slice(-12000);
  return {
    stateDir,
    port: Number(port),
    start: { ...start, output: start.output.slice(-6000) },
    towerLog: logTail,
    stop: { code: stop.status, output: `${stop.stdout ?? ''}${stop.stderr ?? ''}`.slice(-3000) },
    daemonPid,
    daemonAliveAfterStop,
  };
}

/** Tower from this checkout (requires packages/codev built). */
async function probeTower() {
  if (!existsSync(path.join(repoRoot, 'packages', 'codev', 'dist'))) {
    return { skipped: 'packages/codev is not built (run pnpm build first)' };
  }
  return runIsolatedTower(path.join(repoRoot, 'packages', 'codev', 'bin', 'afx.js'));
}

/**
 * Tower from the PUBLISHED package, installed globally into a throwaway prefix: the path a user
 * takes (`npm install -g @cluesmith/codev`), which the 2026-09-09 field test used.
 */
async function probeTowerPublished(spec) {
  const prefix = mkdtempSync(path.join(os.tmpdir(), 'codev-probe-global-'));
  let npm = 'npm';
  if (isWin) npm = 'npm.cmd';
  const started = Date.now();
  const r = spawnSync(
    npm,
    ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', '--foreground-scripts', `@cluesmith/codev@${spec}`],
    { encoding: 'utf8', shell: isWin, windowsHide: true, timeout: 900_000 },
  );
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const install = {
    spec,
    code: r.status,
    ms: Date.now() - started,
    sourceBuildAttempted: sourceBuildAttempted(output),
    tail: output.slice(-4000),
  };
  // npm's global layout: <prefix>/node_modules on Windows, <prefix>/lib/node_modules elsewhere.
  let pkgDir = path.join(prefix, 'lib', 'node_modules', '@cluesmith', 'codev');
  if (isWin) pkgDir = path.join(prefix, 'node_modules', '@cluesmith', 'codev');
  let version = null;
  if (existsSync(path.join(pkgDir, 'package.json'))) version = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
  let tower = null;
  if (r.status === 0) tower = await runIsolatedTower(path.join(pkgDir, 'bin', 'afx.js'));
  try { rmSync(prefix, { recursive: true, force: true }); } catch { /* best effort */ }
  return { install, version, tower };
}

// ---------------------------------------------------------------------------

function survivalStateFile() {
  const dir = path.join(os.homedir(), '.codev-probe');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'survival.json');
}

/**
 * Two-step launcher survival test for interactive launchers (Windows Terminal, PowerShell console,
 * VS Code terminal, SSH): `start` leaves a detached child behind; close the launcher; `check` from
 * a fresh one reports whether the child survived the launcher closing.
 */
function survival(mode) {
  const file = survivalStateFile();
  if (mode === 'start') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    let launcher = 'other/console';
    if (process.env.WT_SESSION) launcher = 'Windows Terminal';
    else if (process.env.TERM_PROGRAM === 'vscode') launcher = 'VS Code terminal';
    else if (process.env.SSH_CONNECTION) launcher = 'SSH';
    writeFileSync(file, JSON.stringify({ pid: child.pid, launcher, startedAt: new Date().toISOString() }));
    console.log(`Detached child ${child.pid} started from: ${launcher}.`);
    console.log('Now close this terminal window/tab, open a new one, and run: node scripts/windows-probe.mjs --survival check');
    return;
  }
  if (!existsSync(file)) {
    console.log('No survival test in progress. Run --survival start first.');
    process.exitCode = 1;
    return;
  }
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const survived = isAlive(state.pid);
  if (survived) {
    try { process.kill(state.pid); } catch { /* already gone */ }
  }
  rmSync(file, { force: true });
  console.log(JSON.stringify({ ...state, survivedLauncherClose: survived }, null, 2));
}

async function main() {
  const survivalMode = option('--survival');
  if (survivalMode) {
    survival(survivalMode);
    return;
  }
  const sections = [
    await section('host', probeHost),
    await section('gitBash', probeGitBash),
    await section('pathext', probePathext),
    await section('pipe', probePipe),
    await section('census', probeCensus),
    await section('portOwner', probePortOwner),
    await section('job', probeJob),
    await section('detached', probeDetached),
  ];
  if (flag('--deps')) sections.push(await section('deps', probeDeps));
  if (flag('--tower')) sections.push(await section('tower', probeTower));
  const published = option('--tower-published');
  if (published) sections.push(await section('towerPublished', () => probeTowerPublished(published)));
  const report = { generatedAt: new Date().toISOString(), sections };
  const json = JSON.stringify(report, null, 2);
  const out = option('--out');
  if (out) writeFileSync(out, json);
  console.log(json);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
