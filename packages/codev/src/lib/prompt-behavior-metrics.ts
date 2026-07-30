/**
 * prompt-behavior-metrics.ts — behavioural-impact measurement of prompt changes.
 * Spec 1252, criterion M12 / Appendix D / test T14.
 *
 * Lives in `src/lib/` beside `protocol-drift-audit.ts` and
 * `framework-ref-audit.ts` — same module shape (a measurement library, unit
 * tested), and it needs this package's `js-yaml` dependency, which a root-level
 * `scripts/` file cannot resolve in this pnpm workspace. The runnable entry
 * point is `packages/codev/scripts/measure-prompt-behavior.ts`.
 *
 * ## Why this exists
 *
 * M6 counts words. A word reduction that degrades agent compliance is a loss,
 * and word counts cannot see that. This script measures BEHAVIOUR: how often
 * reviewers demand changes, how many rounds phases take, and whether scar rules
 * are being violated.
 *
 * Run at Phase 1 (before any prompt content changes) to produce the baseline,
 * and again in the post-merge verify phase to compare.
 *
 * ## What is deliberately NOT measured, and why
 *
 * Two metrics were requested and cannot be delivered from committed history.
 * They are omitted rather than faked, because a plausible-looking zero is worse
 * than an absent metric:
 *
 *   - GATE REJECTION COUNTS. Across all projects, a gate's `status` only ever
 *     takes `approved | complete | in_progress | pending` — there is no
 *     `rejected` state — and `requested_at` is a scalar that a re-request
 *     OVERWRITES rather than appends to. A rejected-then-approved gate is
 *     indistinguishable from a clean first-time approval. (Making this minable
 *     would need porch to append gate events; out of scope here.)
 *
 *   - HISTORICAL CONSULT TOKENS/COST. Raw consult logs (`codev/projects/*​/*.txt`)
 *     are gitignored, and `consult stats` is a rolling 30-day machine-local DB.
 *     There is no historical series to baseline against, so B5 is captured as a
 *     FORWARD snapshot only — advisory, non-deterministic, and excluded from
 *     T14's determinism assertion and from every rollback trigger.
 *
 * Usage (from packages/codev):
 *   npx tsx scripts/measure-prompt-behavior.ts [repo-root]
 *   npx tsx scripts/measure-prompt-behavior.ts --json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | string;

interface ReviewRec {
  model?: string;
  verdict?: Verdict;
}
interface HistoryItem {
  iteration?: number;
  plan_phase?: string | null;
  reviews?: ReviewRec[];
}
interface StatusYaml {
  id?: string;
  protocol?: string;
  history?: HistoryItem[];
}

export interface ScarHit {
  rule: string;
  file: string;
  line: number;
  excerpt: string;
}

export interface BehaviorMetrics {
  /** B1 — share of all CMAP verdicts that are REQUEST_CHANGES. */
  b1_requestChangesRate: number;
  b1_verdictCounts: Record<string, number>;
  b1_totalVerdicts: number;
  /** B2 — review rounds per plan phase: max(iteration) per plan_phase. */
  b2_roundsPerPhaseMean: number;
  b2_roundsPerPhaseMedian: number;
  b2_roundsPerPhaseMax: number;
  b2_phaseCount: number;
  /** B3 — candidate scar-rule violations (REQUIRES HUMAN ADJUDICATION). */
  b3_candidateHits: ScarHit[];
  b3_filesScanned: number;
  /** B4 — review rounds per project. */
  b4_roundsPerProjectMean: number;
  b4_roundsPerProjectMedian: number;
  b4_projectCount: number;
  /** Sample provenance. */
  sampleProjects: string[];
}

// ---------------------------------------------------------------------------
// The eight ratified scar rules (decision D3) and their violation markers.
//
// These patterns look for the DANGEROUS COMMAND / ACT, not for the rule text.
// That is still fuzzy: documentation *about* a rule reads much like a violation
// of it. Hence excerpts, not just counts — a human adjudicates before the hard
// rollback trigger fires.
// ---------------------------------------------------------------------------

