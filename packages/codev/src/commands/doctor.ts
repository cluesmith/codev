/**
 * codev doctor - Check system dependencies
 *
 * Port of codev/bin/codev-doctor to TypeScript
 */

import { execSync, spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { executeForgeCommandSync, loadForgeConfig, validateForgeConfig, resolveAllConcepts, type ConceptResolution } from '../lib/forge.js';
import { detectHarnessFromCommand, getRetirement } from '../agent-farm/utils/harness.js';
import { auditPrGates, formatPrGateWarning } from '../lib/pr-gate-audit.js';
import { auditStateFileIgnore } from '../lib/gitignore.js';
import { auditFrameworkRefs, formatFrameworkRefFinding, hasFrameworkOverrides } from '../lib/framework-ref-audit.js';
import {
  auditProtocolDrift,
  checkSkeletonStaleness,
  formatDriftFinding,
  formatStaleness,
} from '../lib/protocol-drift-audit.js';
import {
  findMigrationBackups,
  formatMigrationBackup,
  formatBytes,
  totalBytes,
  STALE_BACKUP_AGE_DAYS,
} from '../lib/migration-backup-audit.js';
import { resolveAgyBin, AGY_OAUTH_MARKERS } from './consult/index.js';
import { checkCachedAgyAuth, recordAgyAuthState } from './consult/agy-auth-cache.js';
import { AGENT_FARM_DIR } from '@cluesmith/codev-core/constants';
import {
  measureSessionLogs,
  resolveLogRetentionDays,
  formatBytes as formatLogBytes,
} from '../agent-farm/servers/session-log-sweep.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Dependency {
  name: string;
  command: string;
  versionArg: string;
  versionExtract: (output: string) => string | null;
  minVersion?: string;
  required: boolean;
  installHint: {
    macos: string;
    linux: string;
  };
}

interface CheckResult {
  status: 'ok' | 'warn' | 'fail' | 'skip';
  version: string;
  note?: string;
}

const isMacOS = process.platform === 'darwin';

/**
 * Footprint at which the PTY session log directory becomes a reportable warning
 * rather than an informational line (#1238). Well past what a healthy retention
 * sweep leaves behind, and well under the 19 GB that prompted the issue.
 */
export const SESSION_LOG_WARN_BYTES = 2 * 1024 * 1024 * 1024;

export interface SessionLogCheck {
  status: 'ok' | 'warn';
  files: number;
  bytes: number;
  retentionDays: number;
  /** Human-readable footprint, e.g. `741 file(s), 2.1 GB`. No colour codes. */
  summary: string;
  /** e.g. `retention 30d` / `retention disabled`. */
  retentionNote: string;
  /** Present only when `status === 'warn'`. */
  recommendation?: string;
}

/**
 * Decide what the "Session Logs" doctor section should say (#1238).
 *
 * Split out from `doctor()` so the decision — thresholds, the retention-disabled
 * wording, the remediation hint — is unit-testable against a temp directory.
 * `doctor()` itself passes the real user-global `~/.agent-farm/logs`, which is
 * the whole point of the check, so the *reporting* path is deliberately not
 * hermetic; this function is where the logic lives and is pinned by tests.
 */
