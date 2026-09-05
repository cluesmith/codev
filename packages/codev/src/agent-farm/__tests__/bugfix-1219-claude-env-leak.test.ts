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
} from '../../lib/agent-env.js';
import {
  checkTowerEnv,
  readProcessEnv,
  TOWER_ENV_RESTART_HINT,
  TOWER_ENV_SESSION_HINT,
} from '../../commands/doctor.js';

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

/**
 * Configuration and credentials that MUST survive into a spawned agent.
 *
 * Every name here was verified present in the shipped `claude` binary (2.1.261,
 * 594 `CLAUDE_CODE_*` variables). This list is the reason the module strips
 * named session families instead of denying the namespace: dropping any of these
 * silently points an agent at the wrong provider or strips its credential.
 */
const MUST_SURVIVE = {
  // Auth — stripping OAUTH_TOKEN downgrades subscription auth to the metered API (#985).
  CLAUDE_CODE_OAUTH_TOKEN: 'sub-token',
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh',
  CLAUDE_CODE_OAUTH_SCOPES: 'scope-a scope-b',
  CLAUDE_CODE_OAUTH_CLIENT_ID: 'client',
  // Provider selection — dropping one routes the agent at the wrong backend.
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  CLAUDE_CODE_USE_MANTLE: '1',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1',
  CLAUDE_CODE_USE_GATEWAY: '1',
  // Matching auth-skip switches.
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
  CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
  CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1',
  CLAUDE_CODE_SKIP_MANTLE_AUTH: '1',
  CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH: '1',
  // Routing, transport and policy.
  CLAUDE_CODE_API_BASE_URL: 'https://example.invalid',
  CLAUDE_CODE_PROXY_URL: 'http://proxy.invalid',
  CLAUDE_CODE_HTTPS_PROXY: 'http://proxy.invalid',
  CLAUDE_CODE_CLIENT_CERT: '/etc/cert.pem',
  CLAUDE_CODE_MANAGED_SETTINGS_PATH: '/etc/claude/settings.json',
  // Behavioural configuration a user sets deliberately in their shell rc.
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
  CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

describe('bugfix-1219 — sanitizeAgentEnv', () => {
  it('strips every session marker seen on a contaminated Tower', () => {
    const clean = sanitizeAgentEnv({ ...OBSERVED_MARKERS, PATH: '/usr/bin' });
    for (const key of Object.keys(OBSERVED_MARKERS)) {
      expect(clean, `${key} must not reach a spawned agent`).not.toHaveProperty(key);
    }
    expect(clean.PATH).toBe('/usr/bin');
  });

  it('strips whole session-identity families, not just the names seen so far', () => {
    const clean = sanitizeAgentEnv({
      CLAUDE_CODE_SESSION_KIND: 'interactive',
      CLAUDE_CODE_SESSION_LOG: '/tmp/s.log',
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'tok',
      CLAUDE_CODE_REMOTE_SESSION_UUID: 'uuid',
      CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID: 'org',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/m.sock',
    });
    expect(clean).toEqual({});
  });

  it('preserves provider, auth and routing configuration', () => {
    // The regression the CMAP review caught: an earlier version denied the whole
    // `CLAUDE_CODE_*` namespace, which would have dropped every one of these.
    // Each name is verified present in the shipped claude binary.
    const clean = sanitizeAgentEnv({ ...MUST_SURVIVE, ...OBSERVED_MARKERS });
    expect(clean).toEqual(MUST_SURVIVE);
  });

  it('preserves an unrecognised CLAUDE_CODE_* variable', () => {
    // 594 variables and counting: a name this module has never heard of is far
    // more likely to be new configuration than a new session marker, and
    // silently dropping configuration is the worse failure.
    const clean = sanitizeAgentEnv({ CLAUDE_CODE_SOME_FUTURE_SETTING: 'x' });
    expect(clean).toEqual({ CLAUDE_CODE_SOME_FUTURE_SETTING: 'x' });
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
    expect(findClaudeSessionMarkers({ PATH: '/usr/bin', ...MUST_SURVIVE })).toEqual([]);
  });
});

/**
 * Source-level assertions on the spawn paths.
 *
 * The alternative — booting a Tower and a shellper to read `ps eww` on the
 * grandchild — is exactly the kind of non-deterministic test this repo already
 * confines to `.e2e.test.ts`. What actually regressed here is a *code shape*:
 * seven sites across six files each hand-rolled `{ ...process.env }` and deleted
 * one variable. So that shape is what gets pinned.
 *
 * Both the count and the negative matter (CMAP review): asserting only that a
 * file mentions `sanitizeAgentEnv` somewhere would let ONE of `tower-routes.ts`'s
 * four spawn sites revert while the other three keep the test green. The count
 * catches a removal, and `FORBIDDEN` catches the specific shape a reverted or
 * copy-pasted site would take.
 */
const SPAWN_SITES: Array<{ file: string; calls: number; what: string }> = [
  { file: 'agent-farm/commands/tower.ts', calls: 1, what: 'the daemon itself' },
  { file: 'agent-farm/servers/tower-routes.ts', calls: 4, what: 'builder terminals + workspace shells, and both non-persistent fallbacks' },
  { file: 'agent-farm/servers/tower-instances.ts', calls: 2, what: 'architect launch: main + siblings' },
  { file: 'agent-farm/servers/tower-terminals.ts', calls: 2, what: 'architect reconnect: startup reconcile + on-the-fly' },
  { file: 'agent-farm/servers/tower-cron.ts', calls: 1, what: 'cron tasks, which may launch an agent' },
  { file: 'terminal/session-manager.ts', calls: 1, what: 'the shellper daemon' },
];

/** The shapes a reverted or copy-pasted spawn site would take. */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /env: process\.env\b/, why: 'spawns with the raw inherited environment' },
  { pattern: /\{\s*\.\.\.process\.env\b/, why: 'spreads the raw inherited environment' },
  { pattern: /\.\.\.\(env \|\| process\.env\)/, why: 'spreads the raw inherited environment' },
  { pattern: /delete\s+\w+\[['"]CLAUDECODE['"]\]/, why: 'hand-rolls the old CLAUDECODE-only strip' },
];

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf-8');
}

describe('bugfix-1219 — every Tower spawn path routes through the sanitizer', () => {
  for (const { file, calls, what } of SPAWN_SITES) {
    it(`${file} sanitizes all ${calls} of its spawn env(s) — ${what}`, () => {
      const src = readSource(file);
      expect(src, `${file} must import the shared sanitizer`).toMatch(/agent-env\.js'/);
      // Count, not mere presence: one site reverting inside a multi-site file
      // must fail even while its siblings still call the sanitizer.
      const actual = src.match(/sanitizeAgentEnv\(/g)?.length ?? 0;
      expect(actual, `${file} should call sanitizeAgentEnv() ${calls}x (${what})`).toBe(calls);
    });

    it(`${file} keeps no raw-environment spawn shape`, () => {
      const src = readSource(file);
      for (const { pattern, why } of FORBIDDEN) {
        expect(src, `${file} ${why} (${pattern})`).not.toMatch(pattern);
      }
    });
  }
});

describe('bugfix-1219 — codev doctor surfaces a contaminated Tower', () => {
  const clean = () => ({ PATH: '/usr/bin' });

  it('warns, names the markers, and says how to fix it', () => {
    const result = checkTowerEnv(() => ({ PATH: '/usr/bin', ...OBSERVED_MARKERS }));
    expect(result.status).toBe('warn');
    expect(result.markers).toEqual(Object.keys(OBSERVED_MARKERS).sort());
    expect(result.summary).toContain('CLAUDE_CODE_CHILD_SESSION');
    expect(result.recommendation).toBe(TOWER_ENV_RESTART_HINT);
  });

  it('passes a clean Tower with clean sessions', () => {
    const result = checkTowerEnv(clean, () => [clean(), clean()]);
    expect(result.status).toBe('ok');
    expect(result.markers).toEqual([]);
    expect(result.contaminatedSessions).toBe(0);
  });

  it('skips rather than warns when no Tower is running', () => {
    const result = checkTowerEnv(() => null);
    expect(result.status).toBe('skipped');
    expect(result.recommendation).toBeUndefined();
  });

  it('still warns when Tower is clean but its earlier sessions are not', () => {
    // The false negative the CMAP review caught: shellpers are detached and
    // survive `afx tower stop` by design, so after a plain restart a
    // daemon-only check reports "clean" while the agents spawned by the
    // contaminated Tower are still running and still unresumable.
    const result = checkTowerEnv(clean, () => [
      { ...clean(), CLAUDE_CODE_CHILD_SESSION: 'true' },
      clean(),
      { ...clean(), CLAUDE_CODE_SESSION_ID: 'abc' },
    ]);
    expect(result.status).toBe('warn');
    expect(result.markers).toEqual([]);
    expect(result.contaminatedSessions).toBe(2);
    expect(result.summary).toContain('2 running session(s)');
    expect(result.recommendation).toBe(TOWER_ENV_SESSION_HINT);
  });

  it('reports contaminated sessions alongside a contaminated Tower', () => {
    const result = checkTowerEnv(
      () => ({ ...clean(), ...OBSERVED_MARKERS }),
      () => [{ ...clean(), CLAUDE_CODE_CHILD_SESSION: 'true' }],
    );
    expect(result.status).toBe('warn');
    expect(result.contaminatedSessions).toBe(1);
    expect(result.summary).toContain('1 running session(s) already carry them');
  });

  it('never tells the user a plain Tower restart is sufficient on its own', () => {
    // `afx tower stop` deliberately leaves shellpers running, so a hint that
    // stopped at "restart Tower" would read as a full fix and would not be one.
    expect(TOWER_ENV_RESTART_HINT).toContain('restart each affected agent');
    expect(TOWER_ENV_RESTART_HINT).toContain('leaves existing shellper sessions running');
    expect(TOWER_ENV_SESSION_HINT).toContain('restart each affected agent');
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
