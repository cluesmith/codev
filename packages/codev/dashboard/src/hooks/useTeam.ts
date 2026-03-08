import { useState, useEffect, useCallback } from 'react';
import { fetchTeam } from '../lib/api.js';
import type { TeamApiResponse } from '../lib/api.js';

export function useTeam(isActive: boolean) {
  const [data, setData] = useState<TeamApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTeam();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch team data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch when tab becomes active
  useEffect(() => {
    if (isActive) {
      load();
    }
  }, [isActive, load]);

  const refresh = useCallback(() => {
    load();
  }, [load]);

  return { data, error, loading, refresh };
}
