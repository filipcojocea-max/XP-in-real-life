import { Stack } from 'expo-router';

export default function SleepLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="onboarding" options={{ animation: 'slide_from_bottom' }} />
    </Stack>
  );
}
