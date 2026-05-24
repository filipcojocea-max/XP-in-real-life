/**
 * Build Self-Confidence — Library+ mini-app landing page.
 *
 * Four tracks, each a separate sub-screen:
 *   - Social Speaking   (daily speaking challenge)
 *   - Physical Appearance (daily body/posture challenge)
 *   - Dress with Confidence (AI outfit coach)
 *   - No Negative Thinking (gratitude + affirmations)
 *
 * The landing page pulls `/confidence/daily` once so the three
 * non-AI cards can preview today's challenge title + completion state
 * (a green check next to tracks already finished today).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { api, ConfidenceChallenge } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

type Daily = { social: ConfidenceChallenge; physical: ConfidenceChallenge; gratitude: ConfidenceChallenge };

export default function ConfidenceLanding() {
  const [daily, setDaily] = useState<Daily | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.confidenceDaily();
      setDaily({ social: r.social, physical: r.physical, gratitude: r.gratitude });
    } catch (e: any) {
      showAlert('Could not load', String(e?.message || e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Reload every time the landing page comes back into focus so the
  // completion ticks reflect what the user just finished in a sub-screen.
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Build Self-Confidence</Text>
        <View style={{ width: 32 }} />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: 64 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.cyan} />}
      >
        <Text style={styles.kicker}>FOUR TRACKS · ONE STRONGER YOU</Text>
        <Text style={styles.subtitle}>Small, specific, daily. Pick any track today — they all change tomorrow.</Text>

        {loading ? (
          <ActivityIndicator color={colors.cyan} style={{ marginVertical: 32 }} />
        ) : (
          <>
            <TrackCard
              onPress={() => router.push('/confidence/social')}
              icon="chatbubbles"
              accent={colors.cyan}
              title="Social Speaking"
              subtitle="Daily speaking challenges"
              preview={daily?.social.title}
              done={!!daily?.social.done}
              testID="conf-card-social"
            />
            <TrackCard
              onPress={() => router.push('/confidence/physical')}
              icon="body"
              accent={colors.green}
              title="Physical Appearance"
              subtitle="Posture, movement, presence"
              preview={daily?.physical.title}
              done={!!daily?.physical.done}
              testID="conf-card-physical"
            />
            <TrackCard
              onPress={() => router.push('/confidence/dress')}
              icon="shirt"
              accent={'#FFD700'}
              title="Dress with Confidence"
              subtitle="AI outfit coach · photo + chat"
              preview="Snap a selfie and ask the coach"
              done={false}
              testID="conf-card-dress"
            />
            <TrackCard
              onPress={() => router.push('/confidence/gratitude')}
              icon="sparkles"
              accent={'#ff9fd0'}
              title="No Negative Thinking"
              subtitle="Only grateful minds"
              preview={daily?.gratitude.title}
              done={!!daily?.gratitude.done}
              testID="conf-card-gratitude"
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function TrackCard({ onPress, icon, accent, title, subtitle, preview, done, testID }: {
  onPress: () => void; icon: React.ComponentProps<typeof Ionicons>['name']; accent: string;
  title: string; subtitle: string; preview?: string; done: boolean; testID?: string;
}) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[styles.card, { borderColor: accent + '66' }]} testID={testID}>
      <View style={[styles.iconWrap, { backgroundColor: accent + '22', borderColor: accent + '88' }]}>
        <Ionicons name={icon} size={22} color={accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>{title}</Text>
          {done ? <Ionicons name="checkmark-circle" size={16} color={colors.green} /> : null}
        </View>
        <Text style={styles.cardSubtitle} numberOfLines={1}>{subtitle}</Text>
        {preview ? <Text style={styles.cardPreview} numberOfLines={2}>{preview}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontWeight: '900', fontSize: 17 },
  kicker: { color: colors.cyan, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    padding: spacing.md, borderRadius: radii.md,
    backgroundColor: colors.surface, borderWidth: 1,
    minHeight: 76,
  },
  iconWrap: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  cardTitle: { color: colors.text, fontWeight: '800', fontSize: 15 },
  cardSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  cardPreview: { color: colors.text, fontSize: 12, marginTop: 4, opacity: 0.8 },
});
