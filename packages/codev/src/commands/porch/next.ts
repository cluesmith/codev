/**
 * porch next - Pure planner for protocol execution.
 *
 * Given the current state (status.yaml + filesystem), emits structured
 * JSON task definitions for the builder to execute. No subprocess spawning,
 * no while loop — just read state, compute tasks, output JSON.
 *
 * The builder loop:
 *   porch next → execute tasks → porch done → porch next → ...
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';
import { readState, writeState, findStatusPath, getProjectDir } from './state.js';
import {
  loadProtocol,
  getPhaseConfig,
  getNextPhase,
  getPhaseGate,
  isPhased,
  isBuildVerify,
  getBuildConfig,
  getVerifyConfig,
  getMaxIterations,
  getOnCompleteConfig,
  getPhaseChecks,
} from './protocol.js';
import {
  findPlanFile,
  extractPhasesFromFile,
  getCurrentPlanPhase,
  advancePlanPhase,
  allPlanPhasesComplete,
} from './plan.js';
import { buildPhasePrompt } from './prompts.js';
import { parseVerdict, allApprove } from './verdict.js';
import type {
  ProjectState,
  Protocol,
  ProtocolPhase,
  PorchNextResponse,
  PorchTask,
  ReviewResult,
} from './types.js';

/**
 * Check if an artifact file has YAML frontmatter indicating it was
 * already approved and validated (3-way review).
 *
 * Frontmatter format:
 * ---
 * approved: 2026-01-29
 * validated: [gemini, codex, claude]
 * ---
 */
function isArtifactPreApproved(projectRoot: string, artifactGlob: string): boolean {
  const matches = globSync(artifactGlob, { cwd: projectRoot });
  if (matches.length === 0) return false;

  const filePath = path.join(projectRoot, matches[0]);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return false;

    const frontmatter = frontmatterMatch[1];
    const hasApproved = /^approved:\s*.+$/m.test(frontmatter);
    const hasValidated = /^validated:\s*\[.+\]$/m.test(frontmatter);
    return hasApproved && hasValidated;
  } catch {
    return false;
  }
}

/**
 * Find review files for the current iteration in the project directory.
 * Review files are created by the `consult` CLI and follow the pattern:
 *   <id>-<phase>-iter<N>-<model>.txt
 */
function findReviewFiles(
  projectRoot: string,
  state: ProjectState,
  verifyModels: string[]
): ReviewResult[] {
  const projectDir = getProjectDir(projectRoot, state.id, state.title);
  if (!fs.existsSync(projectDir)) return [];

  const results: ReviewResult[] = [];
  const phase = state.current_plan_phase || state.phase;

  for (const model of verifyModels) {
    const fileName = `${state.id}-${phase}-iter${state.iteration}-${model}.txt`;
    const filePath = path.join(projectDir, fileName);

    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const verdict = parseVerdict(content);
      results.push({ model, verdict, file: filePath });
    }
  }

  return results;
}

/**
 * Compute the expected review file path for a given model.
 * This must match the pattern used by findReviewFiles().
 */
function getReviewFilePath(
  projectRoot: string,
  state: ProjectState,
  model: string
): string {
  const projectDir = getProjectDir(projectRoot, state.id, state.title);
  const phase = state.current_plan_phase || state.phase;
  const fileName = `${state.id}-${phase}-iter${state.iteration}-${model}.txt`;
  return path.join(projectDir, fileName);
}

/**
 * Find a rebuttal file for a given iteration.
 * Rebuttals are written by the builder to dispute false positive reviewer concerns.
 */
function findRebuttalFile(
  projectRoot: string,
  state: ProjectState,
  iteration: number
): string | null {
  const projectDir = getProjectDir(projectRoot, state.id, state.title);
  const phase = state.current_plan_phase || state.phase;
  const fileName = `${state.id}-${phase}-iter${iteration}-rebuttals.md`;
  const filePath = path.join(projectDir, fileName);
  return fs.existsSync(filePath) ? filePath : null;
}

/**
 * Extract SUMMARY line from a review file.
 */
