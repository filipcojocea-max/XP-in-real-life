/**
 * /admin/players-dates  — Creator-only roster of all accounts.
 *
 *  • Sortable: Newest ↔ Oldest by created_at.
 *  • Filterable: All time / past 7 days / past 30 days.
 *  • Live search by name OR email (case-insensitive substring).
 *  • Each row exposes: avatar · name · level · email · "Created on
 *    {Mon DD YYYY · HH:MM}". Tap to open the full profile modal.
 *
 *  Server side: GET /api/admin/players/by-creation
 *  Guard: 403 unless profile.is_admin === true.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { api, type AdminPlayerRow } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

type Order = 'newest' | 'oldest';
type Since = 'all' | 'week' | 'month';

export default function PlayersDatesScreen() {
  const router = useRouter();
  const [players, setPlayers] = useState<AdminPlayerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [order, setOrder] = useState<Order>('newest');
  const [since, setSince] = useState<Since>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.adminPlayersByCreation({ order, since, q: query, limit: 200 });
      setPlayers(r.players);
    } catch (e: any) {
      showAlert('Failed to load roster', String(e?.message || e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [order, since, query]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const filtered = useMemo(() => players, [players]);

  const formatStamp = (iso: string | null | undefined) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return `${d.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' })} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return iso;
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={10} testID="apd-back">
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>View Players Dates</Text>
          <Text style={styles.subtitle}>{players.length} {players.length === 1 ? 'account' : 'accounts'} · creator-only</Text>
        </View>
        <View style={styles.crownPill}>
          <Ionicons name="shield-checkmark" size={12} color="#FFD700" />
          <Text style={styles.crownText}>CREATOR</Text>
        </View>
      </View>

      {/* Inactive accounts entry point — v1.0.29 admin tool to find
          long-dormant accounts and (optionally) delete them. */}
      <TouchableOpacity
        testID="apd-inactive-link"
        onPress={() => router.push('/admin/inactive-accounts' as any)}
        style={styles.inactiveLink}
        activeOpacity={0.85}
      >
        <Ionicons name="time-outline" size={16} color="#FF4D6D" />
        <View style={{ flex: 1 }}>
          <Text style={styles.inactiveLinkTitle}>Inactive Accounts</Text>
          <Text style={styles.inactiveLinkSub}>
            View dormant players · 2 weeks / 1 month / 6 months
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color="#FF4D6D" />
      </TouchableOpacity>

      {/* Search */}
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name or email…"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          returnKeyType="search"
          testID="apd-search"
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Sort */}
      <View style={styles.row}>
        <Text style={styles.rowLabel}>SORT</Text>
        <View style={styles.pillGroup}>
          <Pill label="Newest first" active={order === 'newest'} onPress={() => setOrder('newest')} testID="apd-order-newest" />
          <Pill label="Oldest first" active={order === 'oldest'} onPress={() => setOrder('oldest')} testID="apd-order-oldest" />
        </View>
      </View>

      {/* Filter */}
      <View style={styles.row}>
        <Text style={styles.rowLabel}>FILTER</Text>
        <View style={styles.pillGroup}>
          <Pill label="All time" active={since === 'all'} onPress={() => setSince('all')} testID="apd-since-all" />
          <Pill label="Past week" active={since === 'week'} onPress={() => setSince('week')} testID="apd-since-week" />
          <Pill label="Past month" active={since === 'month'} onPress={() => setSince('month')} testID="apd-since-month" />
        </View>
      </View>

      {loading && players.length === 0 ? (
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 60 }} />
      ) : (
        <FlashList
          data={filtered}
          keyExtractor={(p) => p.user_id}
          estimatedItemSize={84}
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
              <Ionicons name="people-outline" size={32} color={colors.textMuted} />
              <Text style={[styles.subtitle, { marginTop: 6 }]}>No accounts match your filter.</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.85}
              onPress={() => router.push({ pathname: '/admin/player/[id]', params: { id: item.user_id } } as any)}
              testID={`apd-row-${item.user_id}`}
            >
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
                {item.email ? (
                  <Text style={styles.emailText} numberOfLines={1}>{item.email}</Text>
                ) : null}
                <View style={styles.metaRow}>
                  <Ionicons name="calendar-outline" size={12} color={colors.cyan} />
                  <Text style={styles.metaText}>Created {formatStamp(item.created_at)}</Text>
                </View>
                <View style={styles.metaRow}>
                  <Ionicons name="trophy-outline" size={12} color={colors.amber} />
                  <Text style={styles.metaText}>Lv {item.level} · {item.total_xp.toLocaleString()} XP · {item.tasks_completed} tasks</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function Pill({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[styles.pill, active && styles.pillActive]}
      testID={testID}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
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

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: spacing.md, marginTop: spacing.sm,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 14 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: spacing.md, marginTop: spacing.sm,
  },
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
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: 12, marginTop: spacing.sm,
  },
  avatar: { width: 48, height: 48, borderRadius: 24 },
  avatarFallback: { backgroundColor: colors.cyan + '22', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: colors.cyan, fontWeight: '900', fontSize: 18 },
  name: { color: colors.text, fontSize: 14, fontWeight: '900' },
  adminTag: { color: '#FFD700', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  emailText: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  metaText: { color: colors.textMuted, fontSize: 11 },

  /** Banner-style entry point near the top of the screen that opens the
   *  v1.0.29 inactive-accounts admin view. */
  inactiveLink: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: spacing.md, marginTop: 10,
    paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: radii.md, borderWidth: 1, borderColor: '#FF4D6D55',
    backgroundColor: '#FF4D6D15',
  },
  inactiveLinkTitle: { color: '#FF4D6D', fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },
  inactiveLinkSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
});
