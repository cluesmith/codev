/**
 * Porch2 - Minimal Protocol Orchestrator
 *
 * Simplified type definitions. Claude calls porch as a tool;
 * porch returns prescriptive instructions.
 */

// ============================================================================
// Protocol Definition Types (loaded from protocol.json)
// ============================================================================

/**
 * Phase definition in a protocol
 */
export interface ProtocolPhase {
  id: string;
  name: string;
  type?: 'once' | 'per_plan_phase' | 'phased';
  gate?: string;           // Gate name that blocks after this phase
  checks?: string[];       // Check names to run (keys into protocol.checks)
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
  checks?: Record<string, string>;  // Check name -> command (e.g., "build": "npm run build")
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
 * Plan phase extracted from plan.md
 */
export interface PlanPhase {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'complete';
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
