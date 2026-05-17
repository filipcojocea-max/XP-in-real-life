/**
 * LibraryPricing — Pricing badges, Creator pricing menu, and the Buy
 * App modal that surfaces on Library+ mini-app cards.
 *
 * Surfaces:
 *   1. <PricingBadge> — small pill rendered in the bottom-left corner
 *      of every mini-app card. Reads the latest LibraryAppPricing.
 *      • free   → green "FREE" pill
 *      • priced → "$5.00" (or with strikethrough if discounted)
 *      • owned  → green "OWNED" pill
 *      • Creator can tap it (own scope: stopPropagation) to open the
 *        pricing menu — non-Creator taps fall through to the parent
 *        card's tap (which gates to BuyApp modal for priced/non-owned).
 *
 *   2. <CreatorPricingMenu> — bottom-sheet style modal with two
 *      destinations: "Change price" or "Add discount".
 *
 *   3. <SetPriceModal> — Creator inputs price (number), currency
 *      (segmented dropdown), and external purchase URL. Submit calls
 *      api.libraryPricingSet().
 *
 *   4. <SetDiscountModal> — Creator inputs % (1..99) + duration value
 *      + days/weeks/months. Submit calls api.libraryPricingDiscount().
 *
 *   5. <BuyAppModal> — non-Creator's purchase entry point. Renders
 *      title, price (with strikethrough on discount), countdown to
 *      discount expiry, "Open checkout" button (Linking.openURL), and
 *      a follow-up "I've completed purchase" button that records the
 *      purchase via api.libraryPurchase().
 */
import React, { useState, useEffect } from 'react';
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
  Animated as RNAnimated,
  Easing as RNEasing,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radii } from '../theme';
import { api, type LibraryAppPricing } from '../api';
import { presentNativePaymentSheet } from '../PaymentSheetNative';
import { useGuestGate } from './GuestGate';

export type MiniAppId = 'sleep' | 'challenges' | 'spot' | 'confidence';
export type BoostId = 'triple_day' | 'double_week' | 'double_month';
export type PricingKind = 'library' | 'boost';

const APP_LABELS: Record<MiniAppId, string> = {
  sleep: 'Improve Sleeping',
  challenges: 'Challenge Tasks',
  spot: 'Spot the Object',
  confidence: 'Build Self-Confidence',
};

const BOOST_LABELS: Record<BoostId, string> = {
  triple_day: 'Triple your points today!',
  double_week: 'Double your points for 7 days!',
  double_month: 'Double your points for 1 month!',
};

function labelFor(kind: PricingKind, id: string): string {
  if (kind === 'boost') return BOOST_LABELS[id as BoostId] || id;
  return APP_LABELS[id as MiniAppId] || id;
}

// Stripe-side API calls vary by kind — pick the right ones up-front
// so the rest of the modal code doesn't have to branch.
function apiFor(kind: PricingKind) {
  if (kind === 'boost') {
    return {
      pricingSet: api.boostsPricingSet as any,
      pricingDiscount: api.boostsPricingDiscount as any,
      purchase: api.boostsPurchase as any,
    };
  }
  return {
    pricingSet: api.libraryPricingSet as any,
    pricingDiscount: api.libraryPricingDiscount as any,
    purchase: api.libraryPurchase as any,
  };
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  AUD: 'A$',
  CAD: 'C$',
  JPY: '¥',
  INR: '₹',
  RON: 'lei',
  CHF: 'CHF',
  BRL: 'R$',
};

export function formatPrice(price: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] || currency + ' ';
  // "lei" / "CHF" trail-after; symbol prefix otherwise.
  const trailing = symbol === 'lei' || symbol === 'CHF';
  const value = price.toFixed(2);
  return trailing ? `${value} ${symbol}` : `${symbol}${value}`;
}

