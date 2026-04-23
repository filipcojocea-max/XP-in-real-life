import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import Ring from '../../src/components/Ring';
import { colors, spacing, radii } from '../../src/theme';

const ACCENT = '#00FF88';
const CHOICES = [30, 60, 90, 120, 180];

export default function ColdShowerTimer() {
  const router = useRouter();
  const [duration, setDuration] = useState(60);
  const [seconds, setSeconds] = useState(60);
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState(0);

  useEffect(() => {
    if (!running) return;
    if (seconds <= 0) {
      setRunning(false);
      setCompleted((c) => c + 1);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      return;
    }
    const id = setTimeout(() => {
      setSeconds((s) => {
        const next = s - 1;
        // Haptic pulse every 10 sec
        if (next > 0 && next % 10 === 0) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        }
        return next;
      });
    }, 1000);
    return () => clearTimeout(id);
  }, [running, seconds]);

  const start = () => {
    setSeconds(duration);
    setRunning(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
  };
  const stop = () => {
    setRunning(false);
    setSeconds(duration);
  };
  const onChoose = (n: number) => {
    if (running) return;
    setDuration(n);
    setSeconds(n);
  };

  const progress = duration === 0 ? 0 : (duration - seconds) / duration;

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity testID="cold-back" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>Library+</Text>
          <Text style={styles.title}>Cold Shower Timer</Text>
        </View>
        <View style={styles.tag}>
          <Ionicons name="snow" size={14} color={ACCENT} />
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.chips}>
          {CHOICES.map((n) => (
            <TouchableOpacity
              key={n}
              testID={`cold-choice-${n}`}
              disabled={running}
              onPress={() => onChoose(n)}
              style={[
                styles.chip,
                duration === n && { backgroundColor: ACCENT, borderColor: ACCENT },
                running && { opacity: 0.4 },
              ]}
            >
              <Text style={[styles.chipText, duration === n && { color: colors.bg }]}>{n}s</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.ringWrap}>
          <Ring size={280} stroke={14} progress={progress} color={ACCENT}>
            <Text style={styles.time}>{mm}:{ss}</Text>
            <Text style={styles.timeLabel}>{running ? 'COLD' : 'READY'}</Text>
          </Ring>
        </View>

        {!running ? (
          <TouchableOpacity testID="cold-start" style={[styles.primary, { backgroundColor: ACCENT }]} onPress={start}>
            <Ionicons name="snow" size={18} color={colors.bg} />
            <Text style={styles.primaryText}>Turn It On ❄</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity testID="cold-stop" style={[styles.secondary]} onPress={stop}>
            <Ionicons name="stop" size={16} color={colors.red} />
            <Text style={[styles.secondaryText, { color: colors.red }]}>Stop</Text>
          </TouchableOpacity>
        )}

        <View style={styles.counterBox}>
          <Ionicons name="trophy" size={16} color={ACCENT} />
          <Text style={styles.counterText} testID="cold-count">
            {completed} completed this session
          </Text>
        </View>
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

  body: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.md },
  chips: { flexDirection: 'row', gap: 8, marginTop: spacing.md, flexWrap: 'wrap', justifyContent: 'center' },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceGlass },
  chipText: { color: colors.text, fontWeight: '800', fontSize: 13 },
  ringWrap: { marginVertical: spacing.xl },
  time: { color: colors.text, fontSize: 56, fontWeight: '900', letterSpacing: -2 },
  timeLabel: { color: ACCENT, fontSize: 12, fontWeight: '800', letterSpacing: 3 },

  primary: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 16, paddingHorizontal: 32, borderRadius: radii.pill },
  primaryText: { color: colors.bg, fontSize: 15, fontWeight: '900' },
  secondary: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 24, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.red + '88' },
  secondaryText: { fontWeight: '800', fontSize: 14 },

  counterBox: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.xl, paddingVertical: 10, paddingHorizontal: 16, borderRadius: radii.pill, backgroundColor: ACCENT + '15', borderWidth: 1, borderColor: ACCENT + '55' },
  counterText: { color: ACCENT, fontSize: 12, fontWeight: '700' },
});
