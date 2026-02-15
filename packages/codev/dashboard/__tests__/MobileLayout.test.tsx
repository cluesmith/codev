/**
 * Regression test for GitHub Issue #285: Overview tab bar disappears on scroll (mobile)
 *
 * Verifies that MobileLayout renders the tab bar outside the scrollable
 * content area, and that .mobile-content is a flex container so child
 * content (like .dashboard-container) is properly height-constrained
 * and scrolls within its bounds rather than pushing the tab bar offscreen.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MobileLayout } from '../src/components/MobileLayout.js';
import type { Tab } from '../src/hooks/useTabs.js';

afterEach(cleanup);

const mockTabs: Tab[] = [
  { id: 'dashboard', type: 'dashboard', label: 'Overview', closable: false },
  { id: 'architect', type: 'architect', label: 'Architect', closable: false },
];

describe('MobileLayout (Bugfix #285)', () => {
  it('renders tab-bar as a sibling before mobile-content, not inside it', () => {
    const { container } = render(
      <MobileLayout tabs={mockTabs} activeTabId="dashboard" onSelectTab={() => {}} onRefresh={() => {}}>
        <div className="dashboard-container">Content</div>
      </MobileLayout>,
    );

    const mobileLayout = container.querySelector('.mobile-layout');
    expect(mobileLayout).toBeTruthy();

    const children = Array.from(mobileLayout!.children);
    expect(children.length).toBe(2);

    // Tab bar is first child, mobile-content is second
    expect(children[0].classList.contains('tab-bar')).toBe(true);
    expect(children[1].classList.contains('mobile-content')).toBe(true);
  });

  it('renders children inside mobile-content, not alongside tab-bar', () => {
    const { container } = render(
      <MobileLayout tabs={mockTabs} activeTabId="dashboard" onSelectTab={() => {}} onRefresh={() => {}}>
        <div data-testid="child-content">Test content</div>
      </MobileLayout>,
    );

    const mobileContent = container.querySelector('.mobile-content');
    expect(mobileContent).toBeTruthy();
    expect(mobileContent!.querySelector('[data-testid="child-content"]')).toBeTruthy();

    // Child should NOT be a direct child of .mobile-layout
    const tabBar = container.querySelector('.tab-bar');
    expect(tabBar!.querySelector('[data-testid="child-content"]')).toBeNull();
  });
});
