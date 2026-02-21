import { useState, useEffect, useCallback } from 'react';
import { fetchAnalytics } from '../lib/api.js';
import type { AnalyticsResponse } from '../lib/api.js';

type RangeLabel = '24h' | '7d' | '30d' | 'all';

function rangeToParam(range: RangeLabel): string {
  if (range === '24h') return '1';
  if (range === '7d') return '7';
  if (range === '30d') return '30';
  return 'all';
}

export function useAnalytics(isActive: boolean) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<RangeLabel>('7d');

  const load = useCallback(async (r: RangeLabel, bypass = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAnalytics(rangeToParam(r), bypass);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch when range changes (while active) or when tab becomes active
  useEffect(() => {
    if (isActive) {
      load(range);
    }
  }, [range, isActive, load]);

  const refresh = useCallback(() => {
    load(range, true);
  }, [load, range]);

  return { data, error, loading, range, setRange, refresh };
}
