/**
 * Agent harness abstraction.
 *
 * Encapsulates how different agent CLI tools (Claude, Codex, Gemini, etc.)
 * handle role/system prompt injection. Built-in providers cover Claude, Codex,
 * and Gemini. Custom providers can be defined in .codev/config.json.
 *
 * Two integration patterns exist:
 * - Node spawn() call sites: use buildRoleInjection() → returns args + env
 * - Bash script generation: use buildScriptRoleInjection() → returns fragment + env
 *
 * @see codev/specs/591-af-workspace-failure-with-code.md
 */

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
   * Optional: files to write in the worktree before launching the agent.
   * Used by harnesses that rely on file-based configuration (e.g., OpenCode
   * uses opencode.json's instructions field for role injection).
   */
  getWorktreeFiles?(roleContent: string, roleFilePath: string): Array<{
    relativePath: string;
    content: string;
  }>;
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
  buildRoleInjection: (content, _filePath) => ({
    args: ['--append-system-prompt', content],
    env: {},
  }),
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: `--append-system-prompt "$(cat '${shellEscapeSingleQuote(filePath)}')"`,
    env: {},
  }),
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

export const GEMINI_HARNESS: HarnessProvider = {
  buildRoleInjection: (_content, filePath) => ({
    args: [],
    env: { GEMINI_SYSTEM_MD: filePath },
  }),
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: '',
    env: { GEMINI_SYSTEM_MD: filePath },
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

const BUILTIN_HARNESSES: Record<string, HarnessProvider> = {
  claude: CLAUDE_HARNESS,
  codex: CODEX_HARNESS,
  gemini: GEMINI_HARNESS,
  opencode: OPENCODE_HARNESS,
};

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
 * 1. Explicit harnessName → built-in or custom provider
 * 2. Auto-detect from command string basename (if command provided)
 * 3. Default to claude (backward compatible)
 *
 * Throws if harnessName is set but doesn't match any known provider.
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
      return BUILTIN_HARNESSES[detected];
    }
  }

  // Default to claude
  return CLAUDE_HARNESS;
}
