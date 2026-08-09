/**
 * Agent harness abstraction.
 *
 * Encapsulates how different agent CLI tools (Claude, Codex, etc.)
 * handle role/system prompt injection. Built-in providers cover Claude, Codex,
 * and OpenCode. Custom providers can be defined in .codev/config.json.
 *
 * The built-in Gemini CLI harness was retired in Issue #1338 (Google ended
 * consumer-tier Gemini CLI availability on 2026-06-18); selecting it now fails
 * closed with a retirement message instead of resolving a provider. See
 * RETIRED_HARNESSES below.
 *
 * Two integration patterns exist:
 * - Node spawn() call sites: use buildRoleInjection() → returns args + env
 * - Bash script generation: use buildScriptRoleInjection() → returns fragment + env
 *
 * @see codev/specs/591-af-workspace-failure-with-code.md
 */

import { dirname, join } from 'node:path';
import { findLatestSessionId, verifySessionOwnership } from './claude-session-discovery.js';
import {
  findLatestKimiSessionId,
  ensureKimiWorkspaceTrust,
  type KimiDiscoveryOpts,
} from './kimi-session-discovery.js';
import { buildWorktreeGuardFiles } from './worktree-write-guard.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Context for provider-owned builder launch scripts (Issue #1201).
 * Only harnesses whose CLI cannot take a role/prompt via argv implement
 * `buildBuilderLaunchScript` (currently Kimi); flag-shaped harnesses keep the
 * generic scripts in spawn-worktree.ts.
 */
export interface BuilderLaunchScriptContext {
  worktreePath: string;
  /** The resolved builder command string (may include user flags). */
  baseCmd: string;
  /**
   * The harness's own role fragment (`buildScriptRoleInjection().fragment`), or
   * '' when the spawn carries no role. Passed in rather than recomputed so the
   * provider-owned script and the generic shapes inject the role identically.
   */
  roleFragment: string;
  /**
   * Absolute path to `.builder-prompt.txt`, or null when the spawn has no
   * initial task (`afx spawn --worktree`). A provider whose CLI takes no
   * positional prompt delivers this some other way — Kimi queues it on the
   * mailbox — which is why it arrives as a path, not a baked-in string.
   */
  taskFile: string | null;
  /**
   * The builder id, for a provider that must address this builder at runtime
   * (Kimi queues its task with `afx send <builderId>`). Absent in worktree mode.
   */
  builderId?: string;
}

export interface HarnessProvider {
  /**
   * For Node spawn() call sites (architect.ts, tower-utils.ts).
   * Returns CLI args and env vars to inject the role.
   */
  buildRoleInjection(roleContent: string, roleFilePath: string): {
    args: string[];
    env: Record<string, string>;
  };

  /**
   * For bash script generation (spawn-worktree.ts).
   * Returns a shell fragment to append after the base command,
   * and env vars the caller should export before the command.
   */
  buildScriptRoleInjection(roleContent: string, roleFilePath: string): {
    fragment: string;
    env: Record<string, string>;
  };

  /**
   * Whether this harness can clear its conversation context in-session, without
   * restarting the process (Spec 1273 — `afx reset`).
   *
   * Optional, and absence means "no": a harness that has not declared support
   * must not be reset, and defaulting to unsupported is the safe direction. Only
   * Claude declares it today (`/clear`), which is why `afx reset` refuses other
   * harnesses loudly rather than improvising a substitute mechanism.
   */
  supportsContextReset?: boolean;

  /**
   * Optional: files to write in the worktree before launching the agent.
   * Used by harnesses that rely on file-based configuration (e.g., OpenCode
   * uses opencode.json's instructions field for role injection; Claude uses it
   * to install the worktree write-guard hook — Issue #1018).
   *
   * `worktreePath` is the absolute path to the builder's worktree, needed by
   * harnesses that bake worktree-specific values into generated files.
   */
  getWorktreeFiles?(roleContent: string, roleFilePath: string, worktreePath: string): Array<{
    relativePath: string;
    content: string;
  }>;

  /**
   * Optional: one-time side effects a harness needs OUTSIDE the worktree before
   * its first launch there (Issue #1201). Distinct from `getWorktreeFiles`,
   * which can only write files inside the worktree.
   *
   * Kimi is the only implementer: 0.33.0 added a startup "Trust this folder?"
   * dialog, and a builder worktree is always a new folder, so an unattended
   * builder would sit on that dialog forever. It pre-records trust in kimi's
   * own store. Implementations MUST be idempotent and fail-soft — a failure has
   * to degrade to the CLI's normal behavior, never abort a spawn.
   */
  prepareWorkspace?(worktreePath: string): void;

