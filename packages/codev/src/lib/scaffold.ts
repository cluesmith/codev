/**
 * Scaffold utilities shared across codev init / adopt / update.
 *
 * Directory creation, skeleton copying, and root-file templating. Gitignore
 * management lives in `./gitignore.ts` (extracted in issue #882).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isEmptySkillDir } from './skill-refresh.js';
import { ROOT_DOCS, withEmptyHotBlock } from './managed-block.js';
import { SHIPPED_ROOT_DOC_HASHES } from './shipped-root-doc-hashes.js';

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

interface CopyTierDefaultsOptions extends CopyResourceTemplatesOptions {
  /** Report what would be copied, writing nothing (#1982). */
  dryRun?: boolean;
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
  options: CopyTierDefaultsOptions = {}
): CopyResourceTemplatesResult {
  const { skipExisting = false, dryRun = false } = options;
  const resourcesDir = path.join(targetDir, 'codev', 'resources');
  const copied: string[] = [];
  const skipped: string[] = [];

  if (!dryRun && !fs.existsSync(resourcesDir)) {
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
      if (!dryRun) fs.copyFileSync(srcPath, destPath);
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
  options: CopyTierDefaultsOptions = {}
): CopyResourceTemplatesResult {
  const { skipExisting = false, dryRun = false } = options;
  const resourcesDir = path.join(targetDir, 'codev', 'resources');
  const copied: string[] = [];
  const skipped: string[] = [];

  if (!dryRun && !fs.existsSync(resourcesDir)) {
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
      if (!dryRun) fs.copyFileSync(srcPath, destPath);
      copied.push(dest);
    }
  }

  return { copied, skipped };
}

interface CopyRootFilesOptions {
  handleConflicts?: boolean;
  /** Report what would be copied or conflict, writing nothing. */
  dryRun?: boolean;
  /**
   * With `handleConflicts`, replace a doc that is an older shipped version, never edited,
   * and remove a leftover `.codev-new` that is one (#1985). `codev update` asks for it;
   * adopt leaves an existing doc to the merge.
   */
  replaceShipped?: boolean;
  /** Shipped versions per root doc; tests substitute their own. */
  history?: Record<string, readonly string[]>;
}

interface CopyRootFilesResult {
  copied: string[];
  /** Unedited docs from an older release, replaced with the template (#1985). */
  replaced: string[];
  /** The content of each doc copied or replaced (or, under `dryRun`, to be), by name. */
  written: Record<string, string>;
  conflicts: string[];
  /** Root files left alone because the path to write is a symlink or otherwise irregular. */
  notRegular: string[];
  /** Pending `.codev-new` copies removed (or, under `dryRun`, to remove): nothing left to merge. */
  resolved: string[];
}

