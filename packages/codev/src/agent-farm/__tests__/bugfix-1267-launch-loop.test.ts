/**
 * Bugfix #1267 — the builder launch loop must rerun *fresh* after a clean exit.
 *
 * The loop is generated bash, and the bug it had was a bash-level bug: a resumed
 * builder baked `<cmd> --resume <id>` in as the single command the `while true`
 * loop reran, so the Enter-gated relaunch after a deliberate quit resumed the
 * very conversation the user had just ended. String assertions on the generated
 * script would not have caught that (the string was "correct" — it was the loop
 * semantics that were wrong), so these tests **execute** the generated loop with
 * a fake agent and read back what was actually invoked, in what order.
 *
 * Deliberately unmocked: this file runs real bash against a real tmpdir. It is
 * the only place the loop's runtime behaviour is observable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLaunchLoop } from '../commands/spawn-worktree.js';
import { harnessFromLaunchScript } from '../commands/reset/context.js';

let dir: string;

/**
 * A stand-in for the harness binary: appends its argv to `argv.log` and exits
 * with the next code from `codes` (one per line), so a test can script an exact
 * sequence of clean exits and crashes.
 *
 * Arguments are logged one-per-`|` from `"$@"`, not as `"$*"`: the whole point
 * of one assertion below is that `"$(cat …)"` reaches the agent as a SINGLE
 * argument, and `"$*"` would join two arguments into text indistinguishable
 * from one.
 *
 * Running past the scripted codes exits 0, not `exit ""` (which bash rejects
 * with 255 — a *crash*, so the loop would auto-restart and spin until the
 * runner's timeout). A future regression that adds an unexpected relaunch
 * should surface as a wrong invocation list, not a 30-second hang.
 */
function writeFakeAgent(exitCodes: number[]): string {
  const agent = join(dir, 'fake-agent');
  writeFileSync(
    agent,
    `#!/bin/bash
{ printf '%s|' "$@"; printf '\\n'; } >> '${dir}/argv.log'
n=$(cat '${dir}/count')
echo $((n + 1)) > '${dir}/count'
code=$(sed -n "$((n + 1))p" '${dir}/codes')
exit "\${code:-0}"
`,
  );
  chmodSync(agent, '755');
  writeFileSync(join(dir, 'count'), '0\n');
  writeFileSync(join(dir, 'codes'), exitCodes.join('\n') + '\n');
  return agent;
}

/**
 * Run a generated loop to completion under bash, feeding `enterPresses`
 * newlines on stdin (stdin then hits EOF, which the loop treats as "terminal is
 * gone" and exits — that is what bounds the run).
 */
function runLoop(loop: string, enterPresses: number): string[] {
  const script = join(dir, 'start.sh');
  writeFileSync(script, `#!/bin/bash\ncd '${dir}'\n${loop}`);
  chmodSync(script, '755');
  execFileSync('bash', [script], {
    input: '\n'.repeat(enterPresses),
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 30_000,
    env: { ...process.env, TERM: 'dumb' },
  });
  const log = join(dir, 'argv.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf-8').split('\n').filter(Boolean);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codev-1267-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildLaunchLoop — clean exit reruns fresh (Bugfix #1267)', () => {
  it('relaunches with the FRESH command after a clean exit, not the resume one', () => {
    const agent = writeFakeAgent([0, 0]);
    const loop = buildLaunchLoop(`${agent} --resume 'abc-1234-uuid'`, `${agent} --fresh-args`);

    // One Enter → one relaunch; the second clean exit hits EOF and ends the run.
    const invocations = runLoop(loop, 1);

    expect(invocations).toEqual([
      '--resume|abc-1234-uuid|', // entry: recover the prior conversation
      '--fresh-args|',           // relaunch after the user quit: a NEW conversation
    ]);
  });

  it('keeps resuming across a CRASH — recovery is still what an unnatural exit wants', () => {
    const agent = writeFakeAgent([1, 0]);
    const loop = buildLaunchLoop(`${agent} --resume 'abc'`, `${agent} --fresh-args`);

    // Nonzero exit → auto-restart (no keypress), still resuming; the second run
    // exits cleanly and EOF ends it.
    const invocations = runLoop(loop, 0);

    expect(invocations).toEqual(['--resume|abc|', '--resume|abc|']);
  });

  it('the switch to fresh is sticky: a later crash restarts FRESH, not the abandoned session', () => {
    const agent = writeFakeAgent([0, 1, 0]);
    const loop = buildLaunchLoop(`${agent} --resume 'abc'`, `${agent} --fresh-args`);

    // clean exit → Enter → fresh → crash → auto-restart → fresh again → EOF.
    const invocations = runLoop(loop, 1);

    expect(invocations).toEqual(['--resume|abc|', '--fresh-args|', '--fresh-args|']);
  });

  it('EOF at the relaunch prompt exits without relaunching anything', () => {
    const agent = writeFakeAgent([0]);
    const loop = buildLaunchLoop(`${agent} --resume 'abc'`, `${agent} --fresh-args`);

    expect(runLoop(loop, 0)).toEqual(['--resume|abc|']);
  });

  it('preserves quoting in the fresh command (the reason it is a function, not a variable)', () => {
    const agent = writeFakeAgent([0, 0]);
    const promptFile = join(dir, 'prompt.txt');
    writeFileSync(promptFile, 'two words');
    const loop = buildLaunchLoop(
      `${agent} --resume 'abc'`,
      `${agent} --append-system-prompt "$(cat '${promptFile}')"`,
    );

    const invocations = runLoop(loop, 1);

    // One argument, not word-split into two: `two words|` and not `two|words|`.
    expect(invocations[1]).toBe('--append-system-prompt|two words|');
  });

  // `afx reset` refuses to type into a builder whose harness it cannot name, and
  // it names it by scanning `.builder-start.sh` for a command-position harness
  // binary. The dual-launcher shape adds `codev_launch=…` / `"$codev_launch"`
  // lines that scanner has never seen — this is the guard that they neither
  // shadow the real harness line nor get mistaken for one.
  it('stays identifiable to afx reset harness detection', () => {
    const loop = buildLaunchLoop(
      "claude --model opus --resume 'abc'",
      `claude --model opus --append-system-prompt "$(cat '/wt/.builder-role.md')"`,
    );
    const script = `#!/bin/bash\ncd "/wt"\n${loop}`;
    const fs = {
      exists: () => true,
      read: () => script,
      listDirs: () => null,
    };

    expect(harnessFromLaunchScript(fs, '/wt')).toBe('claude');
  });

  it('identical commands collapse to the historical single-command loop', () => {
    const agent = writeFakeAgent([0, 0]);
    const loop = buildLaunchLoop(`${agent} --same`, `${agent} --same`);

    expect(loop).not.toContain('codev_launch');
    expect(loop).toContain('while true; do');
    expect(runLoop(loop, 1)).toEqual(['--same|', '--same|']);
  });
});