  /**
   * Optional: conversation-session support, for agents whose CLI can pin and
   * resume a session by id (Issue #832). Harnesses that omit this are treated as
   * having no resumable sessions — architects on those agents always spawn fresh
   * and nothing is persisted. Keeps agent-specific session flags out of Tower.
   *
   * This is the stored-UUID mechanism (architect resume): an id is minted at spawn,
   * pinned via `newSessionArgs`, persisted on the architect row, and replayed via
   * `resumeArgs`. It disambiguates siblings sharing one cwd, which `buildResume`
   * (mtime discovery) cannot. The two coexist: `buildResume` serves builder resume
   * and the legacy sole-architect fallback; `session` serves architect stored-UUID resume.
   */
  session?: {
    /** Args to START a new session pinned to `sessionId` (caller merges role injection). */
    newSessionArgs(sessionId: string): string[];
    /** Args to RESUME an existing session by id (caller skips role injection). */
    resumeArgs(sessionId: string): string[];
    /**
     * Optional: script-fragment forms of newSessionArgs/resumeArgs for bash
     * script generation (the builder launch loop — Issue #1233), mirroring the
     * dual-form convention of buildRoleInjection/buildScriptRoleInjection and
     * buildResume's args/scriptFragment pair.
     *
     * `idExpr` is a shell expression the caller has already quoted (e.g.
     * `"$codev_session_id"`), NOT a literal id: the generated loop re-mints ids
     * at runtime (clean-exit relaunch, unresumable-session degrade), so the
     * fragment must reference the script's variable rather than bake a value.
     *
     * BOTH must be present for the session-aware loop; a harness providing
     * neither keeps the historical prompt-replay restart loop.
     */
    newSessionScriptFragment?(idExpr: string): string;
    resumeScriptFragment?(idExpr: string): string;
    /**
     * Optional: verify that `sessionId` still has a resumable session on disk
     * for `cwd` before the caller resumes it (Issue #1145). Returns false when
     * the session file is gone (a stored id can outlive its jsonl); callers
     * then spawn fresh instead of baking a broken resume into a restart loop.
     * Harnesses that omit this are trusted as-is.
     */
    verifyOwnership?(sessionId: string, cwd: string, opts?: { homeDir?: string }): boolean;
  };

  /**
   * Optional: discover a resumable prior session for the given working dir and
   * return how to resume it — in BOTH forms, mirroring buildRoleInjection /
   * buildScriptRoleInjection:
   *   - args:           Node argv for spawn() call sites (architect launch)
   *   - scriptFragment: shell-escaped fragment for bash script generation (builder)
   * Returns null when no resumable session exists or this harness has no
   * cwd-keyed session store → callers fall back to a fresh launch. Only Claude
   * implements it (store: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl).
   *
   * Discovery-based (newest jsonl by mtime): used for builder resume
   * (#831/#929) ONLY. Architect launch never discovers — it resumes solely from
   * the stored session id on the workspace-scoped architect row, else spawns
   * fresh (Issue #1145: discovery on a fresh workspace hijacked whatever Claude
   * conversation the user last held in that directory).
   */
  buildResume?(absolutePath: string, opts?: { homeDir?: string }): {
    sessionId: string;
    args: string[];
    scriptFragment: string;
  } | null;

  /**
   * Optional: provider-owned builder launch script (Issue #1201). When present,
   * spawn-worktree.ts uses this INSTEAD of the generic
   * `${baseCmd} ${roleFragment} "<prompt>"` shapes.
   *
   * Kimi is the only implementer, for two reasons the generic shapes cannot
   * express: its CLI takes **no positional prompt** (so the task must reach it
   * through the mailbox, queued by the script whenever a fresh conversation
   * starts), and it mints conversation ids **server-side on the first message**
   * (so there is no id to pin at launch and the crash path resumes with the
   * cwd-scoped `-c` instead of `session.resumeScriptFragment`).
   *
   * A provider-owned script is still expected to honor the shared contract:
   * clean exit → keypress-gated FRESH relaunch (#1267/#1317), crash → resume,
   * repeated fast failures → degrade to fresh. Use {@link launchLoopTail} where
   * the generic tail fits.
   */
  buildBuilderLaunchScript?(ctx: BuilderLaunchScriptContext): string;

  /**
   * Optional: PTY message pacing for this harness's CLI (Issue #1201).
   * `enterDelayMs` overrides message-write.ts's default delayed-Enter timing —
   * CLIs with a longer paste-detection window (Kimi) silently swallow an
   * Enter that arrives too soon after the message body, so `afx send` never
   * submits without this.
   */
  messagePacing?: { enterDelayMs: number };
}

/** Custom harness definition from .codev/config.json */
export interface CustomHarnessConfig {
  roleArgs: string[];
  roleEnv?: Record<string, string>;
  roleScriptFragment: string;
  roleScriptEnv?: Record<string, string>;
}

