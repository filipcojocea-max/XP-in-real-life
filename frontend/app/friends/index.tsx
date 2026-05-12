import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Animated,
  Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api, Player, FriendStatus, FriendRequestEntry, FriendProfileDetails, FriendMiniApp, FriendTaskSummary, FriendGoalSummary } from '../../src/api';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';
import LeaderboardTab from '../../src/components/LeaderboardTab';
import PremiumShield, { getDynamicShieldLevel } from '../../src/components/PremiumShield';
import { SuspendUserModal } from '../../src/components/SuspendUserModal';
import { GiftComposerModal } from '../../src/components/GiftComposerModal';

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
  // Per-friend unread DM counts → drives the red dot on each friend card.
  const [unreadByFriend, setUnreadByFriend] = useState<Record<string, number>>({});
  const [loadingFriends, setLoadingFriends] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [openProfile, setOpenProfile] = useState<Player | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  // Whether the CURRENT VIEWER is the Creator/Admin — drives the
  // moderation toolkit (Suspend / Send Gift / DM-anyone) in the modal.
  const [viewerIsAdmin, setViewerIsAdmin] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const p = await api.getProfile();
        setViewerIsAdmin(!!(p as any).is_admin);
      } catch {}
    })();
  }, []);

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
      const [reqs, fr, unread] = await Promise.all([
        api.listFriendRequests(),
        api.listFriends(),
        api.messagesUnreadSummary().catch(() => ({ unread_by_friend: {}, total_unread: 0 })),
      ]);
      setRequests(reqs);
      setFriends(fr.friends);
      setUnreadByFriend(unread.unread_by_friend || {});
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

      {/* Creator-only admin shortcuts. Only visible to is_admin profiles —
          regular users never see these rows. */}
      {viewerIsAdmin ? (
        <View style={adminStrip.row}>
          <TouchableOpacity
            style={[adminStrip.card, { borderColor: '#FFD70088' }]}
            activeOpacity={0.85}
            onPress={() => router.push('/admin/players-dates' as any)}
            testID="admin-players-dates"
          >
            <Ionicons name="calendar" size={18} color="#FFD700" />
            <Text style={[adminStrip.title, { color: '#FFD700' }]}>Players Dates</Text>
            <Text style={adminStrip.sub}>All accounts · sort by created date</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[adminStrip.card, { borderColor: colors.cyan + '99' }]}
            activeOpacity={0.85}
            onPress={() => router.push('/admin/global-leaderboard' as any)}
            testID="admin-global-leaderboard"
          >
            <Ionicons name="trophy" size={18} color={colors.cyan} />
            <Text style={[adminStrip.title, { color: colors.cyan }]}>Global Leaderboard</Text>
            <Text style={adminStrip.sub}>Top 100 · week / month / year / all</Text>
          </TouchableOpacity>
        </View>
      ) : null}

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
          unreadByFriend={unreadByFriend}
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
        viewerIsAdmin={viewerIsAdmin}
        onClose={() => setOpenProfile(null)}
        onAddFriend={onAddFriend}
        onAccept={onAccept}
        onDecline={onDecline}
        savingId={savingId}
        onFriendChanged={loadFriendsData}
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
  subTab, setSubTab, requests, friends, unreadByFriend, loading, refreshing, onRefresh,
  onAccept, onDecline, onPress, savingId,
}: {
  subTab: FriendsSubTab;
  setSubTab: (t: FriendsSubTab) => void;
  requests: { incoming: FriendRequestEntry[]; outgoing: FriendRequestEntry[] };
  friends: Player[];
  unreadByFriend: Record<string, number>;
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
              onMessage={() => router.push(`/messages/${item.user_id}`)}
              saving={savingId === item.user_id}
              unreadCount={unreadByFriend[item.user_id] || 0}
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

/**
 * PulsingUnreadDot — visual "ping" used next to a friend's name when
 * they have unread DMs. The dot scales 1.0 → 1.35 and fades 1.0 → 0.55
 * on a 900 ms loop to draw the eye without being obnoxious.
 *
 * Uses Animated (native-driver) so the pulse runs on the UI thread and
 * doesn't hitch the Friends list when it's scrolling. When `count` is
 * 0 we render nothing — pulse loop is torn down cleanly via the effect
 * cleanup.
 */
function PulsingUnreadDot({ count, testID }: { count: number; testID?: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (count <= 0) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale, {
            toValue: 1.35,
            duration: 450,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0.55,
            duration: 450,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(scale, {
            toValue: 1,
            duration: 450,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 450,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      // Reset to resting state so a transient count=0 doesn't leave
      // the dot frozen mid-animation if it remounts.
      scale.setValue(1);
      opacity.setValue(1);
    };
  }, [count, scale, opacity]);

  if (count <= 0) return null;
  return (
    <Animated.View
      testID={testID}
      style={[styles.unreadBadge, { transform: [{ scale }], opacity }]}
    >
      <Text style={styles.unreadBadgeText}>{count > 9 ? '9+' : count}</Text>
    </Animated.View>
  );
}

function PlayerCard({ player, onPress, onAddFriend, onMessage, saving, unreadCount }: {
  player: Player;
  onPress: () => void;
  onAddFriend?: () => void;
  onMessage?: () => void;
  saving?: boolean;
  unreadCount?: number;
}) {
  const adminView = !!player.is_admin_view;
  // ── Admin moderation visuals (only the Creator sees these flags) ──
  // - Red border around the entire card while the player is currently
  //   suspended (transient — auto-clears when suspension expires/lifts)
  // - Permanent red dot next to the name once they've EVER been
  //   suspended (never removed, even after lifting)
  const isCurrentlySuspended = !!player.is_currently_suspended;
  const wasSuspendedEver = !!player.was_suspended_ever;
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
      style={[
        styles.playerCard,
        adminView && { borderColor: '#FFD700', backgroundColor: '#FFD70010' },
        // Red outline takes precedence over the gold admin-view border:
        // a suspended player is the most important state to surface.
        isCurrentlySuspended && {
          borderColor: colors.red,
          borderWidth: 2,
          backgroundColor: colors.red + '0F',
        },
      ]}
      testID={`player-${player.user_id}`}
    >
      <PlayerAvatar player={player} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {/* Permanent red dot — visible to admin only because backend
              omits these fields entirely for non-admin viewers. */}
          {wasSuspendedEver ? (
            <View
              testID={`suspended-dot-${player.user_id}`}
              style={styles.suspendedDot}
            />
          ) : null}
          <Text style={[styles.playerName, adminView && { color: '#FFD700' }]} numberOfLines={1}>{player.name}</Text>
          <PulsingUnreadDot count={unreadCount || 0} testID={`friend-unread-${player.user_id}`} />
          {isCurrentlySuspended ? (
            <View style={styles.suspendedPill} testID={`suspended-pill-${player.user_id}`}>
              <Ionicons name="ban" size={9} color={colors.red} />
              <Text style={styles.suspendedPillText}>SUSPENDED</Text>
            </View>
          ) : null}
        </View>
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
      {/* Right-edge action cluster. For friends we show a quick-access
          cyan "Message" IconButton so users can jump straight into a
          DM thread without opening the profile modal first (1 tap
          instead of 3). For non-friends, we fall back to the original
          "Add Friend" affordance. */}
      {onMessage && player.friend_status === 'friends' ? (
        <TouchableOpacity
          onPress={(e) => {
            // Stop the card-level onPress from ALSO firing and opening
            // the profile modal — messaging is its own explicit intent.
            e.stopPropagation();
            onMessage();
          }}
          activeOpacity={0.75}
          style={styles.quickMessageBtn}
          accessibilityRole="button"
          accessibilityLabel={`Message ${player.name}`}
          testID={`friend-quick-message-${player.user_id}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chatbubble-ellipses" size={18} color={colors.cyan} />
        </TouchableOpacity>
      ) : onAddFriend ? (
        <FriendActionButton player={player} onAddFriend={onAddFriend} saving={saving} />
      ) : null}
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
  const adminView = !!player.is_admin_view || !!player.is_admin;
  // In list views we show a Level Shield as the fallback "avatar" so the
  // player's progression shines through at a glance — much more
  // expressive than a single letter. The actual user-uploaded photo is
  // still revealed when they tap into the profile detail modal.
  if (player.avatar_base64) {
    // Circular photo avatar — golden ring for admin when viewed by others.
    const wrapStyle = adminView
      ? { borderWidth: 2, borderColor: '#FFD700', borderRadius: 26, padding: 1 }
      : undefined;
    return (
      <View style={wrapStyle as any}>
        <Image source={{ uri: `data:image/jpeg;base64,${player.avatar_base64}` }} style={styles.avatar} />
      </View>
    );
  }
  // Admin profiles always render as a golden Lv999 shield even if no
  // photo is set — keeps the Creator's visual identity consistent across
  // search, friends list, requests AND the admin's own self-row. We
  // route every shield through the centralized `getDynamicShieldLevel`
  // bridge so future tier rules live in ONE place.
  // CRITICAL: the shield renders as a FREE-STANDING SVG (no circular
  // clip). Previously we nested the shield inside a 44×44 `borderRadius:
  // 22` container with `overflow: 'hidden'`, which clipped the shield
  // points and produced an "empty yellow circle" for the admin (whose
  // shield is 18 % larger than a regular shield) and a bland blue blob
  // for regular Heroes. The fix: render the shield without clipping.
  const shieldLevel = getDynamicShieldLevel({
    level: player.level,
    total_xp: (player as any).total_xp,
    is_admin: player.is_admin,
    is_admin_view: player.is_admin_view,
  });
  return (
    <View style={styles.shieldSlot} testID={`shield-slot-${player.user_id}`}>
      <PremiumShield level={shieldLevel} size={44} />
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
  player, viewerIsAdmin, onClose, onAddFriend, onAccept, onDecline, savingId, onFriendChanged,
}: {
  player: Player | null;
  viewerIsAdmin: boolean;
  onClose: () => void;
  onAddFriend: (p: Player) => void;
  onAccept: (p: Player) => void;
  onDecline: (p: Player) => void;
  savingId: string | null;
  onFriendChanged?: () => void;
}) {
  if (!player) return null;
  const saving = savingId === player.user_id;
  const [showUnfriendConfirm, setShowUnfriendConfirm] = useState(false);
  const [unfriending, setUnfriending] = useState(false);
  // Live-refresh the player's stats every time the modal opens, so the
  // viewer always sees the most up-to-the-second XP/level/streak/quests/
  // goals/last-active counters instead of a stale snapshot from the
  // list endpoint.
  const [livePlayer, setLivePlayer] = useState<Player>(player);
  useEffect(() => { setLivePlayer(player); }, [player.user_id]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await api.playerProfile(player.user_id);
        if (!cancelled) setLivePlayer((prev) => ({ ...prev, ...fresh }));
      } catch {/* keep snapshot on failure */}
    })();
    return () => { cancelled = true; };
  }, [player.user_id]);
  // Use livePlayer everywhere below so any later edits flip to fresh
  // data without re-templating. We alias to `player` for minimal diff.
  player = livePlayer;

  // Days since the friendship was accepted — drives the unfriend
  // confirmation dialog subtitle. Null when the server didn't send
  // `friended_at` (e.g. viewing from Players search rather than My
  // Friends list).
  const daysFriends = (() => {
    if (!player.friended_at) return null;
    const then = new Date(player.friended_at).getTime();
    if (!Number.isFinite(then)) return null;
    const diffMs = Date.now() - then;
    return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  })();

  async function confirmUnfriend() {
    setUnfriending(true);
    try {
      await api.removeFriend(player!.user_id);
      setShowUnfriendConfirm(false);
      onFriendChanged?.();
      onClose();
    } catch (e: any) {
      showAlert('Could not unfriend', String(e?.message || e));
    } finally {
      setUnfriending(false);
    }
  }
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
                // Big shield fallback in the player detail modal — uses
                // the same dynamic bridge so non-admin friends evolve from
                // blue → yellow → gold as their XP grows.
                <View style={[styles.bigAvatar, styles.avatarFallback, { borderWidth: 0, backgroundColor: 'transparent' }]}>
                  <PremiumShield
                    level={getDynamicShieldLevel({
                      level: player.level,
                      total_xp: (player as any).total_xp,
                      is_admin: player.is_admin,
                      is_admin_view: player.is_admin_view,
                    })}
                    size={120}
                  />
                </View>
              )}
              <View style={styles.levelPill}>
                <Text style={styles.levelPillText}>LV {player.level}</Text>
              </View>
            </View>
          )}
          <Text style={[styles.modalName, player.is_admin_view && { color: '#FFD700' }]}>{player.name}</Text>
          {/* Live "last active" subtitle so the public profile card
              clearly shows how fresh the player's activity is. Admin
              creator profiles are always "Now" since they're omnipresent. */}
          <Text style={styles.modalLastActive}>
            <Ionicons name="time-outline" size={12} color={colors.textMuted} />{' '}
            {player.is_admin_view
              ? 'Last active: Now'
              : `Last active: ${formatLastSeen((player as any).last_seen_at)}`}
          </Text>

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
            <ModalStat icon="rocket" color={player.is_admin_view ? '#FFD700' : colors.cyan}
              value={player.is_admin_view ? '∞' : ((player as any).active_goals_count ?? 0).toString()} label="Active goals" />
          </View>

          {player.bio && !player.is_admin_view ? (
            <View style={styles.modalBioCard}>
              <Text style={styles.modalBioLabel}>BIO</Text>
              <Text style={styles.modalBioText}>{player.bio}</Text>
            </View>
          ) : null}

          {/* Friend-only deep-detail panels: mini-apps, tasks, goals.
              Backend gates this with a 403 if the viewer isn't a friend (or
              self) so this UI is the strictly correct surface to render. */}
          {(player.friend_status === 'friends' || player.friend_status === 'self') ? (
            <FriendDetailsSection userId={player.user_id} />
          ) : null}

          {/* Creator/Admin moderation toolkit — only the Creator account
              sees this block. Non-self only. Lets the Creator suspend
              the player straight from their profile modal. */}
          {viewerIsAdmin && player.friend_status !== 'self' && !player.is_admin_view ? (
            <AdminControlsBlock userId={player.user_id} userName={player.name} />
          ) : null}

          {/* Action area */}
          <View style={{ marginTop: spacing.lg }}>
            {player.friend_status === 'self' ? null
              : player.friend_status === 'friends' ? (
                <View style={{ gap: 10 }}>
                  <TouchableOpacity
                    style={[styles.modalCta, { backgroundColor: colors.cyan, borderColor: colors.cyan }]}
                    onPress={() => {
                      onClose();
                      router.push(`/messages/${player.user_id}`);
                    }}
                    testID="modal-message"
                  >
                    <Ionicons name="chatbubble" size={18} color={colors.bg} />
                    <Text style={[styles.modalCtaText, { color: colors.bg }]}>Message</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalCta, { backgroundColor: colors.green + '22', borderColor: colors.green + '99' }]}
                    onPress={() => setShowUnfriendConfirm(true)}
                    testID="modal-unfriend-open"
                    activeOpacity={0.85}
                  >
                    <Ionicons name="checkmark-circle" size={18} color={colors.green} />
                    <Text style={[styles.modalCtaText, { color: colors.green }]}>Currently Friends</Text>
                  </TouchableOpacity>
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
                <View style={{ gap: 10 }}>
                  {/* Any user can message the Creator even without
                      being friends — admin DM bypass. Rendered above
                      "Add Friend" so it's the primary CTA on the
                      Creator's public profile. */}
                  {player.is_admin_view ? (
                    <TouchableOpacity
                      testID="modal-message-creator"
                      style={[styles.modalCta, { backgroundColor: '#FFD700', borderColor: '#FFD700' }]}
                      onPress={() => {
                        onClose();
                        router.push(`/messages/${player.user_id}`);
                      }}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="send" size={16} color={colors.bg} />
                      <Text style={[styles.modalCtaText, { color: colors.bg }]}>Send Message to Creator</Text>
                    </TouchableOpacity>
                  ) : null}
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
                </View>
              )
            }
          </View>
        </ScrollView>
      </SafeAreaView>

      {/* Unfriend confirmation — inline modal so it stays within the
          same visibility context as the profile sheet. */}
      <Modal
        visible={showUnfriendConfirm}
        animationType="fade"
        transparent
        onRequestClose={() => setShowUnfriendConfirm(false)}
      >
        <View style={styles.confirmBackdrop}>
          <View style={styles.confirmCard}>
            <View style={styles.confirmIconRing}>
              <Ionicons name="person-remove" size={30} color={colors.red} />
            </View>
            <Text style={styles.confirmTitle}>
              Are you sure you want to unfriend this player?
            </Text>
            {daysFriends !== null ? (
              <Text style={styles.confirmSubtitle}>
                You've been friends for {daysFriends} day{daysFriends === 1 ? '' : 's'}.
              </Text>
            ) : null}
            <View style={styles.confirmRow}>
              <TouchableOpacity
                style={[styles.confirmBtn, styles.confirmBtnSecondary]}
                onPress={() => setShowUnfriendConfirm(false)}
                disabled={unfriending}
                testID="unfriend-nevermind"
                activeOpacity={0.85}
              >
                <Text style={[styles.confirmBtnText, { color: colors.textSecondary }]}>Never mind</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, styles.confirmBtnDanger, unfriending && { opacity: 0.6 }]}
                onPress={confirmUnfriend}
                disabled={unfriending}
                testID="unfriend-confirm"
                activeOpacity={0.85}
              >
                {unfriending ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Ionicons name="person-remove" size={14} color="#fff" />
                    <Text style={[styles.confirmBtnText, { color: '#fff' }]}>Unfriend Player</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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

/**
 * AdminControlsBlock — only renders inside the player profile modal when
 * the viewer is the Creator/Admin AND the target is not the admin
 * themselves. Shows current suspension status and exposes the
 * Suspend/Lift Suspension buttons. Sending Gifts and admin-bypass DM
 * will be added to this block in subsequent phases.
 */
function AdminControlsBlock({ userId, userName }: { userId: string; userName: string }) {
  const [status, setStatus] = useState<{ suspended: boolean; forever?: boolean; remaining_seconds?: number | null; until?: string | null; reason?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSuspend, setShowSuspend] = useState(false);
  const [showGift, setShowGift] = useState(false);
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.adminSuspensionStatus(userId);
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  function formatRemaining(seconds: number | null | undefined, forever?: boolean): string {
    if (forever) return 'Suspended indefinitely';
    if (!seconds || seconds <= 0) return 'Expired';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h remaining`;
    if (hours > 0) return `${hours}h ${minutes}m remaining`;
    return `${minutes}m remaining`;
  }

  async function lift() {
    setWorking(true);
    try {
      await api.adminUnsuspendUser(userId);
      await refresh();
    } catch (e: any) {
      // surface error inline; admins are forgiving
      console.error('unsuspend failed', e);
    } finally {
      setWorking(false);
    }
  }

  return (
    <View style={styles.adminBlock}>
      <View style={styles.adminHeader}>
        <Ionicons name="shield-checkmark" size={14} color="#FFD700" />
        <Text style={styles.adminTitle}>CREATOR TOOLS</Text>
      </View>

      {loading ? (
        <ActivityIndicator color="#FFD700" />
      ) : status?.suspended ? (
        <View style={styles.suspendActiveCard}>
          <View style={styles.suspendActiveRow}>
            <Ionicons name="ban" size={16} color={colors.red} />
            <Text style={styles.suspendActiveText}>{formatRemaining(status.remaining_seconds, status.forever)}</Text>
          </View>
          {status.reason ? (
            <Text style={styles.suspendReasonText} numberOfLines={3}>"{status.reason}"</Text>
          ) : null}
          <TouchableOpacity
            testID="admin-lift-suspension"
            onPress={lift}
            disabled={working}
            style={[styles.adminLiftBtn, working && { opacity: 0.6 }]}
            activeOpacity={0.85}
          >
            {working ? (
              <ActivityIndicator color="#FFD700" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={16} color="#FFD700" />
                <Text style={styles.adminLiftText}>Lift Suspension</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          testID="admin-suspend-btn"
          onPress={() => setShowSuspend(true)}
          style={styles.adminSuspendBtn}
          activeOpacity={0.85}
        >
          <Ionicons name="ban" size={16} color={colors.red} />
          <Text style={styles.adminSuspendText}>Suspend This Account</Text>
        </TouchableOpacity>
      )}

      <SuspendUserModal
        visible={showSuspend}
        targetUserId={userId}
        targetName={userName}
        onClose={() => setShowSuspend(false)}
        onSuspended={refresh}
      />

      {/* Send Gift — gold action */}
      <TouchableOpacity
        testID="admin-gift-btn"
        onPress={() => setShowGift(true)}
        style={styles.adminGiftBtn}
        activeOpacity={0.85}
      >
        <Ionicons name="gift" size={16} color="#FFD700" />
        <Text style={styles.adminGiftText}>Send Gift</Text>
      </TouchableOpacity>

      {/* Direct message — admin can DM anyone, no friendship needed */}
      <TouchableOpacity
        testID="admin-dm-btn"
        onPress={() => router.push(`/messages/${userId}`)}
        style={styles.adminDMBtn}
        activeOpacity={0.85}
      >
        <Ionicons name="chatbubbles" size={16} color={colors.cyan} />
        <Text style={styles.adminDMText}>Direct Message</Text>
      </TouchableOpacity>

      <GiftComposerModal
        visible={showGift}
        targetUserId={userId}
        targetName={userName}
        onClose={() => setShowGift(false)}
      />

      {/* Open the full creator-only player page where the XP Penalty
          Subtraction tool + bar/line charts (with black penalty
          overlay) + recent-penalty history live. */}
      <TouchableOpacity
        testID="admin-open-full-profile"
        onPress={() => router.push(`/admin/player/${userId}` as any)}
        style={styles.adminPenaltyBtn}
        activeOpacity={0.85}
      >
        <Ionicons name="remove-circle" size={16} color={colors.red} />
        <Text style={styles.adminPenaltyText}>XP Penalty Subtraction & Charts</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.red} />
      </TouchableOpacity>
    </View>
  );
}

/**
 * FriendDetailsSection — collapsible deep-detail panels for the friend
 * profile modal: Mini-Apps · Quests · Goals.
 *
 * Backend gates this behind a friend/self check (403 otherwise) so we can
 * trust whatever comes back. We render three discoverable accordions that
 * the viewer can independently expand to keep the modal scannable.
 */
function FriendDetailsSection({ userId }: { userId: string }) {
  const [data, setData] = useState<FriendProfileDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSection, setOpenSection] = useState<'apps' | 'tasks' | 'goals' | null>('apps');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    api.playerProfileDetails(userId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: any) => { if (!cancelled) setError(String(e?.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) {
    return (
      <View style={[styles.detailsLoading]}>
        <ActivityIndicator color={colors.cyan} />
        <Text style={styles.detailsLoadingText}>Loading details…</Text>
      </View>
    );
  }
  if (error || !data) {
    return (
      <View style={styles.detailsError}>
        <Ionicons name="lock-closed" size={16} color={colors.textMuted} />
        <Text style={styles.detailsErrorText}>{error || 'Could not load details'}</Text>
      </View>
    );
  }

  return (
    <View style={{ marginTop: spacing.lg }}>
      {/* Mini-Apps */}
      <DetailAccordion
        icon="apps"
        iconColor={colors.cyan}
        title="Mini-Apps"
        subtitle={`${data.mini_apps.filter((m) => m.active).length}/${data.mini_apps.length} active`}
        open={openSection === 'apps'}
        onToggle={() => setOpenSection(openSection === 'apps' ? null : 'apps')}
        testID="friend-details-apps"
      >
        <View style={{ gap: 8 }}>
          {data.mini_apps.map((app) => (
            <MiniAppRow key={app.id} app={app} />
          ))}
        </View>
      </DetailAccordion>

      {/* Tasks / Quests */}
      <DetailAccordion
        icon="checkmark-done"
        iconColor={colors.green}
        title="Quests"
        subtitle={
          data.counts.tasks_total === 0
            ? 'No quests yet'
            : `${data.counts.tasks_total} total · ${data.counts.tasks_default} default · ${data.counts.tasks_custom} custom`
        }
        open={openSection === 'tasks'}
        onToggle={() => setOpenSection(openSection === 'tasks' ? null : 'tasks')}
        testID="friend-details-tasks"
      >
        {data.tasks.length === 0 ? (
          <Text style={styles.detailsEmpty}>No quests created yet.</Text>
        ) : (
          <View style={{ gap: 8 }}>
            {data.tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </View>
        )}
      </DetailAccordion>

      {/* Goals */}
      <DetailAccordion
        icon="flag"
        iconColor={colors.amber}
        title="Goals"
        subtitle={
          data.counts.goals_total === 0
            ? 'No goals yet'
            : `${data.counts.goals_active} active · ${data.counts.goals_completed} completed`
        }
        open={openSection === 'goals'}
        onToggle={() => setOpenSection(openSection === 'goals' ? null : 'goals')}
        testID="friend-details-goals"
      >
        {data.goals.length === 0 ? (
          <Text style={styles.detailsEmpty}>No goals set yet.</Text>
        ) : (
          <View style={{ gap: 8 }}>
            {data.goals.map((g) => (
              <GoalRow key={g.id} goal={g} />
            ))}
          </View>
        )}
      </DetailAccordion>
    </View>
  );
}

function DetailAccordion({
  icon, iconColor, title, subtitle, open, onToggle, children, testID,
}: {
  icon: string;
  iconColor: string;
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <View style={[styles.detailCard, open && { borderColor: iconColor + '99' }]}>
      <TouchableOpacity
        testID={testID}
        onPress={onToggle}
        activeOpacity={0.85}
        style={styles.detailHeader}
      >
        <View style={[styles.detailIcon, { backgroundColor: iconColor + '22', borderColor: iconColor + '66' }]}>
          <Ionicons name={icon as any} size={16} color={iconColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.detailTitle}>{title}</Text>
          <Text style={styles.detailSubtitle}>{subtitle}</Text>
        </View>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {open ? <View style={styles.detailBody}>{children}</View> : null}
    </View>
  );
}

function MiniAppRow({ app }: { app: FriendMiniApp }) {
  const tone = app.color === 'green' ? colors.green
    : app.color === 'amber' ? colors.amber
    : app.color === 'red' ? colors.red
    : colors.cyan;
  return (
    <View style={[styles.miniAppRow, { borderColor: app.active ? tone + '88' : colors.border }]}>
      <View style={[styles.detailIcon, { backgroundColor: tone + '22', borderColor: tone + '66' }]}>
        <Ionicons name={app.icon as any} size={16} color={tone} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.miniAppTitleRow}>
          <Text style={styles.miniAppTitle}>{app.title}</Text>
          {app.active ? (
            <View style={[styles.miniAppPill, { backgroundColor: tone + '22', borderColor: tone + '88' }]}>
              <Text style={[styles.miniAppPillText, { color: tone }]}>ACTIVE</Text>
            </View>
          ) : (
            <View style={[styles.miniAppPill, { borderColor: colors.border }]}>
              <Text style={[styles.miniAppPillText, { color: colors.textMuted }]}>NOT YET</Text>
            </View>
          )}
        </View>
        <Text style={styles.miniAppDesc}>{app.description}</Text>
        <Text style={[styles.miniAppStat, { color: tone }]}>{app.stat_label}</Text>
      </View>
    </View>
  );
}

function TaskRow({ task }: { task: FriendTaskSummary }) {
  const slotColor = task.time_slot === 'morning' ? colors.amber
    : task.time_slot === 'afternoon' ? colors.cyan
    : colors.red;
  return (
    <View style={styles.taskRow}>
      <View style={styles.taskHeader}>
        <View style={[styles.taskSlotPill, { backgroundColor: slotColor + '22', borderColor: slotColor + '66' }]}>
          <Text style={[styles.taskSlotText, { color: slotColor }]}>{(task.time_slot || 'morning').toUpperCase()}</Text>
        </View>
        <Text style={styles.taskTitle} numberOfLines={2}>{task.title}</Text>
        <View style={styles.taskXpPill}>
          <Ionicons name="flash" size={10} color={colors.amber} />
          <Text style={styles.taskXpText}>{task.xp_value}</Text>
        </View>
      </View>
      {task.description ? (
        <Text style={styles.taskDesc}>{task.description}</Text>
      ) : null}
      <View style={styles.taskMetaRow}>
        <Text style={styles.taskMeta}>{task.is_default ? 'Default quest' : 'Custom quest'}</Text>
        <Text style={[styles.taskMeta, { textTransform: 'capitalize' }]}>· {task.focus_area}</Text>
      </View>
    </View>
  );
}

function GoalRow({ goal }: { goal: FriendGoalSummary }) {
  const pct = goal.target_value > 0 ? Math.min(100, Math.round((goal.current_value / goal.target_value) * 100)) : 0;
  return (
    <View style={styles.goalRow}>
      <View style={styles.taskHeader}>
        <Text style={styles.taskTitle} numberOfLines={2}>{goal.title}</Text>
        {goal.completed ? (
          <View style={[styles.miniAppPill, { backgroundColor: colors.green + '22', borderColor: colors.green + '88' }]}>
            <Text style={[styles.miniAppPillText, { color: colors.green }]}>DONE</Text>
          </View>
        ) : (
          <View style={styles.taskXpPill}>
            <Ionicons name="flash" size={10} color={colors.amber} />
            <Text style={styles.taskXpText}>+{goal.xp_reward}</Text>
          </View>
        )}
      </View>
      {goal.description ? (
        <Text style={styles.taskDesc}>{goal.description}</Text>
      ) : null}
      <View style={styles.goalProgressBar}>
        <View style={[styles.goalProgressFill, {
          width: `${pct}%`,
          backgroundColor: goal.completed ? colors.green : colors.cyan,
        }]} />
      </View>
      <View style={styles.taskMetaRow}>
        <Text style={styles.taskMeta}>{goal.current_value}/{goal.target_value} {goal.unit}</Text>
        <Text style={[styles.taskMeta, { textTransform: 'capitalize' }]}>· {goal.focus_area}</Text>
      </View>
    </View>
  );
}

// Creator-only horizontal strip rendered above the Friends+ tabs.
const adminStrip = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1.5,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 4,
  },
  title: { fontSize: 13, fontWeight: '900', marginTop: 4 },
  sub: { color: colors.textMuted, fontSize: 10, fontWeight: '700' },
});


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
  // Container for the PremiumShield fallback. No borderRadius / overflow
  // so the shield's pointy silhouette renders in full — this is what
  // fixes the "empty yellow circle" Admin bug and the "generic blue
  // blob" for regular Heroes.
  shieldSlot: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarShieldWrap: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
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
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.red,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadBadgeText: { color: '#fff', fontSize: 10, fontWeight: '900' },
  // Quick-access chat button on each friend card — lets the user skip
  // the profile-modal step when they just want to reply to a message.
  quickMessageBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cyan + '18',
    borderWidth: 1,
    borderColor: colors.cyan + '66',
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

  modalName: { color: colors.text, fontWeight: '900', fontSize: 24, textAlign: 'center', marginBottom: 4 },
  modalLastActive: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginBottom: spacing.lg, fontWeight: '600' },

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

  // Friend-detail accordion + sub-rows
  detailsLoading: { marginTop: spacing.lg, alignItems: 'center', gap: 8 },
  detailsLoadingText: { color: colors.textMuted, fontSize: 12 },
  detailsError: { marginTop: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  detailsErrorText: { color: colors.textMuted, fontSize: 12 },
  detailsEmpty: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic', paddingVertical: 8 },
  detailCard: {
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    marginBottom: 10,
    overflow: 'hidden',
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  detailIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailTitle: { color: colors.text, fontWeight: '900', fontSize: 14, letterSpacing: 0.3 },
  detailSubtitle: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  detailBody: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  miniAppRow: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: 10,
  },
  miniAppTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  miniAppTitle: { color: colors.text, fontWeight: '900', fontSize: 13, flex: 1 },
  miniAppPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  miniAppPillText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  miniAppDesc: { color: colors.textMuted, fontSize: 11, marginTop: 3, lineHeight: 15 },
  miniAppStat: { fontSize: 11, fontWeight: '700', marginTop: 4 },
  taskRow: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: 10,
  },
  taskHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  taskSlotPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  taskSlotText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  taskTitle: { color: colors.text, fontWeight: '800', fontSize: 13, flex: 1 },
  taskXpPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.amber + '22',
    borderWidth: 1,
    borderColor: colors.amber + '66',
  },
  taskXpText: { color: colors.amber, fontSize: 11, fontWeight: '900' },
  taskDesc: { color: colors.textMuted, fontSize: 12, marginTop: 4, lineHeight: 16 },
  taskMetaRow: { flexDirection: 'row', gap: 4, marginTop: 4 },
  taskMeta: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },
  goalRow: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: 10,
  },
  goalProgressBar: {
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    marginTop: 8,
    overflow: 'hidden',
  },
  goalProgressFill: {
    height: '100%',
    borderRadius: 3,
  },

  // Admin / Creator moderation toolkit (gold accent)
  adminBlock: {
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: 'rgba(255, 215, 0, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 215, 0, 0.45)',
    borderRadius: radii.lg,
    gap: 10,
  },
  adminHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  adminTitle: { color: '#FFD700', fontWeight: '900', fontSize: 11, letterSpacing: 1.2 },
  adminSuspendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.red + '22',
    borderWidth: 1,
    borderColor: colors.red,
  },
  adminSuspendText: { color: colors.red, fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },
  suspendActiveCard: {
    padding: 12,
    backgroundColor: colors.red + '12',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.red + '88',
    gap: 8,
  },
  suspendActiveRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  suspendActiveText: { color: colors.red, fontWeight: '900', fontSize: 13 },
  suspendReasonText: { color: colors.textSecondary, fontSize: 12, fontStyle: 'italic' },
  adminLiftBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255, 215, 0, 0.15)',
    borderWidth: 1,
    borderColor: '#FFD700',
  },
  adminLiftText: { color: '#FFD700', fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },
  adminGiftBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255, 215, 0, 0.18)',
    borderWidth: 1,
    borderColor: '#FFD700',
  },
  adminGiftText: { color: '#FFD700', fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },
  adminDMBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.cyan + '22',
    borderWidth: 1,
    borderColor: colors.cyan,
  },
  adminDMText: { color: colors.cyan, fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },
  adminPenaltyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.red + '22',
    borderWidth: 1,
    borderColor: colors.red,
    marginTop: 8,
  },
  adminPenaltyText: { color: colors.red, fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },

  // Admin moderation badges on player cards
  suspendedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.red,
    borderWidth: 1,
    borderColor: '#fff3',
  },
  suspendedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.red + '22',
    borderWidth: 1,
    borderColor: colors.red,
  },
  suspendedPillText: {
    color: colors.red,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  // Unfriend confirmation modal
  confirmBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  confirmCard: {
    width: '100%', maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
  },
  confirmIconRing: {
    width: 70, height: 70, borderRadius: 35,
    borderWidth: 2, borderColor: colors.red,
    backgroundColor: colors.red + '22',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing.md,
  },
  confirmTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '900',
    textAlign: 'center',
    lineHeight: 22,
  },
  confirmSubtitle: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
    fontStyle: 'italic',
  },
  confirmRow: { flexDirection: 'row', gap: 10, marginTop: spacing.lg, width: '100%' },
  confirmBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  confirmBtnSecondary: { backgroundColor: colors.surfaceGlass, borderColor: colors.border },
  confirmBtnDanger: { backgroundColor: colors.red, borderColor: colors.red },
  confirmBtnText: { fontWeight: '900', fontSize: 13 },
});
