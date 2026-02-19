/**
 * consult - AI consultation with external models
 *
 * Three modes:
 * 1. General — ad-hoc prompts via --prompt or --prompt-file
 * 2. Protocol — structured reviews via --protocol + --type
 * 3. Stats — consultation metrics (delegated to stats.ts, handled in cli.ts)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import chalk from 'chalk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { readCodevFile, findWorkspaceRoot } from '../../lib/skeleton.js';
import { MetricsDB } from './metrics.js';
import { extractUsage, extractReviewText, type SDKResultLike, type UsageData } from './usage-extractor.js';

// Model configuration
interface ModelConfig {
  cli: string;
  args: string[];
  envVar: string | null;
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  gemini: { cli: 'gemini', args: ['--model', 'gemini-3-pro-preview'], envVar: 'GEMINI_SYSTEM_MD' },
};

// Models that use an Agent SDK instead of CLI subprocess
const SDK_MODELS = ['claude', 'codex'];

// Claude Agent SDK turn limit. Claude explores the codebase with Read/Glob/Grep
// tools before producing its verdict, so it needs a generous turn budget.
const CLAUDE_MAX_TURNS = 200;

// Model aliases
const MODEL_ALIASES: Record<string, string> = {
  pro: 'gemini',
  gpt: 'codex',
  opus: 'claude',
};

export interface ConsultOptions {
  model: string;
  // General mode
  prompt?: string;
  promptFile?: string;
  // Protocol mode
  protocol?: string;
  type?: string;
  issue?: string;
  // Porch flags
  output?: string;
  planPhase?: string;
  context?: string;
  projectId?: string;
}

// Metrics context for passing invocation metadata to recording functions
interface MetricsContext {
  timestamp: string;
  model: string;
  reviewType: string | null;
  subcommand: string;
  protocol: string;
  projectId: string | null;
  workspacePath: string;
}

// Helper to record a metrics entry, opening and closing the DB
function recordMetrics(ctx: MetricsContext, extra: {
  durationSeconds: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  exitCode: number;
  errorMessage: string | null;
}): void {
  try {
    const db = new MetricsDB();
    try {
      db.record({
        timestamp: ctx.timestamp,
        model: ctx.model,
        reviewType: ctx.reviewType,
        subcommand: ctx.subcommand,
        protocol: ctx.protocol,
        projectId: ctx.projectId,
        durationSeconds: extra.durationSeconds,
        inputTokens: extra.inputTokens,
        cachedInputTokens: extra.cachedInputTokens,
        outputTokens: extra.outputTokens,
        costUsd: extra.costUsd,
        exitCode: extra.exitCode,
        workspacePath: ctx.workspacePath,
        errorMessage: extra.errorMessage,
      });
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`[warn] Failed to record metrics: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Validate name to prevent directory traversal attacks.
 * Only allows alphanumeric, hyphen, and underscore characters.
 */
function isValidRoleName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Load the consultant role.
 * Checks local codev/roles/consultant.md first, then falls back to embedded skeleton.
 */
