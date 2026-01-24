/**
 * porch run - Main run loop (Porch Outer design)
 *
 * Porch is the outer loop that spawns Claude for each phase,
 * monitors output, and controls transitions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { readState, writeState, findStatusPath } from './state.js';
import { loadProtocol, getPhaseConfig, isPhased, getPhaseGate, getPhaseVerification } from './protocol.js';
import { runPhaseChecks, allChecksPassed, formatCheckResults, type CheckEnv } from './checks.js';
import { getCurrentPlanPhase } from './plan.js';
import { spawnClaude, type ClaudeProcess } from './claude.js';
import { watchForSignal, type Signal } from './signals.js';
import { runRepl } from './repl.js';
import { buildPhasePrompt } from './prompts.js';
import type { ProjectState, Protocol } from './types.js';

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
    const state = readState(statusPath);
    const protocol = loadProtocol(projectRoot, state.protocol);
    const phaseConfig = getPhaseConfig(protocol, state.phase);

    if (!phaseConfig) {
      console.log(chalk.green.bold('🎉 PROTOCOL COMPLETE'));
      console.log(`\n  Project ${state.id} has completed the ${state.protocol} protocol.`);
      break;
    }

    // Generate output file for this iteration
    const outputFileName = getOutputFileName(state, protocol);
    const outputPath = path.join(porchDir, outputFileName);

    // Check for pending gate
    const gateName = getPhaseGate(protocol, state.phase);
    if (gateName && state.gates[gateName]?.status === 'pending' && state.gates[gateName]?.requested_at) {
      await handleGate(state, gateName, statusPath, projectRoot, outputPath, protocol);
      continue;
    }

    // Build prompt for current phase
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

/**
 * Display current status.
 */
function showStatus(state: ProjectState, protocol: Protocol): void {
  const phaseConfig = getPhaseConfig(protocol, state.phase);

  console.log('');
  console.log(chalk.bold(`[${state.id}] ${state.title}`));
  console.log(`  Phase: ${state.phase} (${phaseConfig?.name || 'unknown'})`);

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
 * Returns true if should respawn Claude (verification failed), false otherwise.
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

      // Check for verification requirements
      const verification = getPhaseVerification(protocol, state.phase);
      if (verification) {
        const maxRetries = verification.max_retries ?? 5;
        const currentRetries = state.verification_retries ?? 0;

        console.log(chalk.dim(`Running verification checks (attempt ${currentRetries + 1}/${maxRetries})...`));

        const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: state.title };
        const results = await runPhaseChecks(verification.checks, projectRoot, checkEnv);
        console.log(formatCheckResults(results));

        if (!allChecksPassed(results)) {
          if (currentRetries < maxRetries - 1) {
            // Increment retry count and respawn
            state.verification_retries = currentRetries + 1;
            writeState(statusPath, state);
            console.log(chalk.yellow(`\nVerification failed. Respawning Claude (${state.verification_retries}/${maxRetries})...`));
            return true; // Signal to respawn
          } else {
            // Max retries reached, proceed to gate anyway
            console.log(chalk.yellow(`\nVerification failed after ${maxRetries} attempts. Proceeding to gate for human decision.`));
            state.verification_retries = 0; // Reset for next phase
            writeState(statusPath, state);
          }
        } else {
          console.log(chalk.green('Verification passed.'));
          state.verification_retries = 0; // Reset on success
          writeState(statusPath, state);
        }
      }

      // Advance state (reuse existing done logic)
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
