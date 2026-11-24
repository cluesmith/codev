/**
 * The `linked-issue` check of `codev check pr` (Spec 1951 § Linked issue).
 *
 * The architect role requires that the issue closes when the PR merges. The description is
 * read for GitHub's documented closing keywords (`close`, `closes`, `closed`, `fix`, `fixes`,
 * `fixed`, `resolve`, `resolves`, `resolved`, optionally followed by a colon) before
 * `#<id>`. A `builder/<protocol>-<id>` branch names the issue it is for.
 *
 *   - a keyword naming the branch's issue, or any keyword on another branch: `info`
 *   - no keyword: `info`, with the close-by-hand note (a partial fix legitimately has none)
 *   - keywords, none of them naming the branch's issue: attention
 */

import { check, notRun, type Check } from './report.js';

const CLOSING_KEYWORD = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+#(\d+)/gi;
const BUILDER_BRANCH = /^builder\/[a-z]+-(\d+)$/;

export interface ClosingReference {
  /** The keyword as written, e.g. `Fixes`. */
  keyword: string;
  issue: number;
}

/** Every closing keyword in `text`, in order. */
export function closingReferences(text: string): ClosingReference[] {
  return [...text.matchAll(CLOSING_KEYWORD)].map((m) => ({ keyword: m[1], issue: Number(m[2]) }));
}

/** The issue a `builder/<protocol>-<id>` branch is for, or null for any other branch. */
export function branchIssue(branch: string): number | null {
  const match = BUILDER_BRANCH.exec(branch);
  return match ? Number(match[1]) : null;
}

function quote(ref: ClosingReference): string {
  return `"${ref.keyword} #${ref.issue}"`;
}

export function checkLinkedIssue(body: string | null, headRef: string): Check {
  if (body === null) return notRun('linked-issue', 'pr-view did not return body (the description)');
  const refs = closingReferences(body);
  const forBranch = branchIssue(headRef);
  const details: Record<string, unknown> = { references: refs };
  if (forBranch !== null) details.branchIssue = forBranch;

  if (refs.length === 0) {
    const note = forBranch === null ? 'no closing keyword' : `no closing keyword — close #${forBranch} by hand after merge`;
    return check('linked-issue', 'info', note, details);
  }
  const matching = forBranch === null ? undefined : refs.find((r) => r.issue === forBranch);
  const chosen = matching ?? refs[0];
  Object.assign(details, { keyword: chosen.keyword, issue: chosen.issue });
  const others = refs.filter((r) => r !== chosen).map((r) => `#${r.issue}`);
  const also = others.length > 0 ? `; also ${[...new Set(others)].join(', ')}` : '';

  if (forBranch === null) return check('linked-issue', 'info', `${quote(chosen)}${also}`, details);
  if (matching) return check('linked-issue', 'info', `${quote(chosen)} — matches ${headRef}${also}`, details);
  return check('linked-issue', 'attention', `${quote(chosen)}${also}, but ${headRef} is for #${forBranch}`, details);
}