function loadRole(workspaceRoot: string): string {
  const role = readCodevFile('roles/consultant.md', workspaceRoot);
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
 * Resolve protocol prompt template.
 * 1. If --protocol given → codev/protocols/<protocol>/consult-types/<type>-review.md
 * 2. If --type alone → codev/consult-types/<type>-review.md
 * 3. Error if file not found
 */
function resolveProtocolPrompt(workspaceRoot: string, protocol: string | undefined, type: string): string {
  const templateName = `${type}-review.md`;

  const relativePath = protocol
    ? `protocols/${protocol}/consult-types/${templateName}`
    : `consult-types/${templateName}`;

  const content = readCodevFile(relativePath, workspaceRoot);

  if (!content) {
    const location = protocol
      ? `codev/protocols/${protocol}/consult-types/${templateName}`
      : `codev/consult-types/${templateName}`;
    throw new Error(`Prompt template not found: ${location}`);
  }

  return content;
}

/**
 * Load .env file if it exists
 */
function loadDotenv(workspaceRoot: string): void {
  const envFile = path.join(workspaceRoot, '.env');
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
 * Find a spec file by number. Returns null if not found.
 * Errors if multiple matches found.
 */
function findSpec(workspaceRoot: string, number: number): string | null {
  const specsDir = path.join(workspaceRoot, 'codev', 'specs');
  const unpadded = String(number);
  const padded = unpadded.padStart(4, '0');

  if (fs.existsSync(specsDir)) {
    const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.md'));
    const matches = files.filter(f => f.startsWith(`${unpadded}-`) || f.startsWith(`${padded}-`));
    if (matches.length > 1) {
      const list = matches.map(f => `  - codev/specs/${f}`).join('\n');
      throw new Error(`Multiple spec files match '${unpadded}' or '${padded}':\n${list}`);
    }
    if (matches.length === 1) {
      return path.join(specsDir, matches[0]);
    }
  }
  return null;
}

/**
 * Find a plan file by number. Returns null if not found.
 * Errors if multiple matches found.
 */
function findPlan(workspaceRoot: string, number: number): string | null {
  const plansDir = path.join(workspaceRoot, 'codev', 'plans');
  const unpadded = String(number);
  const padded = unpadded.padStart(4, '0');

  if (fs.existsSync(plansDir)) {
    const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
    const matches = files.filter(f => f.startsWith(`${unpadded}-`) || f.startsWith(`${padded}-`));
    if (matches.length > 1) {
      const list = matches.map(f => `  - codev/plans/${f}`).join('\n');
      throw new Error(`Multiple plan files match '${unpadded}' or '${padded}':\n${list}`);
    }
    if (matches.length === 1) {
      return path.join(plansDir, matches[0]);
    }
  }
  return null;
}

/**
 * Check if running in a builder worktree
 */
function isBuilderContext(): boolean {
  return process.cwd().includes('/.builders/');
}

/**
 * Get builder project state from status.yaml
 */
function getBuilderProjectState(workspaceRoot: string): { id: string; title: string; currentPlanPhase: string | null } {
  const projectsDir = path.join(workspaceRoot, 'codev', 'projects');
  if (!fs.existsSync(projectsDir)) {
    throw new Error('No project state found. Are you in a builder worktree?');
  }

  const entries = fs.readdirSync(projectsDir);
  const projectDirs = entries.filter(e => {
    return fs.statSync(path.join(projectsDir, e)).isDirectory();
  });

  if (projectDirs.length === 0) {
    throw new Error('No project found in codev/projects/');
  }
  let dir: string;
  if (projectDirs.length > 1) {
    // Multiple project dirs exist (historical records on main).
    // Disambiguate using the worktree directory name which contains the project ID,
    // e.g. .builders/spir-438-aspir-protocol → match "438-aspir-protocol"
    const cwd = process.cwd();
    const builderMatch = cwd.match(/\.builders\/[^/]*?-?(\d+)-([^/]+)/);
    if (builderMatch) {
      const worktreeId = builderMatch[1];
      const matched = projectDirs.find(d => d.startsWith(`${worktreeId}-`) || d.startsWith(`bugfix-${worktreeId}-`));
      if (matched) {
        dir = matched;
      } else {
        throw new Error(`Multiple projects found and none match worktree ID ${worktreeId}: ${projectDirs.join(', ')}`);
      }
    } else {
      throw new Error(`Multiple projects found: ${projectDirs.join(', ')}`);
    }
  } else {
    dir = projectDirs[0];
  }
  const statusPath = path.join(projectsDir, dir, 'status.yaml');
  if (!fs.existsSync(statusPath)) {
    throw new Error(`status.yaml not found in ${dir}`);
  }

  const content = fs.readFileSync(statusPath, 'utf-8');

  // Simple YAML parsing for the fields we need
  const idMatch = content.match(/^id:\s*'?(\d+)'?\s*$/m);
  const titleMatch = content.match(/^title:\s*(.+)$/m);
  const phaseMatch = content.match(/^current_plan_phase:\s*(.+)$/m);

  const id = idMatch?.[1] ?? '';
  const title = titleMatch?.[1]?.trim() ?? '';
  const rawPhase = phaseMatch?.[1]?.trim() ?? 'null';
  const currentPlanPhase = rawPhase === 'null' ? null : rawPhase;

  return { id, title, currentPlanPhase };
}

/**
 * Log query to history file
 */
function logQuery(workspaceRoot: string, model: string, query: string, duration?: number): void {
  try {
    const logDir = path.join(workspaceRoot, '.consult');
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

// Codex pricing for cost computation (matches values from old SUBPROCESS_MODEL_PRICING)
const CODEX_PRICING = { inputPer1M: 2.00, cachedInputPer1M: 1.00, outputPer1M: 8.00 };

/**
 * Run Codex consultation via @openai/codex-sdk.
 * Mirrors runClaudeConsultation() — streams events, captures usage, records metrics.
 */
export async function runCodexConsultation(
  queryText: string,
  role: string,
  workspaceRoot: string,
  outputPath?: string,
  metricsCtx?: MetricsContext,
): Promise<void> {
  const chunks: string[] = [];
  const startTime = Date.now();
  let usageData: UsageData | null = null;
  let errorMessage: string | null = null;
  let exitCode = 0;

  // Write role to temp file — SDK requires file path for instructions
  const tempFile = path.join(tmpdir(), `codev-role-${Date.now()}.md`);
  fs.writeFileSync(tempFile, role);

  try {
    const codex = new Codex({
      config: {
        experimental_instructions_file: tempFile,
      },
    });

    const thread = codex.startThread({
      model: 'gpt-5.2-codex',
      sandboxMode: 'read-only',
      modelReasoningEffort: 'medium',
      workingDirectory: workspaceRoot,
    });

    const { events } = await thread.runStreamed(queryText);

    for await (const event of events) {
      if (event.type === 'item.completed') {
        const item = event.item;
        if (item.type === 'agent_message') {
          process.stdout.write(item.text);
          chunks.push(item.text);
        }
      }
      if (event.type === 'turn.completed') {
        const input = event.usage.input_tokens;
        const cached = event.usage.cached_input_tokens;
        const output = event.usage.output_tokens;
        const uncached = input - cached;
        const cost = (uncached / 1_000_000) * CODEX_PRICING.inputPer1M
                   + (cached / 1_000_000) * CODEX_PRICING.cachedInputPer1M
                   + (output / 1_000_000) * CODEX_PRICING.outputPer1M;
        usageData = { inputTokens: input, cachedInputTokens: cached, outputTokens: output, costUsd: cost };
      }
      if (event.type === 'turn.failed') {
        errorMessage = event.error.message ?? 'Codex turn failed';
        exitCode = 1;
        throw new Error(errorMessage);
      }
      if (event.type === 'error') {
        errorMessage = event.message ?? 'Codex stream error';
        exitCode = 1;
        throw new Error(errorMessage);
      }
    }

    // Write output file
    if (outputPath) {
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outputPath, chunks.join(''));
      console.error(`\nOutput written to: ${outputPath}`);
    }
  } catch (err) {
    if (!errorMessage) {
      errorMessage = (err instanceof Error ? err.message : String(err)).substring(0, 500);
      exitCode = 1;
    }
    throw err;
  } finally {
    // Clean up temp file
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

    // Record metrics (always, even on error)
    if (metricsCtx) {
      const duration = (Date.now() - startTime) / 1000;
      recordMetrics(metricsCtx, {
        durationSeconds: duration,
        inputTokens: usageData?.inputTokens ?? null,
        cachedInputTokens: usageData?.cachedInputTokens ?? null,
        outputTokens: usageData?.outputTokens ?? null,
        costUsd: usageData?.costUsd ?? null,
        exitCode,
        errorMessage,
      });
    }
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
  workspaceRoot: string,
  outputPath?: string,
  metricsCtx?: MetricsContext,
): Promise<void> {
  const chunks: string[] = [];
  const startTime = Date.now();
  let sdkResult: SDKResultLike | undefined;
  let errorMessage: string | null = null;
  let exitCode = 0;

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
        maxTurns: CLAUDE_MAX_TURNS,
        maxBudgetUsd: 25,
        cwd: workspaceRoot,
        env,
      },
    });

    for await (const message of session) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block) {
            process.stdout.write(block.text);
            chunks.push(block.text);
          }
        }
      }
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          sdkResult = message as unknown as SDKResultLike;
        } else {
          const errors = 'errors' in message ? (message as { errors: string[] }).errors : [];
          errorMessage = `Claude SDK error (${message.subtype}): ${errors.join(', ')}`.substring(0, 500);
          exitCode = 1;
          throw new Error(errorMessage);
        }
      }
    }

    if (outputPath) {
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outputPath, chunks.join(''));
      console.error(`\nOutput written to: ${outputPath}`);
    }
  } catch (err) {
    if (!errorMessage) {
      errorMessage = (err instanceof Error ? err.message : String(err)).substring(0, 500);
      exitCode = 1;
    }
    throw err;
  } finally {
    if (savedClaudeCode !== undefined) {
      process.env.CLAUDECODE = savedClaudeCode;
    }

    // Record metrics (always, even on error)
    if (metricsCtx) {
      const duration = (Date.now() - startTime) / 1000;
      const usage = sdkResult ? extractUsage('claude', '', sdkResult) : null;
      recordMetrics(metricsCtx, {
        durationSeconds: duration,
        inputTokens: usage?.inputTokens ?? null,
        cachedInputTokens: usage?.cachedInputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        costUsd: usage?.costUsd ?? null,
        exitCode,
        errorMessage,
      });
    }
  }
}

