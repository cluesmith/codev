#!/usr/bin/env node
// Tripwire: samples established TCP connections on a watched port (the owner's :4100 in a real
// run) and fails if any belongs to the harness's own process tree. It never connects to the
// watched port; it only reads the kernel's socket table through lsof.
//
// The harness's tree is: every PID recorded in the pids dir (one JSON file per process the harness
// launched), every process holding a Unix socket under the harness's socket dir (the shellpers,
// which can outlive their parent Tower), and all live descendants of both.
//
// The socket-holder scan is a machine-wide `lsof -U`, the costliest probe, so `watch` runs it on
// the first sample and then every `--socket-scan-every` samples. Shellpers are also descendants of
// the live isolated Tower, so the pid path covers them between scans.
//
//   node tripwire.mjs watch --port <n> --pids <dir> --marker <file> [--socket-prefix <path>]...
//                           [--interval <ms>] [--socket-scan-every <n>]
//
// On a hit it writes the marker (JSON: the offending pids and commands) and exits 3.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { descendants, isAlive, processTable, tcpOn, unixSocketHolders } from './procs.mjs';

export const TRIPWIRE_EXIT_CODE = 3;

/** PIDs recorded in `pidsDir` (files `<name>.json` holding `{ pid }`) that are still alive. */
export function recordedPids(pidsDir) {
  if (!fs.existsSync(pidsDir)) return [];
  const pids = [];
  for (const f of fs.readdirSync(pidsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(pidsDir, f), 'utf-8'));
      if (Number.isInteger(pid) && isAlive(pid)) pids.push(pid);
    } catch {
      // A pid file being written right now; the next sample reads it.
    }
  }
  return pids;
}

/**
 * The harness's process tree right now. `socketHolders`, when given, is a recent socket-holder
 * scan to reuse; otherwise the holders under `socketPrefixes` are scanned now.
 */
export function harnessTree({ pidsDir, socketPrefixes = [], socketHolders }) {
  const table = processTable();
  const roots = new Set(recordedPids(pidsDir));
  const holders = socketHolders ?? (socketPrefixes.length ? unixSocketHolders(socketPrefixes) : []);
  for (const pid of holders) roots.add(pid);
  return { tree: descendants(roots, table), table };
}

/** One sample: established connections on `port` owned by a process in the harness's tree. */
export function sample({ port, pidsDir, socketPrefixes = [], socketHolders }) {
  const { tree, table } = harnessTree({ pidsDir, socketPrefixes, socketHolders });
  const violations = tcpOn(port, 'ESTABLISHED')
    .filter((p) => tree.has(p.pid))
    .map((p) => ({ pid: p.pid, command: table.get(p.pid)?.command ?? p.command, sockets: p.names }));
  return { treeSize: tree.size, violations };
}

function parseArgs(argv) {
  const opts = { socketPrefixes: [], interval: 2000, socketScanEvery: 5 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--port') opts.port = Number(value);
    else if (flag === '--pids') opts.pidsDir = value;
    else if (flag === '--marker') opts.marker = value;
    else if (flag === '--socket-prefix') opts.socketPrefixes.push(value);
    else if (flag === '--interval') opts.interval = Number(value);
    else if (flag === '--socket-scan-every') opts.socketScanEvery = Number(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0) throw new Error('--port is required');
  if (!opts.pidsDir) throw new Error('--pids is required');
  if (!opts.marker) throw new Error('--marker is required');
  if (!Number.isInteger(opts.interval) || opts.interval <= 0) throw new Error('--interval must be a positive integer');
  if (!Number.isInteger(opts.socketScanEvery) || opts.socketScanEvery <= 0) throw new Error('--socket-scan-every must be a positive integer');
  return opts;
}

async function watch(opts) {
  const stamp = () => new Date().toISOString();
  console.log(`${stamp()} tripwire watching :${opts.port} for pids in ${opts.pidsDir} (+ socket holders under ${opts.socketPrefixes.join(', ') || 'none'})`);
  let samples = 0;
  let socketHolders = [];
  for (;;) {
    if (opts.socketPrefixes.length && samples % opts.socketScanEvery === 0) socketHolders = [...unixSocketHolders(opts.socketPrefixes)];
    const { treeSize, violations } = sample({ ...opts, socketHolders });
    samples++;
    if (violations.length) {
      const record = { at: stamp(), port: opts.port, samples, violations };
      fs.writeFileSync(opts.marker, `${JSON.stringify(record, null, 2)}\n`);
      console.log(`${stamp()} TRIPPED: ${JSON.stringify(violations)}`);
      process.exit(TRIPWIRE_EXIT_CODE);
    }
    if (samples % 30 === 1) console.log(`${stamp()} sample ${samples}: tree of ${treeSize}, no connection on :${opts.port}`);
    await new Promise((r) => setTimeout(r, opts.interval));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'watch') {
    console.error('usage: tripwire.mjs watch --port <n> --pids <dir> --marker <file> [--socket-prefix <path>]... [--interval <ms>] [--socket-scan-every <n>]');
    process.exit(64);
  }
  watch(parseArgs(rest)).catch((err) => {
    console.error(`tripwire error: ${err.stack ?? err}`);
    process.exit(1);
  });
}