const SCAR_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: 'git-add-all', re: /\bgit\s+add\s+(-A\b|--all\b|\.(?:\s|$))/ },
  { rule: 'destroy-worktree', re: /\bgit\s+worktree\s+remove\b|\bgit\s+branch\s+-D\b/ },
  { rule: 'destructive-git', re: /\bgit\s+(reset\s+--hard|checkout\s+--\s+\.|clean\s+-[a-z]*f|stash\b)/ },
  { rule: 'auto-approve-gate', re: /auto-?approv\w*/i },
  { rule: 'hand-edit-status', re: /(hand|manual\w*)[- ]edit\w*\s+status\.yaml|edited?\s+status\.yaml\s+(directly|by hand)/i },
  { rule: 'afx-from-worktree', re: /\bafx\s+spawn\b[^\n]*\bfrom\s+(inside\s+)?(a\s+)?worktree/i },
  { rule: 'kill-shellper', re: /kill\w*\s+[^\n]{0,40}shellper/i },
  { rule: 'restart-tower', re: /\b(restart|stop)\w*\s+tower\b/i },
];

/** Phrases indicating the surrounding text DESCRIBES a rule rather than reports a breach. */
const DOCUMENTATION_MARKERS =
  /\b(never|do not|don'?t|must not|forbidden|prohibited|avoid|rule|policy|reminder|guard|prevent)\b/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function walk(dir: string, pred: (p: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, pred));
    else if (pred(p)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metric collection
// ---------------------------------------------------------------------------

/**
 * B1/B2/B4 — CMAP verdicts and review rounds.
 *
 * Sample: projects whose `status.yaml` has a non-empty `history`. In practice
 * this is SPIR (and one legacy `spider`) — porch only persists per-plan-phase
 * review history for protocols that loop that way, so pir/bugfix/air contribute
 * nothing. Sorted for deterministic output.
 */
function collectReviewMetrics(root: string, excludeProjects: string[], includeProjects?: string[]) {
  const projDir = path.join(root, 'codev', 'projects');
  const files = fs.existsSync(projDir)
    ? fs
        .readdirSync(projDir)
        .filter((d) => (includeProjects ? includeProjects.includes(d) : true))
        .filter((d) => !excludeProjects.includes(d))
        .map((d) => path.join(projDir, d, 'status.yaml'))
        .filter((f) => fs.existsSync(f))
        .sort()
    : [];

  const verdictCounts: Record<string, number> = {};
  const phaseRounds: number[] = [];
  const projectRounds: number[] = [];
  const sampleProjects: string[] = [];

  for (const f of files) {
    let doc: StatusYaml;
    try {
      doc = yaml.load(fs.readFileSync(f, 'utf-8')) as StatusYaml;
    } catch {
      continue; // a malformed status file must not abort the measurement
    }
    const history = doc?.history ?? [];
    if (!history.length) continue;

    sampleProjects.push(path.basename(path.dirname(f)));

    const byPhase = new Map<string, number>();
    for (const item of history) {
      for (const r of item.reviews ?? []) {
        const v = r.verdict ?? 'UNKNOWN';
        verdictCounts[v] = (verdictCounts[v] ?? 0) + 1;
      }
      const ph = item.plan_phase ?? '__none__';
      byPhase.set(ph, Math.max(byPhase.get(ph) ?? 0, item.iteration ?? 0));
    }
    const rounds = [...byPhase.values()];
    phaseRounds.push(...rounds);
    projectRounds.push(rounds.reduce((a, b) => a + b, 0));
  }

  const total = Object.values(verdictCounts).reduce((a, b) => a + b, 0);
  return {
    verdictCounts,
    total,
    rcRate: total ? (verdictCounts['REQUEST_CHANGES'] ?? 0) / total : 0,
    phaseRounds,
    projectRounds,
    sampleProjects: sampleProjects.sort(),
  };
}

/**
 * B3 — candidate scar-rule violations mined from committed prose.
 *
 * Scans `codev/reviews/*.md` and `codev/state/*_thread.md`. Emits EXCERPTS, not
 * just counts: the mining cannot distinguish "we violated this" from "never do
 * this", so every hit is a candidate requiring human adjudication. Lines that
 * look like rule documentation are filtered out to cut the obvious noise, but
 * the filter is conservative by design — it is better to hand a human a false
 * positive than to silently drop a real breach.
 */
function collectScarHits(root: string, excludeBasenamePrefixes: string[]) {
  const excluded = (p: string) =>
    excludeBasenamePrefixes.some((pre) => path.basename(p).startsWith(pre));
  const targets = [
    ...walk(path.join(root, 'codev', 'reviews'), (p) => p.endsWith('.md')),
    ...walk(path.join(root, 'codev', 'state'), (p) => p.endsWith('_thread.md')),
  ]
    .filter((p) => !excluded(p))
    .sort();

  const hits: ScarHit[] = [];
  for (const file of targets) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (DOCUMENTATION_MARKERS.test(line)) return; // prescriptive, not a breach report
      for (const { rule, re } of SCAR_PATTERNS) {
        if (re.test(line)) {
          hits.push({
            rule,
            file: path.relative(root, file),
            line: i + 1,
            excerpt: line.trim().slice(0, 200),
          });
          break;
        }
      }
    });
  }
  return { hits, filesScanned: targets.length };
}

