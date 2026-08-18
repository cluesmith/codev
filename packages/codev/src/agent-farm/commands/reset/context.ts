/**
 * Builder context resolution for `afx refresh` (Spec 1273, phase 4).
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
  getBuiltinHarness,
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
  modeSource: 'flag' | 'builder-prompt' | 'task-default';
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
  /**
   * Ad-hoc task text, from the registry row (`builders.task_text`).
   *
   * Present only for `afx spawn --task` builders. Phase 5 needs it to tell that
   * lane apart from the others: a task builder still gets a porch project keyed
   * on its builder id, so `issueNumber` is populated for it too, and without
   * this field the task lane is indistinguishable from an issue-driven one.
   */
  taskText?: string;
  /**
   * True only for a BARE `afx spawn --task` builder (no `--protocol`).
   *
   * Established from positive evidence — task text present AND the prompt file
   * carries no `## Mode:` heading — rather than inferred from the absence of a
   * porch project. `initPorchInWorktree` is deliberately non-fatal, so a
   * `--task --protocol X` builder whose porch init failed also has task text and
   * no porch, and inferring from that would strip its real protocol template and
   * hand it the raw task text instead.
   *
   * The prompt is built BEFORE porch init (`spawn.ts:545-548`), so a
   * `--task --protocol` builder's prompt carries the rendered template — and its
   * `## Mode:` line — regardless of whether porch init later succeeded.
   */
  isBareTask: boolean;
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
 * Locate and parse THIS BUILDER's porch status file.
 *
 * Returns null when this builder has no porch project — a task or shell builder
 * is a legitimate reset target, it simply gets no porch re-entry block.
 *
 * ## Why this takes an identity instead of picking the first parsable file
 *
 * The first implementation returned the first directory under `codev/projects`
 * with a parsable `status.yaml`. That is correct only for a repo holding exactly
 * one project directory. **This repo commits porch history to `main`**, so every
 * worktree inherits every project ever run — 203 of them at the time of writing.
 * The alphabetically-first is `0087-porch-timeout-termination-retries`, whose
 * protocol is `spider`, so `afx refresh` resolved protocol "spider" for *every*
 * builder and died on `Protocol "spider" has no builder-prompt.md`. It failed
 * loudly, which is why nothing was corrupted — but it failed for every lane.
 *
 * The fix is to select by identity, never by position: a directory qualifies
 * only when it belongs to the builder being reset. No match returns null, which
 * is the honest answer for a genuinely non-porch builder and is also safe for a
 * porch one — a missing porch block is visible in the re-orientation, whereas
 * *another project's* protocol is a confident lie.
 *
 * (This is the #1235 wrong-winner family: pick-the-first over a set that is
 * assumed to be a singleton and is not.)
 *
 * Parsed with targeted line matching rather than a YAML dependency: this module
 * needs four scalar fields, and the file is machine-written by porch.
 */
export interface PorchProjectIdentity {
  /** Registry builder id, e.g. `aspir-1273`, `builder-task-re_v`. */
  builderId: string;
  /** Issue number when the lane has one. */
  issueNumber?: string;
}

/**
 * Project ids this builder could legitimately own, most specific first.
 *
 * Three forms, because porch names projects differently per lane:
 *   - the issue number, for issue-driven lanes;
 *   - the builder id itself — `spawn.ts` passes `builderId` as the porch project
 *     id on the `--task` path;
 *   - the builder id with its protocol prefix stripped (`aspir-1273` → `1273`),
 *     which is how spec-driven lanes are named.
 */
export function candidateProjectIds(identity: PorchProjectIdentity): string[] {
  const out: string[] = [];
  if (identity.issueNumber) out.push(identity.issueNumber);

  // The raw registry id, INCLUDING any `builder-` prefix. `spawn --task
  // --protocol X` passes `builderId` straight to `porch init`
  // (`spawn.ts:548`), and `initPorchInWorktree` keeps dashes when sanitising
  // (`spawn-worktree.ts:472`), so that lane's porch project id really is
  // `builder-task-<id>`. Omitting this form orphaned it: porch resolved to
  // null, and the builder was re-oriented as protocol TASK with no porch
  // re-entry — a silently degraded frame rather than a loud failure.
  out.push(identity.builderId);

  // And without the prefix, which is how spec/bugfix lanes are named.
  const bare = identity.builderId.replace(/^builder-/, '');
  if (bare !== identity.builderId) out.push(bare);

  const dash = bare.indexOf('-');
  if (dash > 0) out.push(bare.slice(dash + 1));

  return out.filter(v => v !== '');
}

/**
 * Compare ids ignoring case and leading zeros.
 *
 * Case: the registry lowercases builder ids while worktree and directory names
 * preserve the original (`builder-task-re_v` vs `.builders/task-RE_V`). macOS
 * hides that; a case-sensitive filesystem would not.
 * Leading zeros: project dirs use `0087-…` while porch ids and CLI arguments use
 * `87` (`afx cleanup -p 466` vs `0466` is the same long-standing split).
 */
