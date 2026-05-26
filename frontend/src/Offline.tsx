/**
 * Offline-First Layer (v1.0.29)
 *
 * Three pieces in one file so call sites only have to import from one
 * place:
 *
 *   1. <OfflineProvider> — React context that publishes the current
 *      `isOnline` state via NetInfo subscription, plus the pending
 *      queue length. Mount once near the top of the app tree.
 *
 *   2. queueMutation(...) — fire-and-forget helper called by api.ts
 *      wrappers to enqueue a write that can't run right now. Persists
 *      via AsyncStorage so kills + reboots survive. On reconnect, the
 *      provider drains the queue strictly FIFO (per user preference
 *      locked 2026-05-17: 1a / 2y / 3y / 4y).
 *
 *   3. <OfflineBanner /> — thin slate-grey pill that floats at the top
 *      of the screen while offline, showing the pending count. Hidden
 *      when online and the queue is empty.
 *
 * Design notes
 * ────────────
 * • We deliberately don't use TanStack Query's built-in mutation
 *   persistence — its pause/resume model is awkward when we need
 *   call-site control (e.g. "feed post should appear optimistically,
 *   purchase should hard-fail"). The custom queue is small + tested.
 * • Purchases are NEVER queued — Stripe sessions are time-bound, the
 *   price + card could change, and re-running stale checkouts risks
 *   double-charging. Call sites that involve money MUST early-return
 *   with a separate "needs internet" toast instead of queueing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii } from './theme';
import { showAlert } from './uiAlert';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────
export type QueuedMutation = {
  id: string;                  // uuid — used to dedupe replay
  kind: string;                // free-form tag (e.g. "goal.create"); shown in debug toasts
  // ↓ The fetch-style request we'll replay verbatim once online.
  path: string;                // e.g. "/goals"
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: any;                  // serialisable JSON
  // Human label for the banner / toast ("Pending goal", etc).
  label?: string;
  // Timestamp ms when queued.
  queuedAt: number;
  // Number of replay attempts so far (for max-retry capping).
  attempts: number;
};

type OfflineState = {
  isOnline: boolean;
  pendingCount: number;
  isReplaying: boolean;
  /** Returns the queued mutation id. Caller can use it to wire up an
   *  optimistic UI rollback in case sync fails on reconnect. */
  enqueue: (m: Omit<QueuedMutation, 'id' | 'queuedAt' | 'attempts'>) => Promise<string>;
  /** Manual trigger — pulls from the top of the queue. Normally
   *  invoked automatically when isOnline flips true. */
  flush: () => Promise<void>;
  /** Synchronous helper for call sites — shows the standard "you're
   *  offline" toast and enqueues. Returns true when the action was
   *  queued (caller should early-return). */
  guardOffline: (
    label: string,
    fn: Omit<QueuedMutation, 'id' | 'queuedAt' | 'attempts'>,
  ) => Promise<boolean>;
};

// ────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────
const QUEUE_KEY = '@xp.offline_queue.v1';
const MAX_ATTEMPTS = 5;

