/**
 * /spot/multiplayer/new
 *
 * Friend-picker for starting a new match. Tap up to 7 friends, then
 * "Create lobby" to spin up the match. We then route into the match
 * detail screen where the host can tap "Start Now".
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showAlert } from '../../../src/uiAlert';
import { colors, spacing } from '../../../src/theme';
import { api, type Player } from '../../../src/api';

const MAX_INVITES = 7;

export default function NewSpotMatch() {
  const router = useRouter();
  const [friends, setFriends] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listFriends();
      setFriends(r.friends || []);
    } catch (e: any) {
      showAlert('Could not load friends', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (uid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        if (next.size >= MAX_INVITES) {
          showAlert('Limit reached', `You can invite up to ${MAX_INVITES} friends per match.`);
          return prev;
        }
        next.add(uid);
      }
      return next;
    });
  };

  const create = async () => {
    if (selected.size === 0) {
      showAlert('Pick a friend', 'Select at least one friend to invite.');
      return;
    }
    if (creating) return;
    setCreating(true);
    try {
      const r = await api.spotMatchCreate(Array.from(selected));
      router.replace(`/spot/multiplayer/${r.match.id}`);
    } catch (e: any) {
      showAlert('Could not create match', String(e?.message || e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="mp-new-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.topTitleWrap}>
          <Text style={styles.topTitle}>Invite friends</Text>
          <Text style={styles.topSub}>{selected.size}/{MAX_INVITES} selected</Text>
        </View>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.cyan} />
        </View>
      ) : friends.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Ionicons name="people-outline" size={42} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No friends yet</Text>
          <Text style={styles.emptyDesc}>
            Add some friends from the Friends+ tab first, then come back to invite them.
          </Text>
          <TouchableOpacity
            style={styles.findFriendsBtn}
            onPress={() => router.push('/friends')}
            testID="mp-find-friends"
          >
            <Text style={styles.findFriendsText}>Open Friends+</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120 }}>
          {friends.map((f) => {
            const isSel = selected.has(f.user_id);
            return (
              <TouchableOpacity
                key={f.user_id}
                activeOpacity={0.85}
                onPress={() => toggle(f.user_id)}
                style={[styles.row, isSel && styles.rowSel]}
                testID={`mp-friend-${f.user_id}`}
              >
                {f.avatar_base64 ? (
                  <Image source={{ uri: `data:image/jpeg;base64,${f.avatar_base64}` }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarLetter}>{(f.name || '?').slice(0, 1).toUpperCase()}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{f.name}</Text>
                  <Text style={styles.sub}>Lv {f.level} · {f.total_xp} XP</Text>
                </View>
                <View style={[styles.check, isSel && styles.checkOn]}>
                  {isSel ? <Ionicons name="checkmark" size={16} color={colors.bg} /> : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Bottom CTA */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={[styles.cta, (selected.size === 0 || creating) && styles.ctaDisabled]}
          disabled={selected.size === 0 || creating}
          onPress={create}
          testID="mp-create-lobby"
          activeOpacity={0.85}
        >
          {creating ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.ctaText}>
              Create lobby ({selected.size})
            </Text>
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
  topSub: { color: colors.cyan, fontSize: 11, fontWeight: '700' },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '900', marginTop: 12 },
  emptyDesc: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  findFriendsBtn: {
    marginTop: 18,
    backgroundColor: colors.cyan,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 10,
  },
  findFriendsText: { color: colors.bg, fontWeight: '900' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 64,
  },
  rowSel: { borderColor: colors.cyan, backgroundColor: colors.cyan + '15' },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  avatarFallback: { backgroundColor: colors.cyan + '22', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: colors.cyan, fontWeight: '900' },
  name: { color: colors.text, fontSize: 14, fontWeight: '800' },
  sub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  check: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { borderColor: colors.cyan, backgroundColor: colors.cyan },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.md,
    paddingBottom: spacing.lg,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  cta: {
    backgroundColor: colors.cyan,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  ctaDisabled: { backgroundColor: colors.surface },
  ctaText: { color: colors.bg, fontSize: 15, fontWeight: '900' },
});
