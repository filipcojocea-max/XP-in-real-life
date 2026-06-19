/**
 * /treasure/group/[id]/hide — Re-Hide screen.
 *
 * Group rotation flow: after a member finds the chest the server flips
 * the group into "awaiting_hide" status and the previous finder lands
 * on THIS screen. They walk to a new public GREEN spot, snap a photo,
 * and submit — the backend's strict green-only Overpass check rejects
 * roads / buildings / yellow zones (HTTP 400).
 *
 * 2026-06-15 rewrite v2 — TRUE 1:1 mirror of the working solo.tsx
 * pattern after the spinning-map / 2-second-crash bug:
 *
 *   • The map ALWAYS mounts on first render (no `gps ? <Map/> : <Spinner/>`
 *     gate). A translucent overlay shows the spinner until the first GPS
 *     fix arrives, so the WebView gets exactly ONE mount + one tile-load
 *     pass. The previous version flipped `gps ? Map : Spinner` every GPS
 *     tick which kept remounting the WebView and prevented tiles ever
 *     finishing loading.
 *
 *   • `initialLat` / `initialLng` are captured ONCE from the first GPS
 *     fix and stored in a separate `initialCenter` state. Subsequent GPS
 *     ticks update the blue "you are here" dot via the ref's
 *     `setUserLocation()` only — no re-render of the map ever.
 *
 *   • Until the first fix is in, the map is centred on (0, 0) at zoom 2
 *     just so the WebView has SOMETHING to render. The overlay covers
 *     this initial frame so the user never sees the world map.
 *
 *   • `Stack.Screen headerShown: false` + an inline custom header so we
 *     don't fight expo-router's stack header (the old default header
 *     was the source of the ~2 s layout-thrash crash on Android).
 *
 *   • Camera lives inside `<Modal>` — the parent screen + map stay
 *     mounted underneath it.  EXACT same import set, exact same
 *     `takePictureAsync({ quality: 0.55, skipProcessing: true })` +
 *     `FileSystem.readAsStringAsync(uri, base64)` flow as solo.tsx.
 *
 *   • A tiny inline placeholder PNG is sent as `map_screenshot_base64`
 *     so the backend's required-field check passes. We do NOT call any
 *     WebView snapshot RPC — solo doesn't either, and the snapshot RPC
 *     was the original race that froze the screen.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system';
import { api } from '../../../../src/api';
import BTLeafletMap, { type BTLeafletMapHandle } from '../../../../src/components/BTLeafletMap';
import { colors, radii, spacing } from '../../../../src/theme';
import { showAlert } from '../../../../src/uiAlert';

// 1x1 transparent PNG (~70 B). The backend `/bt/groups/{gid}/hide`
// endpoint requires a non-empty `map_screenshot_base64`; this is the
// smallest valid value. Solo mode never sends a map snapshot at all,
// so we mimic its "no snapshot RPC" behaviour and just hand the server
// a placeholder. The chest's true location is determined by the GPS
// coords + photo, not this image.
const PLACEHOLDER_MAP =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkqAcAAIUAgUW0RjgAAAAASUVORK5CYII=';

export default function HideScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // Live GPS — updated by the watcher; pushed into the map via ref.
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  // FIRST fix only — used as `initialLat/Lng` for the map. Stable for
  // the lifetime of the screen so the BTLeafletMap WebView never
  // remounts.
  const [initialCenter, setInitialCenter] = useState<{ lat: number; lng: number } | null>(null);

  const [perm] = useCameraPermissions();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const cameraRef = useRef<any>(null);
  const mapRef = useRef<BTLeafletMapHandle | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  // ─── GPS watcher (IDENTICAL to solo.tsx) ─────────────────────────
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
        showAlert('Location needed', 'Allow Location so we can save the new hiding spot.');
        return;
      }
      try {
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 2, timeInterval: 1500 },
          (pos) => {
            if (cancelled) return;
            const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            setGps(next);
            // Lock the map's initial centre on the FIRST fix only.
            // Subsequent ticks just update the live dot through the
            // ref — they do NOT cause a re-render of the WebView.
            setInitialCenter((prev) => prev || next);
          },
        );
        watchRef.current = sub;
      } catch (e: any) {
        showAlert('GPS error', String(e?.message || e));
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
      try { watchRef.current?.remove(); } catch {}
    };
  }, []);

  // Pipe every GPS tick into the embedded mini-map so the user sees
  // their live "you are here" dot while standing on the spot. Mirrors
  // solo.tsx exactly — only the ref's setUserLocation runs, never a
  // prop change.
  useEffect(() => {
    if (!gps) return;
    try { mapRef.current?.setUserLocation(gps.lat, gps.lng); } catch {}
  }, [gps]);

  // ─── Camera open flow (IDENTICAL to solo.tsx openCamera) ─────────
  const openCamera = useCallback(async () => {
    if (!gps) {
      showAlert('No GPS yet', 'Waiting for your location — try again in a moment.');
      return;
    }
    let granted = perm?.granted ?? false;
    if (!granted) {
      const r = await (await import('expo-camera')).Camera.requestCameraPermissionsAsync();
      granted = r.status === 'granted';
    }
    if (!granted) {
      showAlert('Camera blocked', 'Allow Camera so you can photograph the spot.');
      return;
    }
    setCameraOpen(true);
  }, [gps, perm]);

  // ─── Snap + submit (IDENTICAL to solo.tsx snapAndSubmit) ─────────
  const snapAndSubmit = useCallback(async () => {
    if (!cameraRef.current || !gps || submitting) return;
    setSubmitting(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.55,
        skipProcessing: true,
      });
      const uri: string = photo?.uri;
      if (!uri) throw new Error('Camera returned no photo.');
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: 'base64',
      });
      await api.btGroupHide(String(id), {
        lat: gps.lat,
        lng: gps.lng,
        photo_base64: b64,
        map_screenshot_base64: PLACEHOLDER_MAP,
      });
      setCameraOpen(false);
      showAlert('Hidden!', 'Fresh chest is live for the next finder. Your turn is over.');
      router.replace(`/treasure/group/${id}`);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/green|public/i.test(msg)) {
        showAlert(
          'Not a green spot',
          "That spot isn't on a park, oval, garden or reserve. Move onto green public land and try again.",
        );
      } else {
        showAlert('Could not hide', msg);
      }
    } finally {
      setSubmitting(false);
    }
  }, [gps, id, router, submitting]);

  // ─── Render ──────────────────────────────────────────────────────
  // The map MUST mount on first render or the WebView's tile loader
  // never starts. We always pass coordinates — either the first GPS
  // fix or (0,0) at zoom 2 — so BTLeafletMap initialises cleanly
  // exactly once. A translucent overlay hides the world-map frame
  // until the real fix lands.
  const mapLat = initialCenter?.lat ?? 0;
  const mapLng = initialCenter?.lng ?? 0;
  const mapZoom = initialCenter ? 17 : 2;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Custom header — matches solo.tsx so the layout doesn't fight
          expo-router's default stack header (which used to thrash on
          Android and trigger the 2-second crash). */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.headerBtn}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Hide the chest</Text>
        <View style={styles.headerBtn} />
      </View>

      <View style={styles.body}>
        <Text style={styles.title}>Bury the chest at this exact spot</Text>
        <Text style={styles.hint}>
          Stand on PUBLIC GREEN land only — park, oval, beach, garden, reserve.
          Roads, footpaths, driveways and private yards will be rejected.
          Snap a photo when you&apos;re ready.
        </Text>

        <View style={styles.mapWrap}>
          {/* ALWAYS render the map — the overlay below hides the
              world-map frame until the GPS fix arrives. */}
          <BTLeafletMap
            ref={mapRef}
            mode="static"
            initialLat={mapLat}
            initialLng={mapLng}
            initialZoom={mapZoom}
            initialRadius={0}
            ringColor="#FFD166"
            markerColor="#FF3B30"
            markerShape="x"
            interactive={false}
            onReady={() => {
              // Drop the live user dot the moment the WebView is ready,
              // exactly like solo.tsx does in its expanded modal.
              if (gps) {
                try { mapRef.current?.setUserLocation(gps.lat, gps.lng); } catch {}
              }
            }}
            style={StyleSheet.absoluteFill}
          />
          {!initialCenter ? (
            <View style={styles.mapOverlay} pointerEvents="none">
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.hint}>Locking GPS…</Text>
            </View>
          ) : null}
        </View>

        <TouchableOpacity
          style={[styles.cta, (!gps || submitting) && styles.ctaDisabled]}
          onPress={openCamera}
          disabled={!gps || submitting}
          activeOpacity={0.85}
          testID="bt-hide-open-cam"
        >
          <Ionicons name="camera" size={20} color="#0b0f15" />
          <Text style={styles.ctaText}>TAKE PHOTO &amp; HIDE</Text>
        </TouchableOpacity>
      </View>

      {/* Camera inside Modal — parent screen + map STAY MOUNTED. */}
      <Modal
        visible={cameraOpen}
        animationType="slide"
        onRequestClose={() => setCameraOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView ref={cameraRef as any} style={{ flex: 1 }} facing="back" />
          <View style={styles.camControls}>
            <TouchableOpacity
              onPress={() => setCameraOpen(false)}
              style={styles.camCancel}
              disabled={submitting}
            >
              <Text style={{ color: '#fff', fontWeight: '800' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={snapAndSubmit}
              disabled={submitting}
              style={[styles.camShoot, submitting && { opacity: 0.5 }]}
            >
              {submitting ? (
                <ActivityIndicator color="#0b0f15" />
              ) : (
                <Ionicons name="camera" size={32} color="#0b0f15" />
              )}
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

  // Custom header — copy of solo.tsx so we don't fight expo-router's
  // default Stack header (the source of the 2-second crash).
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderColor: '#1A1A24',
    backgroundColor: colors.surface,
  },
  headerBtn: { width: 40, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
    flex: 1,
    textAlign: 'center',
  },

  body: { flex: 1, padding: spacing.md, gap: spacing.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  hint: { color: '#8C92A6', fontSize: 13, lineHeight: 18 },
  mapWrap: {
    flex: 1,
    minHeight: 240,
    borderRadius: radii.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#1A1A24',
    backgroundColor: '#0F1218',
  },
  mapOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0F1218',
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FFD166',
    paddingVertical: 16,
    borderRadius: radii.md,
  },
  ctaDisabled: { backgroundColor: '#3A3A44' },
  ctaText: {
    color: '#0b0f15',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.5,
  },

  // Camera controls — bit-for-bit copy of solo.tsx's modal styles.
  camControls: {
    position: 'absolute',
    bottom: 30,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
  },
  camCancel: { width: 80, paddingVertical: 10 },
  camShoot: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: '#22C55E',
  },
});
