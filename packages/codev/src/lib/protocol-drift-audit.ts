/**
 * Protocol-file drift audit (#1210).
 *
 * Detects two silent failure modes of the four-tier resolver
 * (`.codev/` → `codev/` → cache → installed skeleton):
 *
 *  1. **Shadow drift** — a project-local copy (tier-1 `.codev/` or tier-2 `codev/`)
 *     of a framework file that ALSO ships in the installed skeleton. The resolver
 *     serves the local copy, so a stale snapshot of an old upstream default keeps
 *     winning forever, silently, even after the package ships a fix. This audit
 *     diffs each local copy against its skeleton counterpart and classifies it:
 *       - `identical` → a redundant copy that adds nothing but risk (safe to remove;
 *         resolution then falls back to the package).
 *       - `differs`   → "customized or stale? — adjudicate" (a human must decide;
 *         we NEVER auto-act).
 *
 *  2. **Skeleton staleness** — the installed `@cluesmith/codev` package is itself a
 *     version behind npm `latest`, so even NON-shadowed resolution serves pre-fix
 *     framework files. Reported as an explicit `installed X; latest Y` pair
 *     (a computed "N behind" distance is not crisply testable), best-effort and
 *     offline-tolerant.
 *
 * Report-only: this module performs NO writes to disk. Adjudication stays human —
 * local copies may be deliberate customizations (that is the resolver's whole point).
 *
 * Mirrors the existing doctor audit precedents: `pr-gate-audit.ts` (#943) and
 * `framework-ref-audit.ts` (#1011) — a pure lib returning findings + formatters,
 * consumed by `commands/doctor.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getSkeletonDir, listSkeletonFiles, resolveCodevFile, findWorkspaceRoot } from './skeleton.js';
import { version as installedVersion } from '../version.js';

/**
 * The framework subtrees whose files ship in the skeleton and resolve via the
 * four-tier resolver. Pinned scan set (per the spec) — prompts and per-protocol
 * templates live WITHIN `protocols/`, so they are covered transitively.
 *
 * Maintenance point: a new top-level framework subtree must be added here (same
 * shape as `PR_PRODUCING_PROTOCOLS` in pr-gate-audit). `codev/resources/` is
 * deliberately EXCLUDED — those are user-evolved files (arch.md, lessons-learned.md,
 * and their -critical companions), not framework files, and must never be flagged.
 */
export const FRAMEWORK_DRIFT_DIRS = ['protocols', 'consult-types', 'roles'] as const;

/** Only these extensions are framework files worth diffing. */
const FRAMEWORK_EXTS = new Set(['.md', '.json']);

/** The two project-local override roots, in resolver-precedence order (tier 1 first). */
const OVERRIDE_TIERS = ['.codev', 'codev'] as const;
export type OverrideTier = (typeof OVERRIDE_TIERS)[number];

export type DriftStatus = 'identical' | 'differs';

export interface DriftFinding {
  /** Path relative to the skeleton/override root, e.g. `protocols/spir/protocol.md`. */
  relativePath: string;
  /** Which local override root holds this copy. */
  tier: OverrideTier;
  /** Byte-comparison result against the skeleton counterpart. */
  status: DriftStatus;
  /**
   * Whether the four-tier resolver actually resolves THIS copy (i.e. it is the
   * live one the runtime loads). A tier-2 `codev/` copy shadowed by a tier-1
   * `.codev/` copy is still reported (it is still rot), but marked not-the-winner.
   */
  isResolvedWinner: boolean;
}

export interface StalenessResult {
  /** Installed `@cluesmith/codev` version. */
  installed: string;
  /** npm `latest`, or null when the registry could not be reached. */
  latest: string | null;
  /** True only when a latest version was obtained AND installed < latest. */
  behind: boolean;
  /** Human note when latest could not be determined. */
  note?: string;
}

/** Injectable seam for the npm-latest lookup so tests are deterministic (no network). */
export type FetchLatest = () => string | null;

/** SHA-256 of a file's raw bytes (no text decoding — EOL/trailing-newline sensitive). */
function hashBytes(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Skeleton-relative framework files under a scan-set subtree, filtered to
 * framework extensions. Enumerated via the resolver's own `listSkeletonFiles`
 * (over `getSkeletonDir()`) so this audit and runtime resolution agree on exactly
 * what the skeleton is. Returned paths (e.g. `protocols/spir/protocol.md`) are
 * both the skeleton-relative and the override-relative path.
 */
function skeletonFrameworkFiles(sub: string): string[] {
  return listSkeletonFiles(sub).filter((rel) => FRAMEWORK_EXTS.has(path.extname(rel)));
}

/**
 * Audit a project for shadow drift against the installed skeleton.
 *
 * For every framework file in the skeleton (under FRAMEWORK_DRIFT_DIRS), checks
 * whether a local copy exists in `.codev/` and/or `codev/`; for each local copy
 * found, byte-compares it against the skeleton file and records a finding. Returns
 * one finding per local copy (so a file present in BOTH tiers yields two findings).
 *
 * @param workspaceRoot - project root (auto-detected via findWorkspaceRoot if omitted)
 */
export function auditProtocolDrift(workspaceRoot?: string): DriftFinding[] {
  const root = workspaceRoot ?? findWorkspaceRoot();
  const skeletonDir = getSkeletonDir();
  const findings: DriftFinding[] = [];

  for (const sub of FRAMEWORK_DRIFT_DIRS) {
    for (const rel of skeletonFrameworkFiles(sub)) {
      const skeletonPath = path.join(skeletonDir, rel);
      let skeletonHash: string;
      try {
        skeletonHash = hashBytes(skeletonPath);
      } catch {
        continue; // unreadable skeleton file — nothing to diff against
      }

      // Which copy does the resolver actually pick? (absolute path or null)
      const resolved = resolveCodevFile(rel, root);
      const resolvedAbs = resolved ? path.resolve(resolved) : null;

      for (const tier of OVERRIDE_TIERS) {
        const localPath = path.join(root, tier, rel);
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) continue;

        const status: DriftStatus =
          hashBytes(localPath) === skeletonHash ? 'identical' : 'differs';
        findings.push({
          relativePath: rel,
          tier,
          status,
          isResolvedWinner: resolvedAbs === path.resolve(localPath),
        });
      }
    }
  }

  return findings;
}

