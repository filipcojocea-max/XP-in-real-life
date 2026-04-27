import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api, Profile } from '../api';
import { showAlert } from '../uiAlert';
import { colors, spacing, radii } from '../theme';

type BoostType = 'triple_day' | 'double_week' | 'double_month';

type BoostOption = {
  type: BoostType;
  title: string;
  subtitle: string;
  icon: string;          // e.g. "3x" or "2x"
  iconColor: string;
  accent: string;
};

const BOOSTS: BoostOption[] = [
  {
    type: 'triple_day',
    title: 'Triple your points today!',
    subtitle: 'All quest XP earned today is multiplied by 3',
    icon: '3x',
    iconColor: colors.amber,
    accent: colors.amber,
  },
  {
    type: 'double_week',
    title: 'Double your points for 7 days!',
    subtitle: 'Every quest XP doubled for a full week',
    icon: '2x',
    iconColor: colors.cyan,
    accent: colors.cyan,
  },
  {
    type: 'double_month',
    title: 'Double your points for 1 month!',
    subtitle: 'Every quest XP doubled for 30 whole days',
    icon: '2x',
    iconColor: colors.green,
    accent: colors.green,
  },
];

function timeLeftLabel(iso: string): string {
  const d = new Date(iso).getTime() - Date.now();
  if (d <= 0) return 'expired';
  const hrs = Math.floor(d / (1000 * 60 * 60));
  if (hrs < 24) return `${hrs}h left`;
  const days = Math.floor(hrs / 24);
  return `${days}d left`;
}

