/**
 * Issue 1450: age/countdown formatting for the dashboard's held-mail popover.
 *
 * Ported — deliberately, not imported — from the `afx inbox` CLI renderer
 * (`packages/codev/src/agent-farm/commands/inbox.ts:77-90`). The web app must not import
 * from `@cluesmith/codev-core` (server/client isolation, #1189), and `@cluesmith/codev-types`
 * is a types-only devDependency, the wrong home for a runtime helper. Ten lines duplicated
 * beats a boundary violation; keeping the output identical to the CLI's is what lets a
 * reviewer check the popover against `afx inbox` row for row.
 *
 * Named `formatHeldAge` rather than `formatDuration` because
 * `apps/web/src/lib/open-files-shells-utils.ts` already exports a `formatDuration` with
 * DIFFERENT semantics (minute granularity, `<1m` floor) and existing callers. Two
 * same-named formatters with different output in one `lib/` is a trap.
 */

import type { HeldMessage, PeerQueuePause } from '@cluesmith/codev-types';

/**
 * Compact human duration ("5s", "3m", "2h", "1d") from a millisecond delta.
 * Second-granularity, matching the CLI — held mail is often seconds old, and "<1m"
 * would erase the distinction between "just held" and "held for most of a minute".
 * Negative deltas clamp to `0s`.
 */
export function formatHeldDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Compact human age ("5s", "3m", "2h", "1d") from an epoch-ms timestamp. */
export function formatHeldAge(createdAt: number, now: number): string {
  return formatHeldDuration(now - createdAt);
}

/**
 * Is this row a pre-due `--delay` send — scheduled rather than stuck?
 *
 * The single predicate that splits the popover's two groups, and the same test the CLI
 * applies (`inbox.ts:135`). A scheduled row is excluded from `OverviewData.heldCount` by
 * `heldSummaryForWorkspace`, so grouping on exactly this predicate is what makes the
 * "Held" group's length equal the badge count.
 */
export function isScheduled(notBefore: number | null, now: number): boolean {
  return notBefore != null && notBefore > now;
}

/**
 * Spec 1967: is this row mail from another Tower held for a human's release? It waits for
 * `afx inbox release`, not for an agent, so it is counted apart from `heldCount` (as
 * `heldForReleaseCount`) and listed in a group of its own.
 */
export function isHeldForRelease(message: Pick<HeldMessage, 'reason'>): boolean {
  return message.reason === 'held-for-release';
}

/** The workspace's mailbox rows as the popover groups them. */
export interface HeldMailGroups {
  /** Waiting for a local agent: exactly the rows `OverviewData.heldCount` counts. */
  held: HeldMessage[];
  /** Pre-due `--delay` sends: listed, never counted. */
  scheduled: HeldMessage[];
  /** From another Tower, held for a human's release: `OverviewData.heldForReleaseCount`. */
  forRelease: HeldMessage[];
}

/**
 * Split the rows `GET /api/inbox` lists into the popover's groups, each row into exactly one.
 * Held for release is decided first: such a row waits for a human whatever else it carries.
 * The rest split on {@link isScheduled}, as before. So each group's length is the count the
 * badge shows for it, which is what lets a reader check one against the other.
 */
export function groupHeldMail(messages: readonly HeldMessage[], now: number): HeldMailGroups {
  const groups: HeldMailGroups = { held: [], scheduled: [], forRelease: [] };
  for (const message of messages) {
    if (isHeldForRelease(message)) groups.forRelease.push(message);
    else if (isScheduled(message.notBefore, now)) groups.scheduled.push(message);
    else groups.held.push(message);
  }
  return groups;
}

/** Who a row is from, as `afx inbox` names it: a remote sender's full address, else the agent, else `?`. */
export function heldSenderOf(message: Pick<HeldMessage, 'fromAgent' | 'remoteSender'>): string {
  return message.remoteSender ?? message.fromAgent ?? '?';
}

/** Why no mail for another Tower leaves now, as `afx inbox` says it, without the command. */
export function peerPauseText(pause: PeerQueuePause): string {
  switch (pause) {
    case 'remote-off':
      return 'Not sent now: remote messaging is off on this Tower.';
    case 'not-connected':
      return 'Not sent now: this Tower is not connected to Codev Cloud.';
    case 'not-registered':
      return "Not sent now: this Tower's registration was removed from Codev Cloud.";
    case 'no-relay':
      return 'Not sent now: this Codev Cloud has no relay.';
  }
}
