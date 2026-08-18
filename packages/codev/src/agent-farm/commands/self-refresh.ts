/**
 * `afx self-refresh` — the builder-side command surface (Spec 1470, Phase 4).
 *
 * Deliberately thin, exactly like `reset.ts`: resolve identity, bind real
 * implementations to the orchestrator's ports, print the report. Every decision,
 * every ordering rule and every refusal lives in `reset/self.ts`, where it is
 * testable without Tower, a PTY, or a live builder.
 *
 * ## Why this is a separate command, not a flag on `afx refresh`
 *
 * `afx refresh <builder>` takes a target. This one takes **no positional
 * argument at all**, and that is a safety property rather than a style choice:
 * with nothing to pass, there is nothing to point at another session. A
 * `--self` flag on the existing command would have left the target parameter
 * present and merely ignored, which is a rule that can be broken by a future
 * edit. `--begin` is a MODE flag, not a target, so the two-step handshake
 * preserves the property.
 *
 * ## Identity is derived, never supplied
 *
 * `detectCurrentBuilderId()` resolves from the worktree path against the shared
 * `global.db` and THROWS rather than falling back — the #1094 anti-spoofing
 * path, built because a silent bare-name fallback once misrouted builder
 * messages to `main`. Refusing here is right: a refresh that cannot prove whose
 * context it is about to destroy must not proceed.
 *
 * ## What Phase 3's reviews told this file to do
 *
 * - Always pass `expectedBoundary`. An optional guard is opt-in, and an opt-in
 *   guard protects nobody by default.
 * - Validate every safety flag at the boundary, as `afx refresh` does. Each one
 *   tunes a gate, so a bad value disables a protection while still reporting
 *   success. The core validates too; the two catch different mistakes (a human
 *   typing a flag versus code passing an argument).
 * - Introduce NO Tower call that can fail AFTER the clear. `scheduleReentry` is
 *   the only Tower touch before it, and that is load-bearing: a call added later
 *   in the sequence could fail once the context is already gone.
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TowerClient } from '../lib/tower-client.js';
import { logger, fatal } from '../utils/logger.js';
import { findBuilderById } from '../lib/builder-lookup.js';
import { getConfig } from '../utils/index.js';
import { loadConfig } from '../../lib/config.js';
import { fetchIssue as fetchForgeIssue } from '../../lib/github.js';
import { loadForgeConfig } from '../../lib/forge.js';
import { buildPromptFromTemplate, buildResumeNotice } from './spawn-roles.js';
import { detectWorkspaceRoot, detectCurrentBuilderId } from './send.js';
import { resolveBuilderContext } from './reset/context.js';
import {
  MIN_ALLOWED_MIN_BYTES,
  MIN_ALLOWED_REENTRY_DELAY_SECONDS,
  MIN_ALLOWED_STABILITY_WINDOW_MS,
} from './reset/constants.js';
import {
  beginSelfRefresh,
  formatSelfRefreshReport,
  runSelfRefresh,
  type SelfGitPort,
  type SelfRefreshClockPort,
  type SelfRefreshFsPort,
  type SelfTerminalPort,
} from './reset/self.js';
import type { IssuePayload } from './reset/reorient.js';
import type { CustomHarnessConfig } from '../utils/harness.js';
import type { SelfRefreshOptions } from '../types.js';

// ============================================================================
// Entry point
// ============================================================================

export async function selfRefresh(options: SelfRefreshOptions): Promise<void> {
  logger.header(options.begin ? 'Context Refresh — Begin' : 'Context Refresh');

  // ------------------------------------------------------------------
  // Flag validation, before anything reads state.
  // ------------------------------------------------------------------
  // Same reasoning `afx refresh` documents for its own flags: every one of
  // these tunes a SAFETY GATE, so a bad value does not degrade the run — it
  // disables a protection while still reporting success. `--min-bytes 0`
  // accepts an empty save; a non-positive stability window collapses the
  // two-observation check into one read.
  // FLOORS, not merely positivity. A small positive value neuters the gate it
  // configures while still reporting success — and `--delay 0.001` is the fatal
  // direction, because the re-entry and the clear then race for the same clean
  // prompt. If the re-entry lands first it is delivered and immediately wiped:
  // a cleared builder with nobody coming back.
  const minBytes = boundedInt(options.minBytes, '--min-bytes', MIN_ALLOWED_MIN_BYTES);
  const delaySeconds = boundedInt(
    options.delay,
    '--delay',
    MIN_ALLOWED_REENTRY_DELAY_SECONDS,
  );
  const stabilityWindowMs = boundedInt(
    options.stabilityWindow,
    '--stability-window',
    MIN_ALLOWED_STABILITY_WINDOW_MS,
  );
  const challengeMaxAgeMs = boundedInt(options.challengeMaxAge, '--challenge-max-age', 1);

  // ------------------------------------------------------------------
  // Identity — derived from the worktree, never supplied.
  // ------------------------------------------------------------------
  const workspace = detectWorkspaceRoot() ?? undefined;

  let builderId: string | null;
  try {
    builderId = detectCurrentBuilderId();
  } catch (err) {
    // BuilderIdResolutionError carries the specific reason (#1094). Surface it
    // verbatim: "could not resolve identity" alone would leave the operator
    // guessing between a stale worktree, a missing DB, and an unregistered row.
    fatal(err instanceof Error ? err.message : String(err));
    return;
  }

  if (!builderId) {
    fatal(
      'afx self-refresh must be run from inside a builder worktree — this is a builder ' +
        'refreshing ITSELF. To refresh a different builder from outside, use `afx refresh <builder>`.',
    );
    return;
  }

  const builder = findBuilderById(builderId);
  if (!builder) {
    fatal(
      `Resolved builder id '${builderId}' from this worktree, but no matching registry row ` +
        `exists. Refusing to refresh against unresolved state.`,
    );
    return;
  }
  if (!builder.worktree || !builder.branch) {
    fatal(
      `Builder '${builderId}' has an incomplete registry row (worktree='${builder.worktree}', ` +
        `branch='${builder.branch}'). Refusing to refresh against unresolved state.`,
    );
    return;
  }

  const config = getConfig();
  const userConfig = loadConfig(config.workspaceRoot);
  const fs = buildFsPort();

  // ------------------------------------------------------------------
  // begin — mint the challenge and print what to write.
  // ------------------------------------------------------------------
  if (options.begin) {
    // No Tower needed: begin writes one file and prints. Requiring a live Tower
    // here would make the harmless half of the handshake fail for a reason that
    // only matters to the destructive half.
    const result = beginSelfRefresh({
      fs,
      clock: realClock,
      worktree: builder.worktree,
      boundary: options.boundary,
    });

    logger.success(`Challenge issued (${result.nonce}).`);
    logger.info(`Write your working state to: ${result.statePath}`);
    console.log('');
    console.log(result.saveRequest);
    console.log('');
    logger.info('When the file is written, run: afx self-refresh');
    return;
  }

  // ------------------------------------------------------------------
  // execute — verify, assemble, schedule, clear.
  // ------------------------------------------------------------------
  const client = new TowerClient();
  if (!(await client.isRunning())) {
    fatal(
      'Tower is not running, so the post-clear re-entry cannot be scheduled. Refusing to ' +
        'clear — a cleared builder with no re-entry is a builder nobody is coming back for. ' +
        'Start it with: afx tower start',
    );
    return;
  }

  const context = resolveBuilderContext({
    fs: {
      exists: (p: string) => existsSync(p),
      read: (p: string) => safeRead(p),
      listDirs: () => [],
    },
    builderId: builder.id,
    worktree: builder.worktree,
    branch: builder.branch,
    issueNumber: builder.issueNumber === undefined ? undefined : String(builder.issueNumber),
    taskText: builder.taskText,
    modeOverride: options.mode,
    customHarnesses: userConfig?.harness as Record<string, CustomHarnessConfig> | undefined,
  });

  const result = await runSelfRefresh({
    fs,
    clock: realClock,
    terminal: buildSelfTerminalPort(client, builder.id, workspace),
    git: buildGitPort(builder.worktree),
    context,
    buildSpawnPrompt: (protocol, templateContext) =>
      buildPromptFromTemplate(config, protocol, templateContext),
    buildResumeNotice,
    issue: await fetchIssuePayload(context.issueNumber, config.workspaceRoot),
    addendum: options.note,
    minBytes,
    stabilityWindowMs,
    challengeMaxAgeMs,
    reentryDelaySeconds: delaySeconds,
    dryRun: options.dryRun,
    allowDirty: options.allowDirty,
    // ALWAYS passed, never conditional. An optional guard that callers may omit
    // is a guard that protects nobody by default; when the caller has no
    // boundary, `undefined` is an explicit "no expectation" rather than a
    // forgotten argument.
    expectedBoundary: options.boundary,
  });

  console.log(formatSelfRefreshReport(result));

  if (result.outcome === 'dry-run') {
    console.log('');
    logger.info('--- inline re-entry (what would arrive after the clear) ---');
    console.log(result.payload?.inline ?? '');
    return;
  }

  if (result.outcome === 'aborted') {
    // Non-zero even though refusing is the SAFE outcome: silence here would let
    // a caller read "refused to clear" as "cleared and fine".
    process.exitCode = 1;
    return;
  }
}

// ============================================================================
// Flag validation
// ============================================================================

/**
 * Reject a safety flag that is non-numeric, fractional, or below its floor.
 *
 * Modelled on `afx refresh`'s guard and extended past it. That one checks
 * positivity, which is VALIDITY; these gates need SANITY. `--min-bytes 1`
 * reduces the substance check to "contains the nonce"; `--stability-window 1`
 * makes the sleep a single event-loop tick, which detects nothing; and
 * `--delay 0.001` risks the unrecoverable outcome the whole ordering exists to
 * avoid.
 *
 * Integers only, despite `Number` accepting `0.001` happily — every one of these
 * is a count of bytes, milliseconds or seconds, and a fractional value is a typo
 * rather than an intent.
 */
