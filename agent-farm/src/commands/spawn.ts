/**
 * Spawn command - creates a new builder in various modes
 *
 * Modes:
 * - spec:     --project/-p  Spawn for a spec file (existing behavior)
 * - task:     --task        Spawn with an ad-hoc task description
 * - protocol: --protocol    Spawn to run a protocol (cleanup, experiment, etc.)
 * - shell:    --shell       Bare Claude session (no prompt, no worktree)
 */

import { resolve, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, chmodSync, readdirSync, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { SpawnOptions, Builder, Config, BuilderType } from '../types.js';
import { getConfig, ensureDirectories, getResolvedCommands } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run, spawnDetached, commandExists, findAvailablePort } from '../utils/shell.js';
import { loadState, upsertBuilder } from '../state.js';

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
 * Validate spawn options - ensure exactly one mode is selected
 */
function validateSpawnOptions(options: SpawnOptions): void {
  const modes = [
    options.project,
    options.task,
    options.protocol,
    options.shell,
    options.worktree,
  ].filter(Boolean);

  if (modes.length === 0) {
    fatal('Must specify one of: --project (-p), --task, --protocol, --shell, --worktree\n\nRun "af spawn --help" for examples.');
  }

  if (modes.length > 1) {
    fatal('Flags --project, --task, --protocol, --shell, --worktree are mutually exclusive');
  }

  if (options.files && !options.task) {
    fatal('--files requires --task');
  }
}

/**
 * Determine the spawn mode from options
 */
function getSpawnMode(options: SpawnOptions): BuilderType {
  if (options.project) return 'spec';
  if (options.task) return 'task';
  if (options.protocol) return 'protocol';
  if (options.shell) return 'shell';
  if (options.worktree) return 'worktree';
  throw new Error('No mode specified');
}

/**
 * Find and load a role file - tries local codev/roles/ first, falls back to bundled
 */
function loadRolePrompt(config: Config, roleName: string): { content: string; source: string } | null {
  // Try local project first
  const localPath = resolve(config.codevDir, 'roles', `${roleName}.md`);
  if (existsSync(localPath)) {
    return { content: readFileSync(localPath, 'utf-8'), source: 'local' };
  }

  // Fall back to bundled
  const bundledPath = resolve(config.bundledRolesDir, `${roleName}.md`);
  if (existsSync(bundledPath)) {
    return { content: readFileSync(bundledPath, 'utf-8'), source: 'bundled' };
  }

  return null;
}

/**
 * Load a protocol-specific role if it exists
 */
function loadProtocolRole(config: Config, protocolName: string): { content: string; source: string } | null {
  const protocolRolePath = resolve(config.codevDir, 'protocols', protocolName, 'role.md');
  if (existsSync(protocolRolePath)) {
    return { content: readFileSync(protocolRolePath, 'utf-8'), source: 'protocol' };
  }
  // Fall back to builder role
  return loadRolePrompt(config, 'builder');
}

/**
 * Find a spec file by project ID
 */
async function findSpecFile(codevDir: string, projectId: string): Promise<string | null> {
  const specsDir = resolve(codevDir, 'specs');

  if (!existsSync(specsDir)) {
    return null;
  }

  const files = await readdir(specsDir);

  // Try exact match first (e.g., "0001-feature.md")
  for (const file of files) {
    if (file.startsWith(projectId) && file.endsWith('.md')) {
      return resolve(specsDir, file);
    }
  }

  // Try partial match (e.g., just "0001")
  for (const file of files) {
    if (file.startsWith(projectId + '-') && file.endsWith('.md')) {
      return resolve(specsDir, file);
    }
  }

  return null;
}

/**
 * Validate that a protocol exists
 */
function validateProtocol(config: Config, protocolName: string): void {
  const protocolDir = resolve(config.codevDir, 'protocols', protocolName);
  const protocolFile = resolve(protocolDir, 'protocol.md');

  if (!existsSync(protocolDir)) {
    // List available protocols
    const protocolsDir = resolve(config.codevDir, 'protocols');
    let available = '';
    if (existsSync(protocolsDir)) {
      const dirs = readdirSync(protocolsDir, { withFileTypes: true })
        .filter((d: Dirent) => d.isDirectory())
        .map((d: Dirent) => d.name);
      if (dirs.length > 0) {
        available = `\n\nAvailable protocols: ${dirs.join(', ')}`;
      }
    }
    fatal(`Protocol not found: ${protocolName}${available}`);
  }

  if (!existsSync(protocolFile)) {
    fatal(`Protocol ${protocolName} exists but has no protocol.md file`);
  }
}

