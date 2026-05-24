import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { api } from '../../src/api';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';

type Phase = 'briefing' | 'scanning' | 'reviewing';

export default function SpotPlay() {
  const params = useLocalSearchParams<{ mode?: string; object?: string }>();
  const mode = (params.mode as 'solo_constant' | 'solo_random') || 'solo_constant';
  const isTimed = mode !== 'solo_constant';

  const [target, setTarget] = useState<string>(typeof params.object === 'string' ? params.object : '');
  const [phase, setPhase] = useState<Phase>('briefing');
  const [permission, requestPermission] = useCameraPermissions();
  const [secondsLeft, setSecondsLeft] = useState(isTimed ? 120 : 0);
  const [canCapture, setCanCapture] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [reason, setReason] = useState<string>('');
  const [confidence, setConfidence] = useState<number>(0);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const camRef = useRef<CameraView | null>(null);
  const scanY = useRef(new Animated.Value(0)).current;
  const checkBusy = useRef(false);

  // Fetch a new object on mount (if not provided via param)
  useEffect(() => {
    if (target) return;
    api.spotGetObject().then((r) => setTarget(r.object)).catch((e) => {
      showAlert('Could not start', String(e?.message || e));
    });
  }, []);

  // Timer (only in timed modes)
  useEffect(() => {
    if (phase !== 'scanning' || !isTimed) return;
    if (secondsLeft <= 0) {
      autoCapture();
      return;
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, secondsLeft, isTimed]);

  // Scanner line animation
  useEffect(() => {
    if (phase !== 'scanning') return;
    Animated.loop(
      Animated.sequence([
        Animated.timing(scanY, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(scanY, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
  }, [phase, scanY]);

  // Periodic frame check (every 2.5s while scanning)
  useEffect(() => {
    if (phase !== 'scanning' || !target) return;
    const interval = setInterval(() => {
      runFrameCheck();
    }, 2500);
    return () => clearInterval(interval);
  }, [phase, target]);

  const runFrameCheck = useCallback(async () => {
    if (!camRef.current || checkBusy.current) return;
    checkBusy.current = true;
    setAnalyzing(true);
    try {
      const pic = await camRef.current.takePictureAsync({
        base64: true,
        quality: 0.4,
        skipProcessing: true,
      });
      const b64 = pic?.base64;
      if (!b64) return;
      const r = await api.spotCheck(target, b64);
      setCanCapture(!!r.can_capture);
      setConfidence(r.confidence || 0);
      setReason(r.reason || '');
    } catch (e: any) {
      // Soft fail — keep shutter locked
      setCanCapture(false);
    } finally {
      setAnalyzing(false);
      checkBusy.current = false;
    }
  }, [target]);

  const startScanning = async () => {
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
    setCanCapture(false);
    setReason('');
    setPhotoBase64(null);
    setPhase('scanning');
  };

  const capture = async () => {
    if (!camRef.current || !canCapture) return;
    try {
      const pic = await camRef.current.takePictureAsync({
        base64: true,
        quality: 0.7,
      });
      if (pic?.base64) {
        setPhotoBase64(pic.base64);
        setPhase('reviewing');
      }
    } catch (e: any) {
      showAlert('Capture failed', String(e?.message || e));
    }
  };

  const autoCapture = async () => {
    if (!camRef.current) return;
    try {
      const pic = await camRef.current.takePictureAsync({ base64: true, quality: 0.7 });
      if (pic?.base64) {
        setPhotoBase64(pic.base64);
        setPhase('reviewing');
      }
    } catch {}
  };

  const onSubmit = async (success: boolean) => {
    if (!photoBase64) return;
    setSubmitting(true);
    try {
      const r = await api.spotComplete({
        target_object: target,
        photo_base64: photoBase64,
        success,
        remaining_seconds: isTimed ? Math.max(0, secondsLeft) : 0,
        mode,
      });
      showAlert(
        success ? 'Found the object! 🎯' : "Didn't find the object",
        success ? `+${r.points_delta} Spot Point. Total: ${r.spot_points}` : 'No points awarded.',
      );
      router.back();
    } catch (e: any) {
      showAlert('Could not save', String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  const onTryAgain = async () => {
    setPhotoBase64(null);
    setCanCapture(false);
    setReason('');
    if (mode === 'solo_constant') {
      // Solo constant mode pulls a NEW random object on every retry —
      // show the briefing screen so the user knows what to chase.
      const r = await api.spotGetObject();
      setTarget(r.object);
      setPhase('briefing');
      return;
    }
    // Same target → skip briefing and jump STRAIGHT back into the
    // live camera for an instant second attempt. No loading screen,
    // no extra tap.
    setPhase('scanning');
  };

  // ───────── Briefing screen ─────────
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
            {target ? target : '...'}
          </Text>
          {isTimed ? (
            <Text style={styles.briefingHint}>You have 2 minutes. Go!</Text>
          ) : (
            <Text style={styles.briefingHint}>No timer in solo practice — take your time.</Text>
          )}
        </View>
        <TouchableOpacity
          style={[styles.bigBtn, !target && { opacity: 0.5 }]}
          onPress={startScanning}
          disabled={!target}
          testID="spot-start-scan"
        >
          <Ionicons name="camera" size={20} color={colors.bg} />
          <Text style={styles.bigBtnText}>Take a Photo of {target ? `"${target}"` : '...'}</Text>
        </TouchableOpacity>
        {isTimed ? (
          <View style={styles.briefingTimerLine}>
            <Text style={styles.briefingTimerText}>Timer starts when camera opens</Text>
          </View>
        ) : null}
      </SafeAreaView>
    );
  }

  // ───────── Scanning screen ─────────
  if (phase === 'scanning') {
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
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.scanHeader}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="close" size={26} color={colors.text} />
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
          {/* Green scanner line */}
          <View pointerEvents="none" style={styles.scannerOverlay}>
            <Animated.View
              style={[
                styles.scanLine,
                {
                  transform: [
                    { translateY: scanY.interpolate({ inputRange: [0, 1], outputRange: [0, 320] }) },
                  ],
                },
              ]}
            />
            <View style={styles.scanCorners}>
              <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
            </View>
          </View>
        </View>
        <View style={styles.statusBar}>
          {analyzing ? (
            <ActivityIndicator size="small" color={colors.cyan} />
          ) : canCapture ? (
            <Ionicons name="checkmark-circle" size={16} color={colors.green} />
          ) : (
            <Ionicons name="search" size={16} color={colors.textMuted} />
          )}
          <Text style={[styles.statusText, canCapture && { color: colors.green }]} numberOfLines={1}>
            {analyzing
              ? 'Scanning…'
              : canCapture
                ? `Got it! Confidence ${Math.round(confidence * 100)}% — tap to snap`
                : reason || 'Move closer or center the object in the frame'}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.shutter, !canCapture && styles.shutterLocked]}
          onPress={capture}
          disabled={!canCapture}
          testID="spot-shutter"
        >
          {!canCapture ? (
            <Ionicons name="lock-closed" size={26} color={colors.textMuted} />
          ) : (
            <View style={styles.shutterInner} />
          )}
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ───────── Reviewing screen ─────────
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.scanHeader}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="close" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.scanTitle} numberOfLines={1}>Review</Text>
        <View style={{ width: 26 }} />
      </View>
      {photoBase64 ? (
        <Image
          source={{ uri: `data:image/jpeg;base64,${photoBase64}` }}
          style={styles.reviewImage}
          resizeMode="cover"
        />
      ) : null}
      <View style={styles.reviewBody}>
        <Text style={styles.reviewQ}>Did you find a "{target}"?</Text>
        <Text style={styles.reviewSub}>Save your spot — friends can like and comment.</Text>
        <View style={styles.reviewBtns}>
          <TouchableOpacity
            style={[styles.reviewBtn, { backgroundColor: colors.red + '22', borderColor: colors.red }]}
            onPress={() => onSubmit(false)}
            disabled={submitting}
          >
            <Ionicons name="close-circle" size={18} color={colors.red} />
            <Text style={[styles.reviewBtnTxt, { color: colors.red }]}>Didn't find it</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.reviewBtn, { backgroundColor: colors.green + '22', borderColor: colors.green }]}
            onPress={() => onSubmit(true)}
            disabled={submitting}
          >
            <Ionicons name="checkmark-circle" size={18} color={colors.green} />
            <Text style={[styles.reviewBtnTxt, { color: colors.green }]}>Found it (+1)</Text>
          </TouchableOpacity>
        </View>
        {isTimed && secondsLeft > 0 ? (
          <TouchableOpacity onPress={() => setPhase('scanning')} style={styles.retakeBtn}>
            <Ionicons name="refresh" size={14} color={colors.cyan} />
            <Text style={styles.retakeText}>Retake — {secondsLeft}s left</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={onTryAgain} style={styles.retakeBtn}>
            <Ionicons name="refresh" size={14} color={colors.cyan} />
            <Text style={styles.retakeText}>Try a different object</Text>
          </TouchableOpacity>
        )}
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
  scannerOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'flex-start' },
  scanLine: {
    width: '100%',
    height: 3,
    backgroundColor: colors.green,
    opacity: 0.85,
    elevation: 8,
  },
  scanCorners: { ...StyleSheet.absoluteFillObject, padding: 16 },
  corner: { position: 'absolute', width: 30, height: 30, borderColor: colors.green },
  cornerTL: { top: 16, left: 16, borderTopWidth: 3, borderLeftWidth: 3 },
  cornerTR: { top: 16, right: 16, borderTopWidth: 3, borderRightWidth: 3 },
  cornerBL: { bottom: 16, left: 16, borderBottomWidth: 3, borderLeftWidth: 3 },
  cornerBR: { bottom: 16, right: 16, borderBottomWidth: 3, borderRightWidth: 3 },

  statusBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
  },
  statusText: { color: colors.textSecondary, fontSize: 12, flex: 1 },

  shutter: {
    width: 78, height: 78, borderRadius: 39,
    alignSelf: 'center', marginBottom: spacing.lg,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.green + '22',
    borderWidth: 4, borderColor: colors.green,
  },
  shutterLocked: {
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
  },
  shutterInner: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.green,
  },

  reviewImage: {
    width: '100%', aspectRatio: 1,
    backgroundColor: '#000',
  },
  reviewBody: { flex: 1, padding: spacing.lg, gap: 8 },
  reviewQ: { color: colors.text, fontWeight: '900', fontSize: 18, textAlign: 'center', textTransform: 'capitalize' },
  reviewSub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
  reviewBtns: { flexDirection: 'row', gap: 10, marginTop: spacing.md },
  reviewBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: radii.pill, borderWidth: 1,
  },
  reviewBtnTxt: { fontWeight: '900', fontSize: 13, letterSpacing: 0.4 },
  retakeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: spacing.md,
  },
  retakeText: { color: colors.cyan, fontWeight: '700', fontSize: 13 },
});
