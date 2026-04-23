import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import Ring from '../../src/components/Ring';
import Card from '../../src/components/Card';
import MotivationBanner from '../../src/components/MotivationBanner';
import { api, Profile, DailyStats } from '../../src/api';
import { colors, focusMeta, spacing, radii } from '../../src/theme';
import { scheduleMotivationalNotifications, pickMotivation } from '../../src/notifications';

export default function Home() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [daily, setDaily] = useState<DailyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [motivation, setMotivation] = useState<string>(() => pickMotivation());

  const load = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([api.getProfile(), api.statsDaily()]);
      setProfile(p);
      setDaily(d);
      if (!p.onboarding_complete) {
        router.replace('/onboarding');
        return;
      }
      if (d.total_tasks === 0) {
        await api.seed().catch(() => null);
        const d2 = await api.statsDaily();
        setDaily(d2);
      }
    } catch (e) {
      console.log('home load error', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    load();
    scheduleMotivationalNotifications().catch(() => {});
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (loading || !profile || !daily) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loading}>
          <ActivityIndicator color={colors.green} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const xpPct = profile.is_max_level ? 1 : profile.xp_progress;
  const totalProgress =
    daily.total_tasks === 0 ? 0 : daily.total_done / daily.total_tasks;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={colors.green}
          />
        }
      >
        {/* Greeting */}
        <View style={styles.header}>
          <View>
            <Text testID="home-greeting" style={styles.hello}>
              Welcome back
            </Text>
            <Text style={styles.name}>{profile.name}</Text>
          </View>
          <TouchableOpacity
            testID="home-focus-btn"
            style={styles.focusChip}
            onPress={() => router.push('/focus')}
          >
            <Ionicons name="lock-closed" size={14} color={colors.cyan} />
            <Text style={styles.focusChipText}>Focus Mode</Text>
          </TouchableOpacity>
        </View>

        {/* Motivational banner with rotating green+cyan border */}
        <MotivationBanner
          testID="motivation-banner"
          message={motivation}
          onPress={() => {
            setMotivation(pickMotivation());
            router.push('/tasks');
          }}
        />

        {/* Hero emblem */}
        <View style={styles.heroWrap}>
          <Ring size={260} stroke={10} progress={xpPct} color={colors.amber} glow>
            <View style={styles.emblemCore}>
              <View style={styles.emblemGlow} />
              <Ionicons name="shield" size={88} color={colors.cyan} />
              <View style={styles.emblemInner}>
                <Ionicons name="flash" size={32} color={colors.green} />
              </View>
            </View>
          </Ring>

          <View style={styles.levelBadge} testID="home-level-badge">
            <Text style={styles.levelLabel}>LEVEL</Text>
            <Text style={styles.levelNumber}>{profile.level}</Text>
          </View>

          <View style={styles.xpRow} testID="home-xp-row">
            <Text style={styles.xpText}>
              {profile.is_max_level
                ? `${profile.total_xp} XP · MAX`
                : `${profile.xp_in_level} / ${profile.xp_to_next} XP`}
            </Text>
            <Text style={styles.xpSub}>
              {profile.is_max_level ? 'Peak Level Reached' : `${profile.xp_to_next - profile.xp_in_level} XP to Lv ${profile.level + 1}`}
            </Text>
          </View>
        </View>

        {/* Quick stats */}
        <View style={styles.statsRow}>
          <Card style={styles.statCard}>
            <Ionicons name="flame" size={22} color={colors.amber} />
            <Text style={styles.statValue} testID="home-streak">
              {profile.current_streak}
            </Text>
            <Text style={styles.statLabel}>Day Streak</Text>
          </Card>
          <Card style={styles.statCard}>
            <Ionicons name="checkmark-done" size={22} color={colors.green} />
            <Text style={styles.statValue} testID="home-today-tasks">
              {daily.total_done}/{daily.total_tasks}
            </Text>
            <Text style={styles.statLabel}>Today's Quests</Text>
          </Card>
          <Card style={styles.statCard}>
            <Ionicons name="sparkles" size={22} color={colors.cyan} />
            <Text style={styles.statValue} testID="home-xp-today">
              +{daily.xp_today}
            </Text>
            <Text style={styles.statLabel}>XP Today</Text>
          </Card>
        </View>

        {/* Daily completion rings */}
        <Text style={styles.sectionTitle}>Daily Focus Rings</Text>
        <View style={styles.ringsGrid}>
          {(Object.keys(focusMeta) as (keyof typeof focusMeta)[]).map((key) => {
            const r = daily.rings[key];
            const meta = focusMeta[key];
            return (
              <Card key={key} style={styles.ringCard} accent={meta.color} testID={`ring-card-${key}`}>
                <Ring size={96} stroke={9} progress={r.progress} color={meta.color}>
                  <Ionicons name={meta.icon as any} size={26} color={meta.color} />
                </Ring>
                <Text style={styles.ringLabel}>{meta.label}</Text>
                <Text style={styles.ringProgress}>
                  {r.done}/{r.total}
                </Text>
              </Card>
            );
          })}
        </View>

        {/* Daily overall progress */}
        <Card style={styles.overallCard}>
          <View style={styles.overallHeader}>
            <Text style={styles.overallTitle}>Today's Overall</Text>
            <Text style={styles.overallPct}>{Math.round(totalProgress * 100)}%</Text>
          </View>
          <View style={styles.bar}>
            <View
              style={[
                styles.barFill,
                { width: `${Math.max(4, totalProgress * 100)}%` },
              ]}
            />
          </View>
          <Text style={styles.overallCaption}>
            {daily.total_done === daily.total_tasks && daily.total_tasks > 0
              ? 'All quests cleared. Legendary.'
              : `${daily.total_tasks - daily.total_done} quests remaining`}
          </Text>
        </Card>

        <TouchableOpacity
          testID="home-cta-tasks"
          style={styles.cta}
          onPress={() => router.push('/tasks')}
        >
          <Text style={styles.ctaText}>Go to Today's Quests</Text>
          <Ionicons name="arrow-forward" size={18} color={colors.bg} />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  hello: { color: colors.textMuted, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  name: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 2 },
  focusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.cyan + '66',
    backgroundColor: colors.cyan + '12',
  },
  focusChipText: { color: colors.cyan, fontSize: 12, fontWeight: '700' },

  heroWrap: { alignItems: 'center', marginVertical: spacing.lg },
  emblemCore: {
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emblemGlow: {
    position: 'absolute',
    width: 180,
    height: 180,
    borderRadius: 100,
    backgroundColor: colors.cyan,
    opacity: 0.12,
  },
  emblemInner: {
    position: 'absolute',
    bottom: 54,
  },
  levelBadge: {
    marginTop: -18,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.green,
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  levelLabel: { color: colors.green, fontSize: 11, letterSpacing: 2, fontWeight: '800' },
  levelNumber: { color: colors.text, fontSize: 22, fontWeight: '900', letterSpacing: -1 },
  xpRow: { alignItems: 'center', marginTop: spacing.md },
  xpText: { color: colors.amber, fontSize: 18, fontWeight: '800' },
  xpSub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },

  statsRow: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.md },
  statCard: { flex: 1, alignItems: 'center', paddingVertical: spacing.md },
  statValue: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 4 },
  statLabel: { color: colors.textMuted, fontSize: 11, marginTop: 2, textAlign: 'center' },

  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  ringsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  ringCard: {
    width: '48.5%',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  ringLabel: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: spacing.sm },
  ringProgress: { color: colors.textMuted, fontSize: 12, marginTop: 2 },

  overallCard: { marginTop: spacing.md },
  overallHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  overallTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  overallPct: { color: colors.green, fontSize: 18, fontWeight: '900' },
  bar: {
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: radii.pill,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: colors.green,
    borderRadius: radii.pill,
  },
  overallCaption: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },

  cta: {
    marginTop: spacing.lg,
    backgroundColor: colors.green,
    paddingVertical: 16,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    shadowColor: colors.green,
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
  },
  ctaText: { color: colors.bg, fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
});
