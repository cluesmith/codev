/**
 * Unit tests for team-update module — automatic hourly activity summaries.
 *
 * Spec 587: Team Tab in Tower Right Panel.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { collectEvents, formatSummary } from '../agent-farm/commands/team-update.js';

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-update-test-'));
  // Create a minimal git repo
  await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'codev', 'team', 'people'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// =============================================================================
// formatSummary
// =============================================================================

describe('formatSummary', () => {
  it('returns empty string for no events', () => {
    expect(formatSummary([])).toBe('');
  });

  it('formats single event', () => {
    const events = [{ type: 'merge' as const, description: 'Merged PR #42: Fix bug' }];
    expect(formatSummary(events)).toBe('Hourly update: Merged PR #42: Fix bug.');
  });

  it('formats multiple events', () => {
    const events = [
      { type: 'spawn' as const, description: 'Spawned builder for #10' },
      { type: 'merge' as const, description: 'Merged PR #20: Feature' },
    ];
    const result = formatSummary(events);
    expect(result).toBe('Hourly update: Spawned builder for #10. Merged PR #20: Feature.');
  });
});

// =============================================================================
// collectEvents
// =============================================================================

describe('collectEvents', () => {
  it('returns empty array when no events found', async () => {
    const events = await collectEvents(tmpDir);
    expect(events).toEqual([]);
  });

  it('detects recently modified review files', async () => {
    const reviewsDir = path.join(tmpDir, 'codev', 'reviews');
    await fs.mkdir(reviewsDir, { recursive: true });
    // Create a review file with current mtime (within the last hour)
    await fs.writeFile(path.join(reviewsDir, '42-feature.md'), '# Review');

    const events = await collectEvents(tmpDir);
    const reviewEvents = events.filter(e => e.type === 'review');
    expect(reviewEvents).toHaveLength(1);
    expect(reviewEvents[0].description).toContain('42');
  });

  it('detects recently modified status.yaml with approved gates', async () => {
    const projectDir = path.join(tmpDir, 'codev', 'projects', '42-feature');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'status.yaml'), 'phase: implement\napproved: true\n');

    const events = await collectEvents(tmpDir);
    const gateEvents = events.filter(e => e.type === 'gate');
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0].description).toContain('42');
  });

  it('skips old review files', async () => {
    const reviewsDir = path.join(tmpDir, 'codev', 'reviews');
    await fs.mkdir(reviewsDir, { recursive: true });
    const filePath = path.join(reviewsDir, '42-feature.md');
    await fs.writeFile(filePath, '# Review');
    // Set mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fss.utimesSync(filePath, twoHoursAgo, twoHoursAgo);

    const events = await collectEvents(tmpDir);
    const reviewEvents = events.filter(e => e.type === 'review');
    expect(reviewEvents).toHaveLength(0);
  });

  it('handles missing codev directories gracefully', async () => {
    // Remove codev dir
    await fs.rm(path.join(tmpDir, 'codev'), { recursive: true, force: true });

    const events = await collectEvents(tmpDir);
    expect(events).toEqual([]);
  });
});
