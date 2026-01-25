/**
 * E2E Test Setup Helper
 *
 * Creates a temporary git repository with codev initialized for testing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCallback);

export interface TestContext {
  /** Temporary directory containing the test repo */
  tempDir: string;
  /** Project ID for the test */
  projectId: string;
  /** Project title */
  projectTitle: string;
  /** Path to the codev-skeleton */
  skeletonPath: string;
}

/**
 * Create a temporary test project with codev initialized.
 */
export async function createTestProject(
  projectId: string = '9999',
  projectTitle: string = 'test-feature'
): Promise<TestContext> {
  // Find skeleton path (relative to this file's location in dist)
  const skeletonPath = path.resolve(__dirname, '../../../../../../skeleton');

  if (!fs.existsSync(skeletonPath)) {
    throw new Error(`Skeleton not found at ${skeletonPath}. Run 'npm run build' first.`);
  }

  // Create temp directory
  const tempDir = fs.mkdtempSync(path.join(tmpdir(), 'porch-e2e-'));

  try {
    // Initialize git repo
    await exec('git init', { cwd: tempDir });
    await exec('git config user.email "test@e2e.test"', { cwd: tempDir });
    await exec('git config user.name "E2E Test"', { cwd: tempDir });

    // Copy codev-skeleton to codev/
    const codevDir = path.join(tempDir, 'codev');
    await copyDir(skeletonPath, codevDir);

    // Create required directories
    fs.mkdirSync(path.join(codevDir, 'specs'), { recursive: true });
    fs.mkdirSync(path.join(codevDir, 'plans'), { recursive: true });
    fs.mkdirSync(path.join(codevDir, 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(codevDir, 'projects'), { recursive: true });

    // Create a minimal package.json for the test project
    const packageJson = {
      name: 'e2e-test-project',
      version: '1.0.0',
      scripts: {
        build: 'echo "Build successful"',
        test: 'echo "Tests passed"',
      },
    };
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    // Create initial commit - add specific files (no git add . per policy)
    await exec('git add codev package.json', { cwd: tempDir });
    await exec('git commit -m "Initial commit"', { cwd: tempDir });

    // Initialize porch project
    const { init } = await import('../../../index.js');
    await init(tempDir, 'spider', projectId, projectTitle);

    return {
      tempDir,
      projectId,
      projectTitle,
      skeletonPath,
    };
  } catch (err) {
    // Cleanup on failure
    await cleanupTestProject({ tempDir, projectId, projectTitle, skeletonPath });
    throw err;
  }
}

/**
 * Copy directory recursively.
 */
async function copyDir(src: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Clean up a test project.
 */
export async function cleanupTestProject(ctx: TestContext): Promise<void> {
  if (ctx.tempDir && fs.existsSync(ctx.tempDir)) {
    fs.rmSync(ctx.tempDir, { recursive: true, force: true });
  }
}

/**
 * Get the porch state for a test project.
 */
export function getTestProjectState(ctx: TestContext): Record<string, unknown> | null {
  const statusPath = path.join(
    ctx.tempDir,
    'codev',
    'projects',
    `${ctx.projectId}-${ctx.projectTitle}`,
    'status.yaml'
  );

  if (!fs.existsSync(statusPath)) {
    return null;
  }

  const yaml = require('js-yaml');
  const content = fs.readFileSync(statusPath, 'utf-8');
  return yaml.load(content) as Record<string, unknown>;
}
