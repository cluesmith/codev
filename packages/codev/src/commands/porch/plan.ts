/**
 * Porch Plan Parsing
 *
 * Extracts implementation phases from plan.md files.
 * Looks for `### Phase N: <title>` headers.
 * Fails loudly if plan file is missing when required.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PlanPhase } from './types.js';

// ============================================================================
// Plan File Discovery
// ============================================================================

/**
 * Find the plan file for a project
 * Searches both legacy (codev/plans/NNNN-name.md) and new (codev/projects/NNNN-name/plan.md) locations
 */
export function findPlanFile(projectRoot: string, projectId: string, projectName?: string): string | null {
  const searchPaths: string[] = [];

  // New structure: codev/projects/<id>-<name>/plan.md
  if (projectName) {
    searchPaths.push(path.join(projectRoot, 'codev/projects', `${projectId}-${projectName}`, 'plan.md'));
  }

  // Legacy structure: codev/plans/<id>-*.md
  const plansDir = path.join(projectRoot, 'codev/plans');
  if (fs.existsSync(plansDir)) {
    const files = fs.readdirSync(plansDir);
    const match = files.find(f => f.startsWith(`${projectId}-`) && f.endsWith('.md'));
    if (match) {
      searchPaths.push(path.join(plansDir, match));
    }
  }

  for (const planPath of searchPaths) {
    if (fs.existsSync(planPath)) {
      return planPath;
    }
  }

  return null;
}

// ============================================================================
// Phase Extraction
// ============================================================================

/** Default stages for a new plan phase */
const DEFAULT_STAGES = {
  implement: 'pending' as const,
  defend: 'pending' as const,
  evaluate: 'pending' as const,
};

/**
 * Extract phases from plan markdown content
 * Returns phases with all stages pending
 *
 * Looks for a JSON code block in the "Phases (Machine Readable)" section:
 * ```json
 * {"phases": [{"id": "phase_1", "title": "..."}, ...]}
 * ```
 */
export function extractPlanPhases(planContent: string): PlanPhase[] {
  // Look for JSON code block with phases
  const jsonMatch = planContent.match(/```json\s*\n([\s\S]*?)\n```/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.phases && Array.isArray(parsed.phases)) {
        return parsed.phases.map((p: { id: string; title: string }) => ({
          id: p.id,
          title: p.title,
          stages: { ...DEFAULT_STAGES },
        }));
      }
    } catch (e) {
      // JSON parse failed, fall through to default
      console.warn('Failed to parse phases JSON from plan:', e);
    }
  }

  // No JSON block found - return single default phase
  return [{
    id: 'phase_1',
    title: 'Implementation',
    stages: { ...DEFAULT_STAGES },
  }];
}

/**
 * Extract phases from a plan file
 * Fails loudly if file doesn't exist
 */
export function extractPhasesFromFile(planFilePath: string): PlanPhase[] {
  if (!fs.existsSync(planFilePath)) {
    throw new Error(`Plan file not found: ${planFilePath}`);
  }

  const content = fs.readFileSync(planFilePath, 'utf-8');
  return extractPlanPhases(content);
}

// ============================================================================
// Phase Navigation
// ============================================================================

/** IDE stages in order */
const IDE_STAGES = ['implement', 'defend', 'evaluate'] as const;
type IDEStage = typeof IDE_STAGES[number];

/**
 * Check if a plan phase is fully complete (all stages complete)
 */
export function isPlanPhaseComplete(phase: PlanPhase): boolean {
  return phase.stages.implement === 'complete' &&
         phase.stages.defend === 'complete' &&
         phase.stages.evaluate === 'complete';
}

/**
 * Get the current stage within a plan phase
 */
export function getCurrentStage(phase: PlanPhase): IDEStage | null {
  for (const stage of IDE_STAGES) {
    if (phase.stages[stage] !== 'complete') {
      return stage;
    }
  }
  return null; // All stages complete
}

/**
 * Get the current plan phase (first non-complete phase)
 */
