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
import { existsSync, readFileSync, writeFileSync, chmodSync, readdirSync, symlinkSync, mkdirSync, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { SpawnOptions, Builder, Config, BuilderType, ProtocolDefinition } from '../types.js';
import { getConfig, ensureDirectories, getResolvedCommands } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run, commandExists } from '../utils/shell.js';
import { loadState, upsertBuilder } from '../state.js';
import { loadRolePrompt } from '../utils/roles.js';

// Tower port — the single HTTP server since Spec 0090
const DEFAULT_TOWER_PORT = 4100;

// =============================================================================
// Template Rendering
// =============================================================================

/**
 * Context object for rendering builder-prompt.md templates
 */
interface TemplateContext {
  protocol_name: string;
  mode: 'strict' | 'soft';
  mode_soft: boolean;
  mode_strict: boolean;
  project_id?: string;
  input_description: string;
  spec?: {
    path: string;
    name: string;
  };
  plan?: {
    path: string;
    name: string;
  };
  issue?: {
    number: number;
    title: string;
    body: string;
  };
  task_text?: string;
}

/**
 * Simple Handlebars-like template renderer
 * Supports: {{variable}}, {{#if condition}}...{{/if}}, {{object.property}}
 */
function renderTemplate(template: string, context: TemplateContext): string {
  let result = template;

  // Process {{#if condition}}...{{/if}} blocks
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ifMatch = result.match(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/);
    if (!ifMatch) break;

    const [fullMatch, condition, content] = ifMatch;
    const value = getNestedValue(context, condition);
    result = result.replace(fullMatch, value ? content : '');
  }

  // Process {{variable}} and {{object.property}} substitutions
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
    const value = getNestedValue(context, path);
    if (value === undefined || value === null) return '';
    return String(value);
  });

  // Clean up any double newlines left from removed sections
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj: TemplateContext, path: string): unknown {
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Load builder-prompt.md template for a protocol
 */
function loadBuilderPromptTemplate(config: Config, protocolName: string): string | null {
  const templatePath = resolve(config.codevDir, 'protocols', protocolName, 'builder-prompt.md');
  if (existsSync(templatePath)) {
    return readFileSync(templatePath, 'utf-8');
  }
  return null;
}

/**
 * Build the prompt using protocol template or fallback to inline prompt
 */
function buildPromptFromTemplate(
  config: Config,
  protocolName: string,
  context: TemplateContext
): string {
  const template = loadBuilderPromptTemplate(config, protocolName);
  if (template) {
    logger.info(`Using template: protocols/${protocolName}/builder-prompt.md`);
    return renderTemplate(template, context);
  }
  // Fallback: no template found, return a basic prompt
  logger.debug(`No template found for ${protocolName}, using inline prompt`);
  return buildFallbackPrompt(protocolName, context);
}

/**
 * Build a fallback prompt when no template exists
 */
function buildFallbackPrompt(protocolName: string, context: TemplateContext): string {
  const modeInstructions = context.mode === 'strict'
    ? `## Mode: STRICT
Porch orchestrates your work. Run: \`porch next\` to get your next tasks.`
    : `## Mode: SOFT
You follow the protocol yourself. The architect monitors your work and verifies compliance.`;

  let prompt = `# ${protocolName.toUpperCase()} Builder (${context.mode} mode)

You are implementing ${context.input_description}.

${modeInstructions}

## Protocol
Follow the ${protocolName.toUpperCase()} protocol: \`codev/protocols/${protocolName}/protocol.md\`
Read and internalize the protocol before starting any work.
`;

  if (context.spec) {
    prompt += `\n## Spec\nRead the specification at: \`${context.spec.path}\`\n`;
  }

  if (context.plan) {
    prompt += `\n## Plan\nFollow the implementation plan at: \`${context.plan.path}\`\n`;
  }

  if (context.issue) {
    prompt += `\n## Issue #${context.issue.number}
**Title**: ${context.issue.title}

**Description**:
${context.issue.body || '(No description provided)'}
`;
  }

  if (context.task_text) {
    prompt += `\n## Task\n${context.task_text}\n`;
  }

  return prompt;
}

// =============================================================================
// Resume Context
// =============================================================================

/**
 * Build a resume notice to prepend to the builder prompt.
 * Tells the builder this is a resumed session and to check existing porch state.
 */
function buildResumeNotice(_projectId: string): string {
  return `## RESUME SESSION

This is a **resumed** builder session. A previous session was working in this worktree.

Start by running \`porch next\` to check your current state and get next tasks.
If porch state exists, continue from where the previous session left off.
If porch reports "not found", run \`porch init\` to re-initialize.
`;
}

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

// loadRolePrompt imported from ../utils/roles.js

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
 * Load and parse a protocol.json file
 */
function loadProtocol(config: Config, protocolName: string): ProtocolDefinition | null {
  const protocolJsonPath = resolve(config.codevDir, 'protocols', protocolName, 'protocol.json');
  if (!existsSync(protocolJsonPath)) {
    return null;
  }
  try {
    const content = readFileSync(protocolJsonPath, 'utf-8');
    return JSON.parse(content) as ProtocolDefinition;
  } catch {
    logger.warn(`Warning: Failed to parse ${protocolJsonPath}`);
    return null;
  }
}

/**
 * Resolve which protocol to use based on precedence:
 * 1. Explicit --protocol flag when used as override (with other input modes)
 * 2. Explicit --use-protocol flag (backwards compatibility)
 * 3. Spec file **Protocol**: header (for --project mode)
 * 4. Hardcoded defaults (spir for specs, bugfix for issues)
 */
async function resolveProtocol(options: SpawnOptions, config: Config): Promise<string> {
  // Count input modes to determine if --protocol is being used as override
  const inputModes = [
    options.project,
    options.task,
    options.shell,
    options.worktree,
    options.issue,
  ].filter(Boolean);
  const protocolAsOverride = options.protocol && inputModes.length > 0;

  // 1. --protocol as override always wins when combined with other input modes
  if (protocolAsOverride) {
    validateProtocol(config, options.protocol!);
    return options.protocol!.toLowerCase();
  }

  // 2. Explicit --use-protocol override (backwards compatibility)
  if (options.useProtocol) {
    validateProtocol(config, options.useProtocol);
    return options.useProtocol.toLowerCase();
  }

  // 3. For spec mode, check spec file header (preserves existing behavior)
  if (options.project) {
    const specFile = await findSpecFile(config.codevDir, options.project);
    if (specFile) {
      const specContent = readFileSync(specFile, 'utf-8');
      const match = specContent.match(/\*\*Protocol\*\*:\s*(\w+)/i);
      if (match) {
        const protocolFromSpec = match[1].toLowerCase();
        // Validate the protocol exists
        try {
          validateProtocol(config, protocolFromSpec);
          return protocolFromSpec;
        } catch {
          // If protocol from spec doesn't exist, fall through to defaults
          logger.warn(`Warning: Protocol "${match[1]}" from spec not found, using default`);
        }
      }
    }
  }

  // 4. Hardcoded defaults based on input type
  if (options.project) return 'spir';
  if (options.issue) return 'bugfix';
  // --protocol alone (not as override) uses the protocol name itself
  if (options.protocol) return options.protocol.toLowerCase();
  if (options.task) return 'spir';

  return 'spir';  // Final fallback
}

// Note: GitHubIssue interface is defined later in the file

/**
 * Resolve the builder mode (strict vs soft)
 * Precedence:
 * 1. Explicit --strict or --soft flags (always win)
 * 2. Protocol defaults from protocol.json
 * 3. Input type defaults (spec = strict, all others = soft)
 */
function resolveMode(
  options: SpawnOptions,
  protocol: ProtocolDefinition | null,
): 'strict' | 'soft' {
  // 1. Explicit flags always win
  if (options.strict && options.soft) {
    fatal('--strict and --soft are mutually exclusive');
  }
  if (options.strict) {
    return 'strict';
  }
  if (options.soft) {
    return 'soft';
  }

  // 2. Protocol defaults from protocol.json
  if (protocol?.defaults?.mode) {
    return protocol.defaults.mode;
  }

  // 3. Input type defaults: only spec mode defaults to strict
  if (options.project) {
    return 'strict';
  }

  // All other modes default to soft
  return 'soft';
}

/**
 * Execute pre-spawn hooks defined in protocol.json
 * Hooks are data-driven but reuse existing implementation logic
 */
async function executePreSpawnHooks(
  protocol: ProtocolDefinition | null,
  context: {
    issueNumber?: number;
    issue?: GitHubIssue;
    worktreePath?: string;
    force?: boolean;
    noComment?: boolean;
  }
): Promise<void> {
  if (!protocol?.hooks?.['pre-spawn']) return;

  const hooks = protocol.hooks['pre-spawn'];

  // collision-check: reuses existing checkBugfixCollisions() logic
  if (hooks['collision-check'] && context.issueNumber && context.issue && context.worktreePath) {
    await checkBugfixCollisions(context.issueNumber, context.worktreePath, context.issue, !!context.force);
  }

  // comment-on-issue: posts comment to GitHub issue
  if (hooks['comment-on-issue'] && context.issueNumber && !context.noComment) {
    const message = hooks['comment-on-issue'];
    logger.info('Commenting on issue...');
    try {
      await run(`gh issue comment ${context.issueNumber} --body "${message}"`);
    } catch {
      logger.warn('Warning: Failed to comment on issue (continuing anyway)');
    }
  }
}

/**
 * Check for required dependencies
 */
async function checkDependencies(): Promise<void> {
  if (!(await commandExists('git'))) {
    fatal('git not found');
  }
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

  // Symlink .env from project root into worktree (if it exists)
  const rootEnvPath = resolve(config.projectRoot, '.env');
  const worktreeEnvPath = resolve(worktreePath, '.env');
  if (existsSync(rootEnvPath) && !existsSync(worktreeEnvPath)) {
    try {
      symlinkSync(rootEnvPath, worktreeEnvPath);
      logger.info('Linked .env from project root');
    } catch (error) {
      logger.debug(`Failed to symlink .env: ${error}`);
    }
  }
}

/**
 * Create a terminal session via the Tower REST API.
 * The Tower server must be running (port 4100).
 */
async function createPtySession(
  config: Config,
  command: string,
  args: string[],
  cwd: string,
  registration?: { projectPath: string; type: 'builder' | 'shell'; roleId: string },
): Promise<{ terminalId: string }> {
  const body: Record<string, unknown> = { command, args, cwd, cols: 200, rows: 50, persistent: true };
  if (registration) {
    body.projectPath = registration.projectPath;
    body.type = registration.type;
    body.roleId = registration.roleId;
  }
  const response = await fetch(`http://localhost:${DEFAULT_TOWER_PORT}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create PTY session: ${response.status} ${text}`);
  }

  const result = await response.json() as { id: string };
  return { terminalId: result.id };
}