export interface MeasureOptions {
  /**
   * Project directory names to exclude from B1/B2/B4.
   *
   * The baseline is defined as the PRE-PROJECT state (spec 1252, M12): the
   * project doing the measuring must not contaminate its own baseline. Its
   * review verdicts accumulate in its status.yaml *while it runs*, so an
   * unexcluded rerun mid-project would drift from the committed artifact —
   * which is exactly how this option came to exist (the Phase-1 reproduction
   * test failed the moment this project's own iter-1 review landed).
   */
  excludeProjects?: string[];
  /**
   * Project directory names to measure EXCLUSIVELY (an allowlist), applied
   * before `excludeProjects`. Unset means "every project on disk".
   *
   * A frozen baseline needs a frozen sample: the committed baseline artifact
   * was computed over the projects that existed at baseline time, so a
   * reproduction against live history must pin that set — otherwise every
   * subsequent project that runs consultations perturbs the numbers and the
   * reproduction fails for reasons that have nothing to do with the metrics
   * (discovered when project 1286's first review iteration moved B1 160 → 163).
   */
  includeProjects?: string[];
  /**
   * Basename prefixes excluded from B3's prose scan, for the same reason: this
   * project's own thread/review discuss scar rules at length and grow with
   * every phase, so scanning them makes B3 non-reproducible AND self-inflating.
   */
  excludeFilePrefixes?: string[];
}

/** This project's own artifacts — excluded from its own baseline by default. */
export const SELF_PROJECT_DIR = '1252-prompt-architecture-single-own';
export const SELF_FILE_PREFIXES = ['spir-1252_', '1252-'];

