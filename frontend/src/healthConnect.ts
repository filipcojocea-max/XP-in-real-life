/**
 * Health Connect service for the Sleep Data tab.
 *
 * Reads sleep records from Samsung Health (or any Health Connect-enabled app)
 * via Google's Health Connect API. This is the modern replacement for Google
 * Fit on Android.
 *
 * RUNTIME REQUIREMENTS (real data won't work without these):
 *   1. Physical Android device (or emulator with Health Connect installed)
 *   2. Custom Expo dev build — the package contains native code that's NOT
 *      available in Expo Go. Build with:
 *          npx expo prebuild --platform android --clean
 *          npx expo run:android -d
 *   3. Health Connect app installed on the device (pre-installed on
 *      Android 14+, otherwise from Play Store).
 *   4. Samsung Health (or another data provider) configured to write sleep
 *      data into Health Connect.
 *
 * On iOS / web / Expo Go we transparently fall back to the existing mocked
 * dataset returned by the backend so the dashboard always renders something.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';

// ── Crash reporter ──────────────────────────────────────────────────────
// Posts every native Health-Connect failure to the backend so we can audit
// why the system permission dialog doesn't appear. Defensive: never throws.
async function reportHcError(stage: string, err: any, extra?: Record<string, any>) {
  try {
    console.error(`[HC:${stage}]`, err);
    const { api } = await import('./api');
    const cfg: any = Constants?.expoConfig ?? (Constants as any)?.manifest;
    await api.reportHealthConnectError({
      stage,
      message: String(err?.message || err || '').slice(0, 500),
      error_name: String(err?.name || err?.code || 'Error').slice(0, 60),
      platform: Platform.OS,
      os_version: String(Platform.Version ?? ''),
      device: Constants?.deviceName || '',
      app_version: cfg?.version || '',
      extra: extra || {},
    }).catch(() => {});
  } catch {
    // never let the reporter itself blow up the native call
  }
}

// ── Types ────────────────────────────────────────────────────────────────
export type SleepStage =
  | 'awake'
  | 'light'
  | 'deep'
  | 'rem'
  | 'sleeping'
  | 'out_of_bed'
  | 'unknown';

export type RawSleepStage = {
  startTime: string; // ISO
  endTime: string;
  stage: SleepStage;
  duration_minutes: number;
};

export type RawSleepSession = {
  id: string;
  startTime: string;
  endTime: string;
  total_minutes: number;
  source: string; // app that wrote the record (e.g. "Samsung Health")
  stages: RawSleepStage[];
};

export type HealthConnectAvailability =
  | 'available'                // Installed and ready
  | 'not_installed'            // User needs to install Health Connect
  | 'update_required'          // Installed but outdated
  | 'unsupported_platform'     // iOS / web
  | 'expo_go_unsupported';     // Expo Go can't load native modules

export type SleepWeekStats = {
  source: 'health_connect' | 'mock';
  sessions: RawSleepSession[];
  avg_total_minutes: number;
  avg_stages: { deep: number; rem: number; light: number; awake: number };
  best?: RawSleepSession;
  worst?: RawSleepSession;
};

// ── Module loader (deferred so web/iOS bundles don't crash) ──────────────
let HC: any = null;
let HC_LOAD_ERROR: any = null;

function tryLoadHC(): any {
  if (HC || HC_LOAD_ERROR) return HC;
  if (Platform.OS !== 'android') return null;
  try {
    // Lazy require so iOS/web/Expo Go never even try to evaluate the module
    HC = require('react-native-health-connect');
  } catch (e) {
    HC_LOAD_ERROR = e;
    HC = null;
  }
  return HC;
}

// ── Public API ───────────────────────────────────────────────────────────
export async function getAvailability(): Promise<HealthConnectAvailability> {
  if (Platform.OS !== 'android') return 'unsupported_platform';
  const hc = tryLoadHC();
  if (!hc) return 'expo_go_unsupported';
  try {
    // Newer versions of the SDK return `undefined` from initialize() on
    // success. Treat a non-thrown result as "reachable" and use
    // getSdkStatus (when available) as the authoritative check.
    try {
      await hc.initialize();
    } catch (e) {
      // If initialize throws, fall back to getSdkStatus — some devices
      // require the explicit status call before initialize can succeed.
      console.log('[HC] initialize threw:', e);
    }
    if (typeof hc.getSdkStatus === 'function') {
      try {
        const status = await hc.getSdkStatus();
        // 1 = SDK_UNAVAILABLE, 2 = PROVIDER_UPDATE_REQUIRED, 3 = AVAILABLE
        if (status === 1) return 'not_installed';
        if (status === 2) return 'update_required';
        if (status === 3) return 'available';
      } catch (e) {
        console.log('[HC] getSdkStatus threw:', e);
      }
    }
    return 'available';
  } catch {
    return 'not_installed';
  }
}

/** Required permissions: read sleep records, heart rate and SpO2. */
const REQUIRED_PERMISSIONS = [
  { accessType: 'read', recordType: 'SleepSession' },
  { accessType: 'read', recordType: 'HeartRate' },
  { accessType: 'read', recordType: 'OxygenSaturation' },
  { accessType: 'read', recordType: 'Steps' },
];

