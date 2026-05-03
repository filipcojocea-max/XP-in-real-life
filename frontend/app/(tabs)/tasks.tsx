import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { api, Task, userDate } from '../../src/api';
import { colors, focusMeta, slotMeta, spacing, radii, FocusArea, TimeSlot } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';
import { useScrollToTopOnFocus } from '../../src/hooks/useScrollToTopOnFocus';
import { router } from 'expo-router';
import {
  ensureNotificationPermission,
  scheduleTaskNotification,
  cancelTaskNotification,
  syncAllTaskNotifications,
} from '../../src/notifications';
import DateTimePicker from '@react-native-community/datetimepicker';

const SLOTS: TimeSlot[] = ['morning', 'afternoon', 'evening'];
const AREAS: FocusArea[] = ['social', 'fitness', 'appearance', 'mindset'];

const slotDefaultHour: Record<TimeSlot, number> = { morning: 8, afternoon: 13, evening: 20 };

function addHoursStr(hhmm: string, delta: number): string {
  const [h = 7, m = 0] = hhmm.split(':').map((x) => parseInt(x, 10));
  let nh = h + delta;
  if (nh < 0) nh += 24;
  if (nh >= 24) nh -= 24;
  const mm = String(m).padStart(2, '0');
  return `${String(nh).padStart(2, '0')}:${mm}`;
}

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [orderSource, setOrderSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalTask, setModalTask] = useState<Task | null>(null); // editing
  const [showAdd, setShowAdd] = useState(false);
  const [actionTask, setActionTask] = useState<Task | null>(null);
  const [xpFloater, setXpFloater] = useState<{ value: number } | null>(null);
  const [wakeTime, setWakeTime] = useState<string>('07:00');
  const [tz, setTz] = useState<string | null>(null);
  const [customCount, setCustomCount] = useState<number>(0);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const floatAnim = useMemo(() => new Animated.Value(0), []);
  const { isAnonymous } = useAuth();

  const load = useCallback(async () => {
    try {
      const prof = await api.getProfile().catch(() => null);
      const wt = prof?.day_start_time || prof?.wake_time || '07:00';
      setWakeTime(wt);
      setTz(prof?.timezone || null);
      setIsAdmin(!!prof?.is_admin);
      const today = userDate(wt, prof?.timezone || null);
      const r = await api.listTasks(today);
      setTasks(r.tasks);
      setCustomCount(r.tasks.filter((t) => !t.is_default).length);
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

  // Scroll the Tasks feed back to the very top whenever the tab is
  // re-focused, so the user always sees the current day first.
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTopOnFocus(scrollRef);

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
    const wasCompleted = task.completed;
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, completed: !wasCompleted } : t))
    );
    try {
      const today = userDate(wakeTime, tz);
      if (wasCompleted) {
        // Un-tick: remove XP
        const res = await api.uncompleteTask(task.id, today);
        if (res?.xp_removed) showXp(-res.xp_removed);
      } else {
        // Tick: award XP
        const res = await api.completeTask(task.id, today);
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
      // Roll back optimistic change on failure
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, completed: wasCompleted } : t))
      );
    }
  };

  const removeTask = (task: Task) => {
    if (task.is_default) {
      Alert.alert('Default quest', 'Default quests cannot be deleted, only edited.');
      return;
    }
    Alert.alert('Delete Quest?', `Remove "${task.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setActionTask(null);
          try {
            await api.deleteTask(task.id);
            await cancelTaskNotification(task.id);
            load();
          } catch (e: any) {
            Alert.alert('Cannot delete', String(e.message || e));
          }
        },
      },
    ]);
  };

  const moveToSlot = async (task: Task, newSlot: TimeSlot) => {
    if (task.is_default) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      Alert.alert(
        'Locked',
        'Default quests are pinned to their original time slot and cannot be moved.',
      );
      return;
    }
    if (task.time_slot === newSlot) {
      setActionTask(null);
      return;
    }
    setActionTask(null);
    // optimistic
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, time_slot: newSlot } : t)));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    try {
      // Reset scheduled_time to slot default hour if reminders enabled
      const hh = String(slotDefaultHour[newSlot]).padStart(2, '0');
      const newTime = task.reminder_enabled ? `${hh}:00` : task.scheduled_time ?? null;
      const updated = await api.updateTask(task.id, {
        time_slot: newSlot,
        scheduled_time: newTime,
      });
      if (updated.reminder_enabled && updated.scheduled_time) {
        await scheduleTaskNotification(updated);
      }
      load();
    } catch (e: any) {
      Alert.alert('Could not move quest', String(e.message || e));
      load();
    }
  };

  const openActions = (task: Task) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setActionTask(task);
  };

  const openEdit = (task: Task) => {
    Haptics.selectionAsync().catch(() => {});
    setActionTask(null);
    setModalTask(task);
  };

  const grouped = useMemo(() => {
    const g: Record<TimeSlot, Task[]> = { morning: [], afternoon: [], evening: [] };
    tasks.forEach((t) => g[t.time_slot].push(t));
    return g;
  }, [tasks]);

  const floaterStyle = {
    opacity: floatAnim.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 1, 0] }),
    transform: [
      { translateY: floatAnim.interpolate({ inputRange: [0, 2], outputRange: [0, -60] }) },
      { scale: floatAnim.interpolate({ inputRange: [0, 1, 2], outputRange: [0.8, 1.1, 1] }) },
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
          <Text style={styles.kicker}>Daily Quests · Resets {wakeTime ? `${addHoursStr(wakeTime, -2)}` : ''}</Text>
          <Text style={styles.title}>
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
          </Text>
          <Text style={styles.customCount} testID="tasks-custom-count">
            {customCount} / 11 custom quests
          </Text>
        </View>
        <Text testID="tasks-count" style={styles.countPill}>
          {tasks.filter((t) => t.completed).length}/{tasks.length}
        </Text>
      </View>

      <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {isAnonymous ? (
          <TouchableOpacity
            testID="anon-signin-banner"
            onPress={() => router.push('/auth/login' as any)}
            style={styles.anonBanner}
          >
            <Ionicons name="cloud-offline" size={18} color={colors.amber} />
            <View style={{ flex: 1 }}>
              <Text style={styles.anonBannerTitle}>Sign in to save your progress</Text>
              <Text style={styles.anonBannerDesc}>
                Your XP lives only on this device. If you uninstall the app, it's gone.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.amber} />
          </TouchableOpacity>
        ) : null}
        {orderSource ? (
          <View testID="adaptive-order-hint" style={styles.orderHint}>
            <Ionicons name="reorder-four" size={14} color={colors.cyan} />
            <Text style={styles.orderHintText}>
              Smart order · reshuffled from your completion pattern on{' '}
              {new Date(orderSource).toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
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
                      style={[styles.taskCard, t.completed && styles.taskDone]}
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
                        <View style={{ flex: 1, marginLeft: spacing.md, marginRight: 40 }}>
                          <View style={styles.titleRow}>
                            <Text
                              style={[styles.taskTitle, t.completed && styles.taskTitleDone]}
                              numberOfLines={1}
                            >
                              {t.title}
                            </Text>
                            {t.is_default ? (
                              <Ionicons name="lock-closed" size={10} color={colors.textMuted} style={{ marginLeft: 6 }} />
                            ) : null}
                          </View>
                          {t.description ? (
                            <Text style={styles.taskDesc} numberOfLines={1}>
                              {t.description}
                            </Text>
                          ) : null}
                          <View style={styles.taskMeta}>
                            <View
                              style={[
                                styles.tag,
                                {
                                  backgroundColor: focusMeta[t.focus_area].color + '22',
                                  borderColor: focusMeta[t.focus_area].color + '55',
                                },
                              ]}
                            >
                              <Ionicons
                                name={focusMeta[t.focus_area].icon as any}
                                size={10}
                                color={focusMeta[t.focus_area].color}
                              />
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
                                <Text
                                  style={[
                                    styles.timeTagText,
                                    { color: t.reminder_enabled ? colors.cyan : colors.textMuted },
                                  ]}
                                >
                                  {t.scheduled_time}
                                </Text>
                              </View>
                            ) : null}
                            <Text style={styles.xpBadge}>+{t.xp_value} XP</Text>
                          </View>
                        </View>
                      </View>

                      {/* Top-right Edit Pencil */}
                      <TouchableOpacity
                        testID={`task-edit-${t.id}`}
                        onPress={(e) => {
                          e.stopPropagation?.();
                          openEdit(t);
                        }}
                        hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                        style={styles.editBadge}
                      >
                        <Ionicons name="pencil" size={14} color={colors.cyan} />
                      </TouchableOpacity>
                    </Card>
                  </Pressable>
                ))
              )}
            </View>
          );
        })}

        <Text style={styles.hint}>Tap the ✎ to edit · Long-press to move or delete</Text>
      </ScrollView>

      <TouchableOpacity
        testID="add-task-fab"
        style={styles.fab}
        onPress={() => {
          setModalTask(null);
          setShowAdd(true);
        }}
      >
        <Ionicons name="add" size={30} color={colors.bg} />
      </TouchableOpacity>

      {xpFloater ? (
        <Animated.View style={[styles.xpFloater, floaterStyle]} pointerEvents="none">
          <Text style={styles.xpFloaterText}>+{xpFloater.value} XP</Text>
        </Animated.View>
      ) : null}

      <TaskActionSheet
        task={actionTask}
        onClose={() => setActionTask(null)}
        onEdit={openEdit}
        onMove={moveToSlot}
        onDelete={removeTask}
      />

      <TaskModal
        visible={showAdd || modalTask !== null}
        editingTask={modalTask}
        isAdmin={isAdmin}
        onClose={() => {
          setShowAdd(false);
          setModalTask(null);
        }}
        onSaved={() => {
          setShowAdd(false);
          setModalTask(null);
          load();
        }}
      />
    </SafeAreaView>
  );
}

// ───────────────────────── ActionSheet ─────────────────────────
function TaskActionSheet({
  task,
  onClose,
  onEdit,
  onMove,
  onDelete,
}: {
  task: Task | null;
  onClose: () => void;
  onEdit: (t: Task) => void;
  onMove: (t: Task, s: TimeSlot) => void;
  onDelete: (t: Task) => void;
}) {
  if (!task) return null;
  const isDefault = !!task.is_default;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.actionSheet} onPress={() => {}} testID="task-action-sheet">
          <View style={styles.sheetHandle} />
          <View style={styles.sheetTitleRow}>
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {task.title}
            </Text>
            {isDefault ? (
              <View style={styles.lockPill}>
                <Ionicons name="lock-closed" size={10} color={colors.amber} />
                <Text style={styles.lockPillText}>DEFAULT</Text>
              </View>
            ) : null}
          </View>

          {/* Edit — always available */}
          <TouchableOpacity
            testID="action-edit"
            style={styles.actionItem}
            onPress={() => onEdit(task)}
          >
            <Ionicons name="pencil" size={18} color={colors.cyan} />
            <Text style={styles.actionItemText}>Edit Quest</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>

          {/* Move */}
          <Text style={styles.actionGroupLabel}>
            {isDefault ? '🔒 Cannot move — default quest' : 'Move to time slot'}
          </Text>
          {SLOTS.map((s) => {
            const disabled = isDefault || task.time_slot === s;
            const isCurrent = task.time_slot === s;
            return (
              <TouchableOpacity
                key={s}
                testID={`action-move-${s}`}
                disabled={disabled}
                onPress={() => onMove(task, s)}
                style={[styles.actionItem, disabled && { opacity: 0.45 }]}
              >
                <Ionicons
                  name={slotMeta[s].icon as any}
                  size={18}
                  color={isCurrent ? colors.green : colors.textSecondary}
                />
                <Text
                  style={[
                    styles.actionItemText,
                    isCurrent && { color: colors.green, fontWeight: '800' },
                  ]}
                >
                  {slotMeta[s].label}
                  {isCurrent ? '  (current)' : ''}
                </Text>
                {!disabled ? <Ionicons name="arrow-forward" size={16} color={colors.textMuted} /> : null}
              </TouchableOpacity>
            );
          })}

          {/* Delete — hidden for default */}
          {!isDefault ? (
            <TouchableOpacity
              testID="action-delete"
              style={[styles.actionItem, { marginTop: spacing.sm }]}
              onPress={() => onDelete(task)}
            >
              <Ionicons name="trash" size={18} color={colors.danger} />
              <Text style={[styles.actionItemText, { color: colors.danger }]}>Delete Quest</Text>
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity
            testID="action-cancel"
            style={[styles.actionBtn, styles.cancelBtn, { marginTop: spacing.md }]}
            onPress={onClose}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ───────────────────────── Add / Edit Modal ─────────────────────────
function TaskModal({
  visible,
  editingTask,
  onClose,
  onSaved,
  isAdmin,
}: {
  visible: boolean;
  editingTask: Task | null;
  onClose: () => void;
  onSaved: () => void;
  isAdmin?: boolean;
}) {
  const isEdit = !!editingTask;
  // Creator/Admin can edit XP on default quests and set custom XP up to 100,000.
  const isDefault = !!editingTask?.is_default;
  const xpLocked = isDefault && !isAdmin;
  const xpMax = isAdmin ? 100000 : 20;

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

  useEffect(() => {
    if (!visible) return;
    if (editingTask) {
      setTitle(editingTask.title);
      setDesc(editingTask.description || '');
      setSlot(editingTask.time_slot);
      setArea(editingTask.focus_area);
      setXp(String(editingTask.xp_value));
      setReminderOn(!!editingTask.reminder_enabled);
      if (editingTask.scheduled_time) {
        const [h, m] = editingTask.scheduled_time.split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        setScheduledDate(d);
      }
    } else {
      setTitle('');
      setDesc('');
      setSlot('morning');
      setArea('fitness');
      setXp('20');
      setReminderOn(true);
      const d = new Date();
      d.setHours(8, 0, 0, 0);
      setScheduledDate(d);
    }
    setShowPicker(false);
  }, [visible, editingTask]);

  const onSlotChange = (s: TimeSlot) => {
    if (isDefault) return;
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
      if (isEdit && editingTask) {
        // For default tasks: only send editable fields. XP, focus_area,
        // time_slot and scheduled_time are all locked — EXCEPT for the
        // Creator/Admin who can edit XP on default quests too.
        const payload: any = {
          title: title.trim(),
          description: desc.trim(),
          reminder_enabled: reminderOn,
        };
        if (!isDefault) {
          payload.xp_value = parseInt(xp, 10) || 20;
          payload.focus_area = area;
          payload.time_slot = slot;
          payload.scheduled_time = scheduled_time;
        } else if (isAdmin) {
          // Admin-only: allow editing XP on default tasks
          const adminXp = parseInt(xp, 10);
          if (!isNaN(adminXp)) payload.xp_value = Math.max(1, Math.min(100000, adminXp));
        }
        const updated = await api.updateTask(editingTask.id, payload);
        if (updated.reminder_enabled && updated.scheduled_time) {
          await scheduleTaskNotification(updated);
        } else {
          await cancelTaskNotification(updated.id);
        }
      } else {
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
      }
      onSaved();
    } catch (e: any) {
      Alert.alert(isEdit ? 'Failed to save' : 'Failed to create quest', String(e.message || e));
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
        <ScrollView
          style={{ width: '100%' }}
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.modalSheet} testID="task-modal">
            <View style={styles.sheetHandle} />
            <View style={styles.sheetTitleRow}>
              <Text style={styles.modalTitle}>
                {isEdit ? 'Edit Quest' : 'New Quest'}
              </Text>
              {isDefault ? (
                <View style={styles.lockPill}>
                  <Ionicons name="lock-closed" size={10} color={colors.amber} />
                  <Text style={styles.lockPillText}>DEFAULT</Text>
                </View>
              ) : null}
            </View>

            {isDefault ? (
              <Text style={styles.defaultNote}>
                Focus area, time slot and XP are locked for default quests. You can still change the title,
                description and reminder.
              </Text>
            ) : null}

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

            <View style={styles.labelRow}>
              <Text style={styles.inputLabel}>Time Slot</Text>
              {isDefault ? <Ionicons name="lock-closed" size={11} color={colors.textMuted} /> : null}
            </View>
            <View style={styles.chipRow}>
              {SLOTS.map((s) => {
                const active = slot === s;
                const disabled = isDefault && !active;
                return (
                  <TouchableOpacity
                    key={s}
                    testID={`task-slot-${s}`}
                    onPress={() => onSlotChange(s)}
                    disabled={isDefault}
                    style={[
                      styles.chip,
                      active && styles.chipActive,
                      disabled && { opacity: 0.35 },
                    ]}
                  >
                    <Ionicons
                      name={slotMeta[s].icon as any}
                      size={14}
                      color={active ? colors.bg : colors.textSecondary}
                    />
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {slotMeta[s].label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.labelRow}>
              <Text style={styles.inputLabel}>Focus Area</Text>
              {isDefault ? <Ionicons name="lock-closed" size={11} color={colors.textMuted} /> : null}
            </View>
            <View style={styles.chipRow}>
              {AREAS.map((a) => {
                const m = focusMeta[a];
                const active = area === a;
                const disabled = isDefault && !active;
                return (
                  <TouchableOpacity
                    key={a}
                    testID={`task-area-${a}`}
                    onPress={() => !isDefault && setArea(a)}
                    disabled={isDefault}
                    style={[
                      styles.chip,
                      {
                        borderColor: m.color + (active ? '' : '55'),
                        backgroundColor: active ? m.color : 'transparent',
                      },
                      disabled && { opacity: 0.35 },
                    ]}
                  >
                    <Ionicons
                      name={m.icon as any}
                      size={14}
                      color={active ? colors.bg : m.color}
                    />
                    <Text style={[styles.chipText, { color: active ? colors.bg : m.color }]}>
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
                  {
                    backgroundColor: reminderOn ? colors.cyan : colors.surfaceGlass,
                    borderColor: reminderOn ? colors.cyan : colors.border,
                  },
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
                onPress={() => !isDefault && setShowPicker(true)}
                disabled={!reminderOn || isDefault}
                style={[
                  styles.timePickBtn,
                  (!reminderOn || isDefault) && { opacity: 0.4 },
                ]}
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

            <View style={styles.labelRow}>
              <Text style={styles.inputLabel}>
                XP Reward {xpLocked ? '' : `(max ${isAdmin ? '100000' : '20'})`}
              </Text>
              {xpLocked ? <Ionicons name="lock-closed" size={11} color={colors.textMuted} /> : null}
            </View>
            {xpLocked ? (
              <View style={styles.lockedXpRow} testID="task-xp-locked">
                <Ionicons name="flash" size={16} color={colors.amber} />
                <Text style={styles.lockedXpValue}>{xp} XP</Text>
                <Text style={styles.lockedXpHint}>Default quest — XP is locked</Text>
              </View>
            ) : (
              <TextInput
                testID="task-input-xp"
                keyboardType="number-pad"
                style={styles.input}
                value={xp}
                onChangeText={(t) => {
                  const cleaned = t.replace(/[^0-9]/g, '');
                  if (cleaned !== '') {
                    const n = parseInt(cleaned, 10);
                    if (n > xpMax) {
                      setXp(String(xpMax));
                      return;
                    }
                  }
                  setXp(cleaned);
                }}
                placeholderTextColor={colors.textMuted}
              />
            )}
            {!xpLocked ? (
              <Text style={styles.xpHint}>
                {isAdmin
                  ? 'Creator · Premium+ — XP up to 100,000 per quest.'
                  : 'Custom quests are capped at 20 XP each.'}
              </Text>
            ) : null}

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
                  <Text style={styles.saveText}>{isEdit ? 'Save changes' : 'Add Quest'}</Text>
                )}
              </TouchableOpacity>
            </View>
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
    paddingBottom: spacing.sm,
  },
  kicker: { color: colors.green, fontSize: 12, letterSpacing: 2, fontWeight: '800' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 2 },
  customCount: { color: colors.cyan, fontSize: 11, fontWeight: '800', marginTop: 4, letterSpacing: 0.5 },
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
  orderHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(0,217,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0,217,255,0.25)',
    marginBottom: spacing.md,
    alignSelf: 'flex-start',
  },
  orderHintText: { color: colors.cyan, fontSize: 11, fontWeight: '700' },
  slotHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: spacing.sm,
  },
  slotTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  slotLine: { flex: 1, height: 1, backgroundColor: colors.border },
  slotCount: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  emptyText: { color: colors.textMuted, fontSize: 13 },

  taskRow: { marginBottom: spacing.sm },
  taskCard: { paddingVertical: spacing.md, paddingHorizontal: spacing.md, position: 'relative' },
  taskDone: { opacity: 0.6 },
  taskInner: { flexDirection: 'row', alignItems: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  check: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskTitle: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  taskTitleDone: { textDecorationLine: 'line-through', color: colors.textMuted },
  taskDesc: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  taskMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: spacing.sm, flexWrap: 'wrap' },
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
  editBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,217,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0,217,255,0.35)',
  },
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
  actionSheet: {
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
  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    flex: 1,
  },
  lockPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.amber + '18',
    borderColor: colors.amber + '55',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  lockPillText: {
    color: colors.amber,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
  actionGroupLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: spacing.md,
    marginBottom: 6,
  },
  actionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceGlass,
    marginBottom: 6,
  },
  actionItemText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
  },
  defaultNote: {
    color: colors.amber,
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: colors.amber + '12',
    borderColor: colors.amber + '33',
    borderWidth: 1,
    padding: 10,
    borderRadius: radii.md,
    marginBottom: spacing.sm,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  modalTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
  inputLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: spacing.md,
    marginBottom: 6,
  },
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
  xpHint: { color: colors.textMuted, fontSize: 11, marginTop: 6, marginLeft: 4 },
  lockedXpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.amber + '44',
    borderStyle: 'dashed',
  },
  lockedXpValue: {
    color: colors.amber,
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  lockedXpHint: {
    color: colors.textMuted,
    fontSize: 11,
    fontStyle: 'italic',
    flex: 1,
    textAlign: 'right',
  },
  anonBanner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.md, borderRadius: radii.md,
    backgroundColor: colors.amber + '14', borderWidth: 1, borderColor: colors.amber + '55',
    marginBottom: spacing.md,
  },
  anonBannerTitle: { color: colors.amber, fontSize: 13, fontWeight: '900' },
  anonBannerDesc: { color: colors.textSecondary, fontSize: 11, marginTop: 2, lineHeight: 16 },
});
