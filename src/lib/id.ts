import { customAlphabet } from 'nanoid';

// Timestamp helpers live in ./time; re-exported here because identifiers and
// timestamps are almost always needed together.
export { nowIso, iso, parseIso, addDays, addMinutes, daysBetween } from './time';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

const makers: Record<string, (n?: number) => string> = {};

/** Prefixed, URL-safe, collision-resistant identifiers. */
export function id(prefix: string, size = 14): string {
  if (!makers[prefix]) makers[prefix] = customAlphabet(ALPHABET, size);
  return `${prefix}_${makers[prefix]()}`;
}

export function slugify(input: string, max = 48): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, max)
    .replace(/^-|-$/g, '');
}

/** Stable non-cryptographic hash — used for anonymised IP hashing (§23). */
export function stableHash(input: string, salt = 'acq-os'): string {
  let h1 = 0x811c9dc5;
  const s = `${salt}:${input}`;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(36);
}

export function normalizeDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  let s = url.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split(/[/?#]/)[0];
  return s || null;
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

export function domainOfEmail(email: string | null | undefined): string | null {
  const e = normalizeEmail(email);
  return e ? e.split('@')[1] : null;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

export function round(n: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function pct(n: number, places = 0): string {
  return `${round(n * 100, places)}%`;
}

export function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (out[k] ||= []).push(item);
  }
  return out;
}

export function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

export function avg(arr: number[]): number {
  return arr.length ? sum(arr) / arr.length : 0;
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = obj[k];
  return out;
}

export function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function truncate(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function sentence(list: string[]): string {
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Deterministic PRNG — keeps demo data and evaluations reproducible. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
