/**
 * Porch Plan Parsing
 *
 * Extracts implementation phases from plan.md files.
 * Looks for `### Phase N: <title>` headers or JSON phases block.
 *
 * Plan phases are simple: pending → in_progress → complete.
 * All checks (implement, defend, evaluate) run together at the end.
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
export function findPlanFile(workspaceRoot: string, projectId: string, projectName?: string): string | null {
  const searchPaths: string[] = [];

  // New structure: codev/projects/<id>-<name>/plan.md
  if (projectName) {
    searchPaths.push(path.join(workspaceRoot, 'codev/projects', `${projectId}-${projectName}`, 'plan.md'));
  }

  // Legacy structure: codev/plans/<id>-*.md
  const plansDir = path.join(workspaceRoot, 'codev/plans');
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

/**
 * Extract phases from plan markdown content
 * Returns phases with status 'pending'
 *
 * Supports two formats:
 *
 * 1. JSON code block:
 * ```json
 * {"phases": [{"id": "phase_1", "title": "..."}, ...]}
 * ```
 *
 * 2. Markdown headers (fallback):
 * ## Phase 1: Core Types
 * ## Phase 2: State Management
 *
 * Also matches "---" separated sections with "## Phase N:" headers.
 */
export function extractPlanPhases(planContent: string): PlanPhase[] {
  // First, try JSON code block with phases
  const jsonMatch = planContent.match(/```json\s*\n([\s\S]*?)\n```/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.phases && Array.isArray(parsed.phases)) {
        return parsed.phases.map((p: { id: string; title: string }, index: number) => ({
          id: p.id,
          title: p.title,
          status: index === 0 ? 'in_progress' as const : 'pending' as const,
        }));
      }
    } catch (e) {
      // JSON parse failed, fall through to markdown parsing
      console.warn('Failed to parse phases JSON from plan:', e);
    }
  }

  // Second, try markdown headers: "## Phase N: Title" or "### Phase N: Title"
  const phaseHeaderRegex = /^#{2,3}\s+Phase\s+(\d+):\s*(.+)$/gm;
  const phases: PlanPhase[] = [];
  let match;

  while ((match = phaseHeaderRegex.exec(planContent)) !== null) {
    const phaseNum = match[1];
    const title = match[2].trim();
    phases.push({
      id: `phase_${phaseNum}`,
      title,
      status: phases.length === 0 ? 'in_progress' as const : 'pending' as const,
    });
  }

  if (phases.length > 0) {
    return phases;
  }

  // No phases found - return single default phase
  return [{
    id: 'phase_1',
    title: 'Implementation',
    status: 'in_progress',
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

/**
 * Check if a plan phase is complete
 */
export function isPlanPhaseComplete(phase: PlanPhase): boolean {
  return phase.status === 'complete';
}

/**
 * Get the current plan phase (first non-complete phase)
 */
export function getCurrentPlanPhase(phases: PlanPhase[]): PlanPhase | null {
  for (const phase of phases) {
    if (phase.status !== 'complete') {
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
 * Advance to the next plan phase
 * Marks current phase complete and next phase in_progress
 * Returns updated phases array and whether to move to review
 */
export function advancePlanPhase(
  phases: PlanPhase[],
  currentPhaseId: string
): { phases: PlanPhase[]; moveToReview: boolean } {
  const phaseIndex = phases.findIndex(p => p.id === currentPhaseId);
  if (phaseIndex < 0) {
    return { phases, moveToReview: false };
  }

  const updatedPhases = phases.map((p, i) => {
    if (i === phaseIndex) {
      return { ...p, status: 'complete' as const };
    }
    if (i === phaseIndex + 1) {
      return { ...p, status: 'in_progress' as const };
    }
    return p;
  });

  // Check if all phases are now complete
  const moveToReview = updatedPhases.every(p => p.status === 'complete');

  return { phases: updatedPhases, moveToReview };
}

/**
 * Get phase content from plan (the text under the phase header)
 * Matches both ## and ### phase headers, and terminates at the next
 * phase header of same or higher level, or a "---" separator.
 */
export function getPhaseContent(planContent: string, phaseId: string): string | null {
  // Extract phase number from id
  const numMatch = phaseId.match(/phase_(\d+)/);
  if (!numMatch) return null;

  const phaseNum = numMatch[1];
  // Match ## or ### Phase N: Title
  // Content ends at: next phase header (## or ### Phase), a --- separator, or end of file
  const regex = new RegExp(
    `#{2,3}\\s*Phase\\s+${phaseNum}:\\s*[^\\n]+\\n([\\s\\S]*?)(?=\\n#{2,3}\\s*Phase\\s+\\d|\\n---\\s*\\n|$)`,
    'i'
  );

  const match = planContent.match(regex);
  return match ? match[1].trim() : null;
}
