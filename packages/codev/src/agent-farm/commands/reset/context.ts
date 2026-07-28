/**
 * Builder context resolution for `afx reset` (Spec 1273, phase 4).
 *
 * Invariant R3 requires a re-orientation carrying protocol, mode, worktree,
 * branch, project identity and porch re-entry. The first draft of the plan
 * assumed the builder registry held those facts. **It does not**, and the gap is
 * silent rather than obvious:
 *
 *   - `builders.protocol_name` is NULL for spec-type builders. `spawn.ts` never
 *     passes `protocolName` on that path (only the `protocol`-type spawn does),
 *     so every SPIR/ASPIR lane — precisely the long-running builders this feature
 *     exists for — has NULL there. Reading `db/schema.ts` shows the column and
 *     looks fine; the persistence path is where the truth is.
 *   - Mode is not persisted at all. `resolveMode` computes it at spawn from flags
 *     plus protocol defaults and discards it, so a spawn-time `--soft` cannot be
 *     recovered afterwards by recomputation.
 *   - Harness comes from workspace config, which can change while a builder runs,
 *     so config is not authoritative for a *running* builder.
 *
 * So this module reads the worktree, which holds all of it authoritatively:
 * porch's `status.yaml` (protocol, phase), `.builder-prompt.txt` (the literal
 * `## Mode:` line the builder was given), and `.builder-start.sh` (the launch
 * line of the process actually running).
 *
 * Every chain ends in a **loud abort**, never a default. A guessed protocol or
 * mode would produce a plausible-looking re-orientation that quietly reframes the
 * builder — the exact drift R3 exists to prevent.
 */

import { join } from 'node:path';
import { parseAgentName } from '../../utils/agent-names.js';
import {
  BUILTIN_HARNESSES,
  buildCustomHarnessProvider,
  type CustomHarnessConfig,
  type HarnessProvider,
} from '../../utils/harness.js';

// ============================================================================
// Ports
// ============================================================================

/** Filesystem access needed for resolution. Injected so tests need no worktree. */
export interface ContextFsPort {
  exists(path: string): boolean;
  read(path: string): string | null;
  /** Immediate subdirectory names, or null when the directory does not exist. */
  listDirs(path: string): string[] | null;
}

// ============================================================================
// Result
// ============================================================================

export interface ResolvedBuilderContext {
  builderId: string;
  worktree: string;
  branch: string;
  protocol: string;
  /** Where the protocol came from — surfaced in the report so it is auditable. */
  protocolSource: 'status.yaml' | 'builder-id';
  mode: 'strict' | 'soft';
  modeSource: 'flag' | 'builder-prompt';
  harnessName: string;
  harness: HarnessProvider;
  /** Null for a non-porch lane; that is a branch, not a failure. */
  porch: PorchContext | null;
  /**
   * Artifact identity, for phase 5's reconstruction of the spawn TemplateContext.
   *
   * Null on a non-porch lane, where there is no spec/plan naming convention to
   * derive from. `specPath`/`planPath` are worktree-relative and are only set
   * when the file actually exists — a pointer to a file that is not there would
   * send a freshly-reset builder chasing a ghost.
   */
  specName: string | null;
  specPath: string | null;
  planPath: string | null;
  /** Issue number, from the registry row or the porch project id. */
  issueNumber?: string;
}

export interface PorchContext {
  projectId: string;
  projectName: string;
  /** The protocol porch is actually running for this project. */
  protocol: string;
  phase: string;
  currentPlanPhase: string | null;
  statusPath: string;
}

/** Thrown when a fact cannot be established. Never swallowed into a default. */
export class ContextResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextResolutionError';
  }
}

// ============================================================================
// porch status.yaml
// ============================================================================

/**
 * Locate and parse the worktree's porch status file.
 *
 * Returns null when there is no porch project — a task or shell builder is a
 * legitimate reset target, it simply gets no porch re-entry block.
 *
 * Parsed with targeted line matching rather than a YAML dependency: this module
 * needs four scalar fields, and the file is machine-written by porch.
 */
export function readPorchContext(fs: ContextFsPort, worktree: string): PorchContext | null {
  const projectsDir = join(worktree, 'codev', 'projects');
  const dirs = fs.listDirs(projectsDir);
  if (!dirs || dirs.length === 0) return null;

  for (const dir of dirs) {
    const statusPath = join(projectsDir, dir, 'status.yaml');
    const content = fs.read(statusPath);
    if (content === null) continue;

    const protocol = matchScalar(content, 'protocol');
    const phase = matchScalar(content, 'phase');
    const id = matchScalar(content, 'id');
    if (!protocol || !phase) continue;

    const currentPlanPhase = matchScalar(content, 'current_plan_phase');
    return {
      projectId: id ?? dir.split('-')[0],
      projectName: dir,
      protocol,
      phase,
      currentPlanPhase: currentPlanPhase && currentPlanPhase !== 'null' ? currentPlanPhase : null,
      statusPath,
    };
  }

  return null;
}

