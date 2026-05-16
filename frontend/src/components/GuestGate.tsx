/**
 * Guest-Gate — small helper used to block actions that require a real
 * (signed-in) account when the user is in guest / anonymous mode.
 *
 * Usage:
 *
 *   const guard = useGuestGate();
 *
 *   // In any onPress handler that requires a real account:
 *   onPress={guard(() => sendFriendRequest(p))}
 *
 *   // Or imperatively (returns true if the action was blocked):
 *   if (guard.block('Add friend')) return;
 *   await sendFriendRequest(p);
 *
 * When blocked, the helper shows a single, consistent modal across the
 * app explaining that the action requires sign-in, with a CTA that
 * routes to /auth/login. The text and CTA target are deliberately
 * uniform so the user always sees the same brand of message.
 */
import React, { useCallback, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAuth } from '../AuthContext';
import { colors, spacing, radii } from '../theme';

// ────────────────────────────────────────────────────────────────────
// Global singleton so any call site can summon the same modal without
// each one having to render its own copy. The <GuestGateHost/> at the
// root of the app subscribes; useGuestGate() pokes the subscriber.
// ────────────────────────────────────────────────────────────────────
let showHost: ((title?: string) => void) | null = null;

export function GuestGateHost() {
  const [visible, setVisible] = useState(false);
  const [actionLabel, setActionLabel] = useState<string | undefined>();

  React.useEffect(() => {
    showHost = (title?: string) => {
      setActionLabel(title);
      setVisible(true);
    };
    return () => {
      showHost = null;
    };
  }, []);

  const onSignIn = () => {
    setVisible(false);
    // Route to login. The user's anon-id is preserved until signIn()
    // is called, so when they come back signed-in their progress will
    // be offered for migration after onboarding.
    setTimeout(() => router.push('/auth/login'), 50);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => setVisible(false)}
    >
      <View style={styles.backdrop}>
        <View style={styles.card} testID="guest-gate-modal">
          <View style={styles.iconWrap}>
            <Ionicons name="lock-closed" size={28} color={colors.amber} />
          </View>
          <Text style={styles.kicker}>SIGN-IN REQUIRED</Text>
          <Text style={styles.title}>
            Can&apos;t {actionLabel || 'view players'} until you sign in /
            register your account
          </Text>
          <Text style={styles.body}>
            You&apos;re currently playing as a guest. Create a free account (or
            sign back in) to unlock the social side of XP in Real Life — your
            progress so far stays on this device.
          </Text>
          <TouchableOpacity
            onPress={onSignIn}
            style={styles.btnPrimary}
            activeOpacity={0.85}
            testID="guest-gate-signin"
          >
            <Ionicons name="log-in" size={18} color={colors.bg} />
            <Text style={styles.btnPrimaryText}>Sign in / register</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setVisible(false)}
            style={styles.btnGhost}
            activeOpacity={0.7}
            testID="guest-gate-dismiss"
          >
            <Text style={styles.btnGhostText}>Maybe later</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────
// Hook — returns a callable that wraps any user action.
// • `guard(fn, 'add a friend')` — returns a wrapped function; when the
//   user is anonymous, the modal shows and the wrapped fn is NOT run.
// • `guard.block('add a friend')` — imperative variant; returns `true`
//   when the action was blocked (caller should early-return).
// ────────────────────────────────────────────────────────────────────
export type GuestGuard = {
  /** Wrap an onPress so it auto-blocks for anonymous users. */
  <F extends (...args: any[]) => any>(fn: F, label?: string): F;
  /** Imperative — returns true if the action should NOT proceed. */
  block: (label?: string) => boolean;
  isAnonymous: boolean;
};

export function useGuestGate(): GuestGuard {
  const { isAnonymous } = useAuth();

  const block = useCallback(
    (label?: string): boolean => {
      if (!isAnonymous) return false;
      try {
        showHost && showHost(label);
      } catch {
        /* ignore — host not mounted yet */
      }
      return true;
    },
    [isAnonymous],
  );

  const guard = useCallback(
    (<F extends (...args: any[]) => any>(fn: F, label?: string): F => {
      return ((...args: any[]) => {
        if (block(label)) return undefined as any;
        return fn(...args);
      }) as F;
    }),
    [block],
  );

  // Attach `.block` + `.isAnonymous` to the function so callers get
  // both styles without two hook variants.
  (guard as any).block = block;
  (guard as any).isAnonymous = isAnonymous;
  return guard as unknown as GuestGuard;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.amber + '66',
    padding: spacing.lg,
    alignItems: 'center',
    gap: 6,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
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
    fontSize: 18,
    fontWeight: '900',
    textAlign: 'center',
    marginTop: 4,
    letterSpacing: -0.2,
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
  },
});
