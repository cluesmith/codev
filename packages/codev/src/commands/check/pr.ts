/**
 * `codev check pr <N>` (Spec 1951): what an architect reads before recommending a merge.
 *
 * The run anchors on the head SHA the forge reports (`pr-view`) and on the base tip
 * `ls-remote` reports. The local `origin/<base>` is never used. Missing objects are fetched
 * ref-neutrally. Every check below is computed on those exact commits, with the diff range
 * merge-base → head (what the forge's diff view shows):
 *
 *   head          the local branch against the forge head (local ahead = not pushed)
 *   state         an open PR that is not a draft
 *   forge         the forge's own mergeability (`MERGEABLE` is ok)
 *   attribution   configured patterns, per line, in the description and each commit not on base
 *   trial-merge   `merge-tree --write-tree` in the object store: no ref, index or file moves
 *   checks        CI on the code, past porch-only commits at the head (porch-only.ts)
 *   watched       files matching `check.watch`; those also matching `check.flag` need attention
 *   linked-issue  a closing keyword for the branch's issue (linked-issue.ts)
 *   overlap       files the base has also changed since the branch point
 *   size          lines and files changed
 *   to-read       the changed files minus `check.notForReading`, largest first
 *
 * When the checks finish, `pr-view` and `ls-remote` are read again. If the head or the base
 * moved, the check anchored on it (`head`, `trial-merge`) needs attention, so a CLEAR always
 * describes the tips that were live at the end of the run. A mergeability the forge had not
 * computed at the first read takes the second read's value.
 */

import { findConfigSource } from '../../lib/config.js';
import {
  atLeast,
  changedFiles,
  ensureCommits,
  failureReason,
  gitVersion,
  hasCommit,
  isAncestor,
  liveTip,
  mergeBase,
  numstat,
  resolveCommit,
  TRIAL_MERGE_MIN,
  versionLabel,
  type FileStat,
  type GitVersion,
  type Lookup,
} from './git-facts.js';
import { checkLinkedIssue } from './linked-issue.js';
import { checkChecks, checksProblem } from './porch-only.js';
import { attentionNames, renderHuman, short, type RenderOptions } from './render.js';
import {
  applySkips,
  check,
  CheckCommandError,
  errorReport,
  exitCodeOf,
  fitList,
  notRun,
  off,
  PR_CHECK_IDS,
  skipped,
  verdictOf,
  type Check,
  type CommandOptions,
  type CommandResult,
  type CommitRuns,
  type PrReport,
} from './report.js';
import { resolveRoots } from './roots.js';
import { createRunner, type Runner } from './runner.js';
import { loadCheckSettings, type AttributionPattern, type CheckSettings } from './settings.js';
import { isFullSha, isRefName, validatePrNumber } from './validate.js';

/** The `pr-view` fields this command reads, validated. */
interface PrView {
  title: string | null;
  body: string | null;
  state: string | null;
  url: string | null;
  draft: boolean | null;
  headRef: string;
  baseRef: string;
  head: string;
  /** The optional fields below are null when `pr-view` did not return them as strings. */
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  mergedAt: string | null;
}

/** Validate a `pr-view` result. A failure reason names the field. */
export function parsePrView(data: unknown): Lookup<PrView> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'pr-view returned something other than a JSON object' };
  }
  const raw = data as Record<string, unknown>;
  if (raw.headRefOid === undefined || raw.headRefOid === null || raw.headRefOid === '') {
    return { ok: false, reason: 'pr-view did not return headRefOid' };
  }
  if (typeof raw.headRefOid !== 'string' || !isFullSha(raw.headRefOid)) {
    return { ok: false, reason: `pr-view returned headRefOid ${JSON.stringify(raw.headRefOid)}, not a full commit SHA` };
  }
  for (const field of ['headRefName', 'baseRefName'] as const) {
    const value = raw[field];
    if (value === undefined || value === null || value === '') return { ok: false, reason: `pr-view did not return ${field}` };
    if (typeof value !== 'string' || !isRefName(value)) {
      return { ok: false, reason: `pr-view returned ${field} ${JSON.stringify(value)}, not a valid branch name` };
    }
  }
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    ok: true,
    value: {
      title: text(raw.title),
      body: text(raw.body),
      state: text(raw.state),
      url: text(raw.url),
      draft: typeof raw.isDraft === 'boolean' ? raw.isDraft : null,
      headRef: raw.headRefName as string,
      baseRef: raw.baseRefName as string,
      head: raw.headRefOid,
      mergeable: text(raw.mergeable),
      mergeStateStatus: text(raw.mergeStateStatus),
      reviewDecision: text(raw.reviewDecision),
      mergedAt: text(raw.mergedAt),
    },
  };
}

