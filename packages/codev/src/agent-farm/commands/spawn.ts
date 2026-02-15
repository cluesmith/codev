/**
 * Spawn command — orchestrator module.
 * Spec 0105: Tower Server Decomposition — Phase 7
 *
 * Modes:
 * - spec:     --project/-p  Spawn for a spec file (existing behavior)
 * - task:     --task        Spawn with an ad-hoc task description
 * - protocol: --protocol    Spawn to run a protocol (cleanup, experiment, etc.)
 * - shell:    --shell       Bare Claude session (no prompt, no worktree)
 *
 * Role/prompt logic extracted to spawn-roles.ts.
 * Worktree/git logic extracted to spawn-worktree.ts.
 */

import { resolve, basename } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import type { SpawnOptions, Builder, BuilderType, Config } from '../types.js';
import { getConfig, ensureDirectories, getResolvedCommands } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run } from '../utils/shell.js';
import { upsertBuilder } from '../state.js';
import { loadRolePrompt } from '../utils/roles.js';
import {
  type TemplateContext,
  buildPromptFromTemplate,
  buildResumeNotice,
  loadProtocolRole,
  findSpecFile,
  validateProtocol,
  loadProtocol,
  resolveProtocol,
  resolveMode,
} from './spawn-roles.js';
import {
  DEFAULT_TOWER_PORT,
  checkDependencies,
  createWorktree,
  initPorchInWorktree,
  checkBugfixCollisions,
  fetchGitHubIssue,
  executePreSpawnHooks,
  slugify,
  validateResumeWorktree,
  createPtySession,
  startBuilderSession,
  startShellSession,
  buildWorktreeLaunchScript,
} from './spawn-worktree.js';

// =============================================================================
// ID and Session Management
// =============================================================================

/**
 * Generate a short 4-character base64-encoded ID
 * Uses URL-safe base64 (a-z, A-Z, 0-9, -, _) for filesystem-safe IDs
 */
function generateShortId(): string {
  // Generate random 24-bit number and base64 encode to 4 chars
  const num = Math.floor(Math.random() * 0xFFFFFF);
  const bytes = new Uint8Array([num >> 16, (num >> 8) & 0xFF, num & 0xFF]);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 4);
}

/**
 * Validate spawn options - ensure exactly one input mode is selected
 * Note: --protocol serves dual purpose:
 *   1. As an input mode when used alone (e.g., `af spawn --protocol experiment`)
 *   2. As a protocol override when combined with other input modes (e.g., `af spawn -p 0001 --protocol tick`)
 */
function validateSpawnOptions(options: SpawnOptions): void {
  // Count input modes (excluding --protocol which can be used as override)
  const inputModes = [
    options.project,
    options.task,
    options.shell,
    options.worktree,
    options.issue,
  ].filter(Boolean);

  // --protocol alone is a valid input mode
  const protocolAlone = options.protocol && inputModes.length === 0;

  if (inputModes.length === 0 && !protocolAlone) {
    fatal('Must specify one of: --project (-p), --issue (-i), --task, --protocol, --shell, --worktree\n\nRun "af spawn --help" for examples.');
  }

  if (inputModes.length > 1) {
    fatal('Flags --project, --issue, --task, --shell, --worktree are mutually exclusive');
  }

  if (options.files && !options.task) {
    fatal('--files requires --task');
  }

  if ((options.noComment || options.force) && !options.issue) {
    fatal('--no-comment and --force require --issue');
  }

  // --protocol as override cannot be used with --shell or --worktree
  if (options.protocol && inputModes.length > 0 && (options.shell || options.worktree)) {
    fatal('--protocol cannot be used with --shell or --worktree (no protocol applies)');
  }

  // --use-protocol is now deprecated in favor of --protocol as universal override
  // Keep for backwards compatibility but prefer --protocol
  if (options.useProtocol && (options.shell || options.worktree)) {
    fatal('--use-protocol cannot be used with --shell or --worktree (no protocol applies)');
  }
}

