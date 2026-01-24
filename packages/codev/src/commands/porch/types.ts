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
 * Verification config - checks run after PHASE_COMPLETE with retry
 */
export interface PhaseVerification {
  checks: Record<string, string>;  // Check name -> command
  max_retries?: number;            // Max respawn attempts (default: 5)
}

/**
 * Phase definition in a protocol
 */
export interface ProtocolPhase {
  id: string;
  name: string;
  type?: 'once' | 'per_plan_phase' | 'phased';
  gate?: string;           // Gate name that blocks after this phase
  checks?: string[];       // Check names to run (keys into protocol.checks)
  verification?: PhaseVerification; // Post-completion checks with retry
  next?: string | null;    // Next phase id, or null if terminal
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
  verification_retries: number;            // Current retry count for verification
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
