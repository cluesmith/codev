/**
 * consult - AI consultation with external models
 *
 * Provides unified interface to gemini-cli, codex, and Claude Agent SDK.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import chalk from 'chalk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { resolveCodevFile, readCodevFile, findProjectRoot, hasLocalOverride } from '../../lib/skeleton.js';

// Model configuration
interface ModelConfig {
  cli: string;
  args: string[];
  envVar: string | null;
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  gemini: { cli: 'gemini', args: ['--yolo'], envVar: 'GEMINI_SYSTEM_MD' },
  // Codex uses experimental_instructions_file config flag (not env var)
  // See: https://github.com/openai/codex/discussions/3896
  codex: { cli: 'codex', args: ['exec', '-m', 'gpt-5.2-codex', '--full-auto'], envVar: null },
};

// Models that use the Agent SDK instead of CLI subprocess
const SDK_MODELS = ['claude'];

// Model aliases
const MODEL_ALIASES: Record<string, string> = {
  pro: 'gemini',
  gpt: 'codex',
  opus: 'claude',
};

interface ConsultOptions {
  model: string;
  subcommand: string;
  args: string[];
  dryRun?: boolean;
  reviewType?: string;
  role?: string;
  output?: string;
  planPhase?: string;
}

// Valid review types
const VALID_REVIEW_TYPES = [
  'spec-review',
  'plan-review',
  'impl-review',
  'pr-ready',
  'integration-review',
];

/**
 * Validate role name to prevent directory traversal attacks.
 * Only allows alphanumeric, hyphen, and underscore characters.
 */
function isValidRoleName(roleName: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(roleName);
}

/**
 * List available roles in codev/roles/
 * Excludes non-role files like README.md, review-types/, etc.
 */
function listAvailableRoles(projectRoot: string): string[] {
  const rolesDir = path.join(projectRoot, 'codev', 'roles');
  if (!fs.existsSync(rolesDir)) return [];

  const excludePatterns = ['readme', 'review-types', 'overview', 'index'];

  return fs.readdirSync(rolesDir)
    .filter(f => {
      if (!f.endsWith('.md')) return false;
      const basename = f.replace('.md', '').toLowerCase();
      return !excludePatterns.some(pattern => basename.includes(pattern));
    })
    .map(f => f.replace('.md', ''));
}

/**
 * Load a custom role from codev/roles/<name>.md
 * Falls back to embedded skeleton if not found locally.
 */
function loadCustomRole(projectRoot: string, roleName: string): string {
  // Validate role name to prevent directory traversal
  if (!isValidRoleName(roleName)) {
    throw new Error(
      `Invalid role name: '${roleName}'\n` +
      'Role names can only contain letters, numbers, hyphens, and underscores.'
    );
  }

  // Use readCodevFile which handles local-first with skeleton fallback
  const rolePath = `roles/${roleName}.md`;
  const roleContent = readCodevFile(rolePath, projectRoot);

  if (!roleContent) {
    const available = listAvailableRoles(projectRoot);
    const availableStr = available.length > 0
      ? `\n\nAvailable roles:\n${available.map(r => `  - ${r}`).join('\n')}`
      : '\n\nNo custom roles found in codev/roles/';
    throw new Error(
      `Role '${roleName}' not found.${availableStr}`
    );
  }

  return roleContent;
}

/**
 * Load the consultant role.
 * Checks local codev/roles/consultant.md first, then falls back to embedded skeleton.
 */
function loadRole(projectRoot: string): string {
  const role = readCodevFile('roles/consultant.md', projectRoot);
  if (!role) {
    throw new Error(
      'consultant.md not found.\n' +
      'Checked: local codev/roles/consultant.md and embedded skeleton.\n' +
      'Run from a codev-enabled project or install @cluesmith/codev globally.'
    );
  }
  return role;
}

/**
 * Load a review type prompt.
 * Checks consult-types/{type}.md first (new location),
 * then falls back to roles/review-types/{type}.md (deprecated) with a warning.
 */