/** Returns true if the app already has all required Health Connect permissions. */
export async function hasGrantedPermissions(): Promise<boolean> {
  const hc = tryLoadHC();
  if (!hc) return false;
  try {
    await hc.initialize();
    const granted = await hc.getGrantedPermissions();
    const sleepGranted = (granted || []).some(
      (p: any) => p?.recordType === 'SleepSession' && p?.accessType === 'read'
    );
    return sleepGranted;
  } catch {
    return false;
  }
}

/** Opens the Health Connect permission UI and resolves once the user is back. */
export async function requestPermissions(): Promise<boolean> {
  // Defensive: bail out cleanly on any non-Android platform so callers
  // never have to special-case the call. Throws a soft, user-friendly
  // error that the UI can render in an Alert without crashing the app.
  if (Platform.OS !== 'android') {
    throw new Error('Samsung Health is only available on Android.');
  }
  const hc = tryLoadHC();
  if (!hc) {
    // The native module is missing — happens in Expo Go and old dev
    // builds that haven't been re-prebuilt after adding the dependency.
    await reportHcError('module_missing', HC_LOAD_ERROR || 'tryLoadHC returned null');
    throw new Error(
      'Health Connect is not available in this build. Re-build the app with the latest dev client to enable Samsung Health integration.',
    );
  }

  // STEP 1 — Make sure Health Connect itself is reachable. This call
  // also surfaces "not installed" / "update required" cases via
  // getSdkStatus instead of throwing a native exception that would
  // close the app.
  let availability: HealthConnectAvailability;
  try {
    availability = await getAvailability();
  } catch (e) {
    await reportHcError('availability', e);
    throw new Error(
      'Health Connect could not be reached. Please install or update the Health Connect app from the Play Store and try again.',
    );
  }
  if (availability === 'not_installed') {
    await reportHcError('not_installed', 'getAvailability=not_installed');
    throw new Error(
      'Health Connect app is not installed on this device. Install it from the Play Store and try again.',
    );
  }
  if (availability === 'update_required') {
    await reportHcError('update_required', 'getAvailability=update_required');
    throw new Error(
      'Your Health Connect app is out of date. Update it from the Play Store and try again.',
    );
  }
  if (availability !== 'available') {
    await reportHcError('availability_unknown', `value=${availability}`);
    throw new Error(
      'Samsung Health is not available on this device or build.',
    );
  }

  // STEP 2 — Initialize the SDK. Wrap in try/catch so a manifest mismatch
  // or missing native module surfaces a friendly message instead of a
  // hard crash.
  try {
    await hc.initialize();
  } catch (e) {
    await reportHcError('initialize', e);
    throw new Error(
      'Health Connect could not be initialized. Make sure the Health Connect app is installed, updated and that this app has been granted access in Android settings.',
    );
  }

  // STEP 3 — Request read permissions. Try BULK first (single native
  // sheet, best UX); if that native call throws for any reason (e.g. a
  // manifest mismatch), fall back to asking one-by-one so we still
  // collect whatever the user will grant. Either path ends with a
  // getGrantedPermissions() re-check as the source of truth.
  let anyGranted = false;
  try {
    const out = await hc.requestPermission(REQUIRED_PERMISSIONS);
    if (Array.isArray(out) && out.length > 0) anyGranted = true;
  } catch (e) {
    await reportHcError('requestPermission_bulk', e, { perms: REQUIRED_PERMISSIONS });
    console.log('[HC] bulk requestPermission failed, falling back:', e);
    for (const perm of REQUIRED_PERMISSIONS) {
      try {
        const out = await hc.requestPermission([perm]);
        if (Array.isArray(out) && out.length > 0) anyGranted = true;
      } catch (e2) {
        await reportHcError('requestPermission_single', e2, { perm });
        console.log('[HC] requestPermission failed for', perm, e2);
      }
    }
  }
  if (anyGranted) return true;
  // Final fallback — re-query whatever the user actually granted.
  try {
    return await hasGrantedPermissions();
  } catch (e) {
    await reportHcError('hasGrantedPermissions', e);
    return false;
  }
}

