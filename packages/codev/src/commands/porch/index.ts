/**
 * Porch - Protocol Orchestrator
 *
 * Claude calls porch as a tool; porch returns prescriptive instructions.
 * All commands produce clear, actionable output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { globSync } from 'glob';
import type { ProjectState, Protocol, PlanPhase } from './types.js';
import {
  readState,
  writeState,
  writeStateAndCommit,
  createInitialState,
  findStatusPath,
  getProjectDir,
  getStatusPath,
  detectProjectId,
  resolveProjectId,
  resolveArtifactBaseName,
} from './state.js';
import {
  loadProtocol,
  getPhaseConfig,
  getNextPhase,
  getPhaseChecks,
  getPhaseGate,
  isPhased,
  isBuildVerify,
  getVerifyConfig,
} from './protocol.js';
import {
  findPlanFile,
  extractPlanPhases,
  getCurrentPlanPhase,
  getPhaseContent,
  allPlanPhasesComplete,
  isPlanPhaseComplete,
} from './plan.js';
import { getResolver, type ArtifactResolver } from './artifacts.js';
import {
  runPhaseChecks,
  formatCheckResults,
  allChecksPassed,
  type CheckEnv,
} from './checks.js';
import { loadCheckOverrides } from './config.js';
import { loadConfig } from '../../lib/config.js';

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

/**
 * Log override/skip notices before running checks.
 * Only emits output when overrides are actually in use.
 * @param phaseCheckNames - original check names from the protocol phase
 * @param resolvedChecks - checks after applying overrides (skipped ones absent)
 * @param overrides - raw override map from .codev/config.json (null if not configured)
 */
function logCheckOverrides(
  phaseCheckNames: string[],
  resolvedChecks: Record<string, import('./types.js').CheckDef>,
  overrides: import('./types.js').CheckOverrides | null
): void {
  if (!overrides) return;

  for (const name of phaseCheckNames) {
    const override = overrides[name];
    if (!override) continue;

    if (override.skip) {
      console.log(chalk.yellow(`  ⚠ Check "${name}" skipped (.codev/config.json)`));
    } else if (override.command || override.cwd) {
      const parts: string[] = [];
      if (override.command) parts.push(resolvedChecks[name]?.command ?? override.command);
      if (override.cwd) parts.push(`cwd: ${override.cwd}`);
      console.log(chalk.yellow(`  ⚠ Check "${name}" overridden: ${parts.join(', ')}`));
    }
  }
}

// ============================================================================
// Commands
// ============================================================================

/**
 * porch status <id>
 * Shows current state and prescriptive next steps.
 */