/** Something other than a regular file sits at `p` (a symlink, dangling or not; a directory). */
function isIrregularPath(p: string): boolean {
  try {
    return !fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

export const PROJECT_NAME_PLACEHOLDER = '{{PROJECT_NAME}}';

/** A root doc as matching compares it: LF line endings and the managed block emptied (#1982). */
function normalizeRootDoc(doc: string): string {
  return withEmptyHotBlock(doc.replace(/\r\n/g, '\n'));
}

/** The template written for `projectName`. Split and joined: a `$` in the name stays literal. */
function substituteProjectName(template: string, projectName: string): string {
  return template.split(PROJECT_NAME_PLACEHOLDER).join(projectName);
}

/**
 * A root doc the adopter never edited: a regular file that matches the template outside
 * the managed block, whatever project name it was written with and in either line ending.
 * A checkout's directory need not carry the name `init` saw (the name is all the template
 * varies by), and a Windows checkout may turn LF into CRLF, as skills already allow for.
 */
function matchesTemplate(filePath: string, template: string): boolean {
  if (!fs.statSync(filePath).isFile()) return false;
  const pattern = normalizeRootDoc(template)
    .split(PROJECT_NAME_PLACEHOLDER)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^\\n]*');
  return new RegExp(`^${pattern}$`).test(normalizeRootDoc(fs.readFileSync(filePath, 'utf-8')));
}

/**
 * A root doc in the form shipped versions are hashed in (#1985): normalised as for
 * matching, with the project name put back to the placeholder. Every template Codev has
 * shipped carries the name once, in the heading on its first line, so the doc's first line
 * must be `template`'s heading with some name in the placeholder's place, and that name is
 * read from it. The name is never looked for anywhere else, and a doc whose first line is
 * not that heading has no hash form: null.
 */
export function rootDocHashForm(doc: string, template: string): { projectName: string; form: string } | null {
  const heading = template.replace(/\r\n/g, '\n').split('\n', 1)[0];
  const at = heading.indexOf(PROJECT_NAME_PLACEHOLDER);
  if (at < 0) return null;
  const prefix = heading.slice(0, at);
  const suffix = heading.slice(at + PROJECT_NAME_PLACEHOLDER.length);
  const normalized = normalizeRootDoc(doc);
  const firstLine = normalized.split('\n', 1)[0];
  if (firstLine.length < prefix.length + suffix.length) return null;
  if (!firstLine.startsWith(prefix) || !firstLine.endsWith(suffix)) return null;
  return {
    projectName: firstLine.slice(prefix.length, firstLine.length - suffix.length),
    form: heading + normalized.slice(firstLine.length),
  };
}

export function hashRootDocForm(form: string): string {
  return crypto.createHash('sha256').update(form).digest('hex');
}

/**
 * The project name of a root doc that is, outside the managed block, exactly a version of
 * `file`'s template that Codev has shipped; null for anything else, which is the adopter's.
 */
function shippedVersionName(
  content: string,
  file: string,
  template: string,
  history: Record<string, readonly string[]>,
): string | null {
  const parsed = rootDocHashForm(content, template);
  if (parsed === null || !(history[file] ?? []).includes(hashRootDocForm(parsed.form))) return null;
  return parsed.projectName;
}

/**
 * Copy root files (CLAUDE.md, AGENTS.md) with project name substitution. With
 * `handleConflicts`, an existing doc that differs from the template outside the managed
 * block keeps its content and gets the template beside it as `.codev-new`, unless
 * `replaceShipped` is set and it is an older shipped version, never edited: then it is
 * replaced (#1985).
 */
export function copyRootFiles(
  targetDir: string,
  skeletonDir: string,
  projectName: string,
  options: CopyRootFilesOptions = {}
): CopyRootFilesResult {
  const { handleConflicts = false, replaceShipped = false, dryRun = false, history = SHIPPED_ROOT_DOC_HASHES } = options;
  const copied: string[] = [];
  const replaced: string[] = [];
  const written: Record<string, string> = {};
  const conflicts: string[] = [];
  const notRegular: string[] = [];
  const resolved: string[] = [];

  for (const file of ROOT_DOCS) {
    const srcPath = path.join(skeletonDir, 'templates', file);
    const destPath = path.join(targetDir, file);

    if (!fs.existsSync(srcPath)) {
      continue;
    }

    const template = fs.readFileSync(srcPath, 'utf-8');
    const content = substituteProjectName(template, projectName);

    // Never write through a symlink, which may point outside the project: not the
    // `.codev-new` copy, and not a dangling link where a missing file would be created. A
    // root file that is itself a symlink (CLAUDE.md -> AGENTS.md) is fine: only its
    // `.codev-new` sibling is written.
    const pendingIrregular = handleConflicts && isIrregularPath(destPath + '.codev-new');
    const danglingDest = !fs.existsSync(destPath) && isIrregularPath(destPath);
    if (pendingIrregular || danglingDest) {
      notRegular.push(file);
      continue;
    }

    // A pending copy Codev wrote, the template or an older shipped version of it, leaves
    // nothing to merge once the doc is current (a symlinked one was skipped above).
    const removeSettledPending = (): void => {
      const pendingPath = destPath + '.codev-new';
      if (!fs.existsSync(pendingPath)) return;
      const settled = matchesTemplate(pendingPath, template)
        || (replaceShipped && shippedVersionName(fs.readFileSync(pendingPath, 'utf-8'), file, template, history) !== null);
      if (!settled) return;
      if (!dryRun) fs.rmSync(pendingPath);
      resolved.push(file + '.codev-new');
    };

    // Never replace through a symlink: only a regular file at the doc's own path.
    const shippedName = handleConflicts && replaceShipped && fs.existsSync(destPath) && !isIrregularPath(destPath)
      ? shippedVersionName(fs.readFileSync(destPath, 'utf-8'), file, template, history)
      : null;

    if (fs.existsSync(destPath)) {
      if (handleConflicts && matchesTemplate(destPath, template)) {
        // Up to date: the managed block is refreshed by syncHotContextBlock (#1982).
        removeSettledPending();
      } else if (shippedName !== null) {
        // An older release's template, never edited (#1985): written as init would write it
        // for the project name it carries; syncHotContextBlock then regenerates the block.
        const replacement = substituteProjectName(template, shippedName);
        if (!dryRun) fs.writeFileSync(destPath, replacement);
        replaced.push(file);
        written[file] = replacement;
        removeSettledPending();
      } else if (handleConflicts) {
        // Create .codev-new for merge
        if (!dryRun) fs.writeFileSync(destPath + '.codev-new', content);
        conflicts.push(file);
      }
      // Skip if exists and not handling conflicts
    } else {
      if (!dryRun) fs.writeFileSync(destPath, content);
      copied.push(file);
      written[file] = content;
    }
  }

  return { copied, replaced, written, conflicts, notRegular, resolved };
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

      // An empty folder (left when an earlier install's files were discarded) is filled.
      if (skipExisting && fs.existsSync(destSkillDir) && !isEmptySkillDir(destSkillDir)) {
        skipped.push(relativeSkillDir);
        continue;
      }

      copyDirRecursive(path.join(srcDir, entry.name), destSkillDir);
      copied.push(relativeSkillDir);
    }
  }

  return { copied, skipped, directoriesCreated };
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