function boundedInt(
  raw: string | number | undefined,
  flag: string,
  floor: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(parsed)) {
    fatal(`${flag} must be a whole number, got '${raw}'`);
  }
  if (parsed < floor) {
    fatal(
      `${flag} must be at least ${floor}, got '${raw}'. Values below that disable the ` +
        `protection this flag configures instead of failing loudly.`,
    );
  }
  return parsed;
}

// ============================================================================
// Port bindings
// ============================================================================

const realClock: SelfRefreshClockPort = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
  /**
   * Monotonic, deliberately distinct from `now()`.
   *
   * `Date.now()` can step forward under NTP, which would make the measured
   * stability gap satisfy the check when no real time had passed — spoofing the
   * measurement that was introduced precisely to stop the gap being asserted on
   * faith. Timestamps still use the wall clock, because `issuedAt` is compared
   * across processes.
   */
  monotonicNow: () => performance.now(),
};

function buildFsPort(): SelfRefreshFsPort {
  return {
    read: (p: string) => safeRead(p),
    sizeOf: (p: string) => {
      try {
        return statSync(p).size;
      } catch {
        return null;
      }
    },
    write: (p: string, content: string) => writeFileSync(p, content, 'utf-8'),
    remove: (p: string) => unlinkSync(p),
  };
}

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Tracked-changes check.
 *
 * `--quiet` + exit code, not porcelain parsing: we want the single boolean
 * "are there uncommitted TRACKED changes", and `git diff --quiet` answers it
 * without us classifying paths. Untracked files are invisible to it, which is
 * the behaviour the gate wants — the worktree legitimately carries untracked
 * `.builder-*` scaffold, including the two files this very command writes.
 */