function extractReviewSummary(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/SUMMARY:\s*(.+)/);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * Build review context for stateful consultations.
 * Includes previous iteration reviews and builder rebuttals so consultants
 * can see what was raised before and how the builder responded.
 */
function buildReviewContext(
  projectRoot: string,
  state: ProjectState,
): string | null {
  if (state.history.length === 0) return null;

  const currentPhase = state.current_plan_phase || undefined;
  const phaseHistory = state.history.filter(
    h => (h.plan_phase || undefined) === currentPhase
  );
  if (phaseHistory.length === 0) return null;

  const lines: string[] = [];

  for (const record of phaseHistory) {
    lines.push(`### Iteration ${record.iteration} Reviews`);
    for (const review of record.reviews) {
      const summary = extractReviewSummary(review.file);
      const summaryStr = summary ? ` — ${summary}` : '';
      lines.push(`- ${review.model}: ${review.verdict}${summaryStr}`);
    }
    lines.push('');

    // Check for builder rebuttals
    const rebuttalFile = findRebuttalFile(projectRoot, state, record.iteration);
    if (rebuttalFile) {
      try {
        const rebuttals = fs.readFileSync(rebuttalFile, 'utf-8');
        lines.push(`### Builder Response to Iteration ${record.iteration}`);
        lines.push(rebuttals);
        lines.push('');
      } catch { /* ignore read errors */ }
    }
  }

  lines.push('### IMPORTANT: Stateful Review Context');
  lines.push('This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.');
  lines.push('Before re-raising a previous concern:');
  lines.push('1. Check if the builder has already addressed it in code');
  lines.push('2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting');
  lines.push('3. Do not re-raise concerns that have been explained as false positives with valid justification');
  lines.push('4. Check package.json and config files for version numbers before flagging missing configuration');
  lines.push('');

  return lines.join('\n');
}

/**
 * Compute the next tasks for a project.
 *
 * This is a pure planner — it reads state and filesystem, infers what
 * happened since the last call, and emits the next batch of tasks.
 *
 * State is only mutated when completed work is detected (filesystem-as-truth).
 * If called twice without filesystem changes, returns the same output.
 */
