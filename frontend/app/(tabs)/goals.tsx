import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import Card from '../../src/components/Card';
import { api, Goal } from '../../src/api';
import { colors, focusMeta, spacing, radii, FocusArea } from '../../src/theme';
import { showAlert, showConfirm } from '../../src/uiAlert';

const AREAS: FocusArea[] = ['social', 'fitness', 'appearance', 'mindset'];

// Cycle-lockout helpers for the Goals "tick rate-limit" feature.
// Backend enforces this — these helpers are just for the UI countdown.
function formatRelativeFuture(target: Date): string {
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';
  const mins = Math.floor(diffMs / (60 * 1000));
  if (mins < 60) return `in ${mins} min${mins === 1 ? '' : 's'}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours} hr${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `in ${days} day${days === 1 ? '' : 's'}`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `in ${weeks} week${weeks === 1 ? '' : 's'}`;
  return `on ${target.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

// Refresh "in X mins" labels every minute so the countdown stays accurate
// without needing to re-fetch the whole goals list.
function useTick(intervalMs: number = 60_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}

// XP cap by duration unit. Long-term goals = bigger reward, capped per tier.
type DurationUnit = 'days' | 'weeks' | 'months';
const DURATION_UNITS: DurationUnit[] = ['days', 'weeks', 'months'];
const XP_CAPS: Record<DurationUnit, number> = {
  days: 30,
  weeks: 225,
  months: 900,
};
const UNIT_META: Record<DurationUnit, { label: string; icon: string }> = {
  days: { label: 'Days', icon: 'sunny' },
  weeks: { label: 'Weeks', icon: 'calendar' },
  months: { label: 'Months', icon: 'calendar-outline' },
};

export default function Goals() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listGoals();
      setGoals(r.goals);
    } catch (e) {
      console.log('goals', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // Re-render every minute so countdown labels stay current.
  useTick(60_000);

  const adjust = async (g: Goal, delta: number) => {
    try {
      const res = await api.updateGoalProgress(g.id, g.current_value + delta);
      setGoals((prev) => prev.map((x) => (x.id === g.id ? res : x)));
      if (res.completed && !g.completed) {
        const xp = res.awarded_xp ?? res.xp_reward ?? 100;
        showAlert('Goal complete! 🎉', `+${xp} XP for finishing "${res.title}"`);
      }
    } catch (e: any) {
      // Friendly handling for the cycle-lockout 429 error returned by the backend.
      const detail = e?.detail;
      if (detail && (detail.error === 'cycle_locked' || /locked/i.test(String(e?.message || '')))) {
        const next = detail.next_tick_available_at
          ? new Date(detail.next_tick_available_at)
          : null;
        showAlert(
          'Locked for now',
          next
            ? `You can tick this goal again ${formatRelativeFuture(next)}.`
            : 'This goal is locked until its next cycle.'
        );
        // Refresh to get the latest server-side lock state.
        load();
        return;
      }
      console.log(e);
    }
  };

  const remove = async (g: Goal) => {
    const ok = await showConfirm('Delete Goal?', `Remove "${g.title}"?`, {
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await api.deleteGoal(g.id);
    load();
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loading}>
          <ActivityIndicator color={colors.green} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.kicker}>Long-Term Goals</Text>
          <Text style={styles.title}>Your Quests</Text>
        </View>
        <TouchableOpacity
          testID="add-goal-btn"
          style={styles.addBtn}
          onPress={() => setShowAdd(true)}
        >
          <Ionicons name="add" size={20} color={colors.bg} />
          <Text style={styles.addBtnText}>New</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {goals.length === 0 ? (
          <Card style={styles.empty}>
            <Ionicons name="flag" size={40} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No goals yet</Text>
            <Text style={styles.emptyDesc}>
              Set long-term quests over days, weeks or months. Earn up to 900 XP on completion.
            </Text>
          </Card>
        ) : (
          goals.map((g) => {
            const meta = focusMeta[g.focus_area];
            const pct = Math.min(1, g.current_value / g.target_value);
            const locked = !!g.is_locked && !g.completed;
            const nextAt = g.next_tick_available_at
              ? new Date(g.next_tick_available_at)
              : null;
            return (
              <Pressable
                key={g.id}
                testID={`goal-row-${g.id}`}
                onLongPress={() => remove(g)}
                style={{ marginBottom: spacing.md }}
              >
                <Card accent={meta.color}>
                  <View style={styles.goalHead}>
                    <View style={[styles.goalIcon, { backgroundColor: meta.color + '22', borderColor: meta.color + '55' }]}>
                      <Ionicons name={meta.icon as any} size={18} color={meta.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.goalTitle}>{g.title}</Text>
                      {g.description ? <Text style={styles.goalDesc}>{g.description}</Text> : null}
                    </View>
                    {g.completed ? (
                      <View style={styles.doneBadge}>
                        <Ionicons name="checkmark" size={14} color={colors.bg} />
                      </View>
                    ) : g.xp_reward ? (
                      <View style={styles.xpBadge}>
                        <Ionicons name="flash" size={11} color={colors.amber} />
                        <Text style={styles.xpBadgeText}>+{g.xp_reward}</Text>
                      </View>
                    ) : null}
                  </View>

                  <View style={styles.progressRow}>
                    <Text style={styles.progressText}>
                      {g.current_value} / {g.target_value} {g.unit}
                    </Text>
                    <Text style={[styles.progressPct, { color: meta.color }]}>
                      {Math.round(pct * 100)}%
                    </Text>
                  </View>
                  <View style={styles.bar}>
                    <View style={[styles.barFill, { width: `${pct * 100}%`, backgroundColor: meta.color }]} />
                  </View>

                  {locked && nextAt ? (
                    <View style={styles.lockPill} testID={`goal-lock-${g.id}`}>
                      <Ionicons name="lock-closed" size={11} color={colors.amber} />
                      <Text style={styles.lockPillText}>
                        Unlocks {formatRelativeFuture(nextAt)}
                      </Text>
                    </View>
                  ) : null}

                  <View style={styles.goalActions}>
                    <TouchableOpacity
                      testID={`goal-dec-${g.id}`}
                      style={styles.smallBtn}
                      onPress={() => adjust(g, -1)}
                    >
                      <Ionicons name="remove" size={18} color={colors.text} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`goal-inc-${g.id}`}
                      disabled={locked}
                      style={[
                        styles.smallBtn,
                        { backgroundColor: meta.color },
                        locked && styles.btnDisabled,
                      ]}
                      onPress={() => adjust(g, 1)}
                    >
                      <Ionicons
                        name={locked ? 'lock-closed' : 'add'}
                        size={18}
                        color={colors.bg}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`goal-plus10-${g.id}`}
                      disabled={locked}
                      style={[styles.smallBtnWide, locked && styles.btnDisabled]}
                      onPress={() => adjust(g, 10)}
                    >
                      <Text style={[styles.smallBtnText, { color: locked ? colors.textMuted : meta.color }]}>+10</Text>
                    </TouchableOpacity>
                  </View>
                </Card>
              </Pressable>
            );
          })
        )}
        <Text style={styles.hint}>Tip: long-press to delete.</Text>
      </ScrollView>

      <AddGoalModal visible={showAdd} onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); load(); }} />
    </SafeAreaView>
  );
}

