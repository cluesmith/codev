/**
 * consult - AI consultation with external models
 *
 * Provides unified interface to gemini-cli, codex, and claude CLIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import chalk from 'chalk';
import { resolveCodevFile, readCodevFile, findProjectRoot } from '../../lib/skeleton.js';

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
  codex: { cli: 'codex', args: ['exec', '--full-auto'], envVar: null },
  claude: { cli: 'claude', args: ['--print', '-p'], envVar: null },
};

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
 * Checks local codev/roles/review-types/{type}.md first, then falls back to embedded skeleton.
 */
function loadReviewTypePrompt(projectRoot: string, reviewType: string): string | null {
  const promptPath = `roles/review-types/${reviewType}.md`;
  const prompt = readCodevFile(promptPath, projectRoot);
  return prompt;
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
 * Run the consultation
 */
async function runConsultation(
  model: string,
  query: string,
  projectRoot: string,
  dryRun: boolean,
  reviewType?: string
): Promise<void> {
  let role = loadRole(projectRoot);

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

  // Prepare command and environment based on model
  let cmd: string[];

  if (model === 'gemini') {
    // Gemini uses GEMINI_SYSTEM_MD env var for role
    tempFile = path.join(tmpdir(), `codev-role-${Date.now()}.md`);
    fs.writeFileSync(tempFile, role);
    env['GEMINI_SYSTEM_MD'] = tempFile;

    // Handle GOOGLE_API_KEY vs GEMINI_API_KEY conflict
    if (process.env['GOOGLE_API_KEY'] && process.env['GEMINI_API_KEY']) {
      env['GEMINI_API_KEY'] = '';
    }

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
  } else if (model === 'claude') {
    // Claude gets role prepended to query
    const fullQuery = `${role}\n\n---\n\nConsultation Request:\n${query}`;
    cmd = [config.cli, ...config.args, fullQuery, '--dangerously-skip-permissions'];
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
  const fullEnv = { ...process.env, ...env };
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      env: fullEnv,
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      const duration = (Date.now() - startTime) / 1000;
      logQuery(projectRoot, model, query, duration);

      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
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
 * Build query for PR review
 */
function buildPRQuery(prNumber: number, projectRoot: string): string {
  const dataDir = path.join(projectRoot, '.consult', `pr-${String(prNumber).padStart(4, '0')}`);

  return `Review Pull Request #${prNumber}

Available data files (read these to understand the PR):
- PR Info: ${dataDir}/pr-info.txt
- Comments: ${dataDir}/pr-comments.txt
- Diff: ${dataDir}/pr-diff.patch
- Files JSON: ${dataDir}/pr-files.json

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
  const { model: modelInput, subcommand, args, dryRun = false, reviewType } = options;

  // Resolve model alias
  const model = MODEL_ALIASES[modelInput.toLowerCase()] || modelInput.toLowerCase();

  // Validate model
  if (!MODEL_CONFIGS[model]) {
    const validModels = [...Object.keys(MODEL_CONFIGS), ...Object.keys(MODEL_ALIASES)];
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

    default:
      throw new Error(`Unknown subcommand: ${subcommand}\nValid subcommands: pr, spec, plan, general`);
  }

  console.error('');
  console.error('='.repeat(60));
  console.error(`[${model.toUpperCase()}] Starting consultation...`);
  console.error('='.repeat(60));
  console.error('');

  await runConsultation(model, query, projectRoot, dryRun, reviewType);
}