function loadReviewTypePrompt(projectRoot: string, reviewType: string): string | null {
  const primaryPath = `consult-types/${reviewType}.md`;
  const fallbackPath = `roles/review-types/${reviewType}.md`;

  // 1. Check LOCAL consult-types/ first (preferred location)
  if (hasLocalOverride(primaryPath, projectRoot)) {
    return readCodevFile(primaryPath, projectRoot);
  }

  // 2. Check LOCAL roles/review-types/ (deprecated location with warning)
  if (hasLocalOverride(fallbackPath, projectRoot)) {
    console.error(chalk.yellow('Warning: Review types in roles/review-types/ are deprecated.'));
    console.error(chalk.yellow('Move your custom types to consult-types/ for future compatibility.'));
    return readCodevFile(fallbackPath, projectRoot);
  }

  // 3. Fall back to embedded skeleton consult-types/ (default)
  const skeletonPrompt = readCodevFile(primaryPath, projectRoot);
  if (skeletonPrompt) {
    return skeletonPrompt;
  }

  return null;
}

/**
 * Load .env file if it exists
 */
function loadDotenv(projectRoot: string): void {
  const envFile = path.join(projectRoot, '.env');
  if (!fs.existsSync(envFile)) return;

  const content = fs.readFileSync(envFile, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Only set if not already in environment
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

/**
 * Find a spec file by number
 */
function findSpec(projectRoot: string, number: number): string | null {
  const specsDir = path.join(projectRoot, 'codev', 'specs');
  const pattern = String(number).padStart(4, '0');

  if (fs.existsSync(specsDir)) {
    const files = fs.readdirSync(specsDir);
    for (const file of files) {
      if (file.startsWith(pattern) && file.endsWith('.md')) {
        return path.join(specsDir, file);
      }
    }
  }
  return null;
}

/**
 * Find a plan file by number
 */
function findPlan(projectRoot: string, number: number): string | null {
  const plansDir = path.join(projectRoot, 'codev', 'plans');
  const pattern = String(number).padStart(4, '0');

  if (fs.existsSync(plansDir)) {
    const files = fs.readdirSync(plansDir);
    for (const file of files) {
      if (file.startsWith(pattern) && file.endsWith('.md')) {
        return path.join(plansDir, file);
      }
    }
  }
  return null;
}

/**
 * Log query to history file
 */
function logQuery(projectRoot: string, model: string, query: string, duration?: number): void {
  try {
    const logDir = path.join(projectRoot, '.consult');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFile = path.join(logDir, 'history.log');
    const timestamp = new Date().toISOString();
    const queryPreview = query.substring(0, 100).replace(/\n/g, ' ');
    const durationStr = duration !== undefined ? ` duration=${duration.toFixed(1)}s` : '';

    fs.appendFileSync(logFile, `${timestamp} model=${model}${durationStr} query=${queryPreview}...\n`);
  } catch {
    // Logging failure should not block consultation
  }
}

/**
 * Check if a command exists
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run Claude consultation via Agent SDK.
 * Uses the SDK's query() function instead of CLI subprocess.
 * This avoids the CLAUDECODE nesting guard and enables tool use during reviews.
 */
async function runClaudeConsultation(
  queryText: string,
  role: string,
  projectRoot: string,
  outputPath?: string,
): Promise<void> {
  const chunks: string[] = [];

  // The SDK spawns a Claude Code subprocess that checks process.env.CLAUDECODE.
  // We must remove it from process.env (not just the options env) to avoid
  // the nesting guard. Restore it after the SDK call.
  const savedClaudeCode = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  try {
    const session = claudeQuery({
      prompt: queryText,
      options: {
        systemPrompt: role,
        allowedTools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        model: 'claude-opus-4-6',
        maxTurns: 10,
        maxBudgetUsd: 1.00,
        cwd: projectRoot,
        env,
      },
    });

    for await (const message of session) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block) {
            process.stdout.write(block.text);
            chunks.push(block.text);
          } else if ('name' in block) {
            // Tool use block — show tool name + input summary on stderr
            const input = 'input' in block ? block.input : {};
            const detail = typeof input === 'object' && input !== null
              ? (input as Record<string, unknown>).file_path || (input as Record<string, unknown>).pattern || (input as Record<string, unknown>).path || ''
              : '';
            const summary = detail ? `: ${detail}` : '';
            process.stderr.write(chalk.dim(`[Tool: ${block.name}${summary}]\n`));
          }
        }
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success') {
          const errors = 'errors' in message ? (message as { errors: string[] }).errors : [];
          throw new Error(`Claude SDK error (${message.subtype}): ${errors.join(', ')}`);
        }
      }
    }

    if (outputPath) {
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outputPath, chunks.join(''));
      console.error(`\nOutput written to: ${outputPath}`);
    }
  } finally {
    if (savedClaudeCode !== undefined) {
      process.env.CLAUDECODE = savedClaudeCode;
    }
  }
}

