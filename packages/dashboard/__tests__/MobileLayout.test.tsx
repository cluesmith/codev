/**
 * Regression test for GitHub Issue #285: Overview tab bar disappears on scroll (mobile)
 *
 * Verifies that MobileLayout renders the tab bar outside the scrollable
 * content area, and that the .mobile-content CSS rule is a flex container
 * so child content (like .dashboard-container) is properly height-constrained
 * and scrolls within its bounds rather than pushing the tab bar offscreen.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MobileLayout } from '../src/components/MobileLayout.js';
import type { Tab } from '../src/hooks/useTabs.js';

afterEach(cleanup);

const mockTabs: Tab[] = [
  { id: 'dashboard', type: 'work', label: 'Overview', closable: false },
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

  it('renders children inside mobile-content, not inside tab-bar', () => {
    const { container } = render(
      <MobileLayout tabs={mockTabs} activeTabId="dashboard" onSelectTab={() => {}} onRefresh={() => {}}>
        <div data-testid="child-content">Test content</div>
      </MobileLayout>,
    );

    const mobileContent = container.querySelector('.mobile-content');
    expect(mobileContent).toBeTruthy();
    expect(mobileContent!.querySelector('[data-testid="child-content"]')).toBeTruthy();

    // Child should NOT be inside tab-bar
    const tabBar = container.querySelector('.tab-bar');
    expect(tabBar!.querySelector('[data-testid="child-content"]')).toBeNull();
  });

  it('.mobile-content CSS rule has display:flex and flex-direction:column', () => {
    // JSDOM doesn't load external CSS, so we verify the stylesheet directly.
    // This catches the exact regression: if someone removes the flex properties
    // from .mobile-content, the dashboard content won't be height-constrained
    // and the tab bar will scroll offscreen on mobile.
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(__dirname, '../src/index.css'), 'utf-8');

    // Extract the .mobile-content rule block (not inside a media query or nested selector)
    const match = css.match(/\.mobile-content\s*\{([^}]+)\}/);
    expect(match).toBeTruthy();

    const rule = match![1];
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex-direction:\s*column/);
  });
});
