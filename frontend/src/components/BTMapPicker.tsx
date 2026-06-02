/**
 * <BTMapPicker /> — Buried Treasure location + radius picker.
 *
 * 2026-06-04: rebuilt on top of <BTLeafletMap /> (WebView + Leaflet +
 * OpenStreetMap) — we ditched Google Maps / react-native-maps after
 * weeks of unreliable rendering on the user's Android devices. No API
 * keys needed, identical UX on iOS and Android.
 *
 * UX:
 *   1. Opens centred on Australia (per spec) so a brand-new user
 *      sees a familiar starting view even before location permission
 *      is resolved.
 *   2. Requests foreground location; on grant we recenter to the
 *      user's GPS at street-level zoom and drop the pin there.
 *   3. User can tap or drag the pin to fine-tune the hunt centre.
 *   4. Slider in RN drives the radius circle imperatively.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import BTLeafletMap, { type BTLeafletMapHandle, type LatLng } from './BTLeafletMap';
import { colors, radii, spacing } from '../theme';

const MIN_RADIUS = 100;     // metres
const MAX_RADIUS = 25_000;  // metres

// Australia centroid — initial view per spec.
const AUS_INITIAL = { lat: -25.2744, lng: 133.7751, zoom: 4 };

const fmtRadius = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;

export type BTAreaPicked = { lat: number; lng: number; radius_m: number };

type Props = {
  onConfirm: (area: BTAreaPicked) => void;
  initialRadius?: number;
  /** Optional pre-set centre (used by /treasure/settings when editing). */
  initialLat?: number;
  initialLng?: number;
  title?: string;
  confirmLabel?: string;
};

