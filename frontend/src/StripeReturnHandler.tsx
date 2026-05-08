/**
 * StripeReturnHandler — listens for the deep link
 * `xpinreallife://payments/return?status=...&session_id=...` that the
 * /api/payments/return HTML page redirects to after Stripe Checkout.
 *
 * On `success` we hit /payments/session/{id}/verify to finalize OWNED
 * state (handles the case where the webhook hasn't fired yet) and
 * surface a small toast/alert to confirm. On `cancel` we just no-op
 * silently — the user is already back inside the app.
 *
 * Also parses the equivalent web-style query string
 * `?stripe_status=success&stripe_session=cs_test_...` from the URL on
 * web so the same flow works in the browser preview.
 */
import { useEffect, useRef } from 'react';
import * as Linking from 'expo-linking';
import { Alert, Platform } from 'react-native';
import { api } from './api';

export function StripeReturnHandler() {
  const handledSessions = useRef<Set<string>>(new Set());

  const handle = async (status: string, sessionId: string) => {
    if (!sessionId) return;
    if (handledSessions.current.has(sessionId)) return;
    handledSessions.current.add(sessionId);
    if (status !== 'success') return; // cancel = silent no-op
    // Allow webhook a tiny head start; then poll-verify a few times in
    // case it lands a moment after the user returns.
    const tryVerify = async (attempt: number) => {
      try {
        const r = await api.paymentsVerifySession(sessionId);
        if (r.paid) {
          const label = r.app_id || 'mini-app';
          Alert.alert(
            'Purchase complete 🎉',
            `Your ${label} is now unlocked. Enjoy!`,
          );
          return true;
        }
      } catch {
        // session not paid / not yet recorded — retry
      }
      return false;
    };
    for (let i = 0; i < 4; i++) {
      const done = await tryVerify(i);
      if (done) return;
      await new Promise((res) => setTimeout(res, 1500));
    }
  };

  useEffect(() => {
    // 1. Initial deep link (cold start)
    Linking.getInitialURL().then((url) => {
      if (!url) return;
      const parsed = Linking.parse(url);
      const qp = (parsed.queryParams || {}) as Record<string, string>;
      const status = String(qp.status || qp.stripe_status || '');
      const sessionId = String(qp.session_id || qp.stripe_session || '');
      if (status && sessionId) handle(status, sessionId);
    });

    // 2. Live deep links while app is open
    const sub = Linking.addEventListener('url', (evt) => {
      const parsed = Linking.parse(evt.url);
      const qp = (parsed.queryParams || {}) as Record<string, string>;
      const status = String(qp.status || qp.stripe_status || '');
      const sessionId = String(qp.session_id || qp.stripe_session || '');
      if (status && sessionId) handle(status, sessionId);
    });

    // 3. Web — also peek at window.location on mount
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      try {
        const u = new URL(window.location.href);
        const status = u.searchParams.get('stripe_status') || '';
        const sessionId = u.searchParams.get('stripe_session') || '';
        if (status && sessionId) {
          handle(status, sessionId).then(() => {
            // Clean the query string so a refresh doesn't re-trigger.
            try {
              u.searchParams.delete('stripe_status');
              u.searchParams.delete('stripe_session');
              window.history.replaceState({}, '', u.toString());
            } catch {}
          });
        }
      } catch {}
    }

    return () => {
      try { sub.remove(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