/**
 * Opens the system Health Connect "permissions for this app" screen, used
 * as a manual fallback when the in-app permission dialog gets dismissed
 * or denied.
 */
export async function openHealthConnectSettings(): Promise<void> {
  const hc = tryLoadHC();
  if (hc && typeof hc.openHealthConnectSettings === 'function') {
    try {
      await hc.openHealthConnectSettings();
      return;
    } catch (e) {
      console.log('[HC] openHealthConnectSettings failed', e);
    }
  }
  // Fallback: deep-link the Health Connect app or its Play Store page.
  try {
    const Linking = require('expo-linking');
    await Linking.openURL('package:com.google.android.apps.healthdata');
  } catch {
    try {
      const Linking = require('expo-linking');
      await Linking.openURL('https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata');
    } catch {
      // last resort: silently no-op
    }
  }
}

// ── Stage helpers ────────────────────────────────────────────────────────
// Health Connect numeric stage codes (see SleepSessionRecord.StageType)
//   1 = AWAKE
//   2 = SLEEPING (generic)
//   3 = OUT_OF_BED
//   4 = LIGHT
//   5 = DEEP
//   6 = REM
//   7 = AWAKE_IN_BED
function decodeStage(stage: any): SleepStage {
  switch (stage) {
    case 1:
    case 7:
      return 'awake';
    case 2:
      return 'sleeping';
    case 3:
      return 'out_of_bed';
    case 4:
      return 'light';
    case 5:
      return 'deep';
    case 6:
      return 'rem';
    default:
      return 'unknown';
  }
}

function diffMinutes(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.max(0, Math.round((db - da) / 60000));
}

/**
 * Read every sleep session in the last `days` days (default 7).
 * Each session contains its full stage breakdown.
 */
export async function readLastNDaysOfSleep(days = 7): Promise<RawSleepSession[]> {
  const hc = tryLoadHC();
  if (!hc) return [];
  await hc.initialize();
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const result = await hc.readRecords('SleepSession', {
    timeRangeFilter: {
      operator: 'between',
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    },
    ascendingOrder: true,
  });
  // The lib returns either { records } or a raw array depending on version
  const records: any[] = Array.isArray(result) ? result : result?.records || [];
  return records.map((r: any) => {
    const stages = (r.stages || []).map((s: any): RawSleepStage => ({
      startTime: s.startTime,
      endTime: s.endTime,
      stage: decodeStage(s.stage),
      duration_minutes: diffMinutes(s.startTime, s.endTime),
    }));
    return {
      id: String(r.metadata?.id ?? r.id ?? `${r.startTime}-${r.endTime}`),
      startTime: r.startTime,
      endTime: r.endTime,
      total_minutes: diffMinutes(r.startTime, r.endTime),
      source: r.metadata?.dataOrigin?.packageName ?? r.metadata?.dataOriginAppName ?? 'Health Connect',
      stages,
    };
  });
}

/** Aggregate raw sessions into a 7-day summary for the dashboard. */
export function aggregateWeekly(sessions: RawSleepSession[]): SleepWeekStats {
  if (sessions.length === 0) {
    return {
      source: 'health_connect',
      sessions: [],
      avg_total_minutes: 0,
      avg_stages: { deep: 0, rem: 0, light: 0, awake: 0 },
    };
  }
  let deep = 0, rem = 0, light = 0, awake = 0;
  let total = 0;
  for (const s of sessions) {
    total += s.total_minutes;
    for (const st of s.stages) {
      if (st.stage === 'deep') deep += st.duration_minutes;
      else if (st.stage === 'rem') rem += st.duration_minutes;
      else if (st.stage === 'light' || st.stage === 'sleeping') light += st.duration_minutes;
      else if (st.stage === 'awake') awake += st.duration_minutes;
    }
  }
  const n = sessions.length;
  const sorted = [...sessions].sort((a, b) => a.total_minutes - b.total_minutes);
  return {
    source: 'health_connect',
    sessions,
    avg_total_minutes: Math.round(total / n),
    avg_stages: {
      deep: Math.round(deep / n),
      rem: Math.round(rem / n),
      light: Math.round(light / n),
      awake: Math.round(awake / n),
    },
    best: sorted[sorted.length - 1],
    worst: sorted[0],
  };
}

