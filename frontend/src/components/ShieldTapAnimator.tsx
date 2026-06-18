/**
 * <ShieldTapAnimator />
 *
 * Wraps the level-shield that sits INSIDE the Home XP progress ring
 * and adds two interaction effects driven by the user's spec:
 *
 *   ─── TAP ────────────────────────────────────────────────────────
 *   • The shield spins ~3 full rotations over 1.5 s with a smooth
 *     ease-out so the artwork lands upright.
 *   • While spinning, ~18 particles in the shield's CURRENT tier
 *     colours (fill + outline mixed) fan OUTWARD fast, fast enough
 *     that they stay within the XP-ring boundary (capped at
 *     `ringRadius - particle/2`). Each particle has a soft glow trail
 *     in its own colour and fades to 0 over the duration.
 *
 *   ─── HOLD (long-press) ──────────────────────────────────────────
 *   • While held: the shield gently scales down to ~88% so the user
 *     gets tactile feedback that the hold is registered.
 *   • Particles spawn continuously at a low rate and drift slowly
 *     outward — capped at the same ring boundary so they never escape.
 *   • On release: the active particles snap back TOWARD the shield
 *     centre over ~240 ms and disappear behind it.
 *   • Immediately after that retraction: a smaller, bright-yellow
 *     SHIELD-SHAPED burst expands outward from the centre, fades over
 *     400 ms, and stays inside the ring.
 *   • The shield then pops back to 100 % scale with a soft spring.
 *
 * Colour sourcing is automatic: `getShieldTapColors(level)` already
 * returns the active tier's body + rim hues — the same function the
 * SVG itself uses — so when the player levels up the burst auto-adapts
 * on the very next interaction with NO manual config.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { getShieldTapColors } from './PremiumShield';

type Props = {
  /** Level used to look up the active tier colours. */
  level: number;
  /** Square footprint of the wrapped shield (e.g. 110 px on Home). */
  size: number;
  /** Diameter of the surrounding XP ring (e.g. 260 px on Home). Used
   * to cap particle travel so they never escape the ring boundary. */
  ringDiameter: number;
  /** Disable taps entirely (e.g. while a parent screen is read-only). */
  disabled?: boolean;
  children: React.ReactNode;
};

// ─── Tunables (spec-driven) ──────────────────────────────────────
const SPIN_DURATION_MS = 1500;             // user spec: 1.5 s
const SPIN_DEG = 1080;                     // 3 full rotations
const TAP_PARTICLE_COUNT = 18;
const TAP_PARTICLE_DURATION_MS = 1500;     // fly outward + fade matches spin
const HOLD_SCALE = 0.88;                   // shield shrinks while held
const HOLD_PARTICLE_LIFETIME_MS = 900;
const HOLD_SPAWN_INTERVAL_MS = 110;
const RETRACT_DURATION_MS = 240;
const BURST_DURATION_MS = 420;
// Reserve a tiny gutter so particles never visually clip the ring stroke.
const RING_INNER_GUTTER = 6;
// Slim down particles a notch so high-count bursts stay crisp.
const PARTICLE_SIZE_MIN = 3;
const PARTICLE_SIZE_MAX = 8;

type Particle = {
  key: string;
  angle: number;     // radians, outward direction
  distance: number;  // px from centre at peak
  curl: number;      // -1..1 sideways bend mid-flight
  sizePx: number;
  color: string;
  delay: number;     // ms — staggers individual particle starts
};

/** Build a fresh batch of tap-burst particles. `maxRadius` is the cap
 *  from centre (already accounts for the ring stroke + particle size). */
function buildTapParticles(colors: string[], maxRadius: number, seed: number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < TAP_PARTICLE_COUNT; i++) {
    const base = (i / TAP_PARTICLE_COUNT) * Math.PI * 2;
    const jitter = (Math.random() - 0.5) * (Math.PI / TAP_PARTICLE_COUNT) * 1.4;
    // 80–100 % of max radius so the burst feels strong and consistently
    // close to (but never past) the ring edge.
    const reach = maxRadius * (0.82 + Math.random() * 0.18);
    out.push({
      key: `t-${seed}-${i}`,
      angle: base + jitter,
      distance: reach,
      curl: (Math.random() - 0.5) * 0.5,
      sizePx: PARTICLE_SIZE_MIN + Math.random() * (PARTICLE_SIZE_MAX - PARTICLE_SIZE_MIN),
      color: colors[i % colors.length],
      delay: Math.random() * 60,
    });
  }
  return out;
}

/** Single hold particle. Tracks its own Animated values so we can
 *  drive each one's outward drift + retract on release. */
type HoldParticle = {
  key: string;
  color: string;
  sizePx: number;
  angle: number;
  maxDistance: number;
  progress: Animated.Value;   // 0 → 1 outward, then back to 0 on release
  opacity: Animated.Value;
  spawnedAt: number;
};

