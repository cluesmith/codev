import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TabBar } from '../src/components/TabBar.js';
import type { Tab } from '../src/hooks/useTabs.js';

// Mock the api module so deleteTab doesn't make real HTTP calls
vi.mock('../src/lib/api.js', () => ({
  deleteTab: vi.fn().mockResolvedValue(undefined),
}));

import { deleteTab } from '../src/lib/api.js';

afterEach(cleanup);

const mockTabs: Tab[] = [
  { id: 'dashboard', type: 'dashboard', label: 'Dashboard', closable: false },
  { id: 'files', type: 'files', label: 'Files', closable: false },
  { id: 'shell-1', type: 'shell', label: 'Shell 1', closable: true, utilId: 'U1' },
];

describe('TabBar', () => {
  it('renders all tabs', () => {
    render(
      <TabBar tabs={mockTabs} activeTabId="dashboard" onSelectTab={() => {}} onRefresh={() => {}} />,
    );
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(screen.getByText('Files')).toBeTruthy();
    expect(screen.getByText('Shell 1')).toBeTruthy();
  });

  it('highlights active tab', () => {
    render(
      <TabBar tabs={mockTabs} activeTabId="files" onSelectTab={() => {}} onRefresh={() => {}} />,
    );
    const filesTab = screen.getByText('Files').closest('button');
    expect(filesTab?.getAttribute('aria-selected')).toBe('true');
  });

  it('calls onSelectTab when tab clicked', () => {
    const onSelect = vi.fn();
    render(
      <TabBar tabs={mockTabs} activeTabId="dashboard" onSelectTab={onSelect} onRefresh={() => {}} />,
    );
    fireEvent.click(screen.getByText('Files'));
    expect(onSelect).toHaveBeenCalledWith('files');
  });

  it('shows close button only for closable tabs', () => {
    render(
      <TabBar tabs={mockTabs} activeTabId="dashboard" onSelectTab={() => {}} onRefresh={() => {}} />,
    );
    const closeButtons = screen.getAllByRole('button', { name: /Close/ });
    expect(closeButtons.length).toBe(1);
  });

  // Regression test for #185: close buttons must send server-provided IDs (no double-prefixing)
  it('calls deleteTab with correct server-provided ID on close', async () => {
    const tabsWithMultipleClosable: Tab[] = [
      { id: 'dashboard', type: 'dashboard', label: 'Dashboard', closable: false },
      { id: 'shell-1', type: 'shell', label: 'Shell 1', closable: true, utilId: 'shell-1' },
      { id: 'builder-0085', type: 'builder', label: 'Builder 0085', closable: true, projectId: 'builder-0085' },
      { id: 'file-abc123', type: 'file', label: 'main.ts', closable: true, annotationId: 'file-abc123' },
    ];

    const onRefresh = vi.fn();
    render(
      <TabBar tabs={tabsWithMultipleClosable} activeTabId="dashboard" onSelectTab={() => {}} onRefresh={onRefresh} />,
    );

    const closeButtons = screen.getAllByRole('button', { name: /Close/ });
    expect(closeButtons.length).toBe(3);

    // Close the shell tab - should send "shell-1" not "shell-shell-1"
    fireEvent.click(closeButtons[0]);
    await waitFor(() => {
      expect(deleteTab).toHaveBeenCalledWith('shell-1');
    });

    // Close the builder tab - should send "builder-0085" not "builder-builder-0085"
    fireEvent.click(closeButtons[1]);
    await waitFor(() => {
      expect(deleteTab).toHaveBeenCalledWith('builder-0085');
    });

    // Close the file tab - should send "file-abc123" not "file-file-abc123"
    fireEvent.click(closeButtons[2]);
    await waitFor(() => {
      expect(deleteTab).toHaveBeenCalledWith('file-abc123');
    });
  });
});
