/**
 * Porch2 - Minimal Protocol Orchestrator
 *
 * Claude calls porch as a tool; porch returns prescriptive instructions.
 * All commands produce clear, actionable output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import type { ProjectState, Protocol, PlanPhase } from './types.js';
import {
  readState,
  writeState,
  createInitialState,
  findStatusPath,
  getProjectDir,
  getStatusPath,
} from './state.js';
import {
  loadProtocol,
  getPhaseConfig,
  getNextPhase,
  getPhaseChecks,
  getPhaseGate,
  isPhased,
} from './protocol.js';
import {
  findPlanFile,
  extractPhasesFromFile,
  getCurrentPlanPhase,
  getPhaseContent,
  advancePlanPhase,
  allPlanPhasesComplete,
} from './plan.js';
import {
  runPhaseChecks,
  formatCheckResults,
  allChecksPassed,
  type CheckEnv,
} from './checks.js';

// ============================================================================
// Output Helpers
// ============================================================================

function header(text: string): string {
  const line = '═'.repeat(50);
  return `${line}\n  ${text}\n${line}`;
}

function section(title: string, content: string): string {
  return `\n${chalk.bold(title)}:\n${content}`;
}

// ============================================================================
// Commands
// ============================================================================

/**
 * porch2 status <id>
 * Shows current state and prescriptive next steps.
 */
export async function status(projectRoot: string, projectId: string): Promise<void> {
  const statusPath = findStatusPath(projectRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.\nRun 'porch2 init' to create a new project.`);
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(projectRoot, state.protocol);
  const phaseConfig = getPhaseConfig(protocol, state.phase);

  // Header
  console.log('');
  console.log(header(`PROJECT: ${state.id} - ${state.title}`));
  console.log(`  PROTOCOL: ${state.protocol}`);
  console.log(`  PHASE: ${state.phase} (${phaseConfig?.name || 'unknown'})`);

  // For phased protocols, show current plan phase
  if (isPhased(protocol, state.phase) && state.plan_phases.length > 0) {
    const currentPlanPhase = getCurrentPlanPhase(state.plan_phases);
    if (currentPlanPhase) {
      console.log('');
      console.log(chalk.bold(`CURRENT PLAN PHASE: ${currentPlanPhase.id} - ${currentPlanPhase.title}`));
      console.log(`STATUS: ${currentPlanPhase.status}`);

      // Show phase content from plan
      const planPath = findPlanFile(projectRoot, state.id, state.title);
      if (planPath) {
        const content = fs.readFileSync(planPath, 'utf-8');
        const phaseContent = getPhaseContent(content, currentPlanPhase.id);
        if (phaseContent) {
          console.log(section('FROM THE PLAN', phaseContent.slice(0, 500)));
        }
      }
    }
  }

  // Show checks status
  const checks = getPhaseChecks(protocol, state.phase);
  if (Object.keys(checks).length > 0) {
    const checkLines = Object.keys(checks).map(name => `  ○ ${name} (not yet run)`);
    console.log(section('CRITERIA', checkLines.join('\n')));
  }

  // Instructions
  const gate = getPhaseGate(protocol, state.phase);
  if (gate && state.gates[gate]?.status === 'pending' && state.gates[gate]?.requested_at) {
    console.log(section('STATUS', chalk.yellow('WAITING FOR HUMAN APPROVAL')));
    console.log(`\n  Gate: ${gate}`);
    console.log('  Do not proceed until gate is approved.');
    console.log(`\n  To approve: porch2 approve ${state.id} ${gate}`);
  } else {
    console.log(section('INSTRUCTIONS', getInstructions(state, protocol)));
  }

  console.log(section('NEXT ACTION', getNextAction(state, protocol)));
  console.log('');
}

/**
 * porch2 check <id>
 * Runs the phase checks and reports results.
 */
export async function check(projectRoot: string, projectId: string): Promise<void> {
  const statusPath = findStatusPath(projectRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.`);
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(projectRoot, state.protocol);
  const checks = getPhaseChecks(protocol, state.phase);

  if (Object.keys(checks).length === 0) {
    console.log(chalk.dim('No checks defined for this phase.'));
    return;
  }

  const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: state.title };

  console.log('');
  console.log(chalk.bold('RUNNING CHECKS...'));
  console.log('');

  const results = await runPhaseChecks(checks, projectRoot, checkEnv);
  console.log(formatCheckResults(results));

  console.log('');
  if (allChecksPassed(results)) {
    console.log(chalk.green('RESULT: ALL CHECKS PASSED'));
    console.log(`\n  Run: porch2 done ${state.id} (to advance)`);
  } else {
    console.log(chalk.red('RESULT: CHECKS FAILED'));
    console.log(`\n  Fix the failures and run: porch2 check ${state.id}`);
  }
  console.log('');
}

/**
 * porch2 done <id>
 * Advances to next phase if checks pass. Refuses if checks fail.
 */