/**
 * Start a terminal session for a builder
 */
async function startBuilderSession(
  config: Config,
  builderId: string,
  worktreePath: string,
  baseCmd: string,
  prompt: string,
  roleContent: string | null,
  roleSource: string | null,
): Promise<{ terminalId: string }> {
  logger.info('Creating terminal session...');

  // Write initial prompt to a file for reference
  const promptFile = resolve(worktreePath, '.builder-prompt.txt');
  writeFileSync(promptFile, prompt);

  // Build the start script with role if provided
  const scriptPath = resolve(worktreePath, '.builder-start.sh');
  let scriptContent: string;

  if (roleContent) {
    // Write role to a file and use $(cat) to avoid shell escaping issues
    const roleFile = resolve(worktreePath, '.builder-role.md');
    // Inject the actual dashboard port into the role prompt
    const roleWithPort = roleContent.replace(/\{PORT\}/g, String(DEFAULT_TOWER_PORT));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${roleSource})`);
    scriptContent = `#!/bin/bash
cd "${worktreePath}"
while true; do
  ${baseCmd} --append-system-prompt "$(cat '${roleFile}')" "$(cat '${promptFile}')"
  echo ""
  echo "Claude exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
  } else {
    scriptContent = `#!/bin/bash
cd "${worktreePath}"
while true; do
  ${baseCmd} "$(cat '${promptFile}')"
  echo ""
  echo "Claude exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
  }

  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, '755');

  // Create PTY session via Tower REST API (shepherd for persistence)
  logger.info('Creating PTY terminal session...');
  const { terminalId } = await createPtySession(
    config,
    '/bin/bash',
    [scriptPath],
    worktreePath,
    { projectPath: config.projectRoot, type: 'builder', roleId: builderId },
  );
  logger.info(`Terminal session created: ${terminalId}`);
  return { terminalId };
}

/**
 * Start a shell session (no worktree, just node-pty)
 */
async function startShellSession(
  config: Config,
  shellId: string,
  baseCmd: string,
): Promise<{ terminalId: string }> {
  // Create PTY session via REST API
  logger.info('Creating PTY terminal session for shell...');
  const { terminalId } = await createPtySession(
    config,
    '/bin/bash',
    ['-c', baseCmd],
    config.projectRoot,
    { projectPath: config.projectRoot, type: 'shell', roleId: shellId },
  );
  logger.info(`Shell terminal session created: ${terminalId}`);
  return { terminalId };
}

/**
 * Pre-initialize porch in a worktree so the builder doesn't need to self-correct.
 * Non-fatal: logs a warning on failure since the builder can still init manually.
 */
async function initPorchInWorktree(
  worktreePath: string,
  protocol: string,
  projectId: string,
  projectName: string,
): Promise<void> {
  logger.info('Initializing porch...');
  try {
    // Sanitize inputs to prevent shell injection (defense-in-depth;
    // callers already use slugified names, but be safe)
    const safeName = projectName.replace(/[^a-z0-9_-]/gi, '-');
    const safeProto = protocol.replace(/[^a-z0-9_-]/gi, '');
    const safeId = projectId.replace(/[^a-z0-9_-]/gi, '');
    await run(`porch init ${safeProto} ${safeId} "${safeName}"`, { cwd: worktreePath });
    logger.info(`Porch initialized: ${projectId}`);
  } catch (error) {
    logger.warn(`Warning: Failed to initialize porch (builder can init manually): ${error}`);
  }
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
    if (!existsSync(worktreePath)) {
      fatal(`Cannot resume: worktree does not exist at ${worktreePath}`);
    }
    if (!existsSync(resolve(worktreePath, '.git'))) {
      fatal(`Cannot resume: ${worktreePath} is not a valid git worktree`);
    }
    logger.info('Resuming existing worktree (skipping creation)');
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  // Resolve protocol using precedence: --use-protocol > spec header > default
  const protocol = await resolveProtocol(options, config);
  const protocolPath = `codev/protocols/${protocol}/protocol.md`;

  // Load protocol definition for potential hooks/config
  const protocolDef = loadProtocol(config, protocol);

  // Resolve mode: --soft flag > protocol defaults > input type defaults
  const mode = resolveMode(options, protocolDef);

  logger.kv('Protocol', protocol.toUpperCase());
  logger.kv('Mode', mode.toUpperCase());

  // Pre-initialize porch so the builder doesn't need to figure out project ID
  if (!options.resume) {
    const porchProjectName = specName.replace(new RegExp(`^${projectId}-`), '');
    await initPorchInWorktree(worktreePath, protocol, projectId, porchProjectName);
  }

  // Build the prompt using template
  const specRelPath = `codev/specs/${specName}.md`;
  const planRelPath = `codev/plans/${specName}.md`;

  const templateContext: TemplateContext = {
    protocol_name: protocol.toUpperCase(),
    mode,
    mode_soft: mode === 'soft',
    mode_strict: mode === 'strict',
    project_id: projectId,
    input_description: `the feature specified in ${specRelPath}`,
    spec: { path: specRelPath, name: specName },
  };

  if (hasPlan) {
    templateContext.plan = { path: planRelPath, name: specName };
  }

  const initialPrompt = buildPromptFromTemplate(config, protocol, templateContext);
  const resumeNotice = options.resume ? `\n${buildResumeNotice(projectId)}\n` : '';
  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.
${resumeNotice}
${initialPrompt}`;

  // Load role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  const { terminalId } = await startBuilderSession(
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
    status: 'implementing',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    type: 'spec',
    terminalId,
  };

  upsertBuilder(builder);

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
    if (!existsSync(worktreePath)) {
      fatal(`Cannot resume: worktree does not exist at ${worktreePath}`);
    }
    if (!existsSync(resolve(worktreePath, '.git'))) {
      fatal(`Cannot resume: ${worktreePath} is not a valid git worktree`);
    }
    logger.info('Resuming existing worktree (skipping creation)');
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  // Build the prompt — only include protocol if explicitly requested
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
      protocol_name: protocol.toUpperCase(),
      mode,
      mode_soft: mode === 'soft',
      mode_strict: mode === 'strict',
      project_id: builderId,
      input_description: 'an ad-hoc task',
      task_text: taskDescription,
    };

    const prompt = buildPromptFromTemplate(config, protocol, templateContext);
    builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n${resumeNotice}\n${prompt}`;
  } else {
    builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.
${resumeNotice}
# Task

${taskDescription}`;
  }

  // Load role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  const { terminalId } = await startBuilderSession(
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
    status: 'implementing',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    type: 'task',
    taskText,
    terminalId,
  };

  upsertBuilder(builder);

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
    if (!existsSync(worktreePath)) {
      fatal(`Cannot resume: worktree does not exist at ${worktreePath}`);
    }
    if (!existsSync(resolve(worktreePath, '.git'))) {
      fatal(`Cannot resume: ${worktreePath} is not a valid git worktree`);
    }
    logger.info('Resuming existing worktree (skipping creation)');
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  // Load protocol definition and resolve mode
  const protocolDef = loadProtocol(config, protocolName);
  const mode = resolveMode(options, protocolDef);

  logger.kv('Mode', mode.toUpperCase());

  // Build the prompt using template
  const templateContext: TemplateContext = {
    protocol_name: protocolName.toUpperCase(),
    mode,
    mode_soft: mode === 'soft',
    mode_strict: mode === 'strict',
    project_id: builderId,
    input_description: `running the ${protocolName.toUpperCase()} protocol`,
  };

  const promptContent = buildPromptFromTemplate(config, protocolName, templateContext);
  const resumeNotice = options.resume ? `\n${buildResumeNotice(builderId)}\n` : '';
  const prompt = resumeNotice ? `${resumeNotice}\n${promptContent}` : promptContent;

  // Load protocol-specific role or fall back to builder role
  const role = options.noRole ? null : loadProtocolRole(config, protocolName);
  const commands = getResolvedCommands();

  const { terminalId } = await startBuilderSession(
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
    status: 'implementing',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    type: 'protocol',
    protocolName,
    terminalId,
  };

  upsertBuilder(builder);

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

  const { terminalId } = await startShellSession(
    config,
    shortId,
    commands.builder,
  );

  // Shell sessions are tracked as builders with type 'shell'
  // They don't have worktrees or branches
  const builder: Builder = {
    id: shellId,
    name: 'Shell session',
    status: 'implementing',
    phase: 'interactive',
    worktree: '',
    branch: '',
    type: 'shell',
    terminalId,
  };

  upsertBuilder(builder);

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
    if (!existsSync(worktreePath)) {
      fatal(`Cannot resume: worktree does not exist at ${worktreePath}`);
    }
    if (!existsSync(resolve(worktreePath, '.git'))) {
      fatal(`Cannot resume: ${worktreePath} is not a valid git worktree`);
    }
    logger.info('Resuming existing worktree (skipping creation)');
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  // Load builder role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  // Worktree mode: launch Claude with no prompt, but in the worktree directory
  logger.info('Creating terminal session...');

  // Build launch script (with role if provided) to avoid shell escaping issues
  const scriptPath = resolve(worktreePath, '.builder-start.sh');
  let scriptContent: string;

  if (role) {
    const roleFile = resolve(worktreePath, '.builder-role.md');
    // Inject the actual dashboard port into the role prompt
    const roleWithPort = role.content.replace(/\{PORT\}/g, String(DEFAULT_TOWER_PORT));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${role.source})`);
    scriptContent = `#!/bin/bash
