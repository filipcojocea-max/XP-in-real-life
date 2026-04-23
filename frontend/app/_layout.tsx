import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { colors } from '../src/theme';

export default function RootLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="focus" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        <Stack.Screen name="miniapp/anxiety" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="miniapp/posture" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="miniapp/affirmations" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="miniapp/cold-shower" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="miniapp/gratitude" options={{ animation: 'slide_from_right' }} />
      </Stack>
    </View>
  );
}
