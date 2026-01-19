/**
 * Porch - Protocol Orchestrator
 *
 * Type definitions for protocol definitions and state management.
 */

// ============================================================================
// Protocol Definition Types (loaded from protocol.json)
// ============================================================================

/**
 * Signal that a phase can emit to trigger state transitions
 */
export interface PhaseSignals {
  [signalName: string]: string; // signal name -> next state
}

/**
 * Check configuration (build, test, etc.)
 */
export interface Check {
  command: string;
  on_fail: 'retry' | string; // 'retry' or phase to return to
  max_retries?: number;
  retry_delay?: number;
}

/**
 * Consultation configuration for a phase
 */
export interface ConsultationConfig {
  on: string; // substate that triggers consultation
  models: string[]; // e.g., ['gemini', 'codex', 'claude']
  type: string; // e.g., 'spec-review', 'plan-review'
  parallel?: boolean;
  max_rounds?: number;
  next: string; // next state after consultation
}

/**
 * Human approval gate configuration
 */
export interface GateConfig {
  after: string; // substate that triggers gate
  type: 'human' | 'automated';
  next: string; // next state after gate passes
}

/**
 * Phase definition in a protocol
 */
export interface Phase {
  id: string;
  name: string;
  prompt?: string;
  substates?: string[];
  signals?: PhaseSignals;
  terminal?: boolean;
  phased?: boolean; // true if this phase runs per plan-phase
  phases_from?: string; // 'plan' - extract phases from plan file
  checks?: Record<string, Check>;
  consultation?: ConsultationConfig;
  gate?: GateConfig;
}

/**
 * Protocol configuration
 */
export interface ProtocolConfig {
  poll_interval?: number;
  max_iterations?: number;
  claude_timeout?: number; // ms
  consultation_timeout?: number; // ms
  gate_poll_interval?: number; // seconds
  max_gate_wait?: number; // seconds
  scope_limit_loc?: number; // for TICK
  source?: string; // for BUGFIX: 'github_issue'
  auto_pr?: boolean; // for BUGFIX
}

/**
 * Security permissions per phase
 */
export interface ProtocolPermissions {
  [phaseId: string]: string[]; // e.g., ['write:src/**', 'bash:npm *']
}

/**
 * Complete protocol definition (loaded from JSON)
 */
export interface Protocol {
  $schema?: string;
  name: string;
  version: string;
  description: string;
  phases: Phase[];
  initial: string; // initial state (e.g., 'specify:draft')
  config?: ProtocolConfig;
  permissions?: ProtocolPermissions;
}

// ============================================================================
// Legacy Protocol Types (for backward compatibility)
// ============================================================================

/**
 * Legacy gate definition (standalone)
 * @deprecated Use GateConfig in Phase instead
 */
export interface Gate {
  id: string;
  after_state: string;
  next_state: string;
  type: 'human' | 'automated';
  description?: string;
}

/**
 * Legacy transition configuration
 * @deprecated Transitions are now defined in phases via signals
 */
export interface TransitionConfig {
  default?: string;
  on_gate_pass?: string;
  wait_for?: string;
  on_backpressure_pass?: string;
  on_backpressure_fail?: string;
}

/**
 * Legacy protocol format (for backward compatibility)
 */
export interface LegacyProtocol {
  $schema?: string;
  name: string;
  version: string;
  description: string;
  phases: Phase[];
  gates: Gate[];
  transitions: Record<string, TransitionConfig>;
  initial_state: string;
  config: {
    poll_interval: number;
    max_iterations: number;
    prompts_dir: string;
  };
}

// ============================================================================
// Project State Types (stored in status.yaml)
// ============================================================================

/**
 * Gate status in project state
 */
export interface GateStatusEntry {
  status: 'pending' | 'passed' | 'failed';
  requested_at?: string;
  approved_at?: string;
}

/**
 * Phase status in project state
 */
export interface PhaseStatusEntry {
  status: 'pending' | 'in_progress' | 'complete';
  title?: string;
}

/**
 * Plan phase extracted from plan.md
 */
export interface PlanPhase {
  id: string;
  title: string;
  description?: string;
}

/**
 * Log entry in project state
 */
export interface LogEntry {
  ts: string;
  event: string;
  from?: string | null;
  to?: string;
  signal?: string;
  gate?: string;
  phase?: string;
  status?: string;
  count?: number;
}

/**
 * Project state (stored in status.yaml)
 */
export interface ProjectState {
  id: string;
  title: string;
  protocol: string;
  current_state: string;
  worktree?: string;
  gates: Record<string, GateStatusEntry>;
  phases: Record<string, PhaseStatusEntry>;
  plan_phases?: PlanPhase[];
  /** Consultation attempt counts per state key (e.g., "specify:consult" -> 2) */
  consultation_attempts?: Record<string, number>;
  iteration: number;
  started_at: string;
  last_updated: string;
  log: Array<LogEntry | string | unknown>;
}

// ============================================================================
// Command Options
// ============================================================================

/**
 * Options for porch run command
 */
export interface PorchRunOptions {
  dryRun?: boolean;
  noClaude?: boolean;
  pollInterval?: number;
}

/**
 * Options for porch init command
 */
export interface PorchInitOptions {
  description?: string;
  worktree?: string;
}

/**
 * Options for porch approve command
 */
export interface PorchApproveOptions {
  // no special options yet
}

/**
 * Options for porch status command
 */
export interface PorchStatusOptions {
  pendingOnly?: boolean;
}

// ============================================================================
// Consultation Types
// ============================================================================

/**
 * Verdict from a consultation
 */
export type ConsultationVerdict = 'APPROVE' | 'REQUEST_CHANGES';

/**
 * Single model's consultation feedback
 */
export interface ConsultationFeedback {
  model: string;
  verdict: ConsultationVerdict;
  summary: string;
  details?: string;
}

/**
 * Result of a consultation round
 */
export interface ConsultationResult {
  round: number;
  feedback: ConsultationFeedback[];
  allApproved: boolean;
}
