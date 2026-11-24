/**
 * `codev check worktree <builder-id|path>` (Spec 1951): would removing a builder's worktree
 * and its local branch lose data, and, separately, is the builder finished.
 *
 *   uncommitted  staged, unstaged and untracked-not-ignored files (`status`, without optional
 *                locks); spawn's scaffold files and links (`builder-scaffold.ts`) are counted
 *                apart and are not data
 *   commits      local commits on neither the live base tip nor the live remote branch tip,
 *                unless the PR is merged and the local tip is its merged head (squash or rebase)
 *   remote       the local tip against `origin/<branch>`: context only
 *   pr           the branch's PR: OPEN is attention ("builder not finished")
 *   ignored      ignored files matching `cleanup.keepIgnored` that are not dependency or build
 *                output: the definitions `afx cleanup --keep-ignored` uses (`keep-list.ts`).
 *                What spawn linked in (`isSpawnMade`) is scaffold. A symbolic link among the
 *                rest is listed apart: one to a keep-list file inside the worktree is judged as
 *                that file; any other is data cleanup cannot keep (it never copies a link), so
 *                it blocks removal
 *
 * The verdict word describes data only. The exit code also counts the lifecycle and anything
 * that could not run, so "removable" never silently means "finished". The target is
 * resolved against the main checkout, so the command reads the same from any worktree.
 */

import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isBuilderScaffold, spawnLinkTarget } from '../../agent-farm/lib/builder-scaffold.js';
import { isNeverKeep } from '../../agent-farm/lib/keep-list.js';
import {
  ancestry,
  ensureCommits,
  failureReason,
  gitVersion,
  liveTip,
  pathspecArgs,
  remoteDefaultBranch,
  type GitVersion,
  type Lookup,
} from './git-facts.js';
import { normalizeState, parsePrView } from './pr.js';
import { defaultLabel, renderHuman, short } from './render.js';
import {
  check,
  errorReport,
  exitCodeOf,
  fitList,
  needsAttention,
  notRun,
  skipped,
  verdictOf,
  CheckCommandError,
  type Check,
  type CommandOptions,
  type CommandResult,
  type Removable,
  type WorktreeReport,
} from './report.js';
import { listWorktrees, resolveRoots, type Roots } from './roots.js';
import { createRunner, type GitResult, type Runner } from './runner.js';
import { loadCheckSettings, loadKeepIgnored } from './settings.js';
import { hasControlChars, InputError, isFullSha, isRefName, validateBuilderId } from './validate.js';

/** Characters a file list may take on a check's line before it is cut to `… +N`. */
const LIST_WIDTH = 72;

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

// =============================================================================
// The target
// =============================================================================

interface Target {
  /** Real path. */
  path: string;
  builderId: string | null;
  branch: string;
  /** The worktree's HEAD, which is its branch's tip. */
  tip: string;
}

