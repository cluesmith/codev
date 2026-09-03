import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { HeldMessage } from '@cluesmith/codev-types';
import { HeldCountBadge } from '../src/components/HeldCountBadge.js';

afterEach(cleanup);

/** A held row with sensible defaults; override only what a test cares about. */
function row(over: Partial<HeldMessage> = {}): HeldMessage {
  return {
    id: 'row-1',
    workspacePath: '/ws',
    toAgent: 'cost',
    fromAgent: 'architect',
    reason: 'busy',
    // Required on HeldMessage (Issue #1482). Defaulted here so the fixture typechecks on its
    // own terms — apps/web's tsconfig excludes __tests__, so an omission would go unnoticed
    // until someone widened the include.
    detail: null,
    escalated: false,
    createdAt: Date.now() - 90_000, // 1m ago
    notBefore: null,
    ...over,
  };
}

const noMessages = () => Promise.resolve<HeldMessage[]>([]);

/** Open the panel and wait for its first load to settle. */
async function open(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('held-badge'));
  return screen.findByTestId('held-popover');
}

describe('HeldCountBadge', () => {
  // ---------------------------------------------------------------- Spec 1313 contract
  // These five predate Issue 1450 and must keep passing unchanged: the badge's
  // count-only / zero-state / attention behaviour is not what the popover changed.

  it('renders nothing when the count is 0', () => {
    const { container } = render(<HeldCountBadge count={0} escalated={false} loadMessages={noMessages} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('held-badge')).toBeNull();
  });

  it('renders nothing for a negative count (defensive)', () => {
    const { container } = render(<HeldCountBadge count={-1} escalated={false} loadMessages={noMessages} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the held count when greater than 0', () => {
    render(<HeldCountBadge count={3} escalated={false} loadMessages={noMessages} />);
    expect(screen.getByTestId('held-badge')).toBeTruthy();
    expect(screen.getByText('3 held')).toBeTruthy();
  });

  it('is not in the attention state when not escalated', () => {
    render(<HeldCountBadge count={2} escalated={false} loadMessages={noMessages} />);
    const badge = screen.getByTestId('held-badge');
    expect(badge.className).not.toContain('held-badge--attention');
    expect(badge.querySelector('.held-dot--attention')).toBeNull();
  });

  it('enters the attention state (pulsing dot) when escalated', () => {
    render(<HeldCountBadge count={1} escalated={true} loadMessages={noMessages} />);
    const badge = screen.getByTestId('held-badge');
    expect(badge.className).toContain('held-badge--attention');
    expect(badge.querySelector('.held-dot--attention')).toBeTruthy();
  });

  // ---------------------------------------------------------------- Issue 1450: affordance

  it('is a button wired as a disclosure, collapsed by default', () => {
    render(<HeldCountBadge count={1} escalated={false} loadMessages={noMessages} />);
    const badge = screen.getByTestId('held-badge');
    // A real <button> is what buys keyboard activation (Enter/Space) and focusability for
    // free — the affordance is not just the underline.
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    expect(badge.getAttribute('aria-controls')).toBeTruthy();
    // Disclosure pattern, not a dialog — see the component docstring.
    expect(badge.getAttribute('aria-haspopup')).toBeNull();
    expect(screen.queryByTestId('held-popover')).toBeNull();
  });

  it('points aria-controls at the panel it actually opens', async () => {
    render(<HeldCountBadge count={1} escalated={false} loadMessages={noMessages} />);
    const badge = screen.getByTestId('held-badge');
    const panel = await open();
    expect(panel.id).toBe(badge.getAttribute('aria-controls'));
  });

  it('opens the panel on click and loads the messages once', async () => {
    const loadMessages = vi.fn(() => Promise.resolve([row()]));
    render(<HeldCountBadge count={1} escalated={false} loadMessages={loadMessages} />);

    await open();

    expect(screen.getByTestId('held-badge').getAttribute('aria-expanded')).toBe('true');
    expect(loadMessages).toHaveBeenCalledTimes(1);
  });

  it('does not fetch until the panel is opened', () => {
    const loadMessages = vi.fn(noMessages);
    render(<HeldCountBadge count={1} escalated={false} loadMessages={loadMessages} />);
    expect(loadMessages).not.toHaveBeenCalled();
  });

  it('closes again on a second click', async () => {
    render(<HeldCountBadge count={1} escalated={false} loadMessages={() => Promise.resolve([row()])} />);
    const badge = screen.getByTestId('held-badge');

    await open();
    fireEvent.click(badge);

    expect(screen.queryByTestId('held-popover')).toBeNull();
    expect(badge.getAttribute('aria-expanded')).toBe('false');
  });

  // ---------------------------------------------------------------- Issue 1450: row rendering

  it('renders each message as from → to', async () => {
    render(
      <HeldCountBadge
        count={1}
        escalated={false}
        loadMessages={() => Promise.resolve([row({ fromAgent: 'architect', toAgent: 'cost' })])}
      />,
    );
    await open();
    expect(await screen.findByText('architect → cost')).toBeTruthy();
  });

  it('renders a missing sender as "?" (matching afx inbox)', async () => {
    render(
      <HeldCountBadge
        count={1}
        escalated={false}
        loadMessages={() => Promise.resolve([row({ fromAgent: null, toAgent: 'cost' })])}
      />,
    );
    await open();
    expect(await screen.findByText('? → cost')).toBeTruthy();
  });

  it('renders age and reason, and marks an escalated row', async () => {
    const now = Date.now();
    render(
      <HeldCountBadge
        count={1}
        escalated={true}
        loadMessages={() =>
          Promise.resolve([row({ createdAt: now - 120_000, reason: 'no-live-pty', escalated: true })])
        }
      />,
    );
    await open();

    const rowEl = await screen.findByTestId('held-row');
    expect(rowEl.textContent).toContain('2m');
    expect(rowEl.textContent).toContain('no-live-pty');
    expect(rowEl.textContent).toContain('!');
    expect(rowEl.className).toContain('held-row--attention');
  });

  it('falls back to "held" when the row carries no reason', async () => {
    render(
      <HeldCountBadge count={1} escalated={false} loadMessages={() => Promise.resolve([row({ reason: null })])} />,
    );
    await open();
    expect((await screen.findByTestId('held-row')).textContent).toContain('held');
  });

  // ------------------------------------------------- Issue 1450: the Held / Scheduled split
  // The blocking finding from plan review: `heldCount` excludes pre-due `--delay` rows
  // (heldSummaryForWorkspace filters not_before) while GET /api/inbox lists them
  // (listHeld does not). The panel must render that difference, not hide it.

  it('groups a pre-due row separately so the Held group matches the badge count', async () => {
    const now = Date.now();
    const due = row({ id: 'due', fromAgent: 'architect', toAgent: 'cost', notBefore: null });
    const preDue = row({ id: 'pre', fromAgent: 'architect', toAgent: 'docs', notBefore: now + 15_000 });

    // count=1 is what the server reports for these two rows: only `due` is eligible.
    render(<HeldCountBadge count={1} escalated={false} loadMessages={() => Promise.resolve([due, preDue])} />);
    await open();

    const heldGroup = await screen.findByTestId('held-group-held');
    const scheduledGroup = screen.getByTestId('held-group-scheduled');

    // THE assertion: the group the user reads as "the held mail" is exactly the badge count.
    expect(heldGroup.querySelectorAll('li')).toHaveLength(1);
    expect(heldGroup.textContent).toContain('architect → cost');
    expect(scheduledGroup.querySelectorAll('li')).toHaveLength(1);
    expect(scheduledGroup.textContent).toContain('architect → docs');
    expect(screen.getByText('Held (1)')).toBeTruthy();
    expect(screen.getByText('Scheduled (1)')).toBeTruthy();
  });

  it('renders a scheduled row with a countdown and the "scheduled" reason, not an age', async () => {
    // Pin the clock: the component samples `Date.now()` at render, so a countdown built from
    // a real `Date.now()` in the fixture floors to 14s once a millisecond of test time has
    // passed. Freezing it makes the assertion about the FORMAT, not about scheduling luck.
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      render(
        <HeldCountBadge
          count={1}
          escalated={false}
          loadMessages={() =>
            Promise.resolve([row({ id: 'a', notBefore: null }), row({ id: 'b', notBefore: now + 15_000 })])
          }
        />,
      );
      await open();

      const scheduled = await screen.findByTestId('held-group-scheduled');
      expect(scheduled.textContent).toContain('→15s');
      expect(scheduled.textContent).toContain('scheduled');
      // Its own `reason` ('busy') is suppressed — a scheduled row is not stuck.
      expect(scheduled.textContent).not.toContain('busy');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('is absent entirely when the only row is scheduled (count 0) — the documented edge', () => {
    // heldSummaryForWorkspace excludes pre-due rows, so heldCount is 0 and the badge does
    // not render. `afx inbox` remains the surface for a scheduled-only state.
    const { container } = render(
      <HeldCountBadge count={0} escalated={false} loadMessages={() => Promise.resolve([row({ notBefore: Date.now() + 15_000 })])} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('omits a group entirely when it has no rows', async () => {
    render(<HeldCountBadge count={1} escalated={false} loadMessages={() => Promise.resolve([row()])} />);
    await open();

    expect(await screen.findByTestId('held-group-held')).toBeTruthy();
    expect(screen.queryByTestId('held-group-scheduled')).toBeNull();
  });

  // ---------------------------------------------------------------- Issue 1450: load states

  it('shows an explicit empty state rather than a blank panel', async () => {
    render(<HeldCountBadge count={1} escalated={false} loadMessages={noMessages} />);
    await open();
    expect((await screen.findByTestId('held-empty')).textContent).toContain('No held messages');
  });

  it('shows an error state when the fetch fails, not a silent empty list', async () => {
    render(
      <HeldCountBadge
        count={1}
        escalated={false}
        loadMessages={() => Promise.reject(new Error('Failed to fetch held messages: 401'))}
      />,
    );
    await open();

    // A 401 must read as a failure, not as "nothing is held" — the two look identical
    // otherwise, and one of them is a lie.
    const err = await screen.findByTestId('held-error');
    expect(err.textContent).toContain('401');
    expect(screen.queryByTestId('held-empty')).toBeNull();
  });

  it('never renders a message body, even if the server sends one', async () => {
    // Defence in depth for the Spec 1313 redaction rule: the projection carries no body,
    // and the component must not surface one if a future/rogue payload includes it.
    const withBody = { ...row(), body: 'SECRET-BODY-TEXT' } as unknown as HeldMessage;
    render(<HeldCountBadge count={1} escalated={false} loadMessages={() => Promise.resolve([withBody])} />);
    const panel = await open();
    await screen.findByTestId('held-row');
    expect(panel.textContent).not.toContain('SECRET-BODY-TEXT');
  });

  // ---------------------------------------------------------------- Issue 1450: lifecycle

  it('discards a stale response from a fast open → close → open', async () => {
    let call = 0;
    const slowFirst = () => {
      call++;
      return call === 1
        ? new Promise<HeldMessage[]>((r) =>
            setTimeout(() => r([row({ id: 'stale', fromAgent: 'stale-from', toAgent: 'stale-to' })]), 50),
          )
        : Promise.resolve([row({ id: 'fresh', fromAgent: 'fresh-from', toAgent: 'fresh-to' })]);
    };
    render(<HeldCountBadge count={1} escalated={false} loadMessages={slowFirst} />);
    const badge = screen.getByTestId('held-badge');

    fireEvent.click(badge); // open  → slow request in flight
    fireEvent.click(badge); // close
    fireEvent.click(badge); // open  → fast request resolves first

    expect(await screen.findByText('fresh-from → fresh-to')).toBeTruthy();

    // Let the slow first response land; it must NOT overwrite the fresh data.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(screen.queryByText('stale-from → stale-to')).toBeNull();
    expect(screen.getByText('fresh-from → fresh-to')).toBeTruthy();
  });

  it('refetches when the count changes while the panel is open', async () => {
    const loadMessages = vi.fn(() => Promise.resolve([row()]));
    const { rerender } = render(<HeldCountBadge count={1} escalated={false} loadMessages={loadMessages} />);

    await open();
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(1));

    // The SSE-driven count moved — the open panel should follow, not go stale.
    rerender(<HeldCountBadge count={2} escalated={false} loadMessages={loadMessages} />);
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
  });

  it('does not refetch on an unrelated rerender', async () => {
    const loadMessages = vi.fn(() => Promise.resolve([row()]));
    const { rerender } = render(<HeldCountBadge count={1} escalated={false} loadMessages={loadMessages} />);

    await open();
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(1));

    rerender(<HeldCountBadge count={1} escalated={true} loadMessages={loadMessages} />);
    await act(async () => { await Promise.resolve(); });
    expect(loadMessages).toHaveBeenCalledTimes(1);
  });

  it('stays mounted when the last held row is delivered while the panel is open', async () => {
    const loadMessages = vi.fn(() => Promise.resolve<HeldMessage[]>([]));
    const { rerender } = render(<HeldCountBadge count={1} escalated={false} loadMessages={loadMessages} />);

    await open();

    // useOverview polls every 2.5s; the last row clearing must not yank the button out from
    // under the user's focus mid-interaction.
    rerender(<HeldCountBadge count={0} escalated={false} loadMessages={loadMessages} />);

    expect(screen.getByTestId('held-badge')).toBeTruthy();
    expect(screen.getByTestId('held-popover')).toBeTruthy();
    expect((await screen.findByTestId('held-empty')).textContent).toContain('Held mail cleared');
  });

  it('says nothing is held when the held rows drain but a scheduled row remains', async () => {
    // count -> 0 with a pre-due row still listed: the panel is NOT empty, but there is
    // nothing HELD, and the Scheduled group's "not counted above" needs a line above it.
    const now = Date.now();
    const loadMessages = () => Promise.resolve([row({ id: 'sched', notBefore: now + 15_000 })]);
    const { rerender } = render(<HeldCountBadge count={1} escalated={false} loadMessages={loadMessages} />);
    await open();
    rerender(<HeldCountBadge count={0} escalated={false} loadMessages={loadMessages} />);

    const note = await screen.findByTestId('held-empty');
    expect(note.textContent).toContain('scheduled');
    expect(screen.queryByTestId('held-group-held')).toBeNull();
    expect(screen.getByTestId('held-group-scheduled')).toBeTruthy();
  });

  it('unmounts once the user closes a panel whose count already dropped to 0', async () => {
    const { rerender, container } = render(
      <HeldCountBadge count={1} escalated={false} loadMessages={noMessages} />,
    );
    await open();
    rerender(<HeldCountBadge count={0} escalated={false} loadMessages={noMessages} />);

    fireEvent.click(screen.getByTestId('held-badge')); // close
    expect(container.firstChild).toBeNull();
  });

  it('closes on Escape and returns focus to the button', async () => {
    render(<HeldCountBadge count={1} escalated={false} loadMessages={() => Promise.resolve([row()])} />);
    const badge = screen.getByTestId('held-badge');

    await open();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('held-popover')).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  it('ignores unrelated keys while open', async () => {
    render(<HeldCountBadge count={1} escalated={false} loadMessages={() => Promise.resolve([row()])} />);
    await open();

    fireEvent.keyDown(document, { key: 'a' });
    expect(screen.getByTestId('held-popover')).toBeTruthy();
  });

  it('closes when clicking outside the badge', async () => {
    render(
      <div>
        <HeldCountBadge count={1} escalated={false} loadMessages={() => Promise.resolve([row()])} />
        <button type="button">elsewhere</button>
      </div>,
    );

    await open();
    fireEvent.mouseDown(screen.getByText('elsewhere'));

    expect(screen.queryByTestId('held-popover')).toBeNull();
  });

  it('stays open when clicking inside the panel', async () => {
    render(<HeldCountBadge count={1} escalated={false} loadMessages={() => Promise.resolve([row()])} />);
    const panel = await open();

    fireEvent.mouseDown(panel);

    expect(screen.getByTestId('held-popover')).toBeTruthy();
  });

  it('detaches its document listeners on unmount', async () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(
      <HeldCountBadge count={1} escalated={false} loadMessages={() => Promise.resolve([row()])} />,
    );
    await open();
    unmount();

    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain('keydown');
    expect(removed).toContain('mousedown');
    removeSpy.mockRestore();
  });

  // ---------------------------------------------------------------- Issue #1482
  // The popover is the surface an operator reaches for without a terminal. Showing a bare
  // `busy` there, while `afx inbox` shows `busy:user-text`, means the two surfaces describe
  // the same row differently — and the operator cannot tell "a human is typing, this clears
  // itself" from "the classifier is stuck, this never clears" from the dashboard at all.

  it('renders the gate detail as a `reason:detail` sub-code', async () => {
    render(
      <HeldCountBadge
        count={1}
        escalated={false}
        loadMessages={() => Promise.resolve([row({ reason: 'busy', detail: 'user-text' })])}
      />,
    );
    await open();
    expect((await screen.findByTestId('held-row')).textContent).toContain('busy:user-text');
  });

  it.each(['no-region-end', 'no-composer-marker'] as const)(
    'renders the unverifiable detail %s, the class of hold that never clears itself',
    async (detail) => {
      render(
        <HeldCountBadge
          count={1}
          escalated={false}
          loadMessages={() => Promise.resolve([row({ reason: 'busy', detail })])}
        />,
      );
      await open();
      expect((await screen.findByTestId('held-row')).textContent).toContain(`busy:${detail}`);
    },
  );

  it('still renders a bare reason when the row carries no detail', async () => {
    render(
      <HeldCountBadge
        count={1}
        escalated={false}
        loadMessages={() => Promise.resolve([row({ reason: 'no-live-pty', detail: null })])}
      />,
    );
    await open();
    const text = (await screen.findByTestId('held-row')).textContent!;
    expect(text).toContain('no-live-pty');
    expect(text).not.toContain('no-live-pty:');
  });

  it('a scheduled row still reads "scheduled", detail notwithstanding', async () => {
    // A scheduled row is waiting on the clock, not stuck behind a composer. Leaking a stale
    // gate detail onto it would describe a problem that does not exist.
    const now = Date.now();
    render(
      <HeldCountBadge
        count={1}
        escalated={false}
        loadMessages={() =>
          Promise.resolve([row({ reason: 'busy', detail: 'user-text', notBefore: now + 30_000 })])
        }
      />,
    );
    await open();
    const text = (await screen.findByTestId('held-row')).textContent!;
    expect(text).toContain('scheduled');
    expect(text).not.toContain('user-text');
  });
});
