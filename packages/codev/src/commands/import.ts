/**
 * codev import - AI-assisted protocol import from other codev projects
 *
 * Fetches codev/ directory from another project (local or GitHub) and
 * spawns an interactive Claude session to analyze differences and
 * recommend imports.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import chalk from 'chalk';
import { findWorkspaceRoot } from '../lib/skeleton.js';

interface ImportOptions {
  dryRun?: boolean;
}

/**
 * Parse a source argument into its type and path
 */
function parseSource(source: string): { type: 'local' | 'github'; path: string; repo?: string } {
  // GitHub URL patterns:
  // - github:owner/repo
  // - https://github.com/owner/repo
  // - git@github.com:owner/repo.git

  if (source.startsWith('github:')) {
    const repo = source.slice('github:'.length);
    return { type: 'github', path: repo, repo };
  }

  if (source.includes('github.com')) {
    // Extract owner/repo from URL
    // Regex captures owner/repo including dots (e.g., vercel/next.js, owner/repo.name)
    const match = source.match(/github\.com[/:]([\w.-]+\/[\w.-]+)/);
    if (match) {
      const repo = match[1].replace(/\.git$/, '');
      return { type: 'github', path: repo, repo };
    }
  }

  // Treat as local path
  return { type: 'local', path: source };
}

/**
 * Fetch codev directory from GitHub
 */