/**
 * Determine the spawn mode from options
 * Note: --protocol can be used as both an input mode (alone) or an override (with other modes)
 */
function getSpawnMode(options: SpawnOptions): BuilderType {
  // Primary input modes take precedence over --protocol as override
  if (options.project) return 'spec';
  if (options.issue) return 'bugfix';
  if (options.task) return 'task';
  if (options.shell) return 'shell';
  if (options.worktree) return 'worktree';
  // --protocol alone is the protocol input mode
  if (options.protocol) return 'protocol';
  throw new Error('No mode specified');
}

// =============================================================================
// Mode-specific spawn implementations
// =============================================================================

/**
 * Spawn builder for a spec (existing behavior)
 */
async function spawnSpec(options: SpawnOptions, config: Config): Promise<void> {
  const projectId = options.project!;
  const specFile = await findSpecFile(config.codevDir, projectId);
  if (!specFile) {
    fatal(`Spec not found for project: ${projectId}`);
  }

  const specName = basename(specFile, '.md');
  const builderId = projectId;
  const safeName = specName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const branchName = `builder/${safeName}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  // Check for corresponding plan file
  const planFile = resolve(config.codevDir, 'plans', `${specName}.md`);
  const hasPlan = existsSync(planFile);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Builder ${builderId} (spec)`);
  logger.kv('Spec', specFile);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();

  if (options.resume) {
    validateResumeWorktree(worktreePath);
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  const protocol = await resolveProtocol(options, config);
  const protocolDef = loadProtocol(config, protocol);
  const mode = resolveMode(options, protocolDef);

  logger.kv('Protocol', protocol.toUpperCase());
  logger.kv('Mode', mode.toUpperCase());

  // Pre-initialize porch so the builder doesn't need to figure out project ID
  if (!options.resume) {
    const porchProjectName = specName.replace(new RegExp(`^${projectId}-`), '');
    await initPorchInWorktree(worktreePath, protocol, projectId, porchProjectName);
  }

  const specRelPath = `codev/specs/${specName}.md`;
  const planRelPath = `codev/plans/${specName}.md`;
  const templateContext: TemplateContext = {
    protocol_name: protocol.toUpperCase(), mode,
    mode_soft: mode === 'soft', mode_strict: mode === 'strict',
    project_id: projectId,
    input_description: `the feature specified in ${specRelPath}`,
    spec: { path: specRelPath, name: specName },
  };
  if (hasPlan) templateContext.plan = { path: planRelPath, name: specName };

  const initialPrompt = buildPromptFromTemplate(config, protocol, templateContext);
  const resumeNotice = options.resume ? `\n${buildResumeNotice(projectId)}\n` : '';
  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n${resumeNotice}\n${initialPrompt}`;

  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();
  const { terminalId } = await startBuilderSession(
    config, builderId, worktreePath, commands.builder,
    builderPrompt, role?.content ?? null, role?.source ?? null,
  );

  upsertBuilder({
    id: builderId, name: specName, status: 'implementing', phase: 'init',
    worktree: worktreePath, branch: branchName, type: 'spec', terminalId,
  });

  logger.blank();
  logger.success(`Builder ${builderId} spawned!`);
  logger.kv('Mode', mode === 'strict' ? 'Strict (porch-driven)' : 'Soft (protocol-guided)');
  logger.kv('Terminal', `ws://localhost:${DEFAULT_TOWER_PORT}/ws/terminal/${terminalId}`);
}

/**
 * Spawn builder for an ad-hoc task
 */
