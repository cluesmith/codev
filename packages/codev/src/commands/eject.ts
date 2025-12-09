/**
 * codev eject - Copy embedded skeleton files locally for customization
 *
 * Usage:
 *   codev eject protocols/spider
 *   codev eject roles/consultant.md
 *   codev eject --list
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { getSkeletonDir, listSkeletonFiles, hasLocalOverride, findProjectRoot } from '../lib/skeleton.js';

interface EjectOptions {
  list?: boolean;
  force?: boolean;
}

/**
 * List available files that can be ejected
 */
function listEjectableFiles(): void {
  const skeletonDir = getSkeletonDir();

  if (!fs.existsSync(skeletonDir)) {
    console.error(chalk.red('Error: Skeleton directory not found.'));
    console.error('Package may be corrupted. Try reinstalling @cluesmith/codev.');
    return;
  }

  console.log('');
  console.log(chalk.bold('Available files to eject:'));
  console.log('');

  const categories = ['protocols', 'roles', 'agents', 'templates'];

  for (const category of categories) {
    const files = listSkeletonFiles(category);
    if (files.length > 0) {
      console.log(chalk.yellow(`  ${category}/`));
      for (const file of files) {
        console.log(chalk.dim(`    ${file}`));
      }
      console.log('');
    }
  }

  console.log(chalk.dim('Usage: codev eject <path>'));
  console.log(chalk.dim('Example: codev eject protocols/spider/protocol.md'));
}

/**
 * Eject a file or directory from the embedded skeleton
 */
export async function eject(targetPath?: string, options: EjectOptions = {}): Promise<void> {
  const { list = false, force = false } = options;

  // List mode
  if (list || !targetPath) {
    listEjectableFiles();
    return;
  }

  const projectRoot = findProjectRoot();
  const skeletonDir = getSkeletonDir();

  // Normalize the path
  const normalizedPath = targetPath.replace(/^\//, '').replace(/\/$/, '');

  // Check if path exists in skeleton
  const sourcePath = path.join(skeletonDir, normalizedPath);

  if (!fs.existsSync(sourcePath)) {
    console.error(chalk.red(`Error: '${normalizedPath}' not found in embedded skeleton.`));
    console.error('');
    console.error('Use ' + chalk.cyan('codev eject --list') + ' to see available files.');
    process.exit(1);
  }

  const destPath = path.join(projectRoot, 'codev', normalizedPath);

  // Check if source is a file or directory
  const stat = fs.statSync(sourcePath);

  if (stat.isDirectory()) {
    // Eject entire directory
    await ejectDirectory(sourcePath, destPath, normalizedPath, force);
  } else {
    // Eject single file
    await ejectFile(sourcePath, destPath, normalizedPath, force);
  }
}

/**
 * Eject a single file
 */
async function ejectFile(
  sourcePath: string,
  destPath: string,
  relativePath: string,
  force: boolean
): Promise<void> {
  // Check if already exists locally
  if (fs.existsSync(destPath) && !force) {
    console.error(chalk.yellow(`Warning: '${relativePath}' already exists locally.`));
    console.error('Use ' + chalk.cyan('--force') + ' to overwrite.');
    process.exit(1);
  }

  // Create directory if needed
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Copy file
  fs.copyFileSync(sourcePath, destPath);

  console.log('');
  console.log(chalk.green('Ejected:'), `codev/${relativePath}`);
  console.log('');
  console.log(chalk.dim('This file is now a local override.'));
  console.log(chalk.dim("Changes you make won't be overwritten by 'codev update'."));
}

/**
 * Eject an entire directory
 */
async function ejectDirectory(
  sourcePath: string,
  destPath: string,
  relativePath: string,
  force: boolean
): Promise<void> {
  let ejectedCount = 0;
  let skippedCount = 0;

  console.log('');
  console.log(chalk.bold(`Ejecting: ${relativePath}/`));
  console.log('');

  function copyRecursive(src: string, dest: string, relPath: string): void {
    const stat = fs.statSync(src);

    if (stat.isDirectory()) {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }

      const entries = fs.readdirSync(src);
      for (const entry of entries) {
        copyRecursive(
          path.join(src, entry),
          path.join(dest, entry),
          path.join(relPath, entry)
        );
      }
    } else {
      // Skip .gitkeep files
      if (path.basename(src) === '.gitkeep') {
        return;
      }

      if (fs.existsSync(dest) && !force) {
        console.log(chalk.yellow('  skip'), `codev/${relPath}`, chalk.dim('(exists)'));
        skippedCount++;
        return;
      }

      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      fs.copyFileSync(src, dest);
      console.log(chalk.green('  +'), `codev/${relPath}`);
      ejectedCount++;
    }
  }

  copyRecursive(sourcePath, destPath, relativePath);

  console.log('');
  console.log(chalk.bold('Summary:'));
  console.log(chalk.green(`  + ${ejectedCount} files ejected`));
  if (skippedCount > 0) {
    console.log(chalk.yellow(`  - ${skippedCount} files skipped (already exist)`));
    console.log('');
    console.log(chalk.dim('Use --force to overwrite existing files.'));
  }
  console.log('');
  console.log(chalk.dim('These files are now local overrides.'));
  console.log(chalk.dim("Changes you make won't be overwritten by 'codev update'."));
}
