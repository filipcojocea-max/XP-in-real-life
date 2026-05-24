/**
 * Focus Mode — adjustable countdown + "commit to avoiding" list + gamified
 * distraction penalty.
 *
 * Flow
 * ─────
 *  1. User picks a duration (quick-select chips 5/10/…/90, or scrolls to a
 *     custom minute count).
 *  2. User toggles which curated "distracting apps" they are committing to
 *     not open during the session.
 *  3. Session starts → big countdown ring, green until time's up.
 *  4. ANDROID NATIVE BLOCKER: if the OS-level UsageStatsManager
 *     permission has been granted, our local Expo module spins up a
 *     foreground service that polls the foreground app every 2 sec.
 *     The instant a locked app's package is detected:
 *       • A high-priority "Exit this app now or lose 15 XP/min" push
 *         appears on top of the locked app (not us).
 *       • A running "locked-app seconds" counter is incremented.
 *  5. Backgrounding the app (without opening a locked app) still fires
 *     the legacy "left focus" nudge.
 *  6. Completion → bonus XP. Any locked-app time always costs −15 XP/min
 *     server-authoritative via POST /api/focus/session.
 *
 * Wall-clock countdown
 * ─────────────────────
 * The countdown is anchored to `endAtMsRef = Date.now() + plannedMin*60_000`
 * rather than a `setInterval` decrement. This means:
 *   • Backgrounding the app for 5 min and coming back → the timer
 *     correctly shows 5 min less, not the same value frozen in time.
 *   • Killing the app and reopening → still works (timer recomputed
 *     from the wall clock + the persisted endAt).
 *   • The visible tick interval still uses requestAnimationFrame /
 *     setInterval but it only refreshes the displayed mm:ss string.
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  AppState,
  AppStateStatus,
  Modal,
  ScrollView,
  Platform,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import Ring from '../src/components/Ring';
import { colors, spacing, radii } from '../src/theme';
import { api } from '../src/api';
import { showAlert } from '../src/uiAlert';
import AppBlocker from '../modules/app-blocker';

type Mode = 'idle' | 'running' | 'done';

const PRESETS = [5, 10, 15, 20, 25, 30, 45, 60, 90] as const;

// Curated distracting-app list. Each row carries the canonical Android
// package name(s) the native UsageStatsManager will look for. iOS
// users see the same list as a "commitment device" — no detection.
const DISTRACTING_APPS: {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  tint: string;
  packages: string[];
}[] = [
  { id: 'youtube',   label: 'YouTube',   icon: 'logo-youtube',   tint: '#FF0000', packages: ['com.google.android.youtube', 'com.google.android.apps.youtube.music', 'com.google.android.youtube.tv'] },
  { id: 'instagram', label: 'Instagram', icon: 'logo-instagram', tint: '#E1306C', packages: ['com.instagram.android', 'com.instagram.lite'] },
  { id: 'tiktok',    label: 'TikTok',    icon: 'logo-tiktok',    tint: '#FFFFFF', packages: ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill', 'com.tiktok.tv'] },
  { id: 'twitter',   label: 'X',         icon: 'logo-twitter',   tint: '#1DA1F2', packages: ['com.twitter.android'] },
  { id: 'facebook',  label: 'Facebook',  icon: 'logo-facebook',  tint: '#1877F2', packages: ['com.facebook.katana', 'com.facebook.lite'] },
  { id: 'snapchat',  label: 'Snapchat',  icon: 'logo-snapchat',  tint: '#FFFC00', packages: ['com.snapchat.android'] },
  { id: 'reddit',    label: 'Reddit',    icon: 'logo-reddit',    tint: '#FF4500', packages: ['com.reddit.frontpage'] },
  { id: 'discord',   label: 'Discord',   icon: 'logo-discord',   tint: '#5865F2', packages: ['com.discord'] },
  { id: 'whatsapp',  label: 'WhatsApp',  icon: 'logo-whatsapp',  tint: '#25D366', packages: ['com.whatsapp', 'com.whatsapp.w4b'] },
  { id: 'games',     label: 'Games',     icon: 'game-controller',tint: '#A855F7', packages: ['com.supercell.clashofclans', 'com.supercell.clashroyale', 'com.king.candycrushsaga', 'com.mojang.minecraftpe', 'com.roblox.client'] },
  { id: 'netflix',   label: 'Netflix',   icon: 'film',           tint: '#E50914', packages: ['com.netflix.mediaclient'] },
  { id: 'music',     label: 'Spotify',   icon: 'musical-notes',  tint: '#1DB954', packages: ['com.spotify.music'] },
];

const LOCK_BLUE = '#2F7BFF';

export default function Focus() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('idle');
  const [plannedMin, setPlannedMin] = useState<number>(25);
  const [secondsLeft, setSecondsLeft] = useState<number>(25 * 60);
  const [committed, setCommitted] = useState<Set<string>>(
    new Set(['youtube', 'instagram', 'tiktok']),
  );
  const [showWall, setShowWall] = useState(false);
  const [xpSummary, setXpSummary] = useState<{ delta: number; reason: string } | null>(null);
  // Live counter of locked-app seconds (Android-only). Used both for the
  // pre-end UI ("you've already cost yourself 30 XP") and for the
  // backend penalty payload.
  const [lockedAppSec, setLockedAppSec] = useState<number>(0);
  const [hasUsageAccess, setHasUsageAccess] = useState<boolean>(false);

  // Wall-clock anchor — the source of truth for the countdown.
  const endAtMsRef = useRef<number | null>(null);
  // Background tracking (legacy "left the app" detection — still used
  // on iOS / when usage-stats is denied).
  const backgroundedSecRef = useRef<number>(0);
  const bgStartRef = useRef<number | null>(null);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const endNotifIdRef = useRef<string | null>(null);
  const lockedListenerRef = useRef<{ remove: () => void } | null>(null);

  // Shake animation for locked tile taps.
  const shakeX = useRef(new Animated.Value(0)).current;
  const triggerShake = () => {
    Animated.sequence([
      Animated.timing(shakeX, { toValue: -6, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: 6, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: -4, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: 4, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: 0, duration: 40, useNativeDriver: true }),
    ]).start();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  };

  // Check Usage Access permission on mount + on resume so we can
  // surface the "Grant access" CTA accurately.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!AppBlocker.isSupported) {
        if (!cancelled) setHasUsageAccess(false);
        return;
      }
      const ok = await AppBlocker.hasUsageAccessPermission();
      if (!cancelled) setHasUsageAccess(ok);
    };
    check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => { cancelled = true; sub.remove(); };
  }, []);

  // When duration picker changes while idle, reset the visible countdown.
  useEffect(() => {
    if (mode === 'idle') setSecondsLeft(plannedMin * 60);
  }, [plannedMin, mode]);

  // ── Wall-clock-driven countdown tick ───────────────────────────────
  // We intentionally don't decrement a JS counter — we recompute from
  // `endAtMsRef` every tick. This means a setInterval missing while the
  // app is backgrounded does not corrupt the displayed time.
  useEffect(() => {
    if (mode !== 'running' || endAtMsRef.current == null) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((endAtMsRef.current! - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        clearInterval(id);
        finishSession(true);
      }
    };
    tick(); // run immediately so resume → instant catch-up
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── AppState tracking ─────────────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleAppStateChange = useCallback((next: AppStateStatus) => {
    const prev = appState.current;
    appState.current = next;
    if (mode !== 'running') return;
    if ((prev === 'active' || prev === 'inactive') && next === 'background') {
      bgStartRef.current = Date.now();
      // Only fire the soft "left focus" nudge when we DON'T have
      // native blocker coverage — the blocker will fire its own,
      // far more contextual, "Exit YouTube now" alert.
      if (!hasUsageAccess) {
        fireFocusBreachNotification();
      }
    } else if (prev === 'background' && next === 'active') {
      if (bgStartRef.current != null) {
        backgroundedSecRef.current += Math.floor((Date.now() - bgStartRef.current) / 1000);
        bgStartRef.current = null;
      }
      // Recompute now to instantly reflect the time that passed.
      if (endAtMsRef.current != null) {
        const remaining = Math.max(0, Math.ceil((endAtMsRef.current - Date.now()) / 1000));
        setSecondsLeft(remaining);
        if (remaining <= 0) {
          finishSession(true);
          return;
        }
      }
      // Show the wall only if we actually have a real penalty to show
      // (legacy bg time OR locked-app time on Android).
      if (lockedAppSec > 0 || backgroundedSecRef.current > 0) {
        setShowWall(true);
      }
    }
  }, [mode, hasUsageAccess, lockedAppSec]);

  const fireFocusBreachNotification = async () => {
    try {
      const minsLeft = Math.max(1, Math.ceil(secondsLeft / 60));
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '🚨 Focus Mode breach',
          body: `You left the game. ${minsLeft} min left — get back in and save your XP!`,
          priority: Notifications.AndroidNotificationPriority.MAX,
          sound: 'default',
          data: { kind: 'focus_breach', channelId: 'focus_breach' },
        },
        trigger: null, // fire immediately
      });
    } catch (e) {
      console.warn('[focus] notification fire failed', e);
    }
  };

  // Convert the user's committed `id` set into a flat list of Android
  // package names for the native blocker.
  const lockedPackages = useMemo(() => {
    const pkgs: string[] = [];
    for (const app of DISTRACTING_APPS) {
      if (committed.has(app.id)) pkgs.push(...app.packages);
    }
    return pkgs;
  }, [committed]);

  /**
   * Try to begin native-side monitoring. Returns:
   *   • 'started'        — service running, detection active.
   *   • 'no-permission'  — user must grant Usage Access first; we already
   *                         opened the Settings page for them.
   *   • 'unsupported'    — iOS / web — caller should fall back silently.
   *   • 'no-apps'        — user committed to no apps, nothing to track.
   */
  const beginBlocker = async (): Promise<'started' | 'no-permission' | 'unsupported' | 'no-apps'> => {
    if (!AppBlocker.isSupported) return 'unsupported';
    if (lockedPackages.length === 0) return 'no-apps';
    const ok = await AppBlocker.hasUsageAccessPermission();
    if (!ok) {
      await AppBlocker.requestUsageAccessPermission();
      return 'no-permission';
    }
    setLockedAppSec(0);
    // Subscribe BEFORE starting so we don't miss the first tick.
    lockedListenerRef.current?.remove?.();
    lockedListenerRef.current = AppBlocker.addLockedAppListener((e) => {
      setLockedAppSec(e.totalSeconds);
    });
    await AppBlocker.startMonitoring(lockedPackages);
    return 'started';
  };

  // ── Session lifecycle ──────────────────────────────────────────────
  const startSession = async () => {
    backgroundedSecRef.current = 0;
    bgStartRef.current = null;
    setLockedAppSec(0);
    endAtMsRef.current = Date.now() + plannedMin * 60 * 1000;
    setSecondsLeft(plannedMin * 60);
    setMode('running');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});

    // Pre-register Android channels for breach notifications.
    if (Platform.OS === 'android') {
      Notifications.setNotificationChannelAsync('focus_breach', {
        name: 'Focus Mode · Breach alerts',
        description: 'High-priority nudges when you leave the app mid-session.',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
        vibrationPattern: [0, 300, 150, 300],
        lightColor: '#FF3B30',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      }).catch(() => {});
      Notifications.setNotificationChannelAsync('focus_complete', {
        name: 'Focus Mode · Session complete',
        description: 'Celebrates when your focus timer runs out.',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
        vibrationPattern: [0, 150, 100, 150],
        lightColor: '#00FF88',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      }).catch(() => {});
    }

    // Schedule the "Timer ended!" notification to fire exactly when the
    // countdown will hit 0 — this works even if the user backgrounds or
    // kills the app, because expo-notifications stores the trigger
    // natively. We cancel it if the user ends the session early.
    (async () => {
      try {
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: "✅ Focus Mode complete!",
            body: `Your ${plannedMin}-minute session is up — open the app to claim your XP bonus.`,
            priority: Notifications.AndroidNotificationPriority.HIGH,
            sound: 'default',
            data: { kind: 'focus_complete', channelId: 'focus_complete' },
          },
          trigger: {
            seconds: plannedMin * 60,
            channelId: 'focus_complete',
          } as any,
        });
        endNotifIdRef.current = id;
      } catch (e) {
        console.warn('[focus] schedule end notification failed', e);
      }
    })();

    // Kick off the native blocker (Android only). Failure modes are
    // surfaced as a one-shot inline banner — we don't block session
    // start so iOS / un-permissioned Android users still flow through.
    const r = await beginBlocker();
    if (r === 'no-permission') {
      showAlert(
        'Grant Usage Access',
        'To enforce the app blocker and detect when you open YouTube, Instagram, etc., enable "Usage access" for XP in Real Life in the Settings page that just opened. Then come back and start your session.',
        [
          { text: 'Open Settings again', onPress: () => AppBlocker.requestUsageAccessPermission() },
          { text: 'Continue without blocker', style: 'cancel' },
        ],
      );
    }
  };

  const finishSession = async (completed: boolean) => {
    const ran = endAtMsRef.current != null
      ? Math.max(0, Math.floor((Date.now() - (endAtMsRef.current - plannedMin * 60 * 1000)) / 1000))
      : plannedMin * 60 - secondsLeft;
    endAtMsRef.current = null;
    const bgSec = backgroundedSecRef.current;
    const finalBgSec = bgStartRef.current != null
      ? bgSec + Math.floor((Date.now() - bgStartRef.current) / 1000)
      : bgSec;
    bgStartRef.current = null;

    // Cancel the pending "Timer ended" notification on early-exit.
    if (endNotifIdRef.current) {
      try { await Notifications.cancelScheduledNotificationAsync(endNotifIdRef.current); } catch {}
      endNotifIdRef.current = null;
    }

    // Stop the Android blocker FIRST so we read its final counter.
    let lockedSeconds = lockedAppSec;
    if (AppBlocker.isSupported) {
      try {
        const r = await AppBlocker.stopMonitoring();
        // Native total wins over the JS event counter (events can be
        // lost if the JS thread was suspended for the entire session).
        if (r.totalSeconds > lockedSeconds) lockedSeconds = r.totalSeconds;
      } catch {}
    }
    lockedListenerRef.current?.remove?.();
    lockedListenerRef.current = null;

    setMode('done');
    setShowWall(false);
    if (completed) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
    try {
      const r = await api.focusSession({
        planned_minutes: plannedMin,
        actual_seconds: ran,
        backgrounded_seconds: finalBgSec,
        locked_app_seconds: lockedSeconds,
        completed,
        committed_app_count: committed.size,
      });
      setXpSummary({ delta: r.xp_delta, reason: r.reason });
    } catch (e: any) {
      setXpSummary({ delta: 0, reason: 'save_failed' });
    }
  };

  const cancelSession = () => {
    showAlert(
      'End Focus Session?',
      "You'll lose your completion bonus. Any time spent in blocked apps is still penalized at −15 XP/min.",
      [
        { text: 'Keep Going', style: 'cancel' },
        {
          text: 'End Session',
          style: 'destructive',
          onPress: () => finishSession(false),
        },
      ],
    );
  };

  // ── Render helpers ─────────────────────────────────────────────────
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  const totalSec = plannedMin * 60;
  const progress = totalSec > 0 ? (totalSec - secondsLeft) / totalSec : 0;

  const renderLockedApp = (app: typeof DISTRACTING_APPS[number], running: boolean) => {
    const isLocked = running && committed.has(app.id);
    const isSelected = committed.has(app.id);
    return (
      <Animated.View
        key={app.id}
        style={[
          { transform: [{ translateX: isLocked ? shakeX : 0 }] },
          styles.appTile,
          isLocked && styles.appTileLocked,
          !running && isSelected && styles.appTileSelected,
        ]}
      >
        <TouchableOpacity
          onPress={() => {
            if (running && isLocked) {
              triggerShake();
              return;
            }
            setCommitted((s) => {
              const next = new Set(s);
              if (next.has(app.id)) next.delete(app.id);
              else next.add(app.id);
              return next;
            });
            Haptics.selectionAsync().catch(() => {});
          }}
          activeOpacity={0.8}
          style={styles.appTileInner}
          testID={`focus-app-${app.id}`}
        >
          <View style={[styles.appIconWrap, { backgroundColor: app.tint + (isLocked ? '33' : '22') }]}>
            <Ionicons name={app.icon} size={26} color={isLocked ? '#777' : app.tint} />
          </View>
          <Text style={[styles.appLabel, isLocked && { color: '#777' }]} numberOfLines={1}>
            {app.label}
          </Text>
          {isLocked && (
            <View style={styles.lockBadge} testID={`focus-app-${app.id}-lock`}>
              <Ionicons name="lock-closed" size={12} color="#FFF" />
            </View>
          )}
          {!running && isSelected && (
            <View style={styles.checkBadge}>
              <Ionicons name="checkmark" size={12} color={colors.bg} />
            </View>
          )}
        </TouchableOpacity>
      </Animated.View>
    );
  };

  // ── DONE screen ────────────────────────────────────────────────────
  if (mode === 'done') {
    const delta = xpSummary?.delta ?? 0;
    const positive = delta > 0;
    const zero = delta === 0;
    const lockedMin = Math.floor(lockedAppSec / 60);
    const bgMin = Math.round(backgroundedSecRef.current / 60);
    return (
      <SafeAreaView style={styles.safe}>
        <View style={[styles.content, { justifyContent: 'center' }]}>
          <View style={[styles.doneBadge, { backgroundColor: positive ? colors.green + '22' : zero ? colors.border : '#FF3B3022' }]}>
            <Ionicons
              name={positive ? 'checkmark-circle' : zero ? 'time-outline' : 'alert-circle'}
              size={48}
              color={positive ? colors.green : zero ? colors.textMuted : '#FF3B30'}
            />
            <Text style={styles.doneTitle}>
              {positive ? 'Session Complete' : zero ? 'Session Ended' : 'Lost Focus'}
            </Text>
            <Text style={styles.doneSubtitle}>
              {positive
                ? `+${delta} XP earned`
                : zero
                  ? 'No XP awarded'
                  : lockedMin > 0
                    ? `${delta} XP — ${lockedMin} min in blocked apps × −15`
                    : `${delta} XP — distracted for ${bgMin} min`}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.startBtn}
            onPress={() => {
              setMode('idle');
              setXpSummary(null);
              setSecondsLeft(plannedMin * 60);
              backgroundedSecRef.current = 0;
              setLockedAppSec(0);
            }}
          >
            <Ionicons name="reload" size={18} color={colors.bg} />
            <Text style={styles.startText}>Start Another</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ghostBtn} onPress={() => router.back()}>
            <Text style={styles.ghostBtnText}>Back to Profile</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const isRunning = mode === 'running';

  return (
    <SafeAreaView style={styles.safe}>
      {!isRunning && (
        <View style={styles.closeRow}>
          <TouchableOpacity testID="focus-close" onPress={() => router.back()} style={styles.closeBtn}>
            <Ionicons name="close" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>
      )}

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 32 }]} showsVerticalScrollIndicator={false}>
        <Text style={styles.kicker}>Focus Mode</Text>
        <Text style={styles.title}>{isRunning ? 'Lock In' : 'Pick Your Time'}</Text>

        <View style={{ marginVertical: spacing.lg }}>
          <Ring size={260} stroke={14} progress={isRunning ? progress : 0} color={isRunning ? colors.cyan : colors.amber}>
            <Text style={styles.timerMm} testID="focus-timer">{mm}:{ss}</Text>
            <Text style={styles.timerLabel}>
              {isRunning ? 'FOCUSED' : 'READY'}
            </Text>
          </Ring>
        </View>

        {!isRunning ? (
          <>
            {/* Preset quick-selects */}
            <Text style={styles.sectionLabel}>Quick Select</Text>
            <View style={styles.presetRow}>
              {PRESETS.map((m) => {
                const active = plannedMin === m;
                return (
                  <TouchableOpacity
                    key={m}
                    onPress={() => { setPlannedMin(m); Haptics.selectionAsync().catch(() => {}); }}
                    style={[styles.presetChip, active && styles.presetChipActive]}
                    testID={`focus-preset-${m}`}
                  >
                    <Text style={[styles.presetChipText, active && { color: colors.bg }]}>{m}m</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Custom ± adjust */}
            <View style={styles.customRow}>
              <TouchableOpacity
                style={styles.adjBtn}
                onPress={() => { setPlannedMin((m) => Math.max(1, m - 1)); Haptics.selectionAsync().catch(() => {}); }}
                testID="focus-minus"
              >
                <Ionicons name="remove" size={20} color={colors.text} />
              </TouchableOpacity>
              <Text style={styles.customText}>{plannedMin} min</Text>
              <TouchableOpacity
                style={styles.adjBtn}
                onPress={() => { setPlannedMin((m) => Math.min(180, m + 1)); Haptics.selectionAsync().catch(() => {}); }}
                testID="focus-plus"
              >
                <Ionicons name="add" size={20} color={colors.text} />
              </TouchableOpacity>
            </View>

            {/* Distracting apps picker */}
            <Text style={[styles.sectionLabel, { marginTop: spacing.lg }]}>
              Commit to Avoiding ({committed.size})
            </Text>
            <Text style={styles.sectionHint}>
              Select the apps you won't open during this session. They'll lock with a blue icon once the timer starts.
            </Text>
            <View style={styles.appGrid}>
              {DISTRACTING_APPS.map((a) => renderLockedApp(a, false))}
            </View>

            <TouchableOpacity testID="focus-start" style={styles.startBtn} onPress={startSession}>
              <Ionicons name="lock-closed" size={18} color={colors.bg} />
              <Text style={styles.startText}>Start {plannedMin}-min Session</Text>
            </TouchableOpacity>
            {/* Android-only: surface the Usage Access CTA so users know
                why blocking won't fire until they grant the permission. */}
            {AppBlocker.isSupported && !hasUsageAccess ? (
              <TouchableOpacity
                style={styles.usageBanner}
                onPress={async () => {
                  await AppBlocker.requestUsageAccessPermission();
                }}
                testID="focus-usage-cta"
                activeOpacity={0.85}
              >
                <Ionicons name="shield-half" size={16} color={LOCK_BLUE} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.usageBannerTitle}>Enable real app blocking</Text>
                  <Text style={styles.usageBannerSub}>
                    Grant Usage Access to detect blocked apps and apply the −15 XP/min penalty.
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
            <Text style={styles.disclaimer}>
              {AppBlocker.isSupported && hasUsageAccess
                ? 'Opening a blocked app costs −15 XP per minute. Completing the timer earns a bonus.'
                : Platform.OS === 'ios'
                  ? 'Leaving the app during a session costs −2 XP per minute (iOS limitation). Completing earns a bonus.'
                  : 'Without Usage Access, leaving the app costs −2 XP per minute. Completing earns a bonus.'}
            </Text>
          </>
        ) : (
          <>
            {/* RUNNING state: show locked-app wall + live penalty pill. */}
            {lockedAppSec > 0 ? (
              <View style={styles.livePenaltyPill} testID="focus-live-penalty">
                <Ionicons name="alert-circle" size={14} color="#FF3B30" />
                <Text style={styles.livePenaltyText}>
                  −{Math.floor(lockedAppSec / 60) * 15} XP locked-app penalty
                </Text>
              </View>
            ) : null}
            <Text style={styles.sectionLabel}>Locked Apps</Text>
            <View style={styles.appGrid}>
              {DISTRACTING_APPS.filter(a => committed.has(a.id)).map((a) => renderLockedApp(a, true))}
              {committed.size === 0 && (
                <Text style={styles.noApps}>No apps committed — willpower-only mode.</Text>
              )}
            </View>

            <TouchableOpacity testID="focus-cancel" style={styles.endBtn} onPress={cancelSession}>
              <Ionicons name="stop-circle" size={18} color="#FF3B30" />
              <Text style={styles.endBtnText}>End Early</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      {/* Focus Wall — shown when the user returns from background mid-session. */}
      <Modal visible={showWall && isRunning} animationType="fade" transparent>
        <SafeAreaView style={styles.wallBackdrop}>
          <View style={styles.wallCard}>
            <View style={styles.wallPulse}>
              <Ionicons name="lock-closed" size={48} color={LOCK_BLUE} />
            </View>
            <Text style={styles.wallTitle}>Session in Progress</Text>
            <Text style={styles.wallTimer}>{mm}:{ss}</Text>
            <Text style={styles.wallSubtitle}>
              {lockedAppSec > 0
                ? `You've already lost −${Math.floor(lockedAppSec / 60) * 15} XP for ${Math.floor(lockedAppSec / 60)} min in blocked apps.`
                : 'You lost −2 XP per minute while away. Stay put.'}
            </Text>
            <View style={styles.appGrid}>
              {DISTRACTING_APPS.filter(a => committed.has(a.id)).map((a) => (
                <View key={a.id} style={[styles.appTile, styles.appTileLocked]}>
                  <View style={styles.appTileInner}>
                    <View style={[styles.appIconWrap, { backgroundColor: a.tint + '22' }]}>
                      <Ionicons name={a.icon} size={26} color="#777" />
                    </View>
                    <Text style={[styles.appLabel, { color: '#777' }]} numberOfLines={1}>{a.label}</Text>
                    <View style={styles.lockBadge}>
                      <Ionicons name="lock-closed" size={12} color="#FFF" />
                    </View>
                  </View>
                </View>
              ))}
            </View>
            <TouchableOpacity style={styles.startBtn} onPress={() => setShowWall(false)} testID="focus-wall-resume">
              <Text style={styles.startText}>Back to Timer</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  closeRow: { flexDirection: 'row', justifyContent: 'flex-end', padding: spacing.md },
  closeBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.surfaceGlass || colors.surface,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  content: { alignItems: 'center', paddingHorizontal: spacing.lg },
  kicker: { color: colors.cyan, fontSize: 12, letterSpacing: 3, fontWeight: '800' },
  title: { color: colors.text, fontSize: 30, fontWeight: '900', marginTop: 4, letterSpacing: -0.5 },
  timerMm: { color: colors.text, fontSize: 56, fontWeight: '900', letterSpacing: -2 },
  timerLabel: { color: colors.cyan, fontSize: 12, letterSpacing: 3, fontWeight: '800', marginTop: 4 },

  sectionLabel: {
    alignSelf: 'flex-start',
    color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1.5,
    marginTop: spacing.md, marginBottom: 8,
  },
  sectionHint: { alignSelf: 'flex-start', color: colors.textMuted, fontSize: 12, marginBottom: 10, lineHeight: 17 },

  // Presets
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignSelf: 'stretch' },
  presetChip: {
    paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 999, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  presetChipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  presetChipText: { color: colors.text, fontSize: 13, fontWeight: '800' },

  customRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 16, marginTop: 12, alignSelf: 'stretch',
  },
  adjBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  customText: { color: colors.text, fontSize: 18, fontWeight: '800', minWidth: 90, textAlign: 'center' },

  // App grid
  appGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 10,
    marginTop: 4, alignSelf: 'stretch',
  },
  appTile: {
    width: '30.5%',
    aspectRatio: 1,
    borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    position: 'relative',
  },
  appTileInner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 6 },
  appTileSelected: { borderColor: colors.amber, backgroundColor: colors.amber + '15' },
  appTileLocked: {
    opacity: 0.55,
    borderColor: LOCK_BLUE + '88',
  },
  appIconWrap: {
    width: 44, height: 44, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  appLabel: { color: colors.text, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  lockBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: LOCK_BLUE,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.bg,
  },
  checkBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: colors.amber,
    alignItems: 'center', justifyContent: 'center',
  },
  noApps: { color: colors.textMuted, fontSize: 12, textAlign: 'center', padding: spacing.md },

  // Action buttons
  startBtn: {
    marginTop: spacing.lg,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.cyan,
    paddingHorizontal: 22, paddingVertical: 14, borderRadius: radii.pill,
    alignSelf: 'stretch', justifyContent: 'center',
  },
  startText: { color: colors.bg, fontSize: 15, fontWeight: '900', letterSpacing: 0.5 },
  endBtn: {
    marginTop: spacing.lg,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#FF3B3022',
    borderWidth: 1, borderColor: '#FF3B3066',
    paddingHorizontal: 22, paddingVertical: 12, borderRadius: radii.pill,
    alignSelf: 'center',
  },
  endBtnText: { color: '#FF3B30', fontSize: 13, fontWeight: '900' },
  ghostBtn: { marginTop: 10, padding: 12 },
  ghostBtnText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  disclaimer: {
    color: colors.textMuted, fontSize: 11, textAlign: 'center',
    marginTop: 10, lineHeight: 16, paddingHorizontal: 10,
  },

  // Done screen
  doneBadge: {
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radii.md, padding: spacing.lg, gap: 8,
    alignSelf: 'stretch',
  },
  doneTitle: { color: colors.text, fontSize: 20, fontWeight: '900' },
  doneSubtitle: { color: colors.textMuted, fontSize: 13 },

  // Focus Wall modal
  wallBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center', justifyContent: 'center',
    padding: spacing.lg,
  },
  wallCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.bg,
    borderWidth: 2, borderColor: LOCK_BLUE,
    borderRadius: radii.md, padding: spacing.lg,
    alignItems: 'center', gap: 12,
  },
  wallPulse: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: LOCK_BLUE + '22',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  wallTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  wallTimer: { color: LOCK_BLUE, fontSize: 42, fontWeight: '900', letterSpacing: -1 },
  wallSubtitle: { color: colors.textMuted, fontSize: 12, textAlign: 'center', marginBottom: 8 },
});