/**
 * Run the consultation
 */
async function runConsultation(
  model: string,
  query: string,
  projectRoot: string,
  dryRun: boolean,
  reviewType?: string,
  customRole?: string,
  outputPath?: string,
): Promise<void> {
  // Use custom role if specified, otherwise use default consultant role
  let role = customRole ? loadCustomRole(projectRoot, customRole) : loadRole(projectRoot);

  // Append review type prompt if specified
  if (reviewType) {
    const typePrompt = loadReviewTypePrompt(projectRoot, reviewType);
    if (typePrompt) {
      role = role + '\n\n---\n\n' + typePrompt;
      console.error(`Review type: ${reviewType}`);
    } else {
      console.error(chalk.yellow(`Warning: Review type prompt not found: ${reviewType}`));
    }
  }

  // Claude uses the Agent SDK — handle separately from CLI-based models
  if (model === 'claude') {
    if (dryRun) {
      console.log(chalk.yellow(`[claude] Would invoke Agent SDK:`));
      console.log(`  Model: claude-opus-4-6`);
      console.log(`  Tools: Read, Glob, Grep`);
      console.log(`  Max turns: 10`);
      console.log(`  Max budget: $1.00`);
      const promptPreview = query.substring(0, 200) + (query.length > 200 ? '...' : '');
      console.log(`  Prompt: ${promptPreview}`);
      return;
    }

    const startTime = Date.now();
    await runClaudeConsultation(query, role, projectRoot, outputPath);
    const duration = (Date.now() - startTime) / 1000;
    logQuery(projectRoot, model, query, duration);
    console.error(`\n[${model} completed in ${duration.toFixed(1)}s]`);
    return;
  }

  const config = MODEL_CONFIGS[model];

  if (!config) {
    throw new Error(`Unknown model: ${model}`);
  }

  // Check if CLI exists (skip for dry-run mode)
  if (!dryRun && !commandExists(config.cli)) {
    throw new Error(`${config.cli} not found. Please install it first.`);
  }

  let tempFile: string | null = null;
  const env: Record<string, string> = {};

  // Prepare command and environment based on model
  let cmd: string[];

  if (model === 'gemini') {
    // Gemini uses GEMINI_SYSTEM_MD env var for role
    tempFile = path.join(tmpdir(), `codev-role-${Date.now()}.md`);
    fs.writeFileSync(tempFile, role);
    env['GEMINI_SYSTEM_MD'] = tempFile;

    cmd = [config.cli, ...config.args, query];
  } else if (model === 'codex') {
    // Codex uses experimental_instructions_file config flag (not env var)
    // This is the official approach per https://github.com/openai/codex/discussions/3896
    tempFile = path.join(tmpdir(), `codev-role-${Date.now()}.md`);
    fs.writeFileSync(tempFile, role);
    cmd = [
      config.cli,
      'exec',
      '-c', `experimental_instructions_file=${tempFile}`,
      '-c', 'model_reasoning_effort=low', // Faster responses (10-20% improvement)
      '--full-auto',
      query,
    ];
  } else {
    throw new Error(`Unknown model: ${model}`);
  }

  if (dryRun) {
    console.log(chalk.yellow(`[${model}] Would execute:`));
    console.log(`  Command: ${cmd.join(' ')}`);
    if (Object.keys(env).length > 0) {
      for (const [key, value] of Object.entries(env)) {
        if (key === 'GEMINI_SYSTEM_MD') {
          console.log(`  Env: ${key}=<temp file with consultant role>`);
        } else {
          const preview = value.substring(0, 50) + (value.length > 50 ? '...' : '');
          console.log(`  Env: ${key}=${preview}`);
        }
      }
    }
    if (tempFile) fs.unlinkSync(tempFile);
    return;
  }

  // Execute with passthrough stdio
  // Use 'ignore' for stdin to prevent blocking when spawned as subprocess
  // When outputPath is set, capture stdout to write to file (used by porch)
  const fullEnv = { ...process.env, ...env };
  const startTime = Date.now();
  const stdoutMode = outputPath ? 'pipe' : 'inherit';

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      env: fullEnv,
      stdio: ['ignore', stdoutMode, 'inherit'],
    });

    const chunks: Buffer[] = [];
    if (outputPath && proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        // Also write to stdout so the user can still see output
        process.stdout.write(chunk);
      });
    }

    proc.on('close', (code) => {
      const duration = (Date.now() - startTime) / 1000;
      logQuery(projectRoot, model, query, duration);

      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }

      // Write captured output to file
      if (outputPath && chunks.length > 0) {
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        fs.writeFileSync(outputPath, Buffer.concat(chunks).toString('utf-8'));
        console.error(`\nOutput written to: ${outputPath}`);
      }

      console.error(`\n[${model} completed in ${duration.toFixed(1)}s]`);

      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}`));
      } else {
        resolve();
      }
    });

    proc.on('error', (error) => {
      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
      reject(error);
    });
  });
}

/**
 * Fetch PR data and return it inline
 */
function fetchPRData(prNumber: number): { info: string; diff: string; comments: string } {
  console.error(`Fetching PR #${prNumber} data...`);

  try {
    const info = execSync(`gh pr view ${prNumber} --json title,body,state,author,baseRefName,headRefName,files,additions,deletions`, { encoding: 'utf-8' });
    const diff = execSync(`gh pr diff ${prNumber}`, { encoding: 'utf-8' });

    let comments = '(No comments)';
    try {
      comments = execSync(`gh pr view ${prNumber} --comments`, { encoding: 'utf-8' });
    } catch {
      // No comments or error fetching
    }

    return { info, diff, comments };
  } catch (err) {
    throw new Error(`Failed to fetch PR data: ${err}`);
  }
}

