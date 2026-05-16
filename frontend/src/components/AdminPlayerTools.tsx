/**
 * AdminPlayerTools — v1.0.29 Creator-only modals & widgets.
 *
 * Exports:
 *   - <PlayerPriceOverridesModal />  Per-player price override editor.
 *   - <DeletePlayerConfirmModal />   Two-step type-DELETE-to-confirm
 *                                    cascade delete with success receipt.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
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
import type { LibraryAppPricing, PriceOverrideRow } from '../api';

const APP_LIST: { id: string; label: string }[] = [
  { id: 'sleep', label: 'Improve Sleeping' },
  { id: 'challenges', label: 'Challenge Tasks' },
  { id: 'spot', label: 'Spot the Object' },
  { id: 'confidence', label: 'Build Confidence' },
];

function fmtPrice(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

// ════════════════════ PlayerPriceOverridesModal ═══════════════════
export function PlayerPriceOverridesModal({
  visible,
  userId,
  userName,
  onClose,
}: {
  visible: boolean;
  userId: string;
  userName: string;
  onClose: () => void;
}) {
  const [publicPricing, setPublicPricing] = useState<Record<string, LibraryAppPricing> | null>(null);
  const [overrides, setOverrides] = useState<Record<string, PriceOverrideRow>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pp, ov] = await Promise.all([
        api.libraryPricingGet(),
        api.adminPriceOverridesList(userId),
      ]);
      setPublicPricing(pp.pricing as Record<string, LibraryAppPricing>);
      setOverrides(ov.overrides || {});
      // Seed drafts from existing overrides (or empty).
      const seed: Record<string, string> = {};
      APP_LIST.forEach((a) => {
        seed[a.id] = ov.overrides[a.id]?.override_price != null
          ? String(ov.overrides[a.id].override_price)
          : '';
      });
      setDrafts(seed);
    } catch (e: any) {
      showAlert('Could not load', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  const onSave = useCallback(async (appId: string) => {
    const raw = (drafts[appId] || '').trim();
    if (raw === '') {
      showAlert('Enter a price', 'Type a number, or tap Clear to remove the override.');
      return;
    }
    const v = parseFloat(raw);
    if (!isFinite(v) || v < 0) {
      showAlert('Invalid price', 'Override price must be a non-negative number.');
      return;
    }
    setBusy(appId);
    try {
      const currency = publicPricing?.[appId]?.currency || 'USD';
      const r = await api.adminPriceOverrideUpsert(userId, appId, v, currency);
      setOverrides(r.overrides || {});
    } catch (e: any) {
      showAlert('Could not save', String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [drafts, publicPricing, userId]);

  const onClear = useCallback(async (appId: string) => {
    setBusy(appId);
    try {
      const r = await api.adminPriceOverrideClear(userId, appId);
      setOverrides(r.overrides || {});
      setDrafts((d) => ({ ...d, [appId]: '' }));
    } catch (e: any) {
      showAlert('Could not clear', String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }, [userId]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity activeOpacity={1} style={{ flex: 1 }} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.kicker}>CREATOR · PER-PLAYER PRICES</Text>
          <Text style={styles.title} numberOfLines={1}>
            {userName}
          </Text>
          <Text style={styles.sub}>
            Override Library+ prices for this player only. Set a price BELOW or ABOVE the
            public/solo/duo cost — they'll see it exclusively at checkout. Tap CLEAR to
            return to the regular price.
          </Text>

          {loading ? (
            <View style={{ paddingVertical: 32, alignItems: 'center' }}>
              <ActivityIndicator size="large" color="#FFD700" />
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 480 }} contentContainerStyle={{ paddingBottom: spacing.lg }}>
              {APP_LIST.map((a) => {
                const pp = publicPricing?.[a.id];
                const ov = overrides[a.id];
                const draft = drafts[a.id] ?? '';
                const currency = pp?.currency || 'USD';
                const busyHere = busy === a.id;
                return (
                  <View key={a.id} style={styles.appCard} testID={`override-card-${a.id}`}>
                    <View style={styles.appCardHead}>
                      <Text style={styles.appLabel}>{a.label}</Text>
                      <Text style={styles.publicPrice}>
                        Public: {pp ? fmtPrice(pp.price, currency) : '—'}
                      </Text>
                    </View>
                    {ov ? (
                      <Text style={styles.currentOverride}>
                        Active override: {fmtPrice(ov.override_price, ov.currency)}
                      </Text>
                    ) : null}
                    <View style={styles.inputRow}>
                      <Text style={styles.currencyChip}>{currency}</Text>
                      <TextInput
                        testID={`override-input-${a.id}`}
                        style={styles.priceInput}
                        keyboardType="decimal-pad"
                        value={draft}
                        onChangeText={(t) => setDrafts((d) => ({ ...d, [a.id]: t }))}
                        placeholder="e.g. 0.00"
                        placeholderTextColor={colors.textMuted}
                      />
                      <TouchableOpacity
                        testID={`override-save-${a.id}`}
                        onPress={() => onSave(a.id)}
                        disabled={busyHere}
                        style={[styles.saveBtn, busyHere && { opacity: 0.5 }]}
                        activeOpacity={0.85}
                      >
                        {busyHere ? (
                          <ActivityIndicator color={colors.bg} size="small" />
                        ) : (
                          <Text style={styles.saveBtnText}>SAVE</Text>
                        )}
                      </TouchableOpacity>
                      {ov ? (
                        <TouchableOpacity
                          testID={`override-clear-${a.id}`}
                          onPress={() => onClear(a.id)}
                          disabled={busyHere}
                          style={[styles.clearBtn, busyHere && { opacity: 0.5 }]}
                          activeOpacity={0.85}
                        >
                          <Text style={styles.clearBtnText}>CLEAR</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}

          <TouchableOpacity onPress={onClose} style={styles.cancel}>
            <Text style={styles.cancelText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ════════════════════ DeletePlayerConfirmModal ════════════════════
export function DeletePlayerConfirmModal({
  visible,
  userId,
  userName,
  userEmail,
  onClose,
  onDeleted,
}: {
  visible: boolean;
  userId: string;
  userName: string;
  userEmail?: string;
  onClose: () => void;
  /** Called after the cascade delete succeeds. Parent should close the
   *  parent profile modal + refresh the player list. */
  onDeleted: (summary: Record<string, number>) => void;
}) {
  const [phase, setPhase] = useState<'warn' | 'confirm'>('warn');
  const [confirmText, setConfirmText] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!visible) {
      setPhase('warn');
      setConfirmText('');
      setWorking(false);
    }
  }, [visible]);

  const onDelete = useCallback(async () => {
    if (confirmText.trim() !== 'DELETE') {
      showAlert('Type DELETE', "You must type the word DELETE (uppercase) to confirm.");
      return;
    }
    setWorking(true);
    try {
      const r = await api.adminDeletePlayer(userId);
      setWorking(false);
      onClose();
      onDeleted(r.summary);
    } catch (e: any) {
      setWorking(false);
      showAlert('Could not delete', String(e?.detail || e?.message || e));
    }
  }, [confirmText, userId, onClose, onDeleted]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dangerCard}>
          <View style={{ alignItems: 'center', paddingBottom: 8 }}>
            <Ionicons name="warning" size={36} color={colors.red} />
          </View>
          {phase === 'warn' ? (
            <>
              <Text style={styles.dangerTitle}>Delete this player account?</Text>
              <Text style={styles.dangerSub}>
                <Text style={{ fontWeight: '900', color: colors.text }}>{userName}</Text>
                {userEmail ? <Text style={{ color: colors.textMuted }}>{`\n${userEmail}`}</Text> : null}
              </Text>
              <Text style={styles.dangerBlurb}>
                This permanently removes the player's profile, tasks, goals, purchases,
                friend links, messages, gifts, chat prefs, and any duo-group membership.
                The action is irreversible.
              </Text>
              <View style={styles.dangerRow}>
                <TouchableOpacity
                  onPress={onClose}
                  style={[styles.dangerBtn, styles.dangerBtnCancel]}
                  activeOpacity={0.85}
                >
                  <Text style={styles.dangerBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="admin-delete-continue"
                  onPress={() => setPhase('confirm')}
                  style={[styles.dangerBtn, styles.dangerBtnContinue]}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.dangerBtnText, { color: '#fff' }]}>Continue</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.dangerTitle}>Final confirmation</Text>
              <Text style={styles.dangerBlurb}>
                Type <Text style={styles.deleteWord}>DELETE</Text> (in capitals) below to
                permanently destroy this account. This cannot be undone.
              </Text>
              <TextInput
                testID="admin-delete-confirm-input"
                style={styles.confirmInput}
                value={confirmText}
                onChangeText={setConfirmText}
                placeholder="Type DELETE"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <View style={styles.dangerRow}>
                <TouchableOpacity
                  onPress={() => setPhase('warn')}
                  disabled={working}
                  style={[styles.dangerBtn, styles.dangerBtnCancel]}
                  activeOpacity={0.85}
                >
                  <Text style={styles.dangerBtnText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="admin-delete-final-btn"
                  onPress={onDelete}
                  disabled={working || confirmText.trim() !== 'DELETE'}
                  style={[
                    styles.dangerBtn,
                    styles.dangerBtnConfirm,
                    (working || confirmText.trim() !== 'DELETE') && { opacity: 0.45 },
                  ]}
                  activeOpacity={0.85}
                >
                  {working ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={[styles.dangerBtnText, { color: '#fff' }]}>
                      Delete forever
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          )}
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
  kicker: { color: '#FFD700', fontSize: 10, fontWeight: '900', letterSpacing: 2, textAlign: 'center' },
  title: { color: colors.text, fontSize: 18, fontWeight: '900', textAlign: 'center' },
  sub: { color: colors.textMuted, fontSize: 12, lineHeight: 17, textAlign: 'center' },
  appCard: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    gap: 6,
  },
  appCardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  appLabel: { color: colors.text, fontWeight: '800', fontSize: 14 },
  publicPrice: { color: colors.textMuted, fontSize: 11 },
  currentOverride: { color: '#FFD700', fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  currencyChip: { color: colors.textMuted, fontWeight: '800', fontSize: 11, paddingHorizontal: 4 },
  priceInput: {
    flex: 1, color: colors.text, fontSize: 15, fontWeight: '700',
    backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8,
  },
  saveBtn: {
    backgroundColor: '#FFD700', paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 8, alignItems: 'center', justifyContent: 'center', minWidth: 60,
  },
  saveBtnText: { color: '#0a0a0f', fontWeight: '900', fontSize: 11, letterSpacing: 1 },
  clearBtn: {
    backgroundColor: 'transparent', paddingHorizontal: 10, paddingVertical: 10,
    borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: colors.border,
  },
  clearBtnText: { color: colors.textMuted, fontWeight: '800', fontSize: 11, letterSpacing: 1 },
  cancel: { paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  cancelText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },

  // ── Delete modal ──
  dangerCard: {
    margin: 24,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.red + '88',
    padding: 22,
    alignSelf: 'center',
    width: '90%',
    maxWidth: 420,
    alignItems: 'stretch',
    gap: 8,
  },
  dangerTitle: { color: colors.red, fontWeight: '900', fontSize: 18, textAlign: 'center' },
  dangerSub: { color: colors.text, fontSize: 13, textAlign: 'center', marginTop: 4 },
  dangerBlurb: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 8, textAlign: 'center' },
  deleteWord: { color: colors.red, fontWeight: '900', letterSpacing: 1 },
  confirmInput: {
    marginTop: 12, padding: 12, borderRadius: 10,
    borderColor: colors.red + '88', borderWidth: 1,
    color: colors.text, fontWeight: '900', letterSpacing: 4, textAlign: 'center', fontSize: 16,
    backgroundColor: colors.bg,
  },
  dangerRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  dangerBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  dangerBtnCancel: { backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1 },
  dangerBtnContinue: { backgroundColor: colors.red + 'aa' },
  dangerBtnConfirm: { backgroundColor: colors.red },
  dangerBtnText: { color: colors.text, fontWeight: '900', fontSize: 12, letterSpacing: 1 },
});
