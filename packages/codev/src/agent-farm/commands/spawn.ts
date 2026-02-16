/**
 * Spawn command — orchestrator module.
 * Spec 0126: Project Management Rework — Phase 2 (Spawn CLI Rework)
 *
 * Modes (protocol-driven for issue-based spawns):
 * - spec:     af spawn 315 --protocol spir     (feature)
 * - bugfix:   af spawn 315 --protocol bugfix   (bug fix)
 * - task:     af spawn --task "..."             (ad-hoc task)
 * - protocol: af spawn --protocol maintain      (protocol-only run)
 * - shell:    af spawn --shell                  (bare session)
 * - worktree: af spawn --worktree              (worktree, no prompt)
 *
 * Role/prompt logic extracted to spawn-roles.ts.
 * Worktree/git logic extracted to spawn-worktree.ts.
 */

import { resolve, basename } from 'node:path';
import { existsSync, writeFileSync, readdirSync } from 'node:fs';
import type { SpawnOptions, BuilderType, Config } from '../types.js';
import { getConfig, ensureDirectories, getResolvedCommands } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run } from '../utils/shell.js';
import { upsertBuilder } from '../state.js';
import { loadRolePrompt } from '../utils/roles.js';
import { buildAgentName, stripLeadingZeros } from '../utils/agent-names.js';
import { fetchGitHubIssue as fetchGitHubIssueNonFatal } from '../../lib/github.js';
import {
  type TemplateContext,
  buildPromptFromTemplate,
  buildResumeNotice,
  loadProtocolRole,
  findSpecFile,
  validateProtocol,
  loadProtocol,
  resolveMode,
} from './spawn-roles.js';
import {
  checkDependencies,
  createWorktree,
  initPorchInWorktree,
  checkBugfixCollisions,
  fetchGitHubIssue,
  executePreSpawnHooks,
  slugify,
  findExistingBugfixWorktree,
  validateResumeWorktree,
  createPtySession,
  startBuilderSession,
  startShellSession,
  buildWorktreeLaunchScript,
} from './spawn-worktree.js';
import { getTowerClient } from '../lib/tower-client.js';

// =============================================================================
// ID and Session Management
// =============================================================================

/**
 * Log spawn success with terminal WebSocket URL
 */
function logSpawnSuccess(label: string, terminalId: string, mode?: string): void {
  const client = getTowerClient();
  logger.blank();
  logger.success(`${label} spawned!`);
  if (mode) logger.kv('Mode', mode === 'strict' ? 'Strict (porch-driven)' : 'Soft (protocol-guided)');
  logger.kv('Terminal', client.getTerminalWsUrl(terminalId));
}

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
 * Validate spawn options for the new positional-arg interface.
 *
 * Rules:
 * - issueNumber, task, shell, worktree are mutually exclusive
 * - --protocol is required when issueNumber is present (unless --resume or --soft)
 * - --protocol alone (no issueNumber) is valid as a protocol-only run
 * - --amends requires --protocol tick
 */
function validateSpawnOptions(options: SpawnOptions): void {
  // Count primary input modes
  const inputModes = [
    options.issueNumber,
    options.task,
    options.shell,
    options.worktree,
  ].filter(Boolean);

  // --protocol alone (no other input) is a valid mode
  const protocolAlone = options.protocol && inputModes.length === 0;

  if (inputModes.length === 0 && !protocolAlone) {
    fatal(
      'Must specify an issue number or one of: --task, --protocol, --shell, --worktree\n\n' +
      'Usage:\n' +
      '  af spawn 315 --protocol spir      # Feature with SPIR protocol\n' +
      '  af spawn 315 --protocol bugfix    # Bug fix\n' +
      '  af spawn --task "fix the bug"     # Ad-hoc task\n' +
      '  af spawn --protocol maintain      # Protocol-only run\n' +
      '  af spawn --shell                  # Bare session\n\n' +
      'Run "af spawn --help" for more options.'
    );
  }

  if (inputModes.length > 1) {
    fatal('Issue number, --task, --shell, and --worktree are mutually exclusive');
  }

  // --protocol is required for issue-based spawns (unless --resume or --soft)
  if (options.issueNumber && !options.protocol && !options.resume && !options.soft) {
    fatal(
      '--protocol is required when spawning with an issue number.\n\n' +
      'Usage:\n' +
      '  af spawn 315 --protocol spir      # Feature\n' +
      '  af spawn 315 --protocol bugfix    # Bug fix\n' +
      '  af spawn 315 --protocol tick --amends 42  # Amendment\n' +
      '  af spawn 315 --resume             # Resume (reads protocol from worktree)\n' +
      '  af spawn 315 --soft               # Soft mode (defaults to SPIR)'
    );
  }

  if (options.files && !options.task) {
    fatal('--files requires --task');
  }

  if ((options.noComment || options.force) && !options.issueNumber) {
    fatal('--no-comment and --force require an issue number');
  }

  // --protocol cannot be used with --shell or --worktree
  if (options.protocol && (options.shell || options.worktree)) {
    fatal('--protocol cannot be used with --shell or --worktree');
  }

  // --amends requires --protocol tick
  if (options.amends && options.protocol !== 'tick') {
    fatal('--amends requires --protocol tick');
  }

  // --strict and --soft are mutually exclusive
  if (options.strict && options.soft) {
    fatal('--strict and --soft are mutually exclusive');
  }
}

