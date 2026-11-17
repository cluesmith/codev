/**
 * The installed `claude` CLI, as consult's claude lane and `codev doctor` see it (#1912).
 *
 * Everything decided *before* a review is spawned lives here:
 *
 * - which binary runs, and that it meets the version floor
 * - which auth mode applies, and what the child's environment is
 * - whether the CLI reports a login
 * - the `[CLAUDE] binary:` and `[CLAUDE] auth:` lines
 *
 * The lane runs the user's own `claude` rather than a copy bundled with an SDK, so upgrading
 * `claude` upgrades the lane and there is nothing to drift (#1906). It fails fast: a missing or
 * too-old binary, a missing login or a missing key is an error that says what to do. It never falls
 * back to another binary or another credential.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isClaudeSessionMarker } from './agent-env.js';
import { assertClaudeLaneAllowedUnderTest } from './test-env.js';
import { loadConfig, findConfigSource } from './config.js';
import type { ClaudeAuthMode } from './consult-lanes.js';

export type { ClaudeAuthMode } from './consult-lanes.js';

/**
 * The oldest `claude` the lane accepts.
 *
 * 2.1.141 is the oldest CLI verified to run the shipped default `claude-opus-5` on both auth paths
 * (PR #1907's matrix). 2.1.105 got an API 400 on the API-key path only, while a stored login
 * worked. One floor for both modes is simpler than a per-mode floor. Every flag the lane passes is
 * already present at 2.1.105, so model compatibility is what sets this number. Any flag added to
 * the lane later must be verified at this version, or this constant raised in the same commit.
 */
export const CLAUDE_MIN_VERSION = '2.1.141';

/** Pins the binary the lane runs. Mirrors `CODEV_AGY_BIN`. */
export const CLAUDE_BIN_ENV = 'CODEV_CLAUDE_BIN';

export const CLAUDE_INSTALL_HINT = 'curl -fsSL https://claude.ai/install.sh | bash';

/**
 * How to update `claude`, for both install routes: `claude update` serves the native installer, and an
 * npm-installed `claude` is updated through npm. A sentence fragment, so callers end it.
 */
export const CLAUDE_UPDATE_HINT =
  'Update claude: `claude update` for the native install, or ' +
  '`npm install -g @anthropic-ai/claude-code@latest` for an npm install';

/** The credentials that bill the metered Anthropic API, withheld from the child in `login` mode. */
export const CLAUDE_API_CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * Claude Code's authentication precedence, highest first: a cloud-provider switch (in the order the
 * CLI resolves them), then these credential variables, then the stored login (keychain /
 * credentials file). The provider switches pass through in every mode: they are explicit
 * enterprise configuration, and silently dropping configuration is the #985/#1219 scar.
 */
export const CLAUDE_PROVIDER_SWITCHES = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_VERTEX',
];
export const CLAUDE_CREDENTIAL_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** `--version` and `auth status` are local and fast (~40 ms, ~0.2 s); this only bounds a hang. */
const CLAUDE_PREFLIGHT_TIMEOUT_MS = 30_000;

const EXCERPT_MAX_CHARS = 200;