cd "${worktreePath}"
while true; do
  ${commands.builder} --append-system-prompt "$(cat '${roleFile}')"
  echo ""
  echo "Claude exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
  } else {
    scriptContent = `#!/bin/bash
cd "${worktreePath}"
while true; do
  ${commands.builder}
  echo ""
  echo "Claude exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
  }

  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

  // Create PTY session via REST API
  logger.info('Creating PTY terminal session for worktree...');
  const { terminalId: worktreeTerminalId } = await createPtySession(
    config,
    '/bin/bash',
    [scriptPath],
    worktreePath,
    { projectPath: config.projectRoot, type: 'builder', roleId: builderId },
  );
  logger.info(`Worktree terminal session created: ${worktreeTerminalId}`);

  const builder: Builder = {
    id: builderId,
    name: 'Worktree session',
    status: 'implementing',
    phase: 'interactive',
    worktree: worktreePath,
    branch: branchName,
    type: 'worktree',
    terminalId: worktreeTerminalId,
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Worktree ${builderId} spawned!`);
  logger.kv('Terminal', `ws://localhost:${DEFAULT_TOWER_PORT}/ws/terminal/${worktreeTerminalId}`);
}

/**
 * Generate a slug from an issue title (max 30 chars, lowercase, alphanumeric + hyphens)
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with hyphens
    .replace(/-+/g, '-')          // Collapse multiple hyphens
    .replace(/^-|-$/g, '')        // Trim leading/trailing hyphens
    .slice(0, 30);                // Max 30 chars
}

/**
 * GitHub issue structure from gh issue view --json
 */