/**
 * Determine the spawn mode from options.
 * Protocol drives the mode for issue-based spawns.
 */
function getSpawnMode(options: SpawnOptions): BuilderType {
  if (options.task) return 'task';
  if (options.shell) return 'shell';
  if (options.worktree) return 'worktree';

  if (options.issueNumber) {
    // Protocol drives mode for issue-based spawns
    if (options.protocol === 'bugfix') return 'bugfix';
    return 'spec';
  }

  // --protocol alone (no issue number) is protocol mode
  if (options.protocol) return 'protocol';
  throw new Error('No mode specified');
}

/**
 * Resolve the protocol for issue-based spawns.
 * For --soft without --protocol, defaults to SPIR when a spec file exists.
 * For --resume without --protocol, infers from existing worktree directory.
 */
async function resolveIssueProtocol(
  options: SpawnOptions,
  config: Config,
): Promise<string> {
  // Explicit --protocol always wins
  if (options.protocol) {
    validateProtocol(config, options.protocol);
    return options.protocol.toLowerCase();
  }

  // --soft without --protocol: SPIR if spec file exists, bugfix otherwise
  if (options.soft && options.issueNumber) {
    const specFile = await findSpecFile(config.codevDir, String(options.issueNumber));
    return specFile ? 'spir' : 'bugfix';
  }

  // --resume without --protocol: infer from existing worktree
  if (options.resume && options.issueNumber) {
    const inferred = inferProtocolFromWorktree(config, options.issueNumber);
    if (inferred) return inferred;
    fatal(
      `Cannot infer protocol for issue #${options.issueNumber}.\n` +
      'No matching worktree found in .builders/. Specify --protocol explicitly.'
    );
  }

  fatal('--protocol is required');
  throw new Error('unreachable');
}

/**
 * Infer protocol from an existing worktree directory name.
 * Worktree naming: <protocol>-<id>-<slug> or bugfix-<id>-<slug>
 * Handles legacy zero-padded IDs: worktree `spir-0076-feature` matches issueNumber=76.
 */
function inferProtocolFromWorktree(config: Config, issueNumber: number): string | null {
  if (!existsSync(config.buildersDir)) return null;
  const strippedId = stripLeadingZeros(String(issueNumber));
  const dirs = readdirSync(config.buildersDir);
  // Match patterns like: spir-315-feature-name, bugfix-315-slug, spir-0076-feature
  const match = dirs.find(d => {
    const parts = d.split('-');
    return parts.length >= 2 && stripLeadingZeros(parts[1]) === strippedId;
  });
  if (match) {
    return match.split('-')[0];
  }
  return null;
}

// =============================================================================
// Mode-specific spawn implementations
// =============================================================================

/**
 * Spawn builder for a spec (SPIR, TICK, and other non-bugfix protocols)
 */
