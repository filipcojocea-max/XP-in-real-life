/**
 * /admin/purchase-history — Creator-only audit log of all Library+ purchases.
 *
 * Shows {user, app, price, source, duo metadata} so the Creator can see who
 * bought what and through which referral link. Backed by
 *   GET /api/admin/purchase-history (admin-only — 403 otherwise).
 *
 * Filter: All | Solo | Duo (referral)
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';
import { api } from '../../src/api';
import type { AdminPurchaseRow } from '../../src/api';

const FILTERS = ['all', 'duo', 'solo'] as const;
type Filter = typeof FILTERS[number];

function timeAgo(iso: string): string {
  try {
    const t = Date.parse(iso);
    const diff = Math.max(0, Date.now() - t);
    const m = Math.floor(diff / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  } catch {
    return '';
  }
}

const APP_LABEL: Record<string, string> = {
  sleep: 'Improve Sleeping',
  challenges: 'Challenge Tasks',
  spot: 'Spot the Object',
  confidence: 'Build Confidence',
};

export default function PurchaseHistoryScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminPurchaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.adminPurchaseHistory();
      setRows(r.purchases || []);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('403')) {
        showAlert('Creator only', 'This page is only visible to the Creator account.');
        router.back();
      } else {
        showAlert('Could not load', msg);
      }
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (filter === 'all') return rows;
    if (filter === 'duo') return rows.filter((r) => r.source === 'duo');
    if (filter === 'solo') return rows.filter((r) => r.source !== 'duo');
    return rows;
  }, [rows, filter]);

  const tally = useMemo(() => {
    const totalSpend = rows.reduce(
      (acc, r) => acc + (Number(r.paid_amount) || 0),
      0,
    );
    const duoCount = rows.filter((r) => r.source === 'duo').length;
    const currency = (rows.find((r) => r.paid_currency)?.paid_currency || 'USD').toUpperCase();
    return { totalSpend, duoCount, total: rows.length, currency };
  }, [rows]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Purchase History</Text>
        <TouchableOpacity onPress={load} hitSlop={10}>
          <Ionicons name="refresh" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.statRow}>
        <Stat label="Total" value={String(tally.total)} />
        <Stat label="Duo" value={String(tally.duoCount)} tint="#B388FF" />
        <Stat
          label={`Revenue (${tally.currency})`}
          value={tally.totalSpend.toFixed(2)}
        />
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f}
            testID={`history-filter-${f}`}
            onPress={() => setFilter(f)}
            style={[styles.filterPill, filter === f && styles.filterPillActive]}
            activeOpacity={0.8}
          >
            <Text
              style={[styles.filterPillText, filter === f && styles.filterPillTextActive]}
            >
              {f.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.cyan} />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: spacing.md, gap: 10 }}
          ListEmptyComponent={
            <Text style={styles.empty}>No purchases yet.</Text>
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load().finally(() => setRefreshing(false));
              }}
              tintColor={colors.cyan}
            />
          }
          renderItem={({ item }) => <PurchaseRow row={item} />}
        />
      )}
    </SafeAreaView>
  );
}

function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, tint ? { color: tint } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function PurchaseRow({ row }: { row: AdminPurchaseRow }) {
  const isDuo = row.source === 'duo';
  return (
    <View style={[styles.card, isDuo && { borderColor: '#B388FF55' }]}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.userName} numberOfLines={1}>
            {row.user_name}
          </Text>
          <Text style={styles.userEmail} numberOfLines={1}>
            {row.user_email || row.user_id}
          </Text>
        </View>
        <View style={styles.priceBlock}>
          <Text style={styles.priceText}>
            {row.paid_amount != null && row.paid_currency
              ? `${row.paid_amount.toFixed(2)} ${row.paid_currency}`
              : 'free'}
          </Text>
          <Text style={styles.timeText}>{timeAgo(row.purchased_at)}</Text>
        </View>
      </View>
      <View style={styles.cardBody}>
        <View style={[styles.tagPill, { backgroundColor: colors.cyan + '22', borderColor: colors.cyan + '55' }]}>
          <Ionicons name="cube" size={11} color={colors.cyan} />
          <Text style={[styles.tagText, { color: colors.cyan }]}>
            {APP_LABEL[row.app_id] || row.app_id}
          </Text>
        </View>
        <View
          style={[
            styles.tagPill,
            isDuo
              ? { backgroundColor: '#B388FF22', borderColor: '#B388FF66' }
              : { backgroundColor: colors.border, borderColor: colors.border },
          ]}
        >
          <Ionicons
            name={isDuo ? 'people' : 'person'}
            size={11}
            color={isDuo ? '#B388FF' : colors.textMuted}
          />
          <Text style={[styles.tagText, { color: isDuo ? '#B388FF' : colors.textMuted }]}>
            {isDuo ? 'DUO' : (row.source || 'solo').toUpperCase()}
          </Text>
        </View>
        {row.duo ? (
          <Text style={styles.codeText}>
            CODE <Text style={styles.codePillText}>{row.duo.code}</Text> ·{' '}
            {row.duo.members_count}/{row.duo.required_people}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    justifyContent: 'space-between',
  },
  topTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: colors.textMuted, padding: spacing.lg, textAlign: 'center' },

  statRow: { flexDirection: 'row', paddingHorizontal: spacing.md, paddingTop: 12, gap: 8 },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  statValue: { color: colors.text, fontSize: 20, fontWeight: '900' },
  statLabel: { color: colors.textMuted, fontSize: 10, marginTop: 2, letterSpacing: 1 },

  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    gap: 8,
  },
  filterPill: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterPillActive: { backgroundColor: colors.cyan + '22', borderColor: colors.cyan },
  filterPillText: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  filterPillTextActive: { color: colors.cyan },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 8,
  },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  userName: { color: colors.text, fontSize: 14, fontWeight: '800' },
  userEmail: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  priceBlock: { alignItems: 'flex-end' },
  priceText: { color: colors.text, fontWeight: '900' },
  timeText: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  cardBody: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  tagPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  tagText: { fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  codeText: { color: colors.textMuted, fontSize: 10, letterSpacing: 1, marginLeft: 6 },
  codePillText: { color: '#B388FF', fontWeight: '900' },
});