/**
 * The tail shared by every builder launch loop, appended after the agent
 * invocation inside `while true; do … done`.
 *
 * Issue #1241: exit code 0 is the user deliberately quitting (double Ctrl+C,
 * `/quit`) — auto-respawning overrides that choice and forces them to race a
 * second Ctrl+C into the sleep window, where a mistimed one lands in the fresh
 * agent instead. It also feeds the #1224 class, where a respawn within ~2s
 * collides with the dying predecessor's session lock. So a clean exit clears
 * the screen and gates the relaunch on a keypress: recovery stays one keystroke
 * away without anything happening on its own. Nonzero exits and signal deaths
 * (bash reports those as 128+N) keep the historical auto-restart — that is what
 * the loop is for.
 *
 * `read` failing means EOF on stdin, i.e. the terminal is gone; exit rather
 * than spin the loop on an input that will never arrive.
 *
 * `onCleanExit` (Issue #1267) is an extra statement run just after the keypress,
 * before the loop repeats — how the resume variant switches itself over to the
 * fresh invocation. It sits *after* the `read`, so a terminal that went away
 * (EOF → `exit 0`) never mutates state on its way out.
 *
 * Lives here (not in spawn-worktree.ts, where it was introduced) so
 * provider-owned launch scripts — currently Kimi's `buildBuilderLaunchScript`
 * — share the exact same tail as the generic shapes without a circular import
 * (spawn-worktree.ts already imports from this module). Issue #1201's first
 * pass duplicated the tail into the Kimi loops and drifted from it the moment
 * #1244 changed the contract; one definition is what stops that recurring.
 */
export function launchLoopTail(onCleanExit?: string): string {
  const switchToFresh = onCleanExit ? `\n    ${onCleanExit}` : '';
  return `  status=$?
  if [ "$status" -eq 0 ]; then
    clear
    echo "Agent exited at your request. Press Enter to relaunch fresh, or close this terminal."
    read -r || exit 0${switchToFresh}
    continue
  fi
  echo ""
  echo "Agent exited (code $status). Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2`;
}

// =============================================================================
// Built-in providers
// =============================================================================

export const CLAUDE_HARNESS: HarnessProvider = {
  // Spec 1273: `/clear` empties the conversation while leaving the process — and
  // therefore the --append-system-prompt role below — intact. That is what makes
  // an in-session reset possible here and nowhere else today.
  supportsContextReset: true,
  buildRoleInjection: (content, _filePath) => ({
    args: ['--append-system-prompt', content],
    env: {},
  }),
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: `--append-system-prompt "$(cat '${shellEscapeSingleQuote(filePath)}')"`,
    env: {},
  }),
  buildResume: (absolutePath, opts) => {
    const sessionId = findLatestSessionId(absolutePath, opts);
    if (!sessionId) return null;
    return {
      sessionId,
      args: ['--resume', sessionId],
      scriptFragment: `--resume '${shellEscapeSingleQuote(sessionId)}'`,
    };
  },
  // Install the worktree write-guard PreToolUse hook (Issue #1018) so a builder
  // cannot silently write outside its worktree (e.g. into the main checkout).
  getWorktreeFiles: (_content, _filePath, worktreePath) =>
    buildWorktreeGuardFiles(worktreePath),
  // Issue #832: Claude pins/resumes a conversation by UUID and stores each session
  // as ~/.claude/projects/<encoded-cwd>/<id>.jsonl.
  session: {
    newSessionArgs: (sessionId) => ['--session-id', sessionId],
    resumeArgs: (sessionId) => ['--resume', sessionId],
    // Issue #1233: script-fragment forms for the builder crash-resume loop.
    // `idExpr` arrives pre-quoted (a shell variable reference, not a literal).
    newSessionScriptFragment: (idExpr) => `--session-id ${idExpr}`,
    resumeScriptFragment: (idExpr) => `--resume ${idExpr}`,
    // Issue #1145: a stored id is only resumed when its jsonl still exists
    // under this cwd's project dir (stale ids degrade to a fresh spawn).
    verifyOwnership: (sessionId, cwd, opts) => verifySessionOwnership(cwd, sessionId, opts),
  },
};

export const CODEX_HARNESS: HarnessProvider = {
  buildRoleInjection: (_content, filePath) => ({
    args: ['-c', `model_instructions_file=${filePath}`],
    env: {},
  }),
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: `-c model_instructions_file='${shellEscapeSingleQuote(filePath)}'`,
    env: {},
  }),
};

export const OPENCODE_HARNESS: HarnessProvider = {
  buildRoleInjection: () => {
    throw new Error(
      'OpenCode is only supported as a builder shell, not as an architect shell. ' +
      'OpenCode uses file-based role injection (opencode.json instructions field) ' +
      'which requires an ephemeral worktree. Configure a different shell for ' +
      'the architect (e.g., "claude --dangerously-skip-permissions").',
    );
  },
  buildScriptRoleInjection: () => ({ fragment: '', env: {} }),
  getWorktreeFiles: () => ([{
    relativePath: 'opencode.json',
    content: JSON.stringify({ instructions: ['.builder-role.md'] }, null, 2) + '\n',
  }]),
};

// =============================================================================
// Kimi (Issue #1201 — builder-only)
// =============================================================================

/**
 * The agent-definition file the Kimi builder launches with (`--agent-file`).
 * Written into the worktree by {@link KIMI_HARNESS.getWorktreeFiles}; distinct
 * from `.builder-role.md` (the raw role every harness writes) because kimi
 * needs frontmatter and a template body around it.
 */
export const KIMI_AGENT_FILE = '.builder-role-agent.md';

