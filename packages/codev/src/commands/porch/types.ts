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
  max_iterations?: number;       // Max build-verify iterations (default: 3)
  on_complete?: OnCompleteConfig; // Actions after successful verify
  gate?: string;                 // Gate name that blocks after this phase
  checks?: string[];             // Check names to run (keys into protocol.checks)
  next?: string | null;          // Next phase id, or null if terminal
}

/**
 * Protocol definition (loaded from protocol.json)
 */
export interface Protocol {
  name: string;
  version?: string;
  description?: string;
  phases: ProtocolPhase[];
  checks?: Record<string, string>;           // Check name -> command (e.g., "build": "npm run build")
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
 */
export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

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
  build_output: string;   // Path to Claude's build output file
  reviews: ReviewResult[]; // Reviews from verification
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
  started_at: string;
  updated_at: string;
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
