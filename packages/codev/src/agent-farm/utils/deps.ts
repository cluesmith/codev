/**
 * Dependency checking utilities for Agent Farm
 *
 * Verifies that required system dependencies are installed with correct versions.
 */

import { run, commandExists } from './shell.js';
import { logger, fatal } from './logger.js';

export interface Dependency {
  name: string;
  command: string;
  minVersion: string;
  versionCmd: string;
  versionParser: (output: string) => string | null;
  installHint: {
    macos: string;
    linux: string;
  };
  required: boolean;
}

/**
 * Core dependencies required for Agent Farm
 */
export const CORE_DEPENDENCIES: Dependency[] = [
  {
    name: 'Node.js',
    command: 'node',
    minVersion: '18.0.0',
    versionCmd: 'node --version',
    versionParser: (output) => {
      // v18.17.0 -> 18.17.0
      const match = output.match(/v?(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    },
    installHint: {
      macos: 'brew install node',
      linux: 'apt install nodejs npm',
    },
    required: true,
  },
  {
    name: 'tmux',
    command: 'tmux',
    minVersion: '3.0',
    versionCmd: 'tmux -V',
    versionParser: (output) => {
      // tmux 3.3a -> 3.3
      const match = output.match(/tmux\s+(\d+\.\d+)/);
      return match ? match[1] : null;
    },
    installHint: {
      macos: 'brew install tmux',
      linux: 'apt install tmux',
    },
    required: true,
  },
  {
    name: 'git',
    command: 'git',
    minVersion: '2.5.0',
    versionCmd: 'git --version',
    versionParser: (output) => {
      // git version 2.39.2 (Apple Git-143)
      const match = output.match(/git version (\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    },
    installHint: {
      macos: '(pre-installed on macOS)',
      linux: 'apt install git',
    },
    required: true,
  },
];

/**
 * Compare semantic versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return 0;
}

export interface DependencyCheckResult {
  name: string;
  installed: boolean;
  version: string | null;
  minVersion: string;
  versionOk: boolean;
  versionUnknown: boolean;
  installHint: string;
}

/**
 * Check a single dependency
 */
export async function checkDependency(dep: Dependency): Promise<DependencyCheckResult> {
  const platform = process.platform === 'darwin' ? 'macos' : 'linux';
  const installHint = dep.installHint[platform];

  // Check if command exists
  if (!(await commandExists(dep.command))) {
    return {
      name: dep.name,
      installed: false,
      version: null,
      minVersion: dep.minVersion,
      versionOk: false,
      versionUnknown: false,
      installHint,
    };
  }

  // Get version
  let version: string | null = null;
  let versionOk = false;
  let versionUnknown = false;

  try {
    const { stdout, stderr } = await run(dep.versionCmd);
    // Some tools output version to stderr
    const output = stdout || stderr;
    version = dep.versionParser(output);

    if (version) {
      versionOk = compareVersions(version, dep.minVersion) >= 0;
    } else {
      // Parser returned null - version unknown
      versionUnknown = true;
    }
  } catch {
    // Command exists but version check failed
    version = 'unknown';
    versionUnknown = true;
  }

  return {
    name: dep.name,
    installed: true,
    version,
    minVersion: dep.minVersion,
    versionOk,
    versionUnknown,
    installHint,
  };
}

/**
 * Check all core dependencies required for Agent Farm
 *
 * @param exitOnFailure - If true, calls fatal() on missing required deps (default: true)
 * @returns Array of check results
 */
export async function checkCoreDependencies(exitOnFailure = true): Promise<DependencyCheckResult[]> {
  const results: DependencyCheckResult[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const dep of CORE_DEPENDENCIES) {
    const result = await checkDependency(dep);
    results.push(result);

    if (!result.installed) {
      failures.push(`${dep.name} not found. Install with: ${result.installHint}`);
    } else if (result.versionUnknown) {
      warnings.push(
        `${dep.name} version could not be determined (may be incompatible)`
      );
    } else if (!result.versionOk && result.version) {
      failures.push(
        `${dep.name} version ${result.version} is below minimum ${dep.minVersion}. ` +
        `Upgrade with: ${result.installHint}`
      );
    }
  }

  // Show warnings first (non-fatal)
  if (warnings.length > 0) {
    logger.warn('Dependency warnings:');
    for (const warning of warnings) {
      logger.warn(`  • ${warning}`);
    }
  }

  // Then show failures and exit if requested
  if (failures.length > 0 && exitOnFailure) {
    logger.error('Missing or outdated dependencies:');
    for (const failure of failures) {
      logger.error(`  • ${failure}`);
    }
    fatal('Please install missing dependencies and try again.');
  }

  return results;
}

/**
 * Quick check for a single required dependency (for backwards compat)
 */
export async function requireDependency(name: string, installHint?: string): Promise<void> {
  if (!(await commandExists(name))) {
    const hint = installHint || `Please install ${name}`;
    fatal(`${name} not found. ${hint}`);
  }
}