/** Read a top-level scalar from porch's status.yaml, stripping quotes. */
function matchScalar(content: string, key: string): string | null {
  const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!m) return null;
  const raw = m[1].trim().replace(/^['"]|['"]$/g, '');
  return raw === '' ? null : raw;
}

/**
 * The protocol recorded in status.yaml, if there is one.
 *
 * Reads through `readPorchContext` rather than re-scanning the project dirs, so
 * the two cannot disagree about which status.yaml is authoritative when a
 * worktree somehow holds more than one project directory.
 */
export function protocolFromStatus(fs: ContextFsPort, worktree: string): string | null {
  return readPorchContext(fs, worktree)?.protocol ?? null;
}

// ============================================================================
// Mode
// ============================================================================

/**
 * Read the mode the builder was actually told it was running in.
 *
 * The spawn prompt renders a literal `## Mode: STRICT` heading, and `--resume`
 * does not rewrite the prompt file, so this stays correct across resumes. It is
 * a stronger source than recomputing `resolveMode`, which cannot recover a
 * spawn-time `--soft` from protocol defaults.
 */
export function modeFromBuilderPrompt(fs: ContextFsPort, worktree: string): 'strict' | 'soft' | null {
  const content = fs.read(join(worktree, '.builder-prompt.txt'));
  if (content === null) return null;
  const m = content.match(/^##\s*Mode:\s*(STRICT|SOFT)\s*$/im);
  if (!m) return null;
  return m[1].toLowerCase() as 'strict' | 'soft';
}

// ============================================================================
// Harness
// ============================================================================

/**
 * Identify the harness from the worktree's launch script.
 *
 * Per-builder ground truth: the script is what the running process was started
 * with, so it stays right even if workspace config changed since the spawn.
 */
export function harnessFromLaunchScript(
  fs: ContextFsPort,
  worktree: string,
  customHarnesses?: Record<string, CustomHarnessConfig>,
): string | null {
  const content = fs.read(join(worktree, '.builder-start.sh'));
  if (content === null) return null;

  // Custom names first: a project may define a custom harness whose name
  // contains a builtin's (e.g. "claude-experimental"), and the more specific
  // match is the right one.
  const names = new Set([
    ...Object.keys(customHarnesses ?? {}),
    ...Object.keys(BUILTIN_HARNESSES),
  ]);

  for (const line of content.split('\n')) {
    const command = commandNameOf(line);
    if (command && names.has(command)) return command;
  }
  return null;
}

/**
 * The command a shell line invokes, or null if the line invokes nothing.
 *
 * Matching on **command position** rather than searching the whole line for a
 * harness name: a substring search would report a false positive on a line like
 * `if [ "$HARNESS" = "codex" ]`, and naming the wrong harness would either refuse
 * a resettable builder or — worse — approve typing into one that cannot be reset.
 */
function commandNameOf(line: string): string | null {
  let rest = line.trim();
  if (!rest || rest.startsWith('#')) return null;

  // Strip shell control keywords that can prefix a command on the same line.
  rest = rest.replace(/^(?:while|until|if|then|else|elif|do|done|fi|exec|command|nohup)\s+/, '');
  // Strip leading `VAR=value ` environment assignments.
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
    const space = rest.indexOf(' ');
    if (space === -1) return null; // a bare assignment invokes nothing
    rest = rest.slice(space + 1).trimStart();
  }

  const first = rest.split(/\s+/)[0];
  if (!first || first.includes('=')) return null;

  // Basename, so `/usr/local/bin/claude` resolves like `claude`, with any
  // surrounding quotes removed.
  const base = first.replace(/^['"]|['"]$/g, '').split('/').pop();
  return base && base !== '' ? base : null;
}

/**
 * Map a harness name to its provider, honouring project-defined custom harnesses.
 *
 * Custom harnesses resolve to a real provider rather than failing as
 * "unrecognisable", so the refusal a project sees is the accurate one — *this
 * harness cannot reset in-session* — instead of a misleading "unknown harness".
 * `buildCustomHarnessProvider` does not set `supportsContextReset`, so custom
 * harnesses are unsupported by default; letting one declare support would be a
 * one-field addition to `CustomHarnessConfig`, deliberately out of scope here.
 */
export function harnessProviderFor(
  harnessName: string,
  customHarnesses?: Record<string, CustomHarnessConfig>,
): HarnessProvider | null {
  const builtin = BUILTIN_HARNESSES[harnessName];
  if (builtin) return builtin;
  if (customHarnesses && harnessName in customHarnesses) {
    return buildCustomHarnessProvider(customHarnesses[harnessName]);
  }
  return null;
}

/**
 * Derive artifact identity from the porch project.
 *
 * Porch names its project dir `<id>-<title>`, and spec/plan files share that
 * stem by convention (`codev/specs/<id>-<title>.md`). Paths are returned only
 * when the file exists.
 */
export function artifactPaths(
  fs: ContextFsPort,
  worktree: string,
  porch: PorchContext | null,
): { specName: string | null; specPath: string | null; planPath: string | null } {
  if (!porch) return { specName: null, specPath: null, planPath: null };

  const specName = porch.projectName;
  const specRel = join('codev', 'specs', `${specName}.md`);
  const planRel = join('codev', 'plans', `${specName}.md`);

  return {
    specName,
    specPath: fs.exists(join(worktree, specRel)) ? specRel : null,
    planPath: fs.exists(join(worktree, planRel)) ? planRel : null,
  };
}

// ============================================================================
// Resolution
// ============================================================================

export interface ResolveContextOptions {
  fs: ContextFsPort;
  builderId: string;
  worktree: string;
  branch: string;
  issueNumber?: string;
  /** `--mode` override; wins over the worktree, for when the prompt file is gone. */
  modeOverride?: 'strict' | 'soft';
  /** Project-defined harnesses from `.codev/config.json`, if any. */
  customHarnesses?: Record<string, CustomHarnessConfig>;
}

/**
 * Resolve everything the re-orientation needs, or throw.
 *
 * Deliberately does NOT consult `builders.protocol_name`: it is NULL for
 * spec-type builders, so a reader who "fixed" this to use the registry would
 * break exactly the lanes the feature targets while the code looked more correct.
 */
export function resolveBuilderContext(options: ResolveContextOptions): ResolvedBuilderContext {
  const { fs, builderId, worktree, branch, issueNumber, modeOverride, customHarnesses } = options;

  if (!fs.exists(worktree)) {
    throw new ContextResolutionError(
      `Worktree not found for '${builderId}': ${worktree}. The builder's registry row may be stale.`,
    );
  }

  // --- Protocol: status.yaml → builder id → abort -------------------------
  let protocol = protocolFromStatus(fs, worktree);
  let protocolSource: ResolvedBuilderContext['protocolSource'] = 'status.yaml';
  if (!protocol) {
    const parsed = parseAgentName(builderId);
    if (parsed) {
      protocol = parsed.protocol;
      protocolSource = 'builder-id';
    }
  }
  if (!protocol) {
    throw new ContextResolutionError(
      `Cannot determine the protocol for '${builderId}': no porch status.yaml under ${worktree}/codev/projects, ` +
        `and the builder id is not in canonical 'builder-<protocol>-<id>' form. ` +
        `Refusing to re-orient a builder without naming its protocol.`,
    );
  }

  // --- Mode: flag → .builder-prompt.txt → abort ---------------------------
  let mode = modeOverride ?? null;
  let modeSource: ResolvedBuilderContext['modeSource'] = 'flag';
  if (!mode) {
    mode = modeFromBuilderPrompt(fs, worktree);
    modeSource = 'builder-prompt';
  }
  if (!mode) {
    throw new ContextResolutionError(
      `Cannot determine the mode (strict/soft) for '${builderId}': no '## Mode:' line in ` +
        `${join(worktree, '.builder-prompt.txt')}. Mode is not persisted anywhere else — ` +
        `pass --mode strict or --mode soft explicitly.`,
    );
  }

  // --- Harness: .builder-start.sh → provider → capability check → abort ---
  const harnessName = harnessFromLaunchScript(fs, worktree, customHarnesses);
  if (!harnessName) {
    throw new ContextResolutionError(
      `Cannot determine the harness for '${builderId}': no recognisable launch command in ` +
        `${join(worktree, '.builder-start.sh')}. Refusing to type into a terminal whose agent is unknown.`,
    );
  }
  const harness = harnessProviderFor(harnessName, customHarnesses);
  if (!harness) {
    throw new ContextResolutionError(
      `Harness '${harnessName}' is not a known provider — it is neither built in nor defined under ` +
        `"harness" in .codev/config.json. Refusing to type into a terminal whose agent is unknown.`,
    );
  }
  if (!harness.supportsContextReset) {
    throw new ContextResolutionError(
      `Harness '${harnessName}' has no in-session context reset, so 'afx reset' cannot clear this ` +
        `builder's context. Only the claude harness supports it today. ` +
        `To give this builder a fresh window, stop it and respawn without --resume.`,
    );
  }

  const porch = readPorchContext(fs, worktree);
  const { specName, specPath, planPath } = artifactPaths(fs, worktree, porch);

  return {
    builderId,
    worktree,
    branch,
    protocol,
    protocolSource,
    mode,
    modeSource,
    harnessName,
    harness,
    porch,
    specName,
    specPath,
    planPath,
    // Issue-driven protocols name the porch project after the issue, so the
    // project id is the correct value when the registry row has none.
    issueNumber: issueNumber ?? porch?.projectId,
  };
}
