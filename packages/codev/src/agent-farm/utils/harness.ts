/**
 * Agent harness abstraction.
 *
 * Encapsulates how different agent CLI tools (Claude, Codex, etc.)
 * handle role/system prompt injection. Built-in providers cover Claude, Codex,
 * and OpenCode. Custom providers can be defined in .codev/config.json.
 *
 * The built-in Gemini CLI harness was retired in Issue #1338 (Google ended
 * consumer-tier Gemini CLI availability on 2026-06-18); selecting it now fails
 * closed with a retirement message instead of resolving a provider. See
 * RETIRED_HARNESSES below.
 *
 * Two integration patterns exist:
 * - Node spawn() call sites: use buildRoleInjection() → returns args + env
 * - Bash script generation: use buildScriptRoleInjection() → returns fragment + env
 *
 * @see codev/specs/591-af-workspace-failure-with-code.md
 */

import { findLatestSessionId, verifySessionOwnership } from './claude-session-discovery.js';
import { buildWorktreeGuardFiles } from './worktree-write-guard.js';

// =============================================================================
// Types
// =============================================================================

export interface HarnessProvider {
  /**
   * For Node spawn() call sites (architect.ts, tower-utils.ts).
   * Returns CLI args and env vars to inject the role.
   */
  buildRoleInjection(roleContent: string, roleFilePath: string): {
    args: string[];
    env: Record<string, string>;
  };

  /**
   * For bash script generation (spawn-worktree.ts).
   * Returns a shell fragment to append after the base command,
   * and env vars the caller should export before the command.
   */
  buildScriptRoleInjection(roleContent: string, roleFilePath: string): {
    fragment: string;
    env: Record<string, string>;
  };

  /**
   * Whether this harness can clear its conversation context in-session, without
   * restarting the process (Spec 1273 — `afx reset`).
   *
   * Optional, and absence means "no": a harness that has not declared support
   * must not be reset, and defaulting to unsupported is the safe direction. Only
   * Claude declares it today (`/clear`), which is why `afx reset` refuses other
   * harnesses loudly rather than improvising a substitute mechanism.
   */
  supportsContextReset?: boolean;

  /**
   * Optional: files to write in the worktree before launching the agent.
   * Used by harnesses that rely on file-based configuration (e.g., OpenCode
   * uses opencode.json's instructions field for role injection; Claude uses it
   * to install the worktree write-guard hook — Issue #1018).
   *
   * `worktreePath` is the absolute path to the builder's worktree, needed by
   * harnesses that bake worktree-specific values into generated files.
   */
  getWorktreeFiles?(roleContent: string, roleFilePath: string, worktreePath: string): Array<{
    relativePath: string;
    content: string;
  }>;

  /**
   * Optional: conversation-session support, for agents whose CLI can pin and
   * resume a session by id (Issue #832). Harnesses that omit this are treated as
   * having no resumable sessions — architects on those agents always spawn fresh
   * and nothing is persisted. Keeps agent-specific session flags out of Tower.
   *
   * This is the stored-UUID mechanism (architect resume): an id is minted at spawn,
   * pinned via `newSessionArgs`, persisted on the architect row, and replayed via
   * `resumeArgs`. It disambiguates siblings sharing one cwd, which `buildResume`
   * (mtime discovery) cannot. The two coexist: `buildResume` serves builder resume
   * and the legacy sole-architect fallback; `session` serves architect stored-UUID resume.
   */
  session?: {
    /** Args to START a new session pinned to `sessionId` (caller merges role injection). */
    newSessionArgs(sessionId: string): string[];
    /** Args to RESUME an existing session by id (caller skips role injection). */
    resumeArgs(sessionId: string): string[];
    /**
     * Optional: verify that `sessionId` still has a resumable session on disk
     * for `cwd` before the caller resumes it (Issue #1145). Returns false when
     * the session file is gone (a stored id can outlive its jsonl); callers
     * then spawn fresh instead of baking a broken resume into a restart loop.
     * Harnesses that omit this are trusted as-is.
     */
    verifyOwnership?(sessionId: string, cwd: string, opts?: { homeDir?: string }): boolean;
  };

