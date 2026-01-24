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
import { spawnClaude, type ClaudeProcess } from './claude.js';
import { watchForSignal, type Signal } from './signals.js';
import { runRepl } from './repl.js';
import { buildPhasePrompt } from './prompts.js';
import type { ProjectState, Protocol, FeedbackSet } from './types.js';

const PORCH_DIR = '.porch';

/** Track iteration count per phase for output file naming */
const iterationCounts = new Map<string, number>();

/**
 * Generate output file name with phase and iteration info.
 * e.g., "0074-specify-iter-1.txt" or "0074-phase_1-iter-2.txt"
 */
function getOutputFileName(state: ProjectState, protocol: Protocol): string {
  const planPhase = getCurrentPlanPhase(state.plan_phases);

  // Build phase key for iteration tracking
  const phaseKey = planPhase
    ? `${state.phase}-${planPhase.id}`
    : state.phase;

  // Increment iteration count
  const iter = (iterationCounts.get(phaseKey) || 0) + 1;
  iterationCounts.set(phaseKey, iter);

  // Build filename
  const parts = [state.id];
  if (planPhase) {
    parts.push(planPhase.id);
  } else {
    parts.push(state.phase);
  }
  parts.push(`iter-${iter}`);

  return `${parts.join('-')}.txt`;
}

/**
 * Main run loop for porch.
 * Spawns Claude for each phase and monitors until protocol complete.
 */
