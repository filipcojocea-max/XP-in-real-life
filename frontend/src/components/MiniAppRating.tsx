/**
 * MiniAppRating — reusable rating UI for Library+ mini-app cards.
 *
 * Two pieces:
 *   1. <MiniAppRatingStrip>
 *      Vertical 5-star column shown on the LEFT side of every featured
 *      mini-app card. Stars are rendered top-to-bottom; filled count
 *      reflects the current AVERAGE (rounded to nearest half-star).
 *      Beneath the stars: reviewer count ("12") and the average ("4.5").
 *      Tapping the strip fires `onPress` so the parent can open the
 *      rating modal — and crucially, taps DO NOT propagate up to the
 *      surrounding card's TouchableOpacity because we use a nested
 *      Pressable that claims the responder.
 *
 *   2. <RateMiniAppModal>
 *      Centered modal that lets the user pick 1-5 stars and submit.
 *      Pre-selects their existing rating (so they can edit).
 *
 * Why two components instead of one stateful blob?
 *   The strip is rendered N times in the Library tab, but only one
 *   modal is ever open at a time. Decoupling lets the parent screen
 *   own the modal state + a single submit handler.
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radii } from '../theme';

/** Server stats payload as returned by GET/POST /api/library/ratings. */
export type MiniAppRatingStats = {
  average: number;        // 0-5, two decimals
  count: number;          // total reviewer count
  user_rating: number | null; // caller's rating, null if never rated
};

// ────────────────────────────────────────────────────────────────────
// Vertical 5-star column for the left side of each mini-app card.
// ────────────────────────────────────────────────────────────────────

