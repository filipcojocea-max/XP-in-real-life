/**
 * Duo Referral Discount components — Library+ group-buy.
 *
 * Three exports:
 *   - <SetDuoDiscountModal/>   Admin sheet to upsert/clear a duo offer.
 *   - <DuoBadge/>              Bottom-left pill on each mini-app card
 *                              showing "🎟 $X w/ N friends" + tap action.
 *   - <DuoJoinModal/>          User-facing "create or join a duo group"
 *                              flow with share, code entry, member list,
 *                              countdown, leave/cancel, and Pay button
 *                              (only enabled when status='full').
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { showAlert } from '../uiAlert';
import { colors, radii, spacing } from '../theme';
import { api } from '../api';
import type { DuoGroup, DuoOffer, LibraryAppPricing } from '../api';
import { useGuestGate } from './GuestGate';

const DUO_COLOR = '#B388FF';

function formatPrice(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function fmtRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

// ════════════════════ SetDuoDiscountModal ═════════════════════════
export function SetDuoDiscountModal({
  visible,
  appId,
  pricing,
  onClose,
  onSaved,
}: {
  visible: boolean;
  appId: string | null;
  pricing: LibraryAppPricing | null;
  onClose: () => void;
  onSaved: (next: LibraryAppPricing) => void;
}) {
  const [requiredPeople, setRequiredPeople] = useState<number>(2);
  const [priceText, setPriceText] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible && pricing) {
      setRequiredPeople(pricing.duo_offer?.required_people || 2);
      setPriceText(
        pricing.duo_offer?.discounted_price != null
          ? String(pricing.duo_offer.discounted_price)
          : '',
      );
    }
  }, [visible, pricing]);

  const onSave = useCallback(async () => {
    if (!appId) return;
    const dp = parseFloat(priceText);
    if (!isFinite(dp) || dp <= 0) {
      showAlert('Invalid price', 'Enter a discounted price greater than 0.');
      return;
    }
    if (pricing && pricing.price > 0 && dp >= pricing.price) {
      showAlert(
        'Too high',
        `Duo price must be LESS than the full price (${formatPrice(pricing.price, pricing.currency)}).`,
      );
      return;
    }
    setSaving(true);
    try {
      const r = await api.libraryDuoOfferSet(
        appId,
        requiredPeople,
        dp,
        // Default to AUD if the parent app has no explicit currency set
        // yet. The Creator can re-save the parent's pricing in another
        // currency from the "Change price" sheet to override.
        pricing?.currency || 'AUD',
      );
      onSaved({ ...(pricing as LibraryAppPricing), duo_offer: r.duo_offer });
      onClose();
    } catch (e: any) {
      showAlert('Could not save', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }, [appId, priceText, requiredPeople, pricing, onSaved, onClose]);

  const onClear = useCallback(async () => {
    if (!appId) return;
    setSaving(true);
    try {
      await api.libraryDuoOfferClear(appId);
      onSaved({ ...(pricing as LibraryAppPricing), duo_offer: null });
      onClose();
    } catch (e: any) {
      showAlert('Could not clear', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }, [appId, pricing, onSaved, onClose]);

  if (!appId) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.kicker}>CREATOR · DUO DISCOUNT</Text>
          <Text style={styles.sectionLabel}>How many people need to join?</Text>
          <View style={styles.chipsRow}>
            {[1, 2, 3, 4, 5].map((n) => {
              const active = requiredPeople === n;
              return (
                <TouchableOpacity
                  key={n}
                  testID={`duo-required-${n}`}
                  onPress={() => setRequiredPeople(n)}
                  style={[styles.chip, active && styles.chipActive]}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{n}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.sectionLabel}>Discounted price</Text>
          <View style={styles.priceRow}>
            <Text style={styles.currencyLabel}>{pricing?.currency || 'USD'}</Text>
            <TextInput
              testID="duo-price-input"
              style={styles.priceInput}
              keyboardType="decimal-pad"
              value={priceText}
              onChangeText={setPriceText}
              placeholder="e.g. 4.99"
              placeholderTextColor={colors.textMuted}
            />
            {pricing && pricing.price > 0 ? (
              <Text style={styles.helperHint}>
                Must be &lt; {formatPrice(pricing.price, pricing.currency)}
              </Text>
            ) : null}
          </View>

          <TouchableOpacity
            testID="duo-save-btn"
            onPress={onSave}
            disabled={saving}
            style={[styles.primaryBtn, saving && { opacity: 0.5 }]}
            activeOpacity={0.8}
          >
            {saving ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.primaryBtnText}>Save duo discount</Text>
            )}
          </TouchableOpacity>

          {pricing?.duo_offer ? (
            <TouchableOpacity
              testID="duo-clear-btn"
              onPress={onClear}
              style={styles.secondaryBtn}
              activeOpacity={0.7}
            >
              <Text style={styles.secondaryBtnText}>Remove duo discount</Text>
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity onPress={onClose} style={styles.cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ════════════════════ DuoBadge (mini-app card overlay) ════════════
export function DuoBadge({
  offer,
  onPress,
}: {
  offer: DuoOffer | null | undefined;
  onPress: () => void;
}) {
  if (!offer || !offer.active) return null;
  return (
    <TouchableOpacity
      testID={`duo-badge-${offer.app_id}`}
      onPress={onPress}
      activeOpacity={0.8}
      style={badgeStyles.outer}
      hitSlop={6}
    >
      <Ionicons name="people" size={10} color={DUO_COLOR} />
      <Text style={badgeStyles.priceText}>
        {formatPrice(offer.discounted_price, offer.currency)}
      </Text>
      <Text style={badgeStyles.subText}>
        w/ {offer.required_people} {offer.required_people === 1 ? 'friend' : 'friends'}
      </Text>
    </TouchableOpacity>
  );
}

// ════════════════════ DuoJoinModal ════════════════════════════════
export function DuoJoinModal({
  visible,
  appId,
  appName,
  offer,
  onClose,
  onCheckout,
}: {
  visible: boolean;
  appId: string | null;
  appName: string;
  offer: DuoOffer | null;
  onClose: () => void;
  /** Called when the group is full and the user taps "Pay". The parent
   *  opens the existing PaymentSheet with `duo_group_id` attached. */
  onCheckout: (group: DuoGroup) => void;
}) {
  const [phase, setPhase] = useState<'menu' | 'group'>('menu');
  const [group, setGroup] = useState<DuoGroup | null>(null);
  const [loading, setLoading] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [tick, setTick] = useState(Date.now());
  // Guest-gate — anonymous users can VIEW the duo offer / discount
  // badge but tapping "Start a duo group" or "Join by code" must prompt
  // them to sign in (we attribute the discount to a real user).
  const _guard = useGuestGate();
  const gateBlock = useCallback(
    (label?: string) => _guard.block(label),
    [_guard],
  );

  // Reset state when the modal is dismissed.
  useEffect(() => {
    if (!visible) {
      setPhase('menu');
      setGroup(null);
      setCodeInput('');
    }
  }, [visible]);

  // Live re-render countdown.
  useEffect(() => {
    if (!visible || !group) return;
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [visible, group]);

  // Poll group state every 5s while open so new members + payment
  // completion arrive without a manual refresh.
  useEffect(() => {
    if (!visible || !group) return;
    const id = setInterval(async () => {
      try {
        const fresh = await api.duoGet(group.group_id);
        setGroup(fresh);
      } catch {
        /* ignore */
      }
    }, 5_000);
    return () => clearInterval(id);
  }, [visible, group?.group_id]);

  // On open, try to pick up an existing group for this app so we don't
  // overwrite the host's session every time.
  useEffect(() => {
    if (!visible || !appId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.duoMy();
        if (cancelled) return;
        const active = r.groups.find(
          (g) => g.app_id === appId && (g.status === 'waiting' || g.status === 'full'),
        );
        if (active) {
          setGroup(active);
          setPhase('group');
        }
      } catch {
        /* fall through to menu */
      }
    })();
    return () => { cancelled = true; };
  }, [visible, appId]);

  const onCreate = useCallback(async () => {
    if (!appId) return;
    if (gateBlock('start a duo group')) return;
    setLoading(true);
    try {
      const g = await api.duoCreate(appId);
      setGroup(g);
      setPhase('group');
    } catch (e: any) {
      showAlert('Could not start', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [appId, gateBlock]);

  const onJoinByCode = useCallback(async () => {
    if (gateBlock('join a duo group')) return;
    const c = codeInput.trim().toUpperCase();
    if (c.length < 4) {
      showAlert('Invalid code', 'Enter the 6-character code your friend shared.');
      return;
    }
    setLoading(true);
    try {
      const g = await api.duoJoin({ code: c });
      setGroup(g);
      setPhase('group');
    } catch (e: any) {
      showAlert('Could not join', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [codeInput, gateBlock]);

  const onLeave = useCallback(async () => {
    if (!group) return;
    setLoading(true);
    try {
      const g = await api.duoLeave(group.group_id);
      setGroup(g);
      if (g.status === 'expired') {
        onClose();
      }
    } catch (e: any) {
      showAlert('Could not leave', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [group, onClose]);

  const remainingMs = useMemo(() => {
    if (!group) return 0;
    const exp = Date.parse(group.expires_at);
    return Math.max(0, exp - tick);
  }, [group, tick]);

  const shareLink = group ? `xpconfidence://duo/${group.code}` : '';
  const shareMessage = group
    ? `🎟 Join my duo on XP in Real Life for ${appName} — only ${formatPrice(group.discounted_price, group.currency)} when ${group.required_people} of us team up. Code: ${group.code}\n${shareLink}`
    : '';

  const onShare = useCallback(async () => {
    if (!group) return;
    try {
      await Share.share({ message: shareMessage });
    } catch (e: any) {
      showAlert('Could not share', String(e?.message || e));
    }
  }, [group, shareMessage]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.kicker}>DUO REFERRAL</Text>
          <Text style={styles.title}>{appName}</Text>

          {phase === 'menu' && offer ? (
            <View style={{ gap: 10 }}>
              <Text style={styles.heroSub}>
                Unlock for{' '}
                <Text style={styles.heroPrice}>
                  {formatPrice(offer.discounted_price, offer.currency)}
                </Text>{' '}
                when {offer.required_people}{' '}
                {offer.required_people === 1 ? 'friend joins' : 'friends join'}.
              </Text>

              <TouchableOpacity
                testID="duo-create-btn"
                onPress={onCreate}
                disabled={loading}
                style={[styles.primaryBtn, loading && { opacity: 0.5 }]}
                activeOpacity={0.85}
              >
                {loading ? (
                  <ActivityIndicator color={colors.bg} />
                ) : (
                  <Text style={styles.primaryBtnText}>Start a duo · share link</Text>
                )}
              </TouchableOpacity>

              <Text style={[styles.sectionLabel, { marginTop: spacing.md }]}>
                Have a code from a friend?
              </Text>
              <View style={styles.codeJoinRow}>
                <TextInput
                  testID="duo-code-input"
                  style={styles.codeInput}
                  value={codeInput}
                  onChangeText={(t) => setCodeInput(t.toUpperCase().slice(0, 8))}
                  placeholder="ABC123"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={8}
                />
                <TouchableOpacity
                  testID="duo-join-btn"
                  onPress={onJoinByCode}
                  disabled={loading}
                  style={[styles.secondaryBtn, { flex: 0 }]}
                  activeOpacity={0.85}
                >
                  <Text style={styles.secondaryBtnText}>Join</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {phase === 'group' && group ? (
            <View style={{ gap: 8 }}>
              <View style={styles.statusRow}>
                <View style={styles.progressBubble}>
                  <Text style={styles.progressNum}>
                    {group.members_count}/{group.required_people}
                  </Text>
                  <Text style={styles.progressSub}>joined</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.heroSub}>
                    {group.is_full
                      ? 'Group is full! Everyone can pay now.'
                      : 'Waiting for friends to join…'}
                  </Text>
                  <Text style={styles.expiryLine}>
                    Code <Text style={styles.codePill}>{group.code}</Text> · expires in{' '}
                    {fmtRemaining(remainingMs)}
                  </Text>
                </View>
              </View>

              <View style={styles.memberList}>
                {group.members.map((m) => (
                  <View key={m.user_id} style={styles.memberRow}>
                    <View style={styles.memberDot} />
                    <Text style={styles.memberName} numberOfLines={1}>
                      {m.name}
                    </Text>
                    {m.paid_at ? (
                      <View style={styles.paidPill}>
                        <Ionicons name="checkmark" size={9} color="#0a0a0f" />
                        <Text style={styles.paidPillText}>PAID</Text>
                      </View>
                    ) : null}
                  </View>
                ))}
              </View>

              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity
                  testID="duo-share-btn"
                  onPress={onShare}
                  style={[styles.secondaryBtn, { flex: 1 }]}
                  activeOpacity={0.85}
                >
                  <Ionicons name="share-outline" size={16} color={colors.text} />
                  <Text style={[styles.secondaryBtnText, { marginLeft: 6 }]}>Share invite</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  testID="duo-pay-btn"
                  disabled={!group.is_full || loading}
                  onPress={() => onCheckout(group)}
                  style={[
                    styles.primaryBtn,
                    { flex: 1.2 },
                    (!group.is_full || loading) && { opacity: 0.45 },
                  ]}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryBtnText}>
                    {group.is_full
                      ? `Pay ${formatPrice(group.discounted_price, group.currency)}`
                      : 'Pay (locked)'}
                  </Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity onPress={onLeave} style={styles.cancel} activeOpacity={0.7}>
                <Text style={styles.cancelText}>
                  {group.is_host ? 'Cancel duo' : 'Leave duo'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <TouchableOpacity onPress={onClose} style={styles.cancel}>
            <Text style={styles.cancelText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  handle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border, marginBottom: spacing.sm,
  },
  kicker: { color: DUO_COLOR, fontSize: 10, fontWeight: '900', letterSpacing: 2, textAlign: 'center' },
  title: { color: colors.text, fontSize: 18, fontWeight: '900', textAlign: 'center', marginTop: 2 },
  heroSub: { color: colors.text, fontSize: 13, lineHeight: 18 },
  heroPrice: { color: DUO_COLOR, fontWeight: '900' },
  sectionLabel: {
    color: colors.textMuted, fontSize: 11, fontWeight: '900',
    letterSpacing: 1.5, marginTop: 6,
  },
  chipsRow: { flexDirection: 'row', gap: 8 },
  chip: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  chipActive: { backgroundColor: DUO_COLOR + '22', borderColor: DUO_COLOR },
  chipText: { color: colors.text, fontWeight: '800' },
  chipTextActive: { color: DUO_COLOR },
  priceRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6,
    backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1,
    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 10,
  },
  currencyLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '800' },
  priceInput: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '700', paddingVertical: 8 },
  helperHint: { color: colors.textMuted, fontSize: 10 },
  primaryBtn: {
    backgroundColor: DUO_COLOR, paddingVertical: 14, alignItems: 'center',
    borderRadius: radii.md,
  },
  primaryBtnText: { color: colors.bg, fontWeight: '900', letterSpacing: 1 },
  secondaryBtn: {
    flexDirection: 'row',
    backgroundColor: 'transparent', paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center',
    borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, justifyContent: 'center',
  },
  secondaryBtnText: { color: colors.text, fontWeight: '700' },
  cancel: { paddingVertical: 12, alignItems: 'center' },
  cancelText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },

  codeJoinRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  codeInput: {
    flex: 1, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    color: colors.text, fontSize: 16, fontWeight: '800', letterSpacing: 4, textAlign: 'center',
  },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  progressBubble: {
    width: 70, height: 70, borderRadius: 35, alignItems: 'center', justifyContent: 'center',
    backgroundColor: DUO_COLOR + '22', borderWidth: 2, borderColor: DUO_COLOR,
  },
  progressNum: { color: DUO_COLOR, fontWeight: '900', fontSize: 18 },
  progressSub: { color: colors.textMuted, fontSize: 9, letterSpacing: 1, marginTop: 1 },
  expiryLine: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
  codePill: { color: DUO_COLOR, fontWeight: '900', letterSpacing: 2 },

  memberList: { marginTop: 8, gap: 6 },
  memberRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: colors.bg, borderRadius: 10,
  },
  memberDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: DUO_COLOR },
  memberName: { flex: 1, color: colors.text, fontWeight: '700' },
  paidPill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#33ff95', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  paidPillText: { color: '#0a0a0f', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
});

const badgeStyles = StyleSheet.create({
  outer: {
    // Bottom-RIGHT of the mini-app card — leaves bottom-left for the
    // PricingBadge (original full price). This keeps the two prices
    // visually separated so the duo discount reads as "the deal".
    position: 'absolute',
    bottom: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: DUO_COLOR + '22',
    borderWidth: 1,
    borderColor: DUO_COLOR + '88',
  },
  priceText: { color: DUO_COLOR, fontSize: 11, fontWeight: '900' },
  subText: { color: colors.textMuted, fontSize: 10 },
});