/** A real path for comparison (long names, on-disk case on Windows), or null when it does not exist. */
function realPath(p: string): string | null {
  try {
    const real = realpathSync.native(p);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

/** A builder id is a bare name; anything with a separator, or `.`/`..`, is a path. */
function isPathArgument(raw: string): boolean {
  return raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\') || isAbsolute(raw);
}

/** The argument, validated before any subprocess runs. */
type TargetArgument = { kind: 'id'; id: string } | { kind: 'path'; path: string };

export function parseTargetArgument(raw: string, cwd: string): TargetArgument {
  if (raw.trim() === '') throw new InputError('no builder id or worktree path given');
  if (!isPathArgument(raw)) return { kind: 'id', id: validateBuilderId(raw) };
  if (hasControlChars(raw)) throw new InputError(`invalid worktree path ${JSON.stringify(raw)}: contains a control character`);
  return { kind: 'path', path: resolve(cwd, raw) };
}

/**
 * Resolve a builder id (`<mainRoot>/.builders/<id>`) or a path to a registered worktree that
 * is not the main one. Anything else is exit 2.
 */
async function resolveTarget(runner: Runner, roots: Roots, argument: TargetArgument): Promise<Target> {
  let builderId: string | null = null;
  let wanted: string | null;
  if (argument.kind === 'path') {
    wanted = realPath(argument.path);
    if (wanted === null) throw new CheckCommandError(`worktree not found: ${argument.path} does not exist`);
  } else {
    builderId = argument.id;
    const dir = join(roots.mainRoot, '.builders', builderId);
    wanted = realPath(dir);
    if (wanted === null) throw new CheckCommandError(`builder ${builderId} not found: there is no worktree at ${dir}`);
  }

  const [main, ...others] = await listWorktrees(runner);
  if (wanted === realPath(main.path)) throw new CheckCommandError(`${main.path} is the main worktree, not a builder's`);
  const entry = others.find((e) => realPath(e.path) === wanted);
  if (!entry) throw new CheckCommandError(`${wanted} is not a registered worktree of ${roots.mainRoot} (git worktree list)`);
  if (entry.branch === null) throw new CheckCommandError(`${entry.path} has a detached HEAD; check worktree judges a builder's branch`);
  if (!isRefName(entry.branch)) throw new CheckCommandError(`${entry.path} is on branch ${JSON.stringify(entry.branch)}, which codev check cannot pass to git`);
  if (entry.head === null || !isFullSha(entry.head)) throw new CheckCommandError(`git worktree list gave no commit for ${entry.path}`);

  if (builderId === null && dirname(entry.path) === join(main.path, '.builders')) builderId = basename(entry.path);
  return { path: entry.path, builderId, branch: entry.branch, tip: entry.head };
}

// =============================================================================
// Parsers
// =============================================================================

export interface StatusEntry {
  path: string;
  /** `modified`, `added`, `deleted`, `renamed`, `copied`, `type changed`, `conflicted` or `untracked`. */
  change: string;
}

const CHANGE_WORDS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
};

function changeWord(xy: string): string {
  if (xy === '??') return 'untracked';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflicted';
  const letter = [...xy].find((c) => c !== ' ' && c !== '.');
  return (letter && CHANGE_WORDS[letter]) ?? 'changed';
}

/** Parse `status --porcelain=v1 -z`. A rename or copy carries its source as the next entry, which is dropped. */
export function parseStatus(output: string): StatusEntry[] {
  const tokens = splitNul(output);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4 || token[2] !== ' ') throw new CheckCommandError(`unexpected git status output ${JSON.stringify(token.slice(0, 80))}`);
    const xy = token.slice(0, 2);
    entries.push({ path: token.slice(3), change: changeWord(xy) });
    if (xy.includes('R') || xy.includes('C')) i++;
  }
  return entries;
}

/**
 * The PR to judge the branch by, from `pr-search`: only exact head-branch matches, OPEN first,
 * then the newest MERGED, then the newest CLOSED, then any whose state the search left blank.
 * Null when there is none.
 */