export function checkSessionLogs(
  logDir: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionLogCheck {
  const { files, bytes } = measureSessionLogs(logDir);
  const retentionDays = resolveLogRetentionDays(env);
  const retentionNote = retentionDays === 0 ? 'retention disabled' : `retention ${retentionDays}d`;

  if (files === 0) {
    return {
      status: 'ok',
      files,
      bytes,
      retentionDays,
      summary: 'No PTY session logs on disk',
      retentionNote,
    };
  }

  const summary = `${files} file(s), ${formatLogBytes(bytes)}`;
  if (bytes < SESSION_LOG_WARN_BYTES) {
    return { status: 'ok', files, bytes, retentionDays, summary, retentionNote };
  }

  return {
    status: 'warn',
    files,
    bytes,
    retentionDays,
    summary,
    retentionNote,
    recommendation: retentionDays === 0
      ? 'retention is disabled (AGENT_FARM_LOG_RETENTION_DAYS=0) — unset it and restart Tower to let the sweep run'
      : 'restart Tower to run the retention sweep (afx tower stop && afx tower start)',
  };
}

/**
 * Compare semantic versions: returns true if v1 >= v2
 */
function versionGte(v1: string, v2: string): boolean {
  const v1Parts = v1.split('.').map(p => parseInt(p.replace(/[^0-9]/g, ''), 10) || 0);
  const v2Parts = v2.split('.').map(p => parseInt(p.replace(/[^0-9]/g, ''), 10) || 0);

  for (let i = 0; i < 3; i++) {
    const p1 = v1Parts[i] || 0;
    const p2 = v2Parts[i] || 0;
    if (p1 > p2) return true;
    if (p1 < p2) return false;
  }
  return true;
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
 * Run a command and get its output
 */
function runCommand(cmd: string, args: string[]): string | null {
  try {
    const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 5000 });
    if (result.status === 0) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Print status line with color
 */
function printStatus(name: string, result: CheckResult): void {
  const { status, version, note } = result;

  let icon: string;
  let color: typeof chalk;

  switch (status) {
    case 'ok':
      icon = chalk.green('✓');
      color = chalk;
      break;
    case 'warn':
      icon = chalk.yellow('⚠');
      color = chalk;
      break;
    case 'fail':
      icon = chalk.red('✗');
      color = chalk;
      break;
    case 'skip':
      icon = chalk.blue('○');
      color = chalk;
      break;
  }

  let line = `  ${icon} ${name.padEnd(12)} ${version}`;
  if (note) {
    line += chalk.blue(` (${note})`);
  }
  console.log(line);
}

// Core dependencies
const CORE_DEPENDENCIES: Dependency[] = [
  {
    name: 'Node.js',
    command: 'node',
    versionArg: '--version',
    versionExtract: (output) => output.replace(/^v/, ''),
    minVersion: '18.0.0',
    required: true,
    installHint: {
      macos: 'brew install node',
      linux: 'apt install nodejs npm',
    },
  },
  {
    name: 'git',
    command: 'git',
    versionArg: '--version',
    versionExtract: (output) => {
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    },
    minVersion: '2.5.0',
    required: true,
    installHint: {
      macos: 'xcode-select --install',
      linux: 'apt install git',
    },
  },
];

// AI CLI dependencies - at least one required
// Note: Claude is verified via Agent SDK (not CLI), handled separately below
// Note: the gemini lane now uses the Antigravity CLI (agy) — checked separately
// via resolveAgyBin (the bare `which agy` resolves to the IDE symlink, not the CLI).
const AI_DEPENDENCIES: Dependency[] = [
  {
    name: 'Codex',
    command: 'codex',
    versionArg: '--version',
    versionExtract: () => 'working',
    required: false,
    installHint: {
      macos: 'npm i -g @openai/codex',
      linux: 'npm i -g @openai/codex',
    },
  },
  {
    name: 'OpenCode',
    command: 'opencode',
    versionArg: '--version',
    versionExtract: () => 'working',
    required: false,
    installHint: {
      macos: 'npm install -g opencode-ai',
      linux: 'npm install -g opencode-ai',
    },
  },
];

/**
 * Check a single dependency
 */
function checkDependency(dep: Dependency): CheckResult {
  if (!commandExists(dep.command)) {
    const hint = isMacOS ? dep.installHint.macos : dep.installHint.linux;
    return {
      status: dep.required ? 'fail' : 'skip',
      version: 'not installed',
      note: hint,
    };
  }

  // Get version
  const output = runCommand(dep.command, dep.versionArg.split(' '));
  if (!output) {
    return {
      status: 'warn',
      version: '(version unknown)',
      note: 'may be incompatible',
    };
  }

  const version = dep.versionExtract(output);
  if (!version) {
    return {
      status: 'warn',
      version: '(version unknown)',
      note: 'may be incompatible',
    };
  }

  // Check minimum version if specified
  if (dep.minVersion) {
    if (versionGte(version, dep.minVersion)) {
      return { status: 'ok', version };
    } else {
      return {
        status: dep.required ? 'fail' : 'warn',
        version,
        note: `need >= ${dep.minVersion}`,
      };
    }
  }

  return { status: 'ok', version };
}

/**
 * CLI-specific verification commands
 * Each CLI has its own way to verify authentication without running a full query
 */
interface VerifyConfig {
  command: string;
  args: string[];
  timeout: number;
  successCheck: (result: { status: number | null; stdout: string; stderr: string }) => boolean;
  authHint: string;
}

const VERIFY_CONFIGS: Record<string, VerifyConfig> = {
  'Codex': {
    // codex login status exits 0 when logged in
    command: 'codex',
    args: ['login', 'status'],
    timeout: 10000,
    successCheck: (r) => r.status === 0,
    authHint: 'Run "codex login status" in this directory and confirm it works without codev first',
  },
  // OpenCode: multi-provider, so we just verify the CLI works (no auth check)
  'OpenCode': {
    command: 'opencode',
    args: ['--version'],
    timeout: 10000,
    successCheck: (r) => r.status === 0,
    authHint: 'Run "opencode --version" to verify installation',
  },
  // Claude is verified via Agent SDK — see verifyClaudeViaSDK() below.
  // The gemini lane (Antigravity `agy`) is verified via verifyAgy() — not here.
};

/**
 * Verify Claude is operational via Agent SDK.
 * Sends a minimal query to verify auth and connectivity.
 */
async function verifyClaudeViaSDK(): Promise<CheckResult> {
  // Temporarily remove CLAUDECODE nesting guard from process.env.
  // The SDK spawns a subprocess that checks this directly.
  const savedClaudeCode = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;

  try {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }

    const session = claudeQuery({
      prompt: 'Reply OK',
      options: {
        allowedTools: [],
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env,
      },
    });

    for await (const message of session) {
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          return { status: 'ok', version: 'operational (SDK)' };
        }
        return { status: 'fail', version: 'SDK error', note: 'Set ANTHROPIC_API_KEY or run: claude /login' };
      }
    }

    return { status: 'ok', version: 'operational (SDK)' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'unknown error';
    const combined = errMsg.toLowerCase();
    if (combined.includes('api key') || combined.includes('unauthorized') || combined.includes('authentication')) {
      return { status: 'fail', version: 'auth error', note: 'Set ANTHROPIC_API_KEY or run: claude /login' };
    }
    return { status: 'fail', version: 'error', note: `Set ANTHROPIC_API_KEY or run: claude /login (${errMsg.substring(0, 60)})` };
  } finally {
    if (savedClaudeCode !== undefined) {
      process.env.CLAUDECODE = savedClaudeCode;
    }
  }
}

