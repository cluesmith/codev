/**
 * codev doctor - Check system dependencies
 *
 * Port of codev/bin/codev-doctor to TypeScript
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

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
    name: 'tmux',
    command: 'tmux',
    versionArg: '-V',
    versionExtract: (output) => output.replace(/^tmux /, '').replace(/[a-z]$/, ''),
    minVersion: '3.0',
    required: true,
    installHint: {
      macos: 'brew install tmux',
      linux: 'apt install tmux',
    },
  },
  {
    name: 'ttyd',
    command: 'ttyd',
    versionArg: '--version',
    versionExtract: (output) => {
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    },
    minVersion: '1.7.0',
    required: true,
    installHint: {
      macos: 'brew install ttyd',
      linux: 'build from source',
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
  {
    name: 'gh',
    command: 'gh',
    versionArg: 'auth status',
    versionExtract: () => 'authenticated', // Special case - check auth status
    required: true,
    installHint: {
      macos: 'brew install gh',
      linux: 'apt install gh',
    },
  },
];

// AI CLI dependencies - at least one required
const AI_DEPENDENCIES: Dependency[] = [
  {
    name: 'Claude',
    command: 'claude',
    versionArg: '--version',
    versionExtract: () => 'working',
    required: false,
    installHint: {
      macos: 'npm i -g @anthropic-ai/claude-code',
      linux: 'npm i -g @anthropic-ai/claude-code',
    },
  },
  {
    name: 'Gemini',
    command: 'gemini',
    versionArg: '--version',
    versionExtract: () => 'working',
    required: false,
    installHint: {
      macos: 'see github.com/google-gemini/gemini-cli',
      linux: 'see github.com/google-gemini/gemini-cli',
    },
  },
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

  // Special case for gh auth status
  if (dep.name === 'gh') {
    try {
      execSync('gh auth status', { stdio: 'pipe' });
      return { status: 'ok', version: 'authenticated' };
    } catch {
      return { status: 'warn', version: 'not authenticated', note: 'gh auth login' };
    }
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
 * Verify an AI model is operational by running a quick consult command
 */
function verifyAiModel(modelName: string): CheckResult {
  const modelMap: Record<string, string> = {
    'Claude': 'claude',
    'Gemini': 'gemini',
    'Codex': 'codex',
  };

  const model = modelMap[modelName];
  if (!model) {
    return { status: 'skip', version: 'unknown model' };
  }

  try {
    // Use consult to verify the model is operational
    const result = spawnSync(
      'consult',
      ['--model', model, 'general', 'Reply with just OK if operational'],
      { encoding: 'utf-8', timeout: 60000, stdio: 'pipe' }
    );

    if (result.status === 0 && result.stdout) {
      return { status: 'ok', version: 'operational' };
    }

    // Check for common auth errors in stderr
    const stderr = result.stderr || '';
    if (stderr.includes('auth') || stderr.includes('API key') || stderr.includes('token')) {
      return { status: 'fail', version: 'auth error', note: 'check API key/auth' };
    }

    return { status: 'fail', version: 'not responding', note: 'check configuration' };
  } catch {
    return { status: 'fail', version: 'error', note: 'consult command failed' };
  }
}

/**
 * Find the project root with a codev/ directory
 */
function findProjectRoot(): string | null {
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
 * Check codev directory structure
 */
function checkCodevStructure(projectRoot: string): { warnings: string[] } {
  const warnings: string[] = [];
  const codevDir = resolve(projectRoot, 'codev');

  // Check for consult-types/ directory (new location)
  const consultTypesDir = resolve(codevDir, 'consult-types');
  if (!existsSync(consultTypesDir)) {
    warnings.push('consult-types/ directory not found - review types may not work correctly');
  }

  // Check for deprecated roles/review-types/ directory
  const oldReviewTypes = resolve(codevDir, 'roles', 'review-types');
  if (existsSync(oldReviewTypes)) {
    warnings.push('Deprecated: roles/review-types/ still exists. Move contents to consult-types/');
  }

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

  // Fallback: check if codev/af commands exist
  if (commandExists('codev')) {
    const output = runCommand('codev', ['--version']);
    if (output) {
      return { status: 'ok', version: output.trim() };
    }
    return { status: 'ok', version: 'installed' };
  }

  if (commandExists('af')) {
    return { status: 'ok', version: 'installed (via af)' };
  }

  return {
    status: 'warn',
    version: 'not installed',
    note: 'npm i -g @cluesmith/codev',
  };
}

/**
 * Main doctor function
 */
export async function doctor(): Promise<number> {
  let errors = 0;
  let warnings = 0;

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
    if (result.status === 'warn') warnings++;
  }

  // Check npm package
  const npmResult = checkNpmDependencies();
  printStatus('@cluesmith/codev', npmResult);
  if (npmResult.status === 'warn') warnings++;

  console.log('');

  // Check AI CLI dependencies
  console.log(chalk.bold('AI CLI Dependencies') + ' (at least one required)');
  console.log('');

  let aiCliCount = 0;
  const installedAiClis: string[] = [];

  // First check if CLIs are installed
  for (const dep of AI_DEPENDENCIES) {
    const result = checkDependency(dep);
    if (result.status === 'ok') {
      installedAiClis.push(dep.name);
    }
    printStatus(dep.name, result);
  }

  if (installedAiClis.length === 0) {
    console.log('');
    console.log(chalk.red('  ✗') + ' No AI CLI installed! Install at least one to use Codev.');
    errors++;
  } else {
    // Verify installed CLIs are actually operational
    console.log('');
    console.log(chalk.bold('AI Model Verification') + ' (checking auth & connectivity)');
    console.log('');

    for (const cliName of installedAiClis) {
      console.log(chalk.blue(`  ⋯ ${cliName.padEnd(12)} verifying...`));
      // Move cursor up to overwrite the "verifying" line
      process.stdout.write('\x1b[1A\x1b[2K');

      const result = verifyAiModel(cliName);
      printStatus(cliName, result);

      if (result.status === 'ok') {
        aiCliCount++;
      } else if (result.status === 'fail') {
        warnings++;
      }
    }

    if (aiCliCount === 0) {
      console.log('');
      console.log(chalk.red('  ✗') + ' No AI CLI operational! Check API keys and authentication.');
      errors++;
    }
  }

  console.log('');

  // Check codev directory structure (only if we're in a codev project)
  const projectRoot = findProjectRoot();
  if (projectRoot && existsSync(resolve(projectRoot, 'codev'))) {
    console.log(chalk.bold('Codev Structure') + ' (project configuration)');
    console.log('');

    const structureCheck = checkCodevStructure(projectRoot);
    if (structureCheck.warnings.length === 0) {
      console.log(`  ${chalk.green('✓')} Project structure OK`);
    } else {
      for (const warning of structureCheck.warnings) {
        console.log(`  ${chalk.yellow('⚠')} ${warning}`);
        warnings++;
      }
    }
    console.log('');
  }

  // Summary
  console.log('============================================');
  if (errors > 0) {
    console.log(chalk.red.bold('FAILED') + ` - ${errors} required dependency/dependencies missing`);
    console.log('');
    console.log('Install missing dependencies and run this command again.');
    return 1;
  } else if (warnings > 0) {
    console.log(chalk.yellow.bold('OK with warnings') + ` - ${warnings} dependency/dependencies below recommended version`);
    console.log('');
    console.log('Consider upgrading for best experience.');
    return 0;
  } else {
    console.log(chalk.green.bold('ALL OK') + ' - Your environment is ready for Codev!');
    return 0;
  }
}
