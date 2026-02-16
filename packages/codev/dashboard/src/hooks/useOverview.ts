import { useState, useEffect, useCallback } from 'react';
import { fetchOverview, refreshOverview } from '../lib/api.js';
import type { OverviewData } from '../lib/api.js';

const POLL_INTERVAL_MS = 5000;

export function useOverview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const result = await fetchOverview();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch overview');
    }
  }, []);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [poll]);

  const refresh = useCallback(async () => {
    await refreshOverview();
    await poll();
  }, [poll]);

  return { data, error, refresh };
}