async function readPrView(runner: Runner, number: number): Promise<Lookup<PrView>> {
  const outcome = await runner.forge('pr-view', { CODEV_PR_NUMBER: String(number) });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  return parsePrView(outcome.data);
}

/** `provider github`, or `provider github, override in <file>` when a project overrides the concept. */
function forgeSource(runner: Runner, mainRoot: string): string {
  const override = findConfigSource(mainRoot, ['forge', 'pr-view']);
  return override ? `provider ${runner.provider()}, override in ${override}` : `provider ${runner.provider()}`;
}

/** Characters a file list may take on a check's line before it is cut to `… +N`. */
const LIST_WIDTH = 72;

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** At most `max` characters of a line, for the human summary. */
function clip(text: string, max = 30): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

async function countRange(runner: Runner, from: string, to: string): Promise<number> {
  const result = await runner.git(['rev-list', '--count', `${from}..${to}`]);
  const count = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !Number.isInteger(count)) {
    throw new CheckCommandError(`git rev-list --count ${from}..${to} failed`, result.stderr.trim());
  }
  return count;
}

// =============================================================================
// The checks
// =============================================================================

/** The commits the base-dependent and head-dependent checks need, or why they are missing. */
interface Anchors {
  head: string;
  headProblem: string | null;
  baseTip: string | null;
  baseProblem: string | null;
  mergeBase: string | null;
  rangeProblem: string | null;
}

async function checkHead(runner: Runner, pr: PrView, local: string | null, anchors: Anchors): Promise<Check> {
  const name = pr.headRef;
  if (local === null) return check('head', 'ok', `no local branch ${name}`, { forgeHead: pr.head, relation: 'absent' });
  const details: Record<string, unknown> = { forgeHead: pr.head, localBranchSha: local };
  if (local === pr.head) return check('head', 'ok', `local ${name} matches`, { ...details, relation: 'matches', aheadOfPr: 0 });
  // The local branch is compared only when origin's branch of that name is the PR head. A
  // fork's PR names a branch in another repository, often `main`; a local branch of the same
  // name is unrelated to it and must not be reported as unpushed work.
  const onOrigin = await liveTip(runner, name);
  if (!onOrigin.ok) return notRun('head', onOrigin.reason, details);
  const originTip = onOrigin.value;
  if (originTip !== pr.head) {
    // origin's branch past the forge head is a push the forge has not indexed yet, so every
    // forge answer describes an older head. Decided only when the origin tip is local.
    if (originTip !== null && !anchors.headProblem && (await hasCommit(runner, originTip)) && (await isAncestor(runner, pr.head, originTip))) {
      const past = await countRange(runner, pr.head, originTip);
      return check(
        'head',
        'attention',
        `origin's ${name} is ${plural(past, 'commit')} past the PR head (a push the forge has not indexed yet); re-run`,
        { ...details, relation: 'origin-ahead', originBranchSha: originTip, originAheadOfPr: past },
      );
    }
    const where =
      originTip === null
        ? `origin has no branch ${name} (a fork's PR, or the branch was deleted)`
        : `origin's ${name} is at ${short(originTip)}, not the PR head (a fork's PR, or the branch moved)`;
    return check('head', 'info', `${where}: local ${name} not compared`, {
      ...details,
      relation: 'not-origin-branch',
      originBranchSha: originTip,
    });
  }
  if (anchors.headProblem) return notRun('head', anchors.headProblem, details);
  const ahead = await countRange(runner, pr.head, local);
  const behind = await countRange(runner, local, pr.head);
  const counted = { ...details, aheadOfPr: ahead, behindPr: behind };
  if (ahead > 0 && behind > 0) {
    return check('head', 'attention', `local ${name} has diverged from the PR head (${ahead} not pushed, ${behind} not local)`, {
      ...counted,
      relation: 'diverged',
    });
  }
  if (ahead > 0) {
    return check('head', 'attention', `local ${name} is ${plural(ahead, 'commit')} ahead of the PR head (not pushed)`, {
      ...counted,
      relation: 'ahead',
    });
  }
  return check('head', 'ok', `local ${name} is ${plural(behind, 'commit')} behind the PR head`, { ...counted, relation: 'behind' });
}