function buildGitPort(worktree: string): SelfGitPort {
  return {
    hasUncommittedTrackedChanges(): boolean {
      for (const args of [
        ['diff', '--quiet'],
        ['diff', '--cached', '--quiet'],
      ]) {
        try {
          execFileSync('git', args, { cwd: worktree, stdio: 'ignore' });
        } catch {
          return true; // non-zero exit = differences exist
        }
      }
      return false;
    },
  };
}

/**
 * The two ways this command touches its own terminal.
 *
 * NOTE the deliberate absence of anything else. Phase 3's review established
 * that `scheduleReentry` must remain the ONLY Tower call before the clear: a
 * call added later in the sequence could fail once the context is already gone,
 * and there would be nothing left to report it to.
 */
function buildSelfTerminalPort(
  client: TowerClient,
  selfId: string,
  workspace: string | undefined,
): SelfTerminalPort {
  return {
    /**
     * A normal, formatted message with `deliverAfter`.
     *
     * Not `raw`: this is prose the harness should render as a message. And not a
     * bare timer — `--delay` persists the body to the durable mailbox at request
     * time, so it survives a Tower restart, and the render gate holds it until
     * the prompt is verifiably clean.
     */
    async scheduleReentry(message: string, delaySeconds: number) {
      const result = await client.sendMessage(selfId, message, {
        from: selfId,
        workspace,
        fromWorkspace: workspace,
        deliverAfter: delaySeconds,
      });
      if (!result.ok) throw new Error(result.error || 'Re-entry scheduling failed');
    },
    /**
     * `raw: true`, NOT `escape: true` — the same trap `afx refresh` documents.
     *
     * Tower's escape route writes a hardcoded ESC and discards the body, so
     * binding this to `escape` would turn `/clear` into an interrupt: the run
     * would report success while the builder kept its entire context.
     */
    async sendRaw(text: string) {
      const result = await client.sendMessage(selfId, text, {
        from: selfId,
        workspace,
        fromWorkspace: workspace,
        raw: true,
      });
      if (!result.ok) throw new Error(result.error || 'Raw write failed');
    },
  };
}

// ============================================================================
// Issue metadata
// ============================================================================

async function fetchIssuePayload(
  issueNumber: string | undefined,
  workspaceRoot: string,
): Promise<IssuePayload | undefined> {
  if (!issueNumber) return undefined;
  try {
    const issue = await fetchForgeIssue(issueNumber, {
      cwd: workspaceRoot,
      forgeConfig: loadForgeConfig(workspaceRoot),
    });
    if (!issue) return undefined;
    return {
      number: issueNumber,
      title: issue.title,
      body: issue.body || '(No description provided)',
    };
  } catch {
    // A missing issue is surfaced inside the re-orientation itself, with a
    // recovery instruction. Failing the whole refresh over unreachable issue
    // metadata would trade a complete refresh for a cosmetic one.
    return undefined;
  }
}
