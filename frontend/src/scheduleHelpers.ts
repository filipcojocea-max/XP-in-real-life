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
 * Detects the full cycle length given a binary work-grid where the user
 * has marked their FIRST block of work days. Two cases:
 *
 *  ① Multiple work blocks visible → cycle = distance between the start
 *     of block-1 and start of block-2 (e.g. "4 on, 4 off, 4 on…" → 8).
 *
 *  ② Only ONE work block visible → assume the user stopped marking at
 *     the end of their first work block and left the rest blank for us
 *     to "fill in". We use the trailing zero-stretch as the off-period
 *     and clip it to the work-period when blanks ≥ W (symmetric default
 *     — covers e.g. "1–14 work, 15–28 blank" → 14 on, 14 off).
 *
 *  Returns the total cycle length, or null when no work day is marked.
 */
export function detectPeriod(arr: number[]): number | null {
  const n = arr.length;
  if (n < 2) return null;
  const onIndices = arr
    .map((v, i) => (v ? i : -1))
    .filter((i) => i >= 0);
  if (!onIndices.length) return null;

  // Locate first 1-block (start..end inclusive).
  const start = onIndices[0];
  let end = start;
  while (end + 1 < n && arr[end + 1]) end++;
  const W = end - start + 1;

  // Locate start of the SECOND 1-block, if any.
  let secondStart = -1;
  for (let i = end + 1; i < n; i++) {
    if (arr[i]) { secondStart = i; break; }
  }
  if (secondStart > 0) {
    return secondStart - start;  // cycle = first-block-start → next-block-start
  }

  // Single-block case: F = trailing zeros, default to symmetric (= W) if blanks ≥ W.
  const trailing = n - 1 - end;
  if (trailing <= 0) return null; // user marked everything as work — no off period yet
  let F = trailing;
  if (F >= W) F = W;
  return W + F;
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
 *  - ["day"×14, "off"×14] → "14 days on and 14 days off"
 *  - ["day","day","off","off","off"]  → "2 days on and 3 days off"
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
    if (onCount && offCount) {
      return `${onCount} ${onCount === 1 ? 'day' : 'days'} on and ${offCount} ${offCount === 1 ? 'day' : 'days'} off`;
    }
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
