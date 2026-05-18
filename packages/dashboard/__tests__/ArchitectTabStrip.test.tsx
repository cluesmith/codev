/**
 * Spec 761: ArchitectTabStrip component tests.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ArchitectTabStrip } from '../src/components/ArchitectTabStrip.js';
import type { Tab } from '../src/hooks/useTabs.js';

function archTab(name: string, id: string): Tab {
  return {
    id,
    type: 'architect',
    label: name,
    closable: false,
    terminalId: `term-${name}`,
    architectName: name,
  };
}

afterEach(cleanup);

describe('ArchitectTabStrip (Spec 761)', () => {
  it('renders one button per architect', () => {
    render(
      <ArchitectTabStrip
        tabs={[archTab('main', 'architect'), archTab('sibling', 'architect:sibling')]}
        activeTabId="architect"
        onSelectTab={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('sibling')).toBeInTheDocument();
  });

  it('marks the active tab as aria-selected and tab-active', () => {
    render(
      <ArchitectTabStrip
        tabs={[archTab('main', 'architect'), archTab('sibling', 'architect:sibling')]}
        activeTabId="architect:sibling"
        onSelectTab={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1].className).toContain('tab-active');
    expect(tabs[0].className).not.toContain('tab-active');
  });

  it('calls onSelectTab with the clicked tab id', () => {
    const onSelectTab = vi.fn();
    render(
      <ArchitectTabStrip
        tabs={[archTab('main', 'architect'), archTab('sibling', 'architect:sibling')]}
        activeTabId="architect"
        onSelectTab={onSelectTab}
      />,
    );

    fireEvent.click(screen.getByText('sibling'));
    expect(onSelectTab).toHaveBeenCalledWith('architect:sibling');
  });

  it('renders no close buttons (architect tabs are non-closable)', () => {
    render(
      <ArchitectTabStrip
        tabs={[archTab('main', 'architect'), archTab('sibling', 'architect:sibling')]}
        activeTabId="architect"
        onSelectTab={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText(/close/i)).toBeNull();
  });
});
