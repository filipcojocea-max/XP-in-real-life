/**
 * Spot the Object — Admin "Test & Train AI" mode.
 *
 * Creator-only training screen: the AI chooses an object, asks the
 * Creator to capture it from multiple angles (object-aware prompts —
 * "open the scissors", "now close them", etc.), and stores each
 * confirmed photo as a few-shot reference in the spot_training
 * collection. Those references are injected into every other player's
 * GPT-4o vision check, making the AI substantially more reliable at
 * recognising that object during normal gameplay.
 *
 * Flow:
 *   1. fetchSession() picks the next un-trained object (or a specific
 *      one chosen from the home screen)
 *   2. Camera view, progress bar across the top, current angle prompt
 *      underneath in small text
 *   3. Capture → AI verifies → if confirmed, sample saved + progress
 *      advances → next angle prompt
 *   4. Skip button: marks as skipped, picks the next un-trained one
 *      (skipped objects re-surface later)
 *   5. On is_complete: success screen with "Test Next Object" CTA
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, Platform } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, SpotTrainingSession, SpotTrainingCaptureResult } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

const GOLD = '#FFD700';

export default function SpotTrainScreen() {
  const params = useLocalSearchParams<{ object?: string }>();
  const [session, setSession] = useState<SpotTrainingSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [lastResult, setLastResult] = useState<SpotTrainingCaptureResult | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);

  const fetchSession = useCallback(async (objectName?: string) => {
    setBusy(true);
    setLastResult(null);
    try {
      const s = await api.adminSpotTrainingStart(objectName);
      setSession(s);
    } catch (e: any) {
      showAlert('Could not load training session', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    fetchSession(typeof params.object === 'string' ? params.object : undefined);
  }, [fetchSession, params.object]);

  useEffect(() => {
    if (!permission) return;
    if (!permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  async function captureAndSubmit() {
    if (!session || !cameraRef.current || capturing) return;
    setCapturing(true);
    setLastResult(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.7,
        skipProcessing: false,
      });
      if (!photo?.base64) {
        showAlert('Capture failed', 'No photo data returned.');
        return;
      }
      const result = await api.adminSpotTrainingCapture(
        session.object_name,
        session.next_angle || 'unknown',
        photo.base64
      );
      setLastResult(result);
      if (result.ok && !result.rejected) {
        // Refresh session to advance the progress bar + next prompt.
        if (result.is_complete) {
          // Stay on screen, show completion success card.
          setSession((prev) => prev && {
            ...prev,
            captured_count: result.captured_count ?? prev.captured_count,
            total_count: result.total_count ?? prev.total_count,
            next_angle: null,
          });
        } else {
          setSession((prev) => prev && {
            ...prev,
            captured_count: result.captured_count ?? (prev.captured_count + 1),
            total_count: result.total_count ?? prev.total_count,
            next_angle: result.next_angle ?? prev.next_angle,
          });
        }
      }
    } catch (e: any) {
      showAlert('Capture error', String(e?.message || e));
    } finally {
      setCapturing(false);
    }
  }

  async function skipObject() {
    if (!session) return;
    setBusy(true);
    try {
      await api.adminSpotTrainingSkip(session.object_name);
      await fetchSession();
    } catch (e: any) {
      showAlert('Could not skip', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function nextObject() {
    setLastResult(null);
    await fetchSession();
  }

  if (busy && !session) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.center, { flex: 1 }]}>
          <ActivityIndicator color={GOLD} size="large" />
          <Text style={styles.loadingText}>Loading next object…</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (!session) return null;

  const progressPct = session.total_count > 0
    ? Math.round((session.captured_count / session.total_count) * 100)
    : 0;
  const isComplete = !session.next_angle;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} testID="train-back">
          <Ionicons name="chevron-back" size={22} color={GOLD} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>TEST & TRAIN AI</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Progress bar across the top of the screen — gold gradient */}
      <View style={styles.progressOuter}>
        <View style={[styles.progressInner, { width: `${progressPct}%` }]} />
      </View>
      <Text style={styles.progressText}>
        {session.captured_count}/{session.total_count} angles · {progressPct}%
      </Text>

      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={styles.objectCard}>
          <Text style={styles.objectKicker}>FIND THIS OBJECT</Text>
          <Text style={styles.objectName} testID="train-object-name">{session.object_name}</Text>
          {!isComplete ? (
            <Text style={styles.angleLabel}>Show: <Text style={{ color: GOLD, fontWeight: '900' }}>{session.next_angle}</Text></Text>
          ) : null}
        </View>

        {!isComplete ? (
          <View style={styles.cameraWrap}>
            {permission?.granted ? (
              <CameraView
                ref={(r) => { cameraRef.current = r; }}
                style={styles.camera}
                facing="back"
              />
            ) : (
              <View style={[styles.camera, styles.center]}>
                <Ionicons name="camera-off" size={32} color={colors.textMuted} />
                <Text style={styles.permissionText}>Camera permission required</Text>
                <TouchableOpacity onPress={requestPermission} style={styles.permissionBtn}>
                  <Text style={styles.permissionBtnText}>Grant access</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ) : null}

        {lastResult?.rejected ? (
          <View style={[styles.toast, { borderColor: colors.red, backgroundColor: colors.red + '22' }]}>
            <Ionicons name="alert-circle" size={16} color={colors.red} />
            <Text style={[styles.toastText, { color: colors.red }]}>
              {lastResult.reason || "AI couldn't see the object — try again."}
            </Text>
          </View>
        ) : lastResult?.ok ? (
          <View style={[styles.toast, { borderColor: GOLD, backgroundColor: GOLD + '22' }]}>
            <Ionicons name="checkmark-circle" size={16} color={GOLD} />
            <Text style={[styles.toastText, { color: GOLD }]}>
              Saved! Confidence {Math.round((lastResult.confidence || 0) * 100)}%
            </Text>
          </View>
        ) : null}

        {!isComplete ? (
          <View style={styles.actionsRow}>
            <TouchableOpacity
              testID="train-skip"
              style={[styles.actionBtn, styles.actionSecondary]}
              onPress={skipObject}
              disabled={busy || capturing}
            >
              <Ionicons name="play-skip-forward" size={16} color={colors.textMuted} />
              <Text style={[styles.actionText, { color: colors.textMuted }]}>Skip this object for now</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="train-capture"
              style={[styles.actionBtn, styles.actionPrimary, capturing && { opacity: 0.6 }]}
              onPress={captureAndSubmit}
              disabled={capturing || !permission?.granted}
            >
              {capturing ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <>
                  <Ionicons name="checkmark" size={16} color={colors.bg} />
                  <Text style={[styles.actionText, { color: colors.bg }]}>This is correct object</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.completeCard}>
            <View style={styles.completeIcon}>
              <Ionicons name="trophy" size={36} color={GOLD} />
            </View>
            <Text style={styles.completeTitle}>Trained!</Text>
            <Text style={styles.completeText}>
              All angles for "{session.object_name}" captured. The AI is now sharper at recognising this object for everyone playing the game.
            </Text>
            <TouchableOpacity
              testID="train-next-object"
              style={[styles.actionBtn, styles.actionPrimary, { width: '100%' }]}
              onPress={nextObject}
            >
              <Ionicons name="arrow-forward" size={16} color={colors.bg} />
              <Text style={[styles.actionText, { color: colors.bg }]}>Test Next Object</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  loadingText: { color: colors.textMuted, fontSize: 13, marginTop: 12 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: GOLD + '33',
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: GOLD, fontWeight: '900', fontSize: 14, letterSpacing: 1.2, textAlign: 'center' },

  progressOuter: {
    height: 8, backgroundColor: colors.border,
    marginHorizontal: spacing.md, marginTop: spacing.md,
    borderRadius: 4, overflow: 'hidden',
  },
  progressInner: { height: '100%', backgroundColor: GOLD },
  progressText: {
    color: GOLD, fontSize: 11, fontWeight: '900',
    textAlign: 'center', marginTop: 6,
  },

  objectCard: {
    margin: spacing.md, padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg, borderWidth: 1, borderColor: GOLD + '88',
    alignItems: 'center',
  },
  objectKicker: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  objectName: { color: colors.text, fontSize: 26, fontWeight: '900', textTransform: 'capitalize', marginTop: 4 },
  angleLabel: { color: colors.textSecondary, fontSize: 13, marginTop: 8, textAlign: 'center' },

  cameraWrap: {
    marginHorizontal: spacing.md,
    aspectRatio: 1,
    borderRadius: radii.lg,
    overflow: 'hidden',
    borderWidth: 1, borderColor: GOLD + '55',
    backgroundColor: '#000',
  },
  camera: { flex: 1 },
  permissionText: { color: colors.textMuted, fontSize: 13 },
  permissionBtn: {
    marginTop: 8, paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: GOLD, borderRadius: radii.pill,
  },
  permissionBtnText: { color: colors.bg, fontWeight: '900' },

  toast: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    margin: spacing.md, padding: 10,
    borderRadius: radii.md, borderWidth: 1,
  },
  toastText: { fontSize: 12, fontWeight: '700', flex: 1 },

  actionsRow: { flexDirection: 'row', gap: 8, marginHorizontal: spacing.md, marginTop: spacing.md },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 12, borderRadius: radii.pill, borderWidth: 1,
  },
  actionSecondary: { backgroundColor: colors.surfaceGlass, borderColor: colors.border },
  actionPrimary: { backgroundColor: GOLD, borderColor: GOLD },
  actionText: { fontWeight: '900', fontSize: 13 },

  completeCard: {
    margin: spacing.md, padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radii.lg, borderWidth: 2, borderColor: GOLD,
    alignItems: 'center', gap: 8,
  },
  completeIcon: {
    width: 70, height: 70, borderRadius: 35,
    backgroundColor: GOLD + '22', borderWidth: 2, borderColor: GOLD,
    alignItems: 'center', justifyContent: 'center',
  },
  completeTitle: { color: GOLD, fontSize: 22, fontWeight: '900', letterSpacing: 0.8, marginTop: 4 },
  completeText: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 },
});