function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/^0+(?=\d)/, '');
}

/**
 * How strongly a project directory claims to belong to this builder.
 *
 * `none` — not this builder's.
 * `weak` — matched on the bare project NUMBER (or a directory prefix). Numbers
 *          are reused across protocols: issue 799 has both a PIR project
 *          (`799-vscode-builder-changed-file-ro`) and a bugfix, so a bare-number
 *          match alone would hand `builder-bugfix-799` the PIR project's
 *          protocol and porch id. Requires protocol corroboration.
 * `strong` — matched on a globally unique, non-numeric project id, i.e. the raw
 *          registry builder id. `spawn --task --protocol X` stores exactly that
 *          (`builder-task-<id>`), so it identifies one builder and needs no
 *          corroboration — which matters because that lane's PROTOCOL
 *          legitimately differs from its id prefix (`task` vs `air`).
 */
type ProjectClaim = 'none' | 'weak' | 'strong';

function claimStrength(
  dir: string,
  statusId: string | null,
  identity: PorchProjectIdentity,
): ProjectClaim {
  const rawId = normalizeId(identity.builderId);
  if (statusId && normalizeId(statusId) === rawId && !/^\d+$/.test(rawId)) return 'strong';

  const wanted = candidateProjectIds(identity).map(normalizeId);

  // A status.yaml that STATES its id is authoritative about what it is. If that
  // id does not claim this builder, the directory name cannot overrule it —
  // `codev/projects/1273-old/` holding `id: '999'` belongs to 999, whatever the
  // directory is called. Falling through to the name here let a renamed or
  // recycled directory claim a builder, and manufactured false ambiguities
  // alongside the real project.
  if (statusId) return wanted.includes(normalizeId(statusId)) ? 'weak' : 'none';

  // Directory-name fallback applies ONLY when the file states no id at all.
  const dirNorm = normalizeId(dir);
  return wanted.some(c => dirNorm === c || dirNorm.startsWith(`${c}-`)) ? 'weak' : 'none';
}

