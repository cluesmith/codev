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
    fragment: `--append-system-prompt "$(cat '${filePath}')"`,
    env: {},
  }),
};

export const CODEX_HARNESS: HarnessProvider = {
  buildRoleInjection: (_content, filePath) => ({
    args: ['-c', `model_instructions_file=${filePath}`],
    env: {},
  }),
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: `-c model_instructions_file='${filePath}'`,
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

const BUILTIN_HARNESSES: Record<string, HarnessProvider> = {
  claude: CLAUDE_HARNESS,
  codex: CODEX_HARNESS,
  gemini: GEMINI_HARNESS,
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
  return template
    .replace(/\$\{ROLE_FILE\}/g, roleFilePath)
    .replace(/\$\{ROLE_CONTENT\}/g, roleContent);
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

  if (obj.roleEnv !== undefined && (typeof obj.roleEnv !== 'object' || obj.roleEnv === null)) {
    throw new Error(`Harness "${name}": "roleEnv" must be an object if provided`);
  }

  if (obj.roleScriptEnv !== undefined && (typeof obj.roleScriptEnv !== 'object' || obj.roleScriptEnv === null)) {
    throw new Error(`Harness "${name}": "roleScriptEnv" must be an object if provided`);
  }

  return obj as unknown as CustomHarnessConfig;
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve a harness name to a HarnessProvider.
 *
 * - undefined → defaults to claude (backward compatible)
 * - built-in name → returns built-in provider
 * - custom name → looks up in customHarnesses, builds provider
 * - unknown → throws descriptive error
 */
export function resolveHarness(
  harnessName: string | undefined,
  customHarnesses?: Record<string, CustomHarnessConfig>,
): HarnessProvider {
  if (!harnessName) {
    return CLAUDE_HARNESS;
  }

  const builtin = BUILTIN_HARNESSES[harnessName];
  if (builtin) {
    return builtin;
  }

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