export default function BTMapPicker({
  onConfirm,
  initialRadius = 800,
  initialLat,
  initialLng,
  title = 'Pick where you’re hunting',
  confirmLabel = 'Confirm location & area',
}: Props) {
  const mapRef = useRef<BTLeafletMapHandle | null>(null);
  // Centre is initially Australia OR the caller-provided value; it gets
  // overridden by the GPS result once the permission resolves.
  const [centre, setCentre] = useState<LatLng>(() => ({
    lat: typeof initialLat === 'number' ? initialLat : AUS_INITIAL.lat,
    lng: typeof initialLng === 'number' ? initialLng : AUS_INITIAL.lng,
  }));
  const [radius, setRadius] = useState<number>(initialRadius);
  const [gpsLoading, setGpsLoading] = useState<boolean>(typeof initialLat !== 'number');
  const [permNote, setPermNote] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // GPS auto-locate — only runs when the caller didn't pre-set a centre.
  useEffect(() => {
    if (typeof initialLat === 'number') {
      setGpsLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cur = await Location.getForegroundPermissionsAsync();
        let granted = cur.status === 'granted';
        if (!granted && cur.canAskAgain) {
          const r = await Location.requestForegroundPermissionsAsync();
          granted = r.status === 'granted';
        }
        if (!granted) {
          if (!cancelled) {
            setPermNote(
              cur.canAskAgain === false
                ? 'Location is blocked — tap the map to drop a pin.'
                : 'Allow Location to auto-drop your pin, or tap the map.',
            );
            setGpsLoading(false);
          }
          return;
        }
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCentre(next);
        setGpsLoading(false);
        // Recenter the WebView once it's ready. If the map isn't yet
        // mounted we just rely on the `mapReady` effect below.
        mapRef.current?.setCenter(next.lat, next.lng, 14);
      } catch (e: any) {
        if (!cancelled) {
          setPermNote('Could not get your location — tap the map to drop a pin.');
          setGpsLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push slider changes into the WebView circle.
  useEffect(() => {
    if (mapReady) mapRef.current?.setRadius(radius);
  }, [radius, mapReady]);

  // When the WebView signals ready AFTER we already received GPS, jump
  // straight to street zoom. This fixes a race where the map mounted
  // before the GPS resolved.
  useEffect(() => {
    if (mapReady && !gpsLoading && centre.lat !== AUS_INITIAL.lat) {
      mapRef.current?.setCenter(centre.lat, centre.lng, 14);
      mapRef.current?.setRadius(radius);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  const onCentreChange = useCallback((c: LatLng) => {
    setCentre(c);
  }, []);

  const onLocateMe = useCallback(async () => {
    setGpsLoading(true);
    setPermNote(null);
    try {
      const cur = await Location.getForegroundPermissionsAsync();
      let granted = cur.status === 'granted';
      if (!granted && cur.canAskAgain) {
        const r = await Location.requestForegroundPermissionsAsync();
        granted = r.status === 'granted';
      }
      if (!granted) {
        setPermNote(
          cur.canAskAgain === false
            ? 'Location is blocked. Open Settings to allow it.'
            : 'Permission denied — tap the map to drop a pin.',
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setCentre(next);
      mapRef.current?.setCenter(next.lat, next.lng, 14);
    } catch (e: any) {
      setPermNote(String(e?.message || e));
    } finally {
      setGpsLoading(false);
    }
  }, []);

  const initialZoom = useMemo(
    () => (typeof initialLat === 'number' ? 14 : AUS_INITIAL.zoom),
    [initialLat],
  );

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.mapBox}>
        <BTLeafletMap
          ref={mapRef}
          mode="picker"
          initialLat={centre.lat}
          initialLng={centre.lng}
          initialZoom={initialZoom}
          initialRadius={radius}
          onCenterChange={onCentreChange}
          onReady={() => setMapReady(true)}
          style={StyleSheet.absoluteFill}
        />
        {/* Locate-me FAB */}
        <TouchableOpacity
          onPress={onLocateMe}
          activeOpacity={0.85}
          style={styles.fab}
          testID="bt-locate-me"
        >
          {gpsLoading ? (
            <ActivityIndicator color={colors.cyan} size="small" />
          ) : (
            <Ionicons name="locate" size={20} color={colors.cyan} />
          )}
        </TouchableOpacity>
      </View>

      {permNote ? (
        <View style={styles.note}>
          <Ionicons name="information-circle" size={14} color={colors.amber} />
          <Text style={styles.noteText}>{permNote}</Text>
        </View>
      ) : null}

      <View style={styles.controls}>
        <View style={styles.row}>
          <Ionicons name="resize" size={16} color={colors.cyan} />
          <Text style={styles.controlsLabel}>Hunt area</Text>
          <Text style={styles.controlsValue}>{fmtRadius(radius)}</Text>
        </View>
        <Slider
          style={{ width: '100%', height: 40 }}
          minimumValue={MIN_RADIUS}
          maximumValue={MAX_RADIUS}
          step={50}
          value={radius}
          onValueChange={setRadius}
          minimumTrackTintColor={colors.cyan}
          maximumTrackTintColor={colors.border}
          thumbTintColor={colors.cyan}
        />
        <View style={styles.row}>
          <Text style={styles.helper}>Smaller</Text>
          <Text style={[styles.helper, { textAlign: 'right' }]}>Larger</Text>
        </View>
      </View>

      <TouchableOpacity
        style={styles.confirmBtn}
        activeOpacity={0.85}
        onPress={() =>
          onConfirm({ lat: centre.lat, lng: centre.lng, radius_m: radius })
        }
        testID="bt-confirm-area"
      >
        <Ionicons name="checkmark-circle" size={20} color="#0b0f15" />
        <Text style={styles.confirmText}>{confirmLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

const { width } = Dimensions.get('window');

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'center',
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  mapBox: {
    width: '100%',
    height: Math.min(420, width * 1.0),
    backgroundColor: '#1a1d22',
    position: 'relative',
  },
  fab: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#0b0f15EE',
    borderWidth: 1,
    borderColor: colors.cyan + '88',
    alignItems: 'center',
    justifyContent: 'center',
  },
  note: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: spacing.md, paddingVertical: 8,
    backgroundColor: '#FFB02011',
    borderBottomWidth: 1,
    borderColor: '#FFB02033',
  },
  noteText: { color: colors.amber, fontSize: 11, flex: 1 },
  controls: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  controlsLabel: { color: colors.text, fontWeight: '800', flex: 1, marginLeft: 4 },
  controlsValue: { color: colors.cyan, fontWeight: '900' },
  helper: { color: colors.textMuted, fontSize: 10, flex: 1 },
  confirmBtn: {
    backgroundColor: colors.cyan,
    margin: spacing.md,
    borderRadius: radii.lg,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  confirmText: { color: '#0b0f15', fontWeight: '900', fontSize: 14, letterSpacing: 0.4 },
});