async function spawnTask(options: SpawnOptions, config: Config): Promise<void> {
  const taskText = options.task!;
  const shortId = generateShortId();
  const builderId = `task-${shortId}`;
  const branchName = `builder/task-${shortId}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Builder ${builderId} (task)`);
  logger.kv('Task', taskText.substring(0, 60) + (taskText.length > 60 ? '...' : ''));
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  if (options.files && options.files.length > 0) {
    logger.kv('Files', options.files.join(', '));
  }

  await ensureDirectories(config);
  await checkDependencies();

  if (options.resume) {
    validateResumeWorktree(worktreePath);
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  let taskDescription = taskText;
  if (options.files && options.files.length > 0) {
    taskDescription += `\n\nRelevant files to consider:\n${options.files.map(f => `- ${f}`).join('\n')}`;
  }

  const hasExplicitProtocol = options.protocol || options.useProtocol;
  const resumeNotice = options.resume ? `\n${buildResumeNotice(builderId)}\n` : '';
  let builderPrompt: string;

  if (hasExplicitProtocol) {
    const protocol = await resolveProtocol(options, config);
    const protocolDef = loadProtocol(config, protocol);
    const mode = resolveMode(options, protocolDef);
    const templateContext: TemplateContext = {
      protocol_name: protocol.toUpperCase(), mode,
      mode_soft: mode === 'soft', mode_strict: mode === 'strict',
      project_id: builderId, input_description: 'an ad-hoc task', task_text: taskDescription,
    };
    const prompt = buildPromptFromTemplate(config, protocol, templateContext);
    builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n${resumeNotice}\n${prompt}`;
  } else {
    builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n${resumeNotice}\n# Task\n\n${taskDescription}`;
  }

  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();
  const { terminalId } = await startBuilderSession(
    config, builderId, worktreePath, commands.builder,
    builderPrompt, role?.content ?? null, role?.source ?? null,
  );

  upsertBuilder({
    id: builderId,
    name: `Task: ${taskText.substring(0, 30)}${taskText.length > 30 ? '...' : ''}`,
    status: 'implementing', phase: 'init',
    worktree: worktreePath, branch: branchName, type: 'task', taskText, terminalId,
  });

  logger.blank();
  logger.success(`Builder ${builderId} spawned!`);
  logger.kv('Terminal', `ws://localhost:${DEFAULT_TOWER_PORT}/ws/terminal/${terminalId}`);
}

/**
 * Spawn builder to run a protocol
 */
async function spawnProtocol(options: SpawnOptions, config: Config): Promise<void> {
  const protocolName = options.protocol!;
  validateProtocol(config, protocolName);

  const shortId = generateShortId();
  const builderId = `${protocolName}-${shortId}`;
  const branchName = `builder/${protocolName}-${shortId}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Builder ${builderId} (protocol)`);
  logger.kv('Protocol', protocolName);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();

  if (options.resume) {
    validateResumeWorktree(worktreePath);
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  const protocolDef = loadProtocol(config, protocolName);
  const mode = resolveMode(options, protocolDef);
  logger.kv('Mode', mode.toUpperCase());

  const templateContext: TemplateContext = {
    protocol_name: protocolName.toUpperCase(), mode,
    mode_soft: mode === 'soft', mode_strict: mode === 'strict',
    project_id: builderId,
    input_description: `running the ${protocolName.toUpperCase()} protocol`,
  };
  const promptContent = buildPromptFromTemplate(config, protocolName, templateContext);
  const resumeNotice = options.resume ? `\n${buildResumeNotice(builderId)}\n` : '';
  const prompt = resumeNotice ? `${resumeNotice}\n${promptContent}` : promptContent;

  const role = options.noRole ? null : loadProtocolRole(config, protocolName);
  const commands = getResolvedCommands();
  const { terminalId } = await startBuilderSession(
    config, builderId, worktreePath, commands.builder,
    prompt, role?.content ?? null, role?.source ?? null,
  );

  upsertBuilder({
    id: builderId, name: `Protocol: ${protocolName}`,
    status: 'implementing', phase: 'init',
    worktree: worktreePath, branch: branchName, type: 'protocol', protocolName, terminalId,
  });

  logger.blank();
  logger.success(`Builder ${builderId} spawned!`);
  logger.kv('Terminal', `ws://localhost:${DEFAULT_TOWER_PORT}/ws/terminal/${terminalId}`);
}