/**
 * Build query for PR review
 */
function buildPRQuery(prNumber: number, _projectRoot: string): string {
  const prData = fetchPRData(prNumber);

  // Truncate diff if too large (keep first 50k chars)
  const maxDiffSize = 50000;
  const diff = prData.diff.length > maxDiffSize
    ? prData.diff.substring(0, maxDiffSize) + '\n\n... (diff truncated, ' + prData.diff.length + ' chars total)'
    : prData.diff;

  return `Review Pull Request #${prNumber}

## PR Info
\`\`\`json
${prData.info}
\`\`\`

## Diff
\`\`\`diff
${diff}
\`\`\`

## Comments
${prData.comments}

---

Please review:
1. Code quality and correctness
2. Alignment with spec/plan (if provided)
3. Test coverage and quality
4. Edge cases and error handling
5. Documentation and comments
6. Any security concerns

End your review with a verdict in this EXACT format:

---
VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary of your review]
CONFIDENCE: [HIGH | MEDIUM | LOW]
---

KEY_ISSUES: [List of critical issues if any, or "None"]`;
}

/**
 * Build query for spec review
 */
function buildSpecQuery(specPath: string, planPath: string | null): string {
  let query = `Review Specification: ${path.basename(specPath)}

Please read and review this specification:
- Spec file: ${specPath}
`;

  if (planPath) {
    query += `- Plan file: ${planPath}\n`;
  }

  query += `
Please review:
1. Clarity and completeness of requirements
2. Technical feasibility
3. Edge cases and error scenarios
4. Security considerations
5. Testing strategy
6. Any ambiguities or missing details

End your review with a verdict in this EXACT format:

---
VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary of your review]
CONFIDENCE: [HIGH | MEDIUM | LOW]
---

KEY_ISSUES: [List of critical issues if any, or "None"]`;

  return query;
}

/**
 * Build query for implementation review
 */
