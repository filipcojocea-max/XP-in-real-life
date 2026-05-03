/**
 * Focus Mode — adjustable countdown + "commit to avoiding" list + gamified
 * distraction penalty.
 *
 * Flow
 * ─────
 *  1. User picks a duration (quick-select chips 5/10/…/90, or scrolls to a
 *     custom minute count).
 *  2. User toggles which curated "distracting apps" they are committing to
 *     not open during the session. (Icons + name; purely a commitment /
 *     accountability device — we can't actually block other OS apps from
 *     an Expo sandbox.)
 *  3. Session starts → big countdown ring, green until time's up.
 *  4. If the user backgrounds the app we:
 *       - Fire a HIGH-PRIORITY local push ("You're losing focus!").
 *       - Accumulate `backgroundedSec` while the app is out of foreground.
 *       - When they return, show a full-screen "Focus Wall — Session in
 *         Progress" with the locked app gallery (grayed out + blue lock).
 *  5. Completion → bonus XP. Early exit with distraction → XP PENALTY
 *     of –2 XP per backgrounded minute (server-authoritative via
 *     POST /api/focus/session).
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

type Mode = 'idle' | 'running' | 'done';

const PRESETS = [5, 10, 15, 20, 25, 30, 45, 60, 90] as const;

// Curated distracting-app list. Icons use Ionicons for cross-platform
// consistency — they are visual commitment devices, not real app links.
const DISTRACTING_APPS: { id: string; label: string; icon: React.ComponentProps<typeof Ionicons>['name']; tint: string }[] = [
  { id: 'youtube',   label: 'YouTube',   icon: 'logo-youtube',   tint: '#FF0000' },
  { id: 'instagram', label: 'Instagram', icon: 'logo-instagram', tint: '#E1306C' },
  { id: 'tiktok',    label: 'TikTok',    icon: 'logo-tiktok',    tint: '#FFFFFF' },
  { id: 'twitter',   label: 'X',         icon: 'logo-twitter',   tint: '#1DA1F2' },
  { id: 'facebook',  label: 'Facebook',  icon: 'logo-facebook',  tint: '#1877F2' },
  { id: 'snapchat',  label: 'Snapchat',  icon: 'logo-snapchat',  tint: '#FFFC00' },
  { id: 'reddit',    label: 'Reddit',    icon: 'logo-reddit',    tint: '#FF4500' },
  { id: 'discord',   label: 'Discord',   icon: 'logo-discord',   tint: '#5865F2' },
  { id: 'whatsapp',  label: 'WhatsApp',  icon: 'logo-whatsapp',  tint: '#25D366' },
  { id: 'games',     label: 'Games',     icon: 'game-controller',tint: '#A855F7' },
  { id: 'netflix',   label: 'Netflix',   icon: 'film',           tint: '#E50914' },
  { id: 'music',     label: 'Spotify',   icon: 'musical-notes',  tint: '#1DB954' },
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

  // Background tracking (persists across the running state).
  const backgroundedSecRef = useRef<number>(0);
  const bgStartRef = useRef<number | null>(null);
  const appState = useRef<AppStateStatus>(AppState.currentState);

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

  // When duration picker changes while idle, reset the visible countdown.
  useEffect(() => {
    if (mode === 'idle') setSecondsLeft(plannedMin * 60);
  }, [plannedMin, mode]);

  // ── Countdown tick ──────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'running') return;
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          finishSession(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
    // finishSession captured via closure; keep deps narrow so the timer
    // doesn't restart on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── AppState tracking — the gamified "stay focused" detector ──────
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
      // User just left the app. Start counting background time and fire a
      // high-priority local notification as a nudge.
      bgStartRef.current = Date.now();
      fireFocusBreachNotification();
    } else if (prev === 'background' && next === 'active') {
      // User came back. Accumulate the background span, open the Focus
      // Wall so they see the commitment visually enforced.
      if (bgStartRef.current != null) {
        backgroundedSecRef.current += Math.floor((Date.now() - bgStartRef.current) / 1000);
        bgStartRef.current = null;
      }
      setShowWall(true);
    }
  }, [mode]);

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
      // Silent — notifications might be denied, not blocking.
      console.warn('[focus] notification fire failed', e);
    }
  };

  // ── Session lifecycle ──────────────────────────────────────────────
  const startSession = () => {
    backgroundedSecRef.current = 0;
    bgStartRef.current = null;
    setSecondsLeft(plannedMin * 60);
    setMode('running');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    // Pre-register the Android channel for the breach notification so
    // lock-screen priority is honoured in EAS builds.
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
    }
  };

  const finishSession = async (completed: boolean) => {
    const ran = plannedMin * 60 - secondsLeft;
    const bgSec = backgroundedSecRef.current;
    // Flush an in-progress background span if we're finishing mid-flight.
    const finalBgSec = bgStartRef.current != null
      ? bgSec + Math.floor((Date.now() - bgStartRef.current) / 1000)
      : bgSec;
    bgStartRef.current = null;
    setMode(completed ? 'done' : 'done');
    setShowWall(false);
    if (completed) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
    // Call backend to apply XP delta.
    try {
      const r = await api.focusSession({
        planned_minutes: plannedMin,
        actual_seconds: ran,
        backgrounded_seconds: finalBgSec,
        completed,
        committed_app_count: committed.size,
      });
      setXpSummary({ delta: r.xp_delta, reason: r.reason });
    } catch (e: any) {
      // Still show local summary even if XP save failed.
      setXpSummary({ delta: 0, reason: 'save_failed' });
    }
  };

  const cancelSession = () => {
    // Give the user one chance to confirm — most "cancel" taps are
    // accidental. If they confirm, we still apply the background-time
    // penalty (if any) so leaving early doesn't come for free.
    showAlert(
      'End Focus Session?',
      'You\'ll lose your completion bonus. Any background time is still penalized.',
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
                  : `${delta} XP — distracted for ${Math.round(backgroundedSecRef.current / 60)} min`}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.startBtn}
            onPress={() => {
              setMode('idle');
              setXpSummary(null);
              setSecondsLeft(plannedMin * 60);
              backgroundedSecRef.current = 0;
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
            <Text style={styles.disclaimer}>
              Leaving the app during a session costs −2 XP per minute. Completing earns a bonus.
            </Text>
          </>
        ) : (
          <>
            {/* RUNNING state: show locked-app wall */}
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
              You lost −2 XP per minute while away. Stay put.
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