/**
 * Run the consultation — dispatches to the correct model runner.
 */
async function runConsultation(
  model: string,
  query: string,
  workspaceRoot: string,
  role: string,
  outputPath?: string,
  metricsCtx?: MetricsContext,
  generalMode?: boolean,
): Promise<void> {
  // SDK-based models
  if (model === 'claude') {
    const startTime = Date.now();
    await runClaudeConsultation(query, role, workspaceRoot, outputPath, metricsCtx);
    const duration = (Date.now() - startTime) / 1000;
    logQuery(workspaceRoot, model, query, duration);
    console.error(`\n[${model} completed in ${duration.toFixed(1)}s]`);
    return;
  }

  if (model === 'codex') {
    const startTime = Date.now();
    await runCodexConsultation(query, role, workspaceRoot, outputPath, metricsCtx);
    const duration = (Date.now() - startTime) / 1000;
    logQuery(workspaceRoot, model, query, duration);
    console.error(`\n[${model} completed in ${duration.toFixed(1)}s]`);
    return;
  }

  const config = MODEL_CONFIGS[model];

  if (!config) {
    throw new Error(`Unknown model: ${model}`);
  }

  // Check if CLI exists
  if (!commandExists(config.cli)) {
    throw new Error(`${config.cli} not found. Please install it first.`);
  }

  let tempFile: string | null = null;
  const env: Record<string, string> = {};
  let cmd: string[];

  if (model === 'gemini') {
    // Gemini uses GEMINI_SYSTEM_MD env var for role
    tempFile = path.join(tmpdir(), `codev-role-${Date.now()}.md`);
    fs.writeFileSync(tempFile, role);
    env['GEMINI_SYSTEM_MD'] = tempFile;

    // Use --output-format json to capture token usage/cost in structured output.
    // Never use --yolo — it allows Gemini to write files (#370).
    cmd = [config.cli, '--output-format', 'json', ...config.args, query];
  } else {
    throw new Error(`Unknown model: ${model}`);
  }

  // Execute with passthrough stdio
  // Use 'ignore' for stdin to prevent blocking when spawned as subprocess
  const fullEnv = { ...process.env, ...env };
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: workspaceRoot,
      env: fullEnv,
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    const chunks: Buffer[] = [];

    if (proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
    }

    proc.on('close', (code) => {
      const duration = (Date.now() - startTime) / 1000;
      logQuery(workspaceRoot, model, query, duration);

      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }

      const rawOutput = Buffer.concat(chunks).toString('utf-8');

      // Extract review text from structured output (JSON/JSONL → plain text)
      const reviewText = extractReviewText(model, rawOutput);
      const outputContent = reviewText ?? rawOutput; // Fallback to raw on parse failure

      // Write text to stdout (was fully buffered)
      process.stdout.write(outputContent);

      // Write to output file
      if (outputPath && outputContent.length > 0) {
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        fs.writeFileSync(outputPath, outputContent);
        console.error(`\nOutput written to: ${outputPath}`);
      }

      // Record metrics
      if (metricsCtx) {
        const usage = extractUsage(model, rawOutput);
        recordMetrics(metricsCtx, {
          durationSeconds: duration,
          inputTokens: usage?.inputTokens ?? null,
          cachedInputTokens: usage?.cachedInputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          costUsd: usage?.costUsd ?? null,
          exitCode: code ?? 1,
          errorMessage: code !== 0 ? `Process exited with code ${code}` : null,
        });
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

      // Record metrics for spawn failures
      if (metricsCtx) {
        const duration = (Date.now() - startTime) / 1000;
        recordMetrics(metricsCtx, {
          durationSeconds: duration,
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          costUsd: null,
          exitCode: 1,
          errorMessage: (error.message || String(error)).substring(0, 500),
        });
      }

      reject(error);
    });
  });
}

