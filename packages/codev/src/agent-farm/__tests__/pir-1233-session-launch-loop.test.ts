/**
 * PIR #1233 — the builder launch loop must RESUME the conversation after a
 * crash instead of replaying the spawn prompt into a fresh, amnesiac session.
 *
 * Like the #1267 suite, these tests execute the generated loop under real bash
 * with a fake agent that scripts an exact exit-code sequence, then assert on
 * the argv log — the loop is generated bash and its bugs are bash-level bugs.
 *
 * Layer caution (#1244 finding): the wrapper sees bash's 128+N for signal
 * deaths, while node-pty reports {exitCode: 0, signal}. Everything here runs
 * real bash and asserts wrapper-layer codes only; 137 below IS "SIGKILLed" as
 * the wrapper perceives it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSessionLaunchLoop,
  buildLaunchLoop,
  buildWorktreeLaunchScript,
  scriptSessionForms,
  CRASH_RESUME_NUDGE,
  SESSION_ID_EXPR,
} from '../commands/spawn-worktree.js';
import { CLAUDE_HARNESS, BUILTIN_HARNESSES } from '../utils/harness.js';
import { harnessFromLaunchScript } from '../commands/reset/context.js';

const SPAWN_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let dir: string;

/** Same fake-agent contract as the #1267 suite: argv appended to argv.log
 * (one `|`-separated line per invocation, from `"$@"` so argument boundaries
 * are observable), exit code scripted per invocation via `codes`. */
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

/** Build the session-aware loop the way startBuilderSession does for Claude,
 * but around the fake agent. Mirrors production command construction:
 * pinned = role-ish + pin + prompt, resume = bare + resume + nudge. */
function buildLoop(agent: string, opts?: { initial?: string; sessionId?: string }): string {
  const forms = scriptSessionForms(CLAUDE_HARNESS)!;
  const promptArg = `"$(cat '${dir}/prompt.txt')"`;
  return buildSessionLaunchLoop({
    sessionId: opts?.sessionId ?? SPAWN_ID,
    initial: opts?.initial,
    pinnedFresh: `'${agent}' ${forms.newSessionScriptFragment(SESSION_ID_EXPR)} ${promptArg}`,
    unpinnedFresh: `'${agent}' ${promptArg}`,
    resume: `'${agent}' ${forms.resumeScriptFragment(SESSION_ID_EXPR)} '${CRASH_RESUME_NUDGE}'`,
  });
}

function runLoop(loop: string, enterPresses: number, env?: Record<string, string>): string[] {
  const script = join(dir, 'start.sh');
  writeFileSync(script, `#!/bin/bash\ncd '${dir}'\n${loop}`);
  chmodSync(script, '755');
  execFileSync('bash', [script], {
    input: '\n'.repeat(enterPresses),
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 60_000,
    env: { ...process.env, TERM: 'dumb', ...env },
  });
  const log = join(dir, 'argv.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf-8').split('\n').filter(Boolean);
}

