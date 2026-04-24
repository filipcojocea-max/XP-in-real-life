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
  Animated,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import Card from '../../src/components/Card';
import { api, Task } from '../../src/api';
import { colors, focusMeta, slotMeta, spacing, radii, FocusArea, TimeSlot } from '../../src/theme';
import {
  ensureNotificationPermission,
  scheduleTaskNotification,
  cancelTaskNotification,
  syncAllTaskNotifications,
} from '../../src/notifications';
import DateTimePicker from '@react-native-community/datetimepicker';

const SLOTS: TimeSlot[] = ['morning', 'afternoon', 'evening'];
const AREAS: FocusArea[] = ['social', 'fitness', 'appearance', 'mindset'];

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [orderSource, setOrderSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [actionTask, setActionTask] = useState<Task | null>(null);
  const [xpFloater, setXpFloater] = useState<{ value: number } | null>(null);
  const floatAnim = useMemo(() => new Animated.Value(0), []);

  const load = useCallback(async () => {
    try {
      const r = await api.listTasks();
      setTasks(r.tasks);
      setOrderSource(r.adaptive_order ? r.order_source_date ?? null : null);
      syncAllTaskNotifications(r.tasks).catch(() => {});
    } catch (e) {
      console.log('tasks load', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    ensureNotificationPermission().catch(() => {});
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const showXp = (value: number) => {
    setXpFloater({ value });
    floatAnim.setValue(0);
    Animated.sequence([
      Animated.timing(floatAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.delay(600),
      Animated.timing(floatAnim, { toValue: 2, duration: 400, useNativeDriver: true }),
    ]).start(() => setXpFloater(null));
  };

  const toggle = async (task: Task) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    // optimistic
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, completed: !t.completed } : t))
    );
    try {
      if (task.completed) {
        await api.uncompleteTask(task.id);
      } else {
        const res = await api.completeTask(task.id);
        showXp(res.xp_awarded);
        if (res.leveled_up) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          Alert.alert('LEVEL UP!', `You reached Level ${res.new_level}. Keep climbing.`);
        } else if (res.newly_unlocked_achievements.length > 0) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        }
      }
    } catch (e) {
      console.log('toggle err', e);
      // revert
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, completed: task.completed } : t))
      );
    }
  };

  const removeTask = (task: Task) => {
    setActionTask(null);
    Alert.alert('Delete Quest?', `Remove "${task.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await api.deleteTask(task.id);
          await cancelTaskNotification(task.id);
          load();
        },
      },
    ]);
  };

  const openActions = (task: Task) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setActionTask(task);
  };

  const grouped = useMemo(() => {
    const g: Record<TimeSlot, Task[]> = { morning: [], afternoon: [], evening: [] };
    tasks.forEach((t) => g[t.time_slot].push(t));
    return g;
  }, [tasks]);

  const floaterStyle = {
    opacity: floatAnim.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 1, 0] }),
    transform: [
      {
        translateY: floatAnim.interpolate({ inputRange: [0, 2], outputRange: [0, -60] }),
      },
      {
        scale: floatAnim.interpolate({ inputRange: [0, 1, 2], outputRange: [0.8, 1.1, 1] }),
      },
    ],
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
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>Daily Quests · Unlimited</Text>
          <Text style={styles.title}>{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</Text>
        </View>
        <Text testID="tasks-count" style={styles.countPill}>
          {tasks.filter((t) => t.completed).length}/{tasks.length}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {orderSource ? (
          <View testID="adaptive-order-hint" style={styles.orderHint}>
            <Ionicons name="reorder-four" size={14} color={colors.cyan} />
            <Text style={styles.orderHintText}>
              Smart order · reshuffled from your completion pattern on{' '}
              {new Date(orderSource).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
            </Text>
          </View>
        ) : null}
        {SLOTS.map((slot) => {
          const arr = grouped[slot];
          const meta = slotMeta[slot];
          return (
            <View key={slot} style={{ marginBottom: spacing.lg }}>
              <View style={styles.slotHeader}>
                <Ionicons name={meta.icon as any} size={16} color={colors.textSecondary} />
                <Text style={styles.slotTitle}>{meta.label}</Text>
                <View style={styles.slotLine} />
                <Text style={styles.slotCount}>{arr.length}</Text>
              </View>
              {arr.length === 0 ? (
                <Card style={{ padding: spacing.md }}>
                  <Text style={styles.emptyText}>No quests for {meta.label.toLowerCase()} yet.</Text>
                </Card>
              ) : (
                arr.map((t) => (
                  <Pressable
                    key={t.id}
                    testID={`task-row-${t.id}`}
                    onLongPress={() => openActions(t)}
                    onPress={() => toggle(t)}
                    style={({ pressed }) => [styles.taskRow, pressed && { opacity: 0.85 }]}
                  >
                    <Card
                      accent={focusMeta[t.focus_area].color}
                      style={[
                        styles.taskCard,
                        t.completed && styles.taskDone,
                      ]}
                    >
                      <View style={styles.taskInner}>
                        <View
                          testID={`task-check-${t.id}`}
                          style={[
                            styles.check,
                            {
                              borderColor: focusMeta[t.focus_area].color,
                              backgroundColor: t.completed ? focusMeta[t.focus_area].color : 'transparent',
                            },
                          ]}
                        >
                          {t.completed ? (
                            <Ionicons name="checkmark" size={18} color={colors.bg} />
                          ) : null}
                        </View>
                        <View style={{ flex: 1, marginLeft: spacing.md }}>
                          <Text
                            style={[
                              styles.taskTitle,
                              t.completed && styles.taskTitleDone,
                            ]}
                          >
                            {t.title}
                          </Text>
                          {t.description ? (
                            <Text style={styles.taskDesc} numberOfLines={1}>
                              {t.description}
                            </Text>
                          ) : null}
                          <View style={styles.taskMeta}>
                            <View
                              style={[
                                styles.tag,
                                { backgroundColor: focusMeta[t.focus_area].color + '22', borderColor: focusMeta[t.focus_area].color + '55' },
                              ]}
                            >
                              <Ionicons name={focusMeta[t.focus_area].icon as any} size={10} color={focusMeta[t.focus_area].color} />
                              <Text style={[styles.tagText, { color: focusMeta[t.focus_area].color }]}>
                                {focusMeta[t.focus_area].label}
                              </Text>
                            </View>
                            {t.scheduled_time ? (
                              <View testID={`task-time-${t.id}`} style={styles.timeTag}>
                                <Ionicons
                                  name={t.reminder_enabled ? 'notifications' : 'notifications-off'}
                                  size={10}
                                  color={t.reminder_enabled ? colors.cyan : colors.textMuted}
                                />
                                <Text style={[
                                  styles.timeTagText,
                                  { color: t.reminder_enabled ? colors.cyan : colors.textMuted },
                                ]}>
                                  {t.scheduled_time}
                                </Text>
                              </View>
                            ) : null}
                            <Text style={styles.xpBadge}>+{t.xp_value} XP</Text>
                          </View>
                        </View>
                      </View>
                    </Card>
                  </Pressable>
                ))
              )}
            </View>
          );
        })}

        <Text style={styles.hint}>Tip: long-press a quest to edit or delete it.</Text>
      </ScrollView>

      <TouchableOpacity
        testID="add-task-fab"
        style={styles.fab}
        onPress={() => setShowAdd(true)}
      >
        <Ionicons name="add" size={30} color={colors.bg} />
      </TouchableOpacity>

      {xpFloater ? (
        <Animated.View style={[styles.xpFloater, floaterStyle]} pointerEvents="none">
          <Text style={styles.xpFloaterText}>+{xpFloater.value} XP</Text>
        </Animated.View>
      ) : null}

      <AddTaskModal
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => {
          setShowAdd(false);
          load();
        }}
      />
    </SafeAreaView>
  );
}

function AddTaskModal({
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
  const [slot, setSlot] = useState<TimeSlot>('morning');
  const [area, setArea] = useState<FocusArea>('fitness');
  const [xp, setXp] = useState('20');
  const [reminderOn, setReminderOn] = useState(true);
  const [scheduledDate, setScheduledDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(8, 0, 0, 0);
    return d;
  });
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  const slotDefaultHour: Record<TimeSlot, number> = { morning: 8, afternoon: 13, evening: 20 };

  useEffect(() => {
    if (visible) {
      setTitle('');
      setDesc('');
      setSlot('morning');
      setArea('fitness');
      setXp('20');
      setReminderOn(true);
      const d = new Date();
      d.setHours(8, 0, 0, 0);
      setScheduledDate(d);
      setShowPicker(false);
    }
  }, [visible]);

  const onSlotChange = (s: TimeSlot) => {
    setSlot(s);
    const d = new Date(scheduledDate);
    d.setHours(slotDefaultHour[s], 0, 0, 0);
    setScheduledDate(d);
  };

  const formatTime = (d: Date) => {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  };

  const save = async () => {
    if (!title.trim()) {
      Alert.alert('Enter a quest title');
      return;
    }
    setSaving(true);
    try {
      const scheduled_time = reminderOn ? formatTime(scheduledDate) : null;
      const created = await api.createTask({
        title: title.trim(),
        description: desc.trim(),
        focus_area: area,
        time_slot: slot,
        xp_value: parseInt(xp, 10) || 20,
        scheduled_time,
        reminder_enabled: reminderOn,
      });
      if (reminderOn && scheduled_time) {
        await scheduleTaskNotification({ ...created, reminder_enabled: true, scheduled_time });
      }
      onAdded();
    } catch (e: any) {
      Alert.alert('Failed to create quest', String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.modalBackdrop}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.modalSheet} testID="add-task-modal">
          <View style={styles.sheetHandle} />
          <Text style={styles.modalTitle}>New Quest</Text>

          <Text style={styles.inputLabel}>Title</Text>
          <TextInput
            testID="task-input-title"
            placeholder="e.g. 20 push-ups"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            value={title}
            onChangeText={setTitle}
          />

          <Text style={styles.inputLabel}>Description (optional)</Text>
          <TextInput
            testID="task-input-desc"
            placeholder="Why does this matter?"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            value={desc}
            onChangeText={setDesc}
          />

          <Text style={styles.inputLabel}>Time Slot</Text>
          <View style={styles.chipRow}>
            {SLOTS.map((s) => (
              <TouchableOpacity
                key={s}
                testID={`task-slot-${s}`}
                onPress={() => onSlotChange(s)}
                style={[styles.chip, slot === s && styles.chipActive]}
              >
                <Ionicons
                  name={slotMeta[s].icon as any}
                  size={14}
                  color={slot === s ? colors.bg : colors.textSecondary}
                />
                <Text style={[styles.chipText, slot === s && styles.chipTextActive]}>
                  {slotMeta[s].label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.inputLabel}>Focus Area</Text>
          <View style={styles.chipRow}>
            {AREAS.map((a) => {
              const m = focusMeta[a];
              const active = area === a;
              return (
                <TouchableOpacity
                  key={a}
                  testID={`task-area-${a}`}
                  onPress={() => setArea(a)}
                  style={[
                    styles.chip,
                    {
                      borderColor: m.color + (active ? '' : '55'),
                      backgroundColor: active ? m.color : 'transparent',
                    },
                  ]}
                >
                  <Ionicons
                    name={m.icon as any}
                    size={14}
                    color={active ? colors.bg : m.color}
                  />
                  <Text
                    style={[
                      styles.chipText,
                      { color: active ? colors.bg : m.color },
                    ]}
                  >
                    {m.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.inputLabel}>Reminder</Text>
          <View style={styles.reminderRow}>
            <TouchableOpacity
              testID="task-reminder-toggle"
              onPress={() => setReminderOn((v) => !v)}
              style={[
                styles.reminderToggle,
                { backgroundColor: reminderOn ? colors.cyan : colors.surfaceGlass, borderColor: reminderOn ? colors.cyan : colors.border },
              ]}
            >
              <Ionicons
                name={reminderOn ? 'notifications' : 'notifications-off'}
                size={16}
                color={reminderOn ? colors.bg : colors.textMuted}
              />
              <Text style={[styles.reminderText, { color: reminderOn ? colors.bg : colors.textMuted }]}>
                {reminderOn ? 'Daily reminder ON' : 'Reminder OFF'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              testID="task-time-picker-btn"
              onPress={() => setShowPicker(true)}
              disabled={!reminderOn}
              style={[styles.timePickBtn, !reminderOn && { opacity: 0.4 }]}
            >
              <Ionicons name="time" size={14} color={colors.amber} />
              <Text style={styles.timePickText}>{formatTime(scheduledDate)}</Text>
            </TouchableOpacity>
          </View>
          {showPicker ? (
            <DateTimePicker
              testID="task-time-picker"
              value={scheduledDate}
              mode="time"
              is24Hour
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(_, d) => {
                if (Platform.OS !== 'ios') setShowPicker(false);
                if (d) setScheduledDate(d);
              }}
              themeVariant="dark"
            />
          ) : null}

          <Text style={styles.inputLabel}>XP Reward</Text>
          <TextInput
            testID="task-input-xp"
            keyboardType="number-pad"
            style={styles.input}
            value={xp}
            onChangeText={setXp}
            placeholderTextColor={colors.textMuted}
          />

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
            <TouchableOpacity style={[styles.actionBtn, styles.cancelBtn]} onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="task-save-btn"
              style={[styles.actionBtn, styles.saveBtn]}
              onPress={save}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text style={styles.saveText}>Add Quest</Text>
              )}
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
    paddingBottom: spacing.sm,
  },
  kicker: { color: colors.green, fontSize: 12, letterSpacing: 2, fontWeight: '800' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 2 },
  countPill: {
    color: colors.amber,
    fontWeight: '800',
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.amber + '18',
    borderWidth: 1,
    borderColor: colors.amber + '55',
  },
  scroll: { padding: spacing.md, paddingBottom: 120 },
  slotHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: spacing.sm,
  },
  slotTitle: { color: colors.textSecondary, fontSize: 12, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  slotLine: { flex: 1, height: 1, backgroundColor: colors.border },
  slotCount: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  emptyText: { color: colors.textMuted, fontSize: 13 },

  taskRow: { marginBottom: spacing.sm },
  taskCard: { paddingVertical: spacing.md, paddingHorizontal: spacing.md },
  taskDone: { opacity: 0.6 },
  taskInner: { flexDirection: 'row', alignItems: 'center' },
  check: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  taskTitleDone: { textDecorationLine: 'line-through', color: colors.textMuted },
  taskDesc: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  taskMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: spacing.sm },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  tagText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  xpBadge: {
    color: colors.amber,
    fontSize: 11,
    fontWeight: '800',
    backgroundColor: colors.amber + '15',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radii.pill,
    overflow: 'hidden',
  },
  timeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(0,217,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0,217,255,0.3)',
  },
  timeTagText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  reminderRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  reminderToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  reminderText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.3 },
  timePickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.amber + '66',
    backgroundColor: colors.amber + '15',
  },
  timePickText: { color: colors.amber, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
  hint: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: spacing.md },

  fab: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md + 70,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.green,
    shadowOpacity: 0.7,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },

  xpFloater: {
    position: 'absolute',
    top: '45%',
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.amber,
  },
  xpFloaterText: { color: colors.bg, fontSize: 20, fontWeight: '900', letterSpacing: 1 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.surface,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.md,
  },
  modalTitle: { color: colors.text, fontSize: 22, fontWeight: '800', marginBottom: spacing.md },
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
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: colors.bg },
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: { backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.textSecondary, fontWeight: '700' },
  saveBtn: { backgroundColor: colors.green },
  saveText: { color: colors.bg, fontWeight: '800', fontSize: 15 },
});

