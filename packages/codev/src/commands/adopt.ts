/**
 * codev adopt - Add codev to an existing project
 *
 * Creates a minimal codev structure. Framework files (protocols, roles)
 * are provided by the embedded skeleton at runtime, not copied to the project.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { getTemplatesDir } from '../lib/templates.js';

interface AdoptOptions {
  yes?: boolean;
}

interface Conflict {
  file: string;
  type: 'file' | 'directory';
}

/**
 * Prompt for yes/no confirmation
 */
async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    rl.question(`${question} ${hint}: `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized === '') {
        resolve(defaultYes);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}

/**
 * Detect conflicts with existing files
 */
function detectConflicts(targetDir: string): Conflict[] {
  const conflicts: Conflict[] = [];
  const isRulerProject = fs.existsSync(path.join(targetDir, '.ruler', 'ruler.toml'));

  // Check for codev/ directory
  const codevDir = path.join(targetDir, 'codev');
  if (fs.existsSync(codevDir)) {
    conflicts.push({ file: 'codev/', type: 'directory' });
  }

  if (isRulerProject) {
    // Ruler project: check .ruler/codev.md instead of root files
    const rulerCodev = path.join(targetDir, '.ruler', 'codev.md');
    if (fs.existsSync(rulerCodev)) {
      conflicts.push({ file: '.ruler/codev.md', type: 'file' });
    }
  } else {
    // Non-Ruler: check root files
    const claudeMd = path.join(targetDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      conflicts.push({ file: 'CLAUDE.md', type: 'file' });
    }

    const agentsMd = path.join(targetDir, 'AGENTS.md');
    if (fs.existsSync(agentsMd)) {
      conflicts.push({ file: 'AGENTS.md', type: 'file' });
    }
  }

  return conflicts;
}

/**
 * Detect if project uses Ruler for agent config management
 * https://github.com/intellectronica/ruler
 */
function detectRuler(targetDir: string): boolean {
  const rulerToml = path.join(targetDir, '.ruler', 'ruler.toml');
  return fs.existsSync(rulerToml);
}

/**
 * Add codev to an existing project
 */
