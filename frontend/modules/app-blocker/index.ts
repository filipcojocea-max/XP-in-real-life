/**
 * App Blocker (Android-only).
 *
 * Detects when a user opens a "locked" app during a Focus Mode session,
 * fires a high-priority warning notification and accumulates the time
 * spent inside the locked app so the backend can apply the XP penalty.
 *
 * iOS / web fall-back: every method becomes a no-op and `isSupported`
 * returns false. The caller is expected to gracefully degrade to the
 * existing AppState-based "left the app" detection.
 *
 * Implementation
 * ──────────────
 * Native side: `AppBlockerModule.kt` exposes a foreground service that
 * polls UsageStatsManager every 2 seconds. When the foreground app's
 * package matches one of the user's blocklist, it:
 *   • Emits a JS event `onLockedAppOpened` { packageName, totalSeconds }
 *   • Fires a high-importance notification (channel: `app_blocker`).
 *   • Increments a session-scoped counter.
 *
 * Public surface kept intentionally tiny — anything more complex stays
 * in Kotlin so we don't need ad-hoc bridge calls per second.
 */
import { NativeModulesProxy, EventEmitter, Subscription, requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type LockedAppEvent = {
  packageName: string;
  totalSeconds: number;
};

export type AppBlockerStopResult = {
  totalSeconds: number;
  detectedPackages: string[];
};

// `requireOptionalNativeModule` lets us gracefully bail on iOS / web
// where the native side isn't compiled at all. Returns null in those
// environments so we can short-circuit every public call.
const NativeModule: any =
  Platform.OS === 'android'
    ? requireOptionalNativeModule('AppBlocker') ?? (NativeModulesProxy as any)?.AppBlocker
    : null;

const isSupported: boolean = Platform.OS === 'android' && NativeModule != null;

const emitter = NativeModule ? new EventEmitter(NativeModule) : null;

function noop(): any {}

export const AppBlocker = {
  /** True only on Android with the native module compiled in. */
  isSupported,

  /** Returns true if the user has granted PACKAGE_USAGE_STATS access. */
  hasUsageAccessPermission: async (): Promise<boolean> => {
    if (!NativeModule) return false;
    try {
      return await NativeModule.hasUsageAccessPermission();
    } catch {
      return false;
    }
  },

  /**
   * Opens the system **Settings → Usage Access** screen so the user can
   * toggle the permission on. Returns true if Settings was launched
   * (the actual grant is async and must be re-checked on resume).
   */
  requestUsageAccessPermission: async (): Promise<boolean> => {
    if (!NativeModule) return false;
    try {
      return await NativeModule.requestUsageAccessPermission();
    } catch {
      return false;
    }
  },

  /**
   * Starts the foreground service that polls UsageStatsManager every
   * ~2s. The native side keeps a running counter of seconds spent
   * inside any of the `lockedPackages`.
   *
   * NOTE: This is idempotent — calling start while running is a no-op.
   */
  startMonitoring: async (lockedPackages: string[]): Promise<void> => {
    if (!NativeModule) return noop();
    try {
      await NativeModule.startMonitoring(lockedPackages);
    } catch (e) {
      console.warn('[AppBlocker] start failed', e);
    }
  },

  /**
   * Stops the foreground service and returns the cumulative seconds
   * the user spent inside any locked app during the session, plus the
   * unique package names that triggered detection (for analytics /
   * showing the user which apps cost them XP).
   */
  stopMonitoring: async (): Promise<AppBlockerStopResult> => {
    if (!NativeModule) return { totalSeconds: 0, detectedPackages: [] };
    try {
      const r = await NativeModule.stopMonitoring();
      return {
        totalSeconds: Number(r?.totalSeconds || 0),
        detectedPackages: Array.isArray(r?.detectedPackages) ? r.detectedPackages : [],
      };
    } catch {
      return { totalSeconds: 0, detectedPackages: [] };
    }
  },

  /** Subscribe to per-detection events for live UI updates. */
  addLockedAppListener: (cb: (e: LockedAppEvent) => void): Subscription | { remove: () => void } => {
    if (!emitter) return { remove: () => {} };
    return emitter.addListener<LockedAppEvent>('onLockedAppOpened', cb);
  },
};

export default AppBlocker;
