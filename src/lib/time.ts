/** Time helpers. Timestamps are stored as ISO-8601 UTC strings. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function iso(d: Date | number | string): string {
  return new Date(d).toISOString();
}

export function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(base: Date | string, days: number): Date {
  const d = typeof base === 'string' ? new Date(base) : new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function addMinutes(base: Date | string, minutes: number): Date {
  const d = typeof base === 'string' ? new Date(base) : new Date(base.getTime());
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d;
}

export function daysBetween(a: string | Date, b: string | Date = new Date()): number {
  const da = typeof a === 'string' ? new Date(a).getTime() : a.getTime();
  const db = typeof b === 'string' ? new Date(b).getTime() : b.getTime();
  return (db - da) / 86_400_000;
}

export function isPast(s: string | null | undefined): boolean {
  if (!s) return false;
  return new Date(s).getTime() <= Date.now();
}

export function todayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function startOfDayUtc(d: Date = new Date()): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export function formatDateTime(s: string | null | undefined, tz = 'UTC'): string {
  const d = parseIso(s);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  }).format(d);
}

export function formatDate(s: string | null | undefined, tz = 'UTC'): string {
  const d = parseIso(s);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: tz,
  }).format(d);
}

/** "Today 10:32" / "Yesterday 16:20" / "12 Mar, 09:00" — used by the activity timeline (§61). */
export function relativeDateTime(s: string | null | undefined, tz = 'UTC'): string {
  const d = parseIso(s);
  if (!d) return '—';
  const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
  const today = startOfDayUtc();
  const that = new Date(d);
  const diffDays = Math.floor((today.getTime() - new Date(that.toISOString().slice(0, 10)).getTime()) / 86_400_000);
  if (diffDays === 0) return `Today ${fmtTime.format(d)}`;
  if (diffDays === 1) return `Yesterday ${fmtTime.format(d)}`;
  if (diffDays < 7) return `${diffDays} days ago ${fmtTime.format(d)}`;
  return `${formatDate(s, tz)}, ${fmtTime.format(d)}`;
}

export function relativeFromNow(s: string | null | undefined): string {
  const d = parseIso(s);
  if (!d) return '—';
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return 'just now';
  const label =
    mins < 60
      ? `${mins}m`
      : mins < 1440
        ? `${Math.round(mins / 60)}h`
        : `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

/** "02:00" style clock in the given timezone. */
export function clockInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d);
}

/** Next occurrence of an "HH:MM" wall-clock time in the given timezone (UTC-safe approximation). */
export function nextRunForCron(cron: string, tz = 'UTC', from: Date = new Date()): Date {
  const parts = cron.trim().split(/\s+/);
  const [minS, hourS] = parts.length >= 2 ? parts : ['0', '2'];
  const parseField = (f: string, fallback: number) => {
    if (f === '*') return fallback;
    if (f.includes('/')) return Number(f.split('/')[0]) || fallback;
    if (f.includes(',')) return Number(f.split(',')[0]) || fallback;
    const n = Number(f);
    return Number.isFinite(n) ? n : fallback;
  };
  const minute = parseField(minS, 0);
  const hour = parseField(hourS, 2);
  const next = new Date(from);
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  void tz; // wall-clock alignment beyond UTC is handled by the scheduler layer
  return next;
}

export function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
