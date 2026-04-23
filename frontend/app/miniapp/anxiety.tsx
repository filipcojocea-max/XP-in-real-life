import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radii } from '../../src/theme';

const ACCENT = '#FF3366';
type Mode = 'menu' | 'breathe' | 'ground';

export default function AnxietyCoach() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('menu');

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="anxiety-back"
          onPress={() => (mode === 'menu' ? router.back() : setMode('menu'))}
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>Library+</Text>
          <Text style={styles.title}>Anxiety Coach</Text>
        </View>
        <View style={styles.tag}>
          <Ionicons name="heart" size={14} color={ACCENT} />
        </View>
      </View>

      {mode === 'menu' ? <Menu onPick={setMode} /> : mode === 'breathe' ? <BoxBreathing /> : <Grounding />}
    </SafeAreaView>
  );
}

function Menu({ onPick }: { onPick: (m: Mode) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.menuWrap}>
      <Text style={styles.intro}>
        Two tools to calm your nervous system in under 3 minutes.
      </Text>
      <TouchableOpacity testID="anxiety-pick-breathe" style={styles.toolCard} onPress={() => onPick('breathe')}>
        <View style={[styles.toolIcon, { backgroundColor: ACCENT + '22', borderColor: ACCENT }]}>
          <Ionicons name="water" size={28} color={ACCENT} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.toolTitle}>Box Breathing</Text>
          <Text style={styles.toolDesc}>4-4-4-4 in · hold · out · hold · loops for 2 minutes.</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </TouchableOpacity>
      <TouchableOpacity testID="anxiety-pick-ground" style={styles.toolCard} onPress={() => onPick('ground')}>
        <View style={[styles.toolIcon, { backgroundColor: ACCENT + '22', borderColor: ACCENT }]}>
          <Ionicons name="leaf" size={28} color={ACCENT} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.toolTitle}>5-4-3-2-1 Grounding</Text>
          <Text style={styles.toolDesc}>Anchor to the present through your 5 senses.</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </TouchableOpacity>
    </ScrollView>
  );
}

function BoxBreathing() {
  const scale = useRef(new Animated.Value(0.6)).current;
  const [phase, setPhase] = useState<'in' | 'hold1' | 'out' | 'hold2'>('in');
  const [cycles, setCycles] = useState(0);
  const running = useRef(true);

  useEffect(() => {
    running.current = true;
    const run = () => {
      if (!running.current) return;
      setPhase('in');
      Animated.timing(scale, { toValue: 1.4, duration: 4000, useNativeDriver: true }).start(() => {
        if (!running.current) return;
        setPhase('hold1');
        setTimeout(() => {
          if (!running.current) return;
          setPhase('out');
          Animated.timing(scale, { toValue: 0.6, duration: 4000, useNativeDriver: true }).start(() => {
            if (!running.current) return;
            setPhase('hold2');
            setTimeout(() => {
              if (!running.current) return;
              setCycles((c) => c + 1);
              run();
            }, 4000);
          });
        }, 4000);
      });
    };
    run();
    return () => {
      running.current = false;
    };
  }, [scale]);

  const label =
    phase === 'in' ? 'Breathe In' :
    phase === 'out' ? 'Breathe Out' : 'Hold';

  return (
    <View style={styles.center}>
      <Animated.View
        testID="anxiety-breath-orb"
        style={[
          styles.orb,
          {
            transform: [{ scale }],
            backgroundColor: ACCENT + '33',
            borderColor: ACCENT,
            shadowColor: ACCENT,
          },
        ]}
      />
      <Text style={[styles.phaseLabel, { color: ACCENT }]}>{label}</Text>
      <Text style={styles.cycleLabel}>Cycle {cycles + 1}</Text>
    </View>
  );
}

