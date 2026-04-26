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
    // initialize() returns true if Health Connect is installed and reachable.
    const ok = await hc.initialize();
    if (!ok) return 'not_installed';
    // Some versions expose getSdkStatus — surface "update required" cases.
    if (typeof hc.getSdkStatus === 'function') {
      const status = await hc.getSdkStatus();
      if (status === 1 /* SDK_UNAVAILABLE */) return 'not_installed';
      if (status === 2 /* PROVIDER_UPDATE_REQUIRED */) return 'update_required';
    }
    return 'available';
  } catch {
    return 'not_installed';
  }
}

/** Required permissions: read sleep records (and optionally steps & HR). */
const REQUIRED_PERMISSIONS = [
  { accessType: 'read', recordType: 'SleepSession' },
  { accessType: 'read', recordType: 'Steps' },
  { accessType: 'read', recordType: 'HeartRate' },
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
  const hc = tryLoadHC();
  if (!hc) throw new Error('Health Connect is not available on this device.');
  await hc.initialize();
  const granted = await hc.requestPermission(REQUIRED_PERMISSIONS);
  // Sometimes the call returns immediately while the user is still on the
  // permission screen. Re-check explicitly.
  if (Array.isArray(granted) && granted.length > 0) return true;
  return await hasGrantedPermissions();
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