function AddGoalModal({
  visible,
  onClose,
  onAdded,
}: {
  visible: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [area, setArea] = useState<FocusArea>('fitness');
  const [target, setTarget] = useState('30');
  const [unit, setUnit] = useState<DurationUnit>('days');
  const [xp, setXp] = useState<string>('15');
  const [saving, setSaving] = useState(false);

  // Sensible default XP per unit (half of cap, rounded to a nice round number)
  const defaultXpFor = useCallback((u: DurationUnit): number => {
    if (u === 'days') return 15;
    if (u === 'weeks') return 100;
    return 450; // months
  }, []);

  useEffect(() => {
    if (visible) {
      setTitle('');
      setDesc('');
      setArea('fitness');
      setTarget('30');
      setUnit('days');
      setXp(String(defaultXpFor('days')));
    }
  }, [visible, defaultXpFor]);

  const cap = XP_CAPS[unit];
  const xpNum = parseInt(xp, 10);
  const xpInvalid = !isNaN(xpNum) && (xpNum < 1 || xpNum > cap);

  // When user changes the unit, clamp the existing XP to the new cap
  const onChangeUnit = (u: DurationUnit) => {
    setUnit(u);
    const current = parseInt(xp, 10);
    if (isNaN(current)) {
      setXp(String(defaultXpFor(u)));
      return;
    }
    if (current > XP_CAPS[u]) setXp(String(XP_CAPS[u]));
  };

  const onChangeXp = (t: string) => {
    const cleaned = t.replace(/[^0-9]/g, '');
    if (cleaned === '') {
      setXp('');
      return;
    }
    const n = parseInt(cleaned, 10);
    // Auto-clamp at the cap so the user can't even type higher
    if (n > cap) {
      setXp(String(cap));
      return;
    }
    setXp(cleaned);
  };

  const save = async () => {
    if (!title.trim()) {
      showAlert('Enter a goal title');
      return;
    }
    const targetN = parseInt(target, 10) || 30;
    const xpRequested = Math.max(1, Math.min(cap, parseInt(xp, 10) || defaultXpFor(unit)));
    setSaving(true);
    try {
      await api.createGoal({
        title: title.trim(),
        description: desc.trim(),
        focus_area: area,
        target_value: targetN,
        unit,
        xp_reward: xpRequested,
      });
      onAdded();
    } catch (e: any) {
      showAlert('Failed', String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <ScrollView
          style={{ maxHeight: '92%' }}
          contentContainerStyle={styles.sheet}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          testID="add-goal-modal"
        >
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>New Goal</Text>

          <Text style={styles.inputLabel}>Title</Text>
          <TextInput
            testID="goal-input-title"
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Read every day"
            placeholderTextColor={colors.textMuted}
          />

          <Text style={styles.inputLabel}>Description (optional)</Text>
          <TextInput
            testID="goal-input-desc"
            style={styles.input}
            value={desc}
            onChangeText={setDesc}
            placeholder="Why does this matter?"
            placeholderTextColor={colors.textMuted}
          />

          <Text style={styles.inputLabel}>Focus Area</Text>
          <View style={styles.chipRow}>
            {AREAS.map((a) => {
              const m = focusMeta[a];
              const active = area === a;
              return (
                <TouchableOpacity
                  key={a}
                  testID={`goal-area-${a}`}
                  onPress={() => setArea(a)}
                  style={[
                    styles.chip,
                    {
                      borderColor: m.color + (active ? '' : '55'),
                      backgroundColor: active ? m.color : 'transparent',
                    },
                  ]}
                >
                  <Ionicons name={m.icon as any} size={14} color={active ? colors.bg : m.color} />
                  <Text style={[styles.chipText, { color: active ? colors.bg : m.color }]}>{m.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.inputLabel}>Duration</Text>
          <View style={styles.chipRow}>
            {DURATION_UNITS.map((u) => {
              const m = UNIT_META[u];
              const active = unit === u;
              return (
                <TouchableOpacity
                  key={u}
                  testID={`goal-unit-${u}`}
                  onPress={() => onChangeUnit(u)}
                  style={[
                    styles.chip,
                    {
                      borderColor: colors.cyan + (active ? '' : '55'),
                      backgroundColor: active ? colors.cyan : 'transparent',
                    },
                  ]}
                >
                  <Ionicons name={m.icon as any} size={14} color={active ? colors.bg : colors.cyan} />
                  <Text style={[styles.chipText, { color: active ? colors.bg : colors.cyan }]}>{m.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>Target</Text>
              <TextInput
                testID="goal-input-target"
                keyboardType="number-pad"
                style={styles.input}
                value={target}
                onChangeText={(t) => setTarget(t.replace(/[^0-9]/g, ''))}
                placeholderTextColor={colors.textMuted}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>Unit</Text>
              <View style={[styles.input, styles.unitDisplay]}>
                <Text style={styles.unitDisplayText}>{UNIT_META[unit].label.toLowerCase()}</Text>
              </View>
            </View>
          </View>

          <View style={styles.xpHeaderRow}>
            <Text style={[styles.inputLabel, { marginTop: 0 }]}>XP Reward</Text>
            <Text style={styles.xpCapPill} testID="goal-xp-cap">
              <Ionicons name="flash" size={11} color={colors.amber} />
              {`  max ${cap} XP for ${unit}`}
            </Text>
          </View>
          <TextInput
            testID="goal-input-xp"
            keyboardType="number-pad"
            style={[styles.input, xpInvalid && { borderColor: colors.red }]}
            value={xp}
            onChangeText={onChangeXp}
            placeholder={String(defaultXpFor(unit))}
            placeholderTextColor={colors.textMuted}
          />
          <Text style={styles.xpHint} testID="goal-xp-hint">
            {unit === 'days'
              ? 'Daily goals can award up to 30 XP.'
              : unit === 'weeks'
                ? 'Weekly goals can award up to 225 XP.'
                : 'Monthly goals can award up to 900 XP.'}
          </Text>

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg }}>
            <TouchableOpacity style={[styles.actionBtn, styles.cancelBtn]} onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="goal-save-btn" style={[styles.actionBtn, styles.saveBtn]} onPress={save} disabled={saving}>
              {saving ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.saveText}>Create Goal</Text>}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    padding: spacing.md,
  },
  kicker: { color: colors.cyan, fontSize: 12, letterSpacing: 2, fontWeight: '800' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 2 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.green,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
  },
  addBtnText: { color: colors.bg, fontWeight: '800', fontSize: 13 },
  scroll: { padding: spacing.md, paddingBottom: 120 },
  empty: { alignItems: 'center', padding: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing.md },
  emptyDesc: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: spacing.sm, lineHeight: 18 },

  goalHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  goalIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goalTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  goalDesc: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  doneBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.md, marginBottom: 6 },
  progressText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  progressPct: { fontSize: 14, fontWeight: '800' },
  bar: { height: 8, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: radii.pill, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: radii.pill },
  goalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  smallBtn: {
    width: 40,
    height: 40,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallBtnWide: {
    paddingHorizontal: spacing.md,
    height: 40,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallBtnText: { fontWeight: '800', fontSize: 13 },
  btnDisabled: { opacity: 0.45 },
  lockPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.amber + '15',
    borderWidth: 1,
    borderColor: colors.amber + '55',
  },
  lockPillText: {
    color: colors.amber,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  hint: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: spacing.md },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginBottom: spacing.md },
  sheetTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
  inputLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing.md, marginBottom: 6 },
  input: {
    backgroundColor: colors.surfaceGlass,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  chipText: { fontSize: 13, fontWeight: '700' },
  actionBtn: { flex: 1, paddingVertical: 14, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  cancelBtn: { backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.textSecondary, fontWeight: '700' },
  saveBtn: { backgroundColor: colors.green },
  saveText: { color: colors.bg, fontWeight: '800', fontSize: 15 },

  xpBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.amber + '22',
    borderWidth: 1,
    borderColor: colors.amber + '55',
  },
  xpBadgeText: { color: colors.amber, fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },

  xpHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    marginBottom: 6,
  },
  xpCapPill: {
    color: colors.amber,
    fontSize: 11,
    fontWeight: '800',
    backgroundColor: colors.amber + '15',
    borderColor: colors.amber + '44',
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  xpHint: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 6,
    marginLeft: 4,
  },
  unitDisplay: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.surfaceGlass,
    borderStyle: 'dashed',
    borderColor: colors.cyan + '55',
  },
  unitDisplayText: {
    color: colors.cyan,
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.5,
    textTransform: 'capitalize',
  },
});
