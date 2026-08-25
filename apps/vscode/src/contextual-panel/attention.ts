/**
 * Pure projection of the extension's overview cache into the Attention roll-up.
 *
 * The contextual panel's Attention mode is the fallback view (shown when no artifact / diff /
 * builder-terminal surface resolves). This module turns the `OverviewData` the extension already
 * holds into the small, render-ready `AttentionSummary` the webview draws. It is **pure and
 * `vscode`-free** (the only import is a type), mirroring the panel's pure-core / host-adapter split
 * so it unit-tests without a VS Code host.
 *
 * EXTENSION-LOCAL by design: like the panel's other contract types, `AttentionSummary` crosses only
 * this extension's own `postMessage` boundary, so it deliberately does NOT live in
 * `@cluesmith/codev-types` (wire contracts only). It is a *consumer* of `OverviewData`: it reads
 * fields already on the overview wire and adds no Tower/types surface.
 */

import type { OverviewData } from '@cluesmith/codev-types';

/** A builder an Attention row is about (id + its issue, for the row label). */
export interface AttentionBuilderRef {
  builderId: string;
  issueId: string | null;
  issueTitle: string | null;
}

/** A builder parked on a human gate (a blocked porch gate, or a PR awaiting review). */
export interface GateItem extends AttentionBuilderRef {
  /** Display gate label (e.g. "plan review", or "PR review" for a pending PR). */
  gate: string;
  /** ISO timestamp the builder became blocked, when known (`null` for the PR-ready signal). */
  since: string | null;
}

/** A builder with a countable pending item (held mail rows, or queued review comments). */
export interface CountItem extends AttentionBuilderRef {
  count: number;
}

/**
 * The render-ready Attention roll-up. Lists preserve `OverviewData.builders` order (deterministic;
 * the host does no sorting). `isEmpty` is the single flag the webview reads to choose the honest
 * empty state over the sections.
 */
export interface AttentionSummary {
  /** Builders blocked at a porch gate, plus builders whose PR is awaiting a reviewer. */
  pendingGates: GateItem[];
  /** Workspace-wide count of held mailbox rows (all recipients, including architects). */
  heldTotal: number;
  /** True when at least one held row has crossed the escalation age. */
  heldEscalated: boolean;
  /** Per-builder held-mail counts (only builders with at least one held row). */
  heldMail: CountItem[];
  /** Per-builder queued review-comment counts (only builders with at least one queued). */
  queuedFeedback: CountItem[];
  /** True when nothing needs attention: every list empty AND no mail held anywhere. */
  isEmpty: boolean;
}

const EMPTY: AttentionSummary = {
  pendingGates: [],
  heldTotal: 0,
  heldEscalated: false,
  heldMail: [],
  queuedFeedback: [],
  isEmpty: true,
};

/**
 * Project the overview cache into the Attention roll-up.
 *
 * `data === null` (cache not yet populated, or a transient disconnect) yields the empty summary, so
 * the panel shows the honest empty state rather than stale or half-rendered content.
 */
export function deriveAttention(data: OverviewData | null): AttentionSummary {
  if (data === null) {
    return EMPTY;
  }

  const pendingGates: GateItem[] = [];
  const heldMail: CountItem[] = [];
  const queuedFeedback: CountItem[] = [];

  for (const builder of data.builders) {
    const ref: AttentionBuilderRef = {
      builderId: builder.id,
      issueId: builder.issueId,
      issueTitle: builder.issueTitle,
    };

    // A blocked porch gate (plan / dev review, etc). `blocked` is the display label; `blockedSince`
    // dates it. `prReady` is the separate, uniform "PR waiting on a reviewer" gate signal — a builder
    // can present either, so both are checked independently.
    if (builder.blocked !== null) {
      pendingGates.push({ ...ref, gate: builder.blocked, since: builder.blockedSince });
    }
    if (builder.prReady) {
      pendingGates.push({ ...ref, gate: 'PR review', since: null });
    }

    if (builder.heldCount !== undefined && builder.heldCount > 0) {
      heldMail.push({ ...ref, count: builder.heldCount });
    }

    const queued = data.queuedFeedback[builder.id] ?? 0;
    if (queued > 0) {
      queuedFeedback.push({ ...ref, count: queued });
    }
  }

  const heldTotal = data.heldCount;
  const isEmpty =
    pendingGates.length === 0 &&
    heldMail.length === 0 &&
    queuedFeedback.length === 0 &&
    heldTotal === 0;

  return {
    pendingGates,
    heldTotal,
    heldEscalated: data.mailboxEscalated,
    heldMail,
    queuedFeedback,
    isEmpty,
  };
}
