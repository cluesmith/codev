/**
 * Refresh shipped provider skills on `codev update` (issue #1811).
 *
 * A skill directory is unedited when its content matches a version Codev has shipped
 * (SHIPPED_SKILL_HASHES, generated from git history). Unedited skills are replaced with
 * the package's version; an edited one gets a `.codev-new` copy of each differing file
 * for update's merge session, the same treatment CLAUDE.md and AGENTS.md get.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SHIPPED_SKILL_HASHES } from './shipped-skill-hashes.js';
import { SKILL_PROVIDERS } from './scaffold.js';

export type SkillProvider = (typeof SKILL_PROVIDERS)[number];

/** Suffix of the new version written beside an edited skill file. */
export const CODEV_NEW_SUFFIX = '.codev-new';

export interface SkillFile {
  /** Path relative to the skill directory, with `/` separators. */
  path: string;
  content: string;
  /** A symlink, recorded by its target and never followed. */
  link?: boolean;
}

/**
 * Files that never count as skill content: a pending `.codev-new` copy, and Finder's
 * `.DS_Store`, which would otherwise mark every skill a macOS user opened as edited.
 */
function isIgnoredSkillFile(name: string): boolean {
  return name.endsWith(CODEV_NEW_SUFFIX) || name === '.DS_Store';
}

/**
 * The content hash of one skill directory: its files in path order, each as path and
 * content, with line endings normalised so a CRLF checkout of a shipped skill still matches.
 */
export function hashSkillFiles(files: SkillFile[]): string {
  const hash = crypto.createHash('sha256');
  const sorted = [...files].sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  for (const file of sorted) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.content.replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * The files of a skill directory, or null when the path is not a real directory (missing,
 * a symlink, or a file). Symlinked entries inside it are read as content, never followed.
 */
export function readSkillFiles(dir: string): SkillFile[] | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const files: SkillFile[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (isIgnoredSkillFile(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = prefix + entry.name;
      if (entry.isDirectory()) {
        walk(full, `${rel}/`);
      } else if (entry.isSymbolicLink()) {
        files.push({ path: rel, content: `<link:${fs.readlinkSync(full)}>`, link: true });
      } else if (entry.isFile()) {
        files.push({ path: rel, content: fs.readFileSync(full, 'utf-8') });
      }
    }
  };
  walk(dir, '');
  return files;
}

/**
 * Whether a skill directory holds a pending `.codev-new` that is not a regular file. A
 * symlinked pending path would carry the next `.codev-new` write outside the project.
 */
function hasIrregularPending(dir: string): boolean {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith(CODEV_NEW_SUFFIX) && !entry.isFile()) return true;
    if (entry.isDirectory() && hasIrregularPending(full)) return true;
  }
  return false;
}

export function hashSkillDir(dir: string): string | null {
  const files = readSkillFiles(dir);
  if (files === null) return null;
  return hashSkillFiles(files);
}

/** Project-relative directory of one provider's copy of a skill, e.g. `.claude/skills/afx`. */
export function skillRelDir(provider: SkillProvider, name: string): string {
  return `.${provider}/skills/${name}`;
}

export type SkillState =
  /** No copy in the project. */
  | 'missing'
  /** Identical to the package's version. */
  | 'current'
  /** An earlier shipped version, never edited. */
  | 'shipped'
  /** Differs from every shipped version: the user's own content. */
  | 'edited'
  /**
   * A symlink or a file where the skill directory should be, or a directory holding a
   * symlink. Left alone: a write could land outside the project.
   */
  | 'not-regular';

/**
 * Where a project's copy of a skill stands against the package's version. `key` is the
 * skill's project-relative directory (`skillRelDir`), which keys the shipped history.
 */
