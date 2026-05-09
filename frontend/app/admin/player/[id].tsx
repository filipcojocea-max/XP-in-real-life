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
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api, type Player } from '../../../src/api';
import { colors, spacing, radii } from '../../../src/theme';
import { showAlert } from '../../../src/uiAlert';

export default function AdminPlayerScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [player, setPlayer] = useState<Player | null>(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => { load(); }, [load]);

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
          <Stat label="Streak" value={`${player.current_streak} d`} icon="flame" color={colors.amber} />
          <Stat label="Best streak" value={`${player.best_streak} d`} icon="medal" color="#9333EA" />
        </View>

        {/* Account meta */}
        <View style={styles.metaCard}>
          <Text style={styles.kicker}>ACCOUNT META</Text>
          <Row label="User ID" value={player.user_id} mono />
          <Row label="Friend status" value={player.friend_status} />
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
  kicker: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginBottom: 8 },
  rowMeta: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingVertical: 6, gap: 12 },
  rowMetaLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  rowMetaValue: { color: colors.text, fontSize: 12, fontWeight: '700', flex: 1, textAlign: 'right' },
  rowMetaMono: { fontFamily: 'Courier', fontSize: 10 },
});
