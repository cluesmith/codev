import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Regression tests for GitHub issues #222 and #234:
// Dashboard API calls and tower links must use relative URLs so they work
// behind reverse proxies (e.g., codevos.ai /t/{slug}/).

describe('getApiBase (constants.ts)', () => {
  it('returns relative base "./" regardless of pathname', async () => {
    // Simulate proxy path: /t/abc123/workspace/my-workspace/
    Object.defineProperty(window, 'location', {
      value: { ...window.location, pathname: '/t/abc123/workspace/my-workspace/' },
      writable: true,
    });

    // Re-import to pick up the mocked location
    const { getApiBase } = await import('../src/lib/constants.js');
    expect(getApiBase()).toBe('./');
  });

  it('returns relative base "./" when at root', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, pathname: '/' },
      writable: true,
    });

    const { getApiBase } = await import('../src/lib/constants.js');
    expect(getApiBase()).toBe('./');
  });
});

describe('getTerminalWsPath (api.ts)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes full pathname prefix for WebSocket path', async () => {
    // Simulate proxy path
    Object.defineProperty(window, 'location', {
      value: { ...window.location, pathname: '/t/abc123/workspace/my-workspace/' },
      writable: true,
    });

    const { getTerminalWsPath } = await import('../src/lib/api.js');

    const result = getTerminalWsPath({ type: 'builder', terminalId: 'term-1' });
    expect(result).toBe('/t/abc123/workspace/my-workspace/ws/terminal/term-1');
  });

  it('works when accessed directly at root', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, pathname: '/' },
      writable: true,
    });

    const { getTerminalWsPath } = await import('../src/lib/api.js');

    const result = getTerminalWsPath({ type: 'builder', terminalId: 'term-1' });
    expect(result).toBe('/ws/terminal/term-1');
  });

  it('adds trailing slash to pathname without one', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, pathname: '/t/abc123/workspace/my-workspace' },
      writable: true,
    });

    const { getTerminalWsPath } = await import('../src/lib/api.js');

    const result = getTerminalWsPath({ type: 'builder', terminalId: 'term-1' });
    expect(result).toBe('/t/abc123/workspace/my-workspace/ws/terminal/term-1');
  });

  it('returns null when no terminalId', async () => {
    const { getTerminalWsPath } = await import('../src/lib/api.js');
    expect(getTerminalWsPath({ type: 'builder' })).toBeNull();
  });
});

// Regression test for GitHub issue #234:
// Tower.html instance/terminal links must be relative, not absolute.
// The server returns absolute paths like "/workspace/<encoded>/" in API responses.
// The client's relUrl() converts these to relative "./workspace/<encoded>/" so
// they resolve through the proxy prefix.
describe('tower.html relUrl pattern (issue #234)', () => {
  // Mirror of the relUrl() function in tower.html
  function relUrl(path: string | null | undefined): string {
    if (path && path.startsWith('/')) return '.' + path;
    return path || '';
  }

  it('converts absolute workspace URL to relative', () => {
    expect(relUrl('/workspace/abc123/')).toBe('./workspace/abc123/');
  });

  it('converts absolute terminal URL to relative', () => {
    expect(relUrl('/workspace/abc123/?tab=architect')).toBe('./workspace/abc123/?tab=architect');
  });

  it('leaves already-relative URLs unchanged', () => {
    expect(relUrl('./workspace/abc123/')).toBe('./workspace/abc123/');
  });

  it('handles empty string', () => {
    expect(relUrl('')).toBe('');
  });

  it('handles null/undefined', () => {
    expect(relUrl(null)).toBe('');
    expect(relUrl(undefined)).toBe('');
  });
});