/** Convenience wrapper used by the UI: status → permission → fetch → aggregate. */
export async function fetchSleepWeek(): Promise<{
  availability: HealthConnectAvailability;
  granted: boolean;
  stats: SleepWeekStats | null;
}> {
  const availability = await getAvailability();
  if (availability !== 'available') {
    return { availability, granted: false, stats: null };
  }
  const granted = await hasGrantedPermissions();
  if (!granted) return { availability, granted: false, stats: null };
  const sessions = await readLastNDaysOfSleep(7);
  return { availability, granted: true, stats: aggregateWeekly(sessions) };
}

// ── Heart rate & SpO2 (during a specific sleep window) ───────────────────
export type HRSample = { time: string; bpm: number };
export type SpO2Sample = { time: string; pct: number };

export async function readHeartRateBetween(start: string, end: string): Promise<HRSample[]> {
  const hc = tryLoadHC();
  if (!hc) return [];
  try {
    await hc.initialize();
    const r = await hc.readRecords('HeartRate', {
      timeRangeFilter: { operator: 'between', startTime: start, endTime: end },
    });
    const records: any[] = Array.isArray(r) ? r : r?.records || [];
    const out: HRSample[] = [];
    for (const rec of records) {
      const samples = rec.samples || [];
      for (const s of samples) out.push({ time: s.time, bpm: s.beatsPerMinute });
    }
    return out;
  } catch {
    return [];
  }
}

export async function readSpO2Between(start: string, end: string): Promise<SpO2Sample[]> {
  const hc = tryLoadHC();
  if (!hc) return [];
  try {
    await hc.initialize();
    const r = await hc.readRecords('OxygenSaturation', {
      timeRangeFilter: { operator: 'between', startTime: start, endTime: end },
    });
    const records: any[] = Array.isArray(r) ? r : r?.records || [];
    return records.map((rec: any) => ({
      time: rec.time || rec.startTime,
      pct: rec.percentage?.value ?? rec.percentage ?? 0,
    }));
  } catch {
    return [];
  }
}

// ── Sleep score, factors, and animal ─────────────────────────────────────
export type ScoreFactors = {
  total_score: number;          // 0-100
  duration: number;             // 0-100
  consistency: number;          // 0-100
  awakenings: number;           // 0-100
  physical_recovery: number;    // 0-100 (deep sleep weight)
  mental_recovery: number;      // 0-100 (REM sleep weight)
};

export type SleepAnimal = {
  key: 'lion' | 'penguin' | 'walrus' | 'sealion' | 'hedgehog' | 'crocodile' | 'shark';
  name: string;
  emoji: string;
  description: string;
  trait: string;
};

