/**
 * Forge concept command dispatcher.
 *
 * Routes forge operations (issue fetch, PR list, etc.) through configurable
 * external commands. Default commands wrap the `gh` CLI for GitHub repos.
 * Projects override commands via the `forge` section in .codev/config.json.
 *
 * Concept commands are executed via shell (`sh -c`) to support pipes,
 * redirects, and variable expansion in user-configured commands.
 * Environment variables (CODEV_*) are set before invocation.
 *
 * @see codev/specs/589-non-github-repository-support.md
 */

import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig as loadCodevConfig } from './config.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the path to a provider's on-disk concept script.
 * Scripts live at `scripts/forge/<provider>/<concept>.sh` relative to the package root.
 * At runtime, __dirname is `dist/lib/` — the package root is two levels up.
 */
function resolveScriptPath(provider: string, concept: string): string {
  return resolve(__dirname, '..', '..', 'scripts', 'forge', provider, `${concept}.sh`);
}

/** Default maxBuffer for forge commands (10MB). Prevents truncation for large diffs. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * The provider a concept resolves against when config names none, and the
 * fallback backend key when a command's executable cannot be determined.
 *
 * Defined here rather than in forge-rate-limit.ts because that module imports
 * this one; the reverse would be a cycle. It was briefly duplicated as a bare
 * `'github'` literal in both, which would have keyed rate-limit writes and
 * reads differently the moment either changed.
 */
export const DEFAULT_PROVIDER = 'github';

/**
 * The CLI each built-in provider drives.
 *
 * Backend keys must live in one namespace: healthy resolution yields the
 * executable (`gh`), while the unreadable-script fallback yields the provider
 * (`github`), and without this map one account would hold two independent
 * suspension states under the two spellings.
 */
const PROVIDER_EXECUTABLES: Record<string, string> = {
  github: 'gh',
  gitlab: 'glab',
  gitea: 'tea',
};

/**
 * Tools that identify a transport rather than a forge account.
 *
 * Linear's concepts run `curl` against its GraphQL API, so `curl` says nothing
 * about *whose* budget was spent — and any future curl-based provider would
 * collide with it. For these, the configured provider is the better key, which
 * also keeps Linear's healthy resolve (`curl`) and its fallback (`linear`) from
 * becoming two suspension states for one account.
 */
const GENERIC_TRANSPORTS = new Set(['curl', 'wget', 'http', 'https', 'sh', 'bash', 'jq', 'python', 'python3', 'node']);

// =============================================================================
// Types
// =============================================================================

/** Forge config from .codev/config.json `forge` section (concept overrides + optional provider). */
export type ForgeConfig = Record<string, string | null> & { provider?: string };

/** Options for forge command execution. */
export interface ForgeCommandOptions {
  /** Working directory for command execution. */
  cwd?: string;
  /** Workspace root for loading .codev/config.json (only used if forgeConfig not provided). */
  workspaceRoot?: string;
  /** Pre-loaded forge config. Avoids repeated .codev/config.json reads. */
  forgeConfig?: ForgeConfig | null;
  /** If true, return stdout as raw string instead of parsing as JSON. */
  raw?: boolean;
  /** Maximum stdout buffer size in bytes. Defaults to 10MB. */
  maxBuffer?: number;
}

// =============================================================================
// Known concept names
// =============================================================================

const KNOWN_CONCEPTS = [
  'issue-view', 'pr-list', 'issue-list', 'issue-search', 'issue-comment', 'pr-exists',
  'recently-closed', 'recently-merged', 'user-identity', 'team-activity',
  'on-it-timestamps', 'pr-create', 'pr-merge', 'pr-search', 'pr-view', 'pr-diff',
  'auth-status', 'repo-archive', 'rate-limit',
] as const;

// =============================================================================
// Default concept commands — resolved lazily from on-disk scripts
// =============================================================================

let _defaultCommands: Record<string, string> | null = null;

/**
 * Build default commands from on-disk scripts (github provider).
 * Each concept maps to `scripts/forge/github/<concept>.sh`.
 * Lazily computed and cached.
 */
