/**
 * <BTAROverlay />
 *
 * "AR-lite" treasure indicator drawn ON TOP of the live camera feed.
 *
 * We don't use true ARKit/ARCore (those need a development build and
 * heavyweight integration). Instead we subscribe to:
 *   • The user's GPS — provided by the parent (already-watched).
 *   • The device compass heading via `expo-location.watchHeadingAsync`.
 *
 * Every tick we:
 *   1. Compute the bearing from the user to the chest.
 *   2. Subtract the device's current heading → "delta degrees" left/right.
 *   3. If |delta| ≤ HFOV/2 → render the chest icon on screen, offset
 *      horizontally proportional to (delta / (HFOV/2)) — when the camera
 *      is pointed straight at the chest the icon is centered, exactly
 *      like a Pokémon-GO overhead pin.
 *   4. If |delta| > HFOV/2 → render an edge arrow indicating "turn this
 *      way" so the user can swing the camera until the chest enters
 *      frame.
 *
 * The vertical offset is keyed to distance — as the player gets closer
 * the chest drops lower on screen (mimicking ground-anchoring) and
 * scales up. Inside the 15m find ring the chest sits centre-low and
 * pulses to indicate "you're here — take the photo".
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';

type Props = {
  /** Live device GPS — pass null until the first fix arrives. */
  gps: { lat: number; lng: number } | null;
  /** Treasure target. */
  chestLat: number;
  chestLng: number;
  /** Find-ring radius in metres (defaults to 15 m to match the
   *  /bt/solo/find server-side check). */
  findRingM?: number;
};

// Camera horizontal FOV used to map heading-delta → on-screen X offset.
// 60° is a sensible default for the rear camera on most phones; it
// gracefully tolerates a few degrees of magnetometer noise either way.
const HFOV_DEG = 60;

function _toRad(d: number) { return (d * Math.PI) / 180; }
function _toDeg(r: number) { return (r * 180) / Math.PI; }

