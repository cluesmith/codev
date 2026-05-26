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
    case 'PR review': return 'attention-kind--pr';
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
  // for the PR-creating phase. Issue #872 made this a canonical `prReady`
  // boolean so consumers don't have to derive it from the protocol-specific
  // gate shape (the v3.1.3 derivation `blocked === 'PR review'` silently
  // dropped BUGFIX because BUGFIX has no `pr` gate). Track `blockedSince`
  // when present so the waiting-time chip measures "how long since the human
  // became the bottleneck", with a fallback to the PR's createdAt for
  // BUGFIX-style protocols whose pr-ready state isn't a gate.
  const prReadySince = new Map<string, string>();
  const prReadyIssueIds = new Set<string>();
  const builderIssueIds = new Set<string>();
  for (const b of builders) {
    if (b.issueId) {
      builderIssueIds.add(b.issueId);
      if (b.prReady) {
        prReadyIssueIds.add(b.issueId);
        if (b.blockedSince) prReadySince.set(b.issueId, b.blockedSince);
      }
    }
  }

  // Track which pr-ready builders had their PR successfully emitted. If a
  // builder signals prReady but its PR is missing from `prs` (cache delay,
  // pagination, transient API failure), the builder loop below still surfaces
  // it so a real human-action signal isn't silently dropped.
  const emittedPrReadyIssueIds = new Set<string>();

  for (const pr of prs) {
    const hasBuilder = pr.linkedIssue !== null && builderIssueIds.has(pr.linkedIssue);
    const prReady = pr.linkedIssue !== null && prReadyIssueIds.has(pr.linkedIssue);
    const readySince = prReady && pr.linkedIssue !== null ? prReadySince.get(pr.linkedIssue) : undefined;
    // Human-authored / externally opened PRs have no porch signal to wait on —
    // fall back to GitHub's reviewDecision and only surface when a review is
    // actually outstanding.
    const unaffiliatedNeedsReview = !hasBuilder && pr.reviewStatus === 'REVIEW_REQUIRED';
    if (!prReady && !unaffiliatedNeedsReview) continue;

    if (prReady && pr.linkedIssue) emittedPrReadyIssueIds.add(pr.linkedIssue);
    items.push({
      key: `pr-${pr.id}`,
      issueOrPR: `#${pr.id}`,
      title: pr.title,
      kind: 'PR review',
      kindClass: 'attention-kind--pr',
      waitingSince: readySince || pr.createdAt,
      url: pr.url,
    });
  }

  // Surface prReady builders and gate-blocked builders. Two independent
  // signals — they share a loop but the prReady check must come BEFORE the
  // gate-blocked early-out, otherwise BUGFIX builders (blocked = null,
  // blockedSince = null) are filtered out before the prReady path fires and
  // the missing-PR defense quietly drops them.
  for (const b of builders) {
    // Already surfaced as a PR row above — skip to avoid double-counting.
    if (b.prReady && b.issueId && emittedPrReadyIssueIds.has(b.issueId)) continue;

    // prReady builder whose PR didn't appear in `prs` (cache miss, pagination,
    // transient API failure). Surface anyway so we don't silently drop a real
    // human-action signal. blockedSince may be absent for gateless protocols
    // (BUGFIX) — fall back to startedAt so the waiting chip still renders.
    if (b.prReady) {
      const label = b.issueId ? `#${b.issueId}` : b.id;
      items.push({
        key: `gate-${b.id}`,
        issueOrPR: label,
        title: b.issueTitle || b.id,
        kind: 'PR review',
        kindClass: 'attention-kind--pr',
        waitingSince: b.blockedSince || b.startedAt || new Date().toISOString(),
      });
      continue;
    }

    // Gate-blocked (non-PR) builders.
    if (!b.blocked || !b.blockedSince) continue;
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
