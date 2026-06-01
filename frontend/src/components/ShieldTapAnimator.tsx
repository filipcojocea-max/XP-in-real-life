/**
 * <ShieldTapAnimator />
 *
 * Wraps the Profile Shield (or any child) with a satisfying tap / click
 * animation sequence:
 *
 *   1. Pulse-and-spin — child scales to 110%, then snaps back to 100%
 *      while simultaneously spinning ~1.5 rotations over ~320 ms with a
 *      cubic ease-out so the rotation lands cleanly instead of just
 *      stopping dead.
 *   2. Particle burst — 14 small dots in the shield's CURRENT tier
 *      colors fan out in a circle, each with a randomised speed, size
 *      and slight curl so the burst feels organic instead of mechanical.
 *      Each particle has a soft glow-shadow that acts as a short trail
 *      tint, fades to 0 opacity over 450 ms, and shrinks to 30%.
 *   3. Halo flash — a brief radial glow in the tier's primary color
 *      ramps up over ~120 ms and decays over ~280 ms.
 *
 * Color sourcing is automatic: the component asks <PremiumShield/>
 * (via `getShieldTapColors`) what the player's current tier looks
 * like and mixes those 2–4 hues into the burst. No manual config —
 * a Lv 25 user gets blue + gold particles, a Lv 200 user gets gold
 * + cream + white, the Creator account gets the brighter gold mix,
 * etc.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { getShieldTapColors } from './PremiumShield';

type Props = {
  /** Level used to look up the active tier colors. */
  level: number;
  /** Footprint of the wrapped shield (square). The particle radius
   *  scales off this. */
  size: number;
  /** Disable taps entirely (e.g. while a parent screen is read-only). */
  disabled?: boolean;
  children: React.ReactNode;
};

const PARTICLE_COUNT = 14;
const SPIN_DURATION_MS = 320;
const PARTICLE_DURATION_MS = 470;
const HALO_IN_MS = 120;
const HALO_OUT_MS = 290;
// Two rotations of the shield. 540° = 1.5 full turns which lands
// the artwork upright at the end (matching the user's "1–1.5 rotations"
// spec) and feels snappier than a strict 360°.
const SPIN_DEG = 540;

type Particle = {
  key: string;
  angle: number;     // radians
  distance: number;  // px from center at peak
  curl: number;      // -1..1 sideways bend mid-flight
  sizePx: number;    // 3..10
  color: string;
  delay: number;     // ms — staggers individual particle starts
};

function buildParticles(colors: string[], size: number, seed: number): Particle[] {
  // Distribute particles around a full circle with light angular
  // jitter so two adjacent particles never spawn perfectly back-to-back.
  const list: Particle[] = [];
  const radius = size * 0.65;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const base = (i / PARTICLE_COUNT) * Math.PI * 2;
    const jitter = (Math.random() - 0.5) * (Math.PI / PARTICLE_COUNT);
    const speed = 0.72 + Math.random() * 0.55; // 0.72..1.27 — speed variation
    const sizePx = 3 + Math.random() * 7;       // 3..10 — size variation
    const curl = (Math.random() - 0.5) * 0.7;   // arc instead of pure radial
    list.push({
      key: `p-${seed}-${i}`,
      angle: base + jitter,
      distance: radius * speed,
      curl,
      sizePx,
      color: colors[i % colors.length],
      delay: Math.random() * 35, // 0..35 ms stagger
    });
  }
  return list;
}

