// Minimal cron expression parser for af cron (Spec 399).
//
// Supports standard 5-field cron expressions: minute hour day-of-month month day-of-week
// Field types: * (any), step (*/N), fixed value, comma-separated values
// Shortcuts: @hourly, @daily, @startup

export interface CronSchedule {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  startup: boolean;
}

const SHORTCUTS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 9 * * *',
};

// Parse a single cron field into an array of matching values.
function parseField(field: string, min: number, max: number): number[] {
  if (field === '*') {
    return makeRange(min, max);
  }

  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) {
      throw new Error(`Invalid step value in cron field: ${field}`);
    }
    const values: number[] = [];
    for (let i = min; i <= max; i += step) {
      values.push(i);
    }
    return values;
  }

  // Comma-separated values or single value
  const parts = field.split(',');
  const values: number[] = [];
  for (const part of parts) {
    const num = parseInt(part.trim(), 10);
    if (isNaN(num) || num < min || num > max) {
      throw new Error(`Invalid value '${part}' in cron field (must be ${min}-${max})`);
    }
    values.push(num);
  }
  return values;
}

function makeRange(min: number, max: number): number[] {
  const arr: number[] = [];
  for (let i = min; i <= max; i++) {
    arr.push(i);
  }
  return arr;
}

// Parse a cron expression string into a CronSchedule.
export function parseCronExpression(expr: string): CronSchedule {
  const trimmed = expr.trim();

  if (trimmed === '@startup') {
    return {
      minutes: [],
      hours: [],
      daysOfMonth: [],
      months: [],
      daysOfWeek: [],
      startup: true,
    };
  }

  const expanded = SHORTCUTS[trimmed] ?? trimmed;
  const fields = expanded.split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length} in "${expr}"`);
  }

  return {
    minutes: parseField(fields[0], 0, 59),
    hours: parseField(fields[1], 0, 23),
    daysOfMonth: parseField(fields[2], 1, 31),
    months: parseField(fields[3], 1, 12),
    daysOfWeek: parseField(fields[4], 0, 6),
    startup: false,
  };
}

// Check if a cron schedule is due to run at the given time.
// For startup schedules, returns false (startup tasks are handled separately at init).
// For regular schedules, checks if the current minute matches and enough time has
// passed since the last run (at least 60 seconds to prevent double-firing).
export function isDue(schedule: CronSchedule, now: Date, lastRun: number | null): boolean {
  if (schedule.startup) {
    return false;
  }

  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const dayOfMonth = now.getUTCDate();
  const month = now.getUTCMonth() + 1; // getUTCMonth is 0-indexed
  const dayOfWeek = now.getUTCDay(); // 0 = Sunday

  if (!schedule.minutes.includes(minute)) return false;
  if (!schedule.hours.includes(hour)) return false;
  if (!schedule.daysOfMonth.includes(dayOfMonth)) return false;
  if (!schedule.months.includes(month)) return false;
  if (!schedule.daysOfWeek.includes(dayOfWeek)) return false;

  // Prevent double-firing within the same minute
  if (lastRun !== null) {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (nowSeconds - lastRun < 60) {
      return false;
    }
  }

  return true;
}
