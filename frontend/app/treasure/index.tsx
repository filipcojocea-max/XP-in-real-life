/**
 * /treasure — Buried Treasure Phase 1 (solo daily hunt).
 *
 * One screen, four modes driven by internal state:
 *
 *  • onboard  — Pick the coverage circle for your city / town.
 *  • main     — Today's chest on a map (with hint card + Start Hunt CTA).
 *  • hunt     — 2D-AR hunt: compass arrow + live distance + "Found it!"
 *               photo capture once you're inside the 12m proximity ring.
 *  • settings — Daylight-only toggle, finds history, "Report a bug".
 *
 * Native AR (true ARKit/ARCore chest placement) is NOT used — Phase 1
 * uses a 2D camera overlay with compass heading + distance counter as
 * agreed with the user (see the v1.0.29 Phase 1 scope brief).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Magnetometer } from 'expo-sensors';
import MapView, { Circle, Marker } from 'react-native-maps';
import { showAlert } from '../../src/uiAlert';
import { colors, radii, spacing } from '../../src/theme';
import { api } from '../../src/api';
import type { BTChest, BTLocation, BTFind } from '../../src/api';

type Mode = 'loading' | 'onboard' | 'main' | 'hunt' | 'settings';

const TREASURE_GOLD = '#FFC857';
const TREASURE_GREEN = '#33ff95';
const RING_M = 12;       // proximity ring for find-tap
const MAX_RADIUS_M = 25_000;
const MIN_RADIUS_M = 300;

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export default function BuriedTreasureScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('loading');
  const [location, setLocation] = useState<BTLocation | null>(null);
  const [chest, setChest] = useState<BTChest | null>(null);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [daylightOnly, setDaylightOnly] = useState(false);
  const [finds, setFinds] = useState<BTFind[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // ── Boot: load location → settings → chest ──
  const load = useCallback(async () => {
    try {
      const [locRes, settingsRes] = await Promise.all([
        api.btLocationGet(),
        api.btSettingsGet().catch(() => ({ settings: { daylight_only: false } })),
      ]);
      setDaylightOnly(!!settingsRes.settings.daylight_only);
      if (!locRes.location) {
        setMode('onboard');
        return;
      }
      setLocation(locRes.location);
      const c = await api.btChestToday();
      setChest(c.chest);
      setMode('main');
    } catch (e: any) {
      showAlert('Could not load', String(e?.message || e));
      setMode('onboard');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Live device position (always-on while screen is mounted) ──
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const cur = await Location.getCurrentPositionAsync({});
      setPos({ lat: cur.coords.latitude, lng: cur.coords.longitude });
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 2, timeInterval: 1500 },
        (l) => setPos({ lat: l.coords.latitude, lng: l.coords.longitude }),
      );
    })();
    return () => { sub?.remove(); };
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // ─────────────── Onboarding flow ───────────────
  if (mode === 'loading') {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={TREASURE_GOLD} />
          <Text style={styles.loadingText}>Loading the chart…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (mode === 'onboard') {
    return (
      <OnboardLocation
        onSaved={async (loc) => {
          setLocation(loc);
          const c = await api.btChestToday();
          setChest(c.chest);
          setMode('main');
        }}
        onBack={() => router.back()}
      />
    );
  }

  if (mode === 'hunt' && chest) {
    return (
      <HuntScreen
        chest={chest}
        currentPos={pos}
        onClose={() => setMode('main')}
        onFound={(updated) => {
          setChest(updated);
          showAlert('🏴‍☠️ You found it!', `+50 XP added to your stash.`);
          setMode('main');
        }}
      />
    );
  }

  if (mode === 'settings' && location) {
    return (
      <SettingsScreen
        location={location}
        daylightOnly={daylightOnly}
        finds={finds}
        onDaylightChange={async (v) => {
          setDaylightOnly(v);
          await api.btSettingsSet(v);
        }}
        onResetLocation={() => setMode('onboard')}
        onClose={() => setMode('main')}
        loadFinds={async () => {
          const r = await api.btFindsHistory();
          setFinds(r.finds);
        }}
        onReportSent={() => showAlert('Report sent', 'The Creator will take a look.')}
      />
    );
  }

  // ── MAIN MODE ──
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Buried Treasure</Text>
        <TouchableOpacity onPress={() => setMode('settings')} hitSlop={10}>
          <Ionicons name="settings-outline" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      {location && chest ? (
        <View style={{ flex: 1 }}>
          <MapView
            style={styles.map}
            initialRegion={{
              latitude: chest.lat,
              longitude: chest.lng,
              latitudeDelta: Math.max(0.01, (location.radius_m / 111_000) * 2),
              longitudeDelta: Math.max(0.01, (location.radius_m / 111_000) * 2),
            }}
            showsUserLocation
            showsMyLocationButton
          >
            <Circle
              center={{ latitude: location.lat, longitude: location.lng }}
              radius={location.radius_m}
              fillColor={`${TREASURE_GREEN}11`}
              strokeColor={`${TREASURE_GREEN}77`}
              strokeWidth={2}
            />
            {chest.status === 'hidden' ? (
              <Marker
                coordinate={{ latitude: chest.lat, longitude: chest.lng }}
                title="Today's Chest"
                description={chest.osm_feature_name || 'Public terrain'}
                pinColor={TREASURE_GOLD}
              />
            ) : null}
            {pos ? (
              <Circle
                center={{ latitude: pos.lat, longitude: pos.lng }}
                radius={RING_M}
                fillColor={`${TREASURE_GOLD}33`}
                strokeColor={TREASURE_GOLD}
                strokeWidth={2}
              />
            ) : null}
          </MapView>

          <View style={styles.hintCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="map" size={16} color={TREASURE_GOLD} />
              <Text style={styles.hintCardKicker}>TODAY'S HINT</Text>
              {chest.daylight_only ? (
                <View style={styles.tinyTag}>
                  <Ionicons name="sunny" size={10} color={TREASURE_GOLD} />
                  <Text style={styles.tinyTagText}>DAYLIGHT</Text>
                </View>
              ) : null}
              {chest.status === 'found' ? (
                <View style={[styles.tinyTag, { borderColor: TREASURE_GREEN + '88' }]}>
                  <Ionicons name="checkmark" size={10} color={TREASURE_GREEN} />
                  <Text style={[styles.tinyTagText, { color: TREASURE_GREEN }]}>FOUND</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.hintText}>{chest.hint}</Text>
            {chest.osm_feature_name ? (
              <Text style={styles.hintSub}>📍 {chest.osm_feature_name}</Text>
            ) : null}
            {pos ? (
              <Text style={styles.hintSub}>
                ~{Math.round(haversineM(pos.lat, pos.lng, chest.lat, chest.lng))} m away
              </Text>
            ) : null}
            <TouchableOpacity
              testID="bt-start-hunt"
              onPress={() => setMode('hunt')}
              disabled={chest.status !== 'hidden'}
              style={[
                styles.huntBtn,
                chest.status !== 'hidden' && { opacity: 0.45 },
              ]}
              activeOpacity={0.85}
            >
              <Ionicons name="compass" size={18} color={colors.bg} />
              <Text style={styles.huntBtnText}>
                {chest.status === 'found' ? 'Already Found Today' : 'START HUNT'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={TREASURE_GOLD} />
        </View>
      )}
    </SafeAreaView>
  );
}

// ════════════════════════ OnboardLocation ═══════════════════════
function OnboardLocation({
  onSaved,
  onBack,
}: {
  onSaved: (loc: BTLocation) => void;
  onBack: () => void;
}) {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [radius, setRadius] = useState(5000);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        showAlert('Permission needed', 'We need your location to set the hunt area.');
        return;
      }
      const c = await Location.getCurrentPositionAsync({});
      setCoords({ lat: c.coords.latitude, lng: c.coords.longitude });
    })();
  }, []);

  const onUse = useCallback(async () => {
    if (!coords) return;
    setSaving(true);
    try {
      const tz = -new Date().getTimezoneOffset();
      await api.btLocationSet(coords.lat, coords.lng, radius, label, tz);
      onSaved({
        lat: coords.lat,
        lng: coords.lng,
        radius_m: radius,
        label,
        tz_offset_minutes: tz,
      });
    } catch (e: any) {
      showAlert('Could not save', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }, [coords, radius, label, onSaved]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <TouchableOpacity onPress={onBack} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Set your hunt area</Text>
        <View style={{ width: 22 }} />
      </View>

      {coords ? (
        <View style={{ flex: 1 }}>
          <MapView
            style={styles.map}
            initialRegion={{
              latitude: coords.lat,
              longitude: coords.lng,
              latitudeDelta: (radius / 111_000) * 3,
              longitudeDelta: (radius / 111_000) * 3,
            }}
            onPress={(e) => setCoords({
              lat: e.nativeEvent.coordinate.latitude,
              lng: e.nativeEvent.coordinate.longitude,
            })}
          >
            <Circle
              center={{ latitude: coords.lat, longitude: coords.lng }}
              radius={radius}
              fillColor={`${TREASURE_GREEN}22`}
              strokeColor={TREASURE_GREEN}
              strokeWidth={2}
            />
            <Marker coordinate={{ latitude: coords.lat, longitude: coords.lng }} />
          </MapView>

          <View style={styles.onboardCard}>
            <Text style={styles.onboardKicker}>COVERAGE RADIUS</Text>
            <View style={styles.radiusRow}>
              {[1000, 3000, 5000, 10000, 20000].map((r) => (
                <TouchableOpacity
                  key={r}
                  testID={`bt-radius-${r}`}
                  onPress={() => setRadius(r)}
                  style={[
                    styles.radiusPill,
                    radius === r && styles.radiusPillActive,
                  ]}
                  activeOpacity={0.85}
                >
                  <Text
                    style={[
                      styles.radiusPillText,
                      radius === r && styles.radiusPillTextActive,
                    ]}
                  >
                    {r >= 1000 ? `${r / 1000}km` : `${r}m`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={styles.labelInput}
              placeholder="Optional label (e.g. Brisbane)"
              placeholderTextColor={colors.textMuted}
              value={label}
              onChangeText={setLabel}
              maxLength={30}
            />
            <Text style={styles.onboardHelp}>
              Drag the map / tap to recentre. Zoom out to cover the whole town,
              then save.
            </Text>
            <TouchableOpacity
              testID="bt-use-location"
              onPress={onUse}
              disabled={saving}
              style={[styles.primaryBtn, saving && { opacity: 0.5 }]}
              activeOpacity={0.85}
            >
              {saving ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text style={styles.primaryBtnText}>Use this location area</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={TREASURE_GOLD} />
          <Text style={styles.loadingText}>Looking you up on the map…</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

// ════════════════════════ HuntScreen ════════════════════════════
function HuntScreen({
  chest,
  currentPos,
  onClose,
  onFound,
}: {
  chest: BTChest;
  currentPos: { lat: number; lng: number } | null;
  onClose: () => void;
  onFound: (c: BTChest) => void;
}) {
  const [perm, requestPerm] = useCameraPermissions();
  const [heading, setHeading] = useState(0);
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef<CameraView | null>(null);

  useEffect(() => {
    if (perm && !perm.granted) requestPerm();
  }, [perm, requestPerm]);

  useEffect(() => {
    Magnetometer.setUpdateInterval(200);
    const sub = Magnetometer.addListener((data) => {
      const angle = Math.atan2(data.y, data.x) * (180 / Math.PI);
      setHeading((angle + 360) % 360);
    });
    return () => sub.remove();
  }, []);

  const dist = currentPos
    ? haversineM(currentPos.lat, currentPos.lng, chest.lat, chest.lng)
    : null;
  const targetBearing = currentPos
    ? bearingDeg(currentPos.lat, currentPos.lng, chest.lat, chest.lng)
    : 0;
  const arrowRot = currentPos ? (targetBearing - heading + 360) % 360 : 0;
  const withinRing = dist != null && dist <= RING_M;

  const onTapFound = useCallback(async () => {
    if (!currentPos) {
      showAlert('No GPS', 'Wait for the map to pick up your position.');
      return;
    }
    if (!withinRing) {
      showAlert('Too far', `You're ${Math.round(dist || 0)}m away. Get within ${RING_M}m.`);
      return;
    }
    setBusy(true);
    try {
      let photoB64: string | undefined;
      if (cameraRef.current) {
        try {
          const r: any = await (cameraRef.current as any).takePictureAsync({
            base64: true, quality: 0.5, exif: false,
          });
          photoB64 = r?.base64;
        } catch {/* ignore — camera failure shouldn't block the find */}
      }
      const r = await api.btChestFind(currentPos.lat, currentPos.lng, photoB64);
      onFound(r.chest);
    } catch (e: any) {
      showAlert('Could not claim', String(e?.detail || e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [currentPos, withinRing, dist, onFound]);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Stack.Screen options={{ headerShown: false }} />
      {perm?.granted ? (
        <CameraView ref={cameraRef as any} style={StyleSheet.absoluteFill} facing="back" />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Text style={{ color: '#fff' }}>Camera permission required</Text>
        </View>
      )}

      {/* HUD overlay */}
      <SafeAreaView style={styles.hudSafe} edges={['top']}>
        <View style={styles.hudTop}>
          <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.hudClose}>
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>
          <View style={styles.hudDistBlock}>
            <Text style={styles.hudDistNum}>
              {dist != null ? `${Math.round(dist)} m` : '— m'}
            </Text>
            <Text style={styles.hudDistLabel}>{withinRing ? 'WITHIN RING' : 'TO CHEST'}</Text>
          </View>
          <View style={{ width: 36 }} />
        </View>

        {/* Center compass arrow */}
        <View style={styles.compassWrap} pointerEvents="none">
          <View style={[styles.compassRing, withinRing && { borderColor: TREASURE_GOLD }]}>
            <View
              style={[
                styles.compassArrow,
                { transform: [{ rotate: `${arrowRot}deg` }] },
              ]}
            >
              <Ionicons
                name="caret-up"
                size={48}
                color={withinRing ? TREASURE_GOLD : TREASURE_GREEN}
              />
            </View>
            {withinRing ? (
              <Text style={styles.lookHere}>🎯 LOOK AROUND YOU!</Text>
            ) : null}
          </View>
        </View>

        {/* Bottom: chest sprite + Found button */}
        <View style={styles.hudBottom}>
          {withinRing ? (
            <View pointerEvents="none" style={styles.chestSprite}>
              <Text style={{ fontSize: 64 }}>🏴‍☠️</Text>
            </View>
          ) : null}
          <TouchableOpacity
            testID="bt-found"
            onPress={onTapFound}
            disabled={busy || !withinRing}
            style={[
              styles.foundBtn,
              (!withinRing || busy) && { opacity: 0.5, backgroundColor: '#444' },
            ]}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <>
                <Ionicons name="camera" size={20} color={colors.bg} />
                <Text style={styles.foundBtnText}>
                  {withinRing ? 'I FOUND IT — snap photo' : `Get within ${RING_M}m`}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

// ════════════════════════ SettingsScreen ════════════════════════
function SettingsScreen({
  location,
  daylightOnly,
  finds,
  onDaylightChange,
  onResetLocation,
  onClose,
  loadFinds,
  onReportSent,
}: {
  location: BTLocation;
  daylightOnly: boolean;
  finds: BTFind[];
  onDaylightChange: (v: boolean) => void;
  onResetLocation: () => void;
  onClose: () => void;
  loadFinds: () => Promise<void>;
  onReportSent: () => void;
}) {
  const [reportText, setReportText] = useState('');
  const [reportKind, setReportKind] = useState<'location' | 'object'>('object');
  const [sending, setSending] = useState(false);
  useEffect(() => { loadFinds(); }, [loadFinds]);

  const sendReport = useCallback(async () => {
    if (!reportText.trim()) {
      showAlert('Empty', 'Tell the Creator what to look at.');
      return;
    }
    setSending(true);
    try {
      await api.btReport(reportKind, reportText.trim(), {
        lat: location.lat, lng: location.lng,
      });
      setReportText('');
      onReportSent();
    } catch (e: any) {
      showAlert('Could not send', String(e?.message || e));
    } finally {
      setSending(false);
    }
  }, [reportText, reportKind, location, onReportSent]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <TouchableOpacity onPress={onClose} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Settings & History</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: 12 }}>
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>HUNT WINDOW</Text>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Only during the day</Text>
              <Text style={styles.rowSub}>
                {daylightOnly
                  ? 'Hunting limited to roughly 06:00 – 19:00 local.'
                  : 'Hunt 24 hours — chest is valid until tomorrow.'}
              </Text>
            </View>
            <Switch
              testID="bt-daylight-toggle"
              value={daylightOnly}
              onValueChange={onDaylightChange}
              trackColor={{ false: colors.border, true: TREASURE_GOLD + '99' }}
              thumbColor={daylightOnly ? TREASURE_GOLD : '#f0f0f0'}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>HUNT AREA</Text>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>
                {location.label || `${location.lat.toFixed(3)}, ${location.lng.toFixed(3)}`}
              </Text>
              <Text style={styles.rowSub}>
                Coverage: {(location.radius_m / 1000).toFixed(1)} km radius
              </Text>
            </View>
            <TouchableOpacity onPress={onResetLocation} style={styles.changeBtn}>
              <Text style={styles.changeBtnText}>CHANGE</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>REPORT A BUG OR BAD LOCATION</Text>
          <View style={styles.kindRow}>
            <TouchableOpacity
              onPress={() => setReportKind('object')}
              style={[styles.kindPill, reportKind === 'object' && styles.kindPillActive]}
              activeOpacity={0.85}
            >
              <Text style={[styles.kindPillText, reportKind === 'object' && styles.kindPillTextActive]}>
                CHEST BUG
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setReportKind('location')}
              style={[styles.kindPill, reportKind === 'location' && styles.kindPillActive]}
              activeOpacity={0.85}
            >
              <Text style={[styles.kindPillText, reportKind === 'location' && styles.kindPillTextActive]}>
                BAD LOCATION
              </Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.reportInput}
            multiline
            placeholder={
              reportKind === 'object'
                ? 'e.g. The chest was unreachable — fenced off.'
                : 'e.g. Avoid private school grounds at (lat, lng).'
            }
            placeholderTextColor={colors.textMuted}
            value={reportText}
            onChangeText={setReportText}
            maxLength={500}
          />
          <TouchableOpacity
            testID="bt-send-report"
            onPress={sendReport}
            disabled={sending}
            style={[styles.primaryBtn, sending && { opacity: 0.5 }]}
            activeOpacity={0.85}
          >
            {sending ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.primaryBtnText}>Send to Creator</Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>YOUR FINDS</Text>
          {finds.length === 0 ? (
            <Text style={styles.emptyHistory}>No finds yet. Get hunting!</Text>
          ) : (
            finds.map((f) => (
              <View key={f.id} style={styles.findRow}>
                {f.photo_base64 ? (
                  <Image
                    source={{ uri: `data:image/jpeg;base64,${f.photo_base64}` }}
                    style={styles.findThumb}
                  />
                ) : (
                  <View style={[styles.findThumb, styles.findThumbFallback]}>
                    <Text style={{ fontSize: 24 }}>🏴‍☠️</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.findDate}>
                    {new Date(f.found_at).toLocaleString()}
                  </Text>
                  <Text style={styles.findCoords}>
                    {f.lat.toFixed(4)}, {f.lng.toFixed(4)}
                  </Text>
                </View>
                <Text style={styles.findXp}>+50 XP</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '900' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  loadingText: { color: colors.textMuted, fontSize: 12 },
  map: { flex: 1 },

  hintCard: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    margin: spacing.md, padding: 14, borderRadius: radii.lg,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    gap: 6,
  },
  hintCardKicker: { color: TREASURE_GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  hintText: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 4 },
  hintSub: { color: colors.textMuted, fontSize: 11 },
  tinyTag: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
    backgroundColor: TREASURE_GOLD + '22', borderWidth: 1, borderColor: TREASURE_GOLD + '99',
  },
  tinyTagText: { color: TREASURE_GOLD, fontSize: 8, fontWeight: '900', letterSpacing: 1 },

  huntBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: TREASURE_GOLD, paddingVertical: 12,
    borderRadius: radii.md, marginTop: 8,
  },
  huntBtnText: { color: colors.bg, fontWeight: '900', letterSpacing: 1, fontSize: 13 },

  // ── Onboard ──
  onboardCard: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    margin: spacing.md, padding: 14, borderRadius: radii.lg,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    gap: 8,
  },
  onboardKicker: { color: TREASURE_GREEN, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  radiusRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  radiusPill: {
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  radiusPillActive: { backgroundColor: TREASURE_GREEN + '22', borderColor: TREASURE_GREEN },
  radiusPillText: { color: colors.textMuted, fontSize: 12, fontWeight: '800' },
  radiusPillTextActive: { color: TREASURE_GREEN },
  labelInput: {
    backgroundColor: colors.bg, color: colors.text, padding: 10,
    borderRadius: 10, borderColor: colors.border, borderWidth: 1, fontSize: 13,
  },
  onboardHelp: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  primaryBtn: {
    backgroundColor: TREASURE_GOLD, paddingVertical: 12,
    borderRadius: radii.md, alignItems: 'center', justifyContent: 'center',
  },
  primaryBtnText: { color: colors.bg, fontWeight: '900', letterSpacing: 1, fontSize: 13 },

  // ── Hunt HUD ──
  hudSafe: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  hudTop: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 16,
  },
  hudClose: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  hudDistBlock: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 16, paddingVertical: 6, borderRadius: 999 },
  hudDistNum: { color: '#fff', fontSize: 20, fontWeight: '900' },
  hudDistLabel: { color: '#bbb', fontSize: 9, letterSpacing: 2 },
  compassWrap: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  compassRing: {
    width: 220, height: 220, borderRadius: 110,
    borderColor: TREASURE_GREEN, borderWidth: 3,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  compassArrow: { position: 'absolute' },
  lookHere: {
    position: 'absolute', bottom: -36,
    color: TREASURE_GOLD, fontWeight: '900', letterSpacing: 1.5,
  },
  hudBottom: { padding: 16, alignItems: 'center', gap: 12 },
  chestSprite: { backgroundColor: 'rgba(0,0,0,0.4)', padding: 8, borderRadius: 12 },
  foundBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: TREASURE_GOLD, paddingVertical: 16, paddingHorizontal: 24,
    borderRadius: 999, minWidth: 220,
  },
  foundBtnText: { color: colors.bg, fontWeight: '900', letterSpacing: 1, fontSize: 13 },

  // ── Settings ──
  section: {
    backgroundColor: colors.surface, padding: 14,
    borderRadius: radii.md, borderColor: colors.border, borderWidth: 1, gap: 10,
  },
  sectionLabel: { color: TREASURE_GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  rowSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  changeBtn: {
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999,
    backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1,
  },
  changeBtnText: { color: colors.cyan, fontWeight: '900', fontSize: 10, letterSpacing: 1 },

  kindRow: { flexDirection: 'row', gap: 8 },
  kindPill: {
    flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center',
    backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1,
  },
  kindPillActive: { backgroundColor: TREASURE_GOLD + '22', borderColor: TREASURE_GOLD },
  kindPillText: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  kindPillTextActive: { color: TREASURE_GOLD },
  reportInput: {
    backgroundColor: colors.bg, color: colors.text, padding: 12,
    borderRadius: 10, borderColor: colors.border, borderWidth: 1, fontSize: 13,
    minHeight: 80, textAlignVertical: 'top',
  },
  findRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.bg, borderRadius: 10, padding: 8,
  },
  findThumb: { width: 48, height: 48, borderRadius: 8 },
  findThumbFallback: { backgroundColor: TREASURE_GOLD + '22', alignItems: 'center', justifyContent: 'center' },
  findDate: { color: colors.text, fontSize: 12, fontWeight: '700' },
  findCoords: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  findXp: { color: TREASURE_GOLD, fontSize: 11, fontWeight: '900' },
  emptyHistory: { color: colors.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: 8 },
});
