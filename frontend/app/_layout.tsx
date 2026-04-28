import React, { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator } from 'react-native';
import { colors, applyAdminTheme, clearAdminTheme } from '../src/theme';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { api } from '../src/api';
import { enableAdminTextOverride, disableAdminTextOverride } from '../src/adminTextOverride';
import { ImmersiveProvider } from '../src/immersive';
import { RevealZone } from '../src/components/RevealZone';
import { NotificationPermissionPrompt } from '../src/NotificationPermissionPrompt';

function AuthGate({ children }: { children: React.ReactNode }) {
  const { loading, token, anonymousId } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const hasAccess = !!token || !!anonymousId;
  const [anchorChecked, setAnchorChecked] = useState(false);
  const [anchorMissing, setAnchorMissing] = useState(false);

  // Poll profile once we have access; force day-anchor setup if missing.
  // Re-runs on segment change so that after /day-anchor-setup navigates away
  // (via setDayAnchor → router.replace('/')), we re-check against fresh data
  // instead of bouncing the user back into the setup flow on stale state.
  useEffect(() => {
    let cancelled = false;
    if (loading || !hasAccess) {
      setAnchorChecked(false);
      setAnchorMissing(false);
      return;
    }
    (async () => {
      try {
        const p = await api.getProfile();
        if (cancelled) return;
        // The day-anchor onboarding is considered DONE the moment a user
        // has BOTH a timezone and a day_start_time on their profile. We
        // intentionally don't gate on `onboarding_tz_done` alone — that
        // flag was added later and may be missing/false on legacy
        // profiles from before the field existed. Without this guard,
        // an app update would re-prompt those users to choose timezone
        // & morning time even though they already have. Once both
        // values are present, the prompt is gone for good.
        const missing = !p.timezone || !p.day_start_time;
        setAnchorMissing(!!missing);
        // Apply Premium+ golden text theme for the Creator/Admin globally.
        if (p.is_admin) {
          applyAdminTheme();
          enableAdminTextOverride();
        } else {
          clearAdminTheme();
          disableAdminTextOverride();
        }
      } catch {
        // swallow — profile call may fail if user hasn't finished onboarding yet
      } finally {
        if (!cancelled) setAnchorChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, [loading, hasAccess, token, anonymousId, segments[0]]);

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === 'auth';
    const isResetPage = inAuthGroup && segments[1] === 'reset-password';
    const onAnchorSetup = segments[0] === 'day-anchor-setup';
    const onOnboarding = segments[0] === 'onboarding';

    if (!hasAccess && !inAuthGroup) {
      router.replace('/auth/login');
      return;
    }
    if (token && inAuthGroup && !isResetPage) {
      router.replace('/');
      return;
    }
    // Force day-anchor questions when they haven't been answered.
    if (
      hasAccess &&
      anchorChecked &&
      anchorMissing &&
      !onAnchorSetup &&
      !inAuthGroup &&
      !onOnboarding
    ) {
      router.replace('/day-anchor-setup');
    }
  }, [loading, hasAccess, token, segments, router, anchorChecked, anchorMissing]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.green} />
      </View>
    );
  }
  return <>{children}</>;
}

export default function RootLayout() {
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
            </Stack>
            {/* Bottom 40-px swipe-up reveal target for Immersive Mode. */}
            <RevealZone />
            {/* On first launch, ask for notification permission so we
                can fire the daily motivational push at the user's
                scheduled times. */}
            <NotificationPermissionPrompt />
          </AuthGate>
        </View>
      </ImmersiveProvider>
    </AuthProvider>
  );
}