/** `text`, trimmed, capped at 200 characters and JSON-quoted, for quoting CLI output in an error. */
export function excerpt(text: string): string {
  const trimmed = text.trim();
  return JSON.stringify(trimmed.length > EXCERPT_MAX_CHARS ? `${trimmed.slice(0, EXCERPT_MAX_CHARS)}…` : trimmed);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What went wrong with an `execFileSync` call, in one clause: errno, signal, or exit code + stderr. */
function describeExecFailure(err: unknown): string {
  const e = err as { code?: unknown; signal?: unknown; status?: unknown; stderr?: unknown };
  if (e.code === 'ETIMEDOUT') return `no answer within ${CLAUDE_PREFLIGHT_TIMEOUT_MS / 1000}s`;
  if (typeof e.code === 'string') return e.code;
  if (typeof e.signal === 'string') return `killed by ${e.signal}`;
  const stderr = typeof e.stderr === 'string' && e.stderr.trim() ? `: ${excerpt(e.stderr)}` : '';
  if (typeof e.status === 'number') return `exit ${e.status}${stderr}`;
  return errorText(err);
}

/** `KEY (from .env)` or `KEY (from shell)`. */
export function credentialOrigin(key: string, fromDotenv: ReadonlySet<string>): string {
  return `${key} (from ${fromDotenv.has(key) ? '.env' : 'shell'})`;
}

// ---------------------------------------------------------------------------
// Binary and version
// ---------------------------------------------------------------------------

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `claude` binary the lane runs.
 *
 * `CODEV_CLAUDE_BIN` wins when set; a pinned path that is not an executable file is an error, never
 * a reason to try `PATH`. A relative pin is resolved against consult's cwd here, so the review,
 * which runs with `cwd` = the workspace, spawns the same file that was checked. Otherwise `claude`
 * is found by walking `PATH`, without executing anything.
 *
 * `env` is where the pin and `PATH` are read. Consult has already merged `<workspace>/.env` into
 * `process.env` by now; `codev doctor` passes its merged copy, so both resolve the same binary.
 */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env[CLAUDE_BIN_ENV];
  if (pinned) {
    if (!isExecutableFile(pinned)) {
      throw new Error(
        `${CLAUDE_BIN_ENV}=${pinned} is not an executable file. Point ${CLAUDE_BIN_ENV} at the ` +
        `claude binary, or unset it to use the claude on PATH. Codev does not fall back to PATH ` +
        `when a pinned binary is unusable.`
      );
    }
    return path.resolve(pinned);
  }

  // Past this point we go looking for the developer's real install, so this is the chokepoint for
  // the test-isolation guard (#1323), as `resolveAgyBin` is for agy.
  assertClaudeLaneAllowedUnderTest();

  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new Error(
    `The claude CLI was not found on PATH. The claude review lane runs your installed claude. ` +
    `Install it with \`${CLAUDE_INSTALL_HINT}\`, or set ${CLAUDE_BIN_ENV} to its absolute path.`
  );
}

