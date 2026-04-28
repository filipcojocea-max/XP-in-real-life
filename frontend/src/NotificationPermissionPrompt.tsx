/**
 * NotificationPermissionPrompt — a friendly in-app modal that explains
 * WHY notifications matter for this app, then forwards the user to the
 * native OS permission dialog.
 *
 * Behaviour:
 *  - Mounted once at the root of the app (after auth).
 *  - On first launch (or after re-install) the OS permission status is
 *    `undetermined`; we display the modal so the user has context for
 *    the system prompt that follows.
 *  - "Allow notifications" → calls expo-notifications
 *    requestPermissionsAsync(), then schedules the daily motivational
 *    notifications for the user.
 *  - "Not now" → silently dismisses; we won't re-prompt automatically
 *    again, but the user can re-enable from system settings (or from a
 *    future Profile toggle).
 *  - We persist a `notif_prompt_v1` flag in AsyncStorage so the prompt
 *    is shown at most once per install.
 *  - Web is a no-op — push notifications aren't supported here.
 */
import React, { useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './theme';
import {
  ensureNotificationPermission,
  scheduleMotivationalNotifications,
} from './notifications';

const PROMPT_FLAG_KEY = 'notif_prompt_v1';

export function NotificationPermissionPrompt() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    (async () => {
      try {
        // Already shown once on this install? Don't bother the user again.
        const seen = await AsyncStorage.getItem(PROMPT_FLAG_KEY);
        if (seen === '1') return;

        // OS-level status — only prompt while it's still undetermined,
        // i.e. the user has neither granted nor explicitly denied yet.
        // If they've already granted we silently make sure the daily
        // motivational notifications are scheduled; if they've denied
        // we don't nag.
        const { status, canAskAgain } = await Notifications.getPermissionsAsync();
        if (cancelled) return;
        if (status === 'granted') {
          // Already granted — kick off the schedule and mark seen.
          scheduleMotivationalNotifications().catch(() => {});
          await AsyncStorage.setItem(PROMPT_FLAG_KEY, '1');
          return;
        }
        if (status === 'denied' && !canAskAgain) {
          // The OS will refuse a fresh request; respect that and stop.
          await AsyncStorage.setItem(PROMPT_FLAG_KEY, '1');
          return;
        }
        // Show our context-explaining modal first so the user knows
        // WHY we'd like to send notifications before iOS/Android shows
        // its own permission dialog.
        // Slight delay so it doesn't fight the splash screen.
        setTimeout(() => {
          if (!cancelled) setVisible(true);
        }, 800);
      } catch {
        // ignore — never let permission UX crash the app
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAllow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // ensureNotificationPermission triggers the OS-level prompt and
      // also creates the Android notification channel on first grant.
      const granted = await ensureNotificationPermission();
      if (granted) {
        // Background scheduling: arm the daily motivational push at all
        // four scheduled windows (morning/afternoon/evening/night).
        await scheduleMotivationalNotifications();
      }
    } catch {
      // ignore — keep the app alive
    } finally {
      try {
        await AsyncStorage.setItem(PROMPT_FLAG_KEY, '1');
      } catch {}
      setBusy(false);
      setVisible(false);
    }
  };

  const handleDismiss = async () => {
    if (busy) return;
    try {
      await AsyncStorage.setItem(PROMPT_FLAG_KEY, '1');
    } catch {}
    setVisible(false);
  };

  if (Platform.OS === 'web' || !visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleDismiss}
    >
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityRole="alert" testID="notif-perm-modal">
          <View style={styles.iconWrap}>
            <Ionicons name="notifications" size={32} color={colors.green} />
          </View>
          <Text style={styles.title}>Allow notifications?</Text>
          <Text style={styles.body}>
            Get gentle daily nudges to stay on your streak, finish your
            quests, and unlock XP — including your morning, afternoon,
            evening and night reminders. You can change this any time
            from your phone settings.
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity
              testID="notif-perm-deny"
              style={[styles.btn, styles.btnSecondary]}
              onPress={handleDismiss}
              disabled={busy}
              activeOpacity={0.8}
            >
              <Text style={styles.btnSecondaryText}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="notif-perm-allow"
              style={[styles.btn, styles.btnPrimary]}
              onPress={handleAllow}
              disabled={busy}
              activeOpacity={0.85}
            >
              <Text style={styles.btnPrimaryText}>
                {busy ? 'Asking…' : 'Allow notifications'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 16,
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderColor: colors.border,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(0, 255, 136, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  body: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 18,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  btn: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimary: {
    backgroundColor: colors.green,
  },
  btnPrimaryText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '700',
  },
  btnSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnSecondaryText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
});
