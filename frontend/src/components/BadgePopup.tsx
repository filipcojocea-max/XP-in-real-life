/**
 * BadgePopup — global celebratory modal that appears whenever the
 * backend reports `newly_unlocked_achievements`. Mounted once in
 * `app/_layout.tsx`. Subscribes to the `badgeEvents` pub/sub and
 * queues each new badge so multiple unlocks (e.g. one task hits 10
 * tasks AND a 3-day streak) show in sequence rather than overlapping.
 *
 * Each badge type has its own encouraging text that comes from the
 * backend's `ACHIEVEMENT_DEFS`. We cache the achievement metadata on
 * first show so subsequent unlocks don't re-fetch.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, Achievement } from '../api';
import { subscribeNewBadges } from '../badgeEvents';
import { colors, radii, spacing } from '../theme';

export function BadgePopup() {
  const [queue, setQueue] = useState<string[]>([]);
  const [current, setCurrent] = useState<Achievement | null>(null);
  const cacheRef = useRef<Record<string, Achievement>>({});
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Subscribe to newly-unlocked badge events from anywhere in the app.
  useEffect(() => {
    return subscribeNewBadges((ids) => {
      setQueue((q) => [...q, ...ids]);
    });
  }, []);

  // Drain the queue one badge at a time.
  useEffect(() => {
    if (current || queue.length === 0) return;
    const [nextId, ...rest] = queue;
    setQueue(rest);
    (async () => {
      try {
        // Use cached metadata if we've shown this badge type before in
        // this session; otherwise fetch the full list.
        let meta = cacheRef.current[nextId];
        if (!meta) {
          const r = await api.achievements();
          r.achievements.forEach((a) => {
            cacheRef.current[a.id] = a;
          });
          meta = cacheRef.current[nextId];
        }
        if (meta) setCurrent(meta);
      } catch {
        /* if metadata fetch fails, skip silently — no half-popup */
      }
    })();
  }, [queue, current]);

  // Entrance animation whenever a new `current` arrives.
  useEffect(() => {
    if (!current) return;
    scaleAnim.setValue(0);
    fadeAnim.setValue(0);
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 5,
        tension: 80,
        useNativeDriver: true,
      }),
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
  }, [current, scaleAnim, fadeAnim]);

  // ── Long-press to dismiss (2026-05-30 spec) ──────────────────────
  // The "Collect this badge" CTA now requires a deliberate 2-second
  // hold to close the popup. This prevents accidental dismissals (e.g.
  // tapping through a Continue button when scrolling rapidly through
  // task completions) and gives the celebratory animation room to
  // breathe. We also drop the backdrop tap-to-dismiss so the only way
  // out is the explicit long-press on the CTA.
  const HOLD_MS = 2000;
  const [holdProgress, setHoldProgress] = useState(0);
  const holdAnim = useRef(new Animated.Value(0)).current;

  const dismiss = useCallback(() => {
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start(() => {
      setCurrent(null);
      // Reset hold state for the next badge in the queue.
      setHoldProgress(0);
      holdAnim.setValue(0);
    });
  }, [fadeAnim, holdAnim]);

  const onPressIn = useCallback(() => {
    setHoldProgress(0.001);   // kick the bar into view immediately
    holdAnim.setValue(0);
    Animated.timing(holdAnim, {
      toValue: 1,
      duration: HOLD_MS,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) {
        // 2 seconds elapsed without release → collect.
        dismiss();
      }
    });
  }, [holdAnim, dismiss]);

  const onPressOut = useCallback(() => {
    // Cancel the in-flight animation if the user lifts early.
    holdAnim.stopAnimation((value: number) => {
      if (value < 1) {
        setHoldProgress(0);
        holdAnim.setValue(0);
      }
    });
  }, [holdAnim]);

  // Track the animated value so we can render a progress bar inside
  // the CTA. addListener fires up to 60 fps so this stays smooth.
  useEffect(() => {
    const id = holdAnim.addListener(({ value }) => setHoldProgress(value));
    return () => holdAnim.removeListener(id);
  }, [holdAnim]);

  if (!current) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={() => { /* hardware back is a no-op — must hold the CTA */ }}
      testID="badge-popup"
    >
      <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]}>
        {/* Backdrop is intentionally NOT a TouchableOpacity any more.
            Per 2026-05-30 spec the only way to close the popup is the
            2-second hold on "Collect this badge". */}
        <Animated.View
          style={[
            styles.card,
            { transform: [{ scale: scaleAnim }] },
          ]}
        >
          <Text style={styles.bannerLabel}>NEW BADGE UNLOCKED</Text>
          <View style={styles.iconWrap}>
            <Ionicons name={current.icon as any} size={64} color="#FFD700" />
          </View>
          <Text style={styles.title} testID="badge-popup-title">
            {current.title}
          </Text>
          <Text style={styles.encouraging} testID="badge-popup-text">
            {(current as any).encouraging_text || current.description}
          </Text>
          <Text style={styles.descSubtle}>{current.description}</Text>
          {/* Hold-to-collect CTA. The fill bar inside the pill animates
              from 0→100% over 2 s. Releasing early resets it. */}
          <TouchableOpacity
            style={styles.cta}
            onPressIn={onPressIn}
            onPressOut={onPressOut}
            activeOpacity={0.85}
            testID="badge-popup-close"
            delayPressIn={0}
          >
            <View
              pointerEvents="none"
              style={[
                styles.ctaFill,
                { width: `${Math.min(100, Math.round(holdProgress * 100))}%` },
              ]}
            />
            <Text style={styles.ctaText}>
              {holdProgress > 0 ? 'Hold…' : 'Collect this badge'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.ctaHint}>Press and hold for 2 seconds to collect</Text>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.surfaceGlass,
    borderRadius: radii.lg,
    borderWidth: 2,
    borderColor: '#FFD700',
    paddingVertical: 28,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    shadowColor: '#FFD700',
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  bannerLabel: {
    color: '#FFD700',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.6,
    marginBottom: 14,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#FFD70022',
    borderWidth: 2,
    borderColor: '#FFD70066',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 0.3,
    marginBottom: 8,
    textAlign: 'center',
  },
  encouraging: {
    color: '#FFD700',
    fontSize: 16,
    fontWeight: '700',
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: 8,
  },
  descSubtle: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 20,
  },
  cta: {
    backgroundColor: '#FFD700',
    borderRadius: radii.pill,
    paddingHorizontal: 36,
    paddingVertical: 14,
    overflow: 'hidden',
    position: 'relative',
    minWidth: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The cyan progress strip that fills the CTA pill from left → right
  // as the user holds the button. Rendered behind the label via absolute
  // positioning; pointerEvents=none on the View so the press stays on
  // the parent TouchableOpacity.
  ctaFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#22C55E',
    opacity: 0.55,
  },
  ctaText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  ctaHint: {
    color: colors.textMuted,
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 10,
    textAlign: 'center',
  },
});
