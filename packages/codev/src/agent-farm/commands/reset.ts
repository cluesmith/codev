/**
 * `afx refresh` — the command surface over the refresh state machine (Spec 1273).
 *
 * This file is deliberately thin. It does three things and nothing else:
 * resolves the target, binds REAL implementations to the orchestrator's ports,
 * and prints the report. Every decision, every ordering rule and every refusal
 * lives in `reset/index.ts`, where it is testable without Tower, a PTY, or a
 * live builder.
 *
 * That split is the point. The dangerous part of a refresh is the ordering, and
 * ordering is only provable if the thing that decides it has no I/O in it.
 *
 * Addressing, workspace detection and sender identity are reused verbatim from
 * `afx send` — there is exactly one address resolver (the same rule `afx
 * interrupt` follows).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { TowerClient } from '../lib/tower-client.js';
import { logger, fatal } from '../utils/logger.js';
import { findBuilderById } from '../lib/builder-lookup.js';
import { getConfig } from '../utils/index.js';
import { loadConfig } from '../../lib/config.js';
import { loadForgeConfig } from '../../lib/forge.js';
import { fetchIssue as fetchForgeIssue } from '../../lib/github.js';
import { buildPromptFromTemplate, buildResumeNotice } from './spawn-roles.js';
import { detectWorkspaceRoot, detectCurrentBuilderId } from './send.js';
import { buildContextFsPort, resolveBuilderContext } from './reset/context.js';
import {
  formatResetReport,
  runReset,
  ResetPreflightError,
  type ClockPort,
  type ResetFsPort,
  type TerminalPort,
} from './reset/index.js';
import type { IssuePayload } from './reset/reorient.js';
import type { CustomHarnessConfig } from '../utils/harness.js';
import type { ResetOptions } from '../types.js';

/** Same cap `afx send --file` enforces. One rule for architect-supplied files. */
const MAX_FILE_SIZE = 48 * 1024;

/**
 * The one-line notice `afx reset` prints before doing the work (#1489).
 *
 * Exported so the deprecation is pinned by a test rather than by whoever
 * happens to read the CLI wiring: an alias that stops announcing itself is an
 * alias nobody migrates off, and this one is scheduled for removal.
 */
export const RESET_ALIAS_NOTICE =
  'afx reset has been renamed to afx refresh; this alias will be removed in a future release';

/**
 * Announce the deprecated spelling on **stderr**.
 *
 * stdout carries the run report, which is read by humans and occasionally piped;
 * a deprecation line does not belong in it.
 */
export function warnResetAlias(): void {
  process.stderr.write(`${RESET_ALIAS_NOTICE}\n`);
}

export async function refresh(options: ResetOptions): Promise<void> {
  const target = options.builder;
  if (!target) {
    fatal('Must specify a builder. Usage: afx refresh <builder>');
  }

  logger.header('Builder Context Refresh');

  const workspace = detectWorkspaceRoot() ?? undefined;

  let from: string;
  try {
    from = detectCurrentBuilderId() ?? 'architect';
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  }

  // `findBuilderById`, NOT `getBuilder`: the latter matches the id EXACTLY, so
  // `afx refresh 1273` would fail against a builder registered as `aspir-1273`
  // while `afx send 1273` reached it fine. Refresh must resolve targets the same
  // way every other builder-addressed command does — a refresh that cannot be
  // addressed the way the architect already types addresses is one that
  // gets typed wrong under pressure. `findBuilderById` also reports AMBIGUOUS
  // with the candidate list rather than silently picking one.
  const builder = findBuilderById(target);
  if (!builder) {
    fatal(
      `No builder '${target}' in this workspace (or the id is ambiguous — see above). ` +
        `Check 'afx status'. Refresh needs the registry row for the worktree and branch.`,
    );
  }
  if (!builder.worktree || !builder.branch) {
    fatal(
      `Builder '${target}' has an incomplete registry row (worktree='${builder.worktree}', ` +
        `branch='${builder.branch}'). Refusing to refresh against unresolved state.`,
    );
  }

  const client = new TowerClient();
  if (!(await client.isRunning())) {
    fatal('Tower is not running. Start it with: afx tower start');
  }

  const addendum = buildAddendum(options);
  const config = getConfig();
  const userConfig = loadConfig(config.workspaceRoot);

  const context = resolveBuilderContext({
    // Shared implementation — see `reset/context.ts`. Three hand-rolled copies
    // of this port existed, and a stub in any one silently nulled the porch
    // context for that path.
    fs: buildContextFsPort(),
    builderId: builder.id,
    worktree: builder.worktree,
    branch: builder.branch,
    issueNumber: builder.issueNumber === undefined ? undefined : String(builder.issueNumber),
    taskText: builder.taskText,
    modeOverride: options.mode,
    customHarnesses: userConfig?.harness as Record<string, CustomHarnessConfig> | undefined,
  });

  const terminal: TerminalPort = buildTerminalPort(client, builder.terminalId, target, from, workspace);

  try {
    const result = await runReset({
      context,
      fs: buildFsPort(),
      clock: realClock,
      terminal,
      buildSpawnPrompt: (protocol, templateContext) =>
        buildPromptFromTemplate(config, protocol, templateContext),
      buildResumeNotice,
      issue: await fetchIssuePayload(context.issueNumber, config.workspaceRoot),
      addendum,
      dryRun: options.dryRun,
      interruptFirst: options.interruptFirst,
      receiptTimeoutMs: options.timeout ? options.timeout * 1000 : undefined,
      minBytes: options.minBytes,
      quietWindowMs: options.quietWindow,
    });

    if (result.outcome === 'dry-run') {
      logger.info('DRY RUN — nothing was written to the builder.\n');
      logger.info('--- save request (what the builder is asked to write) ---');
      console.log(result.saveRequest);
      logger.info('--- inline re-orientation ---');
      console.log(result.payload?.inline ?? '');
      logger.info(`--- long form would be written to ${result.reorientPath} ---`);
      console.log(result.payload?.longForm ?? '');
      return;
    }

    console.log(formatResetReport(result));

    if (result.outcome === 'aborted') {
      // Non-zero: an aborted refresh is a failure the caller must see, even though
      // it is the SAFE outcome. Silence here would let a script treat "refused
      // to clear" as "cleared".
      process.exitCode = 1;
      return;
    }

    logger.success(`Builder ${target} refreshed and re-oriented.`);
    logger.info(`State file: ${result.statePath} (${result.stateBytes} bytes)`);
  } catch (err) {
    if (err instanceof ResetPreflightError) {
      fatal(err.message);
    }
    fatal(err instanceof Error ? err.message : String(err));
  }
}

