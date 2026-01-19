/**
 * Plan Parser
 *
 * Extracts implementation phases from plan.md files.
 * Supports the standard codev plan format with `### Phase N: <title>` headers.
 */

import * as fs from 'node:fs';
import type { PlanPhase } from './types.js';

/**
 * Extract phases from a plan markdown file
 *
 * Looks for either:
 * - `## Implementation Phases` or `## Phases` section
 * - `### Phase N: <title>` headers within that section
 *
 * Falls back to treating entire implementation as single phase if no structured phases found.
 */
export function extractPhasesFromPlan(planContent: string): PlanPhase[] {
  const phases: PlanPhase[] = [];

  // Look for the phases section
  const phaseSectionMatch = planContent.match(
    /##\s*(?:Implementation\s+)?Phases\s*\n([\s\S]*?)(?=\n##\s|$)/i
  );

  if (!phaseSectionMatch) {
    // No phases section found, return single default phase
    return [{
      id: 'phase_1',
      title: 'Implementation',
      description: 'Single implementation phase (no structured phases in plan)',
    }];
  }

  const phasesSection = phaseSectionMatch[1];

  // Extract individual phases with ### Phase N: <title> format
  const phaseRegex = /###\s*Phase\s+(\d+):\s*([^\n]+)\n([\s\S]*?)(?=\n###\s*Phase|\n##\s|$)/gi;
  let match;

  while ((match = phaseRegex.exec(phasesSection)) !== null) {
    const [, number, title, content] = match;
    const phaseId = `phase_${number}`;

    // Extract description from content (bullet points or first paragraph)
    const description = extractPhaseDescription(content);

    phases.push({
      id: phaseId,
      title: title.trim(),
      description,
    });
  }

  // If no phases found with numbered format, try alternative format
  if (phases.length === 0) {
    // Try format: ### <title> (without Phase N prefix)
    const altRegex = /###\s*([^\n]+)\n([\s\S]*?)(?=\n###|\n##\s|$)/gi;

    let phaseNum = 1;
    while ((match = altRegex.exec(phasesSection)) !== null) {
      const [, title, content] = match;

      // Skip if this looks like a non-phase section
      if (title.toLowerCase().includes('dependencies') ||
          title.toLowerCase().includes('acceptance') ||
          title.toLowerCase().includes('test')) {
        continue;
      }

      phases.push({
        id: `phase_${phaseNum}`,
        title: title.trim(),
        description: extractPhaseDescription(content),
      });
      phaseNum++;
    }
  }

  // If still no phases, return single default
  if (phases.length === 0) {
    return [{
      id: 'phase_1',
      title: 'Implementation',
      description: 'Single implementation phase (could not parse plan phases)',
    }];
  }

  return phases;
}

/**
 * Extract a description from phase content
 * Takes the first few bullet points or the first paragraph
 */
function extractPhaseDescription(content: string): string {
  const lines = content.trim().split('\n');
  const descLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Stop at subheadings
    if (trimmed.startsWith('###') || trimmed.startsWith('####')) {
      break;
    }

    // Collect bullet points
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const bulletContent = trimmed.slice(2).trim();
      // Skip long bullets
      if (bulletContent.length < 100) {
        descLines.push(bulletContent);
      }
    }

    // Limit to first 5 items
    if (descLines.length >= 5) break;
  }

  return descLines.join(', ');
}

/**
 * Extract phases from a plan file path
 */
export function extractPhasesFromPlanFile(planFilePath: string): PlanPhase[] {
  if (!fs.existsSync(planFilePath)) {
    throw new Error(`Plan file not found: ${planFilePath}`);
  }

  const content = fs.readFileSync(planFilePath, 'utf-8');
  return extractPhasesFromPlan(content);
}

/**
 * Find the plan file for a project
 */
export function findPlanFile(projectRoot: string, projectId: string, projectName?: string): string | null {
  const possiblePaths = [
    // New structure: codev/projects/<id>-<name>/plan.md
    `${projectRoot}/codev/projects/${projectId}-${projectName}/plan.md`,
    `${projectRoot}/codev/projects/${projectId}/plan.md`,
    // Legacy structure: codev/plans/<id>-<name>.md
    `${projectRoot}/codev/plans/${projectId}-${projectName}.md`,
  ];

  // Also try to find by ID prefix in legacy structure
  const plansDir = `${projectRoot}/codev/plans`;
  if (fs.existsSync(plansDir)) {
    const files = fs.readdirSync(plansDir);
    const match = files.find(f => f.startsWith(`${projectId}-`) && f.endsWith('.md'));
    if (match) {
      possiblePaths.push(`${plansDir}/${match}`);
    }
  }

  for (const planPath of possiblePaths) {
    if (fs.existsSync(planPath)) {
      return planPath;
    }
  }

  return null;
}

/**
 * Get the current phase ID based on completed phases
 */
export function getCurrentPhase(
  phases: PlanPhase[],
  completedPhases: Set<string>
): PlanPhase | null {
  for (const phase of phases) {
    if (!completedPhases.has(phase.id)) {
      return phase;
    }
  }
  return null; // All phases complete
}

/**
 * Get the next phase after a given phase
 */
export function getNextPhase(
  phases: PlanPhase[],
  currentPhaseId: string
): PlanPhase | null {
  const currentIndex = phases.findIndex(p => p.id === currentPhaseId);
  if (currentIndex >= 0 && currentIndex < phases.length - 1) {
    return phases[currentIndex + 1];
  }
  return null;
}

/**
 * Check if all phases are complete
 */
export function allPhasesComplete(
  phases: PlanPhase[],
  completedPhases: Set<string>
): boolean {
  return phases.every(p => completedPhases.has(p.id));
}
