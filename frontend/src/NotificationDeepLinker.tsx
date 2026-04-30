/**
 * NotificationDeepLinker — global listener that opens the right screen
 * when the user taps a push notification.
 *
 * Payload contract (set by the backend when firing the push):
 *   - type: "message"   → open /messages/{from_user_id}
 *   - type: "gift"      → open /points (future)
 *   - type: "suspended" → open /profile (future)
 *
 * Two Expo listeners are wired:
 *   - addNotificationResponseReceivedListener: fired when the user
 *     TAPS a push notification while the app is foregrounded OR the
 *     notification is delivered via the OS lock-screen.
 *   - getLastNotificationResponseAsync: catches the case where the app
 *     was completely closed and the user opened it from the
 *     notification — we read the "last response" on boot.
 *
 * Gated by a route-ready flag: we delay the navigation until the
 * expo-router stack has mounted (otherwise the replace() is dropped).
 * Because `useRouter` itself is available synchronously after the
 * layout mounts, a small `setTimeout(..., 0)` is enough.
 */
import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { Platform } from 'react-native';

function extractFromUserId(data: any): string | null {
  if (!data || typeof data !== 'object') return null;
  const id = data.from_user_id || data.fromUserId || data.user_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function NotificationDeepLinker() {
  const router = useRouter();
  // Guard against handling the same launch-notification twice (once from
  // getLastNotificationResponseAsync on boot, once from the live listener
  // that Android sometimes replays).
  const handledIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // No native notifications on web — bail cleanly to avoid a "not
    // implemented" warning in the browser preview.
    if (Platform.OS === 'web') return;

    const route = (data: any, responseId: string | undefined) => {
      try {
        if (responseId && handledIdsRef.current.has(responseId)) return;
        if (responseId) handledIdsRef.current.add(responseId);
        const type = (data?.type || '').toString();
        console.log('[NotifDeepLink] tap received. type=', type, 'data=', data);
        if (type === 'message') {
          const from = extractFromUserId(data);
          if (from) {
            // Small defer so expo-router has the stack ready before we
            // navigate (guards against a cold-start race where
            // addNotificationResponseReceivedListener fires before the
            // layout is mounted on Android).
            setTimeout(() => {
              router.push(`/messages/${from}`);
            }, 0);
          }
        }
        // Future: wire 'gift' / 'suspended' here.
      } catch (e) {
        console.warn('[NotifDeepLink] routing error:', e);
      }
    };

    // 1) Catch the cold-start case: app was quit, user tapped a push,
    //    app booted here. The last response is what brought them in.
    Notifications.getLastNotificationResponseAsync()
      .then((resp) => {
        if (resp) {
          route(resp.notification.request.content.data, resp.notification.request.identifier);
        }
      })
      .catch((e) => console.warn('[NotifDeepLink] getLast err:', e));

    // 2) Live listener for taps while the app is already running.
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      route(resp.notification.request.content.data, resp.notification.request.identifier);
    });

    return () => {
      sub.remove();
    };
  }, [router]);

  return null;
}
