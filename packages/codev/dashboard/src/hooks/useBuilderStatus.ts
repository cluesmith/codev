import { useState, useEffect, useCallback } from 'react';
import { fetchState } from '../lib/api.js';
import type { DashboardState } from '../lib/api.js';
import { POLL_INTERVAL_MS } from '../lib/constants.js';

export function useBuilderStatus() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchState();
      setState(data);
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

  return { state, error, refresh };
}
