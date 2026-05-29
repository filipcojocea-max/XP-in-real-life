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

  const dismiss = useCallback(() => {
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start(() => setCurrent(null));
  }, [fadeAnim]);

  if (!current) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={dismiss}
      testID="badge-popup"
    >
      <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={dismiss}
        />
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
          <TouchableOpacity
            style={styles.cta}
            onPress={dismiss}
            testID="badge-popup-close"
          >
            <Text style={styles.ctaText}>Continue</Text>
          </TouchableOpacity>
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
    paddingVertical: 12,
  },
  ctaText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
});
