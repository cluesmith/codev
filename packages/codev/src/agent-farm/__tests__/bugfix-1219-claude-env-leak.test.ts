/**
 * Tower must not hand Claude Code session markers to the agents it spawns (#1219).
 *
 * Claude Code plants `CLAUDE_CODE_CHILD_SESSION` (and friends) into every
 * subprocess it creates. Tower is a daemon but inherits the env of whoever
 * started it, and starting Tower from inside a Claude session is routine. The
 * marker then cascades — Tower → shellper → agent claude — and every agent
 * believes it is a nested child session, so transcript saving is off and the
 * session **cannot be resumed**. The failure only surfaces at crash-recovery
 * time, which is why it needs a test rather than a habit.
 *
 * Before the fix, every Tower spawn site built `{ ...process.env }` and deleted
 * only `CLAUDECODE`, so each of the assertions below on a real spawn path failed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  sanitizeAgentEnv,
  findClaudeSessionMarkers,
  isClaudeSessionMarker,
  CLAUDE_CODE_ENV_ALLOWLIST,
} from '../../lib/agent-env.js';
import { checkTowerEnv, readProcessEnv, TOWER_ENV_RESTART_HINT } from '../../commands/doctor.js';

/** The marker set observed on a real contaminated Tower via `ps eww` (#1219). */
const OBSERVED_MARKERS = {
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: 'true',
  CLAUDE_CODE_SESSION_ID: 'abc-123',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_EXECPATH: '/opt/homebrew/bin/claude',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
  CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge-1',
};

describe('bugfix-1219 — sanitizeAgentEnv', () => {
  it('strips every session marker seen on a contaminated Tower', () => {
    const clean = sanitizeAgentEnv({ ...OBSERVED_MARKERS, PATH: '/usr/bin' });
    for (const key of Object.keys(OBSERVED_MARKERS)) {
      expect(clean, `${key} must not reach a spawned agent`).not.toHaveProperty(key);
    }
    expect(clean.PATH).toBe('/usr/bin');
  });

  it('strips markers Claude Code has not invented yet (deny-by-default)', () => {
    // The namespace is denied wholesale precisely so a marker added upstream
    // tomorrow does not silently reintroduce unresumable agents.
    const clean = sanitizeAgentEnv({ CLAUDE_CODE_SOME_FUTURE_MARKER: 'x' });
    expect(clean).toEqual({});
  });

  it('preserves CLAUDE_CODE_OAUTH_TOKEN so consult keeps subscription auth', () => {
    // #985: consult reads this from the agent's own env; stripping it silently
    // reroutes every CMAP review to the metered API.
    const clean = sanitizeAgentEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'sub-token',
      CLAUDE_CODE_CHILD_SESSION: 'true',
    });
    expect(clean).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sub-token' });
  });

  it('preserves every allowlisted config var', () => {
    const env = Object.fromEntries(CLAUDE_CODE_ENV_ALLOWLIST.map((k) => [k, 'v']));
    expect(sanitizeAgentEnv(env)).toEqual(env);
  });

  it('drops undefined-valued entries so the result is spawn-ready', () => {
    // NodeJS.ProcessEnv permits undefined values; node-pty rejects them.
    const clean = sanitizeAgentEnv({ SET: 'yes', UNSET: undefined });
    expect(clean).toEqual({ SET: 'yes' });
    expect(Object.keys(clean)).not.toContain('UNSET');
  });

  it('does not mutate the environment it is given', () => {
    const source = { ...OBSERVED_MARKERS };
    sanitizeAgentEnv(source);
    expect(source).toEqual(OBSERVED_MARKERS);
  });

  it('leaves unrelated CLAUDE_* names alone', () => {
    // CLAUDE_PID / CLAUDE_EFFORT are not in the CLAUDE_CODE_ namespace and are
    // not nesting markers; the fix must not overreach into them.
    expect(isClaudeSessionMarker('CLAUDE_PID')).toBe(false);
    expect(isClaudeSessionMarker('CLAUDE_EFFORT')).toBe(false);
    expect(isClaudeSessionMarker('ANTHROPIC_API_KEY')).toBe(false);
  });
});