// ============================================================================
// Port bindings
// ============================================================================

const realClock: ClockPort = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

function buildFsPort(): ResetFsPort {
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
  };
}

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function buildTerminalPort(
  client: TowerClient,
  terminalId: string | undefined,
  target: string,
  from: string,
  workspace: string | undefined,
): TerminalPort {
  return {
    async observe() {
      if (!terminalId) return { exists: false };
      const t = await client.getTerminal(terminalId);
      if (!t || t.status !== 'running') return { exists: false };
      // Both optional fields are forwarded AS-IS, including undefined. The
      // orchestrator distinguishes "reported false" from "not reported", and
      // collapsing either to a concrete value here would defeat that check at
      // the boundary — `lastDataAt: 0` reads as decades of silence, and
      // `writable: true` would assert a fact this Tower never supplied.
      return { exists: true, lastDataAt: t.lastDataAt, writable: t.writable };
    },
    async sendMessage(message: string) {
      const result = await client.sendMessage(target, message, {
        from,
        workspace,
        fromWorkspace: workspace,
      });
      if (!result.ok) throw new Error(result.error || 'Message delivery failed');
    },
    /**
     * `raw: true`, NOT `escape: true`.
     *
     * Tower's escape route writes a hardcoded ESC and discards the message
     * body, so binding this to `escape` would silently turn `/clear` into an
     * interrupt: the run would report success while the builder kept its
     * entire context. `raw` types the text as literal input, which is what the
     * verified manual recipe used.
     */
    async sendRaw(text: string) {
      const result = await client.sendMessage(target, text, {
        from,
        workspace,
        fromWorkspace: workspace,
        raw: true,
      });
      if (!result.ok) throw new Error(result.error || 'Raw write failed');
    },
    async sendEscape() {
      const result = await client.sendMessage(target, '\x1b', {
        from,
        workspace,
        fromWorkspace: workspace,
        escape: true,
      });
      if (!result.ok) throw new Error(result.error || 'Interrupt (ESC) failed');
    },
    /**
     * Bound for real, not left undefined.
     *
     * When this was absent the orchestrator's `confirmClear` returned false on
     * every production run, so the report always said "clear-unconfirmed" — a
     * step that looked attempted and could never succeed outside tests.
     *
     * Returns `total` alongside the lines so confirmation can look only at
     * output produced AFTER the clear. Reset writes into this same terminal, so
     * without that window any pattern eventually matches reset's own text.
     */
    async readOutput() {
      if (!terminalId) return null;
      const output = await client.getTerminalOutput(terminalId, 200);
      return output ? { lines: output.lines, total: output.total } : null;
    },
  };
}

// ============================================================================
// Inputs
// ============================================================================

/**
 * Assemble the architect addendum from `--note` and `--file`.
 *
 * `--file` reads from the CALLER's filesystem, exactly as `afx send --file`
 * does, and reuses its 48KB cap. The worktree-containment rule applies to the
 * state-file path override, not to this — the architect is reading their own
 * notes, not instructing the builder where to write.
 */
function buildAddendum(options: ResetOptions): string | undefined {
  const parts: string[] = [];
  if (options.note) parts.push(options.note);
  if (options.file) {
    if (!existsSync(options.file)) {
      fatal(`File not found: ${options.file}`);
    }
    const buf = readFileSync(options.file);
    if (buf.length > MAX_FILE_SIZE) {
      fatal(`File too large: ${buf.length} bytes (max ${MAX_FILE_SIZE} bytes / 48KB)`);
    }
    parts.push(buf.toString('utf-8'));
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Fetch issue metadata for the long form, best-effort.
 *
 * A forge outage must not block a refresh: phase 5 renders an explicit "could not
 * be fetched" gap with a `gh issue view` recovery line, which is strictly better
 * than aborting a refresh the architect needs, and strictly better than silently
 * omitting requirements.
 */
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
    return undefined;
  }
}