/**
 * Get a compact diff stat summary and list of changed files.
 */
function getDiffStat(workspaceRoot: string, ref: string): { stat: string; files: string[] } {
  const stat = execSync(`git diff --stat ${ref}`, { cwd: workspaceRoot, encoding: 'utf-8' }).toString();
  const nameOnly = execSync(`git diff --name-only ${ref}`, { cwd: workspaceRoot, encoding: 'utf-8' }).toString();
  const files = nameOnly.trim().split('\n').filter(Boolean);
  return { stat, files };
}

/**
 * Fetch PR metadata (no diff — that's fetched separately)
 */
function fetchPRData(prNumber: number): { info: string; changedFiles: string[]; comments: string } {
  console.error(`Fetching PR #${prNumber} data...`);

  try {
    const info = execSync(`gh pr view ${prNumber} --json title,body,state,author,baseRefName,headRefName,additions,deletions`, { encoding: 'utf-8' });
    const nameOnly = execSync(`gh pr diff ${prNumber} --name-only`, { encoding: 'utf-8' });
    const changedFiles = nameOnly.trim().split('\n').filter(Boolean);

    let comments = '(No comments)';
    try {
      comments = execSync(`gh pr view ${prNumber} --comments`, { encoding: 'utf-8' });
    } catch {
      // No comments or error fetching
    }

    return { info, changedFiles, comments };
  } catch (err) {
    throw new Error(`Failed to fetch PR data: ${err}`);
  }
}

