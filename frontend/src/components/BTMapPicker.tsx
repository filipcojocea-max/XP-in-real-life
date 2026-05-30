/**
 * <BTMapPicker /> — Buried Treasure location + radius picker.
 *
 * Renders the player's current GPS pin plus an adjustable blue radius
 * circle on a Google Map. A slider lets them stretch the radius from
 * 100 m up to 25 km. When the user confirms we return {lat, lng,
 * radius_m} to the caller.
 *
 * The actual map ships from `react-native-maps` via the shared MapShim
 * so it lights up on iOS / Android. On the web preview we still render
 * a non-map fallback (the MapShim.web variant) so this component never
 * crashes the bundle there.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import MapView, { Circle, Marker, IS_WEB_PLACEHOLDER } from './MapShim';
import { colors, radii, spacing } from '../theme';
import { showAlert } from '../uiAlert';

const MIN_RADIUS = 100;     // metres
const MAX_RADIUS = 25_000;  // metres

const fmtRadius = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;

export type BTAreaPicked = { lat: number; lng: number; radius_m: number };

type Props = {
  onConfirm: (area: BTAreaPicked) => void;
  initialRadius?: number;
  title?: string;
  confirmLabel?: string;
};

export default function BTMapPicker({
  onConfirm,
  initialRadius = 800,
  title = 'Select what location you’re at',
  confirmLabel = 'Confirm location & area',
}: Props) {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [loadingGPS, setLoadingGPS] = useState(true);
  const [radius, setRadius] = useState(initialRadius);
  const [permError, setPermError] = useState<string | null>(null);
  const mapRef = useRef<any>(null);

  const fetchGPS = async () => {
    setLoadingGPS(true);
    setPermError(null);
    try {
      // Check existing perm first so we don't double-prompt.
      const cur = await Location.getForegroundPermissionsAsync();
      let granted = cur.status === 'granted';
      if (!granted && cur.canAskAgain) {
        const r = await Location.requestForegroundPermissionsAsync();
        granted = r.status === 'granted';
      }
      if (!granted) {
        setPermError(
          cur.canAskAgain === false
            ? "Location is blocked. Open Settings to allow Location for this app."
            : "Allow Location to drop your pin on the map.",
        );
        setLoadingGPS(false);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    } catch (e: any) {
      setPermError(String(e?.message || e));
    } finally {
      setLoadingGPS(false);
    }
  };

  useEffect(() => {
    fetchGPS();
  }, []);

  // Re-fit the map whenever the radius changes so the entire circle
  // stays in view as the user drags the slider.
  useEffect(() => {
    if (!mapRef.current || !coords || IS_WEB_PLACEHOLDER) return;
    // 1° latitude  ≈ 111_320 m so we convert the radius to a degree
    // delta with a small zoom-out factor so the ring isn't flush with
    // the screen edge.
    const latDelta = (radius / 111_320) * 3.2;
    try {
      mapRef.current.animateToRegion(
        {
          latitude: coords.lat,
          longitude: coords.lng,
          latitudeDelta: latDelta,
          longitudeDelta: latDelta,
        },
        400,
      );
    } catch {
      // Some platforms don't support animateToRegion before first layout
    }
  }, [radius, coords]);

  const initialRegion = useMemo(() => {
    if (!coords) return undefined;
    const latDelta = (radius / 111_320) * 3.2;
    return {
      latitude: coords.lat,
      longitude: coords.lng,
      latitudeDelta: latDelta,
      longitudeDelta: latDelta,
    };
  }, [coords]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadingGPS) {
    return (
      <View style={styles.fill}>
        <ActivityIndicator color={colors.cyan} />
        <Text style={styles.status}>Finding your location…</Text>
      </View>
    );
  }

  if (permError || !coords) {
    return (
      <View style={styles.fill}>
        <Ionicons name="location-outline" size={40} color={colors.amber} />
        <Text style={[styles.status, { color: colors.amber, marginTop: 12 }]}>{permError || 'Location unavailable.'}</Text>
        <TouchableOpacity onPress={fetchGPS} style={styles.retryBtn}>
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.mapBox}>
        <MapView
          ref={mapRef as any}
          style={StyleSheet.absoluteFill}
          initialRegion={initialRegion as any}
          showsUserLocation
          showsMyLocationButton={Platform.OS === 'android'}
        >
          <Marker
            coordinate={{ latitude: coords.lat, longitude: coords.lng }}
            title="You are here"
            pinColor="#22D3EE"
          />
          <Circle
            center={{ latitude: coords.lat, longitude: coords.lng }}
            radius={radius}
            strokeColor="#22D3EE"
            strokeWidth={2}
            fillColor="rgba(34, 211, 238, 0.18)"
          />
        </MapView>
      </View>

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
          onConfirm({ lat: coords.lat, lng: coords.lng, radius_m: radius })
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
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8, backgroundColor: colors.bg },
  status: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
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
    backgroundColor: '#1d2126',
  },
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
  retryBtn: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.cyan,
  },
  retryText: { color: colors.cyan, fontWeight: '800' },
});