export function getCurrentPlanPhase(phases: PlanPhase[]): PlanPhase | null {
  for (const phase of phases) {
    if (!isPlanPhaseComplete(phase)) {
      return phase;
    }
  }
  return null; // All phases complete
}

/**
 * Get the next plan phase after a given phase
 */
export function getNextPlanPhase(phases: PlanPhase[], currentPhaseId: string): PlanPhase | null {
  const currentIndex = phases.findIndex(p => p.id === currentPhaseId);
  if (currentIndex >= 0 && currentIndex < phases.length - 1) {
    return phases[currentIndex + 1];
  }
  return null;
}

/**
 * Check if all plan phases are complete
 */
export function allPlanPhasesComplete(phases: PlanPhase[]): boolean {
  return phases.every(isPlanPhaseComplete);
}

/**
 * Advance the stage within a plan phase
 * Returns updated phases array and the next protocol phase to enter
 */
export function advanceStage(
  phases: PlanPhase[],
  currentPhaseId: string,
  currentStage: IDEStage
): { phases: PlanPhase[]; nextProtocolPhase: string | null } {
  const phaseIndex = phases.findIndex(p => p.id === currentPhaseId);
  if (phaseIndex < 0) {
    return { phases, nextProtocolPhase: null };
  }

  const stageIndex = IDE_STAGES.indexOf(currentStage);
  const updatedPhases = phases.map((p, i) => {
    if (i !== phaseIndex) return p;

    const newStages = { ...p.stages };
    newStages[currentStage] = 'complete';

    // If there's a next stage, mark it in_progress
    if (stageIndex < IDE_STAGES.length - 1) {
      newStages[IDE_STAGES[stageIndex + 1]] = 'in_progress';
    }

    return { ...p, stages: newStages };
  });

  // Determine next protocol phase
  let nextProtocolPhase: string | null = null;

  if (stageIndex < IDE_STAGES.length - 1) {
    // Move to next stage within same plan phase
    nextProtocolPhase = IDE_STAGES[stageIndex + 1];
  } else {
    // Completed evaluate, check if there's another plan phase
    if (phaseIndex < phases.length - 1) {
      // Start next plan phase at implement
      const nextPlanPhase = phases[phaseIndex + 1];
      updatedPhases[phaseIndex + 1] = {
        ...nextPlanPhase,
        stages: { ...nextPlanPhase.stages, implement: 'in_progress' },
      };
      nextProtocolPhase = 'implement';
    } else {
      // All plan phases complete, move to review
      nextProtocolPhase = 'review';
    }
  }

  return { phases: updatedPhases, nextProtocolPhase };
}

/**
 * Legacy: Advance to the next plan phase (for backward compat)
 * @deprecated Use advanceStage instead
 */
export function advancePlanPhase(phases: PlanPhase[], currentPhaseId: string): PlanPhase[] {
  // Mark all stages of current phase as complete
  return phases.map((p, i) => {
    if (p.id === currentPhaseId) {
      return {
        ...p,
        stages: { implement: 'complete', defend: 'complete', evaluate: 'complete' },
      };
    }
    // Mark next phase's implement as in_progress
    const currentIndex = phases.findIndex(phase => phase.id === currentPhaseId);
    if (i === currentIndex + 1) {
      return {
        ...p,
        stages: { ...p.stages, implement: 'in_progress' },
      };
    }
    return p;
  });
}

/**
 * Get phase content from plan (the text under the phase header)
 */
export function getPhaseContent(planContent: string, phaseId: string): string | null {
  // Extract phase number from id
  const numMatch = phaseId.match(/phase_(\d+)/);
  if (!numMatch) return null;

  const phaseNum = numMatch[1];
  const regex = new RegExp(
    `###\\s*Phase\\s+${phaseNum}:\\s*[^\\n]+\\n([\\s\\S]*?)(?=\\n###\\s*Phase|\\n##\\s|$)`,
    'i'
  );

  const match = planContent.match(regex);
  return match ? match[1].trim() : null;
}
