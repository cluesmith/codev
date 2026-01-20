/**
 * Porch - Protocol Orchestrator
 *
 * Generic loop orchestrator that reads protocol definitions from JSON
 * and executes them with Claude. Implements the Ralph pattern: fresh
 * context per iteration with state persisted to files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { findProjectRoot, getSkeletonDir } from '../../lib/skeleton.js';
import type {
  Protocol,
  Phase,
  ProjectState,
  PorchRunOptions,
  PorchInitOptions,
} from './types.js';
import {
  getProjectDir,
  getProjectStatusPath,
  getExecutionStatusPath,
  readState,
  writeState,
  createInitialState,
  updateState,
  approveGate,
  requestGateApproval,
  updatePhaseStatus,
  setPlanPhases,
  findProjects,
  findExecutions,
  findStatusFile,
  findPendingGates,
  getConsultationAttempts,
  incrementConsultationAttempts,
  resetConsultationAttempts,
} from './state.js';
import {
  extractPhasesFromPlanFile,
  findPlanFile,
  getCurrentPhase,
  getNextPhase as getNextPlanPhase,
  allPhasesComplete,
} from './plan-parser.js';
import { extractSignal, parseSignal } from './signal-parser.js';
import { runPhaseChecks, formatCheckResults } from './checks.js';
import {
  runConsultationLoop,
  formatConsultationResults,
  hasConsultation,
} from './consultation.js';
import {
  loadProtocol as loadProtocolFromLoader,
  listProtocols as listProtocolsFromLoader,
} from './protocol-loader.js';
import {
  createNotifier,
} from './notifications.js';

// ============================================================================
// Protocol Loading (delegates to protocol-loader.ts)
// ============================================================================

/**
 * List available protocols
 * Delegates to protocol-loader.ts for proper conversion
 */
export function listProtocols(projectRoot?: string): string[] {
  const root = projectRoot || findProjectRoot();
  return listProtocolsFromLoader(root);
}

/**
 * Load a protocol definition
 * Delegates to protocol-loader.ts which properly converts steps→substates
 */
export function loadProtocol(name: string, projectRoot?: string): Protocol {
  const root = projectRoot || findProjectRoot();
  const protocol = loadProtocolFromLoader(root, name);

  if (!protocol) {
    throw new Error(`Protocol not found: ${name}\nAvailable protocols: ${listProtocols(root).join(', ')}`);
  }

  return protocol;
}

/**
 * Load a prompt file for a phase
 */
function loadPrompt(protocol: Protocol, phaseId: string, projectRoot: string): string | null {
  const phase = protocol.phases.find(p => p.id === phaseId);
  if (!phase?.prompt) {
    return null;
  }

  // New structure: protocols/<protocol>/prompts/<prompt>.md
  const promptPaths = [
    path.join(projectRoot, 'codev', 'protocols', protocol.name, 'prompts', phase.prompt),
    path.join(getSkeletonDir(), 'protocols', protocol.name, 'prompts', phase.prompt),
    // Legacy paths
    path.join(projectRoot, 'codev', 'porch', 'prompts', phase.prompt),
    path.join(getSkeletonDir(), 'porch', 'prompts', phase.prompt),
  ];

  for (const promptPath of promptPaths) {
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf-8');
    }
    // Try with .md extension
    if (fs.existsSync(`${promptPath}.md`)) {
      return fs.readFileSync(`${promptPath}.md`, 'utf-8');
    }
  }

  return null;
}

// ============================================================================
// Protocol Helpers
// ============================================================================

/**
 * Check if a phase is terminal
 */
function isTerminalPhase(protocol: Protocol, phaseId: string): boolean {
  const phase = protocol.phases.find(p => p.id === phaseId);
  return phase?.terminal === true;
}

/**
 * Find the phase that has a gate blocking after the given state
 */
function getGateForState(protocol: Protocol, state: string): { gateId: string; phase: Phase } | null {
  const [phaseId, substate] = state.split(':');
  const phase = protocol.phases.find(p => p.id === phaseId);

  if (phase?.gate && phase.gate.after === substate) {
    const gateId = `${phaseId}_approval`;
    return { gateId, phase };
  }

  return null;
}

/**
 * Get next state after gate passes
 */
function getGateNextState(protocol: Protocol, phaseId: string): string | null {
  const phase = protocol.phases.find(p => p.id === phaseId);
  return phase?.gate?.next || null;
}

/**
 * Get signal-based next state
 */
function getSignalNextState(protocol: Protocol, phaseId: string, signal: string): string | null {
  const phase = protocol.phases.find(p => p.id === phaseId);
  return phase?.signals?.[signal] || null;
}

/**
 * Get the default next state for a phase (first substate or next phase)
 */
function getDefaultNextState(protocol: Protocol, state: string): string | null {
  const [phaseId, substate] = state.split(':');
  const phase = protocol.phases.find(p => p.id === phaseId);

  if (!phase) return null;

  // If phase has substates, move to next substate
  if (phase.substates && substate) {
    const currentIdx = phase.substates.indexOf(substate);
    if (currentIdx >= 0 && currentIdx < phase.substates.length - 1) {
      return `${phaseId}:${phase.substates[currentIdx + 1]}`;
    }
  }

  // Move to next phase
  const phaseIdx = protocol.phases.findIndex(p => p.id === phaseId);
  if (phaseIdx >= 0 && phaseIdx < protocol.phases.length - 1) {
    const nextPhase = protocol.phases[phaseIdx + 1];
    if (nextPhase.substates && nextPhase.substates.length > 0) {
      return `${nextPhase.id}:${nextPhase.substates[0]}`;
    }
    return nextPhase.id;
  }

  return null;
}

