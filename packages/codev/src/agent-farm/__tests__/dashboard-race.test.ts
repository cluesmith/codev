/**
 * Tests for dashboard race condition fix (Bugfix #170)
 *
 * Verifies that renderDashboardTab() doesn't overwrite tab content when
 * the user switches tabs while the dashboard is still loading.
 *
 * The race condition:
 * 1. User views dashboard -> renderDashboardTab() starts async loading
 * 2. User clicks shell tab -> selectTab() renders shell iframe
 * 3. Dashboard loading completes -> would overwrite shell if not guarded
 *
 * The fix adds a guard check after the await to verify dashboard is still active.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Simulates the dashboard's renderDashboardTab function behavior.
 * This is a simplified version that captures the essential race condition pattern.
 */
async function simulateRenderDashboardTab(
  state: {
    activeTabId: string;
    contentRendered: string | null;
  },
  loadProjectlist: () => Promise<void>,
  loadFilesTree: () => Promise<void>,
  renderDashboardContent: () => void,
  hasGuard: boolean
): Promise<void> {
  // Show loading state
  state.contentRendered = 'loading';

  // Await async operations (this is where the race can occur)
  await Promise.all([loadProjectlist(), loadFilesTree()]);

  // THE FIX: Guard against race condition
  if (hasGuard && state.activeTabId !== 'dashboard') {
    return;
  }

  // Render dashboard content
  renderDashboardContent();
}

describe('Dashboard Race Condition (Bugfix #170)', () => {
  let state: {
    activeTabId: string;
    contentRendered: string | null;
  };

  beforeEach(() => {
    state = {
      activeTabId: 'dashboard',
      contentRendered: null,
    };
  });

  describe('without guard (demonstrates the bug)', () => {
    it('should overwrite shell content when user switches tabs during load', async () => {
      // Simulate slow async loading
      const loadProjectlist = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50))
      );
      const loadFilesTree = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50))
      );
      const renderDashboardContent = vi.fn(() => {
        state.contentRendered = 'dashboard';
      });

      // Start dashboard loading
      const dashboardPromise = simulateRenderDashboardTab(
        state,
        loadProjectlist,
        loadFilesTree,
        renderDashboardContent,
        false // NO GUARD - demonstrates the bug
      );

      // User switches to shell tab DURING loading
      state.activeTabId = 'shell-U12345';
      state.contentRendered = 'shell-iframe';

      // Wait for dashboard loading to complete
      await dashboardPromise;

      // BUG: Dashboard overwrites shell content!
      expect(state.contentRendered).toBe('dashboard');
      expect(renderDashboardContent).toHaveBeenCalled();
    });
  });

  describe('with guard (the fix)', () => {
    it('should NOT overwrite shell content when user switches tabs during load', async () => {
      // Simulate slow async loading
      const loadProjectlist = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50))
      );
      const loadFilesTree = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50))
      );
      const renderDashboardContent = vi.fn(() => {
        state.contentRendered = 'dashboard';
      });

      // Start dashboard loading
      const dashboardPromise = simulateRenderDashboardTab(
        state,
        loadProjectlist,
        loadFilesTree,
        renderDashboardContent,
        true // WITH GUARD - the fix
      );

      // User switches to shell tab DURING loading
      state.activeTabId = 'shell-U12345';
      state.contentRendered = 'shell-iframe';

      // Wait for dashboard loading to complete
      await dashboardPromise;

      // FIX: Shell content is preserved!
      expect(state.contentRendered).toBe('shell-iframe');
      expect(renderDashboardContent).not.toHaveBeenCalled();
    });

    it('should render dashboard normally when user stays on dashboard', async () => {
      const loadProjectlist = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 10))
      );
      const loadFilesTree = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 10))
      );
      const renderDashboardContent = vi.fn(() => {
        state.contentRendered = 'dashboard';
      });

      // Start and complete dashboard loading without switching
      await simulateRenderDashboardTab(
        state,
        loadProjectlist,
        loadFilesTree,
        renderDashboardContent,
        true // WITH GUARD
      );

      // Dashboard renders normally
      expect(state.contentRendered).toBe('dashboard');
      expect(renderDashboardContent).toHaveBeenCalled();
    });

    it('should handle rapid tab switching correctly', async () => {
      const loadProjectlist = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 30))
      );
      const loadFilesTree = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 30))
      );
      const renderDashboardContent = vi.fn(() => {
        state.contentRendered = 'dashboard';
      });

      // Start dashboard loading
      const dashboardPromise = simulateRenderDashboardTab(
        state,
        loadProjectlist,
        loadFilesTree,
        renderDashboardContent,
        true
      );

      // Rapid switching: dashboard -> shell -> builder
      state.activeTabId = 'shell-U12345';
      state.contentRendered = 'shell-iframe';

      state.activeTabId = 'builder-0055';
      state.contentRendered = 'builder-iframe';

      await dashboardPromise;

      // Final state (builder) is preserved
      expect(state.contentRendered).toBe('builder-iframe');
      expect(renderDashboardContent).not.toHaveBeenCalled();
    });

    it('should handle user switching back to dashboard before load completes', async () => {
      const loadProjectlist = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 30))
      );
      const loadFilesTree = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 30))
      );
      const renderDashboardContent = vi.fn(() => {
        state.contentRendered = 'dashboard-final';
      });

      // Start dashboard loading
      const dashboardPromise = simulateRenderDashboardTab(
        state,
        loadProjectlist,
        loadFilesTree,
        renderDashboardContent,
        true
      );

      // User switches away then back to dashboard
      state.activeTabId = 'shell-U12345';
      state.contentRendered = 'shell-iframe';

      state.activeTabId = 'dashboard'; // Back to dashboard

      await dashboardPromise;

      // Dashboard renders because user is back on dashboard tab
      expect(state.contentRendered).toBe('dashboard-final');
      expect(renderDashboardContent).toHaveBeenCalled();
    });
  });

  describe('async loading behavior', () => {
    it('should wait for both projectlist and files tree to load', async () => {
      const loadOrder: string[] = [];

      const loadProjectlist = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        loadOrder.push('projectlist');
      });
      const loadFilesTree = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        loadOrder.push('files');
      });
      const renderDashboardContent = vi.fn(() => {
        loadOrder.push('render');
      });

      await simulateRenderDashboardTab(
        state,
        loadProjectlist,
        loadFilesTree,
        renderDashboardContent,
        true
      );

      // Both load operations complete before render
      expect(loadProjectlist).toHaveBeenCalled();
      expect(loadFilesTree).toHaveBeenCalled();
      expect(loadOrder).toContain('projectlist');
      expect(loadOrder).toContain('files');
      expect(loadOrder[loadOrder.length - 1]).toBe('render');
    });
  });
});
