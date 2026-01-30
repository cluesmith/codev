/**
 * Phase prompts for Porch
 *
 * Loads phase-specific prompts from the protocol's prompts/ directory.
 * Prompts are markdown files with {{variable}} placeholders.
 *
 * For build-verify cycles, when iteration > 1, previous build outputs
 * and review files are listed so Claude can read them for context.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectState, Protocol, ProtocolPhase, PlanPhase, IterationRecord } from './types.js';
import { getPhaseConfig, isPhased, isBuildVerify, getBuildConfig } from './protocol.js';
import { findPlanFile, getCurrentPlanPhase, getPhaseContent } from './plan.js';

/** Locations to search for protocol prompts */
const PROTOCOL_PATHS = [
  'codev/protocols',
  'codev-skeleton/protocols',
  'skeleton/protocols',  // Used in packages/codev
];

/**
 * Get project summary from projectlist.md.
 * Returns the summary field for the given project ID.
 */
function getProjectSummary(projectRoot: string, projectId: string): string | null {
  const projectlistPath = path.join(projectRoot, 'codev', 'projectlist.md');
  if (!fs.existsSync(projectlistPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(projectlistPath, 'utf-8');

    // Look for the project entry by ID
    // Format: - id: "0076" followed by summary: "..."
    const idPattern = new RegExp(`- id: ["']?${projectId}["']?`, 'i');
    const idMatch = content.match(idPattern);
    if (!idMatch) {
      return null;
    }

    // Find the summary after this ID (within the next ~500 chars)
    const afterId = content.slice(idMatch.index!, idMatch.index! + 500);
    const summaryMatch = afterId.match(/summary:\s*["'](.+?)["']/);
    if (summaryMatch) {
      return summaryMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Find the prompts directory for a protocol.
 */
function findPromptsDir(projectRoot: string, protocolName: string): string | null {
  for (const basePath of PROTOCOL_PATHS) {
    const promptsDir = path.join(projectRoot, basePath, protocolName, 'prompts');
    if (fs.existsSync(promptsDir)) {
      return promptsDir;
    }
  }
  return null;
}

/**
 * Load a prompt file from the protocol's prompts directory.
 */
function loadPromptFile(promptsDir: string, promptFile: string): string | null {
  const promptPath = path.join(promptsDir, promptFile);
  if (fs.existsSync(promptPath)) {
    return fs.readFileSync(promptPath, 'utf-8');
  }
  return null;
}

/**
 * Substitute template variables in a prompt.
 */
function substituteVariables(
  prompt: string,
  state: ProjectState,
  planPhase?: PlanPhase | null,
  summary?: string | null
): string {
  const variables: Record<string, string> = {
    project_id: state.id,
    title: state.title,
    current_state: state.phase,
    protocol: state.protocol,
  };

  // Add summary/goal if available
  if (summary) {
    variables.summary = summary;
    variables.goal = summary;  // Alias for convenience
  }

  if (planPhase) {
    variables.plan_phase_id = planPhase.id;
    variables.plan_phase_title = planPhase.title;
  }

  // Replace {{variable}} with values
  return prompt.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    return variables[varName] || match;
  });
}

/**
 * Build a header listing all previous iteration files.
 * Claude can read these files to understand the history and feedback.
 */
function buildHistoryHeader(history: IterationRecord[], currentIteration: number): string {
  const lines: string[] = [
    '# ⚠️ REVISION REQUIRED',
    '',
    `This is iteration ${currentIteration}. Previous iterations received feedback from reviewers.`,
    '',
    '**Read the files below to understand the history and address the feedback.**',
    '',
    '## Previous Iterations',
    '',
  ];

  for (const record of history) {
    lines.push(`### Iteration ${record.iteration}`);
    lines.push('');

    if (record.build_output) {
      lines.push(`**Build Output:** \`${record.build_output}\``);
    }

    if (record.reviews.length > 0) {
      lines.push('');
      lines.push('**Reviews:**');
      for (const review of record.reviews) {
        const icon = review.verdict === 'APPROVE' ? '✓' :
                     review.verdict === 'COMMENT' ? '💬' : '✗';
        lines.push(`- ${review.model} (${icon} ${review.verdict}): \`${review.file}\``);
      }
    }
    lines.push('');
  }

  lines.push('## Instructions');
  lines.push('');
  lines.push('1. Read the review files above to understand the feedback');
  lines.push('2. Address any REQUEST_CHANGES issues');
  lines.push('3. Consider suggestions from COMMENT and APPROVE reviews');
  lines.push('');

  return lines.join('\n');
}

/**
 * Build a prompt for the current phase.
 * Loads from protocol's prompts/ directory if available, otherwise uses fallback.
 *
 * For build-verify phases with iteration > 1, lists previous build outputs
 * and review files so Claude can read them for context.
 */
export function buildPhasePrompt(
  projectRoot: string,
  state: ProjectState,
  protocol: Protocol
): string {
  const phaseConfig = getPhaseConfig(protocol, state.phase);
  if (!phaseConfig) {
    return buildFallbackPrompt(state, 'unknown');
  }

  // Get project summary from projectlist.md
  const summary = getProjectSummary(projectRoot, state.id);

  // Get current plan phase for phased protocols
  let currentPlanPhase: PlanPhase | null = null;

  if (isPhased(protocol, state.phase) && state.plan_phases.length > 0) {
    currentPlanPhase = getCurrentPlanPhase(state.plan_phases);
  }

  // Build history header if this is a retry iteration
  let historyHeader = '';
  if (isBuildVerify(protocol, state.phase) && state.iteration > 1 && state.history.length > 0) {
    historyHeader = buildHistoryHeader(state.history, state.iteration);
  }

  // Build user answers section if they asked clarifying questions
  let userAnswersSection = '';
  if (state.context?.user_answers) {
    userAnswersSection = `# User Answers to Your Questions\n\n${state.context.user_answers}\n\n---\n\n`;
  }

  // Try to load prompt from protocol directory
  const promptsDir = findPromptsDir(projectRoot, state.protocol);
  if (promptsDir) {
    // Get prompt filename from protocol's build config, fallback to phase.md
    const buildConfig = getBuildConfig(protocol, state.phase);
    const promptFileName = buildConfig?.prompt || `${state.phase}.md`;

    const promptContent = loadPromptFile(promptsDir, promptFileName);
    if (promptContent) {
      let result = substituteVariables(promptContent, state, currentPlanPhase, summary);

      // Add goal/summary header if available
      if (summary) {
        result = `## Goal\n\n${summary}\n\n---\n\n` + result;
      }

      // Add user answers if Claude asked clarifying questions
      if (userAnswersSection) {
        result = userAnswersSection + result;
      }

      // Add plan phase context if applicable
      if (currentPlanPhase) {
        result = addPlanPhaseContext(projectRoot, state, currentPlanPhase, result);
      }

      // Prepend history if this is a retry
      if (historyHeader) {
        result = historyHeader + '\n\n---\n\n' + result;
      }

      return result;
    }
  }

  // Fallback to generic prompt if no protocol prompt found
  let fallback = buildFallbackPrompt(state, phaseConfig.name, currentPlanPhase, summary);

  // Prepend history if this is a retry
  if (historyHeader) {
    fallback = historyHeader + '\n\n---\n\n' + fallback;
  }

  return fallback;
}

/**
 * Add plan phase context from the plan file.
 */
function addPlanPhaseContext(
  projectRoot: string,
  state: ProjectState,
  planPhase: PlanPhase,
  prompt: string
): string {
  const planPath = findPlanFile(projectRoot, state.id, state.title);
  if (!planPath) {
    return prompt;
  }

  try {
    const planContent = fs.readFileSync(planPath, 'utf-8');
    const phaseContent = getPhaseContent(planContent, planPhase.id);
    if (phaseContent) {
      return prompt + `\n\n## Current Plan Phase Details\n\n**${planPhase.id}: ${planPhase.title}**\n\n${phaseContent}\n`;
    }
  } catch {
    // Ignore errors reading plan
  }

  return prompt;
}


/**
 * Build a fallback prompt when no protocol prompt is found.
 */
function buildFallbackPrompt(
  state: ProjectState,
  phaseName: string,
  planPhase?: PlanPhase | null,
  summary?: string | null
): string {
  let prompt = `# Phase: ${phaseName}

You are executing the ${phaseName} phase of the ${state.protocol.toUpperCase()} protocol.

## Context

- **Project ID**: ${state.id}
- **Project Title**: ${state.title}
- **Protocol**: ${state.protocol}
`;

  if (planPhase) {
    prompt += `- **Plan Phase**: ${planPhase.id} - ${planPhase.title}\n`;
  }

  // Add goal from projectlist.md summary
  if (summary) {
    prompt += `\n## Goal\n\n${summary}\n`;
  }

  prompt += `
## Task

Complete the work for this phase according to the protocol.

`;

  return prompt;
}
