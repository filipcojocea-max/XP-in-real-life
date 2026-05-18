import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
  Image,
  ScrollView,
  RefreshControl,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { api, Profile, SpotEntry } from '../../src/api';
import { showAlert, showConfirm } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';
import { useGuestGate } from '../../src/components/GuestGate';

export default function SpotHub() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [feed, setFeed] = useState<SpotEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openEntry, setOpenEntry] = useState<SpotEntry | null>(null);
  // v1.0.29 Phase 1 — permanent groups list. Fetched alongside the
  // solo feed; renders as a "MY GROUPS" section. Empty for first-time
  // users and silently hidden in that case.
  const [groups, setGroups] = useState<any[]>([]);

  const load = useCallback(async () => {
    try {
      const [p, f, g] = await Promise.all([
        api.getProfile(),
        api.spotFeed(50),
        api.spotGroupsList().catch(() => ({ groups: [] })),
      ]);
      setProfile(p);
      setFeed(f.entries || []);
      setGroups(g.groups || []);
    } catch (e: any) {
      console.log('spot load', e?.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onToggleRandom = async (next: boolean) => {
    try {
      const r = await api.spotRandomToggle(next);
      setProfile(r.profile);
      if (next) {
        showAlert(
          'Random mode ON',
          "We'll surprise you with 3 challenges at random times each day. You'll get 2 minutes to find each object.",
        );
      }
    } catch (e: any) {
      showAlert('Could not toggle', String(e?.message || e));
    }
  };

  const startSolo = () => {
    if (profile?.spot_random_enabled) {
      showAlert(
        'Solo locked',
        'Turn off "Random object at random time" first to play freestyle.',
      );
      return;
    }
    router.push('/spot/play?mode=solo_constant');
  };

  const points = profile?.spot_points || 0;
  const randomEnabled = !!profile?.spot_random_enabled;

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}><ActivityIndicator size="large" color={colors.cyan} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.topTitleWrap}>
          <View style={styles.miniIconBox}>
            <Ionicons name="scan" size={14} color={colors.green} />
          </View>
          <Text style={styles.topTitle}>Spot the Object</Text>
        </View>
        <View style={styles.pointsPill}>
          <Ionicons name="trophy" size={11} color={colors.amber} />
          <Text style={styles.pointsText}>{points}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.cyan} />}
      >
        {/* Mode 1: Play Solo */}
        <TouchableOpacity
          activeOpacity={randomEnabled ? 1 : 0.85}
          onPress={startSolo}
          testID="spot-mode-solo"
          style={[styles.modeCard, randomEnabled && styles.modeCardLocked]}
        >
          <View style={[styles.modeIcon, { backgroundColor: colors.green + '22', borderColor: colors.green + '88' }]}>
            <Ionicons name="play" size={26} color={randomEnabled ? colors.textMuted : colors.green} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[styles.modeTitle, randomEnabled && { color: colors.textMuted }]}>
                Play Challenge Solo
              </Text>
              {randomEnabled ? <Ionicons name="lock-closed" size={12} color={colors.textMuted} /> : null}
            </View>
            <Text style={styles.modeDesc}>
              {randomEnabled
                ? 'Locked while Random Mode is on.'
                : 'Endless practice. New random object every round, no time limit.'}
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={20}
            color={randomEnabled ? colors.textMuted : colors.green}
          />
        </TouchableOpacity>

        {/* Mode 2: Random object at random time */}
        <View style={styles.modeCard}>
          <View style={[styles.modeIcon, { backgroundColor: colors.amber + '22', borderColor: colors.amber + '88' }]}>
            <Ionicons name="alarm" size={26} color={colors.amber} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeTitle}>Random object at random time</Text>
            <Text style={styles.modeDesc}>
              3 surprise challenges per day. 2-minute timer. Locks Solo mode while on.
            </Text>
          </View>
          <Switch
            value={randomEnabled}
            onValueChange={onToggleRandom}
            trackColor={{ false: colors.border, true: colors.amber + '88' }}
            thumbColor={randomEnabled ? colors.amber : '#888'}
            testID="spot-random-toggle"
          />
        </View>

        {/* Mode 3: Spot the Object — Friends Multiplayer (Phase 2) */}
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => router.push('/spot/multiplayer')}
          testID="spot-mode-multiplayer"
          style={styles.modeCard}
        >
          <View style={[styles.modeIcon, { backgroundColor: colors.cyan + '22', borderColor: colors.cyan + '88' }]}>
            <Ionicons name="people" size={26} color={colors.cyan} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeTitle}>Spot with Friends</Text>
            <Text style={styles.modeDesc}>
              Invite friends to a 2-min lobby. Whoever spots the object the most wins +5 SP. Losers −1 SP.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.cyan} />
        </TouchableOpacity>

        {/* Mode 4: Admin/Creator-only — Test & Train AI. Hidden for
            everyone else. Tapping launches the dedicated training
            screen which walks the Creator through capturing reference
            photos for each trainable object (few-shot data injected
            into every other player's vision check). */}
        {profile?.is_admin ? (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => router.push('/spot/train')}
            testID="spot-mode-train"
            style={[styles.modeCard, { borderColor: '#FFD700', backgroundColor: '#FFD70010' }]}
          >
            <View style={[styles.modeIcon, { backgroundColor: '#FFD70022', borderColor: '#FFD70088' }]}>
              <Ionicons name="sparkles" size={26} color="#FFD700" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.modeTitle, { color: '#FFD700' }]}>Test & Train AI</Text>
              <Text style={styles.modeDesc}>
                Capture reference photos so the AI gets faster at recognising every object during gameplay.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#FFD700" />
          </TouchableOpacity>
        ) : null}

        {/* Spot Points stat */}
        <View style={styles.statCard}>
          <View>
            <Text style={styles.statLabel}>YOUR SPOT POINTS</Text>
            <Text style={styles.statValue}>{points}</Text>
          </View>
          <View style={styles.statTrophy}>
            <Ionicons name="trophy" size={32} color={colors.amber} />
          </View>
        </View>

        {/* ── v1.0.29 Phase 1: Permanent Groups ────────────────── */}
        <View style={styles.groupsHeader}>
          <Text style={styles.sectionLabel}>MY GROUPS</Text>
          <TouchableOpacity
            onPress={() => router.push('/spot/multiplayer/new' as any)}
            style={styles.newGroupBtn}
            activeOpacity={0.8}
            testID="spot-new-group"
          >
            <Ionicons name="add" size={14} color={colors.amber} />
            <Text style={styles.newGroupText}>NEW</Text>
          </TouchableOpacity>
        </View>
        {groups.length === 0 ? (
          <Text style={styles.groupsEmpty}>
            No permanent groups yet. Tap NEW to start one with up to 8 friends.
          </Text>
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
                  {g.member_count} of {g.max_members} active
                  {g.auto_challenge_on ? ' · auto-challenges ON' : ''}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          ))
        )}

        {/* Solo feed — now rendered as COMPACT TABS per spec. */}
        <Text style={[styles.sectionLabel, { marginTop: spacing.lg }]}>RECENT SPOTS</Text>
        {feed.length === 0 ? (
          <View style={styles.emptyFeed}>
            <Ionicons name="camera-outline" size={32} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No spots yet</Text>
            <Text style={styles.emptyDesc}>Tap "Play Challenge Solo" to get your first object!</Text>
          </View>
        ) : (
          feed.map((e) => (
            <CompactFeedTab key={e.id} entry={e} onTap={() => setOpenEntry(e)} />
          ))
        )}
      </ScrollView>

      <SpotEntryModal entry={openEntry} onClose={() => setOpenEntry(null)} onChange={load} />
    </SafeAreaView>
  );
}


