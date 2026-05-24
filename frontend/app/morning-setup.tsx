import React from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import MorningTimePicker from '../src/components/MorningTimePicker';
import { api } from '../src/api';
import { showAlert } from '../src/uiAlert';
import { colors } from '../src/theme';

/**
 * Standalone morning-time picker screen — kept around so we can route here
 * later from Profile ("Edit my morning time") if/when needed. The picker UI
 * itself lives in /src/components/MorningTimePicker.tsx and is also embedded
 * directly inside the Challenge Tasks mini-app (first-launch experience).
 */
export default function MorningSetup() {
  const params = useLocalSearchParams<{ initial?: string }>();
  const initial = typeof params.initial === 'string' ? params.initial : undefined;

  const onDone = async (wakeTime: string) => {
    try {
      await api.completeMorningSetup(wakeTime);
      router.replace('/');
    } catch (e: any) {
      showAlert('Could not save', String(e?.message || e));
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <MorningTimePicker
        initialTime={initial}
        onDone={onDone}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
});
