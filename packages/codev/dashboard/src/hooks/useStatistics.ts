import { useState, useEffect, useCallback } from 'react';
import { fetchStatistics } from '../lib/api.js';
import type { StatisticsResponse } from '../lib/api.js';

type RangeLabel = '7d' | '30d' | 'all';

function rangeToParam(range: RangeLabel): string {
  if (range === '7d') return '7';
  if (range === '30d') return '30';
  return 'all';
}

export function useStatistics(isActive: boolean) {
  const [data, setData] = useState<StatisticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<RangeLabel>('7d');

  const load = useCallback(async (r: RangeLabel, bypass = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchStatistics(rangeToParam(r), bypass);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch statistics');
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
