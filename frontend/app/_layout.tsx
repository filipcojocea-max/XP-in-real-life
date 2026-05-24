import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, AppState, Text } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { colors, applyAdminTheme, clearAdminTheme } from '../src/theme';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { api } from '../src/api';
import { enableAdminTextOverride, disableAdminTextOverride } from '../src/adminTextOverride';
import { ImmersiveProvider } from '../src/immersive';
import { RevealZone } from '../src/components/RevealZone';
import { NotificationPermissionPrompt } from '../src/NotificationPermissionPrompt';
import { PushTokenSync } from '../src/PushTokenSync';
import { NotificationDeepLinker } from '../src/NotificationDeepLinker';
import { enableAndroidImmersive, reassertAndroidImmersive } from '../src/androidImmersive';
import { SuspensionAlertModal } from '../src/components/SuspensionAlertModal';
import { GiftReceivedAlert } from '../src/components/GiftReceivedAlert';
import { LevelUpReviewModal } from '../src/components/LevelUpReviewModal';
import { useLevelUpDetector } from '../src/hooks/useLevelUpDetector';
import { StripeReturnHandler } from '../src/StripeReturnHandler';

/**
 * LevelUpPromptHost — wires the level-up detector hook to the modal.
 * Mounted inside <AuthGate> so it only runs when there's a signed-in
 * user (the hook itself no-ops when `user` is falsy, but mounting it
 * inside the gate also keeps the polling off the auth screens).
 */
function LevelUpPromptHost() {
  const { pending, clearPending } = useLevelUpDetector();
  if (!pending) return null;
  return (
    <LevelUpReviewModal
      visible
      level={pending.level}
      hasSubmittedFeedback={pending.hasSubmittedFeedback}
      hasClickedPlayStoreReview={pending.hasClickedPlayStoreReview}
      onClose={() => clearPending()}
    />
  );
}

// Keep the splash screen visible only until the JS bundle has finished
// evaluating the root component. Without this we can't predictably
// dismiss it ourselves and users on slow devices see a too-long splash
// while AuthContext bootstraps.
//
// `.catch(() => {})` swallows the (harmless) "already-prevented" race
// in fast-refresh / dev-client reloads.
SplashScreen.preventAutoHideAsync().catch(() => {});
// Hard timeout: if anything hangs, kill the splash after 1.5s no matter
// what — better to drop the user into the auth-gate skeleton than to
// stare at a frozen logo. This is the "font loading timeout" fix.
const SPLASH_HARD_TIMEOUT_MS = 1500;

function AuthGate({ children }: { children: React.ReactNode }) {
  const { loading, token, anonymousId } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const hasAccess = !!token || !!anonymousId;

  // Fetch profile on auth + segment change and, ONCE the fresh result is
  // in, decide whether the user still needs to answer the two day-anchor
  // onboarding questions. The redirect fires INSIDE the async block so
  // we never redirect based on stale state from the previous render —
  // this is what fixes the "onboarding repeats twice" bug.
  //
  // Previous implementation used a separate routing `useEffect` that
  // read `anchorMissing` / `anchorChecked` state. Because React batches
  // state updates across effects in the same render pass, the routing
  // effect saw the PREVIOUS render's `anchorMissing=true` value the
  // moment the user navigated away from `/day-anchor-setup`, and
  // bounced them right back to step 1 before the fresh fetch could
  // update the flag. Ripping that second effect out kills the race.
  useEffect(() => {
    let cancelled = false;
    if (loading || !hasAccess) return;
    (async () => {
      try {
        const p = await api.getProfile();
        if (cancelled) return;
        // Apply Premium+ golden text theme for the Creator/Admin globally.
        if (p.is_admin) {
          applyAdminTheme();
          enableAdminTextOverride();
        } else {
          clearAdminTheme();
          disableAdminTextOverride();
        }
        // Day-anchor gate. Considered DONE the moment the user has BOTH
        // `timezone` and `day_start_time` — we intentionally don't gate
        // on the `onboarding_tz_done` flag alone because legacy profiles
        // pre-date that field.
        const missing = !p.timezone || !p.day_start_time;
        if (!missing) return;
        const seg0 = segments[0];
        const onAnchorSetup = seg0 === 'day-anchor-setup';
        const inAuthGroup = seg0 === 'auth';
        const onOnboarding = seg0 === 'onboarding';
        if (!onAnchorSetup && !inAuthGroup && !onOnboarding) {
          router.replace('/day-anchor-setup');
        }
      } catch {
        // swallow — profile call may fail if user hasn't finished onboarding yet
      }
    })();
    return () => { cancelled = true; };
  }, [loading, hasAccess, token, anonymousId, segments[0]]);

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === 'auth';
    const isResetPage = inAuthGroup && segments[1] === 'reset-password';

    if (!hasAccess && !inAuthGroup) {
      router.replace('/auth/login');
      return;
    }
    if (token && inAuthGroup && !isResetPage) {
      router.replace('/');
      return;
    }
  }, [loading, hasAccess, token, segments, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.green} />
        <Text style={{ color: colors.textMuted, marginTop: 12, fontSize: 12, fontWeight: '700', letterSpacing: 1.5 }}>
          LOADING
        </Text>
      </View>
    );
  }
  return <>{children}</>;
}