/**
 * Spawn a bare shell session (no worktree, no prompt)
 */
async function spawnShell(options: SpawnOptions, config: Config): Promise<void> {
  const shortId = generateShortId();
  const shellId = `shell-${shortId}`;

  logger.header(`Spawning Shell ${shellId}`);

  await ensureDirectories(config);
  await checkDependencies();

  const commands = getResolvedCommands();
  const { terminalId } = await startShellSession(config, shortId, commands.builder);

  upsertBuilder({
    id: shellId, name: 'Shell session',
    status: 'implementing', phase: 'interactive',
    worktree: '', branch: '', type: 'shell', terminalId,
  });

  logger.blank();
  logger.success(`Shell ${shellId} spawned!`);
  logger.kv('Terminal', `ws://localhost:${DEFAULT_TOWER_PORT}/ws/terminal/${terminalId}`);
}

/**
 * Spawn a worktree session (has worktree/branch, but no initial prompt)
 * Use case: Small features without spec/plan, like quick fixes
 */
async function spawnWorktree(options: SpawnOptions, config: Config): Promise<void> {
  const shortId = generateShortId();
  const builderId = `worktree-${shortId}`;
  const branchName = `builder/worktree-${shortId}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Worktree ${builderId}`);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();

  if (options.resume) {
    validateResumeWorktree(worktreePath);
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  logger.info('Creating terminal session...');
  const scriptContent = buildWorktreeLaunchScript(worktreePath, commands.builder, role);
  const scriptPath = resolve(worktreePath, '.builder-start.sh');
  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

  logger.info('Creating PTY terminal session for worktree...');
  const { terminalId: worktreeTerminalId } = await createPtySession(
    config,
    '/bin/bash',
    [scriptPath],
    worktreePath,
    { workspacePath: config.workspaceRoot, type: 'builder', roleId: builderId },
  );
  logger.info(`Worktree terminal session created: ${worktreeTerminalId}`);

  upsertBuilder({
    id: builderId, name: 'Worktree session',
    status: 'implementing', phase: 'interactive',
    worktree: worktreePath, branch: branchName, type: 'worktree',
    terminalId: worktreeTerminalId,
  });

  logger.blank();
  logger.success(`Worktree ${builderId} spawned!`);
  logger.kv('Terminal', `ws://localhost:${DEFAULT_TOWER_PORT}/ws/terminal/${worktreeTerminalId}`);
}

/**
 * Spawn builder for a GitHub issue (bugfix mode)
 */
