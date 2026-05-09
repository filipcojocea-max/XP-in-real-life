/**
 * Pure helpers for the Adaptive Work-Life Scheduler wizard.
 *
 *  - patternFromBinary(): turns a 0/1 work-grid array into ['day'|'off', ...]
 *  - detectPeriod():      finds smallest cycle length that fully repeats
 *  - describePattern():   "4 on, 3 off" textual hint shown to the user
 *  - buildSixMonths():    array of 6 contiguous months (~180 days)
 *  - mondayOf():          ISO date of the Monday on/before a given date
 *  - addDays() / iso():   tiny date utils used across the wizard
 */
import type { ShiftType } from './api';

export function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function fromIso(s: string): Date {
  // YYYY-MM-DD parsed at noon LOCAL to avoid TZ rollover bugs.
  const [y, m, d] = s.split('-').map((x) => parseInt(x, 10));
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}

/** Monday (0..0) of the week containing `d`. JS Sunday=0, Monday=1. */
export function mondayOf(d: Date): Date {
  const dow = d.getDay(); // 0..6 (Sun..Sat)
  const diff = dow === 0 ? -6 : 1 - dow; // back to Monday
  return addDays(d, diff);
}

/**
 * Detects the smallest period L (>=2, <=14) such that arr[i] == arr[i+L]
 * for every overlapping i. Trims trailing partial cycle. Returns null
 * when no clean period is found.
 */
export function detectPeriod(arr: number[]): number | null {
  const n = arr.length;
  if (n < 2) return null;
  for (let L = 2; L <= Math.min(14, Math.floor(n / 2) + 0); L++) {
    let ok = true;
    for (let i = 0; i + L < n; i++) {
      if (arr[i] !== arr[i + L]) { ok = false; break; }
    }
    if (ok) return L;
  }
  return null;
}

/** Builds a length-L cycle from binary work-grid: 1→'day', 0→'off'. */
export function patternFromBinary(arr: number[], length: number): ShiftType[] {
  const out: ShiftType[] = [];
  for (let i = 0; i < length; i++) {
    out.push(arr[i] ? 'day' : 'off');
  }
  return out;
}

/**
 * Plain-English summary of a pattern. Examples:
 *  - ["day","day","day","day","off","off","off","off"] → "4 on, 4 off"
 *  - ["day","day","off","off","off"]                  → "2 on, 3 off"
 *  - mixed Day/Night → "3 day · 3 night · 2 off"
 */
export function describePattern(pat: ShiftType[]): string {
  if (!pat.length) return '';
  const counts: Record<ShiftType, number> = { day: 0, night: 0, off: 0 };
  pat.forEach((p) => { counts[p]++; });
  const hasNight = counts.night > 0;
  if (!hasNight) {
    const onCount = counts.day;
    const offCount = counts.off;
    if (onCount && offCount) return `${onCount} on, ${offCount} off`;
    if (onCount && !offCount) return `${onCount} working ${onCount === 1 ? 'day' : 'days'}`;
    return `${offCount} off`;
  }
  const parts: string[] = [];
  if (counts.day) parts.push(`${counts.day} day`);
  if (counts.night) parts.push(`${counts.night} night`);
  if (counts.off) parts.push(`${counts.off} off`);
  return parts.join(' · ');
}

/**
 * Returns a list of 6 month buckets starting from the user's TODAY.
 * Each bucket = { year, month, days[] } where days is the ISO YYYY-MM-DD
 * for every date in that month.
 */
export function buildSixMonths(today: Date = new Date()): Array<{
  key: string;
  year: number;
  month: number;       // 0..11
  label: string;       // e.g. "May 2026"
  days: string[];      // ISO dates
  firstWeekday: number; // 0..6 (Mon=0)  for blank cells before day 1
}> {
  const out = [];
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  for (let i = 0; i < 6; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const year = d.getFullYear();
    const month = d.getMonth();
    const label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const days: string[] = [];
    const last = new Date(year, month + 1, 0).getDate();
    for (let n = 1; n <= last; n++) {
      days.push(iso(new Date(year, month, n)));
    }
    // Mon=0, Sun=6  (so the calendar starts on Monday like in EU)
    const jsDow = new Date(year, month, 1).getDay(); // 0..6 Sun..Sat
    const firstWeekday = jsDow === 0 ? 6 : jsDow - 1;
    out.push({ key: `${year}-${month}`, year, month, label, days, firstWeekday });
  }
  return out;
}

/** Mon..Sun short labels used by the weekly grid. */
export const WEEK_LABELS_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
