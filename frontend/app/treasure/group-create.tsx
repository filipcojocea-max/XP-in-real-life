/**
 * /treasure/group-create — Step 2 of the Friends flow.
 *
 * 1. Name the group.
 * 2. Pick friends to invite. We show the player's FULL friend list,
 *    each row is tappable to toggle selection.
 * 3. Tap CREATE & INVITE → server creates the group, then for every
 *    selected friend tries to send an invite. The server runs the
 *    50 km area check; any friends who fail land in a "Could not
 *    invite" summary popup so the user understands why.
 * 4. On success we navigate to /treasure/group/[id] to await accepts.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api, type Player } from '../../src/api';
import { colors, radii, spacing } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

export default function GroupCreate() {
  const router = useRouter();
  const { lat, lng, radius_m } = useLocalSearchParams<{ lat: string; lng: string; radius_m: string }>();

  const [name, setName] = useState('');
  const [friends, setFriends] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.friendsList();
      setFriends((r.friends as Player[]) || []);
    } catch (e: any) {
      showAlert('Failed to load friends', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSubmit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      showAlert('Name your group', 'Give your hunt a name your crew will recognize.');
      return;
    }
    if (selected.size === 0) {
      showAlert('Pick at least 1 friend', 'You need someone to hunt with you!');
      return;
    }
    const lat_n = parseFloat(String(lat));
    const lng_n = parseFloat(String(lng));
    const rad_n = parseFloat(String(radius_m));
    if (!Number.isFinite(lat_n) || !Number.isFinite(lng_n) || !Number.isFinite(rad_n)) {
      showAlert('Missing area', 'Go back, pick an area on the map, then try again.');
      return;
    }
    setBusy(true);
    try {
      const g = await api.btGroupCreate(trimmed, lat_n, lng_n, rad_n);
      const inv = await api.btGroupInvite(g.id, Array.from(selected));
      // Summarise rejections so the creator knows who was blocked.
      const rejected = [...(inv.rejected_too_far || []), ...(inv.rejected_other || [])];
      if (rejected.length > 0) {
        const lines = rejected.slice(0, 4).map((r) => {
          const f = friends.find((x) => x.user_id === r.user_id);
          return `• ${f?.name || r.user_id}: ${('distance_km' in r && r.distance_km) ? `${r.distance_km} km away — ` : ''}${(r as any).reason}`;
        }).join('\n');
        const more = rejected.length > 4 ? `\n…and ${rejected.length - 4} more.` : '';
        showAlert(
          'Some invites were not sent',
          `${lines}${more}\n\nYou cannot invite this person because they are not in your area.`,
        );
      }
      router.replace(`/treasure/group/${g.id}`);
    } catch (e: any) {
      showAlert('Could not create group', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [name, selected, lat, lng, radius_m, friends, router]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Create Group</Text>
        <View style={styles.headerBtn} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
        <Text style={styles.label}>Group name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Saturday Hunt Crew"
          placeholderTextColor={colors.textMuted}
          style={styles.nameInput}
          maxLength={80}
          testID="bt-group-name"
        />

        <Text style={styles.label}>Invite friends</Text>
        <Text style={styles.helper}>
          Friends who are more than 50 km away will be blocked automatically — the hunt is for people in your area.
        </Text>
        {loading ? (
          <ActivityIndicator color={colors.cyan} style={{ marginVertical: 20 }} />
        ) : friends.length === 0 ? (
          <View style={styles.emptyBlock}>
            <Ionicons name="person-add-outline" size={26} color={colors.textMuted} />
            <Text style={styles.emptyText}>No friends yet. Add some in the Friends tab, then come back!</Text>
          </View>
        ) : (
          friends.map((f) => {
            const isSel = selected.has(f.user_id);
            return (
              <TouchableOpacity
                key={f.user_id}
                style={[styles.friendRow, isSel && styles.friendRowSel]}
                onPress={() => toggle(f.user_id)}
                activeOpacity={0.85}
                testID={`bt-friend-${f.user_id}`}
              >
                <View style={[styles.avatar, { backgroundColor: colors.cyan + '22' }]}>
                  <Text style={styles.avatarLetter}>{(f.name || '?').slice(0, 1).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.friendName}>{f.name}</Text>
                  <Text style={styles.friendSub}>Lv {f.level} · {f.total_xp.toLocaleString()} XP</Text>
                </View>
                <View style={[styles.checkbox, isSel && styles.checkboxOn]}>
                  {isSel ? <Ionicons name="checkmark" size={16} color="#0b0f15" /> : null}
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.cta, (busy || selected.size === 0) && { opacity: 0.5 }]}
          disabled={busy || selected.size === 0}
          onPress={onSubmit}
          activeOpacity={0.85}
          testID="bt-group-submit"
        >
          {busy ? (
            <ActivityIndicator color="#0b0f15" />
          ) : (
            <>
              <Ionicons name="send" size={18} color="#0b0f15" />
              <Text style={styles.ctaText}>CREATE & INVITE ({selected.size})</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.sm, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerBtn: { width: 40, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1, textAlign: 'center' },
  label: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  nameInput: {
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    color: colors.text, fontSize: 15, padding: 12,
  },
  helper: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  emptyBlock: {
    alignItems: 'center', padding: spacing.lg, gap: 6,
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
  },
  emptyText: { color: colors.textSecondary, fontSize: 12, textAlign: 'center' },
  friendRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: spacing.sm, backgroundColor: colors.surface,
    borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
  },
  friendRowSel: { borderColor: colors.cyan, backgroundColor: colors.cyan + '12' },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: colors.cyan, fontWeight: '900' },
  friendName: { color: colors.text, fontWeight: '700' },
  friendSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  checkbox: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  footer: {
    padding: spacing.md, borderTopWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cta: {
    backgroundColor: colors.cyan, borderRadius: radii.lg,
    paddingVertical: 14, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  ctaText: { color: '#0b0f15', fontWeight: '900', letterSpacing: 0.5 },
});