export function readPorchContext(
  fs: ContextFsPort,
  worktree: string,
  identity: PorchProjectIdentity,
): PorchContext | null {
  const projectsDir = join(worktree, 'codev', 'projects');
  const dirs = fs.listDirs(projectsDir);
  if (!dirs || dirs.length === 0) return null;

  // The protocol the builder id claims, used to corroborate weak (number-only)
  // matches. Absent for ids that are not in canonical form, in which case a weak
  // match cannot be corroborated and is not trusted.
  const expectedProtocol = parseAgentName(identity.builderId)?.protocol ?? null;

  const strong: PorchContext[] = [];
  const weak: PorchContext[] = [];

  for (const dir of dirs) {
    const statusPath = join(projectsDir, dir, 'status.yaml');
    const content = fs.read(statusPath);
    if (content === null) continue;

    const protocol = matchScalar(content, 'protocol');
    const phase = matchScalar(content, 'phase');
    const id = matchScalar(content, 'id');
    if (!protocol || !phase) continue;

    const claim = claimStrength(dir, id, identity);
    if (claim === 'none') continue;

    const currentPlanPhase = matchScalar(content, 'current_plan_phase');
    const ctx: PorchContext = {
      projectId: id ?? dir.split('-')[0],
      projectName: dir,
      protocol,
      phase,
      currentPlanPhase: currentPlanPhase && currentPlanPhase !== 'null' ? currentPlanPhase : null,
      statusPath,
    };

    if (claim === 'strong') {
      strong.push(ctx);
      continue;
    }

    // A weak match must agree with the protocol the builder id declares.
    // Without this, `builder-bugfix-799` adopts the PIR project that happens to
    // share the number — wrong protocol, wrong porch id, and silently so.
    //
    // And when the id is not in canonical form there IS no protocol to
    // corroborate against, so the claim cannot be trusted at all. The previous
    // version's comment said exactly that while the code did the opposite —
    // `if (expectedProtocol && mismatch) continue` let every weak claim through
    // whenever `expectedProtocol` was null. A legacy or noncanonical builder
    // could adopt any historical project sharing its tail.
    if (!expectedProtocol) continue;
    if (protocol.toLowerCase() !== expectedProtocol.toLowerCase()) continue;
    weak.push(ctx);
  }

  const matches = strong.length > 0 ? strong : weak;
  if (matches.length === 0) return null;

  if (matches.length > 1) {
    // Never pick one arbitrarily — that is the bug this whole function exists to
    // fix, and picking the "least wrong" of several is the same mistake with
    // better manners.
    throw new ContextResolutionError(
      `Ambiguous porch project for '${identity.builderId}': ${matches
        .map(m => `${m.projectName} (${m.protocol})`)
        .join(', ')} all claim it. Refusing to guess which one governs this builder.`,
    );
  }

  return matches[0];
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
 * the two cannot disagree about which status.yaml is authoritative. Worktrees
 * routinely hold MANY project directories here (porch history is committed to
 * `main`), which is exactly why both go through one identity-aware selector.
 */
export function protocolFromStatus(
  fs: ContextFsPort,
  worktree: string,
  identity: PorchProjectIdentity,
): string | null {
  return readPorchContext(fs, worktree, identity)?.protocol ?? null;
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

/**
 * Recover an issue number from a porch project id.
 *
 * Porch ids are not uniformly numeric. PIR and SPIR use the bare issue number;
 * **BUGFIX deliberately uses `<prefix>-<N>`** (`spawn.ts:817`, "historical, kept
 * untouched"). A strict `/^\d+$/` guard therefore threw away BUGFIX's issue
 * identity whenever the registry row lacked one — and on BUGFIX the issue body
 * IS the spec, so the re-orientation lost the requirements it was meant to carry.
 *
 * Accepts a bare number or a canonical `<word>-<number>`; rejects anything else,
 * so an ad-hoc task id (`builder-task-abc`) still cannot masquerade as an issue.
 */
export function issueNumberFromPorchId(projectId?: string): string | undefined {
  if (!projectId) return undefined;
  if (/^\d+$/.test(projectId)) return projectId;
  const m = projectId.match(/^[a-z]+-(\d+)$/i);
  return m ? m[1] : undefined;
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
  // Own-property lookup (see getBuiltinHarness): `harnessName` comes from a running
  // builder's launch script — a user-controlled key — so a bare index could hand
  // back an inherited Object member as a bogus provider.
  const builtin = getBuiltinHarness(harnessName);
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
  /** `builders.task_text`, for `--task` builders. Forwarded verbatim. */
  taskText?: string;
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
  const { fs, builderId, worktree, branch, issueNumber, taskText, modeOverride, customHarnesses } =
    options;

  if (!fs.exists(worktree)) {
    throw new ContextResolutionError(
      `Worktree not found for '${builderId}': ${worktree}. The builder's registry row may be stale.`,
    );
  }

  // Resolved once, with identity, and reused for both the protocol chain and
  // the result. Two independent scans could disagree about which project is
  // this builder's — the exact ambiguity the identity match exists to remove.
  const identity: PorchProjectIdentity = { builderId, issueNumber };
  const porch = readPorchContext(fs, worktree, identity);

  // --- Protocol: status.yaml → builder id → abort -------------------------
  let protocol = porch?.protocol ?? null;
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
  const promptMode = modeFromBuilderPrompt(fs, worktree);

  // Positive evidence, not a negative inference: a bare `--task` spawn writes a
  // prompt with no `## Mode:` heading, while `--task --protocol X` renders the
  // full template (built BEFORE porch init, so it survives a failed init).
  const isBareTask = Boolean(taskText) && promptMode === null;

  let mode = modeOverride ?? null;
  let modeSource: ResolvedBuilderContext['modeSource'] = 'flag';
  if (!mode) {
    mode = promptMode;
    modeSource = 'builder-prompt';
  }
  if (!mode && isBareTask) {
    // A `--task` spawn writes a bare prompt with no `## Mode:` heading, so this
    // lane could never auto-detect and every `afx refresh <task>` hard-errored.
    //
    // Defaulting to SOFT is not a guess dressed up as a fact: "strict" means
    // *porch orchestrates this builder*, and a builder with no porch project
    // cannot be strict. The source is recorded as `task-default` so the report
    // says where it came from rather than implying the worktree stated it.
    //
    // Scoped deliberately to the no-porch case. A porch-driven builder missing
    // its `## Mode:` line is a genuine ambiguity and still aborts below.
    mode = 'soft';
    modeSource = 'task-default';
  }
  if (!mode) {
    throw new ContextResolutionError(
      `Cannot determine the mode (strict/soft) for '${builderId}': no '## Mode:' line in ` +
        `${join(worktree, '.builder-prompt.txt')}, and this builder is not the bare ad-hoc-task ` +
        `lane that defaults to soft (no task text, or a rendered protocol template). ` +
        `Mode is not persisted anywhere else — pass --mode strict or --mode soft explicitly.`,
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
      `Harness '${harnessName}' has no in-session context reset, so 'afx refresh' cannot clear this ` +
        `builder's context. Only the claude harness supports it today. ` +
        `To give this builder a fresh window, stop it and respawn without --resume.`,
    );
  }

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
    // project id is the correct value when the registry row has none — but ONLY
    // when it is actually an issue number. The `--task --protocol` lane's porch
    // id is `builder-task-<id>`, which would render `- Issue: #builder-task-abc`
    // and an unfollowable `gh issue view builder-task-abc` in the
    // re-orientation. A fabricated issue reference is worse than none: it sends
    // a freshly-reset builder to look up requirements that do not exist.
    issueNumber: issueNumber ?? issueNumberFromPorchId(porch?.projectId),
    taskText,
    isBareTask,
  };
}