/**
 * Check for required dependencies
 */
async function checkDependencies(): Promise<void> {
  if (!(await commandExists('git'))) {
    fatal('git not found');
  }

  if (!(await commandExists('ttyd'))) {
    fatal('ttyd not found. Install with: brew install ttyd');
  }
}

/**
 * Find an available port, avoiding ports already in use by other builders
 */
async function findFreePort(config: Config): Promise<number> {
  const state = loadState();
  const usedPorts = new Set<number>();
  for (const b of state.builders || []) {
    if (b.port) usedPorts.add(b.port);
  }
  let port = config.builderPortRange[0];
  while (usedPorts.has(port)) {
    port++;
  }
  return findAvailablePort(port);
}

/**
 * Create git branch and worktree
 */
async function createWorktree(config: Config, branchName: string, worktreePath: string): Promise<void> {
  logger.info('Creating branch...');
  try {
    await run(`git branch ${branchName}`, { cwd: config.projectRoot });
  } catch (error) {
    // Branch might already exist, that's OK
    logger.debug(`Branch creation: ${error}`);
  }

  logger.info('Creating worktree...');
  try {
    await run(`git worktree add "${worktreePath}" ${branchName}`, { cwd: config.projectRoot });
  } catch (error) {
    fatal(`Failed to create worktree: ${error}`);
  }
}

/**
 * Start tmux session and ttyd for a builder
 */
async function startBuilderSession(
  config: Config,
  builderId: string,
  worktreePath: string,
  baseCmd: string,
  prompt: string,
  roleContent: string | null,
  roleSource: string | null,
): Promise<{ port: number; pid: number; sessionName: string }> {
  const port = await findFreePort(config);
  const sessionName = `builder-${builderId}`;

  logger.info('Creating tmux session...');

  // Write initial prompt to a file for reference
  const promptFile = resolve(worktreePath, '.builder-prompt.txt');
  writeFileSync(promptFile, prompt);

  // Build the start script with role if provided
  const scriptPath = resolve(worktreePath, '.builder-start.sh');
  let scriptContent: string;

  if (roleContent) {
    // Write role to a file and use $(cat) to avoid shell escaping issues
    const roleFile = resolve(worktreePath, '.builder-role.md');
    writeFileSync(roleFile, roleContent);
    logger.info(`Loaded role (${roleSource})`);
    scriptContent = `#!/bin/bash
exec ${baseCmd} --append-system-prompt "$(cat '${roleFile}')" "$(cat '${promptFile}')"
`;
  } else {
    scriptContent = `#!/bin/bash
exec ${baseCmd} "$(cat '${promptFile}')"
`;
  }

  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, '755');

  // Create tmux session running the script
  await run(`tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${worktreePath}" "${scriptPath}"`);

  // Enable mouse scrolling in tmux
  await run('tmux set -g mouse on');
  await run('tmux set -g set-clipboard on');
  await run('tmux set -g allow-passthrough on');

  // Copy selection to clipboard when mouse is released (pbcopy for macOS)
  await run('tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');
  await run('tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');

  // Start ttyd connecting to the tmux session
  logger.info('Starting builder terminal...');
  const customIndexPath = resolve(config.templatesDir, 'ttyd-index.html');
  const ttydArgs = [
    '-W',
    '-p', String(port),
    '-t', 'theme={"background":"#000000"}',
    '-t', 'rightClickSelectsWord=true',  // Enable word selection on right-click for better UX
  ];

  if (existsSync(customIndexPath)) {
    ttydArgs.push('-I', customIndexPath);
    logger.info('Using custom terminal with file click support');
  }

  ttydArgs.push('tmux', 'attach-session', '-t', sessionName);

  const ttydProcess = spawnDetached('ttyd', ttydArgs, {
    cwd: worktreePath,
  });

  if (!ttydProcess.pid) {
    fatal('Failed to start ttyd process for builder');
  }

  return { port, pid: ttydProcess.pid, sessionName };
}