export default function RootLayout() {
  // Hide the splash screen as soon as React has mounted the root tree,
  // and ALSO after a hard timeout so a wedged init never traps the
  // user behind the splash (the bug the user described as "font
  // loading timeout"). Both calls are idempotent — whichever fires
  // first wins and the second one's a no-op.
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
    const t = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, SPLASH_HARD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  // Hide the Samsung 3-button (or pill) navigation bar on Android the
  // moment the app boots, and re-assert hidden state when the OS gives
  // it back to us (e.g. after a permission dialog or returning from
  // background). Web/iOS no-ops cleanly.
  useEffect(() => {
    enableAndroidImmersive();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') reassertAndroidImmersive();
    });
    return () => sub.remove();
  }, []);
  return (
    <AuthProvider>
      <ImmersiveProvider>
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <StatusBar style="light" />
          <AuthGate>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
                animation: 'fade',
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="auth" />
              <Stack.Screen name="focus" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
              <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
              <Stack.Screen name="morning-setup" options={{ animation: 'fade' }} />
              <Stack.Screen name="day-anchor-setup" options={{ animation: 'fade', gestureEnabled: false }} />
              <Stack.Screen name="sleep" />
              <Stack.Screen name="challenges" />
              <Stack.Screen name="friends" />
              <Stack.Screen name="spot" />
              <Stack.Screen name="library-catalog" />
              <Stack.Screen name="messages" />
              <Stack.Screen name="admin" />
              <Stack.Screen name="feedback" />
              <Stack.Screen name="schedule" />
            </Stack>
            {/* Bottom 40-px swipe-up reveal target for Immersive Mode. */}
            <RevealZone />
            {/* On first launch, ask for notification permission so we
                can fire the daily motivational push at the user's
                scheduled times. */}
            <NotificationPermissionPrompt />
            {/* Fires on every authenticated launch and guarantees the
                device's Expo push token is registered with our backend
                (idempotent upsert). Without this mounted, users who
                granted permission on a previous install would silently
                never re-register their token and would stop receiving
                pushes forever. */}
            <PushTokenSync />
            {/* Deep-linker — listens for push-notification taps and
                opens the right screen. Currently handles DM pushes by
                routing to /messages/{fromUserId}. */}
            <NotificationDeepLinker />
            {/* Global suspension alert — fires whenever the API returns
                a 403 account_suspended on any request. The user is
                already signed-out by AuthProvider; this just shows
                them the golden reason + time-remaining. */}
            <SuspensionAlertModal />
            <GiftReceivedAlert />
            {/* Level-up review prompt — fires once per crossed L2..L6
                milestone. Self-contained: detector hook polls profile,
                modal handles store-review CTA + tip link + feedback. */}
            <LevelUpPromptHost />
            {/* Listens for the deep-link from /api/payments/return after
                Stripe Checkout, verifies the session, and surfaces a
                confirmation alert if the webhook hasn't already
                inserted the OWNED row. */}
            <StripeReturnHandler />
          </AuthGate>
        </View>
      </ImmersiveProvider>
    </AuthProvider>
  );
}
