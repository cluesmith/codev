import { useState, useEffect, useCallback } from 'react';
import { fetchOverview, refreshOverview } from '../lib/api.js';
import type { OverviewData } from '../lib/api.js';
import { useSSE } from './useSSE.js';

const POLL_INTERVAL_MS = 2500;

export function useOverview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const result = await fetchOverview();
      setData(prev => {
        if (prev !== null && JSON.stringify(prev) === JSON.stringify(result)) {
          return prev;
        }
        return result;
      });
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

  // Bugfix #472: Trigger immediate poll on SSE events (e.g. after Tower restart)
  useSSE(poll);

  const refresh = useCallback(async () => {
    await refreshOverview();
    await poll();
  }, [poll]);

  return { data, error, refresh };
}
