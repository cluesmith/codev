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
 * `detectBlocked` in packages/codev/src/agent-farm/servers/overview.ts. The five
 * core gates each get their own colour; the non-core protocol gates (experiment /
 * maintain / scope / research, #1779) and any unknown gate Tower reports (it
 * surfaces every pending gate since #1777) share the neutral `--other` styling,
 * so an unrecognised gate never masquerades as a plan review.
 */
function gateKindClass(blocked: string): string {
  switch (blocked) {
    case 'spec review': return 'attention-kind--spec';
    case 'plan review': return 'attention-kind--plan';
    case 'dev review': return 'attention-kind--dev';
    case 'PR review': return 'attention-kind--pr';
    case 'verify review': return 'attention-kind--verify';
    case 'experiment review':
    case 'maintenance review':
    case 'scope review':
    case 'research review': return 'attention-kind--other';
    default: return 'attention-kind--other';
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

export function buildItems(
  prs: OverviewPR[],
  builders: OverviewBuilder[],
): AttentionItem[] {
  const items: AttentionItem[] = [];

  // A PR is waiting on a human exactly when its builder's `pr` gate is pending
  // (#927) — surfaced as the gate-authoritative `prReady` flag from the
  // overview server. Build issueId → prReady / blockedSince lookups so the PR
  // loop can match open PRs to their builder and measure waiting time from the
  // `pr` gate's `requested_at` (carried on `blockedSince`).
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

  // (A) PR rows: open PRs whose linked builder has a pending `pr` gate, plus
  // unaffiliated/human-authored PRs with an outstanding GitHub review. A PR is
  // surfaced ONLY as a PR row — never as a builder standing in for it. If a
  // pr-ready builder's PR is absent from `prs` (cache miss / pagination /
  // merged), nothing is emitted here; the next refresh surfaces it once
  // `pendingPRs` includes the open PR.
  for (const pr of prs) {
    const hasBuilder = pr.linkedIssue !== null && builderIssueIds.has(pr.linkedIssue);
    const prReady = pr.linkedIssue !== null && prReadyIssueIds.has(pr.linkedIssue);
    const readySince = prReady && pr.linkedIssue !== null ? prReadySince.get(pr.linkedIssue) : undefined;
    // Human-authored / externally opened PRs have no porch signal to wait on —
    // fall back to GitHub's reviewDecision and only surface when a review is
    // actually outstanding.
    const unaffiliatedNeedsReview = !hasBuilder && pr.reviewStatus === 'REVIEW_REQUIRED';
    if (!prReady && !unaffiliatedNeedsReview) continue;

    // Affiliated pr-gate PRs measure wait from the gate-requested time the
    // builder carries on `blockedSince` (#927: gate-authoritative ⇒ a prReady
    // builder always has it). Unaffiliated / human-authored PRs have no gate
    // signal, so they use the PR's createdAt. The `?? pr.createdAt` on the
    // affiliated branch is an unreachable type guard — NOT the old gateless
    // BUGFIX fallback (a prReady builder without blockedSince can no longer occur).
    const waitingSince = prReady ? (readySince ?? pr.createdAt) : pr.createdAt;
    items.push({
      key: `pr-${pr.id}`,
      issueOrPR: `#${pr.id}`,
      title: pr.title,
      kind: 'PR review',
      kindClass: 'attention-kind--pr',
      waitingSince,
      url: pr.url,
    });
  }

  // (B) Gate rows: builders blocked on a genuine human-approval gate
  // (spec/plan/dev/verify-approval). PR-ready builders are excluded — they
  // surface ONLY as PR rows above (the dashboard-local "no builder stand-in"
  // rule, #927). Skipping them here also keeps the `pr` gate out of the
  // gate-row path: `pr` remains in the shared GATE_LABELS (VSCode depends on
  // it), but a pr-gate-pending builder is `prReady`, so it never reaches the
  // gate-row emission below.
  for (const b of builders) {
    if (b.prReady) continue;
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
