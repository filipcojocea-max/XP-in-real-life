import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Platform, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Haptics from 'expo-haptics';
import { api, SleepQuestion } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';

export default function SleepOnboarding() {
  const [questions, setQuestions] = useState<SleepQuestion[]>([]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showPicker, setShowPicker] = useState<{ field: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.sleepProfile();
        setQuestions(r.questions);
      } catch (e) {
        console.log('q load', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const q = questions[idx];
  const total = questions.length;
  const progress = total > 0 ? (idx + 1) / total : 0;
  const value = q ? answers[q.id] : undefined;

  const canNext = useMemo(() => {
    if (!q) return false;
    if (q.type === 'text') return true; // optional
    if (q.type === 'multi') return Array.isArray(value) && value.length > 0;
    return value !== undefined && value !== '' && value !== null;
  }, [q, value]);

  const setAnswer = (id: string, v: any) => {
    setAnswers((prev) => ({ ...prev, [id]: v }));
    Haptics.selectionAsync().catch(() => {});
  };

  const next = async () => {
    if (!canNext && q?.type !== 'text') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }
    if (idx < total - 1) {
      setIdx(idx + 1);
    } else {
      // finalize
      setSaving(true);
      try {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        await api.sleepOnboard(answers);
        router.replace('/sleep' as any);
      } catch (e: any) {
        Alert.alert('Failed to generate plan', String(e.message || e));
      } finally {
        setSaving(false);
      }
    }
  };

  const back = () => {
    if (idx > 0) setIdx(idx - 1);
    else router.back();
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}><ActivityIndicator size="large" color={colors.cyan} /></View>
      </SafeAreaView>
    );
  }

  if (!q) return null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={back} hitSlop={10}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.topTitle}>Sleep Coach Setup</Text>
          <Text style={styles.stepCount}>{idx + 1}/{total}</Text>
        </View>

        {/* Progress bar */}
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text testID="sleep-question" style={styles.question}>{q.q}</Text>

          {/* Scale */}
          {q.type === 'scale' ? (
            <View style={styles.scaleWrap}>
              <View style={styles.scaleLabels}>
                <Text style={styles.scaleLabelText}>{q.min}</Text>
                <Text style={styles.scaleLabelText}>{q.max}</Text>
              </View>
              <View style={styles.scaleRow}>
                {Array.from({ length: (q.max ?? 10) - (q.min ?? 1) + 1 }).map((_, i) => {
                  const v = (q.min ?? 1) + i;
                  const active = value === v;
                  return (
                    <TouchableOpacity
                      key={v}
                      testID={`sleep-scale-${q.id}-${v}`}
                      onPress={() => setAnswer(q.id, v)}
                      style={[styles.scaleBtn, active && styles.scaleBtnActive]}
                    >
                      <Text style={[styles.scaleBtnText, active && styles.scaleBtnTextActive]}>{v}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* Time */}
          {q.type === 'time' ? (
            <View>
              <TouchableOpacity
                style={styles.timeBtn}
                onPress={() => setShowPicker({ field: q.id })}
                testID={`sleep-time-${q.id}`}
              >
                <Ionicons name="time" size={18} color={colors.cyan} />
                <Text style={styles.timeBtnText}>{value ? value : 'Pick a time'}</Text>
              </TouchableOpacity>
              {showPicker?.field === q.id ? (
                <DateTimePicker
                  value={parseTime(value) || new Date()}
                  mode="time"
                  is24Hour={false}
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={(_, d) => {
                    if (Platform.OS !== 'ios') setShowPicker(null);
                    if (d) setAnswer(q.id, formatTime(d));
                  }}
                  themeVariant="dark"
                />
              ) : null}
            </View>
          ) : null}

          {/* Single choice */}
          {q.type === 'single' ? (
            <View style={styles.optionList}>
              {q.options?.map((opt) => {
                const active = value === opt;
                return (
                  <TouchableOpacity
                    key={opt}
                    testID={`sleep-opt-${q.id}-${slugify(opt)}`}
                    onPress={() => setAnswer(q.id, opt)}
                    style={[styles.option, active && styles.optionActive]}
                  >
                    <View style={[styles.optionRadio, active && { borderColor: colors.cyan, backgroundColor: colors.cyan }]}>
                      {active ? <Ionicons name="checkmark" size={14} color={colors.bg} /> : null}
                    </View>
                    <Text style={[styles.optionText, active && styles.optionTextActive]}>{opt}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}

          {/* Multi */}
          {q.type === 'multi' ? (
            <View style={styles.optionList}>
              {q.options?.map((opt) => {
                const arr: string[] = Array.isArray(value) ? value : [];
                const active = arr.includes(opt);
                return (
                  <TouchableOpacity
                    key={opt}
                    testID={`sleep-multi-${q.id}-${slugify(opt)}`}
                    onPress={() => {
                      const next = active ? arr.filter((x) => x !== opt) : [...arr, opt];
                      setAnswer(q.id, next);
                    }}
                    style={[styles.option, active && styles.optionActive]}
                  >
                    <View style={[styles.optionCheckbox, active && { borderColor: colors.cyan, backgroundColor: colors.cyan }]}>
                      {active ? <Ionicons name="checkmark" size={14} color={colors.bg} /> : null}
                    </View>
                    <Text style={[styles.optionText, active && styles.optionTextActive]}>{opt}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}

          {/* Free text */}
          {q.type === 'text' ? (
            <TextInput
              testID={`sleep-text-${q.id}`}
              value={value || ''}
              onChangeText={(t) => setAnswers((p) => ({ ...p, [q.id]: t }))}
              placeholder="Type your answer (optional)"
              placeholderTextColor={colors.textMuted}
              multiline
              style={styles.textInput}
            />
          ) : null}
        </ScrollView>

        {/* Bottom actions */}
        <View style={styles.bottomBar}>
          <TouchableOpacity
            testID="sleep-next"
            disabled={saving || (!canNext && q.type !== 'text')}
            onPress={next}
            style={[styles.nextBtn, (saving || (!canNext && q.type !== 'text')) && { opacity: 0.4 }]}
          >
            {saving ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <>
                <Text style={styles.nextText}>{idx === total - 1 ? 'Build my plan' : 'Continue'}</Text>
                <Ionicons name={idx === total - 1 ? 'sparkles' : 'arrow-forward'} size={16} color={colors.bg} />
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function parseTime(v?: string): Date | null {
  if (!v) return null;
  const m = v.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  const d = new Date();
  d.setHours(h, mm, 0, 0);
  return d;
}
function formatTime(d: Date): string {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  topTitle: { color: colors.text, fontSize: 16, fontWeight: '800', flex: 1 },
  stepCount: { color: colors.cyan, fontSize: 13, fontWeight: '900' },
  progressBar: {
    height: 4, backgroundColor: colors.surfaceGlass,
    marginHorizontal: spacing.md, borderRadius: 2, overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.cyan },
  scroll: { padding: spacing.md, paddingBottom: 120 },
  question: { color: colors.text, fontSize: 22, fontWeight: '800', lineHeight: 30, marginBottom: spacing.lg },

  scaleWrap: { marginTop: spacing.md },
  scaleLabels: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  scaleLabelText: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  scaleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'space-between' },
  scaleBtn: {
    flexBasis: '18%', minWidth: 50, aspectRatio: 1,
    borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceGlass,
  },
  scaleBtnActive: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  scaleBtnText: { color: colors.text, fontSize: 16, fontWeight: '900' },
  scaleBtnTextActive: { color: colors.bg },

  optionList: { gap: spacing.sm },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    padding: spacing.md, borderRadius: radii.md,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
  },
  optionActive: { borderColor: colors.cyan, backgroundColor: colors.cyan + '14' },
  optionRadio: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2,
    borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center',
  },
  optionCheckbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 2,
    borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center',
  },
  optionText: { color: colors.text, fontSize: 14, fontWeight: '700', flex: 1 },
  optionTextActive: { color: colors.cyan },

  timeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.md, borderRadius: radii.md,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.cyan + '55',
  },
  timeBtnText: { color: colors.cyan, fontSize: 16, fontWeight: '800' },

  textInput: {
    minHeight: 100, color: colors.text, fontSize: 15,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, padding: spacing.md, textAlignVertical: 'top',
  },

  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: spacing.md, backgroundColor: colors.bg,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  nextBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 16, borderRadius: radii.pill, backgroundColor: colors.cyan,
  },
  nextText: { color: colors.bg, fontSize: 15, fontWeight: '900', letterSpacing: 0.3 },
});
