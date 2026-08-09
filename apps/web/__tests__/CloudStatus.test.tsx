import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
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

function connectedStatus(overrides: Partial<TunnelStatus> = {}): TunnelStatus {
  return {
    registered: true,
    state: 'connected',
    uptime: 60000,
    towerId: 'tower-123',
    towerName: 'my-tower',
    serverUrl: 'https://codevos.ai',
    accessUrl: 'https://codevos.ai/t/my-tower/',
    ...overrides,
  };
}

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

  it('Disconnect button opens a confirmation instead of disconnecting (#1370)', async () => {
    render(<CloudStatus tunnelStatus={connectedStatus()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTestId('cloud-disconnect-btn'));

    expect(screen.getByTestId('cloud-disconnect-confirm')).toBeTruthy();
    // The one click must not have deregistered anything.
    expect(disconnectTunnel).not.toHaveBeenCalled();
  });

  it('confirmation names the destructive consequences (#1370)', () => {
    render(<CloudStatus tunnelStatus={connectedStatus()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTestId('cloud-disconnect-btn'));

    const dialog = screen.getByTestId('cloud-disconnect-confirm');
    expect(dialog.textContent).toContain('deregisters the tower server-side');
    expect(dialog.textContent).toContain('deletes its local cloud credentials');
    expect(dialog.textContent).toContain('my-tower');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('Cancel closes the confirmation without disconnecting (#1370)', async () => {
    render(<CloudStatus tunnelStatus={connectedStatus()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTestId('cloud-disconnect-btn'));
    fireEvent.click(screen.getByTestId('cloud-disconnect-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('cloud-disconnect-confirm')).toBeNull();
    });
    expect(disconnectTunnel).not.toHaveBeenCalled();
  });

  it('confirming calls disconnectTunnel and onRefresh', async () => {
    render(<CloudStatus tunnelStatus={connectedStatus()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTestId('cloud-disconnect-btn'));
    fireEvent.click(screen.getByTestId('cloud-disconnect-confirm-btn'));

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

  // #1370: during an uplink flap the header control swaps between Connect and
  // Disconnect in the same position, so a click aimed at Connect can land on
  // the destructive button. Disconnect stays disabled briefly after a change.
  describe('flap guard (#1370)', () => {
    it('enables Disconnect on first render of an already-connected tunnel', () => {
      render(<CloudStatus tunnelStatus={connectedStatus()} onRefresh={onRefresh} />);
      const btn = screen.getByTestId('cloud-disconnect-btn') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    it('disables Disconnect for 2s after the state flips to connected', () => {
      vi.useFakeTimers();
      try {
        const { rerender } = render(
          <CloudStatus
            tunnelStatus={connectedStatus({ state: 'disconnected', accessUrl: null })}
            onRefresh={onRefresh}
          />,
        );
        expect(screen.getByTestId('cloud-connect-btn')).toBeTruthy();

        // The flap: Connect is replaced by Disconnect in the same position.
        rerender(<CloudStatus tunnelStatus={connectedStatus()} onRefresh={onRefresh} />);
        expect((screen.getByTestId('cloud-disconnect-btn') as HTMLButtonElement).disabled).toBe(true);

        act(() => { vi.advanceTimersByTime(2100); });
        expect((screen.getByTestId('cloud-disconnect-btn') as HTMLButtonElement).disabled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-enables after a flap even when re-rendered mid-window', () => {
      // The settle timer is armed off `settled`, not off the transition, so an
      // extra render (or a StrictMode effect re-run) cannot strand the button
      // in its disabled state.
      vi.useFakeTimers();
      try {
        const { rerender } = render(
          <CloudStatus
            tunnelStatus={connectedStatus({ state: 'disconnected', accessUrl: null })}
            onRefresh={onRefresh}
          />,
        );
        rerender(<CloudStatus tunnelStatus={connectedStatus()} onRefresh={onRefresh} />);
        expect((screen.getByTestId('cloud-disconnect-btn') as HTMLButtonElement).disabled).toBe(true);

        // Re-render with the same state partway through the settle window.
        act(() => { vi.advanceTimersByTime(1000); });
        rerender(<CloudStatus tunnelStatus={connectedStatus({ uptime: 61000 })} onRefresh={onRefresh} />);

        act(() => { vi.advanceTimersByTime(2100); });
        expect((screen.getByTestId('cloud-disconnect-btn') as HTMLButtonElement).disabled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels an open confirmation when the tunnel state changes', () => {
      const { rerender } = render(
        <CloudStatus tunnelStatus={connectedStatus()} onRefresh={onRefresh} />,
      );
      fireEvent.click(screen.getByTestId('cloud-disconnect-btn'));
      expect(screen.getByTestId('cloud-disconnect-confirm')).toBeTruthy();

      rerender(
        <CloudStatus
          tunnelStatus={connectedStatus({ state: 'disconnected', accessUrl: null })}
          onRefresh={onRefresh}
        />,
      );
      expect(screen.queryByTestId('cloud-disconnect-confirm')).toBeNull();
      expect(disconnectTunnel).not.toHaveBeenCalled();
    });
  });
});
