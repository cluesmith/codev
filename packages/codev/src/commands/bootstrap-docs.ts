/**
 * `codev bootstrap-docs` (Spec 1797): draft the four governance docs from an existing
 * codebase, in place of the starter placeholders `codev adopt` leaves behind.
 *
 * The CLI owns everything deterministic: which files are still untouched starters, whether
 * there is anything to document, the launch, the before/after change report, validation of
 * the drafts and the summary. The agent owns only the writing, under the rules of the
 * `update-arch-docs` skill's bootstrap mode: the project's installed copy when it matches
 * the package (#1811), the packaged text inlined into the prompt otherwise.
 *
 * An interactive agent cannot be sandboxed from here, so the guarantee is detect-and-report:
 * anything that moved outside the eligible files is named and the exit code is non-zero.
 * Nothing is ever reverted, staged or committed; the drafts are the human's to review.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { spawnAgentProcess, type AgentExit, type AgentLaunch } from '../lib/agent-process.js';
import { confirm } from '../lib/cli-prompts.js';
import { loadConfig } from '../lib/config.js';
import { getTemplatesDir } from '../lib/templates.js';
import {
  GOVERNANCE_FILES,
  bootstrapEligibleFiles,
  classifyProjectFile,
  classifyProjectGovernance,
  irregularAncestor,
  governancePathKind,
  isNonEmptyRepo,
  knownStarterTexts,
  topLevelHeadings,
  validateColdFile,
  validateHotFile,
  HOT_CAP_MAP_TOPICS,
  type GovernanceClass,
  type GovernanceFile,
  type GovernanceStatus,
  type Violation,
} from '../lib/governance-bootstrap.js';
import {
  CONSULT_OWNED_PREFIXES,
  FILESYSTEM_WALK_LIMIT,
  FILESYSTEM_WALK_SKIPPED,
  diffRepositoryIdentity,
  diffSnapshotEntries,
  escapeControlChars,
  hashPath,
  readIndexFingerprint,
  snapshotFilesystem,
  snapshotTree,
  type IdentityChange,
  type TreeSnapshot,
} from '../lib/tree-snapshot.js';
import {
  resolveInteractiveTaskLauncher,
  type CustomHarnessConfig,
  type InteractiveTaskLauncher,
} from '../agent-farm/utils/harness.js';
import { classifySkill, skillRelDir, type SkillProvider, type SkillState } from '../lib/skill-refresh.js';
import { SKILL_PROVIDERS } from '../lib/scaffold.js';

export type { AgentExit, AgentLaunch };

/** Where the rendered prompt is saved, for the manual fallback and for the record. */
export const PROMPT_FILE = '.consult/bootstrap-docs/prompt.md';

/** Where the draft review's prompt and each reviewer's feedback are written. */
export const REVIEW_DIR = '.consult/bootstrap-docs';
export const REVIEW_PROMPT_FILE = `${REVIEW_DIR}/review-prompt.md`;

/** The three reviewers of the drafts, run in parallel. */
export const REVIEW_MODELS = ['gemini', 'codex', 'claude'] as const;

/**
 * Largest prompt passed as a command-line argument. Linux caps one argument at 128 KB
 * (MAX_ARG_STRLEN); above this the prompt goes to the manual fallback instead of failing
 * the spawn with E2BIG.
 */
export const MAX_PROMPT_BYTES = 100_000;

/**
 * Paths the agent harness itself writes during an ordinary session. Still reported (the spec
 * allows no exemption beyond the eligible files and `.consult/`), but annotated so the human
 * can judge them quickly.
 */
const HARNESS_SCRATCH_PATHS: Record<string, string> = {
  '.claude/settings.local.json': 'written by the agent harness itself, usually benign',
};

export interface BootstrapDocsOptions {
  /** Project root; defaults to the current directory. */
  cwd?: string;
  /** Report eligibility and the resolved launch, launch nothing, write nothing. */
  dryRun?: boolean;
}

/** Seams for tests: the agent, the prompt and the environment are all replaceable. */
export interface BootstrapDocsDeps {
  /** Root of the packaged skeleton (holds `templates/` and the skill copies). */
  skeletonDir: string;
  resolveLauncher(root: string): InteractiveTaskLauncher;
  isExecutableAvailable(executable: string): boolean;
  confirm(question: string): Promise<boolean>;
  stdinIsTTY: boolean;
  spawnAgent(launch: AgentLaunch, cwd: string): Promise<AgentExit>;
  /** Run `consult` with these arguments in `cwd` and wait for it. */
  runConsult(args: string[], cwd: string): Promise<AgentExit>;
  log(line: string): void;
}