function getDefaultCommands(): Record<string, string> {
  if (_defaultCommands) return _defaultCommands;
  _defaultCommands = {};
  for (const concept of KNOWN_CONCEPTS) {
    _defaultCommands[concept] = resolveScriptPath('github', concept);
  }
  return _defaultCommands;
}

// =============================================================================
// Provider presets
// =============================================================================

/**
 * Build a provider preset from on-disk scripts.
 * Concepts without a script file are omitted (fall through to default).
 * Explicitly disabled concepts are set to null.
 */
function buildPresetFromScripts(provider: string, disabledConcepts: string[] = []): Record<string, string | null> {
  const preset: Record<string, string | null> = {};
  for (const concept of KNOWN_CONCEPTS) {
    if (disabledConcepts.includes(concept)) {
      preset[concept] = null;
      continue;
    }
    const scriptPath = resolveScriptPath(provider, concept);
    if (existsSync(scriptPath)) {
      preset[concept] = scriptPath;
    }
  }
  return preset;
}

let _providerPresets: Record<string, Record<string, string | null>> | null = null;

/**
 * Built-in presets for common forges. Resolved lazily from on-disk scripts.
 *
 * NOTE: Non-GitHub presets are best-effort. Their output schemas may not conform
 * to the contracts in forge-contracts.ts. Consumers must handle null returns
 * gracefully since JSON parse failures now return null instead of raw strings.
 */
function getProviderPresets(): Record<string, Record<string, string | null>> {
  if (_providerPresets) return _providerPresets;
  _providerPresets = {
    github: getDefaultCommands(),
    gitlab: buildPresetFromScripts('gitlab', ['team-activity', 'on-it-timestamps', 'rate-limit']),
    gitea: buildPresetFromScripts('gitea', ['team-activity', 'on-it-timestamps', 'pr-search', 'pr-diff', 'rate-limit']),
    // Linear is a hybrid forge (spec 719): it owns *issues*, while every PR
    // concept — pr-create included — deliberately falls through to the github
    // default. Disabling pr-create here would leave Linear the one provider
    // that can merge a PR but not open one.
    linear: buildPresetFromScripts('linear', ['team-activity', 'on-it-timestamps', 'rate-limit']),
  };
  return _providerPresets;
}

/** Get known provider names. */
export function getKnownProviders(): string[] {
  return Object.keys(getProviderPresets());
}

/** Resolution source for a concept command. */
export type ConceptSource = 'override' | 'preset' | 'default' | 'disabled';

export interface ConceptResolution {
  concept: string;
  command: string | null;
  source: ConceptSource;
  executable: string | null;
}

/**
 * Resolve every known concept with its source and executable.
 * Used by `codev doctor` for full concept reporting.
 */
export function resolveAllConcepts(forgeConfig?: ForgeConfig | null): ConceptResolution[] {
  const concepts = Object.keys(getDefaultCommands());
  return concepts.map((concept) => {
    // Check manual override first
    if (forgeConfig && concept !== 'provider' && concept in forgeConfig) {
      const cmd = forgeConfig[concept];
      if (cmd === null) {
        return { concept, command: null, source: 'disabled' as ConceptSource, executable: null };
      }
      return { concept, command: cmd, source: 'override' as ConceptSource, executable: extractExecutable(cmd) };
    }

    // Check provider preset
    if (forgeConfig?.provider) {
      const preset = getProviderPresets()[forgeConfig.provider];
      if (preset && concept in preset) {
        const cmd = preset[concept];
        if (cmd === null) {
          return { concept, command: null, source: 'disabled' as ConceptSource, executable: null };
        }
        return { concept, command: cmd, source: 'preset' as ConceptSource, executable: extractExecutable(cmd) };
      }
    }

    // Default
    const cmd = getDefaultCommands()[concept] ?? null;
    return { concept, command: cmd, source: 'default' as ConceptSource, executable: cmd ? extractExecutable(cmd) : null };
  });
}

