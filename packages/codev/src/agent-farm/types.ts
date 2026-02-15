/**
 * Core types for Agent Farm
 */

export type BuilderType = 'spec' | 'task' | 'protocol' | 'shell' | 'worktree' | 'bugfix';

export interface Builder {
  id: string;
  name: string;
  status: 'spawning' | 'implementing' | 'blocked' | 'pr-ready' | 'complete';
  phase: string;
  worktree: string;
  branch: string;
  type: BuilderType;
  taskText?: string;      // For task mode (display in dashboard)
  protocolName?: string;  // For protocol mode
  issueNumber?: number;   // For bugfix mode
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
  // Mode flags (mutually exclusive)
  project?: string;     // Spec-based mode: --project / -p
  task?: string;        // Task mode: --task
  protocol?: string;    // Protocol mode: --protocol
  shell?: boolean;      // Shell mode: --shell (no worktree, no prompt)
  worktree?: boolean;   // Worktree mode: --worktree (worktree, no prompt)
  issue?: number;       // Bugfix mode: --issue / -i

  // Task mode options
  files?: string[];     // Context files for task mode: --files

  // Bugfix mode options
  noComment?: boolean;  // Skip "On it" comment on issue: --no-comment
  force?: boolean;      // Override collision detection: --force

  // Protocol override
  useProtocol?: string; // Override default protocol: --use-protocol

  // Mode control
  soft?: boolean;       // Soft mode: AI follows protocol, architect verifies: --soft
  strict?: boolean;     // Strict mode: porch orchestrates: --strict

  // Resume mode
  resume?: boolean;    // Resume existing worktree: --resume

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
    builder?: string | string[];
    shell?: string | string[];
  };
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
