/**
 * codev init - Create a new codev project
 *
 * Creates a minimal codev structure. Framework files (protocols, roles)
 * are provided by the embedded skeleton at runtime, not copied to the project.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import chalk from 'chalk';
import { getTemplatesDir } from '../lib/templates.js';

interface InitOptions {
  yes?: boolean;
}

/**
 * Prompt user for input
 */
async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const promptText = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
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
 * Initialize a new codev project
 */
export async function init(projectName?: string, options: InitOptions = {}): Promise<void> {
  const { yes = false } = options;

  // Determine project directory
  let targetDir: string;
  if (projectName) {
    targetDir = path.resolve(projectName);
  } else if (yes) {
    throw new Error('Project name is required when using --yes flag');
  } else {
    const name = await prompt('Project name', 'my-project');
    targetDir = path.resolve(name);
  }

  const projectBaseName = path.basename(targetDir);

  // Check if directory already exists
  if (fs.existsSync(targetDir)) {
    throw new Error(`Directory '${projectBaseName}' already exists. Use 'codev adopt' to add codev to an existing project.`);
  }

  console.log('');
  console.log(chalk.bold('Creating new codev project:'), projectBaseName);
  console.log(chalk.dim('Location:'), targetDir);
  console.log('');

  // Get configuration (interactive or defaults)
  let initGit = true;

  if (!yes) {
    initGit = await confirm('Initialize git repository?', true);
  }

  // Create directory
  fs.mkdirSync(targetDir, { recursive: true });

  // Create minimal codev structure
  // Framework files (protocols, roles) are provided by embedded skeleton at runtime
  let fileCount = 0;

  console.log(chalk.dim('Creating minimal codev structure...'));
  console.log(chalk.dim('(Framework files provided by @cluesmith/codev at runtime)'));
  console.log('');

  // Create user data directories
  const userDirs = ['specs', 'plans', 'reviews'];
  for (const dir of userDirs) {
    const dirPath = path.join(targetDir, 'codev', dir);
    fs.mkdirSync(dirPath, { recursive: true });
    // Create .gitkeep to preserve empty directory
    fs.writeFileSync(path.join(dirPath, '.gitkeep'), '');
    console.log(chalk.green('  +'), `codev/${dir}/`);
    fileCount++;
  }

  // Get skeleton directory for templates
  const skeletonDir = getTemplatesDir();

  // Create projectlist.md from skeleton template
  const projectlistPath = path.join(targetDir, 'codev', 'projectlist.md');
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

  // Create resources directory and copy templates
  const resourcesDir = path.join(targetDir, 'codev', 'resources');
  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }

  // Copy lessons-learned.md template
  const lessonsPath = path.join(resourcesDir, 'lessons-learned.md');
  const lessonsTemplatePath = path.join(skeletonDir, 'templates', 'lessons-learned.md');
  if (fs.existsSync(lessonsTemplatePath)) {
    fs.copyFileSync(lessonsTemplatePath, lessonsPath);
    console.log(chalk.green('  +'), 'codev/resources/lessons-learned.md');
    fileCount++;
  }

  // Copy arch.md template
  const archPath = path.join(resourcesDir, 'arch.md');
  const archTemplatePath = path.join(skeletonDir, 'templates', 'arch.md');
  if (fs.existsSync(archTemplatePath)) {
    fs.copyFileSync(archTemplatePath, archPath);
    console.log(chalk.green('  +'), 'codev/resources/arch.md');
    fileCount++;
  }

  // Create CLAUDE.md / AGENTS.md at project root from skeleton templates
  const claudeMdSrc = path.join(skeletonDir, 'templates', 'CLAUDE.md');
  const agentsMdSrc = path.join(skeletonDir, 'templates', 'AGENTS.md');

  if (fs.existsSync(claudeMdSrc)) {
    const content = fs.readFileSync(claudeMdSrc, 'utf-8')
      .replace(/\{\{PROJECT_NAME\}\}/g, projectBaseName);
    fs.writeFileSync(path.join(targetDir, 'CLAUDE.md'), content);
    console.log(chalk.green('  +'), 'CLAUDE.md');
    fileCount++;
  }

  if (fs.existsSync(agentsMdSrc)) {
    const content = fs.readFileSync(agentsMdSrc, 'utf-8')
      .replace(/\{\{PROJECT_NAME\}\}/g, projectBaseName);
    fs.writeFileSync(path.join(targetDir, 'AGENTS.md'), content);
    console.log(chalk.green('  +'), 'AGENTS.md');
    fileCount++;
  }

  // Create .gitignore
  const gitignoreContent = `# Codev
.agent-farm/
.consult/
codev/.update-hashes.json
.builders/

# Dependencies
node_modules/

# Build output
dist/

# OS files
.DS_Store
*.swp
*.swo
`;
  fs.writeFileSync(path.join(targetDir, '.gitignore'), gitignoreContent);
  console.log(chalk.green('  +'), '.gitignore');
  fileCount++;

  // Initialize git if requested
  if (initGit) {
    const { execSync } = await import('node:child_process');
    try {
      execSync('git init', { cwd: targetDir, stdio: 'pipe' });
      console.log(chalk.green('  ✓'), 'Git repository initialized');
    } catch (error) {
      console.log(chalk.yellow('  ⚠'), 'Failed to initialize git repository');
    }
  }

  console.log('');
  console.log(chalk.green.bold('✓'), `Created ${fileCount} files`);
  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log('');
  console.log(`  cd ${projectBaseName}`);
  console.log('  codev doctor           # Check dependencies');
  console.log('  af start               # Start the architect dashboard');
  console.log('');
  console.log(chalk.dim('For more info, see: https://github.com/cluesmith/codev'));
}