export type BootstrapOutcome =
  | 'no-codev'
  | 'nothing-eligible'
  | 'empty-repo'
  | 'dry-run'
  | 'manual'
  | 'declined'
  | 'unsafe-path'
  | 'ran';

export type FileStatus = GovernanceStatus;

export interface DraftValidation {
  name: string;
  /** `unwritten`: still a placeholder after the session; `deleted`: the file is gone. */
  state: 'written' | 'unwritten' | 'deleted';
  violations: Violation[];
  /** Cold sections the map leaves out, listed as information when the cold doc has > 12. */
  unmappedInfo: string[];
}

export interface OutOfScopeChange {
  path: string;
  annotation?: string;
}

export interface ChangeReport {
  /** Governance files that were not eligible but changed (curated, missing, held back). */
  governanceChanged: string[];
  identityChanges: IdentityChange[];
  indexChanged: boolean;
  outOfScope: OutOfScopeChange[];
  /** Set when the tree could be read before the session and not after. */
  detectionLost?: string;
  /** The detector's scope, stated in every summary. */
  scope: string;
}

export type ReviewStatus = 'ok' | 'skipped' | 'failed';

export interface ReviewOutcome {
  model: string;
  status: ReviewStatus;
  /** Why a reviewer was skipped or failed. */
  detail?: string;
}

export interface DraftReview {
  /** Nothing was written, so nothing was reviewed. */
  ran: boolean;
  /** Why the review did not run: `consult` could not start, or the review could not be prepared. */
  unavailable?: string;
  reviewers: ReviewOutcome[];
  /** Governance files whose content changed while the reviewers ran. */
  changesDuringReview?: ChangeReport;
}

export interface BootstrapDocsResult {
  exitCode: number;
  outcome: BootstrapOutcome;
  files: FileStatus[];
  launched: boolean;
  agentExit?: AgentExit;
  report?: ChangeReport;
  validation?: DraftValidation[];
  review?: DraftReview;
}

function governancePath(name: string): string {
  return `codev/resources/${name}`;
}

// =============================================================================
// Prompt
// =============================================================================

/**
 * Fill `{{NAME}}` placeholders in one pass, so text inserted for one placeholder (the skill
 * text in particular) is never itself scanned for placeholders.
 */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}

function fileList(names: string[]): string {
  if (names.length === 0) return '(none)';
  return names.map(name => `- \`${governancePath(name)}\``).join('\n');
}

const BOOTSTRAP_SKILL = 'update-arch-docs';

/** Where the agent gets the bootstrap-mode rules from. */
export type SkillSource =
  | { kind: 'installed'; dir: string }
  /** `provider` names the launching harness's copy to inline; a manual prompt has none. */
  | { kind: 'inline'; reason: string; provider?: SkillProvider };

const INLINE_REASONS: Record<Exclude<SkillState, 'current'>, string> = {
  missing: 'is missing',
  shipped: 'is an older version (`codev update` refreshes it)',
  edited: 'has local edits',
  'not-regular': 'is a symlink, holds one, is unreadable, or is not a directory',
};

/**
 * Run the project's installed skill by name when the launching harness loads it and the copy
 * is identical to the package's, so the rules the agent follows are exactly the ones the
 * drafts are validated against. Anything else gets the packaged text inlined.
 */
export function chooseSkillSource(root: string, skeletonDir: string, harnessName: string | undefined): SkillSource {
  const provider = SKILL_PROVIDERS.find(name => name === harnessName);
  if (!provider) return { kind: 'inline', reason: 'the agent that runs this prompt may not load project skills' };
  const dir = skillRelDir(provider, BOOTSTRAP_SKILL);
  const state = classifySkill(path.join(root, dir), path.join(skeletonDir, dir), dir);
  if (state === 'current') return { kind: 'installed', dir };
  return { kind: 'inline', reason: `the installed copy at \`${dir}/\` ${INLINE_REASONS[state]}`, provider };
}

export function describeSkillSource(source: SkillSource): string {
  if (source.kind === 'installed') return `the installed skill at ${source.dir}/`;
  return `the packaged skill text, inlined because ${source.reason}`;
}

function buildPrompt(root: string, skeletonDir: string, eligible: string[], curated: string[], source: SkillSource): string {
  const template = fs.readFileSync(path.join(skeletonDir, 'templates', 'bootstrap-docs-prompt.md'), 'utf-8');
  let skillSource: string;
  let skillText = '';
  if (source.kind === 'installed') {
    skillSource = `The skill is installed in this project at \`${source.dir}/\`: load it before you start, since it holds the rules for this work.`;
  } else {
    const skill = fs.readFileSync(path.join(skeletonDir, skillRelDir(source.provider ?? 'claude', BOOTSTRAP_SKILL), 'SKILL.md'), 'utf-8');
    skillSource = `Its full text is at the end of this prompt, because ${source.reason}; follow that text, not any installed copy.`;
    skillText = `\n## The ${BOOTSTRAP_SKILL} skill\n\n${skill.trim()}\n`;
  }
  return renderPrompt(template, {
    PROJECT_NAME: path.basename(root),
    SKILL_SOURCE: skillSource,
    ELIGIBLE_FILES: fileList(eligible),
    CURATED_FILES: fileList(curated),
    SKILL_TEXT: skillText,
  });
}

