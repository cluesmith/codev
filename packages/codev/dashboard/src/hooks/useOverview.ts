import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchOverview, refreshOverview, getSSEEventsUrl } from '../lib/api.js';
import type { OverviewData } from '../lib/api.js';

const POLL_INTERVAL_MS = 5000;

export function useOverview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlight = useRef(false);

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

  // Bugfix #388: Subscribe to SSE events for push-based updates.
  // When the server broadcasts 'overview-changed', the cache has already been
  // invalidated server-side — just re-fetch (don't POST back, which would
  // trigger another broadcast and create a loop).
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;

    const url = getSSEEventsUrl();
    const es = new EventSource(url);

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'overview-changed' && !refreshInFlight.current) {
          refreshInFlight.current = true;
          poll().finally(() => {
            refreshInFlight.current = false;
          });
        }
      } catch {
        // Ignore malformed events
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; no action needed
    };

    return () => es.close();
  }, [poll]);

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
