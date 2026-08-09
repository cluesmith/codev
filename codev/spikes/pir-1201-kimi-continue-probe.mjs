/**
 * PIR #1201 — what does `kimi -c` do when there is NOTHING to continue?
 *
 * The pivot's crash path is `kimi -c --yolo` (documented, cwd-scoped) instead of
 * a pinned `-S <id>` from the undocumented store. That is only safe if a crash
 * BEFORE the first message — i.e. before 0.33.0's TUI has minted any session —
 * fails loudly rather than silently starting a **roleless** fresh conversation.
 * A silent roleless start is the #929 hazard class: the builder would run on with
 * no role and nobody would know.
 *
 * Checks:
 *   A. `kimi -c -p "…"` in a virgin cwd — exit code and message.
 *   B. Whether it minted a session in that cwd anyway (silent-fresh evidence).
 *   C. Whether that fallback session carries the role (it cannot: -c forbids
 *      --agent-file), i.e. how bad a silent fallback would be.
 *
 * Usage: node codev/spikes/pir-1201-kimi-continue-probe.mjs
 */

import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pty = require(join(repoRoot, 'packages/codev/node_modules/node-pty'));
const KIMI_HOME = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');

function preTrust(root) {
  const dir = join(KIMI_HOME, 'workspace-trust');
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  writeFileSync(join(dir, `wd_${basename(root).toLowerCase()}_${hash}`),
    JSON.stringify({ root, trustedAt: Date.now() }));
}

function sessionsFor(cwd) {
  const root = join(KIMI_HOME, 'sessions');
  const found = [];
  if (!existsSync(root)) return found;
  for (const wd of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const s of readdirSync(join(root, wd.name), { withFileTypes: true }).filter((e) => e.isDirectory())) {
      try {
        const st = JSON.parse(readFileSync(join(root, wd.name, s.name, 'state.json'), 'utf-8'));
        if ((st.cwd ?? st.workDir) === cwd) found.push(s.name);
      } catch { /* unreadable */ }
    }
  }
  return found;
}

function run(args, cwd) {
  return new Promise((resolve) => {
    const term = pty.spawn('kimi', args, {
      name: 'xterm-256color', cols: 110, rows: 32, cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    let out = '';
    term.onData((d) => { out += d; });
    term.onExit(({ exitCode }) => resolve({ out, exitCode }));
  });
}

const dir = mkdtempSync(join(tmpdir(), 'kimi-cont-'));
preTrust(dir);
console.log(`[probe] virgin cwd: ${dir}`);

const r = await run(['-c', '-p', 'Say READY and nothing else.'], dir);
console.log(`\n[A] exit code: ${r.exitCode}`);
console.log(`[A] output:\n${r.out.trim().slice(0, 1200)}`);

const after = sessionsFor(dir);
console.log(`\n[B] sessions minted in that cwd: ${after.length} ${JSON.stringify(after)}`);
console.log(
  r.exitCode !== 0
    ? '\nVERDICT: `-c` FAILS LOUDLY with nothing to continue → the launch loop\'s fast-fail degrade converts it to a fresh (role-carrying) relaunch. Safe.'
    : '\nVERDICT: `-c` SUCCEEDS with nothing to continue → it silently starts a conversation the role never reached. The loop must NOT enter on -c before a session exists.'
);
process.exit(0);