  /**
   * Optional: discover a resumable prior session for the given working dir and
   * return how to resume it — in BOTH forms, mirroring buildRoleInjection /
   * buildScriptRoleInjection:
   *   - args:           Node argv for spawn() call sites (architect launch)
   *   - scriptFragment: shell-escaped fragment for bash script generation (builder)
   * Returns null when no resumable session exists or this harness has no
   * cwd-keyed session store → callers fall back to a fresh launch. Only Claude
   * implements it (store: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl).
   *
   * Discovery-based (newest jsonl by mtime): used for builder resume
   * (#831/#929) ONLY. Architect launch never discovers — it resumes solely from
   * the stored session id on the workspace-scoped architect row, else spawns
   * fresh (Issue #1145: discovery on a fresh workspace hijacked whatever Claude
   * conversation the user last held in that directory).
   */
  buildResume?(absolutePath: string, opts?: { homeDir?: string }): {
    sessionId: string;
    args: string[];
    scriptFragment: string;
  } | null;
}

/** Custom harness definition from .codev/config.json */
export interface CustomHarnessConfig {
  roleArgs: string[];
  roleEnv?: Record<string, string>;
  roleScriptFragment: string;
  roleScriptEnv?: Record<string, string>;
}

// =============================================================================
// Built-in providers
// =============================================================================

export const CLAUDE_HARNESS: HarnessProvider = {
  // Spec 1273: `/clear` empties the conversation while leaving the process — and
  // therefore the --append-system-prompt role below — intact. That is what makes
  // an in-session reset possible here and nowhere else today.
  supportsContextReset: true,
  buildRoleInjection: (content, _filePath) => ({
    args: ['--append-system-prompt', content],
    env: {},
  }),
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: `--append-system-prompt "$(cat '${shellEscapeSingleQuote(filePath)}')"`,
    env: {},
  }),
  buildResume: (absolutePath, opts) => {
    const sessionId = findLatestSessionId(absolutePath, opts);
    if (!sessionId) return null;
    return {
      sessionId,
      args: ['--resume', sessionId],
      scriptFragment: `--resume '${shellEscapeSingleQuote(sessionId)}'`,
    };
  },
  // Install the worktree write-guard PreToolUse hook (Issue #1018) so a builder
  // cannot silently write outside its worktree (e.g. into the main checkout).
  getWorktreeFiles: (_content, _filePath, worktreePath) =>
    buildWorktreeGuardFiles(worktreePath),
  // Issue #832: Claude pins/resumes a conversation by UUID and stores each session
  // as ~/.claude/projects/<encoded-cwd>/<id>.jsonl.
  session: {
    newSessionArgs: (sessionId) => ['--session-id', sessionId],
    resumeArgs: (sessionId) => ['--resume', sessionId],
    // Issue #1145: a stored id is only resumed when its jsonl still exists
    // under this cwd's project dir (stale ids degrade to a fresh spawn).
    verifyOwnership: (sessionId, cwd, opts) => verifySessionOwnership(cwd, sessionId, opts),
  },
};

export const CODEX_HARNESS: HarnessProvider = {
  buildRoleInjection: (_content, filePath) => ({
    args: ['-c', `model_instructions_file=${filePath}`],
    env: {},
  }),
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: `-c model_instructions_file='${shellEscapeSingleQuote(filePath)}'`,
    env: {},
  }),
};

export const OPENCODE_HARNESS: HarnessProvider = {
  buildRoleInjection: () => {
    throw new Error(
      'OpenCode is only supported as a builder shell, not as an architect shell. ' +
      'OpenCode uses file-based role injection (opencode.json instructions field) ' +
      'which requires an ephemeral worktree. Configure a different shell for ' +
      'the architect (e.g., "claude --dangerously-skip-permissions").',
    );
  },
  buildScriptRoleInjection: () => ({ fragment: '', env: {} }),
  getWorktreeFiles: () => ([{
    relativePath: 'opencode.json',
    content: JSON.stringify({ instructions: ['.builder-role.md'] }, null, 2) + '\n',
  }]),
};

/**
 * Exported for Spec 1273: `afx reset` identifies a running builder's harness from
 * its launch script and must check `supportsContextReset` before typing into the
 * terminal. It needs the name→provider map, not just the workspace default.
 */
export const BUILTIN_HARNESSES: Record<string, HarnessProvider> = {
  claude: CLAUDE_HARNESS,
  codex: CODEX_HARNESS,
  opencode: OPENCODE_HARNESS,
};

// =============================================================================
// Retired harnesses
// =============================================================================

