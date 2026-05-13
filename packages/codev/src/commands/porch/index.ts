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
  writeStateAndCommit,
  createInitialState,
  findStatusPath,
  getArtifactRoot,
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
import { getResolver, LocalResolver, type ArtifactResolver } from './artifacts.js';
import {
  runPhaseChecks,
  formatCheckResults,
  allChecksPassed,
  type CheckEnv,
} from './checks.js';
import { loadCheckOverrides } from './config.js';
import { notifyTerminal, gateApprovedMessage } from './notify.js';
import { loadConfig } from '../../lib/config.js';
import { version } from '../../version.js';

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
 * Return a resolver scoped to `artifactRoot` when it differs from the caller's
 * cwd-rooted resolver. The incoming `resolver` is typically built from
 * `process.cwd()` (the main workspace), but `findStatusPath` may resolve a
 * project to a builder worktree under `.builders/`. Checks like `plan_exists`
 * must read from that worktree, not from the main tree (bugfix #676).
 *
 * For the LOCAL backend we rebuild the resolver against `artifactRoot` so file
 * lookups point at `<artifactRoot>/codev/...`. For other backends (e.g. CLI)
 * artifact location is already independent of the filesystem, so we keep the
 * caller's resolver.
 */
function scopeResolver(
  workspaceRoot: string,
  artifactRoot: string,
  resolver?: ArtifactResolver,
): ArtifactResolver | undefined {
  if (artifactRoot === workspaceRoot) return resolver;
  // Only rebuild if the existing resolver is a LocalResolver (path-dependent).
  if (resolver && !(resolver instanceof LocalResolver)) return resolver;
  return getResolver(workspaceRoot, artifactRoot);
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
 * porch status <id> [--json]
 * Shows current state and prescriptive next steps.
 *
 * `--json`: emits a single-line JSON object with the project's current state
 * and gate status, suppressing all human-readable output. Consumed by the
 * VSCode Needs Attention view (Issue 691) and any other tooling that needs
 * structured access to gate state.
 *
 * JSON shape:
 *   {
 *     "id": string,
 *     "title": string,
 *     "protocol": string,
 *     "phase": string,
 *     "iteration": number,
 *     "build_complete": boolean,
 *     "gate": string | null,
 *     "gate_status": "pending" | "approved" | null,
 *     "gate_requested_at": string | null,   // ISO timestamp
 *     "gate_approved_at": string | null     // ISO timestamp
 *   }
 */
export async function status(
  workspaceRoot: string,
  projectId: string,
  resolver?: ArtifactResolver,
  options?: { json?: boolean },
): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    if (options?.json) {
      console.error(`Project ${projectId} not found.`);
      process.exit(1);
    }
    throw new Error(`Project ${projectId} not found.\nRun 'porch init' to create a new project.`);
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(workspaceRoot, state.protocol);
  const phaseConfig = getPhaseConfig(protocol, state.phase);

  if (options?.json) {
    const gateName = getPhaseGate(protocol, state.phase);
    const gateStatus = gateName ? state.gates[gateName] : undefined;
    const out = {
      id: state.id,
      title: state.title,
      protocol: state.protocol,
      phase: state.phase,
      iteration: state.iteration,
      build_complete: state.build_complete,
      gate: gateName ?? null,
      gate_status: gateStatus?.status ?? null,
      gate_requested_at: gateStatus?.requested_at ?? null,
      gate_approved_at: gateStatus?.approved_at ?? null,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

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
        case 'verified': return chalk.green('✓');
        case 'complete': return chalk.green('✓'); // backward compat
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

  // Scope artifact reads + check cwd to the worktree that owns this status.yaml.
  // `findStatusPath` searches `.builders/*` first; resolver/cwd must match so
  // checks like `plan_exists` see files in the same worktree (bugfix #676).
  const artifactRoot = getArtifactRoot(statusPath);
  const scopedResolver = scopeResolver(workspaceRoot, artifactRoot, resolver);

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

  const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: resolveArtifactBaseName(artifactRoot, state.id, state.title, scopedResolver) };

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

  const results = await runPhaseChecks(checks, artifactRoot, checkEnv, undefined, scopedResolver);
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
export async function done(workspaceRoot: string, projectId: string, resolver?: ArtifactResolver, options?: { pr?: number; branch?: string; merged?: number }): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(`Project ${projectId} not found.`);
  }

  let state = readState(statusPath);

  // Record-only mode: --pr or --merged writes PR metadata and exits immediately.
  // Does NOT run checks, does NOT advance the phase, does NOT mark build_complete.
  if (options?.pr !== undefined) {
    if (!options.branch) throw new Error('--pr requires --branch <name>');
    if (!state.pr_history) state.pr_history = [];
    state.pr_history.push({
      phase: state.phase,
      pr_number: options.pr,
      branch: options.branch,
      created_at: new Date().toISOString(),
    });
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} record PR #${options.pr}`);
    console.log(chalk.green(`Recorded PR #${options.pr} (branch: ${options.branch}) in pr_history.`));
    return;
  }
  if (options?.merged !== undefined) {
    if (!state.pr_history) throw new Error(`No PR history found for project ${projectId}`);
    const entry = state.pr_history.find(e => e.pr_number === options.merged);
    if (!entry) throw new Error(`PR #${options.merged} not found in pr_history`);
    entry.merged = true;
    entry.merged_at = new Date().toISOString();
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} PR #${options.merged} merged`);
    console.log(chalk.green(`Marked PR #${options.merged} as merged.`));
    return;
  }
  const protocol = loadProtocol(workspaceRoot, state.protocol);
  const overrides = loadCheckOverrides(workspaceRoot);
  const phaseConfig = getPhaseConfig(protocol, state.phase);
  const phaseCheckNames = phaseConfig?.checks ?? [];
  const checks = getPhaseChecks(protocol, state.phase, overrides ?? undefined);

  // Scope artifact reads + check cwd to the worktree that owns this status.yaml
  // (bugfix #676 — see check() for rationale).
  const artifactRoot = getArtifactRoot(statusPath);
  const scopedResolver = scopeResolver(workspaceRoot, artifactRoot, resolver);

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
      const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: resolveArtifactBaseName(artifactRoot, state.id, state.title, scopedResolver) };

      console.log('');
      console.log(chalk.bold('RUNNING CHECKS...'));
      logCheckOverrides(phaseCheckNames, checks, overrides);

      if (Object.keys(checks).length > 0) {
        const results = await runPhaseChecks(checks, artifactRoot, checkEnv, undefined, scopedResolver);
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

  // Check for gate — auto-request if not yet requested
  const gate = getPhaseGate(protocol, state.phase);
  if (gate && state.gates[gate]?.status !== 'approved') {
    // Auto-request the gate if it hasn't been requested yet
    if (!state.gates[gate]) {
      state.gates[gate] = { status: 'pending' };
    }
    if (!state.gates[gate].requested_at) {
      state.gates[gate].requested_at = new Date().toISOString();
      await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${gate} gate-requested`);
    }
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
  await advanceProtocolPhase(workspaceRoot, state, protocol, statusPath, scopedResolver);
}

async function advanceProtocolPhase(workspaceRoot: string, state: ProjectState, protocol: Protocol, statusPath: string, resolver?: ArtifactResolver): Promise<void> {
  const nextPhase = getNextPhase(protocol, state.phase);

  if (!nextPhase) {
    state.phase = 'verified';
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

  // Scope artifact reads + check cwd to the worktree that owns this status.yaml
  // (bugfix #676 — see check() for rationale).
  const artifactRoot = getArtifactRoot(statusPath);
  const scopedResolver = scopeResolver(workspaceRoot, artifactRoot, resolver);

  const state = readState(statusPath);

  // Convenience: for verify-approval, auto-complete porch done if build_complete is false
  if (gateName === 'verify-approval' && state.phase === 'verify' && !state.build_complete) {
    state.build_complete = true;
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} verify build-complete (auto)`);
  }

  // Auto-create gate entry for upgraded projects (e.g., verify-approval missing after upgrade)
  if (!state.gates[gateName]) {
    const protocol = loadProtocol(workspaceRoot, state.protocol);
    const phaseGate = getPhaseGate(protocol, state.phase);
    if (phaseGate === gateName) {
      // Gate belongs to the current phase — initialize it
      state.gates[gateName] = { status: 'pending', requested_at: new Date().toISOString() };
      await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${gateName} gate-created (upgrade)`);
    } else {
      const knownGates = Object.keys(state.gates).join(', ');
      throw new Error(`Unknown gate: ${gateName}\nKnown gates: ${knownGates || 'none'}`);
    }
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
    const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: resolveArtifactBaseName(artifactRoot, state.id, state.title, scopedResolver) };

    console.log('');
    console.log(chalk.bold('RUNNING CHECKS...'));
    logCheckOverrides(phaseCheckNames, checks, overrides);

    if (Object.keys(checks).length > 0) {
      const results = await runPhaseChecks(checks, artifactRoot, checkEnv, undefined, scopedResolver);
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

  // Wake the builder iff porch was invoked from OUTSIDE the builder's
  // worktree. The wake-up wakes an *idle* builder; when the builder is
  // the one running `porch approve` (the user typed feedback into the
  // builder's pane and the builder ran the command itself), it's already
  // active and the message would be echoed back as the builder's next
  // input — Claude then "responds" to its own approval message.
  //
  // workspaceRoot is process.cwd() at CLI invocation. When called from
  // inside the worktree it resolves to the same path as artifactRoot.
  const calledFromBuilderWorktree = path.resolve(workspaceRoot) === path.resolve(artifactRoot);
  if (!calledFromBuilderWorktree) {
    notifyTerminal({
      target: state.id,
      message: gateApprovedMessage(gateName),
      worktreeDir: workspaceRoot,
    });
  }

  console.log('');
  console.log(chalk.green(`Gate ${gateName} approved.`));

  // For verify-approval: auto-advance to terminal state (convenience — one command)
  // NOTE: The 'verified' state is committed to the builder branch, which may not
  // be merged back to main. The closed GitHub Issue serves as the canonical "done"
  // signal on main. State alignment (making status.yaml on main authoritative) is
  // tracked as future work per spec 653.
  if (gateName === 'verify-approval') {
    await advanceProtocolPhase(workspaceRoot, state, protocol, statusPath, resolver);
  } else {
    console.log(`\n  Run: porch done ${state.id} (to advance)`);
  }
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
  if (state.phase === 'verified' || state.phase === 'complete') {
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

/**
 * porch pending
 * List all projects with gates awaiting human approval.
 * Scans both the local workspace and any builder worktrees under .builders/*.
 */
export async function pending(workspaceRoot: string): Promise<void> {
  type PendingGate = {
    id: string;
    title: string;
    phase: string;
    gate: string;
    requested_at?: string;
    statusPath: string;
  };

  const seen = new Set<string>(); // dedupe by status.yaml path
  const results: PendingGate[] = [];

  // Build the list of project directories to scan: main + every builder worktree.
  const projectsDirs: string[] = [path.join(workspaceRoot, 'codev', 'projects')];
  const buildersDir = path.join(workspaceRoot, '.builders');
  if (fs.existsSync(buildersDir)) {
    for (const wt of fs.readdirSync(buildersDir, { withFileTypes: true })) {
      if (!wt.isDirectory()) continue;
      projectsDirs.push(path.join(buildersDir, wt.name, 'codev', 'projects'));
    }
  }

  for (const projectsDir of projectsDirs) {
    if (!fs.existsSync(projectsDir)) continue;
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statusPath = path.join(projectsDir, entry.name, 'status.yaml');
      if (!fs.existsSync(statusPath)) continue;

      const realPath = fs.realpathSync(statusPath);
      if (seen.has(realPath)) continue;
      seen.add(realPath);

      let state: ProjectState;
      try {
        state = readState(statusPath);
      } catch {
        continue; // skip corrupted status files
      }

      for (const [gateName, gateStatus] of Object.entries(state.gates)) {
        if (gateStatus?.status === 'pending' && gateStatus.requested_at) {
          results.push({
            id: state.id,
            title: state.title,
            phase: state.phase,
            gate: gateName,
            requested_at: gateStatus.requested_at,
            statusPath,
          });
        }
      }
    }
  }

  console.log('');
  if (results.length === 0) {
    console.log(chalk.dim('No gates pending approval.'));
    console.log('');
    return;
  }

  // Sort oldest-first so the longest-waiting gates surface at the top.
  results.sort((a, b) => (a.requested_at ?? '').localeCompare(b.requested_at ?? ''));

  console.log(chalk.bold(`${results.length} gate${results.length === 1 ? '' : 's'} pending approval:`));
  console.log('');
  for (const r of results) {
    console.log(`  ${chalk.cyan(r.id)} ${chalk.dim('—')} ${r.title}`);
    console.log(`    phase: ${r.phase}  gate: ${chalk.yellow(r.gate)}  requested: ${r.requested_at}`);
    console.log(chalk.dim(`    approve: porch approve ${r.id} ${r.gate} --a-human-explicitly-approved-this`));
    console.log('');
  }
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

  // Handle --version / -v before any project resolution — version output
  // must work from any directory and never require a project context.
  if (command === '--version' || command === '-v') {
    console.log(version);
    return;
  }

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

  // Commands that mutate state. After dispatching, we fire a Tower
  // overview-refresh so subscribed clients (VSCode sidebar, dashboard)
  // pick up the change immediately instead of waiting for an unrelated
  // SSE event to incidentally cause a re-fetch.
  const MUTATING_COMMANDS = new Set(['next', 'done', 'gate', 'approve', 'rollback', 'verify', 'init']);

  try {
    switch (command) {
      case 'pending':
        await pending(workspaceRoot);
        break;

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

      case 'status': {
        const json = rest.includes('--json');
        const positional = rest.find(a => !a.startsWith('--'));
        await status(workspaceRoot, getProjectId(positional), resolver, { json });
        break;
      }

      case 'check':
        await check(workspaceRoot, getProjectId(rest[0]), resolver);
        break;

      case 'done': {
        const doneOpts: { pr?: number; branch?: string; merged?: number } = {};
        const prIdx = rest.indexOf('--pr');
        const brIdx = rest.indexOf('--branch');
        const mergedIdx = rest.indexOf('--merged');
        if (prIdx !== -1) {
          const val = parseInt(rest[prIdx + 1], 10);
          if (!Number.isInteger(val) || val <= 0) throw new Error('--pr requires a positive integer PR number');
          doneOpts.pr = val;
        }
        if (brIdx !== -1) {
          if (!rest[brIdx + 1] || rest[brIdx + 1].startsWith('--')) throw new Error('--branch requires a branch name');
          doneOpts.branch = rest[brIdx + 1];
        }
        if (mergedIdx !== -1) {
          const val = parseInt(rest[mergedIdx + 1], 10);
          if (!Number.isInteger(val) || val <= 0) throw new Error('--merged requires a positive integer PR number');
          doneOpts.merged = val;
        }
        if (doneOpts.pr !== undefined && doneOpts.merged !== undefined) {
          throw new Error('--pr and --merged are mutually exclusive');
        }
        const hasRecordFlags = doneOpts.pr !== undefined || doneOpts.merged !== undefined;
        // For project ID: use first positional arg, or fall back to auto-detection
        const projectIdArg = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
        await done(workspaceRoot, getProjectId(projectIdArg), resolver, hasRecordFlags ? doneOpts : undefined);
        break;
      }

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

      case 'verify': {
        const verifyProjectId = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
        const skipIdx = rest.indexOf('--skip');
        if (skipIdx === -1) throw new Error('Usage: porch verify <id> --skip "reason"');
        const skipReason = rest[skipIdx + 1];
        if (!skipReason || skipReason.startsWith('--')) throw new Error('--skip requires a reason');
        const pid = getProjectId(verifyProjectId);
        const sp = findStatusPath(workspaceRoot, pid);
        if (!sp) throw new Error(`Project ${pid} not found.`);
        const st = readState(sp);
        if (st.phase !== 'verify') {
          throw new Error(`porch verify --skip can only be used in the verify phase (current: ${st.phase}). The PR must be merged first.`);
        }
        st.phase = 'verified';
        st.context = { ...st.context, verify_skip_reason: skipReason };
        await writeStateAndCommit(sp, st, `chore(porch): ${st.id} verify skipped: ${skipReason}`);
        console.log('');
        console.log(chalk.green(`VERIFIED (skipped): ${st.id}`));
        console.log(`  Reason: ${skipReason}`);
        break;
      }

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
        console.log('  done [id] --pr N --branch NAME   Record PR creation (no phase advancement)');
        console.log('  done [id] --merged N             Mark PR as merged (no phase advancement)');
        console.log('  gate [id]                Request human approval');
        console.log('  pending                  List all gates awaiting approval across projects');
        console.log('  approve <id> <gate> --a-human-explicitly-approved-this');
        console.log('  verify <id> --skip "reason"      Skip verification and mark as verified');
        console.log('  rollback <id> <phase>    Rewind project to an earlier phase');
        console.log('  init <protocol> <id> <name>  Initialize a new project');
        console.log('');
        console.log('Flags:');
        console.log('  --version, -v            Print porch (codev) version');
        console.log('');
        console.log('Project ID is auto-detected from worktree path or when exactly one project exists.');
        console.log('');
        process.exit(command && command !== '--help' && command !== '-h' ? 1 : 0);
    }

    // After a successful mutating command, broadcast `overview-changed`
    // via Tower so VSCode / dashboard refresh without a manual reload.
    // Best-effort — silently no-ops if Tower isn't running.
    if (command && MUTATING_COMMANDS.has(command)) {
      try {
        const { TowerClient } = await import('../../agent-farm/lib/tower-client.js');
        await new TowerClient().refreshOverview();
      } catch {
        // Tower not running / unreachable — non-fatal.
      }
    }
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
