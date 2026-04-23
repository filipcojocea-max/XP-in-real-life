import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import Ring from '../../src/components/Ring';
import { colors, spacing, radii } from '../../src/theme';

const ACCENT = '#00D9FF';
const STEPS = [
  { label: 'Stand up tall', sub: 'Feet shoulder width, weight even', duration: 10 },
  { label: 'Roll shoulders back', sub: 'Squeeze shoulder blades together', duration: 10 },
  { label: 'Lift your chest', sub: 'Crown of head up, ribs stacked', duration: 10 },
  { label: 'Tuck your chin', sub: 'Slight double-chin, neck long', duration: 10 },
  { label: 'Deep breath', sub: 'In through nose, out through mouth', duration: 10 },
  { label: 'Hold & scan', sub: 'Notice how your spine feels now', duration: 10 },
];

export default function PostureCoach() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [seconds, setSeconds] = useState(STEPS[0].duration);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!running) return;
    if (seconds <= 0) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      if (stepIdx >= STEPS.length - 1) {
        setRunning(false);
        setDone(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        return;
      }
      setStepIdx((i) => i + 1);
      setSeconds(STEPS[stepIdx + 1].duration);
      return;
    }
    const id = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [running, seconds, stepIdx]);

  const start = () => {
    setRunning(true);
    setStepIdx(0);
    setDone(false);
    setSeconds(STEPS[0].duration);
  };
  const reset = () => {
    setRunning(false);
    setDone(false);
    setStepIdx(0);
    setSeconds(STEPS[0].duration);
  };

  const step = STEPS[stepIdx];
  const totalSeconds = STEPS.reduce((s, x) => s + x.duration, 0);
  const elapsedBeforeStep = STEPS.slice(0, stepIdx).reduce((s, x) => s + x.duration, 0);
  const globalElapsed = elapsedBeforeStep + (step.duration - seconds);
  const globalProgress = globalElapsed / totalSeconds;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity testID="posture-back" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>Library+</Text>
          <Text style={styles.title}>Posture Coach</Text>
        </View>
        <View style={styles.tag}>
          <Ionicons name="body" size={14} color={ACCENT} />
        </View>
      </View>

      <View style={styles.body}>
        <Ring size={280} stroke={14} progress={done ? 1 : globalProgress} color={ACCENT}>
          {done ? (
            <>
              <Ionicons name="checkmark" size={72} color={ACCENT} />
              <Text style={[styles.ringLabel, { color: ACCENT }]}>RESET!</Text>
            </>
          ) : (
            <>
              <Text style={styles.countBig}>{seconds}</Text>
              <Text style={styles.ringLabel}>SEC</Text>
            </>
          )}
        </Ring>

        {!done ? (
          <View style={styles.stepBox}>
            <Text style={styles.stepNum}>Step {stepIdx + 1} of {STEPS.length}</Text>
            <Text style={styles.stepLabel}>{step.label}</Text>
            <Text style={styles.stepSub}>{step.sub}</Text>
          </View>
        ) : (
          <View style={styles.stepBox}>
            <Text style={[styles.stepLabel, { color: ACCENT }]}>60-second reset complete</Text>
            <Text style={styles.stepSub}>Set another reminder on your phone or tasks.</Text>
          </View>
        )}

        {!running && !done ? (
          <TouchableOpacity testID="posture-start" style={[styles.primary, { backgroundColor: ACCENT }]} onPress={start}>
            <Ionicons name="play" size={18} color={colors.bg} />
            <Text style={styles.primaryText}>Start 60-sec Reset</Text>
          </TouchableOpacity>
        ) : running ? (
          <TouchableOpacity testID="posture-skip" style={[styles.secondary]} onPress={() => setSeconds(0)}>
            <Ionicons name="play-skip-forward" size={16} color={ACCENT} />
            <Text style={[styles.secondaryText, { color: ACCENT }]}>Skip step</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity testID="posture-again" style={[styles.primary, { backgroundColor: ACCENT }]} onPress={reset}>
            <Ionicons name="refresh" size={18} color={colors.bg} />
            <Text style={styles.primaryText}>Again</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surfaceGlass, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  kicker: { color: ACCENT, fontSize: 11, letterSpacing: 2, fontWeight: '800' },
  title: { color: colors.text, fontSize: 20, fontWeight: '900' },
  tag: { width: 36, height: 36, borderRadius: 18, backgroundColor: ACCENT + '22', borderWidth: 1, borderColor: ACCENT, alignItems: 'center', justifyContent: 'center' },

  body: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  countBig: { color: colors.text, fontSize: 72, fontWeight: '900', letterSpacing: -2 },
  ringLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '800', letterSpacing: 3, marginTop: 4 },
  stepBox: { marginTop: spacing.xl, alignItems: 'center', paddingHorizontal: spacing.md },
  stepNum: { color: colors.textMuted, fontSize: 11, letterSpacing: 2, fontWeight: '800' },
  stepLabel: { color: colors.text, fontSize: 22, fontWeight: '900', marginTop: 6, textAlign: 'center' },
  stepSub: { color: colors.textSecondary, fontSize: 13, marginTop: 6, textAlign: 'center' },

  primary: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 16, paddingHorizontal: 32, borderRadius: radii.pill, marginTop: spacing.xl },
  primaryText: { color: colors.bg, fontSize: 15, fontWeight: '900' },
  secondary: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 24, borderRadius: radii.pill, borderWidth: 1, borderColor: ACCENT + '66', marginTop: spacing.xl },
  secondaryText: { fontWeight: '800', fontSize: 14 },
});
