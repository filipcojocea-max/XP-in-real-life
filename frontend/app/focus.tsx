import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Alert,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import Ring from '../src/components/Ring';
import { colors, spacing, radii } from '../src/theme';

type Mode = 'idle' | 'running' | 'done' | 'challenge';
const DURATION_SEC = 5 * 60; // 5 min
const PUSHUP_GOAL = 20;
const BREATH_CYCLES = 4;

export default function Focus() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('idle');
  const [secondsLeft, setSecondsLeft] = useState(DURATION_SEC);
  const [challenge, setChallenge] = useState<'pushups' | 'breathing' | null>(null);

  // Pushups
  const [pushupCount, setPushupCount] = useState(0);

  // Breathing
  const [breathCycle, setBreathCycle] = useState(0);
  const [breathPhase, setBreathPhase] = useState<'in' | 'hold' | 'out'>('in');
  const breathScale = useRef(new Animated.Value(0.6)).current;

  // Timer
  useEffect(() => {
    if (mode !== 'running') return;
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          setMode('done');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [mode]);

  // Breathing animation
  useEffect(() => {
    if (challenge !== 'breathing') return;
    const loop = () => {
      setBreathPhase('in');
      Animated.timing(breathScale, { toValue: 1.4, duration: 4000, useNativeDriver: true }).start(() => {
        setBreathPhase('hold');
        setTimeout(() => {
          setBreathPhase('out');
          Animated.timing(breathScale, { toValue: 0.6, duration: 4000, useNativeDriver: true }).start(() => {
            setBreathCycle((c) => {
              const next = c + 1;
              if (next >= BREATH_CYCLES) {
                setMode('idle');
                setChallenge(null);
                setSecondsLeft(DURATION_SEC);
                Alert.alert('Challenge complete', 'You earned your unlock. Stay focused.');
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                return 0;
              } else {
                loop();
                return next;
              }
            });
          });
        }, 2000);
      });
    };
    loop();
  }, [challenge, breathScale]);

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  const progress = (DURATION_SEC - secondsLeft) / DURATION_SEC;

  const [challengePicker, setChallengePicker] = useState(false);

  const startTimer = () => {
    setSecondsLeft(DURATION_SEC);
    setMode('running');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  };

  const tryExit = () => {
    if (mode === 'running') {
      setChallengePicker(true);
    } else {
      router.back();
    }
  };

  if (challenge === 'pushups') {
    const pct = pushupCount / PUSHUP_GOAL;
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.challengeWrap}>
          <Text style={styles.challengeKicker}>Unlock Challenge</Text>
          <Text style={styles.challengeTitle}>Push-ups</Text>

          <Ring size={260} stroke={16} progress={pct} color={colors.green}>
            <Text style={styles.countBig} testID="pushup-count">{pushupCount}</Text>
            <Text style={styles.countSub}>/ {PUSHUP_GOAL}</Text>
          </Ring>

          <Text style={styles.challengeDesc}>Tap after each push-up.</Text>

          <TouchableOpacity
            testID="pushup-tap"
            style={styles.bigGreenBtn}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
              const next = Math.min(PUSHUP_GOAL, pushupCount + 1);
              setPushupCount(next);
              if (next >= PUSHUP_GOAL) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                setTimeout(() => {
                  setChallenge(null);
                  setMode('idle');
                  setSecondsLeft(DURATION_SEC);
                  Alert.alert('Challenge complete', 'You earned your unlock.');
                }, 400);
              }
            }}
          >
            <Ionicons name="add" size={28} color={colors.bg} />
            <Text style={styles.bigGreenText}>TAP</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setChallenge(null)} style={styles.cancelChallenge}>
            <Text style={styles.cancelChallengeText}>Back to Timer</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (challenge === 'breathing') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.challengeWrap}>
          <Text style={styles.challengeKicker}>Unlock Challenge</Text>
          <Text style={styles.challengeTitle}>Breathe</Text>

          <Animated.View
            testID="breath-orb"
            style={[
              styles.breathOrb,
              {
                transform: [{ scale: breathScale }],
                shadowColor: colors.cyan,
                shadowOpacity: 0.6,
                shadowRadius: 40,
              },
            ]}
          />
          <Text style={styles.breathPhase}>
            {breathPhase === 'in' ? 'Breathe In' : breathPhase === 'out' ? 'Breathe Out' : 'Hold'}
          </Text>
          <Text style={styles.breathCycle}>Cycle {breathCycle + 1} / {BREATH_CYCLES}</Text>

          <TouchableOpacity onPress={() => setChallenge(null)} style={styles.cancelChallenge}>
            <Text style={styles.cancelChallengeText}>Back to Timer</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.closeRow}>
        <TouchableOpacity testID="focus-close" onPress={tryExit} style={styles.closeBtn}>
          <Ionicons name="close" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.content}>
        <Text style={styles.kicker}>Focus Mode</Text>
        <Text style={styles.title}>Lock In</Text>

        <View style={{ marginVertical: spacing.xl }}>
          <Ring size={280} stroke={14} progress={mode === 'running' ? progress : mode === 'done' ? 1 : 0} color={colors.cyan}>
            <Text style={styles.timerMm} testID="focus-timer">{mm}:{ss}</Text>
            <Text style={styles.timerLabel}>
              {mode === 'idle' ? 'READY' : mode === 'running' ? 'FOCUSED' : 'COMPLETE'}
            </Text>
          </Ring>
        </View>

        {mode === 'idle' ? (
          <>
            <Text style={styles.desc}>
              Stay focused for 5 minutes. Exiting early requires a quick physical challenge.
            </Text>
            <TouchableOpacity testID="focus-start" style={styles.startBtn} onPress={startTimer}>
              <Ionicons name="lock-closed" size={18} color={colors.bg} />
              <Text style={styles.startText}>Start Focus Session</Text>
            </TouchableOpacity>
          </>
        ) : mode === 'running' ? (
          <>
            <Text style={styles.desc}>Don't break the streak. Stay in the zone.</Text>
            <TouchableOpacity testID="focus-escape" style={styles.escapeBtn} onPress={tryExit}>
              <Text style={styles.escapeText}>Exit Early (Challenge)</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={styles.victoryBadge}>
              <Ionicons name="checkmark-circle" size={24} color={colors.green} />
              <Text style={styles.victoryText}>Session Complete</Text>
            </View>
            <TouchableOpacity style={styles.startBtn} onPress={() => router.back()}>
              <Text style={styles.startText}>Done</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  closeRow: { flexDirection: 'row', justifyContent: 'flex-end', padding: spacing.md },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceGlass,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  content: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.lg },
  kicker: { color: colors.cyan, fontSize: 12, letterSpacing: 3, fontWeight: '800' },
  title: { color: colors.text, fontSize: 34, fontWeight: '900', marginTop: 4, letterSpacing: -0.5 },
  timerMm: { color: colors.text, fontSize: 56, fontWeight: '900', letterSpacing: -2 },
  timerLabel: { color: colors.cyan, fontSize: 12, letterSpacing: 3, fontWeight: '800', marginTop: 4 },
  desc: { color: colors.textSecondary, textAlign: 'center', fontSize: 14, lineHeight: 20, marginBottom: spacing.lg },

  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.green,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: radii.pill,
    shadowColor: colors.green,
    shadowOpacity: 0.6,
    shadowRadius: 16,
  },
  startText: { color: colors.bg, fontSize: 15, fontWeight: '900', letterSpacing: 0.5 },
  escapeBtn: {
    marginTop: spacing.md,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.red + '88',
  },
  escapeText: { color: colors.red, fontWeight: '700' },

  victoryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.green + '22',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.green,
    marginBottom: spacing.md,
  },
  victoryText: { color: colors.green, fontWeight: '800' },

  challengeWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  challengeKicker: { color: colors.amber, fontSize: 12, letterSpacing: 3, fontWeight: '800' },
  challengeTitle: { color: colors.text, fontSize: 32, fontWeight: '900', marginTop: 4, marginBottom: spacing.lg },
  challengeDesc: { color: colors.textSecondary, marginTop: spacing.md },
  countBig: { color: colors.text, fontSize: 72, fontWeight: '900', letterSpacing: -2 },
  countSub: { color: colors.textMuted, fontSize: 16, fontWeight: '700' },
  bigGreenBtn: {
    marginTop: spacing.xl,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.green,
    shadowOpacity: 0.7,
    shadowRadius: 30,
  },
  bigGreenText: { color: colors.bg, fontSize: 22, fontWeight: '900', letterSpacing: 2 },

  breathOrb: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: colors.cyan + '55',
    borderWidth: 2,
    borderColor: colors.cyan,
    marginVertical: spacing.xl,
  },
  breathPhase: { color: colors.cyan, fontSize: 22, fontWeight: '800', letterSpacing: 2 },
  breathCycle: { color: colors.textMuted, fontSize: 14, marginTop: spacing.sm },

  cancelChallenge: { marginTop: spacing.xl, padding: spacing.md },
  cancelChallengeText: { color: colors.textMuted, fontSize: 13 },

  pickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  pickerSheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pickerTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  pickerDesc: { color: colors.textSecondary, fontSize: 13, marginTop: 6, marginBottom: spacing.lg },
  pickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
    borderRadius: radii.pill,
    marginBottom: spacing.sm,
  },
  pickerCancel: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.sm,
  },
  pickerBtnText: { color: colors.bg, fontSize: 15, fontWeight: '800' },
});
