/**
 * /admin/inactive-accounts  — Creator-only view of dormant players.
 *
 * Backend: GET /api/admin/players/inactive?bucket=2w|1m|6m
 *   • Inactivity = max(profile.last_seen_at, latest task_logs.completed_at).
 *   • Sorted longest-inactive → shortest-inactive.
 *   • 2w  = 14+ days dormant
 *     1m  = 30+ days dormant
 *     6m  = 180+ days dormant
 *
 * Each row tap → confirm modal → cascade-delete the account.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';
import { api } from '../../src/api';
import type { InactivePlayerRow } from '../../src/api';
import { DeletePlayerConfirmModal } from '../../src/components/AdminPlayerTools';

type Bucket = '2w' | '1m' | '6m';
const BUCKET_LABELS: Record<Bucket, string> = {
  '2w': '2 weeks',
  '1m': '1 month',
  '6m': '6 months',
};

function fmtTimeAgo(days: number) {
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export default function InactiveAccountsScreen() {
  const router = useRouter();
  const [bucket, setBucket] = useState<Bucket>('2w');
  const [rows, setRows] = useState<InactivePlayerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [thresholdDays, setThresholdDays] = useState(14);
  const [confirmDelete, setConfirmDelete] = useState<InactivePlayerRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.adminInactivePlayers(bucket);
      setRows(r.players || []);
      setThresholdDays(r.threshold_days || 14);
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
  }, [bucket, router]);

  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="iv-back">
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Inactive Accounts</Text>
          <Text style={styles.subtitle}>
            {rows.length} {rows.length === 1 ? 'account' : 'accounts'} ·
            inactive {thresholdDays}+ days
          </Text>
        </View>
        <View style={styles.crownPill}>
          <Ionicons name="shield-checkmark" size={12} color="#FFD700" />
          <Text style={styles.crownText}>CREATOR</Text>
        </View>
      </View>

      <View style={styles.filterRow}>
        {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => (
          <TouchableOpacity
            key={b}
            testID={`iv-bucket-${b}`}
            onPress={() => setBucket(b)}
            style={[styles.pill, bucket === b && styles.pillActive]}
            activeOpacity={0.85}
          >
            <Text style={[styles.pillText, bucket === b && styles.pillTextActive]}>
              {BUCKET_LABELS[b]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 60 }} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.user_id}
          contentContainerStyle={{
            paddingHorizontal: spacing.md,
            paddingBottom: spacing.xl,
            gap: 8,
          }}
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
          ListEmptyComponent={
            <Text style={styles.empty}>
              No accounts inactive {thresholdDays}+ days. 🎉
            </Text>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`iv-row-${item.user_id}`}
              onPress={() => setConfirmDelete(item)}
              activeOpacity={0.85}
              style={styles.card}
            >
              {item.avatar_base64 ? (
                <Image
                  source={{ uri: `data:image/jpeg;base64,${item.avatar_base64}` }}
                  style={styles.avatar}
                />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.avatarLetter}>
                    {(item.name || '?').slice(0, 1).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.emailText} numberOfLines={1}>
                  {item.email || item.user_id}
                </Text>
                <View style={styles.metaRow}>
                  <Ionicons name="time-outline" size={11} color="#FF4D6D" />
                  <Text style={styles.metaText}>
                    Last active {fmtTimeAgo(item.days_inactive)} ago · Lv {item.level}
                  </Text>
                </View>
              </View>
              <View style={styles.deletePill}>
                <Ionicons name="trash" size={13} color="#FF4D6D" />
                <Text style={styles.deletePillText}>DELETE</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      <DeletePlayerConfirmModal
        visible={confirmDelete !== null}
        userId={confirmDelete?.user_id || ''}
        userName={confirmDelete?.name || ''}
        userEmail={confirmDelete?.email}
        onClose={() => setConfirmDelete(null)}
        onDeleted={() => {
          // Remove the just-deleted player from the list optimistically
          // and trigger a refresh.
          if (confirmDelete) {
            setRows((prev) => prev.filter((r) => r.user_id !== confirmDelete.user_id));
          }
          setConfirmDelete(null);
          showAlert('Deleted', `${confirmDelete?.name || 'Account'} has been removed.`);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '900' },
  subtitle: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  crownPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999,
    backgroundColor: '#FFD70022', borderWidth: 1, borderColor: '#FFD70088',
  },
  crownText: { color: '#FFD700', fontSize: 9, fontWeight: '900', letterSpacing: 1 },

  filterRow: { flexDirection: 'row', padding: spacing.md, gap: 8 },
  pill: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: '#FF4D6D22', borderColor: '#FF4D6D' },
  pillText: { color: colors.textMuted, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  pillTextActive: { color: '#FF4D6D' },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    padding: 12,
  },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: { backgroundColor: '#FF4D6D22', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#FF4D6D', fontWeight: '900', fontSize: 17 },
  name: { color: colors.text, fontSize: 14, fontWeight: '900' },
  emailText: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  metaText: { color: colors.textMuted, fontSize: 11 },
  deletePill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999,
    backgroundColor: '#FF4D6D15', borderWidth: 1, borderColor: '#FF4D6D88',
  },
  deletePillText: { color: '#FF4D6D', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  empty: { color: colors.textMuted, textAlign: 'center', padding: spacing.xl, fontSize: 13 },
});