describe('bugfix-1219 — findClaudeSessionMarkers', () => {
  it('names the markers present, sorted, and nothing else', () => {
    expect(findClaudeSessionMarkers({ ...OBSERVED_MARKERS, PATH: '/usr/bin' }))
      .toEqual(Object.keys(OBSERVED_MARKERS).sort());
  });

  it('reports none for a clean environment', () => {
    expect(findClaudeSessionMarkers({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 't' })).toEqual([]);
  });
});

/**
 * Source-level assertions on the spawn paths.
 *
 * The alternative — booting a Tower and a shellper to read `ps eww` on the
 * grandchild — is exactly the kind of non-deterministic test this repo already
 * confines to `.e2e.test.ts`. What actually regressed here is a *code shape*:
 * six sites each hand-rolled `{ ...process.env }` and deleted one variable. So
 * that shape is what gets pinned. If a site is refactored, this test fails loudly
 * and the refactorer has to reassert the invariant deliberately.
 */
const SPAWN_SITES = [
  'agent-farm/commands/tower.ts',       // the daemon itself
  'agent-farm/servers/tower-routes.ts', // builder terminals and workspace shells
  'agent-farm/servers/tower-instances.ts', // architect launch
  'agent-farm/servers/tower-terminals.ts', // architect reconnect / auto-restart
  'terminal/session-manager.ts',        // the shellper daemon
];

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf-8');
}

describe('bugfix-1219 — every Tower spawn path routes through the sanitizer', () => {
  for (const site of SPAWN_SITES) {
    it(`${site} sanitizes the env it spawns with`, () => {
      const src = readSource(site);
      expect(src, `${site} must import the shared sanitizer`).toMatch(/agent-env\.js'/);
      expect(src, `${site} must call sanitizeAgentEnv`).toContain('sanitizeAgentEnv(');
    });

    it(`${site} no longer hand-rolls a CLAUDECODE-only strip`, () => {
      // The pre-fix shape. Its absence is the regression guard: a new spawn site
      // copy-pasted from an old one would reintroduce the leak for everything
      // except CLAUDECODE.
      expect(readSource(site)).not.toMatch(/delete\s+\w+\[['"]CLAUDECODE['"]\]/);
    });
  }

  it('tower.ts daemonizes with a sanitized env, not raw process.env', () => {
    const src = readSource('agent-farm/commands/tower.ts');
    expect(src).toContain('env: sanitizeAgentEnv(process.env)');
    expect(src).not.toContain('env: process.env,');
  });
});

describe('bugfix-1219 — codev doctor surfaces a contaminated Tower', () => {
  it('warns, names the markers, and says how to fix it', () => {
    const result = checkTowerEnv(() => ({ PATH: '/usr/bin', ...OBSERVED_MARKERS }));
    expect(result.status).toBe('warn');
    expect(result.markers).toEqual(Object.keys(OBSERVED_MARKERS).sort());
    expect(result.summary).toContain('CLAUDE_CODE_CHILD_SESSION');
    expect(result.recommendation).toBe(TOWER_ENV_RESTART_HINT);
  });

  it('passes a clean Tower', () => {
    const result = checkTowerEnv(() => ({ PATH: '/usr/bin' }));
    expect(result.status).toBe('ok');
    expect(result.markers).toEqual([]);
  });

  it('skips rather than warns when no Tower is running', () => {
    const result = checkTowerEnv(() => null);
    expect(result.status).toBe('skipped');
    expect(result.recommendation).toBeUndefined();
  });
});

describe('bugfix-1219 — readProcessEnv', () => {
  it('reads a live process env without mistaking argv for variables', () => {
    // Self-check against this very process: `ps` is the only portable reader on
    // macOS (no /proc), and the argv-subtraction it depends on is the fragile
    // part. A `null` here means `ps` is unavailable or shaped differently on
    // this platform — the doctor check degrades to "skipped" in that case, so
    // the test does too rather than failing for an unrelated reason.
    const env = readProcessEnv(process.pid);
    if (env === null) return;

    expect(Object.keys(env), 'PATH should be readable from the live process').toContain('PATH');

    // The argv of a vitest worker is long and full of paths and flags; none of
    // it should have been parsed as an assignment. (Env *names* may legally
    // contain a `-` — npm sets `npm_package_bin_<name>` — so the check is on the
    // shapes argv contributes, not on POSIX-portable names.)
    for (const key of Object.keys(env)) {
      expect(key, `${key} looks like argv, not an env var name`).not.toMatch(/[/\s]|^-/);
    }
  });
});