export default function ShieldTapAnimator({
  level,
  size,
  disabled,
  children,
}: Props) {
  const colors = useMemo(() => getShieldTapColors(level), [level]);

  // Shield transform values — driven by useNativeDriver for 60fps.
  const spin = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  // Halo opacity — JS-driven because shadowOpacity isn't native-driver
  // compatible on iOS for boxShadow either way.
  const haloOpacity = useRef(new Animated.Value(0)).current;
  // Single shared particle progress (0 → 1) lets us drive ALL 14
  // particles from one Animated.Value via interpolation instead of
  // spawning 14 separate animations — much lighter on the JS bridge.
  const burstProgress = useRef(new Animated.Value(0)).current;

  // Particle list is regenerated on every tap so randomness feels
  // fresh and so previously-completed particles don't get re-driven
  // by the next tap's burstProgress sweep.
  const [particles, setParticles] = useState<Particle[]>([]);
  const tapCount = useRef(0);

  const onTap = useCallback(() => {
    if (disabled) return;

    // Reset all drivers so a rapid double-tap doesn't blend halfway-
    // animated transforms into the new sequence.
    spin.setValue(0);
    scale.setValue(1);
    haloOpacity.setValue(0);
    burstProgress.setValue(0);

    tapCount.current += 1;
    setParticles(buildParticles(colors, size, tapCount.current));

    Animated.parallel([
      // Pulse: snap up to 110% then settle. Spring for organic bounce
      // — friction tuned so it doesn't oscillate visibly past 1.0.
      Animated.sequence([
        Animated.spring(scale, {
          toValue: 1.1,
          friction: 5,
          tension: 220,
          useNativeDriver: true,
        }),
        Animated.spring(scale, {
          toValue: 1,
          friction: 6,
          tension: 160,
          useNativeDriver: true,
        }),
      ]),
      // Spin: 1.5 rotations with cubic ease-out so the landing feels
      // decisive but not abrupt.
      Animated.timing(spin, {
        toValue: 1,
        duration: SPIN_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      // Halo flash — quick fade-in then a slightly slower fade-out so
      // the brightest moment lines up with the start of the burst.
      Animated.sequence([
        Animated.timing(haloOpacity, {
          toValue: 0.85,
          duration: HALO_IN_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.timing(haloOpacity, {
          toValue: 0,
          duration: HALO_OUT_MS,
          easing: Easing.in(Easing.quad),
          useNativeDriver: false,
        }),
      ]),
      // Particle burst — single shared progress, individual particles
      // interpolate against it.
      Animated.timing(burstProgress, {
        toValue: 1,
        duration: PARTICLE_DURATION_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [disabled, colors, size, spin, scale, haloOpacity, burstProgress]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', `${SPIN_DEG}deg`],
  });

  const primary = colors[0] || '#22D3EE';

  return (
    <Pressable
      onPress={onTap}
      onLongPress={onTap}
      hitSlop={10}
      style={styles.touchable}
      android_ripple={null}
      accessibilityRole="button"
      accessibilityLabel="Activate profile shield animation"
      testID="shield-tap-target"
    >
      <View
        style={[styles.frame, { width: size, height: size }]}
        pointerEvents="box-none"
      >
        {/* Halo flash — sits behind the shield, slightly larger. We use
            a tinted opaque circle inside a transparent wrapper rather
            than shadow* so it renders identically on iOS, Android and
            web. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            {
              width: size * 1.45,
              height: size * 1.45,
              borderRadius: size,
              opacity: haloOpacity,
              backgroundColor: primary,
            },
          ]}
        />

        {/* Particles. Each one interpolates its position, opacity and
            scale from the shared `burstProgress` driver so the JS bridge
            sees a single tween instead of 14. */}
        {particles.map((p) => {
          const tx = burstProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [
              0,
              Math.cos(p.angle) * p.distance + p.curl * 12,
            ],
          });
          const ty = burstProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [
              0,
              Math.sin(p.angle) * p.distance - Math.abs(p.curl) * 6,
            ],
          });
          // Particles stay opaque for ~25% of their flight then fade
          // — so the burst reads as a "punch" rather than ramping
          // down from the very first frame.
          const op = burstProgress.interpolate({
            inputRange: [0, 0.25, 1],
            outputRange: [1, 1, 0],
          });
          const sc = burstProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0.3],
          });
          return (
            <Animated.View
              key={p.key}
              pointerEvents="none"
              style={[
                styles.particle,
                {
                  width: p.sizePx,
                  height: p.sizePx,
                  borderRadius: p.sizePx / 2,
                  backgroundColor: p.color,
                  // Trail tint — soft, short, color-matched.
                  shadowColor: p.color,
                  shadowOffset: { width: 0, height: 0 },
                  shadowOpacity: 0.85,
                  shadowRadius: 4,
                  opacity: op,
                  transform: [
                    { translateX: tx },
                    { translateY: ty },
                    { scale: sc },
                  ],
                },
              ]}
            />
          );
        })}

        {/* The shield itself. We do NOT change shape, colors or rim —
            just rotate + scale the entire wrapper so the artwork is
            preserved 1:1. */}
        <Animated.View
          style={{
            transform: [{ rotate }, { scale }],
          }}
        >
          {children}
        </Animated.View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  touchable: { alignSelf: 'center' },
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    // Tint comes from `backgroundColor` set inline so we never need
    // to repaint the stylesheet when the user levels up.
  },
  particle: {
    position: 'absolute',
  },
});