export function MiniAppRatingStrip({
  stats,
  tint = colors.amber,
  onPress,
  testID,
}: {
  stats: MiniAppRatingStats | null | undefined;
  tint?: string;
  onPress: () => void;
  testID?: string;
}) {
  const avg = stats?.average ?? 0;
  const count = stats?.count ?? 0;
  const userRated = (stats?.user_rating ?? null) != null;

  // Render 5 stars stacked vertically. Each star is "full" if its
  // index (1..5) is <= rounded average. We render half-stars when the
  // average's fractional part is >= 0.25 and < 0.75 — anything outside
  // that band rounds to a full or empty star for cleaner visuals.
  const stars: ('full' | 'half' | 'empty')[] = [];
  for (let i = 1; i <= 5; i++) {
    if (avg >= i - 0.25) stars.push('full');
    else if (avg >= i - 0.75) stars.push('half');
    else stars.push('empty');
  }

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      hitSlop={6}
      // Claim the touch responder so parent <TouchableOpacity> doesn't
      // also fire and navigate the user away when they tap a star.
      onStartShouldSetResponder={() => true}
      style={({ pressed }) => [
        styles.stripWrap,
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={styles.starsCol}>
        {stars.map((s, i) => (
          <Ionicons
            key={i}
            name={s === 'full' ? 'star' : s === 'half' ? 'star-half' : 'star-outline'}
            size={14}
            color={s === 'empty' ? colors.textMuted : tint}
            style={{ marginVertical: 1 }}
          />
        ))}
      </View>
      <View style={styles.statsBlock}>
        {count > 0 ? (
          <>
            <Text style={[styles.avgText, { color: tint }]}>{avg.toFixed(1)}</Text>
            <Text style={styles.countText}>{count} {count === 1 ? 'review' : 'reviews'}</Text>
          </>
        ) : (
          <Text style={styles.emptyText}>No reviews</Text>
        )}
        <View style={[styles.actionPill, userRated ? { borderColor: tint + '88', backgroundColor: tint + '15' } : null]}>
          <Ionicons
            name={userRated ? 'pencil' : 'add'}
            size={9}
            color={userRated ? tint : colors.textMuted}
          />
          <Text style={[styles.actionText, userRated ? { color: tint } : null]}>
            {userRated ? 'EDIT' : 'RATE'}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

// ────────────────────────────────────────────────────────────────────
// 1-5 star picker modal.
// ────────────────────────────────────────────────────────────────────

export function RateMiniAppModal({
  visible,
  appLabel,
  tint = colors.amber,
  initialStars = null,
  submitting = false,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  appLabel: string;
  tint?: string;
  initialStars?: number | null;
  submitting?: boolean;
  onCancel: () => void;
  onSubmit: (stars: number) => void;
}) {
  const [picked, setPicked] = useState<number>(initialStars || 5);

  // Re-sync on open so re-rating shows the user's existing value.
  useEffect(() => {
    if (visible) setPicked(initialStars || 5);
  }, [visible, initialStars]);

  const choose = (n: number) => {
    setPicked(n);
    if (Platform.OS !== 'web') {
      Haptics.selectionAsync().catch(() => {});
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={[styles.modalAccent, { backgroundColor: tint + '22', borderColor: tint + '88' }]}>
            <Ionicons name="star" size={28} color={tint} />
          </View>
          <Text style={styles.modalTitle}>Rate {appLabel}</Text>
          <Text style={styles.modalSub}>
            {initialStars
              ? `You rated this ${initialStars}/5 — tap to change.`
              : 'How many stars would you give this mini-app?'}
          </Text>

          <View style={styles.modalStarsRow}>
            {[1, 2, 3, 4, 5].map((n) => {
              const filled = n <= picked;
              return (
                <TouchableOpacity
                  key={n}
                  testID={`rate-star-${n}`}
                  activeOpacity={0.7}
                  onPress={() => choose(n)}
                  hitSlop={6}
                  style={styles.modalStarBtn}
                >
                  <Ionicons
                    name={filled ? 'star' : 'star-outline'}
                    size={36}
                    color={filled ? tint : colors.textMuted}
                  />
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={[styles.modalPickedLabel, { color: tint }]}>
            {picked} {picked === 1 ? 'star' : 'stars'}
          </Text>

          <View style={styles.modalBtnRow}>
            <TouchableOpacity
              testID="rate-cancel"
              activeOpacity={0.85}
              onPress={onCancel}
              disabled={submitting}
              style={[styles.modalBtn, styles.modalBtnGhost]}
            >
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="rate-submit"
              activeOpacity={0.85}
              onPress={() => onSubmit(picked)}
              disabled={submitting}
              style={[styles.modalBtn, { backgroundColor: tint }, submitting && { opacity: 0.5 }]}
            >
              {submitting ? (
                <ActivityIndicator color={colors.bg} size="small" />
              ) : (
                <Text style={styles.modalBtnPrimaryText}>Submit Rating</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────
// Styles
// ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Vertical strip on the LEFT of each mini-app card. Width is kept
  // narrow (~44px) so the rest of the card layout barely shifts.
  stripWrap: {
    width: 44,
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 2,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.06)',
    marginRight: 4,
  },
  starsCol: { alignItems: 'center', marginBottom: 4 },
  statsBlock: { alignItems: 'center', gap: 2 },
  avgText: { fontSize: 13, fontWeight: '900', letterSpacing: -0.3 },
  countText: { color: colors.textMuted, fontSize: 9, fontWeight: '700', textAlign: 'center' },
  emptyText: { color: colors.textMuted, fontSize: 9, fontWeight: '700', textAlign: 'center' },
  actionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginTop: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  actionText: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },

  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.78)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
  },
  modalAccent: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: '900', textAlign: 'center', letterSpacing: -0.3 },
  modalSub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 4, lineHeight: 18 },
  modalStarsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
    justifyContent: 'center',
  },
  modalStarBtn: { padding: 4 },
  modalPickedLabel: { fontSize: 14, fontWeight: '900', marginTop: spacing.sm, letterSpacing: 0.5 },
  modalBtnRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
    width: '100%',
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalBtnGhostText: { color: colors.textSecondary, fontWeight: '800', fontSize: 13 },
  modalBtnPrimaryText: { color: colors.bg, fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
});
