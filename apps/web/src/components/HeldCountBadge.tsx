/**
 * Spec 1313 Phase 8 / Issue 1450: the dashboard header's held-mail indicator.
 *
 * Renders the number of currently-*held* (undelivered) mailbox rows in the workspace, fed by
 * `OverviewData.heldCount` (which the overview refetches live on the `overview-changed`
 * broadcast). When at least one held row has crossed the escalation age
 * (`OverviewData.mailboxEscalated`) the badge enters an attention state — a pulsing amber dot —
 * and clears back to normal when the row resolves. Renders nothing when the count is zero, so
 * it stays out of the way until there is held mail.
 *
 * Issue 1450 made it a **disclosure button**: clicking it opens a panel listing each held
 * message as `from → to` with its age and why-held reason, so "2 held" stops sending the user
 * to a terminal to find out who is stuck. Still strictly READ-ONLY — dismissal remains CLI-only
 * (`afx inbox dismiss`, spec Decision 8), and the list carries no message bodies (the redaction
 * rule; `afx inbox show <id>` is the body path).
 *
 * ## Held vs Scheduled — why the panel groups rows
 *
 * The badge count and the list come from DIFFERENT queries and legitimately disagree.
 * `heldSummaryForWorkspace` (the count) requires `not_before IS NULL OR not_before <= now`, so a
 * pre-due `--delay` send is "scheduled, not stuck" and does not inflate the attention count.
 * `listHeld` (behind `GET /api/inbox`) has no such filter and returns every held row. So
 * `count <= messages.length`, always.
 *
 * Rather than hide that, the panel groups: **Held (N)** — where N is exactly the badge count —
 * and a secondary **Scheduled (M)** section for pre-due rows, with their due countdown. Each
 * group renders only when non-empty, so the ordinary case (no `--delay` in flight) looks like a
 * single plain list. This mirrors `afx inbox`, which lists both and labels the pre-due ones
 * `scheduled`.
 *
 * Consequence worth knowing: with 0 due and 1 scheduled row the badge does not render at all,
 * so a scheduled-only state is invisible here. That is the existing contract — the badge is an
 * *attention* indicator — and `afx inbox` remains the surface that sees it.
 *
 * Presentational: it takes a `loadMessages` loader rather than importing `fetchInbox`, so it
 * unit-tests in isolation with a fake loader, mirroring `CloudStatus`.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { HeldMessage } from '../lib/api.js';
import { formatHeldAge, formatHeldDuration, formatHoldVerdict, isScheduled } from '../lib/heldMail.js';

export interface HeldCountBadgeProps {
  /** Count of currently-held ELIGIBLE rows across the workspace (`OverviewData.heldCount`). */
  count: number;
  /** True when at least one held row has crossed the escalation age. */
  escalated: boolean;
  /**
   * Fetches the workspace's held rows. Called on open, and again whenever `count` changes
   * while open. Injected so the component stays presentational and testable.
   */
  loadMessages: () => Promise<HeldMessage[]>;
}

/** What the panel is currently showing. */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; messages: HeldMessage[] };

function HeldRow({ message, now }: { message: HeldMessage; now: number }) {
  const scheduled = isScheduled(message.notBefore, now);
  // `?` for a missing sender matches how `afx inbox` renders the same row.
  const fromTo = `${message.fromAgent ?? '?'} → ${message.toAgent}`;
  // A scheduled row shows its countdown to due time; a stuck one shows how long it has waited.
  const when = scheduled
    ? `→${formatHeldDuration(message.notBefore! - now)}`
    : formatHeldAge(message.createdAt, now);
  // Issue #1482: the gate detail rides along as a `reason:detail` sub-code, exactly as
  // `afx inbox` renders it — a popover that says `busy` where the CLI says `busy:user-text`
  // would have the two surfaces describing the same row differently.
  const reason = scheduled ? 'scheduled' : formatHoldVerdict(message.reason, message.detail);
  return (
    <li className={`held-row${message.escalated ? ' held-row--attention' : ''}`} data-testid="held-row">
      <span className="held-row-addresses">{fromTo}</span>
      <span className="held-row-meta">
        {when} · {reason}
        {message.escalated && !scheduled ? '!' : ''}
      </span>
    </li>
  );
}

