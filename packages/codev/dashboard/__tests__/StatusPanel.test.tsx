import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StatusPanel } from '../src/components/StatusPanel.js';
import type { DashboardState } from '../src/lib/api.js';

afterEach(cleanup);

const emptyState: DashboardState = {
  architect: null,
  builders: [],
  utils: [],
  annotations: [],
};

const populatedState: DashboardState = {
  architect: { port: 4201, pid: 1234 },
  builders: [
    {
      id: 'B1', name: 'Builder 0085', port: 4210, pid: 2345,
      status: 'implementing', phase: 'phase-1', worktree: '.builders/0085',
      branch: 'builder/0085', type: 'spec',
    },
  ],
  utils: [
    { id: 'U1', name: 'Shell 1', port: 4230, pid: 3456 },
  ],
  annotations: [
    { id: 'A1', file: '/src/main.ts', port: 4250, pid: 4567, parent: { type: 'architect' } },
  ],
};

describe('StatusPanel', () => {
  it('shows loading when state is null', () => {
    render(<StatusPanel state={null} onRefresh={() => {}} />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('shows empty messages for empty state', () => {
    render(<StatusPanel state={emptyState} onRefresh={() => {}} />);
    expect(screen.getByText('No builders spawned')).toBeTruthy();
    expect(screen.getByText('No shell tabs open')).toBeTruthy();
    expect(screen.getByText('No file tabs open')).toBeTruthy();
  });

  it('shows builders, shells, and files', () => {
    render(<StatusPanel state={populatedState} onRefresh={() => {}} />);
    expect(screen.getByText('Builder 0085')).toBeTruthy();
    expect(screen.getByText('Shell 1')).toBeTruthy();
    expect(screen.getByText('main.ts')).toBeTruthy();
  });

  it('shows correct counts', () => {
    render(<StatusPanel state={populatedState} onRefresh={() => {}} />);
    expect(screen.getByText('Builders (1)')).toBeTruthy();
    expect(screen.getByText('Shells (1)')).toBeTruthy();
    expect(screen.getByText('Files (1)')).toBeTruthy();
  });
});
