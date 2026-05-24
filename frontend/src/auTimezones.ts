/**
 * Australian timezones — IANA zone names for DST-aware day calculations.
 * The app is targeted at AU users, so only these are offered during onboarding.
 */
export type AuZone = {
  city: string;
  iana: string;
  state: string;
  abbrev: string;   // e.g. "AEST" / "AEDT" — display hint (not strict)
  offset: string;   // e.g. "UTC+10" — display hint
  notes?: string;
};

export const AU_TIMEZONES: AuZone[] = [
  {
    city: 'Sydney',
    iana: 'Australia/Sydney',
    state: 'NSW',
    abbrev: 'AEST/AEDT',
    offset: 'UTC+10 / +11',
    notes: 'Observes DST',
  },
  {
    city: 'Melbourne',
    iana: 'Australia/Melbourne',
    state: 'VIC',
    abbrev: 'AEST/AEDT',
    offset: 'UTC+10 / +11',
    notes: 'Observes DST',
  },
  {
    city: 'Canberra',
    iana: 'Australia/Sydney',
    state: 'ACT',
    abbrev: 'AEST/AEDT',
    offset: 'UTC+10 / +11',
    notes: 'Observes DST',
  },
  {
    city: 'Hobart',
    iana: 'Australia/Hobart',
    state: 'TAS',
    abbrev: 'AEST/AEDT',
    offset: 'UTC+10 / +11',
    notes: 'Observes DST',
  },
  {
    city: 'Brisbane',
    iana: 'Australia/Brisbane',
    state: 'QLD',
    abbrev: 'AEST',
    offset: 'UTC+10',
    notes: 'No DST',
  },
  {
    city: 'Adelaide',
    iana: 'Australia/Adelaide',
    state: 'SA',
    abbrev: 'ACST/ACDT',
    offset: 'UTC+9:30 / +10:30',
    notes: 'Observes DST',
  },
  {
    city: 'Broken Hill',
    iana: 'Australia/Broken_Hill',
    state: 'NSW',
    abbrev: 'ACST/ACDT',
    offset: 'UTC+9:30 / +10:30',
    notes: 'Observes DST',
  },
  {
    city: 'Darwin',
    iana: 'Australia/Darwin',
    state: 'NT',
    abbrev: 'ACST',
    offset: 'UTC+9:30',
    notes: 'No DST',
  },
  {
    city: 'Perth',
    iana: 'Australia/Perth',
    state: 'WA',
    abbrev: 'AWST',
    offset: 'UTC+8',
    notes: 'No DST',
  },
  {
    city: 'Eucla',
    iana: 'Australia/Eucla',
    state: 'WA',
    abbrev: 'ACWST',
    offset: 'UTC+8:45',
    notes: 'No DST',
  },
  {
    city: 'Lord Howe Island',
    iana: 'Australia/Lord_Howe',
    state: 'NSW',
    abbrev: 'LHST/LHDT',
    offset: 'UTC+10:30 / +11',
    notes: 'Observes DST',
  },
];

/** Find the best-guess zone entry from an IANA string. */
export function findAuZone(iana?: string | null): AuZone | null {
  if (!iana) return null;
  return AU_TIMEZONES.find((z) => z.iana === iana) || null;
}

/** Human-readable "Sydney · AEDT (UTC+11)" with DST-aware current abbreviation. */
export function formatZoneDisplay(iana?: string | null): string {
  const z = findAuZone(iana);
  if (!z) return iana || '—';
  try {
    const fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone: z.iana,
      timeZoneName: 'short',
    });
    const parts = fmt.formatToParts(new Date());
    const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (tzPart) return `${z.city} · ${tzPart}`;
  } catch {}
  return `${z.city} · ${z.abbrev}`;
}
