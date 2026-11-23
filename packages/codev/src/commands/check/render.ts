/**
 * Rendering for `codev check` (Spec 1951 § Output and exit codes).
 *
 * The human form: the verdict line first, naming what needs attention; then the header; then
 * one line per check with its status word. `--json` writes exactly one object to stdout.
 * Each command supplies its own verdict text, header and labels; the layout lives here.
 */

import type { Check, ErrorReport, Status } from './report.js';
import { needsAttention } from './report.js';

export const STATUS_WORD: Record<Status, string> = {
  ok: 'ok',
  attention: 'ATTN',
  info: 'info',
  'not-run': 'not run',
  off: 'off',
  skip: 'skip',
};

/** How a check id reads in the human form, where it differs from the id. */
const DEFAULT_LABELS: Record<string, string> = {
  'trial-merge': 'trial merge',
  'linked-issue': 'linked issue',
  'to-read': 'to read',
  'on-branch': 'on branch',
  'deploy-run': 'deploy run',
  'merge-checks': 'merge checks',
};

export function defaultLabel(id: string): string {
  return DEFAULT_LABELS[id] ?? id;
}

export interface RenderOptions {
  /** The label printed for a check; defaults to `defaultLabel(check.id)`. */
  label?: (check: Check) => string;
  /**
   * A qualifier for a check named on the verdict line, e.g. `running` for
   * `checks (running)`. A not-run check is qualified `not run` unless this says otherwise.
   */
  qualifier?: (check: Check) => string | null;
}

/** The names on the verdict line: each check needing attention, with its qualifier. */
export function attentionNames(checks: readonly Check[], options: RenderOptions = {}): string[] {
  const label = options.label ?? ((c: Check) => defaultLabel(c.id));
  return checks.filter(needsAttention).map((c) => {
    const qualifier = options.qualifier?.(c) ?? (c.status === 'not-run' ? 'not run' : null);
    return qualifier ? `${label(c)} (${qualifier})` : label(c);
  });
}

const STATUS_WIDTH = Math.max(...Object.values(STATUS_WORD).map((w) => w.length)) + 1;

/**
 * One line per check: `  ATTN    attribution   2 lines: …`. A summary's continuation
 * lines (separated by `\n`) are indented to the summary column.
 */
export function renderChecks(checks: readonly Check[], options: RenderOptions = {}): string[] {
  const label = options.label ?? ((c: Check) => defaultLabel(c.id));
  const labelWidth = Math.max(0, ...checks.map((c) => label(c).length)) + 3;
  const indent = ' '.repeat(2 + STATUS_WIDTH + labelWidth);
  const lines: string[] = [];
  for (const c of checks) {
    const [first, ...rest] = c.summary.split('\n');
    lines.push(`  ${STATUS_WORD[c.status].padEnd(STATUS_WIDTH)}${label(c).padEnd(labelWidth)}${first}`.trimEnd());
    for (const line of rest) lines.push(`${indent}${line}`.trimEnd());
  }
  return lines;
}

export interface HumanSection {
  /** A line printed above the section's checks (e.g. `#1948  merged … → main`). */
  title?: string;
  checks: readonly Check[];
}

export interface HumanReport {
  verdictLine: string;
  header: readonly string[];
  sections: readonly HumanSection[];
}

export function renderHuman(report: HumanReport, options: RenderOptions = {}): string {
  const lines: string[] = [report.verdictLine, ''];
  if (report.header.length > 0) lines.push(...report.header);
  for (const section of report.sections) {
    if (section.title !== undefined) lines.push(section.title);
    lines.push(...renderChecks(section.checks, options));
  }
  return `${lines.join('\n')}\n`;
}

/** `--json`: exactly one object. */
export function renderJson(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The human form of an exit-2 failure, for stderr. */
export function renderErrorHuman(report: ErrorReport): string {
  const lines = [`codev check ${report.command}: ${report.error.message}`];
  if (report.error.cause) lines.push(...report.error.cause.split('\n').map((l) => `  ${l}`));
  return `${lines.join('\n')}\n`;
}

/** The short form of a SHA for the human output. */
export function short(sha: string): string {
  return sha.slice(0, 7);
}
