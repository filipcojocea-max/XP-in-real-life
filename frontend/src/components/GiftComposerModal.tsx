/**
 * GiftComposerModal — Creator/Admin-only bottom-sheet composer used to
 * send a Gift to a specific player.
 *
 * Two modes (tabs at the top):
 *   • Gift XP Points  — type a custom amount up to 100,000
 *   • Gift Bonus Top-Up — pick an existing 1.5x/2x/3x preset (1-day) OR
 *     create a fully custom multiplier×duration combo
 *
 * Optional "message to player" field. Submitting the form fires the
 * relevant /api/admin/gift/* endpoint and shows a toast on success.
 */
import React, { useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, TextInput,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api';
import { colors, spacing, radii } from '../theme';
import { showAlert } from '../uiAlert';

const GOLD = '#FFD700';

type Tab = 'xp' | 'boost';
type BoostPreset =
  | { kind: 'preset'; type: string; label: string; multiplier: number; duration: number }
  | { kind: 'custom' };

const PRESETS: BoostPreset[] = [
  { kind: 'preset', type: 'triple_day', label: '3x for 1 day', multiplier: 3, duration: 1 },
  { kind: 'preset', type: 'double_week', label: '2x for 7 days', multiplier: 2, duration: 7 },
  { kind: 'preset', type: 'double_month', label: '2x for 30 days', multiplier: 2, duration: 30 },
  { kind: 'custom' },
];

type Props = {
  visible: boolean;
  targetUserId: string;
  targetName: string;
  onClose: () => void;
  onSent?: () => void;
};

export function GiftComposerModal({ visible, targetUserId, targetName, onClose, onSent }: Props) {
  const [tab, setTab] = useState<Tab>('xp');
  const [xpAmount, setXpAmount] = useState('100');
  const [pickedBoost, setPickedBoost] = useState<BoostPreset>(PRESETS[0]);
  const [customMult, setCustomMult] = useState('5');
  const [customDays, setCustomDays] = useState('3');
  const [customLabel, setCustomLabel] = useState('Special Top-Up');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setTab('xp');
    setXpAmount('100');
    setPickedBoost(PRESETS[0]);
    setCustomMult('5');
    setCustomDays('3');
    setCustomLabel('Special Top-Up');
    setMessage('');
  }

  async function send() {
    setSubmitting(true);
    try {
      if (tab === 'xp') {
        const amount = parseInt(xpAmount, 10);
        if (!Number.isFinite(amount) || amount <= 0) {
          showAlert('Invalid amount', 'Type a positive number of XP points (max 100,000).');
          setSubmitting(false);
          return;
        }
        if (amount > 100000) {
          showAlert('Too much', 'Gift XP cannot exceed 100,000 per gift.');
          setSubmitting(false);
          return;
        }
        await api.adminGiftXP(targetUserId, amount, message.trim());
        showAlert('Gift sent! 🎁', `${amount} XP gifted to ${targetName}.`);
      } else {
        if (pickedBoost.kind === 'preset') {
          await api.adminGiftBoost(targetUserId, {
            boost_type: pickedBoost.type,
            message: message.trim(),
          });
          showAlert('Gift sent! 🎁', `${pickedBoost.label} gifted to ${targetName}.`);
        } else {
          const m = parseInt(customMult, 10);
          const d = parseInt(customDays, 10);
          if (!Number.isFinite(m) || m < 2 || m > 10) {
            showAlert('Invalid multiplier', 'Custom multiplier must be 2..10.');
            setSubmitting(false);
            return;
          }
          if (!Number.isFinite(d) || d < 1 || d > 365) {
            showAlert('Invalid duration', 'Custom duration must be 1..365 days.');
            setSubmitting(false);
            return;
          }
          await api.adminGiftBoost(targetUserId, {
            custom_label: customLabel.trim() || `${m}x for ${d} day${d === 1 ? '' : 's'}`,
            custom_multiplier: m,
            custom_duration_days: d,
            message: message.trim(),
          });
          showAlert('Gift sent! 🎁', `${customLabel || `${m}x for ${d}d`} gifted to ${targetName}.`);
        }
      }
      onSent?.();
      reset();
      onClose();
    } catch (e: any) {
      showAlert('Could not send gift', String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.backdrop}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Ionicons name="gift" size={20} color={GOLD} />
            <Text style={styles.headerTitle}>Send Gift to {targetName}</Text>
            <TouchableOpacity testID="gift-close" onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Tabs: XP vs Bonus Top-Up */}
          <View style={styles.tabs}>
            {(['xp', 'boost'] as Tab[]).map((t) => {
              const active = tab === t;
              const label = t === 'xp' ? 'Gift XP Points' : 'Gift Bonus Top Up!';
              return (
                <TouchableOpacity
                  key={t}
                  onPress={() => setTab(t)}
                  testID={`gift-tab-${t}`}
                  style={[styles.tab, active && styles.tabActive]}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>
            {tab === 'xp' ? (
              <View style={styles.xpBlock}>
                <Text style={styles.fieldLabel}>How many XP points?</Text>
                <View style={styles.xpRow}>
                  <Ionicons name="flash" size={20} color={GOLD} />
                  <TextInput
                    testID="gift-xp-amount"
                    value={xpAmount}
                    onChangeText={(t) => setXpAmount(t.replace(/[^0-9]/g, ''))}
                    keyboardType="numeric"
                    maxLength={6}
                    style={styles.xpInput}
                    placeholder="0"
                    placeholderTextColor={colors.textMuted}
                  />
                  <Text style={styles.xpUnit}>XP</Text>
                </View>
                <View style={styles.quickPicks}>
                  {[100, 500, 1000, 5000, 10000].map((n) => (
                    <TouchableOpacity
                      key={n}
                      onPress={() => setXpAmount(String(n))}
                      style={styles.quickPickChip}
                      testID={`gift-xp-quick-${n}`}
                    >
                      <Text style={styles.quickPickText}>+{n.toLocaleString()}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.helper}>Max 100,000 XP per gift.</Text>
              </View>
            ) : (
              <View style={styles.boostBlock}>
                <Text style={styles.fieldLabel}>Choose a Bonus Top-Up</Text>
                {PRESETS.map((p, i) => {
                  const active = pickedBoost === p || (
                    p.kind === 'preset' && pickedBoost.kind === 'preset' && p.type === pickedBoost.type
                  ) || (p.kind === 'custom' && pickedBoost.kind === 'custom');
                  return (
                    <TouchableOpacity
                      key={i}
                      onPress={() => setPickedBoost(p)}
                      style={[styles.boostRow, active && styles.boostRowActive]}
                      testID={`gift-boost-${p.kind === 'preset' ? p.type : 'custom'}`}
                    >
                      <Ionicons
                        name={active ? 'radio-button-on' : 'radio-button-off'}
                        size={18}
                        color={active ? GOLD : colors.textMuted}
                      />
                      <Text style={[styles.boostLabel, active && { color: GOLD }]}>
                        {p.kind === 'preset' ? p.label : 'Create custom Top-Up…'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}

                {pickedBoost.kind === 'custom' ? (
                  <View style={styles.customGroup}>
                    <Text style={styles.fieldLabel}>Multiplier (2..10)</Text>
                    <TextInput
                      testID="gift-custom-multiplier"
                      value={customMult}
                      onChangeText={(t) => setCustomMult(t.replace(/[^0-9]/g, ''))}
                      keyboardType="numeric"
                      maxLength={2}
                      style={styles.smallInput}
                    />
                    <Text style={styles.fieldLabel}>Duration (days, 1..365)</Text>
                    <TextInput
                      testID="gift-custom-days"
                      value={customDays}
                      onChangeText={(t) => setCustomDays(t.replace(/[^0-9]/g, ''))}
                      keyboardType="numeric"
                      maxLength={3}
                      style={styles.smallInput}
                    />
                    <Text style={styles.fieldLabel}>Display label</Text>
                    <TextInput
                      testID="gift-custom-label"
                      value={customLabel}
                      onChangeText={setCustomLabel}
                      maxLength={50}
                      style={styles.smallInput}
                      placeholder="e.g. Birthday Boost"
                      placeholderTextColor={colors.textMuted}
                    />
                  </View>
                ) : null}
              </View>
            )}

            <Text style={styles.fieldLabel}>Message to player (optional)</Text>
            <TextInput
              testID="gift-message"
              value={message}
              onChangeText={setMessage}
              multiline
              maxLength={500}
              placeholder="Keep grinding! 💪"
              placeholderTextColor={colors.textMuted}
              style={styles.messageInput}
            />
            <Text style={styles.charCount}>{message.length}/500</Text>
          </ScrollView>

          <View style={styles.ctaRow}>
            <TouchableOpacity onPress={onClose} disabled={submitting} style={[styles.cta, styles.ctaSecondary]} testID="gift-cancel">
              <Text style={[styles.ctaText, { color: colors.textMuted }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={send}
              disabled={submitting}
              style={[styles.cta, styles.ctaPrimary, submitting && { opacity: 0.6 }]}
              testID="gift-send"
              activeOpacity={0.85}
            >
              {submitting ? <ActivityIndicator color={colors.bg} /> : (
                <>
                  <Ionicons name="send" size={16} color={colors.bg} />
                  <Text style={[styles.ctaText, { color: colors.bg }]}>Send Gift</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: spacing.lg,
    borderTopWidth: 2,
    borderTopColor: GOLD,
    maxHeight: '90%',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing.md },
  headerTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '900', letterSpacing: 0.5 },
  closeBtn: { padding: 6 },

  tabs: { flexDirection: 'row', backgroundColor: colors.bg, borderRadius: radii.pill, padding: 4, marginBottom: spacing.md },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: radii.pill },
  tabActive: { backgroundColor: GOLD },
  tabText: { color: colors.textMuted, fontWeight: '900', fontSize: 12 },
  tabTextActive: { color: colors.bg },

  fieldLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1, marginBottom: 6, marginTop: 8 },

  xpBlock: { gap: 4 },
  xpRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: GOLD + '88',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  xpInput: { flex: 1, color: GOLD, fontSize: 22, fontWeight: '900' },
  xpUnit: { color: GOLD, fontWeight: '900', fontSize: 14 },
  quickPicks: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 },
  quickPickChip: {
    paddingVertical: 6, paddingHorizontal: 10,
    borderRadius: radii.pill,
    borderWidth: 1, borderColor: GOLD + '55',
    backgroundColor: GOLD + '11',
  },
  quickPickText: { color: GOLD, fontWeight: '800', fontSize: 12 },
  helper: { color: colors.textMuted, fontSize: 11, marginTop: 6 },

  boostBlock: { gap: 4 },
  boostRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 12,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 6,
  },
  boostRowActive: { borderColor: GOLD },
  boostLabel: { color: colors.text, fontWeight: '700', fontSize: 13 },
  customGroup: { gap: 4, marginTop: 8 },
  smallInput: {
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 10, fontSize: 14,
  },

  messageInput: {
    minHeight: 70,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 10, fontSize: 13,
    textAlignVertical: 'top',
  },
  charCount: { color: colors.textMuted, fontSize: 10, textAlign: 'right', marginTop: 2 },

  ctaRow: { flexDirection: 'row', gap: 8, marginTop: spacing.md },
  cta: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 12, borderRadius: radii.pill, borderWidth: 1,
  },
  ctaSecondary: { backgroundColor: colors.surfaceGlass, borderColor: colors.border },
  ctaPrimary: { backgroundColor: GOLD, borderColor: GOLD },
  ctaText: { fontWeight: '900', fontSize: 14 },
});
