/**
 * Environment sanitation for agent processes Tower spawns (Issue #1219).
 *
 * Claude Code plants session markers — `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
 * `CLAUDE_CODE_SESSION_ID`, … — into every subprocess it creates, so a nested
 * `claude` can tell it was launched from inside another session and turn
 * transcript saving off. Tower is a daemon, but it inherits the environment of
 * whoever started it, and starting Tower from inside a Claude session is routine
 * (`afx tower start`, `pnpm -w run local-install`, an architect recovering from a
 * crash). The markers then cascade:
 *
 *     claude session → Bash → afx tower start → Tower → shellper → agent claude
 *
 * Every agent Tower spawns believes it is a nested child session, and a session
 * with transcript saving off **cannot be resumed** — which quietly guts the
 * crash-recovery story (#1145, #1149) and only shows up at recovery time, when
 * it is too late.
 *
 * The rule here is deny-by-default over the `CLAUDE_CODE_*` namespace, so a
 * marker Claude Code adds tomorrow is stripped without a code change. That is
 * deliberate: a missed marker silently produces unresumable agents, while a
 * missed *config* var produces a loud or harmless difference. The allowlist
 * below is the escape hatch for the config/auth vars that genuinely must reach
 * an agent — `CLAUDE_CODE_OAUTH_TOKEN` above all, since `consult` reads it from
 * the agent's own env to route CMAP through the Claude subscription rather than
 * the metered API (#985).
 */

/**
 * `CLAUDE_CODE_*` variables that are configuration or credentials rather than
 * session identity, and so must survive into spawned agents.
 */
export const CLAUDE_CODE_ENV_ALLOWLIST: readonly string[] = [
  // Auth — stripping this downgrades subscription auth to the metered API (#985).
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Provider selection and its auth-skip switches.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  // Behavioural configuration a user sets deliberately in their shell rc.
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EXTRA_BODY',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
];

/**
 * Non-namespaced markers stripped alongside `CLAUDE_CODE_*`.
 *
 * `CLAUDECODE` was already being deleted ad hoc at each Tower spawn site; it
 * lives here now so there is one list rather than six copies of one `delete`.
 */
const EXTRA_SESSION_MARKERS: readonly string[] = ['CLAUDECODE'];

const ALLOWED = new Set(CLAUDE_CODE_ENV_ALLOWLIST);

/** Whether `name` is a Claude Code session marker that must not reach an agent. */
export function isClaudeSessionMarker(name: string): boolean {
  if (EXTRA_SESSION_MARKERS.includes(name)) return true;
  return name.startsWith('CLAUDE_CODE_') && !ALLOWED.has(name);
}

/**
 * Copy `env` with Claude Code session markers removed.
 *
 * Returns a plain `Record<string, string>` — `undefined`-valued entries (which
 * `NodeJS.ProcessEnv` permits and node-pty rejects) are dropped — so callers can
 * hand the result straight to a spawn call.
 */
export function sanitizeAgentEnv(
  env: NodeJS.ProcessEnv | Record<string, string> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isClaudeSessionMarker(key)) continue;
    out[key] = value;
  }
  return out;
}

/** The session markers present in `env`, for diagnostics (`codev doctor`). */
export function findClaudeSessionMarkers(
  env: NodeJS.ProcessEnv | Record<string, string> = process.env,
): string[] {
  return Object.keys(env).filter(isClaudeSessionMarker).sort();
}
