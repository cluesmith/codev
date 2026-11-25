/**
 * `afx cleanup --keep-ignored` (#1950): copy a worktree's evidence out before it is removed.
 *
 * Kept: every untracked file that is not ignored, and the ignored files matching the keep list
 * (`cleanup.keepIgnored` in `.codev/config.json`). Never kept: dependency and build output,
 * whatever the list says (both defined in `keep-list.ts`, which `codev check worktree` shares),
 * and symlinks (a worktree's links point back into the workspace, and
 * following one could copy a secret such as `.env`). Every copy is checked by SHA-256; any
 * failure removes the partial kept folder and throws, so the caller stops before removing
 * anything.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isNeverKeep } from './keep-list.js';

export { DEFAULT_KEEP_IGNORED, keepPatterns } from './keep-list.js';

export function keptDirFor(agentFarmDir: string, workspaceRoot: string, builderId: string): string {
  return join(agentFarmDir, 'kept', basename(workspaceRoot), builderId);
}

function gitList(worktree: string, args: string[]): string[] {
  const out = execFileSync('git', ['-C', worktree, 'ls-files', '--others', '-z', ...args], {
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  return out.split('\0').filter(Boolean);
}

/**
 * A directory entry (`dir/`, e.g. a nested repository) expands to the files under it. Walked by
 * hand on purpose: `readdirSync({ recursive: true })` also returns directories and joins names
 * with `path.sep`, while this keeps regular files only and builds `/`-separated paths.
 */
function expand(worktree: string, rel: string): string[] {
  if (!rel.endsWith('/')) return [rel];
  return readdirSync(join(worktree, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel + entry.name;
    if (entry.isDirectory()) return expand(worktree, `${child}/`);
    return entry.isFile() ? [child] : [];
  });
}

export interface KeepCandidates {
  /** Worktree-relative paths (`/`-separated), sorted; symlinks included for `keepFiles` to skip. */
  files: string[];
  /** How many matched but are dependency or build output, and so are never kept. */
  excluded: number;
}

export function listKeepCandidates(worktree: string, patterns: readonly string[]): KeepCandidates {
  const untracked = gitList(worktree, ['--exclude-standard']);
  const ignored = patterns.length
    ? gitList(worktree, ['--ignored', '--exclude-standard', '--', ...patterns.map((p) => `:(glob)${p}`)])
    : [];
  const all = [...new Set([...untracked, ...ignored])].flatMap((rel) => expand(worktree, rel));
  const files = all.filter((rel) => !isNeverKeep(rel)).sort();
  return { files, excluded: all.length - files.length };
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export interface KeepResult {
  copied: number;
  skippedSymlinks: string[];
}

export interface KeepDeps {
  copy(src: string, dst: string): Promise<void>;
}

/**
 * Copy `files` from `worktree` into a NEW `keptDir`, verifying each by checksum. Refuses if
 * `keptDir` exists. On any failure the partial `keptDir` is removed and the error rethrown.
 */
export async function keepFiles(
  worktree: string,
  keptDir: string,
  files: readonly string[],
  deps: KeepDeps = { copy: (src, dst) => copyFile(src, dst) },
): Promise<KeepResult> {
  if (existsSync(keptDir)) throw new Error(`kept folder already exists: ${keptDir}`);
  mkdirSync(dirname(keptDir), { recursive: true });
  mkdirSync(keptDir); // not recursive: a folder that appeared since the check fails here, atomically
  const result: KeepResult = { copied: 0, skippedSymlinks: [] };
  try {
    for (const rel of files) {
      const src = join(worktree, rel);
      if (lstatSync(src).isSymbolicLink()) {
        result.skippedSymlinks.push(rel);
        continue;
      }
      const dst = join(keptDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      await deps.copy(src, dst);
      const [expected, actual] = await Promise.all([sha256(src), sha256(dst)]);
      if (expected !== actual) {
        throw new Error(`checksum mismatch after copying ${rel} (source ${expected.slice(0, 12)}, copy ${actual.slice(0, 12)})`);
      }
      result.copied++;
    }
  } catch (err) {
    rmSync(keptDir, { recursive: true, force: true });
    throw err;
  }
  return result;
}
