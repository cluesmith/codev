import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TabBar } from '../src/components/TabBar.js';
import type { Tab } from '../src/hooks/useTabs.js';

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
});