/**
 * Extract the executable name from a command string or script path.
 *
 * For script paths (ending in .sh): reads the script and finds the first
 * substantive command (after `exec`, or in `if/then` blocks).
 *
 * For inline commands: handles `if [ ... ]; then cmd ...` patterns and pipes.
 */
/** Shell builtins and keywords that are never the executable a concept needs on PATH. */
const SHELL_BUILTINS = ['if', 'then', 'else', 'fi', 'test', '[', '[[', 'set', 'export', 'readonly', 'local', 'shift', ':', '.', 'source'];

function extractExecutable(command: string): string | null {
  const trimmed = command.trim();

  // Script path: read and extract the underlying tool
  if (trimmed.endsWith('.sh') && existsSync(trimmed)) {
    try {
      const content = readFileSync(trimmed, 'utf-8');
      // An explicit `# forge-executable: <tool>` declaration wins. The heuristic
      // below reads the first substantive line, which is wrong for any script
      // that opens with `set -e` or an input guard — it would tell `codev
      // doctor` to look for `set` or `echo` instead of `gh`/`tea`/`glab`, and a
      // missing forge CLI would go unreported (#1455).
      const declared = content.match(/^#\s*forge-executable:\s*(\S+)/m);
      if (declared) return declared[1];
      // Look for `exec <tool>` or first non-comment, non-shebang, non-blank line
      for (const line of content.split('\n')) {
        const l = line.trim();
        if (!l || l.startsWith('#') || l.startsWith('if') || l.startsWith('else') || l.startsWith('fi') || /^\w+=/.test(l)) continue;
        const execMatch = l.match(/^exec\s+(\S+)/);
        if (execMatch) return execMatch[1];
        // First substantive command. Shell builtins are skipped, not returned:
        // a script opening with `set -e` would otherwise report `set` as its
        // executable, and `codev doctor` would then warn that `set` is missing
        // instead of checking for the real CLI (#1455).
        const token = l.split(/\s+/)[0];
        if (token && !SHELL_BUILTINS.includes(token)) {
          return token;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Inline command: extract first real executable
  // Shell conditional: extract first command after "then"
  const thenMatch = trimmed.match(/then\s+(\S+)/);
  if (thenMatch) return thenMatch[1];
  // First substantive segment of a pipe/sequence. Builtins are *skipped*, not
  // returned as null: `doctor` treats a null executable as "nothing to check"
  // (doctor.ts, `execInstalled`), so bailing at the first builtin would report
  // `. env.sh; gh issue view "$1"` as healthy without ever checking for `gh` —
  // the silent success #1455 is about, inside the reporter for it. This mirrors
  // the script-file branch above, which also scans past builtins to the real CLI.
  for (const segment of trimmed.split(/[|;]/)) {
    const token = segment.trim().split(/\s+/)[0];
    if (token && !SHELL_BUILTINS.includes(token)) return token;
  }
  return null;
}

// =============================================================================
// Configuration loading
// =============================================================================

/**
 * Load forge configuration from .codev/config.json (via unified config loader).
 * Returns the forge section or null if not configured.
 *
 * Prefer passing forge config directly via ForgeCommandOptions.forgeConfig
 * when config is already loaded (e.g., from loadConfig in lib/config.ts).
 */
export function loadForgeConfig(workspaceRoot: string): ForgeConfig | null {
  const config = loadCodevConfig(workspaceRoot);
  return (config.forge as ForgeConfig) ?? null;
}

/** Resolve forge config from options: explicit > loaded from workspace > loaded from cwd > null. */
function resolveForgeConfig(options?: ForgeCommandOptions): ForgeConfig | null {
  if (options?.forgeConfig !== undefined) return options.forgeConfig;
  if (options?.workspaceRoot) return loadForgeConfig(options.workspaceRoot);
  if (options?.cwd) return loadForgeConfig(options.cwd);
  return null;
}

/**
 * Get the command string for a concept.
 * Resolution order: manual concept override > provider preset > default (github).
 * Returns null if concept is explicitly disabled (set to null in config).
 */
export function getForgeCommand(
  concept: string,
  forgeConfig?: ForgeConfig | null,
): string | null {
  // Check manual concept overrides first (excluding 'provider' key)
  if (forgeConfig && concept !== 'provider' && concept in forgeConfig) {
    return forgeConfig[concept]; // null means explicitly disabled
  }

  // Check provider preset
  if (forgeConfig?.provider) {
    const preset = getProviderPresets()[forgeConfig.provider];
    if (preset && concept in preset) {
      return preset[concept]; // null means not supported by this provider
    }
  }

  // Fall back to default (github)
  return getDefaultCommands()[concept] ?? null;
}

const _backendCache = new Map<string, string>();

/**
 * Drop memoized backend resolutions.
 *
 * Resolution reads the concept script off disk, so an edited script — or an
 * added `# forge-executable:` line — would otherwise not take effect until the
 * process restarted. Called from `OverviewCache.invalidate()`, which is what a
 * config or script change is followed by.
 */
export function clearForgeBackendCache(): void {
  _backendCache.clear();
}

/**
 * The backend a concept will actually run against: the resolved command's
 * executable, lowercased. Falls back to the configured provider, then to
 * `DEFAULT_PROVIDER`.
 *
 * This is the correct key for anything accounted per-forge (rate limits), and
 * it is deliberately *not* the workspace's configured provider — see
 * `ForgeFailure.backend`. Memoized because resolution reads the script's first
 * substantive line off disk.
 */
export function resolveConceptBackend(
  concept: string,
  forgeConfig?: ForgeConfig | null,
): string {
  const provider = forgeConfig?.provider ?? DEFAULT_PROVIDER;
  const providerBackend = (PROVIDER_EXECUTABLES[provider.toLowerCase()] ?? provider).toLowerCase();
  const command = getForgeCommand(concept, forgeConfig);
  // A disabled concept still has to answer in the same namespace as every
  // other: returning the bare provider name here was the one place the alias
  // map was bypassed, so `github` could key separately from `gh`.
  if (command === null) return providerBackend;

  // `provider` belongs in the key, not just `command`: two workspaces can
  // resolve the same default script while naming different providers, and the
  // path-like fallback below answers with the *provider*. Keying on the command
  // alone would let the first caller's provider bleed into the second's.
  const key = `${concept}\u0000${command}\u0000${provider}`;
  const cached = _backendCache.get(key);
  if (cached !== undefined) return cached;

  // Three shapes come back from `extractExecutable`, and they mean different
  // things:
  //
  // - `gh`, or `/usr/local/bin/gh` from `"/usr/local/bin/gh issue list"` — a
  //   real executable. Its basename is the backend: an override spelling the
  //   tool in full must key the same as one spelling it bare.
  // - the command echoed back, because it is a bare path to a script that could
  //   not be read (`…/pr-list.sh`, or an extensionless `/opt/forge/issue-list`).
  //   That names no tool, and keying on it would give every concept a backend of
  //   its own — so fall back to the configured provider instead. Less precise,
  //   but it keeps concepts that share an account sharing a key.
  // - a generic transport (`curl`), which names a protocol rather than an
  //   account. The provider is the better key. See GENERIC_TRANSPORTS.
  const trimmed = command.trim();
  const executable = extractExecutable(command);
  const basename = executable?.split('/').pop() || null;
  // A bare path with no arguments is a script reference; if the extractor just
  // handed it back, it read nothing useful out of the file.
  const bareScriptRef = !/\s/.test(trimmed) && (trimmed.includes('/') || trimmed.endsWith('.sh'));
  const unknownTool =
    basename === null
    || basename.endsWith('.sh')
    || (bareScriptRef && basename === trimmed.split('/').pop())
    // A file named after the concept is a per-concept script, not a tool —
    // `/opt/forge/issue-list --json …` names no CLI. Keying on it would give
    // every concept a backend of its own and fragment one account across all
    // of them, arguments or no arguments.
    || basename === concept;
  const backend = (
    unknownTool || GENERIC_TRANSPORTS.has(basename!.toLowerCase()) ? providerBackend : basename!.toLowerCase()
  );
  _backendCache.set(key, backend);
  return backend;
}

/**
 * Check if a concept is explicitly disabled (set to null in config).
 */
export function isConceptDisabled(
  concept: string,
  forgeConfig?: ForgeConfig | null,
): boolean {
  if (!forgeConfig) return false;
  return concept in forgeConfig && forgeConfig[concept] === null;
}

// =============================================================================
// Failure notification (Issue #1645)
// =============================================================================

/** A forge concept command that exited non-zero, with the detail the catch block discards. */
export interface ForgeFailure {
  concept: string;
  /** stderr when the child produced any, else the Error message. Never null. */
  message: string;
  /** Child exit code when Node reported one. */
  exitCode: number | null;
  /**
   * The **backend** this command actually ran against — the executable the
   * concept resolved to (`gh`, `glab`, `tea`, …), lowercased, falling back to
   * the configured provider name.
   *
   * The resolved backend, not the configured provider: a rate limit is charged
   * to whatever account made the call, and providers are hybrid. A Linear
   * workspace has no `pr-list` script of its own, so that concept falls through
   * to the github default and spends *GitHub's* budget (spec 719). Keying on
   * the workspace's configured provider would file that limit under `linear`
   * and leave a real GitHub workspace to discover it all over again.
   */
  backend: string;
}

type ForgeFailureListener = (failure: ForgeFailure) => void;

const failureListeners = new Set<ForgeFailureListener>();

/**
 * Observe every forge concept failure in this process.
 *
 * `executeForgeCommand` collapses every failure mode to `null`, which is all
 * most callers need — but it means nothing downstream can tell "gh is not
 * installed" from "the GitHub API rate limit is exhausted". Tower needs that
 * distinction to stop hammering a forge that is refusing it (#1645), so the
 * detail is published here instead of being widened into every return type.
 *
 * @returns an unsubscribe function.
 */
export function onForgeFailure(listener: ForgeFailureListener): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

/** Build a ForgeFailure from a child_process rejection and publish it. */
function notifyFailure(concept: string, err: unknown, backend: string): void {
  if (failureListeners.size === 0) return;
  const e = err as { stderr?: unknown; code?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  const message = stderr || (err instanceof Error ? err.message : String(err));
  const exitCode = typeof e?.code === 'number' ? e.code : null;
  const failure: ForgeFailure = { concept, message, exitCode, backend };
  for (const listener of failureListeners) {
    try {
      listener(failure);
    } catch {
      // A listener must never break the command path it is observing.
    }
  }
}

// =============================================================================
// Execution
// =============================================================================

/**
 * Execute a forge concept command asynchronously.
 *
 * Sets CODEV_* environment variables, executes the configured command
 * via shell, and parses stdout as JSON. Returns null on failure.
 *
 * @param concept - The concept name (e.g., 'issue-view', 'pr-list')
 * @param env - Additional environment variables to set (CODEV_* prefix recommended)
 * @param options - Execution options
 * @returns Parsed JSON from stdout, raw string for non-JSON concepts, or null on failure
 */
export async function executeForgeCommand(
  concept: string,
  env?: Record<string, string>,
  options?: ForgeCommandOptions,
): Promise<unknown | null> {
  const forgeConfig = resolveForgeConfig(options);
  const command = getForgeCommand(concept, forgeConfig);

  if (command === null) {
    return null;
  }

  const forgeEnv = buildForgeEnv(forgeConfig);

  try {
    const { stdout } = await execAsync(command, {
      cwd: options?.cwd,
      env: { ...process.env, ...forgeEnv, ...env },
      timeout: 30_000,
      maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
    });

    return parseOutput(stdout, options?.raw);
  } catch (err: unknown) {
    logDebug(concept, err);
    notifyFailure(concept, err, resolveConceptBackend(concept, forgeConfig));
    return null;
  }
}

/**
 * Execute a forge concept command synchronously.
 *
 * Same as executeForgeCommand but blocks until completion.
 * Use sparingly — prefer the async variant.
 */
export function executeForgeCommandSync(
  concept: string,
  env?: Record<string, string>,
  options?: ForgeCommandOptions,
): unknown | null {
  const forgeConfig = resolveForgeConfig(options);
  const command = getForgeCommand(concept, forgeConfig);

  if (command === null) {
    return null;
  }

  const forgeEnv = buildForgeEnv(forgeConfig);

  try {
    const stdout = execSync(command, {
      cwd: options?.cwd,
      env: { ...process.env, ...forgeEnv, ...env },
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return parseOutput(stdout, options?.raw);
  } catch (err: unknown) {
    logDebug(concept, err, true);
    notifyFailure(concept, err, resolveConceptBackend(concept, forgeConfig));
    return null;
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

const _knownConceptSet = new Set<string>(KNOWN_CONCEPTS);

/**
 * Build environment variables from non-concept forge config keys.
 * E.g., `forge.linear-team: "ENG"` → `CODEV_LINEAR_TEAM=ENG`.
 */
function buildForgeEnv(forgeConfig: ForgeConfig | null): Record<string, string> {
  if (!forgeConfig) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(forgeConfig)) {
    if (key === 'provider' || _knownConceptSet.has(key) || value === null) continue;
    const envKey = 'CODEV_' + key.toUpperCase().replace(/-/g, '_');
    result[envKey] = value;
  }
  return result;
}

/** Parse command stdout: try JSON when raw=false (null on parse failure), raw string otherwise. */
function parseOutput(stdout: string, raw?: boolean): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  if (raw) return trimmed;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Not valid JSON — return null so downstream code doesn't cast a raw
    // string to typed objects (e.g. IssueViewResult, PrListItem[]).
    return null;
  }
}

/** Log concept failure at debug level. */
function logDebug(concept: string, err: unknown, sync = false): void {
  if (process.env.CODEV_DEBUG) {
    const msg = err instanceof Error ? err.message : String(err);
    const suffix = sync ? ' (sync)' : '';
    console.warn(`[forge] concept '${concept}'${suffix} failed: ${msg}`);
  }
}

// =============================================================================
// Convenience helpers
// =============================================================================

/**
 * Get the list of all known concept names.
 */
export function getKnownConcepts(): string[] {
  return Object.keys(getDefaultCommands());
}

/**
 * Get the default command for a concept (ignoring user config).
 * Useful for documentation and doctor checks.
 */
export function getDefaultCommand(concept: string): string | null {
  return getDefaultCommands()[concept] ?? null;
}

/**
 * Validate forge configuration.
 * Returns an array of diagnostic messages.
 * Used by `codev doctor`.
 */
export function validateForgeConfig(
  forgeConfig: ForgeConfig,
): { concept: string; status: 'ok' | 'disabled' | 'unknown_concept' | 'empty_command' | 'provider'; message: string }[] {
  const results: { concept: string; status: 'ok' | 'disabled' | 'unknown_concept' | 'empty_command' | 'provider'; message: string }[] = [];

  // Report provider if set
  if (forgeConfig.provider) {
    const providerName = forgeConfig.provider;
    if (getProviderPresets()[providerName]) {
      results.push({ concept: 'provider', status: 'provider', message: `Provider: ${providerName}` });
    } else {
      results.push({ concept: 'provider', status: 'unknown_concept', message: `Unknown provider '${providerName}' (known: ${Object.keys(getProviderPresets()).join(', ')})` });
    }
  }

  for (const [concept, command] of Object.entries(forgeConfig)) {
    if (concept === 'provider') continue; // Already handled above
    if (command === null) {
      results.push({ concept, status: 'disabled', message: `Concept '${concept}' is explicitly disabled` });
    } else if (command === '') {
      results.push({ concept, status: 'empty_command', message: `Concept '${concept}' has an empty command string` });
    } else if (!(concept in getDefaultCommands())) {
      results.push({ concept, status: 'unknown_concept', message: `Concept '${concept}' is not a known forge concept` });
    } else {
      results.push({ concept, status: 'ok', message: `Concept '${concept}' overridden: ${command}` });
    }
  }

  return results;
}
