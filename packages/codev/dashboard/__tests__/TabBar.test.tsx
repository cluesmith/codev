import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TabBar, TAB_ICONS } from '../src/components/TabBar.js';
import type { Tab } from '../src/hooks/useTabs.js';

vi.mock('../src/lib/api.js', () => ({
  deleteTab: vi.fn(() => Promise.resolve()),
}));

afterEach(cleanup);

const mockTabs: Tab[] = [
  { id: 'work', type: 'work', label: 'Work', closable: false },
  { id: 'files', type: 'files', label: 'Files', closable: false },
  { id: 'shell-1', type: 'shell', label: 'Shell 1', closable: true, utilId: 'U1' },
];

describe('TabBar', () => {
  it('renders all tabs', () => {
    render(
      <TabBar tabs={mockTabs} activeTabId="work" onSelectTab={() => {}} onRefresh={() => {}} />,
    );
    expect(screen.getByText('Work')).toBeTruthy();
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
      <TabBar tabs={mockTabs} activeTabId="work" onSelectTab={onSelect} onRefresh={() => {}} />,
    );
    fireEvent.click(screen.getByText('Files'));
    expect(onSelect).toHaveBeenCalledWith('files');
  });

  it('shows close button only for closable tabs', () => {
    render(
      <TabBar tabs={mockTabs} activeTabId="work" onSelectTab={() => {}} onRefresh={() => {}} />,
    );
    const closeButtons = screen.getAllByRole('button', { name: /Close/ });
    expect(closeButtons.length).toBe(1);
  });
});

describe('TabBar icons', () => {
  it('renders icon for each tab type', () => {
    const allTypeTabs: Tab[] = [
      { id: 'w', type: 'work', label: 'Work', closable: false },
      { id: 'a', type: 'architect', label: 'Architect', closable: false },
      { id: 'b', type: 'builder', label: 'Builder', closable: true, projectId: 'p1' },
      { id: 's', type: 'shell', label: 'Shell', closable: true, utilId: 'u1' },
      { id: 'f', type: 'file', label: 'test.ts', closable: true, annotationId: 'a1' },
      { id: 'act', type: 'activity', label: 'Activity', closable: false },
      { id: 'fs', type: 'files', label: 'Files', closable: false },
    ];

    const { container } = render(
      <TabBar tabs={allTypeTabs} activeTabId="w" onSelectTab={() => {}} onRefresh={() => {}} />,
    );

    const iconSpans = container.querySelectorAll('.tab-icon');
    expect(iconSpans.length).toBe(7);

    expect(iconSpans[0].textContent).toBe(TAB_ICONS.work);
    expect(iconSpans[1].textContent).toBe(TAB_ICONS.architect);
    expect(iconSpans[2].textContent).toBe(TAB_ICONS.builder);
    expect(iconSpans[3].textContent).toBe(TAB_ICONS.shell);
    expect(iconSpans[4].textContent).toBe(TAB_ICONS.file);
    expect(iconSpans[5].textContent).toBe(TAB_ICONS.activity);
    expect(iconSpans[6].textContent).toBe(TAB_ICONS.files);
  });

  it('icon spans have aria-hidden="true"', () => {
    const { container } = render(
      <TabBar tabs={mockTabs} activeTabId="work" onSelectTab={() => {}} onRefresh={() => {}} />,
    );

    const iconSpans = container.querySelectorAll('.tab-icon');
    for (const icon of iconSpans) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('icon appears before label in DOM order', () => {
    const { container } = render(
      <TabBar tabs={mockTabs} activeTabId="work" onSelectTab={() => {}} onRefresh={() => {}} />,
    );

    const firstTab = container.querySelector('.tab');
    const children = firstTab!.children;
    expect(children[0].className).toBe('tab-icon');
    expect(children[1].className).toBe('tab-label');
  });

  it('TAB_ICONS covers all tab types', () => {
    const expectedTypes: Tab['type'][] = ['work', 'files', 'architect', 'builder', 'shell', 'file', 'activity'];
    for (const type of expectedTypes) {
      expect(TAB_ICONS[type]).toBeTruthy();
      expect(typeof TAB_ICONS[type]).toBe('string');
    }
  });

  it('close button works with icons present', async () => {
    const { deleteTab } = await import('../src/lib/api.js');
    const onRefresh = vi.fn();

    render(
      <TabBar tabs={mockTabs} activeTabId="work" onSelectTab={() => {}} onRefresh={onRefresh} />,
    );

    const closeButton = screen.getByRole('button', { name: /Close Shell 1/ });
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(deleteTab).toHaveBeenCalledWith('shell-1');
      expect(onRefresh).toHaveBeenCalled();
    });
  });
});
