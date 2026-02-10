/**
 * Porch - Protocol Orchestrator
 *
 * Simplified type definitions. Claude calls porch as a tool;
 * porch returns prescriptive instructions.
 */

// ============================================================================
// Protocol Definition Types (loaded from protocol.json)
// ============================================================================

/**
 * Build config for build_verify phases
 */
export interface BuildConfig {
  prompt: string;           // Prompt file (e.g., "specify.md")
  artifact: string;         // Artifact path pattern (e.g., "codev/specs/${PROJECT_ID}-*.md")
}

/**
 * Verify config for build_verify phases - 3-way consultation
 */
export interface VerifyConfig {
  type: string;             // Review type (e.g., "spec-review", "plan-review")
  models: string[];         // ["gemini", "codex", "claude"]
  parallel?: boolean;       // Run consultations in parallel (default: true)
}

/**
 * On-complete actions
 */
export interface OnCompleteConfig {
  commit?: boolean;         // Commit artifact after successful verify
  push?: boolean;           // Push after commit
}

/**
 * Phase definition in a protocol
 */
export interface ProtocolPhase {
  id: string;
  name: string;
  type?: 'once' | 'per_plan_phase' | 'build_verify';
  build?: BuildConfig;           // Build config (for build_verify phases)
  verify?: VerifyConfig;         // Verify config (for build_verify phases)
  max_iterations?: number;       // Max build-verify iterations (default: 7)
  on_complete?: OnCompleteConfig; // Actions after successful verify
  gate?: string;                 // Gate name that blocks after this phase
  checks?: string[];             // Check names to run (keys into protocol.checks)
  next?: string | null;          // Next phase id, or null if terminal
}

/**
 * Check definition with optional working directory
 */
export interface CheckDef {
  command: string;             // Command to run (e.g., "npm run build")
  cwd?: string;               // Working directory relative to project root (e.g., "packages/codev")
}

/**
 * Protocol definition (loaded from protocol.json)
 */
export interface Protocol {
  name: string;
  version?: string;
  description?: string;
  phases: ProtocolPhase[];
  checks?: Record<string, CheckDef>;           // Check name -> definition
  phase_completion?: Record<string, string>; // Checks run when a plan phase completes (after evaluate)
}

// ============================================================================
// Project State Types (stored in status.yaml)
// ============================================================================

/**
 * Gate status
 */
export interface GateStatus {
  status: 'pending' | 'approved';
  requested_at?: string;
  approved_at?: string;
}

/**
 * Plan phase status
 */
export type PlanPhaseStatus = 'pending' | 'in_progress' | 'complete';

/**
 * Plan phase extracted from plan.md
 * Each plan phase is a single unit - implement, defend, evaluate happen together
 */
export interface PlanPhase {
  id: string;
  title: string;
  status: PlanPhaseStatus;
}

/**
 * Verdict from a 3-way review
 *
 * CONSULT_ERROR: Consultation failed (API key missing, network error, timeout)
 *                Not a valid review - triggers retry, not REQUEST_CHANGES
 */
export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | 'CONSULT_ERROR';

/**
 * Review result with file path
 */
export interface ReviewResult {
  model: string;
  verdict: Verdict;
  file: string;           // Path to review output file
}

/**
 * Record of a single build-verify iteration
 */
export interface IterationRecord {
  iteration: number;
  plan_phase?: string;      // Which plan phase this belongs to (for per_plan_phase protocols)
  build_output: string;     // Path to Claude's build output file
  reviews: ReviewResult[];  // Reviews from verification
}

/**
 * Project state (stored in status.yaml)
 */
export interface ProjectState {
  id: string;
  title: string;
  protocol: string;
  phase: string;                           // Current protocol phase (e.g., "implement")
  plan_phases: PlanPhase[];                // Phases from plan.md
  current_plan_phase: string | null;       // Current plan phase id
  gates: Record<string, GateStatus>;       // Gate statuses
  iteration: number;                       // Current build-verify iteration (1-based)
  build_complete: boolean;                 // Has build finished this iteration?
  history: IterationRecord[];              // History of all iterations (for context)
  awaiting_input?: boolean;                 // Worker signaled it needs human input
  awaiting_input_output?: string;           // Output file path when AWAITING_INPUT was set (for resume guard)
  awaiting_input_hash?: string;            // SHA-256 hash of output at time of AWAITING_INPUT (for resume guard)
  context?: Record<string, string>;        // User-provided context (e.g., answers to questions)
  started_at: string;
  updated_at: string;
}

// ============================================================================
// Porch Next Response Types (output of `porch next`)
// ============================================================================

/**
 * Response from `porch next <id>`.
 * Tells the builder what to do next.
 */
export interface PorchNextResponse {
  status: 'tasks' | 'gate_pending' | 'complete' | 'error';
  phase: string;
  iteration: number;
  plan_phase?: string;

  /** Present when status === 'tasks' or 'gate_pending' (gate tasks are actionable) */
  tasks?: PorchTask[];

  /** Present when status === 'gate_pending' */
  gate?: string;

  /** Present when status === 'error' */
  error?: string;

  /** Present when status === 'complete' */
  summary?: string;
}

/**
 * A task for the builder to execute.
 * Claude Code creates these via TaskCreate.
 */
export interface PorchTask {
  subject: string;            // Imperative title (e.g., "Run 3-way consultation on spec")
  activeForm: string;         // Present continuous (e.g., "Running spec consultation")
  description: string;        // Full instructions for Claude to execute
  sequential?: boolean;       // If true, must complete before next task starts (default: false)
}

// ============================================================================
// Check Results
// ============================================================================

/**
 * Result of running a check
 */
export interface CheckResult {
  name: string;
  command: string;
  passed: boolean;
  output?: string;
  error?: string;
  duration_ms?: number;
}
