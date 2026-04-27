import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import Svg, { Rect, Line, Text as SvgText } from 'react-native-svg';
import Card from '../../src/components/Card';
import PointsPlusModal from '../../src/components/PointsPlusModal';
import { api, WeeklyStats, Profile, Achievement } from '../../src/api';
import { colors, focusMeta, spacing, radii, FocusArea } from '../../src/theme';

const AREAS: FocusArea[] = ['social', 'fitness', 'appearance', 'mindset'];

export default function Progress() {
  const [weekly, setWeekly] = useState<WeeklyStats | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [byArea, setByArea] = useState<Record<FocusArea, number> | null>(null);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPointsPlus, setShowPointsPlus] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, p, a, ach] = await Promise.all([
        api.statsWeekly(),
        api.getProfile(),
        api.statsByArea(),
        api.achievements(),
      ]);
      setWeekly(w);
      setProfile(p);
      setByArea(a.by_area);
      setAchievements(ach.achievements);
    } catch (e) {
      console.log('progress', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading || !weekly || !profile || !byArea) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loading}>
          <ActivityIndicator color={colors.green} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const maxXp = Math.max(1, ...weekly.days.map((d) => d.xp));
  const chartW = 320;
  const chartH = 160;
  const pad = 24;
  const barW = (chartW - pad * 2) / weekly.days.length - 6;
  const totalWeekXp = weekly.days.reduce((s, d) => s + d.xp, 0);
  const totalAreaXp = Object.values(byArea).reduce((s, v) => s + v, 0);

  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.topBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.kicker}>Progress</Text>
            <Text style={styles.title}>Your Ascension</Text>
          </View>
          <TouchableOpacity
            testID="points-plus-btn"
            onPress={() => setShowPointsPlus(true)}
            activeOpacity={0.85}
            style={styles.pointsPlusBtn}
          >
            <Ionicons name="flash" size={14} color={colors.bg} />
            <Text style={styles.pointsPlusText}>Points+</Text>
            {profile.active_boost ? (
              <View style={styles.pointsPlusActiveDot} />
            ) : null}
          </TouchableOpacity>
        </View>

        {/* Top stat cards */}
        <View style={styles.row}>
          <Card style={styles.stat}>
            <Ionicons name="diamond" size={22} color={colors.cyan} />
            <Text style={styles.statVal} testID="stat-total-xp">{profile.total_xp}</Text>
            <Text style={styles.statLbl}>Total XP</Text>
          </Card>
          <Card style={styles.stat}>
            <Ionicons name="trending-up" size={22} color={colors.green} />
            <Text style={styles.statVal}>Lv {profile.level}</Text>
            <Text style={styles.statLbl}>Character Level</Text>
          </Card>
          <Card style={styles.stat}>
            <Ionicons name="trophy" size={22} color={colors.amber} />
            <Text style={styles.statVal}>{profile.longest_streak}</Text>
            <Text style={styles.statLbl}>Best Streak</Text>
          </Card>
        </View>

        {/* Weekly XP chart */}
        <Card style={styles.chartCard}>
          <View style={styles.chartHead}>
            <Text style={styles.sectionTitle}>Weekly XP</Text>
            <Text style={styles.chartTotal}>+{totalWeekXp} XP</Text>
          </View>
          <Svg width={chartW} height={chartH}>
            <Line
              x1={pad}
              y1={chartH - pad}
              x2={chartW - pad}
              y2={chartH - pad}
              stroke={colors.border}
              strokeWidth={1}
            />
            {weekly.days.map((d, i) => {
              const h = ((chartH - pad * 2) * d.xp) / maxXp;
              const x = pad + i * ((chartW - pad * 2) / weekly.days.length) + 3;
              const y = chartH - pad - h;
              return (
                <React.Fragment key={d.date}>
                  <Rect
                    x={x}
                    y={y}
                    width={barW}
                    height={Math.max(2, h)}
                    rx={4}
                    fill={d.xp > 0 ? colors.green : 'rgba(255,255,255,0.1)'}
                  />
                  <SvgText
                    x={x + barW / 2}
                    y={chartH - pad + 14}
                    fontSize="10"
                    fontWeight="700"
                    fill={colors.textMuted}
                    textAnchor="middle"
                  >
                    {d.day}
                  </SvgText>
                </React.Fragment>
              );
            })}
          </Svg>
        </Card>

        {/* Confidence metric / by area */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={styles.sectionTitle}>Confidence Metric</Text>
          <Text style={styles.sectionSub}>XP distribution per focus area (all time)</Text>
          {AREAS.map((a) => {
            const meta = focusMeta[a];
            const v = byArea[a] || 0;
            const pct = totalAreaXp > 0 ? v / totalAreaXp : 0;
            return (
              <View key={a} style={styles.areaRow} testID={`area-stat-${a}`}>
                <View style={styles.areaLabel}>
                  <Ionicons name={meta.icon as any} size={14} color={meta.color} />
                  <Text style={styles.areaName}>{meta.label}</Text>
                </View>
                <View style={styles.areaBarWrap}>
                  <View style={[styles.areaBarFill, { width: `${Math.max(3, pct * 100)}%`, backgroundColor: meta.color }]} />
                </View>
                <Text style={styles.areaValue}>{v}</Text>
              </View>
            );
          })}
        </Card>

        {/* Achievements */}
        <View style={styles.achHead}>
          <Text style={styles.sectionTitle}>Achievements</Text>
          <Text style={styles.achCount}>{unlockedCount}/{achievements.length}</Text>
        </View>
        <View style={styles.achGrid}>
          {achievements.map((a) => (
            <View
              key={a.id}
              testID={`achievement-${a.id}`}
              style={[styles.achCard, !a.unlocked && styles.achLocked]}
            >
              <View
                style={[
                  styles.achIconWrap,
                  {
                    backgroundColor: a.unlocked ? colors.amber + '22' : 'rgba(255,255,255,0.04)',
                    borderColor: a.unlocked ? colors.amber : colors.border,
                  },
                ]}
              >
                <Ionicons
                  name={a.icon as any}
                  size={22}
                  color={a.unlocked ? colors.amber : colors.textMuted}
                />
              </View>
              <Text style={[styles.achTitle, !a.unlocked && { color: colors.textMuted }]}>
                {a.title}
              </Text>
              <Text style={styles.achDesc} numberOfLines={2}>
                {a.description}
              </Text>
              {!a.unlocked ? (
                <View style={styles.lockIcon}>
                  <Ionicons name="lock-closed" size={10} color={colors.textMuted} />
                </View>
              ) : null}
            </View>
          ))}
        </View>
      </ScrollView>

      <PointsPlusModal
        visible={showPointsPlus}
        onClose={() => setShowPointsPlus(false)}
        profile={profile}
        onProfileUpdate={(p) => setProfile(p)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: spacing.md, paddingBottom: 120 },
  kicker: { color: colors.green, fontSize: 12, letterSpacing: 2, fontWeight: '800' },
  title: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 2, marginBottom: spacing.md },
  topBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  pointsPlusBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.amber,
    borderRadius: radii.pill,
    marginTop: spacing.sm,
  },
  pointsPlusText: { color: colors.bg, fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
  pointsPlusActiveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.green,
    marginLeft: 2,
    borderWidth: 1,
    borderColor: colors.bg,
  },
  row: { flexDirection: 'row', gap: spacing.sm },
  stat: { flex: 1, alignItems: 'center', paddingVertical: spacing.md },
  statVal: { color: colors.text, fontSize: 18, fontWeight: '800', marginTop: 4 },
  statLbl: { color: colors.textMuted, fontSize: 10, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'center' },
  chartCard: { marginTop: spacing.md, alignItems: 'center' },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', alignSelf: 'stretch', alignItems: 'center', marginBottom: spacing.sm },
  chartTotal: { color: colors.green, fontSize: 14, fontWeight: '800' },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  sectionSub: { color: colors.textMuted, fontSize: 12, marginTop: 2, marginBottom: spacing.sm },
  areaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  areaLabel: { width: 90, flexDirection: 'row', alignItems: 'center', gap: 6 },
  areaName: { color: colors.text, fontSize: 12, fontWeight: '700' },
  areaBarWrap: { flex: 1, height: 8, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: radii.pill, overflow: 'hidden' },
  areaBarFill: { height: '100%' },
  areaValue: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', minWidth: 40, textAlign: 'right' },

  achHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.lg, marginBottom: spacing.sm },
  achCount: { color: colors.amber, fontSize: 14, fontWeight: '800' },
  achGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  achCard: {
    width: '48.5%',
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceGlass,
    position: 'relative',
  },
  achLocked: { opacity: 0.5 },
  achIconWrap: {
    width: 44,
    height: 44,
    borderRadius: radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  achTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  achDesc: { color: colors.textMuted, fontSize: 11, marginTop: 2, lineHeight: 15 },
  lockIcon: { position: 'absolute', top: 10, right: 10 },
});
