/**
 * Spot the Object — Permanent Group Detail (v1.0.29 Phase 1)
 *
 * Shows the members, their status, and the Leave / Add Players /
 * Auto-Challenge toggle controls. Phase 2 will wire the random-
 * challenge scheduler driven by the auto-challenge toggle here.
 *
 * Status badge legend (Phase 1 keeps it simple):
 *   • active   — member currently in the group (green dot)
 *   • left     — member soft-left (grey dot + "Left at <ts>")
 * Phase 2 adds: sleeping / at_work / unavailable derived from each
 * player's profile schedule + timezone.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../src/api';
import { showAlert, showConfirm } from '../../../src/uiAlert';
import { colors, radii, spacing } from '../../../src/theme';

type GroupMember = {
  user_id: string;
  name: string;
  avatar_base64?: string | null;
  status: 'active' | 'left' | 'sleeping' | 'at_work';
  role: 'owner' | 'member';
  joined_at?: string | null;
  left_at?: string | null;
};

type Group = {
  id: string;
  name: string;
  owner_id: string;
  auto_challenge_on: boolean;
  member_count: number;
  max_members: number;
  viewer_is_member: boolean;
  members: GroupMember[];
};

function StatusBadge({ status, left_at }: { status: GroupMember['status']; left_at?: string | null }) {
  if (status === 'left') {
    const when = left_at ? new Date(left_at).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '';
    return (
      <View style={[styles.badge, { borderColor: '#94a3b8', backgroundColor: '#94a3b822' }]}>
        <Ionicons name="exit-outline" size={10} color="#94a3b8" />
        <Text style={[styles.badgeText, { color: '#94a3b8' }]} numberOfLines={1}>
          Left{when ? ` ${when}` : ''}
        </Text>
      </View>
    );
  }
  if (status === 'sleeping') {
    return (
      <View style={[styles.badge, { borderColor: colors.cyan, backgroundColor: colors.cyan + '22' }]}>
        <Ionicons name="moon" size={10} color={colors.cyan} />
        <Text style={[styles.badgeText, { color: colors.cyan }]}>Sleeping</Text>
      </View>
    );
  }
  if (status === 'at_work') {
    return (
      <View style={[styles.badge, { borderColor: colors.amber, backgroundColor: colors.amber + '22' }]}>
        <Ionicons name="briefcase" size={10} color={colors.amber} />
        <Text style={[styles.badgeText, { color: colors.amber }]}>At work</Text>
      </View>
    );
  }
  return (
    <View style={[styles.badge, { borderColor: colors.green, backgroundColor: colors.green + '22' }]}>
      <View style={styles.dot} />
      <Text style={[styles.badgeText, { color: colors.green }]}>Active</Text>
    </View>
  );
}

export default function SpotGroupDetail() {
  const { gid } = useLocalSearchParams<{ gid: string }>();
  const router = useRouter();
  const [group, setGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [friends, setFriends] = useState<{ user_id: string; name?: string; avatar_base64?: string | null }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!gid) return;
    try {
      const r = await api.spotGroupGet(String(gid));
      setGroup(r.group as Group);
    } catch (e: any) {
      showAlert("Couldn't load group", String(e?.message || e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [gid]);

  useEffect(() => { load(); }, [load]);

  const onToggleAuto = async (next: boolean) => {
    if (!group) return;
    setSaving(true);
    try {
      const r = await api.spotGroupPatch(group.id, { auto_challenge_on: next });
      setGroup(r.group as Group);
    } catch (e: any) {
      showAlert("Couldn't save", String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const onLeave = async () => {
    if (!group) return;
    const ok = await showConfirm(
      'Leave this group?',
      `You'll stop receiving challenges for "${group.name}". The other members won't be notified.`,
      { confirmText: 'Leave', cancelText: 'Cancel', destructive: true },
    );
    if (!ok) return;
    try {
      await api.spotGroupLeave(group.id);
      router.back();
    } catch (e: any) {
      showAlert("Couldn't leave", String(e?.message || e));
    }
  };

  const openAdd = async () => {
    setAddOpen(true);
    try {
      const fs = await api.listFriends();
      const memberIds = new Set(group?.members.filter((m) => m.status !== 'left').map((m) => m.user_id) || []);
      setFriends((fs.friends || []).filter((f: any) => !memberIds.has(f.user_id)));
    } catch (e: any) {
      showAlert("Couldn't load friends", String(e?.message || e));
    }
  };

  const onConfirmAdd = async () => {
    if (!group || picked.size === 0) return;
    setSaving(true);
    try {
      const r = await api.spotGroupAddMembers(group.id, Array.from(picked));
      setGroup(r.group as Group);
      setPicked(new Set());
      setAddOpen(false);
    } catch (e: any) {
      showAlert("Couldn't add", String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={colors.amber} style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  if (!group) return null;
  const activeCount = group.members.filter((m) => m.status === 'active').length;
  const canAdd = activeCount < group.max_members;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{group.name}</Text>
        <View style={{ width: 26 }} />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.amber} />
        }
      >
        {/* Auto-challenge toggle */}
        <View style={styles.toggleCard}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={styles.toggleTitle}>Spot random objects at random times</Text>
            <Text style={styles.toggleBody}>
              When on, the app sends 3 surprise challenges per day to everyone in this group at the
              exact same moment — daylight-only in each player&apos;s timezone, with a minimum of
              1.5h between challenges. Any member can toggle this.
            </Text>
          </View>
          <Switch
            value={group.auto_challenge_on}
            onValueChange={onToggleAuto}
            disabled={saving}
            thumbColor={group.auto_challenge_on ? colors.amber : '#94a3b8'}
            trackColor={{ false: '#555', true: colors.amber + '88' }}
          />
        </View>

        <View style={styles.sectionRow}>
          <Text style={styles.sectionLabel}>MEMBERS · {activeCount}/{group.max_members}</Text>
          <TouchableOpacity
            onPress={openAdd}
            disabled={!canAdd}
            style={[styles.addBtn, !canAdd && { opacity: 0.4 }]}
            activeOpacity={0.8}
            testID="spot-group-add-players"
          >
            <Ionicons name="person-add" size={14} color={colors.amber} />
            <Text style={styles.addBtnText}>ADD PLAYERS</Text>
          </TouchableOpacity>
        </View>

        {group.members.map((m) => (
          <View key={m.user_id} style={styles.memberRow}>
            {m.avatar_base64 ? (
              <Image source={{ uri: `data:image/jpeg;base64,${m.avatar_base64}` }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, { backgroundColor: colors.amber + '22', alignItems: 'center', justifyContent: 'center' }]}>
                <Ionicons name="person" size={18} color={colors.amber} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.memberName} numberOfLines={1}>
                {m.name}{m.role === 'owner' ? ' · Owner' : ''}
              </Text>
              <StatusBadge status={m.status} left_at={m.left_at} />
            </View>
          </View>
        ))}

        <TouchableOpacity onPress={onLeave} style={styles.leaveBtn} activeOpacity={0.85} testID="spot-group-leave">
          <Ionicons name="exit" size={16} color={colors.red} />
          <Text style={styles.leaveBtnText}>Leave this Spot the Object group</Text>
        </TouchableOpacity>
      </ScrollView>

      <Modal visible={addOpen} animationType="slide" transparent onRequestClose={() => setAddOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add players</Text>
            <Text style={styles.modalBody}>
              {activeCount}/{group.max_members} active. You can add {group.max_members - activeCount} more.
            </Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {friends.map((f) => {
                const checked = picked.has(f.user_id);
                return (
                  <TouchableOpacity
                    key={f.user_id}
                    onPress={() => {
                      const n = new Set(picked);
                      if (checked) n.delete(f.user_id);
                      else if (n.size + activeCount < group.max_members) n.add(f.user_id);
                      setPicked(n);
                    }}
                    style={[styles.pickRow, checked && { borderColor: colors.amber, backgroundColor: colors.amber + '22' }]}
                  >
                    <Ionicons
                      name={checked ? 'checkbox' : 'square-outline'}
                      size={20}
                      color={checked ? colors.amber : colors.textMuted}
                    />
                    <Text style={[styles.memberName, { flex: 1 }]} numberOfLines={1}>
                      {f.name || 'Player'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              {friends.length === 0 ? (
                <Text style={[styles.toggleBody, { textAlign: 'center', padding: 20 }]}>
                  No eligible friends. Add new friends from the Friends tab first.
                </Text>
              ) : null}
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
              <TouchableOpacity onPress={() => { setAddOpen(false); setPicked(new Set()); }} style={[styles.modalBtn, { backgroundColor: colors.surface }]}>
                <Text style={[styles.modalBtnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onConfirmAdd}
                disabled={picked.size === 0 || saving}
                style={[styles.modalBtn, { backgroundColor: colors.amber, opacity: picked.size === 0 ? 0.5 : 1 }]}
              >
                {saving ? <ActivityIndicator color={colors.bg} /> : <Text style={[styles.modalBtnText, { color: colors.bg }]}>Add {picked.size || ''}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: { color: colors.text, fontSize: 16, fontWeight: '900', flex: 1, textAlign: 'center' },
  toggleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.amber + '88',
  },
  toggleTitle: { color: colors.text, fontWeight: '900', fontSize: 14, marginBottom: 4 },
  toggleBody: { color: colors.textMuted, fontSize: 12, lineHeight: 16 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  sectionLabel: { color: colors.amber, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: colors.amber + '22',
    borderWidth: 1,
    borderColor: colors.amber + '88',
  },
  addBtnText: { color: colors.amber, fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  memberName: { color: colors.text, fontWeight: '800', fontSize: 13, marginBottom: 4 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, alignSelf: 'flex-start' },
  badgeText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.3 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green },
  leaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.red + '22',
    borderWidth: 1,
    borderColor: colors.red + '88',
    borderRadius: radii.pill,
    paddingVertical: 12,
    marginTop: spacing.xl,
  },
  leaveBtnText: { color: colors.red, fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', justifyContent: 'center', padding: spacing.lg },
  modalCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: '900', marginBottom: 4 },
  modalBody: { color: colors.textMuted, fontSize: 12, marginBottom: 12 },
  pickRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, marginBottom: 6,
  },
  modalBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: radii.pill },
  modalBtnText: { fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
});