// =============================================================================
// Default environment
// =============================================================================

function resolveConfiguredLauncher(root: string): InteractiveTaskLauncher {
  let config;
  try {
    config = loadConfig(root);
  } catch (err) {
    return { supported: false, reason: `.codev/config.json could not be loaded: ${(err as Error).message}` };
  }
  return resolveInteractiveTaskLauncher(
    config.shell?.architect ?? 'claude',
    config.shell?.architectHarness,
    config.harness as Record<string, CustomHarnessConfig> | undefined,
  );
}

function isExecutableOnPath(executable: string): boolean {
  const canRun = (candidate: string): boolean => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (executable.includes('/') || executable.includes(path.sep)) return canRun(executable);
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    for (const ext of extensions) {
      if (canRun(path.join(dir, executable + ext))) return true;
    }
  }
  return false;
}

/**
 * Run one `consult` process. Its progress output is discarded (three in parallel would
 * interleave on the terminal); the last stderr line is kept as the reason when it fails.
 */
function runConsultProcess(args: string[], cwd: string): Promise<AgentExit> {
  return new Promise<AgentExit>(resolve => {
    const child = spawn('consult', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on('error', err => resolve({ code: null, signal: null, error: err.message }));
    child.on('exit', (code, signal) => {
      const lastLine = stderr.trim().split('\n').pop();
      if (code !== 0 && lastLine) {
        resolve({ code, signal, error: lastLine });
      } else {
        resolve({ code, signal });
      }
    });
  });
}

/** Defaults for every seam but `skeletonDir`, which is resolved only when not overridden. */
function defaultDeps(): Omit<BootstrapDocsDeps, 'skeletonDir'> {
  return {
    runConsult: runConsultProcess,
    resolveLauncher: resolveConfiguredLauncher,
    isExecutableAvailable: isExecutableOnPath,
    confirm: question => confirm(question, false),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    spawnAgent: spawnAgentProcess,
    log: line => console.log(line),
  };
}

// =============================================================================
// Change detection
// =============================================================================

type Detector = { mode: 'git' | 'filesystem'; snapshot: TreeSnapshot; index: string | null };

function takeSnapshot(root: string, mode?: Detector['mode']): Detector {
  if (mode !== 'filesystem') {
    const snapshot = snapshotTree(root);
    if (snapshot.available || mode === 'git') {
      return { mode: 'git', snapshot, index: readIndexFingerprint(root) };
    }
  }
  return { mode: 'filesystem', snapshot: snapshotFilesystem(root), index: null };
}

/**
 * Each governance file's identity: the path itself, plus what it resolves to when it is a
 * symlink, so a retarget and a write through the link are both a change.
 */
function hashGovernanceFiles(root: string): Map<string, string> {
  return new Map(GOVERNANCE_FILES.map(file => {
    const absolute = path.join(root, governancePath(file.name));
    let identity = hashPath(absolute);
    if (identity.startsWith('<link:')) identity += hashResolved(absolute);
    return [file.name, identity];
  }));
}

function hashResolved(absolute: string): string {
  try {
    return hashPath(fs.realpathSync(absolute));
  } catch {
    return '<dangling>';
  }
}

function detectorScope(before: Detector, after: Detector): string {
  if (before.mode === 'git') {
    return 'Change detection covered the git state and every tracked or untracked path git does not ignore; gitignored paths are not watched.';
  }
  if (before.snapshot.truncated || after.snapshot.truncated) {
    return `Not a git repository, and the tree holds more than ${FILESYSTEM_WALK_LIMIT.toLocaleString('en-US')} files, so change detection covered only the four governance files.`;
  }
  const skipped = FILESYSTEM_WALK_SKIPPED.map(dir => `${dir}/`).join(', ');
  return `Not a git repository: change detection walked every file except ${skipped} and paths the root .gitignore ignores (a repository created during the session is not seen).`;
}

function buildChangeReport(
  eligible: Set<string>,
  before: Detector,
  after: Detector,
  hashesBefore: Map<string, string>,
  hashesAfter: Map<string, string>,
): ChangeReport {
  const governanceChanged = GOVERNANCE_FILES
    .filter(file => !eligible.has(file.name) && hashesBefore.get(file.name) !== hashesAfter.get(file.name))
    .map(file => governancePath(file.name));

  const governancePaths = new Set(GOVERNANCE_FILES.map(file => governancePath(file.name)));
  const eligiblePaths = new Set([...eligible].map(governancePath));
  const isExempt = (rel: string): boolean =>
    eligiblePaths.has(rel) ||
    // Reported above, by content hash, which also sees clean tracked files.
    governancePaths.has(rel) ||
    CONSULT_OWNED_PREFIXES.some(prefix => rel.startsWith(prefix));

  const report: ChangeReport = {
    governanceChanged,
    identityChanges: [],
    indexChanged: false,
    outOfScope: [],
    scope: detectorScope(before, after),
  };

  if (before.snapshot.available && !after.snapshot.available) {
    report.detectionLost = after.snapshot.reason ?? 'unknown';
    return report;
  }
  if (before.snapshot.truncated || after.snapshot.truncated) return report;

  report.outOfScope = diffSnapshotEntries(before.snapshot, after.snapshot, isExempt).map(rel => {
    const annotation = HARNESS_SCRATCH_PATHS[rel];
    if (annotation) return { path: rel, annotation };
    return { path: rel };
  });
  report.identityChanges = diffRepositoryIdentity(before.snapshot, after.snapshot);
  report.indexChanged = before.index !== null && after.index !== null && before.index !== after.index;
  return report;
}

function reportHasChanges(report: ChangeReport): boolean {
  return (
    report.governanceChanged.length > 0 ||
    report.identityChanges.length > 0 ||
    report.indexChanged ||
    report.outOfScope.length > 0 ||
    report.detectionLost !== undefined
  );
}

// =============================================================================
// This command's own files
// =============================================================================

/**
 * Why `relPath` (one of this command's files under `.consult/bootstrap-docs/`) cannot be
 * written safely, else undefined. A symlinked `.consult/`, directory or file would carry the
 * write outside the project, before change detection has started.
 */
function artifactPathProblem(root: string, relPath: string): string | undefined {
  const ancestor = irregularAncestor(root, relPath);
  if (ancestor !== undefined) return `${relPath} would be written through ${ancestor}`;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path.join(root, relPath));
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) return `${relPath} is a symlink`;
  if (!stat.isFile()) return `${relPath} is not a regular file`;
  return undefined;
}

