/**
 * /treasure/solo — Solo hunting screen.
 *
 * Top-of-screen:    nothing (solo mode has no burier-photo / map-screenshot)
 * Middle:           big compass arrow pointing toward the chest +
 *                   distance read-out + heading
 * Bottom:           VIEW CAMERA → take photo. When inside 15 m, a tap
 *                   submits the find, awards 100 XP and the server
 *                   auto-assigns the next chest in the same area.
 *
 * Also exposes a PAST FINDS button at the top right that opens the
 * gallery (/treasure/solo-finds).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Magnetometer } from 'expo-sensors';
import * as FileSystem from 'expo-file-system';
import { api, type BTCompassReading } from '../../src/api';
import { colors, radii, spacing } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

export default function SoloHunt() {
  const router = useRouter();
  const [gps, setGPS] = useState<{ lat: number; lng: number } | null>(null);
  const [compass, setCompass] = useState<BTCompassReading | null>(null);
  const [heading, setHeading] = useState(0);  // device facing (deg true-north)
  const [perm] = useCameraPermissions();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const magSubRef = useRef<{ remove: () => void } | null>(null);
  const cameraRef = useRef<any>(null);

  // ─── GPS watcher ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cur = await Location.getForegroundPermissionsAsync();
      let granted = cur.status === 'granted';
      if (!granted && cur.canAskAgain) {
        const r = await Location.requestForegroundPermissionsAsync();
        granted = r.status === 'granted';
      }
      if (!granted) {
        showAlert('Location needed', 'Allow Location to hunt the chest.');
        return;
      }
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 2, timeInterval: 1500 },
        (pos) => {
          if (cancelled) return;
          setGPS({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
      );
      watchRef.current = sub;
    })().catch(() => {});
    return () => {
      cancelled = true;
      try { watchRef.current?.remove(); } catch {}
    };
  }, []);

  // ─── Magnetometer (device heading) ──────────────────────────────
  // 2026-06-02 — wrapped in availability + try/catch. On some Android
  // devices the `_nativeModule.addListener` symbol is missing (no
  // magnetometer hardware, sensor blocked by OEM power policy, or the
  // expo-sensors native module wasn't bridged in time). Without this
  // guard the entire Solo screen crashes on mount with
  // "this._nativeModule.addListener is not a function" before the user
  // can even see the compass. Compass rotation is purely a
  // nice-to-have — the chest-find logic only needs GPS — so we degrade
  // silently if sensors aren't available.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const available = await Magnetometer.isAvailableAsync();
        if (!available || cancelled) return;
        try {
          Magnetometer.setUpdateInterval(120);
        } catch { /* setUpdateInterval can throw on Android 14 when the
                     sensor service is rate-limited — non-fatal. */ }
        let sub: { remove: () => void } | null = null;
        try {
          sub = Magnetometer.addListener(({ x, y }) => {
            // atan2 gives -π..π; convert to compass deg 0..360 (0 = north)
            let deg = Math.atan2(y, x) * (180 / Math.PI);
            deg = (deg + 360 + 90) % 360;
            setHeading(deg);
          });
        } catch (inner) {
          // Some Android builds raise from inside addListener itself
          // ("_nativeModule.addListener is not a function"); swallow so
          // the screen mounts and the user can still hunt via GPS.
          // eslint-disable-next-line no-console
          console.warn('[solo] Magnetometer.addListener failed:', (inner as any)?.message || inner);
        }
        if (sub) magSubRef.current = sub;
      } catch (e) {
        // Final safety net — DO NOT propagate. Heading stays at 0 and
        // the compass arrow just points north until the user moves.
        // eslint-disable-next-line no-console
        console.warn('[solo] Magnetometer unavailable:', (e as any)?.message || e);
      }
    })();
    return () => {
      cancelled = true;
      try { magSubRef.current?.remove(); } catch {}
    };
  }, []);

  // ─── Server compass (bearing + distance to chest) ───────────────
  const fetchCompass = useCallback(async () => {
    if (!gps) return;
    try {
      const r = await api.btSoloCompass(gps.lat, gps.lng);
      setCompass(r);
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (msg.includes('404') || /no active solo/i.test(msg)) {
        // No active hunt — kick back to entry.
        router.replace('/treasure');
        return;
      }
      // else silent — we'll retry next tick
    } finally {
      setLoading(false);
    }
  }, [gps, router]);

  useEffect(() => {
    fetchCompass();
    const id = setInterval(fetchCompass, 2000);
    return () => clearInterval(id);
  }, [fetchCompass]);

  useFocusEffect(
    useCallback(() => {
      fetchCompass();
    }, [fetchCompass]),
  );

  // ─── Camera find flow ──────────────────────────────────────────
  const openCamera = useCallback(async () => {
    if (!compass) return;
    if (!compass.in_find_ring) {
      showAlert(
        'Get closer',
        `You're ${Math.round(compass.distance_m)} m away — get within ${compass.find_ring_m} m to claim the find.`,
      );
      return;
    }
    let granted = perm?.granted ?? false;
    if (!granted) {
      const r = await (await import('expo-camera')).Camera.requestCameraPermissionsAsync();
      granted = r.status === 'granted';
    }
    if (!granted) {
      showAlert('Camera blocked', 'Allow Camera so we can confirm the find.');
      return;
    }
    setCameraOpen(true);
  }, [compass, perm]);

  const snapAndSubmit = useCallback(async () => {
    if (!cameraRef.current || !gps || submitting) return;
    setSubmitting(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.55, skipProcessing: true });
      const uri: string = photo?.uri;
      if (!uri) throw new Error('Camera returned no photo.');
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const res = await api.btSoloFind(gps.lat, gps.lng, b64);
      setCameraOpen(false);
      showAlert(
        '+100 XP — chest found!',
        `New total: ${res.new_total_xp.toLocaleString()} XP. A new chest has been placed inside your area — keep hunting!`,
      );
      // Refresh compass so the bearing/distance update to the next chest.
      await fetchCompass();
    } catch (e: any) {
      showAlert('Could not claim find', String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  }, [gps, submitting, fetchCompass]);

  // ─── Render ────────────────────────────────────────────────────
  // Arrow rotation = compass bearing to chest MINUS current heading,
  // so the arrow always points at the real-world chest no matter which
  // way the phone is facing.
  const arrowRot = compass ? (compass.bearing_deg - heading + 360) % 360 : 0;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace('/treasure')} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Find the Treasure Chest</Text>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => router.push('/treasure/solo-finds')}
          testID="bt-past-finds"
        >
          <Ionicons name="file-tray-full-outline" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.cyan} />
          <Text style={styles.loadingText}>Locking onto the chest…</Text>
        </View>
      ) : !compass ? (
        <View style={styles.center}>
          <Ionicons name="location-outline" size={32} color={colors.amber} />
          <Text style={styles.loadingText}>Waiting for GPS signal…</Text>
        </View>
      ) : (
        <View style={styles.body}>
          {/* COMPASS */}
          <View style={styles.compassWrap}>
            <View style={styles.compassFace}>
              {['N', 'E', 'S', 'W'].map((dir, idx) => (
                <Text
                  key={dir}
                  style={[styles.cardinal, {
                    transform: [{ rotate: `${idx * 90}deg` }, { translateY: -110 }],
                  }]}
                >
                  {dir}
                </Text>
              ))}
              <View
                style={[
                  styles.arrow,
                  { transform: [{ rotate: `${arrowRot}deg` }] },
                ]}
              >
                <Ionicons name="navigate" size={120} color={compass.in_find_ring ? '#22C55E' : colors.cyan} />
              </View>
            </View>
            <Text style={[
              styles.distance,
              compass.in_find_ring && { color: '#22C55E' },
            ]}>
              {compass.distance_m < 1 ? 'Right here!' : `${Math.round(compass.distance_m)} m away`}
            </Text>
            <Text style={styles.heading}>
              Heading {Math.round(compass.bearing_deg)}° · You're facing {Math.round(heading)}°
            </Text>
            {compass.in_find_ring ? (
              <Text style={styles.ringHit}>📍 You're inside the {compass.find_ring_m} m find ring — open the camera!</Text>
            ) : null}
          </View>

          {/* CAMERA BUTTON */}
          <TouchableOpacity
            style={[
              styles.cameraBtn,
              compass.in_find_ring
                ? { backgroundColor: '#22C55E' }
                : { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
            ]}
            activeOpacity={0.85}
            onPress={openCamera}
            testID="bt-open-camera"
          >
            <Ionicons
              name="camera"
              size={26}
              color={compass.in_find_ring ? '#0b0f15' : colors.cyan}
            />
            <Text
              style={[
                styles.cameraBtnText,
                { color: compass.in_find_ring ? '#0b0f15' : colors.text },
              ]}
            >
              {compass.in_find_ring ? 'VIEW CAMERA / CONFIRM FIND' : 'VIEW CAMERA / TAKE PHOTO'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <Modal visible={cameraOpen} animationType="slide" onRequestClose={() => setCameraOpen(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView ref={cameraRef as any} style={{ flex: 1 }} facing="back" />
          <View style={styles.camControls}>
            <TouchableOpacity onPress={() => setCameraOpen(false)} style={styles.camCancel}>
              <Text style={{ color: '#fff', fontWeight: '800' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={snapAndSubmit}
              disabled={submitting}
              style={[styles.camShoot, submitting && { opacity: 0.5 }]}
            >
              {submitting ? <ActivityIndicator color="#0b0f15" /> : <Ionicons name="camera" size={32} color="#0b0f15" />}
            </TouchableOpacity>
            <View style={{ width: 80 }} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.sm, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerBtn: { width: 40, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1, textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: colors.textSecondary, fontSize: 13 },
  body: { flex: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.lg, justifyContent: 'space-between' },
  compassWrap: { alignItems: 'center', gap: 8 },
  compassFace: {
    width: 280, height: 280, borderRadius: 140,
    borderWidth: 2, borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  cardinal: {
    position: 'absolute',
    color: colors.textMuted, fontWeight: '900', fontSize: 14,
  },
  arrow: { alignItems: 'center', justifyContent: 'center' },
  distance: { color: colors.cyan, fontSize: 28, fontWeight: '900', marginTop: 12 },
  heading: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  ringHit: { color: '#22C55E', fontWeight: '800', marginTop: 6, textAlign: 'center', fontSize: 12 },
  cameraBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, paddingVertical: 16, borderRadius: radii.lg,
  },
  cameraBtnText: { fontWeight: '900', fontSize: 14, letterSpacing: 0.7 },
  camControls: {
    position: 'absolute', bottom: 30, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 24,
  },
  camCancel: { width: 80, paddingVertical: 10 },
  camShoot: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 4, borderColor: '#22C55E',
  },
});