export async function status(workspaceRoot: string, projectId: string, resolver?: ArtifactResolver): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.\nRun 'porch init' to create a new project.`);
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(workspaceRoot, state.protocol);
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

      // Show phase content from plan (via resolver if available)
      const planContent = resolver?.getPlanContent(state.id, state.title)
        ?? (() => { const p = findPlanFile(workspaceRoot, state.id, state.title); return p ? fs.readFileSync(p, 'utf-8') : null; })();
      if (planContent) {
        const phaseContent = getPhaseContent(planContent, currentPlanPhase.id);
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

  // Show checks status (apply overrides so display matches what will actually run)
  const statusOverrides = loadCheckOverrides(workspaceRoot);
  const checks = getPhaseChecks(protocol, state.phase, statusOverrides ?? undefined);
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
export async function check(workspaceRoot: string, projectId: string, resolver?: ArtifactResolver): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.`);
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(workspaceRoot, state.protocol);
  const overrides = loadCheckOverrides(workspaceRoot);
  const phaseConfig = getPhaseConfig(protocol, state.phase);
  const phaseCheckNames = phaseConfig?.checks ?? [];
  const checks = getPhaseChecks(protocol, state.phase, overrides ?? undefined);

  if (Object.keys(checks).length === 0 && phaseCheckNames.length === 0) {
    console.log(chalk.dim('No checks defined for this phase.'));
    return;
  }

  const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: resolveArtifactBaseName(workspaceRoot, state.id, state.title, resolver) };

  console.log('');
  console.log(chalk.bold('RUNNING CHECKS...'));
  logCheckOverrides(phaseCheckNames, checks, overrides);
  console.log('');

  if (Object.keys(checks).length === 0) {
    console.log(chalk.dim('  (all checks skipped via .codev/config.json)'));
    console.log('');
    console.log(chalk.green('RESULT: ALL CHECKS PASSED'));
    console.log(`\n  Run: porch done ${state.id} (to advance)`);
    console.log('');
    return;
  }

  const results = await runPhaseChecks(checks, workspaceRoot, checkEnv, undefined, resolver);
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
export async function done(workspaceRoot: string, projectId: string, resolver?: ArtifactResolver): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.`);
  }

  let state = readState(statusPath);
  const protocol = loadProtocol(workspaceRoot, state.protocol);
  const overrides = loadCheckOverrides(workspaceRoot);
  const phaseConfig = getPhaseConfig(protocol, state.phase);
  const phaseCheckNames = phaseConfig?.checks ?? [];
  const checks = getPhaseChecks(protocol, state.phase, overrides ?? undefined);

  // Run checks first — but skip if the gate was just approved (approve already ran them)
  if (phaseCheckNames.length > 0) {
    const gate = getPhaseGate(protocol, state.phase);
    const gateStatus = gate ? state.gates[gate] : undefined;
    const recentlyApproved = gateStatus?.status === 'approved' && gateStatus.approved_at &&
      (Date.now() - new Date(gateStatus.approved_at).getTime()) < 60_000;

    if (recentlyApproved) {
      console.log('');
      console.log(chalk.dim('Checks skipped (gate approved <60s ago).'));
    } else {
      const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: resolveArtifactBaseName(workspaceRoot, state.id, state.title, resolver) };

      console.log('');
      console.log(chalk.bold('RUNNING CHECKS...'));
      logCheckOverrides(phaseCheckNames, checks, overrides);

      if (Object.keys(checks).length > 0) {
        const results = await runPhaseChecks(checks, workspaceRoot, checkEnv, undefined, resolver);
        console.log(formatCheckResults(results));

        if (!allChecksPassed(results)) {
          console.log('');
          console.log(chalk.red('CHECKS FAILED. Cannot advance.'));
          console.log(`\n  Fix the failures and try again.`);
          process.exit(1);
        }
      } else {
        console.log(chalk.dim('  (all checks skipped via .codev/config.json)'));
      }
    }
  }

  // For build_verify phases: mark build as complete for verification
  if (isBuildVerify(protocol, state.phase) && !state.build_complete) {
    state.build_complete = true;
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${state.phase} build-complete`);
    console.log('');
    console.log(chalk.green('BUILD COMPLETE. Ready for verification.'));
    console.log(`\n  Run: porch next ${state.id} (to get verification tasks)`);
    return;
  }

  // Enforce verification for build_verify phases (config-aware)
  const verifyConfig = getVerifyConfig(protocol, state.phase);
  if (verifyConfig) {
    // Resolve effective models from config (overrides protocol defaults)
    let effectiveModels = verifyConfig.models;
    let consultMode: 'normal' | 'none' | 'parent' = 'normal';

    try {
      const config = loadConfig(workspaceRoot);
      const configModels = config.porch?.consultation?.models;
      if (configModels !== undefined) {
        if (configModels === 'none') {
          consultMode = 'none';
        } else if (configModels === 'parent') {
          consultMode = 'parent';
        } else if (Array.isArray(configModels)) {
          effectiveModels = configModels;
        } else if (typeof configModels === 'string') {
          effectiveModels = [configModels];
        }
      }
    } catch {
      // Config load failed — use protocol defaults
    }

    // "none" mode: skip verification
    if (consultMode === 'none') {
      console.log(chalk.dim('  (consultation skipped — configured: none)'));
    } else if (consultMode === 'parent') {
      // "parent" mode: verification is handled by architect gate, not review files
      console.log(chalk.dim('  (consultation delegated to architect — configured: parent)'));
    } else {
      // Normal mode: check for review files from effective models
      const projectDir = getProjectDir(workspaceRoot, state.id, state.title);
      const phase = state.current_plan_phase || state.phase;
      const missingModels: string[] = [];

      for (const model of effectiveModels) {
        // Look for any review file for this model+phase (any iteration)
        const pattern = path.join(projectDir, `${state.id}-${phase}-iter*-${model}.txt`);
        const matches = globSync(pattern);
        if (matches.length === 0) {
          missingModels.push(model);
        }
      }

      if (missingModels.length > 0) {
        console.log('');
        console.log(chalk.red('VERIFICATION REQUIRED'));
        console.log(`\n  ${effectiveModels.length}-way review not completed. Missing: ${missingModels.join(', ')}`);
        console.log(`\n  Run: porch next ${state.id} (to trigger verification)`);
        process.exit(1);
      }
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

  // For phased protocols: plan phase advancement requires 3-way review.
  // The isBuildVerify block above already marked build_complete=true.
  // Redirect to porch next for verification (3-way review + unanimous verdict).
  if (isPhased(protocol, state.phase) && state.plan_phases.length > 0) {
    const currentPlanPhase = getCurrentPlanPhase(state.plan_phases);
    if (currentPlanPhase && !allPlanPhasesComplete(state.plan_phases)) {
      console.log('');
      console.log(chalk.green('BUILD COMPLETE. Ready for 3-way review.'));
      console.log(`\n  Run: porch next ${state.id} (to trigger verification)`);
      return;
    }
  }

  // Advance to next protocol phase
  await advanceProtocolPhase(workspaceRoot, state, protocol, statusPath, resolver);
}

async function advanceProtocolPhase(workspaceRoot: string, state: ProjectState, protocol: Protocol, statusPath: string, resolver?: ArtifactResolver): Promise<void> {
  const nextPhase = getNextPhase(protocol, state.phase);

  if (!nextPhase) {
    state.phase = 'complete';
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} protocol complete`);
    console.log('');
    console.log(chalk.green.bold('🎉 PROTOCOL COMPLETE'));
    console.log(`\n  Project ${state.id} has completed the ${state.protocol} protocol.`);
    return;
  }

  state.phase = nextPhase.id;
  state.build_complete = false;
  state.iteration = 1;

  // If entering a phased phase (implement), extract plan phases
  if (isPhased(protocol, nextPhase.id)) {
    const planContent = resolver?.getPlanContent(state.id, state.title)
      ?? (() => { const p = findPlanFile(workspaceRoot, state.id, state.title); return p ? fs.readFileSync(p, 'utf-8') : null; })();
    if (planContent) {
      state.plan_phases = extractPlanPhases(planContent);
      // extractPlanPhases already marks first phase as in_progress
      if (state.plan_phases.length > 0) {
        state.current_plan_phase = state.plan_phases[0].id;
      }
    }
  }

  await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${nextPhase.id} phase-transition`);

  console.log('');
  console.log(chalk.green(`ADVANCING TO: ${nextPhase.id} - ${nextPhase.name}`));

  // If we just entered implement phase, show phase 1 info and the critical warning
  if (isPhased(protocol, nextPhase.id) && state.plan_phases.length > 0) {
    const firstPhase = state.plan_phases[0];
    const nextPlanPhase = state.plan_phases[1];

    console.log('');
    console.log(chalk.bold(`YOUR TASK: ${firstPhase.id} - "${firstPhase.title}"`));

    // Show phase content from plan (via resolver if available)
    const planContentForDisplay = resolver?.getPlanContent(state.id, state.title)
      ?? (() => { const p = findPlanFile(workspaceRoot, state.id, state.title); return p ? fs.readFileSync(p, 'utf-8') : null; })();
    if (planContentForDisplay) {
      const phaseContent = getPhaseContent(planContentForDisplay, firstPhase.id);
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
export async function gate(workspaceRoot: string, projectId: string, resolver?: ArtifactResolver): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.`);
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(workspaceRoot, state.protocol);
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
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${gateName} gate-requested`);
  }

  console.log('');
  console.log(chalk.bold(`GATE: ${gateName}`));
  console.log('');

  // Show relevant artifact and open it for review
  const artifact = getArtifactForPhase(workspaceRoot, state, resolver);
  if (artifact) {
    const fullPath = path.join(workspaceRoot, artifact);
    if (fs.existsSync(fullPath)) {
      console.log(`  Artifact: ${artifact}`);
      console.log('');
      console.log(chalk.cyan('  Opening artifact for human review...'));
      // Use afx open to display in annotation viewer
      const { spawn } = await import('node:child_process');
      spawn('afx', ['open', fullPath], {
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
  workspaceRoot: string,
  projectId: string,
  gateName: string,
  hasHumanFlag: boolean,
  resolver?: ArtifactResolver
): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
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
  const protocol = loadProtocol(workspaceRoot, state.protocol);
  const overrides = loadCheckOverrides(workspaceRoot);
  const phaseConfig = getPhaseConfig(protocol, state.phase);
  const phaseCheckNames = phaseConfig?.checks ?? [];
  const checks = getPhaseChecks(protocol, state.phase, overrides ?? undefined);

  if (phaseCheckNames.length > 0) {
    const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: resolveArtifactBaseName(workspaceRoot, state.id, state.title, resolver) };

    console.log('');
    console.log(chalk.bold('RUNNING CHECKS...'));
    logCheckOverrides(phaseCheckNames, checks, overrides);

    if (Object.keys(checks).length > 0) {
      const results = await runPhaseChecks(checks, workspaceRoot, checkEnv, undefined, resolver);
      console.log(formatCheckResults(results));

      if (!allChecksPassed(results)) {
        console.log('');
        console.log(chalk.red('CHECKS FAILED. Cannot approve gate.'));
        console.log(`\n  Fix the failures and try again.`);
        process.exit(1);
      }
    } else {
      console.log(chalk.dim('  (all checks skipped via .codev/config.json)'));
    }
  }

  state.gates[gateName].status = 'approved';
  state.gates[gateName].approved_at = new Date().toISOString();
  await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${gateName} gate-approved`);

  console.log('');
  console.log(chalk.green(`Gate ${gateName} approved.`));
  console.log(`\n  Run: porch done ${state.id} (to advance)`);
  console.log('');
}

/**
 * porch rollback <id> <phase>
 * Rewinds project to an earlier phase, clearing downstream gates and resetting build state.
 */
export async function rollback(
  workspaceRoot: string,
  projectId: string,
  targetPhase: string,
  resolver?: ArtifactResolver
): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.`);
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(workspaceRoot, state.protocol);

  // Validate target phase exists in protocol
  const targetConfig = getPhaseConfig(protocol, targetPhase);
  if (!targetConfig) {
    const validPhases = protocol.phases.map(p => p.id).join(', ');
    throw new Error(`Unknown phase: ${targetPhase}\nValid phases: ${validPhases}`);
  }

  // Find indices to validate rollback direction
  const currentIndex = protocol.phases.findIndex(p => p.id === state.phase);
  const targetIndex = protocol.phases.findIndex(p => p.id === targetPhase);

  // Handle completed projects (phase not in protocol phases array)
  if (state.phase === 'complete') {
    // Allow rollback from complete state to any valid phase
  } else if (currentIndex === -1) {
    throw new Error(`Current phase '${state.phase}' not found in protocol.`);
  } else if (targetIndex >= currentIndex) {
    throw new Error(
      `Cannot rollback forward. Current phase: ${state.phase}, target: ${targetPhase}\n` +
      `Use 'porch done' to advance phases.`
    );
  }

  // Clear gates at or after the target phase
  for (let i = targetIndex; i < protocol.phases.length; i++) {
    const phase = protocol.phases[i];
    if (phase.gate && state.gates[phase.gate]) {
      state.gates[phase.gate] = { status: 'pending' };
    }
  }

  // Reset state to target phase
  const previousPhase = state.phase;
  state.phase = targetPhase;
  state.iteration = 1;
  state.build_complete = false;
  state.history = [];

  // If rolling back to a phased phase, re-extract plan phases
  if (isPhased(protocol, targetPhase)) {
    const planContent = resolver?.getPlanContent(state.id, state.title)
      ?? (() => { const p = findPlanFile(workspaceRoot, state.id, state.title); return p ? fs.readFileSync(p, 'utf-8') : null; })();
    if (planContent) {
      state.plan_phases = extractPlanPhases(planContent);
      if (state.plan_phases.length > 0) {
        state.current_plan_phase = state.plan_phases[0].id;
      } else {
        state.current_plan_phase = null;
      }
    } else {
      state.plan_phases = [];
      state.current_plan_phase = null;
    }
  } else {
    state.plan_phases = [];
    state.current_plan_phase = null;
  }

  await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} rollback ${previousPhase} → ${targetPhase}`);

  console.log('');
  console.log(chalk.green(`ROLLED BACK: ${previousPhase} → ${targetPhase}`));
  console.log(`  Project: ${state.id}`);
  console.log(`  Protocol: ${state.protocol}`);
  console.log(`\n  Run: porch status ${state.id}`);
  console.log('');
}

/**
 * porch init <protocol> <id> <name>
 * Initialize a new project.
 *
 * Idempotent: if status.yaml already exists, preserves it and reports
 * current state. This supports `afx spawn --resume` where the builder
 * may re-run `porch init` after a session restart.
 */
export async function init(
  workspaceRoot: string,
  protocolName: string,
  projectId: string,
  projectName: string
): Promise<void> {
  const protocol = loadProtocol(workspaceRoot, protocolName);
  const statusPath = getStatusPath(workspaceRoot, projectId, projectName);

  // If status.yaml already exists, preserve it (idempotent for resume)
  if (fs.existsSync(statusPath)) {
    const existingState = readState(statusPath);
    console.log('');
    console.log(chalk.yellow(`Project ${projectId}-${projectName} already exists. Preserving existing state.`));
    console.log(`  Protocol: ${existingState.protocol}`);
    console.log(`  Current phase: ${existingState.phase}`);
    if (existingState.current_plan_phase) {
      console.log(`  Plan phase: ${existingState.current_plan_phase}`);
    }
    console.log(`\n  Run: porch next ${projectId}`);
    console.log('');
    return;
  }

  // Also check if a project with this ID exists under a different name
  const existingPath = findStatusPath(workspaceRoot, projectId);
  if (existingPath) {
    const existingState = readState(existingPath);
    console.log('');
    console.log(chalk.yellow(`Project ${projectId} already exists (as ${existingState.id}-${existingState.title}). Preserving existing state.`));
    console.log(`  Protocol: ${existingState.protocol}`);
    console.log(`  Current phase: ${existingState.phase}`);
    if (existingState.current_plan_phase) {
      console.log(`  Plan phase: ${existingState.current_plan_phase}`);
    }
    console.log(`\n  Run: porch next ${projectId}`);
    console.log('');
    return;
  }

  const state = createInitialState(protocol, projectId, projectName, workspaceRoot);
  await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} init ${protocolName}`);

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

