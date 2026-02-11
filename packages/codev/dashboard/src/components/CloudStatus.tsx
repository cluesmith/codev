import { useState, useCallback } from 'react';
import { connectTunnel, disconnectTunnel } from '../lib/api.js';
import type { TunnelStatus } from '../lib/api.js';

interface CloudStatusProps {
  tunnelStatus: TunnelStatus | null;
  onRefresh: () => void;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

export function CloudStatus({ tunnelStatus, onRefresh }: CloudStatusProps) {
  const [loading, setLoading] = useState(false);

  const handleConnect = useCallback(async () => {
    setLoading(true);
    try {
      await connectTunnel();
      onRefresh();
    } catch {
      // Error handled by next poll
    } finally {
      setLoading(false);
    }
  }, [onRefresh]);

  const handleDisconnect = useCallback(async () => {
    setLoading(true);
    try {
      await disconnectTunnel();
      onRefresh();
    } catch {
      // Error handled by next poll
    } finally {
      setLoading(false);
    }
  }, [onRefresh]);

  // Not registered or tunnel status unavailable
  if (!tunnelStatus || !tunnelStatus.registered) {
    return (
      <span className="cloud-status cloud-status--none" data-testid="cloud-status">
        <span className="cloud-dot cloud-dot--gray" />
        Cloud: not registered
      </span>
    );
  }

  const { state, towerName, accessUrl, uptime } = tunnelStatus;

  if (state === 'auth_failed') {
    return (
      <span className="cloud-status cloud-status--error" data-testid="cloud-status">
        <span className="cloud-dot cloud-dot--red" />
        Cloud: auth failed
        <span className="cloud-hint">Run --reauth</span>
      </span>
    );
  }

  if (state === 'connecting') {
    return (
      <span className="cloud-status cloud-status--connecting" data-testid="cloud-status">
        <span className="cloud-dot cloud-dot--yellow" />
        Cloud: connecting...
      </span>
    );
  }

  if (state === 'connected') {
    return (
      <span className="cloud-status cloud-status--connected" data-testid="cloud-status">
        <span className="cloud-dot cloud-dot--green" />
        Cloud: {towerName}
        {uptime !== null && <span className="cloud-uptime">{formatUptime(uptime)}</span>}
        {accessUrl && (
          <a
            href={accessUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="cloud-link"
          >
            Open
          </a>
        )}
        <button
          className="cloud-btn"
          onClick={handleDisconnect}
          disabled={loading}
          data-testid="cloud-disconnect-btn"
        >
          Disconnect
        </button>
      </span>
    );
  }

  // Disconnected
  return (
    <span className="cloud-status cloud-status--disconnected" data-testid="cloud-status">
      <span className="cloud-dot cloud-dot--gray" />
      Cloud: disconnected
      <button
        className="cloud-btn"
        onClick={handleConnect}
        disabled={loading}
        data-testid="cloud-connect-btn"
      >
        Connect
      </button>
    </span>
  );
}