function Grounding() {
  const prompts = [
    { n: 5, sense: 'see', icon: 'eye' },
    { n: 4, sense: 'hear', icon: 'ear' },
    { n: 3, sense: 'feel or touch', icon: 'hand-left' },
    { n: 2, sense: 'smell', icon: 'flower' },
    { n: 1, sense: 'taste', icon: 'restaurant' },
  ];
  const [idx, setIdx] = useState(0);
  const [entries, setEntries] = useState<string[][]>(prompts.map((p) => Array(p.n).fill('')));
  const done = idx >= prompts.length;
  const current = prompts[Math.min(idx, prompts.length - 1)];

  const updateEntry = (i: number, val: string) => {
    setEntries((all) => {
      const copy = all.map((arr) => [...arr]);
      copy[idx][i] = val;
      return copy;
    });
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 160 }}>
        {done ? (
          <View style={styles.doneBox}>
            <Ionicons name="checkmark-circle" size={64} color={ACCENT} />
            <Text style={styles.doneTitle}>Grounded.</Text>
            <Text style={styles.doneDesc}>You're present. Notice your breath, then return to your day.</Text>
            <TouchableOpacity testID="anxiety-ground-reset" style={[styles.primaryBtn, { backgroundColor: ACCENT }]} onPress={() => { setIdx(0); setEntries(prompts.map((p) => Array(p.n).fill(''))); }}>
              <Ionicons name="refresh" size={16} color={colors.bg} />
              <Text style={styles.primaryText}>Again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={[styles.toolIcon, { backgroundColor: ACCENT + '22', borderColor: ACCENT, alignSelf: 'center' }]}>
              <Ionicons name={current.icon as any} size={28} color={ACCENT} />
            </View>
            <Text style={styles.groundTitle}>{current.n} things you can {current.sense}</Text>
            {Array.from({ length: current.n }).map((_, i) => (
              <TextInput
                key={i}
                testID={`ground-input-${idx}-${i}`}
                value={entries[idx][i]}
                onChangeText={(t) => updateEntry(i, t)}
                placeholder={`#${i + 1}`}
                placeholderTextColor={colors.textMuted}
                style={styles.input}
              />
            ))}
            <TouchableOpacity testID="ground-next" style={[styles.primaryBtn, { backgroundColor: ACCENT }]} onPress={() => setIdx((i) => i + 1)}>
              <Text style={styles.primaryText}>{idx < prompts.length - 1 ? 'Next sense' : 'Finish'}</Text>
              <Ionicons name="arrow-forward" size={16} color={colors.bg} />
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surfaceGlass, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  kicker: { color: ACCENT, fontSize: 11, letterSpacing: 2, fontWeight: '800' },
  title: { color: colors.text, fontSize: 20, fontWeight: '900' },
  tag: { width: 36, height: 36, borderRadius: 18, backgroundColor: ACCENT + '22', borderWidth: 1, borderColor: ACCENT, alignItems: 'center', justifyContent: 'center' },

  menuWrap: { padding: spacing.md, gap: spacing.sm },
  intro: { color: colors.textSecondary, fontSize: 13, marginBottom: spacing.md, lineHeight: 19 },
  toolCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border },
  toolIcon: { width: 56, height: 56, borderRadius: 28, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  toolTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  toolDesc: { color: colors.textMuted, fontSize: 12, marginTop: 2, lineHeight: 16 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  orb: { width: 240, height: 240, borderRadius: 120, borderWidth: 2, shadowOpacity: 0.6, shadowRadius: 40 },
  phaseLabel: { fontSize: 26, fontWeight: '900', letterSpacing: 2, marginTop: spacing.xl },
  cycleLabel: { color: colors.textMuted, fontSize: 14, marginTop: spacing.sm },

  groundTitle: { color: colors.text, fontSize: 22, fontWeight: '900', textAlign: 'center', marginTop: spacing.md },
  input: { backgroundColor: colors.surfaceGlass, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: 12, color: colors.text, fontSize: 15, borderWidth: 1, borderColor: colors.border, marginTop: spacing.sm },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: radii.pill, marginTop: spacing.lg },
  primaryText: { color: colors.bg, fontWeight: '900', fontSize: 15 },

  doneBox: { alignItems: 'center', padding: spacing.xl },
  doneTitle: { color: colors.text, fontSize: 28, fontWeight: '900', marginTop: spacing.md },
  doneDesc: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', marginTop: spacing.sm, lineHeight: 20 },
});
