/**
 * Agent harness abstraction.
 *
 * Encapsulates how different agent CLI tools (Claude, Codex, Gemini, etc.)
 * handle role/system prompt injection. Built-in providers cover Claude, Codex,
 * and Gemini. Custom providers can be defined in .codev/config.json.
 *
 * Two integration patterns exist:
 * - Node spawn() call sites: use buildRoleInjection() → returns args + env
 * - Bash script generation: use buildScriptRoleInjection() → returns fragment + env
 *
 * @see codev/specs/591-af-workspace-failure-with-code.md
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { findLatestSessionId, verifySessionOwnership } from './claude-session-discovery.js';
import {
  findLatestKimiSessionId,
  verifyKimiSessionOwnership,
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
   * Absolute path to the seed-prompt file (.builder-seed.txt) written by the
   * caller from `seedDelivery.buildSeedPrompt(...)`. Null on paths with
   * nothing to seed (no role, no prompt) and on resume.
   */
  seedFile: string | null;
  /** Present on the resume path: relaunch pinned to this prior session. */
  resume?: { sessionId: string };
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
   * Optional: provider-owned builder launch script (Issue #1201). When
   * present, spawn-worktree.ts uses this INSTEAD of the generic
   * `${baseCmd} ${roleFragment} "<prompt>"` script shapes — for CLIs with no
   * role flag and no positional prompt (Kimi), where the whole launch shape
   * (seed-session bootstrap + pinned-id TUI loop) belongs to the provider.
   */
  buildBuilderLaunchScript?(ctx: BuilderLaunchScriptContext): string;

  /**
   * Optional: seed-session delivery metadata (Issue #1201), consumed by
   * spawn-worktree.ts (seed-prompt file) and Tower's seed-kick module
   * (readiness barrier). Only meaningful alongside buildBuilderLaunchScript.
   *
   * The generated script prints `<sentinelPrefix> <session-id>` on its own
   * line after the seed completes and before the interactive TUI starts.
   * Tower gates any first-message delivery on that sentinel: bytes written to
   * the PTY during the seed window have no defined consumer (observed: they
   * are silently lost), so an ungated write would drop the task kick.
   */
  seedDelivery?: {
    sentinelPrefix: string;
    /** Single-line kick delivered after the sentinel + grace (e.g. 'BEGIN'). */
    kickMessage: string;
    /** Post-sentinel grace before writing the kick (composer warm-up). */
    graceMs: number;
    /** Compose the seed-turn prompt from role and/or initial task prompt. */
    buildSeedPrompt(roleContent: string | null, taskPrompt: string | null): string;
  };

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

// =============================================================================
// Built-in providers
// =============================================================================

export const CLAUDE_HARNESS: HarnessProvider = {
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

export const GEMINI_HARNESS: HarnessProvider = {
  buildRoleInjection: (_content, filePath) => ({
    args: [],
    env: { GEMINI_SYSTEM_MD: filePath },
  }),
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: '',
    env: { GEMINI_SYSTEM_MD: filePath },
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
 * Sentinel printed by the generated Kimi launch script between seed completion
 * and TUI start. Tower's seed-kick module gates first-message delivery on it.
 */
export const KIMI_SEED_SENTINEL = '__CODEV_KIMI_SEED_DONE__';

/**
 * File in the worktree persisting the seeded Kimi session id. Doubles as the
 * Kimi-shape marker for Tower's pacing probe (message-pacing.ts), so EVERY
 * launch shape persists it: seed and resume write the captured id; the bare
 * no-role/no-prompt shape touches it empty (there is no id to pin).
 */
export const KIMI_SESSION_FILE = '.builder-kimi-session';

/**
 * Delayed-Enter timing for Kimi PTYs. Kimi's paste-detection window is longer
 * than Claude's: an Enter arriving too soon after the message body is treated
 * as part of a paste and NOT submitted. Bisected live against kimi 0.27.0
 * (PIR #1201): 80ms and 100ms fail; 120ms, 250ms, 500ms, 1000ms submit —
 * threshold ≈ 100–120ms. Pinned at 1000ms for ~9x margin (the POC-validated
 * value; the only cost is submission latency, which is irrelevant for
 * agent-to-agent messages). Applied via messagePacing below.
 */
export const KIMI_ENTER_DELAY_MS = 1000;

/** Map the shared `homeDir` test-seam option onto the Kimi store location. */
function kimiOpts(opts?: { homeDir?: string }): KimiDiscoveryOpts | undefined {
  return opts?.homeDir ? { kimiHome: join(opts.homeDir, '.kimi-code') } : undefined;
}

/**
 * Compose the seed-turn prompt: role and/or task briefing wrapped in an
 * ack-and-wait discipline. The role rides a USER turn, not a system prompt
 * (Kimi documents no system-prompt flag) — the same tradeoff that deferred
 * agy as an architect (#1063). Validated end-to-end in spike task-Iptx.
 */
function buildKimiSeedPrompt(roleContent: string | null, taskPrompt: string | null): string {
  const waitInstruction = taskPrompt
    ? '- Reply with exactly "ROLE-OK", then wait. You will receive a message "BEGIN" in a later turn — only then start working on the task briefing, following your role.'
    : '- Reply with exactly "ROLE-OK", then wait for instructions from the user in the interactive session.';
  const parts: string[] = [
    'You are being initialized as an autonomous agent inside a project worktree.',
    'This initialization turn delivers your ROLE and TASK BRIEFING. Strict discipline for THIS turn:',
    '- Do NOT start working yet. Do NOT use any tools. Do NOT read or write files.',
    '- Internalize everything below; it governs the rest of this session.',
    waitInstruction,
  ];
  if (roleContent) {
    parts.push('', '=== YOUR ROLE ===', roleContent);
  }
  if (taskPrompt) {
    parts.push('', '=== TASK BRIEFING (do not act until BEGIN) ===', taskPrompt);
  }
  return parts.join('\n');
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
 * Extract the seeded session id from `kimi -p … --output-format stream-json`
 * stdout: the machine-readable `session.resume_hint` meta line (UNDOCUMENTED,
 * observed on kimi 0.27.0 — see kimi-session-discovery.ts header). Reads stdin
 * to EOF before printing so the pipe never closes early (an early exit would
 * EPIPE the seed process mid-turn). Exits 1 when no hint line is found — the
 * session file ends up empty and the script's empty-id bailout fires.
 */
const KIMI_SEED_EXTRACTOR =
  'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{' +
  'for(const l of b.split("\\n")){try{const o=JSON.parse(l);' +
  'if(o&&o.type==="session.resume_hint"&&typeof o.session_id==="string"){process.stdout.write(o.session_id);return}}catch{}}' +
  'process.exit(1)})';

export const KIMI_HARNESS: HarnessProvider = {
  buildRoleInjection: () => {
    throw new Error(
      'Kimi is only supported as a builder shell, not as an architect shell ' +
      '(stage 2 — see issue #1201). Kimi has no documented system-prompt flag; ' +
      'builder role injection uses a seed-session bootstrap owned by the builder ' +
      'launch script. Configure a different shell for the architect ' +
      '(e.g., "claude --dangerously-skip-permissions" or "codex").',
    );
  },
  // Role cannot ride argv (no role flag, no positional prompt — both exit 1,
  // observed). The real shape is provider-owned via buildBuilderLaunchScript.
  buildScriptRoleInjection: () => ({ fragment: '', env: {} }),

  // Builder resume (afx spawn --resume): prefer the id persisted by the launch
  // script, ownership-verified so a stale id (store GC, manual deletion) falls
  // through instead of baking a fast-failing `-S <dead-id>` into the restart
  // loop; else newest store session recorded for exactly this worktree; else
  // null → callers take the fresh-with-role seed path (never a roleless fresh
  // session — the reason explicit-ID is preferred over cwd-scoped --continue).
  buildResume: (absolutePath, opts) => {
    const kOpts = kimiOpts(opts);
    let sessionId: string | null = null;
    try {
      const persisted = readFileSync(join(absolutePath, KIMI_SESSION_FILE), 'utf-8').trim();
      if (persisted && verifyKimiSessionOwnership(persisted, absolutePath, kOpts)) {
        sessionId = persisted;
      }
    } catch {
      // No persisted session file — fall through to the store scan
    }
    if (!sessionId) {
      sessionId = findLatestKimiSessionId(absolutePath, kOpts);
    }
    if (!sessionId) return null;
    return {
      sessionId,
      args: ['-S', sessionId],
      scriptFragment: `-S '${shellEscapeSingleQuote(sessionId)}'`,
    };
  },

  buildBuilderLaunchScript: (ctx) => {
    const tuiCmd = kimiTuiCmd(ctx.baseCmd);
    const loop = `while true; do
  ${tuiCmd} -S "$SID"
  echo ""
  echo "Agent exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;

    if (ctx.resume) {
      // Resume path: pinned prior session, no seed. Re-persist the id so the
      // session file regains precedence for the next resume (it may be absent
      // when the id came from a store scan) and so the file keeps serving as
      // the Kimi marker for message pacing.
      const escapedId = shellEscapeSingleQuote(ctx.resume.sessionId);
      return `#!/bin/bash
cd "${ctx.worktreePath}"
printf '%s' '${escapedId}' > ${KIMI_SESSION_FILE}
SID='${escapedId}'
echo "${KIMI_SEED_SENTINEL} $SID"
${loop}`;
    }

    if (ctx.seedFile) {
      // Fresh path: seed-session bootstrap (spike task-Iptx, POC 6). The seed
      // turn carries the role/task briefing; its captured session id pins the
      // TUI loop, so context survives inner restarts. The `-s` guard makes the
      // seed idempotent across script relaunches; a failed seed (auth,
      // network, no resume_hint) leaves the file empty and exits BEFORE the
      // loop — surfaced once, never restart-looped.
      return `#!/bin/bash
cd "${ctx.worktreePath}"
if [ ! -s ${KIMI_SESSION_FILE} ]; then
  echo "Seeding Kimi session (role/task briefing via kimi -p)..."
  ${ctx.baseCmd} -p "$(cat '${shellEscapeSingleQuote(ctx.seedFile)}')" --output-format stream-json \\
    | node -e '${KIMI_SEED_EXTRACTOR}' > ${KIMI_SESSION_FILE}
  echo ""
fi
SID="$(cat ${KIMI_SESSION_FILE} 2>/dev/null)"
if [ -z "$SID" ]; then
  echo "ERROR: Kimi seed failed — no session id captured." >&2
  echo "Check authentication (kimi login) and network, then relaunch this terminal." >&2
  rm -f ${KIMI_SESSION_FILE}
  exit 1
fi
echo "${KIMI_SEED_SENTINEL} $SID"
${loop}`;
    }

    // Nothing to seed (no role, no prompt): plain TUI loop. No session
    // pinning — restarts start fresh, matching the bare-mode behavior of
    // other harnesses. The marker file is still persisted (empty — no id to
    // pin) so Tower's pacing probe recognizes the worktree as Kimi-shaped;
    // without it an override-spawned bare builder (`--builder-cmd kimi` in a
    // claude-configured workspace) resolves the config harness's Enter timing
    // and `afx send` payloads are swallowed by paste detection. `touch`
    // preserves a previously seeded id, and an empty file keeps both the seed
    // guard (`! -s`) and buildResume's empty-id fallthrough intact.
    return `#!/bin/bash
cd "${ctx.worktreePath}"
touch ${KIMI_SESSION_FILE}
while true; do
  ${tuiCmd}
  echo ""
  echo "Agent exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
  },

  seedDelivery: {
    sentinelPrefix: KIMI_SEED_SENTINEL,
    kickMessage: 'BEGIN',
    graceMs: 2500,
    buildSeedPrompt: buildKimiSeedPrompt,
  },

  messagePacing: { enterDelayMs: KIMI_ENTER_DELAY_MS },
};

const BUILTIN_HARNESSES: Record<string, HarnessProvider> = {
  claude: CLAUDE_HARNESS,
  codex: CODEX_HARNESS,
  gemini: GEMINI_HARNESS,
  opencode: OPENCODE_HARNESS,
  kimi: KIMI_HARNESS,
};

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
 * 1. Explicit harnessName → built-in or custom provider
 * 2. Auto-detect from command string basename (if command provided)
 * 3. Default to claude (backward compatible)
 *
 * Throws if harnessName is set but doesn't match any known provider.
 */
export function resolveHarness(
  harnessName: string | undefined,
  customHarnesses?: Record<string, CustomHarnessConfig>,
  command?: string,
): HarnessProvider {
  // Explicit harness name takes priority
  if (harnessName) {
    const builtin = BUILTIN_HARNESSES[harnessName];
    if (builtin) return builtin;

    if (customHarnesses && harnessName in customHarnesses) {
      return buildCustomHarnessProvider(customHarnesses[harnessName]);
    }

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
      return BUILTIN_HARNESSES[detected];
    }
  }

  // Default to claude
  return CLAUDE_HARNESS;
}