/**
 * Start a shell session (no worktree, just tmux + ttyd)
 */
async function startShellSession(
  config: Config,
  shellId: string,
  baseCmd: string,
): Promise<{ port: number; pid: number; sessionName: string }> {
  const port = await findFreePort(config);
  const sessionName = `shell-${shellId}`;

  logger.info('Creating tmux session...');

  // Shell mode: just launch Claude with no prompt
  await run(`tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${config.projectRoot}" "${baseCmd}"`);

  // Enable mouse scrolling in tmux
  await run('tmux set -g mouse on');
  await run('tmux set -g set-clipboard on');
  await run('tmux set -g allow-passthrough on');

  // Copy selection to clipboard when mouse is released (pbcopy for macOS)
  await run('tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');
  await run('tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');

  // Start ttyd
  logger.info('Starting shell terminal...');
  const customIndexPath = resolve(config.templatesDir, 'ttyd-index.html');
  const ttydArgs = [
    '-W',
    '-p', String(port),
    '-t', 'theme={"background":"#000000"}',
    '-t', 'rightClickSelectsWord=true',  // Enable word selection on right-click for better UX
  ];

  if (existsSync(customIndexPath)) {
    ttydArgs.push('-I', customIndexPath);
  }

  ttydArgs.push('tmux', 'attach-session', '-t', sessionName);

  const ttydProcess = spawnDetached('ttyd', ttydArgs, {
    cwd: config.projectRoot,
  });

  if (!ttydProcess.pid) {
    fatal('Failed to start ttyd process for shell');
  }

  return { port, pid: ttydProcess.pid, sessionName };
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

  logger.header(`Spawning Builder ${builderId} (spec)`);
  logger.kv('Spec', specFile);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();
  await createWorktree(config, branchName, worktreePath);

  // Build the prompt
  const specRelPath = `codev/specs/${specName}.md`;
  const planRelPath = `codev/plans/${specName}.md`;
  let initialPrompt = `Implement the feature specified in ${specRelPath}.`;
  if (hasPlan) {
    initialPrompt += ` Follow the implementation plan in ${planRelPath}.`;
  }
  initialPrompt += ` Start by reading the spec${hasPlan ? ' and plan' : ''}, then begin implementation.`;

  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition. ${initialPrompt}`;

  // Load role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  const { port, pid, sessionName } = await startBuilderSession(
    config,
    builderId,
    worktreePath,
    commands.builder,
    builderPrompt,
    role?.content ?? null,
    role?.source ?? null,
  );

  const builder: Builder = {
    id: builderId,
    name: specName,
    port,
    pid,
    status: 'spawning',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    tmuxSession: sessionName,
    type: 'spec',
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Builder ${builderId} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
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

  logger.header(`Spawning Builder ${builderId} (task)`);
  logger.kv('Task', taskText.substring(0, 60) + (taskText.length > 60 ? '...' : ''));
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  if (options.files && options.files.length > 0) {
    logger.kv('Files', options.files.join(', '));
  }

  await ensureDirectories(config);
  await checkDependencies();
  await createWorktree(config, branchName, worktreePath);

  // Build the prompt
  let prompt = taskText;
  if (options.files && options.files.length > 0) {
    prompt += `\n\nRelevant files to consider:\n${options.files.map(f => `- ${f}`).join('\n')}`;
  }

  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition. ${prompt}`;

  // Load role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  const { port, pid, sessionName } = await startBuilderSession(
    config,
    builderId,
    worktreePath,
    commands.builder,
    builderPrompt,
    role?.content ?? null,
    role?.source ?? null,
  );

  const builder: Builder = {
    id: builderId,
    name: `Task: ${taskText.substring(0, 30)}${taskText.length > 30 ? '...' : ''}`,
    port,
    pid,
    status: 'spawning',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    tmuxSession: sessionName,
    type: 'task',
    taskText,
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Builder ${builderId} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
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

  logger.header(`Spawning Builder ${builderId} (protocol)`);
  logger.kv('Protocol', protocolName);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();
  await createWorktree(config, branchName, worktreePath);

  // Build the prompt
  const prompt = `You are running the ${protocolName} protocol. Start by reading codev/protocols/${protocolName}/protocol.md and follow its instructions.`;

  // Load protocol-specific role or fall back to builder role
  const role = options.noRole ? null : loadProtocolRole(config, protocolName);
  const commands = getResolvedCommands();

  const { port, pid, sessionName } = await startBuilderSession(
    config,
    builderId,
    worktreePath,
    commands.builder,
    prompt,
    role?.content ?? null,
    role?.source ?? null,
  );

  const builder: Builder = {
    id: builderId,
    name: `Protocol: ${protocolName}`,
    port,
    pid,
    status: 'spawning',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    tmuxSession: sessionName,
    type: 'protocol',
    protocolName,
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Builder ${builderId} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
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

  const { port, pid, sessionName } = await startShellSession(
    config,
    shortId,
    commands.builder,
  );

  // Shell sessions are tracked as builders with type 'shell'
  // They don't have worktrees or branches
  const builder: Builder = {
    id: shellId,
    name: 'Shell session',
    port,
    pid,
    status: 'spawning',
    phase: 'interactive',
    worktree: '',
    branch: '',
    tmuxSession: sessionName,
    type: 'shell',
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Shell ${shellId} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
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

  logger.header(`Spawning Worktree ${builderId}`);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();
  await createWorktree(config, branchName, worktreePath);

  // Load builder role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  // Worktree mode: launch Claude with no prompt, but in the worktree directory
  const port = await findFreePort(config);
  const sessionName = `builder-${builderId}`;

  logger.info('Creating tmux session...');

  // Build launch script (with role if provided) to avoid shell escaping issues
  const scriptPath = resolve(worktreePath, '.builder-start.sh');
  let scriptContent: string;

  if (role) {
    const roleFile = resolve(worktreePath, '.builder-role.md');
    writeFileSync(roleFile, role.content);
    logger.info(`Loaded role (${role.source})`);
    scriptContent = `#!/bin/bash
exec ${commands.builder} --append-system-prompt "$(cat '${roleFile}')"
`;
  } else {
    scriptContent = `#!/bin/bash
exec ${commands.builder}
`;
  }

  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

  // Create tmux session running the launch script
  await run(`tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${worktreePath}" "${scriptPath}"`);

  // Enable mouse scrolling in tmux
  await run('tmux set -g mouse on');
  await run('tmux set -g set-clipboard on');
  await run('tmux set -g allow-passthrough on');

  // Copy selection to clipboard when mouse is released (pbcopy for macOS)
  await run('tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');
  await run('tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');

  // Start ttyd
  logger.info('Starting worktree terminal...');
  const customIndexPath = resolve(config.codevDir, 'templates', 'ttyd-index.html');
  const ttydArgs = [
    '-W',
    '-p', String(port),
    '-t', 'theme={"background":"#000000"}',
    '-t', 'rightClickSelectsWord=true',  // Enable word selection on right-click for better UX
  ];

  if (existsSync(customIndexPath)) {
    ttydArgs.push('-I', customIndexPath);
    logger.info('Using custom terminal with file click support');
  }

  ttydArgs.push('tmux', 'attach-session', '-t', sessionName);

  const ttydProcess = spawnDetached('ttyd', ttydArgs, {
    cwd: worktreePath,
  });

  if (!ttydProcess.pid) {
    fatal('Failed to start ttyd process for worktree');
  }

  const builder: Builder = {
    id: builderId,
    name: 'Worktree session',
    port,
    pid: ttydProcess.pid,
    status: 'spawning',
    phase: 'interactive',
    worktree: worktreePath,
    branch: branchName,
    tmuxSession: sessionName,
    type: 'worktree',
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Worktree ${builderId} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
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
  const mode = getSpawnMode(options);

  switch (mode) {
    case 'spec':
      await spawnSpec(options, config);
      break;
    case 'task':
      await spawnTask(options, config);
      break;
    case 'protocol':
      await spawnProtocol(options, config);
      break;
    case 'shell':
      await spawnShell(options, config);
      break;
    case 'worktree':
      await spawnWorktree(options, config);
      break;
  }
}