export type LastNightDetail = {
  session: RawSleepSession;
  hr: { avg: number; min: number; max: number; samples: HRSample[] };
  spo2: { avg: number; min: number; samples: SpO2Sample[] };
  factors: ScoreFactors;
  awakenings: number;
  efficiency: number; // % of time-in-bed actually asleep
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** Translate a raw session + its HR data into a Samsung-style 0-100 score
 *  with sub-factor breakdown. */
export function computeScoreFactors(
  session: RawSleepSession,
  weekSessions: RawSleepSession[]
): ScoreFactors {
  const totalH = session.total_minutes / 60;
  // 1. Duration: ideal 7-9h
  const duration = totalH >= 7 && totalH <= 9
    ? 100
    : totalH >= 6 && totalH <= 10
      ? 80
      : totalH >= 5 && totalH <= 11
        ? 60
        : 40;

  // 2. Consistency: stdev of bedtimes vs midnight, lower is better
  let consistency = 100;
  if (weekSessions.length >= 3) {
    const minutes = weekSessions.map((s) => {
      const d = new Date(s.startTime);
      return d.getHours() * 60 + d.getMinutes();
    });
    const mean = minutes.reduce((a, b) => a + b, 0) / minutes.length;
    const sd = Math.sqrt(
      minutes.reduce((a, b) => a + (b - mean) ** 2, 0) / minutes.length
    );
    consistency = clamp(100 - sd / 1.5, 30, 100);
  }

  // 3. Awakenings count (penalize > 2 awake stages in the night)
  const awakeStages = session.stages.filter((s) => s.stage === 'awake').length;
  const awakenings = clamp(100 - awakeStages * 10, 30, 100);

  // 4. Physical recovery: deep sleep should be ~13-23% of total
  const deepMin = session.stages.filter((s) => s.stage === 'deep').reduce((a, s) => a + s.duration_minutes, 0);
  const deepPct = (deepMin / Math.max(1, session.total_minutes)) * 100;
  const physical_recovery = clamp(100 - Math.abs(deepPct - 18) * 4, 20, 100);

  // 5. Mental recovery: REM should be ~20-25% of total
  const remMin = session.stages.filter((s) => s.stage === 'rem').reduce((a, s) => a + s.duration_minutes, 0);
  const remPct = (remMin / Math.max(1, session.total_minutes)) * 100;
  const mental_recovery = clamp(100 - Math.abs(remPct - 22) * 3, 20, 100);

  const total_score = Math.round(
    duration * 0.3 +
    consistency * 0.15 +
    awakenings * 0.15 +
    physical_recovery * 0.2 +
    mental_recovery * 0.2
  );
  return {
    total_score,
    duration: Math.round(duration),
    consistency: Math.round(consistency),
    awakenings: Math.round(awakenings),
    physical_recovery: Math.round(physical_recovery),
    mental_recovery: Math.round(mental_recovery),
  };
}

/** Discover sleep animal — Samsung-style. Based on 7-day patterns.
 *  Reference: Samsung Health groups users into ~7 animal archetypes. */
export function classifySleepAnimal(weekSessions: RawSleepSession[]): SleepAnimal {
  if (!weekSessions.length) {
    return {
      key: 'hedgehog',
      name: 'Cautious Hedgehog',
      emoji: '🦔',
      description: 'Not enough data yet — keep tracking your sleep!',
      trait: 'Curious',
    };
  }
  const avgMin =
    weekSessions.reduce((a, s) => a + s.total_minutes, 0) / weekSessions.length;
  const avgH = avgMin / 60;
  const bedtimes = weekSessions.map((s) => {
    const d = new Date(s.startTime);
    return d.getHours() * 60 + d.getMinutes();
  });
  const meanBed = bedtimes.reduce((a, b) => a + b, 0) / bedtimes.length;
  const sdBed = Math.sqrt(
    bedtimes.reduce((a, b) => a + (b - meanBed) ** 2, 0) / bedtimes.length
  );
  const totalAwake = weekSessions.reduce(
    (a, s) => a + s.stages.filter((st) => st.stage === 'awake').length,
    0
  );
  const isLateOwl = meanBed >= 60 && meanBed <= 6 * 60; // bed between midnight-6am
  const isConsistent = sdBed < 60; // <1h stdev = consistent
  // Decision tree
  if (avgH >= 8 && isConsistent) {
    return {
      key: 'lion',
      name: 'Confident Lion',
      emoji: '🦁',
      description: "You sleep long, deep and on a dependable schedule. Royal!",
      trait: 'Strong & Stable',
    };
  }
  if (avgH >= 7.5 && avgH < 9 && totalAwake / weekSessions.length < 1.5) {
    return {
      key: 'penguin',
      name: 'Peaceful Penguin',
      emoji: '🐧',
      description: 'Smooth sleep with very few awakenings. You glide through the night.',
      trait: 'Calm & Steady',
    };
  }
  if (avgH >= 7 && isConsistent) {
    return {
      key: 'sealion',
      name: 'Sociable Sea Lion',
      emoji: '🦭',
      description: 'You get solid 7-hour nights with a regular rhythm.',
      trait: 'Rhythmic',
    };
  }
  if (avgH >= 6 && !isConsistent) {
    return {
      key: 'walrus',
      name: 'Lethargic Walrus',
      emoji: '🦣',
      description: 'You sleep enough but your bedtime drifts a lot. Try anchoring it.',
      trait: 'Drifty',
    };
  }
  if (isLateOwl) {
    return {
      key: 'crocodile',
      name: 'Nervous Crocodile',
      emoji: '🐊',
      description: 'You sleep late and your wake-window is restless.',
      trait: 'Nocturnal',
    };
  }
  if (avgH < 6) {
    return {
      key: 'shark',
      name: 'Sensitive Shark',
      emoji: '🦈',
      description: 'Light sleeper with too few hours. Recovery is at risk.',
      trait: 'Light Sleeper',
    };
  }
  return {
    key: 'hedgehog',
    name: 'Cautious Hedgehog',
    emoji: '🦔',
    description: 'Short, fragmented nights. Build a wind-down ritual.',
    trait: 'Restless',
  };
}

// ── Achievements badges (computed from week stats) ───────────────────────
export type Achievement = {
  key: string;
  name: string;
  description: string;
  icon: string;       // Ionicon name
  color: 'green' | 'cyan' | 'amber' | 'pink';
  unlocked: boolean;
};

export function computeAchievements(weekSessions: RawSleepSession[]): Achievement[] {
  const avgMin = weekSessions.length
    ? weekSessions.reduce((a, s) => a + s.total_minutes, 0) / weekSessions.length
    : 0;
  const totalDeep = weekSessions.reduce(
    (a, s) =>
      a + s.stages.filter((st) => st.stage === 'deep').reduce((x, st) => x + st.duration_minutes, 0),
    0
  );
  const totalRem = weekSessions.reduce(
    (a, s) =>
      a + s.stages.filter((st) => st.stage === 'rem').reduce((x, st) => x + st.duration_minutes, 0),
    0
  );
  const has7Days = weekSessions.length >= 7;
  const allOver7 = weekSessions.length >= 5 && weekSessions.every((s) => s.total_minutes >= 7 * 60);
  return [
    { key: 'streak7',  name: '7-Night Streak',     description: 'Tracked 7 nights in a row',  icon: 'flame',       color: 'amber', unlocked: has7Days },
    { key: 'long_avg', name: 'Marathon Sleeper',  description: 'Avg 7+ hours this week',     icon: 'moon',        color: 'cyan',  unlocked: avgMin / 60 >= 7 },
    { key: 'all7',     name: 'Iron Discipline',   description: '5+ nights of 7h or more',    icon: 'shield-checkmark', color: 'green', unlocked: allOver7 },
    { key: 'deep_pro', name: 'Deep Diver',        description: '90+ min deep sleep / week', icon: 'water',       color: 'cyan',  unlocked: totalDeep >= 90 },
    { key: 'rem_pro',  name: 'Dream Weaver',      description: '120+ min REM / week',       icon: 'sparkles',    color: 'pink',  unlocked: totalRem >= 120 },
  ];
}

/** Build the rich detail payload for "last night". Combines session + HR + SpO2. */
export async function buildLastNightDetail(
  session: RawSleepSession,
  weekSessions: RawSleepSession[]
): Promise<LastNightDetail> {
  const [hrSamples, spo2Samples] = await Promise.all([
    readHeartRateBetween(session.startTime, session.endTime),
    readSpO2Between(session.startTime, session.endTime),
  ]);
  const hrVals = hrSamples.map((s) => s.bpm).filter((n) => n > 0);
  const spVals = spo2Samples.map((s) => s.pct).filter((n) => n > 0);
  const hrAvg = hrVals.length ? Math.round(hrVals.reduce((a, b) => a + b, 0) / hrVals.length) : 0;
  const spAvg = spVals.length ? Math.round(spVals.reduce((a, b) => a + b, 0) / spVals.length) : 0;
  const factors = computeScoreFactors(session, weekSessions);
  // Time in bed vs asleep: total_minutes is in-bed; subtract awake stage minutes
  const awakeMin = session.stages
    .filter((s) => s.stage === 'awake' || s.stage === 'out_of_bed')
    .reduce((a, s) => a + s.duration_minutes, 0);
  const efficiency = Math.max(
    0,
    Math.min(100, Math.round(((session.total_minutes - awakeMin) / Math.max(1, session.total_minutes)) * 100))
  );
  const awakenings = session.stages.filter((s) => s.stage === 'awake').length;
  return {
    session,
    hr: { avg: hrAvg, min: Math.min(...hrVals, hrAvg || 0), max: Math.max(...hrVals, hrAvg || 0), samples: hrSamples },
    spo2: { avg: spAvg, min: Math.min(...spVals, spAvg || 0), samples: spo2Samples },
    factors,
    awakenings,
    efficiency,
  };
}
