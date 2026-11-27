/**
 * Spec 1995 — the overview spend projection and the module that owns the
 * overview TTLs (scenario 18). That the cache really spends what this projects
 * is pinned in spec-1995-overview-bundle-cache.test.ts, on both paths.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIST_TTL_MS, SEARCH_TTL_MS, projectHourlyForgeCalls } from '../servers/overview-budget.js';

const serversDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../servers');
const defaults = { listTtlMs: LIST_TTL_MS, searchTtlMs: SEARCH_TTL_MS };

describe('Spec 1995 — projectHourlyForgeCalls (18)', () => {
  it('the default TTLs: 20 calls/h bundled, 52 on the four calls', () => {
    expect(LIST_TTL_MS).toBe(180_000);
    expect(SEARCH_TTL_MS).toBe(600_000);
    expect(projectHourlyForgeCalls('bundle')).toBe(20);
    expect(projectHourlyForgeCalls('four-call')).toBe(52);
  });

  it('a doubled list TTL halves the bundle projection', () => {
    const ttls = { ...defaults, listTtlMs: 2 * LIST_TTL_MS };
    expect(projectHourlyForgeCalls('bundle', ttls)).toBe(10);
    expect(projectHourlyForgeCalls('four-call', ttls)).toBe(2 * 10 + 2 * 6);
  });

  it('a changed search TTL changes only the four-call projection', () => {
    const ttls = { ...defaults, searchTtlMs: 2 * SEARCH_TTL_MS };
    expect(projectHourlyForgeCalls('bundle', ttls)).toBe(20);
    expect(projectHourlyForgeCalls('four-call', ttls)).toBe(2 * 20 + 2 * 3);
  });
});

describe('Spec 1995 — one source for the overview cadence', () => {
  it('overview-budget.ts imports nothing, so doctor can read it without loading Tower', () => {
    const source = fs.readFileSync(path.join(serversDir, 'overview-budget.ts'), 'utf-8');
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it('OverviewCache defines none of the TTLs itself: it imports them from overview-budget.ts', () => {
    const source = fs.readFileSync(path.join(serversDir, 'overview.ts'), 'utf-8');
    expect(source).toMatch(/from '\.\/overview-budget\.js'/);
    for (const name of ['LIST_TTL_MS', 'SEARCH_TTL_MS', 'USER_TTL_MS', 'INVALIDATE_DEBOUNCE_MS', 'FAILURE_WINDOW_MIN_MS', 'FAILURE_WINDOW_MAX_MS']) {
      expect(source, name).not.toMatch(new RegExp(`\\bconst ${name}\\s*=`));
    }
  });
});