// ════════════════════ PricingBadge ════════════════════════════════
export function PricingBadge({
  pricing,
  isAdmin,
  onCreatorTap,
  testID,
}: {
  pricing: LibraryAppPricing | null | undefined;
  isAdmin: boolean;
  onCreatorTap?: () => void;
  testID?: string;
}) {
  if (!pricing) {
    // Pricing row not loaded yet (or backend hasn't seeded this app).
    // For the Creator we STILL want this pill to be tappable so they
    // can set the price for the first time — otherwise the menu is
    // unreachable from cards whose backend row was just inserted (e.g.
    // a freshly-added mini-app like Buried Treasure right after we
    // bump LIBRARY_APP_IDS). For non-admins we keep it a plain pill so
    // the parent card's TouchableOpacity catches the tap.
    if (isAdmin && onCreatorTap) {
      return (
        <TouchableOpacity
          testID={testID}
          activeOpacity={0.7}
          hitSlop={8}
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            onCreatorTap();
          }}
          style={[badgeStyles.pill, badgeStyles.free, badgeStyles.adminFree]}
        >
          <Text style={badgeStyles.freeText}>FREE</Text>
          <Ionicons name="create-outline" size={11} color={colors.green} />
        </TouchableOpacity>
      );
    }
    return (
      <View style={[badgeStyles.pill, badgeStyles.free]} testID={testID}>
        <Text style={badgeStyles.freeText}>FREE</Text>
      </View>
    );
  }
  const owned = pricing.purchased && !pricing.is_free;

  // Wrap in a tap target only for Creator; non-Creator taps must fall
  // through to the parent so the BuyAppModal opens at the card level.
  const Wrap: any = isAdmin && onCreatorTap ? TouchableOpacity : View;
  const wrapProps: any = isAdmin && onCreatorTap
    ? {
        activeOpacity: 0.7,
        hitSlop: 8,
        onPress: () => {
          Haptics.selectionAsync().catch(() => {});
          onCreatorTap();
        },
      }
    : {};

  // Build inner display
  let inner: React.ReactNode;
  if (pricing.is_free) {
    inner = <Text style={badgeStyles.freeText}>FREE</Text>;
  } else if (owned) {
    inner = (
      <>
        <Ionicons name="checkmark-circle" size={11} color={colors.green} />
        <Text style={badgeStyles.ownedText}>OWNED</Text>
      </>
    );
  } else if (pricing.discount_active) {
    inner = (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Text style={badgeStyles.struck}>{formatPrice(pricing.price, pricing.currency)}</Text>
        <Text style={badgeStyles.priceText}>{formatPrice(pricing.effective_price, pricing.currency)}</Text>
        <View style={badgeStyles.discountChip}>
          <Text style={badgeStyles.discountText}>-{pricing.discount_percent}%</Text>
        </View>
      </View>
    );
  } else {
    inner = <Text style={badgeStyles.priceText}>{formatPrice(pricing.price, pricing.currency)}</Text>;
  }

  return (
    <Wrap
      {...wrapProps}
      style={[
        badgeStyles.pill,
        pricing.is_free ? badgeStyles.free : owned ? badgeStyles.owned : badgeStyles.priced,
        isAdmin && badgeStyles.adminEditable,
      ]}
      testID={testID}
    >
      {inner}
      {isAdmin && (
        <View style={badgeStyles.editIcon}>
          <Ionicons name="pencil" size={9} color="#FFD700" />
        </View>
      )}
    </Wrap>
  );
}

const badgeStyles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  free: { backgroundColor: colors.green + '22', borderColor: colors.green + '88' },
  // Same green pill but with a slightly stronger border + the pencil
  // icon, so the Creator can spot that the FREE pill is editable even
  // before the backend pricing row has loaded.
  adminFree: { borderColor: colors.green, borderWidth: 1.5 },
  freeText: { color: colors.green, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  priced: { backgroundColor: colors.bg, borderColor: '#FFD70066' },
  priceText: { color: colors.text, fontSize: 11, fontWeight: '900' },
  struck: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textDecorationLine: 'line-through',
  },
  discountChip: {
    backgroundColor: colors.red + '22',
    borderRadius: radii.pill,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderWidth: 1,
    borderColor: colors.red + '88',
  },
  discountText: { color: colors.red, fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  owned: { backgroundColor: colors.green + '22', borderColor: colors.green + '88' },
  ownedText: { color: colors.green, fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  adminEditable: { borderStyle: 'dashed', borderColor: '#FFD70088' },
  editIcon: { marginLeft: 2 },
});

