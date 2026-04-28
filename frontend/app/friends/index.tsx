import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  ActivityIndicator,
  Modal,
  ScrollView,
  Image,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api, Player, FriendStatus, FriendRequestEntry } from '../../src/api';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';
import LeaderboardTab from '../../src/components/LeaderboardTab';
import PremiumShield from '../../src/components/PremiumShield';

type TopTab = 'players' | 'friends' | 'leaderboard';
type FriendsSubTab = 'requests' | 'mine';

export default function FriendsScreen() {
  const [topTab, setTopTab] = useState<TopTab>('players');
  const [subTab, setSubTab] = useState<FriendsSubTab>('requests');

  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [loadingPlayers, setLoadingPlayers] = useState(true);

  const [requests, setRequests] = useState<{ incoming: FriendRequestEntry[]; outgoing: FriendRequestEntry[] }>({
    incoming: [],
    outgoing: [],
  });
  const [friends, setFriends] = useState<Player[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [openProfile, setOpenProfile] = useState<Player | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Debounce search input — 250ms feels good for fuzzy server search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const loadPlayers = useCallback(async (q: string) => {
    setLoadingPlayers(true);
    try {
      const r = await api.listPlayers(q);
      setPlayers(r.players);
    } catch (e: any) {
      showAlert('Could not load players', String(e?.message || e));
    } finally {
      setLoadingPlayers(false);
    }
  }, []);

  const loadFriendsData = useCallback(async () => {
    setLoadingFriends(true);
    try {
      const [reqs, fr] = await Promise.all([api.listFriendRequests(), api.listFriends()]);
      setRequests(reqs);
      setFriends(fr.friends);
    } catch (e: any) {
      console.log('friends', e);
    } finally {
      setLoadingFriends(false);
    }
  }, []);

  useEffect(() => {
    if (topTab === 'players') loadPlayers(debouncedQ);
  }, [topTab, debouncedQ, loadPlayers]);

  useEffect(() => {
    if (topTab === 'friends') loadFriendsData();
  }, [topTab, loadFriendsData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (topTab === 'players') await loadPlayers(debouncedQ);
    else await loadFriendsData();
    setRefreshing(false);
  }, [topTab, debouncedQ, loadPlayers, loadFriendsData]);

  // ── Friend actions ────────────────────────────────────────────────────
  const updatePlayerInList = (id: string, status: FriendStatus) => {
    setPlayers((prev) => prev.map((p) => (p.user_id === id ? { ...p, friend_status: status } : p)));
    if (openProfile && openProfile.user_id === id) {
      setOpenProfile({ ...openProfile, friend_status: status });
    }
  };

  const onAddFriend = async (p: Player) => {
    setSavingId(p.user_id);
    try {
      const r = await api.sendFriendRequest(p.user_id);
      updatePlayerInList(p.user_id, r.status);
      showAlert('Friend request', r.message || 'Sent');
    } catch (e: any) {
      showAlert('Could not send', String(e?.message || e));
    } finally {
      setSavingId(null);
    }
  };

  const onAccept = async (p: Player) => {
    setSavingId(p.user_id);
    try {
      await api.acceptFriendRequest(p.user_id);
      updatePlayerInList(p.user_id, 'friends');
      // refresh friends list / requests
      loadFriendsData();
    } catch (e: any) {
      showAlert('Could not accept', String(e?.message || e));
    } finally {
      setSavingId(null);
    }
  };

  const onDecline = async (p: Player) => {
    setSavingId(p.user_id);
    try {
      await api.declineFriendRequest(p.user_id);
      updatePlayerInList(p.user_id, 'none');
      loadFriendsData();
    } catch (e: any) {
      showAlert('Could not decline', String(e?.message || e));
    } finally {
      setSavingId(null);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* Top header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Friends+</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* Top tabs: Players | Friends | Leaderboard */}
      <View style={styles.tabsRow}>
        <TabPill label="Players" active={topTab === 'players'} onPress={() => setTopTab('players')} testID="ftab-players" />
        <TabPill label="Friends" active={topTab === 'friends'} onPress={() => setTopTab('friends')} testID="ftab-friends" />
        <TabPill label="Leaderboard" active={topTab === 'leaderboard'} onPress={() => setTopTab('leaderboard')} testID="ftab-leaderboard" />
      </View>

      {topTab === 'players' ? (
        <PlayersTab
          query={query}
          onChangeQuery={setQuery}
          players={players}
          loading={loadingPlayers}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onPress={setOpenProfile}
          onAddFriend={onAddFriend}
          savingId={savingId}
        />
      ) : topTab === 'friends' ? (
        <FriendsTab
          subTab={subTab}
          setSubTab={setSubTab}
          requests={requests}
          friends={friends}
          loading={loadingFriends}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onAccept={onAccept}
          onDecline={onDecline}
          onPress={setOpenProfile}
          savingId={savingId}
        />
      ) : (
        <LeaderboardTab />
      )}

      <PlayerProfileModal
        player={openProfile}
        onClose={() => setOpenProfile(null)}
        onAddFriend={onAddFriend}
        onAccept={onAccept}
        onDecline={onDecline}
        savingId={savingId}
      />
    </SafeAreaView>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────
function TabPill({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      style={[styles.tabPill, active && styles.tabPillActive]}
      activeOpacity={0.85}
    >
      <Text style={[styles.tabPillText, active && styles.tabPillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function PlayersTab({
  query, onChangeQuery, players, loading, refreshing, onRefresh, onPress, onAddFriend, savingId,
}: {
  query: string;
  onChangeQuery: (s: string) => void;
  players: Player[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onPress: (p: Player) => void;
  onAddFriend: (p: Player) => void;
  savingId: string | null;
}) {
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textMuted} />
        <TextInput
          testID="players-search"
          placeholder="Search players..."
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={onChangeQuery}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.length > 0 ? (
          <TouchableOpacity onPress={() => onChangeQuery('')}>
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {loading && players.length === 0 ? (
        <View style={styles.center}><ActivityIndicator color={colors.cyan} /></View>
      ) : players.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={36} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No players found</Text>
          <Text style={styles.emptyDesc}>Try a different search term</Text>
        </View>
      ) : (
        <FlatList
          data={players}
          keyExtractor={(p) => p.user_id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cyan} />}
          renderItem={({ item }) => (
            <PlayerCard
              player={item}
              onPress={() => onPress(item)}
              onAddFriend={() => onAddFriend(item)}
              saving={savingId === item.user_id}
            />
          )}
        />
      )}
    </View>
  );
}

function FriendsTab({
  subTab, setSubTab, requests, friends, loading, refreshing, onRefresh,
  onAccept, onDecline, onPress, savingId,
}: {
  subTab: FriendsSubTab;
  setSubTab: (t: FriendsSubTab) => void;
  requests: { incoming: FriendRequestEntry[]; outgoing: FriendRequestEntry[] };
  friends: Player[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onAccept: (p: Player) => void;
  onDecline: (p: Player) => void;
  onPress: (p: Player) => void;
  savingId: string | null;
}) {
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.subTabsRow}>
        <SubTab label={`Friend Requests${requests.incoming.length ? ` (${requests.incoming.length})` : ''}`} active={subTab === 'requests'} onPress={() => setSubTab('requests')} testID="sub-requests" />
        <SubTab label={`My Friends${friends.length ? ` (${friends.length})` : ''}`} active={subTab === 'mine'} onPress={() => setSubTab('mine')} testID="sub-mine" />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.cyan} /></View>
      ) : subTab === 'requests' ? (
        <FlatList
          data={requests.incoming}
          keyExtractor={(r) => r.request_id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cyan} />}
          ListHeaderComponent={
            requests.outgoing.length > 0 ? (
              <View>
                <Text style={styles.sectionLabel}>Sent by you</Text>
                {requests.outgoing.map((r) => (
                  <View key={r.request_id} style={styles.requestRow}>
                    <PlayerAvatar player={r.player} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.playerName}>{r.player.name}</Text>
                      <Text style={styles.playerMeta}>Lv {r.player.level} · {r.player.total_xp} XP · pending</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => onDecline(r.player)}
                      disabled={savingId === r.player.user_id}
                      style={styles.smallActionBtn}
                    >
                      <Text style={styles.smallActionText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                <Text style={styles.sectionLabel}>Incoming</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            requests.outgoing.length === 0 ? (
              <View style={styles.center}>
                <Ionicons name="mail-open-outline" size={36} color={colors.textMuted} />
                <Text style={styles.emptyTitle}>No friend requests</Text>
                <Text style={styles.emptyDesc}>When someone sends you a request it'll show here.</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity activeOpacity={0.85} onPress={() => onPress(item.player)} style={styles.requestRow}>
              <PlayerAvatar player={item.player} />
              <View style={{ flex: 1 }}>
                <Text style={styles.playerName}>{item.player.name}</Text>
                <Text style={styles.playerMeta}>Lv {item.player.level} · {item.player.total_xp} XP</Text>
              </View>
              <TouchableOpacity
                testID={`accept-${item.player.user_id}`}
                onPress={() => onAccept(item.player)}
                disabled={savingId === item.player.user_id}
                style={[styles.smallActionBtn, { backgroundColor: colors.green, borderColor: colors.green }]}
              >
                <Text style={[styles.smallActionText, { color: colors.bg }]}>Accept</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID={`decline-${item.player.user_id}`}
                onPress={() => onDecline(item.player)}
                disabled={savingId === item.player.user_id}
                style={styles.smallActionBtn}
              >
                <Text style={styles.smallActionText}>Decline</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      ) : (
        <FlatList
          data={friends}
          keyExtractor={(p) => p.user_id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cyan} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="happy-outline" size={36} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>No friends yet</Text>
              <Text style={styles.emptyDesc}>Browse Players and send a request.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <PlayerCard
              player={item}
              onPress={() => onPress(item)}
              saving={savingId === item.user_id}
            />
          )}
        />
      )}
    </View>
  );
}

function SubTab({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity testID={testID} onPress={onPress} style={[styles.subTab, active && styles.subTabActive]} activeOpacity={0.85}>
      <Text style={[styles.subTabText, active && styles.subTabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function PlayerCard({ player, onPress, onAddFriend, saving }: {
  player: Player;
  onPress: () => void;
  onAddFriend?: () => void;
  saving?: boolean;
}) {
  const adminView = !!player.is_admin_view;
  // "Active 1.5 hrs ago" label — only meaningful (and only shown) when
  // they're already on our friends list. Anyone else's last_seen is
  // hidden for privacy.
  const lastSeenText =
    player.friend_status === 'friends' && player.last_seen_at
      ? formatLastSeen(player.last_seen_at)
      : null;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[styles.playerCard, adminView && { borderColor: '#FFD700', backgroundColor: '#FFD70010' }]}
      testID={`player-${player.user_id}`}
    >
      <PlayerAvatar player={player} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.playerName, adminView && { color: '#FFD700' }]} numberOfLines={1}>{player.name}</Text>
        <View style={styles.playerStatsRow}>
          <View style={[styles.statChip, adminView && { borderColor: '#FFD70088', backgroundColor: '#FFD70015' }]}>
            <Ionicons name="ribbon" size={11} color={adminView ? '#FFD700' : colors.cyan} />
            <Text style={[styles.statChipText, adminView && { color: '#FFD700' }]}>
              {adminView ? '∞' : `Lv ${player.level}`}
            </Text>
          </View>
          <View style={[styles.statChip, adminView && { borderColor: '#FFD70088', backgroundColor: '#FFD70015' }]}>
            <Ionicons name="flash" size={11} color={adminView ? '#FFD700' : colors.amber} />
            <Text style={[styles.statChipText, { color: adminView ? '#FFD700' : colors.amber }]}>
              {adminView ? '∞' : `${player.total_xp} XP`}
            </Text>
          </View>
        </View>
        {lastSeenText ? (
          <View style={styles.lastSeenRow} testID={`last-seen-${player.user_id}`}>
            <Ionicons name="time-outline" size={10} color={colors.textMuted} />
            <Text style={styles.lastSeenText} numberOfLines={1}>{lastSeenText}</Text>
          </View>
        ) : null}
      </View>
      {onAddFriend ? <FriendActionButton player={player} onAddFriend={onAddFriend} saving={saving} /> : null}
    </TouchableOpacity>
  );
}

/**
 * Humanise an ISO-8601 timestamp into the format the spec requested:
 *   - <1 min  → "Active just now"
 *   - <1 hr   → "Active less than 1hr ago"  (e.g. anything under 60 min)
 *   - <24 hr  → "Active 1.5 hrs ago" (one decimal place)
 *   - <30 d   → "Active 3 days ago"
 *   - else    → "Active a while ago"
 */
function formatLastSeen(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return 'Last seen on this app: unknown';
    const diffMs = Date.now() - t;
    if (diffMs < 0) return 'Active just now';
    const diffMin = diffMs / 60000;
    if (diffMin < 1) return 'Active just now';
    if (diffMin < 60) return 'Active less than 1hr ago';
    const diffH = diffMin / 60;
    if (diffH < 24) {
      // 1.0, 1.5, 2.0, ... — one decimal so "1.5 hrs ago" is preserved
      const rounded = Math.round(diffH * 2) / 2;
      const display = Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`;
      return `Active ${display} hr${rounded === 1 ? '' : 's'} ago`;
    }
    const diffD = diffH / 24;
    if (diffD < 30) {
      const d = Math.floor(diffD);
      return `Active ${d} day${d === 1 ? '' : 's'} ago`;
    }
    return 'Active a while ago';
  } catch {
    return 'Last seen on this app: unknown';
  }
}

function PlayerAvatar({ player }: { player: Player }) {
  const adminView = !!player.is_admin_view;
  const wrapStyle = adminView ? { borderWidth: 2, borderColor: '#FFD700', borderRadius: 26, padding: 1 } : undefined;
  if (player.avatar_base64) {
    return (
      <View style={wrapStyle as any}>
        <Image source={{ uri: `data:image/jpeg;base64,${player.avatar_base64}` }} style={styles.avatar} />
      </View>
    );
  }
  return (
    <View style={wrapStyle as any}>
      <View style={[styles.avatar, styles.avatarFallback, adminView && { backgroundColor: '#FFD70022', borderColor: '#FFD700' }]}>
        <Text style={[styles.avatarLetter, adminView && { color: '#FFD700' }]}>
          {(player.name || '?').slice(0, 1).toUpperCase()}
        </Text>
      </View>
    </View>
  );
}

function FriendActionButton({ player, onAddFriend, saving }: { player: Player; onAddFriend: () => void; saving?: boolean }) {
  const status = player.friend_status;
  if (status === 'friends') {
    return (
      <View style={[styles.actionBtn, { borderColor: colors.green + '88', backgroundColor: colors.green + '15' }]}>
        <Ionicons name="checkmark-circle" size={14} color={colors.green} />
        <Text style={[styles.actionBtnText, { color: colors.green }]}>Already Friends</Text>
      </View>
    );
  }
  if (status === 'pending_outgoing') {
    return (
      <View style={[styles.actionBtn, { borderColor: colors.textMuted, opacity: 0.7 }]}>
        <Ionicons name="hourglass" size={13} color={colors.textMuted} />
        <Text style={[styles.actionBtnText, { color: colors.textMuted }]}>Pending</Text>
      </View>
    );
  }
  if (status === 'pending_incoming') {
    return (
      <View style={[styles.actionBtn, { borderColor: colors.amber + '88', backgroundColor: colors.amber + '15' }]}>
        <Ionicons name="mail-unread" size={13} color={colors.amber} />
        <Text style={[styles.actionBtnText, { color: colors.amber }]}>Tap to accept</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity
      onPress={(e) => { e.stopPropagation?.(); onAddFriend(); }}
      disabled={saving}
      style={[styles.actionBtn, { borderColor: colors.cyan, backgroundColor: colors.cyan + '15' }, saving && { opacity: 0.6 }]}
      testID={`add-friend-${player.user_id}`}
    >
      <Ionicons name="person-add" size={13} color={colors.cyan} />
      <Text style={[styles.actionBtnText, { color: colors.cyan }]}>Add Friend</Text>
    </TouchableOpacity>
  );
}

function PlayerProfileModal({
  player, onClose, onAddFriend, onAccept, onDecline, savingId,
}: {
  player: Player | null;
  onClose: () => void;
  onAddFriend: (p: Player) => void;
  onAccept: (p: Player) => void;
  onDecline: (p: Player) => void;
  savingId: string | null;
}) {
  if (!player) return null;
  const saving = savingId === player.user_id;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Player Profile</Text>
          <View style={{ width: 36 }} />
        </View>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl }}>
          {player.is_admin_view ? (
            <View style={{ alignItems: 'center', marginBottom: spacing.md }}>
              <PremiumShield level={999} size={140} />
              <View style={{
                marginTop: 12,
                paddingHorizontal: 14, paddingVertical: 6,
                borderRadius: 999,
                backgroundColor: '#FFD700',
                borderWidth: 2, borderColor: '#FFEB3B',
              }}>
                <Text style={{ color: colors.bg, fontWeight: '900', fontSize: 12, letterSpacing: 1.2 }}>
                  ∞ CREATOR · PREMIUM+
                </Text>
              </View>
            </View>
          ) : (
            <View style={[styles.modalAvatarWrap]}>
              {player.avatar_base64 ? (
                <Image
                  source={{ uri: `data:image/jpeg;base64,${player.avatar_base64}` }}
                  style={styles.bigAvatar}
                />
              ) : (
                <View style={[styles.bigAvatar, styles.avatarFallback]}>
                  <Text style={styles.bigAvatarLetter}>
                    {(player.name || '?').slice(0, 1).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={styles.levelPill}>
                <Text style={styles.levelPillText}>LV {player.level}</Text>
              </View>
            </View>
          )}
          <Text style={[styles.modalName, player.is_admin_view && { color: '#FFD700' }]}>{player.name}</Text>

          <View style={styles.modalStatsGrid}>
            <ModalStat icon="flash" color={player.is_admin_view ? '#FFD700' : colors.amber}
              value={player.is_admin_view ? '∞' : player.total_xp.toString()} label="Total XP" />
            <ModalStat icon="flame" color={player.is_admin_view ? '#FFD700' : colors.red}
              value={player.is_admin_view ? '∞' : player.current_streak.toString()} label="Streak" />
            <ModalStat icon="trophy" color={player.is_admin_view ? '#FFD700' : colors.amber}
              value={player.is_admin_view ? '∞' : player.best_streak.toString()} label="Best" />
            <ModalStat icon="checkmark-circle" color={player.is_admin_view ? '#FFD700' : colors.green}
              value={player.is_admin_view ? '∞' : player.tasks_completed.toString()} label="Quests" />
            <ModalStat icon="flag" color={player.is_admin_view ? '#FFD700' : colors.cyan}
              value={player.is_admin_view ? '∞' : player.goals_completed.toString()} label="Goals" />
          </View>

          {player.bio && !player.is_admin_view ? (
            <View style={styles.modalBioCard}>
              <Text style={styles.modalBioLabel}>BIO</Text>
              <Text style={styles.modalBioText}>{player.bio}</Text>
            </View>
          ) : null}

          {/* Action area */}
          <View style={{ marginTop: spacing.lg }}>
            {player.friend_status === 'self' ? null
              : player.friend_status === 'friends' ? (
                <View style={[styles.modalCta, { backgroundColor: colors.green + '22', borderColor: colors.green + '99' }]}>
                  <Ionicons name="checkmark-circle" size={18} color={colors.green} />
                  <Text style={[styles.modalCtaText, { color: colors.green }]}>Already Friends</Text>
                </View>
              ) : player.friend_status === 'pending_outgoing' ? (
                <View style={[styles.modalCta, { backgroundColor: colors.surfaceGlass, borderColor: colors.border }]}>
                  <Ionicons name="hourglass" size={18} color={colors.textMuted} />
                  <Text style={[styles.modalCtaText, { color: colors.textMuted }]}>Friend request sent</Text>
                </View>
              ) : player.friend_status === 'pending_incoming' ? (
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    style={[styles.modalCta, { flex: 1, backgroundColor: colors.green, borderColor: colors.green }]}
                    onPress={() => onAccept(player)}
                    disabled={saving}
                    testID="modal-accept"
                  >
                    <Ionicons name="checkmark" size={18} color={colors.bg} />
                    <Text style={[styles.modalCtaText, { color: colors.bg }]}>Accept</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalCta, { flex: 1, borderColor: colors.border, backgroundColor: colors.surfaceGlass }]}
                    onPress={() => onDecline(player)}
                    disabled={saving}
                    testID="modal-decline"
                  >
                    <Ionicons name="close" size={18} color={colors.textMuted} />
                    <Text style={[styles.modalCtaText, { color: colors.textMuted }]}>Decline</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.modalCta, { backgroundColor: colors.cyan, borderColor: colors.cyan }, saving && { opacity: 0.6 }]}
                  onPress={() => onAddFriend(player)}
                  disabled={saving}
                  testID="modal-add-friend"
                >
                  {saving ? <ActivityIndicator color={colors.bg} /> : (
                    <>
                      <Ionicons name="person-add" size={18} color={colors.bg} />
                      <Text style={[styles.modalCtaText, { color: colors.bg }]}>Add Friend</Text>
                    </>
                  )}
                </TouchableOpacity>
              )
            }
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function ModalStat({ icon, color, value, label }: { icon: string; color: string; value: string; label: string }) {
  return (
    <View style={styles.modalStatBox}>
      <Ionicons name={icon as any} size={18} color={color} />
      <Text style={styles.modalStatValue}>{value}</Text>
      <Text style={styles.modalStatLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerTitle: { flex: 1, color: colors.cyan, fontSize: 16, fontWeight: '900', textAlign: 'center', letterSpacing: 1, textTransform: 'uppercase' },
  tabsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  tabPill: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabPillActive: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  tabPillText: { color: colors.textSecondary, fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },
  tabPillTextActive: { color: colors.bg },

  subTabsRow: { flexDirection: 'row', paddingHorizontal: spacing.lg, gap: 8, marginBottom: spacing.sm },
  subTab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  subTabActive: { borderBottomColor: colors.cyan },
  subTabText: { color: colors.textMuted, fontWeight: '800', fontSize: 12, letterSpacing: 0.4 },
  subTabTextActive: { color: colors.text },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 14, padding: 0 },

  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: 8 },

  playerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: 8,
  },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: { backgroundColor: colors.cyan + '22', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.cyan + '55' },
  avatarLetter: { color: colors.cyan, fontWeight: '900', fontSize: 18 },
  playerName: { color: colors.text, fontWeight: '900', fontSize: 14 },
  playerMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  playerStatsRow: { flexDirection: 'row', gap: 6, marginTop: 4 },
  statChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statChipText: { color: colors.cyan, fontSize: 11, fontWeight: '800' },
  lastSeenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  lastSeenText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '500',
  },

  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  actionBtnText: { fontWeight: '900', fontSize: 11, letterSpacing: 0.3 },

  requestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: 8,
  },
  smallActionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  smallActionText: { color: colors.text, fontSize: 11, fontWeight: '900' },

  sectionLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1.2, marginVertical: 8 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: 8 },
  emptyTitle: { color: colors.text, fontWeight: '900', fontSize: 15, marginTop: 6 },
  emptyDesc: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },

  modalAvatarWrap: { alignItems: 'center', marginTop: spacing.md, marginBottom: spacing.md, position: 'relative' },
  bigAvatar: { width: 110, height: 110, borderRadius: 55 },
  bigAvatarLetter: { color: colors.cyan, fontWeight: '900', fontSize: 48 },
  levelPill: {
    position: 'absolute',
    bottom: -6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: colors.green,
    borderRadius: radii.pill,
  },
  levelPillText: { color: colors.bg, fontWeight: '900', fontSize: 11, letterSpacing: 0.5 },

  modalName: { color: colors.text, fontWeight: '900', fontSize: 24, textAlign: 'center', marginBottom: spacing.lg },

  modalStatsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.md },
  modalStatBox: {
    flexBasis: '30%',
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  modalStatValue: { color: colors.text, fontWeight: '900', fontSize: 18 },
  modalStatLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },

  modalBioCard: {
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  modalBioLabel: { color: colors.cyan, fontSize: 11, fontWeight: '900', letterSpacing: 1.5, marginBottom: 6 },
  modalBioText: { color: colors.text, fontSize: 14, lineHeight: 20 },

  modalCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  modalCtaText: { fontWeight: '900', fontSize: 15, letterSpacing: 0.4 },
});