/**
 * Delayed-Enter timing for Kimi PTYs. Kimi's paste-detection window is longer
 * than Claude's: an Enter arriving too soon after the message body is treated
 * as part of a paste and NOT submitted. Bisected live against kimi 0.27.0
 * (PIR #1201): 80ms and 100ms fail; 120ms, 250ms, 500ms, 1000ms submit —
 * threshold ≈ 100–120ms. Pinned at 1000ms for ~9x margin; re-verified
 * submitting on 0.34.0 (agent-core-v2). The only cost is submission latency,
 * which is irrelevant for agent-to-agent messages. Applied via messagePacing.
 */
export const KIMI_ENTER_DELAY_MS = 1000;

/** Map the shared `homeDir` test-seam option onto the Kimi store location. */
function kimiOpts(opts?: { homeDir?: string }): KimiDiscoveryOpts | undefined {
  return opts?.homeDir ? { kimiHome: join(opts.homeDir, '.kimi-code') } : undefined;
}

/**
 * Compose the `--agent-file` body: kimi's agent-definition format is YAML
 * frontmatter plus a system-prompt template.
 *
 * `${base_prompt}` is the load-bearing token — it interpolates kimi's own
 * default system prompt, so the role EXTENDS the agent's instructions instead
 * of replacing them (the `claude --append-system-prompt` analogue). Without it
 * the builder would lose kimi's tool-use and safety preamble wholesale.
 * Verified on 0.34.0 in both `-p` and interactive TUI mode
 * (`codev/spikes/pir-1201-kimi-agentfile-probe.mjs`).
 */
export function buildKimiAgentFile(roleContent: string): string {
  return `---
name: codev-builder
description: Codev builder role, injected at spawn by Agent Farm.
---
\${base_prompt}

# Your Role

${roleContent}
`;
}

/**
 * Append --yolo (auto-approve tools; the Kimi analog of
 * `claude --dangerously-skip-permissions`) unless the user already passed it.
 * `--auto` is deliberately NOT used: it suppresses agent→user questions, which
 * the gate/Q&A workflow depends on, and it conflicts with --yolo (documented).
 */
function kimiTuiCmd(baseCmd: string): string {
  return baseCmd.includes('--yolo') ? baseCmd : `${baseCmd} --yolo`;
}

/**
 * Runtime guard for the crash-resume path, emitted into the launch script.
 *
 * `kimi -c` does NOT fail when there is nothing to continue — it prints
 * "No sessions to continue under <cwd>; starting a fresh session." and starts a
 * fresh one anyway (verified, 0.34.0). That fresh session never saw
 * `--agent-file` (illegal alongside `-c`), so it would run **roleless** — the
 * #929 hazard class, silently. So the loop only takes the `-c` path once a
 * session provably exists for this cwd.
 *
 * 0.33.0's TUI mints no session at startup (verified) — the FIRST MESSAGE mints
 * it — so "has the task landed yet?" and "is there anything to resume?" are the
 * same question, and this probe answers it directly from the store.
 *
 * Fails CLOSED: any error (no store, unreadable dir, malformed JSON) exits
 * non-zero and the loop relaunches fresh WITH the role, which is always safe.
 *
 * It mirrors {@link findLatestKimiSessionId} field for field — `cwd ?? workDir`,
 * `sameDir`'s realpath tolerance, and `isResumable`'s archived / `session_`
 * filters — because the two answer the same question in two languages and a
 * divergence is a silent bug in EITHER direction: a probe that says yes where
 * discovery says no sends `-c` down its roleless nothing-to-continue path, and a
 * probe that says no where discovery says yes restarts a crashed builder with no
 * context and re-queues its task. The generated snippet is pinned against fixture
 * stores by a unit test that EXECUTES it and cross-checks both answers, so the
 * mirroring cannot rot.
 */
const KIMI_HAS_SESSION_PROBE =
  'const {readdirSync,readFileSync,realpathSync}=require("fs"),{join}=require("path");' +
  'const r=join(process.env.KIMI_CODE_HOME||join(require("os").homedir(),".kimi-code"),"sessions");' +
  // Mirrors sameDir(): compare canonicalized paths, falling back to the literal
  // when realpath fails, so a symlinked worktree or a trailing slash still matches.
  'const n=p=>{p=String(p).replace(/\\/+$/,"")||"/";try{return realpathSync(p)}catch{return p}};' +
  'const a0=process.argv[1],c=n(a0);' +
  'let ws=[];try{ws=readdirSync(r,{withFileTypes:true}).filter(e=>e.isDirectory())}catch{}' +
  'for(const w of ws){let ss=[];' +
  // Each level gets its OWN try. A stray non-directory under sessions/ (a
  // .DS_Store) made readdirSync throw ENOTDIR into the single outer try, which
  // aborted the WHOLE scan — one junk file silently disabled resume for every
  // worktree on the machine.
  'try{ss=readdirSync(join(r,w.name),{withFileTypes:true})' +
  '.filter(e=>e.isDirectory()&&e.name.startsWith("session_"))}catch{continue}' +
  'for(const s of ss){try{const j=JSON.parse(readFileSync(join(r,w.name,s.name,"state.json"),"utf8"));' +
  'if(j.archived===true)continue;const d=j.cwd??j.workDir;' +
  'if(typeof d==="string"&&(d===a0||n(d)===c))process.exit(0)}catch{}}}' +
  'process.exit(1)';