async function loadQueue(): Promise<QueuedMutation[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveQueue(q: QueuedMutation[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* persistence failure is non-fatal — items will be lost on reload */
  }
}

// ────────────────────────────────────────────────────────────────────
// `runQueuedMutation` is injected from outside so we don't have a
// circular import between api.ts ↔ Offline.tsx. api.ts calls
// `setOfflineRunner(fn)` at module load time.
// ────────────────────────────────────────────────────────────────────
type RunnerFn = (m: QueuedMutation) => Promise<void>;
let runner: RunnerFn | null = null;
export function setOfflineRunner(fn: RunnerFn) {
  runner = fn;
}

// ────────────────────────────────────────────────────────────────────
// Context
// ────────────────────────────────────────────────────────────────────
const Ctx = createContext<OfflineState>({
  isOnline: true,
  pendingCount: 0,
  isReplaying: false,
  enqueue: async () => '',
  flush: async () => {},
  guardOffline: async () => false,
});

export function useOffline() {
  return useContext(Ctx);
}

// Module-level mirror used by api.ts wrappers (which can't `useOffline`
// because they're called outside React components). Kept in sync by
// the provider on every state change.
let _isOnline = true;
export function isOnlineNow(): boolean {
  return _isOnline;
}

// ────────────────────────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────────────────────────
export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [queue, setQueue] = useState<QueuedMutation[]>([]);
  const [isReplaying, setIsReplaying] = useState(false);
  // Track the latest queue inside a ref so async drain doesn't rely on
  // stale state during back-to-back enqueues.
  const queueRef = useRef<QueuedMutation[]>([]);

  const persist = useCallback(async (next: QueuedMutation[]) => {
    queueRef.current = next;
    setQueue(next);
    await saveQueue(next);
  }, []);

  // ── Boot: hydrate queue + subscribe to NetInfo ───────────────────
  useEffect(() => {
    let active = true;
    (async () => {
      const hydrated = await loadQueue();
      if (!active) return;
      queueRef.current = hydrated;
      setQueue(hydrated);
      // Sync the initial online state from NetInfo immediately on boot
      // so the first render of OfflineBanner / api.req() reflects real
      // device state (instead of the `true` default which causes
      // requests to hang waiting for the first network event when the
      // user is actually offline).
      try {
        const s = await NetInfo.fetch();
        const online = s.isConnected !== false && s.isInternetReachable !== false;
        _isOnline = online;
        if (active) setIsOnline(online);
      } catch {
        /* leave default */
      }
    })();
    const unsub = NetInfo.addEventListener((s: NetInfoState) => {
      // Treat `null` (still checking) as online to avoid false banners
      // on slow boot. Once we get a definitive `false`, we go offline.
      const online =
        s.isConnected !== false && s.isInternetReachable !== false;
      _isOnline = online;
      setIsOnline(online);
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  // ── Drain pending mutations whenever we transition offline → online
  const flush = useCallback(async () => {
    if (!_isOnline) return;
    if (!runner) return;
    if (isReplaying) return;
    if (queueRef.current.length === 0) return;
    setIsReplaying(true);
    try {
      // Strict FIFO — sip items one at a time so a server-side rate
      // limit or DB lock doesn't trip a thundering-herd replay.
      while (queueRef.current.length > 0) {
        const m = queueRef.current[0];
        try {
          await runner(m);
          // Success → pop the head.
          const next = queueRef.current.slice(1);
          await persist(next);
        } catch (e: any) {
          const attempts = m.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            // Give up — drop the item, log loudly, and let the user
            // know that one of their pending actions was lost.
            // eslint-disable-next-line no-console
            console.log('[offline] dropping after', attempts, 'attempts:', m, e);
            try {
              showAlert(
                'Pending action failed',
                `${m.label || m.kind} couldn't be synced after ${MAX_ATTEMPTS} tries and was discarded.`,
              );
            } catch {
              /* ignore */
            }
            const next = queueRef.current.slice(1);
            await persist(next);
          } else {
            // Bump attempt count, leave the item at the head, and
            // exit the loop — the next NetInfo flip / manual flush
            // will retry.
            const next = [
              { ...m, attempts },
              ...queueRef.current.slice(1),
            ];
            await persist(next);
            break;
          }
        }
      }
    } finally {
      setIsReplaying(false);
    }
  }, [isReplaying, persist]);

  // Trigger flush on offline → online transitions.
  useEffect(() => {
    if (isOnline) {
      // Slight debounce so we don't fire while a flaky network is
      // still flapping. 1.2 s is plenty for a real reconnect.
      const t = setTimeout(() => {
        flush();
      }, 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [isOnline, flush]);

  // ── enqueue ──────────────────────────────────────────────────────
  const enqueue = useCallback(
    async (m: Omit<QueuedMutation, 'id' | 'queuedAt' | 'attempts'>) => {
      const id = `qm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const item: QueuedMutation = {
        ...m,
        id,
        queuedAt: Date.now(),
        attempts: 0,
      };
      const next = [...queueRef.current, item];
      await persist(next);
      return id;
    },
    [persist],
  );

  // Expose `enqueue` to api.ts so the centralised offline guard inside
  // req() can drop mutations into the queue without `useOffline`.
  useEffect(() => {
    try {
      const { _setOfflineEnqueue } = require('./api');
      if (typeof _setOfflineEnqueue === 'function') {
        _setOfflineEnqueue((m: any) => enqueue(m));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[offline] could not wire api enqueue', e);
    }
  }, [enqueue]);

  // ── guardOffline: standard wrapper used by call sites ────────────
  const guardOffline = useCallback(
    async (label: string, m: Omit<QueuedMutation, 'id' | 'queuedAt' | 'attempts'>) => {
      if (_isOnline) return false;
      await enqueue({ ...m, label });
      try {
        showAlert(
          "You're offline",
          `This action will sync when you reconnect.`,
        );
      } catch {
        /* ignore */
      }
      return true;
    },
    [enqueue],
  );

  return (
    <Ctx.Provider
      value={{
        isOnline,
        pendingCount: queue.length,
        isReplaying,
        enqueue,
        flush,
        guardOffline,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

// ────────────────────────────────────────────────────────────────────
// <OfflineBanner /> — thin pill on top of every screen when needed.
// ────────────────────────────────────────────────────────────────────
export function OfflineBanner() {
  const { isOnline, pendingCount, isReplaying } = useOffline();
  if (isOnline && pendingCount === 0) return null;

  const isOffline = !isOnline;
  const text = isOffline
    ? 'OFFLINE — will sync automatically when internet returns'
    : isReplaying
    ? `Syncing ${pendingCount} change${pendingCount === 1 ? '' : 's'}…`
    : `${pendingCount} pending — will sync automatically`;

  // Full-width strip pinned to the top of the screen. `pointerEvents:
  // 'none'` means the strip is purely informational — taps fall through
  // to the buttons / UI elements underneath, so the banner never blocks
  // interaction. Red while offline, amber while pending, green while
  // syncing.
  const bg = isOffline ? '#dc2626' : isReplaying ? colors.green : colors.amber;

  return (
    <View
      pointerEvents="none"
      style={[bannerStyles.strip, { backgroundColor: bg }]}
      testID="offline-banner"
    >
      <Text style={bannerStyles.text} numberOfLines={1}>{text}</Text>
    </View>
  );
}

const bannerStyles = StyleSheet.create({
  strip: {
    // Full-width strip docked to the top of the safe-area. We render
    // this from inside the root layout so it sits above every screen.
    // `pointerEvents: 'none'` is set on the View itself so taps pass
    // through to the underlying UI — the banner is never a click trap.
    width: '100%',
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.4,
    textAlign: 'center',
  },
});
