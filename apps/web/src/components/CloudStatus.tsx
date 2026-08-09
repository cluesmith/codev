import { useState, useCallback, useEffect, useRef } from 'react';
import { connectTunnel, disconnectTunnel } from '../lib/api.js';
import type { TunnelStatus } from '../lib/api.js';

interface CloudStatusProps {
  tunnelStatus: TunnelStatus | null;
  onRefresh: () => void;
}

/**
 * #1370: how long Disconnect stays disabled after a tunnel state change.
 *
 * While the uplink flaps, the header control swaps between Connect and
 * Disconnect in the same position — a click aimed at Connect (or the adjacent
 * Open link) can land on Disconnect, which deregisters the tower server-side
 * and deletes its credentials. Holding the destructive button briefly makes
 * the click target stop moving under the cursor.
 */
const SETTLE_MS = 2000;

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
  const [confirming, setConfirming] = useState(false);
  const [settled, setSettled] = useState(true);

  // Track the tunnel state so a transition can arm the settle window. The
  // first render seeds the ref without arming it — a page load that finds the
  // tunnel already connected is not a flap.
  const state = tunnelStatus?.state ?? null;
  const prevState = useRef<typeof state>(state);
  useEffect(() => {
    if (prevState.current === state) return;
    prevState.current = state;
    setSettled(false);
    // A flap while the dialog is open cancels it: the confirmation described
    // the tunnel as it was, and a stale dialog must not outlive that.
    setConfirming(false);
  }, [state]);

  // Arming is driven by `settled` rather than by the transition above, so the
  // invariant "unsettled ⇒ a timer is pending" holds even when StrictMode
  // re-runs effects. Otherwise a dropped timer would disable Disconnect
  // permanently.
  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settled]);

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
      setConfirming(false);
      onRefresh();
    } catch {
      // Error handled by next poll
    } finally {
      setLoading(false);
    }
  }, [onRefresh]);

  // When accessed through codevos.ai, the cloud status is irrelevant —
  // we're already in the cloud. (Checked after hooks so the hook order is
  // stable across renders.)
  const isCloudHosted = window.location.hostname.endsWith('codevos.ai');
  if (isCloudHosted) return null;

  const confirmDialog = confirming ? (
    <div
      className="confirm-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cloud-disconnect-title"
      data-testid="cloud-disconnect-confirm"
    >
      <div className="confirm-dialog">
        <h2 id="cloud-disconnect-title">
          Disconnect <code>{tunnelStatus?.towerName ?? 'this tower'}</code> from Codev Cloud?
        </h2>
        <p>
          This deregisters the tower server-side and deletes its local cloud credentials.
          Reconnecting requires signing in again.
        </p>
        <div className="confirm-dialog-actions">
          <button
            type="button"
            autoFocus
            onClick={() => setConfirming(false)}
            disabled={loading}
            data-testid="cloud-disconnect-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleDisconnect}
            disabled={loading}
            data-testid="cloud-disconnect-confirm-btn"
          >
            {loading ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // Tunnel status unavailable (404 — not configured)
  if (!tunnelStatus) {
    return (
      <span className="cloud-status cloud-status--none" data-testid="cloud-status">
        <span className="cloud-dot cloud-dot--gray" />
        Cloud: not registered
      </span>
    );
  }

  // API/network error — distinguish from not-registered
  if (tunnelStatus.state === 'error') {
    return (
      <span className="cloud-status cloud-status--error" data-testid="cloud-status">
        <span className="cloud-dot cloud-dot--red" />
        Cloud: error
      </span>
    );
  }

  // Not registered
  if (!tunnelStatus.registered) {
    return (
      <span className="cloud-status cloud-status--none" data-testid="cloud-status">
        <span className="cloud-dot cloud-dot--gray" />
        Cloud: not registered
      </span>
    );
  }

  const { towerName, accessUrl, uptime } = tunnelStatus;

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
      <>
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
            onClick={() => setConfirming(true)}
            disabled={loading || !settled}
            title={
              settled
                ? 'Deregister this tower from Codev Cloud'
                : 'Connection just changed state — wait a moment'
            }
            data-testid="cloud-disconnect-btn"
          >
            Disconnect
          </button>
        </span>
        {confirmDialog}
      </>
    );
  }

  // Disconnected
  return (
    <>
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
      {confirmDialog}
    </>
  );
}
