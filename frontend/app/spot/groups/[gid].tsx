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
import { useAuth } from '../../../src/AuthContext';
import { showAlert, showConfirm } from '../../../src/uiAlert';
import { colors, radii, spacing } from '../../../src/theme';

type GroupMember = {
  user_id: string;
  name: string;
  avatar_base64?: string | null;
  // Phase 4 — full status enum.
  status: 'active' | 'left' | 'sleeping' | 'at_work' | 'pending' | 'off';
  role: 'owner' | 'member';
  notifications_on?: boolean;
  accepted_at?: string | null;
  joined_at?: string | null;
  left_at?: string | null;
};

type Group = {
  id: string;
  name: string;
  owner_id: string;
  auto_challenge_on: boolean;
  // Phase 4 — lobby/game lifecycle.
  started: boolean;
  started_at?: string | null;
  member_count: number;
  pending_count: number;
  accepted_count: number;
  all_accepted: boolean;
  max_members: number;
  viewer_is_member: boolean;
  viewer_status: GroupMember['status'] | 'none';
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
  if (status === 'pending') {
    return (
      <View style={[styles.badge, { borderColor: '#f59e0b', backgroundColor: '#f59e0b22' }]}>
        <Ionicons name="time-outline" size={10} color="#f59e0b" />
        <Text style={[styles.badgeText, { color: '#f59e0b' }]}>Pending invite</Text>
      </View>
    );
  }
  if (status === 'off') {
    return (
      <View style={[styles.badge, { borderColor: '#94a3b8', backgroundColor: '#94a3b822' }]}>
        <Ionicons name="notifications-off-outline" size={10} color="#94a3b8" />
        <Text style={[styles.badgeText, { color: '#94a3b8' }]}>Turned off from the group</Text>
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
  const { user } = useAuth();
  const viewerId = user?.id || '';
  const [group, setGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [friends, setFriends] = useState<{ user_id: string; name?: string; avatar_base64?: string | null }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Phase 2 — Auto-challenge history. Phase 3 adds responses[] (member
  // photos posted in reply) + new skipped buckets. We use a flexible
  // shape so future additions don't require touching this annotation.
  const [challenges, setChallenges] = useState<Array<{
    id: string;
    target_object: string;
    fired_at_utc: string;
    recipients_count: number;
    you_received: boolean;
    skipped_sleeping_count?: number;
    skipped_work_count?: number;
    skipped_night_count?: number;
    responses?: Array<{
      id: string;
      user_id: string;
      photo_base64: string | null;
      taken_at: string;
      remaining_seconds?: number;
    }>;
    response_count?: number;
    you_responded?: boolean;
    // Phase 4 — round window + XP result.
    round_ends_at_utc?: string;
    resolved?: boolean;
    winners?: string[];
    losers?: string[];
    xp_per_winner?: number;
    xp_per_loser?: number;
    you_won?: boolean;
    you_lost?: boolean;
  }>>([]);
  // Phase 3 — full-screen photo viewer (Option 6B: simple Modal +
  // resizeMode='contain', no zoom). The viewer overlays the entire
  // screen and dismisses on tap anywhere.
  const [viewerPhoto, setViewerPhoto] = useState<string | null>(null);
  // Phase 3 — auto-minimise. Challenges older than 6h are collapsed
  // behind a single "Earlier today (N)" disclosure tile. Users can
  // expand it manually.
  const [showOld, setShowOld] = useState(false);

  const load = useCallback(async () => {
    if (!gid) return;
    try {
      const r = await api.spotGroupGet(String(gid));
      setGroup(r.group as Group);
      // Best-effort — don't block detail load if challenges list fails.
      try {
        const c = await api.spotGroupChallenges(String(gid));
        setChallenges(c.challenges || []);
      } catch {
        setChallenges([]);
      }
    } catch (e: any) {
      showAlert("Couldn't load group", String(e?.message || e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [gid]);

  useEffect(() => { load(); }, [load]);

  const onAccept = async () => {
    if (!group) return;
    setSaving(true);
    try {
      const r = await api.spotGroupAccept(group.id);
      setGroup(r.group as Group);
    } catch (e: any) {
      showAlert("Couldn't accept", String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const onDecline = async () => {
    if (!group) return;
    const ok = await showConfirm(
      'Decline this invite?',
      `You won't join "${group.name}". The other members won't be notified.`,
      { confirmText: 'Decline', cancelText: 'Cancel', destructive: true },
    );
    if (!ok) return;
    try {
      await api.spotGroupDecline(group.id);
      router.back();
    } catch (e: any) {
      showAlert("Couldn't decline", String(e?.message || e));
    }
  };

  const onStartGame = async () => {
    if (!group) return;
    setSaving(true);
    try {
      const r = await api.spotGroupStart(group.id);
      setGroup(r.group as Group);
    } catch (e: any) {
      showAlert("Couldn't start the game", String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const onToggleSelf = async (next: boolean) => {
    if (!group) return;
    setSaving(true);
    try {
      const r = await api.spotGroupNotifications(group.id, next);
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
        {/* Phase 4 lifecycle — top card varies by state:
              (a) viewer is pending → Accept + Decline
              (b) accepted but game not started → Start new game CTA +
                  pending-count hint (disabled until all_accepted)
              (c) game started → Rules panel (3/day, 2-min rounds, XP) */}
        {group.viewer_status === 'pending' ? (
          <View style={styles.lifeCard}>
            <Text style={styles.lifeTitle}>You&apos;ve been invited to this group</Text>
            <Text style={styles.lifeBody}>
              Accept to join the lobby. Once everyone accepts, any member can tap
              <Text style={{ fontWeight: '900' }}> Start new game</Text> to begin
              the daily 3-challenge rotation.
            </Text>
            <View style={styles.lifeBtnRow}>
              <TouchableOpacity
                onPress={onAccept}
                disabled={saving}
                style={[styles.lifeCta, styles.lifeCtaPrimary, saving && { opacity: 0.5 }]}
                activeOpacity={0.85}
                testID="spot-group-accept"
              >
                <Ionicons name="checkmark" size={16} color={colors.bg} />
                <Text style={[styles.lifeCtaText, { color: colors.bg }]}>Accept invite</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onDecline}
                disabled={saving}
                style={[styles.lifeCta, styles.lifeCtaGhost, saving && { opacity: 0.5 }]}
                activeOpacity={0.85}
                testID="spot-group-decline"
              >
                <Text style={[styles.lifeCtaText, { color: colors.red }]}>Decline</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : !group.started ? (
          <View style={styles.lifeCard}>
            <Text style={styles.lifeTitle}>Lobby — waiting on players</Text>
            <Text style={styles.lifeBody}>
              {group.pending_count > 0
                ? `${group.pending_count} ${group.pending_count === 1 ? 'invite' : 'invites'} still pending. The Start button unlocks once everyone accepts.`
                : "Everyone's in! Tap below to start the daily 3-challenge rotation."}
            </Text>
            <TouchableOpacity
              onPress={onStartGame}
              disabled={saving || !group.all_accepted || group.accepted_count < 2}
              style={[
                styles.lifeCta,
                styles.lifeCtaPrimary,
                (saving || !group.all_accepted || group.accepted_count < 2) && { opacity: 0.45 },
                { marginTop: 12 },
              ]}
              activeOpacity={0.85}
              testID="spot-group-start"
            >
              <Ionicons name="play" size={16} color={colors.bg} />
              <Text style={[styles.lifeCtaText, { color: colors.bg }]}>
                {group.all_accepted ? 'Start new game' : `Waiting for ${group.pending_count}…`}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.lifeCard}>
            <Text style={styles.lifeTitle}>🎯 Game on — Rules</Text>
            <View style={{ marginTop: 6 }}>
              <Text style={styles.rule}>
                <Text style={styles.ruleNum}>1.</Text> 3 random times per day to find a new object
              </Text>
              <Text style={styles.rule}>
                <Text style={styles.ruleNum}>2.</Text> 2-minute rounds — be quick!
              </Text>
              <Text style={styles.rule}>
                <Text style={styles.ruleNum}>3.</Text> Winner: <Text style={{ color: colors.green, fontWeight: '900' }}>+5 XP per loser</Text>
              </Text>
              <Text style={styles.rule}>
                <Text style={styles.ruleNum}>4.</Text> Loser: <Text style={{ color: colors.red, fontWeight: '900' }}>−1 XP per successful player</Text>
              </Text>
            </View>
          </View>
        )}

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

        {group.members.map((m) => {
          // Phase 4 — per-member toggle. Shown ONLY for the viewer's
          // own row, ONLY when the game has started, AND only if the
          // viewer is an accepted member (not pending).
          const isSelf = m.user_id === viewerId;
          const showSelfToggle = isSelf && group.started && m.status !== 'left' && m.status !== 'pending';
          return (
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
                  {m.name}{m.role === 'owner' ? ' · Owner' : ''}{isSelf ? ' · You' : ''}
                </Text>
                <StatusBadge status={m.status} left_at={m.left_at} />
              </View>
              {showSelfToggle ? (
                <TouchableOpacity
                  onPress={() => !saving && onToggleSelf(!(m.notifications_on ?? true))}
                  disabled={saving}
                  activeOpacity={0.7}
                  testID="spot-group-self-toggle"
                  accessibilityRole="switch"
                  accessibilityState={{ checked: !!m.notifications_on, disabled: saving }}
                  style={{ marginLeft: 8 }}
                >
                  <Switch
                    value={!!m.notifications_on}
                    onValueChange={onToggleSelf}
                    disabled={saving}
                    thumbColor={m.notifications_on ? colors.amber : '#94a3b8'}
                    trackColor={{ false: '#555', true: colors.amber + '88' }}
                    pointerEvents="none"
                  />
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}

        {/* Phase 2/3 — Auto-challenge feed. Each challenge shows the
            target object, who got the push (status pill on the right),
            and any photo responses members posted while the window was
            open. Challenges older than 6h collapse behind a "Earlier"
            disclosure tile (Phase 3 / Option 5A). */}
        <Text style={[styles.sectionLabel, { marginTop: spacing.lg, marginBottom: spacing.sm }]}>
          RECENT CHALLENGES
        </Text>
        {challenges.length === 0 ? (
          <Text style={styles.toggleBody}>
            {group.started
              ? "No challenges have fired yet today. The next one will arrive at one of today's 3 random global moments."
              : "Once the game starts, challenges will appear here. Wait for all invitees to accept, then tap Start new game above."}
          </Text>
        ) : (
          (() => {
            // Partition challenges into "fresh" (< 6h) and "old" (≥ 6h).
            const NOW = Date.now();
            const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
            const fresh: typeof challenges = [];
            const old: typeof challenges = [];
            challenges.forEach((c) => {
              const t = c.fired_at_utc ? new Date(c.fired_at_utc).getTime() : 0;
              if (NOW - t < SIX_HOURS_MS) fresh.push(c);
              else old.push(c);
            });
            const renderChallenge = (c: typeof challenges[number], minimised: boolean) => {
              const dot = c.you_received
                ? { name: 'checkmark-circle' as const, color: colors.green, bg: colors.green + '22' }
                : { name: 'moon-outline' as const, color: '#94a3b8', bg: '#94a3b822' };
              return (
                <View key={c.id} style={[styles.chCard, minimised && styles.chCardMin]}>
                  <View style={styles.chHeader}>
                    <View style={[styles.chIcon, { backgroundColor: dot.bg }]}>
                      <Ionicons name={dot.name} size={16} color={dot.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.challengeTitle} numberOfLines={1}>
                        Find a {c.target_object}
                      </Text>
                      <Text style={styles.challengeMeta} numberOfLines={1}>
                        {c.fired_at_utc
                          ? new Date(c.fired_at_utc).toLocaleString(undefined, {
                              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                            })
                          : '—'}
                        {' · '}
                        {c.recipients_count}/{group.max_members} got it
                        {c.you_received ? '' : ' · slept through'}
                      </Text>
                    </View>
                    {(c.response_count || 0) > 0 ? (
                      <View style={styles.chBadge}>
                        <Ionicons name="images-outline" size={12} color={colors.amber} />
                        <Text style={styles.chBadgeText}>{c.response_count}</Text>
                      </View>
                    ) : null}
                    {/* Phase 4 — won/lost XP chip on resolved rounds */}
                    {c.resolved && c.you_won ? (
                      <View style={[styles.resultChip, { borderColor: colors.green, backgroundColor: colors.green + '22' }]}>
                        <Ionicons name="trophy" size={11} color={colors.green} />
                        <Text style={[styles.resultChipText, { color: colors.green }]}>+{c.xp_per_winner} XP</Text>
                      </View>
                    ) : null}
                    {c.resolved && c.you_lost ? (
                      <View style={[styles.resultChip, { borderColor: colors.red, backgroundColor: colors.red + '22' }]}>
                        <Ionicons name="remove-circle" size={11} color={colors.red} />
                        <Text style={[styles.resultChipText, { color: colors.red }]}>{c.xp_per_loser} XP</Text>
                      </View>
                    ) : null}
                  </View>
                  {/* Response thumbnails strip (Phase 3 group feed —
                      Option 4C). Hidden when the challenge is in the
                      "minimised" bucket. */}
                  {!minimised && (c.responses?.length || 0) > 0 ? (
                    <View style={styles.chThumbsRow}>
                      {c.responses!.slice(0, 6).map((r) => {
                        const responder = group.members.find((mm) => mm.user_id === r.user_id);
                        const isYou = r.user_id === viewerId;
                        return (
                          <TouchableOpacity
                            key={r.id}
                            onPress={() => r.photo_base64 && setViewerPhoto(r.photo_base64)}
                            disabled={!r.photo_base64}
                            activeOpacity={0.8}
                            style={styles.chThumbWrap}
                            testID={`spot-group-challenge-thumb-${r.id}`}
                          >
                            {r.photo_base64 ? (
                              <Image
                                source={{ uri: `data:image/jpeg;base64,${r.photo_base64}` }}
                                style={styles.chThumb}
                              />
                            ) : (
                              <View style={[styles.chThumb, styles.chThumbPlaceholder]}>
                                <Ionicons name="image-outline" size={18} color={colors.textMuted} />
                              </View>
                            )}
                            <Text style={styles.chThumbName} numberOfLines={1}>
                              {isYou ? 'You' : (responder?.name || '?').split(' ')[0]}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ) : null}
                  {!minimised && (c.response_count || 0) === 0 && c.you_received ? (
                    <Text style={styles.chHint}>
                      Tap the camera in the Spot tab to post your photo of a {c.target_object}.
                    </Text>
                  ) : null}
                </View>
              );
            };
            return (
              <>
                {fresh.slice(0, 5).map((c) => renderChallenge(c, false))}
                {old.length > 0 ? (
                  <TouchableOpacity
                    onPress={() => setShowOld((v) => !v)}
                    activeOpacity={0.8}
                    style={styles.oldToggle}
                    testID="spot-group-old-toggle"
                  >
                    <Ionicons
                      name={showOld ? 'chevron-down' : 'chevron-forward'}
                      size={14}
                      color={colors.textMuted}
                    />
                    <Text style={styles.oldToggleText}>
                      Earlier today ({old.length})
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {showOld ? old.map((c) => renderChallenge(c, true)) : null}
              </>
            );
          })()
        )}

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

      {/* Phase 3 — Photo viewer (Option 6B). Plain Modal with the
          image centered & resizeMode='contain'; tap anywhere to
          dismiss. No pinch-zoom for v1 — kept lightweight to avoid a
          new RN dependency. */}
      <Modal
        visible={viewerPhoto !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerPhoto(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setViewerPhoto(null)}
          style={styles.viewerBackdrop}
          testID="spot-group-photo-viewer-backdrop"
        >
          {viewerPhoto ? (
            <Image
              source={{ uri: `data:image/jpeg;base64,${viewerPhoto}` }}
              style={styles.viewerImage}
              resizeMode="contain"
            />
          ) : null}
          <View style={styles.viewerCloseHint}>
            <Ionicons name="close-circle" size={28} color="#fff" />
          </View>
        </TouchableOpacity>
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
  // Phase 3 challenge cards (replaces the old single-row layout).
  chCard: {
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    padding: 10, marginBottom: 8,
  },
  chCardMin: { opacity: 0.55, padding: 8 },
  chHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.amber + '18',
    borderRadius: radii.pill,
    paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 1, borderColor: colors.amber + '44',
  },
  chBadgeText: { color: colors.amber, fontWeight: '900', fontSize: 11 },
  chThumbsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chThumbWrap: { width: 60, alignItems: 'center' },
  chThumb: { width: 60, height: 60, borderRadius: 10, backgroundColor: colors.bg },
  chThumbPlaceholder: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  chThumbName: { color: colors.textMuted, fontSize: 10, marginTop: 3, maxWidth: 60 },
  chHint: { color: colors.textMuted, fontSize: 11, marginTop: 8, fontStyle: 'italic' },
  oldToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 8, paddingHorizontal: 4,
    marginTop: 4,
  },
  oldToggleText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  viewerBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.95)',
    alignItems: 'center', justifyContent: 'center',
  },
  viewerImage: { width: '100%', height: '100%' },
  viewerCloseHint: { position: 'absolute', top: 50, right: 20, opacity: 0.85 },
  // Phase 4 lifecycle card (replaces auto-toggle).
  lifeCard: {
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.amber + '55',
    padding: spacing.md, marginBottom: spacing.md,
  },
  lifeTitle: { color: colors.text, fontSize: 15, fontWeight: '900', marginBottom: 6 },
  lifeBody: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  lifeBtnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  lifeCta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, paddingHorizontal: 16, borderRadius: radii.md,
    minHeight: 44, flex: 1,
  },
  lifeCtaPrimary: { backgroundColor: colors.amber },
  lifeCtaGhost: { borderWidth: 1, borderColor: colors.red, backgroundColor: 'transparent' },
  lifeCtaText: { fontSize: 14, fontWeight: '900' },
  rule: { color: colors.text, fontSize: 13, marginVertical: 4, lineHeight: 18 },
  ruleNum: { color: colors.amber, fontWeight: '900' },
  // Phase 4 win/loss XP chip for resolved challenges.
  resultChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: radii.pill, borderWidth: 1,
  },
  resultChipText: { fontSize: 11, fontWeight: '900' },
  challengeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, marginBottom: 6,
  },
  chIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  challengeTitle: { color: colors.text, fontWeight: '800', fontSize: 13 },
  challengeMeta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
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
