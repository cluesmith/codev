import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { CloudStatus } from '../src/components/CloudStatus.js';
import type { TunnelStatus } from '../src/lib/api.js';

// Mock the API module
vi.mock('../src/lib/api.js', async () => {
  const actual = await vi.importActual('../src/lib/api.js');
  return {
    ...actual,
    connectTunnel: vi.fn(async () => {}),
    disconnectTunnel: vi.fn(async () => {}),
  };
});

import { connectTunnel, disconnectTunnel } from '../src/lib/api.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const onRefresh = vi.fn();

describe('CloudStatus', () => {
  it('shows "not registered" when tunnelStatus is null', () => {
    render(<CloudStatus tunnelStatus={null} onRefresh={onRefresh} />);
    expect(screen.getByText('Cloud: not registered')).toBeTruthy();
  });

  it('shows "not registered" when not registered', () => {
    const status: TunnelStatus = {
      registered: false,
      state: 'disconnected',
      uptime: null,
      towerId: null,
      towerName: null,
      serverUrl: null,
      accessUrl: null,
    };
    render(<CloudStatus tunnelStatus={status} onRefresh={onRefresh} />);
    expect(screen.getByText('Cloud: not registered')).toBeTruthy();
  });

  it('shows disconnected state with Connect button', () => {
    const status: TunnelStatus = {
      registered: true,
      state: 'disconnected',
      uptime: null,
      towerId: 'tower-123',
      towerName: 'my-tower',
      serverUrl: 'https://codevos.ai',
      accessUrl: null,
    };
    render(<CloudStatus tunnelStatus={status} onRefresh={onRefresh} />);
    expect(screen.getByText('Cloud: disconnected')).toBeTruthy();
    expect(screen.getByTestId('cloud-connect-btn')).toBeTruthy();
  });

  it('shows connecting state', () => {
    const status: TunnelStatus = {
      registered: true,
      state: 'connecting',
      uptime: null,
      towerId: 'tower-123',
      towerName: 'my-tower',
      serverUrl: 'https://codevos.ai',
      accessUrl: null,
    };
    render(<CloudStatus tunnelStatus={status} onRefresh={onRefresh} />);
    expect(screen.getByText('Cloud: connecting...')).toBeTruthy();
  });

  it('shows connected state with tower name, uptime, and Disconnect button', () => {
    const status: TunnelStatus = {
      registered: true,
      state: 'connected',
      uptime: 3600000, // 1 hour
      towerId: 'tower-123',
      towerName: 'my-tower',
      serverUrl: 'https://codevos.ai',
      accessUrl: 'https://codevos.ai/t/my-tower/',
    };
    render(<CloudStatus tunnelStatus={status} onRefresh={onRefresh} />);
    expect(screen.getByText('Cloud: my-tower')).toBeTruthy();
    expect(screen.getByText('1h 0m')).toBeTruthy();
    expect(screen.getByTestId('cloud-disconnect-btn')).toBeTruthy();
    const link = screen.getByText('Open');
    expect(link.getAttribute('href')).toBe('https://codevos.ai/t/my-tower/');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('shows auth_failed state', () => {
    const status: TunnelStatus = {
      registered: true,
      state: 'auth_failed',
      uptime: null,
      towerId: 'tower-123',
      towerName: 'my-tower',
      serverUrl: 'https://codevos.ai',
      accessUrl: null,
    };
    render(<CloudStatus tunnelStatus={status} onRefresh={onRefresh} />);
    expect(screen.getByText('Cloud: auth failed')).toBeTruthy();
    expect(screen.getByText('Run --reauth')).toBeTruthy();
  });

  it('Connect button calls connectTunnel and onRefresh', async () => {
    const status: TunnelStatus = {
      registered: true,
      state: 'disconnected',
      uptime: null,
      towerId: 'tower-123',
      towerName: 'my-tower',
      serverUrl: 'https://codevos.ai',
      accessUrl: null,
    };
    render(<CloudStatus tunnelStatus={status} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTestId('cloud-connect-btn'));
    await waitFor(() => {
      expect(connectTunnel).toHaveBeenCalled();
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it('Disconnect button calls disconnectTunnel and onRefresh', async () => {
    const status: TunnelStatus = {
      registered: true,
      state: 'connected',
      uptime: 60000,
      towerId: 'tower-123',
      towerName: 'my-tower',
      serverUrl: 'https://codevos.ai',
      accessUrl: 'https://codevos.ai/t/my-tower/',
    };
    render(<CloudStatus tunnelStatus={status} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTestId('cloud-disconnect-btn'));
    await waitFor(() => {
      expect(disconnectTunnel).toHaveBeenCalled();
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it('shows error state when API returns error', () => {
    const status: TunnelStatus = {
      registered: false,
      state: 'error',
      uptime: null,
      towerId: null,
      towerName: null,
      serverUrl: null,
      accessUrl: null,
    };
    render(<CloudStatus tunnelStatus={status} onRefresh={onRefresh} />);
    expect(screen.getByText('Cloud: error')).toBeTruthy();
    const dot = screen.getByTestId('cloud-status').querySelector('.cloud-dot--red');
    expect(dot).toBeTruthy();
  });

  it('shows connected state without uptime when null', () => {
    const status: TunnelStatus = {
      registered: true,
      state: 'connected',
      uptime: null,
      towerId: 'tower-123',
      towerName: 'my-tower',
      serverUrl: 'https://codevos.ai',
      accessUrl: null,
    };
    render(<CloudStatus tunnelStatus={status} onRefresh={onRefresh} />);
    expect(screen.getByText('Cloud: my-tower')).toBeTruthy();
    expect(screen.queryByText(/\d+[hms]/)).toBeNull();
  });
});
