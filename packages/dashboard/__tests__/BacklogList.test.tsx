import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BacklogList } from '../src/components/BacklogList.js';
import type { OverviewBacklogItem } from '../src/lib/api.js';

afterEach(() => {
  cleanup();
});

function makeItem(overrides: Partial<OverviewBacklogItem> = {}): OverviewBacklogItem {
  return {
    id: '1',
    title: 'Test issue',
    url: 'https://github.com/org/repo/issues/1',
    type: 'project',
    priority: 'medium',
    hasSpec: false,
    hasPlan: false,
    hasReview: false,
    hasBuilder: false,
    createdAt: new Date().toISOString(),
    author: 'waleedkadous',
    ...overrides,
  };
}

describe('BacklogList assignee rendering', () => {
  it('renders "a: none" when there are no assignees', () => {
    const items = [makeItem({ id: '1', title: 'Unassigned' })];
    render(<BacklogList items={items} />);

    expect(screen.getByText('r: @waleedkadous')).toBeInTheDocument();
    expect(screen.getByText('a: none')).toBeInTheDocument();
  });

  it('renders a single assignee as "a: @login"', () => {
    const items = [
      makeItem({ id: '2', title: 'One assignee', assignees: ['amr'] }),
    ];
    render(<BacklogList items={items} />);

    expect(screen.getByText('a: @amr')).toBeInTheDocument();
  });

  it('renders multiple assignees comma-separated', () => {
    const items = [
      makeItem({ id: '3', title: 'Many assignees', assignees: ['amr', 'bob'] }),
    ];
    render(<BacklogList items={items} />);

    expect(screen.getByText('a: @amr, @bob')).toBeInTheDocument();
  });

  it('treats empty assignees array as no assignees', () => {
    const items = [makeItem({ id: '4', title: 'Empty list', assignees: [] })];
    render(<BacklogList items={items} />);

    expect(screen.getByText('a: none')).toBeInTheDocument();
  });
});
