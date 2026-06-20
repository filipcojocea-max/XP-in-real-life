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
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Magnetometer } from 'expo-sensors';
import * as FileSystem from 'expo-file-system/legacy';
import { api, type BTCompassReading, type BTSoloHunt } from '../../src/api';
import BTLeafletMap, { type BTLeafletMapHandle } from '../../src/components/BTLeafletMap';
import BTAROverlay from '../../src/components/BTAROverlay';
import { BTReportIssueModal } from '../../src/components/BTReportIssueModal';
import { colors, radii, spacing } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

// ── Daily-gate helpers ────────────────────────────────────────────────
// AsyncStorage key includes the local YYYY-MM-DD so the interstitial
// re-appears at local midnight even if the user never closed the app.
// Per spec: "if they haven't started their hunt for the day yet, show
// a clean screen with a single prominent button: Start Daily Treasure
// Hunt". Once tapped, the flag persists for the rest of the day.
const localDateKey = (): string => {
  const d = new Date();
  return `bt_daily_started:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function SoloHunt() {
  const router = useRouter();
  const [gps, setGPS] = useState<{ lat: number; lng: number } | null>(null);
  const [compass, setCompass] = useState<BTCompassReading | null>(null);
  const [hunt, setHunt] = useState<BTSoloHunt | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [heading, setHeading] = useState(0);  // device facing (deg true-north)
  const [perm] = useCameraPermissions();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Daily interstitial gate:
  //   null      → still checking AsyncStorage (brief flash)
  //   'gated'   → show "Start Daily Treasure Hunt" button
  //   'active'  → show the normal compass + camera UI
  const [dailyStage, setDailyStage] = useState<'checking' | 'gated' | 'active'>('checking');
  // Map clue expand/minimize state (Part 1 spec). Declared HERE — when
  // these were defined inline elsewhere the bundler crashed at runtime
  // because the closures captured undefined refs.
  const [mapExpanded, setMapExpanded] = useState(false);
  const mapRef = useRef<BTLeafletMapHandle | null>(null);
  const expandedMapRef = useRef<BTLeafletMapHandle | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const magSubRef = useRef<{ remove: () => void } | null>(null);
  const cameraRef = useRef<any>(null);

  // ─── Daily gate check ───────────────────────────────────────────
  // Runs once on mount. If the user already activated today's hunt we
  // skip straight to the compass; otherwise we park them on the
  // interstitial until they tap the big button.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await AsyncStorage.getItem(localDateKey());
        if (cancelled) return;
        setDailyStage(v ? 'active' : 'gated');
      } catch {
        // If AsyncStorage is unavailable for some reason, default to
        // showing the gate (better UX than dumping them into the
        // compass without the "starting" moment).
        if (!cancelled) setDailyStage('gated');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onActivateDaily = useCallback(async () => {
    try { await AsyncStorage.setItem(localDateKey(), '1'); } catch {}
    setDailyStage('active');
  }, []);

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
        // 2026-06-20: tightened GPS precision per spec.
        // • BestForNavigation = sub-metre target (vs ~5 m for High)
        // • distanceInterval: 1 m (vs 2) so the AR overlay anchor stays
        //   tight while the user walks into the 15 m ring.
        // • timeInterval: 800 ms keeps battery cost reasonable while
        //   the heading watcher already updates the icon position.
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 1, timeInterval: 800 },
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

  // ─── Live "you are here" → mini-map blue dot ───────────────────────
  // Pipe every GPS tick into both map WebViews (embedded + expanded)
  // so the player can visually compare their position to the X marker.
  useEffect(() => {
    if (dailyStage !== 'active' || !gps) return;
    mapRef.current?.setUserLocation(gps.lat, gps.lng);
    if (mapExpanded) {
      expandedMapRef.current?.setUserLocation(gps.lat, gps.lng);
    }
  }, [gps, dailyStage, mapExpanded]);

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

  // Fetch the current hunt doc so we can render the static map clue
  // (chest_lat / chest_lng) below the compass. Refreshed after every
  // find since the server auto-buries the next chest in the same area.
  const fetchHunt = useCallback(async () => {
    try {
      const r = await api.btSoloCurrent();
      setHunt(r.hunt || null);
    } catch { /* silent — compass loop will catch fatal "no hunt" cases */ }
  }, []);

  useEffect(() => {
    if (dailyStage !== 'active') return;
    fetchHunt();
  }, [dailyStage, fetchHunt]);

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
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      const res = await api.btSoloFind(gps.lat, gps.lng, b64);
      setCameraOpen(false);
      // 2026-06-20: success flow per spec — clearly award XP, mark the
      // user "completed for today", and tell them when they can hunt
      // again. The backend has already flipped `found_today = true`
      // and stamped `next_reset_at`, so when the user reopens the
      // app the gate logic in /bt/solo/current will keep this hunt
      // locked until the personal wake-up boundary passes.
      showAlert(
        `+${res.xp_awarded ?? 100} XP — chest found!`,
        `New total: ${res.new_total_xp.toLocaleString()} XP.\n\n` +
        `You completed it for today — come back tomorrow! A fresh chest will spawn in your area at your next wake-up boundary.`,
      );
      // Refresh compass + hunt doc so the screen reflects the locked
      // "found today" state until the daily reset.
      await fetchCompass();
      await fetchHunt();
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
        <View style={styles.headerRightStack}>
          {hunt?.chest_lat != null && hunt?.chest_lng != null && dailyStage !== 'gated' ? (
            <TouchableOpacity
              style={[styles.headerBtn, styles.headerReportBtn]}
              onPress={() => setReportOpen(true)}
              testID="bt-report-issue"
              accessibilityLabel="Report an issue with this chest"
            >
              <Ionicons name="flag-outline" size={18} color="#FF3B30" />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={() => router.push('/treasure/solo-finds')}
            testID="bt-past-finds"
          >
            <Ionicons name="file-tray-full-outline" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>

      {dailyStage === 'checking' ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.cyan} />
        </View>
      ) : dailyStage === 'gated' ? (
        // ───────────── Daily interstitial ─────────────
        // Single-purpose screen — "Start Daily Treasure Hunt" — that
        // marks today's hunt as activated and reveals the compass.
        // Persists across app restarts via AsyncStorage; auto-resets
        // at local midnight (key includes today's YYYY-MM-DD).
        <View style={styles.gateWrap} testID="bt-daily-gate">
          <View style={styles.gateBadge}>
            <Ionicons name="today" size={14} color="#FFD166" />
            <Text style={styles.gateBadgeText}>TODAY'S EVENT</Text>
          </View>
          <Ionicons name="map" size={72} color={colors.cyan} />
          <Text style={styles.gateTitle}>A new chest is buried.</Text>
          <Text style={styles.gateSub}>
            Tap below to officially start today's hunt. Once you start, the
            compass will lock onto the chest and your map clue will appear.
          </Text>
          <TouchableOpacity
            style={styles.gateBtn}
            onPress={onActivateDaily}
            activeOpacity={0.85}
            testID="bt-start-daily-hunt"
          >
            <Ionicons name="play-circle" size={24} color="#0b0f15" />
            <Text style={styles.gateBtnText}>START DAILY TREASURE HUNT</Text>
          </TouchableOpacity>
        </View>
      ) : loading ? (
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

            {/* ───────────── Map snapshot clue ─────────────
                Static read-only Leaflet map centred on the chest with
                a red X marker and a live blue "you are here" dot. The
                Expand button promotes it to a full-screen modal where
                the player can pinch/drag freely. */}
            {hunt?.chest_lat != null && hunt?.chest_lng != null ? (
              <View style={styles.mapClue} testID="bt-map-clue">
                <View style={styles.mapClueHeader}>
                  <Ionicons name="location" size={14} color="#EF4444" />
                  <Text style={styles.mapClueTitle}>BURIED HERE · X MARKS THE SPOT</Text>
                  <View style={{ flex: 1 }} />
                  <TouchableOpacity
                    onPress={() => setMapExpanded(true)}
                    style={styles.expandBtn}
                    activeOpacity={0.8}
                    testID="bt-expand-map"
                  >
                    <Ionicons name="expand" size={12} color={colors.cyan} />
                    <Text style={styles.expandBtnText}>EXPAND MAP</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.mapClueBox}>
                  <BTLeafletMap
                    ref={mapRef}
                    mode="static"
                    initialLat={hunt.chest_lat}
                    initialLng={hunt.chest_lng}
                    initialZoom={17}
                    initialRadius={0}
                    markerShape="x"
                    markerColor="#EF4444"
                    ringColor="#EF4444"
                    interactive={false}
                    style={StyleSheet.absoluteFill}
                  />
                </View>
              </View>
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
          {/* AR-lite chest indicator anchored to the buried-treasure
              coordinates. Uses the device compass + GPS to position
              a chest icon on screen as if it were floating at the
              find spot (Pokémon-GO-style guidance), with an edge
              arrow when the chest is outside the camera's field of
              view. Pulses when the user crosses inside the 15m find
              ring so it's obvious WHEN to tap the shutter. */}
          {hunt?.chest_lat != null && hunt?.chest_lng != null ? (
            <BTAROverlay
              gps={gps}
              chestLat={hunt.chest_lat}
              chestLng={hunt.chest_lng}
              findRingM={15}
            />
          ) : null}
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
      {/* ───────────── Expanded full-screen map modal ─────────────
          Per Part-1 spec: tapping "EXPAND MAP" promotes the snapshot
          to a full-screen modal with pan + pinch + zoom buttons all
          enabled. Tapping "Minimize Map" returns to the embedded box.
          We render a SECOND BTLeafletMap inside the modal so the small
          map keeps its scroll position when the modal closes. */}
      <Modal
        visible={mapExpanded}
        animationType="slide"
        onRequestClose={() => setMapExpanded(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: '#0b0f15' }} edges={['top']}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => setMapExpanded(false)} style={styles.headerBtn}>
              <Ionicons name="contract" size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Treasure map · X marks the spot</Text>
            <TouchableOpacity
              onPress={() => setMapExpanded(false)}
              style={[styles.headerBtn, { width: 'auto', paddingHorizontal: 10 }]}
              testID="bt-minimize-map"
            >
              <Text style={{ color: colors.cyan, fontWeight: '900', fontSize: 11, letterSpacing: 1 }}>MINIMIZE</Text>
            </TouchableOpacity>
          </View>
          {hunt?.chest_lat != null && hunt?.chest_lng != null ? (
            <BTLeafletMap
              ref={expandedMapRef}
              mode="static"
              initialLat={hunt.chest_lat}
              initialLng={hunt.chest_lng}
              initialZoom={17}
              initialRadius={0}
              markerShape="x"
              markerColor="#EF4444"
              ringColor="#EF4444"
              interactive={true}
              onReady={() => {
                // Drop in the live user dot the moment the expanded
                // map finishes loading, otherwise the player would
                // see only the X until the next GPS tick.
                if (gps) expandedMapRef.current?.setUserLocation(gps.lat, gps.lng);
              }}
              style={{ flex: 1 }}
            />
          ) : null}
        </SafeAreaView>
      </Modal>

      {/* Issue Report modal — opened from the header flag button. */}
      {hunt?.chest_lat != null && hunt?.chest_lng != null ? (
        <BTReportIssueModal
          visible={reportOpen}
          onClose={() => setReportOpen(false)}
          source="solo"
          hunt_id={String(hunt?.user_id || '')}
          chest_lat={hunt.chest_lat}
          chest_lng={hunt.chest_lng}
        />
      ) : null}
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
  headerRightStack: { flexDirection: 'row', alignItems: 'center' },
  headerReportBtn: {
    borderWidth: 1, borderColor: '#FF3B30', borderRadius: 8,
    marginRight: 6, width: 36, height: 32,
  },
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
  // Styles
  expandBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1, borderColor: colors.cyan + '88',
    backgroundColor: colors.cyan + '22',
  },
  expandBtnText: { color: colors.cyan, fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  // ── Daily interstitial ────────────────────────────────────────────
  gateWrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: spacing.xl ?? 28, gap: 14,
  },
  gateBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1, borderColor: '#FFD16655',
    backgroundColor: '#FFD16622',
    marginBottom: 8,
  },
  gateBadgeText: { color: '#FFD166', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  gateTitle: { color: colors.text, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  gateSub: {
    color: colors.textSecondary, fontSize: 13, lineHeight: 19,
    textAlign: 'center', maxWidth: 320,
  },
  gateBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.cyan,
    paddingVertical: 18, paddingHorizontal: 26, borderRadius: radii.lg,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    minWidth: 280,
  },
  gateBtnText: { color: '#0b0f15', fontWeight: '900', fontSize: 14, letterSpacing: 1 },
  // ── Map clue (static chest map under the compass) ─────────────────
  mapClue: {
    width: '100%',
    marginTop: 16,
    borderRadius: radii.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#EF444455',
    backgroundColor: colors.surface,
  },
  mapClueHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: '#EF444422',
    borderBottomWidth: 1, borderBottomColor: '#EF444433',
  },
  mapClueTitle: { color: '#EF4444', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  // Fixed-height map box. Keeping the box self-contained means the
  // surrounding ScrollView (if added later) doesn't fight the WebView
  // for vertical space.
  mapClueBox: { width: '100%', height: 160, backgroundColor: '#1a1d22' },
});