/**
 * Fetch the full PR diff via gh pr diff
 */
function fetchPRDiff(prNumber: number): string {
  try {
    return execSync(`gh pr diff ${prNumber}`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`Failed to fetch PR diff for #${prNumber}: ${err}`);
  }
}

/**
 * Build query for PR review.
 * Includes full PR diff + file list; model reads surrounding context from disk.
 */
function buildPRQuery(prNumber: number): string {
  const prData = fetchPRData(prNumber);
  const diff = fetchPRDiff(prNumber);

  const fileList = prData.changedFiles.map(f => `- ${f}`).join('\n');

  return `Review Pull Request #${prNumber}

## PR Info
\`\`\`json
${prData.info}
\`\`\`

## Changed Files
${fileList}

## PR Diff
\`\`\`diff
${diff}
\`\`\`

## How to Review
Review the PR diff above for the changes. You also have **full filesystem access** — read files from disk for surrounding context beyond what the diff shows.

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
## How to Review
**Read the files listed above directly from disk.** You have full filesystem access.
Do NOT rely on \`git diff\` or \`git log\` to review content — diffs may be truncated or miss uncommitted work.
Open the spec file, read it in full, and evaluate it directly.

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
 * Build query for implementation review.
 * Accepts spec/plan paths and optional diff reference override.
 */
function buildImplQuery(
  workspaceRoot: string,
  specPath: string | null,
  planPath: string | null,
  planPhase?: string,
  diffRef?: string,
): string {
  // Get compact diff summary
  let diffStat = '';
  let changedFiles: string[] = [];
  try {
    const ref = diffRef ?? execSync('git merge-base HEAD main', { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
    const result = getDiffStat(workspaceRoot, ref);
    diffStat = result.stat;
    changedFiles = result.files;
  } catch {
    // If git diff fails, reviewer will explore filesystem
  }

  let query = `Review Implementation`;
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

  if (changedFiles.length > 0) {
    query += `\n## Changed Files (${changedFiles.length} files)\n`;
    query += `\`\`\`\n${diffStat}\`\`\`\n`;
    query += `\n### File List\n`;
    query += changedFiles.map(f => `- ${f}`).join('\n');
    query += `\n\n## How to Review\n`;
    query += `**Read the changed files from disk** to review their actual content. You have full filesystem access.\n`;
    query += `For each file listed above, read it and evaluate the implementation against the spec/plan.\n`;
    query += `Do NOT rely on git diffs to determine the current state of code — diffs miss uncommitted changes in worktrees.\n`;
  } else {
    query += `\n## Instructions\n\nRead the spec and plan files above, then explore the filesystem to find and review the implementation changes.\n`;
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
## How to Review
**Read the files listed above directly from disk.** You have full filesystem access.
Do NOT rely on \`git diff\` or \`git log\` to review content — diffs may be truncated or miss uncommitted work.
Open the plan file (and spec if provided), read them in full, and evaluate the plan directly.

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
 * Build query for phase-scoped review.
 * Uses git show HEAD for the phase's atomic commit diff.
 */
function buildPhaseQuery(
  workspaceRoot: string,
  planPhase: string,
  specPath: string | null,
  planPath: string | null,
): string {
  let phaseDiff = '';
  try {
    phaseDiff = execSync('git show HEAD', { cwd: workspaceRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch {
    // If git show fails, reviewer explores filesystem
  }

  let query = `Review Phase Implementation: "${planPhase}"\n\n## Context Files\n`;

  if (specPath) query += `- Spec: ${specPath}\n`;
  if (planPath) query += `- Plan: ${planPath}\n`;

  query += `
## REVIEW SCOPE — CURRENT PLAN PHASE ONLY
You are reviewing **plan phase "${planPhase}" ONLY**.
Read the plan, find the section for "${planPhase}", and scope your review to ONLY the work described in that phase.

**DO NOT** request changes for work that belongs to other plan phases.
**DO NOT** flag missing functionality that is scheduled for a later phase.
**DO** verify that this phase's deliverables are complete and correct.

## Phase Commit Diff
\`\`\`
${phaseDiff}
\`\`\`

## How to Review
The diff above shows the atomic commit for this phase. You also have **full filesystem access** — read files from disk to understand surrounding code.

Please review:
1. **Spec Adherence**: Does the code fulfill the spec requirements for this phase?
2. **Code Quality**: Is the code readable, maintainable, and bug-free?
3. **Test Coverage**: Are there adequate tests for the changes in this phase?
4. **Error Handling**: Are edge cases and errors handled properly?
5. **Plan Alignment**: Does the implementation follow the plan for phase "${planPhase}"?

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
 * Find PR number for the current branch
 */
function findPRForCurrentBranch(workspaceRoot: string): number {
  const branchName = execSync('git branch --show-current', { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
  const prJson = execSync(
    `gh pr list --head "${branchName}" --json number --jq '.[0].number'`,
    { cwd: workspaceRoot, encoding: 'utf-8' }
  ).trim();

  if (!prJson) {
    throw new Error(`No PR found for branch: ${branchName}`);
  }

  const prNumber = parseInt(prJson, 10);
  if (isNaN(prNumber)) {
    throw new Error(`No PR found for branch: ${branchName}`);
  }

  return prNumber;
}

/**
 * Find PR number for a given issue number (architect mode)
 */
function findPRForIssue(workspaceRoot: string, issueNumber: number): { number: number; headRefName: string } {
  const prJson = execSync(
    `gh pr list --search "${issueNumber}" --json number,headRefName --jq '.[0]'`,
    { cwd: workspaceRoot, encoding: 'utf-8' }
  ).trim();

  if (!prJson || prJson === 'null') {
    throw new Error(`No PR found for issue #${issueNumber}`);
  }

  return JSON.parse(prJson);
}

