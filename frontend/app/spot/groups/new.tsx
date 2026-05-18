/**
 * Spot the Object — Create Permanent Group (v1.0.29 Phase 1)
 *
 * Permanent groups differ from the legacy "match" flow in `multiplayer/new`:
 *   • They SURVIVE across days (no auto-cleanup).
 *   • They support an auto-challenge toggle (Phase 2 random scheduler).
 *   • Up to 8 players (incl. the creator).
 *
 * UX rules per spec:
 *   • Friend-only picker (gates are enforced server-side too).
 *   • Optional group name (default: "Spot Group · <day month>")
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, type Player } from '../../../src/api';
import { showAlert } from '../../../src/uiAlert';
import { colors, radii, spacing } from '../../../src/theme';

const MAX_INVITES = 7; // +1 (the creator) = 8 cap.

export default function NewSpotGroup() {
  const router = useRouter();
  const [friends, setFriends] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listFriends();
      setFriends(r.friends || []);
    } catch (e: any) {
      showAlert("Couldn't load friends", String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (uid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        if (next.size >= MAX_INVITES) {
          showAlert('Group full', `A group can have up to ${MAX_INVITES + 1} players (including you).`);
          return prev;
        }
        next.add(uid);
      }
      return next;
    });
  };

  const create = async () => {
    if (selected.size === 0) {
      showAlert('Pick at least one friend', 'Permanent groups need at least one other player.');
      return;
    }
    if (creating) return;
    setCreating(true);
    try {
      const r = await api.spotGroupCreate({
        name: name.trim() || undefined,
        member_ids: Array.from(selected),
      });
      router.replace(`/spot/groups/${r.group.id}` as any);
    } catch (e: any) {
      showAlert("Couldn't create group", String(e?.message || e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="spot-newgrp-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.topTitleWrap}>
          <Text style={styles.topTitle}>New Spot Group</Text>
          <Text style={styles.topSub}>{selected.size}/{MAX_INVITES} friends · permanent</Text>
        </View>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}>
        {/* Optional name */}
        <Text style={styles.label}>GROUP NAME (OPTIONAL)</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={60}
          placeholder="e.g. Coffee Crew, Roomies, Spot Squad"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          testID="spot-newgrp-name"
        />

        <Text style={[styles.label, { marginTop: spacing.lg }]}>INVITE FRIENDS</Text>
        {loading ? (
          <ActivityIndicator color={colors.amber} style={{ marginTop: 30 }} />
        ) : friends.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Ionicons name="people-outline" size={36} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No friends yet</Text>
            <Text style={styles.emptyDesc}>
              Add friends from the Friends+ tab to start a permanent Spot the Object group with them.
            </Text>
            <TouchableOpacity
              style={styles.findBtn}
              onPress={() => router.push('/friends')}
              testID="spot-newgrp-findfriends"
            >
              <Text style={styles.findBtnText}>Open Friends+</Text>
            </TouchableOpacity>
          </View>
        ) : (
          friends.map((f) => {
            const isSel = selected.has(f.user_id);
            return (
              <TouchableOpacity
                key={f.user_id}
                activeOpacity={0.85}
                onPress={() => toggle(f.user_id)}
                style={[styles.row, isSel && styles.rowSel]}
                testID={`spot-newgrp-friend-${f.user_id}`}
              >
                {f.avatar_base64 ? (
                  <Image
                    source={{ uri: `data:image/jpeg;base64,${f.avatar_base64}` }}
                    style={styles.avatar}
                  />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarLetter}>
                      {(f.name || '?').slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>{f.name}</Text>
                  <Text style={styles.sub}>Lv {f.level} · {f.total_xp} XP</Text>
                </View>
                <View style={[styles.check, isSel && styles.checkOn]}>
                  {isSel ? <Ionicons name="checkmark" size={16} color={colors.bg} /> : null}
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={[styles.cta, (selected.size === 0 || creating) && styles.ctaDisabled]}
          disabled={selected.size === 0 || creating}
          onPress={create}
          testID="spot-newgrp-create"
          activeOpacity={0.85}
        >
          {creating ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.ctaText}>Create group ({selected.size + 1})</Text>
          )}
        </TouchableOpacity>
      </View>
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
  },
  topTitleWrap: { flex: 1, paddingLeft: 10 },
  topTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  topSub: { color: colors.amber, fontSize: 11, fontWeight: '700' },
  label: { color: colors.amber, fontSize: 11, fontWeight: '900', letterSpacing: 1, marginBottom: 6 },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 14,
  },
  emptyWrap: { alignItems: 'center', paddingVertical: 30 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '900', marginTop: 10 },
  emptyDesc: {
    color: colors.textMuted, fontSize: 12, textAlign: 'center',
    marginTop: 4, paddingHorizontal: 24, lineHeight: 17,
  },
  findBtn: {
    marginTop: 14, backgroundColor: colors.amber,
    paddingHorizontal: 22, paddingVertical: 10, borderRadius: radii.pill,
  },
  findBtnText: { color: colors.bg, fontWeight: '900' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, borderRadius: 12,
    padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border, minHeight: 64,
  },
  rowSel: { borderColor: colors.amber, backgroundColor: colors.amber + '15' },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  avatarFallback: { backgroundColor: colors.amber + '22', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: colors.amber, fontWeight: '900' },
  name: { color: colors.text, fontSize: 14, fontWeight: '800' },
  sub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  check: {
    width: 26, height: 26, borderRadius: 13,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkOn: { borderColor: colors.amber, backgroundColor: colors.amber },
  bottomBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: spacing.md, paddingBottom: spacing.lg,
    backgroundColor: colors.bg,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  cta: {
    backgroundColor: colors.amber, paddingVertical: 14,
    borderRadius: 12, alignItems: 'center',
    minHeight: 48, justifyContent: 'center',
  },
  ctaDisabled: { backgroundColor: colors.surface },
  ctaText: { color: colors.bg, fontSize: 15, fontWeight: '900' },
});