async function spawnSpec(options: SpawnOptions, config: Config): Promise<void> {
  const issueNumber = options.issueNumber!;
  const projectId = String(issueNumber);
  const protocol = await resolveIssueProtocol(options, config);

  // For TICK amendments, resolve spec by the amends number (the original spec)
  const specLookupId = (protocol === 'tick' && options.amends)
    ? String(options.amends)
    : projectId;

  // Resolve spec file (supports legacy zero-padded IDs)
  const specFile = await findSpecFile(config.codevDir, specLookupId);
  if (!specFile) {
    fatal(`Spec not found for ${protocol === 'tick' ? `amends #${options.amends}` : `issue #${issueNumber}`}. Expected: codev/specs/${specLookupId}-*.md`);
  }

  const specName = basename(specFile, '.md');
  const strippedId = stripLeadingZeros(projectId);
  const builderId = buildAgentName('spec', projectId, protocol);
  const specSlug = specName.replace(/^[0-9]+-/, '');
  const worktreeName = `${protocol}-${strippedId}-${specSlug}`;
  const branchName = `builder/${worktreeName}`;
  const worktreePath = resolve(config.buildersDir, worktreeName);

  // Check for corresponding plan file
  const planFile = resolve(config.codevDir, 'plans', `${specName}.md`);
  const hasPlan = existsSync(planFile);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Builder ${builderId} (${protocol})`);
  logger.kv('Issue', `#${issueNumber}`);
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

  const protocolDef = loadProtocol(config, protocol);
  const mode = resolveMode(options, protocolDef);

  logger.kv('Protocol', protocol.toUpperCase());
  logger.kv('Mode', mode.toUpperCase());

  // Pre-initialize porch so the builder doesn't need to figure out project ID
  if (!options.resume) {
    const porchProjectName = specName.replace(new RegExp(`^0*${projectId}-`), '');
    await initPorchInWorktree(worktreePath, protocol, projectId, porchProjectName);
  }

  // Fetch GitHub issue context (non-fatal, for enriching the builder prompt)
  const ghIssue = await fetchGitHubIssueNonFatal(issueNumber);
  if (ghIssue) {
    logger.kv('GitHub Issue', `#${issueNumber}: ${ghIssue.title}`);
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
  if (ghIssue) {
    templateContext.issue = {
      number: issueNumber,
      title: ghIssue.title,
      body: ghIssue.body || '(No description provided)',
    };
  }

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
    worktree: worktreePath, branch: branchName, type: 'spec', issueNumber, terminalId,
  });

  logSpawnSuccess(`Builder ${builderId}`, terminalId, mode);
}

/**
 * Spawn builder for an ad-hoc task
 */
async function spawnTask(options: SpawnOptions, config: Config): Promise<void> {
  const taskText = options.task!;
  const shortId = generateShortId();
  const builderId = buildAgentName('task', shortId);
  const worktreeName = `task-${shortId}`;
  const branchName = `builder/${worktreeName}`;
  const worktreePath = resolve(config.buildersDir, worktreeName);

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

  const hasExplicitProtocol = !!options.protocol;
  const resumeNotice = options.resume ? `\n${buildResumeNotice(builderId)}\n` : '';
  let builderPrompt: string;

  if (hasExplicitProtocol) {
    validateProtocol(config, options.protocol!);
    const protocol = options.protocol!.toLowerCase();
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

  logSpawnSuccess(`Builder ${builderId}`, terminalId);
}

/**
 * Spawn builder to run a protocol (no issue number)
 */
async function spawnProtocol(options: SpawnOptions, config: Config): Promise<void> {
  const protocolName = options.protocol!;
  validateProtocol(config, protocolName);

  const shortId = generateShortId();
  const builderId = buildAgentName('protocol', shortId, protocolName);
  const worktreeName = `${protocolName}-${shortId}`;
  const branchName = `builder/${worktreeName}`;
  const worktreePath = resolve(config.buildersDir, worktreeName);

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

  logSpawnSuccess(`Builder ${builderId}`, terminalId);
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

  logSpawnSuccess(`Shell ${shellId}`, terminalId);
}

/**
 * Spawn a worktree session (has worktree/branch, but no initial prompt)
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

  logSpawnSuccess(`Worktree ${builderId}`, worktreeTerminalId);
}

/**
 * Spawn builder for a GitHub issue (bugfix mode)
 */
async function spawnBugfix(options: SpawnOptions, config: Config): Promise<void> {
  const issueNumber = options.issueNumber!;
  const protocol = await resolveIssueProtocol(options, config);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Bugfix Builder for Issue #${issueNumber}`);

  // Fetch issue from GitHub
  logger.info('Fetching issue from GitHub...');
  const issue = await fetchGitHubIssue(issueNumber);

  const builderId = buildAgentName('bugfix', String(issueNumber));

  // When resuming, find the existing worktree by issue number pattern
  // instead of recomputing from the current title (which may have changed).
  let worktreeName: string;
  if (options.resume) {
    const existing = findExistingBugfixWorktree(config.buildersDir, issueNumber);
    if (existing) {
      worktreeName = existing;
    } else {
      worktreeName = `bugfix-${issueNumber}-${slugify(issue.title)}`;
    }
  } else {
    worktreeName = `bugfix-${issueNumber}-${slugify(issue.title)}`;
  }

  const branchName = `builder/${worktreeName}`;
  const worktreePath = resolve(config.buildersDir, worktreeName);

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

    // Pre-initialize porch so the builder doesn't need to figure out project ID.
    // Use bugfix-{N} as the porch project ID (not the builder agent name).
    // This aligns with porch's CWD-based detection from worktree paths.
    const porchProjectId = `bugfix-${issueNumber}`;
    const slug = slugify(issue.title);
    await initPorchInWorktree(worktreePath, protocol, porchProjectId, slug);
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

  logSpawnSuccess(`Bugfix builder for issue #${issueNumber}`, terminalId, mode);
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
