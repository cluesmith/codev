/**
 * Scaffold utilities for codev init and adopt commands
 * Extracted to eliminate duplication (Maintenance Run 0004)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Standard gitignore entries for codev projects
 */
export const CODEV_GITIGNORE_ENTRIES = `# Codev
.agent-farm/
.consult/
codev/.update-hashes.json
.builders/
`;

/**
 * Full gitignore content for new projects
 */
export const FULL_GITIGNORE_CONTENT = `${CODEV_GITIGNORE_ENTRIES}
# Dependencies
node_modules/

# Build output
dist/

# OS files
.DS_Store
*.swp
*.swo
`;

/**
 * Inline fallback template for projectlist.md
 */
const PROJECTLIST_FALLBACK = `# Project List

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

interface CreateUserDirsOptions {
  skipExisting?: boolean;
}

interface CreateUserDirsResult {
  created: string[];
  skipped: string[];
}

/**
 * Create user data directories (specs, plans, reviews) with .gitkeep files
 */
export function createUserDirs(
  targetDir: string,
  options: CreateUserDirsOptions = {}
): CreateUserDirsResult {
  const { skipExisting = false } = options;
  const userDirs = ['specs', 'plans', 'reviews'];
  const created: string[] = [];
  const skipped: string[] = [];

  for (const dir of userDirs) {
    const dirPath = path.join(targetDir, 'codev', dir);
    if (skipExisting && fs.existsSync(dirPath)) {
      skipped.push(dir);
      continue;
    }
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, '.gitkeep'), '');
    created.push(dir);
  }

  return { created, skipped };
}

interface CopyProjectlistOptions {
  skipExisting?: boolean;
}

interface CopyProjectlistResult {
  copied: boolean;
  skipped?: boolean;
  usedFallback?: boolean;
}

/**
 * Copy projectlist.md from skeleton template, with inline fallback
 */
export function copyProjectlist(
  targetDir: string,
  skeletonDir: string,
  options: CopyProjectlistOptions = {}
): CopyProjectlistResult {
  const { skipExisting = false } = options;
  const projectlistPath = path.join(targetDir, 'codev', 'projectlist.md');

  if (skipExisting && fs.existsSync(projectlistPath)) {
    return { copied: false, skipped: true };
  }

  const templatePath = path.join(skeletonDir, 'templates', 'projectlist.md');
  if (fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, projectlistPath);
    return { copied: true };
  }

  // Fallback to inline template
  fs.writeFileSync(projectlistPath, PROJECTLIST_FALLBACK);
  return { copied: true, usedFallback: true };
}

interface CopyProjectlistArchiveResult {
  copied: boolean;
  skipped?: boolean;
  templateNotFound?: boolean;
}

/**
 * Copy projectlist-archive.md from skeleton template
 */
export function copyProjectlistArchive(
  targetDir: string,
  skeletonDir: string,
  options: CopyProjectlistOptions = {}
): CopyProjectlistArchiveResult {
  const { skipExisting = false } = options;
  const archivePath = path.join(targetDir, 'codev', 'projectlist-archive.md');

  if (skipExisting && fs.existsSync(archivePath)) {
    return { copied: false, skipped: true };
  }

  const templatePath = path.join(skeletonDir, 'templates', 'projectlist-archive.md');
  if (!fs.existsSync(templatePath)) {
    return { copied: false, templateNotFound: true };
  }

  fs.copyFileSync(templatePath, archivePath);
  return { copied: true };
}

interface CopyConsultTypesOptions {
  skipExisting?: boolean;
}

interface CopyConsultTypesResult {
  copied: string[];
  skipped: string[];
  directoryCreated: boolean;
}

/**
 * Copy consult-types directory from skeleton.
 * Contains review type prompts that users can customize.
 */
export function copyConsultTypes(
  targetDir: string,
  skeletonDir: string,
  options: CopyConsultTypesOptions = {}
): CopyConsultTypesResult {
  const { skipExisting = false } = options;
  const consultTypesDir = path.join(targetDir, 'codev', 'consult-types');
  const srcDir = path.join(skeletonDir, 'consult-types');
  const copied: string[] = [];
  const skipped: string[] = [];
  let directoryCreated = false;

  // Ensure consult-types directory exists
  if (!fs.existsSync(consultTypesDir)) {
    fs.mkdirSync(consultTypesDir, { recursive: true });
    directoryCreated = true;
  }

  // If source directory doesn't exist, return early
  if (!fs.existsSync(srcDir)) {
    return { copied, skipped, directoryCreated };
  }

  // Copy all .md files from skeleton consult-types
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const destPath = path.join(consultTypesDir, file);
    const srcPath = path.join(srcDir, file);

    if (skipExisting && fs.existsSync(destPath)) {
      skipped.push(file);
      continue;
    }

    fs.copyFileSync(srcPath, destPath);
    copied.push(file);
  }

  return { copied, skipped, directoryCreated };
}

interface CopyResourceTemplatesOptions {
  skipExisting?: boolean;
}

interface CopyResourceTemplatesResult {
  copied: string[];
  skipped: string[];
}

/**
 * Copy resource templates (lessons-learned.md, arch.md)
 */
export function copyResourceTemplates(
  targetDir: string,
  skeletonDir: string,
  options: CopyResourceTemplatesOptions = {}
): CopyResourceTemplatesResult {
  const { skipExisting = false } = options;
  const resourcesDir = path.join(targetDir, 'codev', 'resources');
  const copied: string[] = [];
  const skipped: string[] = [];

  // Ensure resources directory exists
  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }

  const templates = ['lessons-learned.md', 'arch.md'];
  for (const template of templates) {
    const destPath = path.join(resourcesDir, template);
    const srcPath = path.join(skeletonDir, 'templates', template);

    if (skipExisting && fs.existsSync(destPath)) {
      skipped.push(template);
      continue;
    }

    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      copied.push(template);
    }
  }

  return { copied, skipped };
}

interface CopyRootFilesOptions {
  handleConflicts?: boolean;
}

interface CopyRootFilesResult {
  copied: string[];
  conflicts: string[];
}

/**
 * Copy root files (CLAUDE.md, AGENTS.md) with project name substitution
 */
export function copyRootFiles(
  targetDir: string,
  skeletonDir: string,
  projectName: string,
  options: CopyRootFilesOptions = {}
): CopyRootFilesResult {
  const { handleConflicts = false } = options;
  const copied: string[] = [];
  const conflicts: string[] = [];

  const rootFiles = ['CLAUDE.md', 'AGENTS.md'];
  for (const file of rootFiles) {
    const srcPath = path.join(skeletonDir, 'templates', file);
    const destPath = path.join(targetDir, file);

    if (!fs.existsSync(srcPath)) {
      continue;
    }

    const content = fs.readFileSync(srcPath, 'utf-8')
      .replace(/\{\{PROJECT_NAME\}\}/g, projectName);

    if (fs.existsSync(destPath)) {
      if (handleConflicts) {
        // Create .codev-new for merge
        fs.writeFileSync(destPath + '.codev-new', content);
        conflicts.push(file);
      }
      // Skip if exists and not handling conflicts
    } else {
      fs.writeFileSync(destPath, content);
      copied.push(file);
    }
  }

  return { copied, conflicts };
}

/**
 * Create a new .gitignore file with full content (for init)
 */
export function createGitignore(targetDir: string): void {
  const gitignorePath = path.join(targetDir, '.gitignore');
  fs.writeFileSync(gitignorePath, FULL_GITIGNORE_CONTENT);
}

interface UpdateGitignoreResult {
  updated: boolean;
  created: boolean;
  alreadyPresent: boolean;
}

/**
 * Update existing .gitignore or create if not exists (for adopt)
 */
export function updateGitignore(targetDir: string): UpdateGitignoreResult {
  const gitignorePath = path.join(targetDir, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, CODEV_GITIGNORE_ENTRIES.trim() + '\n');
    return { updated: false, created: true, alreadyPresent: false };
  }

  const existing = fs.readFileSync(gitignorePath, 'utf-8');
  if (existing.includes('.agent-farm/')) {
    return { updated: false, created: false, alreadyPresent: true };
  }

  fs.appendFileSync(gitignorePath, '\n' + CODEV_GITIGNORE_ENTRIES);
  return { updated: true, created: false, alreadyPresent: false };
}