/**
 * Verify an AI model is operational using CLI-specific auth checks
 */
function verifyAiModel(modelName: string): CheckResult {
  const config = VERIFY_CONFIGS[modelName];
  if (!config) {
    return { status: 'skip', version: 'unknown model' };
  }

  try {
    const result = spawnSync(config.command, config.args, {
      encoding: 'utf-8',
      timeout: config.timeout,
      stdio: 'pipe',
    });

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    if (config.successCheck({ status: result.status, stdout, stderr })) {
      return { status: 'ok', version: 'operational' };
    }

    // Check for common auth-related error patterns
    const combined = (stdout + stderr).toLowerCase();
    if (combined.includes('not logged in') ||
        combined.includes('authentication') ||
        combined.includes('api key') ||
        combined.includes('api_key') ||
        combined.includes('unauthorized') ||
        combined.includes('invalid key') ||
        combined.includes('credential')) {
      return { status: 'fail', version: 'auth error', note: config.authHint };
    }

    // Check for timeout
    if (result.signal === 'SIGTERM' || combined.includes('timeout')) {
      return { status: 'fail', version: 'timeout', note: 'check network connection' };
    }

    // Generic failure - include a snippet of the error for debugging
    const errorSnippet = (stderr || stdout).trim().split('\n').slice(-2).join(' ').substring(0, 60);
    const note = errorSnippet ? `${config.authHint} (${errorSnippet}...)` : config.authHint;
    return { status: 'fail', version: 'not responding', note };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'unknown error';
    return { status: 'fail', version: 'error', note: `${config.authHint} (${errMsg})` };
  }
}

const AGY_INSTALL_HINT = 'install: curl -fsSL https://antigravity.google/cli/install.sh | bash, then run `agy` once to sign in';

/**
 * Presence check for the Antigravity CLI (agy) — the gemini lane's backend.
 * Uses resolveAgyBin (rejects the IDE symlink); never a bare `which agy`.
 */
function checkAgy(): CheckResult {
  const bin = resolveAgyBin();
  if (!bin) {
    return { status: 'skip', version: 'not installed', note: AGY_INSTALL_HINT };
  }
  return { status: 'ok', version: 'CLI' };
}

/**
 * Verify agy is authenticated via a tiny non-interactive --print probe.
 * Streams output and detects the OAuth URL on the *early* stream so an
 * unauthenticated agy reports "needs login" promptly (it would otherwise print
 * the URL and wait ~30s) — rather than stalling `codev doctor` for the full
 * auth wait.
 *
 * Resolves rather than rejecting for every agy outcome. The one exception is the
 * test-isolation guard inside `resolveAgyBin` (#1323), which throws
 * *synchronously* — before the promise exists — when a suite reaches this path
 * with no pinned `CODEV_AGY_BIN`. That is intentional loudness, but it means a
 * caller cannot catch it via `.catch()` on the returned promise.
 *
 * Shares the consult lane's auth cache (#1077): a fresh verdict is reported
 * without probing, so `codev doctor` on an unauthenticated agy does not open yet
 * another OAuth browser tab. When it does probe, it records the result for the
 * consult lane's benefit.
 */