export async function done(projectRoot: string, projectId: string): Promise<void> {
  const statusPath = findStatusPath(projectRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.`);
  }

  let state = readState(statusPath);
  const protocol = loadProtocol(projectRoot, state.protocol);
  const checks = getPhaseChecks(protocol, state.phase);

  // Run checks first
  if (Object.keys(checks).length > 0) {
    const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: state.title };

    console.log('');
    console.log(chalk.bold('RUNNING CHECKS...'));

    const results = await runPhaseChecks(checks, projectRoot, checkEnv);
    console.log(formatCheckResults(results));

    if (!allChecksPassed(results)) {
      console.log('');
      console.log(chalk.red('CHECKS FAILED. Cannot advance.'));
      console.log(`\n  Fix the failures and try again.`);
      process.exit(1);
    }
  }

  // Check for gate
  const gate = getPhaseGate(protocol, state.phase);
  if (gate && state.gates[gate]?.status !== 'approved') {
    console.log('');
    console.log(chalk.yellow(`GATE REQUIRED: ${gate}`));
    console.log(`\n  Run: porch2 gate ${state.id}`);
    console.log('  Wait for human approval before advancing.');
    return;
  }

  // Handle phased protocols
  if (isPhased(protocol, state.phase) && state.plan_phases.length > 0) {
    const currentPlanPhase = getCurrentPlanPhase(state.plan_phases);

    if (currentPlanPhase && !allPlanPhasesComplete(state.plan_phases)) {
      // Advance plan phase
      state.plan_phases = advancePlanPhase(state.plan_phases, currentPlanPhase.id);
      state.current_plan_phase = getCurrentPlanPhase(state.plan_phases)?.id || null;
      writeState(statusPath, state);

      console.log('');
      console.log(chalk.green(`PHASE COMPLETE: ${currentPlanPhase.id} - ${currentPlanPhase.title}`));

      const nextPlanPhase = getCurrentPlanPhase(state.plan_phases);
      if (nextPlanPhase) {
        console.log(chalk.cyan(`NEXT PHASE: ${nextPlanPhase.id} - ${nextPlanPhase.title}`));
        console.log(`\n  Run: porch2 status ${state.id}`);
      } else {
        // All plan phases done, move to next protocol phase
        advanceProtocolPhase(state, protocol, statusPath);
      }
      return;
    }
  }

  // Advance to next protocol phase
  advanceProtocolPhase(state, protocol, statusPath);
}

function advanceProtocolPhase(state: ProjectState, protocol: Protocol, statusPath: string): void {
  const nextPhase = getNextPhase(protocol, state.phase);

  if (!nextPhase) {
    console.log('');
    console.log(chalk.green.bold('🎉 PROTOCOL COMPLETE'));
    console.log(`\n  Project ${state.id} has completed the ${state.protocol} protocol.`);
    return;
  }

  state.phase = nextPhase.id;

  // If entering a phased phase, extract plan phases
  if (isPhased(protocol, nextPhase.id)) {
    const planPath = findPlanFile(process.cwd(), state.id, state.title);
    if (planPath) {
      state.plan_phases = extractPhasesFromFile(planPath);
      state.plan_phases[0].status = 'in_progress';
      state.current_plan_phase = state.plan_phases[0].id;
    }
  }

  writeState(statusPath, state);

  console.log('');
  console.log(chalk.green(`ADVANCING TO: ${nextPhase.id} - ${nextPhase.name}`));
  console.log(`\n  Run: porch2 status ${state.id}`);
}

/**
 * porch2 gate <id>
 * Requests human approval for current gate.
 */
export async function gate(projectRoot: string, projectId: string): Promise<void> {
  const statusPath = findStatusPath(projectRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.`);
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(projectRoot, state.protocol);
  const gateName = getPhaseGate(protocol, state.phase);

  if (!gateName) {
    console.log(chalk.dim('No gate required for this phase.'));
    console.log(`\n  Run: porch2 done ${state.id}`);
    return;
  }

  // Mark gate as requested
  if (!state.gates[gateName]) {
    state.gates[gateName] = { status: 'pending' };
  }
  if (!state.gates[gateName].requested_at) {
    state.gates[gateName].requested_at = new Date().toISOString();
    writeState(statusPath, state);
  }

  console.log('');
  console.log(chalk.bold(`GATE: ${gateName}`));
  console.log('');

  // Show relevant artifact
  const artifact = getArtifactForPhase(projectRoot, state);
  if (artifact) {
    console.log(`  Artifact: ${artifact}`);
  }

  console.log('');
  console.log(chalk.yellow('  Human approval required. STOP and wait.'));
  console.log('  Do not proceed until gate is approved.');
  console.log('');
  console.log(chalk.bold('STATUS: WAITING FOR HUMAN APPROVAL'));
  console.log('');
  console.log(chalk.dim(`  To approve: porch2 approve ${state.id} ${gateName}`));
  console.log('');
}

/**
 * porch2 approve <id> <gate>
 * Human approves a gate.
 */
