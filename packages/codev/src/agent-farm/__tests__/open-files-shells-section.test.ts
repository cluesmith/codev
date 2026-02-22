/**
 * Tests for OpenFilesShellsSection utility functions (Spec 467)
 *
 * Tests pure utility functions (formatDuration, shortPath) extracted from
 * the React component. Component rendering is not unit-tested here because
 * React is a dashboard-only dependency. Visual verification is manual.
 */

import { describe, it, expect } from 'vitest';

import { formatDuration, shortPath } from '../../../dashboard/src/lib/open-files-shells-utils.js';

// ============================================================================
// formatDuration
// ============================================================================

describe('formatDuration', () => {
  it('returns "<1m" for durations under 1 minute', () => {
    expect(formatDuration(0)).toBe('<1m');
    expect(formatDuration(30_000)).toBe('<1m');
    expect(formatDuration(59_999)).toBe('<1m');
  });

  it('returns minutes for durations under 1 hour', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(300_000)).toBe('5m');
    expect(formatDuration(3_540_000)).toBe('59m');
  });

  it('returns hours for durations under 1 day', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(82_800_000)).toBe('23h');
  });

  it('returns days for durations >= 1 day', () => {
    expect(formatDuration(86_400_000)).toBe('1d');
    expect(formatDuration(172_800_000)).toBe('2d');
  });
});

// ============================================================================
// shortPath
// ============================================================================

describe('shortPath', () => {
  it('returns parent/basename for absolute paths', () => {
    expect(shortPath('/a/b/src/components/App.tsx')).toBe('components/App.tsx');
  });

  it('returns the full path if only one segment', () => {
    expect(shortPath('file.txt')).toBe('file.txt');
  });

  it('handles paths with trailing slash (filter strips empty segment)', () => {
    expect(shortPath('/a/b/c/')).toBe('b/c');
  });

  it('returns parent/basename for deeply nested paths', () => {
    expect(shortPath('/Users/mwk/Development/cluesmith/codev/packages/codev/dashboard/src/index.css'))
      .toBe('src/index.css');
  });
});
