/**
 * /spot/multiplayer
 * Hub for the Spot the Object Multiplayer mode.
 *
 * Three sections, polled every 4 s while focused so an incoming invite
 * appears without the user having to manually pull-to-refresh:
 *  1) "Active matches" — status='active' (in-flight games to jump back into)
 *  2) "Pending lobbies" — status='waiting' (the host is still gathering)
 *  3) "Recent results" — status='finished' / 'cancelled' inside last 24 h
 *
 * The big "Start Match" button at the top opens the friend-picker.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing } from '../../../src/theme';
import { api, type SpotMatch } from '../../../src/api';

export default function SpotMultiplayerHub() {
  const router = useRouter();
  const [matches, setMatches] = useState<SpotMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.spotMatchList();
      setMatches(r.matches || []);
    } catch {
      // swallow — keep last-known state
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Poll while focused so invites land within ~4 s.
  useFocusEffect(
    useCallback(() => {
      load();
      const id = setInterval(load, 4000);
      return () => clearInterval(id);
    }, [load]),
  );

  const active = matches.filter((m) => m.status === 'active');
  const waiting = matches.filter((m) => m.status === 'waiting');
  const recent = matches.filter((m) => m.status === 'finished' || m.status === 'cancelled');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="mp-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.topTitleWrap}>
          <View style={styles.miniIconBox}>
            <Ionicons name="people" size={14} color={colors.cyan} />
          </View>
          <Text style={styles.topTitle}>Spot Multiplayer</Text>
        </View>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={colors.cyan}
          />
        }
      >
        {/* CTA — start a new match */}
        <TouchableOpacity
          activeOpacity={0.85}
          style={styles.ctaCard}
          onPress={() => router.push('/spot/multiplayer/new')}
          testID="mp-new-match"
        >
          <View style={styles.ctaIcon}>
            <Ionicons name="add-circle" size={32} color={colors.bg} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.ctaTitle}>Start a new match</Text>
            <Text style={styles.ctaDesc}>
              Invite up to 7 friends. 2-min round. Winner +5 SP, losers −1.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={22} color={colors.bg} />
        </TouchableOpacity>

        {loading ? (
          <View style={{ paddingVertical: 32, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={colors.cyan} />
          </View>
        ) : (
          <>
            {active.length > 0 && (
              <Section title="LIVE NOW" icon="flame">
                {active.map((m) => (
                  <MatchRow key={m.id} match={m} onPress={() => router.push(`/spot/multiplayer/${m.id}`)} />
                ))}
              </Section>
            )}

            <Section title="PENDING LOBBIES" icon="hourglass">
              {waiting.length === 0 ? (
                <Empty
                  text="No open lobbies."
                  hint="Invitations from your friends will land here."
                />
              ) : (
                waiting.map((m) => (
                  <MatchRow key={m.id} match={m} onPress={() => router.push(`/spot/multiplayer/${m.id}`)} />
                ))
              )}
            </Section>

            {recent.length > 0 && (
              <Section title="RECENT RESULTS" icon="time">
                {recent.map((m) => (
                  <MatchRow key={m.id} match={m} onPress={() => router.push(`/spot/multiplayer/${m.id}`)} />
                ))}
              </Section>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: spacing.lg }}>
      <View style={styles.sectionHead}>
        <Ionicons name={icon} size={12} color={colors.textMuted} />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function Empty({ text, hint }: { text: string; hint?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{text}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

function MatchRow({ match, onPress }: { match: SpotMatch; onPress: () => void }) {
  const host = match.players.find((p) => p.is_host);
  const playerCount = match.players.filter((p) => p.joined).length;
  const totalCount = match.players.length;
  const statusBadge = (() => {
    switch (match.status) {
      case 'active':
        return { color: colors.cyan, label: `LIVE · ${match.seconds_left ?? 0}s left` };
      case 'waiting':
        return { color: colors.amber, label: `WAITING · ${playerCount}/${totalCount}` };
      case 'finished': {
        const winnerName = match.winner_id
          ? match.players.find((p) => p.user_id === match.winner_id)?.name || 'Winner'
          : 'No winner';
        return { color: colors.green, label: `WON BY ${winnerName.toUpperCase()}` };
      }
      case 'cancelled':
        return { color: colors.textMuted, label: 'CANCELLED' };
      default:
        return { color: colors.textMuted, label: match.status.toUpperCase() };
    }
  })();
  const target = match.target_object;
  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.matchRow} onPress={onPress} testID={`mp-row-${match.id}`}>
      <View style={[styles.matchIcon, { backgroundColor: statusBadge.color + '22', borderColor: statusBadge.color + '88' }]}>
        <Ionicons
          name={match.status === 'active' ? 'flash' : match.status === 'waiting' ? 'hourglass' : 'flag'}
          size={20}
          color={statusBadge.color}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.matchTitle}>{target ? `Find: ${target}` : 'New match'}</Text>
        <Text style={styles.matchSub}>
          Hosted by {host?.name || '—'} · {totalCount} player{totalCount === 1 ? '' : 's'}
        </Text>
        <View style={[styles.statusPill, { backgroundColor: statusBadge.color + '22' }]}>
          <Text style={[styles.statusPillText, { color: statusBadge.color }]}>{statusBadge.label}</Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
    </TouchableOpacity>
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
  topTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10 },
  miniIconBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    backgroundColor: colors.cyan + '22',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  ctaCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.cyan,
    borderRadius: 14,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  ctaIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaTitle: { color: colors.bg, fontSize: 16, fontWeight: '900' },
  ctaDesc: { color: 'rgba(0,0,0,0.7)', fontSize: 12, marginTop: 2 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  sectionTitle: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  empty: { padding: spacing.lg, alignItems: 'center', borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, borderRadius: 12 },
  emptyText: { color: colors.text, fontWeight: '700' },
  emptyHint: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  matchIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  matchTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  matchSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  statusPill: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, marginTop: 6 },
  statusPillText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
});
