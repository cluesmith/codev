/**
 * porch run - Main run loop (Build-Verify design)
 *
 * Porch orchestrates build-verify cycles:
 * 1. BUILD: Spawn Claude to create artifact
 * 2. VERIFY: Run 3-way consultation (Gemini, Codex, Claude)
 * 3. ITERATE: If any REQUEST_CHANGES, feed back to Claude
 * 4. COMPLETE: When all APPROVE (or max iterations), commit + push + gate
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { readState, writeState, findStatusPath } from './state.js';
import { loadProtocol, getPhaseConfig, isPhased, getPhaseGate, isBuildVerify, getVerifyConfig, getMaxIterations, getOnCompleteConfig, getBuildConfig } from './protocol.js';
import { getCurrentPlanPhase } from './plan.js';
import { buildWithTimeout } from './claude.js';
import { buildPhasePrompt } from './prompts.js';
import type { ProjectState, Protocol, ReviewResult, IterationRecord, Verdict } from './types.js';
import { globSync } from 'node:fs';

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
  // Resolve glob pattern (e.g., "codev/specs/0085-*.md")
  const matches = globSync(artifactGlob, { cwd: projectRoot });
  if (matches.length === 0) return false;

  const filePath = path.join(projectRoot, matches[0]);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Check for YAML frontmatter with approved and validated fields
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

// Runtime artifacts go in project directory, not a hidden folder
function getPorchDir(projectRoot: string, state: ProjectState): string {
  return path.join(projectRoot, 'codev', 'projects', `${state.id}-${state.title}`);
}

/**
 * Generate output file name with phase and iteration info.
 * e.g., "0074-specify-iter-1.txt" or "0074-phase_1-iter-2.txt"
 *
 * Uses state.iteration which is persisted and survives porch restarts.
 */
function getOutputFileName(state: ProjectState): string {
  const planPhase = getCurrentPlanPhase(state.plan_phases);

  // Build filename using persisted iteration from state
  const parts = [state.id];
  if (planPhase) {
    parts.push(planPhase.id);
  } else {
    parts.push(state.phase);
  }
  parts.push(`iter-${state.iteration}`);

  return `${parts.join('-')}.txt`;
}

export interface RunOptions {
  /** Run a single build-verify iteration then exit (for step-by-step debugging) */
  singleIteration?: boolean;
  /** Run a single phase (build-verify + gate) then exit. Used by Builder (outer Claude) to stay in the loop. */
  singlePhase?: boolean;
}

/** Exit code when AWAITING_INPUT is detected in non-interactive mode */
export const EXIT_AWAITING_INPUT = 3;

/**
 * Main run loop for porch.
 * Spawns Claude for each phase and monitors until protocol complete.
 */
