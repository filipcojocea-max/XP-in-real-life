/**
 * Spot the Object — Play screen (Solo + Multiplayer random-challenge)
 *
 * 2026-06-15 photo-capture overhaul (per user spec):
 *   • NO real-time AI scanning — the camera no longer pulls frames
 *     every 2.5 s to pre-classify them.
 *   • NO auto-capture — even when the timer hits 0 we do NOT secretly
 *     snap a photo. The round simply ends.
 *   • Camera screen ALWAYS shows a big "Take Photo" button below the
 *     viewfinder. Tap → snap → AI verifies the SNAPPED photo only.
 *   • Correct: confirm success + auto-submit + return.
 *   • Incorrect: show "Incorrect object" + a "Try Again" button that
 *     puts the player straight back on the camera screen. Repeats
 *     until they get it right OR the round timer runs out.
 *
 * Scoring, timer length, and round rules are unchanged — only the
 * capture + verification UX changes.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { api } from '../../src/api';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';

/**
 * Phase machine:
 *   briefing   — pre-camera intro card with the target object.
 *   capturing  — camera open + "Take Photo" button (no AI scanning).
 *   verifying  — photo just snapped; AI verifying it.
 *   incorrect  — AI rejected the snap; player taps "Try Again".
 *   correct    — AI accepted; submit + show success.
 *   timeout    — timer hit 0 with no correct snap; show failure.
 */
type Phase = 'briefing' | 'capturing' | 'verifying' | 'incorrect' | 'correct' | 'timeout';