export function pickPr(data: unknown, branch: string): Lookup<number | null> {
  if (!Array.isArray(data)) return { ok: false, reason: 'pr-search returned something other than a JSON array' };
  const rank: Record<string, number> = { OPEN: 0, MERGED: 1, CLOSED: 2 };
  const candidates: Array<{ number: number; rank: number }> = [];
  for (const [index, raw] of data.entries()) {
    const where = `pr-search item ${index + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: `${where} is not an object` };
    const { number, headRefName, state } = raw as Record<string, unknown>;
    if (headRefName !== branch) continue;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return { ok: false, reason: `${where} has no valid number` };
    candidates.push({ number, rank: rank[typeof state === 'string' ? state.toUpperCase() : ''] ?? 3 });
  }
  candidates.sort((a, b) => a.rank - b.rank || b.number - a.number);
  return { ok: true, value: candidates[0]?.number ?? null };
}

// =============================================================================
// What the checks share
// =============================================================================

interface BranchPr {
  number: number;
  state: string;
  baseRef: string;
  /** The forge's head SHA for the PR: the merged head when it is merged. */
  head: string;
}

/** The PR found for the branch, none, or why its state is not available. */
type PrLookup = { kind: 'found'; pr: BranchPr } | { kind: 'none' } | { kind: 'unavailable'; reason: string; number?: number };

async function lookupPr(runner: Runner, branch: string): Promise<PrLookup> {
  const search = await runner.forge('pr-search', { CODEV_SEARCH_QUERY: `head:${branch}` });
  if (!search.ok) return { kind: 'unavailable', reason: search.reason };
  const picked = pickPr(search.data, branch);
  if (!picked.ok) return { kind: 'unavailable', reason: picked.reason };
  if (picked.value === null) return { kind: 'none' };
  const number = picked.value;
  const outcome = await runner.forge('pr-view', { CODEV_PR_NUMBER: String(number) });
  const view = outcome.ok ? parsePrView(outcome.data) : { ok: false as const, reason: outcome.reason };
  if (!view.ok) return { kind: 'unavailable', reason: view.reason, number };
  if (view.value.state === null || view.value.state === '') return { kind: 'unavailable', reason: 'pr-view did not return state', number };
  const state = normalizeState(view.value.state, view.value.mergedAt);
  return { kind: 'found', pr: { number, state, baseRef: view.value.baseRef, head: view.value.head } };
}

/** A tip read with `ls-remote` and made available locally, or why it is not. */
type Tip = Lookup<string | null>;

interface Facts {
  runner: Runner;
  /** The main checkout, where spawn's links point. */
  mainRoot: string;
  target: Target;
  pr: PrLookup | null;
  /** The base branch, or why there is none. */
  base: Lookup<string>;
  /** The live base tip; null when origin has no such branch. */
  baseTip: Tip;
  /** The live `origin/<branch>` tip; null when origin has no such branch. */
  remoteTip: Tip;
}

/** Each tip found is made available locally; one that cannot be is a failed lookup. */
async function available(runner: Runner, tips: Tip[], version: GitVersion): Promise<Tip[]> {
  const shas = tips.flatMap((t) => (t.ok && t.value !== null ? [t.value] : []));
  const problems = shas.length > 0 ? await ensureCommits(runner, shas, version) : new Map<string, string | null>();
  return tips.map((t) => {
    if (!t.ok || t.value === null) return t;
    const problem = problems.get(t.value);
    return problem ? { ok: false, reason: problem } : t;
  });
}

async function revList(runner: Runner, args: string[]): Promise<Lookup<string[]>> {
  const result = await runner.git(['rev-list', ...args]);
  if (result.exitCode !== 0) return { ok: false, reason: failureReason('rev-list', result, runner.timeoutLabel) };
  const shas = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const bad = shas.find((sha) => !isFullSha(sha));
  if (bad !== undefined) return { ok: false, reason: `unexpected git rev-list output: ${JSON.stringify(bad)} is not a commit SHA` };
  return { ok: true, value: shas };
}

/** A symbolic link: its target as written, where that points, and whether anything is there. */
interface Link {
  target: string;
  resolved: string;
  missing: boolean;
}

/** The link at a worktree-relative path, or null when the path is not a link. */
function linkAt(facts: Facts, rel: string): Lookup<Link | null> {
  const abs = join(facts.target.path, ...rel.split('/'));
  try {
    if (!lstatSync(abs).isSymbolicLink()) return { ok: true, value: null };
    const target = readlinkSync(abs);
    const resolved = resolve(dirname(abs), target);
    return { ok: true, value: { target, resolved, missing: realPath(resolved) === null } };
  } catch (err) {
    return { ok: false, reason: `could not read ${rel}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A path spelled for comparison: its real path, or, when it does not exist, its parent's. */
function comparable(p: string): string {
  const real = realPath(p);
  if (real !== null) return real;
  const parent = realPath(dirname(p));
  const spelled = parent === null ? resolve(p) : join(parent, basename(p));
  return process.platform === 'win32' ? spelled.toLowerCase() : spelled;
}

/** Whether a link is one spawn made: it points at the same path in the main checkout. */
function isSpawnLink(facts: Facts, rel: string, link: Link): boolean {
  return comparable(link.resolved) === comparable(spawnLinkTarget(facts.mainRoot, rel));
}

/**
 * Whether the entry at `rel` is one spawn made, so removing it loses nothing. Spawn links each
 * entry to the same path in the main checkout: a symbolic link where it may make one, else, on
 * native Windows, a hard link of that file, else a copy (`createWorktreeLink`). A copy counts
 * only while its bytes still equal the main checkout's file: one that has changed is data.
 */
function isSpawnMade(facts: Facts, rel: string, link: Link | null): Lookup<boolean> {
  if (link !== null) return { ok: true, value: isSpawnLink(facts, rel, link) };
  const source = spawnLinkTarget(facts.mainRoot, rel);
  const abs = join(facts.target.path, ...rel.split('/'));
  try {
    const main = statSync(source, { bigint: true, throwIfNoEntry: false });
    if (main === undefined || !main.isFile()) return { ok: true, value: false };
    const mine = statSync(abs, { bigint: true });
    if (!mine.isFile()) return { ok: true, value: false };
    if (mine.dev === main.dev && mine.ino === main.ino) return { ok: true, value: true };
    if (mine.size !== main.size) return { ok: true, value: false };
    return { ok: true, value: readFileSync(abs).equals(readFileSync(source)) };
  } catch (err) {
    return { ok: false, reason: `could not compare ${rel} with the main checkout's: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The worktree-relative path a link resolves to, or null when it resolves outside the worktree or to nothing. */
function insideTarget(facts: Facts, link: Link): string | null {
  const real = realPath(link.resolved);
  if (real === null) return null;
  const rel = relative(comparable(facts.target.path), real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Git in the inspected worktree, for the reads that are per worktree. */
function gitIn(facts: Facts, args: string[]): Promise<GitResult> {
  return facts.runner.git(['-C', facts.target.path, ...args]);
}

// =============================================================================
// The checks
// =============================================================================

async function checkUncommitted(facts: Facts): Promise<Check> {
  const result = await gitIn(facts, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (result.exitCode !== 0) return notRun('uncommitted', failureReason('status', result, facts.runner.timeoutLabel));
  const entries = parseStatus(result.stdout);
  const scaffold: string[] = [];
  const files: StatusEntry[] = [];
  for (const e of entries) {
    let isScaffold = false;
    if (e.change === 'untracked') {
      isScaffold = isBuilderScaffold(e.path);
      if (!isScaffold) {
        const link = linkAt(facts, e.path);
        if (!link.ok) return notRun('uncommitted', link.reason);
        const made = isSpawnMade(facts, e.path, link.value);
        if (!made.ok) return notRun('uncommitted', made.reason);
        isScaffold = made.value;
      }
    }
    if (isScaffold) scaffold.push(e.path);
    else files.push(e);
  }
  scaffold.sort();
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const note = scaffold.length > 0 ? `   [${plural(scaffold.length, 'scaffold file')} not counted]` : '';
  const details = { files, scaffold };
  if (files.length === 0) return check('uncommitted', 'ok', `nothing uncommitted${note}`, details);
  const list = fitList(files.map((f) => `${f.path} (${f.change})`), LIST_WIDTH);
  return check('uncommitted', 'attention', `${plural(files.length, 'file')}: ${list}${note}`, details);
}

/** Why the base cannot be judged against, or null when it can. */
function baseProblem(facts: Facts): string | null {
  if (!facts.base.ok) return facts.base.reason;
  if (!facts.baseTip.ok) return facts.baseTip.reason;
  return facts.baseTip.value === null ? `origin has no branch ${facts.base.value}` : null;
}

async function checkCommits(facts: Facts): Promise<Check> {
  const problem = baseProblem(facts);
  if (problem !== null) return notRun('commits', `base not read: ${problem}`);
  const base = facts.base.ok ? facts.base.value : '';
  const baseTip = facts.baseTip.ok ? (facts.baseTip.value as string) : '';
  const { tip, branch } = facts.target;

  const notOnBase = await revList(facts.runner, [tip, '--not', baseTip]);
  if (!notOnBase.ok) return notRun('commits', notOnBase.reason);
  const total = notOnBase.value.length;
  if (total === 0) return check('commits', 'ok', `every commit is on origin/${base}`, { total, notOnBase: [], unsafe: [] });

  const remote = facts.remoteTip;
  const merged = facts.pr?.kind === 'found' && facts.pr.pr.state === 'MERGED' ? facts.pr.pr : null;
  let unsafe = notOnBase.value;
  if (remote.ok && remote.value !== null) {
    const off = await revList(facts.runner, [tip, '--not', baseTip, remote.value]);
    if (!off.ok) return notRun('commits', off.reason);
    unsafe = off.value;
  }
  const details = { total, notOnBase: notOnBase.value, unsafe };
  const commits = plural(total, 'commit');
  if (unsafe.length > 0 && merged !== null && merged.head === tip) {
    return check('commits', 'ok', `${commits} not on origin/${base}; the local tip is PR #${merged.number}'s merged head (squash or rebase merge)`, {
      ...details,
      unsafe: [],
    });
  }
  if (unsafe.length === 0) return check('commits', 'ok', `${commits} not on origin/${base}, all on origin/${branch}`, details);
  // Without the remote branch's tip, whether these commits were pushed cannot be told.
  if (!remote.ok) {
    return notRun('commits', `${commits} not on origin/${base}, and origin/${branch} could not be read to check them: ${remote.reason}`, {
      total,
      notOnBase: notOnBase.value,
    });
  }
  const listed = fitList(unsafe.map(short), LIST_WIDTH);
  return check('commits', 'attention', `${plural(unsafe.length, 'commit')} on no remote branch: ${listed}`, details);
}

async function checkRemote(facts: Facts): Promise<Check> {
  const { branch, tip } = facts.target;
  const remote = facts.remoteTip;
  if (!remote.ok) return notRun('remote', remote.reason);
  if (remote.value === null) return check('remote', 'info', `origin has no branch ${branch}`, { remoteSha: null, relation: 'absent' });
  const remoteSha = remote.value;
  if (remoteSha === tip) return check('remote', 'ok', `origin/${branch} matches local (${short(tip)})`, { remoteSha, relation: 'matches' });
  const remoteInLocal = await ancestry(facts.runner, remoteSha, tip);
  if (!remoteInLocal.ok) return notRun('remote', remoteInLocal.reason, { remoteSha });
  const localInRemote = await ancestry(facts.runner, tip, remoteSha);
  if (!localInRemote.ok) return notRun('remote', localInRemote.reason, { remoteSha });
  const relation = remoteInLocal.value ? 'ahead' : localInRemote.value ? 'behind' : 'diverged';
  const words = {
    ahead: `local ${short(tip)} is ahead of origin/${branch} @ ${short(remoteSha)} (not pushed)`,
    behind: `local ${short(tip)} is behind origin/${branch} @ ${short(remoteSha)}`,
    diverged: `local ${short(tip)} and origin/${branch} @ ${short(remoteSha)} have diverged`,
  }[relation];
  return check('remote', 'info', words, { remoteSha, relation });
}

function checkPrState(lookup: PrLookup, branch: string): Check {
  if (lookup.kind === 'unavailable') {
    return notRun('pr', `PR state not available: ${lookup.reason}`, lookup.number === undefined ? {} : { number: lookup.number });
  }
  if (lookup.kind === 'none') return check('pr', 'attention', `no PR found for ${branch}`, {});
  const { number, state, head } = lookup.pr;
  if (state === 'MERGED') return check('pr', 'ok', `#${number} MERGED`, { number, state, mergedHead: head });
  if (state === 'CLOSED') return check('pr', 'ok', `#${number} CLOSED without merging`, { number, state });
  if (state === 'OPEN') return check('pr', 'attention', `#${number} OPEN: builder not finished`, { number, state });
  return check('pr', 'attention', `#${number} ${state}`, { number, state });
}

async function checkIgnored(facts: Facts, patterns: readonly string[]): Promise<Check> {
  const keep: string[] = [];
  const links: Array<{ path: string; target: string; missing: boolean }> = [];
  const scaffold: string[] = [];
  let matched: string[] = [];
  const pathspecs = pathspecArgs({ include: patterns });
  if (pathspecs !== null) {
    const result = await gitIn(facts, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...pathspecs]);
    if (result.exitCode !== 0) return notRun('ignored', failureReason('ls-files', result, facts.runner.timeoutLabel));
    matched = splitNul(result.stdout).filter((p) => !isNeverKeep(p));
    const linked: Array<[string, Link]> = [];
    for (const p of matched) {
      const link = linkAt(facts, p);
      if (!link.ok) return notRun('ignored', link.reason);
      const made = isSpawnMade(facts, p, link.value);
      if (!made.ok) return notRun('ignored', made.reason);
      if (made.value) scaffold.push(p);
      else if (link.value === null) keep.push(p);
      else linked.push([p, link.value]);
    }
    const key = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
    const kept = new Set(keep.map(key));
    for (const [p, link] of linked) {
      // A link to a keep-list file inside the worktree is judged as that file, which is kept.
      const inside = insideTarget(facts, link);
      if (inside !== null && kept.has(key(inside))) continue;
      links.push({ path: p, target: link.target, missing: link.missing });
    }
    keep.sort();
    links.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    scaffold.sort();
  }
  const all = await gitIn(facts, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  if (all.exitCode !== 0) return notRun('ignored', failureReason('ls-files', all, facts.runner.timeoutLabel));
  // Every other ignored path, directories collapsed, is treated as regenerable.
  const holdsMatch = (entry: string): boolean => matched.some((k) => k === entry || (entry.endsWith('/') && k.startsWith(entry)));
  const others = splitNul(all.stdout).filter((entry) => !holdsMatch(entry)).sort();
  const details = { keep, regenerable: others.length, links, scaffold };
  const examples = others.length > 0 ? `: ${fitList(others, 40)}` : '';
  const note = scaffold.length > 0 ? `   [${plural(scaffold.length, 'scaffold link')} not counted]` : '';

  if (keep.length === 0 && links.length === 0) {
    const none = patterns.length === 0 ? 'no keep list (cleanup.keepIgnored is empty)' : 'no keep-list files';
    const rest = others.length === 0 ? 'no other ignored files' : `${plural(others.length, 'ignored path')} treated as regenerable${examples}`;
    return check('ignored', 'ok', `${none}; ${rest}${note}`, details);
  }
  const lines: string[] = [];
  if (keep.length > 0) lines.push(`${plural(keep.length, 'keep-list file')} would be lost: ${fitList(keep, LIST_WIDTH)}`);
  // A link is data too, but `afx cleanup --keep-ignored` skips every link, so only copying it
  // out by hand keeps it. Each is printed with its target, so the reader can judge what is at stake.
  if (links.length > 0) {
    const each = links.map((l) => `${l.path} -> ${l.target}${l.missing ? ' (target missing)' : ''}`);
    if (each.length === 1) lines.push(`1 keep-list symlink would be lost: ${each[0]}`);
    else lines.push(`${plural(links.length, 'keep-list symlink')} would be lost:`, ...each.map((e) => `  ${e}`));
  }
  lines[0] += note;
  if (others.length > 0) lines.push(`(${plural(others.length, 'other ignored path')} treated as regenerable${examples})`);
  lines.push(
    links.length === 0
      ? '→ copy them out first, or use `afx cleanup --keep-ignored`'
      : keep.length === 0
        ? '→ copy them out first (`afx cleanup --keep-ignored` never copies a link)'
        : '→ copy the symlinks out first (`afx cleanup --keep-ignored` keeps the files, never a link)',
  );
  return check('ignored', 'attention', lines.join('\n'), details);
}

// =============================================================================
// The verdict
// =============================================================================

/**
 * Data only. A data check that could not run makes the verdict conservative: NOT REMOVABLE,
 * except `commits` when the local tip is on the live remote branch, which keeps every commit.
 * Keep-list symlinks are data `afx cleanup --keep-ignored` cannot keep, so they block removal.
 */
export function removability(checks: readonly Check[], localOnRemote: boolean): Removable {
  const status = (id: string): Check['status'] | undefined => checks.find((c) => c.id === id)?.status;
  const uncommitted = status('uncommitted');
  const commits = status('commits');
  const links = linkCount(checks.find((c) => c.id === 'ignored'));
  if (uncommitted === 'attention' || uncommitted === 'not-run' || status('ignored') === 'not-run' || links > 0) return 'not-removable';
  if (commits === 'attention' || (commits === 'not-run' && !localOnRemote)) return 'not-removable';
  return status('ignored') === 'attention' ? 'removable-after-keeping' : 'removable';
}

function linkCount(ignored: Check | undefined): number {
  return Array.isArray(ignored?.details.links) ? ignored.details.links.length : 0;
}

/** Whether the local tip is reachable from the live remote branch tip. */
async function onRemote(facts: Facts): Promise<boolean> {
  const remote = facts.remoteTip;
  if (!remote.ok || remote.value === null) return false;
  const answer = await ancestry(facts.runner, facts.target.tip, remote.value);
  return answer.ok && answer.value;
}

// =============================================================================
// The command
// =============================================================================

async function buildWorktreeReport(argument: TargetArgument, options: CommandOptions): Promise<WorktreeReport> {
  const runnerOptions = { timeoutMs: options.timeoutMs, env: options.env, spawn: options.spawn };
  const roots = await resolveRoots(createRunner({ cwd: options.cwd, workspaceRoot: options.cwd, ...runnerOptions }));
  const runner = createRunner({ cwd: roots.mainRoot, workspaceRoot: roots.mainRoot, ...runnerOptions });
  const settings = loadCheckSettings(roots.mainRoot);
  const target = await resolveTarget(runner, roots, argument);
  const skip = (id: string): boolean => settings.skip.has(id);
  // A skipped check reads nothing of its own, its configuration included.
  const patterns = skip('ignored') ? [] : loadKeepIgnored(roots.mainRoot);

  // The PR decides the base; without one (or with `pr` skipped), origin's default branch does.
  const pr = skip('pr') ? null : await lookupPr(runner, target.branch);
  let base: Lookup<string>;
  if (pr?.kind === 'found') {
    base = { ok: true, value: pr.pr.baseRef };
  } else {
    const fallback = await remoteDefaultBranch(runner);
    if (!fallback.ok) base = fallback;
    else if (fallback.value === null) base = { ok: false, reason: 'no PR names a base, and origin does not name a default branch' };
    else base = { ok: true, value: fallback.value };
  }

  const needBase = !skip('commits');
  const needRemote = !skip('commits') || !skip('remote');
  const version = await gitVersion(runner);
  const [baseTip, remoteTip] = await available(
    runner,
    [
      needBase && base.ok ? await liveTip(runner, base.value) : { ok: true, value: null },
      needRemote ? await liveTip(runner, target.branch) : { ok: true, value: null },
    ],
    version,
  );
  const facts: Facts = { runner, mainRoot: roots.mainRoot, target, pr, base, baseTip, remoteTip };

  const run = async (id: string, fn: () => Check | Promise<Check>): Promise<Check> => (skip(id) ? skipped(id) : fn());
  const checks = [
    await run('uncommitted', () => checkUncommitted(facts)),
    await run('commits', () => checkCommits(facts)),
    await run('remote', () => checkRemote(facts)),
    pr === null ? skipped('pr') : checkPrState(pr, target.branch),
    await run('ignored', () => checkIgnored(facts, patterns)),
  ];
  const commitsNotRun = checks.some((c) => c.id === 'commits' && c.status === 'not-run');
  const removable = removability(checks, commitsNotRun ? await onRemote(facts) : false);

  return {
    schema: 1,
    command: 'worktree',
    verdict: verdictOf(checks),
    generatedAt: new Date().toISOString(),
    removable,
    worktree: {
      path: target.path,
      builderId: target.builderId,
      branch: target.branch,
      baseRef: base.ok ? base.value : null,
      baseTip: needBase && baseTip.ok ? baseTip.value : null,
    },
    checks,
  };
}

/** `codev check worktree <builder-id|path>`. Never throws: a failure that prevents a report is exit 2 with an `ErrorReport`. */
export async function checkWorktree(raw: string, options: CommandOptions): Promise<CommandResult<WorktreeReport>> {
  try {
    const report = await buildWorktreeReport(parseTargetArgument(raw, options.cwd), options);
    return { report, exitCode: exitCodeOf(report.verdict) };
  } catch (err) {
    return { report: errorReport('worktree', err), exitCode: 2 };
  }
}

// =============================================================================
// Human form
// =============================================================================

const VERDICT_WORDS: Record<Removable, (keep: number) => string> = {
  removable: () => 'REMOVABLE',
  'removable-after-keeping': (keep) => `REMOVABLE AFTER KEEPING ${plural(keep, 'file').toUpperCase()}`,
  'not-removable': () => 'NOT REMOVABLE',
};

/**
 * What a check needing attention means, in a few words for the verdict line. Keep-list files
 * are left out: the verdict word, or the data that blocks removal anyway, already says it.
 * Keep-list symlinks are named, as they alone can make the verdict NOT REMOVABLE.
 */
function reasonWords(c: Check): string | null {
  if (c.status === 'not-run') return `${defaultLabel(c.id)} not run`;
  const d = c.details;
  switch (c.id) {
    case 'uncommitted':
      return `${plural((d.files as unknown[]).length, 'uncommitted file')}`;
    case 'commits':
      return `${plural((d.unsafe as unknown[]).length, 'unpushed commit')}`;
    case 'ignored': {
      const links = linkCount(c);
      return links > 0 ? plural(links, 'keep-list symlink') : null;
    }
    case 'pr':
      if (d.number === undefined) return 'no PR found';
      return d.state === 'OPEN' ? `PR #${String(d.number)} open: builder not finished` : `PR #${String(d.number)} ${String(d.state)}`;
    default:
      return defaultLabel(c.id);
  }
}

export function renderWorktreeHuman(report: WorktreeReport): string {
  const { worktree } = report;
  // A builder's worktree reads by its place under the main checkout; any other by its path.
  const where = worktree.builderId === null ? worktree.path : `.builders/${worktree.builderId}`;
  const name = worktree.builderId ?? worktree.path;
  const keep = report.checks.find((c) => c.id === 'ignored');
  const keepCount = Array.isArray(keep?.details.keep) ? keep.details.keep.length : 0;
  const reasons = report.checks
    .filter(needsAttention)
    .map(reasonWords)
    .filter((r): r is string => r !== null);
  const verdictLine = `${VERDICT_WORDS[report.removable](keepCount)}  ${name}${reasons.length > 0 ? ` — ${reasons.join(', ')}` : ''}`;
  // With `commits` skipped the base tip is never read, so there is nothing to say about it.
  const tipSkipped = report.checks.some((c) => c.id === 'commits' && c.status === 'skip');
  const base =
    worktree.baseRef === null
      ? 'base not read'
      : worktree.baseTip !== null
        ? `base ${worktree.baseRef} @ ${short(worktree.baseTip)} (origin, live)`
        : tipSkipped
          ? `base ${worktree.baseRef}`
          : `base ${worktree.baseRef} (live tip not read)`;
  return renderHuman({
    verdictLine,
    header: [`worktree  ${where}   branch ${worktree.branch}   ${base}`],
    sections: [{ checks: report.checks }],
  });
}