export async function run(projectRoot: string, projectId: string, options: RunOptions = {}): Promise<void> {
  const statusPath = findStatusPath(projectRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.\nRun 'porch init' to create a new project.`);
  }

  // Read initial state to get project directory
  let state = readState(statusPath);
  const singleIteration = options.singleIteration || false;
  const singlePhase = options.singlePhase || false;

  // Ensure project artifacts directory exists
  const porchDir = getPorchDir(projectRoot, state);
  if (!fs.existsSync(porchDir)) {
    fs.mkdirSync(porchDir, { recursive: true });
  }

  console.log('');
  console.log(chalk.bold('PORCH - Protocol Orchestrator'));
  console.log(chalk.dim('Porch is the outer loop. Claude runs under porch control.'));
  console.log('');

  let consecutiveFailures = 0;

  while (true) {
    state = readState(statusPath);

    // AWAITING_INPUT resume guard
    if (state.awaiting_input) {
      console.log(chalk.yellow('[PORCH] Resuming from AWAITING_INPUT state'));
      state.awaiting_input = false;
      writeState(statusPath, state);
      // Continue normally — will re-run the build phase
    }

    // Circuit breaker check
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      console.error(chalk.red(`[PORCH] Circuit breaker: ${consecutiveFailures} consecutive build failures. Halting.`));
      process.exit(2);
    }

    const protocol = loadProtocol(projectRoot, state.protocol);
    const phaseConfig = getPhaseConfig(protocol, state.phase);

    if (!phaseConfig) {
      console.log(chalk.green.bold('🎉 PROTOCOL COMPLETE'));
      console.log(`\n  Project ${state.id} has completed the ${state.protocol} protocol.`);
      break;
    }

    // Check for pending gate
    const gateName = getPhaseGate(protocol, state.phase);
    if (gateName && state.gates[gateName]?.status === 'pending' && state.gates[gateName]?.requested_at) {
      // --single-phase: return gate status to Builder, let it handle human interaction
      if (singlePhase) {
        console.log(chalk.yellow(`\n[--single-phase] Gate '${gateName}' pending. Needs human approval.`));
        outputSinglePhaseResult(state, 'gate_needed', gateName);
        return;
      }

      const outputPath = path.join(porchDir, `${state.id}-gate.txt`);
      await handleGate(state, gateName, statusPath, projectRoot, outputPath, protocol);
      continue;
    }

    // Gate approved → advance to next phase
    if (gateName && state.gates[gateName]?.status === 'approved') {
      const { done } = await import('./index.js');
      await done(projectRoot, state.id);

      // --single-phase: exit after phase advances
      if (singlePhase) {
        const newState = readState(statusPath);
        console.log(chalk.dim(`\n[--single-phase] Phase complete. Now at: ${newState.phase}`));
        outputSinglePhaseResult(newState, 'advanced', undefined, undefined);
        return;
      }
      continue;
    }

    // Handle build_verify phases
    if (isBuildVerify(protocol, state.phase)) {
      const maxIterations = getMaxIterations(protocol, state.phase);

      // Check if artifact already exists and was pre-approved + validated
      // (e.g., spec/plan created by architect before builder was spawned)
      if (!state.build_complete && state.iteration === 1) {
        const buildConfig = getBuildConfig(protocol, state.phase);
        if (buildConfig?.artifact) {
          const artifactGlob = buildConfig.artifact.replace('${PROJECT_ID}', state.id);
          if (isArtifactPreApproved(projectRoot, artifactGlob)) {
            console.log(chalk.green(`[${state.id}] ${phaseConfig.name}: artifact exists with approval metadata - skipping build+verify`));

            // Auto-approve gate and advance
            if (gateName) {
              state.gates[gateName] = { status: 'approved', approved_at: new Date().toISOString() };
              writeState(statusPath, state);
            }
            const { done } = await import('./index.js');
            await done(projectRoot, state.id);
            continue;
          }
        }
      }

      // Check if we need to run VERIFY (build just completed)
      if (state.build_complete) {
        // First check if the artifact was actually created
        const artifactPath = getArtifactForPhase(state);
        if (artifactPath) {
          const fullPath = path.join(projectRoot, artifactPath);
          if (!fs.existsSync(fullPath)) {
            console.log('');
            console.log(chalk.yellow(`Artifact not found: ${artifactPath}`));
            console.log(chalk.dim('Claude may have asked questions or encountered an error.'));
            console.log(chalk.dim('Check the output file for details, then respawn.'));
            state.build_complete = false;
            writeState(statusPath, state);
            continue;
          }
        }

        console.log('');
        console.log(chalk.cyan(`[${state.id}] VERIFY - Iteration ${state.iteration}/${maxIterations}`));

        const reviews = await runVerification(projectRoot, state, protocol);

        // Get the build output file from current iteration (stored when we track it)
        const currentBuildOutput = state.history.find(h => h.iteration === state.iteration)?.build_output || '';

        // Update history with reviews
        const existingRecord = state.history.find(h => h.iteration === state.iteration);
        if (existingRecord) {
          existingRecord.reviews = reviews;
        } else {
          state.history.push({
            iteration: state.iteration,
            build_output: currentBuildOutput,
            reviews,
          });
        }

        if (allApprove(reviews)) {
          console.log(chalk.green('\nAll reviewers APPROVE!'));

          // Run on_complete actions (commit + push)
          await runOnComplete(projectRoot, state, protocol, reviews);

          // Request gate
          if (gateName) {
            state.gates[gateName] = { status: 'pending', requested_at: new Date().toISOString() };
          }

          // Reset for next phase
          state.build_complete = false;
          state.iteration = 1;
          state.history = [];
          writeState(statusPath, state);

          // Single iteration mode: exit after completing a build-verify cycle
          if (singleIteration) {
            console.log(chalk.dim('\n[--single-iteration] Build-verify cycle complete. Exiting.'));
            return;
          }

          // --single-phase: exit after build-verify passes
          if (singlePhase) {
            if (gateName) {
              console.log(chalk.dim(`\n[--single-phase] Build-verify passed. Gate '${gateName}' requested.`));
              outputSinglePhaseResult(state, 'gate_needed', gateName, reviews);
            } else {
              console.log(chalk.dim(`\n[--single-phase] Build-verify passed. No gate needed.`));
              outputSinglePhaseResult(state, 'verified', undefined, reviews);
            }
            return;
          }
          continue;
        }

        // Some reviewers requested changes
        console.log(chalk.yellow('\nChanges requested. Feeding back to Claude...'));

        // --single-phase: return control to Builder with iterating status
        if (singlePhase) {
          console.log(chalk.dim(`\n[--single-phase] Changes requested. Returning control to Builder.`));
          outputSinglePhaseResult(state, 'iterating', undefined, reviews);
          return;
        }

        if (state.iteration >= maxIterations) {
          // Max iterations reached without unanimity - summarize and interrupt user
          console.log('');
          console.log(chalk.red('═'.repeat(60)));
          console.log(chalk.red.bold('  MAX ITERATIONS REACHED - NO UNANIMITY'));
          console.log(chalk.red('═'.repeat(60)));
          console.log('');
          console.log(chalk.yellow(`After ${maxIterations} iterations, reviewers did not reach unanimity.`));
          console.log('');
          console.log(chalk.bold('Summary of reviewer positions:'));

          // Group reviews by verdict
          const byVerdict: Record<string, string[]> = {};
          for (const r of reviews) {
            if (!byVerdict[r.verdict]) byVerdict[r.verdict] = [];
            byVerdict[r.verdict].push(r.model);
          }

          for (const [verdict, models] of Object.entries(byVerdict)) {
            const color = verdict === 'APPROVE' ? chalk.green :
                          verdict === 'CONSULT_ERROR' ? chalk.red :
                          verdict === 'REQUEST_CHANGES' ? chalk.yellow : chalk.blue;
            console.log(`  ${color(verdict)}: ${models.join(', ')}`);
          }

          console.log('');
          console.log(chalk.dim('Review files:'));
          for (const r of reviews) {
            console.log(`  ${r.model}: ${r.file}`);
          }
          console.log('');

          // Check for identical REQUEST_CHANGES (may indicate missing context)
          const requestChangesReviews = reviews.filter(r => r.verdict === 'REQUEST_CHANGES');
          if (requestChangesReviews.length >= 2) {
            console.log(chalk.yellow('Note: Multiple REQUEST_CHANGES may indicate missing file context.'));
            console.log(chalk.dim('Check if the artifact path is correct and files are committed.'));
            console.log('');
          }

          // Wait for user decision
          const readline = await import('node:readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          console.log('Options:');
          console.log("  'c' or 'continue' - Proceed to gate anyway (let human decide)");
          console.log("  'r' or 'retry'    - Reset iteration counter and try again");
          console.log("  'q' or 'quit'     - Exit porch");
          console.log('');

          const action = await new Promise<string>((resolve) => {
            rl.question(chalk.cyan(`[${state.id}] > `), (input) => {
              rl.close();
              resolve(input.trim().toLowerCase());
            });
          });

          switch (action) {
            case 'c':
            case 'continue':
              console.log(chalk.dim('\nProceeding to gate...'));
              break;

            case 'r':
            case 'retry':
              console.log(chalk.dim('\nResetting iteration counter...'));
              state.iteration = 1;
              state.build_complete = false;
              state.history = [];
              writeState(statusPath, state);
              continue;

            case 'q':
            case 'quit':
              console.log(chalk.yellow('\nExiting porch.'));
              return;

            default:
              console.log(chalk.yellow('\nUnknown option. Proceeding to gate.'));
          }

          // Run on_complete actions
          await runOnComplete(projectRoot, state, protocol, reviews);

          // Request gate
          if (gateName) {
            state.gates[gateName] = { status: 'pending', requested_at: new Date().toISOString() };
          }

          state.build_complete = false;
          state.iteration = 1;
          state.history = [];
          writeState(statusPath, state);

          // Single iteration mode: exit after max iterations
          if (singleIteration) {
            console.log(chalk.dim('\n[--single-iteration] Max iterations reached. Exiting.'));
            return;
          }
          continue;
        }

        // Increment iteration and continue to BUILD
        state.iteration++;
        state.build_complete = false;
        writeState(statusPath, state);

        // Single iteration mode: exit after storing feedback
        if (singleIteration) {
          console.log(chalk.dim('\n[--single-iteration] Feedback stored for next iteration. Exiting.'));
          console.log(chalk.dim(`  Next run will be iteration ${state.iteration} with reviewer feedback.`));
          return;
        }
        // Fall through to BUILD phase
      }

      // BUILD phase
      console.log('');
      console.log(chalk.cyan(`[${state.id}] BUILD - ${phaseConfig.name} - Iteration ${state.iteration}/${maxIterations}`));
    }

    // Generate output file for this iteration
    const outputFileName = getOutputFileName(state);
    const outputPath = path.join(porchDir, outputFileName);

    // Track this build output in history (for feedback to next iteration)
    if (isBuildVerify(protocol, state.phase)) {
      const existingRecord = state.history.find(h => h.iteration === state.iteration);
      if (existingRecord) {
        existingRecord.build_output = outputPath;
      } else {
        state.history.push({
          iteration: state.iteration,
          build_output: outputPath,
          reviews: [],
        });
      }
      writeState(statusPath, state);
    }

    // Build prompt for current phase (includes history file paths if iteration > 1)
    const prompt = buildPhasePrompt(projectRoot, state, protocol);

    console.log(chalk.dim(`Output: ${outputFileName}`));

    // Show status
    showStatus(state, protocol);

    // Print the prompt being sent to the Worker
    console.log('');
    console.log(chalk.cyan('═'.repeat(60)));
    console.log(chalk.cyan.bold('  PROMPT TO WORKER (Agent SDK)'));
    console.log(chalk.cyan('═'.repeat(60)));
    console.log(chalk.dim(prompt.substring(0, 2000)));
    if (prompt.length > 2000) {
      console.log(chalk.dim(`... (${prompt.length - 2000} more chars)`));
    }
    console.log(chalk.cyan('═'.repeat(60)));
    console.log('');

    // Run the Worker via Agent SDK with retry
    console.log(chalk.dim('Starting Worker (Agent SDK)...'));
    let result = await buildWithTimeout(prompt, outputPath, projectRoot, BUILD_TIMEOUT_MS);

    // Retry on failure (timeout or SDK error)
    if (!result.success && isBuildVerify(protocol, state.phase)) {
      for (let attempt = 1; attempt <= BUILD_MAX_RETRIES && !result.success; attempt++) {
        const delay = BUILD_RETRY_DELAYS[attempt - 1] || BUILD_RETRY_DELAYS[BUILD_RETRY_DELAYS.length - 1];
        console.log(chalk.yellow(`\nBuild failed. Retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${BUILD_MAX_RETRIES + 1})`));
        await sleep(delay);

        // Each retry attempt gets a distinct output file
        const retryOutputPath = outputPath.replace(/\.txt$/, `-try-${attempt + 1}.txt`);
        result = await buildWithTimeout(prompt, retryOutputPath, projectRoot, BUILD_TIMEOUT_MS);
      }
    }

    if (result.cost) {
      console.log(chalk.dim(`  Cost: $${result.cost.toFixed(4)}`));
    }
    if (result.duration) {
      console.log(chalk.dim(`  Duration: ${(result.duration / 1000).toFixed(1)}s`));
    }

    // AWAITING_INPUT detection
    if (result.output && (/<signal>BLOCKED:/i.test(result.output) || /<signal>AWAITING_INPUT<\/signal>/i.test(result.output))) {
      console.error(chalk.yellow(`[PORCH] Worker needs human input — check output file: ${outputPath}`));
      state.awaiting_input = true;
      writeState(statusPath, state);
      process.exit(EXIT_AWAITING_INPUT);
    }

    // For build_verify phases, only proceed to verify on success
    if (isBuildVerify(protocol, state.phase)) {
      if (result.success) {
        console.log(chalk.dim('\nWorker finished. Moving to verification...'));
        // Update history to point at the actual successful attempt's output file
        const historyRecord = state.history.find(h => h.iteration === state.iteration);
        if (historyRecord && result.output) {
          // If a retry succeeded, the outputPath may differ from the original
          // Find which file was actually written last
          const lastOutputPath = historyRecord.build_output;
          // Check if result came from a retry by scanning for retry files
          for (let t = BUILD_MAX_RETRIES; t >= 1; t--) {
            const tryPath = outputPath.replace(/\.txt$/, `-try-${t + 1}.txt`);
            if (fs.existsSync(tryPath)) {
              historyRecord.build_output = tryPath;
              break;
            }
          }
        }
        state.build_complete = true;
        consecutiveFailures = 0;
        writeState(statusPath, state);
      } else {
        // All retries exhausted — increment circuit breaker, do NOT set build_complete
        console.log(chalk.red('\nWorker failed after all retries.'));
        console.log(chalk.dim(`Check output: ${outputPath}`));
        consecutiveFailures++;
        // Loop back to top where circuit breaker check will halt if threshold reached
        continue;
      }
      // Continue loop - will hit build_complete check and run verify
    } else if (!result.success) {
      console.log(chalk.red('\nWorker failed.'));
      console.log(chalk.dim(`Check output: ${outputPath}`));
      if (singlePhase) {
        outputSinglePhaseResult(state, 'failed');
      }
      return;
    }
  }
}

// ============================================================================
// Verification (3-way consultation)
// ============================================================================

/**
 * Run 3-way verification on the current phase artifact.
 * Writes each consultation output to a file.
 * Returns array of review results with file paths.
 */
async function runVerification(
  projectRoot: string,
  state: ProjectState,
  protocol: Protocol
): Promise<ReviewResult[]> {
  const verifyConfig = getVerifyConfig(protocol, state.phase);
  if (!verifyConfig) {
    return []; // No verification configured
  }

  console.log(chalk.dim(`Running ${verifyConfig.models.length}-way consultation...`));

  const porchDir = getPorchDir(projectRoot, state);
  const reviews: ReviewResult[] = [];

  // Run consultations in parallel
  const promises = verifyConfig.models.map(async (model) => {
    console.log(chalk.dim(`  ${model}: starting...`));

    // Output file for this review
    const reviewFile = path.join(porchDir, `${state.id}-${state.phase}-iter${state.iteration}-${model}.txt`);

    const result = await runConsult(projectRoot, model, verifyConfig.type, state, reviewFile);
    reviews.push(result);

    const verdictColor = result.verdict === 'APPROVE' ? chalk.green :
                         result.verdict === 'COMMENT' ? chalk.blue : chalk.yellow;
    console.log(`  ${model}: ${verdictColor(result.verdict)}`);
  });

  await Promise.all(promises);

  return reviews;
}

/**
 * Get the consult artifact type for a phase.
 */
function getConsultArtifactType(phaseId: string): string {
  switch (phaseId) {
    case 'specify':
      return 'spec';
    case 'plan':
      return 'plan';
    case 'implement':
      return 'impl'; // Implementation reviews the code diff
    case 'review':
      return 'spec'; // Review phase reviews overall work
    default:
      return 'spec';
  }
}

/**
 * Run a single consultation with retry on failure.
 * Writes output to file and returns result with file path.
 *
 * Retry logic:
 * - Non-zero exit code = consultation failed (API key missing, network error, etc.)
 * - Retry up to 3 times with exponential backoff
 * - If all retries fail, return CONSULT_ERROR (not REQUEST_CHANGES)
 */
// Build timeout and retry constants (mirrors CONSULT_* pattern)
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;     // 15 minutes
const BUILD_MAX_RETRIES = 3;
const BUILD_RETRY_DELAYS = [5000, 15000, 30000]; // 5s, 15s, 30s
const CIRCUIT_BREAKER_THRESHOLD = 5;

const CONSULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const CONSULT_MAX_RETRIES = 3;
const CONSULT_RETRY_DELAYS = [5000, 15000, 30000]; // 5s, 15s, 30s

async function runConsult(
  projectRoot: string,
  model: string,
  reviewType: string,
  state: ProjectState,
  outputFile: string
): Promise<ReviewResult> {
  for (let attempt = 0; attempt < CONSULT_MAX_RETRIES; attempt++) {
    const result = await runConsultOnce(projectRoot, model, reviewType, state, outputFile);

    // Success - got a valid verdict
    if (result.verdict !== 'CONSULT_ERROR') {
      return result;
    }

    // Consultation failed - retry if attempts remaining
    if (attempt < CONSULT_MAX_RETRIES - 1) {
      const delay = CONSULT_RETRY_DELAYS[attempt];
      console.log(chalk.yellow(`  ${model}: failed, retrying in ${delay / 1000}s... (attempt ${attempt + 2}/${CONSULT_MAX_RETRIES})`));
      await sleep(delay);
    }
  }

  // All retries failed
  console.log(chalk.red(`  ${model}: FAILED after ${CONSULT_MAX_RETRIES} attempts`));
  return { model, verdict: 'CONSULT_ERROR', file: outputFile };
}

async function runConsultOnce(
  projectRoot: string,
  model: string,
  reviewType: string,
  state: ProjectState,
  outputFile: string
): Promise<ReviewResult> {
  const { spawn } = await import('node:child_process');

  const artifactType = getConsultArtifactType(state.phase);

  return new Promise((resolve) => {
    const args = ['--model', model, '--type', reviewType, artifactType, state.id];
    const proc = spawn('consult', args, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let resolved = false;
    let exitCode: number | null = null;

    // Timeout after 1 hour
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        const timeoutOutput = output + '\n\n[TIMEOUT: Consultation exceeded 1 hour limit]';
        fs.writeFileSync(outputFile, timeoutOutput);
        console.log(chalk.yellow(`  ${model}: timeout (1 hour limit)`));
        resolve({ model, verdict: 'CONSULT_ERROR', file: outputFile });
      }
    }, CONSULT_TIMEOUT_MS);

    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { output += data.toString(); });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        exitCode = code;

        // Write output to file
        fs.writeFileSync(outputFile, output);

        // Non-zero exit code = consultation failed (API key missing, etc.)
        if (code !== 0) {
          console.log(chalk.yellow(`  ${model}: exit code ${code}`));
          resolve({ model, verdict: 'CONSULT_ERROR', file: outputFile });
          return;
        }

        // Parse verdict from output
        const verdict = parseVerdict(output);
        resolve({ model, verdict, file: outputFile });
      }
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        const errorOutput = `Error: ${err.message}`;
        fs.writeFileSync(outputFile, errorOutput);
        console.log(chalk.red(`  ${model}: error - ${err.message}`));
        resolve({ model, verdict: 'CONSULT_ERROR', file: outputFile });
      }
    });
  });
}

/**
 * Parse verdict from consultation output.
 *
 * Looks for the verdict line in format:
 *   VERDICT: APPROVE
 *   VERDICT: REQUEST_CHANGES
 *   VERDICT: COMMENT
 *
 * Also handles markdown formatting like:
 *   **VERDICT: APPROVE**
 *   *VERDICT: APPROVE*
 *
 * Safety: If no explicit verdict found (empty output, crash, malformed),
 * defaults to REQUEST_CHANGES to prevent proceeding with unverified code.
 */
function parseVerdict(output: string): Verdict {
  // Empty or very short output = something went wrong
  if (!output || output.trim().length < 50) {
    return 'REQUEST_CHANGES';
  }

  // Look for actual verdict line (not template text like "[APPROVE | REQUEST_CHANGES | COMMENT]")
  // Match lines like "VERDICT: APPROVE" or "**VERDICT: APPROVE**"
  const lines = output.split('\n');
  for (const line of lines) {
    // Strip markdown formatting (**, *, __, _) and trim
    const stripped = line.trim().replace(/^[\*_]+|[\*_]+$/g, '').trim().toUpperCase();
    // Match "VERDICT: <value>" but NOT "VERDICT: [APPROVE | ...]"
    if (stripped.startsWith('VERDICT:') && !stripped.includes('[')) {
      if (stripped.includes('REQUEST_CHANGES')) {
        return 'REQUEST_CHANGES';
      }
      if (stripped.includes('APPROVE')) {
        return 'APPROVE';
      }
      if (stripped.includes('COMMENT')) {
        return 'COMMENT';
      }
    }
  }

  // Fallback: look anywhere in output (legacy behavior)
  const upperOutput = output.toUpperCase();
  if (upperOutput.includes('REQUEST_CHANGES')) {
    return 'REQUEST_CHANGES';
  }
  if (upperOutput.includes('APPROVE')) {
    return 'APPROVE';
  }
  // No explicit verdict = default to REQUEST_CHANGES for safety
  return 'REQUEST_CHANGES';
}

/**
 * Check if all reviewers approved (unanimity required).
 *
 * Returns true only if ALL reviewers explicitly APPROVE.
 * COMMENT counts as approve (non-blocking feedback).
 * CONSULT_ERROR and REQUEST_CHANGES block approval.
 */
function allApprove(reviews: ReviewResult[]): boolean {
  if (reviews.length === 0) return true; // No verification = auto-approve

  // Unanimity: ALL must be APPROVE or COMMENT
  return reviews.every(r => r.verdict === 'APPROVE' || r.verdict === 'COMMENT');
}

/**
 * Run on_complete actions (commit + push).
 */
async function runOnComplete(
  projectRoot: string,
  state: ProjectState,
  protocol: Protocol,
  reviews: ReviewResult[]
): Promise<void> {
  const onComplete = getOnCompleteConfig(protocol, state.phase);
  if (!onComplete) return;

  const buildConfig = getBuildConfig(protocol, state.phase);
  if (!buildConfig) return;

  // Resolve artifact path
  const artifact = buildConfig.artifact
    .replace('${PROJECT_ID}', state.id)
    .replace('${PROJECT_TITLE}', state.title);

  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  if (onComplete.commit) {
    console.log(chalk.dim('Committing...'));
    try {
      // Stage artifact
      await execAsync(`git add ${artifact}`, { cwd: projectRoot });

      // Commit
      const message = `[Spec ${state.id}] ${state.phase}: ${state.title}

Iteration ${state.iteration}
3-way review: ${formatVerdicts(reviews)}`;

      await execAsync(`git commit -m "${message}"`, { cwd: projectRoot });
      console.log(chalk.green('Committed.'));
    } catch (err) {
      console.log(chalk.yellow('Commit failed (may be nothing to commit).'));
    }
  }

  if (onComplete.push) {
    console.log(chalk.dim('Pushing...'));
    try {
      await execAsync('git push', { cwd: projectRoot });
      console.log(chalk.green('Pushed.'));
    } catch (err) {
      console.log(chalk.yellow('Push failed.'));
    }
  }
}

/**
 * Format verdicts for commit message.
 */
function formatVerdicts(reviews: ReviewResult[]): string {
  return reviews
    .map(r => `${r.model}=${r.verdict}`)
    .join(', ') || 'N/A';
}

/**
 * Display current status.
 */
function showStatus(state: ProjectState, protocol: Protocol): void {
  const phaseConfig = getPhaseConfig(protocol, state.phase);

  console.log('');
  console.log(chalk.bold(`[${state.id}] ${state.title}`));
  console.log(`  Phase: ${state.phase} (${phaseConfig?.name || 'unknown'})`);

  if (isBuildVerify(protocol, state.phase)) {
    const maxIterations = getMaxIterations(protocol, state.phase);
    console.log(`  Iteration: ${state.iteration}/${maxIterations}`);
  }

  if (isPhased(protocol, state.phase) && state.plan_phases.length > 0) {
    const currentPlanPhase = getCurrentPlanPhase(state.plan_phases);
    if (currentPlanPhase) {
      console.log(`  Plan Phase: ${currentPlanPhase.id} - ${currentPlanPhase.title}`);
    }
  }

  console.log('');
}

/**
 * Handle gate approval flow.
 */
async function handleGate(
  state: ProjectState,
  gateName: string,
  statusPath: string,
  projectRoot: string,
  outputPath: string,
  protocol: Protocol
): Promise<void> {
  // E2E testing: Auto-approve gates when PORCH_AUTO_APPROVE is set
  if (process.env.PORCH_AUTO_APPROVE === 'true') {
    console.log(chalk.yellow(`[E2E] Auto-approving gate: ${gateName}`));
    state.gates[gateName].status = 'approved';
    state.gates[gateName].approved_at = new Date().toISOString();
    writeState(statusPath, state);
    return;
  }

  console.log('');
  console.log(chalk.yellow('═'.repeat(60)));
  console.log(chalk.yellow.bold(`  GATE: ${gateName}`));
  console.log(chalk.yellow('═'.repeat(60)));
  console.log('');

  // Show artifact path
  const artifact = getArtifactForPhase(state);
  if (artifact) {
    console.log(`  Review: ${artifact}`);
  }

  console.log('');
  console.log("  Type 'a' or 'approve' to approve and continue.");
  console.log("  Type 'q' or 'quit' to exit.");
  console.log('');

  // Wait for user input
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const prompt = () => {
      rl.question(chalk.cyan(`[${state.id}] WAITING FOR APPROVAL > `), (input) => {
        const cmd = input.trim().toLowerCase();

        switch (cmd) {
          case 'a':
          case 'approve':
            state.gates[gateName].status = 'approved';
            state.gates[gateName].approved_at = new Date().toISOString();
            writeState(statusPath, state);
            console.log(chalk.green(`\nGate ${gateName} approved.`));
            rl.close();
            resolve();
            break;

          case 'q':
          case 'quit':
            console.log(chalk.yellow('\nExiting without approval.'));
            rl.close();
            process.exit(0);
            break;

          default:
            console.log(chalk.dim("Unknown command. Type 'a' to approve or 'q' to quit."));
            prompt();
        }
      });
    };

    prompt();
  });
}


/**
 * Get artifact path for current phase.
 */
function getArtifactForPhase(state: ProjectState): string | null {
  switch (state.phase) {
    case 'specify':
      return `codev/specs/${state.id}-${state.title}.md`;
    case 'plan':
      return `codev/plans/${state.id}-${state.title}.md`;
    case 'review':
      return `codev/reviews/${state.id}-${state.title}.md`;
    default:
      return null;
  }
}

/**
 * Output structured result for --single-phase mode.
 * The Builder (outer Claude) parses this to understand what happened.
 */
function outputSinglePhaseResult(
  state: ProjectState,
  status: 'advanced' | 'gate_needed' | 'verified' | 'iterating' | 'failed',
  gateName?: string,
  reviews?: ReviewResult[]
): void {
  const result: Record<string, unknown> = {
    phase: state.phase,
    plan_phase: state.current_plan_phase,
    iteration: state.iteration,
    status,
    gate: gateName || null,
  };

  // Include verdicts if reviews were run
  if (reviews && reviews.length > 0) {
    result.verdicts = Object.fromEntries(reviews.map(r => [r.model, r.verdict]));
  }

  // Include artifact path
  const artifact = getArtifactForPhase(state);
  if (artifact) {
    result.artifact = artifact;
  }

  // Output as JSON on a single line for easy parsing
  console.log(`\n__PORCH_RESULT__${JSON.stringify(result)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
