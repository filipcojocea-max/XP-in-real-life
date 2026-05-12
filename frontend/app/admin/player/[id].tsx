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

function BarChart({ days }: { days: { day: string; xp: number; tasks: number; penalty_xp?: number }[] }) {
  const maxXp = useMemo(() => Math.max(10, ...days.map((d) => (d.xp || 0) + (d.penalty_xp || 0))), [days]);
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
          const penaltyH = d.penalty_xp ? Math.max(2, (d.penalty_xp / maxXp) * innerH) : 0;
          const yEarnedTop = pad + innerH - earnedH;
          const yPenaltyTop = yEarnedTop - penaltyH;
          return (
            <React.Fragment key={d.day + i}>
              {/* Earned XP segment (cyan) */}
              {d.xp > 0 ? (
                <Rect x={x} y={yEarnedTop} width={bw} height={earnedH} rx={3} fill={colors.cyan} opacity={0.85} />
              ) : null}
              {/* Penalty overlay (BLACK) — stacked on TOP of the earned bar so
                  the visual height = earned + penalty (penalty subtracted
                  from XP this day). */}
              {penaltyH > 0 ? (
                <Rect x={x} y={yPenaltyTop} width={bw} height={penaltyH} rx={3} fill="#000000" stroke={colors.red} strokeWidth={1} />
              ) : null}
              <SvgText x={x + bw / 2} y={pad + innerH + 12} fontSize={9} fill={colors.textMuted} textAnchor="middle">
                {d.day}
              </SvgText>
              {d.xp > 0 ? (
                <SvgText x={x + bw / 2} y={Math.max(yPenaltyTop, yEarnedTop) - 3} fontSize={9} fill={colors.cyan} textAnchor="middle">
                  {d.xp}
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
      <Text style={styles.chartCaption}>XP earned per day · last 7 days · max {maxXp} · <Text style={{ color: colors.red }}>black = penalty</Text></Text>
    </View>
  );
}

function LineChart({ days }: { days: { day: string; xp: number; penalty_xp?: number }[] }) {
  const maxXp = useMemo(() => Math.max(10, ...days.map((d) => (d.xp || 0) + (d.penalty_xp || 0))), [days]);
  const pad = 18;
  const innerW = CHART_W - pad * 2;
  const innerH = CHART_H - pad * 2;
  const points = days.map((d, i) => {
    const x = pad + (innerW / Math.max(1, days.length - 1)) * i;
    const y = pad + innerH - (d.xp / maxXp) * innerH;
    return { x, y, xp: d.xp, label: d.day, penaltyXp: d.penalty_xp || 0 };
  });
  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <View>
      <Svg width={CHART_W} height={CHART_H} style={styles.chartSvg}>
        <Line x1={pad} y1={pad + innerH} x2={pad + innerW} y2={pad + innerH} stroke={colors.border} strokeWidth={1} />
        <Polyline points={polyline} fill="none" stroke={colors.cyan} strokeWidth={2} />
        {points.map((p, i) => (
          <React.Fragment key={i}>
            <Circle cx={p.x} cy={p.y} r={p.xp > 0 ? 3 : 2} fill={p.xp > 0 ? colors.cyan : colors.textMuted} />
            {/* BLACK marker on penalty days — drawn above the XP point at
                a height proportional to the penalty so it visually maps
                to the deduction. */}
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
      <Text style={styles.chartCaption}>XP earned per day · last 30 days · max {maxXp} · <Text style={{ color: colors.red }}>black = penalty</Text></Text>
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
