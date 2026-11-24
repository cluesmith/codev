// Process and socket inspection for the cockpit harness: the process table, `lsof` readings,
// and kill-by-PID. Nothing here matches processes by name: every PID the harness acts on is one
// it started, a descendant of one, or one holding a socket in the harness's own socket dir.

import { spawnSync } from 'node:child_process';

/** Run a command synchronously; never throws for a non-zero exit. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${cmd} ${args.join(' ')} failed to run: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** pid → { ppid, command } for every process on the machine. */
export function processTable() {
  const r = run('ps', ['-A', '-o', 'pid=,ppid=,command=']);
  if (r.status !== 0) throw new Error(`ps failed: ${r.stderr}`);
  const table = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
  }
  return table;
}

/** The live members of `roots` plus all their live descendants. */
export function descendants(roots, table = processTable()) {
  const children = new Map();
  for (const [pid, { ppid }] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = new Set();
  const stack = [...roots].filter((pid) => table.has(pid));
  while (stack.length) {
    const pid = stack.pop();
    if (out.has(pid)) continue;
    out.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Parse `lsof -F p…n…` output into [{ pid, command, names[] }]. */
function parseLsofFields(stdout) {
  const procs = [];
  let cur = null;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      cur = { pid: Number(val), command: '', names: [] };
      procs.push(cur);
    } else if (cur && tag === 'c') {
      cur.command = val;
    } else if (cur && tag === 'n') {
      cur.names.push(val);
    }
  }
  return procs;
}

/** lsof exits 1 when nothing matches; anything else non-zero with no output is an error. */
function lsof(args) {
  const r = run('lsof', args);
  if (r.status !== 0 && r.status !== 1) throw new Error(`lsof ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  if (r.status === 1 && r.stdout.trim() === '') return [];
  return parseLsofFields(r.stdout);
}

/** Processes with a TCP socket on `port` (either end) in the given state. */
export function tcpOn(port, state) {
  return lsof(['-nP', `-iTCP:${port}`, `-sTCP:${state}`, '-Fpcn']);
}

/** PIDs listening on `port`. */
export function listenerPids(port) {
  return [...new Set(tcpOn(port, 'LISTEN').map((p) => p.pid))];
}

/** PIDs holding a Unix socket whose path starts with one of `prefixes`. */
export function unixSocketHolders(prefixes) {
  const out = new Set();
  for (const proc of lsof(['-U', '-Fpcn'])) {
    if (proc.names.some((n) => prefixes.some((p) => n.startsWith(p)))) out.add(proc.pid);
  }
  return out;
}

/** Paths of the regular files `pid` has open. */
export function openFiles(pid) {
  const procs = lsof(['-nP', '-p', String(pid), '-Fpcn']);
  return procs.flatMap((p) => p.names);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * SIGTERM every pid, wait up to `graceMs`, SIGKILL the rest, and return the pids still alive
 * afterwards (an empty array is a clean teardown).
 */
export async function killPids(pids, { graceMs = 5000 } = {}) {
  const targets = [...new Set(pids)].filter(isAlive);
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && targets.some(isAlive)) await sleep(200);
  for (const pid of targets.filter(isAlive)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  const killDeadline = Date.now() + 3000;
  while (Date.now() < killDeadline && targets.some(isAlive)) await sleep(100);
  return targets.filter(isAlive);
}