export const KIMI_HARNESS: HarnessProvider = {
  buildRoleInjection: () => {
    throw new Error(
      'Kimi is only supported as a builder shell, not as an architect shell ' +
      '(stage 2 — see issue #1201). Kimi takes no inline system-prompt argument: ' +
      'its role mechanism is "--agent-file <path>", which needs a file written ' +
      'into the agent\'s directory first — a seam only the builder launch path ' +
      'has. Configure a different shell for the architect ' +
      '(e.g., "claude --dangerously-skip-permissions" or "codex").',
    );
  },
  // Role rides `--agent-file` (kimi 0.31.0+), pointed at the agent-definition
  // file getWorktreeFiles writes next to the raw role. `filePath` is
  // `<worktree>/.builder-role.md`, so its directory is the worktree.
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: `--agent-file '${shellEscapeSingleQuote(join(dirname(filePath), KIMI_AGENT_FILE))}'`,
    env: {},
  }),

  // One file: the `--agent-file` definition (role + ${base_prompt}), written next
  // to the raw `.builder-role.md` every harness gets. A roleless spawn writes
  // nothing — there is no Kimi-launch MARKER any more. The first pass had one
  // (`.builder-kimi`) for Tower's pacing probe, and it obliged every launch shape
  // to remember to write it — an obligation the bare shape missed, which cost a
  // maintainer review cycle. Pacing now reads the harness out of the generated
  // `.builder-start.sh` instead (see resolvePacingForSession in mailbox-wiring.ts):
  // same override-proof answer, derived from an artifact that cannot be forgotten
  // because the launcher itself is the artifact.
  getWorktreeFiles: (roleContent) => (
    roleContent
      ? [{ relativePath: KIMI_AGENT_FILE, content: buildKimiAgentFile(roleContent) }]
      : []
  ),

  // Builder resume (afx spawn --resume). Discovery answers one question — does
  // a conversation exist for exactly this worktree? — and the ANSWER, not the
  // id, is what the script uses: the relaunch runs the documented cwd-scoped
  // `kimi -c`, so no undocumented id is baked into the generated bash. The id
  // still rides the return value because callers log it and `spawn.ts` treats a
  // null as "nothing to resume" (→ a fresh, role-carrying launch).
  //
  // #1145 semantics hold: the store records each session's exact cwd, and a
  // builder worktree belongs to one builder, so a match cannot be some other
  // conversation the user happened to hold in the same directory.
  buildResume: (absolutePath, opts) => {
    const sessionId = findLatestKimiSessionId(absolutePath, kimiOpts(opts));
    if (!sessionId) return null;
    return {
      sessionId,
      args: ['-c'],
      scriptFragment: '-c',
    };
  },

  // 0.33.0's folder-trust dialog would block an unattended builder before its
  // composer ever renders; pre-record trust for the worktree Codev just made.
  // Idempotent and fail-soft — see ensureKimiWorkspaceTrust.
  prepareWorkspace: (worktreePath) => { ensureKimiWorkspaceTrust(worktreePath); },

  buildBuilderLaunchScript: (ctx) => {
    const tuiCmd = kimiTuiCmd(ctx.baseCmd);
    const fresh = ctx.roleFragment ? `${tuiCmd} ${ctx.roleFragment}` : tuiCmd;

    // Bare shape (no role, no task — `afx spawn --worktree`, or a spawn with
    // neither): the plain loop every session-less harness gets, byte for byte.
    // Nothing to pin, nothing to queue; a clean exit relaunches fresh because a
    // roleless kimi launch IS fresh. Pacing still resolves for this shape: `kimi`
    // sits in command position on its own line, which is what the launch-script
    // harness probe matches on.
    if (!ctx.taskFile) {
      return `#!/bin/bash
cd '${shellEscapeSingleQuote(ctx.worktreePath)}'
while true; do
  ${fresh}
${launchLoopTail()}
done
`;
    }

    // Task-carrying shape. kimi takes no positional prompt, so the task cannot
    // ride argv the way claude's does — it is queued on the Spec 1313 mailbox
    // and delivered by the render gate onto a verified-empty composer. That is
    // also why the queue call lives INSIDE the fresh launch: a fresh
    // conversation needs the task re-delivered, and only the script knows when
    // the loop starts one. It mirrors claude's prompt-on-fresh semantics
    // exactly, including on a script re-run.
    //
    // Never a direct PTY write (Spec 1313 forbids it for message writers), so a
    // busy line, a boot screen, or 0.33.0's folder-trust dialog simply holds the
    // message instead of corrupting or losing it.
    // Every interpolated value enters the script exactly once, inside a
    // single-quoted assignment escaped by shellEscapeSingleQuote — never inside
    // executable double-quoted text. The recovery hints then print the values
    // through `printf '%s\n'` with the shell VARIABLE expanded, because bash does
    // not re-scan an expansion for command substitution: a builder id or task
    // path containing a backtick or `$(…)` is printed literally instead of being
    // executed when the hint is shown (CMAP 2026-08-09, codex #3 / claude F3).
    const queueTask = `codev_builder_id='${shellEscapeSingleQuote(ctx.builderId ?? '')}'
codev_task_file='${shellEscapeSingleQuote(ctx.taskFile)}'
# Set once the task is on the mailbox, so a crash-restart loop cannot enqueue the
# same mission every two seconds while kimi is failing to start (the mailbox
# PERSISTS a held row — it does not need re-queueing to survive). Reset only on
# the human-gated clean-exit relaunch below, which is a deliberate new
# conversation and does want its task again.
codev_task_queued=0
codev_queue_task() {
  [ "$codev_task_queued" = 1 ] && return 0
  if ! command -v afx >/dev/null 2>&1; then
    printf '%s\\n' "WARNING: afx is not on PATH — the builder's task was not queued." >&2
    printf '%s\\n' "         Queue it with: afx send $codev_builder_id \\"\\$(cat $codev_task_file)\\"" >&2
    return 0
  fi
  if afx send "$codev_builder_id" "$(cat "$codev_task_file")" >/dev/null 2>&1; then
    codev_task_queued=1
    return 0
  fi
  printf '%s\\n' "WARNING: could not queue the builder's task (is Tower running?)." >&2
  printf '%s\\n' "         Retry with: afx send $codev_builder_id \\"\\$(cat $codev_task_file)\\"" >&2
}`;

    // Crash restart resumes the conversation (#1233's builder-side contract) via
    // the DOCUMENTED, cwd-scoped `-c` — no undocumented session id in the script.
    // Guarded by codev_has_session because `-c` with nothing to continue does not
    // fail: it starts a fresh session that never saw --agent-file, i.e. a
    // ROLELESS builder (verified, 0.34.0). The guard fails closed, so the
    // fallback is always the role-carrying fresh launch.
    return `#!/bin/bash
cd '${shellEscapeSingleQuote(ctx.worktreePath)}'
codev_fast_fail_secs="\${CODEV_LAUNCH_FAST_FAIL_SECS:-15}"

${queueTask}

codev_has_session() {
  node -e '${KIMI_HAS_SESSION_PROBE}' "$PWD" 2>/dev/null
}

codev_launch_fresh() {
  codev_queue_task
  ${fresh}
}

codev_launch_resume() {
  ${tuiCmd} -c
}

# Entry is self-configuring, which is what makes 'afx spawn --resume' and a
# Tower-side terminal re-create do the right thing without a second script
# shape: a worktree that already holds a conversation is resumed (and the task
# NOT re-queued); a virgin one starts fresh.
if codev_has_session; then
  codev_launch=codev_launch_resume
else
  codev_launch=codev_launch_fresh
fi
codev_fast_fails=0
while true; do
  codev_started=$SECONDS
  "$codev_launch"
  status=$?
  codev_elapsed=$(( SECONDS - codev_started ))
  if [ "$status" -eq 0 ]; then
    clear
    echo "Agent exited at your request. Press Enter to relaunch fresh, or close this terminal."
    read -r || exit 0
    codev_launch=codev_launch_fresh
    codev_task_queued=0
    codev_fast_fails=0
    continue
  fi
  if [ "$codev_elapsed" -lt "$codev_fast_fail_secs" ]; then
    codev_fast_fails=$(( codev_fast_fails + 1 ))
  else
    codev_fast_fails=0
  fi
  echo ""
  if [ "$codev_fast_fails" -ge 3 ]; then
    echo "Agent failing immediately (code $status). Starting a fresh conversation with the original task in 2 seconds... (Ctrl+C to quit)"
    codev_launch=codev_launch_fresh
    codev_fast_fails=0
  elif codev_has_session; then
    echo "Agent exited (code $status). Resuming the conversation in 2 seconds... (Ctrl+C to quit)"
    codev_launch=codev_launch_resume
  else
    echo "Agent exited (code $status) before starting a conversation. Relaunching fresh in 2 seconds... (Ctrl+C to quit)"
    codev_launch=codev_launch_fresh
  fi
  sleep 2
done
`;
  },

  messagePacing: { enterDelayMs: KIMI_ENTER_DELAY_MS },
};