function _haversineM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const dLat = _toRad(lat2 - lat1);
  const dLng = _toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(_toRad(lat1)) * Math.cos(_toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial-bearing from (lat1,lng1) to (lat2,lng2), in degrees clockwise
 *  from true north, 0..360. */
function _bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = _toRad(lat1);
  const φ2 = _toRad(lat2);
  const Δλ = _toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (_toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest signed delta from `a` → `b` in degrees, range -180..+180. */
function _angleDelta(a: number, b: number) {
  let d = (b - a + 540) % 360 - 180;
  if (d < -180) d += 360;
  return d;
}

export default function BTAROverlay({
  gps,
  chestLat,
  chestLng,
  findRingM = 15,
}: Props) {
  const [heading, setHeading] = useState<number | null>(null);
  // Watcher cleanup ref.
  const subRef = useRef<Location.LocationSubscription | null>(null);

  // Subscribe to the compass. expo-location handles iOS calibration
  // prompts internally; we don't need to ask for any extra permission
  // beyond the Foreground location grant the parent already obtained.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sub = await Location.watchHeadingAsync((h) => {
          if (cancelled) return;
          // Prefer trueHeading when the magnetometer is calibrated
          // (accuracy ≥ 1 means "low confidence"); otherwise fall
          // back to magHeading which is always non-null.
          const useTrue =
            typeof h.trueHeading === 'number' &&
            h.trueHeading >= 0 &&
            (h.accuracy ?? 0) <= 2;
          setHeading(useTrue ? h.trueHeading : h.magHeading);
        });
        subRef.current = sub;
      } catch {
        // Compass unavailable (web preview, simulator, broken sensor).
        // We still render distance-only feedback below.
      }
    })();
    return () => {
      cancelled = true;
      try { subRef.current?.remove(); } catch {}
    };
  }, []);

  // Pulse the chest icon when the user is inside the find ring — it's
  // a strong visual "you're here — take the photo!" cue.
  const pulse = useRef(new Animated.Value(0)).current;
  const distance = gps ? _haversineM(gps.lat, gps.lng, chestLat, chestLng) : null;
  const inRing = distance !== null && distance <= findRingM;

  useEffect(() => {
    if (!inRing) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [inRing, pulse]);

  if (!gps) {
    return (
      <View pointerEvents="none" style={styles.center}>
        <Text style={styles.hintText}>Locking GPS…</Text>
      </View>
    );
  }

  const bearingToChest = _bearingDeg(gps.lat, gps.lng, chestLat, chestLng);
  // If we have no compass yet, fall back to a static centred chest +
  // distance — better than nothing while waiting for the magnetometer.
  const delta =
    heading === null ? 0 : _angleDelta(heading, bearingToChest);
  const inFrame = Math.abs(delta) <= HFOV_DEG / 2;

  // Map delta → horizontal offset (-1..+1) inside the camera frame.
  const xNorm = Math.max(-1, Math.min(1, delta / (HFOV_DEG / 2)));

  // Vertical drop based on distance. Far → high in the sky; close →
  // ground level. Caps the icon between 25 % and 70 % of screen height.
  const distClamped = Math.max(findRingM, Math.min(120, distance ?? 60));
  const vNorm = 1 - (distClamped - findRingM) / (120 - findRingM);
  const yPct = 25 + vNorm * 45;

  // Icon scale: closer = bigger.
  const scale = inRing ? 1.4 : 0.6 + (1 - (distClamped / 120)) * 0.7;

  const pulseScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.18],
  });
  const pulseOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.85, 1],
  });

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {inFrame ? (
        <Animated.View
          style={[
            styles.chestWrap,
            {
              left: `${50 + xNorm * 38}%`,
              top: `${yPct}%`,
              transform: [{ translateX: -32 }, { translateY: -32 }, { scale }],
              opacity: pulseOpacity,
            },
          ]}
        >
          <Animated.View style={{ transform: [{ scale: pulseScale }] }}>
            <View style={styles.chestGlow}>
              <Ionicons name="cube" size={48} color="#FFD700" />
            </View>
          </Animated.View>
          <Text style={styles.chestLabel}>
            {distance !== null ? `${distance.toFixed(0)} m` : '—'}
          </Text>
        </Animated.View>
      ) : (
        // Out-of-frame: arrow on the side the user should turn toward.
        <View
          style={[
            styles.arrow,
            delta < 0 ? styles.arrowLeft : styles.arrowRight,
          ]}
        >
          <Ionicons
            name={delta < 0 ? 'arrow-back' : 'arrow-forward'}
            size={36}
            color="#FFD700"
          />
          <Text style={styles.arrowText}>
            Turn {delta < 0 ? 'left' : 'right'} · {distance !== null ? `${distance.toFixed(0)} m` : ''}
          </Text>
        </View>
      )}

      {/* Bottom status pill — keeps the user informed even if the
          compass is mis-calibrated and the icon is dancing around. */}
      <View style={styles.statusPill}>
        <Ionicons
          name={inRing ? 'flag' : 'navigate'}
          size={14}
          color={inRing ? '#22C55E' : '#FFD700'}
        />
        <Text style={styles.statusText}>
          {inRing
            ? `In ring · ${distance!.toFixed(1)} m — take the photo!`
            : `Treasure ${distance !== null ? `${distance.toFixed(0)} m` : '?'} away`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hintText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  chestWrap: {
    position: 'absolute',
    alignItems: 'center',
  },
  chestGlow: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 2,
    borderColor: '#FFD700',
    borderRadius: 32,
    shadowColor: '#FFD700',
    shadowOpacity: 0.9,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  chestLabel: {
    marginTop: 6,
    color: '#FFD700',
    fontWeight: '800',
    fontSize: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  arrow: {
    position: 'absolute',
    top: '45%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 24,
  },
  arrowLeft: { left: 16 },
  arrowRight: { right: 16 },
  arrowText: {
    color: '#FFD700',
    fontWeight: '800',
    fontSize: 12,
  },
  statusPill: {
    position: 'absolute',
    bottom: 110,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
  },
  statusText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
  },
});