/**
 * Resolve query for builder context (auto-detected from porch state)
 */
function resolveBuilderQuery(workspaceRoot: string, type: string, options: ConsultOptions): string {
  const projectState = getBuilderProjectState(workspaceRoot);
  const projectNumber = parseInt(projectState.id, 10);

  switch (type) {
    case 'spec': {
      const specPath = findSpec(workspaceRoot, projectNumber);
      if (!specPath) throw new Error(`Spec ${projectState.id} not found in codev/specs/`);
      const planPath = findPlan(workspaceRoot, projectNumber);
      console.error(`Spec: ${specPath}`);
      if (planPath) console.error(`Plan: ${planPath}`);
      return buildSpecQuery(specPath, planPath);
    }

    case 'plan': {
      const planPath = findPlan(workspaceRoot, projectNumber);
      if (!planPath) throw new Error(`Plan ${projectState.id} not found in codev/plans/`);
      const specPath = findSpec(workspaceRoot, projectNumber);
      console.error(`Plan: ${planPath}`);
      if (specPath) console.error(`Spec: ${specPath}`);
      return buildPlanQuery(planPath, specPath);
    }

    case 'impl': {
      const specPath = findSpec(workspaceRoot, projectNumber);
      const planPath = findPlan(workspaceRoot, projectNumber);
      console.error(`Project: ${projectState.id}`);
      if (specPath) console.error(`Spec: ${specPath}`);
      if (planPath) console.error(`Plan: ${planPath}`);
      if (options.planPhase) console.error(`Plan phase: ${options.planPhase}`);
      return buildImplQuery(workspaceRoot, specPath, planPath, options.planPhase);
    }

    case 'pr': {
      const prNumber = findPRForCurrentBranch(workspaceRoot);
      console.error(`PR: #${prNumber}`);
      return buildPRQuery(prNumber);
    }

    case 'phase': {
      const currentPhase = options.planPhase ?? projectState.currentPlanPhase;
      if (!currentPhase) {
        throw new Error('No current plan phase detected. Use --plan-phase to specify.');
      }
      const specPath = findSpec(workspaceRoot, projectNumber);
      const planPath = findPlan(workspaceRoot, projectNumber);
      console.error(`Phase: ${currentPhase}`);
      if (specPath) console.error(`Spec: ${specPath}`);
      if (planPath) console.error(`Plan: ${planPath}`);
      return buildPhaseQuery(workspaceRoot, currentPhase, specPath, planPath);
    }

    case 'integration': {
      const prNumber = findPRForCurrentBranch(workspaceRoot);
      console.error(`PR: #${prNumber} (integration review)`);
      return buildPRQuery(prNumber);
    }

    default:
      throw new Error(`Unknown review type: ${type}\nValid types: spec, plan, impl, pr, phase, integration`);
  }
}