export async function next(projectRoot: string, projectId: string): Promise<PorchNextResponse> {
  const statusPath = findStatusPath(projectRoot, projectId);
  if (!statusPath) {
    return {
      status: 'error',
      phase: 'unknown',
      iteration: 0,
      error: `Project ${projectId} not found. Run 'porch init' to create a new project.`,
    };
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(projectRoot, state.protocol);
  const phaseConfig = getPhaseConfig(protocol, state.phase);

  // Protocol complete
  if (state.phase === 'complete' || !phaseConfig) {
    return {
      status: 'complete',
      phase: state.phase,
      iteration: state.iteration,
      summary: `Project ${state.id} has completed the ${state.protocol} protocol.`,
      tasks: [{
        subject: 'Merge the pull request',
        activeForm: 'Merging pull request',
        description: `The protocol is complete. Merge the PR using:\n\ngh pr merge --merge\n\nDo NOT squash merge. Use regular merge commits to preserve development history.\n\nAfter merging, notify the architect:\n\naf send architect "Project ${state.id} complete. PR merged. Ready for cleanup."`,
        sequential: true,
      }],
    };
  }

  // Check for pre-approved artifacts (skip build+verify)
  if (isBuildVerify(protocol, state.phase) && !state.build_complete && state.iteration === 1) {
    const buildConfig = getBuildConfig(protocol, state.phase);
    if (buildConfig?.artifact) {
      const artifactGlob = buildConfig.artifact.replace('${PROJECT_ID}', state.id);
      if (isArtifactPreApproved(projectRoot, artifactGlob)) {
        // Auto-approve gate and advance
        const gateName = getPhaseGate(protocol, state.phase);
        if (gateName) {
          state.gates[gateName] = { status: 'approved', approved_at: new Date().toISOString() };
        }
        // Advance to next phase
        const nextPhase = getNextPhase(protocol, state.phase);
        if (nextPhase) {
          state.phase = nextPhase.id;
          // If entering phased protocol, extract plan phases
          if (isPhased(protocol, nextPhase.id)) {
            const planPath = findPlanFile(projectRoot, state.id, state.title);
            if (planPath) {
              state.plan_phases = extractPhasesFromFile(planPath);
              if (state.plan_phases.length > 0) {
                state.current_plan_phase = state.plan_phases[0].id;
              }
            }
          }
          state.iteration = 1;
          state.build_complete = false;
          state.history = [];
          writeState(statusPath, state);
          // Recurse to compute tasks for the new phase
          return next(projectRoot, projectId);
        }
      }
    }
  }

  // Check gate status
  const gateName = getPhaseGate(protocol, state.phase);
  if (gateName) {
    const gateStatus = state.gates[gateName];

    // Gate pending and requested — tell builder to wait
    if (gateStatus?.status === 'pending' && gateStatus?.requested_at) {
      return {
        status: 'gate_pending',
        phase: state.phase,
        iteration: state.iteration,
        plan_phase: state.current_plan_phase || undefined,
        gate: gateName,
        tasks: [{
          subject: `Request human approval: ${gateName}`,
          activeForm: `Requesting ${gateName} approval`,
          description: `Run: porch gate ${state.id}\nThis will open the artifact for human review.\n\nNotify the architect:\n\naf send architect "Project ${state.id}: ${gateName} ready for review. Waiting for approval."\n\nSTOP and wait for human approval before proceeding.`,
        }],
      };
    }

    // Gate approved — advance to next phase
    if (gateStatus?.status === 'approved') {
      const nextPhase = getNextPhase(protocol, state.phase);
      if (!nextPhase) {
        state.phase = 'complete';
        writeState(statusPath, state);
        return next(projectRoot, projectId);
      }

      state.phase = nextPhase.id;
      state.iteration = 1;
      state.build_complete = false;
      state.history = [];

      // If entering phased protocol, extract plan phases
      if (isPhased(protocol, nextPhase.id)) {
        const planPath = findPlanFile(projectRoot, state.id, state.title);
        if (planPath) {
          state.plan_phases = extractPhasesFromFile(planPath);
          if (state.plan_phases.length > 0) {
            state.current_plan_phase = state.plan_phases[0].id;
          }
        }
      }

      writeState(statusPath, state);
      return next(projectRoot, projectId);
    }
  }

  // Handle build_verify / per_plan_phase phases
  if (isBuildVerify(protocol, state.phase)) {
    return await handleBuildVerify(projectRoot, projectId, state, protocol, phaseConfig, statusPath);
  }

  // Handle 'once' phases (TICK, BUGFIX)
  return handleOncePhase(projectRoot, state, protocol, phaseConfig);
}

/**
 * Handle build_verify and per_plan_phase phases.
 */
async function handleBuildVerify(
  projectRoot: string,
  projectId: string,
  state: ProjectState,
  protocol: Protocol,
  phaseConfig: ProtocolPhase,
  statusPath: string,
): Promise<PorchNextResponse> {
  const verifyConfig = getVerifyConfig(protocol, state.phase);
  const maxIterations = getMaxIterations(protocol, state.phase);

  // Determine plan phase context for per_plan_phase protocols
  const planPhase = isPhased(protocol, state.phase)
    ? getCurrentPlanPhase(state.plan_phases)
    : null;

  const baseResponse = {
    phase: state.phase,
    iteration: state.iteration,
    plan_phase: planPhase?.id || state.current_plan_phase || undefined,
  };

  // --- NEED BUILD ---
  if (!state.build_complete) {
    const prompt = buildPhasePrompt(projectRoot, state, protocol);
    const tasks: PorchTask[] = [];

    // Main build task with full phase prompt
    if (state.iteration === 1) {
      tasks.push({
        subject: `${phaseConfig.name}: Build artifact`,
        activeForm: `Building ${phaseConfig.name.toLowerCase()} artifact`,
        description: prompt,
        sequential: true,
      });
    } else {
      tasks.push({
        subject: `${phaseConfig.name}: Fix issues from iteration ${state.iteration - 1}`,
        activeForm: `Fixing ${phaseConfig.name.toLowerCase()} issues (iteration ${state.iteration})`,
        description: prompt,
        sequential: true,
      });
    }

    // Add check tasks
    const checks = getPhaseChecks(protocol, state.phase);
    for (const [name, checkDef] of Object.entries(checks)) {
      const cwdNote = checkDef.cwd ? `\n\nIMPORTANT: Run this from the \`${checkDef.cwd}\` subdirectory (relative to project root).` : '';
      tasks.push({
        subject: `Run check: ${name}`,
        activeForm: `Running ${name} check`,
        description: `Run: ${checkDef.command}${cwdNote}\n\nFix any failures before proceeding.`,
        sequential: true,
      });
    }

    // Signal completion
    tasks.push({
      subject: `Signal build complete`,
      activeForm: 'Signaling build complete',
      description: `Run: porch done ${state.id}\n\nThis validates checks and marks the build as complete for verification.`,
      sequential: true,
    });

    return { status: 'tasks', ...baseResponse, tasks };
  }

  // --- NEED VERIFY ---
  if (state.build_complete && verifyConfig) {
    const reviews = findReviewFiles(projectRoot, state, verifyConfig.models);

    // No review files yet — emit consultation tasks
    if (reviews.length === 0) {
      const tasks: PorchTask[] = [];

      // Build consultation commands with --output so review files land where porch expects them
      const consultType = getConsultArtifactType(state.phase);
      const planPhaseFlag = state.current_plan_phase ? ` --plan-phase ${state.current_plan_phase}` : '';

      // For iteration > 1, generate context file with previous reviews + rebuttals
      let contextFlag = '';
      if (state.iteration > 1) {
        const context = buildReviewContext(projectRoot, state);
        if (context) {
          const projectDir = getProjectDir(projectRoot, state.id, state.title);
          const contextPath = path.join(
            projectDir,
            `${state.id}-${state.current_plan_phase || state.phase}-iter${state.iteration}-context.md`
          );
          fs.writeFileSync(contextPath, context);
          contextFlag = ` --context "${contextPath}"`;
        }
      }

      const consultCmds = verifyConfig.models.map(
        m => `consult --model ${m} --type ${verifyConfig.type}${planPhaseFlag}${contextFlag} --output "${getReviewFilePath(projectRoot, state, m)}" ${consultType} ${state.id}`
      );

      tasks.push({
        subject: `Run ${verifyConfig.models.length}-way consultation`,
        activeForm: `Running ${verifyConfig.models.length}-way consultation`,
        description: `Run these commands in parallel in the background:\n\n${consultCmds.join('\n')}\n\nWait for all to complete, then call \`porch next ${state.id}\` to get the next step.`,
      });

      return { status: 'tasks', ...baseResponse, tasks };
    }

    // Review files exist — check if all models reviewed
    if (reviews.length < verifyConfig.models.length) {
      // Partial reviews — still waiting. Emit same consultation tasks (idempotent).
      const consultType = getConsultArtifactType(state.phase);
      const missingModels = verifyConfig.models.filter(
        m => !reviews.find(r => r.model === m)
      );
      const planPhaseFlagPartial = state.current_plan_phase ? ` --plan-phase ${state.current_plan_phase}` : '';

      // Reuse context file from full consultation emission (if it exists)
      let contextFlagPartial = '';
      if (state.iteration > 1) {
        const projectDir = getProjectDir(projectRoot, state.id, state.title);
        const contextPath = path.join(
          projectDir,
          `${state.id}-${state.current_plan_phase || state.phase}-iter${state.iteration}-context.md`
        );
        if (fs.existsSync(contextPath)) {
          contextFlagPartial = ` --context "${contextPath}"`;
        }
      }

      const consultCmds = missingModels.map(
        m => `consult --model ${m} --type ${verifyConfig.type}${planPhaseFlagPartial}${contextFlagPartial} --output "${getReviewFilePath(projectRoot, state, m)}" ${consultType} ${state.id}`
      );

      return {
        status: 'tasks',
        ...baseResponse,
        tasks: [{
          subject: `Run remaining consultations (${missingModels.join(', ')})`,
          activeForm: `Running remaining consultations`,
          description: `Some consultations are still missing. Run:\n\n${consultCmds.join('\n')}\n\nThen call \`porch next ${state.id}\` again.`,
        }],
      };
    }

    // All reviews in — parse verdicts and decide
    if (allApprove(reviews)) {
      // All approve — advance
      return await handleVerifyApproved(projectRoot, projectId, state, protocol, statusPath, reviews);
    }

    // Some request changes — check max iterations escape
    if (state.iteration >= maxIterations) {
      // Max iterations — proceed to gate if one exists, otherwise force-advance
      const gateName = getPhaseGate(protocol, state.phase);
      if (gateName && state.gates[gateName]?.status !== 'approved') {
        state.gates[gateName] = { status: 'pending', requested_at: new Date().toISOString() };
        state.build_complete = false;
        state.iteration = 1;
        state.history = [];
        writeState(statusPath, state);

        return {
          status: 'gate_pending',
          phase: state.phase,
          iteration: state.iteration,
          plan_phase: state.current_plan_phase || undefined,
          gate: gateName,
          tasks: [{
            subject: `Request human approval: ${gateName} (max iterations reached)`,
            activeForm: `Requesting ${gateName} approval`,
            description: `Max iterations (${maxIterations}) reached without unanimous approval.\n\nReviewer verdicts:\n${formatVerdicts(reviews)}\n\nRun: porch gate ${state.id}\n\nNotify the architect:\n\naf send architect "Project ${state.id}: ${gateName} needs approval (max iterations reached). Waiting for review."\n\nSTOP and wait for human approval.`,
          }],
        };
      }

      // No gate for this phase (e.g., per_plan_phase implement) — force-advance
      // to prevent infinite loops when one model keeps blocking.
      return await handleVerifyApproved(projectRoot, projectId, state, protocol, statusPath, reviews);
    }

    // Increment iteration and emit fix tasks
    state.iteration++;
    state.build_complete = false;

    // Record reviews in history (scoped by plan_phase for disambiguation)
    const currentPhase = state.current_plan_phase || undefined;
    const existingRecord = state.history.find(
      h => h.iteration === state.iteration - 1 &&
           (h.plan_phase || undefined) === currentPhase
    );
    if (existingRecord) {
      existingRecord.reviews = reviews;
    } else {
      state.history.push({
        iteration: state.iteration - 1,
        plan_phase: currentPhase,
        build_output: '',
        reviews,
      });
    }

    writeState(statusPath, state);

    // Emit fix tasks (prompt will include history with feedback)
    const prompt = buildPhasePrompt(projectRoot, state, protocol);
    return {
      status: 'tasks',
      phase: state.phase,
      iteration: state.iteration,
      plan_phase: state.current_plan_phase || undefined,
      tasks: [
        {
          subject: `${phaseConfig.name}: Fix issues from review (iteration ${state.iteration})`,
          activeForm: `Fixing review issues (iteration ${state.iteration})`,
          description: prompt,
          sequential: true,
        },
        {
          subject: `Signal build complete`,
          activeForm: 'Signaling build complete',
          description: `Run: porch done ${state.id}\n\nThis validates checks and marks the build as complete for re-verification.`,
          sequential: true,
        },
      ],
    };
  }

  // build_complete but no verifyConfig — shouldn't happen for build_verify, but handle gracefully
  return {
    status: 'error',
    phase: state.phase,
    iteration: state.iteration,
    error: `Phase ${state.phase} has build_complete=true but no verify config.`,
  };
}

/**
 * Handle the case where all reviewers approve.
 * Advances plan phase or requests gate.
 */
async function handleVerifyApproved(
  projectRoot: string,
  projectId: string,
  state: ProjectState,
  protocol: Protocol,
  statusPath: string,
  reviews: ReviewResult[],
): Promise<PorchNextResponse> {
  const gateName = getPhaseGate(protocol, state.phase);

  // For per_plan_phase: advance to next plan phase (no gate between phases)
  if (isPhased(protocol, state.phase) && state.plan_phases.length > 0) {
    const currentPlanPhase = getCurrentPlanPhase(state.plan_phases);
    if (currentPlanPhase) {
      const { phases: updatedPhases, moveToReview } = advancePlanPhase(
        state.plan_phases,
        currentPlanPhase.id,
      );

      state.plan_phases = updatedPhases;
      state.build_complete = false;
      state.iteration = 1;
      // Preserve history across plan phases for audit trail
      // (plan_phase field on each entry disambiguates iterations)

      if (moveToReview) {
        // All plan phases done — move to review
        state.phase = 'review';
        state.current_plan_phase = null;
        writeState(statusPath, state);
        return next(projectRoot, projectId);
      }

      // Next plan phase
      const newCurrent = getCurrentPlanPhase(state.plan_phases);
      state.current_plan_phase = newCurrent?.id || null;
      writeState(statusPath, state);
      return next(projectRoot, projectId);
    }
  }

  // Request gate (for non-phased phases like specify, plan, review)
  if (gateName) {
    state.gates[gateName] = { status: 'pending', requested_at: new Date().toISOString() };
    state.build_complete = false;
    state.iteration = 1;
    state.history = [];
    writeState(statusPath, state);

    return {
      status: 'gate_pending',
      phase: state.phase,
      iteration: 1,
      gate: gateName,
      tasks: [{
        subject: `Request human approval: ${gateName}`,
        activeForm: `Requesting ${gateName} approval`,
        description: `All reviewers approved!\n\nReviewer verdicts:\n${formatVerdicts(reviews)}\n\nRun: porch gate ${state.id}\n\nNotify the architect:\n\naf send architect "Project ${state.id}: ${gateName} ready for approval. All reviewers approved."\n\nSTOP and wait for human approval.`,
      }],
    };
  }

  // No gate — advance to next phase directly
  const nextPhase = getNextPhase(protocol, state.phase);
  if (!nextPhase) {
    state.phase = 'complete';
    writeState(statusPath, state);
    return next(projectRoot, projectId);
  }

  state.phase = nextPhase.id;
  state.iteration = 1;
  state.build_complete = false;
  state.history = [];
  writeState(statusPath, state);
  return next(projectRoot, projectId);
}

/**
 * Handle 'once' phases (TICK, BUGFIX).
 * These don't have build/verify config — emit a single task.
 */
function handleOncePhase(
  projectRoot: string,
  state: ProjectState,
  protocol: Protocol,
  phaseConfig: ProtocolPhase,
): PorchNextResponse {
  // Try to load a prompt file for this phase
  const prompt = buildPhasePrompt(projectRoot, state, protocol);

  // If prompt is just a generic fallback, try to use phase steps from protocol
  let description = prompt;
  if (phaseConfig.checks && phaseConfig.checks.length > 0) {
    description += `\n\nAfter completing the work, run these checks:\n${phaseConfig.checks.map(c => `- ${c}`).join('\n')}`;
  }

  description += `\n\nWhen complete, run: porch done ${state.id}`;

  return {
    status: 'tasks',
    phase: state.phase,
    iteration: state.iteration,
    tasks: [{
      subject: `${phaseConfig.name}: Complete phase work`,
      activeForm: `Working on ${phaseConfig.name.toLowerCase()}`,
      description,
      sequential: true,
    }],
  };
}

/**
 * Get the consult artifact type for a phase.
 */
function getConsultArtifactType(phaseId: string): string {
  switch (phaseId) {
    case 'specify': return 'spec';
    case 'plan': return 'plan';
    case 'implement': return 'impl';
    case 'review': return 'review';
    default: return 'spec';
  }
}

/**
 * Format review verdicts for display.
 */
function formatVerdicts(reviews: ReviewResult[]): string {
  return reviews
    .map(r => `  ${r.model}: ${r.verdict}`)
    .join('\n');
}