/**
 * Exported for Spec 1273: `afx reset` identifies a running builder's harness from
 * its launch script and must check `supportsContextReset` before typing into the
 * terminal. It needs the name→provider map, not just the workspace default.
 */
export const BUILTIN_HARNESSES: Record<string, HarnessProvider> = {
  claude: CLAUDE_HARNESS,
  codex: CODEX_HARNESS,
  opencode: OPENCODE_HARNESS,
  kimi: KIMI_HARNESS,
};

/**
 * The built-in provider for `name`, or `undefined` when `name` is not a built-in
 * harness. Uses an own-property check — the same guard `isRetiredHarness` gives
 * `RETIRED_HARNESSES` — so inherited Object members (`constructor`, `toString`,
 * `hasOwnProperty`, `valueOf`, …) on a *user-controlled* name are never misread as
 * a provider. A bare `BUILTIN_HARNESSES[name]` for `name = 'constructor'` returns
 * `Object`'s constructor (a truthy function), which a `if (builtin) return builtin`
 * check would then hand back as a bogus "provider" that TypeErrors at the first
 * `buildRoleInjection` call. The name reaches here straight from config
 * (`shell.builderHarness` / a builder launch script), so the key is untrusted.
 */
export function getBuiltinHarness(name: string): HarnessProvider | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_HARNESSES, name)
    ? BUILTIN_HARNESSES[name]
    : undefined;
}