async function spawnBugfix(options: SpawnOptions, config: Config): Promise<void> {
  const issueNumber = options.issue!;

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Bugfix Builder for Issue #${issueNumber}`);

  // Fetch issue from GitHub
  logger.info('Fetching issue from GitHub...');
  const issue = await fetchGitHubIssue(issueNumber);

  const slug = slugify(issue.title);
  const builderId = `bugfix-${issueNumber}`;
  const branchName = `builder/bugfix-${issueNumber}-${slug}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  const protocol = await resolveProtocol(options, config);
  const protocolDef = loadProtocol(config, protocol);
  const mode = resolveMode(options, protocolDef);

  logger.kv('Title', issue.title);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);
  logger.kv('Protocol', protocol.toUpperCase());
  logger.kv('Mode', mode.toUpperCase());

  // Execute pre-spawn hooks (skip in resume mode)
  if (!options.resume) {
    if (protocolDef?.hooks?.['pre-spawn']) {
      await executePreSpawnHooks(protocolDef, {
        issueNumber,
        issue,
        worktreePath,
        force: options.force,
        noComment: options.noComment,
      });
    } else {
      // Fallback: hardcoded behavior for backwards compatibility
      await checkBugfixCollisions(issueNumber, worktreePath, issue, !!options.force);
      if (!options.noComment) {
        logger.info('Commenting on issue...');
        try {
          await run(`gh issue comment ${issueNumber} --body "On it! Working on a fix now."`);
        } catch {
          logger.warn('Warning: Failed to comment on issue (continuing anyway)');
        }
      }
    }
  }

  await ensureDirectories(config);
  await checkDependencies();

  if (options.resume) {
    validateResumeWorktree(worktreePath);
  } else {
    await createWorktree(config, branchName, worktreePath);

    // Pre-initialize porch so the builder doesn't need to figure out project ID
    await initPorchInWorktree(worktreePath, protocol, builderId, slug);
  }

  const templateContext: TemplateContext = {
    protocol_name: protocol.toUpperCase(), mode,
    mode_soft: mode === 'soft', mode_strict: mode === 'strict',
    project_id: builderId,
    input_description: `a fix for GitHub Issue #${issueNumber}`,
    issue: { number: issueNumber, title: issue.title, body: issue.body || '(No description provided)' },
  };
  const prompt = buildPromptFromTemplate(config, protocol, templateContext);
  const resumeNotice = options.resume ? `\n${buildResumeNotice(builderId)}\n` : '';
  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n${resumeNotice}\n${prompt}`;

  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();
  const { terminalId } = await startBuilderSession(
    config, builderId, worktreePath, commands.builder,
    builderPrompt, role?.content ?? null, role?.source ?? null,
  );

  upsertBuilder({
    id: builderId,
    name: `Bugfix #${issueNumber}: ${issue.title.substring(0, 40)}${issue.title.length > 40 ? '...' : ''}`,
    status: 'implementing', phase: 'init',
    worktree: worktreePath, branch: branchName, type: 'bugfix', issueNumber, terminalId,
  });

  logger.blank();
  logger.success(`Bugfix builder for issue #${issueNumber} spawned!`);
  logger.kv('Mode', mode === 'strict' ? 'Strict (porch-driven)' : 'Soft (protocol-guided)');
  logger.kv('Terminal', `ws://localhost:${DEFAULT_TOWER_PORT}/ws/terminal/${terminalId}`);
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Spawn a new builder
 */
export async function spawn(options: SpawnOptions): Promise<void> {
  validateSpawnOptions(options);

  const config = getConfig();

  // Refuse to spawn if the main worktree has uncommitted changes.
  // Builders work in git worktrees branched from HEAD — uncommitted changes
  // (specs, plans, codev updates) won't be visible to the builder.
  // Skip this check in resume mode — the worktree already exists with its own branch.
  if (!options.force && !options.resume) {
    try {
      const { stdout } = await run('git status --porcelain', { cwd: config.workspaceRoot });
      if (stdout.trim().length > 0) {
        fatal(
          'Uncommitted changes detected in main worktree.\n\n' +
          '  Builders branch from HEAD, so uncommitted files (specs, plans,\n' +
          '  codev updates) will NOT be visible to the builder.\n\n' +
          '  Please commit or stash your changes first, then retry.\n' +
          '  Use --force to skip this check.'
        );
      }
    } catch {
      // Non-fatal — if git status fails, allow spawn to continue
    }
  }

  // Prune stale worktrees before spawning to prevent "can't find session" errors
  // This catches orphaned worktrees from crashes, manual kills, or incomplete cleanups
  try {
    await run('git worktree prune', { cwd: config.workspaceRoot });
  } catch {
    // Non-fatal - continue with spawn even if prune fails
  }

  const mode = getSpawnMode(options);

  const handlers: Record<BuilderType, () => Promise<void>> = {
    spec: () => spawnSpec(options, config),
    bugfix: () => spawnBugfix(options, config),
    task: () => spawnTask(options, config),
    protocol: () => spawnProtocol(options, config),
    shell: () => spawnShell(options, config),
    worktree: () => spawnWorktree(options, config),
  };
  await handlers[mode]();
}
