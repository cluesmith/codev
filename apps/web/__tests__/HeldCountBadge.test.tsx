import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { HeldCountBadge } from '../src/components/HeldCountBadge.js';

afterEach(cleanup);

describe('HeldCountBadge', () => {
  it('renders nothing when the count is 0', () => {
    const { container } = render(<HeldCountBadge count={0} escalated={false} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('held-badge')).toBeNull();
  });

  it('renders nothing for a negative count (defensive)', () => {
    const { container } = render(<HeldCountBadge count={-1} escalated={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the held count when greater than 0', () => {
    render(<HeldCountBadge count={3} escalated={false} />);
    expect(screen.getByTestId('held-badge')).toBeTruthy();
    expect(screen.getByText('3 held')).toBeTruthy();
  });

  it('is not in the attention state when not escalated', () => {
    render(<HeldCountBadge count={2} escalated={false} />);
    const badge = screen.getByTestId('held-badge');
    expect(badge.className).not.toContain('held-badge--attention');
    expect(badge.querySelector('.held-dot--attention')).toBeNull();
  });

  it('enters the attention state (pulsing dot) when escalated', () => {
    render(<HeldCountBadge count={1} escalated={true} />);
    const badge = screen.getByTestId('held-badge');
    expect(badge.className).toContain('held-badge--attention');
    expect(badge.querySelector('.held-dot--attention')).toBeTruthy();
  });
});