const argvOf = (line: string): string[] => line.split('|').filter(Boolean);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codev-1233-'));
  writeFileSync(join(dir, 'prompt.txt'), 'the spawn prompt');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PIR #1233 — crash restarts resume the conversation', () => {
  it('resumes the spawn-pinned session after an unnatural exit, with the nudge, instead of replaying the prompt', () => {
    const agent = writeFakeAgent([137, 0]);
    const invocations = runLoop(buildLoop(agent), 0);

    expect(invocations).toHaveLength(2);
    // First launch: pinned fresh, prompt as a SINGLE argument.
    expect(argvOf(invocations[0])).toEqual(['--session-id', SPAWN_ID, 'the spawn prompt']);
    // Crash restart: resume of the SAME id + nudge — no role, no prompt replay.
    expect(argvOf(invocations[1])).toEqual(['--resume', SPAWN_ID, CRASH_RESUME_NUDGE]);
  });

  it('persists the current session id to .builder-session-id', () => {
    const agent = writeFakeAgent([0]);
    runLoop(buildLoop(agent), 0);
    expect(readFileSync(join(dir, '.builder-session-id'), 'utf-8').trim()).toBe(SPAWN_ID);
  });

  it('relaunches FRESH after a clean exit (per #1267) but pinned to a newly minted id', () => {
    const agent = writeFakeAgent([0, 0]);
    const invocations = runLoop(buildLoop(agent), 1);

    expect(invocations).toHaveLength(2);
    const second = argvOf(invocations[1]);
    expect(second[0]).toBe('--session-id');
    expect(second[1]).not.toBe(SPAWN_ID);
    expect(second[1]).toMatch(UUID_RE);
    // Fresh means the prompt is replayed — a new conversation, not a resume.
    expect(second[2]).toBe('the spawn prompt');
    // The re-mint is persisted.
    expect(readFileSync(join(dir, '.builder-session-id'), 'utf-8').trim()).toBe(second[1]);
  });

  it('a crash after a clean-exit relaunch resumes the NEW conversation, never the superseded one', () => {
    const agent = writeFakeAgent([0, 137, 0]);
    const invocations = runLoop(buildLoop(agent), 1);

    expect(invocations).toHaveLength(3);
    const relaunchId = argvOf(invocations[1])[1];
    expect(relaunchId).not.toBe(SPAWN_ID);
    expect(argvOf(invocations[2])).toEqual(['--resume', relaunchId, CRASH_RESUME_NUDGE]);
  }, 15_000);

  it('degrades to a prompt-replay fresh launch under a new id after 3 consecutive fast resume failures', () => {
    // Fake agent exits instantly, so every failure is "fast" under the default
    // threshold: crash (1 fast fail) → resume (2) → resume (3 → degrade) →
    // pinned fresh with a NEW id and the prompt.
    const agent = writeFakeAgent([137, 1, 1, 0]);
    const invocations = runLoop(buildLoop(agent), 0);

    expect(invocations).toHaveLength(4);
    expect(argvOf(invocations[1])[0]).toBe('--resume');
    expect(argvOf(invocations[2])[0]).toBe('--resume');
    const fallback = argvOf(invocations[3]);
    expect(fallback[0]).toBe('--session-id');
    expect(fallback[1]).not.toBe(SPAWN_ID);
    expect(fallback[2]).toBe('the spawn prompt');
  }, 30_000); // real `sleep 2` between restarts

  it('failures slower than the threshold never trip the degrade fallback', () => {
    // CODEV_LAUNCH_FAST_FAIL_SECS=0 makes NO failure count as fast (elapsed < 0
    // is impossible), so even 4 consecutive crashes keep resuming — proving the
    // fallback is gated on the threshold, not on failure count alone.
    const agent = writeFakeAgent([137, 137, 137, 137, 0]);
    const invocations = runLoop(buildLoop(agent), 0, { CODEV_LAUNCH_FAST_FAIL_SECS: '0' });

    expect(invocations).toHaveLength(5);
    for (const line of invocations.slice(1)) {
      expect(argvOf(line)).toEqual(['--resume', SPAWN_ID, CRASH_RESUME_NUDGE]);
    }
  }, 30_000); // real `sleep 2` between restarts

  it('recover-path entry uses the provided initial command; a crash then resumes the discovered id with the nudge', () => {
    const agent = writeFakeAgent([137, 0]);
    const discovered = 'dddddddd-5555-6666-7777-888888888888';
    const loop = buildLoop(agent, {
      sessionId: discovered,
      initial: `'${agent}' --resume '${discovered}'`,
    });
    const invocations = runLoop(loop, 0);

    expect(invocations).toHaveLength(2);
    // Entry: the harness-discovered resume, no nudge (a human drives recover).
    expect(argvOf(invocations[0])).toEqual(['--resume', discovered]);
    // Crash restart: same conversation, now with the nudge.
    expect(argvOf(invocations[1])).toEqual(['--resume', discovered, CRASH_RESUME_NUDGE]);
  });

  it('EOF on stdin at the clean-exit gate exits without re-minting', () => {
    const agent = writeFakeAgent([0]);
    runLoop(buildLoop(agent), 0);
    // The spawn id — not a re-mint — is what remains persisted.
    expect(readFileSync(join(dir, '.builder-session-id'), 'utf-8').trim()).toBe(SPAWN_ID);
  });
});

describe('PIR #1233 — harness gating', () => {
  it('only the Claude harness offers script-form session support', () => {
    // Iterate the live roster rather than naming harnesses, so a retired or
    // added built-in (e.g. gemini's retirement, #1338) can't strand this test.
    for (const [name, harness] of Object.entries(BUILTIN_HARNESSES)) {
      if (name === 'claude') {
        expect(scriptSessionForms(harness)).toBeDefined();
      } else {
        expect(scriptSessionForms(harness)).toBeUndefined();
      }
    }
    expect(scriptSessionForms(CLAUDE_HARNESS)).toBeDefined();
  });

  it('claude renders pin/resume fragments around the caller-supplied id expression', () => {
    const forms = scriptSessionForms(CLAUDE_HARNESS)!;
    expect(forms.newSessionScriptFragment('"$codev_session_id"')).toBe('--session-id "$codev_session_id"');
    expect(forms.resumeScriptFragment('"$codev_session_id"')).toBe('--resume "$codev_session_id"');
  });

  it('session-less harnesses keep the historical single-command loop, byte for byte', () => {
    const command = `'/usr/bin/codex' -c model_instructions_file='/w/.builder-role.md'`;
    expect(buildLaunchLoop(command, command)).toBe(`while true; do
  ${command}
  status=$?
  if [ "$status" -eq 0 ]; then
    clear
    echo "Agent exited at your request. Press Enter to relaunch fresh, or close this terminal."
    read -r || exit 0
    continue
  fi
  echo ""
  echo "Agent exited (code $status). Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`);
  });
});

describe('PIR #1233 — downstream consumers of the generated script', () => {
  it('afx refresh still identifies the claude harness from the session-aware script', () => {
    const loop = buildLoop('claude');
    const script = `#!/bin/bash\ncd '${dir}'\n${loop}`;
    const fs = {
      exists: () => true,
      read: (path: string) => (path.endsWith('.builder-start.sh') ? script : null),
      listDirs: () => null,
    };
    expect(harnessFromLaunchScript(fs, dir)).toBe('claude');
  });

  it('the nudge prompt contains no single quotes (it is embedded single-quoted in bash)', () => {
    expect(CRASH_RESUME_NUDGE).not.toContain("'");
  });

  // Consultation follow-up: the worktree-mode (no-prompt) path gets the
  // session-aware loop too — asserted directly, not incidentally.
  it('buildWorktreeLaunchScript (claude, no role) generates the session-aware loop', () => {
    const script = buildWorktreeLaunchScript(dir, 'claude', null, dir);
    expect(script).toContain(`--session-id ${SESSION_ID_EXPR}`);
    expect(script).toContain('codev_launch_resume()');
    expect(script).toContain(CRASH_RESUME_NUDGE);
  });
});
