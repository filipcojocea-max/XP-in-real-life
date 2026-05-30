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
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Rect, Line, Polyline, Circle, Text as SvgText } from 'react-native-svg';
import { api, type Player, type PenaltyNotice } from '../../../src/api';
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
  // ── Creator Tools: XP Penalty Subtraction ──
  const [penaltyModalOpen, setPenaltyModalOpen] = useState(false);
  const [penaltyAmount, setPenaltyAmount] = useState('');
  const [penaltyNote, setPenaltyNote] = useState('');
  const [penaltyBusy, setPenaltyBusy] = useState(false);
  const [penaltyHistory, setPenaltyHistory] = useState<PenaltyNotice[]>([]);

  const loadPenaltyHistory = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.adminPlayerPenalties(id);
      setPenaltyHistory(r.penalties || []);
    } catch {
      // 403 = not creator; silent
    }
  }, [id]);

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

  useEffect(() => { load(); loadCharts(); loadPenaltyHistory(); }, [load, loadCharts, loadPenaltyHistory]);

  const submitPenalty = useCallback(async () => {
    const amt = parseInt(penaltyAmount, 10);
    if (!Number.isFinite(amt) || amt <= 0) {
      showAlert('Invalid amount', 'Enter a positive number of XP to subtract.');
      return;
    }
    if (penaltyBusy || !id) return;
    setPenaltyBusy(true);
    try {
      const r = await api.adminApplyPenalty(id, amt, penaltyNote.trim());
      showAlert('XP Penalty sent', `Subtracted ${r.amount.toLocaleString()} XP. New total: ${r.new_total_xp.toLocaleString()} XP (Lv ${r.new_level}).`);
      setPenaltyModalOpen(false);
      setPenaltyAmount('');
      setPenaltyNote('');
      // Refresh player stats + charts + history so the new bar shows up immediately.
      await Promise.all([load(), loadCharts(), loadPenaltyHistory()]);
    } catch (e: any) {
      showAlert('Failed to send penalty', String(e?.message || e));
    } finally {
      setPenaltyBusy(false);
    }
  }, [penaltyAmount, penaltyNote, penaltyBusy, id, load, loadCharts, loadPenaltyHistory]);

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
          <Stat label="Active goals" value={(player.active_goals_count ?? 0).toLocaleString()} icon="rocket" color={colors.cyan} />
          <Stat label="Streak" value={`${player.current_streak} d`} icon="flame" color={colors.amber} />
          <Stat label="Best streak" value={`${player.best_streak} d`} icon="medal" color="#9333EA" />
        </View>

        {/* ─────── Creator Tools (admin-only) ─────────────────────── */}
        <View style={styles.toolsCard}>
          <Text style={styles.kicker}>CREATOR TOOLS</Text>
          <TouchableOpacity
            style={styles.toolBtn}
            onPress={() => setPenaltyModalOpen(true)}
            testID="apv-open-penalty"
          >
            <View style={styles.toolBtnIcon}>
              <Ionicons name="remove-circle" size={18} color={colors.red} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.toolBtnTitle}>XP Penalty Subtraction</Text>
              <Text style={styles.toolBtnSubtitle}>Subtract XP and notify the player.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>

          {penaltyHistory.length > 0 ? (
            <View style={styles.penaltyHistoryWrap}>
              <Text style={styles.penaltyHistoryLabel}>RECENT PENALTIES</Text>
              {penaltyHistory.slice(0, 5).map((p) => (
                <View key={p.id} style={styles.penaltyHistoryRow}>
                  <Ionicons name="caret-down" size={12} color={colors.red} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.penaltyAmount}>-{p.amount.toLocaleString()} XP · {p.date}</Text>
                    {p.note ? <Text style={styles.penaltyNote} numberOfLines={2}>{p.note}</Text> : null}
                  </View>
                  {p.acknowledged_at ? (
                    <Ionicons name="checkmark-circle" size={14} color={colors.green} />
                  ) : (
                    <Ionicons name="time-outline" size={14} color={colors.amber} />
                  )}
                </View>
              ))}
            </View>
          ) : null}
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
            <>
              {chartView === 'week' ? (
                <BarChart days={charts.weekly.days} />
              ) : (
                <LineChart days={charts.monthly.days} />
              )}
              {/* Points+ History — colored multiplier bands, aligned
                  day-by-day with the chart above. Same boost type across
                  consecutive days renders as ONE connected block. */}
              <PointsHistoryChart
                days={chartView === 'week' ? charts.weekly.days : charts.monthly.days}
              />
              {/* Money Spent on Multipliers — small bar per day, sums
                  paid_amount for purchases acquired on that day. Uses
                  the player's local currency from boost_pricing. */}
              <MoneySpentChart
                days={chartView === 'week' ? charts.weekly.days : charts.monthly.days}
                currency={charts.boost_spend_currency || 'USD'}
              />
            </>
          ) : (
            <Text style={[styles.subtitle, { textAlign: 'center', marginVertical: 10 }]}>No data</Text>
          )}
        </View>

        {/* Account meta */}
        <View style={styles.metaCard}>
          <Text style={styles.kicker}>ACCOUNT META</Text>
          <Row label="User ID" value={player.user_id} mono />
          <Row label="Friend status" value={player.friend_status} />
          <Row label="Joined" value={formatStamp(player.joined_at as any)} />
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

      {/* ─── XP Penalty modal (Creator only) ─────────────────────── */}
      <Modal
        visible={penaltyModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setPenaltyModalOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>XP Penalty Subtraction</Text>
            <Text style={styles.modalSubtitle}>
              Subtract XP from <Text style={{ fontWeight: '900', color: colors.text }}>{player.name}</Text>.
              They'll see a hold-to-close popup next time they open the app.
            </Text>

            <Text style={styles.modalLabel}>XP TO SUBTRACT</Text>
            <TextInput
              value={penaltyAmount}
              onChangeText={(t) => setPenaltyAmount(t.replace(/[^0-9]/g, ''))}
              placeholder="e.g. 200"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              style={styles.modalInput}
              testID="apv-penalty-amount"
            />

            <Text style={styles.modalLabel}>NOTE TO PLAYER (optional)</Text>
            <TextInput
              value={penaltyNote}
              onChangeText={setPenaltyNote}
              placeholder="Explain the reason for this penalty…"
              placeholderTextColor={colors.textMuted}
              multiline
              numberOfLines={4}
              style={[styles.modalInput, styles.modalNote]}
              testID="apv-penalty-note"
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setPenaltyModalOpen(false)}
                disabled={penaltyBusy}
              >
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnDanger]}
                onPress={submitPenalty}
                disabled={penaltyBusy || !penaltyAmount}
                testID="apv-penalty-submit"
              >
                {penaltyBusy ? (
                  <ActivityIndicator color={colors.text} />
                ) : (
                  <>
                    <Ionicons name="paper-plane" size={14} color={colors.text} />
                    <Text style={styles.modalBtnDangerText}>Send XP Penalty</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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

function BarChart({ days }: { days: { day: string; xp: number; tasks: number; penalty_xp?: number; goal_xp?: number }[] }) {
  const maxXp = useMemo(() => Math.max(10, ...days.map((d) => (d.xp || 0) + (d.penalty_xp || 0) + (d.goal_xp || 0))), [days]);
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
          const earnedH = Math.max(2, (d.xp / maxXp) * innerH);
          const goalH = d.goal_xp ? Math.max(2, (d.goal_xp / maxXp) * innerH) : 0;
          const penaltyH = d.penalty_xp ? Math.max(2, (d.penalty_xp / maxXp) * innerH) : 0;
          const yEarnedTop = pad + innerH - earnedH;
          const yGoalTop = yEarnedTop - goalH;
          const yPenaltyTop = yGoalTop - penaltyH;
          return (
            <React.Fragment key={d.day + i}>
              {/* Earned XP segment (cyan) */}
              {d.xp > 0 ? (
                <Rect x={x} y={yEarnedTop} width={bw} height={earnedH} rx={3} fill={colors.cyan} opacity={0.85} />
              ) : null}
              {/* GREEN goal-XP segment — stacked on the cyan task XP. */}
              {goalH > 0 ? (
                <Rect x={x} y={yGoalTop} width={bw} height={goalH} rx={3} fill="#22C55E" stroke="#16A34A" strokeWidth={1} />
              ) : null}
              {/* BLACK penalty overlay — stacked on top of earned+goal. */}
              {penaltyH > 0 ? (
                <Rect x={x} y={yPenaltyTop} width={bw} height={penaltyH} rx={3} fill="#000000" stroke={colors.red} strokeWidth={1} />
              ) : null}
              <SvgText x={x + bw / 2} y={pad + innerH + 12} fontSize={9} fill={colors.textMuted} textAnchor="middle">
                {d.day}
              </SvgText>
              {d.xp > 0 ? (
                <SvgText x={x + bw / 2} y={Math.min(yPenaltyTop, yGoalTop, yEarnedTop) - 3} fontSize={9} fill={d.goal_xp ? '#22C55E' : colors.cyan} textAnchor="middle">
                  {d.xp + (d.goal_xp || 0)}
                </SvgText>
              ) : null}
              {penaltyH > 0 ? (
                <SvgText x={x + bw / 2} y={yPenaltyTop - 3} fontSize={9} fill={colors.red} textAnchor="middle" fontWeight="900">
                  -{d.penalty_xp}
                </SvgText>
              ) : null}
            </React.Fragment>
          );
        })}
      </Svg>
      <Text style={styles.chartCaption}>XP earned per day · last 7 days · max {maxXp} · <Text style={{ color: '#22C55E' }}>green = goal</Text> · <Text style={{ color: colors.red }}>black = penalty</Text></Text>
    </View>
  );
}

