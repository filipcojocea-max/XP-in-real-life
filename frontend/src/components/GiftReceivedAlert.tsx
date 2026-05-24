/**
 * GiftReceivedAlert — golden full-screen modal shown to a recipient
 * the FIRST TIME they open the app after the Creator/Admin sent them
 * a gift.
 *
 * The component periodically polls /api/gifts/pending; when a non-empty
 * list comes back it pops up the gold-bordered congratulations card
 * and walks the user through each unacknowledged gift one by one.
 * Tapping "Awesome — claim it" calls /api/gifts/ack and removes that
 * entry from the queue.
 *
 * Mounted globally inside _layout.tsx so the alert always shows over
 * whatever screen the user lands on.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, AppState } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, GiftEntry } from '../api';
import { useAuth } from '../AuthContext';
import { colors, spacing, radii } from '../theme';

const GOLD = '#FFD700';

export function GiftReceivedAlert() {
  const { token } = useAuth();
  const [queue, setQueue] = useState<GiftEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const isFetching = useRef(false);

  const fetchPending = useCallback(async () => {
    if (!token || isFetching.current) return;
    isFetching.current = true;
    try {
      const r = await api.giftsPending();
      if (r.gifts && r.gifts.length > 0) {
        setQueue(r.gifts);
      }
    } catch {
      // 401 / 403 / suspension — silently ignore
    } finally {
      isFetching.current = false;
    }
  }, [token]);

  // Initial fetch + on app foreground + every 60s
  useEffect(() => {
    if (!token) return;
    fetchPending();
    const id = setInterval(fetchPending, 60_000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') fetchPending();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [token, fetchPending]);

  const current = queue[0];
  if (!current) return null;

  async function claim() {
    setBusy(true);
    try {
      await api.giftsAck(current.id);
    } catch {
      // server unavailable — still drop locally so user can dismiss
    }
    setQueue((q) => q.slice(1));
    setBusy(false);
  }

  const isXP = current.kind === 'xp';
  const giftIcon = isXP ? 'flash' : 'rocket';
  const giftLine = isXP
    ? `${current.amount.toLocaleString()} XP Points`
    : `${current.boost_label || 'Bonus Top-Up'}`;
  const subLine = isXP
    ? 'Already added to your total XP.'
    : 'Available in your Points+ inventory now.';

  return (
    <Modal visible animationType="fade" transparent onRequestClose={() => { /* must claim */ }}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconRing}>
            <Ionicons name="gift" size={42} color={GOLD} />
          </View>
          <Text style={styles.title}>Congratulations!</Text>
          <Text style={styles.subtitle}>You have received gifts from {current.from_name || 'Creator/Admin'}!</Text>

          <View style={styles.divider} />

          <View style={styles.giftBlock}>
            <View style={styles.giftIconWrap}>
              <Ionicons name={giftIcon as any} size={28} color={GOLD} />
            </View>
            <Text style={styles.giftMain}>{giftLine}</Text>
            <Text style={styles.giftSub}>{subLine}</Text>
          </View>

          {current.message ? (
            <View style={styles.messageBox}>
              <Text style={styles.messageLabel}>MESSAGE</Text>
              <Text style={styles.messageText}>"{current.message}"</Text>
            </View>
          ) : null}

          {queue.length > 1 ? (
            <Text style={styles.moreHint}>+ {queue.length - 1} more gift{queue.length - 1 === 1 ? '' : 's'} after this</Text>
          ) : null}

          <TouchableOpacity
            testID="gift-claim"
            onPress={claim}
            disabled={busy}
            style={styles.cta}
            activeOpacity={0.85}
          >
            <Ionicons name="sparkles" size={16} color={colors.bg} />
            <Text style={styles.ctaText}>Awesome — claim it</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
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
    width: 80, height: 80, borderRadius: 40,
    borderWidth: 2, borderColor: GOLD,
    backgroundColor: GOLD + '22',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: { color: GOLD, fontSize: 24, fontWeight: '900', letterSpacing: 0.8, textAlign: 'center' },
  subtitle: { color: GOLD, fontSize: 13, fontWeight: '700', textAlign: 'center', marginTop: 6, lineHeight: 18 },
  divider: { width: '60%', height: 1, backgroundColor: GOLD + '55', marginVertical: spacing.md },
  giftBlock: { alignItems: 'center', gap: 4 },
  giftIconWrap: {
    width: 60, height: 60, borderRadius: 30,
    borderWidth: 1, borderColor: GOLD + '88',
    backgroundColor: GOLD + '15',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 6,
  },
  giftMain: { color: GOLD, fontSize: 20, fontWeight: '900' },
  giftSub: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  messageBox: {
    width: '100%', marginTop: spacing.md,
    padding: 12,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1, borderColor: GOLD + '55',
  },
  messageLabel: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginBottom: 4 },
  messageText: { color: colors.text, fontSize: 13, lineHeight: 18, fontStyle: 'italic' },
  moreHint: { color: GOLD + 'BB', fontSize: 11, marginTop: spacing.sm },
  cta: {
    marginTop: spacing.lg,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingHorizontal: 22, paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: GOLD,
  },
  ctaText: { color: colors.bg, fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },
});
