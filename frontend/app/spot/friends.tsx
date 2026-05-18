/**
 * Spot the Object — "Spot with Friends" hub
 *
 * Hosts the MY GROUPS list + the "+ NEW" lobby creator entrance. This
 * was previously rendered inline on /spot but per user mock the parent
 * Spot screen now stays focused on the 3 main play modes (Solo, Random
 * Toggle, Spot with Friends). Tap the "Spot with Friends" card on /spot
 * to reach this screen.
 *
 * Everything below is the same UI we used before — just moved one level
 * deeper in the navigation tree. No backend changes required.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../src/api';
import { showAlert } from '../../src/uiAlert';
import { colors, radii, spacing } from '../../src/theme';

type GroupRow = {
  id: string;
  name: string;
  member_count: number;
  max_members: number;
  auto_challenge_on?: boolean;
  // Phase 4 fields:
  started?: boolean;
  pending_count?: number;
  viewer_status?: string;
};

export default function SpotFriends() {
  const router = useRouter();
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.spotGroupsList();
      setGroups((r.groups || []) as GroupRow[]);
    } catch (e: any) {
      showAlert("Couldn't load your groups", String(e?.message || e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const subtitle = (g: GroupRow) => {
    const players = `${g.member_count} of ${g.max_members} player${g.member_count === 1 ? '' : 's'}`;
    if ((g.pending_count || 0) > 0) return `${players} · ${g.pending_count} pending`;
    if (g.started || g.auto_challenge_on) return `${players} · game on`;
    return `${players} · lobby`;
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="spot-friends-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.topTitleWrap}>
          <Text style={styles.topTitle}>Spot with Friends</Text>
          <Text style={styles.topSub}>Permanent groups · 2-min rounds</Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push('/spot/groups/new' as any)}
          style={styles.newBtn}
          activeOpacity={0.8}
          testID="spot-new-group"
        >
          <Ionicons name="add" size={14} color={colors.amber} />
          <Text style={styles.newBtnText}>NEW</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 80 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor={colors.amber}
          />
        }
      >
        <Text style={styles.intro}>
          Create a lobby with up to 8 friends. Once everyone accepts, any member can tap
          <Text style={{ fontWeight: '900', color: colors.amber }}> Start new game</Text>. The
          group then receives 3 surprise object challenges per day at the same moment for
          everyone — 2 minutes to find &amp; photograph each one.
        </Text>

        <Text style={[styles.sectionLabel, { marginTop: spacing.lg }]}>MY GROUPS</Text>
        {loading ? (
          <ActivityIndicator color={colors.amber} style={{ marginTop: 30 }} />
        ) : groups.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Ionicons name="people-outline" size={36} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No groups yet</Text>
            <Text style={styles.emptyDesc}>
              Tap the amber NEW button above to invite friends and create your first lobby.
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/spot/groups/new' as any)}
              style={styles.cta}
              activeOpacity={0.85}
              testID="spot-friends-empty-cta"
            >
              <Ionicons name="add" size={16} color={colors.bg} />
              <Text style={styles.ctaText}>Create new group</Text>
            </TouchableOpacity>
          </View>
        ) : (
          groups.map((g) => (
            <TouchableOpacity
              key={g.id}
              onPress={() => router.push(`/spot/groups/${g.id}` as any)}
              activeOpacity={0.8}
              style={styles.groupRow}
              testID={`spot-group-row-${g.id}`}
            >
              <View style={[styles.groupIcon, { backgroundColor: colors.amber + '22' }]}>
                <Ionicons name="people" size={20} color={colors.amber} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.groupName} numberOfLines={1}>{g.name}</Text>
                <Text style={styles.groupMeta} numberOfLines={1}>
                  {subtitle(g)}
                </Text>
              </View>
              {g.viewer_status === 'pending' ? (
                <View style={styles.pendingPill}>
                  <Text style={styles.pendingPillText}>INVITE</Text>
                </View>
              ) : null}
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
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
    gap: 10,
  },
  topTitleWrap: { flex: 1 },
  topTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  topSub: { color: colors.cyan, fontSize: 11, fontWeight: '700' },
  newBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: radii.pill, borderWidth: 1, borderColor: colors.amber,
    backgroundColor: colors.amber + '15',
  },
  newBtnText: { color: colors.amber, fontWeight: '900', fontSize: 12, letterSpacing: 0.5 },
  intro: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  sectionLabel: { color: colors.amber, fontSize: 11, fontWeight: '900', letterSpacing: 1, marginBottom: 8 },
  emptyWrap: { alignItems: 'center', paddingVertical: 30 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '900', marginTop: 10 },
  emptyDesc: {
    color: colors.textMuted, fontSize: 12, textAlign: 'center',
    marginTop: 4, paddingHorizontal: 24, lineHeight: 17,
  },
  cta: {
    marginTop: 14, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.amber, paddingHorizontal: 18, paddingVertical: 10,
    borderRadius: radii.pill,
  },
  ctaText: { color: colors.bg, fontWeight: '900' },
  groupRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, borderRadius: radii.md,
    padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  groupIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  groupName: { color: colors.text, fontWeight: '900', fontSize: 14 },
  groupMeta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  pendingPill: {
    backgroundColor: '#f59e0b22',
    borderRadius: radii.pill,
    paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 1, borderColor: '#f59e0b',
    marginRight: 4,
  },
  pendingPillText: { color: '#f59e0b', fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
});
