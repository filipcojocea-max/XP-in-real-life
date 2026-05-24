/**
 * SuspensionAlertModal — golden full-screen alert shown when the API
 * client detects a 403 with detail.error='account_suspended'. The
 * AuthProvider stashes the suspension payload in context; this modal
 * reads it and renders a dismissible card with the time-remaining +
 * reason. On dismiss, the user is left on /auth (already signed-out by
 * the AuthProvider's suspension handler).
 */
import React from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../AuthContext';
import { colors, spacing, radii } from '../theme';

const GOLD = '#FFD700';

function formatRemaining(seconds: number | null | undefined, forever?: boolean): string {
  if (forever) return 'Until the Creator lifts it';
  if (!seconds || seconds <= 0) return 'Expired';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  if (minutes > 0) return `${minutes} minute${minutes === 1 ? '' : 's'} remaining`;
  return 'Less than 1 minute remaining';
}

export function SuspensionAlertModal() {
  const { suspension, clearSuspension } = useAuth();
  if (!suspension) return null;
  const remaining = formatRemaining(suspension.remaining_seconds ?? null, suspension.forever);
  return (
    <Modal visible animationType="fade" transparent onRequestClose={clearSuspension}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconRing}>
            <Ionicons name="warning" size={42} color={GOLD} />
          </View>
          <Text style={styles.title}>Account Suspended</Text>
          <Text style={styles.subtitle}>
            {suspension.message || 'This account has been suspended.'}
          </Text>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Ionicons name="time" size={16} color={GOLD} />
            <Text style={styles.rowLabel}>{remaining}</Text>
          </View>
          {suspension.reason ? (
            <View style={styles.reasonBox}>
              <Text style={styles.reasonLabel}>REASON</Text>
              <ScrollView style={{ maxHeight: 120 }}>
                <Text style={styles.reasonText}>{suspension.reason}</Text>
              </ScrollView>
            </View>
          ) : null}
          <Text style={styles.hint}>
            You have been signed out. You can return to the sign-in screen
            and try again once the suspension is lifted.
          </Text>
          <TouchableOpacity
            testID="suspension-alert-dismiss"
            onPress={clearSuspension}
            style={styles.cta}
            activeOpacity={0.85}
          >
            <Text style={styles.ctaText}>OK, sign me out</Text>
          </TouchableOpacity>
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
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 2,
    borderColor: GOLD,
    padding: spacing.lg,
    alignItems: 'center',
  },
  iconRing: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: GOLD,
    backgroundColor: GOLD + '22',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: {
    color: GOLD,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 1.2,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 8,
  },
  divider: {
    width: '60%',
    height: 1,
    backgroundColor: GOLD + '55',
    marginVertical: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.pill,
    backgroundColor: GOLD + '15',
    borderWidth: 1,
    borderColor: GOLD + '88',
  },
  rowLabel: { color: GOLD, fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },
  reasonBox: {
    width: '100%',
    marginTop: spacing.md,
    padding: 12,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reasonLabel: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginBottom: 4 },
  reasonText: { color: colors.text, fontSize: 13, lineHeight: 18 },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.md,
    lineHeight: 17,
  },
  cta: {
    marginTop: spacing.md,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: GOLD,
  },
  ctaText: { color: colors.bg, fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },
});