async function fetchFromGitHub(repo: string, tempDir: string): Promise<string> {
  console.log(chalk.dim(`Fetching from GitHub: ${repo}...`));

  // Clone with depth 1 to get only latest
  const cloneUrl = `https://github.com/${repo}.git`;

  try {
    execSync(`git clone --depth 1 "${cloneUrl}" "${tempDir}"`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  } catch (error) {
    throw new Error(`Failed to clone ${repo}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const codevDir = path.join(tempDir, 'codev');
  if (!fs.existsSync(codevDir)) {
    throw new Error(`Repository ${repo} does not have a codev/ directory`);
  }

  return codevDir;
}

/**
 * Read relevant codev files for comparison
 */
function readCodevDirectory(dir: string): Map<string, string> {
  const files = new Map<string, string>();

  // Directories to include in comparison
  const includeDirs = ['protocols', 'resources', 'roles'];

  function walkDir(currentPath: string, relativePath: string) {
    if (!fs.existsSync(currentPath)) return;

    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walkDir(fullPath, relPath);
      } else if (entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          files.set(relPath, content);
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  for (const subdir of includeDirs) {
    walkDir(path.join(dir, subdir), subdir);
  }

  return files;
}

/**
 * Format files map for Claude context
 */
function formatFilesForContext(files: Map<string, string>, label: string): string {
  let output = `## ${label}\n\n`;

  if (files.size === 0) {
    output += '(No codev files found)\n';
    return output;
  }

  for (const [filePath, content] of files) {
    output += `### ${filePath}\n\n`;
    output += '```markdown\n';
    // Truncate very long files
    if (content.length > 10000) {
      output += content.substring(0, 10000);
      output += '\n\n... (truncated, ' + content.length + ' chars total)\n';
    } else {
      output += content;
    }
    output += '\n```\n\n';
  }

  return output;
}

/**
 * Build the prompt for Claude
 */
function buildImportPrompt(
  sourceFiles: Map<string, string>,
  targetFiles: Map<string, string>,
  sourceLabel: string
): string {
  return `You are helping import protocol improvements from another codev project.

The user wants to import improvements from "${sourceLabel}" into their local codev installation.

${formatFilesForContext(sourceFiles, 'SOURCE (from ' + sourceLabel + ')')}

${formatFilesForContext(targetFiles, 'TARGET (local codev/)')}

---

## Your Task

Analyze the differences between SOURCE and TARGET and help the user decide what to import.

Focus on:
1. **Protocol improvements**: New phases, better documentation, additional guidance
2. **Lessons learned**: Wisdom from other projects' reviews
3. **Architectural patterns**: Better ways to document or structure things
4. **New protocols**: Protocols that exist in source but not target

For each potential import, explain:
- What it is and why it might be valuable
- Any risks or considerations
- Your recommendation (import, skip, or merge manually)

Be interactive - discuss with the user and wait for their approval before making changes.

When the user approves a change, make the edit to the appropriate file in codev/.

Start by summarizing the key differences you found.`;
}

/**
 * Main import entry point
 */
export async function importCommand(source: string, options: ImportOptions = {}): Promise<void> {
  const { dryRun = false } = options;

  if (!source) {
    throw new Error(
      'Source required.\n\n' +
      'Usage:\n' +
      '  codev import /path/to/other-project\n' +
      '  codev import github:owner/repo\n' +
      '  codev import https://github.com/owner/repo'
    );
  }

  const workspaceRoot = findWorkspaceRoot();
  const localCodevDir = path.join(workspaceRoot, 'codev');

  if (!fs.existsSync(localCodevDir)) {
    throw new Error(
      'No codev/ directory found in current project.\n' +
      'Run "codev init" or "codev adopt" first.'
    );
  }

  console.log('');
  console.log(chalk.bold('Codev Import'));
  console.log(chalk.dim('AI-assisted protocol import from other projects'));
  console.log('');

  const parsed = parseSource(source);
  let sourceCodevDir: string;
  let tempDir: string | null = null;
  let sourceLabel = source;

  try {
    if (parsed.type === 'github') {
      // Create temp directory for GitHub clone
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-import-'));
      sourceCodevDir = await fetchFromGitHub(parsed.repo!, tempDir);
      sourceLabel = `github:${parsed.repo}`;
      console.log(chalk.green('✓'), `Fetched ${parsed.repo}`);
    } else {
      // Local path
      sourceCodevDir = path.join(parsed.path, 'codev');
      if (!fs.existsSync(sourceCodevDir)) {
        // Maybe they specified the codev dir directly?
        if (fs.existsSync(parsed.path) && fs.statSync(parsed.path).isDirectory()) {
          // Check if it looks like a codev directory
          if (fs.existsSync(path.join(parsed.path, 'protocols')) ||
              fs.existsSync(path.join(parsed.path, 'roles'))) {
            sourceCodevDir = parsed.path;
          } else {
            throw new Error(`No codev/ directory found at ${parsed.path}`);
          }
        } else {
          throw new Error(`Path not found: ${parsed.path}`);
        }
      }
      sourceLabel = path.basename(path.dirname(sourceCodevDir)) || parsed.path;
      console.log(chalk.green('✓'), `Found local source: ${sourceCodevDir}`);
    }

    // Read files from both directories
    console.log(chalk.dim('Reading source files...'));
    const sourceFiles = readCodevDirectory(sourceCodevDir);
    console.log(chalk.dim(`  Found ${sourceFiles.size} files`));

    console.log(chalk.dim('Reading target files...'));
    const targetFiles = readCodevDirectory(localCodevDir);
    console.log(chalk.dim(`  Found ${targetFiles.size} files`));

    if (sourceFiles.size === 0) {
      throw new Error('No codev files found in source');
    }

    // Build the prompt
    const prompt = buildImportPrompt(sourceFiles, targetFiles, sourceLabel);

    if (dryRun) {
      console.log('');
      console.log(chalk.yellow('Dry run - would spawn Claude with this context:'));
      console.log('');
      console.log(chalk.dim('Source files:'));
      for (const file of sourceFiles.keys()) {
        console.log(chalk.dim(`  - ${file}`));
      }
      console.log('');
      console.log(chalk.dim('Target files:'));
      for (const file of targetFiles.keys()) {
        console.log(chalk.dim(`  - ${file}`));
      }
      console.log('');
      console.log(chalk.dim('Prompt length:'), prompt.length, 'chars');
      return;
    }

    // Check if claude is available
    try {
      execSync('which claude', { stdio: 'pipe' });
    } catch {
      throw new Error(
        'Claude CLI not found.\n' +
        'Install with: npm install -g @anthropic-ai/claude-code'
      );
    }

    console.log('');
    console.log(chalk.bold('Starting interactive Claude session...'));
    console.log(chalk.dim('Claude will analyze the differences and help you decide what to import.'));
    console.log('');

    // Spawn interactive Claude session
    // We use -p to pass the initial prompt, but NOT --print so it stays interactive
    const claudeProcess = spawn('claude', ['-p', prompt], {
      stdio: 'inherit',
      cwd: workspaceRoot, // Run from workspace root so Claude can make edits
    });

    await new Promise<void>((resolve, reject) => {
      claudeProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Claude exited with code ${code}`));
        }
      });

      claudeProcess.on('error', (error) => {
        reject(error);
      });
    });

    console.log('');
    console.log(chalk.green('✓'), 'Import session complete');

  } finally {
    // Clean up temp directory if we created one
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
