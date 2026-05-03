/**
 * Core types for Agent Farm
 */

export type BuilderType = 'spec' | 'task' | 'protocol' | 'shell' | 'worktree' | 'bugfix';

export interface Builder {
  id: string;
  name: string;
  status: 'spawning' | 'implementing' | 'blocked' | 'pr' | 'complete';
  phase: string;
  worktree: string;
  branch: string;
  type: BuilderType;
  taskText?: string;      // For task mode (display in dashboard)
  protocolName?: string;  // For protocol mode
  issueNumber?: number | string;   // For bugfix mode
  terminalId?: string;    // Terminal session ID
}

export interface UtilTerminal {
  id: string;
  name: string;
  worktreePath?: string;  // For worktree shells - used for cleanup on tab close
  terminalId?: string;    // Terminal session ID
}

export interface Annotation {
  id: string;
  file: string;
  parent: {
    type: 'architect' | 'builder' | 'util';
    id?: string;
  };
}

export interface ArchitectState {
  cmd: string;
  startedAt: string;
  terminalId?: string;
}

export interface DashboardState {
  architect: ArchitectState | null;
  builders: Builder[];
  utils: UtilTerminal[];
  annotations: Annotation[];
}

export interface Config {
  workspaceRoot: string;
  codevDir: string;
  buildersDir: string;
  stateDir: string;
  templatesDir: string;
  serversDir: string;
  bundledRolesDir: string;
  terminalBackend: 'node-pty';
}

export interface StartOptions {
  noBrowser?: boolean;  // Skip opening browser after start
}

export interface SpawnOptions {
  // Primary input: issue identifier as positional arg
  issueNumber?: number | string;   // Positional arg: `afx spawn 315` or `afx spawn ENG-123`

  // Protocol selection (required for issue-based spawns)
  protocol?: string;      // --protocol spir|aspir|air|bugfix|maintain|experiment

  // Alternative modes (no issue number needed)
  task?: string;          // Task mode: --task
  shell?: boolean;        // Shell mode: --shell (no worktree, no prompt)
  worktree?: boolean;     // Worktree mode: --worktree (worktree, no prompt)

  // Legacy (TICK removed in spec 653)
  amends?: number;        // --amends (deprecated, errors if used)

  // Task mode options
  files?: string[];       // Context files for task mode: --files

  // Issue-based options
  noComment?: boolean;    // Skip "On it" comment on issue: --no-comment
  force?: boolean;        // Override collision detection: --force

  // Mode control
  soft?: boolean;         // Soft mode: AI follows protocol, architect verifies: --soft
  strict?: boolean;       // Strict mode: porch orchestrates: --strict

  // Resume mode
  resume?: boolean;       // Resume existing worktree: --resume

  // Branch mode (Spec 609): use an existing remote branch
  branch?: string;        // --branch <name>: checkout existing remote branch instead of creating new one
  remote?: string;        // --remote <name>: specify which remote to fetch the branch from (for fork PRs)

  // General options
  noRole?: boolean;
  instruction?: string;
}

// =============================================================================
// Protocol Definition Types (for protocol.json)
// =============================================================================

/**
 * Protocol input configuration - defines what input types a protocol accepts
 */
export interface ProtocolInput {
  type: 'spec' | 'github-issue' | 'task' | 'protocol' | 'shell' | 'worktree';
  required: boolean;
  default_for?: string[];  // CLI flags this protocol is default for, e.g., ["--issue", "-i"]
}

/**
 * Protocol hooks - actions triggered at various points in the spawn lifecycle
 */
export interface ProtocolHooks {
  'pre-spawn'?: {
    'collision-check'?: boolean;      // Check for worktree/PR collisions
    'comment-on-issue'?: string;      // Comment to post on GitHub issue
  };
}

/**
 * Protocol default settings
 */
export interface ProtocolDefaults {
  mode?: 'strict' | 'soft';  // Default orchestration mode
}

/**
 * Full protocol definition as loaded from protocol.json
 */
export interface ProtocolDefinition {
  name: string;
  version: string;
  description: string;
  input?: ProtocolInput;
  hooks?: ProtocolHooks;
  defaults?: ProtocolDefaults;
  phases: unknown[];  // Phase structure varies by protocol
}

export interface SendOptions {
  builder?: string;     // Builder ID (required unless --all)
  message?: string;     // Message to send
  all?: boolean;        // Send to all builders
  file?: string;        // File to include in message
  interrupt?: boolean;  // Send Ctrl+C first to ensure prompt is ready
  raw?: boolean;        // Skip structured formatting
  noEnter?: boolean;    // Don't send Enter after message
}

/**
 * User-facing config.json structure
 */
export interface UserConfig {
  shell?: {
    architect?: string | string[];
    architectHarness?: string;
    builder?: string | string[];
    builderHarness?: string;
    shell?: string | string[];
  };
  /** Custom harness provider definitions. Keys are harness names, values define role injection. */
  harness?: Record<string, {
    roleArgs: string[];
    roleEnv?: Record<string, string>;
    roleScriptFragment: string;
    roleScriptEnv?: Record<string, string>;
  }>;
  templates?: {
    dir?: string;
  };
  roles?: {
    dir?: string;
  };
  terminal?: {
    backend?: 'node-pty';
  };
  dashboard?: {
    frontend?: 'react' | 'legacy';
  };
  /** Forge concept command overrides. Keys are concept names, values are command strings or null (disabled). */
  forge?: Record<string, string | null>;
}

/**
 * Resolved shell commands (after processing config hierarchy)
 */
export interface ResolvedCommands {
  architect: string;
  builder: string;
  shell: string;
}

/**
 * Tutorial state for interactive onboarding
 */
export interface TutorialState {
  workspacePath: string;
  currentStep: string;
  completedSteps: string[];
  userResponses: Record<string, string>;
  startedAt: string;
  lastActiveAt: string;
}

export interface TutorialOptions {
  reset?: boolean;
  skip?: boolean;
  status?: boolean;
}
