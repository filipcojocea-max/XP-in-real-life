/**
 * LevelUpReviewModal
 *
 * Triggered exactly ONCE per qualifying level milestone (L2..L6 by
 * default — see useLevelUpDetector). Shows three optional CTAs:
 *
 *   1. Rate us on Play Store / App Store
 *      → launches expo-store-review's official OS-managed dialog.
 *        We never see the user's review text — it goes straight to
 *        the store. Once they tap our "Rate us" button we set
 *        `play_store_review_clicked: true` on the profile so we never
 *        re-prompt them about the store again (Apple/Google guideline:
 *        do not nag once they've had their chance).
 *
 *   2. Tip the Creator (external link → Stripe / Ko-fi)
 *      → opens the URL in the system browser. Avoids in-app purchase
 *        store fees + sidesteps PCI scope. Tip is optional and never
 *        re-prompted.
 *
 *   3. In-app feedback (rating + free-text)
 *      → POSTs to /api/feedback. Once submitted, the per-modal
 *        feedback section is hidden on subsequent levels.
 *
 * The modal closes on dismiss "Maybe later" — milestone is still
 * marked as "shown" so we don't re-trigger the SAME level-up event
 * twice (only the next milestone, e.g. L4 if they were on L3).
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
} from 'react-native';
import * as StoreReview from 'expo-store-review';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radii } from '../theme';
import { api } from '../api';

// External tip URL — set as a constant for now; can be moved to a
// backend config later. Ko-fi keeps fees lowest (no platform cut).
export const CREATOR_TIP_URL = 'https://ko-fi.com/xpinreallife';

export function LevelUpReviewModal({
  visible,
  level,
  hasSubmittedFeedback,
  hasClickedPlayStoreReview,
  onClose,
}: {
  visible: boolean;
  level: number;
  hasSubmittedFeedback: boolean;
  hasClickedPlayStoreReview: boolean;
  onClose: (opts: { feedbackSubmitted?: boolean; storeReviewClicked?: boolean }) => void;
}) {
  const [rating, setRating] = useState<number>(5);
  const [text, setText] = useState<string>('');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackOk, setFeedbackOk] = useState(false);

  const launchStoreReview = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    try {
      const isAvailable = await StoreReview.isAvailableAsync();
      if (isAvailable) {
        // Native dialog — user types in the OS-managed UI. We never
        // see the content. Apple silently caps to 3/year regardless of
        // how often we call this.
        await StoreReview.requestReview();
      } else {
        // Fallback: open the store listing directly (web preview /
        // unsupported builds).
        const fallback = StoreReview.storeUrl();
        if (fallback) Linking.openURL(fallback).catch(() => {});
      }
    } catch (e) {
      console.warn('[review] requestReview failed', e);
    }
    // Mark as clicked locally + on backend so we never re-prompt.
    try {
      await api.markLevelMilestoneShown(level, true);
    } catch (e) {
      console.warn('[review] mark milestone failed', e);
    }
    onClose({ storeReviewClicked: true });
  };

  const openTipLink = () => {
    Haptics.selectionAsync().catch(() => {});
    Linking.openURL(CREATOR_TIP_URL).catch(() => {});
    // Tip is fire-and-forget — don't close the modal so user can still
    // submit feedback / tap Rate.
  };

  const submitFeedback = async () => {
    if (rating < 1 || rating > 5) return;
    setSubmittingFeedback(true);
    try {
      await api.submitFeedback({
        rating,
        text: text.trim().slice(0, 1000),
        level_at_submit: level,
        platform: Platform.OS,
      });
      setFeedbackOk(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      // Brief success state, then close.
      setTimeout(() => {
        onClose({ feedbackSubmitted: true });
      }, 900);
    } catch (e) {
      console.warn('[feedback] submit failed', e);
    } finally {
      setSubmittingFeedback(false);
    }
  };

  const dismiss = async () => {
    // Mark milestone as "shown" but DON'T set the play_store_review
    // flag — user dismissed without rating, we may try at the next
    // milestone. Backend records the milestone in level_milestones_shown.
    try { await api.markLevelMilestoneShown(level, false); } catch {}
    onClose({});
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={dismiss}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.backdrop}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.card} testID="level-up-review-modal">
            {/* Hero header */}
            <View style={styles.heroIcon}>
              <Ionicons name="trophy" size={42} color={colors.green} />
            </View>
            <Text style={styles.heroTitle}>You reached Level {level}!</Text>
            <Text style={styles.heroSub}>
              You're crushing it. Spare 30 seconds to help the app grow?
            </Text>

            {/* CTA 1 — Rate on Play Store (skip if already clicked) */}
            {!hasClickedPlayStoreReview ? (
              <TouchableOpacity
                testID="levelup-rate-store"
                onPress={launchStoreReview}
                style={[styles.ctaBtn, { borderColor: colors.green + '88', backgroundColor: colors.green + '15' }]}
                activeOpacity={0.85}
              >
                <Ionicons name="star" size={20} color={colors.green} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.ctaTitle, { color: colors.green }]}>
                    Rate us on the {Platform.OS === 'ios' ? 'App Store' : 'Play Store'}
                  </Text>
                  <Text style={styles.ctaSub}>
                    Opens the official store dialog — takes 10 seconds.
                  </Text>
                </View>
                <Ionicons name="open-outline" size={16} color={colors.green} />
              </TouchableOpacity>
            ) : null}

            {/* CTA 2 — Tip the creator */}
            <TouchableOpacity
              testID="levelup-tip-creator"
              onPress={openTipLink}
              style={[styles.ctaBtn, { borderColor: '#FFD70088', backgroundColor: '#FFD70015' }]}
              activeOpacity={0.85}
            >
              <Ionicons name="heart" size={20} color="#FFD700" />
              <View style={{ flex: 1 }}>
                <Text style={[styles.ctaTitle, { color: '#FFD700' }]}>
                  Tip the Creator (optional)
                </Text>
                <Text style={styles.ctaSub}>
                  Pick any amount on Ko-fi — 100% goes to the dev.
                </Text>
              </View>
              <Ionicons name="open-outline" size={16} color="#FFD700" />
            </TouchableOpacity>

            {/* CTA 3 — In-app feedback (skip if already submitted) */}
            {!hasSubmittedFeedback ? (
              <View style={styles.feedbackBlock}>
                <Text style={styles.feedbackLabel}>Or share private feedback</Text>
                <View style={styles.starsRow}>
                  {[1, 2, 3, 4, 5].map((n) => {
                    const filled = n <= rating;
                    return (
                      <TouchableOpacity
                        key={n}
                        testID={`feedback-star-${n}`}
                        onPress={() => {
                          setRating(n);
                          Haptics.selectionAsync().catch(() => {});
                        }}
                        hitSlop={6}
                        style={{ padding: 4 }}
                      >
                        <Ionicons
                          name={filled ? 'star' : 'star-outline'}
                          size={28}
                          color={filled ? colors.cyan : colors.textMuted}
                        />
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TextInput
                  testID="feedback-text"
                  value={text}
                  onChangeText={setText}
                  placeholder="What's working? What can we improve? (optional)"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  maxLength={1000}
                  style={styles.textInput}
                />
                <TouchableOpacity
                  testID="feedback-submit"
                  onPress={submitFeedback}
                  disabled={submittingFeedback || feedbackOk}
                  style={[
                    styles.submitBtn,
                    { backgroundColor: feedbackOk ? colors.green : colors.cyan },
                    submittingFeedback && { opacity: 0.5 },
                  ]}
                  activeOpacity={0.85}
                >
                  {submittingFeedback ? (
                    <ActivityIndicator color={colors.bg} size="small" />
                  ) : feedbackOk ? (
                    <>
                      <Ionicons name="checkmark" size={16} color={colors.bg} />
                      <Text style={styles.submitBtnText}>Thanks!</Text>
                    </>
                  ) : (
                    <Text style={styles.submitBtnText}>Submit Feedback</Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : null}

            {/* Dismiss — always available */}
            <TouchableOpacity
              testID="levelup-dismiss"
              onPress={dismiss}
              style={styles.dismissBtn}
              activeOpacity={0.7}
            >
              <Text style={styles.dismissText}>Maybe later</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  heroIcon: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: colors.green + '22',
    borderWidth: 1, borderColor: colors.green + '88',
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  heroTitle: { color: colors.text, fontSize: 22, fontWeight: '900', textAlign: 'center', letterSpacing: -0.5 },
  heroSub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 4, lineHeight: 18 },
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 14,
    borderRadius: radii.md, borderWidth: 1,
    marginTop: spacing.md,
  },
  ctaTitle: { fontSize: 14, fontWeight: '900', letterSpacing: 0.2 },
  ctaSub: { color: colors.textSecondary, fontSize: 11, marginTop: 2, lineHeight: 14 },

  feedbackBlock: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  feedbackLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textAlign: 'center' },
  starsRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.xs, marginTop: spacing.sm },
  textInput: {
    backgroundColor: colors.bg, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 12, fontSize: 13,
    marginTop: spacing.sm,
    minHeight: 70,
    textAlignVertical: 'top',
  },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, marginTop: spacing.sm,
    borderRadius: radii.pill,
  },
  submitBtnText: { color: colors.bg, fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
  dismissBtn: { paddingVertical: 12, marginTop: spacing.md, alignItems: 'center' },
  dismissText: { color: colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
});