/** The forge's state word, normalized: upper-cased, `OPENED` → `OPEN`, and `MERGED` once merged. */
export function normalizeState(state: string, mergedAt: string | null): string {
  if (mergedAt) return 'MERGED';
  const upper = state.toUpperCase();
  return upper === 'OPENED' ? 'OPEN' : upper;
}

export function checkState(pr: PrView): Check {
  if (pr.state === null || pr.state === '') return notRun('state', 'pr-view did not return state');
  if (pr.draft === null) return notRun('state', 'pr-view did not return isDraft');
  const state = normalizeState(pr.state, pr.mergedAt);
  const details = { state, draft: pr.draft };
  if (state !== 'OPEN') return check('state', 'attention', `${state}: only an open PR can be recommended`, details);
  if (pr.draft) return check('state', 'attention', 'OPEN but a draft: it must be marked ready for review first', details);
  return check('state', 'ok', 'OPEN, ready for review', details);
}

const MERGEABILITY = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'];

/** Why a `BLOCKED` merge state is blocked, from the review decision. */
const BLOCKED_BY: Record<string, string> = {
  REVIEW_REQUIRED: 'review required',
  CHANGES_REQUESTED: 'changes requested',
};

function mergeWords(view: PrView): string {
  const state = view.mergeStateStatus;
  if (!state) return view.mergeable!;
  const why = state === 'BLOCKED' && view.reviewDecision ? BLOCKED_BY[view.reviewDecision] : undefined;
  return why ? `${view.mergeable}, BLOCKED (${why})` : `${view.mergeable}, ${state}`;
}

/**
 * The forge's own mergeability. The verdict follows `mergeable` alone; the merge state and
 * review decision are context. An `UNKNOWN` at the first read takes the re-read's value.
 */
export function checkForge(first: PrView, reread: PrView | null): Check {
  const view = first.mergeable === 'UNKNOWN' && reread?.mergeable ? reread : first;
  const mergeable = view.mergeable;
  if (mergeable === null) return notRun('forge', 'pr-view did not return mergeable');
  if (!MERGEABILITY.includes(mergeable)) {
    return notRun('forge', `pr-view returned mergeable ${JSON.stringify(mergeable)}, not ${MERGEABILITY.join(', ')}`);
  }
  const details = { mergeable, mergeStateStatus: view.mergeStateStatus, reviewDecision: view.reviewDecision };
  if (mergeable === 'MERGEABLE') return check('forge', 'ok', mergeWords(view), details);
  if (mergeable === 'CONFLICTING') return check('forge', 'attention', mergeWords(view), details);
  return check('forge', 'attention', 'forge has not computed mergeability yet; re-run shortly', details);
}

interface AttributionHit {
  where: 'description' | 'commit';
  sha?: string;
  line: number;
  text: string;
}

/** Lines (1-based) of `text` that match any pattern. Patterns carry no `g` flag, so `test` keeps no state. */
export function matchLines(text: string, patterns: readonly AttributionPattern[]): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (patterns.some((p) => p.regex.test(line))) hits.push({ line: index + 1, text: line });
  });
  return hits;
}

