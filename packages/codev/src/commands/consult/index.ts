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
import { spawn, execSync, execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import chalk from 'chalk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { readCodevFile, findWorkspaceRoot } from '../../lib/skeleton.js';
import { resolveDefaultBranch } from '../../lib/default-branch.js';
import { loadConfig } from '../../lib/config.js';
import { getResolver, GitRefResolver, type ArtifactResolver } from '../porch/artifacts.js';
import { MetricsDB } from './metrics.js';
import { extractUsage, extractReviewText, type SDKResultLike, type UsageData } from './usage-extractor.js';
import { executeForgeCommandSync } from '../../lib/forge.js';

// Content reference — resolved artifact content with a display label
interface ContentRef {
  content: string;
  label: string;
}

// Model configuration
interface ModelConfig {
  cli: string;
  args: string[];
  envVar: string | null;
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  // gemini dispatches to the Antigravity CLI (`agy`) via runAgyConsultation —
  // this entry exists only for model validation and the `pro` alias; its
  // cli/args are NOT used for dispatch (agy's binary path is resolved at runtime).
  gemini: { cli: 'agy', args: [], envVar: null },
  hermes: { cli: 'hermes', args: ['chat', '-q'], envVar: null },
};

// Models that use an Agent SDK instead of CLI subprocess
const SDK_MODELS = ['claude', 'codex'];

// Prevent E2BIG when passing very large prompts to CLI backends.
// Large payloads are written to a temp file and referenced in the query.
const CLI_PROMPT_INLINE_MAX_CHARS = 100_000;

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
  // Read spec/plan from this git ref instead of the local workspace.
  // Defaults to the PR's headRefName when --issue resolves to a PR.
  // Closes #777 Defect A.
  branch?: string;
  // Integration-branch override for `--type integration` (#1113). When set,
  // the integration diff is computed locally as a three-dot diff anchored on
  // this base (origin/<base>...origin/<head>) instead of `gh pr diff` (the
  // PR's host-recorded base). Falls back to config `consult.integrationBranch`.
  base?: string;
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
 * Find spec content by project ID using the artifact resolver.
 * Returns a ContentRef with content and label, or null if not found.
 *
 * Accepts an explicit `resolver` to support reading from a git ref (#777
 * Defect A) instead of the architect's local workspace. When omitted,
 * falls back to the workspace-root resolver from `.codev/config.json`.
 */
function findSpecContent(workspaceRoot: string, id: string, resolver?: ArtifactResolver): ContentRef | null {
  const r = resolver ?? getResolver(workspaceRoot);
  const content = r.getSpecContent(id, '');
  if (!content) return null;
  const label = r.findSpecBaseName(id, '') ?? id;
  return { content, label };
}

/**
 * Find plan content by project ID using the artifact resolver.
 * Returns a ContentRef with content and label, or null if not found.
 *
 * Accepts an explicit `resolver` to support reading from a git ref (#777
 * Defect A) instead of the architect's local workspace.
 */
function findPlanContent(workspaceRoot: string, id: string, resolver?: ArtifactResolver): ContentRef | null {
  const r = resolver ?? getResolver(workspaceRoot);
  const content = r.getPlanContent(id, '');
  if (!content) return null;
  const baseName = r.findSpecBaseName(id, '') ?? id;
  return { content, label: baseName };
}

/**
 * Check if running in a builder worktree
 */
function isBuilderContext(): boolean {
  return process.cwd().includes('/.builders/');
}

interface BuilderProjectState {
  id: string;
  title: string;
  currentPlanPhase: string | null;
  phase: string;
  iteration: number;
  projectDir: string;
}

/**
 * Get builder project state from status.yaml
 */
function getBuilderProjectState(workspaceRoot: string, projectId?: string): BuilderProjectState {
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
  if (projectId) {
    // Direct lookup by project ID (passed via --project-id from porch)
    const matched = projectDirs.find(d => d.startsWith(`${projectId}-`) || d.startsWith(`bugfix-${projectId}-`));
    if (matched) {
      dir = matched;
    } else {
      throw new Error(`Project ${projectId} not found in codev/projects/. Available: ${projectDirs.join(', ')}`);
    }
  } else if (projectDirs.length > 1) {
    // Multiple project dirs — try to disambiguate from worktree directory name
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
  // Handles both numeric IDs (e.g., '0042') and prefixed IDs (e.g., 'bugfix-512')
  const idMatch = content.match(/^id:\s*'?([^\s']+)'?\s*$/m);
  const titleMatch = content.match(/^title:\s*(.+)$/m);
  const planPhaseMatch = content.match(/^current_plan_phase:\s*(.+)$/m);
  const phaseMatch = content.match(/^phase:\s*(.+)$/m);
  const iterationMatch = content.match(/^iteration:\s*(\d+)/m);

  const id = idMatch?.[1] ?? '';
  const title = titleMatch?.[1]?.trim() ?? '';
  const rawPlanPhase = planPhaseMatch?.[1]?.trim() ?? 'null';
  const currentPlanPhase = rawPlanPhase === 'null' ? null : rawPlanPhase;
  const phase = phaseMatch?.[1]?.trim() ?? '';
  const iteration = parseInt(iterationMatch?.[1] ?? '1', 10);
  const projectDir = path.join(projectsDir, dir);

  return { id, title, currentPlanPhase, phase, iteration, projectDir };
}

/**
 * Compute a persistent output path for consultation results.
 *
 * When --output is not explicitly provided, this generates a path in the
 * project directory so results survive Claude Code's temp file cleanup.
 *
 * Pattern: codev/projects/<id>-<name>/<id>-<phase>-iter<N>-<model>.txt
 *
 * This matches the pattern used by porch's findReviewFiles() and
 * getReviewFilePath() so porch can find the results.
 */
function computePersistentOutputPath(state: BuilderProjectState, model: string): string {
  const phase = state.currentPlanPhase || state.phase;
  const fileName = `${state.id}-${phase}-iter${state.iteration}-${model}.txt`;
  return path.join(state.projectDir, fileName);
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
        model_instructions_file: tempFile,
      },
    });

    const thread = codex.startThread({
      model: 'gpt-5.4',
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
        // output_tokens already includes reasoning_output_tokens (OpenAI Responses-API
        // convention) — do NOT add the latter to cost or reasoning is double-billed.
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
 * Build the env passed to the Claude Agent SDK subprocess for a consultation.
 *
 * Copies the given environment, but when a Claude subscription/OAuth token
 * (`CLAUDE_CODE_OAUTH_TOKEN`) is present, strips `ANTHROPIC_API_KEY` and
 * `ANTHROPIC_AUTH_TOKEN` from the *copy* (never the global `process.env`).
 * The Agent SDK prioritizes the API key over the OAuth token, so leaving the
 * key in would silently route CMAP/review traffic to the metered Opus API
 * instead of the Claude subscription (issue #985).
 *
 * When no OAuth token is set, the API key is preserved so CI / key-only
 * environments continue to authenticate.
 *
 * The deletion is scoped to this subprocess env only — other callers that need
 * the API key (persona, dev:local) are unaffected.
 */
export function buildClaudeConsultEnv(
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  return env;
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

  const env = buildClaudeConsultEnv(process.env);

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

// ── Antigravity CLI (`agy`) backend for the `gemini` lane ──────────────────
// Replaces the retiring Gemini CLI. agy is an agent (reads files from disk via
// --add-dir under --sandbox), OAuth-only, default model = Flash, plain-text
// output (no usage JSON). See spec/plan 778.

// Markers that indicate agy is NOT authenticated (it prints an OAuth URL and
// waits ~30s for an interactive login that can't complete headlessly). When
// seen, we terminate early and emit a non-blocking COMMENT skip.
export const AGY_OAUTH_MARKERS = [
  'accounts.google.com/o/oauth2',
  'Authentication required',
  'paste the authorization code',
  'Waiting for authentication',
];
const AGY_PRINT_TIMEOUT = '5m';                 // passed to `agy --print-timeout`
const AGY_TIMEOUT_MS = 6 * 60 * 1000;           // Codev-owned hard cap (> agy's own timeout)
// OAuth banner appears before any review text; only scan the early stream.
const AGY_MARKER_SCAN_LIMIT = 8192;
// agy's own print-timeout message: on an agentic task that outruns --print-timeout,
// it returns this (often with a "monitoring the task" note) instead of a review.
// Treat it as a non-response → non-blocking skip rather than a garbage "review".
const AGY_NONRESPONSE_MARKER = 'timed out waiting for response';

/**
 * Verify a path is the real headless `agy` CLI, not the Antigravity IDE
 * launcher. The IDE ships `~/.antigravity/.../bin/agy` as a symlink to the
 * Electron app binary (`Antigravity.app/.../antigravity`); resolving it and
 * launching it would open the IDE, never produce a `--print` review. We reject
 * by realpath WITHOUT executing anything (no risk of launching the GUI).
 */
export function isRealAgyCli(p: string): boolean {
  try {
    if (!fs.existsSync(p)) return false;
    const real = fs.realpathSync(p);
    if (real.includes('Antigravity.app')) return false;     // IDE app bundle
    if (/[/\\]antigravity(\.exe)?$/.test(real)) return false; // IDE launcher binary
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the real `agy` CLI binary deterministically — never trust a bare
 * PATH lookup (a stale shell or the IDE symlink shadows the CLI). Prefers the
 * official installer path, then a PATH `agy` verified not to be the IDE.
 * Returns null if no valid headless CLI is found.
 */
/**
 * Positively verify a candidate behaves like the real headless agy CLI by
 * running `--version` (read-only, fast). `isRealAgyCli` rejects the IDE launcher
 * by realpath; this adds behavioral verification for an *untrusted* PATH
 * candidate so we only run a binary proven to be the CLI.
 */
export function agyRespondsToVersion(bin: string): boolean {
  try {
    const out = execSync(`"${bin}" --version 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

export function resolveAgyBin(): string | null {
  // Explicit override (advanced users / tests): use it if valid, never silently
  // fall back to a different binary the user didn't ask for.
  const override = process.env.CODEV_AGY_BIN;
  if (override) return isRealAgyCli(override) ? override : null;

  // Canonical install path — trusted location; realpath-reject the IDE only.
  const preferred = path.join(homedir(), '.local', 'bin', 'agy');
  if (isRealAgyCli(preferred)) return preferred;

  // A bare PATH `agy` is untrusted: require it to NOT be the IDE (realpath) AND
  // to behave like the headless CLI (`--version`) before we'll run it.
  try {
    const found = execSync('command -v agy 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (found && isRealAgyCli(found) && agyRespondsToVersion(found)) return found;
  } catch {
    // not on PATH
  }
  return null;
}

/**
 * Lane-skip artifact: porch parses VERDICT: SKIPPED as "this lane produced no
 * review" — non-blocking for progression (the remaining reviewers still apply)
 * but excluded from approval math, so a skip can never masquerade as a passing
 * review (entriq #2467: a COMMENT stub nearly passed a defective money-critical
 * spec through a gate). The `SUMMARY: ... lane skipped` marker doubles as the
 * legacy-stub detector in porch's parseVerdict — keep both in sync.
 */
function agySkipContent(reason: string): string {
  return [
    '---',
    'VERDICT: SKIPPED',
    `SUMMARY: Gemini lane skipped — ${reason}`,
    'CONFIDENCE: LOW',
    '---',
    '',
    `The Gemini (Antigravity \`agy\`) reviewer was skipped: ${reason}. No review was`,
    'produced; porch records this lane as SKIPPED (not run) and the remaining',
    'reviewers still apply. To enable the Gemini lane, install the CLI',
    '(https://antigravity.google/cli/install.sh) and run `agy` once to sign in.',
  ].join('\n');
}

/**
 * Per-process sandbox temp dir for consult artifacts (the PR diff written by
 * buildPRQuery, and the large-prompt file written by runAgyConsultation).
 *
 * Created once per CLI invocation (each `consult` run is its own process), so the
 * sandboxed `agy` reviewer can be granted exactly this directory via `--add-dir`
 * instead of the entire OS temp dir — keeping the grant scoped to the artifacts
 * this flow creates. `mkdtempSync` yields a private, user-owned dir; callers still
 * write with mode 0o600 / flag 'wx' to defeat symlink/clobber races.
 */
let _consultSandboxDir: string | null = null;
function consultSandboxDir(): string {
  if (!_consultSandboxDir) {
    _consultSandboxDir = fs.mkdtempSync(path.join(tmpdir(), 'codev-consult-'));
  }
  return _consultSandboxDir;
}

function writeConsultOutput(outputPath: string | undefined, content: string): void {
  if (!outputPath || content.length === 0) return;
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, content);
  console.error(`\nOutput written to: ${outputPath}`);
}

function recordAgyMetrics(
  metricsCtx: MetricsContext | undefined,
  startTime: number,
  exitCode: number,
  errorMessage: string | null,
): void {
  if (!metricsCtx) return;
  recordMetrics(metricsCtx, {
    durationSeconds: (Date.now() - startTime) / 1000,
    // agy --print emits plain text, no token usage → cost rows degrade gracefully (null).
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    costUsd: null,
    exitCode,
    errorMessage,
  });
}

/**
 * Run the `gemini` consult lane via the Antigravity CLI (`agy --print`).
 * Preserves agentic file-reading (--sandbox --add-dir), folds the role into the
 * prompt, and NEVER blocks the run: a missing/unauthed/invalid CLI or a
 * timeout/error produces a non-blocking COMMENT skip instead of throwing.
 */
async function runAgyConsultation(
  queryText: string,
  role: string,
  workspaceRoot: string,
  outputPath?: string,
  metricsCtx?: MetricsContext,
): Promise<void> {
  const startTime = Date.now();

  const bin = resolveAgyBin();
  if (!bin) {
    const reason = 'agy CLI not found (install: https://antigravity.google/cli/install.sh)';
    const content = agySkipContent(reason);
    process.stdout.write(content);
    writeConsultOutput(outputPath, content);
    recordAgyMetrics(metricsCtx, startTime, 0, reason);
    console.error(`\n[gemini (agy) skipped: ${reason}]`);
    return;
  }

  // agy has no system-prompt flag — fold the role into the prompt (hermes precedent).
  // Prepend strict constraint directive to force agy to remain on-task, prevent exploratory actions
  // that lead to wandering off-task, and avoid unrelated local skills/directories (Issue #1032).
  const prependConstraints = [
    '=== CRITICAL: READ-ONLY HEADLESS MODE ===',
    'You are running in a non-interactive headless test harness.',
    '1. Do NOT list directories, check git status, check permissions, or run exploratory shell commands.',
    '2. Do NOT explore, read, or activate local skills or plugins (including google-antigravity-sdk) unless explicitly asked.',
    '3. Focus strictly on the review/consultation query. Read ONLY the target files specified in the prompt.',
    '4. You MUST output your response directly. If a review verdict is requested, end your response with a parseable verdict: VERDICT: APPROVE, VERDICT: REQUEST_CHANGES, or VERDICT: COMMENT.',
    '========================================='
  ].join('\n');

  const prompt = `${prependConstraints}\n\n${role}\n\n---\n\n${queryText}`;
  // Grant the sandboxed agent read access to the workspace AND the dedicated consult
  // sandbox dir (where buildPRQuery writes the diff and, below, a large-prompt file
  // lands) — NOT the entire OS temp dir, which would over-expose unrelated /tmp files.
  const addDirs = [workspaceRoot, consultSandboxDir()];
  let tempFile: string | null = null;
  let promptArg = prompt;
  // Large prompts can exceed ARG_MAX (E2BIG) — write to a temp file and point agy at it.
  if (prompt.length > CLI_PROMPT_INLINE_MAX_CHARS) {
    tempFile = path.join(consultSandboxDir(), `codev-consult-prompt-${Date.now()}.md`);
    fs.writeFileSync(tempFile, prompt);
    promptArg = [
      prependConstraints,
      `Read the full consultation prompt from this file: ${tempFile}`,
      'You have file access. Read files directly from disk to review code.',
    ].join('\n\n');
  }

  const args = ['--sandbox', '--print-timeout', AGY_PRINT_TIMEOUT];
  for (const d of addDirs) args.push('--add-dir', d);
  // agy 1.0.10 defines --print as a string-valued option, so its prompt must
  // immediately follow the flag rather than another option such as --sandbox.
  args.push('--print', promptArg);

  const cleanup = () => {
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch { /* best-effort */ }
    }
  };

  return new Promise<void>((resolve) => {
    const proc = spawn(bin, args, {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const outChunks: Buffer[] = [];
    let scanBuf = '';
    let settled = false;

    const settleSkip = (reason: string, exitCode = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      cleanup();
      const content = agySkipContent(reason);
      process.stdout.write(content);
      writeConsultOutput(outputPath, content);
      recordAgyMetrics(metricsCtx, startTime, exitCode, reason);
      console.error(`\n[gemini (agy) skipped: ${reason}]`);
      resolve();
    };

    const timer = setTimeout(
      () => settleSkip('agy timed out (no response)', 1),
      AGY_TIMEOUT_MS,
    );

    const watch = (buf: Buffer, isStdout: boolean) => {
      if (isStdout) outChunks.push(buf);
      if (scanBuf.length < AGY_MARKER_SCAN_LIMIT) {
        scanBuf += buf.toString('utf-8');
        if (AGY_OAUTH_MARKERS.some((m) => scanBuf.includes(m))) {
          settleSkip('agy not authenticated — run `agy` once to sign in (OAuth)', 1);
        }
      }
    };
    proc.stdout?.on('data', (b: Buffer) => watch(b, true));
    proc.stderr?.on('data', (b: Buffer) => watch(b, false));

    proc.on('error', (err) => {
      settleSkip(`agy failed to start: ${err.message}`, 1);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const raw = Buffer.concat(outChunks).toString('utf-8').trim();
      if (code !== 0 || raw.length === 0 || raw.includes(AGY_NONRESPONSE_MARKER)) {
        const reason = code !== 0
          ? `agy exited with code ${code}`
          : raw.includes(AGY_NONRESPONSE_MARKER)
            ? 'agy timed out producing the review'
            : 'agy produced no review output';
        const content = agySkipContent(reason);
        process.stdout.write(content);
        writeConsultOutput(outputPath, content);
        recordAgyMetrics(metricsCtx, startTime, code ?? 1, reason);
        console.error(`\n[gemini (agy) skipped: ${reason}]`);
        resolve();
        return;
      }
      // Plain-text stdout IS the review.
      process.stdout.write(raw);
      writeConsultOutput(outputPath, raw);
      recordAgyMetrics(metricsCtx, startTime, 0, null);
      console.error(`\n[gemini (agy) completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s]`);
      resolve();
    });
  });
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

  // gemini lane → Antigravity CLI (`agy`); handles its own logging, metrics,
  // and non-blocking skip (see runAgyConsultation).
  if (model === 'gemini') {
    const startTime = Date.now();
    await runAgyConsultation(query, role, workspaceRoot, outputPath, metricsCtx);
    logQuery(workspaceRoot, model, query, (Date.now() - startTime) / 1000);
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
  let cmd: string[];

  if (model === 'hermes') {
    // Hermes does not have a dedicated system prompt flag for single-shot mode.
    // Include role context at the top of the prompt.
    const hermesPrompt = `${role}\n\n---\n\n${query}`;

    // Large inline CLI args can exceed OS ARG_MAX and fail with E2BIG.
    // For very large prompts, write the full prompt to a temp file and pass
    // an instruction that points Hermes at that file.
    if (hermesPrompt.length > CLI_PROMPT_INLINE_MAX_CHARS) {
      tempFile = path.join(tmpdir(), `codev-consult-prompt-${Date.now()}.md`);
      fs.writeFileSync(tempFile, hermesPrompt);
      const instruction = [
        `Read the full consultation prompt from this file: ${tempFile}`,
        'You have file access. Read files directly from disk to review code.',
      ].join('\n\n');
      cmd = [config.cli, ...config.args, instruction];
    } else {
      cmd = [config.cli, ...config.args, hermesPrompt];
    }
  } else {
    throw new Error(`Unknown model: ${model}`);
  }

  // Execute with passthrough stdio. stdin is 'ignore' (hermes passes its prompt
  // via argv) — prevents blocking when spawned as a subprocess.
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: workspaceRoot,
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
 *
 * `ref` is passed as a single argv element so branch names with shell
 * metacharacters can't break out of the command (#777 cmap-3 follow-up).
 */
function getDiffStat(workspaceRoot: string, ref: string): { stat: string; files: string[] } {
  const stat = execFileSync('git', ['diff', '--stat', ref], { cwd: workspaceRoot, encoding: 'utf-8' });
  const nameOnly = execFileSync('git', ['diff', '--name-only', ref], { cwd: workspaceRoot, encoding: 'utf-8' });
  const files = nameOnly.trim().split('\n').filter(Boolean);
  return { stat, files };
}

/**
 * Fetch PR metadata via forge concept commands (no diff — that's fetched separately).
 */
function fetchPRData(prId: string): { info: string; changedFiles: string[]; comments: string } {
  console.error(`Fetching PR #${prId} data...`);

  try {
    const prView = executeForgeCommandSync('pr-view', {
      CODEV_PR_NUMBER: prId,
    });
    const info = typeof prView === 'string' ? prView : JSON.stringify(prView);

    const diffResult = executeForgeCommandSync('pr-diff', {
      CODEV_PR_NUMBER: prId,
      CODEV_DIFF_NAME_ONLY: '1',
    }, { raw: true });
    const nameOnly = typeof diffResult === 'string' ? diffResult : '';
    const changedFiles = nameOnly.trim().split('\n').filter(Boolean);

    let comments = '(No comments)';
    try {
      // Fetch PR comments via pr-view concept with CODEV_INCLUDE_COMMENTS flag
      const commentsResult = executeForgeCommandSync('pr-view', {
        CODEV_PR_NUMBER: prId,
        CODEV_INCLUDE_COMMENTS: '1',
      }, { raw: true });
      if (commentsResult && typeof commentsResult === 'string' && commentsResult.trim()) {
        comments = commentsResult;
      }
    } catch {
      // No comments or error fetching
    }

    return { info, changedFiles, comments };
  } catch (err) {
    throw new Error(`Failed to fetch PR data: ${err}`);
  }
}

/**
 * Fetch the full PR diff via the pr-diff forge concept command.
 */
function fetchPRDiff(prId: string): string {
  try {
    const result = executeForgeCommandSync('pr-diff', {
      CODEV_PR_NUMBER: prId,
    }, { raw: true });
    return typeof result === 'string' ? result : '';
  } catch (err) {
    throw new Error(`Failed to fetch PR diff for #${prId}: ${err}`);
  }
}

/**
 * Compose the PR review prompt text from already-fetched pieces.
 *
 * Split from the I/O wrapper so it can be tested without mocking the forge
 * layer. Points the model at a temp-file path rather than inlining the diff:
 * large (~800KB+) inlined diffs blow past the gemini-cli JSON path and bloat
 * prompts for all models (#684).
 */
function composePRQueryText(params: {
  prId: string;
  info: string;
  changedFiles: string[];
  comments: string;
  diffPath: string;
  diffBytes: number;
  diffLines: number;
}): string {
  const { prId, info, changedFiles, comments, diffPath, diffBytes, diffLines } = params;
  const fileList = changedFiles.map(f => `- ${f}`).join('\n');
  const diffSizeKb = (diffBytes / 1024).toFixed(1);

  return `Review Pull Request #${prId}

## PR Info
\`\`\`json
${info}
\`\`\`

## Changed Files (${changedFiles.length})
${fileList}

## PR Diff
The full PR diff is **not inlined** in this prompt to keep the payload small. It has been written to this path on disk:

**Diff file**: \`${diffPath}\`
**Size**: ${diffSizeKb} KB (${diffBytes} bytes, ${diffLines} lines)

## How to Review
1. **Read the diff file** from \`${diffPath}\` to see the exact changes (use the Read tool or \`cat\`).
2. You have **full filesystem access** — read any project files from disk for surrounding context beyond what the diff shows.

## Comments
${comments}

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
 * Resolve the integration-branch base override for `--type integration`.
 *
 * Precedence: explicit `--base <ref>` flag → `consult.integrationBranch` from
 * the merged config (.codev/config.json etc.) → undefined (default behavior,
 * `gh pr diff`). Returns a bare branch name (e.g. `ci`), which the local-diff
 * machinery prefixes with `origin/`. (#1113)
 *
 * Config-load errors (malformed `.codev/config.json`, legacy `af-config.json`,
 * invalid harness config) are NOT swallowed — they propagate, matching every
 * other `loadConfig` caller. Swallowing them would let a broken
 * `consult.integrationBranch` silently revert to `gh pr diff` (the overflow this
 * fix prevents) with no signal why. The explicit `--base` flag short-circuits
 * before the config read, so it still works even with a broken config.
 */
function resolveIntegrationBase(workspaceRoot: string, baseOption?: string): string | undefined {
  if (baseOption) return baseOption;
  return loadConfig(workspaceRoot).consult?.integrationBranch;
}

/**
 * Compute the PR diff locally as a three-dot diff anchored on a base-branch
 * override, instead of relying on the host's `gh pr diff` (which is anchored on
 * the PR's host-recorded base). Mirrors the `--type impl` machinery: fetch both
 * refs, verify both resolve, then `git diff origin/<base>...origin/<head>`.
 *
 * Three-dot (`A...B`) is `git diff $(git merge-base A B) B` — the meaningful
 * change set, excluding commits the base branch picked up since head forked.
 * This is what keeps the diff small in a `ci`-ahead-of-`main` topology (#1113).
 *
 * Fails loudly with an actionable `git fetch` hint if either ref is
 * unresolvable — it never silently degrades to reviewing the checked-out tree
 * (the cmap-3 degradation guarded against in the impl path). Refs are passed as
 * single argv elements (execFileSync) so branch names with shell metacharacters
 * can't break out (#777 cmap-3 follow-up).
 */
function computeLocalPRDiff(
  workspaceRoot: string,
  baseRef: string,
  headRef: string,
): { diff: string; changedFiles: string[] } {
  // Fetch both refs so the diff has fresh local tracking refs. Fetch failures
  // are non-fatal (a locally-cached copy may suffice) but surfaced as warnings.
  for (const ref of [baseRef, headRef]) {
    try {
      execFileSync('git', ['fetch', 'origin', ref], { cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr).trim() : '';
      console.error(
        `Warning: \`git fetch origin ${ref}\` failed; proceeding with any locally-cached copy. ` +
        `Stale refs may produce misleading diffs.` +
        (stderr ? ` Underlying: ${stderr}` : '')
      );
    }
  }

  // Verify both refs resolve up front. Without this, a later `git diff` against
  // a missing ref would fail and (in buildImplQuery's case) silently drop the
  // reviewer into "explore the filesystem" — degrading to whatever's checked
  // out locally. Crash explicitly with an actionable message instead.
  try {
    for (const ref of [baseRef, headRef]) {
      execFileSync('git', ['rev-parse', '--verify', `origin/${ref}`], {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  } catch (err) {
    throw new Error(
      `Cannot compute integration diff scope (origin/${baseRef}...origin/${headRef}). ` +
      `Ensure both refs are fetched: \`git fetch origin ${baseRef} ${headRef}\`. ` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const range = `origin/${baseRef}...origin/${headRef}`;
  const diff = execFileSync('git', ['diff', range], {
    cwd: workspaceRoot,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const nameOnly = execFileSync('git', ['diff', '--name-only', range], { cwd: workspaceRoot, encoding: 'utf-8' });
  const changedFiles = nameOnly.trim().split('\n').filter(Boolean);
  return { diff, changedFiles };
}

/**
 * Build query for PR review.
 *
 * Writes the full PR diff to a temp file and points the model at the path
 * instead of inlining it. Inlining large diffs (~800KB+) caused gemini-cli's
 * JSON output path to fail with "Unexpected end of JSON input" in 0.3s
 * (#684); it also bloats prompts for Claude/Codex. This mirrors the pattern
 * used by buildImplQuery.
 *
 * The temp file is left in place for the model to read during consultation.
 * OS /tmp rotation handles cleanup.
 *
 * When `localDiff` is provided (the `--type integration` base-override path,
 * #1113), its diff and changed-file list are used instead of `gh pr diff` /
 * the host-recorded base — PR info and comments are still fetched normally.
 */
function buildPRQuery(prId: string, localDiff?: { diff: string; changedFiles: string[] }): string {
  const prData = fetchPRData(prId);
  const diff = localDiff ? localDiff.diff : fetchPRDiff(prId);
  const changedFiles = localDiff ? localDiff.changedFiles : prData.changedFiles;

  // Private-per-user dir to avoid world-readable /tmp diffs + symlink/clobber
  // races: consultSandboxDir() is a fresh mkdtempSync dir owned by us (and the
  // only temp dir granted to the sandboxed agy reviewer); writeFileSync with
  // flag 'wx' refuses to follow a symlink or overwrite an existing file.
  const diffDir = consultSandboxDir();
  const diffPath = path.join(diffDir, `pr-${prId}.diff`);
  fs.writeFileSync(diffPath, diff, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });

  const diffBytes = Buffer.byteLength(diff, 'utf-8');
  const diffLines = diff ? diff.split('\n').length : 0;

  return composePRQueryText({
    prId,
    info: prData.info,
    changedFiles,
    comments: prData.comments,
    diffPath,
    diffBytes,
    diffLines,
  });
}

/**
 * Build query for spec review
 */
function buildSpecQuery(spec: ContentRef, plan: ContentRef | null): string {
  let query = `Review Specification: ${spec.label}

## Specification

${spec.content}

`;

  if (plan) {
    query += `## Plan

${plan.content}

`;
  }

  query += `Please review:
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
  spec: ContentRef | null,
  plan: ContentRef | null,
  planPhase?: string,
  diffRef?: string,
): string {
  // Get compact diff summary
  let diffStat = '';
  let changedFiles: string[] = [];
  try {
    const defaultBranch = resolveDefaultBranch(workspaceRoot);
    const ref = diffRef ?? execFileSync('git', ['merge-base', 'HEAD', defaultBranch], { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
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

  query += '\n\n';

  if (spec) {
    query += `## Specification\n\n${spec.content}\n\n`;
  }
  if (plan) {
    query += `## Plan\n\n${plan.content}\n\n`;
  }

  if (planPhase) {
    query += `## REVIEW SCOPE — CURRENT PLAN PHASE ONLY\n`;
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
    query += `\n### Scope is the file list above\n`;
    query += `The files above are the canonical scope of this PR (three-dot diff against the PR's base, equivalent to GitHub's PR view). `;
    query += `If this PR targets an integration branch, the file list reflects the diff against that integration branch — not necessarily \`main\`. `;
    query += `Do not flag files outside this list, even if you see other changes in the worktree. `;
    query += `If you compute a diff yourself, use \`git diff <base>...HEAD\` (three-dot) — never two-dot, which over-includes commits the base branch picked up since this branch was created.\n`;
  } else {
    query += `\n## Instructions\n\n`;
    query += `Explore the filesystem to find and review the implementation changes. `;
    query += `If you compute a diff yourself, use \`git diff <base>...HEAD\` (three-dot, anchored at the merge-base) — never two-dot, which over-includes commits the base branch picked up since this branch was created.\n`;
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
function buildPlanQuery(plan: ContentRef, spec: ContentRef | null): string {
  let query = `Review Implementation Plan: ${plan.label}

## Plan

${plan.content}

`;

  if (spec) {
    query += `## Specification (for context)

${spec.content}

`;
  }

  query += `Please review:
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
  spec: ContentRef | null,
  plan: ContentRef | null,
): string {
  let phaseDiff = '';
  try {
    phaseDiff = execSync('git show HEAD', { cwd: workspaceRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch {
    // If git show fails, reviewer explores filesystem
  }

  let query = `Review Phase Implementation: "${planPhase}"\n\n`;

  if (spec) query += `## Specification\n\n${spec.content}\n\n`;
  if (plan) query += `## Plan\n\n${plan.content}\n\n`;

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
 * Find PR number for the current branch via pr-search forge concept.
 */
function findPRForCurrentBranch(workspaceRoot: string): string {
  const branchName = execSync('git branch --show-current', { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
  const result = executeForgeCommandSync('pr-search', {
    CODEV_SEARCH_QUERY: `head:${branchName}`,
  }, { cwd: workspaceRoot });

  const prs = Array.isArray(result) ? result as Array<{ number: number }> : [];
  if (prs.length === 0 || !prs[0]?.number) {
    throw new Error(`No PR found for branch: ${branchName}`);
  }

  return String(prs[0].number);
}

/**
 * Find PR number for a given issue number (architect mode) via pr-search forge concept.
 *
 * Returns the PR's `baseRefName` alongside `headRefName` so the architect-mode
 * impl path can compute the merge-base against the PR's *actual* base, not the
 * repo's default branch. This matters when the PR targets a non-default
 * integration branch — same #777 false-positive class as Layer 1, one layer
 * deeper. Found by cmap-3 review.
 *
 * Defensive fallback: if a project ships its own `pr-search.sh` override at
 * `.codev/scripts/forge/github/pr-search.sh` that pre-dates the baseRefName
 * addition, the JSON won't include it. Rather than crashing on a stale
 * override (which is the kind of thing users only discover at the worst
 * possible moment), substitute the repo's default branch and warn loudly.
 */
function findPRForIssue(workspaceRoot: string, issueId: string): { number: number; headRefName: string; baseRefName: string } {
  const result = executeForgeCommandSync('pr-search', {
    CODEV_SEARCH_QUERY: issueId,
  }, { cwd: workspaceRoot });

  const prs = Array.isArray(result) ? result as Array<{ number: number; headRefName: string; baseRefName?: string }> : [];
  if (prs.length === 0 || !prs[0]?.number) {
    throw new Error(`No PR found for issue #${issueId}`);
  }

  const pr = prs[0];
  if (!pr.baseRefName) {
    const defaultBranch = resolveDefaultBranch(workspaceRoot);
    console.error(
      `Warning: forge pr-search did not return baseRefName for PR #${pr.number}; ` +
      `falling back to repo default branch \`${defaultBranch}\`. ` +
      `This usually means a stale \`pr-search.sh\` override exists at ` +
      `.codev/scripts/forge/github/pr-search.sh — refresh it (see the bundled version under ` +
      `\`packages/codev/scripts/forge/github/pr-search.sh\` for the current shape).`
    );
    return { number: pr.number, headRefName: pr.headRefName, baseRefName: defaultBranch };
  }

  return { number: pr.number, headRefName: pr.headRefName, baseRefName: pr.baseRefName };
}

/**
 * Resolve query for builder context (auto-detected from porch state)
 */
function resolveBuilderQuery(workspaceRoot: string, type: string, options: ConsultOptions): string {
  const projectState = getBuilderProjectState(workspaceRoot, options.projectId);
  const projectId = projectState.id;

  switch (type) {
    case 'spec': {
      const spec = findSpecContent(workspaceRoot, projectId);
      if (!spec) throw new Error(`Spec ${projectId} not found`);
      const plan = findPlanContent(workspaceRoot, projectId);
      console.error(`Spec: ${spec.label}`);
      if (plan) console.error(`Plan: ${plan.label}`);
      return buildSpecQuery(spec, plan);
    }

    case 'plan': {
      const plan = findPlanContent(workspaceRoot, projectId);
      if (!plan) throw new Error(`Plan ${projectId} not found`);
      const spec = findSpecContent(workspaceRoot, projectId);
      console.error(`Plan: ${plan.label}`);
      if (spec) console.error(`Spec: ${spec.label}`);
      return buildPlanQuery(plan, spec);
    }

    case 'impl': {
      const spec = findSpecContent(workspaceRoot, projectId);
      const plan = findPlanContent(workspaceRoot, projectId);
      console.error(`Project: ${projectId}`);
      if (spec) console.error(`Spec: ${spec.label}`);
      if (plan) console.error(`Plan: ${plan.label}`);
      if (options.planPhase) console.error(`Plan phase: ${options.planPhase}`);
      return buildImplQuery(workspaceRoot, spec, plan, options.planPhase);
    }

    case 'pr': {
      const prId = findPRForCurrentBranch(workspaceRoot);
      console.error(`PR: #${prId}`);
      return buildPRQuery(prId);
    }

    case 'phase': {
      const currentPhase = options.planPhase ?? projectState.currentPlanPhase;
      if (!currentPhase) {
        throw new Error('No current plan phase detected. Use --plan-phase to specify.');
      }
      const spec = findSpecContent(workspaceRoot, projectId);
      const plan = findPlanContent(workspaceRoot, projectId);
      console.error(`Phase: ${currentPhase}`);
      if (spec) console.error(`Spec: ${spec.label}`);
      if (plan) console.error(`Plan: ${plan.label}`);
      return buildPhaseQuery(workspaceRoot, currentPhase, spec, plan);
    }

    case 'integration': {
      const prId = findPRForCurrentBranch(workspaceRoot);
      console.error(`PR: #${prId} (integration review)`);
      const base = resolveIntegrationBase(workspaceRoot, options.base);
      if (base) {
        // Head is the builder's current branch (== the PR's head by construction).
        const headRef = execSync('git branch --show-current', { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
        console.error(`Integration base: origin/${base} (three-dot diff vs origin/${headRef})`);
        const localDiff = computeLocalPRDiff(workspaceRoot, base, headRef);
        return buildPRQuery(prId, localDiff);
      }
      return buildPRQuery(prId);
    }

    default:
      throw new Error(`Unknown review type: ${type}\nValid types: spec, plan, impl, pr, phase, integration`);
  }
}

/**
 * Pick the artifact resolver for an architect-mode consult.
 *
 * Closes #777 Defect A. Resolution order:
 *   1. Explicit `--branch <ref>` → read from that ref.
 *   2. PR exists for the issue → read from `origin/<headRefName>`. This is
 *      the routine "architect supplying missing consult" case.
 *   3. Neither → fall back to the local workspace, with a warning so the
 *      architect knows the verdict may target a stale artifact.
 */
function resolveArtifactSource(
  workspaceRoot: string,
  issueId: string,
  branchOption: string | undefined,
): { resolver: ArtifactResolver; sourceLabel: string } {
  if (branchOption) {
    return {
      resolver: new GitRefResolver(workspaceRoot, branchOption),
      sourceLabel: `--branch ${branchOption}`,
    };
  }

  try {
    const pr = findPRForIssue(workspaceRoot, issueId);
    const ref = `origin/${pr.headRefName}`;
    return {
      resolver: new GitRefResolver(workspaceRoot, ref),
      sourceLabel: `${ref} (PR #${pr.number})`,
    };
  } catch {
    console.error(
      `Warning: no PR found for issue #${issueId} and no --branch given; ` +
      `reading spec/plan from local workspace. Verdicts may not reflect ` +
      `the in-progress version.`,
    );
    return {
      resolver: getResolver(workspaceRoot),
      sourceLabel: 'local workspace',
    };
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

  const issueId = options.issue;

  switch (type) {
    case 'spec': {
      const { resolver, sourceLabel } = resolveArtifactSource(workspaceRoot, issueId, options.branch);
      const spec = findSpecContent(workspaceRoot, issueId, resolver);
      if (!spec) throw new Error(`Spec ${issueId} not found at ${sourceLabel}`);
      const plan = findPlanContent(workspaceRoot, issueId, resolver);
      console.error(`Source: ${sourceLabel}`);
      console.error(`Spec: ${spec.label}`);
      if (plan) console.error(`Plan: ${plan.label}`);
      return buildSpecQuery(spec, plan);
    }

    case 'plan': {
      const { resolver, sourceLabel } = resolveArtifactSource(workspaceRoot, issueId, options.branch);
      const plan = findPlanContent(workspaceRoot, issueId, resolver);
      if (!plan) throw new Error(`Plan ${issueId} not found at ${sourceLabel}`);
      const spec = findSpecContent(workspaceRoot, issueId, resolver);
      console.error(`Source: ${sourceLabel}`);
      console.error(`Plan: ${plan.label}`);
      if (spec) console.error(`Spec: ${spec.label}`);
      return buildPlanQuery(plan, spec);
    }

    case 'impl': {
      const pr = findPRForIssue(workspaceRoot, issueId);
      // Fetch both the PR head and its base so the diff has local refs to
      // work with. Fetch failures are non-fatal in the already-cached case,
      // but auth/network failures can leave us with stale local tracking
      // refs — surface them so the architect knows the diff may be
      // misleading.
      for (const ref of [pr.headRefName, pr.baseRefName]) {
        try {
          execFileSync('git', ['fetch', 'origin', ref], { cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
          const stderr = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr).trim() : '';
          console.error(
            `Warning: \`git fetch origin ${ref}\` failed; proceeding with any locally-cached copy. ` +
            `Stale refs may produce misleading diffs.` +
            (stderr ? ` Underlying: ${stderr}` : '')
          );
        }
      }

      // Use the PR's actual base (not the repo's default branch) as the
      // merge-base anchor. cmap-3 finding: when a PR targets a non-default
      // integration branch, defaultBranch was the wrong anchor and produced
      // phantom scope-creep verdicts of the same shape as the hardcoded-
      // `main` bug — one layer deeper.
      //
      // Three-dot in `git diff A...B` is documented as `git diff
      // $(git merge-base A B) B` — git computes the merge-base internally,
      // so an explicit `git merge-base` call would be redundant. We just
      // verify the base ref is locally resolvable and let the three-dot
      // form do the rest. If verification fails, crash explicitly rather
      // than silently degrade to reviewing the architect's checked-out
      // tree (cmap-3 Gemini finding).
      // Verify both refs up front. Without verifying head, getDiffStat would
      // fail later inside buildImplQuery, which swallows diff errors and drops
      // the reviewer into "explore the filesystem" — silently degrading the
      // architect-mode review against whatever's checked out locally. Verify
      // both so the failure surfaces here with an actionable message.
      // cmap-3 round-2 finding (Codex).
      let diffRef: string;
      try {
        for (const refName of [pr.baseRefName, pr.headRefName]) {
          execFileSync('git', ['rev-parse', '--verify', `origin/${refName}`], {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        }
        diffRef = `origin/${pr.baseRefName}...origin/${pr.headRefName}`;
      } catch (err) {
        throw new Error(
          `Cannot compute diff scope for PR #${pr.number} (${pr.headRefName} → ${pr.baseRefName}). ` +
          `Ensure both refs are fetched: \`git fetch origin ${pr.baseRefName} ${pr.headRefName}\`. ` +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Read spec/plan from the PR's branch by default so they match the
      // diff source (#777 Defect A). --branch overrides the PR default; the
      // diff scope itself is always the PR's head→base (--branch does not
      // change diff scope, only artifact source — cmap-3 finding).
      const ref = options.branch ?? `origin/${pr.headRefName}`;
      const resolver = new GitRefResolver(workspaceRoot, ref);
      const spec = findSpecContent(workspaceRoot, issueId, resolver);
      const plan = findPlanContent(workspaceRoot, issueId, resolver);
      console.error(`Project: ${issueId} (PR #${pr.number}, ${pr.headRefName} → ${pr.baseRefName})`);
      console.error(`Source: ${ref}`);
      if (spec) console.error(`Spec: ${spec.label}`);
      if (plan) console.error(`Plan: ${plan.label}`);
      return buildImplQuery(workspaceRoot, spec, plan, options.planPhase, diffRef);
    }

    case 'pr': {
      const pr = findPRForIssue(workspaceRoot, issueId);
      console.error(`PR: #${pr.number}`);
      return buildPRQuery(String(pr.number));
    }

    case 'integration': {
      const pr = findPRForIssue(workspaceRoot, issueId);
      console.error(`PR: #${pr.number} (integration review)`);
      const base = resolveIntegrationBase(workspaceRoot, options.base);
      if (base) {
        console.error(`Integration base: origin/${base} (three-dot diff vs origin/${pr.headRefName})`);
        const localDiff = computeLocalPRDiff(workspaceRoot, base, pr.headRefName);
        return buildPRQuery(String(pr.number), localDiff);
      }
      return buildPRQuery(String(pr.number));
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

  // --base is an integration-review-only override (#1113). Reject it on other
  // types rather than silently ignoring it (fail-fast).
  if (options.base && options.type !== 'integration') {
    throw new Error(
      '--base only applies to --type integration.\n' +
      'It overrides the integration diff base, e.g. consult -m codex --type integration --issue 42 --base ci'
    );
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
  if (model === 'gemini' || model === 'hermes') {
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

  // Auto-generate persistent output path when --output is not provided.
  // In builder context with protocol mode, write results to the project
  // directory so they survive Claude Code's temp file cleanup (#512).
  // Skip when --issue is set (architect-mode query from builder worktree).
  let outputPath = options.output;
  const shouldAutoPersist = isBuilderContext() && !options.issue;
  if (!outputPath && hasType && shouldAutoPersist) {
    try {
      const projectState = getBuilderProjectState(workspaceRoot, options.projectId);
      outputPath = computePersistentOutputPath(projectState, model);
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      console.error(`Auto-persist: ${outputPath}`);
    } catch {
      // If we can't compute a persistent path (e.g., no project state),
      // continue without — output will still go to stdout.
    }
  }

  const isGeneralMode = !hasType;
  await runConsultation(model, query, workspaceRoot, role, outputPath, metricsCtx, isGeneralMode);
}

// Exported for testing
export {
  getDiffStat as _getDiffStat,
  buildSpecQuery as _buildSpecQuery,
  buildPlanQuery as _buildPlanQuery,
  buildPRQuery as _buildPRQuery,
  composePRQueryText as _composePRQueryText,
  computeLocalPRDiff as _computeLocalPRDiff,
  resolveIntegrationBase as _resolveIntegrationBase,
  resolveArchitectQuery as _resolveArchitectQuery,
  computePersistentOutputPath as _computePersistentOutputPath,
  MODEL_CONFIGS as _MODEL_CONFIGS,
  MODEL_ALIASES as _MODEL_ALIASES,
  runAgyConsultation as _runAgyConsultation,
  agySkipContent as _agySkipContent,
};