/**
 * Built-in harness names Codev no longer supports, each mapped to the
 * explanation shown when a user still selects it.
 *
 * A retired name is intercepted on *every* `resolveHarness` exit — the explicit
 * path and the command auto-detect path — so it fails loudly and closed rather
 * than silently falling back to Claude (the Issue #929 mis-injection class) or
 * returning `undefined` (a `BUILTIN_HARNESSES[name]` miss → downstream
 * TypeError). See `resolveHarness` and Issue #1338.
 *
 * Escape hatch: a user who retains access to a retired CLI (e.g. an
 * enterprise/API-key Gemini subscription) can still wire it as a *custom*
 * harness in .codev/config.json — the retirement targets the built-in name,
 * not a user's own definition.
 */
export const RETIRED_HARNESSES: Record<string, string> = {
  gemini:
    'The built-in Gemini CLI harness is retired. Google ended Gemini CLI ' +
    'availability for consumer accounts (free, Pro, and Ultra tiers) on ' +
    '2026-06-18, so it no longer works for most users. Use a supported harness ' +
    'instead: claude, codex, or opencode. If you still have Gemini CLI access ' +
    '(a Standard/Enterprise subscription or API-key auth), configure it as a ' +
    'custom harness in .codev/config.json under the "harness" section. ' +
    'See issue #1338.',
};

/**
 * Whether `name` is a retired built-in harness. Uses an own-property check so
 * inherited Object keys (`constructor`, `toString`, …) are never misread as
 * retired.
 */
export function isRetiredHarness(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETIRED_HARNESSES, name);
}

/**
 * The retirement explanation for `name`, or `undefined` when `name` is not a
 * retired harness.
 */
export function getRetirement(name: string): string | undefined {
  return isRetiredHarness(name) ? RETIRED_HARNESSES[name] : undefined;
}

/**
 * Throw the consistent retirement Error for retired harness `name`. Returns
 * `never` so callers can use it as a resolver exit on any branch and keep one
 * identical message regardless of which path selected the retired name.
 */
export function throwRetired(name: string): never {
  throw new Error(getRetirement(name) ?? `The "${name}" harness is retired.`);
}

// =============================================================================
// Template expansion
// =============================================================================

/**
 * Expand template variables in a string.
 * ${ROLE_FILE} → roleFilePath, ${ROLE_CONTENT} → roleContent.
 * Unknown ${...} variables are left unexpanded (makes typos visible).
 */
function expandTemplateVars(template: string, roleContent: string, roleFilePath: string): string {
  // Use replacer functions to avoid $& / $' / $` interpretation in replacement strings
  return template
    .replace(/\$\{ROLE_FILE\}/g, () => roleFilePath)
    .replace(/\$\{ROLE_CONTENT\}/g, () => roleContent);
}

/**
 * Escape a string for safe inclusion inside single quotes in bash.
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
export function shellEscapeSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

// =============================================================================
// Custom harness provider
// =============================================================================

/**
 * Build a HarnessProvider from a custom config definition.
 * Template variables (${ROLE_FILE}, ${ROLE_CONTENT}) are expanded at call time.
 */
export function buildCustomHarnessProvider(config: CustomHarnessConfig): HarnessProvider {
  return {
    buildRoleInjection: (content, filePath) => ({
      args: config.roleArgs.map(arg => expandTemplateVars(arg, content, filePath)),
      env: Object.fromEntries(
        Object.entries(config.roleEnv ?? {}).map(
          ([k, v]) => [k, expandTemplateVars(v, content, filePath)],
        ),
      ),
    }),
    buildScriptRoleInjection: (content, filePath) => ({
      fragment: expandTemplateVars(config.roleScriptFragment, content, filePath),
      env: Object.fromEntries(
        Object.entries(config.roleScriptEnv ?? {}).map(
          ([k, v]) => [k, expandTemplateVars(v, content, filePath)],
        ),
      ),
    }),
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate a custom harness config entry.
 * Throws a descriptive error if required fields are missing or wrong type.
 */
export function validateCustomHarnessConfig(name: string, config: unknown): CustomHarnessConfig {
  if (typeof config !== 'object' || config === null) {
    throw new Error(`Harness "${name}": expected an object, got ${typeof config}`);
  }

  const obj = config as Record<string, unknown>;

  if (!Array.isArray(obj.roleArgs)) {
    throw new Error(`Harness "${name}": missing required field "roleArgs" (must be a string array)`);
  }
  if (!obj.roleArgs.every((a: unknown) => typeof a === 'string')) {
    throw new Error(`Harness "${name}": "roleArgs" must contain only strings`);
  }

  if (typeof obj.roleScriptFragment !== 'string') {
    throw new Error(`Harness "${name}": missing required field "roleScriptFragment" (must be a string)`);
  }

  if (obj.roleEnv !== undefined) {
    if (typeof obj.roleEnv !== 'object' || obj.roleEnv === null) {
      throw new Error(`Harness "${name}": "roleEnv" must be an object if provided`);
    }
    for (const [k, v] of Object.entries(obj.roleEnv as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`Harness "${name}": "roleEnv.${k}" must be a string, got ${typeof v}`);
      }
    }
  }

  if (obj.roleScriptEnv !== undefined) {
    if (typeof obj.roleScriptEnv !== 'object' || obj.roleScriptEnv === null) {
      throw new Error(`Harness "${name}": "roleScriptEnv" must be an object if provided`);
    }
    for (const [k, v] of Object.entries(obj.roleScriptEnv as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`Harness "${name}": "roleScriptEnv.${k}" must be a string, got ${typeof v}`);
      }
    }
  }

  return obj as unknown as CustomHarnessConfig;
}