/** Parse `git log -z --format=%H%x00%B`: SHA and message, alternating, NUL-separated. */
export function parseLogMessages(output: string): Array<{ sha: string; message: string }> {
  const tokens = output.split('\0');
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
  if (tokens.length % 2 !== 0) throw new CheckCommandError('unexpected git log output (an odd number of fields)');
  const commits: Array<{ sha: string; message: string }> = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const sha = tokens[i].trim();
    if (!isFullSha(sha)) throw new CheckCommandError(`unexpected git log output: ${JSON.stringify(sha)} is not a commit SHA`);
    commits.push({ sha, message: tokens[i + 1] });
  }
  return commits;
}

async function checkAttribution(runner: Runner, pr: PrView, settings: CheckSettings, anchors: Anchors): Promise<Check> {
  if (settings.attribution.length === 0) return off('attribution', 'no patterns configured (check.attribution)');
  if (pr.body === null) return notRun('attribution', 'pr-view did not return body (the description)');
  const blocked = anchors.headProblem ?? anchors.baseProblem;
  if (blocked) return notRun('attribution', blocked);

  const log = await runner.git(['log', '--no-ext-diff', '--no-textconv', '-z', '--format=%H%x00%B', `${anchors.baseTip}..${anchors.head}`]);
  if (log.exitCode !== 0) return notRun('attribution', failureReason('git log', log, runner.timeoutLabel));
  const commits = parseLogMessages(log.stdout);

  const hits: AttributionHit[] = matchLines(pr.body, settings.attribution).map((h) => ({ where: 'description', ...h }));
  for (const commit of commits) {
    for (const h of matchLines(commit.message, settings.attribution)) hits.push({ where: 'commit', sha: commit.sha, ...h });
  }
  const details = { patterns: settings.attribution.map((p) => p.source), hits, commitsScanned: commits.length };
  if (hits.length === 0) {
    return check('attribution', 'ok', `none in the description or ${plural(commits.length, 'commit')}`, details);
  }
  const places = hits.map((h) => (h.where === 'description' ? `description line ${h.line}` : `commit ${short(h.sha!)} "${clip(h.text)}"`));
  return check('attribution', 'attention', `${plural(hits.length, 'line')}: ${fitList(places, LIST_WIDTH)}`, details);
}

/** Parse `merge-tree --write-tree --name-only --no-messages -z`: the tree, then conflicted files. */
export function parseMergeTree(output: string): { tree: string; files: string[] } {
  const [tree, ...rest] = output.split('\0');
  const treeOid = (tree ?? '').trim();
  if (!isFullSha(treeOid)) throw new CheckCommandError(`unexpected git merge-tree output ${JSON.stringify(output.slice(0, 80))}`);
  return { tree: treeOid, files: rest.filter((f) => f !== '') };
}

async function checkTrialMerge(runner: Runner, pr: PrView, version: GitVersion, anchors: Anchors): Promise<Check> {
  if (!atLeast(version, TRIAL_MERGE_MIN)) {
    return notRun('trial-merge', `requires git ${TRIAL_MERGE_MIN.major}.${TRIAL_MERGE_MIN.minor}+ (found ${versionLabel(version)})`);
  }
  const blocked = anchors.headProblem ?? anchors.baseProblem;
  if (blocked) return notRun('trial-merge', blocked);
  const baseTip = anchors.baseTip!;
  const result = await runner.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', baseTip, anchors.head]);
  if (result.exitCode !== 0 && result.exitCode !== 1) return notRun('trial-merge', failureReason('git merge-tree', result, runner.timeoutLabel));
  const { files } = parseMergeTree(result.stdout);
  const details = { baseTip, head: anchors.head, conflicts: files.length, files };
  const target = `${pr.baseRef} @ ${short(baseTip)}`;
  if (result.exitCode === 0) return check('trial-merge', 'ok', `clean into ${target}`, details);
  return check('trial-merge', 'attention', `${plural(files.length, 'conflicting file')} merging into ${target}: ${fitList(files, LIST_WIDTH)}`, details);
}