export function classifySkill(
  projectSkillDir: string,
  packageSkillDir: string,
  key: string,
  history: Record<string, readonly string[]> = SHIPPED_SKILL_HASHES,
): SkillState {
  if (!fs.existsSync(projectSkillDir) && !isSymlink(projectSkillDir)) return 'missing';
  const files = readSkillFiles(projectSkillDir);
  if (files === null || files.some(file => file.link) || hasIrregularPending(projectSkillDir)) return 'not-regular';
  const projectHash = hashSkillFiles(files);
  if (projectHash === hashSkillDir(packageSkillDir)) return 'current';
  if ((history[key] ?? []).includes(projectHash)) return 'shipped';
  return 'edited';
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface RefreshSkillsResult {
  /** Skill directories added because the project had none (`.claude/skills/afx/`). */
  added: string[];
  /**
   * Skill directories brought to the package's version: unedited ones replaced, and under
   * `force` edited ones overwritten file by file (files the package does not ship are kept).
   */
  updated: string[];
  /** Edited skill files that got a `.codev-new` copy of the package's version. */
  conflicts: string[];
  /** Skill paths left alone: symlinked, holding a symlink, or not a directory. */
  notRegular: string[];
}

export interface RefreshSkillsOptions {
  /**
   * Overwrite an edited skill's packaged files too, as `codev update --force` does for
   * CLAUDE.md. Files the package does not ship stay in place.
   */
  force?: boolean;
  /** Classify and report exactly as a real run would, writing nothing. */
  dryRun?: boolean;
  /** Shipped versions per skill; tests substitute their own. */
  history?: Record<string, readonly string[]>;
}

function replaceSkillDir(projectSkillDir: string, packageSkillDir: string): void {
  // Remove only the files the skill is made of; a .DS_Store is the user's.
  for (const file of readSkillFiles(projectSkillDir) ?? []) {
    fs.rmSync(path.join(projectSkillDir, file.path), { force: true });
  }
  fs.cpSync(packageSkillDir, projectSkillDir, { recursive: true, force: true });
}

/** Write the package's files over the project's copy, leaving any other file in place. */
function overwritePackagedFiles(projectSkillDir: string, packageSkillDir: string): void {
  fs.cpSync(packageSkillDir, projectSkillDir, { recursive: true, force: true });
}

/**
 * Delete a pending `.codev-new` that holds exactly the package's version of its file: the
 * skill now has that version, so the copy is resolved. A copy with other content is kept.
 */
function removeResolvedCodevNew(projectSkillDir: string, file: SkillFile): void {
  const pending = path.join(projectSkillDir, file.path + CODEV_NEW_SUFFIX);
  try {
    if (fs.lstatSync(pending).isFile() && fs.readFileSync(pending, 'utf-8') === file.content) fs.rmSync(pending);
  } catch {
    // No pending copy.
  }
}

function removeAllResolvedCodevNew(projectSkillDir: string, packageSkillDir: string): void {
  for (const file of readSkillFiles(packageSkillDir) ?? []) removeResolvedCodevNew(projectSkillDir, file);
}

/** True when something other than a real directory sits at `p` (a symlink, a file). */
function existsButNotDirectory(p: string): boolean {
  try {
    const stat = fs.lstatSync(p);
    return !stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Bring every shipped skill up to date: add missing ones, replace unedited ones, and write
 * `<file>.codev-new` beside each file of an edited skill that differs from the package. A
 * file the package adds to an edited skill arrives as `.codev-new` too: whether it belongs
 * in the user's version of the skill is the merge's call. With `dryRun`, the same result
 * is reported and nothing is written.
 */
export function refreshSkills(
  targetDir: string,
  skeletonDir: string,
  options: RefreshSkillsOptions = {},
): RefreshSkillsResult {
  const result: RefreshSkillsResult = { added: [], updated: [], conflicts: [], notRegular: [] };
  const write = !options.dryRun;

  for (const provider of SKILL_PROVIDERS) {
    const relativeSkillsDir = `.${provider}/skills`;
    const skillsDir = path.join(targetDir, relativeSkillsDir);
    const srcDir = path.join(skeletonDir, relativeSkillsDir);

    // A symlinked `.claude` / `.codex` or skills root may be shared beyond this project;
    // nothing is written through either.
    const linkedRoot = [`.${provider}`, relativeSkillsDir].find(rel => existsButNotDirectory(path.join(targetDir, rel)));
    if (linkedRoot) {
      result.notRegular.push(`${linkedRoot}/`);
      continue;
    }
    if (write && !fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

    // Older/corrupt skeletons may not provide every configured provider.
    if (!fs.existsSync(srcDir)) continue;

    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const key = skillRelDir(provider, entry.name);
      const packageSkillDir = path.join(srcDir, entry.name);
      const projectSkillDir = path.join(skillsDir, entry.name);
      const state = classifySkill(projectSkillDir, packageSkillDir, key, options.history);

      if (state === 'missing') {
        if (write) fs.cpSync(packageSkillDir, projectSkillDir, { recursive: true });
        result.added.push(`${key}/`);
      } else if (state === 'current') {
        if (write) removeAllResolvedCodevNew(projectSkillDir, packageSkillDir);
      } else if (state === 'shipped') {
        // Every file matched a shipped version, so none of them is the user's to keep.
        if (write) {
          replaceSkillDir(projectSkillDir, packageSkillDir);
          removeAllResolvedCodevNew(projectSkillDir, packageSkillDir);
        }
        result.updated.push(`${key}/`);
      } else if (state === 'not-regular') {
        result.notRegular.push(`${key}/`);
      } else if (state === 'edited' && options.force) {
        if (write) {
          overwritePackagedFiles(projectSkillDir, packageSkillDir);
          removeAllResolvedCodevNew(projectSkillDir, packageSkillDir);
        }
        result.updated.push(`${key}/`);
      } else if (state === 'edited') {
        const projectFiles = new Map((readSkillFiles(projectSkillDir) ?? []).map(file => [file.path, file.content]));
        for (const file of readSkillFiles(packageSkillDir) ?? []) {
          if (projectFiles.get(file.path) === file.content) {
            if (write) removeResolvedCodevNew(projectSkillDir, file);
            continue;
          }
          if (write) {
            const target = path.join(projectSkillDir, file.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            // `wx` after removing a regular pending copy: never follow a path swapped in since.
            fs.rmSync(target + CODEV_NEW_SUFFIX, { force: true });
            fs.writeFileSync(target + CODEV_NEW_SUFFIX, file.content, { flag: 'wx' });
          }
          result.conflicts.push(`${key}/${file.path}`);
        }
      }
    }
  }

  return result;
}
