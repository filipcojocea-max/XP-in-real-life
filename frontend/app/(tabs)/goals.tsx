import React, { useCallback, useEffect, useState } from 'react';
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

const AREAS: FocusArea[] = ['social', 'fitness', 'appearance', 'mindset'];

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

  const adjust = async (g: Goal, delta: number) => {
    try {
      const res = await api.updateGoalProgress(g.id, g.current_value + delta);
      setGoals((prev) => prev.map((x) => (x.id === g.id ? res : x)));
      if (res.completed && !g.completed) {
        Alert.alert('Goal complete!', `+100 XP for finishing "${res.title}"`);
      }
    } catch (e) {
      console.log(e);
    }
  };

  const remove = (g: Goal) => {
    Alert.alert('Delete Goal?', `Remove "${g.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await api.deleteGoal(g.id);
          load();
        },
      },
    ]);
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
              Set long-term quests to track your journey. Earn +100 XP on completion.
            </Text>
          </Card>
        ) : (
          goals.map((g) => {
            const meta = focusMeta[g.focus_area];
            const pct = Math.min(1, g.current_value / g.target_value);
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
                      style={[styles.smallBtn, { backgroundColor: meta.color }]}
                      onPress={() => adjust(g, 1)}
                    >
                      <Ionicons name="add" size={18} color={colors.bg} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`goal-plus10-${g.id}`}
                      style={styles.smallBtnWide}
                      onPress={() => adjust(g, 10)}
                    >
                      <Text style={[styles.smallBtnText, { color: meta.color }]}>+10</Text>
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
  const [unit, setUnit] = useState('days');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setTitle('');
      setDesc('');
      setArea('fitness');
      setTarget('30');
      setUnit('days');
    }
  }, [visible]);

  const save = async () => {
    if (!title.trim()) {
      Alert.alert('Enter a goal title');
      return;
    }
    setSaving(true);
    try {
      await api.createGoal({
        title: title.trim(),
        description: desc.trim(),
        focus_area: area,
        target_value: parseInt(target, 10) || 30,
        unit: unit.trim() || 'days',
      });
      onAdded();
    } catch (e: any) {
      Alert.alert('Failed', String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet} testID="add-goal-modal">
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>New Goal</Text>

          <Text style={styles.inputLabel}>Title</Text>
          <TextInput
            testID="goal-input-title"
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Run 100 km this month"
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

          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>Target</Text>
              <TextInput
                testID="goal-input-target"
                keyboardType="number-pad"
                style={styles.input}
                value={target}
                onChangeText={setTarget}
                placeholderTextColor={colors.textMuted}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>Unit</Text>
              <TextInput
                testID="goal-input-unit"
                style={styles.input}
                value={unit}
                onChangeText={setUnit}
                placeholder="days / reps / km"
                placeholderTextColor={colors.textMuted}
              />
            </View>
          </View>

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
            <TouchableOpacity style={[styles.actionBtn, styles.cancelBtn]} onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="goal-save-btn" style={[styles.actionBtn, styles.saveBtn]} onPress={save} disabled={saving}>
              {saving ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.saveText}>Create Goal</Text>}
            </TouchableOpacity>
          </View>
        </View>
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
});