function getArtifactForPhase(workspaceRoot: string, state: ProjectState, resolver?: ArtifactResolver): string | null {
  const baseName = resolveArtifactBaseName(workspaceRoot, state.id, state.title, resolver);
  switch (state.phase) {
    case 'specify':
      return `codev/specs/${baseName}.md`;
    case 'plan':
      return `codev/plans/${baseName}.md`;
    case 'review':
      return `codev/reviews/${baseName}.md`;
    default:
      return null;
  }
}

// ============================================================================
// CLI
// ============================================================================

export async function cli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const workspaceRoot = process.cwd();
  const resolver = getResolver(workspaceRoot);

  // Auto-detect project ID for commands that need it
  function getProjectId(provided?: string): string {
    const { id, source } = resolveProjectId(provided, process.cwd(), workspaceRoot);
    if (source === 'cwd') {
      console.log(chalk.dim(`[auto-detected project from worktree: ${id}]`));
    } else if (source === 'filesystem') {
      console.log(chalk.dim(`[auto-detected project: ${id}]`));
    }
    return id;
  }

  try {
    switch (command) {
      case 'next': {
        const { next: porchNext } = await import('./next.js');
        const result = await porchNext(workspaceRoot, getProjectId(rest[0]));
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'run':
        console.error("Error: 'porch run' has been removed. Use 'porch next <id>' instead.");
        console.error("See: porch --help");
        process.exit(1);
        break;

      case 'status':
        await status(workspaceRoot, getProjectId(rest[0]), resolver);
        break;

      case 'check':
        await check(workspaceRoot, getProjectId(rest[0]), resolver);
        break;

      case 'done':
        await done(workspaceRoot, getProjectId(rest[0]), resolver);
        break;

      case 'gate':
        await gate(workspaceRoot, getProjectId(rest[0]), resolver);
        break;

      case 'approve':
        if (!rest[0] || !rest[1]) throw new Error('Usage: porch approve <id> <gate> --a-human-explicitly-approved-this');
        const hasHumanFlag = rest.includes('--a-human-explicitly-approved-this');
        await approve(workspaceRoot, rest[0], rest[1], hasHumanFlag, resolver);
        break;

      case 'rollback':
        if (!rest[0] || !rest[1]) throw new Error('Usage: porch rollback <id> <phase>');
        await rollback(workspaceRoot, rest[0], rest[1], resolver);
        break;

      case 'init':
        if (!rest[0] || !rest[1] || !rest[2]) {
          throw new Error('Usage: porch init <protocol> <id> <name>');
        }
        await init(workspaceRoot, rest[0], rest[1], rest[2]);
        break;

      default:
        console.log('porch - Protocol Orchestrator');
        console.log('');
        console.log('Commands:');
        console.log('  next [id]                Emit next tasks as JSON (planner mode)');
        console.log('  status [id]              Show current state and instructions');
        console.log('  check [id]               Run checks for current phase');
        console.log('  done [id]                Signal build complete (validates checks, advances)');
        console.log('  gate [id]                Request human approval');
        console.log('  approve <id> <gate> --a-human-explicitly-approved-this');
        console.log('  rollback <id> <phase>    Rewind project to an earlier phase');
        console.log('  init <protocol> <id> <name>  Initialize a new project');
        console.log('');
        console.log('Project ID is auto-detected from worktree path or when exactly one project exists.');
        console.log('');
        process.exit(command && command !== '--help' && command !== '-h' ? 1 : 0);
    }
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