interface GitHubIssue {
  title: string;
  body: string;
  state: string;
  comments: Array<{
    body: string;
    createdAt: string;
    author: { login: string };
  }>;
}

/**
 * Fetch a GitHub issue via gh CLI
 */
async function fetchGitHubIssue(issueNumber: number): Promise<GitHubIssue> {
  try {
    const result = await run(`gh issue view ${issueNumber} --json title,body,state,comments`);
    return JSON.parse(result.stdout);
  } catch (error) {
    fatal(`Failed to fetch issue #${issueNumber}. Ensure 'gh' CLI is installed and authenticated.`);
    throw error; // TypeScript doesn't know fatal() never returns
  }
}

/**
 * Check for collision conditions before spawning bugfix
 */
async function checkBugfixCollisions(
  issueNumber: number,
  worktreePath: string,
  issue: GitHubIssue,
  force: boolean,
): Promise<void> {
  // 1. Check if worktree already exists
  if (existsSync(worktreePath)) {
    fatal(`Worktree already exists at ${worktreePath}\nRun: af cleanup --issue ${issueNumber}`);
  }

  // 2. Check for recent "On it" comments (< 24h old)
  const onItComments = issue.comments.filter((c) =>
    c.body.toLowerCase().includes('on it'),
  );
  if (onItComments.length > 0) {
    const lastComment = onItComments[onItComments.length - 1];
    const age = Date.now() - new Date(lastComment.createdAt).getTime();
    const hoursAgo = Math.round(age / (1000 * 60 * 60));

    if (hoursAgo < 24) {
      if (!force) {
        fatal(`Issue #${issueNumber} has "On it" comment from ${hoursAgo}h ago (by @${lastComment.author.login}).\nSomeone may already be working on this. Use --force to override.`);
      }
      logger.warn(`Warning: "On it" comment from ${hoursAgo}h ago - proceeding with --force`);
    } else {
      logger.warn(`Warning: Stale "On it" comment (${hoursAgo}h ago). Proceeding.`);
    }
  }

  // 3. Check for open PRs referencing this issue
  try {
    const prResult = await run(`gh pr list --search "in:body #${issueNumber}" --json number,title --limit 5`);
    const openPRs = JSON.parse(prResult.stdout);
    if (openPRs.length > 0) {
      if (!force) {
        const prList = openPRs.map((pr: { number: number; title: string }) => `  - PR #${pr.number}: ${pr.title}`).join('\n');
        fatal(`Found ${openPRs.length} open PR(s) referencing issue #${issueNumber}:\n${prList}\nUse --force to proceed anyway.`);
      }
      logger.warn(`Warning: Found ${openPRs.length} open PR(s) referencing issue - proceeding with --force`);
    }
  } catch {
    // Non-fatal: continue if PR check fails
  }

  // 4. Warn if issue is already closed
  if (issue.state === 'CLOSED') {
    logger.warn(`Warning: Issue #${issueNumber} is already closed`);
  }
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

  // Resolve protocol (allows --use-protocol override)
  const protocol = await resolveProtocol(options, config);
  const protocolDef = loadProtocol(config, protocol);

  // Resolve mode: --soft flag > protocol defaults > input type defaults (bugfix defaults to soft)
  const mode = resolveMode(options, protocolDef);

  logger.kv('Title', issue.title);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);
  logger.kv('Protocol', protocol.toUpperCase());
  logger.kv('Mode', mode.toUpperCase());

  // Execute pre-spawn hooks from protocol.json (collision check, issue comment)
  // Skip collision checks in resume mode — the worktree is expected to exist
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
    if (!existsSync(worktreePath)) {
      fatal(`Cannot resume: worktree does not exist at ${worktreePath}`);
    }
    if (!existsSync(resolve(worktreePath, '.git'))) {
      fatal(`Cannot resume: ${worktreePath} is not a valid git worktree`);
    }
    logger.info('Resuming existing worktree (skipping creation)');
  } else {
    await createWorktree(config, branchName, worktreePath);

    // Pre-initialize porch so the builder doesn't need to figure out project ID
    await initPorchInWorktree(worktreePath, protocol, builderId, slug);
  }

  // Build the prompt using template
  const templateContext: TemplateContext = {
    protocol_name: protocol.toUpperCase(),
    mode,
    mode_soft: mode === 'soft',
    mode_strict: mode === 'strict',
    project_id: builderId,
    input_description: `a fix for GitHub Issue #${issueNumber}`,
    issue: {
      number: issueNumber,
      title: issue.title,
      body: issue.body || '(No description provided)',
    },
  };

  const prompt = buildPromptFromTemplate(config, protocol, templateContext);
  const resumeNotice = options.resume ? `\n${buildResumeNotice(builderId)}\n` : '';
  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n${resumeNotice}\n${prompt}`;

  // Load role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  const { terminalId } = await startBuilderSession(
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
    name: `Bugfix #${issueNumber}: ${issue.title.substring(0, 40)}${issue.title.length > 40 ? '...' : ''}`,
    status: 'implementing',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    type: 'bugfix',
    issueNumber,
    terminalId,
  };

  upsertBuilder(builder);

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
      const { stdout } = await run('git status --porcelain', { cwd: config.projectRoot });
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
    await run('git worktree prune', { cwd: config.projectRoot });
  } catch {
    // Non-fatal - continue with spawn even if prune fails
  }

  const mode = getSpawnMode(options);

  switch (mode) {
    case 'spec':
      await spawnSpec(options, config);
      break;
    case 'bugfix':
      await spawnBugfix(options, config);
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
