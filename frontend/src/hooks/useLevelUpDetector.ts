/**
 * useLevelUpDetector
 *
 * Detects when the authenticated user's level transitions UP into
 * one of the configured "milestone" levels (default 2–6). When that
 * happens AND the milestone hasn't already shown its prompt, the
 * hook flips an exposed `pendingLevelUp` value so the consumer can
 * render the LevelUpReviewModal.
 *
 * Strategy:
 *   • Polls /api/profile every 30 s (cheap call). Most XP-grant
 *     screens already poll profile too — our extra poll just acts
 *     as a fallback so a level-up never gets missed.
 *   • Maintains the previous level in a ref. The FIRST poll never
 *     triggers a modal (we don't pop one on app launch when the user
 *     is already at L4 from a previous session) — we only react to
 *     transitions that happen during this session.
 *   • Cross-checks against profile.level_milestones_shown server-side
 *     so even if the same level transition happens twice (e.g. user
 *     dismissed without rating, then quickly de-leveled and re-leveled
 *     via XP refunds), we don't double-pop.
 *   • The L2 → L1 → L2 edge-case: if the user's XP got refunded
 *     down to L1 then they re-earn back to L2, we WON'T re-prompt
 *     because L2 is already in milestones_shown.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { api } from '../api';
import { useAuth } from '../AuthContext';

export const LEVEL_REVIEW_MILESTONES: number[] = [2, 3, 4, 5, 6];
const POLL_INTERVAL_MS = 30_000;

export type LevelUpEvent = {
  level: number;
  hasSubmittedFeedback: boolean;
  hasClickedPlayStoreReview: boolean;
};

export function useLevelUpDetector(): {
  pending: LevelUpEvent | null;
  clearPending: () => void;
} {
  const { user } = useAuth();
  const [pending, setPending] = useState<LevelUpEvent | null>(null);
  const lastSeenLevelRef = useRef<number | null>(null);
  const milestonesShownRef = useRef<Set<number>>(new Set());
  const feedbackSubmittedRef = useRef<boolean>(false);
  const playStoreClickedRef = useRef<boolean>(false);

  const checkLevel = useCallback(async () => {
    try {
      const prof: any = await api.getProfile();
      const currentLevel: number = Number(prof?.level || 0);
      // Snapshot server-known milestones + flags every poll so we stay
      // in sync even across multi-device usage.
      milestonesShownRef.current = new Set(
        Array.isArray(prof?.level_milestones_shown) ? prof.level_milestones_shown.map(Number) : [],
      );
      playStoreClickedRef.current = Boolean(prof?.play_store_review_clicked);
      // Feedback submitted? — separate cheap call to keep hook
      // self-contained even when /profile doesn't expose it.
      try {
        const f = await api.feedbackMe();
        feedbackSubmittedRef.current = Boolean(f?.submitted);
      } catch { /* keep last value */ }

      const prev = lastSeenLevelRef.current;
      lastSeenLevelRef.current = currentLevel;
      if (prev == null) return; // first poll — establish baseline only
      if (currentLevel <= prev) return; // de-level / no change

      // Find the highest milestone the user crossed in this transition
      // that has NOT yet been shown. (If they leapt from L1 → L4 in one
      // big XP grant, prefer L4 — the most impressive one.)
      const crossed = LEVEL_REVIEW_MILESTONES
        .filter((m) => m > prev && m <= currentLevel)
        .filter((m) => !milestonesShownRef.current.has(m));
      if (crossed.length === 0) return;
      const target = crossed[crossed.length - 1];
      setPending({
        level: target,
        hasSubmittedFeedback: feedbackSubmittedRef.current,
        hasClickedPlayStoreReview: playStoreClickedRef.current,
      });
    } catch (e) {
      // Silent — polling shouldn't ever throw a visible error.
      // console.log('[level-detector] poll failed', e);
    }
  }, []);

  // Poll every 30 s while signed in.
  useEffect(() => {
    if (!user) {
      lastSeenLevelRef.current = null;
      setPending(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await checkLevel();
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    // Also re-check whenever the app foregrounds — catches level-ups
    // that happened while the app was backgrounded (e.g. via gifts).
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') tick();
    });
    return () => {
      cancelled = true;
      clearInterval(id);
      sub.remove();
    };
  }, [user, checkLevel]);

  const clearPending = useCallback(() => setPending(null), []);

  return { pending, clearPending };
}
