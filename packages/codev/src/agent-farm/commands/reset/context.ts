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
import { BUILTIN_HARNESSES, type HarnessProvider } from '../../utils/harness.js';

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
  issueNumber?: string;
}

export interface PorchContext {
  projectId: string;
  projectName: string;
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

/** The protocol recorded in status.yaml, if there is one. */
export function protocolFromStatus(fs: ContextFsPort, worktree: string): string | null {
  const projectsDir = join(worktree, 'codev', 'projects');
  const dirs = fs.listDirs(projectsDir);
  if (!dirs) return null;
  for (const dir of dirs) {
    const content = fs.read(join(projectsDir, dir, 'status.yaml'));
    if (content === null) continue;
    const protocol = matchScalar(content, 'protocol');
    if (protocol) return protocol;
  }
  return null;
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
export function harnessFromLaunchScript(fs: ContextFsPort, worktree: string): string | null {
  const content = fs.read(join(worktree, '.builder-start.sh'));
  if (content === null) return null;

  // The launch line is inside the `while true` loop, before the loop tail.
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('cd ') || trimmed.startsWith('export ')) continue;
    for (const name of Object.keys(BUILTIN_HARNESSES)) {
      // Word-boundary match so a path like `/usr/local/bin/claude` still hits
      // while an unrelated mention inside a prompt path does not.
      if (new RegExp(`(^|[\\s/])${name}([\\s'"]|$)`).test(trimmed)) return name;
    }
  }
  return null;
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
}

/**
 * Resolve everything the re-orientation needs, or throw.
 *
 * Deliberately does NOT consult `builders.protocol_name`: it is NULL for
 * spec-type builders, so a reader who "fixed" this to use the registry would
 * break exactly the lanes the feature targets while the code looked more correct.
 */
export function resolveBuilderContext(options: ResolveContextOptions): ResolvedBuilderContext {
  const { fs, builderId, worktree, branch, issueNumber, modeOverride } = options;

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

  // --- Harness: .builder-start.sh → capability check → abort --------------
  const harnessName = harnessFromLaunchScript(fs, worktree);
  if (!harnessName) {
    throw new ContextResolutionError(
      `Cannot determine the harness for '${builderId}': no recognisable launch command in ` +
        `${join(worktree, '.builder-start.sh')}. Refusing to type into a terminal whose agent is unknown.`,
    );
  }
  const harness = BUILTIN_HARNESSES[harnessName];
  if (!harness?.supportsContextReset) {
    throw new ContextResolutionError(
      `Harness '${harnessName}' has no in-session context reset, so 'afx reset' cannot clear this ` +
        `builder's context. Only the claude harness supports it today. ` +
        `To give this builder a fresh window, stop it and respawn without --resume.`,
    );
  }

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
    porch: readPorchContext(fs, worktree),
    issueNumber,
  };
}
