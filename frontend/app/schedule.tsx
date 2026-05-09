/**
 * Adaptive Work-Life Scheduler — Profile sub-screen.
 *
 * Builder for the rotating shift pattern (Day / Night / Off), per-shift
 * wake-up + sleep times, custom emoji + outline color, and a live
 * 14-day calendar preview that supports manual overrides per date.
 *
 * When the master toggle is ON, the backend uses the computed shift
 * boundaries to drive daily resets (tasks, goals, challenges) and to
 * silence push notifications during sleep windows. The 15 XP/min focus
 * penalty cutoff also follows these boundaries.
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Switch,
  TextInput,
  ActivityIndicator,
  Modal,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, type ShiftSchedule, type ShiftType, type ScheduleDay } from '../src/api';
import { colors, spacing, radii } from '../src/theme';
import { showAlert, showConfirm } from '../src/uiAlert';

const SHIFT_ORDER: ShiftType[] = ['day', 'night', 'off'];
const SHIFT_LABEL: Record<ShiftType, string> = { day: 'Day', night: 'Night', off: 'Off' };
const EMOJI_PRESETS: Record<ShiftType, string[]> = {
  day: ['🌅', '🌄', '☀️', '🏢', '🚗', '🏗️', '🛠️'],
  night: ['🌃', '🌙', '🦉', '⭐', '🛌', '🌌'],
  off: ['☕', '🛋️', '🏡', '🍿', '🏖️', '🎮', '😎'],
};
const PRESET_COLORS = [
  '#FFA726', '#F97316', '#FF7043', '#EF4444',
  '#1E3A8A', '#3B82F6', '#0EA5E9', '#06B6D4',
  '#22C55E', '#10B981', '#84CC16', '#A3E635',
  '#A855F7', '#D946EF', '#EC4899', '#F472B6',
  '#FFFFFF', '#9CA3AF', '#374151', '#000000',
];

export default function ScheduleScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [schedule, setSchedule] = useState<ShiftSchedule | null>(null);
  const [preview, setPreview] = useState<ScheduleDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editorFor, setEditorFor] = useState<ShiftType | null>(null);
  const [overrideFor, setOverrideFor] = useState<ScheduleDay | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.scheduleGet();
      setSchedule(r.schedule);
      const p = await api.schedulePreview(14);
      setPreview(p.days);
    } catch (e: any) {
      showAlert('Could not load schedule', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const persist = useCallback(async (next: Partial<ShiftSchedule>) => {
    setSaving(true);
    try {
      const r = await api.schedulePut(next);
      setSchedule(r.schedule);
      const p = await api.schedulePreview(14);
      setPreview(p.days);
    } catch (e: any) {
      showAlert('Save failed', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }, []);

  const toggleEnabled = useCallback((v: boolean) => {
    Haptics.selectionAsync().catch(() => {});
    persist({ enabled: v });
  }, [persist]);

  const addToPattern = useCallback((shift: ShiftType) => {
    if (!schedule) return;
    Haptics.selectionAsync().catch(() => {});
    persist({ pattern: [...schedule.pattern, shift] });
  }, [schedule, persist]);

  const removeFromPattern = useCallback((idx: number) => {
    if (!schedule) return;
    const next = schedule.pattern.slice();
    next.splice(idx, 1);
    persist({ pattern: next });
  }, [schedule, persist]);

  const cyclePatternEntry = useCallback((idx: number) => {
    if (!schedule) return;
    const next = schedule.pattern.slice();
    const cur = next[idx];
    const ci = SHIFT_ORDER.indexOf(cur);
    next[idx] = SHIFT_ORDER[(ci + 1) % SHIFT_ORDER.length];
    persist({ pattern: next });
  }, [schedule, persist]);

  const onResetAll = useCallback(() => {
    showConfirm({
      title: 'Reset schedule?',
      message: 'This wipes the rotating pattern, all manual overrides, and resets icons/colors to defaults. Your master toggle will turn OFF too.',
      confirmText: 'Reset',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.scheduleReset();
          await load();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        } catch (e: any) {
          showAlert('Reset failed', String(e?.message || e));
        }
      },
    });
  }, [load]);

  const setOverride = useCallback(async (date_iso: string, shift: ShiftType | null) => {
    try {
      await api.scheduleDayOverride(date_iso, shift);
      const p = await api.schedulePreview(14);
      setPreview(p.days);
    } catch (e: any) {
      showAlert('Override failed', String(e?.message || e));
    } finally {
      setOverrideFor(null);
    }
  }, []);

  if (loading || !schedule) {
    return (
      <SafeAreaView style={styles.root}>
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Adaptive Work-Life Scheduler</Text>
          <Text style={styles.subtitle}>Override the static "Start Day" with your rotating shift pattern.</Text>
        </View>
        {saving ? <ActivityIndicator color={colors.cyan} size="small" /> : null}
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
        {/* Master toggle */}
        <View style={[styles.card, { borderColor: schedule.enabled ? colors.green + '88' : colors.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>Master Toggle</Text>
            <Text style={styles.cardSub}>
              {schedule.enabled
                ? 'Active — daily resets follow your pattern.'
                : 'Off — app uses the default "Start Day" time.'}
            </Text>
          </View>
          <Switch
            testID="schedule-master-toggle"
            value={schedule.enabled}
            onValueChange={toggleEnabled}
            trackColor={{ false: '#333', true: colors.green + '88' }}
            thumbColor={schedule.enabled ? colors.green : '#999'}
          />
        </View>

        {/* Pattern builder */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Pattern</Text>
          <Text style={styles.cardSub}>Tap a chip to cycle Day → Night → Off · long-press to remove.</Text>
          <View style={styles.patternRow}>
            {schedule.pattern.length === 0 ? (
              <Text style={styles.emptyHint}>No pattern yet. Tap +Day, +Night, or +Off below to start.</Text>
            ) : (
              schedule.pattern.map((s, i) => {
                const def = schedule.shifts[s];
                return (
                  <TouchableOpacity
                    key={`${i}-${s}`}
                    style={[styles.patternChip, { borderColor: def.color }]}
                    onPress={() => cyclePatternEntry(i)}
                    onLongPress={() => removeFromPattern(i)}
                    activeOpacity={0.7}
                    testID={`pattern-chip-${i}`}
                  >
                    <Text style={styles.patternEmoji}>{def.icon}</Text>
                    <Text style={[styles.patternText, { color: def.color }]}>{SHIFT_LABEL[s]}</Text>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
          <View style={styles.addRow}>
            {SHIFT_ORDER.map((s) => (
              <TouchableOpacity
                key={s}
                style={[styles.addBtn, { borderColor: schedule.shifts[s].color + 'AA' }]}
                onPress={() => addToPattern(s)}
                activeOpacity={0.85}
                testID={`pattern-add-${s}`}
              >
                <Text style={{ fontSize: 14 }}>{schedule.shifts[s].icon}</Text>
                <Text style={[styles.addBtnText, { color: schedule.shifts[s].color }]}>+ {SHIFT_LABEL[s]}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Per-shift customization */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Shift settings</Text>
          <Text style={styles.cardSub}>Tap a row to customize wake-up time, sleep time, emoji, and outline color.</Text>
          {SHIFT_ORDER.map((s) => {
            const def = schedule.shifts[s];
            return (
              <TouchableOpacity
                key={s}
                style={[styles.shiftRow, { borderColor: def.color + 'AA' }]}
                onPress={() => setEditorFor(s)}
                activeOpacity={0.85}
                testID={`shift-edit-${s}`}
              >
                <View style={[styles.shiftEmojiBox, { borderColor: def.color }]}>
                  <Text style={styles.shiftEmoji}>{def.icon}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.shiftLabel, { color: def.color }]}>{SHIFT_LABEL[s]}</Text>
                  <Text style={styles.shiftMeta}>
                    Wake {def.start_time} · Sleep {def.sleep_time}
                  </Text>
                </View>
                <Ionicons name="create-outline" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Refresh offset */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Refresh window</Text>
          <Text style={styles.cardSub}>Tasks, goals, and challenges refresh this many hours BEFORE your wake-up time. Notifications stay silent until wake-up.</Text>
          <View style={styles.offsetRow}>
            {[0, 1, 2, 3, 4, 6].map((h) => (
              <TouchableOpacity
                key={h}
                onPress={() => persist({ refresh_offset_hours: h })}
                style={[
                  styles.offsetChip,
                  schedule.refresh_offset_hours === h && styles.offsetChipActive,
                ]}
                activeOpacity={0.8}
                testID={`offset-${h}`}
              >
                <Text
                  style={[
                    styles.offsetText,
                    schedule.refresh_offset_hours === h && styles.offsetTextActive,
                  ]}
                >
                  {h}h
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Calendar preview */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Next 14 days</Text>
          <Text style={styles.cardSub}>Tap any day to override (holiday / shift swap).</Text>
          <View style={styles.calendarGrid}>
            {preview.map((d) => (
              <TouchableOpacity
                key={d.date}
                style={[
                  styles.calCell,
                  { borderColor: (d.color || colors.border) + (d.is_override ? '' : '88') },
                  d.is_override && styles.calCellOverride,
                ]}
                onPress={() => setOverrideFor(d)}
                activeOpacity={0.8}
                testID={`cal-${d.date}`}
              >
                <Text style={styles.calDay}>{new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' })}</Text>
                <Text style={styles.calDate}>{d.date.slice(8)}</Text>
                <Text style={styles.calIcon}>{d.icon}</Text>
                <Text style={[styles.calLabel, { color: d.color }]}>
                  {d.shift ? SHIFT_LABEL[d.shift as ShiftType] : '—'}
                </Text>
                <Text style={styles.calTime}>{d.start_time}</Text>
                {d.is_override ? <View style={styles.overrideDot} /> : null}
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Reset all */}
        <TouchableOpacity
          style={styles.resetBtn}
          onPress={onResetAll}
          activeOpacity={0.85}
          testID="schedule-reset-all"
        >
          <Ionicons name="refresh" size={16} color={colors.red} />
          <Text style={styles.resetText}>Reset Schedule</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* ── Per-shift editor modal ── */}
      <ShiftEditorModal
        visible={editorFor !== null}
        kind={editorFor}
        schedule={schedule}
        onClose={() => setEditorFor(null)}
        onSave={(next) => { persist({ shifts: { ...schedule.shifts, ...next } }); setEditorFor(null); }}
      />

      {/* ── Manual override modal ── */}
      <OverrideModal
        day={overrideFor}
        onClose={() => setOverrideFor(null)}
        onPick={(s) => overrideFor && setOverride(overrideFor.date, s)}
      />
    </SafeAreaView>
  );
}

// ════════════════════ ShiftEditorModal ════════════════════════════
function ShiftEditorModal({
  visible,
  kind,
  schedule,
  onClose,
  onSave,
}: {
  visible: boolean;
  kind: ShiftType | null;
  schedule: ShiftSchedule;
  onClose: () => void;
  onSave: (next: Partial<ShiftSchedule['shifts']>) => void;
}) {
  const def = kind ? schedule.shifts[kind] : null;
  const [startTime, setStartTime] = useState('06:00');
  const [sleepTime, setSleepTime] = useState('22:00');
  const [icon, setIcon] = useState('🌅');
  const [color, setColor] = useState('#FFA726');
  const [customColor, setCustomColor] = useState('');
  const [applyAll, setApplyAll] = useState(false);

  useEffect(() => {
    if (!def) return;
    setStartTime(def.start_time);
    setSleepTime(def.sleep_time);
    setIcon(def.icon);
    setColor(def.color);
    setCustomColor('');
    setApplyAll(false);
  }, [def, kind]);

  if (!kind || !def) return null;

  const submit = () => {
    let finalColor = color;
    if (customColor.trim()) {
      const v = customColor.trim();
      if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) {
        showAlert('Invalid color', 'Use a hex color like #FFA500 or #1E3A8A.');
        return;
      }
      finalColor = v;
    }
    const entry = { start_time: startTime, sleep_time: sleepTime, icon, color: finalColor };
    const next: any = { [kind]: entry };
    if (applyAll) {
      // "Apply emoji + color to all shift types of this kind" — since
      // there's only one entry per kind in the dictionary, this affects
      // the single shift type but we copy the emoji and color verbatim
      // to mark the user's preference. (The pattern can repeat the same
      // kind many times — they all share this single dict entry.)
    }
    onSave(next);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={modalStyles.backdrop}>
        <ScrollView contentContainerStyle={modalStyles.scroll} keyboardShouldPersistTaps="handled">
          <View style={modalStyles.card}>
            <Text style={modalStyles.kicker}>EDIT · {SHIFT_LABEL[kind].toUpperCase()}</Text>

            <Text style={modalStyles.label}>Wake-up time (Start)</Text>
            <TextInput
              value={startTime}
              onChangeText={setStartTime}
              placeholder="06:00"
              placeholderTextColor={colors.textMuted}
              style={modalStyles.timeInput}
              testID="shift-start-time"
            />

            <Text style={modalStyles.label}>Sleep time (Silence push)</Text>
            <TextInput
              value={sleepTime}
              onChangeText={setSleepTime}
              placeholder="22:00"
              placeholderTextColor={colors.textMuted}
              style={modalStyles.timeInput}
              testID="shift-sleep-time"
            />

            <Text style={modalStyles.label}>Emoji</Text>
            <View style={modalStyles.emojiRow}>
              {EMOJI_PRESETS[kind].map((e) => (
                <TouchableOpacity
                  key={e}
                  onPress={() => setIcon(e)}
                  style={[modalStyles.emojiBtn, icon === e && modalStyles.emojiBtnActive]}
                  testID={`emoji-${e}`}
                >
                  <Text style={{ fontSize: 22 }}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={modalStyles.label}>Outline color</Text>
            <View style={modalStyles.colorGrid}>
              {PRESET_COLORS.map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => { setColor(c); setCustomColor(''); }}
                  style={[
                    modalStyles.colorSwatch,
                    { backgroundColor: c, borderColor: color === c ? '#fff' : '#333' },
                  ]}
                  testID={`color-${c}`}
                />
              ))}
            </View>
            <View style={modalStyles.customColorRow}>
              <Text style={modalStyles.customLabel}>Custom hex</Text>
              <TextInput
                value={customColor}
                onChangeText={setCustomColor}
                placeholder="#RRGGBB"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                style={modalStyles.customInput}
                testID="color-custom"
              />
            </View>

            <View style={modalStyles.btnRow}>
              <TouchableOpacity onPress={onClose} style={[modalStyles.btn, modalStyles.btnGhost]}>
                <Text style={modalStyles.btnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                style={[modalStyles.btn, modalStyles.btnPrimary]}
                testID="shift-save"
              >
                <Text style={modalStyles.btnPrimaryText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ════════════════════ OverrideModal ════════════════════════════
function OverrideModal({
  day,
  onClose,
  onPick,
}: {
  day: ScheduleDay | null;
  onClose: () => void;
  onPick: (s: ShiftType | null) => void;
}) {
  if (!day) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={modalStyles.backdrop}>
        <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation && e.stopPropagation()} style={modalStyles.sheet}>
          <View style={modalStyles.handle} />
          <Text style={modalStyles.kicker}>OVERRIDE · {day.date}</Text>
          <Text style={modalStyles.title}>Set this day to…</Text>
          {SHIFT_ORDER.map((s) => (
            <TouchableOpacity
              key={s}
              onPress={() => onPick(s)}
              style={[modalStyles.row, { borderColor: '#444' }]}
              activeOpacity={0.85}
              testID={`override-${s}`}
            >
              <Text style={{ fontSize: 22 }}>{s === 'day' ? '🌅' : s === 'night' ? '🌃' : '☕'}</Text>
              <Text style={modalStyles.rowText}>{SHIFT_LABEL[s]}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          ))}
          {day.is_override ? (
            <TouchableOpacity onPress={() => onPick(null)} style={modalStyles.cancel} testID="override-clear">
              <Text style={modalStyles.cancelText}>Clear override · use pattern</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={onClose} style={modalStyles.cancel}>
              <Text style={modalStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderColor: colors.border,
  },
  backBtn: { padding: 4 },
  title: { color: colors.text, fontSize: 16, fontWeight: '900' },
  subtitle: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  card: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.lg, padding: spacing.md, marginBottom: spacing.md,
    flexDirection: 'row' as const, flexWrap: 'wrap' as const,
  },
  cardTitle: { color: colors.text, fontSize: 14, fontWeight: '900', width: '100%' },
  cardSub: { color: colors.textSecondary, fontSize: 11, marginTop: 4, width: '100%' },
  patternRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10, width: '100%' },
  patternChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: radii.pill,
    borderWidth: 1.5, backgroundColor: colors.bg,
  },
  patternEmoji: { fontSize: 14 },
  patternText: { fontSize: 12, fontWeight: '900' },
  emptyHint: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic' },
  addRow: { flexDirection: 'row', gap: 6, marginTop: 12, width: '100%' },
  addBtn: {
    flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 4,
    borderWidth: 1, borderRadius: radii.md, paddingVertical: 10, backgroundColor: colors.bg,
  },
  addBtnText: { fontSize: 12, fontWeight: '900' },
  shiftRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 10, paddingVertical: 12, borderRadius: radii.md,
    borderWidth: 1, marginTop: 8, width: '100%', backgroundColor: colors.bg,
  },
  shiftEmojiBox: {
    width: 40, height: 40, borderRadius: 12, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface,
  },
  shiftEmoji: { fontSize: 20 },
  shiftLabel: { fontSize: 13, fontWeight: '900' },
  shiftMeta: { color: colors.textSecondary, fontSize: 11 },
  offsetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10, width: '100%' },
  offsetChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radii.pill,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  offsetChipActive: { backgroundColor: colors.cyan + '22', borderColor: colors.cyan },
  offsetText: { color: colors.textSecondary, fontWeight: '900', fontSize: 12 },
  offsetTextActive: { color: colors.cyan },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10, width: '100%' },
  calCell: {
    width: '13.5%', minWidth: 50, aspectRatio: 0.85,
    backgroundColor: colors.bg, borderWidth: 1.5, borderRadius: radii.md,
    padding: 4, alignItems: 'center', justifyContent: 'center', gap: 1,
  },
  calCellOverride: { backgroundColor: '#FFD70015' },
  calDay: { color: colors.textMuted, fontSize: 9, fontWeight: '700' },
  calDate: { color: colors.text, fontSize: 11, fontWeight: '900' },
  calIcon: { fontSize: 14 },
  calLabel: { fontSize: 9, fontWeight: '900' },
  calTime: { color: colors.textSecondary, fontSize: 8 },
  overrideDot: {
    position: 'absolute', top: 3, right: 3,
    width: 6, height: 6, borderRadius: 3, backgroundColor: '#FFD700',
  },
  resetBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8,
    paddingVertical: 14, marginTop: spacing.sm, borderRadius: radii.pill,
    backgroundColor: colors.red + '15', borderWidth: 1, borderColor: colors.red + '88',
  },
  resetText: { color: colors.red, fontSize: 13, fontWeight: '900', letterSpacing: 0.3 },
});

const modalStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)' },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border,
    padding: spacing.lg,
  },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg,
    padding: spacing.lg, paddingBottom: spacing.xl, gap: 8,
    borderTopWidth: 1, borderColor: colors.border, marginTop: 'auto',
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
  kicker: { color: colors.cyan, fontSize: 10, fontWeight: '900', letterSpacing: 2, textAlign: 'center' },
  title: { color: colors.text, fontSize: 16, fontWeight: '900', textAlign: 'center', marginBottom: 8 },
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, marginTop: spacing.sm, marginBottom: 6 },
  timeInput: {
    backgroundColor: colors.bg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 12, fontSize: 16, fontWeight: '900', textAlign: 'center', letterSpacing: 1,
  },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  emojiBtn: {
    width: 44, height: 44, borderRadius: radii.md,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  emojiBtnActive: { borderColor: colors.cyan, backgroundColor: colors.cyan + '22' },
  colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  colorSwatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2 },
  customColorRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  customLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: '800' },
  customInput: {
    flex: 1, backgroundColor: colors.bg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 10, fontSize: 13,
  },
  btnRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  btn: { flex: 1, paddingVertical: 12, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  btnGhostText: { color: colors.textSecondary, fontWeight: '800', fontSize: 13 },
  btnPrimary: { backgroundColor: colors.cyan },
  btnPrimaryText: { color: colors.bg, fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 14, borderRadius: radii.md, borderWidth: 1,
    backgroundColor: colors.bg, marginTop: 8,
  },
  rowText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '900' },
  cancel: { paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  cancelText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
});