/** Collect all behavioural metrics for a repo root. Deterministic over B1–B4. */
export function measureBehavior(root: string, opts: MeasureOptions = {}): BehaviorMetrics {
  const rv = collectReviewMetrics(root, opts.excludeProjects ?? [SELF_PROJECT_DIR], opts.includeProjects);
  const scar = collectScarHits(root, opts.excludeFilePrefixes ?? SELF_FILE_PREFIXES);
  return {
    b1_requestChangesRate: round2(rv.rcRate * 100),
    b1_verdictCounts: rv.verdictCounts,
    b1_totalVerdicts: rv.total,
    b2_roundsPerPhaseMean: round2(mean(rv.phaseRounds)),
    b2_roundsPerPhaseMedian: median(rv.phaseRounds),
    b2_roundsPerPhaseMax: rv.phaseRounds.length ? Math.max(...rv.phaseRounds) : 0,
    b2_phaseCount: rv.phaseRounds.length,
    b3_candidateHits: scar.hits,
    b3_filesScanned: scar.filesScanned,
    b4_roundsPerProjectMean: round2(mean(rv.projectRounds)),
    b4_roundsPerProjectMedian: median(rv.projectRounds),
    b4_projectCount: rv.projectRounds.length,
    sampleProjects: rv.sampleProjects,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render metrics as the committed markdown baseline artifact. */
export function render(m: BehaviorMetrics): string {
  const byRule = new Map<string, number>();
  for (const h of m.b3_candidateHits) byRule.set(h.rule, (byRule.get(h.rule) ?? 0) + 1);

  const lines: string[] = [
    '# Behavioural metrics (Spec 1252, M12 / Appendix D)',
    '',
    '## B1 — CMAP verdict distribution',
    '',
    `Total verdicts: **${m.b1_totalVerdicts}** across ${m.b4_projectCount} projects with review history.`,
    '',
    '| Verdict | Count | Share |',
    '|---|---:|---:|',
    ...Object.entries(m.b1_verdictCounts)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([v, c]) =>
          `| ${v} | ${c} | ${round2((c / Math.max(m.b1_totalVerdicts, 1)) * 100)}% |`
      ),
    '',
    `**B1 REQUEST_CHANGES rate: ${m.b1_requestChangesRate}%** — the load-bearing metric.`,
    '',
    '## B2 — review rounds per plan phase',
    '',
    `mean **${m.b2_roundsPerPhaseMean}**, median ${m.b2_roundsPerPhaseMedian}, max ${m.b2_roundsPerPhaseMax} (n=${m.b2_phaseCount} phases)`,
    '',
    '> Advisory only. The observed range is too narrow to detect a subtle',
    '> regression. Note also that phases advance on builder *rebuttal*, not on',
    '> unanimous approval — 0 terminal phases in this corpus end with 3x APPROVE —',
    '> so a "rounds to unanimity" metric would never resolve.',
    '',
    '## B4 — review rounds per project',
    '',
    `mean **${m.b4_roundsPerProjectMean}**, median ${m.b4_roundsPerProjectMedian} (n=${m.b4_projectCount} projects). Advisory.`,
    '',
    '## B3 — candidate scar-rule violations',
    '',
    `Scanned **${m.b3_filesScanned}** files (codev/reviews + codev/state threads).`,
    `Candidate hits: **${m.b3_candidateHits.length}**`,
    '',
    '> **These are CANDIDATES, not findings.** Keyword mining cannot distinguish',
    '> "we did this" from "never do this". Every hit requires human adjudication',
    '> before the hard rollback trigger fires. B3 is the metric that matters most —',
    '> it is the only one that would catch a compressed scar rule losing its force.',
    '',
  ];

  if (byRule.size) {
    lines.push('| Rule | Candidate hits |', '|---|---:|');
    for (const [r, c] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${r} | ${c} |`);
    }
    lines.push('', '### Excerpts for adjudication', '');
    for (const h of m.b3_candidateHits.slice(0, 50)) {
      lines.push(`- \`${h.file}:${h.line}\` **[${h.rule}]** — ${h.excerpt}`);
    }
    if (m.b3_candidateHits.length > 50) {
      lines.push(`- …and ${m.b3_candidateHits.length - 50} more (see --json for the full list)`);
    }
    lines.push('');
  }

  lines.push(
    '## B5 — consult cost/duration',
    '',
    '**Not captured here.** `consult stats` is a rolling 30-day machine-local DB,',
    'so it is not reproducible from a commit. Capture it separately as advisory',
    'context; it is excluded from T14 determinism and drives no rollback trigger.',
    '',
    '## Sample provenance',
    '',
    ...m.sampleProjects.map((p) => `- ${p}`),
    ''
  );
  return lines.join('\n');
}

/** CLI entry, invoked by `packages/codev/scripts/measure-prompt-behavior.ts`. */
export function runCli(argv: string[], cwd: string): string {
  const json = argv.includes('--json');
  const root = argv.find((a) => !a.startsWith('--')) ?? cwd;
  const m = measureBehavior(path.resolve(root));
  return json ? JSON.stringify(m, null, 2) : render(m);
}