export function HeldCountBadge({ count, escalated, loadMessages }: HeldCountBadgeProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  // In-flight flag, separate from `state`: a refetch keeps the previous rows rendered, so
  // "is a request outstanding" can no longer be read off the state union.
  const [busy, setBusy] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Discards a response whose request is no longer the current one. Without this, a fast
  // open → close → open lands the FIRST (slower) response over the second's data; React 19
  // does not warn about setState on an unmounted/stale path, so the bug would be silent.
  const generationRef = useRef(0);

  // The loader is read through a ref so `load` (and therefore the fetch effect) does not
  // depend on the prop's IDENTITY. App.tsx passes the module-level `fetchInbox`, which is
  // stable — but an inline lambda from any future caller would change identity every render
  // and turn the effect into a refetch loop. Behaviour should not hinge on a caller
  // remembering to memoize.
  const loaderRef = useRef(loadMessages);
  useEffect(() => {
    loaderRef.current = loadMessages;
  }, [loadMessages]);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setBusy(true);
    // Keep already-loaded rows on screen while refetching rather than blanking to "Loading…".
    // A refetch fires whenever `count` changes while the panel is open, and flashing the list
    // away is exactly the wrong moment to do it — the user is watching to see what moved.
    // `aria-busy` carries the in-flight state instead. Only a cold open shows the spinner.
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    loaderRef.current().then(
      (messages) => {
        if (generationRef.current !== generation) return;
        setBusy(false);
        setState({ kind: 'ready', messages });
      },
      (err: unknown) => {
        if (generationRef.current !== generation) return;
        setBusy(false);
        // An error DOES replace the rows: once a refetch has failed, the previous list is no
        // longer known to be current, and showing it as if it were would be a lie.
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    // No deps: the loader is reached through `loaderRef`, so `load` is stable for the
    // lifetime of the component and the fetch effect fires only on open / count change.
  }, []);

  // Load on open, and again when `count` changes while open. Refetch rather than snapshot:
  // the count is SSE-driven, so a change means the mailbox actually moved — precisely when a
  // user staring at the open panel would expect it to follow.
  useEffect(() => {
    if (!open) return;
    load();
  }, [open, count, load]);

  // Escape closes and returns focus to the button (the disclosure pattern's keyboard contract).
  // Click-outside closes without moving focus, since the user is already looking elsewhere.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  // Normally the badge disappears at zero. But `useOverview` polls every 2.5s, so the last
  // held row being delivered WHILE the panel is open would unmount the button mid-interaction
  // and drop focus to <body>. So when open, stay mounted and say the mail cleared; the user's
  // own close unmounts us. The closed-at-zero contract is unchanged.
  if (count <= 0 && !open) {
    return null;
  }

  const label = `${count} held`;
  const title = escalated
    ? `${count} held message${count === 1 ? '' : 's'} — at least one past the escalation age. Click to list them.`
    : `${count} held message${count === 1 ? '' : 's'} awaiting a clear prompt. Click to list them.`;

  // `now` is sampled per render rather than ticked on a timer: the panel is a triage glance,
  // and every refetch re-renders anyway. A live-ticking age would be motion for its own sake.
  const now = Date.now();
  const messages = state.kind === 'ready' ? state.messages : [];
  const heldRows = messages.filter((m) => !isScheduled(m.notBefore, now));
  const scheduledRows = messages.filter((m) => isScheduled(m.notBefore, now));

  return (
    <div className="held-badge-wrapper" ref={wrapperRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`held-badge${escalated ? ' held-badge--attention' : ''}`}
        data-testid="held-badge"
        title={title}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`held-dot${escalated ? ' held-dot--attention' : ''}`} />
        {label}
      </button>
      {/* aria-live: the rows arrive asynchronously after the panel opens, so without it a
          screen reader announces an empty container and never mentions the messages. */}
      {open && (
        <div
          className="held-popover"
          id={panelId}
          data-testid="held-popover"
          aria-live="polite"
          aria-busy={busy}
        >
          {state.kind === 'loading' && <p className="held-popover-note">Loading…</p>}
          {state.kind === 'error' && (
            <p className="held-popover-note held-popover-note--error" data-testid="held-error">
              Could not load held messages: {state.message}
            </p>
          )}
          {/* Keyed on heldRows, not messages: when the held rows drain but a SCHEDULED row
              remains, the panel is not empty yet there is still nothing held — and the
              Scheduled group's "not counted above" needs something above it to refer to. */}
          {state.kind === 'ready' && heldRows.length === 0 && (
            <p className="held-popover-note" data-testid="held-empty">
              {count <= 0 && messages.length > 0 ? 'No held messages — the rows below are scheduled.'
                : count <= 0 ? 'Held mail cleared.'
                : 'No held messages.'}
            </p>
          )}
          {heldRows.length > 0 && (
            <section className="held-group">
              <h2 className="held-group-title">Held ({heldRows.length})</h2>
              <ul className="held-list" data-testid="held-group-held">
                {heldRows.map((m) => (
                  <HeldRow key={m.id} message={m} now={now} />
                ))}
              </ul>
            </section>
          )}
          {scheduledRows.length > 0 && (
            <section className="held-group held-group--scheduled">
              <h2 className="held-group-title">Scheduled ({scheduledRows.length})</h2>
              <p className="held-group-note">
                Waiting for their due time — not counted above.
              </p>
              <ul className="held-list" data-testid="held-group-scheduled">
                {scheduledRows.map((m) => (
                  <HeldRow key={m.id} message={m} now={now} />
                ))}
              </ul>
            </section>
          )}
          {/* Points at `afx inbox` rather than `afx inbox dismiss <id>`: dismissal needs a row
              id, and this panel deliberately shows none (a full uuid would dominate the row
              and this surface never mutates anyway). `afx inbox` is where the ids live. */}
          <p className="held-popover-foot">Ids and dismissal: <code>afx inbox</code></p>
        </div>
      )}
    </div>
  );
}
