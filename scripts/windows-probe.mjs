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
 *   node scripts/windows-probe.mjs [--out report.json] [--tower] [--deps]
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
 *   deps        (--deps) native-dependency install behavior with a failing node-gyp stub
 *   tower       (--tower) `afx tower start` from this checkout, with the tower log captured
 *
 * Every section catches its own errors, so one failure never hides the rest.
 */

import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
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

/**
 * Native dependency install behavior. Installs each pinned dependency into a scratch dir with
 * `npm_config_node_gyp` pointing at a stub that records its invocation and fails, so a source-build
 * fallback is visible instead of silently succeeding on a machine that has a toolchain.
 */
async function probeDeps() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'packages', 'codev', 'package.json'), 'utf8'));
  const deps = ['node-pty', 'better-sqlite3'].map((n) => ({ name: n, range: pkg.dependencies[n] }));
  const results = [];
  for (const dep of deps) {
    const dir = mkdtempSync(path.join(os.tmpdir(), `codev-probe-${dep.name}-`));
    const marker = path.join(dir, 'node-gyp-invoked');
    const stub = path.join(dir, 'node-gyp-stub.js');
    writeFileSync(stub, `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.join(' ')); process.exit(1);\n`);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', private: true }));
    const started = Date.now();
    let npm = 'npm';
    if (isWin) npm = 'npm.cmd';
    const r = spawnSync(
      npm,
      ['install', '--no-audit', '--no-fund', `${dep.name}@${dep.range}`],
      {
        cwd: dir,
        encoding: 'utf8',
        shell: isWin,
        windowsHide: true,
        timeout: 600_000,
        env: { ...process.env, npm_config_node_gyp: stub },
      },
    );
    const installed = r.status === 0;
    let loads = null;
    let loadError = null;
    if (installed) {
      const l = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(dep.name)})`], { cwd: dir, encoding: 'utf8', windowsHide: true });
      loads = l.status === 0;
      if (!loads) loadError = (l.stderr ?? '').slice(-2000);
    }
    let version = null;
    let prebuilds = null;
    const depDir = path.join(dir, 'node_modules', dep.name);
    if (existsSync(path.join(depDir, 'package.json'))) {
      version = JSON.parse(readFileSync(path.join(depDir, 'package.json'), 'utf8')).version;
      const pbDir = path.join(depDir, 'prebuilds');
      if (existsSync(pbDir)) prebuilds = readdirSync(pbDir);
    }
    let nodeGypInvoked = false;
    if (existsSync(marker)) nodeGypInvoked = readFileSync(marker, 'utf8');
    let npmTail = null;
    if (!installed) npmTail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.slice(-3000);
    results.push({
      name: dep.name,
      range: dep.range,
      version,
      installed,
      ms: Date.now() - started,
      nodeGypInvoked,
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

/** Start Tower from this checkout (built), capture the outcome and the tower log, then stop it. */
async function probeTower() {
  const afx = path.join(repoRoot, 'packages', 'codev', 'bin', 'afx.js');
  if (!existsSync(path.join(repoRoot, 'packages', 'codev', 'dist'))) {
    return { skipped: 'packages/codev is not built (run pnpm build first)' };
  }
  const logFile = path.join(process.env.CODEV_AGENT_FARM_DIR ?? path.join(os.homedir(), '.agent-farm'), 'tower.log');
  let offset = 0;
  if (existsSync(logFile)) offset = statSync(logFile).size;
  const start = await new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [afx, 'tower', 'start'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ timedOut: true, ms: Date.now() - started, output: out }); }, 120_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ timedOut: false, code, ms: Date.now() - started, output: out }); });
  });
  let towerLog = null;
  if (existsSync(logFile)) towerLog = readFileSync(logFile).subarray(offset).toString().slice(-12000);
  const stop = spawnSync(process.execPath, [afx, 'tower', 'stop'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return {
    start: { ...start, output: start.output.slice(-6000) },
    towerLog,
    stop: { code: stop.status, output: `${stop.stdout ?? ''}${stop.stderr ?? ''}`.slice(-3000) },
  };
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
