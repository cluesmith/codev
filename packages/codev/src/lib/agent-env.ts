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
 * ## Why this strips named families rather than the whole namespace
 *
 * The first version of this module denied `CLAUDE_CODE_*` wholesale and kept a
 * short allowlist, on the theory that a *missed marker* is worse than a missed
 * config var. The CMAP review (codex) rejected that, and checking the shipped
 * `claude` binary settled it: it reads **594** distinct `CLAUDE_CODE_*`
 * variables, and they are overwhelmingly configuration — provider selection
 * (`USE_BEDROCK`, `USE_VERTEX`, `USE_FOUNDRY`, `USE_MANTLE`,
 * `USE_ANTHROPIC_AWS`, `USE_GATEWAY`), the matching `SKIP_*_AUTH` switches,
 * credentials (`OAUTH_TOKEN`, `OAUTH_REFRESH_TOKEN`, `OAUTH_SCOPES`,
 * `CLIENT_CERT`), routing (`API_BASE_URL`, `PROXY_URL`, `HTTPS_PROXY`), and
 * policy (`MANAGED_SETTINGS_PATH`). No hand-maintained allowlist survives that,
 * and dropping any of them is not the harmless failure the original reasoning
 * assumed — it silently routes an agent at the wrong provider, or strips the
 * subscription credential and reroutes CMAP to the metered API (the #985 scar).
 *
 * So the rule is: **strip what is per-session identity, keep everything else.**
 * Identity is a small, stable, nameable set; configuration is not.
 *
 * The cost of that direction is real and worth stating plainly: a marker added
 * upstream that this list has not caught up with will pass through, and nothing
 * here will notice. `codev doctor`'s Tower Environment check is not a backstop
 * for that case — it classifies with this same list, so it is blind to exactly
 * what it would need to catch. Claude Code's own "transcript saving is off"
 * banner is the only real signal, and it is how #1219 was found in the first
 * place. Adding the new name here is the fix when that happens.
 */

/**
 * Whole families of per-session identity. Every variable Claude Code ships
 * under these prefixes describes *this* session — its id, its socket, its
 * bridge — and inheriting one into a different agent is always wrong.
 */
export const CLAUDE_SESSION_MARKER_PREFIXES: readonly string[] = [
  // SESSION_ID / _KIND / _LOG / _NAME / _ORIGIN / _ACCESS_TOKEN
  'CLAUDE_CODE_SESSION_',
  // REMOTE_SESSION_ID / _ORIGIN / _UUID
  'CLAUDE_CODE_REMOTE_SESSION_',
  // BRIDGE_SESSION_ID / _PROMPT_SHA256 / _OWNER_* / _MCP_CARRIER
  'CLAUDE_CODE_BRIDGE_',
  // MESSAGING_SOCKET / _TOKEN — a live socket path and its bearer token
  'CLAUDE_CODE_MESSAGING_',
];

/**
 * Individually named session markers that do not fall under a prefix family.
 *
 * `CLAUDECODE` was already being deleted ad hoc at each Tower spawn site; it
 * lives here now so there is one list rather than six copies of one `delete`.
 * `CHILD_SESSION`, `ENTRYPOINT` and `EXECPATH` are the nesting-detection triple
 * that #1219 is actually about.
 *
 * `CLAUDE_PID` sits outside the `CLAUDE_CODE_` namespace but belongs here on the
 * merits: the shipped binary builds its child environment as
 * `{CLAUDECODE:"1", CLAUDE_CODE_SESSION_ID:…, CLAUDE_CODE_CHILD_SESSION:"1",
 * CLAUDE_PID:String(process.pid)}` — one object literal, so it is identity by
 * construction, not by namespace. Nothing reads it for nesting detection; its
 * only reader is the `pkill` guard in the Bash tool's shell prelude, which
 * refuses a pattern matching the Claude CLI's own pid. An inherited stale value
 * points that guard at a dead or unrelated pid, which is its own small bug.
 *
 * `CLAUDE_EFFORT` is planted by that same function and is deliberately NOT here:
 * being planted by Claude Code is not the test — it carries a *setting* (the
 * effort level), not an identity, so it is configuration and passes through.
 */
export const CLAUDE_SESSION_MARKER_NAMES: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  // Not in the CLAUDE_CODE_ namespace, but planted by the same object literal
  // as CHILD_SESSION and set to `String(process.pid)` — see the note below.
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CLOUD_SESSION_ID',
  'CLAUDE_CODE_RESUME_FROM_SESSION',
  'CLAUDE_CODE_SPAWN_TIMESTAMP_MS',
  'CLAUDE_CODE_TRIGGER_ID',
  'CLAUDE_CODE_WORKER_EPOCH',
];

const MARKER_NAMES = new Set(CLAUDE_SESSION_MARKER_NAMES);

/** Whether `name` is a Claude Code session marker that must not reach an agent. */
export function isClaudeSessionMarker(name: string): boolean {
  if (MARKER_NAMES.has(name)) return true;
  return CLAUDE_SESSION_MARKER_PREFIXES.some((prefix) => name.startsWith(prefix));
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
