/**
 * Scaffold utilities shared across codev init / adopt / update.
 *
 * Directory creation, skeleton copying, and root-file templating. Gitignore
 * management lives in `./gitignore.ts` (extracted in issue #882).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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

  const templates = ['lessons-learned.md', 'arch.md', 'cheatsheet.md', 'lifecycle.md'];
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

/** The capped hot-tier files materialized into a project's codev/resources/ (Spec 987). */
export const HOT_TIER_FILES = ['arch-critical.md', 'lessons-critical.md'] as const;

/**
 * Copy the hot-tier files (arch-critical.md, lessons-critical.md) from the skeleton
 * into the project's codev/resources/.
 *
 * Spec 987: these are framework-provided starters each project then curates. Porch
 * injection and the CLAUDE/AGENTS managed block resolve them via the four-tier chain
 * (so injection works even before this runs), but materializing local copies makes the
 * hot tier visible and per-project editable. `skipExisting` so a curated copy is never
 * overwritten. This is a focused, wired-in step — distinct from the dead
 * `copyResourceTemplates` (which init/adopt/update do not call).
 */
export function copyHotTierDefaults(
  targetDir: string,
  skeletonDir: string,
  options: CopyResourceTemplatesOptions = {}
): CopyResourceTemplatesResult {
  const { skipExisting = false } = options;
  const resourcesDir = path.join(targetDir, 'codev', 'resources');
  const copied: string[] = [];
  const skipped: string[] = [];

  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }

  for (const file of HOT_TIER_FILES) {
    const destPath = path.join(resourcesDir, file);
    const srcPath = path.join(skeletonDir, 'templates', file);

    if (skipExisting && fs.existsSync(destPath)) {
      skipped.push(file);
      continue;
    }
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      copied.push(file);
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

interface CreateProjectsDirOptions {
  skipExisting?: boolean;
}

interface CreateProjectsDirResult {
  created: boolean;
  skipped: boolean;
}

/**
 * Create codev/projects/ directory for porch state files
 */
export function createProjectsDir(
  targetDir: string,
  options: CreateProjectsDirOptions = {}
): CreateProjectsDirResult {
  const { skipExisting = false } = options;
  const projectsDir = path.join(targetDir, 'codev', 'projects');

  if (skipExisting && fs.existsSync(projectsDir)) {
    return { created: false, skipped: true };
  }

  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, '.gitkeep'), '');
  return { created: true, skipped: false };
}

/**
 * Recursively copy a directory
 */
function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

interface CopySkillsOptions {
  skipExisting?: boolean;
}

interface CopySkillsResult {
  copied: string[];
  skipped: string[];
  directoryCreated: boolean;
}

/**
 * Copy .claude/skills/ from skeleton to project root.
 * Skills are Claude Code slash commands that provide contextual guidance.
 */
export function copySkills(
  targetDir: string,
  skeletonDir: string,
  options: CopySkillsOptions = {}
): CopySkillsResult {
  const { skipExisting = false } = options;
  const skillsDir = path.join(targetDir, '.claude', 'skills');
  const srcDir = path.join(skeletonDir, '.claude', 'skills');
  const copied: string[] = [];
  const skipped: string[] = [];
  let directoryCreated = false;

  // Ensure .claude/skills directory exists
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    directoryCreated = true;
  }

  // If source directory doesn't exist, return early
  if (!fs.existsSync(srcDir)) {
    return { copied, skipped, directoryCreated };
  }

  // Copy each skill directory
  const skills = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of skills) {
    if (!entry.isDirectory()) continue;

    const destSkillDir = path.join(skillsDir, entry.name);
    const srcSkillDir = path.join(srcDir, entry.name);

    if (skipExisting && fs.existsSync(destSkillDir)) {
      skipped.push(entry.name);
      continue;
    }

    copyDirRecursive(srcSkillDir, destSkillDir);
    copied.push(entry.name);
  }

  return { copied, skipped, directoryCreated };
}

interface CopyRolesOptions {
  skipExisting?: boolean;
}

interface CopyRolesResult {
  copied: string[];
  skipped: string[];
  directoryCreated: boolean;
}

/**
 * Copy roles directory from skeleton to codev/roles/.
 * Contains role prompts (architect, builder, consultant) for agent sessions.
 */
export function copyRoles(
  targetDir: string,
  skeletonDir: string,
  options: CopyRolesOptions = {}
): CopyRolesResult {
  const { skipExisting = false } = options;
  const rolesDir = path.join(targetDir, 'codev', 'roles');
  const srcDir = path.join(skeletonDir, 'roles');
  const copied: string[] = [];
  const skipped: string[] = [];
  let directoryCreated = false;

  // Ensure roles directory exists
  if (!fs.existsSync(rolesDir)) {
    fs.mkdirSync(rolesDir, { recursive: true });
    directoryCreated = true;
  }

  // If source directory doesn't exist, return early
  if (!fs.existsSync(srcDir)) {
    return { copied, skipped, directoryCreated };
  }

  // Copy all .md files from skeleton roles
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const destPath = path.join(rolesDir, file);
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

interface CopyProtocolsOptions {
  skipExisting?: boolean;
}

interface CopyProtocolsResult {
  copied: string[];
  skipped: string[];
  directoryCreated: boolean;
}

/**
 * Copy protocol definitions from skeleton to codev/protocols/
 * Required for porch orchestration
 */
export function copyProtocols(
  targetDir: string,
  skeletonDir: string,
  options: CopyProtocolsOptions = {}
): CopyProtocolsResult {
  const { skipExisting = false } = options;
  const protocolsDir = path.join(targetDir, 'codev', 'protocols');
  const srcDir = path.join(skeletonDir, 'protocols');
  const copied: string[] = [];
  const skipped: string[] = [];
  let directoryCreated = false;

  // Ensure protocols directory exists
  if (!fs.existsSync(protocolsDir)) {
    fs.mkdirSync(protocolsDir, { recursive: true });
    directoryCreated = true;
  }

  // If source directory doesn't exist, return early
  if (!fs.existsSync(srcDir)) {
    return { copied, skipped, directoryCreated };
  }

  // Copy each protocol directory
  const protocols = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of protocols) {
    if (!entry.isDirectory()) {
      // Copy top-level files (like protocol-schema.json)
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(protocolsDir, entry.name);

      if (skipExisting && fs.existsSync(destPath)) {
        skipped.push(entry.name);
        continue;
      }

      fs.copyFileSync(srcPath, destPath);
      copied.push(entry.name);
      continue;
    }

    const destProtocolDir = path.join(protocolsDir, entry.name);
    const srcProtocolDir = path.join(srcDir, entry.name);

    if (skipExisting && fs.existsSync(destProtocolDir)) {
      skipped.push(entry.name + '/');
      continue;
    }

    copyDirRecursive(srcProtocolDir, destProtocolDir);
    copied.push(entry.name + '/');
  }

  return { copied, skipped, directoryCreated };
}