/**
 * Resolve query for architect context (requires --issue)
 */
function resolveArchitectQuery(workspaceRoot: string, type: string, options: ConsultOptions): string {
  if (type === 'phase') {
    throw new Error('--type phase requires a builder worktree. Phases only exist in builders and require the phase commit to exist.');
  }

  if (!options.issue) {
    throw new Error(
      `--issue is required from architect context for --type ${type}.\n` +
      `Example: consult -m gemini --protocol spir --type ${type} --issue 42`
    );
  }

  const issueNumber = parseInt(options.issue, 10);
  if (isNaN(issueNumber)) {
    throw new Error(`Invalid issue number: ${options.issue}`);
  }

  switch (type) {
    case 'spec': {
      const specPath = findSpec(workspaceRoot, issueNumber);
      if (!specPath) throw new Error(`Spec ${issueNumber} not found in codev/specs/`);
      const planPath = findPlan(workspaceRoot, issueNumber);
      console.error(`Spec: ${specPath}`);
      if (planPath) console.error(`Plan: ${planPath}`);
      return buildSpecQuery(specPath, planPath);
    }

    case 'plan': {
      const planPath = findPlan(workspaceRoot, issueNumber);
      if (!planPath) throw new Error(`Plan ${issueNumber} not found in codev/plans/`);
      const specPath = findSpec(workspaceRoot, issueNumber);
      console.error(`Plan: ${planPath}`);
      if (specPath) console.error(`Spec: ${specPath}`);
      return buildPlanQuery(planPath, specPath);
    }

    case 'impl': {
      const pr = findPRForIssue(workspaceRoot, issueNumber);
      // Fetch the branch and diff from merge-base
      try {
        execSync(`git fetch origin ${pr.headRefName}`, { cwd: workspaceRoot, stdio: 'pipe' });
      } catch {
        // May already be fetched
      }
      const mergeBase = execSync(`git merge-base main origin/${pr.headRefName}`, { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
      const specPath = findSpec(workspaceRoot, issueNumber);
      const planPath = findPlan(workspaceRoot, issueNumber);
      console.error(`Project: ${issueNumber} (PR #${pr.number}, branch: ${pr.headRefName})`);
      if (specPath) console.error(`Spec: ${specPath}`);
      if (planPath) console.error(`Plan: ${planPath}`);
      return buildImplQuery(workspaceRoot, specPath, planPath, options.planPhase, `${mergeBase}..origin/${pr.headRefName}`);
    }

    case 'pr': {
      const pr = findPRForIssue(workspaceRoot, issueNumber);
      console.error(`PR: #${pr.number}`);
      return buildPRQuery(pr.number);
    }

    case 'integration': {
      const pr = findPRForIssue(workspaceRoot, issueNumber);
      console.error(`PR: #${pr.number} (integration review)`);
      return buildPRQuery(pr.number);
    }

    default:
      throw new Error(`Unknown review type: ${type}\nValid types: spec, plan, impl, pr, phase, integration`);
  }
}

/**
 * Main consult entry point
 */
export async function consult(options: ConsultOptions): Promise<void> {
  const hasPrompt = !!options.prompt || !!options.promptFile;
  const hasType = !!options.type;

  // --- Input validation ---

  // Mode conflict: --prompt/--prompt-file + --type
  if (hasPrompt && hasType) {
    throw new Error(
      'Mode conflict: cannot use --prompt/--prompt-file with --type.\n' +
      'Use --prompt or --prompt-file for general queries.\n' +
      'Use --type (with optional --protocol) for protocol reviews.'
    );
  }

  // --prompt + --prompt-file together
  if (options.prompt && options.promptFile) {
    throw new Error('Cannot use both --prompt and --prompt-file. Choose one.');
  }

  // --protocol without --type
  if (options.protocol && !options.type) {
    throw new Error('--protocol requires --type. Example: consult -m gemini --protocol spir --type spec');
  }

  // Neither mode specified
  if (!hasPrompt && !hasType) {
    throw new Error(
      'No mode specified.\n' +
      'General mode: consult -m <model> --prompt "question"\n' +
      'Protocol mode: consult -m <model> --protocol <name> --type <type>\n' +
      'Stats mode: consult stats'
    );
  }

  // Validate --protocol and --type for path traversal
  if (options.protocol && !isValidRoleName(options.protocol)) {
    throw new Error(`Invalid protocol name: '${options.protocol}'. Only alphanumeric characters, hyphens, and underscores allowed.`);
  }
  if (options.type && !isValidRoleName(options.type)) {
    throw new Error(`Invalid type name: '${options.type}'. Only alphanumeric characters, hyphens, and underscores allowed.`);
  }

  // --- Resolve model ---
  const model = MODEL_ALIASES[options.model.toLowerCase()] || options.model.toLowerCase();
  if (!MODEL_CONFIGS[model] && !SDK_MODELS.includes(model)) {
    const validModels = [...Object.keys(MODEL_CONFIGS), ...SDK_MODELS, ...Object.keys(MODEL_ALIASES)];
    throw new Error(`Unknown model: ${options.model}\nValid models: ${validModels.join(', ')}`);
  }

  // --- Setup ---
  const workspaceRoot = findWorkspaceRoot();
  loadDotenv(workspaceRoot);

  const timestamp = new Date().toISOString();
  const metricsCtx: MetricsContext = {
    timestamp,
    model,
    reviewType: options.type ?? null,
    subcommand: options.type ?? 'general',
    protocol: options.protocol ?? 'manual',
    projectId: options.projectId ?? null,
    workspacePath: workspaceRoot,
  };

  console.error(`Model: ${model}`);

  let query: string;
  let role = loadRole(workspaceRoot);

  // --- Build query based on mode ---
  if (hasType) {
    // Protocol mode
    const type = options.type!;

    // Load and append protocol prompt template
    const promptTemplate = resolveProtocolPrompt(workspaceRoot, options.protocol, type);
    role = role + '\n\n---\n\n' + promptTemplate;
    console.error(`Review type: ${type}${options.protocol ? ` (protocol: ${options.protocol})` : ''}`);

    // Determine context: builder (auto-detect) vs architect (--issue or not in builder)
    const inBuilder = isBuilderContext() && !options.issue;

    if (inBuilder) {
      query = resolveBuilderQuery(workspaceRoot, type, options);
    } else {
      query = resolveArchitectQuery(workspaceRoot, type, options);
    }
  } else {
    // General mode
    if (options.prompt) {
      query = options.prompt;
    } else {
      const filePath = options.promptFile!;
      if (!fs.existsSync(filePath)) {
        throw new Error(`Prompt file not found: ${filePath}`);
      }
      query = fs.readFileSync(filePath, 'utf-8');
    }
  }

  // Prepend iteration context if provided (for stateful reviews)
  if (options.context) {
    try {
      const contextContent = fs.readFileSync(options.context, 'utf-8');
      query = `## Previous Iteration Context\n\n${contextContent}\n\n---\n\n${query}`;
      console.error(`Context: ${options.context}`);
    } catch {
      console.error(chalk.yellow(`Warning: Could not read context file: ${options.context}`));
    }
  }

  // Add file access instruction for Gemini
  if (model === 'gemini') {
    query += '\n\nYou have file access. Read files directly from disk to review code.';
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

  const isGeneralMode = !hasType;
  await runConsultation(model, query, workspaceRoot, role, options.output, metricsCtx, isGeneralMode);
}

// Exported for testing
export { getDiffStat as _getDiffStat, buildSpecQuery as _buildSpecQuery, buildPlanQuery as _buildPlanQuery };