// =============================================================================
// Auto-detection
// =============================================================================

/**
 * Detect harness type from a command string by extracting the basename of the
 * first token and matching against known CLI names.
 * Returns undefined if no match (caller decides what to do).
 */
export function detectHarnessFromCommand(command: string): string | undefined {
  const firstToken = command.trim().split(/\s+/)[0];
  if (!firstToken) return undefined;

  // Extract basename (handles full paths like /opt/homebrew/bin/codex)
  const basename = firstToken.split('/').pop() || firstToken;

  if (basename.includes('claude')) return 'claude';
  if (basename.includes('codex')) return 'codex';
  if (basename.includes('gemini')) return 'gemini';
  if (basename.includes('opencode')) return 'opencode';

  return undefined;
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve a harness name to a HarnessProvider.
 *
 * Resolution order:
 * 1. Explicit harnessName → built-in provider, else custom provider
 * 2. Retired name → throw the retirement error (fail closed). A same-named
 *    custom harness still wins for an *explicit* name (the escape hatch), but an
 *    auto-detected retired command is always retired — auto-detection never
 *    consults custom harnesses (Issue #1338).
 * 3. Auto-detect from command string basename (if command provided)
 * 4. Default to claude (backward compatible)
 *
 * Throws if harnessName is retired, or is set but doesn't match any provider.
 */
export function resolveHarness(
  harnessName: string | undefined,
  customHarnesses?: Record<string, CustomHarnessConfig>,
  command?: string,
): HarnessProvider {
  // Explicit harness name takes priority
  if (harnessName) {
    const builtin = BUILTIN_HARNESSES[harnessName];
    if (builtin) return builtin;

    if (customHarnesses && harnessName in customHarnesses) {
      return buildCustomHarnessProvider(customHarnesses[harnessName]);
    }

    // A retired name with no custom override fails closed with a clear message.
    // Checked after the custom lookup so an explicit custom `gemini` (the
    // escape hatch for retained enterprise/API-key access) still resolves.
    if (isRetiredHarness(harnessName)) throwRetired(harnessName);

    const knownNames = Object.keys(BUILTIN_HARNESSES);
    const customNames = customHarnesses ? Object.keys(customHarnesses) : [];
    const allNames = [...knownNames, ...customNames];

    throw new Error(
      `Unknown harness "${harnessName}". ` +
      `Available harnesses: ${allNames.join(', ') || '(none)'}. ` +
      `Configure a custom harness in .codev/config.json under the "harness" section.`,
    );
  }

  // Auto-detect from command basename
  if (command) {
    const detected = detectHarnessFromCommand(command);
    if (detected) {
      // Intercept a retired detected name BEFORE the BUILTIN_HARNESSES lookup:
      // it must never return undefined (removed registry entry) nor fall through
      // to the Claude default below (the #929 silent-mismatch class). Auto-detect
      // resolves the built-in namespace only, so a detected `gemini` is retired
      // even when a custom `gemini` exists.
      if (isRetiredHarness(detected)) throwRetired(detected);
      return BUILTIN_HARNESSES[detected];
    }
  }

  // Default to claude
  return CLAUDE_HARNESS;
}
