/**
 * GuestProgressMigrationHost — sits at the root and watches the auth
 * state. When a user transitions from guest mode to a real signed-in
 * account AND has finished onboarding, it pops a modal asking whether
 * to import their guest progress into the new account.
 *
 * Flow:
 *   1. Guest plays for a while as user_id="anon-{xpAnonId}".
 *   2. Guest registers / signs in → AuthContext.signIn() stashes the
 *      old anon id under PENDING_MIGRATION_KEY (preserved across the
 *      onboarding screens) and exposes it as `pendingMigrationAnonId`.
 *   3. Once profile.onboarding_complete flips to true, this host shows.
 *   4. "Yes, import" → POST /api/guest/migrate {anonymous_id} →
 *      backend rewrites every collection's user-scoped fields and the
 *      banner shows "+N records imported".
 *   5. "Start fresh" → just clears the pending flag; guest data sits
 *      orphaned in the DB (cheap; we can prune later via a cron).
 *
 * Renders nothing when there's no pending migration. Re-checks every
 * time the auth state changes so it survives token refreshes.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import { colors, spacing, radii } from '../theme';

export function GuestProgressMigrationHost() {
  const { token, user, pendingMigrationAnonId, clearPendingMigration } = useAuth();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | null
    | { state: 'success'; moved: number }
    | { state: 'error'; message: string }
  >(null);
  // Once-per-pending-id guard so we don't re-show after the user dismissed.
  const handledIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!token || !user || !pendingMigrationAnonId) return;
    if (handledIds.current.has(pendingMigrationAnonId)) return;

    let cancelled = false;
    (async () => {
      try {
        // Wait until the user has finished onboarding (profile flag
        // flips to true after onboarding submit). Poll every 1.5s up
        // to ~3 min.
        for (let i = 0; i < 120; i++) {
          if (cancelled) return;
          try {
            const p = await api.profile();
            if ((p as any)?.onboarding_complete) break;
          } catch {
            /* not fatal — try again */
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (cancelled) return;

        // Cheap probe — if the anon account has no progress at all,
        // silently skip the modal and clear the pending flag so the
        // guest doesn't see a confusing "do you want to migrate
        // (nothing)?" prompt.
        try {
          const probe = await api.guestHasProgress(pendingMigrationAnonId);
          if (!probe?.has_progress) {
            handledIds.current.add(pendingMigrationAnonId);
            await clearPendingMigration();
            return;
          }
        } catch {
          /* On error fall through to showing the modal — better safe. */
        }

        if (!cancelled) {
          handledIds.current.add(pendingMigrationAnonId);
          setVisible(true);
        }
      } catch {
        /* swallow — don't break the app on a migration prompt */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, user, pendingMigrationAnonId, clearPendingMigration]);

  const onContinueGuest = async () => {
    if (!pendingMigrationAnonId) return;
    setBusy(true);
    try {
      const r = await api.guestMigrate(pendingMigrationAnonId);
      setResult({ state: 'success', moved: r.moved });
      await clearPendingMigration();
    } catch (e: any) {
      setResult({
        state: 'error',
        message: String(e?.message || e || 'Could not import guest progress.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const onStartFresh = async () => {
    setBusy(true);
    try {
      await clearPendingMigration();
      setVisible(false);
    } finally {
      setBusy(false);
    }
  };

  const onDone = () => {
    setVisible(false);
    setResult(null);
  };

  if (!visible) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!busy) onDone();
      }}
    >
      <View style={styles.backdrop}>
        <View style={styles.card} testID="guest-migration-modal">
          {result?.state === 'success' ? (
            <>
              <View style={styles.iconWrap}>
                <Ionicons name="checkmark-circle" size={36} color={colors.green} />
              </View>
              <Text style={styles.kicker}>PROGRESS IMPORTED</Text>
              <Text style={styles.title}>Welcome back, hero!</Text>
              <Text style={styles.body}>
                {result.moved}{' '}
                {result.moved === 1 ? 'record was' : 'records were'} moved from
                your guest session into this account. Carry on where you left off.
              </Text>
              <TouchableOpacity
                onPress={onDone}
                style={styles.btnPrimary}
                activeOpacity={0.85}
                testID="guest-migration-done"
              >
                <Text style={styles.btnPrimaryText}>Let&apos;s go</Text>
              </TouchableOpacity>
            </>
          ) : result?.state === 'error' ? (
            <>
              <View style={[styles.iconWrap, { borderColor: colors.red, backgroundColor: colors.red + '22' }]}>
                <Ionicons name="alert-circle" size={32} color={colors.red} />
              </View>
              <Text style={[styles.kicker, { color: colors.red }]}>IMPORT FAILED</Text>
              <Text style={styles.title}>We couldn&apos;t import your guest progress</Text>
              <Text style={styles.body}>{result.message}</Text>
              <TouchableOpacity
                onPress={onContinueGuest}
                style={styles.btnPrimary}
                activeOpacity={0.85}
                testID="guest-migration-retry"
              >
                <Text style={styles.btnPrimaryText}>Try again</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onStartFresh}
                style={styles.btnGhost}
                activeOpacity={0.7}
                testID="guest-migration-give-up"
              >
                <Text style={styles.btnGhostText}>Skip — start fresh</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <View style={styles.iconWrap}>
                <Ionicons name="save-outline" size={32} color={colors.amber} />
              </View>
              <Text style={styles.kicker}>GUEST PROGRESS DETECTED</Text>
              <Text style={styles.title}>
                Do you want to continue your progress while you were in &quot;guest
                mode&quot;?
              </Text>
              <Text style={styles.body}>
                We saved everything you did before signing in — XP, quests,
                challenges, schedules and more. Pick what to do with it now:
              </Text>
              <TouchableOpacity
                onPress={onContinueGuest}
                disabled={busy}
                style={[styles.btnPrimary, busy && { opacity: 0.5 }]}
                activeOpacity={0.85}
                testID="guest-migration-continue"
              >
                {busy ? (
                  <ActivityIndicator color={colors.bg} />
                ) : (
                  <>
                    <Ionicons name="cloud-upload" size={18} color={colors.bg} />
                    <Text style={styles.btnPrimaryText}>
                      Yes — bring my guest progress
                    </Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onStartFresh}
                disabled={busy}
                style={styles.btnGhost}
                activeOpacity={0.7}
                testID="guest-migration-fresh"
              >
                <Text style={styles.btnGhostText}>I want to start fresh</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.amber + '88',
    padding: spacing.lg,
    alignItems: 'center',
    gap: 6,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.amber + '22',
    borderWidth: 1,
    borderColor: colors.amber + '88',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  kicker: {
    color: colors.amber,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 2,
  },
  title: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '900',
    textAlign: 'center',
    marginTop: 4,
    letterSpacing: -0.2,
    lineHeight: 24,
  },
  body: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: spacing.md,
  },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.amber,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    width: '100%',
  },
  btnPrimaryText: {
    color: colors.bg,
    fontWeight: '900',
    fontSize: 14,
    letterSpacing: 0.3,
  },
  btnGhost: {
    paddingVertical: 12,
    alignItems: 'center',
    width: '100%',
  },
  btnGhostText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
});
