import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '../src/theme';
import { AuthProvider, useAuth } from '../src/AuthContext';

function AuthGate({ children }: { children: React.ReactNode }) {
  const { loading, token, anonymousId } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const hasAccess = !!token || !!anonymousId;

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === 'auth';
    if (!hasAccess && !inAuthGroup) {
      router.replace('/auth/login');
    } else if (hasAccess && inAuthGroup) {
      router.replace('/');
    }
  }, [loading, hasAccess, segments, router]);

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
            <Stack.Screen name="sleep" />
          </Stack>
        </AuthGate>
      </View>
    </AuthProvider>
  );
}
