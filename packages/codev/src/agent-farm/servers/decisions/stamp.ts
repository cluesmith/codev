// Decision heading timestamps (Spec 1819, Issue #1836).
//
// A stamp is `[YYYY-MM-DD] h:mm am|pm [ZONE]` or `[YYYY-MM-DD] HH:mm [ZONE]`. It is
// resolved to an absolute instant using the zone written in it or, failing that, the
// file's `_Zone: …_` line — nothing here defaults to, or special-cases, any zone. A
// stamp without a date is today in its zone. A stamp with no zone at all is returned
// unconverted with no reason, so the tab shows it as written; text in none of these
// forms is not a stamp at all (null).
//
// IANA and generic zones are resolved with the runtime's built-in `Intl` time-zone
// data by offset probing: the wall-clock time is tried against every offset the
// zone has near that date, and the candidates that round-trip are kept. One means
// success; none is a spring-forward gap; two is a fall-back fold. Gaps and folds
// are left unconverted rather than broken by a tie-break rule.

import type { DecisionStamp } from '@cluesmith/codev-types';

/** Generic North-American zones: DST follows the stamp's date. */
const GENERIC_ZONES: Record<string, string> = {
  PT: 'America/Los_Angeles',
  MT: 'America/Denver',
  CT: 'America/Chicago',
  ET: 'America/New_York',
  AKT: 'America/Anchorage',
  HT: 'Pacific/Honolulu',
};

/**
 * Fixed-offset abbreviations, in minutes east of UTC. `CST` is North-American
 * Central (China Standard Time is written `+08:00` or `Asia/Shanghai`). Ambiguous
 * abbreviations (`IST`, `BST`, `AST`, …) are deliberately absent.
 */
const FIXED_ZONES: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  Z: 0,
  PST: -8 * 60,
  PDT: -7 * 60,
  MST: -7 * 60,
  MDT: -6 * 60,
  CST: -6 * 60,
  CDT: -5 * 60,
  EST: -5 * 60,
  EDT: -4 * 60,
  AKST: -9 * 60,
  AKDT: -8 * 60,
  HST: -10 * 60,
  WET: 0,
  WEST: 1 * 60,
  CET: 1 * 60,
  CEST: 2 * 60,
  EET: 2 * 60,
  EEST: 3 * 60,
  MSK: 3 * 60,
  SGT: 8 * 60,
  HKT: 8 * 60,
  JST: 9 * 60,
  KST: 9 * 60,
  AEST: 10 * 60,
  AEDT: 11 * 60,
  NZST: 12 * 60,
  NZDT: 13 * 60,
};

const STAMP_RE = /^(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2}):(\d{2})(?:\s*(am|pm))?(?:\s+(\S+))?$/i;
const OFFSET_RE = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/;
/** Shaped like a zone (an abbreviation, an Area/Location name, an offset), known or not. */
const ZONE_LIKE_RE = /^(?:[A-Z]{2,5}|[A-Z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)+|(?:UTC|GMT)?[+-]\d{1,2}(?::?\d{2})?)$/;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

type Zone = { kind: 'fixed'; offsetMinutes: number } | { kind: 'iana'; name: string };

function isIanaZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function parseZone(zone: string): Zone | null {
  // Own keys only: `in` would let prototype names (`toString`, `__proto__`, …) through.
  if (Object.hasOwn(FIXED_ZONES, zone)) return { kind: 'fixed', offsetMinutes: FIXED_ZONES[zone] };
  if (Object.hasOwn(GENERIC_ZONES, zone)) return { kind: 'iana', name: GENERIC_ZONES[zone] };
  const offset = OFFSET_RE.exec(zone);
  if (offset) {
    const hours = Number(offset[2]);
    const minutes = offset[3] ? Number(offset[3]) : 0;
    if (hours > 14 || minutes > 59) return null;
    const sign = offset[1] === '-' ? -1 : 1;
    return { kind: 'fixed', offsetMinutes: sign * (hours * 60 + minutes) };
  }
  // IANA names only in Area/Location form, so legacy ids (`EST5EDT`, `IST`, …) are
  // never accepted through the back door.
  if (zone.includes('/') && isIanaZone(zone)) return { kind: 'iana', name: zone };
  return null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The zone's UTC offset, in minutes, at the given instant. */
function offsetAt(instantMs: number, zone: string): number {
  const parts = formatterFor(zone).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find(p => p.type === type)!.value);
  const wallMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const instantMinute = Math.floor(instantMs / MINUTE_MS) * MINUTE_MS;
  return Math.round((wallMs - instantMinute) / MINUTE_MS);
}

/** All instants whose wall-clock time in `zone` is `wallMs` (as if UTC). */
function instantsForWallClock(wallMs: number, zone: string): number[] {
  const offsets = new Set([offsetAt(wallMs - DAY_MS, zone), offsetAt(wallMs, zone), offsetAt(wallMs + DAY_MS, zone)]);
  const instants = new Set<number>();
  for (const offset of offsets) {
    const candidate = wallMs - offset * MINUTE_MS;
    if (offsetAt(candidate, zone) === offset) instants.add(candidate);
  }
  return [...instants].sort((a, b) => a - b);
}

/** The wall-clock time in `zone` at the given instant, as if UTC. */
function wallClockAt(instantMs: number, zone: Zone): number {
  const offsetMinutes = zone.kind === 'fixed' ? zone.offsetMinutes : offsetAt(instantMs, zone.name);
  return instantMs + offsetMinutes * MINUTE_MS;
}

/**
 * Resolve a heading stamp to an instant, using the zone written in it or else `fileZone`.
 * A stamp without a date takes today's date in that zone. Returns null for text that is not
 * a stamp.
 */
export function resolveStamp(raw: string, fileZone: string | null = null): DecisionStamp | null {
  const m = STAMP_RE.exec(raw.trim());
  if (!m) return null;

  const [, y, mo, d, h, mi, meridiem, zoneText] = m;
  let hour = Number(h);
  const minute = Number(mi);

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const pm = meridiem.toLowerCase() === 'pm';
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  if (minute > 59) return null;

  const timeOnly = y === undefined;
  let dateMs = 0;
  if (!timeOnly) {
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    dateMs = Date.UTC(year, month - 1, day);
    const check = new Date(dateMs);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  }

  const stamp: DecisionStamp = timeOnly ? { raw, instant: null, timeOnly: true } : { raw, instant: null };
  const zoneName = zoneText ?? fileZone;
  if (!zoneName) return stamp;
  const zone = parseZone(zoneName);
  if (!zone) {
    // A bare time and a word that is no zone (`10:30 standup?`) is a question, not a stamp.
    if (timeOnly && zoneText !== undefined && !ZONE_LIKE_RE.test(zoneText)) return null;
    return { ...stamp, unconvertedReason: 'unknown-zone' };
  }

  if (timeOnly) dateMs = Math.floor(wallClockAt(Date.now(), zone) / DAY_MS) * DAY_MS;
  const wallMs = dateMs + (hour * 60 + minute) * MINUTE_MS;

  if (zone.kind === 'fixed') {
    return { ...stamp, instant: new Date(wallMs - zone.offsetMinutes * MINUTE_MS).toISOString() };
  }

  const instants = instantsForWallClock(wallMs, zone.name);
  if (instants.length === 0) return { ...stamp, unconvertedReason: 'nonexistent-time' };
  if (instants.length > 1) return { ...stamp, unconvertedReason: 'ambiguous-time' };
  return { ...stamp, instant: new Date(instants[0]).toISOString() };
}
