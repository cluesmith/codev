/**
 * Tests for tower-cron-parser.ts (Spec 399)
 * Cron expression parsing and isDue logic
 */

import { describe, it, expect } from 'vitest';
import { parseCronExpression, isDue } from '../servers/tower-cron-parser.js';
import type { CronSchedule } from '../servers/tower-cron-parser.js';

// ============================================================================
// parseCronExpression
// ============================================================================

describe('parseCronExpression', () => {
  describe('wildcard (*)', () => {
    it('parses all-wildcard expression', () => {
      const schedule = parseCronExpression('* * * * *');
      expect(schedule.minutes).toHaveLength(60); // 0-59
      expect(schedule.hours).toHaveLength(24);   // 0-23
      expect(schedule.daysOfMonth).toHaveLength(31); // 1-31
      expect(schedule.months).toHaveLength(12);  // 1-12
      expect(schedule.daysOfWeek).toHaveLength(7); // 0-6
      expect(schedule.startup).toBe(false);
    });
  });

  describe('step values (*/N)', () => {
    it('parses */30 minutes', () => {
      const schedule = parseCronExpression('*/30 * * * *');
      expect(schedule.minutes).toEqual([0, 30]);
    });

    it('parses */5 minutes', () => {
      const schedule = parseCronExpression('*/5 * * * *');
      expect(schedule.minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    });

    it('parses */4 hours', () => {
      const schedule = parseCronExpression('0 */4 * * *');
      expect(schedule.hours).toEqual([0, 4, 8, 12, 16, 20]);
    });

    it('rejects invalid step value', () => {
      expect(() => parseCronExpression('*/0 * * * *')).toThrow('Invalid step value');
      expect(() => parseCronExpression('*/abc * * * *')).toThrow('Invalid step value');
    });
  });

  describe('fixed values', () => {
    it('parses fixed minute and hour', () => {
      const schedule = parseCronExpression('30 9 * * *');
      expect(schedule.minutes).toEqual([30]);
      expect(schedule.hours).toEqual([9]);
    });

    it('rejects out-of-range values', () => {
      expect(() => parseCronExpression('60 * * * *')).toThrow('Invalid value');
      expect(() => parseCronExpression('* 24 * * *')).toThrow('Invalid value');
      expect(() => parseCronExpression('* * 0 * *')).toThrow('Invalid value');
      expect(() => parseCronExpression('* * * 13 *')).toThrow('Invalid value');
      expect(() => parseCronExpression('* * * * 7')).toThrow('Invalid value');
    });
  });

  describe('comma-separated values', () => {
    it('parses comma-separated minutes', () => {
      const schedule = parseCronExpression('0,15,30,45 * * * *');
      expect(schedule.minutes).toEqual([0, 15, 30, 45]);
    });

    it('parses comma-separated days of week', () => {
      const schedule = parseCronExpression('0 9 * * 1,3,5');
      expect(schedule.daysOfWeek).toEqual([1, 3, 5]);
    });
  });

  describe('shortcuts', () => {
    it('parses @hourly', () => {
      const schedule = parseCronExpression('@hourly');
      expect(schedule.minutes).toEqual([0]);
      expect(schedule.hours).toHaveLength(24);
      expect(schedule.startup).toBe(false);
    });

    it('parses @daily', () => {
      const schedule = parseCronExpression('@daily');
      expect(schedule.minutes).toEqual([0]);
      expect(schedule.hours).toEqual([9]);
      expect(schedule.startup).toBe(false);
    });

    it('parses @startup', () => {
      const schedule = parseCronExpression('@startup');
      expect(schedule.minutes).toEqual([]);
      expect(schedule.hours).toEqual([]);
      expect(schedule.startup).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('trims whitespace', () => {
      const schedule = parseCronExpression('  0 9 * * *  ');
      expect(schedule.minutes).toEqual([0]);
      expect(schedule.hours).toEqual([9]);
    });

    it('rejects wrong number of fields', () => {
      expect(() => parseCronExpression('* * *')).toThrow('expected 5 fields');
      expect(() => parseCronExpression('* * * * * *')).toThrow('expected 5 fields');
    });

    it('rejects empty expression', () => {
      expect(() => parseCronExpression('')).toThrow('expected 5 fields');
    });
  });
});

// ============================================================================
// isDue
// ============================================================================

describe('isDue', () => {
  // Helper: create a Date at a specific UTC time
  function utcDate(year: number, month: number, day: number, hour: number, minute: number): Date {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  }

  it('returns true when all fields match and no lastRun', () => {
    // Schedule: every 30 minutes
    const schedule = parseCronExpression('*/30 * * * *');
    // Time: 2026-02-17 10:30:00 UTC (Tuesday, day=17, month=2)
    const now = utcDate(2026, 2, 17, 10, 30);
    expect(isDue(schedule, now, null)).toBe(true);
  });

  it('returns false when minute does not match', () => {
    const schedule = parseCronExpression('0 * * * *');
    const now = utcDate(2026, 2, 17, 10, 15);
    expect(isDue(schedule, now, null)).toBe(false);
  });

  it('returns false when hour does not match', () => {
    const schedule = parseCronExpression('0 9 * * *');
    const now = utcDate(2026, 2, 17, 10, 0);
    expect(isDue(schedule, now, null)).toBe(false);
  });

  it('returns false when day of month does not match', () => {
    const schedule = parseCronExpression('0 9 1 * *');
    const now = utcDate(2026, 2, 17, 9, 0);
    expect(isDue(schedule, now, null)).toBe(false);
  });

  it('returns false when month does not match', () => {
    const schedule = parseCronExpression('0 9 * 3 *');
    const now = utcDate(2026, 2, 17, 9, 0);
    expect(isDue(schedule, now, null)).toBe(false);
  });

  it('returns false when day of week does not match', () => {
    // 2026-02-17 is a Tuesday (day 2)
    const schedule = parseCronExpression('0 9 * * 1'); // Monday only
    const now = utcDate(2026, 2, 17, 9, 0);
    expect(isDue(schedule, now, null)).toBe(false);
  });

  it('prevents double-firing within 60 seconds', () => {
    const schedule = parseCronExpression('*/30 * * * *');
    const now = utcDate(2026, 2, 17, 10, 30);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    // Last run was 30 seconds ago — should NOT fire
    expect(isDue(schedule, now, nowSeconds - 30)).toBe(false);
  });

  it('allows firing when lastRun is older than 60 seconds', () => {
    const schedule = parseCronExpression('*/30 * * * *');
    const now = utcDate(2026, 2, 17, 10, 30);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    // Last run was 120 seconds ago — should fire
    expect(isDue(schedule, now, nowSeconds - 120)).toBe(true);
  });

  it('returns false for startup schedules', () => {
    const schedule = parseCronExpression('@startup');
    const now = utcDate(2026, 2, 17, 10, 0);
    expect(isDue(schedule, now, null)).toBe(false);
  });

  it('matches @daily at 9:00 UTC', () => {
    const schedule = parseCronExpression('@daily');
    const now = utcDate(2026, 2, 17, 9, 0);
    expect(isDue(schedule, now, null)).toBe(true);
  });

  it('does not match @daily at other times', () => {
    const schedule = parseCronExpression('@daily');
    const now = utcDate(2026, 2, 17, 10, 0);
    expect(isDue(schedule, now, null)).toBe(false);
  });

  it('matches @hourly at minute 0', () => {
    const schedule = parseCronExpression('@hourly');
    const now = utcDate(2026, 2, 17, 14, 0);
    expect(isDue(schedule, now, null)).toBe(true);
  });

  it('does not match @hourly at other minutes', () => {
    const schedule = parseCronExpression('@hourly');
    const now = utcDate(2026, 2, 17, 14, 30);
    expect(isDue(schedule, now, null)).toBe(false);
  });
});