function LineChart({ days }: { days: { day: string; xp: number; penalty_xp?: number; goal_xp?: number }[] }) {
  const maxXp = useMemo(() => Math.max(10, ...days.map((d) => (d.xp || 0) + (d.penalty_xp || 0) + (d.goal_xp || 0))), [days]);
  const pad = 18;
  const innerW = CHART_W - pad * 2;
  const innerH = CHART_H - pad * 2;
  const points = days.map((d, i) => {
    const total = d.xp + (d.goal_xp || 0);
    const x = pad + (innerW / Math.max(1, days.length - 1)) * i;
    const y = pad + innerH - (total / maxXp) * innerH;
    return { x, y, xp: total, label: d.day, penaltyXp: d.penalty_xp || 0, goalXp: d.goal_xp || 0 };
  });
  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <View>
      <Svg width={CHART_W} height={CHART_H} style={styles.chartSvg}>
        <Line x1={pad} y1={pad + innerH} x2={pad + innerW} y2={pad + innerH} stroke={colors.border} strokeWidth={1} />
        <Polyline points={polyline} fill="none" stroke={colors.cyan} strokeWidth={2} />
        {points.map((p, i) => (
          <React.Fragment key={i}>
            <Circle cx={p.x} cy={p.y} r={p.xp > 0 ? 3 : 2} fill={p.goalXp > 0 ? '#22C55E' : p.xp > 0 ? colors.cyan : colors.textMuted} />
            {/* BLACK marker on penalty days — height = deducted XP. */}
            {p.penaltyXp > 0 ? (
              <Circle
                cx={p.x}
                cy={pad + innerH - ((p.penaltyXp / maxXp) * innerH)}
                r={5}
                fill="#000000"
                stroke={colors.red}
                strokeWidth={1}
              />
            ) : null}
          </React.Fragment>
        ))}
        {/* Sparse labels every ~5 days so x-axis stays readable */}
        {points.filter((_, i) => i % 5 === 0 || i === points.length - 1).map((p, i) => (
          <SvgText key={`x${i}`} x={p.x} y={pad + innerH + 12} fontSize={9} fill={colors.textMuted} textAnchor="middle">
            {p.label}
          </SvgText>
        ))}
      </Svg>
      <Text style={styles.chartCaption}>XP earned per day · last 30 days · max {maxXp} · <Text style={{ color: '#22C55E' }}>green = goal</Text> · <Text style={{ color: colors.red }}>black = penalty</Text></Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// <PointsHistoryChart /> — short stacked bar that shows which Points+
// multipliers were active on each day. Same boost across consecutive
// days renders as ONE long connected block (one "row" per boost type).
//
// Colors are fixed by boost type so the Creator can read the chart at
// a glance without a legend:
//    triple_day    → yellow
//    double_day    → blue
//    double_week   → purple
//    double_month  → green
// ─────────────────────────────────────────────────────────────────────
const BOOST_COLORS: Record<string, string> = {
  triple_day:   '#FACC15',  // yellow
  double_day:   '#3B82F6',  // blue
  double_week:  '#A855F7',  // purple
  double_month: '#22C55E',  // green
};
// Render order — top row down. Longer-duration multipliers sit at the
// bottom so the long green/purple bands form a "base" and the short
// yellow/blue daily boosts stack on top of them.
const BOOST_ROW_ORDER = ['triple_day', 'double_day', 'double_week', 'double_month'];
const BOOST_LABELS: Record<string, string> = {
  triple_day:   '3× / 1 day',
  double_day:   '2× / 1 day',
  double_week:  '2× / 7 days',
  double_month: '2× / 1 month',
};

function PointsHistoryChart({ days }: { days: { day: string; boosts_active: { type: string }[] }[] }) {
  // Compute which boost types appear at all in the window — we only
  // render rows for those, so the chart isn't padded with empty bands.
  const presentTypes = useMemo(() => {
    const set = new Set<string>();
    for (const d of days) for (const b of d.boosts_active || []) set.add(b.type);
    // Stable ordering per BOOST_ROW_ORDER, then anything unknown last.
    const ordered = BOOST_ROW_ORDER.filter((t) => set.has(t));
    set.forEach((t) => { if (!ordered.includes(t)) ordered.push(t); });
    return ordered;
  }, [days]);

  const ROW_H = 14;
  const ROW_GAP = 4;
  const pad = 18;
  const chartH = Math.max(50, presentTypes.length * (ROW_H + ROW_GAP) + pad * 2);
  const innerW = CHART_W - pad * 2;
  const colW = innerW / Math.max(1, days.length);

  if (presentTypes.length === 0) {
    return (
      <View style={{ marginTop: spacing.md }}>
        <Text style={styles.subKicker}>POINTS+ HISTORY</Text>
        <View style={styles.emptyMini}>
          <Text style={styles.emptyMiniText}>No multipliers active in this window.</Text>
        </View>
      </View>
    );
  }

  // For each boost type, collapse consecutive active days into spans
  // so we draw ONE rectangle stretched across [startIdx..endIdx].
  type Span = { start: number; end: number };
  const spansByType: Record<string, Span[]> = {};
  for (const t of presentTypes) {
    const spans: Span[] = [];
    let curStart = -1;
    for (let i = 0; i < days.length; i++) {
      const active = (days[i].boosts_active || []).some((b) => b.type === t);
      if (active && curStart < 0) curStart = i;
      if ((!active || i === days.length - 1) && curStart >= 0) {
        const end = active ? i : i - 1;
        spans.push({ start: curStart, end });
        curStart = -1;
      }
    }
    spansByType[t] = spans;
  }

  return (
    <View style={{ marginTop: spacing.md }}>
      <Text style={styles.subKicker}>POINTS+ HISTORY</Text>
      <Svg width={CHART_W} height={chartH} style={styles.chartSvg}>
        {presentTypes.map((t, rowIdx) => {
          const y = pad + rowIdx * (ROW_H + ROW_GAP);
          const color = BOOST_COLORS[t] || colors.cyan;
          return (
            <React.Fragment key={t}>
              {/* Faint background track so empty days are visually clear */}
              <Rect
                x={pad}
                y={y}
                width={innerW}
                height={ROW_H}
                rx={3}
                fill={color}
                opacity={0.10}
              />
              {/* Connected spans — one rect per consecutive active run */}
              {spansByType[t].map((s, idx) => {
                const x = pad + s.start * colW + 1;
                const w = (s.end - s.start + 1) * colW - 2;
                return (
                  <Rect
                    key={`${t}-${idx}`}
                    x={x}
                    y={y}
                    width={Math.max(2, w)}
                    height={ROW_H}
                    rx={3}
                    fill={color}
                    stroke={color}
                    strokeWidth={1}
                    opacity={0.95}
                  />
                );
              })}
              {/* Row label on the left margin */}
              <SvgText
                x={pad + 4}
                y={y + ROW_H * 0.72}
                fontSize={9}
                fill="#fff"
                fontWeight="800"
              >
                {BOOST_LABELS[t] || t}
              </SvgText>
            </React.Fragment>
          );
        })}
        {/* Day labels — aligned with the chart above so the columns line up. */}
        {days.map((d, i) => {
          const x = pad + (i + 0.5) * colW;
          return (
            <SvgText
              key={`l-${i}`}
              x={x}
              y={chartH - 4}
              fontSize={9}
              fill={colors.textMuted}
              textAnchor="middle"
            >
              {d.day}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// <MoneySpentChart /> — small bar chart of money the player spent on
// Points+ multipliers, bucketed by acquisition date. Aligns 1:1 with
// the day columns of the two charts above so the Creator can quickly
// correlate "they bought 2x today" → "their XP spiked tomorrow".
// ─────────────────────────────────────────────────────────────────────
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$', AUD: 'A$', CAD: 'C$', EUR: '€', GBP: '£',
  JPY: '¥', INR: '₹', RON: 'lei', CHF: 'CHF', BRL: 'R$',
};

function MoneySpentChart({
  days,
  currency,
}: {
  days: { day: string; boost_spend: number }[];
  currency: string;
}) {
  const sym = CURRENCY_SYMBOL[currency?.toUpperCase()] || '';
  const max = useMemo(
    () => Math.max(1, ...days.map((d) => d.boost_spend || 0)),
    [days],
  );
  const pad = 18;
  const chartH = 90;
  const innerW = CHART_W - pad * 2;
  const innerH = chartH - pad * 2;
  const colW = innerW / Math.max(1, days.length);
  const bw = colW * 0.55;

  const total = useMemo(
    () => days.reduce((s, d) => s + (d.boost_spend || 0), 0),
    [days],
  );

  const fmt = (n: number) => {
    if (!n) return '0';
    if (n >= 1000) return (Math.round(n * 10) / 10).toFixed(0);
    return (Math.round(n * 100) / 100).toString();
  };

  return (
    <View style={{ marginTop: spacing.md }}>
      <Text style={styles.subKicker}>MONEY SPENT ON MULTIPLIERS</Text>
      <Svg width={CHART_W} height={chartH} style={styles.chartSvg}>
        <Line x1={pad} y1={pad + innerH} x2={pad + innerW} y2={pad + innerH} stroke={colors.border} strokeWidth={1} />
        {days.map((d, i) => {
          const spend = d.boost_spend || 0;
          const x = pad + i * colW + (colW - bw) / 2;
          const h = spend > 0 ? Math.max(2, (spend / max) * innerH) : 0;
          const y = pad + innerH - h;
          return (
            <React.Fragment key={`m-${i}`}>
              {h > 0 ? (
                <Rect x={x} y={y} width={bw} height={h} rx={3} fill="#22D3EE" stroke="#0E7490" strokeWidth={1} />
              ) : null}
              <SvgText x={x + bw / 2} y={pad + innerH + 11} fontSize={9} fill={colors.textMuted} textAnchor="middle">
                {d.day}
              </SvgText>
              {spend > 0 ? (
                <SvgText x={x + bw / 2} y={y - 3} fontSize={9} fill="#22D3EE" fontWeight="800" textAnchor="middle">
                  {sym}{fmt(spend)}
                </SvgText>
              ) : null}
            </React.Fragment>
          );
        })}
      </Svg>
      <Text style={styles.chartCaption}>
        Total: <Text style={{ color: '#22D3EE', fontWeight: '900' }}>{sym}{fmt(total)} {currency?.toUpperCase()}</Text>
      </Text>
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
  // Sub-headers for the secondary charts (Points+ History, Money Spent)
  // stacked under the primary BarChart / LineChart inside the same card.
  subKicker: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
    marginBottom: 6,
  },
  emptyMini: {
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    borderRadius: radii.md,
  },
  emptyMiniText: {
    color: colors.textMuted,
    fontSize: 11,
    fontStyle: 'italic',
  },
  kicker: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginBottom: 8 },
  rowMeta: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingVertical: 6, gap: 12 },
  rowMetaLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  rowMetaValue: { color: colors.text, fontSize: 12, fontWeight: '700', flex: 1, textAlign: 'right' },
  rowMetaMono: { fontFamily: 'Courier', fontSize: 10 },

  // ── Creator Tools (penalty) ────────────────────────────────────
  toolsCard: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  toolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: radii.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.red + '44',
  },
  toolBtnIcon: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: colors.red + '22',
    alignItems: 'center', justifyContent: 'center',
  },
  toolBtnTitle: { color: colors.text, fontWeight: '900', fontSize: 13 },
  toolBtnSubtitle: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  penaltyHistoryWrap: { marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  penaltyHistoryLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.5, marginBottom: 6 },
  penaltyHistoryRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  penaltyAmount: { color: colors.red, fontWeight: '900', fontSize: 12 },
  penaltyNote: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },

  // ── Penalty modal ──────────────────────────────────────────────
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg, paddingTop: 12, paddingBottom: spacing.xl,
    borderTopWidth: 1, borderTopColor: colors.red + '55',
  },
  modalHandle: { width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: spacing.md },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  modalSubtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 4, lineHeight: 16 },
  modalLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginTop: spacing.md, marginBottom: 6 },
  modalInput: {
    backgroundColor: colors.bg, color: colors.text,
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
  },
  modalNote: { minHeight: 90, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: spacing.md },
  modalBtn: {
    flex: 1, paddingVertical: 12, borderRadius: radii.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  modalBtnGhost: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  modalBtnGhostText: { color: colors.textSecondary, fontWeight: '700' },
  modalBtnDanger: { backgroundColor: colors.red },
  modalBtnDangerText: { color: colors.text, fontWeight: '900', fontSize: 13 },
});