/** Write one of this command's files, or return why it was not written. */
function writeArtifact(root: string, relPath: string, content: string): string | undefined {
  const problem = artifactPathProblem(root, relPath);
  if (problem !== undefined) return problem;
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.rmSync(full, { force: true });
  fs.writeFileSync(full, content, { flag: 'wx' });
  return undefined;
}

// =============================================================================
// Validation
// =============================================================================

function readIfExists(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

function validateDrafts(root: string, eligible: GovernanceFile[], templatesDir: string): DraftValidation[] {
  return eligible.map(file => {
    // A draft the session replaced with a symlink is never read through.
    const kind = governancePathKind(root, file);
    if (kind !== undefined) {
      return { name: file.name, state: 'written', violations: [{ kind: 'not-regular', message: `the draft is now ${kind}, so it was not read` }], unmappedInfo: [] };
    }
    const content = readIfExists(path.join(root, governancePath(file.name)));
    if (content === null) return { name: file.name, state: 'deleted', violations: [], unmappedInfo: [] };
    if (classifyProjectFile(root, file, templatesDir) === 'placeholder') {
      return { name: file.name, state: 'unwritten', violations: [], unmappedInfo: [] };
    }
    if (file.kind === 'cold') {
      return { name: file.name, state: 'written', violations: validateColdFile(content, true), unmappedInfo: [] };
    }
    const cold = readIfExists(path.join(root, governancePath(file.coldDoc!))) ?? '';
    const starter = knownStarterTexts(file, templatesDir)[0];
    const { violations, unmappedSections } = validateHotFile(content, cold, file, starter);
    let unmappedInfo: string[] = [];
    if (topLevelHeadings(cold).length > HOT_CAP_MAP_TOPICS) unmappedInfo = unmappedSections;
    return { name: file.name, state: 'written', violations, unmappedInfo };
  });
}

// =============================================================================
// Draft review
// =============================================================================

/** The argv for one reviewer: general mode, so no project detection is needed. */
export function reviewConsultArgs(model: string): string[] {
  return ['-m', model, '--prompt-file', REVIEW_PROMPT_FILE, '--output', `${REVIEW_DIR}/${model}.md`];
}

/** A code fence longer than any backtick run in `content`, so the draft cannot close it. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map(run => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function renderDrafts(root: string, names: string[]): string {
  return names
    .map(name => {
      const rel = governancePath(name);
      const content = fs.readFileSync(path.join(root, rel), 'utf-8');
      const fence = fenceFor(content);
      return `### \`${rel}\`\n\n${fence}markdown\n${content.replace(/\n$/, '')}\n${fence}`;
    })
    .join('\n\n');
}

/** A consult artifact that records a non-blocking skip, e.g. Gemini without credentials. */
const SKIP_SUMMARY = /^SUMMARY: .*lane skipped\W+(.*)$/m;

/**
 * Run the 3-way general consult on the written drafts and save the feedback under
 * `.consult/bootstrap-docs/`. Never applies anything and never fails the pass: a reviewer
 * that fails or skips is named, and `consult` being unavailable is a warning.
 */
async function reviewDrafts(
  root: string,
  skeletonDir: string,
  written: string[],
  deps: BootstrapDocsDeps,
): Promise<DraftReview> {
  if (written.length === 0) return { ran: false, reviewers: [] };

  const template = fs.readFileSync(path.join(skeletonDir, 'templates', 'bootstrap-docs-review-prompt.md'), 'utf-8');
  const prompt = renderPrompt(template, {
    PROJECT_NAME: path.basename(root),
    DRAFTS: renderDrafts(root, written),
  });
  // consult writes each reviewer's feedback itself, so its paths are checked here too.
  const reviewPaths = [REVIEW_PROMPT_FILE, ...REVIEW_MODELS.map(model => `${REVIEW_DIR}/${model}.md`)];
  const blocked = reviewPaths.map(rel => artifactPathProblem(root, rel)).find(problem => problem !== undefined);
  if (blocked !== undefined) return { ran: true, unavailable: blocked, reviewers: [] };
  writeArtifact(root, REVIEW_PROMPT_FILE, prompt);

  deps.log('');
  deps.log(`Reviewing the drafts with ${REVIEW_MODELS.join(', ')} (feedback goes to ${REVIEW_DIR}/; nothing is applied)…`);

  const exits = await Promise.all(REVIEW_MODELS.map(model => {
    const output = path.join(root, REVIEW_DIR, `${model}.md`);
    // A file left by an earlier run must not pass for this run's feedback.
    fs.rmSync(output, { force: true });
    return deps.runConsult(reviewConsultArgs(model), root);
  }));

  const reviewers: ReviewOutcome[] = REVIEW_MODELS.map((model, i) => {
    const exit = exits[i];
    const output = readIfExists(path.join(root, REVIEW_DIR, `${model}.md`));
    if (exit.error !== undefined && exit.code === null) return { model, status: 'failed', detail: exit.error };
    if (exit.signal) return { model, status: 'failed', detail: `terminated by ${exit.signal}` };
    if (exit.code !== 0) {
      let detail = `exit ${exit.code}`;
      if (exit.error) detail += `: ${exit.error}`;
      return { model, status: 'failed', detail };
    }
    if (output === null || output.trim() === '') return { model, status: 'failed', detail: 'no feedback was written' };
    const skipped = output.match(SKIP_SUMMARY);
    if (skipped) return { model, status: 'skipped', detail: skipped[1].trim() };
    return { model, status: 'ok' };
  });

  // Every reviewer failed to start: consult itself is missing or broken.
  if (exits.every(exit => exit.code === null && exit.error !== undefined)) {
    return { ran: true, unavailable: `\`consult\` could not run: ${exits[0].error}`, reviewers };
  }
  return { ran: true, reviewers };
}

function printReview(log: (line: string) => void, review: DraftReview): void {
  if (!review.ran) return;
  if (review.unavailable !== undefined) {
    log(chalk.yellow(`  Draft review did not run (${escapeControlChars(review.unavailable)}); the drafts were not reviewed.`));
    return;
  }
  const reviewed = review.reviewers.filter(reviewer => reviewer.status === 'ok').map(reviewer => reviewer.model);
  if (reviewed.length > 0) {
    log(`  Draft review: feedback from ${reviewed.join(', ')} is in ${REVIEW_DIR}/ (read it before committing; nothing was applied).`);
  } else {
    log(chalk.yellow('  Draft review: no reviewer produced feedback.'));
  }
  for (const reviewer of review.reviewers) {
    if (reviewer.status === 'ok') continue;
    log(chalk.yellow(`    - ${reviewer.model} ${reviewer.status}: ${escapeControlChars(reviewer.detail ?? 'unknown')}`));
  }
}

// =============================================================================
// Output
// =============================================================================

const CLASS_LABEL: Record<GovernanceClass, string> = {
  placeholder: 'placeholder (eligible)',
  curated: 'curated (read as input, not edited)',
  missing: 'missing (run `codev update` to restore the starter, then re-run)',
};

function printFileStatuses(log: (line: string) => void, files: FileStatus[]): void {
  for (const status of files) {
    let label = CLASS_LABEL[status.class];
    if (status.heldBack) label = `placeholder, held back: ${status.heldBack}`;
    if (status.pathKind) label = `${status.pathKind}, never rewritten (read as input, not edited)`;
    log(`  ${governancePath(status.file.name)}: ${label}`);
  }
}

function quoteArg(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The launch as a command line, with the (long) prompt argument shown by reference. */
function describeLaunch(launch: AgentLaunch, prompt: string): string {
  const args = launch.args.map(arg => {
    if (arg === prompt) return `"$(cat ${PROMPT_FILE})"`;
    return quoteArg(arg);
  });
  return [quoteArg(launch.executable), ...args].join(' ');
}

/** Flags (or `--flag=value` forms) that let the agent act without asking. */
const BYPASS_FLAGS = [
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--permission-mode=bypassPermissions',
];
const PERMISSION_FLAG = /dangerously|bypass|yolo|full-auto|permission|approval|sandbox/i;

function describePermissions(launch: AgentLaunch, prompt: string): string {
  const flags: string[] = [];
  const args = launch.args.filter(arg => arg !== prompt);
  for (let i = 0; i < args.length; i++) {
    if (!PERMISSION_FLAG.test(args[i])) continue;
    // Keep a separate value with its flag (`--permission-mode plan`).
    if (!args[i].includes('=') && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
      flags.push(`${args[i]}=${args[i + 1]}`);
      i++;
    } else {
      flags.push(args[i]);
    }
  }
  if (flags.length === 0) return 'Permission mode: the agent CLI\'s default (it asks before running commands or editing files).';
  if (flags.some(flag => BYPASS_FLAGS.includes(flag))) {
    return `Permission mode from your config: ${flags.join(' ')} (the agent will NOT ask before running commands or editing files).`;
  }
  return `Permission flags from your config: ${flags.join(' ')} (see your agent's documentation for what they allow).`;
}

function printSummary(
  log: (line: string) => void,
  validation: DraftValidation[],
  report: ChangeReport,
  agentExit: AgentExit,
): void {
  log('');
  log(chalk.bold('Bootstrap summary'));

  if (agentExit.error) {
    log(chalk.red(`  Agent could not be started: ${agentExit.error}`));
    log(`  The prompt is saved at ${PROMPT_FILE} if you would rather run it in your own agent.`);
  } else if (agentExit.signal) {
    log(chalk.red(`  Agent was terminated by ${agentExit.signal}.`));
  } else if (agentExit.code !== 0) {
    log(chalk.red(`  Agent exited with status ${agentExit.code}.`));
  }

  log('  Drafts:');
  for (const draft of validation) {
    const rel = governancePath(draft.name);
    if (draft.state === 'deleted') {
      log(chalk.red(`    ✗ ${rel}: deleted during the session (not written)`));
    } else if (draft.state === 'unwritten') {
      log(chalk.red(`    ✗ ${rel}: still the starter placeholder (not written)`));
    } else if (draft.violations.length === 0) {
      log(chalk.green(`    ✓ ${rel}: written, validation passed`));
    } else {
      log(chalk.red(`    ✗ ${rel}: written, ${draft.violations.length} validation problem(s):`));
      for (const violation of draft.violations) log(`        - ${escapeControlChars(violation.message)}`);
    }
    if (draft.unmappedInfo.length > 0) {
      log(`      info: cold sections not in the map (allowed above ${HOT_CAP_MAP_TOPICS}): ${draft.unmappedInfo.map(escapeControlChars).join(', ')}`);
    }
  }

  if (reportHasChanges(report)) {
    log(chalk.red('  Changes outside the eligible files (nothing has been reverted):'));
    printChanges(log, report, 'governance file that was not eligible');
  } else {
    log('  No changes outside the eligible files.');
  }
  if (report.detectionLost === undefined) log(`  ${report.scope}`);
}

/** One line per change in `report`; `governanceLabel` says why a governance file is listed. */
function printChanges(log: (line: string) => void, report: ChangeReport, governanceLabel: string): void {
  for (const rel of report.governanceChanged) log(chalk.red(`    - ${rel} (${governanceLabel})`));
  for (const change of report.identityChanges) {
    log(chalk.red(`    - ${change.field} moved: ${escapeControlChars(change.before)} -> ${escapeControlChars(change.after)} (check \`git reflog\`)`));
  }
  if (report.indexChanged) log(chalk.red('    - the git index changed (check `git diff --cached`)'));
  for (const change of report.outOfScope) {
    let line = `    - ${escapeControlChars(change.path)}`;
    if (change.annotation) line += ` (${change.annotation})`;
    log(chalk.red(line));
  }
  if (report.detectionLost !== undefined) {
    log(chalk.red(`    - the working tree could not be read afterwards (${escapeControlChars(report.detectionLost)}); whether anything else changed is unknown`));
  }
}

function printFooter(log: (line: string) => void, report: ChangeReport, review: DraftReview): void {
  printReview(log, review);

  const duringReview = review.changesDuringReview;
  if (duringReview !== undefined && reportHasChanges(duringReview)) {
    log(chalk.red('  Changes made while the reviewers ran (nothing has been reverted):'));
    printChanges(log, duringReview, 'changed during the review; the validation above describes the version before it');
  }

  const gitMoved = [report, duringReview].some(
    changes => changes !== undefined && (changes.identityChanges.length > 0 || changes.indexChanged),
  );
  log('');
  if (gitMoved) {
    log(chalk.yellow('Review before commit — Codev staged and committed nothing, but git state moved during the session (see above).'));
    log('  Check `git log` and `git diff --cached` before trusting what is staged or committed.');
  } else {
    log(chalk.yellow('Review before commit — nothing has been staged or committed.'));
  }
  log(`  Inspect the drafts with \`git diff\` (or open them), edit as needed, then commit them yourself.`);
}

// =============================================================================
// Command
// =============================================================================

export async function runBootstrapDocs(
  options: BootstrapDocsOptions = {},
  overrides: Partial<BootstrapDocsDeps> = {},
): Promise<BootstrapDocsResult> {
  const deps: BootstrapDocsDeps = {
    ...defaultDeps(),
    ...overrides,
    skeletonDir: overrides.skeletonDir ?? getTemplatesDir(),
  };
  const { log } = deps;
  const root = path.resolve(options.cwd ?? process.cwd());
  const templatesDir = path.join(deps.skeletonDir, 'templates');

  if (!fs.existsSync(path.join(root, 'codev'))) {
    log(chalk.red(`No codev/ directory in ${root}. Run \`codev adopt\` first, then re-run \`codev bootstrap-docs\` here.`));
    return { exitCode: 1, outcome: 'no-codev', files: [], launched: false };
  }

  const files: FileStatus[] = classifyProjectGovernance(root, templatesDir);
  const eligible = bootstrapEligibleFiles(files);
  const curated = files.filter(status => status.class === 'curated').map(status => status.file.name);

  log(chalk.bold('Governance docs:'));
  printFileStatuses(log, files);

  if (eligible.length === 0) {
    log('');
    log('Nothing needs bootstrapping: no governance file is still an untouched starter.');
    if (files.some(status => status.class === 'missing')) {
      log('Missing files are not created here: run `codev update` to restore their starters, then re-run.');
    }
    return { exitCode: 0, outcome: 'nothing-eligible', files, launched: false };
  }

  if (!isNonEmptyRepo(root)) {
    log('');
    log('This project holds nothing beyond the files Codev generated, so there is nothing to document yet.');
    log('The placeholders stay; they fill in through review phases as work happens.');
    return { exitCode: 0, outcome: 'empty-repo', files, launched: false };
  }

  const launcher = deps.resolveLauncher(root);
  let unavailable: string | undefined;
  if (!launcher.supported) {
    unavailable = launcher.reason;
  } else {
    const executable = launcher.buildLaunch('').executable;
    if (!deps.isExecutableAvailable(executable)) unavailable = `"${executable}" was not found on PATH`;
  }

  // The installed skill is named only for a session this command launches itself; a prompt
  // saved for a manual run may go to an agent that does not load project skills.
  let launchingHarness: string | undefined;
  if (launcher.supported && !unavailable) launchingHarness = launcher.harnessName;
  const skillSource = chooseSkillSource(root, deps.skeletonDir, launchingHarness);

  if (options.dryRun) {
    log('');
    if (launcher.supported && !unavailable) {
      const launch = launcher.buildLaunch('<bootstrap prompt>');
      log(`Would launch (${launcher.harnessName}): ${[launch.executable, ...launch.args.map(quoteArg)].join(' ')}`);
      log(`The agent would follow ${describeSkillSource(skillSource)}.`);
    } else {
      log(`Would not launch an agent: ${unavailable}.`);
      log(`Would write the prompt to ${PROMPT_FILE} for you to run in your own agent.`);
    }
    log('Dry run: nothing launched, nothing written.');
    return { exitCode: 0, outcome: 'dry-run', files, launched: false };
  }

  const prompt = buildPrompt(root, deps.skeletonDir, eligible.map(file => file.name), curated, skillSource);
  const promptProblem = writeArtifact(root, PROMPT_FILE, prompt);
  if (promptProblem !== undefined) {
    log(chalk.red(`Cannot save the bootstrap prompt: ${escapeControlChars(promptProblem)}.`));
    log('Nothing was launched. Make it a regular path inside the project, then run `codev bootstrap-docs` again.');
    return { exitCode: 1, outcome: 'unsafe-path', files, launched: false };
  }

  const promptBytes = Buffer.byteLength(prompt);
  if (!unavailable && promptBytes > MAX_PROMPT_BYTES) {
    unavailable = `the prompt is ${Math.ceil(promptBytes / 1000)} KB, too long to pass as a command-line argument (limit ${MAX_PROMPT_BYTES / 1000} KB)`;
  }

  if (!launcher.supported || unavailable) {
    log('');
    log(chalk.yellow(`Not launching an agent: ${unavailable}.`));
    log(`The bootstrap prompt is saved at ${PROMPT_FILE}. To draft the docs yourself:`);
    log('  1. Open your agent in this directory.');
    log(`  2. Give it the contents of ${PROMPT_FILE} as its first message.`);
    log('  3. Review the drafts before committing; the placeholders stay until it writes them.');
    return { exitCode: 0, outcome: 'manual', files, launched: false };
  }

  const launch = launcher.buildLaunch(prompt);
  const command = describeLaunch(launch, prompt);
  log('');
  log(chalk.bold('About to launch an agent session to draft the governance docs:'));
  log(`  Command: ${command}`);
  log('  It reads the codebase and explores the git history with read-only git commands.');
  log(`  It follows ${describeSkillSource(skillSource)}.`);
  log(`  It may write only: ${eligible.map(file => governancePath(file.name)).join(', ')}`);
  log('  It consumes model quota on your agent account.');
  log(`  Afterwards the drafts are sent to ${REVIEW_MODELS.join(', ')} for review, through \`consult\`.`);
  log(`  ${describePermissions(launch, prompt)}`);
  log('  When it says the drafts are done, exit the session; Codev then checks what changed.');

  if (!deps.stdinIsTTY) {
    log('');
    log('Standard input is not a terminal, so the launch is declined. Run it interactively:');
    log('  codev bootstrap-docs');
    log(`The prompt is saved at ${PROMPT_FILE} if you would rather run it in your own agent.`);
    return { exitCode: 0, outcome: 'declined', files, launched: false };
  }
  if (!(await deps.confirm('Launch the agent now?'))) {
    log('Declined; nothing launched. The placeholders are unchanged.');
    log(`The prompt is saved at ${PROMPT_FILE} if you would rather run it in your own agent.`);
    return { exitCode: 0, outcome: 'declined', files, launched: false };
  }

  const eligibleNames = new Set(eligible.map(file => file.name));
  const hashesBefore = hashGovernanceFiles(root);
  const before = takeSnapshot(root);

  const agentExit = await deps.spawnAgent(launch, root);

  const after = takeSnapshot(root, before.mode);
  const hashesAfter = hashGovernanceFiles(root);
  const report = buildChangeReport(eligibleNames, before, after, hashesBefore, hashesAfter);
  const validation = validateDrafts(root, eligible, templatesDir);
  // A draft replaced by a symlink is never read, so it is never sent to the reviewers either.
  const written = validation
    .filter(draft => draft.state === 'written' && !draft.violations.some(violation => violation.kind === 'not-regular'))
    .map(draft => draft.name);
  // The summary prints before the review, which can take minutes, so an interrupted review
  // never costs the human the change report.
  printSummary(log, validation, report, agentExit);
  let review: DraftReview;
  try {
    review = await reviewDrafts(root, deps.skeletonDir, written, deps);
  } catch (err) {
    review = { ran: true, unavailable: `the review could not be prepared: ${(err as Error).message}`, reviewers: [] };
  }
  // The reviewers are agents too: anything they changed, drafts included, is named and fails
  // the run, measured from the post-session state (nothing is eligible to change here).
  const changesDuringReview = buildChangeReport(
    new Set(),
    after,
    takeSnapshot(root, before.mode),
    hashesAfter,
    hashGovernanceFiles(root),
  );
  review.changesDuringReview = changesDuringReview;
  printFooter(log, report, review);

  const agentFailed = agentExit.error !== undefined || agentExit.signal !== null || agentExit.code !== 0;
  const draftsFailed = validation.some(draft => draft.state !== 'written' || draft.violations.length > 0);
  let exitCode = 0;
  if (agentFailed || draftsFailed || reportHasChanges(report)) exitCode = 1;
  if (reportHasChanges(changesDuringReview)) exitCode = 1;

  // Reviewer verdicts inform the human and never change the exit code; changes they made do.
  return { exitCode, outcome: 'ran', files, launched: true, agentExit, report, validation, review };
}

/** CLI entry: run the pass and hand back the process exit code. */
export async function bootstrapDocs(options: BootstrapDocsOptions = {}): Promise<number> {
  const result = await runBootstrapDocs(options);
  return result.exitCode;
}
