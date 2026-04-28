/**
 * /spot/multiplayer/[id]
 *
 * Single-screen state machine for a multiplayer match. The same screen
 * morphs through three states based on `match.status`:
 *
 *   • 'waiting'  → lobby view: player list with Joined/Invited badges,
 *                  host has [Start now] + [Cancel], guests have [Join]
 *                  + [Decline]. Polled every 2 s.
 *   • 'active'   → camera + countdown + leaderboard. Player taps to
 *                  snap a photo; we POST to /spot/match/{id}/capture.
 *                  Successful captures bump the count. Polled every 2 s.
 *   • 'finished' → results view with winner banner, final scores, and
 *                  a [Back to lobby list] CTA.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { showAlert } from '../../../src/uiAlert';
import { colors, spacing } from '../../../src/theme';
import { api, type SpotMatch } from '../../../src/api';

const POLL_MS = 2000;

export default function SpotMatchDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const matchId = String(id || '');

  const [match, setMatch] = useState<SpotMatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturing, setCapturing] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const camRef = useRef<CameraView | null>(null);
  // Track whether we've already shown the win/lose alert so we don't spam.
  const finalAlertShown = useRef(false);

  const load = useCallback(async () => {
    if (!matchId) return;
    try {
      const r = await api.spotMatchGet(matchId);
      setMatch(r.match);
    } catch (e: any) {
      // Don't spam alerts during polling — just log to console.
      console.log('[spot/match] load failed', e);
    } finally {
      setLoading(false);
    }
  }, [matchId]);

  // Poll while focused so lobby + countdown + scores stay live.
  useFocusEffect(
    useCallback(() => {
      load();
      const id = setInterval(load, POLL_MS);
      return () => clearInterval(id);
    }, [load]),
  );

  // When the match flips to 'finished' show a one-shot result alert.
  useEffect(() => {
    if (!match || match.status !== 'finished') return;
    if (finalAlertShown.current) return;
    finalAlertShown.current = true;
    const winner = match.players.find((p) => p.user_id === match.winner_id);
    const youWon = winner && winner.user_id === viewerId(match);
    const reward = match.viewer_reward;
    const title = youWon ? '🏆 You won!' : winner ? `${winner.name} won` : "It's a draw";
    const body = winner
      ? youWon
        ? `+${reward} Spot Points`
        : `${reward >= 0 ? '+' : ''}${reward} SP — better luck next round!`
      : 'No captures by anyone — no points awarded.';
    showAlert(title, body);
  }, [match]);

  const isHost = match?.viewer_role === 'host';
  const me = match ? match.players.find((p) => p.is_host && match.viewer_role === 'host')
    : null;

  const onJoin = async () => {
    if (busy || !matchId) return;
    setBusy(true);
    try {
      const r = await api.spotMatchJoin(matchId);
      setMatch(r.match);
    } catch (e: any) {
      showAlert('Could not join', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };
  const onDecline = async () => {
    if (busy || !matchId) return;
    setBusy(true);
    try {
      await api.spotMatchDecline(matchId);
      router.back();
    } catch (e: any) {
      showAlert('Could not decline', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };
  const onStart = async () => {
    if (busy || !matchId) return;
    setBusy(true);
    try {
      const r = await api.spotMatchStart(matchId);
      setMatch(r.match);
      // Make sure we have camera permission before the active phase.
      if (!permission?.granted) {
        await requestPermission();
      }
    } catch (e: any) {
      showAlert('Could not start', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };
  const onCancel = async () => {
    if (busy || !matchId) return;
    setBusy(true);
    try {
      await api.spotMatchCancel(matchId);
      router.back();
    } catch (e: any) {
      showAlert('Could not cancel', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const onSnap = async () => {
    if (capturing || !camRef.current || !matchId) return;
    setCapturing(true);
    setFeedback(null);
    try {
      const photo = await camRef.current.takePictureAsync({
        quality: 0.5,
        base64: true,
        skipProcessing: true,
      });
      const b64 = photo?.base64;
      if (!b64) throw new Error('Could not capture photo');
      const r = await api.spotMatchCapture(matchId, b64);
      setMatch(r.match);
      setFeedback({
        ok: r.can_capture,
        text: r.can_capture
          ? `Got it! Captures: ${r.captures}`
          : 'Not detected — line it up better and try again.',
      });
      // Auto-clear feedback after 2 s
      setTimeout(() => setFeedback(null), 2000);
    } catch (e: any) {
      setFeedback({ ok: false, text: String(e?.message || e) });
      setTimeout(() => setFeedback(null), 2500);
    } finally {
      setCapturing(false);
    }
  };

  if (loading || !match) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}><ActivityIndicator size="large" color={colors.cyan} /></View>
      </SafeAreaView>
    );
  }

  const status = match.status;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="mp-detail-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.topTitleWrap}>
          <Text style={styles.topTitle}>
            {status === 'active' ? 'Live!' : status === 'finished' ? 'Match results' : 'Match lobby'}
          </Text>
          {status === 'active' && (
            <Text style={styles.timerText}>{(match.seconds_left ?? 0)}s left</Text>
          )}
        </View>
        <View style={{ width: 26 }} />
      </View>

      {status === 'waiting' && <LobbyView match={match} isHost={isHost} busy={busy} onJoin={onJoin} onDecline={onDecline} onStart={onStart} onCancel={onCancel} />}
      {status === 'active' && (
        <ActiveView
          match={match}
          permission={permission}
          requestPermission={requestPermission}
          camRef={camRef}
          capturing={capturing}
          feedback={feedback}
          onSnap={onSnap}
        />
      )}
      {(status === 'finished' || status === 'cancelled') && <ResultsView match={match} onClose={() => router.back()} />}
    </SafeAreaView>
  );
}

function viewerId(match: SpotMatch): string {
  // Identify "me" as: the player whose viewer_role isn't 'spectator' if
  // possible; otherwise null. We don't know our own user_id from props,
  // so we infer it from viewer_captures + role.
  if (match.viewer_role === 'host') return match.host_id;
  // For non-host viewers, the joined list is the only info we have about
  // who "you" are. Since the API embeds viewer_captures we can find the
  // player whose captures match (best-effort — duplicates collapse).
  const candidates = match.players.filter((p) => p.captures === match.viewer_captures);
  return candidates.length === 1 ? candidates[0].user_id : (match.players[0]?.user_id || '');
}

// ───────────── Lobby (waiting) ─────────────
function LobbyView({
  match,
  isHost,
  busy,
  onJoin,
  onDecline,
  onStart,
  onCancel,
}: {
  match: SpotMatch;
  isHost: boolean;
  busy: boolean;
  onJoin: () => void;
  onDecline: () => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const isInvitee = match.viewer_role === 'invited';
  const isJoinedNonHost = match.viewer_role === 'joined';
  const joinedCount = match.players.filter((p) => p.joined).length;
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
      <View style={styles.heroCard}>
        <Ionicons name="hourglass" size={28} color={colors.amber} />
        <Text style={styles.heroTitle}>Waiting room</Text>
        <Text style={styles.heroSub}>
          {joinedCount} / {match.players.length} players ready ·{' '}
          {isHost ? 'Tap Start when everyone has joined' : 'Host will start the match shortly'}
        </Text>
      </View>

      <Text style={styles.sectionLabel}>PLAYERS</Text>
      {match.players.map((p) => (
        <View key={p.user_id} style={styles.playerRow}>
          {p.avatar_base64 ? (
            <Image source={{ uri: `data:image/jpeg;base64,${p.avatar_base64}` }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarLetter}>{(p.name || '?').slice(0, 1).toUpperCase()}</Text>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.playerName}>{p.name}{p.is_host ? ' · Host' : ''}</Text>
            <Text style={styles.playerSub}>
              {p.declined ? 'Declined' : p.joined ? 'Ready' : 'Invited — waiting'}
            </Text>
          </View>
          <View style={[styles.statusDot, { backgroundColor: p.declined ? colors.red : p.joined ? colors.green : colors.amber }]} />
        </View>
      ))}

      <View style={{ marginTop: spacing.lg, gap: 10 }}>
        {isHost && (
          <>
            <TouchableOpacity style={styles.btnPrimary} onPress={onStart} disabled={busy} testID="mp-start">
              {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.btnPrimaryText}>Start match now</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnSecondary} onPress={onCancel} disabled={busy} testID="mp-cancel">
              <Text style={styles.btnSecondaryText}>Cancel match</Text>
            </TouchableOpacity>
          </>
        )}
        {isInvitee && (
          <>
            <TouchableOpacity style={styles.btnPrimary} onPress={onJoin} disabled={busy} testID="mp-join">
              {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.btnPrimaryText}>Join match</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnSecondary} onPress={onDecline} disabled={busy} testID="mp-decline">
              <Text style={styles.btnSecondaryText}>Decline</Text>
            </TouchableOpacity>
          </>
        )}
        {isJoinedNonHost && (
          <View style={styles.waitingPill}>
            <Ionicons name="checkmark-circle" size={16} color={colors.green} />
            <Text style={styles.waitingPillText}>You're in! Waiting for the host…</Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

// ───────────── Active (gameplay) ─────────────
function ActiveView({
  match,
  permission,
  requestPermission,
  camRef,
  capturing,
  feedback,
  onSnap,
}: {
  match: SpotMatch;
  permission: ReturnType<typeof useCameraPermissions>[0];
  requestPermission: ReturnType<typeof useCameraPermissions>[1];
  camRef: React.MutableRefObject<CameraView | null>;
  capturing: boolean;
  feedback: { ok: boolean; text: string } | null;
  onSnap: () => void;
}) {
  if (!permission || !permission.granted) {
    return (
      <View style={styles.permGate}>
        <Ionicons name="camera" size={48} color={colors.cyan} />
        <Text style={styles.permTitle}>Camera permission needed</Text>
        <Text style={styles.permDesc}>
          We need access to the camera so you can snap the target object.
        </Text>
        <TouchableOpacity style={styles.btnPrimary} onPress={requestPermission}>
          <Text style={styles.btnPrimaryText}>Allow camera</Text>
        </TouchableOpacity>
      </View>
    );
  }
  // Web has limited CameraView support — show a placeholder.
  if (Platform.OS === 'web') {
    return (
      <View style={styles.permGate}>
        <Ionicons name="phone-portrait" size={48} color={colors.cyan} />
        <Text style={styles.permTitle}>Use the mobile app</Text>
        <Text style={styles.permDesc}>
          Multiplayer capture only works on the phone app — open this match
          on your device to participate.
        </Text>
      </View>
    );
  }
  // Sort leaderboard descending by captures
  const ranked = [...match.players].filter((p) => p.joined).sort((a, b) => b.captures - a.captures);
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.targetCard}>
        <Text style={styles.targetLabel}>FIND</Text>
        <Text style={styles.targetText}>{match.target_object || '—'}</Text>
        <Text style={styles.targetSub}>You: {match.viewer_captures} captures</Text>
      </View>
      <View style={styles.cameraWrap}>
        <CameraView ref={camRef} style={StyleSheet.absoluteFill} facing="back" />
        {feedback ? (
          <View style={[styles.feedback, feedback.ok ? styles.feedbackOk : styles.feedbackNo]}>
            <Ionicons
              name={feedback.ok ? 'checkmark-circle' : 'close-circle'}
              size={18}
              color={feedback.ok ? colors.green : colors.red}
            />
            <Text style={styles.feedbackText}>{feedback.text}</Text>
          </View>
        ) : null}
        <TouchableOpacity
          style={[styles.snapBtn, capturing && { opacity: 0.6 }]}
          onPress={onSnap}
          disabled={capturing}
          testID="mp-snap"
          activeOpacity={0.85}
        >
          {capturing ? <ActivityIndicator color="#000" /> : <Ionicons name="camera" size={28} color="#000" />}
        </TouchableOpacity>
      </View>
      <ScrollView style={styles.leaderboardWrap} contentContainerStyle={{ padding: spacing.md }}>
        <Text style={styles.sectionLabel}>LIVE SCORES</Text>
        {ranked.map((p, i) => (
          <View key={p.user_id} style={styles.scoreRow}>
            <Text style={styles.scoreRank}>{i + 1}</Text>
            <Text style={styles.scoreName} numberOfLines={1}>{p.name}{p.is_host ? ' · Host' : ''}</Text>
            <Text style={styles.scoreCaps}>{p.captures}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// ───────────── Results (finished) ─────────────
function ResultsView({ match, onClose }: { match: SpotMatch; onClose: () => void }) {
  const winner = match.players.find((p) => p.user_id === match.winner_id);
  const ranked = [...match.players].sort((a, b) => b.captures - a.captures);
  const reward = match.viewer_reward;
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
      <View style={[styles.heroCard, { backgroundColor: winner ? colors.green + '22' : colors.surface, borderColor: winner ? colors.green : colors.border }]}>
        <Ionicons name={winner ? 'trophy' : 'flag'} size={36} color={winner ? colors.green : colors.amber} />
        <Text style={styles.heroTitle}>
          {match.status === 'cancelled' ? 'Match cancelled' : winner ? `${winner.name} wins!` : "It's a draw"}
        </Text>
        <Text style={styles.heroSub}>
          {match.status === 'cancelled'
            ? 'The host cancelled before kickoff.'
            : winner
              ? `Found ${winner.captures} object${winner.captures === 1 ? '' : 's'} in 2 minutes.`
              : 'No one captured the target.'}
        </Text>
        {match.status === 'finished' && reward !== 0 ? (
          <View style={[styles.rewardPill, { backgroundColor: reward > 0 ? colors.green : colors.red, marginTop: 10 }]}>
            <Ionicons name={reward > 0 ? 'arrow-up' : 'arrow-down'} size={14} color={colors.bg} />
            <Text style={styles.rewardPillText}>{reward > 0 ? `+${reward}` : reward} Spot Points</Text>
          </View>
        ) : null}
      </View>

      {match.status === 'finished' && (
        <>
          <Text style={styles.sectionLabel}>FINAL SCORES</Text>
          {ranked.map((p, i) => (
            <View key={p.user_id} style={[styles.scoreRow, p.user_id === match.winner_id && styles.scoreRowWinner]}>
              <Text style={styles.scoreRank}>{i + 1}</Text>
              <Text style={styles.scoreName} numberOfLines={1}>
                {p.name}{p.user_id === match.winner_id ? ' 🏆' : ''}
              </Text>
              <Text style={styles.scoreCaps}>{p.captures}</Text>
            </View>
          ))}
        </>
      )}

      <TouchableOpacity style={[styles.btnSecondary, { marginTop: spacing.lg }]} onPress={onClose}>
        <Text style={styles.btnSecondaryText}>Back to lobbies</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  timerText: { color: colors.cyan, fontSize: 12, fontWeight: '800' },
  heroCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: spacing.lg,
    alignItems: 'center',
  },
  heroTitle: { color: colors.text, fontSize: 20, fontWeight: '900', marginTop: 8, textAlign: 'center' },
  heroSub: { color: colors.textMuted, fontSize: 13, marginTop: 4, textAlign: 'center', lineHeight: 18 },
  sectionLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1, marginTop: spacing.lg, marginBottom: 8 },
  playerRow: {
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
  avatar: { width: 38, height: 38, borderRadius: 19 },
  avatarFallback: { backgroundColor: colors.cyan + '22', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: colors.cyan, fontWeight: '900' },
  playerName: { color: colors.text, fontWeight: '800', fontSize: 14 },
  playerSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  statusDot: { width: 12, height: 12, borderRadius: 6 },
  btnPrimary: {
    backgroundColor: colors.cyan,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  btnPrimaryText: { color: colors.bg, fontWeight: '900', fontSize: 15 },
  btnSecondary: {
    backgroundColor: 'transparent',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 44,
    justifyContent: 'center',
  },
  btnSecondaryText: { color: colors.textMuted, fontWeight: '700', fontSize: 14 },
  waitingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.green + '15',
    borderColor: colors.green + '55',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    justifyContent: 'center',
  },
  waitingPillText: { color: colors.green, fontWeight: '800' },
  permGate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: 12 },
  permTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  permDesc: { color: colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  targetCard: {
    backgroundColor: colors.surface,
    margin: spacing.md,
    padding: spacing.md,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.cyan + '55',
  },
  targetLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  targetText: { color: colors.cyan, fontSize: 22, fontWeight: '900', textTransform: 'capitalize' },
  targetSub: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  cameraWrap: {
    height: 320,
    margin: spacing.md,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#000',
    position: 'relative',
  },
  snapBtn: {
    position: 'absolute',
    bottom: 16,
    alignSelf: 'center',
    left: 0,
    right: 0,
    marginHorizontal: 'auto' as any,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateX: -32 }] as any,
  },
  feedback: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  feedbackOk: { backgroundColor: 'rgba(0,0,0,0.7)', borderWidth: 1, borderColor: colors.green + '88' },
  feedbackNo: { backgroundColor: 'rgba(0,0,0,0.7)', borderWidth: 1, borderColor: colors.red + '88' },
  feedbackText: { color: '#fff', fontSize: 12, fontWeight: '700', flex: 1 },
  leaderboardWrap: { flex: 1 },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  scoreRowWinner: { backgroundColor: colors.green + '15', borderWidth: 1, borderColor: colors.green + '88' },
  scoreRank: { color: colors.cyan, fontWeight: '900', fontSize: 14, width: 22 },
  scoreName: { color: colors.text, fontWeight: '700', flex: 1 },
  scoreCaps: { color: colors.amber, fontWeight: '900', fontSize: 16 },
  rewardPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  rewardPillText: { color: colors.bg, fontWeight: '900', fontSize: 13 },
});
