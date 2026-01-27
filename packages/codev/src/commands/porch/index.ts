/**
 * Porch - Protocol Orchestrator
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
  detectProjectId,
} from './state.js';
import {
  loadProtocol,
  getPhaseConfig,
  getNextPhase,
  getPhaseChecks,
  getPhaseGate,
  isPhased,
  getPhaseCompletionChecks,
} from './protocol.js';
import {
  findPlanFile,
  extractPhasesFromFile,
  getCurrentPlanPhase,
  getPhaseContent,
  advancePlanPhase,
  allPlanPhasesComplete,
  isPlanPhaseComplete,
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
 * porch status <id>
 * Shows current state and prescriptive next steps.
 */
export async function status(projectRoot: string, projectId: string): Promise<void> {
  const statusPath = findStatusPath(projectRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.\nRun 'porch init' to create a new project.`);
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(projectRoot, state.protocol);
  const phaseConfig = getPhaseConfig(protocol, state.phase);

  // Header
  console.log('');
  console.log(header(`PROJECT: ${state.id} - ${state.title}`));
  console.log(`  PROTOCOL: ${state.protocol}`);
  console.log(`  PHASE: ${state.phase} (${phaseConfig?.name || 'unknown'})`);

  // For phased protocols, show plan phase status
  if (isPhased(protocol, state.phase) && state.plan_phases.length > 0) {
    console.log('');
    console.log(chalk.bold('PLAN PHASES:'));
    console.log('');

    // Status icons
    const icon = (status: string) => {
      switch (status) {
        case 'complete': return chalk.green('✓');
        case 'in_progress': return chalk.yellow('►');
        default: return chalk.gray('○');
      }
    };

    // Show phases
    for (const phase of state.plan_phases) {
      const isCurrent = phase.status === 'in_progress';
      const prefix = isCurrent ? chalk.cyan('→ ') : '  ';
      const title = isCurrent ? chalk.bold(phase.title) : phase.title;

      console.log(`${prefix}${icon(phase.status)} ${phase.id}: ${title}`);
    }

    const currentPlanPhase = getCurrentPlanPhase(state.plan_phases);
    if (currentPlanPhase) {
      console.log('');
      console.log(chalk.bold(`CURRENT: ${currentPlanPhase.id} - ${currentPlanPhase.title}`));

      // Show phase content from plan
      const planPath = findPlanFile(projectRoot, state.id, state.title);
      if (planPath) {
        const content = fs.readFileSync(planPath, 'utf-8');
        const phaseContent = getPhaseContent(content, currentPlanPhase.id);
        if (phaseContent) {
          console.log(section('FROM THE PLAN', phaseContent.slice(0, 500)));
        }
      }

      // Find the next phase name for the warning
      const currentIdx = state.plan_phases.findIndex(p => p.id === currentPlanPhase.id);
      const nextPlanPhase = state.plan_phases[currentIdx + 1];

      console.log('');
      console.log(chalk.red.bold('╔══════════════════════════════════════════════════════════════╗'));
      console.log(chalk.red.bold('║  🛑 CRITICAL RULES                                           ║'));
      if (nextPlanPhase) {
        console.log(chalk.red.bold(`║  1. DO NOT start ${nextPlanPhase.id} until you run porch again!`.padEnd(63) + '║'));
      } else {
        console.log(chalk.red.bold('║  1. DO NOT start the next phase until you run porch again!   ║'));
      }
      console.log(chalk.red.bold('║  2. Run /compact before starting each new phase              ║'));
      console.log(chalk.red.bold('║  3. After completing this phase, run: porch done ' + state.id.padEnd(12) + '║'));
      console.log(chalk.red.bold('╚══════════════════════════════════════════════════════════════╝'));
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
    console.log(`\n  To approve: porch approve ${state.id} ${gate}`);
  } else {
    console.log(section('INSTRUCTIONS', getInstructions(state, protocol)));
  }

  console.log(section('NEXT ACTION', getNextAction(state, protocol)));
  console.log('');
}

/**
 * porch check <id>
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
    console.log(`\n  Run: porch done ${state.id} (to advance)`);
  } else {
    console.log(chalk.red('RESULT: CHECKS FAILED'));
    console.log(`\n  Fix the failures and run: porch check ${state.id}`);
  }
  console.log('');
}

/**
 * porch done <id>
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
    console.log(`\n  Run: porch gate ${state.id}`);
    console.log('  Wait for human approval before advancing.');
    return;
  }

  // Handle phased protocols (plan phases with checks at completion)
  if (isPhased(protocol, state.phase) && state.plan_phases.length > 0) {
    const currentPlanPhase = getCurrentPlanPhase(state.plan_phases);

    if (currentPlanPhase && !allPlanPhasesComplete(state.plan_phases)) {
      // Run phase completion checks (implement + defend + evaluate all at once)
      const completionChecks = getPhaseCompletionChecks(protocol);
      if (Object.keys(completionChecks).length > 0) {
        const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: state.title };

        console.log('');
        console.log(chalk.bold(`RUNNING PHASE COMPLETION CHECKS (${currentPlanPhase.id})...`));

        const results = await runPhaseChecks(completionChecks, projectRoot, checkEnv);
        console.log(formatCheckResults(results));

        if (!allChecksPassed(results)) {
          console.log('');
          console.log(chalk.red('PHASE COMPLETION CHECKS FAILED. Cannot advance.'));
          console.log(`\n  Ensure your commit includes:`);
          console.log(`    - Implementation code`);
          console.log(`    - Tests`);
          console.log(`    - 3-way review results in commit message`);
          console.log(`\n  Then try again.`);
          process.exit(1);
        }
      }

      // Advance to next plan phase
      const { phases: updatedPhases, moveToReview } = advancePlanPhase(
        state.plan_phases,
        currentPlanPhase.id
      );

      state.plan_phases = updatedPhases;

      console.log('');
      console.log(chalk.green(`PLAN PHASE COMPLETE: ${currentPlanPhase.id} - ${currentPlanPhase.title}`));

      // Check if moving to review (all plan phases done)
      if (moveToReview) {
        state.phase = 'review';
        state.current_plan_phase = null;
        writeState(statusPath, state);
        console.log(chalk.cyan('All plan phases complete. Moving to REVIEW phase.'));
        console.log(`\n  Run: porch status ${state.id}`);
        return;
      }

      // Update current plan phase tracker
      const newCurrentPhase = getCurrentPlanPhase(state.plan_phases);
      state.current_plan_phase = newCurrentPhase?.id || null;

      writeState(statusPath, state);

      if (newCurrentPhase) {
        console.log(chalk.cyan(`NEXT: ${newCurrentPhase.id} - ${newCurrentPhase.title}`));
      }
      console.log(`\n  Run: porch status ${state.id}`);
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

  // If entering a phased phase (implement), extract plan phases
  if (isPhased(protocol, nextPhase.id)) {
    const planPath = findPlanFile(process.cwd(), state.id, state.title);
    if (planPath) {
      state.plan_phases = extractPhasesFromFile(planPath);
      // extractPhasesFromFile already marks first phase as in_progress
      if (state.plan_phases.length > 0) {
        state.current_plan_phase = state.plan_phases[0].id;
      }
    }
  }

  writeState(statusPath, state);

  console.log('');
  console.log(chalk.green(`ADVANCING TO: ${nextPhase.id} - ${nextPhase.name}`));

  // If we just entered implement phase, show phase 1 info and the critical warning
  if (isPhased(protocol, nextPhase.id) && state.plan_phases.length > 0) {
    const firstPhase = state.plan_phases[0];
    const nextPlanPhase = state.plan_phases[1];

    console.log('');
    console.log(chalk.bold(`YOUR TASK: ${firstPhase.id} - "${firstPhase.title}"`));

    // Show phase content from plan
    const planPath = findPlanFile(process.cwd(), state.id, state.title);
    if (planPath) {
      const content = fs.readFileSync(planPath, 'utf-8');
      const phaseContent = getPhaseContent(content, firstPhase.id);
      if (phaseContent) {
        console.log(section('FROM THE PLAN', phaseContent.slice(0, 800)));
      }
    }

    console.log('');
    console.log(chalk.red.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.red.bold('║  🛑 CRITICAL RULES                                           ║'));
    if (nextPlanPhase) {
      console.log(chalk.red.bold(`║  1. DO NOT start ${nextPlanPhase.id} until you run porch again!`.padEnd(63) + '║'));
    } else {
      console.log(chalk.red.bold('║  1. DO NOT start the next phase until you run porch again!   ║'));
    }
    console.log(chalk.red.bold('║  2. Run /compact before starting each new phase              ║'));
    console.log(chalk.red.bold('║  3. When phase complete, run: porch done ' + state.id.padEnd(20) + '║'));
    console.log(chalk.red.bold('╚══════════════════════════════════════════════════════════════╝'));
  }

  console.log(`\n  Run: porch status ${state.id}`);
}

/**
 * porch gate <id>
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
    console.log(`\n  Run: porch done ${state.id}`);
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

  // Show relevant artifact and open it for review
  const artifact = getArtifactForPhase(projectRoot, state);
  if (artifact) {
    const fullPath = path.join(projectRoot, artifact);
    if (fs.existsSync(fullPath)) {
      console.log(`  Artifact: ${artifact}`);
      console.log('');
      console.log(chalk.cyan('  Opening artifact for human review...'));
      // Use af open to display in annotation viewer
      const { spawn } = await import('node:child_process');
      spawn('af', ['open', fullPath], {
        stdio: 'inherit',
        detached: true
      }).unref();
    }
  }

  console.log('');
  console.log(chalk.yellow('  Human approval required. STOP and wait.'));
  console.log('  Do not proceed until gate is approved.');
  console.log('');
  console.log(chalk.bold('STATUS: WAITING FOR HUMAN APPROVAL'));
  console.log('');
  console.log(chalk.dim(`  To approve: porch approve ${state.id} ${gateName}`));
  console.log('');
}

/**
 * porch approve <id> <gate> --a-human-explicitly-approved-this
 * Human approves a gate. Requires explicit flag to prevent automated approvals.
 */
export async function approve(
  projectRoot: string,
  projectId: string,
  gateName: string,
  hasHumanFlag: boolean
): Promise<void> {
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

  // Require explicit human flag
  if (!hasHumanFlag) {
    console.log('');
    console.log(chalk.red('ERROR: Human approval required.'));
    console.log('');
    console.log('  To approve, please run:');
    console.log('');
    console.log(chalk.cyan(`    porch approve ${projectId} ${gateName} --a-human-explicitly-approved-this`));
    console.log('');
    process.exit(1);
  }

  // Run phase checks before approving
  const protocol = loadProtocol(projectRoot, state.protocol);
  const checks = getPhaseChecks(protocol, state.phase);

  if (Object.keys(checks).length > 0) {
    const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: state.title };

    console.log('');
    console.log(chalk.bold('RUNNING CHECKS...'));

    const results = await runPhaseChecks(checks, projectRoot, checkEnv);
    console.log(formatCheckResults(results));

    if (!allChecksPassed(results)) {
      console.log('');
      console.log(chalk.red('CHECKS FAILED. Cannot approve gate.'));
      console.log(`\n  Fix the failures and try again.`);
      process.exit(1);
    }
  }

  state.gates[gateName].status = 'approved';
  state.gates[gateName].approved_at = new Date().toISOString();
  writeState(statusPath, state);

  console.log('');
  console.log(chalk.green(`Gate ${gateName} approved.`));
  console.log(`\n  Run: porch done ${state.id} (to advance)`);
  console.log('');
}

/**
 * porch init <protocol> <id> <name>
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

  const state = createInitialState(protocol, projectId, projectName, projectRoot);
  writeState(statusPath, state);

  console.log('');
  console.log(chalk.green(`Project initialized: ${projectId}-${projectName}`));
  console.log(`  Protocol: ${protocolName}`);
  console.log(`  Starting phase: ${state.phase}`);
  console.log(`\n  Run: porch status ${projectId}`);
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
      return `  You are implementing ${current.id}: "${current.title}".\n\n  Complete the work, then run: porch check ${state.id}`;
    }
  }

  const phaseConfig = getPhaseConfig(protocol, phase);
  return `  You are in the ${phaseConfig?.name || phase} phase.\n\n  When complete, run: porch done ${state.id}`;
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
    return `Complete the phase work, then run: porch check ${state.id}`;
  }

  return `Complete the phase work, then run: porch done ${state.id}`;
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

  // Auto-detect project ID for commands that need it
  function getProjectId(provided?: string): string {
    if (provided) return provided;
    const detected = detectProjectId(projectRoot);
    if (detected) {
      console.log(chalk.dim(`[auto-detected project: ${detected}]`));
      return detected;
    }
    throw new Error('No project ID provided and could not auto-detect.\nProvide ID explicitly or ensure exactly one project exists in codev/projects/');
  }

  try {
    switch (command) {
      case 'run':
        const { run } = await import('./run.js');
        await run(projectRoot, getProjectId(rest[0]));
        break;

      case 'status':
        await status(projectRoot, getProjectId(rest[0]));
        break;

      case 'check':
        await check(projectRoot, getProjectId(rest[0]));
        break;

      case 'done':
        await done(projectRoot, getProjectId(rest[0]));
        break;

      case 'gate':
        await gate(projectRoot, getProjectId(rest[0]));
        break;

      case 'approve':
        if (!rest[0] || !rest[1]) throw new Error('Usage: porch approve <id> <gate> --a-human-explicitly-approved-this');
        const hasHumanFlag = rest.includes('--a-human-explicitly-approved-this');
        await approve(projectRoot, rest[0], rest[1], hasHumanFlag);
        break;

      case 'init':
        if (!rest[0] || !rest[1] || !rest[2]) {
          throw new Error('Usage: porch init <protocol> <id> <name>');
        }
        await init(projectRoot, rest[0], rest[1], rest[2]);
        break;

      default:
        console.log('porch - Protocol Orchestrator');
        console.log('');
        console.log('Commands:');
        console.log('  run [id]                 Run the protocol (auto-detects if one project)');
        console.log('  status [id]              Show current state and instructions');
        console.log('  check [id]               Run checks for current phase');
        console.log('  done [id]                Advance to next phase (if checks pass)');
        console.log('  gate [id]                Request human approval');
        console.log('  approve <id> <gate> --a-human-explicitly-approved-this');
        console.log('  init <protocol> <id> <name>  Initialize a new project');
        console.log('');
        console.log('Project ID is auto-detected when exactly one project exists.');
        console.log('');
        process.exit(command ? 1 : 0);
    }
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
