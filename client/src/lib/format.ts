// Dates are stored and sent in UTC; they are shown in the organisation's timezone.

export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
}

export function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone }).format(new Date(iso));
}

const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return rtf.format(Math.round(diff / (86400 * 30)), 'month');
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

/** Timezones for pickers; India and Ireland/UK first, then every zone the browser knows. */
export function timezoneOptions(): string[] {
  const preferred = ['Asia/Kolkata', 'Europe/Dublin', 'Europe/London', 'UTC'];
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...preferred, ...all.filter((z) => !preferred.includes(z))];
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "2:05" style hours and minutes from seconds. */
export function hm(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** "1:02:05" from seconds, for running timers. */
export function hms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${hm(s)}:${String(s % 60).padStart(2, '0')}`;
}

export const hours = (seconds: number) => `${(Math.round((seconds / 3600) * 100) / 100).toLocaleString('en-GB')} h`;

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone }).format(new Date(iso));
}

/** A calendar date ("2026-10-27") shown without any timezone shift. */
export function formatDay(day: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

/** Today's date ("YYYY-MM-DD") in a timezone. */
export function todayIn(timeZone: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `day`. */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}

export function formatBytes(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function money(amount: number | null, currency: string): string {
  if (amount === null) return '—';
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

export const WEEKDAYS = [
  { iso: 1, short: 'Mon', long: 'Monday' },
  { iso: 2, short: 'Tue', long: 'Tuesday' },
  { iso: 3, short: 'Wed', long: 'Wednesday' },
  { iso: 4, short: 'Thu', long: 'Thursday' },
  { iso: 5, short: 'Fri', long: 'Friday' },
  { iso: 6, short: 'Sat', long: 'Saturday' },
  { iso: 7, short: 'Sun', long: 'Sunday' },
];

/** "Monday to Friday", "every day" or "Mon, Wed, Fri" for a working week. */
export function describeWorkingDays(days: number[]): string {
  const d = [...new Set(days)].sort();
  if (d.length === 7) return 'every day';
  const contiguous = d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  if (contiguous && d.length > 2) return `${WEEKDAYS[d[0]! - 1]!.long} to ${WEEKDAYS[d[d.length - 1]! - 1]!.long}`;
  return d.map((x) => WEEKDAYS[x - 1]!.short).join(', ');
}
