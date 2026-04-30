/**
 * PushTokenSync — runs on every authenticated launch. Ensures the
 * device's Expo push token is registered with our backend so that
 * Creator DMs, gift announcements and daily motivational pushes can
 * actually be delivered.
 *
 * Why this exists separately from NotificationPermissionPrompt:
 *   - That prompt only runs on the FIRST launch after install to ask
 *     for permission. If the user has already granted permission (e.g.
 *     via system settings, or on a previous install), the prompt never
 *     shows and the token never gets registered. That leaves the
 *     backend with no valid destination for future pushes.
 *   - This hook fires unconditionally on every signed-in launch and
 *     registers the token whenever the OS reports `granted`, making
 *     the registration process idempotent and bullet-proof.
 *
 * Audit-friendly logging:
 *   - Every step prints via `console.log('[PushTokenSync] …')` so we
 *     can trace exactly why a device never registered. Previously all
 *     errors were silently swallowed with `.catch(() => {})`.
 *   - The EAS `projectId` is passed to `getExpoPushTokenAsync()` which
 *     is REQUIRED in standalone/EAS builds — without it the call
 *     throws `"No projectId found"` and the token is never obtained.
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useAuth } from './AuthContext';
import { api } from './api';

function getExpoProjectId(): string | undefined {
  // expo-constants exposes EAS config via expoConfig.extra.eas.projectId
  // (SDK 49+). We fall back to the older shape just in case.
  const cfg: any = Constants?.expoConfig ?? (Constants as any)?.manifest;
  return cfg?.extra?.eas?.projectId;
}

export function PushTokenSync() {
  const { token: jwt } = useAuth();

  useEffect(() => {
    console.log('[PushTokenSync] mount effect fired. jwt?', !!jwt, 'platform:', Platform.OS);
    if (!jwt) {
      console.log('[PushTokenSync] skip — no JWT yet');
      return;
    }
    // Web can't receive native push; skip. (Expo fires warnings otherwise.)
    if (Platform.OS === 'web') {
      console.log('[PushTokenSync] skip — web platform does not support native push');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const perm = await Notifications.getPermissionsAsync();
        console.log('[PushTokenSync] OS permission status:', perm.status, 'canAskAgain:', perm.canAskAgain);
        if (cancelled) return;
        if (perm.status !== 'granted') {
          console.log('[PushTokenSync] permission not granted — bailing. Prompt component will handle.');
          return;
        }

        const projectId = getExpoProjectId();
        console.log('[PushTokenSync] EAS projectId:', projectId);
        if (!projectId) {
          console.warn('[PushTokenSync] ⚠ No EAS projectId found in app.json → getExpoPushTokenAsync will fail on standalone builds.');
        }

        let tokenRes;
        try {
          tokenRes = projectId
            ? await Notifications.getExpoPushTokenAsync({ projectId })
            : await Notifications.getExpoPushTokenAsync();
        } catch (e: any) {
          console.error('[PushTokenSync] ❌ getExpoPushTokenAsync THREW:', e?.message || e);
          return;
        }
        const pushToken = tokenRes?.data;
        console.log('[PushTokenSync] expo push token:', pushToken ? pushToken.slice(0, 40) + '…' : '(none)');
        if (cancelled || !pushToken) {
          console.warn('[PushTokenSync] no token returned — aborting registration');
          return;
        }

        try {
          const res = await api.pushRegisterToken(pushToken, Platform.OS);
          console.log('[PushTokenSync] ✅ backend registration OK:', res);
        } catch (e: any) {
          console.error('[PushTokenSync] ❌ backend registration FAILED:', e?.message || e);
        }
      } catch (e: any) {
        console.error('[PushTokenSync] unexpected error:', e?.message || e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jwt]);

  return null;
}
