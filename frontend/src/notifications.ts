import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Task } from './api';

let permissionGranted: boolean | null = null;
let handlerConfigured = false;

function configureHandler() {
  if (handlerConfigured) return;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowAlert: true,
      }),
    });
    handlerConfigured = true;
  } catch {
    // ignore (web / unsupported)
  }
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  configureHandler();
  if (permissionGranted !== null) return permissionGranted;
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    permissionGranted = finalStatus === 'granted';

    if (Platform.OS === 'android' && permissionGranted) {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'LevelUp Quests',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#00FF88',
      });
    }
    return permissionGranted;
  } catch (e) {
    console.log('notification perm err', e);
    permissionGranted = false;
    return false;
  }
}

function parseHHMM(t?: string | null): { hour: number; minute: number } | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Cancel any previously-scheduled notification identified by taskId.
 */
export async function cancelTaskNotification(taskId: string) {
  if (Platform.OS === 'web') return;
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const n of scheduled) {
      if (n.content?.data && (n.content.data as any).taskId === taskId) {
        await Notifications.cancelScheduledNotificationAsync(n.identifier);
      }
    }
  } catch (e) {
    console.log('cancel err', e);
  }
}

/**
 * Schedule a daily repeating notification for a task at its scheduled_time.
 * Silently skips on web or when time is invalid / reminder disabled.
 */
export async function scheduleTaskNotification(task: Task): Promise<void> {
  if (Platform.OS === 'web') return;
  await cancelTaskNotification(task.id);

  if (!task.reminder_enabled) return;
  const t = parseHHMM(task.scheduled_time);
  if (!t) return;

  const granted = await ensureNotificationPermission();
  if (!granted) return;

  try {
    await Notifications.scheduleNotificationAsync({
      identifier: `levelup-${task.id}`,
      content: {
        title: `Quest Time: ${task.title}`,
        body: `Complete it to earn +${task.xp_value} XP`,
        data: { taskId: task.id },
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
        hour: t.hour,
        minute: t.minute,
        repeats: true,
      },
    });
  } catch (e) {
    console.log('schedule err', e);
  }
}

/**
 * Reconcile all task reminders with scheduled local notifications.
 * Clears notifications for tasks no longer present.
 */
export async function syncAllTaskNotifications(tasks: Task[]) {
  if (Platform.OS === 'web') return;
  const granted = await ensureNotificationPermission();
  if (!granted) return;
  try {
    const existing = await Notifications.getAllScheduledNotificationsAsync();
    const existingIds = new Set(
      existing
        .map((n) => (n.content?.data as any)?.taskId)
        .filter((x): x is string => typeof x === 'string'),
    );
    const currentIds = new Set(tasks.map((t) => t.id));
    // Cancel orphans
    for (const n of existing) {
      const tid = (n.content?.data as any)?.taskId;
      if (tid && !currentIds.has(tid)) {
        await Notifications.cancelScheduledNotificationAsync(n.identifier);
      }
    }
    // Schedule missing or re-sync (cancel+schedule) those with reminders
    for (const task of tasks) {
      if (task.reminder_enabled && task.scheduled_time) {
        if (!existingIds.has(task.id)) {
          await scheduleTaskNotification(task);
        }
      } else if (existingIds.has(task.id)) {
        await cancelTaskNotification(task.id);
      }
    }
  } catch (e) {
    console.log('sync err', e);
  }
}