async function checkWatched(runner: Runner, settings: CheckSettings, anchors: Anchors): Promise<Check> {
  if (settings.watch.length === 0) return off('watched', 'no watched paths configured (check.watch)');
  const blocked = anchors.headProblem ?? anchors.baseProblem ?? anchors.rangeProblem;
  if (blocked) return notRun('watched', blocked);
  const mb = anchors.mergeBase!;
  const watched = await changedFiles(runner, mb, anchors.head, { include: settings.watch });
  // check.flag applies only to files check.watch matched.
  const flagged = new Set(await changedFiles(runner, mb, anchors.head, { include: settings.flag }));
  const files = watched
    .map((path) => ({ path, flagged: flagged.has(path) }))
    .sort((a, b) => Number(b.flagged) - Number(a.flagged));
  if (files.length === 0) return check('watched', 'ok', 'no watched file changed', { files });
  const names = files.map((f) => (f.flagged ? `${f.path} (flagged)` : f.path));
  return check('watched', files.some((f) => f.flagged) ? 'attention' : 'info', fitList(names, LIST_WIDTH), { files });
}

async function checkOverlap(runner: Runner, pr: PrView, changed: readonly FileStat[], anchors: Anchors): Promise<Check> {
  const onBase = new Set(await changedFiles(runner, anchors.mergeBase!, anchors.baseTip!));
  const files = changed.map((s) => s.path).filter((p) => onBase.has(p));
  const where = `on ${pr.baseRef} since the branch point`;
  if (files.length === 0) return check('overlap', 'info', `no file also changed ${where}`, { files });
  return check('overlap', 'info', `${plural(files.length, 'file')} also changed ${where}: ${fitList(files, LIST_WIDTH)}`, { files });
}

function checkSize(changed: readonly FileStat[]): Check {
  const additions = changed.reduce((n, s) => n + s.additions, 0);
  const deletions = changed.reduce((n, s) => n + s.deletions, 0);
  const summary = `+${additions.toLocaleString('en-US')} −${deletions.toLocaleString('en-US')} in ${plural(changed.length, 'file')}`;
  return check('size', 'info', summary, { additions, deletions, files: changed.length });
}

async function checkToRead(runner: Runner, settings: CheckSettings, changed: readonly FileStat[], anchors: Anchors): Promise<Check> {
  const toRead = await numstat(runner, anchors.mergeBase!, anchors.head, { exclude: settings.notForReading });
  const kept = new Set(toRead.map((s) => s.path));
  const excluded = changed.map((s) => s.path).filter((p) => !kept.has(p));
  const largestFirst = [...toRead].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || (a.path < b.path ? -1 : 1));
  const details = {
    files: largestFirst.map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    excluded,
  };
  const notForReading = `${excluded.length.toLocaleString('en-US')} not for reading`;
  if (largestFirst.length === 0) return check('to-read', 'info', `nothing to read (${notForReading})`, details);
  const paths = largestFirst.map((s) => s.path);
  return check('to-read', 'info', `${plural(paths.length, 'file')} (${notForReading}): ${fitList(paths, LIST_WIDTH)}`, details);
}

/** The range checks (`overlap`, `size`, `to-read`) share one numstat; all are not run when the range is not available. */
async function rangeChecks(runner: Runner, pr: PrView, settings: CheckSettings, anchors: Anchors): Promise<Check[]> {
  const blocked = anchors.headProblem ?? anchors.baseProblem ?? anchors.rangeProblem;
  if (blocked) return [notRun('overlap', blocked), notRun('size', blocked), notRun('to-read', blocked)];
  const changed = await numstat(runner, anchors.mergeBase!, anchors.head);
  return [await checkOverlap(runner, pr, changed, anchors), checkSize(changed), await checkToRead(runner, settings, changed, anchors)];
}

async function checkCi(runner: Runner, settings: CheckSettings, anchors: Anchors): Promise<Check> {
  if (settings.skip.has('checks')) return skipped('checks');
  const blocked = anchors.headProblem ?? anchors.baseProblem ?? anchors.rangeProblem;
  if (blocked) return notRun('checks', blocked);
  return checkChecks(runner, anchors.head, anchors.mergeBase!);
}

