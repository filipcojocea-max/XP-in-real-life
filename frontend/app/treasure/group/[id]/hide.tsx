/**
 * /treasure/group/[id]/hide — Re-Hide screen.
 *
 * Reached automatically after a player finds the chest (group page
 * auto-routes here once /find returns awaiting_hide status). The finder
 * must bury the chest in a NEW public GREEN spot: take a fresh photo at
 * the intended location, a tiny placeholder map image is sent inline
 * (the backend just needs a valid value), and both are POSTed to
 * /api/bt/groups/{gid}/hide. The backend's strict green-only Overpass
 * check rejects roads / buildings / yellow zones; on success the
 * rotation advances and the next finder is selected.
 *
 * 2026-06-15: rewritten to mirror solo.tsx EXACTLY — same GPS watcher,
 * `useCameraPermissions` hook, dynamic Camera permission import, and a
 * `<Modal>`-hosted camera (the underlying screen + map STAYS MOUNTED).
 * The previous "swap whole view" version unmounted the WebView map and
 * crashed ~2 s after opening the camera.
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

// Tiny transparent 1×1 PNG (~70 B). The backend requires a non-empty
// `map_screenshot_base64`; this is the smallest valid value. The map is
// still drawn for the user to visually confirm the spot — we just don't
// rely on WebView snapshotting which used to deadlock on Android.
const PLACEHOLDER_MAP =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkqAcAAIUAgUW0RjgAAAAASUVORK5CYII=';

export default function HideScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [perm] = useCameraPermissions();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const cameraRef = useRef<any>(null);
  const mapRef = useRef<BTLeafletMapHandle | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  // ─── GPS watcher (same shape as solo.tsx) ────────────────────────
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
            setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
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

  // Pipe every GPS tick into the embedded mini-map so the player sees
  // their live "you are here" dot while standing on the spot.
  useEffect(() => {
    if (!gps) return;
    try { mapRef.current?.setUserLocation(gps.lat, gps.lng); } catch {}
  }, [gps]);

  // ─── Camera open flow ────────────────────────────────────────────
  const openCamera = useCallback(async () => {
    if (!gps) {
      showAlert('No GPS yet', 'Waiting for your location — try again in a moment.');
      return;
    }
    let granted = perm?.granted ?? false;
    if (!granted) {
      // expo-camera 17: dynamic permission request matches solo.tsx.
      const r = await (await import('expo-camera')).Camera.requestCameraPermissionsAsync();
      granted = r.status === 'granted';
    }
    if (!granted) {
      showAlert('Camera blocked', 'Allow Camera so you can photograph the spot.');
      return;
    }
    setCameraOpen(true);
  }, [gps, perm]);

  // ─── Snap + submit ───────────────────────────────────────────────
  const snapAndSubmit = useCallback(async () => {
    if (!gps || !cameraRef.current || submitting) return;
    setSubmitting(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.55,
        skipProcessing: true,
      });
      const uri: string = photo?.uri;
      if (!uri) throw new Error('Camera returned no photo.');
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      await api.btGroupHide(String(id), {
        lat: gps.lat,
        lng: gps.lng,
        photo_base64: b64,
        // Send a tiny placeholder — backend just needs a non-empty value.
        // (WebView snapshotting was the source of the ~2 s crash.)
        map_screenshot_base64: PLACEHOLDER_MAP,
      });
      setCameraOpen(false);
      showAlert('Hidden!', 'Fresh chest is live for the next finder. Your turn is over.');
      router.replace(`/treasure/group/${id}`);
    } catch (e: any) {
      const msg = String(e?.message || e);
      // Surface server-side green-only rejection as a friendly hint.
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
  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <Stack.Screen
        options={{
          title: 'Hide the chest',
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
        }}
      />
      <View style={styles.body}>
        <Text style={styles.title}>Bury the chest at this exact spot</Text>
        <Text style={styles.hint}>
          Stand on PUBLIC GREEN land only — park, oval, beach, garden, reserve.
          Roads, footpaths, driveways and private yards will be rejected.
          Snap a photo when you&apos;re ready.
        </Text>
        <View style={styles.mapWrap}>
          {gps ? (
            <BTLeafletMap
              ref={mapRef}
              mode="static"
              initialLat={gps.lat}
              initialLng={gps.lng}
              initialZoom={17}
              initialRadius={30}
              ringColor="#FFD166"
              markerColor="#FF3B30"
              markerShape="x"
              interactive={false}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <View style={styles.mapPlaceholder}>
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.hint}>Locking GPS…</Text>
            </View>
          )}
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

      {/* Camera lives inside a Modal — keeps the parent screen + map
          MOUNTED behind it, exactly like solo.tsx. */}
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
  mapPlaceholder: {
    flex: 1,
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
