/**
 * PIR #1201 — does `kimi -c` continue the NEWEST session when a cwd has several?
 *
 * The whole crash-resume design rests on this. `kimi -c` is cwd-scoped, not
 * id-pinned, so "resume the conversation" is only well-defined if `-c` picks the
 * most recently updated session deterministically and without prompting. Finding 4
 * (architect review, 2026-08-09) additionally proposes comparing session IDENTITY
 * across a clean exit to keep a superseded conversation from being resurrected —
 * that comparison is meaningless unless `-c` targets the newest.
 *
 * The sibling probe (`pir-1201-kimi-continue-probe.mjs`) answered the *zero*-session
 * case (what `-c` does with nothing to continue). This answers the *many* case.
 *
 * Two independent oracles, because the model's answer alone is not proof:
 *   CONTENT  — each session is seeded with a distinct codeword; ask `-c` which one
 *              it was told, and see which session's memory answered.
 *   IDENTITY — snapshot every session's updatedAt before and after, and see which
 *              session directory the `-c` turn actually landed in. This is the
 *              authoritative one: it reads the store rather than trusting the model.
 *
 * Usage: node codev/spikes/pir-1201-kimi-continue-newest-probe.mjs
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

/** Every session recorded for `cwd`, with the fields discovery ranks on. */
function sessionsFor(cwd) {
  const root = join(KIMI_HOME, 'sessions');
  const found = [];
  if (!existsSync(root)) return found;
  for (const wd of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    let entries = [];
    try {
      entries = readdirSync(join(root, wd.name), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('session_'));
    } catch { continue; }
    for (const s of entries) {
      try {
        const st = JSON.parse(readFileSync(join(root, wd.name, s.name, 'state.json'), 'utf-8'));
        if ((st.cwd ?? st.workDir) === cwd) {
          found.push({ id: s.name, updatedAt: st.updatedAt ?? null, archived: st.archived === true });
        }
      } catch { /* unreadable */ }
    }
  }
  return found.sort((a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1));
}

function run(args, cwd, ms = 60000) {
  return new Promise((resolve) => {
    const term = pty.spawn('kimi', args, {
      name: 'xterm-256color', cols: 110, rows: 32, cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    let out = '';
    let done = false;
    const finish = (code) => { if (!done) { done = true; resolve({ out, code }); } };
    term.onData((d) => { out += d; });
    term.onExit(({ exitCode }) => finish(exitCode));
    setTimeout(() => { try { term.kill(); } catch { /* gone */ } finish(-1); }, ms);
  });
}

const cwd = mkdtempSync(join(tmpdir(), 'kimi-newest-'));
preTrust(cwd);
console.log(`cwd: ${cwd}\n`);

console.error('[probe] seeding session A (codeword ALPHA)…');
await run(['-p', 'Remember this codeword: ALPHA. Reply with only: OK'], cwd);
const afterA = sessionsFor(cwd);
console.log(`after A: ${JSON.stringify(afterA)}`);

// A visible gap so updatedAt ordering is unambiguous rather than a same-millisecond tie.
await new Promise((r) => setTimeout(r, 3000));

console.error('[probe] seeding session B (codeword BRAVO)…');
await run(['-p', 'Remember this codeword: BRAVO. Reply with only: OK'], cwd);
const afterB = sessionsFor(cwd);
console.log(`after B: ${JSON.stringify(afterB)}`);

if (afterB.length < 2) {
  console.log('\nINCONCLUSIVE: the cwd does not hold two sessions; cannot test the many case.');
  process.exit(2);
}
const newest = afterB[0].id;
const older = afterB[afterB.length - 1].id;
console.log(`\nnewest by updatedAt = ${newest}\noldest              = ${older}`);

console.error('[probe] running `kimi -c` and asking which codeword it holds…');
const before = new Map(afterB.map((s) => [s.id, s.updatedAt]));
const cont = await run(['-c', '-p', 'Which codeword were you told to remember? Reply with only that word.'], cwd);
const afterC = sessionsFor(cwd);

const answer = cont.out.includes('BRAVO') ? 'BRAVO' : cont.out.includes('ALPHA') ? 'ALPHA' : '(neither)';
const touched = afterC.filter((s) => (s.updatedAt ?? -1) > (before.get(s.id) ?? -1)).map((s) => s.id);
const created = afterC.filter((s) => !before.has(s.id)).map((s) => s.id);

console.log(`\nexit code        : ${cont.code}`);
console.log(`CONTENT oracle   : ${answer}   (BRAVO = newest, ALPHA = oldest)`);
console.log(`IDENTITY oracle  : touched=${JSON.stringify(touched)} created=${JSON.stringify(created)}`);
console.log(`after -c         : ${JSON.stringify(afterC)}`);

const continuedNewest = touched.includes(newest) && created.length === 0;
console.log(
  '\n' + (continuedNewest && answer === 'BRAVO'
    ? 'PREMISE HOLDS: `kimi -c` continued the NEWEST session, no prompt, no new session minted.'
    : created.length > 0
      ? `PREMISE BROKEN: \`kimi -c\` MINTED a new session (${created.join(',')}) instead of continuing one.`
      : `PREMISE BROKEN or AMBIGUOUS: content=${answer}, touched=${JSON.stringify(touched)}, expected newest=${newest}.`)
);
process.exit(0);