function verifyAgy(): Promise<CheckResult> {
  const bin = resolveAgyBin();
  if (!bin) return Promise.resolve({ status: 'skip', version: 'not installed', note: AGY_INSTALL_HINT });

  const cached = checkCachedAgyAuth(bin);
  if (cached === 'unauth') {
    return Promise.resolve({ status: 'fail', version: 'needs login', note: 'run `agy` once to sign in (OAuth)' });
  }
  if (cached === 'auth') {
    return Promise.resolve({ status: 'ok', version: 'operational (cached)' });
  }

  return new Promise<CheckResult>((resolve) => {
    const proc = spawn(bin, ['--print-timeout', '20s', '--print', 'Reply with just OK'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let scan = '';
    const out: string[] = [];
    let timer: ReturnType<typeof setTimeout>;

    const finish = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      resolve(r);
    };

    timer = setTimeout(
      () => finish({ status: 'fail', version: 'timeout', note: 'check network connection / run `agy` to verify sign-in' }),
      30000,
    );

    const watch = (buf: Buffer, isStdout: boolean) => {
      const s = buf.toString('utf-8');
      if (isStdout) out.push(s);
      if (scan.length < 8192) {
        scan += s;
        // Fast path: OAuth URL appears immediately on an unauthenticated run.
        if (AGY_OAUTH_MARKERS.some((m) => scan.includes(m))) {
          // Share the verdict so a concurrent CMAP burst skips without spawning.
          recordAgyAuthState('unauth', bin);
          finish({ status: 'fail', version: 'needs login', note: 'run `agy` once to sign in (OAuth)' });
        }
      }
    };
    proc.stdout?.on('data', (b: Buffer) => watch(b, true));
    proc.stderr?.on('data', (b: Buffer) => watch(b, false));
    proc.on('error', () => finish({ status: 'fail', version: 'error', note: 'run `agy` to verify sign-in' }));
    proc.on('close', (code) => {
      const text = out.join('').trim();
      if (code === 0 && text.length > 0) {
        recordAgyAuthState('auth', bin);
        finish({ status: 'ok', version: 'operational' });
      } else {
        // Neither authenticated nor proven signed-out — record nothing, so the
        // consult lane re-probes rather than skipping a lane that may work.
        finish({ status: 'fail', version: 'not responding', note: 'run `agy` to verify sign-in' });
      }
    });
  });
}

/**
 * Find the project root with a codev/ directory
 */
function findWorkspaceRoot(): string | null {
  let current = process.cwd();
  while (current !== dirname(current)) {
    if (existsSync(resolve(current, 'codev'))) {
      return current;
    }
    if (existsSync(resolve(current, '.git'))) {
      return current;
    }
    current = dirname(current);
  }
  return null;
}

/**
 * Check if git remote is configured
 */
function checkGitRemote(): { hasRemote: boolean; remoteName?: string; remoteUrl?: string } {
  try {
    const result = spawnSync('git', ['remote', '-v'], { encoding: 'utf-8', timeout: 5000 });
    if (result.status === 0 && result.stdout.trim()) {
      const lines = result.stdout.trim().split('\n');
      if (lines.length > 0) {
        const match = lines[0].match(/^(\S+)\s+(\S+)/);
        if (match) {
          return { hasRemote: true, remoteName: match[1], remoteUrl: match[2] };
        }
      }
    }
    return { hasRemote: false };
  } catch {
    return { hasRemote: false };
  }
}

/**
 * Check codev directory structure
 */
function checkCodevStructure(workspaceRoot: string): { warnings: string[] } {
  const warnings: string[] = [];
  const codevDir = resolve(workspaceRoot, 'codev');

  // Check for deprecated roles/review-types/ directory
  const oldReviewTypes = resolve(codevDir, 'roles', 'review-types');
  if (existsSync(oldReviewTypes)) {
    warnings.push('Deprecated: roles/review-types/ still exists. Move contents to consult-types/');
  }

  // Check for git remote (required for builders to create PRs)
  const remoteCheck = checkGitRemote();
  if (!remoteCheck.hasRemote) {
    warnings.push('No git remote configured - builders cannot push branches or create PRs. Run: git remote add origin <url>');
  }

  // Architect state files must be gitignored; builder thread files versioned (#1192)
  warnings.push(...auditStateFileIgnore(workspaceRoot));

  return { warnings };
}

/**
 * Check if @cluesmith/codev is installed
 */
function checkNpmDependencies(): CheckResult {
  // If we're running as `codev doctor`, codev is definitely installed!
  // Get our own version from package.json
  try {
    // Find our own package.json (relative to this file's location in dist/commands/)
    const ownPkgPath = resolve(__dirname, '..', '..', 'package.json');
    if (existsSync(ownPkgPath)) {
      const pkgJson = JSON.parse(readFileSync(ownPkgPath, 'utf-8'));
      return { status: 'ok', version: pkgJson.version || 'installed' };
    }
  } catch {
    // Fall through to other checks
  }

  // Fallback: check if codev/afx commands exist
  if (commandExists('codev')) {
    const output = runCommand('codev', ['--version']);
    if (output) {
      return { status: 'ok', version: output.trim() };
    }
    return { status: 'ok', version: 'installed' };
  }

  if (commandExists('afx')) {
    return { status: 'ok', version: 'installed (via afx)' };
  }

  return {
    status: 'warn',
    version: 'not installed',
    note: 'npm i -g @cluesmith/codev',
  };
}

interface WarningInfo {
  name: string;
  issue: string;
  recommendation?: string;
}

/**
 * Main doctor function
 */
export async function doctor(): Promise<number> {
  let errors = 0;
  let warnings = 0;
  const warningDetails: WarningInfo[] = [];

  console.log(chalk.bold('Codev Doctor') + ' - Checking your environment');
  console.log('============================================');
  console.log('');

  // Check core dependencies
  console.log(chalk.bold('Core Dependencies') + ' (required for Agent Farm)');
  console.log('');

  for (const dep of CORE_DEPENDENCIES) {
    const result = checkDependency(dep);
    printStatus(dep.name, result);
    if (result.status === 'fail') errors++;
    if (result.status === 'warn') {
      warnings++;
      warningDetails.push({
        name: dep.name,
        issue: result.version,
        recommendation: result.note || (dep.minVersion ? `upgrade to >= ${dep.minVersion}` : undefined),
      });
    }
  }

  // Check npm package
  const npmResult = checkNpmDependencies();
  printStatus('@cluesmith/codev', npmResult);
  if (npmResult.status === 'warn') {
    warnings++;
    warningDetails.push({
      name: '@cluesmith/codev',
      issue: npmResult.version,
      recommendation: npmResult.note,
    });
  }

  console.log('');

  // Check AI CLI dependencies
  console.log(chalk.bold('AI CLI Dependencies') + ' (at least one required)');
  console.log('');

  let aiCliCount = 0;
  const installedAiClis: string[] = [];

  // Claude uses Agent SDK (always available as a dependency)
  printStatus('Claude', { status: 'ok', version: 'Agent SDK' });
  installedAiClis.push('Claude');

  // Check CLI-based AI dependencies (Codex, OpenCode)
  for (const dep of AI_DEPENDENCIES) {
    const result = checkDependency(dep);
    if (result.status === 'ok') {
      installedAiClis.push(dep.name);
    }
    printStatus(dep.name, result);
  }

  // gemini lane → Antigravity CLI (agy): custom presence check (resolveAgyBin
  // rejects the IDE symlink; a bare `which agy` would resolve the wrong binary).
  const agyPresence = checkAgy();
  if (agyPresence.status === 'ok') installedAiClis.push('Gemini (agy)');
  printStatus('Gemini (agy)', agyPresence);

  // Verify installed CLIs are actually operational
  console.log('');
  console.log(chalk.bold('AI Model Verification') + ' (checking auth & connectivity)');
  console.log('');

  // Verify Claude via SDK
  console.log(chalk.blue(`  ⋯ ${'Claude'.padEnd(12)} verifying...`));
  process.stdout.write('\x1b[1A\x1b[2K');
  const claudeResult = await verifyClaudeViaSDK();
  printStatus('Claude', claudeResult);
  if (claudeResult.status === 'ok') {
    aiCliCount++;
  } else if (claudeResult.status === 'fail') {
    warnings++;
    warningDetails.push({
      name: 'Claude',
      issue: claudeResult.version,
      recommendation: claudeResult.note,
    });
  }

  // Verify CLI-based models (agy handled separately below — custom OAuth probe)
  for (const cliName of installedAiClis.filter(n => n !== 'Claude' && n !== 'Gemini (agy)')) {
    console.log(chalk.blue(`  ⋯ ${cliName.padEnd(12)} verifying...`));
    process.stdout.write('\x1b[1A\x1b[2K');

    const result = verifyAiModel(cliName);
    printStatus(cliName, result);

    if (result.status === 'ok') {
      aiCliCount++;
    } else if (result.status === 'fail') {
      warnings++;
      warningDetails.push({
        name: cliName,
        issue: result.version,
        recommendation: result.note,
      });
    }
  }

  // Verify the gemini lane (agy) via its custom OAuth-aware probe so an
  // agy-only setup still counts as an operational model.
  if (installedAiClis.includes('Gemini (agy)')) {
    console.log(chalk.blue(`  ⋯ ${'Gemini (agy)'.padEnd(12)} verifying...`));
    process.stdout.write('\x1b[1A\x1b[2K');
    const agyVerify = await verifyAgy();
    printStatus('Gemini (agy)', agyVerify);
    if (agyVerify.status === 'ok') {
      aiCliCount++;
    } else if (agyVerify.status === 'fail') {
      warnings++;
      warningDetails.push({
        name: 'Gemini (agy)',
        issue: agyVerify.version,
        recommendation: agyVerify.note,
      });
    }
  }

  if (aiCliCount === 0) {
    console.log('');
    console.log(chalk.red('  ✗') + ' No AI model operational! Check API keys and authentication.');
    errors++;
  }

  // Warn if OpenCode is configured as architect shell (unsupported)
  try {
    const { loadConfig } = await import('../lib/config.js');
    const root = findWorkspaceRoot();
    if (root) {
      const config = loadConfig(root) as Record<string, unknown>;
      const shell = config?.shell as Record<string, unknown> | undefined;
      // Diagnose the harness a PERSISTED shell config selects for a role, WITHOUT
      // CLI/env overrides (doctor reports on the persisted config, not a one-off
      // `--architect-cmd`/`TOWER_*_CMD` run). Mirrors resolveHarness's precedence
      // but never throws (doctor reports; it does not launch), and is shared by
      // both role branches so they can't drift:
      //   • explicit shell.<role>Harness — a same-named CUSTOM harness is the
      //     sanctioned escape hatch and wins over retirement (built-in → custom →
      //     retired), so an explicit `gemini` backed by a `harness.gemini`
      //     definition is NOT flagged (following doctor's own advice clears it);
      //   • auto-detected shell.<role> command — retirement applies regardless of
      //     custom harnesses, because auto-detection resolves the built-in
      //     namespace only (Issue #1338), so a bare `gemini …` command is flagged.
      const customHarnesses = config?.harness as Record<string, unknown> | undefined;
      const resolveShell = (role: 'architect' | 'builder'): { name: string | undefined; retirement: string | undefined } => {
        const explicit = shell?.[`${role}Harness`] as string | undefined;
        if (explicit) {
          const hasCustom = !!customHarnesses && Object.prototype.hasOwnProperty.call(customHarnesses, explicit);
          return { name: explicit, retirement: hasCustom ? undefined : getRetirement(explicit) };
        }
        const raw = shell?.[role];
        const cmd = Array.isArray(raw) ? (raw as string[]).join(' ') : (raw as string ?? '');
        const detected = cmd ? detectHarnessFromCommand(cmd) : undefined;
        return { name: detected, retirement: detected ? getRetirement(detected) : undefined };
      };
      const architect = resolveShell('architect');
      const builder = resolveShell('builder');

      // --- Architect shell ---
      if (architect.name === 'opencode') {
        console.log('');
        console.log(chalk.yellow('  ⚠') + ' OpenCode is configured as architect shell — this is unsupported.');
        console.log(chalk.yellow('    ') + 'OpenCode uses file-based role injection that requires an ephemeral worktree.');
        console.log(chalk.yellow('    ') + 'Use a different shell for the architect (e.g., "claude --dangerously-skip-permissions").');
        warnings++;
        warningDetails.push({
          name: 'Shell config',
          issue: 'OpenCode configured as architect shell (unsupported)',
          recommendation: 'Set shell.architect to "claude --dangerously-skip-permissions" in .codev/config.json',
        });
      } else if (architect.retirement) {
        // Issue #1338: the built-in gemini harness is retired for BOTH roles
        // (Google ended consumer Gemini CLI access 2026-06-18). This branch
        // previously claimed gemini was "supported for builders, not architects";
        // that premise is now wrong — it is retired for builders too.
        console.log('');
        console.log(chalk.yellow('  ⚠') + ` ${architect.name} is configured as the architect shell — this harness is retired.`);
        console.log(chalk.yellow('    ') + architect.retirement);
        console.log(chalk.yellow('    ') + 'Use codex or claude for the architect (e.g., "codex" or "claude --dangerously-skip-permissions").');
        warnings++;
        warningDetails.push({
          name: 'Shell config',
          issue: `${architect.name} configured as architect shell (harness retired)`,
          // Cover both selectors: an explicit shell.architectHarness beats the
          // shell.architect command, so switching only the command wouldn't help.
          // The custom-harness name is the configured (retired) harness, not a
          // hard-coded "gemini", so the advice stays correct if another harness is
          // ever retired (RETIRED_HARNESSES is extensible).
          recommendation: `Set shell.architect / shell.architectHarness to "codex" or "claude --dangerously-skip-permissions" in .codev/config.json, or define a custom "${architect.name}" harness and select it explicitly via shell.architectHarness (a bare shell.architect command stays retired)`,
        });
      } else if (architect.name === 'codex') {
        // Issue #929: codex is a supported architect (config-driven).
        console.log('');
        console.log(chalk.green('  ✓') + ' codex is configured as architect shell — supported.');
        console.log(chalk.gray('    ') + 'Conversation resume is Claude-main-only; codex architects relaunch fresh with role injection.');
        console.log(chalk.gray('    ') + 'Select the architect harness via .codev/config.json (shell.architect / shell.architectHarness).');
      }

      // --- Builder shell (#1338) ---
      // A retired builder harness fails closed at spawn (Phase 2); doctor flags
      // the persisted config proactively so users learn before a spawn is rejected.
      if (builder.retirement) {
        console.log('');
        console.log(chalk.yellow('  ⚠') + ` ${builder.name} is configured as the builder shell — this harness is retired.`);
        console.log(chalk.yellow('    ') + builder.retirement);
        console.log(chalk.yellow('    ') + 'Use claude, codex, or opencode for builders (set shell.builder / shell.builderHarness in .codev/config.json).');
        warnings++;
        warningDetails.push({
          name: 'Shell config',
          issue: `${builder.name} configured as builder shell (harness retired)`,
          // Cover both selectors: an explicit shell.builderHarness beats the
          // shell.builder command, so switching only the command wouldn't help.
          // The custom-harness name is the configured (retired) harness, not a
          // hard-coded "gemini", so the advice stays correct if another harness is
          // ever retired (RETIRED_HARNESSES is extensible).
          recommendation: `Set shell.builder / shell.builderHarness to a supported harness (claude, codex, or opencode) in .codev/config.json, or define a custom "${builder.name}" harness and select it explicitly via shell.builderHarness (a bare shell.builder command stays retired)`,
        });
      }
    }
  } catch {
    // Config loading may fail in non-project contexts — skip warning
  }

  console.log('');

  const workspaceRoot = findWorkspaceRoot();

  // Migration backups (#1239): state migrations leave copies of the pre-migration
  // state behind — whole-directory `~/.agent-farm.bak-*` copies and the
  // `*.pre-merge-*` renames from db/consolidate.ts — and nothing ever removes
  // them. One was found at 18 GB three weeks after the migration that made it.
  // Report-only: these are the user's own state copies, so doctor surfaces age +
  // size + the removal command and leaves the decision to the human. QUIET BY
  // DEFAULT — the section prints only when a leftover exists.
  const migrationBackups = findMigrationBackups({ workspaceRoot });
  if (migrationBackups.length > 0) {
    const reclaimable = totalBytes(migrationBackups);
    console.log(chalk.bold('Migration Backups') + ' (leftover copies of pre-migration state)');
    console.log('');
    for (const backup of migrationBackups) {
      if (backup.stale) {
        console.log(`  ${chalk.yellow('⚠')} ${formatMigrationBackup(backup)}`);
        warnings++;
        warningDetails.push({
          name: 'Migration backup',
          issue: formatMigrationBackup(backup),
          recommendation: `nothing reaps these — if the migrated state is healthy, run: rm -rf "${backup.path}"`,
        });
      } else {
        console.log(
          `  ${chalk.dim('○')} ${formatMigrationBackup(backup)}` +
          chalk.dim(` (within the ${STALE_BACKUP_AGE_DAYS}-day verification window)`)
        );
      }
    }
    if (reclaimable > 0) {
      console.log('');
      console.log(chalk.dim(`  ${formatBytes(reclaimable)} reclaimable across ${migrationBackups.length} backup(s).`));
    }
    console.log('');
  }

  // Check codev directory structure (only if we're in a codev project)
  if (workspaceRoot && existsSync(resolve(workspaceRoot, 'codev'))) {
    console.log(chalk.bold('Codev Structure') + ' (project configuration)');
    console.log('');

    const structureCheck = checkCodevStructure(workspaceRoot);
    if (structureCheck.warnings.length === 0) {
      console.log(`  ${chalk.green('✓')} Project structure OK`);
    } else {
      for (const warning of structureCheck.warnings) {
        console.log(`  ${chalk.yellow('⚠')} ${warning}`);
        warnings++;
        warningDetails.push({
          name: 'Project structure',
          issue: warning,
        });
      }
    }
    console.log('');

    // Framework-file reference audit (#1011): the user's OWN codev/ overrides
    // (codev/protocols, codev/roles) must not instruct shell reads of framework
    // docs by literal path, which bypass the resolver and fail in fresh installs.
    // Scans the project's local overrides only (the shipped skeleton is the
    // framework's responsibility, guarded by its own CI). Warn-not-error, and a
    // true no-op (no output) when the project ships no protocol/role overrides.
    const codevRoot = resolve(workspaceRoot, 'codev');
    if (hasFrameworkOverrides(codevRoot)) {
      const frameworkRefs = auditFrameworkRefs(codevRoot);
      if (frameworkRefs.length === 0) {
        console.log(`  ${chalk.green('✓')} No literal-path shell reads of framework files in codev/ overrides`);
      } else {
        for (const finding of frameworkRefs) {
          console.log(`  ${chalk.yellow('⚠')} ${formatFrameworkRefFinding(finding)}`);
          warnings++;
          warningDetails.push({
            name: 'Framework refs',
            issue: `codev/${formatFrameworkRefFinding(finding)}`,
            recommendation: 'Deliver framework content via spawn/porch inline; see the "Framework files" convention in CLAUDE.md / AGENTS.md',
          });
        }
      }
      console.log('');
    }

    // Protocol PR-gate audit (#943): a PR-producing protocol whose resolved
    // definition (local override included) lost its `pr` gate will silently
    // stop surfacing PRs in Needs Attention (post-#927). Warn loudly; non-fatal.
    console.log(chalk.bold('Protocol PR Gates') + ' (Needs Attention surfacing)');
    console.log('');
    const prGateWarnings = auditPrGates(workspaceRoot);
    if (prGateWarnings.length === 0) {
      console.log(`  ${chalk.green('✓')} All PR-producing protocols are pr-gated`);
    } else {
      for (const w of prGateWarnings) {
        console.log(`  ${chalk.yellow('⚠')} ${formatPrGateWarning(w)}`);
        warnings++;
        warningDetails.push({
          name: `Protocol ${w.protocol}`,
          issue: 'no `pr` gate on PR-creating phase — PRs will not surface in Needs Attention',
          recommendation: 'Add "gate": "pr" to its PR-creating phase, or remove the local override',
        });
      }
    }
    console.log('');

    // Framework drift (#1210): a project-local copy (tier-1 `.codev/` or tier-2 `codev/`) of a
    // framework file that also ships in the installed skeleton silently shadows the package — a
    // stale snapshot of an old default keeps winning resolution forever, with no signal. And the
    // installed skeleton can itself be a version behind. Both are invisible in normal operation.
    // Report-only (never mutates a user file), and QUIET BY DEFAULT: the section prints only when it
    // has something actionable to say — a shadow exists OR the skeleton is behind. No overrides +
    // up-to-date/offline => true no-op (no section at all).
    const drift = auditProtocolDrift(workspaceRoot);
    // Test seam: `CODEV_DOCTOR_FAKE_LATEST` injects the npm-latest version so the
    // staleness-only "behind" integration branch is e2e-testable without a live
    // registry. Unset in real use → the actual `npm view` lookup runs.
    const fakeLatest = process.env.CODEV_DOCTOR_FAKE_LATEST;
    const staleness = checkSkeletonStaleness(fakeLatest ? () => fakeLatest : undefined);
    if (drift.length > 0 || staleness.behind) {
      // Header parenthetical reflects the actual finding: the shadowing subtitle is only accurate
      // when a local shadow exists; in the staleness-only path (no shadows, skeleton behind) it
      // would be false, so use a staleness-specific subtitle instead.
      const subtitle = drift.length > 0
        ? 'local copies shadowing the installed skeleton'
        : 'installed skeleton is behind npm latest';
      console.log(chalk.bold('Framework Drift') + ` (${subtitle})`);
      console.log('');

      // Staleness line. Only `behind` is a warning; up-to-date / uncheckable lines are informational
      // and shown only because the section is already open (a shadow or a behind result opened it).
      if (staleness.behind) {
        console.log(`  ${chalk.yellow('⚠')} ${formatStaleness(staleness)}`);
        warnings++;
        warningDetails.push({
          name: 'Skeleton staleness',
          issue: `installed ${staleness.installed} < latest ${staleness.latest}`,
          recommendation: 'run: codev update (and reinstall @cluesmith/codev if globally out of date)',
        });
      } else {
        console.log(`  ${chalk.dim('○')} ${formatStaleness(staleness)}`);
      }

      // Shadow drift. `differs` => adjudicate warning; `identical` => informational (redundant copy).
      // The skeleton version IS the installed package version (the skeleton ships with the
      // package), which staleness already resolved — name it in each drift line per the spec.
      const skeletonVersion = staleness.installed;
      const differs = drift.filter((f) => f.status === 'differs');
      const identical = drift.filter((f) => f.status === 'identical');
      for (const f of differs) {
        console.log(`  ${chalk.yellow('⚠')} ${formatDriftFinding(f, skeletonVersion)}`);
        warnings++;
        warningDetails.push({
          name: 'Framework drift',
          issue: `${f.tier}/${f.relativePath} differs from installed skeleton v${skeletonVersion} (customized or stale?)`,
          recommendation: 'review vs the installed skeleton; if unintentional, remove the local copy so resolution falls back to the package',
        });
      }
      for (const f of identical) {
        console.log(`  ${chalk.dim('○')} ${formatDriftFinding(f, skeletonVersion)}`);
      }
      console.log('');
    }

    // Full forge concept reporting: all 15 concepts with resolution source and executable check
    const forgeConfig = loadForgeConfig(workspaceRoot);
    const provider = forgeConfig?.provider ?? 'github';
    console.log(chalk.bold('Forge Concepts') + ` (provider: ${provider})`);
    console.log('');

    // Validate user overrides first
    if (forgeConfig && Object.keys(forgeConfig).length > 0) {
      const validationResults = validateForgeConfig(forgeConfig);
      for (const r of validationResults) {
        if (r.status === 'unknown_concept' || r.status === 'empty_command') {
          console.log(`  ${chalk.yellow('⚠')} ${r.message}`);
          warnings++;
          warningDetails.push({ name: 'Forge concepts', issue: r.message });
        }
      }
    }

    // Report all 15 concepts with source and executable availability
    const resolutions = resolveAllConcepts(forgeConfig);
    const missingExecs = new Set<string>();

    for (const r of resolutions) {
      if (r.source === 'disabled') {
        console.log(`  ${chalk.dim('○')} ${r.concept.padEnd(20)} ${chalk.dim('disabled')}`);
        continue;
      }

      const sourceLabel = r.source === 'override' ? chalk.cyan('override') : r.source === 'preset' ? chalk.blue('preset') : chalk.dim('default');
      const execName = r.executable ?? '—';
      const execInstalled = r.executable ? commandExists(r.executable) : true;

      if (execInstalled) {
        console.log(`  ${chalk.green('✓')} ${r.concept.padEnd(20)} ${sourceLabel}  ${chalk.dim(execName)}`);
      } else {
        console.log(`  ${chalk.yellow('⚠')} ${r.concept.padEnd(20)} ${sourceLabel}  ${chalk.red(execName + ' not found')}`);
        missingExecs.add(r.executable!);
      }
    }

    if (missingExecs.size > 0) {
      warnings++;
      warningDetails.push({
        name: 'Forge executables',
        issue: `${missingExecs.size} executable(s) not found: ${[...missingExecs].join(', ')}`,
        recommendation: `Install missing tools or adjust forge config`,
      });
    }

    // gh auth check — only for GitHub provider
    if (provider === 'github' && commandExists('gh')) {
      try {
        const result = executeForgeCommandSync('auth-status', {}, { raw: true });
        if (result) {
          const authOutput = typeof result === 'string' ? result : '';
          const accountMatch = authOutput.match(/Logged in to .+ account (\S+)/);
          const username = accountMatch ? accountMatch[1] : null;
          console.log(`  ${chalk.green('✓')} ${'gh auth'.padEnd(20)} ${username ? `authenticated as ${username}` : 'authenticated'}`);
        } else {
          console.log(`  ${chalk.yellow('⚠')} ${'gh auth'.padEnd(20)} not authenticated`);
          warnings++;
          warningDetails.push({ name: 'gh auth', issue: 'not authenticated', recommendation: 'run: gh auth login' });
        }
      } catch {
        console.log(`  ${chalk.yellow('⚠')} ${'gh auth'.padEnd(20)} not authenticated`);
        warnings++;
        warningDetails.push({ name: 'gh auth', issue: 'not authenticated', recommendation: 'run: gh auth login' });
      }
    }

    console.log('');
  }

  // Session log footprint (#1238). User-global (~/.agent-farm/logs), so this is
  // reported outside the project-scoped section. Tower sweeps aged-out logs, but
  // a machine that has not run a recent Tower — or has retention disabled — can
  // still be sitting on many GB, and that was invisible until this line existed.
  const sessionLogs = checkSessionLogs(resolve(AGENT_FARM_DIR, 'logs'));
  console.log(chalk.bold('Session Logs') + ' (~/.agent-farm/logs)');
  console.log('');
  if (sessionLogs.status === 'warn') {
    console.log(`  ${chalk.yellow('⚠')} ${sessionLogs.summary} ${chalk.blue(`(${sessionLogs.retentionNote})`)}`);
    warnings++;
    warningDetails.push({
      name: 'Session logs',
      issue: `${sessionLogs.summary} in ~/.agent-farm/logs`,
      recommendation: sessionLogs.recommendation,
    });
  } else if (sessionLogs.files === 0) {
    console.log(`  ${chalk.green('✓')} ${sessionLogs.summary}`);
  } else {
    console.log(`  ${chalk.green('✓')} ${sessionLogs.summary} ${chalk.blue(`(${sessionLogs.retentionNote})`)}`);
  }
  console.log('');

  // Summary
  console.log('============================================');
  if (errors > 0) {
    console.log(chalk.red.bold('FAILED') + ` - ${errors} required dependency/dependencies missing`);
    console.log('');
    console.log('Install missing dependencies and run this command again.');
    return 1;
  } else if (warnings > 0) {
    const issueWord = warnings === 1 ? 'issue' : 'issues';
    console.log(chalk.yellow.bold('OK with warnings') + ` - ${warnings} ${issueWord} detected`);
    console.log('');
    for (const w of warningDetails) {
      let line = `  ${chalk.yellow('⚠')} ${w.name}: ${w.issue}`;
      if (w.recommendation) {
        line += chalk.blue(` → ${w.recommendation}`);
      }
      console.log(line);
    }
    return 0;
  } else {
    console.log(chalk.green.bold('ALL OK') + ' - Your environment is ready for Codev!');
    return 0;
  }
}
