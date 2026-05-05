import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import Svg, { Rect, Line, Text as SvgText, Polyline, Circle } from 'react-native-svg';
import Card from '../../src/components/Card';
import PointsPlusModal from '../../src/components/PointsPlusModal';
import { api, WeeklyStats, Profile, Achievement } from '../../src/api';
import { colors, focusMeta, spacing, radii, FocusArea } from '../../src/theme';
import { useScrollToTopOnFocus } from '../../src/hooks/useScrollToTopOnFocus';

const AREAS: FocusArea[] = ['social', 'fitness', 'appearance', 'mindset'];

/**
 * View mode for the XP charts. Both modes share the same SVG render
 * pipeline because the backend returns identical-shaped `{date, day,
 * xp, gifted_xp, tasks}` objects — only the array length and label
 * formatting differ. Cycling stays inside the chart card so the rest
 * of the screen (totals, by-area, achievements) remains stable.
 */
type ChartView = 'weekly' | 'monthly';

export default function Progress() {
  const [weekly, setWeekly] = useState<WeeklyStats | null>(null);
  const [monthly, setMonthly] = useState<WeeklyStats | null>(null);
  const [view, setView] = useState<ChartView>('weekly');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [byArea, setByArea] = useState<Record<FocusArea, number> | null>(null);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPointsPlus, setShowPointsPlus] = useState(false);

  const load = useCallback(async () => {
    try {
      // Fetch both windows in parallel — monthly is small enough
      // (30 rows) that pre-fetching is cheaper than refetching when
      // the user toggles. Keeps the toggle instantaneous.
      const [w, m, p, a, ach] = await Promise.all([
        api.statsWeekly(),
        api.statsMonthly(),
        api.getProfile(),
        api.statsByArea(),
        api.achievements(),
      ]);
      setWeekly(w);
      setMonthly(m);
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

  // Real-time-feel: while the Progress tab is in focus, poll every
  // 4 seconds so the current day's bar visibly rises as the user earns
  // XP from any other tab. (useFocusEffect auto-cancels when blurred.)
  useFocusEffect(useCallback(() => {
    load();
    const id = setInterval(() => {
      load();
    }, 4000);
    return () => clearInterval(id);
  }, [load]));

  // Reset Progress scroll position to top when the tab regains focus.
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTopOnFocus(scrollRef);

  if (loading || !weekly || !monthly || !profile || !byArea) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loading}>
          <ActivityIndicator color={colors.green} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  // ── Active dataset selection ────────────────────────────────────────
  // Both endpoints return the same shape; we just swap the source array
  // based on the current toggle. Monthly is a 30-row window labelled by
  // day-of-month, weekly is 7-row by weekday abbreviation.
  const activeStats: WeeklyStats = view === 'monthly' ? monthly : weekly;
  const days = activeStats.days;
  const maxXp = Math.max(1, ...days.map((d) => d.xp + (d.gifted_xp || 0)));
  // Wider chart for the monthly view so 30 bars don't overlap. Ensures
  // each bar still has at least ~3px of breathing room.
  const chartW = view === 'monthly' ? 720 : 320;
  const chartH = 160;
  const pad = 24;
  const barW = Math.max(2, (chartW - pad * 2) / days.length - 4);
  const totalWindowXp = days.reduce((s, d) => s + d.xp, 0);
  const totalAreaXp = Object.values(byArea).reduce((s, v) => s + v, 0);

  // Today is always the LAST day in the array (server orders oldest→newest).
  const todayIdx = days.length - 1;
  const segmentW = (chartW - pad * 2) / days.length;
  const xCenters = days.map((_, i) => pad + i * segmentW + segmentW / 2);
  const yForXp = (xp: number) => chartH - pad - ((chartH - pad * 2) * xp) / maxXp;
  const linePoints = days
    .map((d, i) => `${xCenters[i]},${yForXp(d.xp)}`)
    .join(' ');

  // Show value labels on every weekly bar but only every 5th monthly bar
  // — 30 stacked labels at 10px wide is unreadable.
  const showLabelEveryN = view === 'monthly' ? 5 : 1;

  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
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

        {/* Weekly/Monthly toggle pill — single source of truth for both
            the bar and line graphs below. Tapping the same option is a
            no-op so it's safe to spam. */}
        <View style={styles.viewToggle} testID="chart-view-toggle">
          {(['weekly', 'monthly'] as ChartView[]).map((v) => {
            const active = view === v;
            return (
              <TouchableOpacity
                key={v}
                onPress={() => setView(v)}
                style={[styles.viewToggleBtn, active && styles.viewToggleBtnActive]}
                testID={`chart-view-${v}`}
                activeOpacity={0.85}
              >
                <Ionicons
                  name={v === 'weekly' ? 'calendar-outline' : 'calendar-number-outline'}
                  size={13}
                  color={active ? colors.bg : colors.textMuted}
                />
                <Text style={[styles.viewToggleText, active && { color: colors.bg }]}>
                  {v === 'weekly' ? 'Weekly' : 'Monthly'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* XP — bar chart with per-day XP labels on top. The monthly view
            uses a horizontal ScrollView because 30 bars don't fit on
            one mobile width; weekly stays static so the layout is
            unchanged for that path. */}
        <Card style={styles.chartCard}>
          <View style={styles.chartHead}>
            <Text style={styles.sectionTitle}>
              {view === 'monthly' ? 'Monthly XP' : 'Weekly XP'}
            </Text>
            <Text style={styles.chartTotal}>+{totalWindowXp} XP</Text>
          </View>
          <ScrollView
            horizontal={view === 'monthly'}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={view === 'monthly' ? { paddingHorizontal: 4 } : undefined}
          >
          <Svg width={chartW} height={chartH}>
            <Line
              x1={pad}
              y1={chartH - pad}
              x2={chartW - pad}
              y2={chartH - pad}
              stroke={colors.border}
              strokeWidth={1}
            />
            {days.map((d, i) => {
              const earnedXp = d.xp;
              const giftedXp = d.gifted_xp || 0;
              const totalXp = earnedXp + giftedXp;
              const totalH = ((chartH - pad * 2) * totalXp) / maxXp;
              const earnedH = ((chartH - pad * 2) * earnedXp) / maxXp;
              const giftedH = ((chartH - pad * 2) * giftedXp) / maxXp;
              const x = pad + i * segmentW + (segmentW - barW) / 2;
              const yEarnedTop = chartH - pad - earnedH;
              const yGiftedTop = chartH - pad - earnedH - giftedH;
              const isToday = i === todayIdx;
              const showLabel = totalXp > 0 && (i % showLabelEveryN === 0 || isToday);
              const showAxisLabel = i % showLabelEveryN === 0 || isToday || i === 0;
              return (
                <React.Fragment key={d.date}>
                  {earnedXp > 0 ? (
                    <Rect
                      x={x}
                      y={yEarnedTop}
                      width={barW}
                      height={Math.max(2, earnedH)}
                      rx={4}
                      // Today's bar uses the brighter cyan accent so users
                      // can see it rise in real time as they earn XP.
                      fill={isToday ? colors.cyan : colors.green}
                    />
                  ) : null}
                  {/* YELLOW gifted-XP segment stacked on top of the
                      earned-XP bar. Same x/width for visual continuity;
                      different fill so it's clearly distinguishable. */}
                  {giftedXp > 0 ? (
                    <Rect
                      x={x}
                      y={yGiftedTop}
                      width={barW}
                      height={Math.max(2, giftedH)}
                      rx={4}
                      fill="#FFD700"
                    />
                  ) : null}
                  {totalXp === 0 ? (
                    <Rect
                      x={x}
                      y={chartH - pad - 2}
                      width={barW}
                      height={2}
                      rx={1}
                      fill="rgba(255,255,255,0.1)"
                    />
                  ) : null}
                  {/* Total XP value above each bar (earned + gifted) */}
                  {showLabel ? (
                    <SvgText
                      x={x + barW / 2}
                      y={Math.max(yGiftedTop, yEarnedTop) - 4}
                      fontSize="10"
                      fontWeight="800"
                      fill={giftedXp > 0 ? '#FFD700' : isToday ? colors.cyan : colors.text}
                      textAnchor="middle"
                    >
                      {totalXp}
                    </SvgText>
                  ) : null}
                  {showAxisLabel ? (
                  <SvgText
                    x={x + barW / 2}
                    y={chartH - pad + 14}
                    fontSize="10"
                    fontWeight="700"
                    fill={isToday ? colors.cyan : colors.textMuted}
                    textAnchor="middle"
                  >
                    {d.day}
                  </SvgText>
                  ) : null}
                </React.Fragment>
              );
            })}
          </Svg>
          </ScrollView>
        </Card>

        {/* XP — companion line graph showing the same data as the
            bar chart so users can read the trend at a glance. */}
        <Card style={[styles.chartCard, { marginTop: spacing.md }]}>
          <View style={styles.chartHead}>
            <Text style={styles.sectionTitle}>
              {view === 'monthly' ? 'Monthly XP — Trend' : 'Weekly XP — Trend'}
            </Text>
            <Text style={[styles.chartTotal, { color: colors.cyan }]}>Line view</Text>
          </View>
          <ScrollView
            horizontal={view === 'monthly'}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={view === 'monthly' ? { paddingHorizontal: 4 } : undefined}
          >
          <Svg width={chartW} height={chartH}>
            <Line
              x1={pad}
              y1={chartH - pad}
              x2={chartW - pad}
              y2={chartH - pad}
              stroke={colors.border}
              strokeWidth={1}
            />
            {/* Faint baseline grid at 50% & 100% of max so the trend is
                anchored visually. */}
            <Line
              x1={pad}
              y1={yForXp(maxXp / 2)}
              x2={chartW - pad}
              y2={yForXp(maxXp / 2)}
              stroke={colors.border}
              strokeWidth={1}
              strokeDasharray="3,4"
              opacity={0.5}
            />
            <Polyline
              points={linePoints}
              fill="none"
              stroke={colors.cyan}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {days.map((d, i) => {
              const cx = xCenters[i];
              const cy = yForXp(d.xp);
              const isToday = i === todayIdx;
              const showLabel = d.xp > 0 && (i % showLabelEveryN === 0 || isToday);
              const showAxisLabel = i % showLabelEveryN === 0 || isToday || i === 0;
              return (
                <React.Fragment key={`pt-${d.date}`}>
                  <Circle
                    cx={cx}
                    cy={cy}
                    r={isToday ? 5 : view === 'monthly' ? 2.5 : 3.5}
                    fill={isToday ? colors.cyan : colors.green}
                    stroke={colors.bg}
                    strokeWidth={1.5}
                  />
                  {showLabel ? (
                    <SvgText
                      x={cx}
                      y={cy - 8}
                      fontSize="10"
                      fontWeight="800"
                      fill={isToday ? colors.cyan : colors.text}
                      textAnchor="middle"
                    >
                      {d.xp}
                    </SvgText>
                  ) : null}
                  {showAxisLabel ? (
                  <SvgText
                    x={cx}
                    y={chartH - pad + 14}
                    fontSize="10"
                    fontWeight="700"
                    fill={isToday ? colors.cyan : colors.textMuted}
                    textAnchor="middle"
                  >
                    {d.day}
                  </SvgText>
                  ) : null}
                </React.Fragment>
              );
            })}
          </Svg>
          </ScrollView>
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
  // Weekly/Monthly toggle pill
  viewToggle: {
    flexDirection: 'row',
    alignSelf: 'center',
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    padding: 3,
    gap: 2,
  },
  viewToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
  },
  viewToggleBtnActive: { backgroundColor: colors.cyan },
  viewToggleText: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 0.3 },
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