export async function adopt(options: AdoptOptions = {}): Promise<void> {
  const { yes = false } = options;
  const targetDir = process.cwd();
  const projectName = path.basename(targetDir);

  console.log('');
  console.log(chalk.bold('Adding codev to existing project:'), projectName);
  console.log(chalk.dim('Location:'), targetDir);
  console.log('');

  // Check for codev/ directory - can't adopt if it exists
  const codevDir = path.join(targetDir, 'codev');
  if (fs.existsSync(codevDir)) {
    throw new Error("codev/ directory already exists. Use 'codev update' to update existing installation.");
  }

  // Detect other conflicts
  const conflicts = detectConflicts(targetDir).filter(c => c.file !== 'codev/');

  if (conflicts.length > 0 && !yes) {
    console.log(chalk.yellow('Potential conflicts detected:'));
    console.log('');
    for (const conflict of conflicts) {
      console.log(chalk.yellow('  ⚠'), conflict.file, chalk.dim(`(${conflict.type})`));
    }
    console.log('');

    const proceed = await confirm('Continue and skip conflicting files?', false);
    if (!proceed) {
      console.log(chalk.dim('Aborted.'));
      process.exit(0);
    }
  }

  // Create minimal codev structure
  // Framework files (protocols, roles) are provided by embedded skeleton at runtime
  let fileCount = 0;
  let skippedCount = 0;

  console.log(chalk.dim('Creating minimal codev structure...'));
  console.log(chalk.dim('(Framework files provided by @cluesmith/codev at runtime)'));
  console.log('');

  // Create user data directories
  const userDirs = ['specs', 'plans', 'reviews'];
  for (const dir of userDirs) {
    const dirPath = path.join(targetDir, 'codev', dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      // Create .gitkeep to preserve empty directory
      fs.writeFileSync(path.join(dirPath, '.gitkeep'), '');
      console.log(chalk.green('  +'), `codev/${dir}/`);
      fileCount++;
    }
  }

  // Get skeleton directory for templates
  const skeletonDir = getTemplatesDir();

  // Create projectlist.md from skeleton template
  const projectlistPath = path.join(targetDir, 'codev', 'projectlist.md');
  if (!fs.existsSync(projectlistPath)) {
    const projectlistTemplatePath = path.join(skeletonDir, 'templates', 'projectlist.md');
    if (fs.existsSync(projectlistTemplatePath)) {
      fs.copyFileSync(projectlistTemplatePath, projectlistPath);
    } else {
      // Fallback to inline template if skeleton template not found
      const projectlistContent = `# Project List

Track all projects here. See codev documentation for status values.

\`\`\`yaml
projects:
  - id: "0001"
    title: "Example Project"
    summary: "Brief description"
    status: conceived
    priority: medium
    files:
      spec: null
      plan: null
      review: null
    dependencies: []
    tags: []
    notes: "Replace with your first project"
\`\`\`
`;
      fs.writeFileSync(projectlistPath, projectlistContent);
    }
    console.log(chalk.green('  +'), 'codev/projectlist.md');
    fileCount++;
  }

  // Create projectlist-archive.md from skeleton template if it doesn't exist
  const projectlistArchivePath = path.join(targetDir, 'codev', 'projectlist-archive.md');
  if (!fs.existsSync(projectlistArchivePath)) {
    const projectlistArchiveTemplatePath = path.join(skeletonDir, 'templates', 'projectlist-archive.md');
    if (fs.existsSync(projectlistArchiveTemplatePath)) {
      fs.copyFileSync(projectlistArchiveTemplatePath, projectlistArchivePath);
      console.log(chalk.green('  +'), 'codev/projectlist-archive.md');
      fileCount++;
    }
  }

  // Create resources directory and copy templates if they don't exist
  const resourcesDir = path.join(targetDir, 'codev', 'resources');
  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }

  // Copy lessons-learned.md template if it doesn't exist
  const lessonsPath = path.join(resourcesDir, 'lessons-learned.md');
  if (!fs.existsSync(lessonsPath)) {
    const lessonsTemplatePath = path.join(skeletonDir, 'templates', 'lessons-learned.md');
    if (fs.existsSync(lessonsTemplatePath)) {
      fs.copyFileSync(lessonsTemplatePath, lessonsPath);
      console.log(chalk.green('  +'), 'codev/resources/lessons-learned.md');
      fileCount++;
    }
  }

  // Copy arch.md template if it doesn't exist
  const archPath = path.join(resourcesDir, 'arch.md');
  if (!fs.existsSync(archPath)) {
    const archTemplatePath = path.join(skeletonDir, 'templates', 'arch.md');
    if (fs.existsSync(archTemplatePath)) {
      fs.copyFileSync(archTemplatePath, archPath);
      console.log(chalk.green('  +'), 'codev/resources/arch.md');
      fileCount++;
    }
  }

  // Create agent config files (Ruler-aware)
  const claudeMdSrc = path.join(skeletonDir, 'templates', 'CLAUDE.md');
  const agentsMdSrc = path.join(skeletonDir, 'templates', 'AGENTS.md');

  const rootConflicts: string[] = [];
  const isRulerProject = detectRuler(targetDir);

  if (isRulerProject) {
    // Ruler project: create .ruler/codev.md instead of root files
    // Ruler will generate CLAUDE.md/AGENTS.md via `ruler apply`
    // Use codev-instructions.md as source (tool-agnostic, no AGENTS.md/CLAUDE.md notes)
    const codevInstructionsSrc = path.join(skeletonDir, 'templates', 'codev-instructions.md');
    const rulerCodevPath = path.join(targetDir, '.ruler', 'codev.md');

    if (!fs.existsSync(rulerCodevPath) && fs.existsSync(codevInstructionsSrc)) {
      const content = fs.readFileSync(codevInstructionsSrc, 'utf-8');
      fs.writeFileSync(rulerCodevPath, content);
      console.log(chalk.green('  +'), '.ruler/codev.md');
      fileCount++;
    } else if (fs.existsSync(rulerCodevPath) && fs.existsSync(codevInstructionsSrc)) {
      // Conflict: create .codev-new for merge
      const content = fs.readFileSync(codevInstructionsSrc, 'utf-8');
      fs.writeFileSync(rulerCodevPath + '.codev-new', content);
      console.log(chalk.yellow('  !'), '.ruler/codev.md', chalk.dim('(conflict - .codev-new created)'));
      rootConflicts.push('.ruler/codev.md');
      skippedCount++;
    }
  } else {
    // Non-Ruler project: create CLAUDE.md and AGENTS.md at project root
    const claudeMdDest = path.join(targetDir, 'CLAUDE.md');
    const agentsMdDest = path.join(targetDir, 'AGENTS.md');

    // CLAUDE.md
    if (!fs.existsSync(claudeMdDest) && fs.existsSync(claudeMdSrc)) {
      const content = fs.readFileSync(claudeMdSrc, 'utf-8')
        .replace(/\{\{PROJECT_NAME\}\}/g, projectName);
      fs.writeFileSync(claudeMdDest, content);
      console.log(chalk.green('  +'), 'CLAUDE.md');
      fileCount++;
    } else if (fs.existsSync(claudeMdDest) && fs.existsSync(claudeMdSrc)) {
      // Create .codev-new for merge
      const content = fs.readFileSync(claudeMdSrc, 'utf-8')
        .replace(/\{\{PROJECT_NAME\}\}/g, projectName);
      fs.writeFileSync(claudeMdDest + '.codev-new', content);
      console.log(chalk.yellow('  !'), 'CLAUDE.md', chalk.dim('(conflict - .codev-new created)'));
      rootConflicts.push('CLAUDE.md');
      skippedCount++;
    }

    // AGENTS.md
    if (!fs.existsSync(agentsMdDest) && fs.existsSync(agentsMdSrc)) {
      const content = fs.readFileSync(agentsMdSrc, 'utf-8')
        .replace(/\{\{PROJECT_NAME\}\}/g, projectName);
      fs.writeFileSync(agentsMdDest, content);
      console.log(chalk.green('  +'), 'AGENTS.md');
      fileCount++;
    } else if (fs.existsSync(agentsMdDest) && fs.existsSync(agentsMdSrc)) {
      // Create .codev-new for merge
      const content = fs.readFileSync(agentsMdSrc, 'utf-8')
        .replace(/\{\{PROJECT_NAME\}\}/g, projectName);
      fs.writeFileSync(agentsMdDest + '.codev-new', content);
      console.log(chalk.yellow('  !'), 'AGENTS.md', chalk.dim('(conflict - .codev-new created)'));
      rootConflicts.push('AGENTS.md');
      skippedCount++;
    }
  }

  // Update .gitignore if it exists
  const gitignorePath = path.join(targetDir, '.gitignore');
  const codevGitignoreEntries = `
# Codev
.agent-farm/
.consult/
codev/.update-hashes.json
.builders/
`;

  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, 'utf-8');
    if (!existing.includes('.agent-farm/')) {
      fs.appendFileSync(gitignorePath, codevGitignoreEntries);
      console.log(chalk.green('  ~'), '.gitignore', chalk.dim('(updated)'));
    }
  } else {
    fs.writeFileSync(gitignorePath, codevGitignoreEntries.trim() + '\n');
    console.log(chalk.green('  +'), '.gitignore');
    fileCount++;
  }

  console.log('');
  console.log(chalk.green.bold('✓'), `Created ${fileCount} files`);
  if (skippedCount > 0) {
    console.log(chalk.yellow('  ⚠'), `Skipped ${skippedCount} existing files`);
  }
  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log('');
  console.log('  codev doctor           # Check dependencies');
  console.log('  af start               # Start the architect dashboard');
  if (isRulerProject) {
    console.log('');
    console.log(chalk.cyan('  Note: Run `npx @intellectronica/ruler apply` to regenerate CLAUDE.md/AGENTS.md'));
  }
  console.log('');
  console.log(chalk.dim('For more info, see: https://github.com/cluesmith/codev'));

  // If there are root conflicts, spawn Claude to merge
  if (rootConflicts.length > 0) {
    console.log('');
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════'));
    console.log(chalk.cyan('  Launching Claude to merge conflicts...'));
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════'));
    console.log('');

    const mergePrompt = isRulerProject
      ? `Merge .ruler/codev.md from the .codev-new version. Add new sections, preserve my customizations, then delete the .codev-new file. After merging, remind me to run 'npx @intellectronica/ruler apply' to regenerate CLAUDE.md/AGENTS.md.`
      : `Merge ${rootConflicts.join(' and ')} from the .codev-new versions. Add new sections from the .codev-new files, preserve my customizations, then delete the .codev-new files when done.`;

    // Spawn Claude interactively with merge instructions as initial prompt
    const claude = spawn('claude', [mergePrompt], {
      stdio: 'inherit',
      cwd: targetDir,
    });

    claude.on('error', (err) => {
      console.error(chalk.red('Failed to launch Claude:'), err.message);
      console.log('');
      console.log('Please merge the conflicts manually:');
      for (const file of rootConflicts) {
        console.log(chalk.dim(`  ${file} ← ${file}.codev-new`));
      }
    });
  }
}
