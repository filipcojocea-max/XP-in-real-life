import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Platform, KeyboardAvoidingView, Modal, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
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
    if (q.type === 'multi_other') {
      const arr = Array.isArray(value) ? value : [];
      if (arr.length === 0) return false;
      // If "Other" is selected, require the free-text input
      const otherKey = (q as any).other_field || `${q.id}_other`;
      const otherOpt = (q as any).other_option || 'Other';
      if (arr.includes(otherOpt)) {
        const txt = String(answers[otherKey] || '').trim();
        return txt.length > 0;
      }
      return true;
    }
    return value !== undefined && value !== '' && value !== null;
  }, [q, value, answers]);

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
                <Text style={styles.timeBtnText}>{value ? value : 'Tap to pick a time'}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.cyan} />
              </TouchableOpacity>
              <Text style={styles.timeHint}>Tap above to choose your usual {q.id === 'bedtime' ? 'bedtime' : 'wake-up time'}.</Text>
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

          {/* Multi with optional "Other" free-text */}
          {q.type === 'multi_other' ? (() => {
            const otherOpt = (q as any).other_option || 'Other';
            const otherKey = (q as any).other_field || `${q.id}_other`;
            const arr: string[] = Array.isArray(value) ? value : [];
            const otherSelected = arr.includes(otherOpt);
            return (
              <View style={styles.optionList}>
                {q.options?.map((opt) => {
                  const active = arr.includes(opt);
                  return (
                    <TouchableOpacity
                      key={opt}
                      testID={`sleep-multi-${q.id}-${slugify(opt)}`}
                      onPress={() => {
                        const next = active ? arr.filter((x) => x !== opt) : [...arr, opt];
                        setAnswer(q.id, next);
                        // Clear other text if user deselects "Other"
                        if (opt === otherOpt && active) {
                          setAnswers((p) => ({ ...p, [otherKey]: '' }));
                        }
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
                {otherSelected ? (
                  <TextInput
                    testID={`sleep-multi-other-input-${q.id}`}
                    value={answers[otherKey] || ''}
                    onChangeText={(t) => setAnswers((p) => ({ ...p, [otherKey]: t }))}
                    placeholder="Type your answer..."
                    placeholderTextColor={colors.textMuted}
                    style={styles.textInput}
                    autoFocus
                  />
                ) : null}
              </View>
            );
          })() : null}

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

        {/* Cross-platform Time Picker Modal */}
        <SimpleTimePickerModal
          visible={!!showPicker}
          initial={value}
          onClose={() => setShowPicker(null)}
          onConfirm={(t) => {
            if (showPicker) setAnswer(showPicker.field, t);
            setShowPicker(null);
          }}
        />

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
function parseTime(v?: any): { h: number; m: number; ampm: 'AM' | 'PM' } {
  if (typeof v === 'string') {
    const m = v.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      let ampm = (m[3] || '').toUpperCase() as 'AM' | 'PM';
      if (!ampm) {
        ampm = h >= 12 ? 'PM' : 'AM';
        if (h > 12) h -= 12;
        if (h === 0) h = 12;
      }
      return { h: h === 0 ? 12 : h, m: mm, ampm };
    }
  }
  return { h: 10, m: 0, ampm: 'PM' };
}
function fmt(h: number, m: number, ampm: 'AM' | 'PM'): string {
  const mm = String(m).padStart(2, '0');
  return `${h}:${mm} ${ampm}`;
}

// ───────── Cross-platform time picker ─────────
function SimpleTimePickerModal({
  visible, initial, onClose, onConfirm,
}: {
  visible: boolean;
  initial?: string;
  onClose: () => void;
  onConfirm: (formatted: string) => void;
}) {
  const init = parseTime(initial);
  const [h, setH] = useState<number>(init.h);
  const [m, setM] = useState<number>(init.m);
  const [ampm, setAmpm] = useState<'AM' | 'PM'>(init.ampm);

  useEffect(() => {
    if (visible) {
      const v = parseTime(initial);
      setH(v.h);
      setM(v.m);
      setAmpm(v.ampm);
    }
  }, [visible, initial]);

  const bump = (which: 'h' | 'm', delta: number) => {
    Haptics.selectionAsync().catch(() => {});
    if (which === 'h') {
      setH((prev) => {
        const n = prev + delta;
        if (n < 1) return 12;
        if (n > 12) return 1;
        return n;
      });
    } else {
      setM((prev) => {
        const n = prev + delta;
        if (n < 0) return 55;
        if (n > 59) return 0;
        return n;
      });
    }
  };

  const presets = [
    { label: '9:30 PM', h: 9, m: 30, ampm: 'PM' as const },
    { label: '10:00 PM', h: 10, m: 0, ampm: 'PM' as const },
    { label: '10:30 PM', h: 10, m: 30, ampm: 'PM' as const },
    { label: '11:00 PM', h: 11, m: 0, ampm: 'PM' as const },
    { label: '11:30 PM', h: 11, m: 30, ampm: 'PM' as const },
    { label: '12:00 AM', h: 12, m: 0, ampm: 'AM' as const },
    { label: '6:00 AM', h: 6, m: 0, ampm: 'AM' as const },
    { label: '6:30 AM', h: 6, m: 30, ampm: 'AM' as const },
    { label: '7:00 AM', h: 7, m: 0, ampm: 'AM' as const },
    { label: '7:30 AM', h: 7, m: 30, ampm: 'AM' as const },
    { label: '8:00 AM', h: 8, m: 0, ampm: 'AM' as const },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.timeBackdrop} onPress={onClose}>
        <Pressable style={styles.timeSheet} onPress={() => {}}>
          <View style={styles.sheetHandle} />
          <Text style={styles.timeTitle}>Pick a time</Text>

          {/* Big preview */}
          <View style={styles.timePreviewWrap}>
            <Text style={styles.timePreview}>
              {String(h)}:<Text style={styles.timePreviewMin}>{String(m).padStart(2, '0')}</Text>
            </Text>
            <View style={styles.ampmCol}>
              <TouchableOpacity
                onPress={() => { setAmpm('AM'); Haptics.selectionAsync().catch(() => {}); }}
                style={[styles.ampmBtn, ampm === 'AM' && styles.ampmBtnActive]}
                testID="time-ampm-am"
              >
                <Text style={[styles.ampmText, ampm === 'AM' && styles.ampmTextActive]}>AM</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setAmpm('PM'); Haptics.selectionAsync().catch(() => {}); }}
                style={[styles.ampmBtn, ampm === 'PM' && styles.ampmBtnActive]}
                testID="time-ampm-pm"
              >
                <Text style={[styles.ampmText, ampm === 'PM' && styles.ampmTextActive]}>PM</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Bumper rows */}
          <View style={styles.bumperRow}>
            <View style={styles.bumperCol}>
              <Text style={styles.bumperLabel}>HOUR</Text>
              <View style={styles.bumperGroup}>
                <TouchableOpacity testID="time-h-down" onPress={() => bump('h', -1)} style={styles.bumperBtn}>
                  <Ionicons name="remove" size={22} color={colors.cyan} />
                </TouchableOpacity>
                <Text style={styles.bumperValue}>{h}</Text>
                <TouchableOpacity testID="time-h-up" onPress={() => bump('h', 1)} style={styles.bumperBtn}>
                  <Ionicons name="add" size={22} color={colors.cyan} />
                </TouchableOpacity>
              </View>
            </View>
            <View style={styles.bumperCol}>
              <Text style={styles.bumperLabel}>MIN</Text>
              <View style={styles.bumperGroup}>
                <TouchableOpacity testID="time-m-down" onPress={() => bump('m', -5)} style={styles.bumperBtn}>
                  <Ionicons name="remove" size={22} color={colors.cyan} />
                </TouchableOpacity>
                <Text style={styles.bumperValue}>{String(m).padStart(2, '0')}</Text>
                <TouchableOpacity testID="time-m-up" onPress={() => bump('m', 5)} style={styles.bumperBtn}>
                  <Ionicons name="add" size={22} color={colors.cyan} />
                </TouchableOpacity>
              </View>
            </View>
          </View>

          {/* Quick presets */}
          <Text style={styles.bumperLabel}>QUICK PICKS</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
            {presets.map((p) => {
              const active = h === p.h && m === p.m && ampm === p.ampm;
              return (
                <TouchableOpacity
                  key={p.label}
                  testID={`time-preset-${slugify(p.label)}`}
                  onPress={() => { setH(p.h); setM(p.m); setAmpm(p.ampm); Haptics.selectionAsync().catch(() => {}); }}
                  style={[styles.presetChip, active && styles.presetChipActive]}
                >
                  <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{p.label}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Actions */}
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
            <TouchableOpacity onPress={onClose} style={[styles.timeActionBtn, styles.timeCancelBtn]}>
              <Text style={styles.timeCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="time-confirm"
              onPress={() => {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                onConfirm(fmt(h, m, ampm));
              }}
              style={[styles.timeActionBtn, styles.timeConfirmBtn]}
            >
              <Ionicons name="checkmark" size={18} color={colors.bg} />
              <Text style={styles.timeConfirmText}>Use {fmt(h, m, ampm)}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
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
  timeBtnText: { color: colors.cyan, fontSize: 16, fontWeight: '800', flex: 1 },
  timeHint: {
    color: colors.textMuted, fontSize: 11, marginTop: 6, marginLeft: 4,
  },

  // ── Time picker modal ──
  timeBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end',
  },
  timeSheet: {
    backgroundColor: colors.surface, padding: spacing.lg, paddingBottom: spacing.xxl,
    borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg,
    borderTopWidth: 1, borderColor: colors.border,
  },
  sheetHandle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.borderStrong, marginBottom: spacing.md,
  },
  timeTitle: {
    color: colors.text, fontSize: 20, fontWeight: '900', marginBottom: spacing.sm, textAlign: 'center',
  },
  timePreviewWrap: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: spacing.md, marginVertical: spacing.md,
  },
  timePreview: {
    color: colors.cyan, fontSize: 56, fontWeight: '900', letterSpacing: -2,
    fontVariant: ['tabular-nums'],
  },
  timePreviewMin: { color: colors.text, fontSize: 56, fontWeight: '900' },
  ampmCol: { gap: 6 },
  ampmBtn: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceGlass,
    minWidth: 50, alignItems: 'center',
  },
  ampmBtnActive: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  ampmText: { color: colors.textSecondary, fontSize: 13, fontWeight: '900' },
  ampmTextActive: { color: colors.bg },

  bumperRow: {
    flexDirection: 'row', justifyContent: 'space-around',
    marginVertical: spacing.md, gap: spacing.md,
  },
  bumperCol: { flex: 1, alignItems: 'center' },
  bumperLabel: {
    color: colors.textMuted, fontSize: 10, fontWeight: '900',
    letterSpacing: 1.5, marginBottom: 6,
  },
  bumperGroup: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, paddingHorizontal: spacing.sm,
  },
  bumperBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  bumperValue: {
    color: colors.text, fontSize: 22, fontWeight: '900',
    minWidth: 40, textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },

  presetChip: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
  },
  presetChipActive: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  presetChipText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  presetChipTextActive: { color: colors.bg, fontWeight: '900' },

  timeActionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 14, borderRadius: radii.pill,
  },
  timeCancelBtn: { backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border },
  timeCancelText: { color: colors.textSecondary, fontWeight: '700' },
  timeConfirmBtn: { backgroundColor: colors.cyan },
  timeConfirmText: { color: colors.bg, fontWeight: '900', fontSize: 13 },

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