// =============================================================================
// Retired harnesses
// =============================================================================

/**
 * Built-in harness names Codev no longer supports, each mapped to the
 * explanation shown when a user still selects it.
 *
 * A retired name is intercepted on *every* `resolveHarness` exit — the explicit
 * path and the command auto-detect path — so it fails loudly and closed rather
 * than silently falling back to Claude (the Issue #929 mis-injection class) or
 * returning `undefined` (a `BUILTIN_HARNESSES[name]` miss → downstream
 * TypeError). See `resolveHarness` and Issue #1338.
 *
 * Escape hatch: a user who retains access to a retired CLI (e.g. an
 * enterprise/API-key Gemini subscription) can still wire it as a *custom*
 * harness in .codev/config.json — the retirement targets the built-in name,
 * not a user's own definition.
 */
export const RETIRED_HARNESSES: Record<string, string> = {
  gemini:
    'The built-in Gemini CLI harness is retired. Google ended Gemini CLI ' +
    'availability for consumer accounts (free, Pro, and Ultra tiers) on ' +
    '2026-06-18, so it no longer works for most users. Use a supported harness ' +
    'instead: claude, codex, or opencode. If you still have Gemini CLI access ' +
    '(a Standard/Enterprise subscription or API-key auth), define a custom ' +
    'harness named "gemini" in .codev/config.json under the "harness" section ' +
    'and select it explicitly with shell.builderHarness / shell.architectHarness ' +
    '— a bare auto-detected "gemini" command stays retired. See issue #1338.',
};

/**
 * Whether `name` is a retired built-in harness. Uses an own-property check so
 * inherited Object keys (`constructor`, `toString`, …) are never misread as
 * retired.
 */
export function isRetiredHarness(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETIRED_HARNESSES, name);
}

/**
 * The retirement explanation for `name`, or `undefined` when `name` is not a
 * retired harness.
 */
export function getRetirement(name: string): string | undefined {
  return isRetiredHarness(name) ? RETIRED_HARNESSES[name] : undefined;
}

/**
 * Error thrown when a retired harness name is selected. A distinct type lets a
 * caller scope a `catch` to the retirement — return a safe default, or abort a
 * spawn before it creates state — and rethrow every other error unchanged. Used
 * by the spawn pre-flight and the Tower-side `siblingRegistrationIsLive`
 * predicate (Issue #1338). `harnessName` is the retired name that triggered it.
 */
export class RetiredHarnessError extends Error {
  constructor(public readonly harnessName: string, message: string) {
    super(message);
    this.name = 'RetiredHarnessError';
  }
}

/**
 * Throw the consistent retirement error for retired harness `name`. Returns
 * `never` so callers can use it as a resolver exit on any branch and keep one
 * identical message regardless of which path selected the retired name.
 */
export function throwRetired(name: string): never {
  throw new RetiredHarnessError(name, getRetirement(name) ?? `The "${name}" harness is retired.`);
}

// =============================================================================
// Template expansion
// =============================================================================

/**
 * Expand template variables in a string.
 * ${ROLE_FILE} → roleFilePath, ${ROLE_CONTENT} → roleContent.
 * Unknown ${...} variables are left unexpanded (makes typos visible).
 */
function expandTemplateVars(template: string, roleContent: string, roleFilePath: string): string {
  // Use replacer functions to avoid $& / $' / $` interpretation in replacement strings
  return template
    .replace(/\$\{ROLE_FILE\}/g, () => roleFilePath)
    .replace(/\$\{ROLE_CONTENT\}/g, () => roleContent);
}

/**
 * Escape a string for safe inclusion inside single quotes in bash.
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
export function shellEscapeSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

// =============================================================================
// Custom harness provider
// =============================================================================

/**
 * Build a HarnessProvider from a custom config definition.
 * Template variables (${ROLE_FILE}, ${ROLE_CONTENT}) are expanded at call time.
 */