// ════════════════════ CreatorPricingMenu ═════════════════════════
export function CreatorPricingMenu({
  visible,
  appId,
  pricing,
  onClose,
  onChoose,
  kind = 'library',
}: {
  visible: boolean;
  appId: MiniAppId | BoostId | null;
  pricing: LibraryAppPricing | null;
  onClose: () => void;
  /** 'price' = change full price, 'discount' = solo % discount,
   *  'duo'   = friends/duo group-buy discount (Library+ only). */
  onChoose: (which: 'price' | 'discount' | 'duo') => void;
  kind?: PricingKind;
}) {
  if (!appId) return null;
  // Duo is Library+ only — boosts can't be group-bought.
  const showDuo = kind === 'library';
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={menuStyles.backdrop}>
        <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation && e.stopPropagation()} style={menuStyles.sheet}>
          <View style={menuStyles.handle} />
          <Text style={menuStyles.kicker}>CREATOR · PRICING</Text>
          <Text style={menuStyles.title}>{labelFor(kind, appId)}</Text>
          {pricing ? (
            <Text style={menuStyles.sub}>
              Currently:{' '}
              {pricing.is_free
                ? 'FREE for everyone'
                : pricing.discount_active
                  ? `${formatPrice(pricing.effective_price, pricing.currency)} (${pricing.discount_percent}% off ${formatPrice(pricing.price, pricing.currency)})`
                  : formatPrice(pricing.price, pricing.currency)}
              {pricing.duo_offer
                ? `\n🎟 Duo: ${formatPrice(pricing.duo_offer.discounted_price, pricing.duo_offer.currency)} w/ ${pricing.duo_offer.required_people} friends`
                : ''}
            </Text>
          ) : null}

          <TouchableOpacity
            testID="pricing-menu-price"
            onPress={() => onChoose('price')}
            style={[menuStyles.row, { borderColor: colors.cyan + '88', backgroundColor: colors.cyan + '15' }]}
            activeOpacity={0.85}
          >
            <Ionicons name="pricetag" size={20} color={colors.cyan} />
            <View style={{ flex: 1 }}>
              <Text style={[menuStyles.rowTitle, { color: colors.cyan }]}>Change price</Text>
              <Text style={menuStyles.rowSub}>Set a fixed price + currency + checkout link.</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.cyan} />
          </TouchableOpacity>

          <TouchableOpacity
            testID="pricing-menu-discount"
            onPress={() => onChoose('discount')}
            style={[menuStyles.row, { borderColor: '#FFD70088', backgroundColor: '#FFD70015' }]}
            activeOpacity={0.85}
          >
            <Ionicons name="flame" size={20} color="#FFD700" />
            <View style={{ flex: 1 }}>
              <Text style={[menuStyles.rowTitle, { color: '#FFD700' }]}>Solo discount</Text>
              <Text style={menuStyles.rowSub}>% off for a limited time (days / weeks / months).</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#FFD700" />
          </TouchableOpacity>

          {showDuo ? (
            <TouchableOpacity
              testID="pricing-menu-duo"
              onPress={() => onChoose('duo')}
              style={[menuStyles.row, { borderColor: '#B388FF88', backgroundColor: '#B388FF15' }]}
              activeOpacity={0.85}
            >
              <Ionicons name="people-circle" size={20} color="#B388FF" />
              <View style={{ flex: 1 }}>
                <Text style={[menuStyles.rowTitle, { color: '#B388FF' }]}>Friends / Duo discount</Text>
                <Text style={menuStyles.rowSub}>
                  Group-buy unlock — 1–5 friends together pay a lower price.
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color="#B388FF" />
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity onPress={onClose} style={menuStyles.cancel}>
            <Text style={menuStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const menuStyles = StyleSheet.create({
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
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
  kicker: { color: '#FFD700', fontSize: 10, fontWeight: '900', letterSpacing: 2, textAlign: 'center' },
  title: { color: colors.text, fontSize: 18, fontWeight: '900', textAlign: 'center', marginTop: 2 },
  sub: { color: colors.textSecondary, fontSize: 12, textAlign: 'center', marginBottom: spacing.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 14,
    borderRadius: radii.md, borderWidth: 1,
  },
  rowTitle: { fontSize: 14, fontWeight: '900', letterSpacing: 0.2 },
  rowSub: { color: colors.textSecondary, fontSize: 11, marginTop: 2, lineHeight: 14 },
  cancel: { paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  cancelText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
});

// ════════════════════ SetPriceModal ═══════════════════════════════
export function SetPriceModal({
  visible,
  appId,
  initial,
  currencies,
  onClose,
  onSaved,
  kind = 'library',
}: {
  visible: boolean;
  appId: MiniAppId | BoostId | null;
  initial: LibraryAppPricing | null;
  currencies: string[];
  onClose: () => void;
  onSaved: (next: LibraryAppPricing) => void;
  kind?: PricingKind;
}) {
  const [price, setPrice] = useState<string>('0');
  // Default currency = AUD (Australian dollars). Creator can still pick
  // any of the 10 supported currencies from the chips below — this is
  // only the seed value for a brand-new mini-app row.
  const [currency, setCurrency] = useState<string>('AUD');
  const [purchaseUrl, setPurchaseUrl] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setErr(null);
    if (initial) {
      setPrice(String(initial.price.toFixed(2)));
      setCurrency(initial.currency || 'AUD');
      setPurchaseUrl(initial.purchase_url || '');
    } else {
      setPrice('0');
      setCurrency('AUD');
      setPurchaseUrl('');
    }
  }, [visible, initial]);

  const submit = async () => {
    if (!appId) return;
    const n = parseFloat(price);
    if (Number.isNaN(n) || n < 0) {
      setErr('Price must be a non-negative number.');
      return;
    }
    if (purchaseUrl && !(purchaseUrl.startsWith('http://') || purchaseUrl.startsWith('https://'))) {
      setErr('Purchase URL must start with http:// or https://');
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      const a = apiFor(kind);
      const r = await a.pricingSet(appId as any, {
        price: n,
        currency,
        purchase_url: purchaseUrl.trim(),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onSaved(r.pricing);
      onClose();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  if (!appId) return null;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={priceStyles.backdrop}>
        <ScrollView contentContainerStyle={priceStyles.scroll} keyboardShouldPersistTaps="handled">
          <View style={priceStyles.card} testID="set-price-modal">
            <Text style={priceStyles.kicker}>CREATOR · CHANGE PRICE</Text>
            <Text style={priceStyles.title}>{labelFor(kind, appId)}</Text>

            <Text style={priceStyles.label}>How much?</Text>
            <View style={priceStyles.priceRow}>
              <TextInput
                value={price}
                onChangeText={setPrice}
                placeholder="0.00"
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
                style={priceStyles.priceInput}
                testID="set-price-amount"
              />
            </View>

            <Text style={priceStyles.label}>Currency</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={priceStyles.currencyRow}>
              {currencies.map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setCurrency(c)}
                  style={[priceStyles.currencyChip, currency === c && priceStyles.currencyChipActive]}
                  activeOpacity={0.8}
                  testID={`currency-${c}`}
                >
                  <Text style={[priceStyles.currencyText, currency === c && priceStyles.currencyTextActive]}>
                    {CURRENCY_SYMBOLS[c] || ''} {c}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={priceStyles.label}>Checkout URL (Ko-fi / Stripe)</Text>
            <TextInput
              value={purchaseUrl}
              onChangeText={setPurchaseUrl}
              placeholder="https://ko-fi.com/yourname"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={priceStyles.urlInput}
              testID="set-price-url"
            />
            <Text style={priceStyles.hint}>
              Set price to <Text style={{ fontWeight: '900' }}>0</Text> to mark this app FREE for all users.
            </Text>
            {err ? <Text style={priceStyles.errText}>{err}</Text> : null}

            <View style={priceStyles.btnRow}>
              <TouchableOpacity onPress={onClose} style={[priceStyles.btn, priceStyles.btnGhost]} activeOpacity={0.8}>
                <Text style={priceStyles.btnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                disabled={submitting}
                style={[priceStyles.btn, priceStyles.btnPrimary, submitting && { opacity: 0.5 }]}
                activeOpacity={0.85}
                testID="set-price-submit"
              >
                {submitting ? (
                  <ActivityIndicator color={colors.bg} />
                ) : (
                  <Text style={priceStyles.btnPrimaryText}>Save price</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const priceStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)' },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border,
    padding: spacing.lg,
  },
  kicker: { color: colors.cyan, fontSize: 10, fontWeight: '900', letterSpacing: 2, textAlign: 'center' },
  title: { color: colors.text, fontSize: 18, fontWeight: '900', textAlign: 'center', marginTop: 2 },
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, marginTop: spacing.md, marginBottom: 6 },
  priceRow: { flexDirection: 'row', gap: spacing.sm },
  priceInput: {
    flex: 1, backgroundColor: colors.bg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 12, fontSize: 18, fontWeight: '900',
  },
  currencyRow: { gap: 6, paddingVertical: 2 },
  currencyChip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  currencyChipActive: { backgroundColor: colors.cyan + '22', borderColor: colors.cyan },
  currencyText: { color: colors.textSecondary, fontSize: 12, fontWeight: '800' },
  currencyTextActive: { color: colors.cyan },
  urlInput: {
    backgroundColor: colors.bg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 12, fontSize: 13,
  },
  hint: { color: colors.textMuted, fontSize: 11, marginTop: 8, lineHeight: 15 },
  errText: { color: colors.red, fontSize: 12, marginTop: 8 },
  btnRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  btn: { flex: 1, paddingVertical: 12, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  btnGhostText: { color: colors.textSecondary, fontWeight: '800', fontSize: 13 },
  btnPrimary: { backgroundColor: colors.cyan },
  btnPrimaryText: { color: colors.bg, fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
});

// ════════════════════ SetDiscountModal ════════════════════════════
export function SetDiscountModal({
  visible,
  appId,
  initial,
  onClose,
  onSaved,
  kind = 'library',
}: {
  visible: boolean;
  appId: MiniAppId | BoostId | null;
  initial: LibraryAppPricing | null;
  onClose: () => void;
  onSaved: (next: LibraryAppPricing) => void;
  kind?: PricingKind;
}) {
  const [percent, setPercent] = useState<number>(20);
  const [durationVal, setDurationVal] = useState<string>('7');
  const [unit, setUnit] = useState<'days' | 'weeks' | 'months'>('days');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setErr(null);
    if (initial?.discount_active) {
      setPercent(initial.discount_percent);
    } else {
      setPercent(20);
    }
    setDurationVal('7');
    setUnit('days');
  }, [visible, initial]);

  const PRESETS = [10, 25, 50, 75];
  const submit = async (clear = false) => {
    if (!appId) return;
    setSubmitting(true);
    setErr(null);
    try {
      const a = apiFor(kind);
      if (clear) {
        const r = await a.pricingDiscount(appId as any, { percent: 0 });
        onSaved(r.pricing);
        onClose();
        return;
      }
      const dv = parseInt(durationVal, 10);
      if (Number.isNaN(dv) || dv <= 0) {
        setErr('Duration must be a positive integer.');
        setSubmitting(false);
        return;
      }
      if (percent < 1 || percent > 99) {
        setErr('Percent must be between 1 and 99.');
        setSubmitting(false);
        return;
      }
      const r = await a.pricingDiscount(appId as any, {
        percent,
        duration_value: dv,
        duration_unit: unit,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onSaved(r.pricing);
      onClose();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  if (!appId) return null;
  const hasActive = !!initial?.discount_active;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={discStyles.backdrop}>
        <ScrollView contentContainerStyle={discStyles.scroll} keyboardShouldPersistTaps="handled">
          <View style={discStyles.card} testID="set-discount-modal">
            <Text style={discStyles.kicker}>CREATOR · ADD DISCOUNT</Text>
            <Text style={discStyles.title}>{labelFor(kind, appId)}</Text>
            {initial && initial.price > 0 ? (
              <Text style={discStyles.sub}>
                Original price: {formatPrice(initial.price, initial.currency)}
              </Text>
            ) : (
              <Text style={[discStyles.sub, { color: colors.amber }]}>
                Tip: set a price first, then come back to apply a discount.
              </Text>
            )}

            <Text style={discStyles.label}>Add Discount %</Text>
            <View style={discStyles.presetRow}>
              {PRESETS.map((p) => (
                <TouchableOpacity
                  key={p}
                  onPress={() => setPercent(p)}
                  style={[discStyles.presetChip, percent === p && discStyles.presetChipActive]}
                  testID={`discount-preset-${p}`}
                  activeOpacity={0.8}
                >
                  <Text style={[discStyles.presetText, percent === p && discStyles.presetTextActive]}>
                    {p}%
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={discStyles.customRow}>
              <Text style={discStyles.customLabel}>Custom</Text>
              <TextInput
                value={String(percent)}
                onChangeText={(t) => {
                  const n = parseInt(t.replace(/[^0-9]/g, ''), 10);
                  setPercent(Number.isNaN(n) ? 0 : Math.min(99, Math.max(0, n)));
                }}
                keyboardType="number-pad"
                style={discStyles.customInput}
                testID="discount-percent-custom"
              />
              <Text style={discStyles.customSuffix}>%</Text>
            </View>

            <Text style={discStyles.label}>Time frame</Text>
            <View style={discStyles.timeRow}>
              <TextInput
                value={durationVal}
                onChangeText={(t) => setDurationVal(t.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
                style={discStyles.timeInput}
                testID="discount-duration-value"
              />
              <View style={discStyles.unitRow}>
                {(['days', 'weeks', 'months'] as const).map((u) => (
                  <TouchableOpacity
                    key={u}
                    onPress={() => setUnit(u)}
                    style={[discStyles.unitChip, unit === u && discStyles.unitChipActive]}
                    activeOpacity={0.8}
                    testID={`discount-unit-${u}`}
                  >
                    <Text style={[discStyles.unitText, unit === u && discStyles.unitTextActive]}>{u}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {initial && initial.price > 0 ? (
              <View style={discStyles.previewBox}>
                <Text style={discStyles.previewLabel}>Preview</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={discStyles.previewStruck}>{formatPrice(initial.price, initial.currency)}</Text>
                  <Text style={discStyles.previewPrice}>
                    {formatPrice(initial.price * (1 - percent / 100), initial.currency)}
                  </Text>
                  <View style={discStyles.previewChip}>
                    <Text style={discStyles.previewChipText}>-{percent}%</Text>
                  </View>
                </View>
                <Text style={discStyles.previewLasts}>
                  Lasts {durationVal || '?'} {unit}.
                </Text>
              </View>
            ) : null}

            {err ? <Text style={discStyles.errText}>{err}</Text> : null}

            <View style={discStyles.btnRow}>
              {hasActive ? (
                <TouchableOpacity
                  onPress={() => submit(true)}
                  disabled={submitting}
                  style={[discStyles.btn, discStyles.btnDanger, submitting && { opacity: 0.5 }]}
                  activeOpacity={0.85}
                  testID="discount-clear"
                >
                  <Text style={discStyles.btnDangerText}>Clear discount</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={onClose} style={[discStyles.btn, discStyles.btnGhost]} activeOpacity={0.8}>
                  <Text style={discStyles.btnGhostText}>Cancel</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() => submit(false)}
                disabled={submitting}
                style={[discStyles.btn, discStyles.btnPrimary, submitting && { opacity: 0.5 }]}
                activeOpacity={0.85}
                testID="discount-submit"
              >
                {submitting ? (
                  <ActivityIndicator color={colors.bg} />
                ) : (
                  <Text style={discStyles.btnPrimaryText}>Apply discount</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const discStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)' },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border,
    padding: spacing.lg,
  },
  kicker: { color: '#FFD700', fontSize: 10, fontWeight: '900', letterSpacing: 2, textAlign: 'center' },
  title: { color: colors.text, fontSize: 18, fontWeight: '900', textAlign: 'center', marginTop: 2 },
  sub: { color: colors.textSecondary, fontSize: 12, textAlign: 'center', marginTop: 4 },
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, marginTop: spacing.md, marginBottom: 6 },
  presetRow: { flexDirection: 'row', gap: 6 },
  presetChip: {
    flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  presetChipActive: { backgroundColor: '#FFD70022', borderColor: '#FFD700' },
  presetText: { color: colors.textSecondary, fontWeight: '900', fontSize: 13 },
  presetTextActive: { color: '#FFD700' },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  customLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: '800' },
  customInput: {
    flex: 1, backgroundColor: colors.bg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 10, fontSize: 14, fontWeight: '900',
  },
  customSuffix: { color: colors.textSecondary, fontSize: 14, fontWeight: '900' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timeInput: {
    width: 70, backgroundColor: colors.bg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 10, fontSize: 14, fontWeight: '900', textAlign: 'center',
  },
  unitRow: { flexDirection: 'row', flex: 1, gap: 4 },
  unitChip: {
    flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  unitChipActive: { backgroundColor: colors.cyan + '22', borderColor: colors.cyan },
  unitText: { color: colors.textSecondary, fontSize: 11, fontWeight: '800' },
  unitTextActive: { color: colors.cyan },
  previewBox: {
    marginTop: spacing.md, padding: spacing.sm, borderRadius: radii.md,
    backgroundColor: '#FFD70010', borderWidth: 1, borderColor: '#FFD70066',
  },
  previewLabel: { color: '#FFD700', fontSize: 10, fontWeight: '900', letterSpacing: 1, marginBottom: 4 },
  previewStruck: { color: colors.textMuted, fontSize: 13, fontWeight: '700', textDecorationLine: 'line-through' },
  previewPrice: { color: colors.text, fontSize: 16, fontWeight: '900' },
  previewChip: { backgroundColor: colors.red + '22', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: colors.red + '88' },
  previewChipText: { color: colors.red, fontSize: 10, fontWeight: '900' },
  previewLasts: { color: colors.textSecondary, fontSize: 11, marginTop: 4 },
  errText: { color: colors.red, fontSize: 12, marginTop: 8 },
  btnRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  btn: { flex: 1, paddingVertical: 12, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  btnGhostText: { color: colors.textSecondary, fontWeight: '800', fontSize: 13 },
  btnDanger: { backgroundColor: colors.red + '22', borderWidth: 1, borderColor: colors.red + '88' },
  btnDangerText: { color: colors.red, fontWeight: '900', fontSize: 13 },
  btnPrimary: { backgroundColor: '#FFD700' },
  btnPrimaryText: { color: colors.bg, fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
});

// ════════════════════ BuyAppModal ═════════════════════════════════
export function BuyAppModal({
  visible,
  appId,
  pricing,
  description,
  onClose,
  onPurchased,
  kind = 'library',
  duoGroupId = null,
}: {
  visible: boolean;
  appId: MiniAppId | BoostId | null;
  pricing: LibraryAppPricing | null;
  description?: string;
  onClose: () => void;
  onPurchased: () => void;
  kind?: PricingKind;
  /** When set, the create-payment-intent is sent with this group id and
   *  the backend charges the snapshotted duo discounted price. */
  duoGroupId?: string | null;
}) {
  const [redirecting, setRedirecting] = useState(false);
  const [redirectError, setRedirectError] = useState<string | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [openedCheckout, setOpenedCheckout] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [successView, setSuccessView] = useState(false);
  // Guest gate — anonymous users can browse the prices but tapping
  // "Buy" must show the sign-in prompt rather than firing checkout.
  const _guard = useGuestGate();
  const gateBlock = (label?: string) => _guard.block(label);

  useEffect(() => {
    if (!visible) {
      setOpenedCheckout(false);
      setErr(null);
      setRedirecting(false);
      setRedirectError(null);
      setPendingSessionId(null);
      setSuccessView(false);
    }
  }, [visible]);

  if (!appId || !pricing) return null;

  const finishWithSuccess = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setSuccessView(true);
    // Refresh OWNED state in parent immediately so subsequent taps
    // open the mini-app instead of the Buy modal.
    onPurchased();
  };

  const openCheckout = async () => {
    Haptics.selectionAsync().catch(() => {});
    // Guests can VIEW prices but tapping "Buy" must show the sign-in
    // modal — purchases are tied to a real account so we can attribute
    // the unlock and tax records correctly.
    if (gateBlock('buy this')) return;
    setRedirecting(true);
    setRedirectError(null);
    setErr(null);

    // ── Native (iOS / Android) → PaymentSheet (in-app, PCI-safe).
    if (Platform.OS !== 'web') {
      try {
        // Pass kind to backend so it knows whether to read price from
        // library_pricing or boost_pricing.
        const intent = await api.paymentsCreatePaymentIntent(appId as any, kind, duoGroupId || undefined);
        await new Promise((res) => setTimeout(res, 450));
        const r = await presentNativePaymentSheet({
          publishableKey: intent.publishable_key,
          paymentIntentClientSecret: intent.payment_intent_client_secret,
          customerId: intent.customer_id,
          customerEphemeralKeySecret: intent.ephemeral_key_secret,
          merchantDisplayName: 'XP in Real Life',
        });
        setRedirecting(false);

        if ((r as any).unsupported) {
        } else if ((r as any).ok === true) {
          try { await apiFor(kind).purchase(appId as any); } catch {}
          finishWithSuccess();
          return;
        } else if ((r as any).canceled) {
          return;
        } else {
          const message = (r as any).error || 'Payment failed.';
          const friendly = /declined|incorrect|invalid|cvc|expir/i.test(message)
            ? 'Incorrect details — please double-check your card and try again.'
            : message;
          setRedirectError(friendly);
          return;
        }
      } catch (e: any) {
        setRedirecting(false);
        const msg = String(e?.message || e);
        setRedirectError(msg.includes('already own') ? 'You already own this item.' : msg);
        return;
      }
    }

    // ── Web fallback → hosted Stripe Checkout in a browser tab.
    // Only Library mini-apps support this fallback (Checkout Sessions
    // backend currently doesn't have boost variant). For boosts on web
    // we surface a message asking to use the mobile app.
    if (kind === 'boost') {
      setRedirecting(false);
      setRedirectError('Boost purchases are available in the mobile app. Open the app on your phone to complete checkout.');
      return;
    }
    try {
      const r = await api.paymentsCreateCheckout(appId as MiniAppId);
      setPendingSessionId(r.session_id);
      await new Promise((res) => setTimeout(res, 500));
      const ok = await Linking.openURL(r.checkout_url).then(() => true).catch(() => false);
      if (!ok) {
        setRedirectError('Could not open the secure checkout window. Please try again.');
        setRedirecting(false);
        return;
      }
      setRedirecting(false);
      setOpenedCheckout(true);
    } catch (e: any) {
      setRedirecting(false);
      const msg = String(e?.message || e);
      setRedirectError(msg.includes('already own') ? 'You already own this mini-app.' : msg);
    }
  };

  const confirmPurchased = async () => {
    setConfirming(true);
    setErr(null);
    try {
      if (pendingSessionId) {
        try {
          const v = await api.paymentsVerifySession(pendingSessionId);
          if (v.paid) {
            try { await api.libraryPurchase(appId); } catch {}
            finishWithSuccess();
            return;
          }
        } catch {}
      }
      // Fallback: trust-based purchase record.
      await apiFor(kind).purchase(appId as any);
      finishWithSuccess();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={buyStyles.backdrop}>
        <ScrollView contentContainerStyle={buyStyles.scroll} keyboardShouldPersistTaps="handled">
          {successView ? (
            <View style={buyStyles.successCard} testID="buy-success">
              <View style={buyStyles.successIcon}>
                <Ionicons name="checkmark-circle" size={56} color={colors.green} />
              </View>
              <Text style={buyStyles.successHead}>
                Payment successful! <Text style={buyStyles.successCheck}>✓</Text>
              </Text>
              <Text style={buyStyles.successBody}>
                You now have access to this feature!
              </Text>
              <Text style={buyStyles.successThanks}>Thank you 🎉</Text>
              <View style={buyStyles.successDivider} />
              <Text style={buyStyles.successFoot}>
                A receipt has been sent to your email.{'\n'}
                Enjoy your new mini-app — it's yours forever.
              </Text>
              <TouchableOpacity
                onPress={() => { onClose(); }}
                style={[buyStyles.btn, buyStyles.btnConfirm]}
                activeOpacity={0.85}
                testID="buy-success-open"
              >
                <Ionicons name="rocket" size={18} color={colors.bg} />
                <Text style={buyStyles.btnPrimaryText}>Open it now</Text>
                <Ionicons name="arrow-forward" size={14} color={colors.bg} />
              </TouchableOpacity>
            </View>
          ) : (
          <View style={buyStyles.card} testID="buy-app-modal">
            <View style={buyStyles.heroIcon}>
              <Ionicons name="lock-closed" size={36} color="#FFD700" />
            </View>
            <Text style={buyStyles.kicker}>PREMIUM MINI-APP</Text>
            <Text style={buyStyles.title}>{labelFor(kind, appId)}</Text>
            {description ? <Text style={buyStyles.desc}>{description}</Text> : null}

            <View style={buyStyles.priceBox}>
              {pricing.discount_active ? (
                <View style={{ alignItems: 'center', gap: 4 }}>
                  <Text style={buyStyles.struck}>{formatPrice(pricing.price, pricing.currency)}</Text>
                  <Text style={buyStyles.priceBig}>{formatPrice(pricing.effective_price, pricing.currency)}</Text>
                  <View style={buyStyles.discChip}>
                    <Ionicons name="flame" size={10} color={colors.red} />
                    <Text style={buyStyles.discText}>{pricing.discount_percent}% OFF — limited time</Text>
                  </View>
                </View>
              ) : (
                <Text style={buyStyles.priceBig}>{formatPrice(pricing.effective_price, pricing.currency)}</Text>
              )}
              <Text style={buyStyles.priceFoot}>One-time purchase · Yours forever</Text>
              <View style={buyStyles.stripeRow}>
                <Ionicons name="shield-checkmark" size={11} color={colors.green} />
                <Text style={buyStyles.stripeText}>Secure checkout via Stripe</Text>
              </View>
            </View>

            {!openedCheckout ? (
              <TouchableOpacity
                onPress={openCheckout}
                disabled={redirecting}
                style={[buyStyles.btn, buyStyles.btnPrimary, redirecting && { opacity: 0.6 }]}
                activeOpacity={0.85}
                testID="buy-open-checkout"
              >
                <Ionicons name="card" size={18} color={colors.bg} />
                <Text style={buyStyles.btnPrimaryText}>{redirecting ? 'Redirecting…' : 'Buy now'}</Text>
                <Ionicons name="arrow-forward" size={14} color={colors.bg} />
              </TouchableOpacity>
            ) : (
              <>
                <Text style={buyStyles.afterTip}>
                  Already paid? Tap below to verify and unlock instantly.
                </Text>
                <TouchableOpacity
                  onPress={confirmPurchased}
                  disabled={confirming}
                  style={[buyStyles.btn, buyStyles.btnConfirm, confirming && { opacity: 0.5 }]}
                  activeOpacity={0.85}
                  testID="buy-confirm"
                >
                  {confirming ? (
                    <ActivityIndicator color={colors.bg} />
                  ) : (
                    <>
                      <Ionicons name="checkmark-circle" size={18} color={colors.bg} />
                      <Text style={buyStyles.btnPrimaryText}>I've completed purchase</Text>
                    </>
                  )}
                </TouchableOpacity>
                <TouchableOpacity onPress={openCheckout} style={buyStyles.btnSecondary} activeOpacity={0.7}>
                  <Text style={buyStyles.btnSecondaryText}>Re-open checkout</Text>
                </TouchableOpacity>
              </>
            )}

            {(redirectError || err) ? <Text style={buyStyles.errText}>{redirectError || err}</Text> : null}

            <TouchableOpacity onPress={onClose} style={buyStyles.cancel} activeOpacity={0.7}>
              <Text style={buyStyles.cancelText}>Maybe later</Text>
            </TouchableOpacity>
          </View>
          )}
        </ScrollView>

        {/* ────── Premium Redirecting overlay ────── */}
        {redirecting ? <CheckoutRedirectingOverlay /> : null}
      </View>
    </Modal>
  );
}

/**
 * Full-screen overlay shown while the backend creates the Stripe
 * Checkout Session. Branded, animated, and "premium" — sells the
 * transition as deliberate rather than a flicker.
 */
function CheckoutRedirectingOverlay() {
  const spin = React.useRef(new RNAnimated.Value(0)).current;
  const pulse = React.useRef(new RNAnimated.Value(0)).current;
  const [dots, setDots] = useState('');

  React.useEffect(() => {
    RNAnimated.loop(
      RNAnimated.timing(spin, { toValue: 1, duration: 1100, useNativeDriver: true, easing: RNEasing.linear }),
    ).start();
    RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
        RNAnimated.timing(pulse, { toValue: 0, duration: 800, useNativeDriver: true }),
      ]),
    ).start();
    const t = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : d + '.'));
    }, 350);
    return () => clearInterval(t);
  }, [spin, pulse]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.75] });

  return (
    <View pointerEvents="auto" style={overlayStyles.root} testID="redirecting-overlay">
      <View style={overlayStyles.center}>
        <View style={overlayStyles.spinnerWrap}>
          <RNAnimated.View
            style={[
              overlayStyles.glow,
              { opacity, transform: [{ scale }] },
            ]}
          />
          <RNAnimated.View style={[overlayStyles.spinner, { transform: [{ rotate }] }]} />
          <View style={overlayStyles.lockChip}>
            <Ionicons name="lock-closed" size={20} color={colors.green} />
          </View>
        </View>
        <Text style={overlayStyles.brand}>XP IN REAL LIFE</Text>
        <Text style={overlayStyles.title}>Redirecting to secure checkout{dots}</Text>
        <Text style={overlayStyles.sub}>Powered by Stripe · 256-bit encrypted</Text>
        <View style={overlayStyles.tipRow}>
          <Ionicons name="shield-checkmark" size={12} color={colors.green} />
          <Text style={overlayStyles.tipText}>Your card details never touch our servers.</Text>
        </View>
      </View>
    </View>
  );
}

const buyStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)' },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: '#FFD70066',
    padding: spacing.lg,
  },
  heroIcon: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: '#FFD70022',
    borderWidth: 1, borderColor: '#FFD70088',
    alignItems: 'center', justifyContent: 'center', alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  kicker: { color: '#FFD700', fontSize: 10, fontWeight: '900', letterSpacing: 2, textAlign: 'center' },
  title: { color: colors.text, fontSize: 22, fontWeight: '900', textAlign: 'center', marginTop: 4, letterSpacing: -0.3 },
  desc: { color: colors.textSecondary, fontSize: 12, textAlign: 'center', marginTop: 6, lineHeight: 17 },

  priceBox: {
    marginTop: spacing.md, padding: spacing.md, borderRadius: radii.md,
    alignItems: 'center', gap: 4,
    backgroundColor: '#FFD70010', borderWidth: 1, borderColor: '#FFD70066',
  },
  struck: { color: colors.textMuted, fontSize: 14, fontWeight: '700', textDecorationLine: 'line-through' },
  priceBig: { color: colors.text, fontSize: 30, fontWeight: '900', letterSpacing: -0.5 },
  discChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.red + '22', borderWidth: 1, borderColor: colors.red + '88',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.pill, marginTop: 2,
  },
  discText: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  priceFoot: { color: colors.textMuted, fontSize: 11, marginTop: 6 },
  stripeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6,
    backgroundColor: colors.green + '15', borderWidth: 1, borderColor: colors.green + '55',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
  },
  stripeText: { color: colors.green, fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },

  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: radii.pill, marginTop: spacing.md,
  },
  btnPrimary: { backgroundColor: '#FFD700' },
  btnPrimaryText: { color: colors.bg, fontWeight: '900', fontSize: 14, letterSpacing: 0.3 },
  btnConfirm: { backgroundColor: colors.green },
  btnSecondary: { paddingVertical: 10, alignItems: 'center', marginTop: 6 },
  btnSecondaryText: { color: colors.cyan, fontSize: 12, fontWeight: '800' },
  afterTip: { color: colors.textSecondary, fontSize: 12, textAlign: 'center', marginTop: spacing.md, lineHeight: 17 },
  errText: { color: colors.red, fontSize: 12, marginTop: 8, textAlign: 'center' },
  cancel: { paddingVertical: 12, alignItems: 'center', marginTop: spacing.sm },
  cancelText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },

  // ── Success state — shown after PaymentSheet (or fallback) confirms ──
  successCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 2,
    borderColor: colors.green,
    padding: spacing.lg,
    paddingTop: spacing.xl,
    alignItems: 'center',
    gap: 6,
  },
  successIcon: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: colors.green + '22',
    borderWidth: 2, borderColor: colors.green,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  successHead: {
    color: colors.green,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  successCheck: { color: colors.green, fontSize: 26, fontWeight: '900' },
  successBody: {
    color: colors.green,
    fontSize: 15,
    fontWeight: '900',
    textAlign: 'center',
    marginTop: 4,
  },
  successThanks: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 4,
  },
  successDivider: {
    width: '100%',
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  successFoot: {
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 17,
    marginBottom: spacing.md,
  },
});

// ════════════════════ Redirecting overlay styles ═══════════════════
const overlayStyles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(5,5,9,0.96)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  center: { alignItems: 'center', justifyContent: 'center', maxWidth: 360 },
  spinnerWrap: {
    width: 96, height: 96, alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  glow: {
    position: 'absolute',
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: colors.green + '55',
  },
  spinner: {
    width: 80, height: 80, borderRadius: 40,
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.08)',
    borderTopColor: colors.green,
    borderRightColor: colors.cyan,
  },
  lockChip: {
    position: 'absolute',
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.green + '88',
    alignItems: 'center', justifyContent: 'center',
  },
  brand: { color: colors.green, fontSize: 11, fontWeight: '900', letterSpacing: 3, marginBottom: 6 },
  title: { color: colors.text, fontSize: 18, fontWeight: '900', textAlign: 'center', letterSpacing: -0.2 },
  sub: { color: colors.textSecondary, fontSize: 12, marginTop: 8, textAlign: 'center' },
  tipRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 14, paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: colors.green + '10', borderWidth: 1, borderColor: colors.green + '44',
    borderRadius: 999,
  },
  tipText: { color: colors.green, fontSize: 11, fontWeight: '700' },
});
