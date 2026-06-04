/**
 * /treasure/group/[id]/hide — Re-Hide screen.
 *
 * Reached automatically after a player finds the chest (group page
 * auto-routes here once /find returns awaiting_hide status). The finder
 * must bury the chest in a NEW public spot: take a fresh photo at the
 * intended location, the Leaflet map snapshot is captured behind the
 * scenes, and both are POSTed to /api/bt/groups/{gid}/hide. The
 * backend's block-aware + Overpass picker rejects bad spots; on
 * success the rotation advances and the next finder is selected.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { CameraView } from 'expo-camera';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system';
import { api } from '../../../../src/api';
import BTLeafletMap, { type BTLeafletMapHandle } from '../../../../src/components/BTLeafletMap';
import { colors, radii, spacing } from '../../../../src/theme';
import { showAlert } from '../../../../src/uiAlert';

const PLACEHOLDER_MAP =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkqAcAAIUAgUW0RjgAAAAASUVORK5CYII=';

export default function HideScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [camOpen, setCamOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const camRef = useRef<CameraView | null>(null);
  const mapRef = useRef<BTLeafletMapHandle | null>(null);

  // Acquire a fresh GPS fix on mount.
  useEffect(() => {
    (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.status !== 'granted') {
          showAlert('Location needed', 'Allow location so we can save the new hiding spot.');
          return;
        }
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      } catch (e: any) {
        showAlert('GPS error', String(e?.message || e));
      }
    })();
  }, []);

  const openCam = useCallback(async () => {
    if (!gps) {
      showAlert('No GPS yet', 'Waiting for your location — try again in a moment.');
      return;
    }
    // expo-camera 17: dynamic-import workaround (matches solo.tsx + group/[id].tsx)
    const { Camera } = await import('expo-camera');
    const r = await Camera.requestCameraPermissionsAsync();
    if (r.status !== 'granted') {
      showAlert('Camera blocked', 'Allow Camera so you can photograph the spot.');
      return;
    }
    setCamOpen(true);
  }, [gps]);

  const snapAndSubmit = useCallback(async () => {
    if (!gps || !camRef.current || busy) return;
    setBusy(true);
    try {
      const pic = await camRef.current.takePictureAsync({
        quality: 0.55,
        skipProcessing: true,
      });
      if (!pic?.uri) throw new Error('Camera returned no photo.');
      const b64 = await FileSystem.readAsStringAsync(pic.uri, { encoding: FileSystem.EncodingType.Base64 });
      // Map snapshot — soft-fails to a 1px placeholder so a failed Leaflet
      // export never blocks the hide.
      let mapB64 = PLACEHOLDER_MAP;
      try {
        const snap = await mapRef.current?.requestSnapshot?.();
        if (snap && typeof snap === 'string' && snap.length > 100) {
          mapB64 = snap;
        }
      } catch {
        /* placeholder fallback */
      }
      await api.btGroupHide(String(id), {
        lat: gps.lat,
        lng: gps.lng,
        photo_base64: b64,
        map_screenshot_base64: mapB64,
      });
      showAlert('Hidden!', 'Fresh chest is live for the next finder. Your turn is over.');
      router.replace(`/treasure/group/${id}`);
    } catch (e: any) {
      showAlert('Could not hide', String(e?.message || e));
    } finally {
      setBusy(false);
      setCamOpen(false);
    }
  }, [busy, gps, id, router]);

  if (camOpen) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.camWrap}>
          <CameraView ref={camRef as any} style={{ flex: 1 }} facing="back" />
          <View style={styles.camFooter}>
            <TouchableOpacity onPress={() => setCamOpen(false)} style={styles.camCancel}>
              <Text style={styles.camCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={snapAndSubmit} style={styles.shutter} disabled={busy}>
              {busy ? <ActivityIndicator color="#0b0f15" /> : <View style={styles.shutterInner} />}
            </TouchableOpacity>
            <View style={{ width: 80 }} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <Stack.Screen options={{ title: 'Hide the chest', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
      <View style={styles.body}>
        <Text style={styles.title}>Bury the chest at this exact spot</Text>
        <Text style={styles.hint}>
          Stand right where you want to hide it (public-land only: park, oval, beach, school
          grounds, reserve). Snap a photo — we save your coords automatically and pass the
          map + photo to the next player.
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
            />
          ) : (
            <View style={styles.mapPlaceholder}>
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.hint}>Locking GPS…</Text>
            </View>
          )}
        </View>
        <TouchableOpacity
          style={[styles.cta, (!gps || busy) && styles.ctaDisabled]}
          onPress={openCam}
          disabled={!gps || busy}
          activeOpacity={0.85}
          testID="bt-hide-open-cam"
        >
          <Ionicons name="camera" size={20} color="#0b0f15" />
          <Text style={styles.ctaText}>TAKE PHOTO &amp; HIDE</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, padding: spacing.md, gap: spacing.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  hint: { color: '#8C92A6', fontSize: 13, lineHeight: 18 },
  mapWrap: {
    flex: 1, minHeight: 240, borderRadius: radii.md, overflow: 'hidden',
    borderWidth: 1, borderColor: '#1A1A24',
  },
  mapPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#0F1218' },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#FFD166', paddingVertical: 16, borderRadius: radii.md,
  },
  ctaDisabled: { backgroundColor: '#3A3A44' },
  ctaText: { color: '#0b0f15', fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
  camWrap: { flex: 1, backgroundColor: '#000' },
  camFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    backgroundColor: '#000',
  },
  camCancel: { paddingHorizontal: 14, paddingVertical: 10 },
  camCancelText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  shutter: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#FFD166',
  },
  shutterInner: { width: 50, height: 50, borderRadius: 25, backgroundColor: '#FFD166' },
});