export default function ShieldTapAnimator({
  level,
  size,
  ringDiameter,
  disabled,
  children,
}: Props) {
  // Re-evaluate colours whenever the level changes so a level-up
  // tap instantly pulls the new tier's hues.
  const colors = useMemo(() => getShieldTapColors(level), [level]);

  // Cap any particle's reach so it stays inside the ring. We subtract
  // the ring stroke + half-particle so even the largest particle's
  // FAR edge sits flush with the inner ring boundary.
  const ringRadius = ringDiameter / 2;
  const maxParticleReach = Math.max(
    size * 0.55,
    ringRadius - PARTICLE_SIZE_MAX / 2 - RING_INNER_GUTTER,
  );

  // Shield transforms — native-driven for 60 fps.
  const spin = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const burstProgress = useRef(new Animated.Value(0)).current;

  // Tap-burst state — list refreshed on every tap so finished particles
  // don't get re-driven by the next sweep.
  const [tapParticles, setTapParticles] = useState<Particle[]>([]);
  const tapSeed = useRef(0);

  // Hold-burst state — particles spawn while held; on release each one
  // retracts. We keep them in component state so the renderer reacts.
  const [holdParticles, setHoldParticles] = useState<HoldParticle[]>([]);
  const holdingRef = useRef(false);
  const spawnTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Release-time shield burst (yellow shield-shaped flash).
  const burstScale = useRef(new Animated.Value(0)).current;
  const burstOpacity = useRef(new Animated.Value(0)).current;
  const burstActive = useRef(false);

  // ─── TAP ────────────────────────────────────────────────────────
  const onTap = useCallback(() => {
    if (disabled) return;
    // If the gesture started as a long-press, the press-out handler
    // will have already cleared holdingRef. A late tap event arriving
    // after a hold should NOT re-spin — the hold's release flow plays
    // its own burst.
    if (holdingRef.current) return;

    // Reset transforms so a rapid double-tap blends cleanly.
    spin.setValue(0);
    scale.setValue(1);
    burstProgress.setValue(0);

    tapSeed.current += 1;
    setTapParticles(buildTapParticles(colors, maxParticleReach, tapSeed.current));

    Animated.parallel([
      // 3 rotations over 1.5 s, easing out for a smooth landing.
      Animated.timing(spin, {
        toValue: 1,
        duration: SPIN_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      // Subtle scale pulse so the shield "punches" briefly at start.
      Animated.sequence([
        Animated.spring(scale, {
          toValue: 1.08,
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
      // Particles — fast initial acceleration (easing.out) so they
      // clear the shield quickly, then drift out and fade.
      Animated.timing(burstProgress, {
        toValue: 1,
        duration: TAP_PARTICLE_DURATION_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [disabled, colors, maxParticleReach, spin, scale, burstProgress]);

  // ─── HOLD (start) ──────────────────────────────────────────────
  const startHold = useCallback(() => {
    if (disabled) return;
    holdingRef.current = true;

    // Shield shrinks slightly while held.
    Animated.spring(scale, {
      toValue: HOLD_SCALE,
      friction: 7,
      tension: 90,
      useNativeDriver: true,
    }).start();

    // Spawn a particle on a steady interval. Each spawned particle
    // owns its own Animated values so it can survive a release event
    // and retract independently.
    spawnTimerRef.current = setInterval(() => {
      if (!holdingRef.current) return;
      const id = Math.random().toString(36).slice(2, 9);
      const angle = Math.random() * Math.PI * 2;
      const reach = maxParticleReach * (0.7 + Math.random() * 0.25);
      const colorIdx = Math.floor(Math.random() * colors.length);
      const p: HoldParticle = {
        key: `h-${id}`,
        color: colors[colorIdx],
        sizePx:
          PARTICLE_SIZE_MIN +
          Math.random() * (PARTICLE_SIZE_MAX - PARTICLE_SIZE_MIN),
        angle,
        maxDistance: reach,
        progress: new Animated.Value(0),
        opacity: new Animated.Value(0),
        spawnedAt: Date.now(),
      };
      // Fade in fast, then drift outward slowly.
      Animated.parallel([
        Animated.timing(p.opacity, {
          toValue: 0.95,
          duration: 140,
          useNativeDriver: true,
        }),
        Animated.timing(p.progress, {
          toValue: 1,
          duration: HOLD_PARTICLE_LIFETIME_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();

      setHoldParticles((prev) => [...prev, p]);

      // Auto-cull particles that finished their drift before release.
      setTimeout(() => {
        if (!holdingRef.current) return;
        Animated.timing(p.opacity, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }).start(() => {
          setHoldParticles((prev) => prev.filter((q) => q.key !== p.key));
        });
      }, HOLD_PARTICLE_LIFETIME_MS - 80);
    }, HOLD_SPAWN_INTERVAL_MS);
  }, [disabled, colors, maxParticleReach, scale]);

  /** Yellow shield-shaped burst that expands from the centre after the
   *  hold particles have retracted. Kept inside the ring (max 1.6×
   *  shield size, well under the ring radius).
   *  Defined BEFORE endHold so its identifier exists in scope when
   *  endHold's useCallback evaluates its dependency array (otherwise
   *  TDZ → "Cannot access 'fireShieldBurst' before initialization"). */
  const fireShieldBurst = useCallback(() => {
    burstActive.current = true;
    burstScale.setValue(0.3);
    burstOpacity.setValue(0);
    Animated.parallel([
      Animated.timing(burstScale, {
        toValue: 1,
        duration: BURST_DURATION_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.timing(burstOpacity, {
          toValue: 0.85,
          duration: 90,
          useNativeDriver: true,
        }),
        Animated.timing(burstOpacity, {
          toValue: 0,
          duration: BURST_DURATION_MS - 90,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    ]).start(() => {
      burstActive.current = false;
    });
  }, [burstScale, burstOpacity]);

  // ─── HOLD (release) ────────────────────────────────────────────
  const endHold = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;

    // Stop spawning further particles.
    if (spawnTimerRef.current) {
      clearInterval(spawnTimerRef.current);
      spawnTimerRef.current = null;
    }

    // Snapshot current particles so we can retract them. After
    // retraction they're cleared from state below.
    setHoldParticles((current) => {
      current.forEach((p) => {
        Animated.parallel([
          // Drive progress BACK to 0 so each particle returns toward
          // centre. We don't stop the previous tween — the new tween
          // takes precedence (same Animated.Value identity).
          Animated.timing(p.progress, {
            toValue: 0,
            duration: RETRACT_DURATION_MS,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: true,
          }),
          // Fade slightly before being hidden behind the shield.
          Animated.timing(p.opacity, {
            toValue: 0,
            duration: RETRACT_DURATION_MS,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
        ]).start();
      });

      // After retraction, clear and then fire the yellow shield burst.
      setTimeout(() => {
        setHoldParticles([]);
        fireShieldBurst();
      }, RETRACT_DURATION_MS + 20);

      return current;
    });

    // Shield pops back to 100 % with a soft bounce.
    Animated.spring(scale, {
      toValue: 1,
      friction: 5,
      tension: 180,
      useNativeDriver: true,
    }).start();
  }, [scale, fireShieldBurst]);

  // Clean up the spawn interval if we unmount mid-hold.
  useEffect(() => {
    return () => {
      if (spawnTimerRef.current) {
        clearInterval(spawnTimerRef.current);
        spawnTimerRef.current = null;
      }
    };
  }, []);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', `${SPIN_DEG}deg`],
  });

  // The shield-burst SVG renders fully inside `size * 1.6` so it
  // stays comfortably inside the ring even at the largest scale.
  const burstSize = size * 1.6;

  return (
    <Pressable
      onPress={onTap}
      onLongPress={startHold}
      onPressOut={endHold}
      delayLongPress={220}
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
        {/* Tap-burst particles — driven by single shared progress. */}
        {tapParticles.map((p) => {
          const tx = burstProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [0, Math.cos(p.angle) * p.distance + p.curl * 10],
          });
          const ty = burstProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [0, Math.sin(p.angle) * p.distance - Math.abs(p.curl) * 6],
          });
          // Stay full-opacity through the punch, then fade.
          const op = burstProgress.interpolate({
            inputRange: [0, 0.18, 1],
            outputRange: [1, 1, 0],
          });
          const sc = burstProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0.35],
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

        {/* Hold particles — each one has its own driver so it can
            keep drifting while others retract. */}
        {holdParticles.map((p) => {
          const tx = p.progress.interpolate({
            inputRange: [0, 1],
            outputRange: [0, Math.cos(p.angle) * p.maxDistance],
          });
          const ty = p.progress.interpolate({
            inputRange: [0, 1],
            outputRange: [0, Math.sin(p.angle) * p.maxDistance],
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
                  shadowColor: p.color,
                  shadowOffset: { width: 0, height: 0 },
                  shadowOpacity: 0.8,
                  shadowRadius: 4,
                  opacity: p.opacity,
                  transform: [
                    { translateX: tx },
                    { translateY: ty },
                  ],
                },
              ]}
            />
          );
        })}

        {/* Release-burst: yellow shield silhouette expanding outward.
            Rendered behind the actual shield so it reads as a flash
            erupting OUT of the shield. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.burstWrap,
            {
              width: burstSize,
              height: burstSize,
              opacity: burstOpacity,
              transform: [{ scale: burstScale }],
            },
          ]}
        >
          <Svg width={burstSize} height={burstSize} viewBox="0 0 100 100">
            {/* Generic shield silhouette — matches the visual mass of
                PremiumShield well enough at this size. Fill = bright
                yellow energy, stroke = soft golden rim. */}
            <Path
              d="M50 6 L88 18 L88 50 C88 72 70 88 50 94 C30 88 12 72 12 50 L12 18 Z"
              fill="#FFEB3B"
              fillOpacity={0.85}
              stroke="#FFD700"
              strokeWidth={3}
              strokeOpacity={0.9}
            />
          </Svg>
        </Animated.View>

        {/* The shield itself — rotated + scaled, artwork untouched. */}
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
  particle: {
    position: 'absolute',
  },
  burstWrap: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