// ────────────────────────────────────────────────────────────────────
// CompactFeedTab — v1.0.29 Phase 1 collapsed presentation for the
// Solo Recent Spots list. Shows player name + object + a coloured
// status dot. Tapping opens the existing SpotEntryModal (the same
// photo + details viewer the previous big card used).
// ────────────────────────────────────────────────────────────────────
function CompactFeedTab({ entry, onTap }: { entry: SpotEntry; onTap: () => void }) {
  const success = entry.success;
  const color = success ? colors.green : colors.red;
  const icon = success ? 'checkmark' : 'close';
  return (
    <TouchableOpacity
      onPress={onTap}
      activeOpacity={0.85}
      style={styles.compactTab}
      testID={`spot-compact-${entry.id}`}
    >
      <View style={[styles.compactStatus, { backgroundColor: color + '22', borderWidth: 1, borderColor: color + '88' }]}>
        <Ionicons name={icon as any} size={14} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.compactPlayer} numberOfLines={1}>{entry.player_name || 'Player'}</Text>
        <Text style={styles.compactObject} numberOfLines={1}>
          {entry.object_name || 'Object'} · {success ? 'Found' : 'Missed'}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

function FeedCard({ entry, onTap }: { entry: SpotEntry; onTap: () => void }) {  const success = entry.success;
  return (
    <TouchableOpacity activeOpacity={0.88} onPress={onTap} style={styles.feedCard} testID={`spot-card-${entry.id}`}>
      <View style={styles.feedHead}>
        <View style={styles.feedAvatarWrap}>
          {entry.player_avatar_base64 ? (
            <Image source={{ uri: `data:image/jpeg;base64,${entry.player_avatar_base64}` }} style={styles.feedAvatar} />
          ) : (
            <View style={[styles.feedAvatar, { backgroundColor: colors.cyan + '22', alignItems: 'center', justifyContent: 'center' }]}>
              <Text style={{ color: colors.cyan, fontWeight: '900' }}>{(entry.player_name || '?').slice(0, 1).toUpperCase()}</Text>
            </View>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={styles.feedName} numberOfLines={1}>{entry.player_name}</Text>
            <View style={styles.miniPointsPill}>
              <Ionicons name="trophy" size={9} color={colors.amber} />
              <Text style={styles.miniPointsTxt}>{entry.player_spot_points || 0}</Text>
            </View>
          </View>
          <Text style={styles.feedSub}>spotted "{entry.target_object}"</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: success ? colors.green + '22' : colors.red + '22', borderColor: success ? colors.green : colors.red }]}>
          <Ionicons name={success ? 'checkmark-circle' : 'close-circle'} size={11} color={success ? colors.green : colors.red} />
          <Text style={[styles.statusText, { color: success ? colors.green : colors.red }]}>
            {success ? 'FOUND' : 'MISSED'}
          </Text>
        </View>
      </View>
      <Image
        source={{ uri: `data:image/jpeg;base64,${entry.photo_base64}` }}
        style={styles.feedImage}
        resizeMode="cover"
      />
      <View style={styles.feedFoot}>
        <View style={styles.feedFootLeft}>
          <Ionicons
            name={entry.liked_by_you ? 'heart' : 'heart-outline'}
            size={16}
            color={entry.liked_by_you ? colors.red : colors.textMuted}
          />
          <Text style={styles.feedFootTxt}>{entry.like_count || 0}</Text>
          <Ionicons name="chatbubble-outline" size={15} color={colors.textMuted} style={{ marginLeft: 12 }} />
          <Text style={styles.feedFootTxt}>{entry.comment_count || 0}</Text>
        </View>
        <Text style={styles.feedTime}>
          {new Date(entry.taken_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function SpotEntryModal({
  entry, onClose, onChange,
}: { entry: SpotEntry | null; onClose: () => void; onChange: () => void }) {
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [liking, setLiking] = useState(false);
  const [local, setLocal] = useState<SpotEntry | null>(null);
  // Guest-gate — anonymous players can SCROLL the feed but tapping
  // like / comment must show the sign-in modal so social attribution
  // stays tied to a real account.
  const _guard = useGuestGate();
  const gateBlock = (label?: string) => _guard.block(label);
  // Edit state:
  //   editing=true  → the filter toolbar is visible over the photo.
  //   activeFilter  → which filter the server has applied in the preview.
  //   previewB64    → the preview returned by /spot/edit/preview. We show
  //                   this instead of the stored photo until the user saves
  //                   or cancels. Keeping it as separate state lets the
  //                   user toggle between filters without losing the
  //                   ability to revert.
  const [editing, setEditing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<'painting' | 'bw' | 'auto' | null>(null);
  const [previewB64, setPreviewB64] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  useEffect(() => {
    setLocal(entry);
    setComment('');
    // Reset editor state whenever a new entry opens.
    setEditing(false);
    setActiveFilter(null);
    setPreviewB64(null);
  }, [entry?.id]);

  if (!entry || !local) return null;

  const onLike = async () => {
    if (gateBlock('like a post')) return;
    setLiking(true);
    try {
      const r = await api.spotLike(local.id);
      setLocal({ ...local, liked_by_you: r.liked_by_you, like_count: r.like_count });
      onChange();
    } catch (e: any) {
      showAlert('Could not like', String(e?.message || e));
    } finally {
      setLiking(false);
    }
  };

  const onComment = async () => {
    if (gateBlock('comment on a post')) return;
    const txt = comment.trim();
    if (!txt) return;
    setSubmitting(true);
    try {
      const r = await api.spotComment(local.id, txt);
      setLocal({ ...local, comments: r.comments });
      setComment('');
      onChange();
    } catch (e: any) {
      showAlert('Could not comment', String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  // ──────────── Photo editing handlers ────────────
  const canEdit = !!local.is_self && local.success && !!local.photo_base64;

  const applyFilter = async (which: 'painting' | 'bw' | 'auto') => {
    if (!local || editBusy) return;
    setEditBusy(true);
    try {
      const r = await api.spotEditPreview(local.id, which);
      setPreviewB64(r.edited_base64);
      setActiveFilter(which);
    } catch (e: any) {
      showAlert('Filter failed', String(e?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!local || !previewB64 || editBusy) return;
    setEditBusy(true);
    try {
      await api.spotEditSave(local.id, previewB64);
      // Optimistically update local state so the new filtered photo is
      // instantly visible throughout the modal + the parent feed.
      setLocal({ ...local, photo_base64: previewB64 });
      setEditing(false);
      setActiveFilter(null);
      setPreviewB64(null);
      onChange();
      showAlert('Saved', 'Your edited photo replaced the original.');
    } catch (e: any) {
      showAlert('Could not save', String(e?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const cancelEdit = () => {
    setEditing(false);
    setActiveFilter(null);
    setPreviewB64(null);
  };

  return (
    <View style={styles.detailBackdrop}>
      <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={styles.detailHeader}>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.detailTitle}>{local.target_object}</Text>
            <View style={{ width: 24 }} />
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
            <View style={styles.detailHead}>
              {local.player_avatar_base64 ? (
                <Image source={{ uri: `data:image/jpeg;base64,${local.player_avatar_base64}` }} style={styles.detailAvatar} />
              ) : (
                <View style={[styles.detailAvatar, { backgroundColor: colors.cyan + '22', alignItems: 'center', justifyContent: 'center' }]}>
                  <Text style={{ color: colors.cyan, fontWeight: '900', fontSize: 20 }}>
                    {(local.player_name || '?').slice(0, 1).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.detailName}>{local.player_name}</Text>
                <Text style={styles.detailSub}>{local.player_spot_points || 0} Spot Points</Text>
              </View>
            </View>
            {/* Photo with in-place edit overlay. The pencil icon shows
                only for the OWNER of the spot; viewers of friend spots
                see the raw photo. Tapping the pencil toggles a filter
                toolbar that overlays the image; the preview is applied
                server-side in <500 ms and rendered via previewB64. */}
            <View style={{ position: 'relative' }}>
              <Image
                source={{ uri: `data:image/jpeg;base64,${previewB64 || local.photo_base64}` }}
                style={styles.detailImage}
                resizeMode="cover"
              />
              {canEdit && !editing ? (
                <TouchableOpacity
                  onPress={() => setEditing(true)}
                  testID="spot-edit-open"
                  style={styles.editPencilBtn}
                  accessibilityLabel="Edit photo"
                  activeOpacity={0.8}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="pencil" size={18} color={colors.bg} />
                </TouchableOpacity>
              ) : null}
              {editBusy ? (
                <View style={styles.editBusyOverlay}>
                  <ActivityIndicator color={colors.cyan} />
                  <Text style={styles.editBusyLabel}>Applying filter…</Text>
                </View>
              ) : null}
            </View>

            {/* Filter chooser row — only visible while editing */}
            {canEdit && editing ? (
              <View style={styles.editToolbar}>
                <Text style={styles.editToolbarKicker}>PHOTO EDITS</Text>
                <View style={styles.filterRow}>
                  <FilterChip
                    label="Painting"
                    icon="color-palette"
                    active={activeFilter === 'painting'}
                    onPress={() => applyFilter('painting')}
                    disabled={editBusy}
                    testID="spot-filter-painting"
                  />
                  <FilterChip
                    label="B&W"
                    icon="contrast"
                    active={activeFilter === 'bw'}
                    onPress={() => applyFilter('bw')}
                    disabled={editBusy}
                    testID="spot-filter-bw"
                  />
                  <FilterChip
                    label="Auto Edit"
                    icon="flash"
                    active={activeFilter === 'auto'}
                    onPress={() => applyFilter('auto')}
                    disabled={editBusy}
                    testID="spot-filter-auto"
                  />
                </View>
                <View style={styles.editActionsRow}>
                  <TouchableOpacity
                    style={[styles.editActionBtn, styles.editCancelBtn]}
                    onPress={cancelEdit}
                    disabled={editBusy}
                    testID="spot-edit-cancel"
                  >
                    <Text style={styles.editCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.editActionBtn,
                      styles.editSaveBtn,
                      (!previewB64 || editBusy) && { opacity: 0.45 },
                    ]}
                    onPress={saveEdit}
                    disabled={!previewB64 || editBusy}
                    testID="spot-edit-save"
                  >
                    <Ionicons name="save" size={16} color={colors.bg} />
                    <Text style={styles.editSaveText}>Save Photo</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
            <View style={styles.detailMeta}>
              <Text style={styles.detailMetaText}>
                {local.success ? '✅ Found the object' : "❌ Didn't find the object"} · {local.remaining_seconds}s left
              </Text>
              <Text style={styles.detailMetaSub}>{new Date(local.taken_at).toLocaleString()}</Text>
            </View>

            <TouchableOpacity onPress={onLike} disabled={liking} style={styles.likeBtn}>
              <Ionicons
                name={local.liked_by_you ? 'heart' : 'heart-outline'}
                size={20}
                color={local.liked_by_you ? colors.red : colors.text}
              />
              <Text style={styles.likeText}>
                {local.like_count || 0} {(local.like_count || 0) === 1 ? 'like' : 'likes'}
              </Text>
            </TouchableOpacity>

            <Text style={styles.sectionLabel}>COMMENTS</Text>
            {(local.comments || []).length === 0 ? (
              <Text style={styles.emptyDesc}>No comments yet — be the first.</Text>
            ) : (
              (local.comments || []).map((c) => (
                <View key={c.id} style={styles.comment}>
                  <View style={styles.commentAvatar}>
                    {c.user_avatar_base64 ? (
                      <Image source={{ uri: `data:image/jpeg;base64,${c.user_avatar_base64}` }} style={{ width: 28, height: 28, borderRadius: 14 }} />
                    ) : (
                      <Text style={{ color: colors.cyan, fontWeight: '900' }}>{(c.user_name || '?').slice(0, 1).toUpperCase()}</Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.commentName}>{c.user_name}</Text>
                    <Text style={styles.commentText}>{c.text}</Text>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
          <View style={styles.commentBar}>
            <TextInput
              value={comment}
              onChangeText={setComment}
              placeholder="Write a comment…"
              placeholderTextColor={colors.textMuted}
              maxLength={280}
              style={styles.commentInput}
              onSubmitEditing={onComment}
              returnKeyType="send"
            />
            <TouchableOpacity onPress={onComment} disabled={submitting || !comment.trim()} style={[styles.sendBtn, (submitting || !comment.trim()) && { opacity: 0.5 }]}>
              {submitting ? <ActivityIndicator color={colors.bg} /> : <Ionicons name="send" size={16} color={colors.bg} />}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

/**
 * FilterChip — small pill button used in the photo editor toolbar.
 * Highlights cyan when active so the user can see which filter the
 * current preview is showing without reading the label.
 */
function FilterChip({
  label, icon, active, onPress, disabled, testID,
}: {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      activeOpacity={0.75}
      style={[
        styles.filterChip,
        active && styles.filterChipActive,
        disabled && { opacity: 0.5 },
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
    >
      <Ionicons name={icon} size={15} color={active ? colors.bg : colors.cyan} />
      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}


const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  topTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, justifyContent: 'center' },
  miniIconBox: {
    width: 22, height: 22, borderRadius: 6,
    backgroundColor: colors.green + '22', borderWidth: 1, borderColor: colors.green + '55',
    alignItems: 'center', justifyContent: 'center',
  },
  topTitle: { color: colors.text, fontWeight: '900', fontSize: 15 },
  pointsPill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: radii.pill,
    backgroundColor: colors.amber + '18', borderWidth: 1, borderColor: colors.amber + '88',
  },
  pointsText: { color: colors.amber, fontWeight: '900', fontSize: 13 },

  modeCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.lg, padding: spacing.md, marginBottom: spacing.md,
  },
  modeCardLocked: { opacity: 0.6 },
  modeIcon: {
    width: 56, height: 56, borderRadius: 14, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  modeTitle: { color: colors.text, fontSize: 15, fontWeight: '900' },
  modeDesc: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  statCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.amber + '12', borderWidth: 1, borderColor: colors.amber + '88',
    borderRadius: radii.lg, padding: spacing.md, marginBottom: spacing.lg,
  },
  statLabel: { color: colors.amber, fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
  statValue: { color: colors.text, fontSize: 36, fontWeight: '900', marginTop: 4 },
  statTrophy: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },

  sectionLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1.5, marginBottom: 8, marginTop: 4 },
  emptyFeed: { alignItems: 'center', paddingVertical: spacing.xl, gap: 6 },
  // ── v1.0.29 Phase 1 — permanent groups ───────────────────────────
  groupsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  newGroupBtn: {
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
  newGroupText: {
    color: colors.amber,
    fontWeight: '900',
    fontSize: 10,
    letterSpacing: 1,
  },
  groupsEmpty: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    paddingVertical: spacing.sm,
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  groupIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupName: {
    color: colors.text,
    fontWeight: '800',
    fontSize: 14,
  },
  groupMeta: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  // ── Compact recent-spots tab ─────────────────────────────────────
  compactTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  compactStatus: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactPlayer: {
    color: colors.text,
    fontWeight: '800',
    fontSize: 13,
  },
  compactObject: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  emptyTitle: { color: colors.text, fontWeight: '900', fontSize: 14, marginTop: 6 },
  emptyDesc: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },

  feedCard: {
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.lg, marginBottom: spacing.md, overflow: 'hidden',
  },
  feedHead: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: spacing.md },
  feedAvatarWrap: { width: 36, height: 36, borderRadius: 18, overflow: 'hidden' },
  feedAvatar: { width: 36, height: 36, borderRadius: 18 },
  feedName: { color: colors.text, fontWeight: '900', fontSize: 13 },
  feedSub: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  miniPointsPill: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: radii.pill,
    backgroundColor: colors.amber + '18', borderWidth: 1, borderColor: colors.amber + '55',
  },
  miniPointsTxt: { color: colors.amber, fontSize: 9, fontWeight: '900' },
  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: radii.pill, borderWidth: 1,
  },
  statusText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  feedImage: { width: '100%', aspectRatio: 1, backgroundColor: '#000' },
  feedFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md },
  feedFootLeft: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  feedFootTxt: { color: colors.textMuted, fontSize: 12, marginLeft: 2 },
  feedTime: { color: colors.textMuted, fontSize: 11 },

  detailBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.bg },
  detailHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  detailTitle: { color: colors.text, fontWeight: '900', fontSize: 15, textTransform: 'capitalize' },
  detailHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: spacing.md },
  detailAvatar: { width: 44, height: 44, borderRadius: 22 },
  detailName: { color: colors.text, fontWeight: '900', fontSize: 15 },
  detailSub: { color: colors.amber, fontSize: 12, marginTop: 2, fontWeight: '700' },
  detailImage: { width: '100%', aspectRatio: 1, borderRadius: radii.md, backgroundColor: '#000' },
  // ── Photo edit overlay ──
  editPencilBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
    // Slight dark scrim behind the icon for contrast over busy photos.
    borderWidth: 2,
    borderColor: '#00000055',
  },
  editBusyOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#00000066',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    gap: 8,
  },
  editBusyLabel: { color: colors.text, fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  editToolbar: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.cyan + '66',
    backgroundColor: colors.surfaceGlass,
    gap: spacing.sm,
  },
  editToolbarKicker: { color: colors.cyan, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  filterRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.cyan + '66',
    backgroundColor: colors.cyan + '14',
    minHeight: 40,
  },
  filterChipActive: {
    backgroundColor: colors.cyan,
    borderColor: colors.cyan,
  },
  filterChipText: { color: colors.cyan, fontSize: 13, fontWeight: '800' },
  filterChipTextActive: { color: colors.bg },
  editActionsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  editActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: radii.md,
    minHeight: 44,
  },
  editCancelBtn: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  editCancelText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  editSaveBtn: { backgroundColor: colors.green },
  editSaveText: { color: colors.bg, fontSize: 13, fontWeight: '900' },
  detailMeta: { marginTop: spacing.md, marginBottom: spacing.md },
  detailMetaText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  detailMetaSub: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  likeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border,
    alignSelf: 'flex-start', marginBottom: spacing.md,
  },
  likeText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  comment: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    padding: 10, marginBottom: 6,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
  },
  commentAvatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cyan + '22' },
  commentName: { color: colors.text, fontWeight: '900', fontSize: 12 },
  commentText: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  commentBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  commentInput: {
    flex: 1, color: colors.text, fontSize: 14,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: radii.pill, backgroundColor: colors.surfaceGlass,
    borderWidth: 1, borderColor: colors.border,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.cyan,
  },
});
