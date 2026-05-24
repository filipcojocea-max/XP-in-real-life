/**
 * /admin/global-leaderboard — Creator-only top-100 ranking by total XP.
 *
 *  • Period selector: All-time · Year · Month · Week
 *  • Live search by player name (case-insensitive substring).
 *  • Medal styling: 🥇 1st = gold border + dot · 🥈 2nd = silver ·
 *    🥉 3rd = blue. Ranks 4–100 use neutral chip.
 *  • Tap any row to open the player profile detail.
 *
 *  Server side: GET /api/admin/leaderboard/global?period=…&q=…
 *  Guard: 403 unless profile.is_admin.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { api, type AdminLeaderboardRow } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

type Period = 'all' | 'year' | 'month' | 'week';

const PERIOD_LABEL: Record<Period, string> = {
  all: 'All-time',
  year: 'This year',
  month: 'This month',
  week: 'This week',
};

const MEDAL: Record<number, { color: string; label: string; glow: string }> = {
  1: { color: '#FFD700', label: '🥇', glow: '#FFD70022' },   // gold
  2: { color: '#C0C0C0', label: '🥈', glow: '#C0C0C022' },   // silver
  3: { color: '#3B82F6', label: '🥉', glow: '#3B82F622' },   // blue (per spec)
};

export default function GlobalLeaderboardScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminLeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<Period>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.adminGlobalLeaderboard({ period, q: query });
      setRows(r.leaderboard);
    } catch (e: any) {
      showAlert('Failed to load leaderboard', String(e?.message || e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period, query]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={10} testID="agl-back">
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Global Leaderboard</Text>
          <Text style={styles.subtitle}>Top 100 · {PERIOD_LABEL[period]}</Text>
        </View>
        <View style={styles.crownPill}>
          <Ionicons name="shield-checkmark" size={12} color="#FFD700" />
          <Text style={styles.crownText}>CREATOR</Text>
        </View>
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Find a player on the global board…"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          returnKeyType="search"
          testID="agl-search"
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Period selector */}
      <View style={styles.row}>
        <Text style={styles.rowLabel}>VIEW</Text>
        <View style={styles.pillGroup}>
          {(['all', 'year', 'month', 'week'] as Period[]).map((p) => (
            <Pill
              key={p}
              label={PERIOD_LABEL[p]}
              active={period === p}
              onPress={() => setPeriod(p)}
              testID={`agl-period-${p}`}
            />
          ))}
        </View>
      </View>

      {loading && rows.length === 0 ? (
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 60 }} />
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(p) => `${p.user_id}-${p.rank}`}
          estimatedItemSize={80}
          contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.xl }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.cyan}
              onRefresh={() => { setRefreshing(true); load(); }}
            />
          }
          ListEmptyComponent={() => (
            <View style={{ alignItems: 'center', marginTop: 40 }}>
              <Ionicons name="trophy-outline" size={32} color={colors.textMuted} />
              <Text style={[styles.subtitle, { marginTop: 6 }]}>No players match this filter.</Text>
            </View>
          )}
          renderItem={({ item }) => {
            const medal = MEDAL[item.rank];
            const labelXp = period === 'all' ? `${item.total_xp.toLocaleString()} XP lifetime` : `${item.period_xp.toLocaleString()} XP ${PERIOD_LABEL[period].toLowerCase()}`;
            return (
              <TouchableOpacity
                style={[
                  styles.card,
                  medal && { borderColor: medal.color, backgroundColor: medal.glow },
                ]}
                activeOpacity={0.85}
                onPress={() => router.push({ pathname: '/admin/player/[id]', params: { id: item.user_id } } as any)}
                testID={`agl-row-${item.rank}`}
              >
                {/* Rank chip */}
                <View
                  style={[
                    styles.rankChip,
                    medal && { backgroundColor: medal.color + '33', borderColor: medal.color },
                  ]}
                >
                  {medal ? (
                    <Text style={{ fontSize: 16 }}>{medal.label}</Text>
                  ) : (
                    <Text style={[styles.rankText, item.rank === 1 && { color: '#FFD700' }]}>
                      {item.rank}
                    </Text>
                  )}
                  <Text style={[styles.rankSuffix, medal && { color: medal.color, fontWeight: '900' as const }]}>
                    {ordinal(item.rank)}
                  </Text>
                </View>

                {item.avatar_base64 ? (
                  <Image
                    source={{ uri: `data:image/jpeg;base64,${item.avatar_base64}` }}
                    style={styles.avatar}
                  />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarLetter}>{(item.name || '?').slice(0, 1).toUpperCase()}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                    {item.is_admin ? <Text style={styles.adminTag}>  · CREATOR</Text> : null}
                  </Text>
                  <View style={styles.metaRow}>
                    <Ionicons name="trophy-outline" size={11} color={colors.amber} />
                    <Text style={styles.metaText}>Lv {item.level} · {labelXp}</Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

function Pill({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[styles.pill, active && styles.pillActive]} testID={testID}>
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
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

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: spacing.md, marginTop: spacing.sm,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 14 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: spacing.md, marginTop: spacing.sm },
  rowLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, width: 50 },
  pillGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, flex: 1 },
  pill: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: colors.cyan + '22', borderColor: colors.cyan },
  pillText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  pillTextActive: { color: colors.cyan, fontWeight: '900' },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1.5, borderColor: colors.border,
    padding: 12, marginTop: spacing.sm,
  },
  rankChip: {
    minWidth: 50, height: 44, paddingHorizontal: 8,
    borderRadius: radii.md, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 3,
  },
  rankText: { color: colors.text, fontSize: 14, fontWeight: '900' },
  rankSuffix: { color: colors.textMuted, fontSize: 10, fontWeight: '700' },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: { backgroundColor: colors.cyan + '22', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: colors.cyan, fontWeight: '900', fontSize: 16 },
  name: { color: colors.text, fontSize: 14, fontWeight: '900' },
  adminTag: { color: '#FFD700', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  metaText: { color: colors.textMuted, fontSize: 11 },
});