export function buildCustomHarnessProvider(config: CustomHarnessConfig): HarnessProvider {
  return {
    buildRoleInjection: (content, filePath) => ({
      args: config.roleArgs.map(arg => expandTemplateVars(arg, content, filePath)),
      env: Object.fromEntries(
        Object.entries(config.roleEnv ?? {}).map(
          ([k, v]) => [k, expandTemplateVars(v, content, filePath)],
        ),
      ),
    }),
    buildScriptRoleInjection: (content, filePath) => ({
      fragment: expandTemplateVars(config.roleScriptFragment, content, filePath),
      env: Object.fromEntries(
        Object.entries(config.roleScriptEnv ?? {}).map(
          ([k, v]) => [k, expandTemplateVars(v, content, filePath)],
        ),
      ),
    }),
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate a custom harness config entry.
 * Throws a descriptive error if required fields are missing or wrong type.
 */
export function validateCustomHarnessConfig(name: string, config: unknown): CustomHarnessConfig {
  if (typeof config !== 'object' || config === null) {
    throw new Error(`Harness "${name}": expected an object, got ${typeof config}`);
  }

  const obj = config as Record<string, unknown>;

  if (!Array.isArray(obj.roleArgs)) {
    throw new Error(`Harness "${name}": missing required field "roleArgs" (must be a string array)`);
  }
  if (!obj.roleArgs.every((a: unknown) => typeof a === 'string')) {
    throw new Error(`Harness "${name}": "roleArgs" must contain only strings`);
  }

  if (typeof obj.roleScriptFragment !== 'string') {
    throw new Error(`Harness "${name}": missing required field "roleScriptFragment" (must be a string)`);
  }

  if (obj.roleEnv !== undefined) {
    if (typeof obj.roleEnv !== 'object' || obj.roleEnv === null) {
      throw new Error(`Harness "${name}": "roleEnv" must be an object if provided`);
    }
    for (const [k, v] of Object.entries(obj.roleEnv as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`Harness "${name}": "roleEnv.${k}" must be a string, got ${typeof v}`);
      }
    }
  }

  if (obj.roleScriptEnv !== undefined) {
    if (typeof obj.roleScriptEnv !== 'object' || obj.roleScriptEnv === null) {
      throw new Error(`Harness "${name}": "roleScriptEnv" must be an object if provided`);
    }
    for (const [k, v] of Object.entries(obj.roleScriptEnv as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`Harness "${name}": "roleScriptEnv.${k}" must be a string, got ${typeof v}`);
      }
    }
  }

  return obj as unknown as CustomHarnessConfig;
}

// =============================================================================
// Auto-detection
// =============================================================================

/**
 * Detect harness type from a command string by extracting the basename of the
 * first token and matching against known CLI names.
 * Returns undefined if no match (caller decides what to do).
 */
export function detectHarnessFromCommand(command: string): string | undefined {
  const firstToken = command.trim().split(/\s+/)[0];
  if (!firstToken) return undefined;

  // Extract basename (handles full paths like /opt/homebrew/bin/codex)
  const basename = firstToken.split('/').pop() || firstToken;

  if (basename.includes('claude')) return 'claude';
  if (basename.includes('codex')) return 'codex';
  if (basename.includes('gemini')) return 'gemini';
  if (basename.includes('opencode')) return 'opencode';
  if (basename.includes('kimi')) return 'kimi';

  return undefined;
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve a harness name to a HarnessProvider.
 *
 * Resolution order:
 * 1. Explicit harnessName → built-in provider, else custom provider
 * 2. Retired name → throw the retirement error (fail closed). A same-named
 *    custom harness still wins for an *explicit* name (the escape hatch), but an
 *    auto-detected retired command is always retired — auto-detection never
 *    consults custom harnesses (Issue #1338).
 * 3. Auto-detect from command string basename (if command provided)
 * 4. Default to claude (backward compatible)
 *
 * Throws if harnessName is retired, or is set but doesn't match any provider.
 */
export function resolveHarness(
  harnessName: string | undefined,
  customHarnesses?: Record<string, CustomHarnessConfig>,
  command?: string,
): HarnessProvider {
  // Explicit harness name takes priority
  if (harnessName) {
    // Own-property lookup: `harnessName` is user-controlled, so a bare index could
    // return an inherited Object member (`constructor`, …) as a bogus provider.
    const builtin = getBuiltinHarness(harnessName);
    if (builtin) return builtin;

    if (customHarnesses && harnessName in customHarnesses) {
      return buildCustomHarnessProvider(customHarnesses[harnessName]);
    }

    // A retired name with no custom override fails closed with a clear message.
    // Checked after the custom lookup so an explicit custom `gemini` (the
    // escape hatch for retained enterprise/API-key access) still resolves.
    if (isRetiredHarness(harnessName)) throwRetired(harnessName);

    const knownNames = Object.keys(BUILTIN_HARNESSES);
    const customNames = customHarnesses ? Object.keys(customHarnesses) : [];
    const allNames = [...knownNames, ...customNames];

    throw new Error(
      `Unknown harness "${harnessName}". ` +
      `Available harnesses: ${allNames.join(', ') || '(none)'}. ` +
      `Configure a custom harness in .codev/config.json under the "harness" section.`,
    );
  }

  // Auto-detect from command basename
  if (command) {
    const detected = detectHarnessFromCommand(command);
    if (detected) {
      // Intercept a retired detected name BEFORE the BUILTIN_HARNESSES lookup:
      // it must never return undefined (removed registry entry) nor fall through
      // to the Claude default below (the #929 silent-mismatch class). Auto-detect
      // resolves the built-in namespace only, so a detected `gemini` is retired
      // even when a custom `gemini` exists.
      if (isRetiredHarness(detected)) throwRetired(detected);
      return BUILTIN_HARNESSES[detected];
    }
  }

  // Default to claude
  return CLAUDE_HARNESS;
}
