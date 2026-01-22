/**
 * Porch2 Plan Parsing
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

/**
 * Extract phases from plan markdown content
 * Returns phases with 'pending' status
 */
export function extractPlanPhases(planContent: string): PlanPhase[] {
  const phases: PlanPhase[] = [];

  // Look for the phases section
  const phaseSectionMatch = planContent.match(
    /##\s*(?:Implementation\s+)?Phases\s*\n([\s\S]*?)(?=\n##\s|$)/i
  );

  if (!phaseSectionMatch) {
    // No phases section - return single default phase
    return [{
      id: 'phase_1',
      title: 'Implementation',
      status: 'pending',
    }];
  }

  const phasesSection = phaseSectionMatch[1];

  // Extract phases with ### Phase N: <title> format
  const phaseRegex = /###\s*Phase\s+(\d+):\s*([^\n]+)/gi;
  let match;

  while ((match = phaseRegex.exec(phasesSection)) !== null) {
    const [, number, title] = match;
    phases.push({
      id: `phase_${number}`,
      title: title.trim(),
      status: 'pending',
    });
  }

  // Fallback: try ### <title> format (without Phase N prefix)
  if (phases.length === 0) {
    const altRegex = /###\s*([^\n]+)/gi;
    let phaseNum = 1;

    while ((match = altRegex.exec(phasesSection)) !== null) {
      const [, title] = match;
      const trimmed = title.trim().toLowerCase();

      // Skip non-phase sections
      if (trimmed.includes('dependencies') ||
          trimmed.includes('acceptance') ||
          trimmed.includes('test') ||
          trimmed.includes('overview')) {
        continue;
      }

      phases.push({
        id: `phase_${phaseNum}`,
        title: title.trim(),
        status: 'pending',
      });
      phaseNum++;
    }
  }

  // If still no phases, return single default
  if (phases.length === 0) {
    return [{
      id: 'phase_1',
      title: 'Implementation',
      status: 'pending',
    }];
  }

  return phases;
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
  return phases.every(p => p.status === 'complete');
}

/**
 * Advance to the next plan phase
 * Marks current as complete, returns new phases array
 */
export function advancePlanPhase(phases: PlanPhase[], currentPhaseId: string): PlanPhase[] {
  return phases.map(p => {
    if (p.id === currentPhaseId) {
      return { ...p, status: 'complete' as const };
    }
    // Mark next phase as in_progress
    const currentIndex = phases.findIndex(phase => phase.id === currentPhaseId);
    const nextIndex = currentIndex + 1;
    if (phases[nextIndex]?.id === p.id) {
      return { ...p, status: 'in_progress' as const };
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