export async function run(projectRoot: string, projectId: string): Promise<void> {
  const statusPath = findStatusPath(projectRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.\nRun 'porch init' to create a new project.`);
  }

  // Ensure .porch directory exists
  const porchDir = path.join(projectRoot, PORCH_DIR);
  if (!fs.existsSync(porchDir)) {
    fs.mkdirSync(porchDir, { recursive: true });
  }

  console.log('');
  console.log(chalk.bold('PORCH - Protocol Orchestrator'));
  console.log(chalk.dim('Porch is the outer loop. Claude runs under porch control.'));
  console.log('');

  while (true) {
    let state = readState(statusPath);
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
      const outputPath = path.join(porchDir, `${state.id}-gate.txt`);
      await handleGate(state, gateName, statusPath, projectRoot, outputPath, protocol);
      continue;
    }

    // Handle build_verify phases
    if (isBuildVerify(protocol, state.phase)) {
      const maxIterations = getMaxIterations(protocol, state.phase);

      // Check if we need to run VERIFY (build just completed)
      if (state.build_complete) {
        console.log('');
        console.log(chalk.cyan(`[${state.id}] VERIFY - Iteration ${state.iteration}/${maxIterations}`));

        const feedback = await runVerification(projectRoot, state, protocol);

        if (allApprove(feedback)) {
          console.log(chalk.green('\nAll reviewers APPROVE!'));

          // Run on_complete actions (commit + push)
          await runOnComplete(projectRoot, state, protocol);

          // Request gate
          if (gateName) {
            state.gates[gateName] = { status: 'pending', requested_at: new Date().toISOString() };
          }

          // Reset for next phase
          state.build_complete = false;
          state.iteration = 1;
          state.last_feedback = {};
          writeState(statusPath, state);
          continue;
        }

        // Some reviewers requested changes
        console.log(chalk.yellow('\nChanges requested. Feeding back to Claude...'));
        state.last_feedback = feedback;

        if (state.iteration >= maxIterations) {
          console.log(chalk.yellow(`\nMax iterations (${maxIterations}) reached. Proceeding to gate.`));

          // Run on_complete actions anyway
          await runOnComplete(projectRoot, state, protocol);

          // Request gate
          if (gateName) {
            state.gates[gateName] = { status: 'pending', requested_at: new Date().toISOString() };
          }

          state.build_complete = false;
          state.iteration = 1;
          state.last_feedback = {};
          writeState(statusPath, state);
          continue;
        }

        // Increment iteration and continue to BUILD
        state.iteration++;
        state.build_complete = false;
        writeState(statusPath, state);
        // Fall through to BUILD phase
      }

      // BUILD phase
      console.log('');
      console.log(chalk.cyan(`[${state.id}] BUILD - ${phaseConfig.name} - Iteration ${state.iteration}/${maxIterations}`));
    }

    // Generate output file for this iteration
    const outputFileName = getOutputFileName(state, protocol);
    const outputPath = path.join(porchDir, outputFileName);

    // Build prompt for current phase (includes feedback if iteration > 1)
    const prompt = buildPhasePrompt(projectRoot, state, protocol);

    // Create output file
    fs.writeFileSync(outputPath, '');
    console.log(chalk.dim(`Output: ${outputFileName}`));

    // Show status
    showStatus(state, protocol);

    // Spawn Claude
    console.log(chalk.dim('Starting Claude...'));
    const claude = spawnClaude(prompt, outputPath, projectRoot);

    // Run REPL while Claude works
    const action = await runRepl(state, claude, outputPath, statusPath, projectRoot, protocol);

    // Handle REPL result
    switch (action.type) {
      case 'quit':
        claude.kill();
        console.log(chalk.yellow('\nPorch terminated by user.'));
        return;

      case 'signal':
        const shouldRespawn = await handleSignal(action.signal, state, statusPath, projectRoot, protocol);
        if (shouldRespawn) {
          console.log(chalk.dim('\nRespawning Claude for retry...'));
          await sleep(1000);
        }
        break;

      case 'claude_exit':
        if (action.exitCode !== 0) {
          console.log(chalk.red(`\nClaude exited with code ${action.exitCode}`));
          console.log(chalk.dim('Restarting in 3 seconds...'));
          await sleep(3000);
        }
        break;

      case 'approved':
        // Gate was approved, continue to next phase
        break;

      case 'manual_claude':
        // User wants to intervene - just continue loop to respawn
        console.log(chalk.dim('\nRespawning Claude...'));
        break;
    }
  }
}

// ============================================================================
// Verification (3-way consultation)
// ============================================================================

/**
 * Run 3-way verification on the current phase artifact.
 * Returns feedback from all models.
 */
async function runVerification(
  projectRoot: string,
  state: ProjectState,
  protocol: Protocol
): Promise<FeedbackSet> {
  const verifyConfig = getVerifyConfig(protocol, state.phase);
  if (!verifyConfig) {
    return {}; // No verification configured
  }

  console.log(chalk.dim(`Running ${verifyConfig.models.length}-way consultation...`));

  const feedback: FeedbackSet = {};

  // Run consultations in parallel
  const promises = verifyConfig.models.map(async (model) => {
    console.log(chalk.dim(`  ${model}: starting...`));
    const result = await runConsult(projectRoot, model, verifyConfig.type, state);
    feedback[model] = result;
    console.log(`  ${model}: ${result.verdict === 'APPROVE' ? chalk.green('APPROVE') : chalk.yellow('REQUEST_CHANGES')}`);
  });

  await Promise.all(promises);

  return feedback;
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
      return 'plan'; // Implementation reviews the plan phase
    case 'review':
      return 'spec'; // Review phase reviews overall work
    default:
      return 'spec';
  }
}

/**
 * Run a single consultation.
 */
async function runConsult(
  projectRoot: string,
  model: string,
  reviewType: string,
  state: ProjectState
): Promise<{ verdict: 'APPROVE' | 'REQUEST_CHANGES'; summary: string }> {
  const { spawn } = await import('node:child_process');

  const artifactType = getConsultArtifactType(state.phase);

  return new Promise((resolve) => {
    const args = ['--model', model, '--type', reviewType, artifactType, state.id];
    const proc = spawn('consult', args, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { output += data.toString(); });

    proc.on('close', (code) => {
      // Parse verdict from output
      const verdict = parseVerdict(output);
      const summary = extractSummary(output);
      resolve({ verdict, summary });
    });

    proc.on('error', (err) => {
      console.log(chalk.red(`  ${model}: error - ${err.message}`));
      resolve({ verdict: 'REQUEST_CHANGES', summary: `Error: ${err.message}` });
    });
  });
}

/**
 * Parse verdict from consultation output.
 */
function parseVerdict(output: string): 'APPROVE' | 'REQUEST_CHANGES' {
  // Look for verdict in output (case insensitive)
  const upperOutput = output.toUpperCase();
  if (upperOutput.includes('APPROVE') && !upperOutput.includes('REQUEST_CHANGES')) {
    return 'APPROVE';
  }
  return 'REQUEST_CHANGES';
}

/**
 * Extract summary from consultation output.
 */
function extractSummary(output: string): string {
  // Take last 500 chars as summary (the conclusion)
  const trimmed = output.trim();
  if (trimmed.length <= 500) {
    return trimmed;
  }
  return '...' + trimmed.slice(-500);
}

/**
 * Check if all reviewers approved.
 */
function allApprove(feedback: FeedbackSet): boolean {
  const results = Object.values(feedback);
  if (results.length === 0) return true; // No verification = auto-approve
  return results.every(r => r.verdict === 'APPROVE');
}

/**
 * Run on_complete actions (commit + push).
 */
async function runOnComplete(
  projectRoot: string,
  state: ProjectState,
  protocol: Protocol
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
3-way review: ${formatVerdicts(state.last_feedback)}`;

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
function formatVerdicts(feedback: FeedbackSet): string {
  return Object.entries(feedback)
    .map(([model, result]) => `${model}=${result.verdict}`)
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
 * Handle signal from Claude output.
 * Returns true if should respawn Claude (for build-verify iteration), false otherwise.
 */
async function handleSignal(
  signal: Signal,
  state: ProjectState,
  statusPath: string,
  projectRoot: string,
  protocol: Protocol
): Promise<boolean> {
  console.log('');

  switch (signal.type) {
    case 'PHASE_COMPLETE':
      console.log(chalk.green('Signal: PHASE_COMPLETE'));

      // For build_verify phases, we'll run verification in the main loop
      // Mark build as complete so main loop knows to run verify
      if (isBuildVerify(protocol, state.phase)) {
        state.build_complete = true;
        writeState(statusPath, state);
        return false; // Main loop will handle verify
      }

      // For non-build_verify phases, advance state directly
      const { done } = await import('./index.js');
      await done(projectRoot, state.id);
      return false;

    case 'GATE_NEEDED':
      console.log(chalk.yellow('Signal: GATE_NEEDED'));
      const gateName = getPhaseGate(protocol, state.phase);
      if (gateName && !state.gates[gateName]) {
        state.gates[gateName] = { status: 'pending', requested_at: new Date().toISOString() };
        writeState(statusPath, state);
      }
      return false;

    case 'BLOCKED':
      console.log(chalk.red(`Signal: BLOCKED - ${signal.reason}`));
      console.log(chalk.dim('Human intervention required.'));
      return false;
  }

  return false;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
