import type { OverviewPR, OverviewBuilder } from '../lib/api.js';

interface NeedsAttentionListProps {
  prs: OverviewPR[];
  builders: OverviewBuilder[];
}

interface AttentionItem {
  key: string;
  issueOrPR: string;
  title: string;
  kind: string;
  kindClass: string;
  waitingSince: string;
  url?: string;
}

/**
 * Map an OverviewBuilder.blocked label to a CSS class. The labels come from
 * `detectBlocked` in packages/codev/src/agent-farm/servers/overview.ts.
 * Unknown kinds fall back to the plan styling so the row still renders.
 */
function gateKindClass(blocked: string): string {
  switch (blocked) {
    case 'spec review': return 'attention-kind--spec';
    case 'plan review': return 'attention-kind--plan';
    case 'code review': return 'attention-kind--code-review';
    default: return 'attention-kind--plan';
  }
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function buildItems(prs: OverviewPR[], builders: OverviewBuilder[]): AttentionItem[] {
  const items: AttentionItem[] = [];

  // A PR is genuinely waiting on a human only after the builder finishes CMAP
  // and reaches the porch `pr` gate. Surfacing PRs before that means the
  // reviewer arrives ahead of the AI review comments. Cross-reference each
  // PR against the builder's gate state via `linkedIssue` → `issueId`.
  const prGateIssueIds = new Set<string>();
  const builderIssueIds = new Set<string>();
  for (const b of builders) {
    if (b.issueId) {
      builderIssueIds.add(b.issueId);
      if (b.blocked === 'PR review') prGateIssueIds.add(b.issueId);
    }
  }

  for (const pr of prs) {
    const hasBuilder = pr.linkedIssue !== null && builderIssueIds.has(pr.linkedIssue);
    const builderAtPrGate = pr.linkedIssue !== null && prGateIssueIds.has(pr.linkedIssue);
    // Human-authored / externally opened PRs have no porch gate to wait on —
    // fall back to GitHub's reviewDecision and only surface when a review is
    // actually outstanding.
    const unaffiliatedNeedsReview = !hasBuilder && pr.reviewStatus === 'REVIEW_REQUIRED';
    if (!builderAtPrGate && !unaffiliatedNeedsReview) continue;

    items.push({
      key: `pr-${pr.id}`,
      issueOrPR: `#${pr.id}`,
      title: pr.title,
      kind: 'PR review',
      kindClass: 'attention-kind--pr',
      waitingSince: pr.createdAt,
      url: pr.url,
    });
  }

  // Builders blocked on gate approvals
  for (const b of builders) {
    if (!b.blocked || !b.blockedSince) continue;
    // Skip "PR review" — those are emitted by the PR loop above. Without this
    // skip, builders at the pr gate would be counted twice (once per loop).
    if (b.blocked === 'PR review') continue;
    const label = b.issueId ? `#${b.issueId}` : b.id;
    items.push({
      key: `gate-${b.id}`,
      issueOrPR: label,
      title: b.issueTitle || b.id,
      kind: b.blocked,
      kindClass: gateKindClass(b.blocked),
      waitingSince: b.blockedSince,
    });
  }

  // Sort by waiting time (oldest first)
  items.sort((a, b) =>
    new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime()
  );

  return items;
}

export function NeedsAttentionList({ prs, builders }: NeedsAttentionListProps) {
  const items = buildItems(prs, builders);

  if (items.length === 0) {
    return <p className="work-empty">Nothing needs attention</p>;
  }

  return (
    <div className="attention-rows">
      {items.map(item => {
        const inner = (
          <>
            <span className="attention-row-id">{item.issueOrPR}</span>
            <span className="attention-row-title">{item.title}</span>
            <span className={`attention-row-kind ${item.kindClass}`}>{item.kind}</span>
            <span className="attention-row-age">{timeAgo(item.waitingSince)}</span>
          </>
        );

        if (item.url) {
          return (
            <a key={item.key} className="attention-row" href={item.url} target="_blank" rel="noopener noreferrer">
              {inner}
            </a>
          );
        }

        return (
          <div key={item.key} className="attention-row">
            {inner}
          </div>
        );
      })}
    </div>
  );
}