export async function approve(projectRoot: string, projectId: string, gateName: string): Promise<void> {
  const statusPath = findStatusPath(projectRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.`);
  }

  const state = readState(statusPath);

  if (!state.gates[gateName]) {
    const knownGates = Object.keys(state.gates).join(', ');
    throw new Error(`Unknown gate: ${gateName}\nKnown gates: ${knownGates || 'none'}`);
  }

  if (state.gates[gateName].status === 'approved') {
    console.log(chalk.yellow(`Gate ${gateName} is already approved.`));
    return;
  }

  state.gates[gateName].status = 'approved';
  state.gates[gateName].approved_at = new Date().toISOString();
  writeState(statusPath, state);

  console.log('');
  console.log(chalk.green(`Gate ${gateName} approved.`));
  console.log(`\n  Run: porch2 done ${state.id} (to advance)`);
  console.log('');
}

/**
 * porch2 init <protocol> <id> <name>
 * Initialize a new project.
 */
export async function init(
  projectRoot: string,
  protocolName: string,
  projectId: string,
  projectName: string
): Promise<void> {
  const protocol = loadProtocol(projectRoot, protocolName);
  const statusPath = getStatusPath(projectRoot, projectId, projectName);

  // Check if already exists
  if (fs.existsSync(statusPath)) {
    throw new Error(`Project ${projectId}-${projectName} already exists.`);
  }

  const state = createInitialState(protocol, projectId, projectName);
  writeState(statusPath, state);

  console.log('');
  console.log(chalk.green(`Project initialized: ${projectId}-${projectName}`));
  console.log(`  Protocol: ${protocolName}`);
  console.log(`  Initial phase: ${state.phase}`);
  console.log(`\n  Run: porch2 status ${projectId}`);
  console.log('');
}

// ============================================================================
// Helpers
// ============================================================================

function getInstructions(state: ProjectState, protocol: Protocol): string {
  const phase = state.phase;

  if (isPhased(protocol, phase) && state.plan_phases.length > 0) {
    const current = getCurrentPlanPhase(state.plan_phases);
    if (current) {
      return `  You are implementing ${current.id}: "${current.title}".\n\n  Complete the work, then run: porch2 check ${state.id}`;
    }
  }

  const phaseConfig = getPhaseConfig(protocol, phase);
  return `  You are in the ${phaseConfig?.name || phase} phase.\n\n  When complete, run: porch2 done ${state.id}`;
}

function getNextAction(state: ProjectState, protocol: Protocol): string {
  const checks = getPhaseChecks(protocol, state.phase);
  const gate = getPhaseGate(protocol, state.phase);

  if (gate && state.gates[gate]?.status === 'pending' && state.gates[gate]?.requested_at) {
    return chalk.yellow('Wait for human to approve the gate.');
  }

  if (isPhased(protocol, state.phase)) {
    const current = getCurrentPlanPhase(state.plan_phases);
    if (current) {
      return `Implement ${current.title} as specified in the plan.`;
    }
  }

  if (Object.keys(checks).length > 0) {
    return `Complete the phase work, then run: porch2 check ${state.id}`;
  }

  return `Complete the phase work, then run: porch2 done ${state.id}`;
}

function getArtifactForPhase(projectRoot: string, state: ProjectState): string | null {
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

// ============================================================================
// CLI
// ============================================================================

export async function cli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const projectRoot = process.cwd();

  try {
    switch (command) {
      case 'status':
        if (!rest[0]) throw new Error('Usage: porch2 status <id>');
        await status(projectRoot, rest[0]);
        break;

      case 'check':
        if (!rest[0]) throw new Error('Usage: porch2 check <id>');
        await check(projectRoot, rest[0]);
        break;

      case 'done':
        if (!rest[0]) throw new Error('Usage: porch2 done <id>');
        await done(projectRoot, rest[0]);
        break;

      case 'gate':
        if (!rest[0]) throw new Error('Usage: porch2 gate <id>');
        await gate(projectRoot, rest[0]);
        break;

      case 'approve':
        if (!rest[0] || !rest[1]) throw new Error('Usage: porch2 approve <id> <gate>');
        await approve(projectRoot, rest[0], rest[1]);
        break;

      case 'init':
        if (!rest[0] || !rest[1] || !rest[2]) {
          throw new Error('Usage: porch2 init <protocol> <id> <name>');
        }
        await init(projectRoot, rest[0], rest[1], rest[2]);
        break;

      default:
        console.log('porch2 - Minimal Protocol Orchestrator');
        console.log('');
        console.log('Commands:');
        console.log('  status <id>              Show current state and instructions');
        console.log('  check <id>               Run checks for current phase');
        console.log('  done <id>                Advance to next phase (if checks pass)');
        console.log('  gate <id>                Request human approval');
        console.log('  approve <id> <gate>      Approve a gate');
        console.log('  init <protocol> <id> <name>  Initialize a new project');
        console.log('');
        process.exit(command ? 1 : 0);
    }
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
