/**
 * /admin/player/[id] — Read-only full-screen profile of any player.
 *
 *  Reuses GET /api/friends/profile/{id} (which the existing in-app
 *  PlayerCard modal also uses) and renders the same data here so that
 *  the admin can drill into a player straight from the new "Players
 *  Dates" or "Global Leaderboard" lists.
 *
 *  Guard: 403 page when the viewer isn't an admin.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Dimensions,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Rect, Line, Polyline, Circle, Text as SvgText } from 'react-native-svg';
import { api, type Player } from '../../../src/api';
import { colors, spacing, radii } from '../../../src/theme';
import { showAlert } from '../../../src/uiAlert';

export default function AdminPlayerScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [player, setPlayer] = useState<Player | null>(null);
  const [loading, setLoading] = useState(true);
  // Charts bundle: weekly bar chart + monthly line chart + by-area totals.
  // Loaded lazily AFTER the profile so the hero renders fast even on
  // slow connections.
  const [charts, setCharts] = useState<Awaited<ReturnType<typeof api.adminPlayerCharts>> | null>(null);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartView, setChartView] = useState<'week' | 'month'>('week');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.playerProfile(id);
      setPlayer(r as Player);
    } catch (e: any) {
      showAlert('Failed to load profile', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadCharts = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.adminPlayerCharts(id);
      setCharts(r);
    } catch (e: any) {
      // 403 just means the viewer isn't an admin — no toast needed.
      if (!String(e?.message || '').includes('403')) {
        showAlert('Failed to load charts', String(e?.message || e));
      }
    } finally {
      setChartsLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); loadCharts(); }, [load, loadCharts]);

  if (loading) {
    return (
      <SafeAreaView style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  if (!player) {
    return (
      <SafeAreaView style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={10}>
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Player not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const formatStamp = (iso: string | null | undefined) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={10} testID="apv-back">
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Player Profile</Text>
          <Text style={styles.subtitle}>creator-only view</Text>
        </View>
        <View style={styles.crownPill}>
          <Ionicons name="shield-checkmark" size={12} color="#FFD700" />
          <Text style={styles.crownText}>CREATOR</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Hero */}
        <View style={styles.hero}>
          {player.avatar_base64 ? (
            <Image
              source={{ uri: `data:image/jpeg;base64,${player.avatar_base64}` }}
              style={styles.avatarBig}
            />
          ) : (
            <View style={[styles.avatarBig, styles.avatarFallback]}>
              <Text style={styles.avatarLetterBig}>{(player.name || '?').slice(0, 1).toUpperCase()}</Text>
            </View>
          )}
          <Text style={styles.name}>
            {player.name}
            {player.is_admin ? <Text style={styles.adminTag}>  · CREATOR</Text> : null}
          </Text>
          <View style={styles.levelPill}>
            <Text style={styles.levelText}>Lv {player.level}</Text>
          </View>
          {player.bio ? <Text style={styles.bio}>{player.bio}</Text> : null}
        </View>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <Stat label="Total XP" value={player.total_xp.toLocaleString()} icon="trophy" color="#FFD700" />
          <Stat label="Tasks done" value={player.tasks_completed.toLocaleString()} icon="checkmark-done" color={colors.cyan} />
          <Stat label="Goals done" value={player.goals_completed.toLocaleString()} icon="flag" color={colors.green} />
          <Stat label="Streak" value={`${player.current_streak} d`} icon="flame" color={colors.amber} />
          <Stat label="Best streak" value={`${player.best_streak} d`} icon="medal" color="#9333EA" />
        </View>

        {/* ── Progress charts (Creator-only data) ─────────────────────
            Reuses the same daily XP buckets the user sees in their own
            Progress tab, so the Creator can quickly inspect anyone. */}
        <View style={styles.chartCard}>
          <View style={styles.chartHead}>
            <Text style={styles.kicker}>PROGRESS CHARTS</Text>
            <View style={styles.toggleRow}>
              <TouchableOpacity
                onPress={() => setChartView('week')}
                style={[styles.toggleBtn, chartView === 'week' && styles.toggleBtnActive]}
                testID="apv-chart-week"
              >
                <Text style={[styles.toggleText, chartView === 'week' && styles.toggleTextActive]}>Week</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setChartView('month')}
                style={[styles.toggleBtn, chartView === 'month' && styles.toggleBtnActive]}
                testID="apv-chart-month"
              >
                <Text style={[styles.toggleText, chartView === 'month' && styles.toggleTextActive]}>Month</Text>
              </TouchableOpacity>
            </View>
          </View>

          {chartsLoading ? (
            <ActivityIndicator color={colors.cyan} style={{ marginVertical: 20 }} />
          ) : charts ? (
            chartView === 'week' ? (
              <BarChart days={charts.weekly.days} />
            ) : (
              <LineChart days={charts.monthly.days} />
            )
          ) : (
            <Text style={[styles.subtitle, { textAlign: 'center', marginVertical: 10 }]}>No data</Text>
          )}
        </View>

        {/* Account meta */}
        <View style={styles.metaCard}>
          <Text style={styles.kicker}>ACCOUNT META</Text>
          <Row label="User ID" value={player.user_id} mono />
          <Row label="Friend status" value={player.friend_status} />
          <Row label="Last seen" value={formatStamp(player.last_seen_at as any)} />
          {player.silence_state ? (
            <Row
              label="Silence state"
              value={
                player.silence_state.in_silence
                  ? `${player.silence_state.label}`
                  : `Awake · ${player.silence_state.shift || '-'} shift`
              }
            />
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, icon, color }: { label: string; value: string; icon: keyof typeof Ionicons.glyphMap; color: string }) {
  return (
    <View style={[styles.statBox, { borderColor: color + '88' }]}>
      <Ionicons name={icon} size={16} color={color} />
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.rowMeta}>
      <Text style={styles.rowMetaLabel}>{label}</Text>
      <Text style={[styles.rowMetaValue, mono && styles.rowMetaMono]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

// ───────────────── Chart helpers (SVG, no extra deps) ─────────────
// Both charts pad ~16px around the plot area and pull max XP up to ~10
// so a quiet user still gets a visible baseline. Colour palette matches
// the rest of the Creator console.
const CHART_W = Dimensions.get('window').width - spacing.md * 2 - spacing.md * 2;
const CHART_H = 160;

function BarChart({ days }: { days: { day: string; xp: number; tasks: number }[] }) {
  const maxXp = useMemo(() => Math.max(10, ...days.map((d) => d.xp || 0)), [days]);
  const pad = 18;
  const innerW = CHART_W - pad * 2;
  const innerH = CHART_H - pad * 2;
  const bw = innerW / Math.max(1, days.length) * 0.6;
  return (
    <View>
      <Svg width={CHART_W} height={CHART_H} style={styles.chartSvg}>
        {/* y-axis baseline */}
        <Line x1={pad} y1={pad + innerH} x2={pad + innerW} y2={pad + innerH} stroke={colors.border} strokeWidth={1} />
        {days.map((d, i) => {
          const x = pad + (innerW / days.length) * i + (innerW / days.length - bw) / 2;
          const h = Math.max(2, (d.xp / maxXp) * innerH);
          const y = pad + innerH - h;
          return (
            <React.Fragment key={d.day + i}>
              <Rect x={x} y={y} width={bw} height={h} rx={3} fill={colors.cyan} opacity={0.85} />
              <SvgText x={x + bw / 2} y={pad + innerH + 12} fontSize={9} fill={colors.textMuted} textAnchor="middle">
                {d.day}
              </SvgText>
              {d.xp > 0 ? (
                <SvgText x={x + bw / 2} y={y - 3} fontSize={9} fill={colors.cyan} textAnchor="middle">
                  {d.xp}
                </SvgText>
              ) : null}
            </React.Fragment>
          );
        })}
      </Svg>
      <Text style={styles.chartCaption}>XP earned per day · last 7 days · max {maxXp}</Text>
    </View>
  );
}

function LineChart({ days }: { days: { day: string; xp: number }[] }) {
  const maxXp = useMemo(() => Math.max(10, ...days.map((d) => d.xp || 0)), [days]);
  const pad = 18;
  const innerW = CHART_W - pad * 2;
  const innerH = CHART_H - pad * 2;
  const points = days.map((d, i) => {
    const x = pad + (innerW / Math.max(1, days.length - 1)) * i;
    const y = pad + innerH - (d.xp / maxXp) * innerH;
    return { x, y, xp: d.xp, label: d.day };
  });
  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <View>
      <Svg width={CHART_W} height={CHART_H} style={styles.chartSvg}>
        <Line x1={pad} y1={pad + innerH} x2={pad + innerW} y2={pad + innerH} stroke={colors.border} strokeWidth={1} />
        <Polyline points={polyline} fill="none" stroke={colors.cyan} strokeWidth={2} />
        {points.map((p, i) => (
          <Circle key={i} cx={p.x} cy={p.y} r={p.xp > 0 ? 3 : 2} fill={p.xp > 0 ? colors.cyan : colors.textMuted} />
        ))}
        {/* Sparse labels every ~5 days so x-axis stays readable */}
        {points.filter((_, i) => i % 5 === 0 || i === points.length - 1).map((p, i) => (
          <SvgText key={`x${i}`} x={p.x} y={pad + innerH + 12} fontSize={9} fill={colors.textMuted} textAnchor="middle">
            {p.label}
          </SvgText>
        ))}
      </Svg>
      <Text style={styles.chartCaption}>XP earned per day · last 30 days · max {maxXp}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderColor: colors.border,
  },
  iconBtn: { padding: 4 },
  title: { color: colors.text, fontSize: 16, fontWeight: '900' },
  subtitle: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  crownPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999,
    borderWidth: 1, borderColor: '#FFD70077', backgroundColor: '#FFD70010',
  },
  crownText: { color: '#FFD700', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  body: { padding: spacing.md, paddingBottom: spacing.xl },

  hero: { alignItems: 'center', paddingVertical: spacing.lg, gap: 8 },
  avatarBig: { width: 110, height: 110, borderRadius: 55, borderWidth: 3, borderColor: colors.cyan },
  avatarFallback: { backgroundColor: colors.cyan + '22', alignItems: 'center', justifyContent: 'center' },
  avatarLetterBig: { color: colors.cyan, fontWeight: '900', fontSize: 38 },
  name: { color: colors.text, fontSize: 22, fontWeight: '900', marginTop: 6 },
  adminTag: { color: '#FFD700', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  levelPill: { backgroundColor: colors.cyan + '22', borderColor: colors.cyan, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999 },
  levelText: { color: colors.cyan, fontWeight: '900', fontSize: 12 },
  bio: { color: colors.textSecondary, fontSize: 13, marginTop: 8, textAlign: 'center', maxWidth: 320 },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: spacing.md },
  statBox: {
    width: '48%', flexBasis: '48%',
    padding: 12, borderRadius: radii.md, backgroundColor: colors.surface,
    borderWidth: 1, alignItems: 'center', gap: 4,
  },
  statValue: { fontSize: 18, fontWeight: '900' },
  statLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },

  metaCard: {
    marginTop: spacing.md,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md,
  },
  // Charts card sits between the stats grid and the meta card.
  chartCard: {
    marginTop: spacing.md,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md,
  },
  chartHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10,
  },
  toggleRow: { flexDirection: 'row', gap: 6 },
  toggleBtn: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  toggleBtnActive: { backgroundColor: colors.cyan + '22', borderColor: colors.cyan },
  toggleText: { color: colors.textSecondary, fontSize: 11, fontWeight: '700' },
  toggleTextActive: { color: colors.cyan, fontWeight: '900' },
  chartSvg: { alignSelf: 'center' },
  chartCaption: { color: colors.textMuted, fontSize: 10, textAlign: 'center', marginTop: 4 },
  kicker: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginBottom: 8 },
  rowMeta: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingVertical: 6, gap: 12 },
  rowMetaLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  rowMetaValue: { color: colors.text, fontSize: 12, fontWeight: '700', flex: 1, textAlign: 'right' },
  rowMetaMono: { fontFamily: 'Courier', fontSize: 10 },
});