function buildImplQuery(projectNumber: number, projectRoot: string, planPhase?: string): string {
  const specPath = findSpec(projectRoot, projectNumber);
  const planPath = findPlan(projectRoot, projectNumber);

  // Compute diff against base branch for focused review
  let diff = '';
  try {
    // Find merge base with main to get only this branch's changes
    const mergeBase = execSync('git merge-base HEAD main', { cwd: projectRoot, encoding: 'utf-8' }).trim();
    diff = execSync(`git diff ${mergeBase}..HEAD`, { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
    // Truncate large diffs
    const maxDiffSize = 80000;
    if (diff.length > maxDiffSize) {
      diff = diff.substring(0, maxDiffSize) + `\n\n... (diff truncated, ${diff.length} chars total)`;
    }
  } catch {
    // If git diff fails, fall back to filesystem exploration
    diff = '';
  }

  let query = `Review Implementation for Project ${projectNumber}`;
  if (planPhase) {
    query += ` — Phase: ${planPhase}`;
  }

  query += `\n\n## Context Files\n`;

  if (specPath) {
    query += `- Spec: ${specPath}\n`;
  }
  if (planPath) {
    query += `- Plan: ${planPath}\n`;
  }

  if (planPhase) {
    query += `\n## REVIEW SCOPE — CURRENT PLAN PHASE ONLY\n`;
    query += `You are reviewing **plan phase "${planPhase}" ONLY**.\n`;
    query += `Read the plan, find the section for "${planPhase}", and scope your review to ONLY the work described in that phase.\n\n`;
    query += `**DO NOT** request changes for work that belongs to other plan phases.\n`;
    query += `**DO NOT** flag missing functionality that is scheduled for a later phase.\n`;
    query += `**DO** verify that this phase's deliverables are complete and correct.\n`;
  }

  if (diff) {
    query += `\n## Diff (branch changes vs main)\n\nReview the following diff. This is the ONLY code that changed — focus your review on these changes. You may read the spec and plan files for context, but do NOT explore the broader codebase.\n\n\`\`\`diff\n${diff}\n\`\`\`\n`;
  } else {
    query += `\n## Instructions\n\nRead the spec and plan files above, then review the implementation changes.\n`;
  }

  query += `
Please review:
1. **Spec Adherence**: Does the code fulfill the spec requirements${planPhase ? ' for this phase' : ''}?
2. **Code Quality**: Is the code readable, maintainable, and bug-free?
3. **Test Coverage**: Are there adequate tests for the changes${planPhase ? ' in this phase' : ''}?
4. **Error Handling**: Are edge cases and errors handled properly?
5. **Plan Alignment**: Does the implementation follow the plan${planPhase ? ` for phase "${planPhase}"` : ''}?

End your review with a verdict in this EXACT format:

---
VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary of your review]
CONFIDENCE: [HIGH | MEDIUM | LOW]
---

KEY_ISSUES: [List of critical issues if any, or "None"]`;

  return query;
}

/**
 * Build query for plan review
 */
function buildPlanQuery(planPath: string, specPath: string | null): string {
  let query = `Review Implementation Plan: ${path.basename(planPath)}

Please read and review this implementation plan:
- Plan file: ${planPath}
`;

  if (specPath) {
    query += `- Spec file: ${specPath} (for context)\n`;
  }

  query += `
Please review:
1. Alignment with specification requirements
2. Implementation approach and architecture
3. Task breakdown and ordering
4. Risk identification and mitigation
5. Testing strategy
6. Any missing steps or considerations

End your review with a verdict in this EXACT format:

---
VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary of your review]
CONFIDENCE: [HIGH | MEDIUM | LOW]
---

KEY_ISSUES: [List of critical issues if any, or "None"]`;

  return query;
}

/**
 * Main consult entry point
 */
export async function consult(options: ConsultOptions): Promise<void> {
  const { model: modelInput, subcommand, args, dryRun = false, reviewType, role: customRole, output: outputPath } = options;

  // Resolve model alias
  const model = MODEL_ALIASES[modelInput.toLowerCase()] || modelInput.toLowerCase();

  // Validate model
  if (!MODEL_CONFIGS[model] && !SDK_MODELS.includes(model)) {
    const validModels = [...Object.keys(MODEL_CONFIGS), ...SDK_MODELS, ...Object.keys(MODEL_ALIASES)];
    throw new Error(`Unknown model: ${modelInput}\nValid models: ${validModels.join(', ')}`);
  }

  // Validate review type if provided
  if (reviewType && !VALID_REVIEW_TYPES.includes(reviewType)) {
    throw new Error(`Invalid review type: ${reviewType}\nValid types: ${VALID_REVIEW_TYPES.join(', ')}`);
  }

  const projectRoot = findProjectRoot();
  loadDotenv(projectRoot);

  console.error(`[${subcommand} review]`);
  console.error(`Model: ${model}`);

  // Log custom role if specified
  if (customRole) {
    console.error(`Role: ${customRole}`);
  }

  let query: string;

  switch (subcommand.toLowerCase()) {
    case 'pr': {
      if (args.length === 0) {
        throw new Error('PR number required\nUsage: consult -m <model> pr <number>');
      }
      const prNumber = parseInt(args[0], 10);
      if (isNaN(prNumber)) {
        throw new Error(`Invalid PR number: ${args[0]}`);
      }
      query = buildPRQuery(prNumber, projectRoot);
      break;
    }

    case 'spec': {
      if (args.length === 0) {
        throw new Error('Spec number required\nUsage: consult -m <model> spec <number>');
      }
      const specNumber = parseInt(args[0], 10);
      if (isNaN(specNumber)) {
        throw new Error(`Invalid spec number: ${args[0]}`);
      }
      const specPath = findSpec(projectRoot, specNumber);
      if (!specPath) {
        throw new Error(`Spec ${specNumber} not found`);
      }
      const planPath = findPlan(projectRoot, specNumber);
      query = buildSpecQuery(specPath, planPath);
      console.error(`Spec: ${specPath}`);
      if (planPath) console.error(`Plan: ${planPath}`);
      break;
    }

    case 'plan': {
      if (args.length === 0) {
        throw new Error('Plan number required\nUsage: consult -m <model> plan <number>');
      }
      const planNumber = parseInt(args[0], 10);
      if (isNaN(planNumber)) {
        throw new Error(`Invalid plan number: ${args[0]}`);
      }
      const planPath = findPlan(projectRoot, planNumber);
      if (!planPath) {
        throw new Error(`Plan ${planNumber} not found`);
      }
      const specPath = findSpec(projectRoot, planNumber);
      query = buildPlanQuery(planPath, specPath);
      console.error(`Plan: ${planPath}`);
      if (specPath) console.error(`Spec: ${specPath}`);
      break;
    }

    case 'general': {
      if (args.length === 0) {
        throw new Error('Query required\nUsage: consult -m <model> general "<query>"');
      }
      query = args.join(' ');
      break;
    }

    case 'impl': {
      if (args.length === 0) {
        throw new Error('Project number required\nUsage: consult -m <model> impl <number>');
      }
      const implNumber = parseInt(args[0], 10);
      if (isNaN(implNumber)) {
        throw new Error(`Invalid project number: ${args[0]}`);
      }
      const specPath = findSpec(projectRoot, implNumber);
      const planPath = findPlan(projectRoot, implNumber);
      query = buildImplQuery(implNumber, projectRoot, options.planPhase);
      console.error(`Project: ${implNumber}`);
      if (specPath) console.error(`Spec: ${specPath}`);
      if (planPath) console.error(`Plan: ${planPath}`);
      if (options.planPhase) console.error(`Plan phase: ${options.planPhase}`);
      break;
    }

    default:
      throw new Error(`Unknown subcommand: ${subcommand}\nValid subcommands: pr, spec, plan, impl, general`);
  }

  // Show the query/prompt being sent
  console.error('');
  console.error('='.repeat(60));
  console.error('PROMPT:');
  console.error('='.repeat(60));
  console.error(query);
  console.error('');
  console.error('='.repeat(60));
  console.error(`[${model.toUpperCase()}] Starting consultation...`);
  console.error('='.repeat(60));
  console.error('');

  await runConsultation(model, query, projectRoot, dryRun, reviewType, customRole, outputPath);
}
