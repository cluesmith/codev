import { useState, useEffect, useCallback } from 'react';
import { fetchState, fetchTunnelStatus } from '../lib/api.js';
import type { DashboardState, TunnelStatus } from '../lib/api.js';
import { POLL_INTERVAL_MS } from '../lib/constants.js';

export function useBuilderStatus() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [data, tunnel] = await Promise.all([
        fetchState(),
        fetchTunnelStatus(),
      ]);
      setState(data);
      setTunnelStatus(tunnel);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return { state, tunnelStatus, error, refresh };
}