export default function PointsPlusModal({
  visible,
  onClose,
  profile,
  onProfileUpdate,
}: {
  visible: boolean;
  onClose: () => void;
  profile: Profile | null;
  onProfileUpdate: (p: Profile) => void;
}) {
  const [unlocked, setUnlocked] = useState(!!profile?.boosts_unlocked);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activating, setActivating] = useState<BoostType | null>(null);

  useEffect(() => {
    setUnlocked(!!profile?.boosts_unlocked);
  }, [profile?.boosts_unlocked, visible]);

  const onSubmitCode = async () => {
    const c = code.trim();
    if (!c) {
      showAlert('Enter a code', 'Please enter your unlock code first.');
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.unlockBoosts(c);
      setUnlocked(!!r.boosts_unlocked);
      onProfileUpdate(r.profile);
      setCode('');
      showAlert('Unlocked! 🎉', 'You can now activate XP boosts.');
    } catch (e: any) {
      showAlert('Invalid code', String(e?.message || 'That code did not work. Double-check and try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  const onActivate = async (b: BoostOption) => {
    if (!unlocked) {
      showAlert('Locked', 'Enter your unlock code first to access XP boosts.');
      return;
    }
    setActivating(b.type);
    try {
      const r = await api.activateBoost(b.type);
      onProfileUpdate(r.profile);
      showAlert('Boost active! ⚡', `${b.title} is now live.`);
      onClose();
    } catch (e: any) {
      showAlert('Could not activate', String(e?.message || e));
    } finally {
      setActivating(null);
    }
  };

  const activeBoost = profile?.active_boost || null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheet}
        >
          <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
            {/* Header */}
            <View style={styles.header}>
              <View>
                <Text style={styles.kicker}>POINTS+</Text>
                <Text style={styles.title}>Boost Your Points</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn} testID="points-plus-close">
                <Ionicons name="close" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>

            <ScrollView
              contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Active boost banner */}
              {activeBoost ? (
                <View style={styles.activeBanner}>
                  <Ionicons name="flash" size={18} color={colors.amber} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.activeBannerTitle}>
                      {activeBoost.multiplier}× Boost Active
                    </Text>
                    <Text style={styles.activeBannerDesc}>
                      {timeLeftLabel(activeBoost.expires_at)}
                    </Text>
                  </View>
                </View>
              ) : null}

              {/* Unlock code input */}
              <View style={[styles.codeCard, unlocked && styles.codeCardUnlocked]}>
                <View style={styles.codeHead}>
                  <Ionicons
                    name={unlocked ? 'checkmark-circle' : 'lock-closed'}
                    size={16}
                    color={unlocked ? colors.green : colors.amber}
                  />
                  <Text style={[styles.codeLabel, { color: unlocked ? colors.green : colors.amber }]}>
                    {unlocked ? 'BOOSTS UNLOCKED' : 'IMPORT CODE TO ACCESS'}
                  </Text>
                </View>
                {!unlocked ? (
                  <View style={styles.codeRow}>
                    <TextInput
                      testID="points-plus-code-input"
                      value={code}
                      onChangeText={setCode}
                      placeholder="Enter unlock code"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      style={styles.codeInput}
                      onSubmitEditing={onSubmitCode}
                      returnKeyType="done"
                    />
                    <TouchableOpacity
                      testID="points-plus-submit-code"
                      onPress={onSubmitCode}
                      disabled={submitting}
                      style={[styles.codeBtn, submitting && { opacity: 0.6 }]}
                    >
                      {submitting ? (
                        <ActivityIndicator color={colors.bg} />
                      ) : (
                        <Text style={styles.codeBtnText}>Unlock</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                ) : (
                  <Text style={styles.codeHint}>
                    Tap a boost below to activate it.
                  </Text>
                )}
              </View>

              {/* Boost options */}
              {BOOSTS.map((b) => {
                const isActivating = activating === b.type;
                const locked = !unlocked;
                return (
                  <TouchableOpacity
                    key={b.type}
                    testID={`boost-${b.type}`}
                    activeOpacity={0.85}
                    disabled={locked || isActivating}
                    onPress={() => onActivate(b)}
                    style={[
                      styles.boostCard,
                      { borderColor: locked ? colors.border : b.accent + '88' },
                      locked && styles.boostCardLocked,
                    ]}
                  >
                    <View style={[styles.boostIcon, { backgroundColor: b.accent + '22', borderColor: b.accent + '77' }]}>
                      <Text style={[styles.boostIconText, { color: b.iconColor }]}>{b.icon}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.boostTitle, locked && { color: colors.textMuted }]}>
                        {b.title}
                      </Text>
                      <Text style={styles.boostSubtitle}>{b.subtitle}</Text>
                    </View>
                    {isActivating ? (
                      <ActivityIndicator color={colors.cyan} />
                    ) : locked ? (
                      <Ionicons name="lock-closed" size={18} color={colors.textMuted} />
                    ) : (
                      <Ionicons name="chevron-forward" size={20} color={b.accent} />
                    )}
                  </TouchableOpacity>
                );
              })}

              <Text style={styles.footnote}>
                XP multiplier applies to every quest you complete while the boost is active.
                {'\n'}Activating a new boost replaces the current one.
              </Text>
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '88%',
    backgroundColor: colors.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: colors.cyan + '55',
    shadowColor: colors.cyan,
    shadowOpacity: 0.3,
    shadowRadius: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  kicker: {
    color: colors.amber,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2.5,
    marginBottom: 4,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
  },

  activeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.amber + '18',
    borderWidth: 1,
    borderColor: colors.amber + '88',
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  activeBannerTitle: { color: colors.amber, fontWeight: '900', fontSize: 14 },
  activeBannerDesc: { color: colors.text, fontSize: 12, marginTop: 2 },

  codeCard: {
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.amber + '55',
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  codeCardUnlocked: { borderColor: colors.green + '55' },
  codeHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  codeLabel: { fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  codeInput: {
    flex: 1,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontWeight: '700',
    letterSpacing: 1,
    fontSize: 14,
  },
  codeBtn: {
    backgroundColor: colors.amber,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: radii.md,
  },
  codeBtnText: { color: colors.bg, fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },
  codeHint: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },

  boostCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: 10,
  },
  boostCardLocked: { opacity: 0.7 },
  boostIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boostIconText: { fontSize: 18, fontWeight: '900', letterSpacing: -0.5 },
  boostTitle: { color: colors.text, fontSize: 14, fontWeight: '900', letterSpacing: -0.2 },
  boostSubtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  footnote: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    marginTop: spacing.md,
    lineHeight: 16,
  },
});