/**
 * Whether the project has ANY local copy of a scanned skeleton file, in EITHER
 * override root. Cheap existence-only scan (no hashing) used for the no-op gate:
 * the existing `hasLocalOverride()` only checks tier-2 `codev/`, so drift detection
 * must check both tiers itself.
 */
export function hasFrameworkShadows(workspaceRoot?: string): boolean {
  const root = workspaceRoot ?? findWorkspaceRoot();
  for (const sub of FRAMEWORK_DRIFT_DIRS) {
    for (const rel of skeletonFrameworkFiles(sub)) {
      for (const tier of OVERRIDE_TIERS) {
        if (fs.existsSync(path.join(root, tier, rel))) return true;
      }
    }
  }
  return false;
}

/** Parse a dotted version into numeric parts; non-numeric segments → 0. */
function parseVersion(v: string): number[] {
  return v.split('.').map((p) => parseInt(p.replace(/[^0-9]/g, ''), 10) || 0);
}

/** True if `a` is strictly older than `b` (semver-ish, major.minor.patch). */
function versionLt(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

/** Bound on the npm-latest lookup (ms). The registry can't stall doctor beyond this. */
export const NPM_LATEST_TIMEOUT_MS = 2500;

/**
 * Default npm-latest lookup: `npm view @cluesmith/codev version`. Bounded by
 * `NPM_LATEST_TIMEOUT_MS` (spawnSync kills the child past it) and offline-tolerant —
 * an unreachable registry, non-zero exit, missing `npm`, or unparsable output all
 * yield `null` rather than throwing or hanging. Exported so tests can assert the
 * real bounded/offline behavior (not just an injected stub).
 */
export function fetchLatestVersion(): string | null {
  try {
    const r = spawnSync('npm', ['view', '@cluesmith/codev', 'version'], {
      encoding: 'utf-8',
      timeout: NPM_LATEST_TIMEOUT_MS,
      stdio: 'pipe',
    });
    if (r.status === 0 && r.stdout) {
      const v = r.stdout.trim();
      return /^\d+\.\d+\.\d+/.test(v) ? v : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compare the installed package version against npm `latest`. Never throws and
 * never hangs beyond the fetch timeout — an unreachable registry yields
 * `{ latest: null, behind: false, note }` so doctor stays usable offline.
 *
 * @param fetchLatest - injectable latest-version source (defaults to `npm view`)
 */
export function checkSkeletonStaleness(
  fetchLatest: FetchLatest = fetchLatestVersion,
): StalenessResult {
  const installed = installedVersion;
  let latest: string | null = null;
  try {
    latest = fetchLatest();
  } catch {
    latest = null;
  }
  if (!latest) {
    return { installed, latest: null, behind: false, note: 'could not check (offline?)' };
  }
  return { installed, latest, behind: versionLt(installed, latest) };
}

/**
 * Render a shadow-drift finding for doctor output.
 *
 * @param skeletonVersion - installed skeleton/package version; when provided it is
 *   named in the line so the human can tell WHICH skeleton the local copy diverged
 *   from (the spec requires the adjudication warning to name the package version).
 */
export function formatDriftFinding(f: DriftFinding, skeletonVersion?: string): string {
  const loc = `${f.tier}/${f.relativePath}`;
  const ver = skeletonVersion ? ` v${skeletonVersion}` : '';
  if (f.status === 'identical') {
    return `${loc} — byte-identical redundant copy of the installed skeleton${ver}; safe to remove (resolution then falls back to the package)`;
  }
  const winner = f.isResolvedWinner ? ' [resolved — this copy is live]' : '';
  return `${loc} — differs from installed skeleton${ver}; customized or stale? — adjudicate${winner}`;
}

/** Render the staleness result for doctor output. */
export function formatStaleness(s: StalenessResult): string {
  if (s.latest === null) {
    return `installed ${s.installed}; latest: ${s.note ?? 'unknown'}`;
  }
  if (s.behind) {
    return `installed ${s.installed}; latest ${s.latest} — behind (run: codev update)`;
  }
  return `installed ${s.installed}; latest ${s.latest} (up to date)`;
}
