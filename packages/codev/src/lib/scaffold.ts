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

/**
 * Cold-tier governance files: the skeleton starter to copy from → the project-local
 * filename it materializes as (issue #1012).
 *
 * The starter sources are minimal placeholders (`*.starter.md`) kept separate from the rich
 * `templates/{arch,lessons-learned}.md` reference templates — those carry a "this file is not
 * copied into projects" note and are the manual-`cp` opt-in, so they must not be the copied
 * starter. Each project instead gets a trivial placeholder it grows over time, enough for the
 * review-phase read to succeed against a real, locally-owned file.
 */
export const COLD_TIER_FILES = [
  { src: 'arch.starter.md', dest: 'arch.md' },
  { src: 'lessons-learned.starter.md', dest: 'lessons-learned.md' },
] as const;

/**
 * Copy the cold-tier governance files (arch.md, lessons-learned.md) from the skeleton's
 * `*.starter.md` placeholders into the project's codev/resources/.
 *
 * Companion to `copyHotTierDefaults`: Spec 987 materializes the hot tier on
 * init/adopt/update but left the cold tier — which the review prompts read and the hot-tier
 * maps point into — uncreated. `skipExisting` so a curated file is never overwritten (the
 * cold files are already registered as protected user data in templates.ts). Results are
 * keyed by the destination filename.
 */
export function copyColdTierDefaults(
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

  for (const { src, dest } of COLD_TIER_FILES) {
    const destPath = path.join(resourcesDir, dest);
    const srcPath = path.join(skeletonDir, 'templates', src);

    if (skipExisting && fs.existsSync(destPath)) {
      skipped.push(dest);
      continue;
    }
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      copied.push(dest);
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
  /** Project-relative provider-qualified paths, including a trailing slash. */
  copied: string[];
  /** Project-relative provider-qualified paths, including a trailing slash. */
  skipped: string[];
  /** Project-relative provider skill roots that were created. */
  directoriesCreated: string[];
}

export const SKILL_PROVIDERS = ['claude', 'codex'] as const;

/**
 * Copy provider-native skill trees from the skeleton to the project root.
 *
 * Each skill directory is the preservation boundary: skipExisting leaves an
 * existing skill completely untouched while still backfilling missing skills
 * for either provider.
 */
export function copySkills(
  targetDir: string,
  skeletonDir: string,
  options: CopySkillsOptions = {}
): CopySkillsResult {
  const { skipExisting = false } = options;
  const copied: string[] = [];
  const skipped: string[] = [];
  const directoriesCreated: string[] = [];

  for (const provider of SKILL_PROVIDERS) {
    const relativeSkillsDir = `.${provider}/skills`;
    const skillsDir = path.join(targetDir, relativeSkillsDir);
    const srcDir = path.join(skeletonDir, relativeSkillsDir);

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
      directoriesCreated.push(`${relativeSkillsDir}/`);
    }

    // Older/corrupt skeletons may not provide every configured provider.
    if (!fs.existsSync(srcDir)) continue;

    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const destSkillDir = path.join(skillsDir, entry.name);
      const relativeSkillDir = `${relativeSkillsDir}/${entry.name}/`;

      if (skipExisting && fs.existsSync(destSkillDir)) {
        skipped.push(relativeSkillDir);
        continue;
      }

      copyDirRecursive(path.join(srcDir, entry.name), destSkillDir);
      copied.push(relativeSkillDir);
    }
  }

  return { copied, skipped, directoriesCreated };
}

/*
 * copyRoles / copyProtocols were removed by Spec 1252 (M9).
 *
 * They copied the skeleton's protocols/ and roles/ into a project's codev/,
 * creating tier-2 shadow copies that silently outrank the installed skeleton
 * in the four-tier resolver — the exact mechanism behind the drift bug this
 * spec fixed (17 stale framework files served to this repo's own builders).
 * Neither function had been called by init/adopt/update for a long time;
 * they survived only as dead exports. Do not reintroduce them: framework
 * files resolve from the skeleton at runtime and are never copied into
 * projects (see arch-critical.md).
 */