/** `bin --version`, parsed to `MAJOR.MINOR.PATCH` (`2.1.326 (Claude Code)` → `2.1.326`). */
export function readClaudeVersion(bin: string): string {
  let out: string;
  try {
    out = execFileSync(bin, ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLAUDE_PREFLIGHT_TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(`Cannot run \`${bin} --version\` (${describeExecFailure(err)}).`);
  }
  const match = /^\s*(\d+\.\d+\.\d+)/.exec(out);
  if (!match) {
    throw new Error(
      `Unparseable output from \`${bin} --version\`: ${excerpt(out)}. Expected a version such as ` +
      `"2.1.326 (Claude Code)". ${CLAUDE_UPDATE_HINT}.`
    );
  }
  return match[1];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function assertClaudeVersion(version: string): void {
  // `readClaudeVersion` only returns this shape, but a malformed string would otherwise compare as
  // NaN and pass the floor check.
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Malformed claude version ${excerpt(version)}: expected MAJOR.MINOR.PATCH. ${CLAUDE_UPDATE_HINT}.`);
  }
  if (compareVersions(version, CLAUDE_MIN_VERSION) < 0) {
    throw new Error(
      `claude ${version} is older than ${CLAUDE_MIN_VERSION}, the oldest version the claude review ` +
      `lane supports. ${CLAUDE_UPDATE_HINT}.`
    );
  }
}

// ---------------------------------------------------------------------------
// Auth mode and the child environment
// ---------------------------------------------------------------------------

/**
 * `consult.claudeAuth`, defaulting to `login`. `source` is the config file that set it (null for
 * the default), so the auth line can name it. Every config layer counts, like every `consult.*` key.
 */
export function resolveClaudeAuthMode(workspaceRoot: string): { mode: ClaudeAuthMode; source: string | null } {
  const configured = loadConfig(workspaceRoot).consult?.claudeAuth;
  if (configured === undefined) return { mode: 'login', source: null };
  return { mode: configured, source: findConfigSource(workspaceRoot, ['consult', 'claudeAuth']) };
}

/**
 * The environment the `claude` child runs with. A copy: `processEnv` is never mutated.
 *
 * - Claude Code session markers (`lib/agent-env.ts`, `CLAUDECODE` included) are dropped, so the
 *   lane works from inside a Claude Code session, which is the normal case.
 * - In `login` mode `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are dropped too; `withheld` names
 *   the ones that carried a value, for the auth line.
 * - Everything else passes through, including `CLAUDE_CODE_OAUTH_TOKEN` (a subscription login, not
 *   API billing), the provider switches and `ANTHROPIC_BASE_URL` / proxy settings.
 */
export function buildClaudeChildEnv(
  processEnv: NodeJS.ProcessEnv,
  mode: ClaudeAuthMode,
): { env: Record<string, string>; withheld: string[] } {
  const apiCredentials: readonly string[] = CLAUDE_API_CREDENTIAL_VARS;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    if (isClaudeSessionMarker(key)) continue;
    if (mode === 'login' && apiCredentials.includes(key)) continue;
    env[key] = value;
  }
  const withheld = mode === 'login' ? apiCredentials.filter((key) => processEnv[key]) : [];
  return { env, withheld };
}

/** In `api-key` mode, require a key, before anything is spawned. */
export function assertApiKeyPresent(
  env: Record<string, string>,
  mode: ClaudeAuthMode,
  modeSource: string | null = null,
): void {
  if (mode !== 'api-key') return;
  if (CLAUDE_API_CREDENTIAL_VARS.some((key) => env[key])) return;
  throw new Error(
    `consult.claudeAuth is "api-key"${modeSource ? ` (set in ${modeSource})` : ''}, but neither ` +
    `ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set in the shell or <workspace>/.env. Set one ` +
    `of them, or remove consult.claudeAuth to use your claude login.`
  );
}

// ---------------------------------------------------------------------------
// Login state
// ---------------------------------------------------------------------------

/**
 * The fields of `claude auth status --json` the lane depends on. `email`, `orgId` and `orgName`
 * are deliberately absent: they are never returned or logged.
 */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider?: string;
  subscriptionType?: string;
  apiKeySource?: string;
}

const OPTIONAL_STATUS_FIELDS = ['apiProvider', 'subscriptionType', 'apiKeySource'] as const;

function parseClaudeAuthStatus(bin: string, stdout: string): ClaudeAuthStatus {
  const unparseable = (why: string) => new Error(
    `Unparseable output from \`${bin} auth status --json\` (${why}): ${excerpt(stdout)}. ` +
    `${CLAUDE_UPDATE_HINT}, then run \`claude auth status\`.`
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw unparseable('not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw unparseable('not a JSON object');
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.loggedIn !== 'boolean') throw unparseable('loggedIn is not a boolean');
  if (typeof raw.authMethod !== 'string') throw unparseable('authMethod is not a string');

  const status: ClaudeAuthStatus = { loggedIn: raw.loggedIn, authMethod: raw.authMethod };
  for (const field of OPTIONAL_STATUS_FIELDS) {
    const value = raw[field];
    // Display-only fields: absent or null both mean "not reported".
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw unparseable(`${field} is not a string`);
    status[field] = value;
  }
  return status;
}

/**
 * `bin auth status --json`, run with the *child's* env so it reports exactly what the review will
 * use. Local and model-free. Exit 1 with `loggedIn: false` is the CLI's normal logged-out answer
 * and is returned as data; any other failure, or output of the wrong shape, throws.
 */
export function readClaudeAuthStatus(bin: string, env: Record<string, string>): ClaudeAuthStatus {
  let stdout: string;
  try {
    stdout = execFileSync(bin, ['auth', 'status', '--json'], {
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLAUDE_PREFLIGHT_TIMEOUT_MS,
    });
  } catch (err) {
    const e = err as { status?: unknown; stdout?: unknown };
    const failure = new Error(`Cannot run \`${bin} auth status --json\` (${describeExecFailure(err)}).`);
    if (e.status !== 1 || typeof e.stdout !== 'string' || !e.stdout.trim()) throw failure;
    const status = parseClaudeAuthStatus(bin, e.stdout);
    if (status.loggedIn) throw failure; // exit 1 while claiming a login is not a shape we know
    return status;
  }
  return parseClaudeAuthStatus(bin, stdout);
}

export function assertLoggedIn(status: ClaudeAuthStatus, withheld: readonly string[] = []): void {
  if (status.loggedIn) return;
  const keyHint = withheld.length > 0
    ? ` ${withheld.join(' and ')} ${withheld.length > 1 ? 'are' : 'is'} set but not used: to bill ` +
      `the API with it instead, set consult.claudeAuth to "api-key" in .codev/config.json.`
    : '';
  throw new Error(`claude reports no login (authMethod: ${status.authMethod}). Run \`claude auth login\`.${keyHint}`);
}

// ---------------------------------------------------------------------------
// The auth line
// ---------------------------------------------------------------------------

export interface ClaudeAuthDescription {
  status: ClaudeAuthStatus;
  /** The child env from `buildClaudeChildEnv`, not `process.env`. */
  env: Record<string, string>;
  mode: ClaudeAuthMode;
  /** The config file that set `consult.claudeAuth`, or null for the default. */
  modeSource: string | null;
  withheld: readonly string[];
  /** Keys consult took from `<workspace>/.env` rather than the shell (#1754). */
  fromDotenv: ReadonlySet<string>;
}

/**
 * The credential the child authenticates with, and its origin; or the stored login. Any other
 * credential variable in the child env is named too, so the line never hides one.
 *
 * The winner follows the CLI's precedence, which agrees with the `authMethod` it reports. Probed on
 * 2.1.326: both API variables → `oauth_token` (the `ANTHROPIC_AUTH_TOKEN` bearer); API key plus
 * `CLAUDE_CODE_OAUTH_TOKEN` → `api_key`. `apiKeySource` is not used to pick the winner: with both
 * API variables set it still reports `ANTHROPIC_API_KEY` while `authMethod` says the token won.
 */
function claudeCredentialInUse(env: Record<string, string>, fromDotenv: ReadonlySet<string>): string {
  // Claude Code reads a provider switch as on only for these values.
  const provider = CLAUDE_PROVIDER_SWITCHES.find(
    (key) => ['1', 'true', 'yes', 'on'].includes((env[key] ?? '').trim().toLowerCase()),
  );
  const present = [...(provider ? [provider] : []), ...CLAUDE_CREDENTIAL_VARS.filter((key) => env[key])];
  if (present.length === 0) return 'stored claude login';
  const [winner, ...others] = present.map((key) => credentialOrigin(key, fromDotenv));
  return others.length > 0 ? `${winner}, with ${others.join(', ')} also set` : winner;
}

/**
 * The content of the `[CLAUDE] auth:` line, e.g.
 *
 *   claude.ai (max) — stored claude login
 *   oauth_token — CLAUDE_CODE_OAUTH_TOKEN (from .env)
 *   api_key (ANTHROPIC_API_KEY) — ANTHROPIC_API_KEY (from shell), consult.claudeAuth="api-key" in /repo/.codev/config.json
 *   claude.ai (max) — stored claude login; ignoring ANTHROPIC_API_KEY (from .env) — set consult.claudeAuth to "api-key" to bill the API instead
 *
 * Built only from the fields `ClaudeAuthStatus` carries, so no email, org name or credential value
 * can reach it.
 */
export function describeClaudeAuth(d: ClaudeAuthDescription): string {
  const { status } = d;
  let line = status.authMethod;
  if (status.apiKeySource) line += ` (${status.apiKeySource})`;
  if (status.subscriptionType) line += ` (${status.subscriptionType})`;
  if (status.apiProvider && status.apiProvider !== 'firstParty') line += ` via ${status.apiProvider}`;
  line += ` — ${status.loggedIn ? claudeCredentialInUse(d.env, d.fromDotenv) : 'not logged in'}`;
  if (d.mode === 'api-key') {
    line += `, consult.claudeAuth="api-key"${d.modeSource ? ` in ${d.modeSource}` : ''}`;
  }
  const withheldNote = describeWithheldKeys(d.withheld, d.fromDotenv);
  if (withheldNote) line += `; ${withheldNote}`;
  return line;
}

/**
 * The note for API credentials withheld in `login` mode, or null when none were, e.g.
 *
 *   ignoring ANTHROPIC_API_KEY (from .env) — set consult.claudeAuth to "api-key" to bill the API instead
 *
 * Shared by the auth line and `codev doctor`, so both word it the same way.
 */
export function describeWithheldKeys(withheld: readonly string[], fromDotenv: ReadonlySet<string>): string | null {
  if (withheld.length === 0) return null;
  const ignored = withheld.map((key) => credentialOrigin(key, fromDotenv)).join(', ');
  return `ignoring ${ignored} — set consult.claudeAuth to "api-key" to bill the API instead`;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * A preflight failure, carrying whichever report lines were known when it failed.
 *
 * `authLine` is set only once `auth status` has parsed. A failure before that point (binary
 * missing, version too old or unparseable, `api-key` mode with no key, auth status unparseable)
 * has no auth line: its message is the explanation.
 */
export class ClaudePreflightError extends Error {
  constructor(
    message: string,
    readonly binaryLine?: string,
    readonly authLine?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ClaudePreflightError';
  }
}

export interface ClaudePreflight {
  bin: string;
  version: string;
  mode: ClaudeAuthMode;
  env: Record<string, string>;
  status: ClaudeAuthStatus;
  /** Content of the `[CLAUDE] binary:` line. */
  binaryLine: string;
  /** Content of the `[CLAUDE] auth:` line. */
  authLine: string;
}

/**
 * Everything the claude lane checks before spawning a review, in order:
 *
 *   1. resolve the binary   2. read and check its version   3. resolve the auth mode and build the
 *   child env   4. in `api-key` mode, require a key   5. read `auth status`   6. require a login
 *
 * Throws a `ClaudePreflightError` at the first failure.
 */
export function preflightClaude(opts: {
  workspaceRoot: string;
  processEnv: NodeJS.ProcessEnv;
  fromDotenv: ReadonlySet<string>;
}): ClaudePreflight {
  let binaryLine: string | undefined;
  let authLine: string | undefined;
  try {
    const bin = resolveClaudeBin();
    const version = readClaudeVersion(bin);
    // `process.env`, not `opts.processEnv`: the pin is consult's own setting, read where
    // `resolveClaudeBin` reads it. `opts.processEnv` is only the source of the child's env.
    binaryLine = `${bin}, ${version} (from ${process.env[CLAUDE_BIN_ENV] ? CLAUDE_BIN_ENV : 'PATH'})`;
    assertClaudeVersion(version);

    const { mode, source } = resolveClaudeAuthMode(opts.workspaceRoot);
    const { env, withheld } = buildClaudeChildEnv(opts.processEnv, mode);
    assertApiKeyPresent(env, mode, source);

    const status = readClaudeAuthStatus(bin, env);
    authLine = describeClaudeAuth({ status, env, mode, modeSource: source, withheld, fromDotenv: opts.fromDotenv });
    assertLoggedIn(status, withheld);

    return { bin, version, mode, env, status, binaryLine, authLine };
  } catch (err) {
    throw new ClaudePreflightError(errorText(err), binaryLine, authLine, { cause: err });
  }
}