// ============================================================================
// Claude Invocation
// ============================================================================

// Note: extractSignal is now imported from signal-parser.js

/**
 * Invoke Claude for a phase
 */
async function invokeClaude(
  protocol: Protocol,
  phaseId: string,
  state: ProjectState,
  statusFilePath: string,
  projectRoot: string,
  options: PorchRunOptions
): Promise<string> {
  const promptContent = loadPrompt(protocol, phaseId, projectRoot);

  if (!promptContent) {
    console.log(chalk.yellow(`[porch] No prompt file for phase: ${phaseId}`));
    return '';
  }

  if (options.dryRun) {
    console.log(chalk.yellow(`[porch] [DRY RUN] Would invoke Claude for phase: ${phaseId}`));
    return '';
  }

  if (options.noClaude) {
    console.log(chalk.blue(`[porch] [NO_CLAUDE] Simulating phase: ${phaseId}`));
    await new Promise(r => setTimeout(r, 1000));
    console.log(chalk.green(`[porch] Simulated completion of phase: ${phaseId}`));
    return '';
  }

  console.log(chalk.cyan(`[phase] Invoking Claude for phase: ${phaseId}`));

  const timeout = protocol.config?.claude_timeout || 600000; // 10 minutes default

  const fullPrompt = `## Protocol: ${protocol.name}
## Phase: ${phaseId}
## Project ID: ${state.id}

## Current Status
\`\`\`yaml
state: "${state.current_state}"
iteration: ${state.iteration}
started_at: "${state.started_at}"
\`\`\`

## Task
Execute the ${phaseId} phase for project ${state.id} - ${state.title}

## Phase Instructions
${promptContent}

## Important
- Project ID: ${state.id}
- Protocol: ${protocol.name}
- Follow the instructions above precisely
- Output <signal>...</signal> tags when you reach completion points
`;

  return new Promise((resolve, reject) => {
    const args = ['--print', '-p', fullPrompt, '--dangerously-skip-permissions'];
    const proc = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    let output = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
      process.stdout.write(data);
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}\n${stderr}`));
      } else {
        resolve(output);
      }
    });

    proc.on('error', reject);
  });
}

// ============================================================================
// Commands
// ============================================================================

/**
 * Initialize a new project with a protocol
 */
export async function init(
  protocolName: string,
  projectId: string,
  projectName: string,
  options: PorchInitOptions = {}
): Promise<void> {
  const projectRoot = findProjectRoot();
  const protocol = loadProtocol(protocolName, projectRoot);

  // Create project directory
  const projectDir = getProjectDir(projectRoot, projectId, projectName);
  fs.mkdirSync(projectDir, { recursive: true });

  // Create initial state
  const state = createInitialState(protocol, projectId, projectName, options.worktree);
  const statusPath = path.join(projectDir, 'status.yaml');

  await writeState(statusPath, state);

  console.log(chalk.green(`[porch] Initialized project ${projectId} with protocol ${protocolName}`));
  console.log(chalk.blue(`[porch] Project directory: ${projectDir}`));
  console.log(chalk.blue(`[porch] Initial state: ${state.current_state}`));
}

/**
 * Check if a protocol phase is a "phased" phase (runs per plan-phase)
 */
function isPhasedPhase(protocol: Protocol, phaseId: string): boolean {
  const phase = protocol.phases.find(p => p.id === phaseId);
  return phase?.phased === true;
}

/**
 * Get the IDE phases (implement, defend, evaluate) that run per plan-phase
 */
function getIDEPhases(protocol: Protocol): string[] {
  return protocol.phases
    .filter(p => p.phased === true)
    .map(p => p.id);
}

/**
 * Parse the current plan-phase from state like "implement:phase_1"
 */
function parsePlanPhaseFromState(state: string): { phaseId: string; planPhaseId: string | null; substate: string | null } {
  const parts = state.split(':');
  const phaseId = parts[0];

  // Check if second part is a plan phase (phase_N) or a substate
  if (parts.length > 1) {
    if (parts[1].startsWith('phase_')) {
      return { phaseId, planPhaseId: parts[1], substate: parts[2] || null };
    }
    return { phaseId, planPhaseId: null, substate: parts[1] };
  }

  return { phaseId, planPhaseId: null, substate: null };
}

/**
 * Get the next IDE state for a phased phase
 * implement:phase_1 → defend:phase_1 → evaluate:phase_1 → implement:phase_2 → ...
 */
function getNextIDEState(
  protocol: Protocol,
  currentState: string,
  planPhases: Array<{ id: string; title: string }>,
  signal?: string
): string | null {
  const { phaseId, planPhaseId } = parsePlanPhaseFromState(currentState);

  if (!planPhaseId) return null;

  const idePhases = getIDEPhases(protocol);
  const currentIdeIndex = idePhases.indexOf(phaseId);

  if (currentIdeIndex < 0) return null;

  // If not at the end of IDE phases, move to next IDE phase for same plan-phase
  if (currentIdeIndex < idePhases.length - 1) {
    return `${idePhases[currentIdeIndex + 1]}:${planPhaseId}`;
  }

  // At end of IDE phases (evaluate), move to next plan-phase
  const currentPlanIndex = planPhases.findIndex(p => p.id === planPhaseId);
  if (currentPlanIndex < 0) return null;

  // Check if there's a next plan phase
  if (currentPlanIndex < planPhases.length - 1) {
    const nextPlanPhase = planPhases[currentPlanIndex + 1];
    return `${idePhases[0]}:${nextPlanPhase.id}`; // Start implement for next phase
  }

  // All plan phases complete, move to review
  const reviewPhase = protocol.phases.find(p => p.id === 'review');
  if (reviewPhase) {
    return 'review';
  }

  return 'complete';
}

// ============================================================================
// Interactive REPL
// ============================================================================

/**
 * Create a readline interface for interactive input
 */
function createRepl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
}

/**
 * Prompt user for input with a given message
 */
async function prompt(rl: readline.Interface, message: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Show REPL help
 */
function showReplHelp(): void {
  console.log('');
  console.log(chalk.blue('Porch REPL Commands:'));
  console.log('  ' + chalk.green('approve') + ' [gate]  - Approve pending gate (or current if omitted)');
  console.log('  ' + chalk.green('view') + '            - View the full artifact for current gate');
  console.log('  ' + chalk.green('status') + '          - Show current project status');
  console.log('  ' + chalk.green('continue') + '        - Continue to next iteration');
  console.log('  ' + chalk.green('skip') + '            - Skip current phase (use with caution)');
  console.log('  ' + chalk.green('help') + '            - Show this help');
  console.log('  ' + chalk.green('quit') + '            - Exit porch');
  console.log('');
}

/**
 * Display current status summary
 */
function displayStatus(state: ProjectState, protocol: Protocol): void {
  console.log('');
  console.log(chalk.blue('─'.repeat(50)));
  console.log(chalk.blue(`Project: ${state.id} - ${state.title}`));
  console.log(chalk.blue(`Protocol: ${state.protocol}`));
  console.log(chalk.blue(`State: ${state.current_state}`));
  console.log(chalk.blue(`Iteration: ${state.iteration}`));

  // Show pending gates
  const pendingGates = Object.entries(state.gates)
    .filter(([, g]) => g.status === 'pending' && g.requested_at)
    .map(([id]) => id);

  if (pendingGates.length > 0) {
    console.log(chalk.yellow(`Pending gates: ${pendingGates.join(', ')}`));
  }
  console.log(chalk.blue('─'.repeat(50)));
  console.log('');
}

/**
 * Get the artifact file path for a gate
 */
function getGateArtifact(gateId: string, state: ProjectState, projectRoot: string): string | null {
  const projectDir = `${state.id}-${state.title}`;

  if (gateId === 'specify_approval') {
    // Look for spec file
    const specPath = path.join(projectRoot, 'codev', 'specs', `${projectDir}.md`);
    if (fs.existsSync(specPath)) return specPath;
    // Try alternate naming
    const altPath = path.join(projectRoot, 'codev', 'specs', `${state.id}-${state.title}.md`);
    if (fs.existsSync(altPath)) return altPath;
  } else if (gateId === 'plan_approval') {
    // Look for plan file
    const planPath = path.join(projectRoot, 'codev', 'plans', `${projectDir}.md`);
    if (fs.existsSync(planPath)) return planPath;
    const altPath = path.join(projectRoot, 'codev', 'plans', `${state.id}-${state.title}.md`);
    if (fs.existsSync(altPath)) return altPath;
  } else if (gateId === 'review_approval') {
    // Look for review file
    const reviewPath = path.join(projectRoot, 'codev', 'reviews', `${projectDir}.md`);
    if (fs.existsSync(reviewPath)) return reviewPath;
  }
  return null;
}

/**
 * Display gate context - show what artifact was created and key information
 */
function displayGateContext(gateId: string, state: ProjectState, projectRoot: string): void {
  const artifactPath = getGateArtifact(gateId, state, projectRoot);

  console.log('');
  console.log(chalk.cyan('─'.repeat(50)));
  console.log(chalk.cyan('  CONTEXT FOR REVIEW'));
  console.log(chalk.cyan('─'.repeat(50)));

  if (artifactPath) {
    console.log(chalk.white(`  Artifact: ${artifactPath}`));
    console.log('');

    // Read and show first ~30 lines of the artifact
    try {
      const content = fs.readFileSync(artifactPath, 'utf-8');
      const lines = content.split('\n');
      const preview = lines.slice(0, 30).join('\n');
      console.log(chalk.gray('  ┌' + '─'.repeat(46) + '┐'));
      for (const line of preview.split('\n')) {
        console.log(chalk.gray('  │ ') + line.slice(0, 44));
      }
      if (lines.length > 30) {
        console.log(chalk.gray(`  │ ... (${lines.length - 30} more lines)`));
      }
      console.log(chalk.gray('  └' + '─'.repeat(46) + '┘'));
      console.log('');
      console.log(chalk.white(`  To view full document: cat ${artifactPath}`));
    } catch (e) {
      console.log(chalk.yellow(`  Could not read artifact: ${e}`));
    }
  } else {
    console.log(chalk.yellow('  No artifact file found for this gate.'));
    console.log(chalk.yellow('  This may indicate Claude did not produce the expected output.'));

    // Show what we expected
    if (gateId === 'specify_approval') {
      console.log(chalk.gray(`  Expected: codev/specs/${state.id}-${state.title}.md`));
    } else if (gateId === 'plan_approval') {
      console.log(chalk.gray(`  Expected: codev/plans/${state.id}-${state.title}.md`));
    }
  }
  console.log('');
}

/**
 * Run the protocol loop for a project (Interactive REPL mode)
 */
export async function run(
  projectId: string,
  options: PorchRunOptions = {}
): Promise<void> {
  const projectRoot = findProjectRoot();

  // Find status file
  const statusFilePath = findStatusFile(projectRoot, projectId);
  if (!statusFilePath) {
    throw new Error(
      `Status file not found for project: ${projectId}\n` +
      `Run: porch init <protocol> ${projectId} <project-name>`
    );
  }

  // Read state and load protocol
  const state = readState(statusFilePath);
  if (!state) {
    throw new Error(`Could not read state from: ${statusFilePath}`);
  }

  const protocol = loadProtocol(state.protocol, projectRoot);
  const maxIterations = protocol.config?.max_iterations || 100;

  // Create notifier for this project (desktop notifications for important events)
  const notifier = createNotifier(projectId, { desktop: true });

  // Create REPL interface
  const rl = createRepl();

  console.log('');
  console.log(chalk.green('═'.repeat(50)));
  console.log(chalk.green(`  PORCH - Protocol Orchestrator`));
  console.log(chalk.green('═'.repeat(50)));
  console.log(chalk.blue(`  Project: ${state.id} - ${state.title}`));
  console.log(chalk.blue(`  Protocol: ${state.protocol}`));
  console.log(chalk.blue(`  State: ${state.current_state}`));
  console.log(chalk.green('═'.repeat(50)));
  console.log('');
  console.log(chalk.gray('Type "help" for commands, "quit" to exit'));
  console.log('');

  let currentState = state;

  // Extract plan phases if not already done and we're past planning
  if (!currentState.plan_phases || currentState.plan_phases.length === 0) {
    const planFile = findPlanFile(projectRoot, projectId, currentState.title);
    if (planFile) {
      try {
        const planPhases = extractPhasesFromPlanFile(planFile);
        currentState = setPlanPhases(currentState, planPhases);
        await writeState(statusFilePath, currentState);
        console.log(chalk.blue(`[porch] Extracted ${planPhases.length} phases from plan`));
        for (const phase of planPhases) {
          console.log(chalk.blue(`  - ${phase.id}: ${phase.title}`));
        }
      } catch (e) {
        console.log(chalk.yellow(`[porch] Could not extract plan phases: ${e}`));
      }
    }
  }

  for (let iteration = currentState.iteration; iteration <= maxIterations; iteration++) {
    console.log(chalk.blue('━'.repeat(40)));
    console.log(chalk.blue(`[porch] Iteration ${iteration}`));
    console.log(chalk.blue('━'.repeat(40)));

    // Fresh read of state each iteration (Ralph pattern)
    currentState = readState(statusFilePath) || currentState;
    console.log(chalk.blue(`[porch] Current state: ${currentState.current_state}`));

    // Parse state into phase and substate
    const { phaseId, planPhaseId, substate } = parsePlanPhaseFromState(currentState.current_state);

    // Re-attempt plan phase extraction if entering a phased phase without plan phases
    // This handles the case where porch started during Specify phase (no plan file yet)
    if (isPhasedPhase(protocol, phaseId) && (!currentState.plan_phases || currentState.plan_phases.length === 0)) {
      const planFile = findPlanFile(projectRoot, projectId, currentState.title);
      if (planFile) {
        try {
          const planPhases = extractPhasesFromPlanFile(planFile);
          currentState = setPlanPhases(currentState, planPhases);
          await writeState(statusFilePath, currentState);
          console.log(chalk.blue(`[porch] Late discovery: Extracted ${planPhases.length} phases from plan`));
          for (const phase of planPhases) {
            console.log(chalk.blue(`  - ${phase.id}: ${phase.title}`));
          }
        } catch (e) {
          console.log(chalk.yellow(`[porch] Could not extract plan phases: ${e}`));
        }
      } else {
        console.log(chalk.yellow(`[porch] Warning: Entering phased phase '${phaseId}' but no plan file found`));
      }
    }

    // Check if terminal phase
    if (isTerminalPhase(protocol, phaseId)) {
      console.log(chalk.green('━'.repeat(40)));
      console.log(chalk.green(`[porch] ${state.protocol} loop COMPLETE`));
      console.log(chalk.green(`[porch] Project ${projectId} finished all phases`));
      console.log(chalk.green('━'.repeat(40)));
      rl.close();
      return;
    }

    // Check if there's a pending gate from a previous iteration (step already executed)
    const pendingGateInfo = getGateForState(protocol, currentState.current_state);
    if (pendingGateInfo) {
      const { gateId } = pendingGateInfo;

      // Check if gate is already approved
      if (currentState.gates[gateId]?.status === 'passed') {
        // Gate approved - proceed to next state
        const nextState = getGateNextState(protocol, phaseId);
        if (nextState) {
          console.log(chalk.green(`[porch] Gate ${gateId} passed! Proceeding to ${nextState}`));
          await notifier.gateApproved(gateId);

          // Reset any consultation attempts for the gated state
          currentState = resetConsultationAttempts(currentState, currentState.current_state);

          // If entering a phased phase, start with first plan phase
          if (isPhasedPhase(protocol, nextState.split(':')[0]) && currentState.plan_phases?.length) {
            const firstPlanPhase = currentState.plan_phases[0];
            currentState = updateState(currentState, `${nextState.split(':')[0]}:${firstPlanPhase.id}`);
            currentState = updatePhaseStatus(currentState, firstPlanPhase.id, 'in_progress');
          } else {
            currentState = updateState(currentState, nextState);
          }
          await writeState(statusFilePath, currentState);
          continue; // Start next iteration with new state
        }
      } else if (currentState.gates[gateId]?.requested_at) {
        // Gate requested but not approved - prompt user interactively
        console.log('');
        console.log(chalk.yellow('═'.repeat(50)));
        console.log(chalk.yellow(`  GATE PENDING: ${gateId}`));
        console.log(chalk.yellow('═'.repeat(50)));
        console.log(chalk.cyan(`  Phase: ${phaseId}`));
        console.log(chalk.cyan(`  State: ${currentState.current_state}`));

        // Show context for the gate - what artifact was created
        displayGateContext(gateId, currentState, projectRoot);

        // Interactive gate approval loop
        let gateHandled = false;
        while (!gateHandled) {
          const answer = await prompt(rl, chalk.yellow(`Approve ${gateId}? [y/n/help]: `));

          switch (answer) {
            case 'y':
            case 'yes':
            case 'approve':
              currentState = approveGate(currentState, gateId);
              await writeState(statusFilePath, currentState);
              console.log(chalk.green(`✓ Gate ${gateId} approved`));
              gateHandled = true;
              break;
            case 'n':
            case 'no':
              console.log(chalk.yellow('Gate not approved. Staying in current state.'));
              console.log(chalk.gray('Type "quit" to exit or wait for changes.'));
              break;
            case 'status':
              displayStatus(currentState, protocol);
              break;
            case 'view':
            case 'cat':
            case 'show':
              // Show full artifact
              const artifactPath = getGateArtifact(gateId, currentState, projectRoot);
              if (artifactPath) {
                console.log(chalk.cyan(`\n─── ${artifactPath} ───\n`));
                try {
                  const content = fs.readFileSync(artifactPath, 'utf-8');
                  console.log(content);
                  console.log(chalk.cyan(`\n─── End of ${artifactPath} ───\n`));
                } catch (e) {
                  console.log(chalk.red(`Error reading file: ${e}`));
                }
              } else {
                console.log(chalk.yellow('No artifact file found for this gate.'));
              }
              break;
            case 'help':
            case '?':
              showReplHelp();
              break;
            case 'quit':
            case 'exit':
              console.log(chalk.blue('Exiting porch...'));
              rl.close();
              return;
            default:
              console.log(chalk.gray('Type "y" to approve, "n" to decline, or "help" for commands'));
          }
        }
        continue;
      }
      // If gate not yet requested, fall through to execute phase first
    }

    // Get the current phase definition
    const phase = protocol.phases.find(p => p.id === phaseId);

    // Show plan phase context if in a phased phase
    if (planPhaseId && currentState.plan_phases) {
      const planPhase = currentState.plan_phases.find(p => p.id === planPhaseId);
      if (planPhase) {
        console.log(chalk.cyan(`[phase] IDE Phase: ${phaseId} | Plan Phase: ${planPhase.title}`));
      } else {
        console.log(chalk.cyan(`[phase] Phase: ${phaseId}`));
      }
    } else {
      console.log(chalk.cyan(`[phase] Phase: ${phaseId}`));
    }

    // Notify phase start
    await notifier.phaseStart(phaseId);

    // Execute phase
    const output = await invokeClaude(protocol, phaseId, currentState, statusFilePath, projectRoot, options);
    const signal = extractSignal(output);

    // Run phase checks (build/test) if defined
    if (phase?.checks && !options.dryRun) {
      console.log(chalk.blue(`[porch] Running checks for phase ${phaseId}...`));
      const checkResult = await runPhaseChecks(phase, {
        cwd: projectRoot,
        dryRun: options.dryRun,
      });

      console.log(formatCheckResults(checkResult));

      if (!checkResult.success) {
        // Notify about check failure
        const failedCheck = checkResult.checks.find(c => !c.success);
        await notifier.checkFailed(phaseId, failedCheck?.name || 'build/test', failedCheck?.error || 'Check failed');

        // If checks fail, handle based on check configuration
        if (checkResult.returnTo) {
          console.log(chalk.yellow(`[porch] Checks failed, returning to ${checkResult.returnTo}`));
          if (planPhaseId) {
            currentState = updateState(currentState, `${checkResult.returnTo}:${planPhaseId}`);
          } else {
            currentState = updateState(currentState, checkResult.returnTo);
          }
          await writeState(statusFilePath, currentState);
          continue;
        }
        // No returnTo means we should retry (already handled in checks)
      }
    }

    // Run consultation if configured for this phase/substate
    if (phase?.consultation && hasConsultation(phase) && !options.dryRun && !options.noClaude) {
      const consultConfig = phase.consultation;
      const currentSubstate = substate || parsePlanPhaseFromState(currentState.current_state).substate;

      // Check if consultation is triggered by current substate
      if (consultConfig.on === currentSubstate || consultConfig.on === phaseId) {
        const maxRounds = consultConfig.max_rounds || 3;
        const stateKey = currentState.current_state;

        // Get attempt count from state (persisted across porch iterations)
        const attemptCount = getConsultationAttempts(currentState, stateKey) + 1;

        console.log(chalk.blue(`[porch] Consultation triggered for phase ${phaseId} (attempt ${attemptCount}/${maxRounds})`));
        await notifier.consultationStart(phaseId, consultConfig.models || ['gemini', 'codex', 'claude']);

        const consultResult = await runConsultationLoop(consultConfig, {
          subcommand: consultConfig.type.includes('pr') ? 'pr' : consultConfig.type.includes('spec') ? 'spec' : 'plan',
          identifier: projectId,
          cwd: projectRoot,
          timeout: protocol.config?.consultation_timeout,
          dryRun: options.dryRun,
        });

        console.log(formatConsultationResults(consultResult));
        await notifier.consultationComplete(phaseId, consultResult.feedback, consultResult.allApproved);

        // If not all approved, track attempt and check for escalation
        if (!consultResult.allApproved) {
          // Increment attempt count in state (persists across iterations)
          currentState = incrementConsultationAttempts(currentState, stateKey);
          await writeState(statusFilePath, currentState);

          // Check if we've reached max attempts
          if (attemptCount >= maxRounds) {
            // Create escalation gate - requires human intervention
            const escalationGateId = `${phaseId}_consultation_escalation`;

            // Check if escalation gate was already approved (human override)
            if (currentState.gates[escalationGateId]?.status === 'passed') {
              console.log(chalk.green(`[porch] Consultation escalation gate already approved, continuing`));
              // Reset attempts and fall through to next state handling
              currentState = resetConsultationAttempts(currentState, stateKey);
              await writeState(statusFilePath, currentState);
            } else {
              console.log(chalk.red(`[porch] Consultation failed after ${attemptCount} attempts - escalating to human`));
              console.log(chalk.yellow(`[porch] To override and continue: porch approve ${projectId} ${escalationGateId}`));

              // Request human gate if not already requested
              if (!currentState.gates[escalationGateId]?.requested_at) {
                currentState = requestGateApproval(currentState, escalationGateId);
                await writeState(statusFilePath, currentState);
                await notifier.gatePending(phaseId, escalationGateId);
              }

              // Prompt user to approve escalation gate
              console.log('');
              console.log(chalk.red('═'.repeat(50)));
              console.log(chalk.red(`  ESCALATION: ${escalationGateId}`));
              console.log(chalk.red('═'.repeat(50)));
              console.log(chalk.yellow(`  Consultation failed after ${attemptCount} attempts`));
              console.log('');

              let escalationHandled = false;
              while (!escalationHandled) {
                const answer = await prompt(rl, chalk.red(`Override and continue? [y/n/help]: `));

                switch (answer) {
                  case 'y':
                  case 'yes':
                  case 'approve':
                  case 'override':
                    currentState = approveGate(currentState, escalationGateId);
                    currentState = resetConsultationAttempts(currentState, stateKey);
                    await writeState(statusFilePath, currentState);
                    console.log(chalk.green(`✓ Escalation gate ${escalationGateId} approved`));
                    escalationHandled = true;
                    break;
                  case 'n':
                  case 'no':
                    console.log(chalk.yellow('Escalation not approved. Consultation loop will continue.'));
                    break;
                  case 'status':
                    displayStatus(currentState, protocol);
                    break;
                  case 'help':
                  case '?':
                    showReplHelp();
                    break;
                  case 'quit':
                  case 'exit':
                    console.log(chalk.blue('Exiting porch...'));
                    rl.close();
                    return;
                  default:
                    console.log(chalk.gray('Type "y" to override and continue, "n" to decline, or "help" for commands'));
                }
              }
              continue;
            }
          } else {
            console.log(chalk.yellow(`[porch] Consultation requested changes (attempt ${attemptCount}/${maxRounds}), continuing for revision`));
            // Stay in same state for Claude to revise on next iteration
            continue;
          }
        } else {
          // All approved - reset attempt counter
          currentState = resetConsultationAttempts(currentState, stateKey);
          await writeState(statusFilePath, currentState);
        }

        // All approved (or escalation gate passed) - use consultation's next state if defined
        if (consultConfig.next) {
          if (planPhaseId) {
            currentState = updateState(currentState, `${consultConfig.next}:${planPhaseId}`);
          } else {
            currentState = updateState(currentState, consultConfig.next);
          }
          await writeState(statusFilePath, currentState);
          continue;
        }
      }
    }

    // Check if current state has a gate that should trigger AFTER this step
    // This is the gate trigger point - step has executed, now block before transition
    const gateInfo = getGateForState(protocol, currentState.current_state);
    if (gateInfo) {
      const { gateId } = gateInfo;

      // Request gate approval if not already requested
      if (!currentState.gates[gateId]?.requested_at) {
        currentState = requestGateApproval(currentState, gateId);
        await writeState(statusFilePath, currentState);
        console.log(chalk.yellow(`[porch] Step complete. Gate approval requested: ${gateId}`));
        await notifier.gatePending(phaseId, gateId);
      }

      // Gate not yet approved - prompt user interactively
      if (currentState.gates[gateId]?.status !== 'passed') {
        console.log('');
        console.log(chalk.yellow('═'.repeat(50)));
        console.log(chalk.yellow(`  GATE PENDING: ${gateId}`));
        console.log(chalk.yellow('═'.repeat(50)));

        let gateHandled = false;
        while (!gateHandled) {
          const answer = await prompt(rl, chalk.yellow(`Approve ${gateId}? [y/n/help]: `));

          switch (answer) {
            case 'y':
            case 'yes':
            case 'approve':
              currentState = approveGate(currentState, gateId);
              await writeState(statusFilePath, currentState);
              console.log(chalk.green(`✓ Gate ${gateId} approved`));
              gateHandled = true;
              break;
            case 'n':
            case 'no':
              console.log(chalk.yellow('Gate not approved. Staying in current state.'));
              break;
            case 'status':
              displayStatus(currentState, protocol);
              break;
            case 'help':
            case '?':
              showReplHelp();
              break;
            case 'quit':
            case 'exit':
              console.log(chalk.blue('Exiting porch...'));
              rl.close();
              return;
            default:
              console.log(chalk.gray('Type "y" to approve, "n" to decline, or "help" for commands'));
          }
        }
        continue;
      }
    }

    // Determine next state
    let nextState: string | null = null;

    if (signal) {
      console.log(chalk.green(`[porch] Signal received: ${signal}`));
      nextState = getSignalNextState(protocol, phaseId, signal);
    }

    if (!nextState) {
      // Check if this is a phased phase (IDE loop)
      if (isPhasedPhase(protocol, phaseId) && currentState.plan_phases?.length) {
        nextState = getNextIDEState(protocol, currentState.current_state, currentState.plan_phases, signal || undefined);

        // Mark current plan phase as complete if moving to next
        if (nextState && planPhaseId) {
          const { planPhaseId: nextPlanPhaseId } = parsePlanPhaseFromState(nextState);
          if (nextPlanPhaseId !== planPhaseId) {
            currentState = updatePhaseStatus(currentState, planPhaseId, 'complete');
            if (nextPlanPhaseId) {
              currentState = updatePhaseStatus(currentState, nextPlanPhaseId, 'in_progress');
            }
          }
        }
      } else {
        // Use default transition
        nextState = getDefaultNextState(protocol, currentState.current_state);
      }
    }

    if (nextState) {
      currentState = updateState(currentState, nextState, signal ? { signal } : undefined);
      await writeState(statusFilePath, currentState);
    } else {
      console.log(chalk.yellow(`[porch] No transition defined, staying in current state`));
    }
  }

  rl.close();
  throw new Error(`Max iterations (${maxIterations}) reached!`);
}

/**
 * Approve a gate
 */
export async function approve(projectId: string, gateId: string): Promise<void> {
  const projectRoot = findProjectRoot();
  const statusFilePath = findStatusFile(projectRoot, projectId);

  if (!statusFilePath) {
    throw new Error(`Status file not found for project: ${projectId}`);
  }

  const state = readState(statusFilePath);
  if (!state) {
    throw new Error(`Could not read state from: ${statusFilePath}`);
  }

  const updatedState = approveGate(state, gateId);
  await writeState(statusFilePath, updatedState);

  console.log(chalk.green(`[porch] Approved: ${gateId}`));
}

/**
 * Show project status
 */
export async function status(projectId?: string): Promise<void> {
  const projectRoot = findProjectRoot();

  if (projectId) {
    // Show specific project
    const statusFilePath = findStatusFile(projectRoot, projectId);
    if (!statusFilePath) {
      throw new Error(`Status file not found for project: ${projectId}`);
    }

    const state = readState(statusFilePath);
    if (!state) {
      throw new Error(`Could not read state from: ${statusFilePath}`);
    }

    console.log(chalk.blue(`[porch] Status for project ${projectId}:`));
    console.log('');
    console.log(`  ID:        ${state.id}`);
    console.log(`  Title:     ${state.title}`);
    console.log(`  Protocol:  ${state.protocol}`);
    console.log(`  State:     ${state.current_state}`);
    console.log(`  Iteration: ${state.iteration}`);
    console.log(`  Started:   ${state.started_at}`);
    console.log(`  Updated:   ${state.last_updated}`);
    console.log('');

    if (Object.keys(state.gates).length > 0) {
      console.log('  Gates:');
      for (const [gateId, gateStatus] of Object.entries(state.gates)) {
        const icon = gateStatus.status === 'passed' ? '✓' : gateStatus.status === 'failed' ? '✗' : '⏳';
        console.log(`    ${icon} ${gateId}: ${gateStatus.status}`);
      }
      console.log('');
    }

    if (state.plan_phases && state.plan_phases.length > 0) {
      console.log('  Plan Phases:');
      for (const phase of state.plan_phases) {
        const phaseStatus = state.phases[phase.id]?.status || 'pending';
        const icon = phaseStatus === 'complete' ? '✓' : phaseStatus === 'in_progress' ? '🔄' : '○';
        console.log(`    ${icon} ${phase.id}: ${phase.title}`);
      }
    }
  } else {
    // Show all projects
    const projects = findProjects(projectRoot);
    const executions = findExecutions(projectRoot);

    if (projects.length === 0 && executions.length === 0) {
      console.log(chalk.yellow('[porch] No projects found'));
      return;
    }

    console.log(chalk.blue('[porch] Projects:'));
    for (const { id, path: statusPath } of projects) {
      const state = readState(statusPath);
      if (state) {
        const pendingGates = Object.entries(state.gates)
          .filter(([, g]) => g.status === 'pending' && g.requested_at)
          .map(([id]) => id);

        const gateStr = pendingGates.length > 0 ? chalk.yellow(` [${pendingGates.join(', ')}]`) : '';
        console.log(`  ${id} ${state.title} - ${state.current_state}${gateStr}`);
      }
    }

    if (executions.length > 0) {
      console.log('');
      console.log(chalk.blue('[porch] Executions:'));
      for (const { protocol, id, path: statusPath } of executions) {
        const state = readState(statusPath);
        if (state) {
          console.log(`  ${protocol}/${id} - ${state.current_state}`);
        }
      }
    }
  }
}

/**
 * List available protocols
 */
export async function list(): Promise<void> {
  const projectRoot = findProjectRoot();
  const protocols = listProtocols(projectRoot);

  if (protocols.length === 0) {
    console.log(chalk.yellow('[porch] No protocols found'));
    return;
  }

  console.log(chalk.blue('[porch] Available protocols:'));
  for (const name of protocols) {
    try {
      const protocol = loadProtocol(name, projectRoot);
      console.log(`  - ${name}: ${protocol.description}`);
    } catch {
      console.log(`  - ${name}: (error loading)`);
    }
  }
}

/**
 * Show protocol definition
 */
export async function show(protocolName: string): Promise<void> {
  const projectRoot = findProjectRoot();
  const protocol = loadProtocol(protocolName, projectRoot);

  console.log(chalk.blue(`[porch] Protocol: ${protocolName}`));
  console.log('');
  console.log(JSON.stringify(protocol, null, 2));
}

/**
 * Show pending gates across all projects
 */
export async function pending(): Promise<void> {
  const projectRoot = findProjectRoot();
  const gates = findPendingGates(projectRoot);

  if (gates.length === 0) {
    console.log(chalk.green('[porch] No pending gates'));
    return;
  }

  console.log(chalk.yellow('[porch] Pending gates:'));
  for (const gate of gates) {
    const requestedAt = gate.requestedAt ? ` (requested ${gate.requestedAt})` : '';
    console.log(`  ${gate.projectId}: ${gate.gateId}${requestedAt}`);
    console.log(`    → porch approve ${gate.projectId} ${gate.gateId}`);
  }
}

// ============================================================================
// Auto-Detection
// ============================================================================

/**
 * Auto-detect project ID from current directory
 *
 * Detection methods:
 * 1. Check if cwd is a worktree matching pattern: .builders/<id> or worktrees/<protocol>_<id>_*
 * 2. Check for a single project in codev/projects/
 * 3. Check for .porch-project marker file
 */
function autoDetectProject(): string | null {
  const cwd = process.cwd();

  // Method 1: Check path pattern for builder worktree
  // Pattern: .builders/<id> or .builders/<id>-<name>
  const buildersMatch = cwd.match(/[/\\]\.builders[/\\](\d+)(?:-[^/\\]*)?(?:[/\\]|$)/);
  if (buildersMatch) {
    return buildersMatch[1];
  }

  // Pattern: worktrees/<protocol>_<id>_<name>
  const worktreeMatch = cwd.match(/[/\\]worktrees[/\\]\w+_(\d+)_[^/\\]*(?:[/\\]|$)/);
  if (worktreeMatch) {
    return worktreeMatch[1];
  }

  // Method 2: Check for .porch-project marker file
  const markerPath = path.join(cwd, '.porch-project');
  if (fs.existsSync(markerPath)) {
    const content = fs.readFileSync(markerPath, 'utf-8').trim();
    if (content) {
      return content;
    }
  }

  // Method 3: Check if there's exactly one project in codev/projects/
  try {
    const projectRoot = findProjectRoot();
    const projects = findProjects(projectRoot);
    if (projects.length === 1) {
      return projects[0].id;
    }
  } catch {
    // Not in a codev project
  }

  return null;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Main porch entry point - handles subcommands
 */
export interface PorchOptions {
  subcommand: string;
  args: string[];
  dryRun?: boolean;
  noClaude?: boolean;
  pollInterval?: number;
  description?: string;
  worktree?: string;
}

export async function porch(options: PorchOptions): Promise<void> {
  const { subcommand, args, dryRun, noClaude, pollInterval, description, worktree } = options;

  switch (subcommand.toLowerCase()) {
    case 'run': {
      let projectId: string = args[0];

      // Auto-detect project if not provided
      if (!projectId) {
        const detected = autoDetectProject();
        if (!detected) {
          throw new Error(
            'Usage: porch run <project-id>\n' +
            'Or run from a project worktree to auto-detect.'
          );
        }
        projectId = detected;
        console.log(chalk.blue(`[porch] Auto-detected project: ${projectId}`));
      }

      await run(projectId, { dryRun, noClaude, pollInterval });
      break;
    }

    case 'init': {
      if (args.length < 3) {
        throw new Error('Usage: porch init <protocol> <project-id> <project-name>');
      }
      await init(args[0], args[1], args[2], { description, worktree });
      break;
    }

    case 'approve': {
      if (args.length < 2) {
        throw new Error('Usage: porch approve <project-id> <gate-id>');
      }
      await approve(args[0], args[1]);
      break;
    }

    case 'status': {
      await status(args[0]);
      break;
    }

    case 'pending': {
      await pending();
      break;
    }

    case 'list':
    case 'list-protocols': {
      await list();
      break;
    }

    case 'show':
    case 'show-protocol': {
      if (args.length < 1) {
        throw new Error('Usage: porch show <protocol>');
      }
      await show(args[0]);
      break;
    }

    default:
      throw new Error(
        `Unknown subcommand: ${subcommand}\n` +
        'Valid subcommands: run, init, approve, status, pending, list, show'
      );
  }
}
