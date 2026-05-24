/**
 * SuspendUserModal — admin/Creator-only duration picker shown when the
 * Creator taps "Suspend Account" inside a player's profile modal.
 *
 * Lets the admin pick from preset chips (12h / 1d / 2d / 7d), enter a
 * custom duration in days, OR choose "Until I lift it" for an indefinite
 * suspension. Optional reason field is stored on the profile and shown
 * to the suspended user inside SuspensionAlertModal.
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

type Props = {
  visible: boolean;
  targetUserId: string;
  targetName: string;
  onClose: () => void;
  onSuspended?: () => void;
};

type PresetKey = '12h' | '1d' | '2d' | '7d' | 'custom' | 'forever';

const PRESETS: { key: PresetKey; label: string; hours?: number }[] = [
  { key: '12h', label: '12 hours', hours: 12 },
  { key: '1d', label: '1 day', hours: 24 },
  { key: '2d', label: '2 days', hours: 48 },
  { key: '7d', label: '7 days', hours: 168 },
  { key: 'custom', label: 'Custom…' },
  { key: 'forever', label: 'Until I lift it' },
];

export function SuspendUserModal({ visible, targetUserId, targetName, onClose, onSuspended }: Props) {
  const [picked, setPicked] = useState<PresetKey>('1d');
  const [customDays, setCustomDays] = useState('3');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm() {
    let opts: { duration_hours?: number; forever?: boolean; reason?: string } = {
      reason: reason.trim().slice(0, 280),
    };
    if (picked === 'forever') {
      opts.forever = true;
    } else if (picked === 'custom') {
      const days = parseFloat(customDays);
      if (!Number.isFinite(days) || days <= 0) {
        showAlert('Invalid duration', 'Please type a positive number of days.');
        return;
      }
      opts.duration_hours = days * 24;
    } else {
      const preset = PRESETS.find((p) => p.key === picked);
      opts.duration_hours = preset?.hours;
    }
    setSubmitting(true);
    try {
      await api.adminSuspendUser(targetUserId, opts);
      onSuspended?.();
      onClose();
      showAlert(
        'Account suspended',
        `${targetName}'s account has been suspended${opts.forever ? ' indefinitely.' : ` for ${picked === 'custom' ? `${customDays} day(s)` : PRESETS.find((p) => p.key === picked)?.label}.`}\nThey will be signed out on their next API call.`
      );
    } catch (e: any) {
      showAlert('Could not suspend', String(e?.message || e));
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
            <Ionicons name="ban" size={20} color={colors.red} />
            <Text style={styles.headerTitle}>Suspend {targetName}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} testID="suspend-close">
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.question}>How long do you want to suspend this account for?</Text>

          <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>
            <View style={styles.optionsGrid}>
              {PRESETS.map((p) => {
                const active = picked === p.key;
                return (
                  <TouchableOpacity
                    key={p.key}
                    onPress={() => setPicked(p.key)}
                    style={[styles.optionChip, active && styles.optionChipActive]}
                    activeOpacity={0.85}
                    testID={`suspend-option-${p.key}`}
                  >
                    <Text style={[styles.optionText, active && styles.optionTextActive]}>{p.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {picked === 'custom' ? (
              <View style={styles.customRow}>
                <Text style={styles.customLabel}>Days</Text>
                <TextInput
                  testID="suspend-custom-days"
                  value={customDays}
                  onChangeText={setCustomDays}
                  keyboardType="numeric"
                  maxLength={5}
                  style={styles.customInput}
                  placeholderTextColor={colors.textMuted}
                  placeholder="3"
                />
              </View>
            ) : null}

            <Text style={styles.reasonLabel}>Reason (optional, shown to the user)</Text>
            <TextInput
              testID="suspend-reason"
              value={reason}
              onChangeText={setReason}
              multiline
              maxLength={280}
              placeholder="e.g. Repeated abusive messages in chat"
              placeholderTextColor={colors.textMuted}
              style={styles.reasonInput}
            />
            <Text style={styles.charCount}>{reason.length}/280</Text>
          </ScrollView>

          <View style={styles.ctaRow}>
            <TouchableOpacity
              style={[styles.cta, styles.ctaSecondary]}
              onPress={onClose}
              disabled={submitting}
              testID="suspend-cancel"
            >
              <Text style={[styles.ctaText, { color: colors.textMuted }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cta, styles.ctaDanger, submitting && { opacity: 0.6 }]}
              onPress={handleConfirm}
              disabled={submitting}
              testID="suspend-confirm"
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="ban" size={16} color="#fff" />
                  <Text style={[styles.ctaText, { color: '#fff' }]}>Suspend now</Text>
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
    borderTopColor: colors.red,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: spacing.sm,
  },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  closeBtn: { padding: 6 },
  question: { color: colors.textSecondary, fontSize: 14, marginBottom: spacing.md, lineHeight: 20 },
  optionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: spacing.md,
  },
  optionChip: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionChipActive: { backgroundColor: colors.red + '22', borderColor: colors.red },
  optionText: { color: colors.textSecondary, fontWeight: '700', fontSize: 13 },
  optionTextActive: { color: colors.red, fontWeight: '900' },

  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: spacing.md,
  },
  customLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '800' },
  customInput: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    paddingVertical: 6,
  },

  reasonLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1, marginBottom: 4 },
  reasonInput: {
    minHeight: 70,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    padding: 10,
    fontSize: 13,
    textAlignVertical: 'top',
  },
  charCount: { color: colors.textMuted, fontSize: 10, textAlign: 'right', marginTop: 2 },

  ctaRow: { flexDirection: 'row', gap: 8, marginTop: spacing.md },
  cta: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  ctaSecondary: { backgroundColor: colors.surfaceGlass, borderColor: colors.border },
  ctaDanger: { backgroundColor: colors.red, borderColor: colors.red },
  ctaText: { fontWeight: '900', fontSize: 14 },
});
