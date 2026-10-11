// Time-zone aware date helpers built on Intl, so they behave the same in the browser and in Cloud Functions
// regardless of the machine's own time zone. Lessons always happen in the instructor's local time.

export const DEFAULT_TIMEZONE = 'Australia/Sydney';

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'long',
    });
    partsFormatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
export function toZoned(date: Date, timeZone: string = DEFAULT_TIMEZONE): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of partsFormatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: parts.weekday.toLowerCase() as Weekday,
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const z = toZoned(date, timeZone);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute);
  return asUtc - Math.floor(date.getTime() / 60000) * 60000;
}

/** The instant at which the wall clock in `timeZone` reads the given local date and time. */
export function fromZoned(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  timeZone: string = DEFAULT_TIMEZONE,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - offsetMs(new Date(guess), timeZone);
  // Re-check once: the offset can differ either side of a daylight-saving change.
  const corrected = guess - offsetMs(new Date(result), timeZone);
  if (corrected !== result) result = corrected;
  return new Date(result);
}

/** "YYYY-MM-DD" for the local calendar day of an instant. */
export function dayKey(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const z = toZoned(date, timeZone);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
}

/** Midnight (local) of a "YYYY-MM-DD" day key. */
export function startOfDayKey(key: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  const [y, m, d] = key.split('-').map(Number);
  return fromZoned(y, m, d, 0, 0, timeZone);
}

/** Adds whole calendar days to a day key. */
export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export function weekdayOfKey(key: string): Weekday {
  const [y, m, d] = key.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** "HH:mm" → minutes after midnight. */
export function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function minutesToHhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The instant for a local day key plus "HH:mm". */
export function atLocalTime(key: string, hhmm: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  const [y, m, d] = key.split('-').map(Number);
  const mins = hhmmToMinutes(hhmm);
  return fromZoned(y, m, d, Math.floor(mins / 60), mins % 60, timeZone);
}

// ---------- Display ----------

export function formatInZone(date: Date, options: Intl.DateTimeFormatOptions, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone, ...options }).format(date);
}

/** "Wed, 9 Sep 2026" */
export function formatDate(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return formatInZone(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, timeZone);
}

/** "10:00 am" */
export function formatTime(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return formatInZone(date, { hour: 'numeric', minute: '2-digit', hour12: true }, timeZone)
    .replace(/\s?(AM|PM)$/i, m => ' ' + m.trim().toLowerCase());
}

export function formatTimeRange(start: Date, end: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return `${formatTime(start, timeZone)} – ${formatTime(end, timeZone)}`;
}