export default function SpotPlay() {
  const params = useLocalSearchParams<{ mode?: string; object?: string }>();
  const mode = (params.mode as 'solo_constant' | 'solo_random') || 'solo_constant';
  // Multiplayer / random-mode challenges are timed (120 s). Practice
  // solo mode is untimed.
  const isTimed = mode !== 'solo_constant';

  const [target, setTarget] = useState<string>(typeof params.object === 'string' ? params.object : '');
  const [phase, setPhase] = useState<Phase>('briefing');
  const [permission, requestPermission] = useCameraPermissions();
  const [secondsLeft, setSecondsLeft] = useState(isTimed ? 120 : 0);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  // Server-supplied "why it was rejected" reason — surfaces under the
  // "Incorrect object" headline so the player knows whether the AI
  // could see the object at all vs. saw the wrong thing.
  const [rejectReason, setRejectReason] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const camRef = useRef<CameraView | null>(null);

  // ── Target fetch ──────────────────────────────────────────────
  // Solo constant + random both start with a target. If the route was
  // opened without one (e.g. from the home shortcut) we ask the server
  // for a random word.
  useEffect(() => {
    if (target) return;
    api.spotGetObject().then((r) => setTarget(r.object)).catch((e) => {
      showAlert('Could not start', String(e?.message || e));
    });
  }, [target]);

  // ── Round timer ───────────────────────────────────────────────
  // Counts down ONLY while the player is actively trying to capture
  // or verifying. Pauses on briefing/incorrect screens so the player
  // has a chance to read the result. Reaching 0 → "timeout" phase.
  useEffect(() => {
    if (!isTimed) return;
    if (phase !== 'capturing' && phase !== 'verifying') return;
    if (secondsLeft <= 0) {
      setPhase('timeout');
      // Auto-submit a FAILED entry so the round counts against the
      // player's stats (same behaviour as the previous build).
      void submitOutcome(false);
      return;
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, secondsLeft, isTimed]);

  // ── Server submission ─────────────────────────────────────────
  const submitOutcome = useCallback(
    async (success: boolean) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        await api.spotComplete({
          target_object: target,
          photo_base64: photoBase64 || '',
          success,
          remaining_seconds: isTimed ? Math.max(0, secondsLeft) : 0,
          mode,
        });
      } catch (e: any) {
        // Don't block the success/failure UX on a network blip — the
        // user already got the verdict from the AI. Just log it.
        console.log('[spot] complete failed', e?.message);
      } finally {
        setSubmitting(false);
      }
    },
    [target, photoBase64, isTimed, secondsLeft, mode, submitting],
  );

  // ── Start the round (briefing → capturing) ────────────────────
  const startCapturing = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r?.granted) {
        showAlert(
          'Camera permission needed',
          'Allow camera access in your phone settings to play Spot the Object.',
        );
        return;
      }
    }
    if (isTimed) setSecondsLeft(120);
    setPhotoBase64(null);
    setRejectReason('');
    setPhase('capturing');
  };

  // ── Manual snap + verify ──────────────────────────────────────
  // Triggered ONLY by tapping the "Take Photo" button. No auto-snap,
  // no real-time scan. The photo is base-64'd and sent to /spot/check
  // for AI verification; the result decides the next phase.
  const onTakePhoto = useCallback(async () => {
    if (!camRef.current || phase !== 'capturing') return;
    setPhase('verifying');
    try {
      const pic = await camRef.current.takePictureAsync({
        base64: true,
        quality: 0.7,
      });
      const b64 = pic?.base64 || '';
      if (!b64) {
        setPhase('capturing');
        showAlert('Capture failed', 'Could not read the photo. Try again.');
        return;
      }
      setPhotoBase64(b64);
      // Run the AI on the SNAPPED photo only — no live-frame scanning.
      const r = await api.spotCheck(target, b64);
      if (r.can_capture) {
        // ✅ Correct — submit the success + show the success screen.
        // We don't wait on submitOutcome before transitioning so the
        // player sees the result instantly even on slow networks.
        void submitOutcome(true);
        setPhase('correct');
      } else {
        setRejectReason(r.reason || '');
        setPhase('incorrect');
      }
    } catch (e: any) {
      // Network / camera error — treat as "verification failed" so
      // the player can retry instead of losing the round.
      setRejectReason(String(e?.message || e));
      setPhase('incorrect');
    }
  }, [phase, target, submitOutcome]);

  // ── "Try Again" — back into camera with the SAME target ───────
  const onTryAgain = () => {
    setPhotoBase64(null);
    setRejectReason('');
    setPhase('capturing');
  };

  // ── Briefing screen (unchanged copy) ──────────────────────────
  if (phase === 'briefing') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.briefingHeader}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="close" size={26} color={colors.text} />
          </TouchableOpacity>
          {isTimed ? (
            <View style={styles.timerPill}>
              <Ionicons name="timer-outline" size={12} color={colors.amber} />
              <Text style={styles.timerPillText}>2:00</Text>
            </View>
          ) : <View />}
        </View>
        <View style={styles.briefingBody}>
          <View style={styles.briefingIcon}>
            <Ionicons name="scan-circle" size={56} color={colors.green} />
          </View>
          <Text style={styles.briefingKicker}>YOUR CHALLENGE</Text>
          <Text style={styles.briefingTarget}>Take a Photo of...</Text>
          <Text style={styles.briefingObject} numberOfLines={2}>
            {target || '...'}
          </Text>
          {isTimed ? (
            <Text style={styles.briefingHint}>You have 2 minutes. Tap the green button when you&apos;ve framed it.</Text>
          ) : (
            <Text style={styles.briefingHint}>No timer in solo practice — take your time and tap when ready.</Text>
          )}
        </View>
        <TouchableOpacity
          style={[styles.bigBtn, !target && { opacity: 0.5 }]}
          onPress={startCapturing}
          disabled={!target}
          testID="spot-start-scan"
        >
          <Ionicons name="camera" size={20} color={colors.bg} />
          <Text style={styles.bigBtnText}>
            {target ? `Open camera` : '...'}
          </Text>
        </TouchableOpacity>
        {isTimed ? (
          <View style={styles.briefingTimerLine}>
            <Text style={styles.briefingTimerText}>Timer starts when camera opens</Text>
          </View>
        ) : null}
      </SafeAreaView>
    );
  }

  // ── Capturing + verifying screen (single camera surface) ──────
  if (phase === 'capturing' || phase === 'verifying') {
    if (!permission?.granted) {
      return (
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
          <View style={styles.center}>
            <Ionicons name="camera-outline" size={48} color={colors.textMuted} />
            <Text style={styles.briefingHint}>Camera permission required</Text>
            <TouchableOpacity onPress={requestPermission} style={[styles.bigBtn, { marginTop: 16, alignSelf: 'center' }]}>
              <Text style={styles.bigBtnText}>Grant access</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }
    const verifying = phase === 'verifying';
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.scanHeader}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10} disabled={verifying}>
            <Ionicons name="close" size={26} color={verifying ? colors.textMuted : colors.text} />
          </TouchableOpacity>
          <Text style={styles.scanTitle} numberOfLines={1}>
            Find: <Text style={{ color: colors.green }}>{target}</Text>
          </Text>
          {isTimed ? (
            <View style={[styles.timerPill, secondsLeft <= 30 && { borderColor: colors.red, backgroundColor: colors.red + '22' }]}>
              <Ionicons name="timer-outline" size={12} color={secondsLeft <= 30 ? colors.red : colors.amber} />
              <Text style={[styles.timerPillText, secondsLeft <= 30 && { color: colors.red }]}>
                {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
              </Text>
            </View>
          ) : <View style={{ width: 60 }} />}
        </View>
        <View style={styles.cameraWrap}>
          <CameraView
            ref={camRef}
            style={styles.camera}
            facing="back"
            mute
          />
          {/* Static framing corners — no live scanner line any more
              (the user spec calls for no real-time AI activity here). */}
          <View pointerEvents="none" style={styles.scannerOverlay}>
            <View style={styles.scanCorners}>
              <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
            </View>
            {/* Verifying overlay sits ON TOP of the camera while the
                AI thinks. Camera stays mounted so we can immediately
                retake on rejection without a re-init. */}
            {verifying ? (
              <View style={styles.verifyDim}>
                <ActivityIndicator size="large" color={colors.green} />
                <Text style={styles.verifyText}>Checking your photo…</Text>
              </View>
            ) : null}
          </View>
        </View>
        <View style={styles.captureHint}>
          <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} />
          <Text style={styles.captureHintText} numberOfLines={2}>
            Frame the {target} clearly, then tap the button below.
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.takePhotoBtn, verifying && styles.takePhotoBtnBusy]}
          onPress={onTakePhoto}
          disabled={verifying}
          activeOpacity={0.85}
          testID="spot-take-photo"
        >
          {verifying ? (
            <>
              <ActivityIndicator color={colors.bg} />
              <Text style={styles.takePhotoBtnText}>Verifying…</Text>
            </>
          ) : (
            <>
              <Ionicons name="camera" size={22} color={colors.bg} />
              <Text style={styles.takePhotoBtnText}>Take Photo</Text>
            </>
          )}
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── Incorrect — show snap + "Try Again" ───────────────────────
  if (phase === 'incorrect') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.scanHeader}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="close" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.scanTitle} numberOfLines={1}>Verdict</Text>
          {isTimed ? (
            <View style={[styles.timerPill, secondsLeft <= 30 && { borderColor: colors.red, backgroundColor: colors.red + '22' }]}>
              <Ionicons name="timer-outline" size={12} color={secondsLeft <= 30 ? colors.red : colors.amber} />
              <Text style={[styles.timerPillText, secondsLeft <= 30 && { color: colors.red }]}>
                {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
              </Text>
            </View>
          ) : <View style={{ width: 60 }} />}
        </View>
        {photoBase64 ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${photoBase64}` }}
            style={styles.reviewImage}
            resizeMode="cover"
          />
        ) : null}
        <View style={styles.reviewBody}>
          <View style={styles.verdictRow}>
            <Ionicons name="close-circle" size={28} color={colors.red} />
            <Text style={styles.verdictTitleBad}>Incorrect object</Text>
          </View>
          {rejectReason ? (
            <Text style={styles.verdictSub} numberOfLines={3}>{rejectReason}</Text>
          ) : (
            <Text style={styles.verdictSub}>
              The AI didn&apos;t see a &quot;{target}&quot; in that photo.
            </Text>
          )}
          {isTimed && secondsLeft <= 0 ? (
            <Text style={[styles.verdictSub, { color: colors.red, marginTop: 4 }]}>
              Time&apos;s up — no points this round.
            </Text>
          ) : null}
          <TouchableOpacity
            style={[styles.takePhotoBtn, { marginTop: spacing.lg }]}
            onPress={onTryAgain}
            disabled={isTimed && secondsLeft <= 0}
            activeOpacity={0.85}
            testID="spot-try-again"
          >
            <Ionicons name="refresh" size={20} color={colors.bg} />
            <Text style={styles.takePhotoBtnText}>
              {isTimed && secondsLeft <= 0 ? 'Round over' : 'Try Again'}
            </Text>
          </TouchableOpacity>
          {isTimed ? (
            <Text style={styles.tryAgainHint}>
              {secondsLeft > 0 ? `${secondsLeft}s left — tap to head straight back to the camera.` : ''}
            </Text>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  // ── Correct — confirm + auto-back ─────────────────────────────
  if (phase === 'correct') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.scanHeader}>
          <View style={{ width: 26 }} />
          <Text style={styles.scanTitle} numberOfLines={1}>Verdict</Text>
          <View style={{ width: 60 }} />
        </View>
        {photoBase64 ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${photoBase64}` }}
            style={styles.reviewImage}
            resizeMode="cover"
          />
        ) : null}
        <View style={styles.reviewBody}>
          <View style={styles.verdictRow}>
            <Ionicons name="checkmark-circle" size={28} color={colors.green} />
            <Text style={styles.verdictTitleGood}>Found it!</Text>
          </View>
          <Text style={styles.verdictSub}>
            +1 Spot Point. Nice eye for a &quot;{target}&quot;.
          </Text>
          <TouchableOpacity
            style={[styles.takePhotoBtn, { marginTop: spacing.lg, backgroundColor: colors.green }]}
            onPress={() => router.back()}
            disabled={submitting}
            activeOpacity={0.85}
            testID="spot-correct-done"
          >
            {submitting ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <>
                <Ionicons name="checkmark" size={20} color={colors.bg} />
                <Text style={styles.takePhotoBtnText}>Done</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Timeout — round ended without a correct photo ─────────────
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.scanHeader}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="close" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.scanTitle} numberOfLines={1}>Time&apos;s up</Text>
        <View style={{ width: 60 }} />
      </View>
      <View style={styles.center}>
        <Ionicons name="timer" size={56} color={colors.red} />
        <Text style={[styles.verdictTitleBad, { marginTop: spacing.md }]}>Out of time</Text>
        <Text style={[styles.verdictSub, { textAlign: 'center', maxWidth: 280 }]}>
          No points this round — the AI never got a winning photo of a &quot;{target}&quot;.
        </Text>
        <TouchableOpacity
          style={[styles.bigBtn, { marginTop: spacing.lg, alignSelf: 'stretch' }]}
          onPress={() => router.back()}
        >
          <Text style={styles.bigBtnText}>Back to Spot</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: 8 },

  briefingHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
  },
  briefingBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg, gap: 8 },
  briefingIcon: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: colors.green + '12',
    borderWidth: 2, borderColor: colors.green + '88',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing.md,
  },
  briefingKicker: { color: colors.green, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  briefingTarget: { color: colors.text, fontSize: 22, fontWeight: '900', textAlign: 'center', marginTop: 6 },
  briefingObject: {
    color: colors.green, fontSize: 36, fontWeight: '900', textAlign: 'center',
    marginTop: 6, textTransform: 'capitalize', lineHeight: 42,
  },
  briefingHint: { color: colors.textSecondary, fontSize: 13, marginTop: 12, textAlign: 'center' },

  bigBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.green,
    paddingVertical: 16, paddingHorizontal: spacing.lg,
    marginHorizontal: spacing.lg, marginBottom: spacing.md,
    borderRadius: radii.pill,
  },
  bigBtnText: { color: colors.bg, fontWeight: '900', fontSize: 15, letterSpacing: 0.4 },

  timerPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: radii.pill,
    backgroundColor: colors.amber + '18', borderWidth: 1, borderColor: colors.amber + '88',
  },
  timerPillText: { color: colors.amber, fontWeight: '900', fontSize: 12, fontVariant: ['tabular-nums'] as any },

  briefingTimerLine: { alignItems: 'center', marginBottom: spacing.lg },
  briefingTimerText: { color: colors.textMuted, fontSize: 11 },

  scanHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    gap: 8,
  },
  scanTitle: { color: colors.text, fontWeight: '800', fontSize: 14, flex: 1, textTransform: 'capitalize' },

  cameraWrap: {
    width: '100%', aspectRatio: 1,
    backgroundColor: '#000',
    overflow: 'hidden',
    borderTopWidth: 1, borderBottomWidth: 1,
    borderColor: colors.green + '55',
  },
  camera: { width: '100%', height: '100%' },
  scannerOverlay: { ...StyleSheet.absoluteFillObject },
  scanCorners: { ...StyleSheet.absoluteFillObject, padding: 16 },
  corner: { position: 'absolute', width: 30, height: 30, borderColor: colors.green },
  cornerTL: { top: 16, left: 16, borderTopWidth: 3, borderLeftWidth: 3 },
  cornerTR: { top: 16, right: 16, borderTopWidth: 3, borderRightWidth: 3 },
  cornerBL: { bottom: 16, left: 16, borderBottomWidth: 3, borderLeftWidth: 3 },
  cornerBR: { bottom: 16, right: 16, borderBottomWidth: 3, borderRightWidth: 3 },

  verifyDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  verifyText: { color: '#fff', fontWeight: '800', fontSize: 14 },

  captureHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
  },
  captureHintText: { color: colors.textMuted, fontSize: 12, flex: 1 },

  takePhotoBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: colors.green,
    marginHorizontal: spacing.lg, marginBottom: spacing.lg,
    paddingVertical: 16,
    borderRadius: radii.pill,
    minHeight: 56,
  },
  takePhotoBtnBusy: { backgroundColor: colors.green + 'cc' },
  takePhotoBtnText: { color: colors.bg, fontWeight: '900', fontSize: 15, letterSpacing: 0.4 },

  reviewImage: {
    width: '100%', aspectRatio: 1,
    backgroundColor: '#000',
  },
  reviewBody: { flex: 1, padding: spacing.lg, gap: 8 },

  verdictRow: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center', marginTop: 6 },
  verdictTitleBad: { color: colors.red, fontWeight: '900', fontSize: 20 },
  verdictTitleGood: { color: colors.green, fontWeight: '900', fontSize: 20 },
  verdictSub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },

  tryAgainHint: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: spacing.sm },
});