/** The checks in the order of PR_CHECK_IDS. */
function inOrder(checks: readonly Check[]): Check[] {
  const order: readonly string[] = PR_CHECK_IDS;
  return [...checks].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

// =============================================================================
// Movement during the run
// =============================================================================

/**
 * Add a note to the check anchored on a tip that moved (or could not be re-read). The check
 * needs attention; one the project skipped is replaced, because a CLEAR must describe the
 * live tips.
 */
function flagCheck(checks: Check[], id: string, note: string, extra: Record<string, unknown>): Check[] {
  return checks.map((c) => {
    if (c.id !== id) return c;
    if (c.status === 'skip') return check(id, 'attention', note, extra);
    const status = c.status === 'not-run' ? 'not-run' : 'attention';
    return { ...c, status, summary: `${c.summary}\n${note}`, details: { ...c.details, ...extra } };
  });
}

function moved(from: string | null, to: string | null): string {
  return `${from ? short(from) : 'none'} → ${to ? short(to) : 'none'}`;
}

// =============================================================================
// The command
// =============================================================================

async function buildPrReport(number: number, options: CommandOptions): Promise<PrReport> {
  const runnerOptions = { timeoutMs: options.timeoutMs, env: options.env, spawn: options.spawn };
  const roots = await resolveRoots(createRunner({ cwd: options.cwd, workspaceRoot: options.cwd, ...runnerOptions }));
  const runner = createRunner({ cwd: roots.mainRoot, workspaceRoot: roots.mainRoot, ...runnerOptions });
  const settings = loadCheckSettings(roots.mainRoot);
  const version = await gitVersion(runner);

  const anchor = await readPrView(runner, number);
  if (!anchor.ok) throw new CheckCommandError(`could not read PR #${number}: ${anchor.reason} (${forgeSource(runner, roots.mainRoot)})`);
  const pr = anchor.value;

  const base = await liveTip(runner, pr.baseRef);
  const anchors: Anchors = { head: pr.head, headProblem: null, baseTip: null, baseProblem: null, mergeBase: null, rangeProblem: null };
  if (!base.ok) anchors.baseProblem = base.reason;
  else if (base.value === null) anchors.baseProblem = `origin has no branch ${pr.baseRef}`;
  else anchors.baseTip = base.value;

  const available = await ensureCommits(runner, anchors.baseTip ? [pr.head, anchors.baseTip] : [pr.head], version);
  anchors.headProblem = available.get(pr.head) ?? null;
  if (anchors.baseTip && !anchors.baseProblem) anchors.baseProblem = available.get(anchors.baseTip) ?? null;
  if (!anchors.headProblem && !anchors.baseProblem) {
    anchors.mergeBase = await mergeBase(runner, anchors.baseTip!, pr.head);
    if (anchors.mergeBase === null) anchors.rangeProblem = `the head and ${pr.baseRef} @ ${short(anchors.baseTip!)} share no history`;
  }

  const localSha = await resolveCommit(runner, `refs/heads/${pr.headRef}`);
  let checks: Check[] = [
    await checkHead(runner, pr, localSha, anchors),
    checkState(pr),
    await checkAttribution(runner, pr, settings, anchors),
    await checkTrialMerge(runner, pr, version, anchors),
    await checkCi(runner, settings, anchors),
    await checkWatched(runner, settings, anchors),
    checkLinkedIssue(pr.body, pr.headRef),
    ...(await rangeChecks(runner, pr, settings, anchors)),
  ];

  // Read both tips again: pr-view first, then ls-remote.
  const reread = await readPrView(runner, number);
  checks = applySkips(inOrder([...checks, checkForge(pr, reread.ok ? reread.value : null)]), settings.skip);
  if (!reread.ok) {
    checks = flagCheck(checks, 'head', `could not confirm the head at the end of the run (${reread.reason}); re-run`, { recheck: reread.reason });
  } else if (reread.value.head !== pr.head) {
    checks = flagCheck(checks, 'head', `head moved during check (${moved(pr.head, reread.value.head)}); re-run`, { movedTo: reread.value.head });
  }
  if (base.ok) {
    const rebase = await liveTip(runner, pr.baseRef);
    if (!rebase.ok) {
      checks = flagCheck(checks, 'trial-merge', `could not confirm the base at the end of the run (${rebase.reason}); re-run`, { recheck: rebase.reason });
    } else if (rebase.value !== base.value) {
      checks = flagCheck(checks, 'trial-merge', `base moved during check (${moved(base.value, rebase.value)}); re-run`, { movedTo: rebase.value });
    }
  }

  return {
    schema: 1,
    command: 'pr',
    verdict: verdictOf(checks),
    generatedAt: new Date().toISOString(),
    pr: {
      number,
      title: pr.title ?? '',
      ...(pr.url ? { url: pr.url } : {}),
      state: pr.state ? normalizeState(pr.state, pr.mergedAt) : '',
      draft: pr.draft,
      headRef: pr.headRef,
      head: pr.head,
      baseRef: pr.baseRef,
      baseTip: anchors.baseTip,
      localBranch: localSha ? { name: pr.headRef, sha: localSha } : null,
    },
    checks,
  };
}

/** `codev check pr <N>`. Never throws: a failure that prevents a report is exit 2 with an `ErrorReport`. */
export async function checkPr(rawNumber: string, options: CommandOptions): Promise<CommandResult<PrReport>> {
  try {
    const number = validatePrNumber(rawNumber);
    const report = await buildPrReport(number, options);
    return { report, exitCode: exitCodeOf(report.verdict) };
  } catch (err) {
    return { report: errorReport('pr', err), exitCode: 2 };
  }
}

// =============================================================================
// Human form
// =============================================================================

const PR_RENDER: RenderOptions = {
  qualifier: (c) => {
    if (c.status === 'not-run') return 'not run';
    if ('movedTo' in c.details) return c.id === 'head' ? 'moved' : 'base moved';
    if (c.status !== 'attention') return null;
    switch (c.id) {
      case 'head':
        if (c.details.relation === 'ahead' || c.details.relation === 'diverged') return 'not pushed';
        return c.details.relation === 'origin-ahead' ? 'forge behind' : null;
      case 'state':
        return c.details.state === 'OPEN' ? 'draft' : String(c.details.state).toLowerCase();
      case 'forge':
        return c.details.mergeable === 'CONFLICTING' ? 'conflicts' : 'not computed';
      case 'trial-merge':
        return 'conflicts' in c.details ? 'conflicts' : null;
      case 'checks':
        return checksProblem(c.details.head as CommitRuns, (c.details.code as CommitRuns | undefined) ?? null);
      case 'watched':
        return 'flagged';
      case 'linked-issue':
        return 'wrong issue';
      default:
        return null;
    }
  },
};

export function renderPrHuman(report: PrReport): string {
  const { pr } = report;
  // A head and a state that are fine read in the header; one that needs attention gets its own line.
  const headCheck = report.checks.find((c) => c.id === 'head' && c.status === 'ok');
  const inHeader = (c: Check): boolean => (c.id === 'head' && c === headCheck) || (c.id === 'state' && c.status === 'ok');
  const verdictLine =
    report.verdict === 'clear'
      ? `CLEAR  PR #${pr.number} — ready to recommend`
      : `ATTENTION  PR #${pr.number} — ${attentionNames(report.checks, PR_RENDER).join(', ')}`;
  const state = `${pr.state || 'state unknown'}${pr.draft ? ' (draft)' : ''}`;
  const title = pr.title ? `  ${pr.title}` : '';
  const headPart = `head  ${short(pr.head)}${headCheck ? `  (${headCheck.summary.split('\n')[0]})` : ''}`;
  const basePart = pr.baseTip ? `base  ${pr.baseRef} @ ${short(pr.baseTip)} (origin, live)` : `base  ${pr.baseRef} (live tip not read)`;
  return renderHuman(
    {
      verdictLine,
      header: [`PR #${pr.number}${title}   ${state}   ${pr.headRef} → ${pr.baseRef}`, `${headPart}      ${basePart}`, ''],
      sections: [{ checks: report.checks.filter((c) => !inHeader(c)) }],
    },
    PR_RENDER,
  );
}
