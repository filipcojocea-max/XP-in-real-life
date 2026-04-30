import React, { useEffect, useMemo, useState } from 'react';
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
import { api, Profile, BoostInventoryItem } from '../api';
import { showAlert, showConfirm } from '../uiAlert';
import { colors, spacing, radii } from '../theme';

type BoostType = 'triple_day' | 'double_week' | 'double_month';
type TabKey = 'topup' | 'available';

type BoostOption = {
  type: BoostType;
  title: string;
  subtitle: string;
  icon: string;
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

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function iconForType(type: string): { icon: string; color: string } {
  if (type === 'triple_day') return { icon: '3x', color: colors.amber };
  if (type === 'double_week') return { icon: '2x', color: colors.cyan };
  if (type === 'double_month') return { icon: '2x', color: colors.green };
  if (type === 'double_day') return { icon: '2x', color: '#FFD700' }; // gold for winner reward
  return { icon: '?', color: colors.textMuted };
}

function labelForDuration(days: number): string {
  if (days === 1) return 'Lasts 24 hours once activated';
  if (days === 7) return 'Lasts 7 days once activated';
  if (days === 30) return 'Lasts 30 days once activated';
  return `Lasts ${days} days once activated`;
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
  const [tab, setTab] = useState<TabKey>('topup');
  const [unlocked, setUnlocked] = useState(!!profile?.boosts_unlocked);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [claimingType, setClaimingType] = useState<BoostType | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  // Force a tick every second so the countdown stays live
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [visible]);

  useEffect(() => {
    setUnlocked(!!profile?.boosts_unlocked);
  }, [profile?.boosts_unlocked, visible]);

  const inventory = profile?.boost_inventory || [];
  const activeBoost = profile?.active_boost || null;
  const activeRemainingMs = useMemo(() => {
    if (!activeBoost?.expires_at) return 0;
    return new Date(activeBoost.expires_at).getTime() - Date.now();
  }, [activeBoost, visible]);

  // ── Actions ───────────────────────────────────────────────────
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
      showAlert('Unlocked! 🎉', 'You can now claim XP boosts from Bonus Top Up.');
    } catch (e: any) {
      showAlert('Invalid code', String(e?.message || 'That code did not work. Double-check and try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  const onClaim = async (b: BoostOption) => {
    if (!unlocked) {
      showAlert('Locked', 'Enter your unlock code first to access XP boosts.');
      return;
    }
    setClaimingType(b.type);
    try {
      const r = await api.claimBoost(b.type);
      onProfileUpdate(r.profile);
      showAlert('Added to Available Bonuses ✨', `${b.title} is waiting in your inventory — tap it there whenever you're ready to use it.`);
      setTab('available');
    } catch (e: any) {
      showAlert('Could not claim', String(e?.message || e));
    } finally {
      setClaimingType(null);
    }
  };

  const onActivateFromInventory = async (item: BoostInventoryItem) => {
    if (activeBoost) {
      const ok = await showConfirm(
        'Replace current boost?',
        `You already have a ${activeBoost.multiplier}× boost active with ${formatCountdown(activeRemainingMs)} left. Activating this will replace it. Continue?`,
        { confirmText: 'Replace', cancelText: 'Cancel' }
      );
      if (!ok) return;
      return doActivate(item);
    }
    const durLabel = labelForDuration(item.duration_days);
    const ok = await showConfirm(
      `Activate ${item.multiplier}× boost?`,
      `${item.label || 'XP Boost'}\n\n${durLabel}\n\nOnce activated the timer starts immediately and cannot be paused.`,
      { confirmText: 'Activate now', cancelText: 'Not yet' }
    );
    if (!ok) return;
    return doActivate(item);
  };

  const doActivate = async (item: BoostInventoryItem) => {
    setActivatingId(item.id);
    try {
      const r = await api.activateBoost({ inventory_id: item.id });
      onProfileUpdate(r.profile);
      showAlert('Boost active! ⚡', `${item.label || 'XP boost'} is now live.`);
    } catch (e: any) {
      showAlert('Could not activate', String(e?.message || e));
    } finally {
      setActivatingId(null);
    }
  };

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

            {/* Tabs */}
            <View style={styles.tabsRow}>
              <TabButton
                label="Bonus Top Up"
                active={tab === 'topup'}
                onPress={() => setTab('topup')}
                testID="pp-tab-topup"
              />
              <TabButton
                label={`Available Bonuses${inventory.length ? ` · ${inventory.length}` : ''}`}
                active={tab === 'available'}
                onPress={() => setTab('available')}
                testID="pp-tab-available"
              />
            </View>

            <ScrollView
              contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Active boost banner (shows on both tabs) */}
              {activeBoost ? (
                <View style={styles.activeBanner}>
                  <Ionicons name="flash" size={18} color={colors.amber} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.activeBannerTitle}>
                      {activeBoost.multiplier}× Boost Active
                    </Text>
                    <Text style={styles.activeBannerDesc}>
                      {formatCountdown(activeRemainingMs)} remaining
                    </Text>
                  </View>
                </View>
              ) : null}

              {tab === 'topup' ? (
                <TopUpTab
                  unlocked={unlocked}
                  code={code}
                  setCode={setCode}
                  submitting={submitting}
                  onSubmitCode={onSubmitCode}
                  claimingType={claimingType}
                  onClaim={onClaim}
                />
              ) : (
                <AvailableTab
                  inventory={inventory}
                  activatingId={activatingId}
                  onActivate={onActivateFromInventory}
                  switchToShop={() => setTab('topup')}
                  unlocked={unlocked}
                />
              )}
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ── Sub-components ─────────────────────────────────────────────
function TabButton({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      style={[styles.tabBtn, active && styles.tabBtnActive]}
      activeOpacity={0.85}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function TopUpTab({
  unlocked, code, setCode, submitting, onSubmitCode, claimingType, onClaim,
}: {
  unlocked: boolean;
  code: string;
  setCode: (s: string) => void;
  submitting: boolean;
  onSubmitCode: () => void;
  claimingType: BoostType | null;
  onClaim: (b: BoostOption) => void;
}) {
  return (
    <View>
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
            Claim a boost below — it'll appear under Available Bonuses for you to activate.
          </Text>
        )}
      </View>

      {/* Boost options */}
      {BOOSTS.map((b) => {
        const isClaiming = claimingType === b.type;
        const locked = !unlocked;
        return (
          <TouchableOpacity
            key={b.type}
            testID={`boost-claim-${b.type}`}
            activeOpacity={0.85}
            disabled={locked || isClaiming}
            onPress={() => onClaim(b)}
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
            {isClaiming ? (
              <ActivityIndicator color={colors.cyan} />
            ) : locked ? (
              <Ionicons name="lock-closed" size={18} color={colors.textMuted} />
            ) : (
              <View style={[styles.claimPill, { borderColor: b.accent, backgroundColor: b.accent + '22' }]}>
                <Ionicons name="add-circle" size={12} color={b.accent} />
                <Text style={[styles.claimPillText, { color: b.accent }]}>Claim</Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}

      <Text style={styles.footnote}>
        Claiming adds a boost to your Available Bonuses — you choose when to activate it.
      </Text>
    </View>
  );
}

function AvailableTab({
  inventory, activatingId, onActivate, switchToShop, unlocked,
}: {
  inventory: BoostInventoryItem[];
  activatingId: string | null;
  onActivate: (it: BoostInventoryItem) => void;
  switchToShop: () => void;
  unlocked: boolean;
}) {
  if (!unlocked) {
    return (
      <View style={styles.center}>
        <Ionicons name="lock-closed" size={32} color={colors.textMuted} />
        <Text style={styles.emptyTitle}>Locked</Text>
        <Text style={styles.emptyDesc}>Enter the unlock code in Bonus Top Up to start collecting boosts.</Text>
        <TouchableOpacity onPress={switchToShop} style={[styles.ghostBtn, { marginTop: 12 }]}>
          <Text style={styles.ghostBtnText}>Go to Bonus Top Up</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!inventory.length) {
    return (
      <View style={styles.center}>
        <Ionicons name="gift-outline" size={32} color={colors.textMuted} />
        <Text style={styles.emptyTitle}>No bonuses yet</Text>
        <Text style={styles.emptyDesc}>Claim one from Bonus Top Up or win the weekly Friends Leaderboard.</Text>
        <TouchableOpacity onPress={switchToShop} style={[styles.ghostBtn, { marginTop: 12 }]}>
          <Text style={styles.ghostBtnText}>Go to Bonus Top Up</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <View>
      {inventory.map((item) => {
        const { icon, color } = iconForType(item.type);
        const isWinnerReward = item.source === 'leaderboard_winner';
        const isActivating = activatingId === item.id;
        return (
          <TouchableOpacity
            key={item.id}
            testID={`boost-inv-${item.id}`}
            activeOpacity={0.85}
            disabled={isActivating}
            onPress={() => onActivate(item)}
            style={[
              styles.boostCard,
              { borderColor: isWinnerReward ? '#FFD700' : color + '88' },
            ]}
          >
            <View style={[styles.boostIcon, { backgroundColor: color + '22', borderColor: color + '77' }]}>
              <Text style={[styles.boostIconText, { color }]}>{icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.boostTitle}>{item.label || `${item.multiplier}× boost`}</Text>
              <Text style={styles.boostSubtitle}>{labelForDuration(item.duration_days)}</Text>
              {isWinnerReward ? (
                <View style={styles.winnerBadge}>
                  <Ionicons name="trophy" size={11} color="#FFD700" />
                  <Text style={styles.winnerBadgeText}>LEADERBOARD WINNER REWARD</Text>
                </View>
              ) : null}
            </View>
            {isActivating ? (
              <ActivityIndicator color={color} />
            ) : (
              <View style={[styles.claimPill, { borderColor: color, backgroundColor: color + '22' }]}>
                <Ionicons name="play" size={11} color={color} />
                <Text style={[styles.claimPillText, { color }]}>Activate</Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
      <Text style={styles.footnote}>
        Activation starts a live countdown. You'll see it on your profile until the boost expires.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  sheet: {
    // Use explicit height (not maxHeight) so the flex chain has a
    // concrete size to divide. `maxHeight` alone left the sheet
    // effectively zero-height on RN Web, rendering the modal blank
    // even though the backdrop was visible.
    height: '85%',
    backgroundColor: colors.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: colors.cyan + '55',
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

  tabsRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: 8,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  tabBtnActive: {
    backgroundColor: colors.cyan + '22',
    borderColor: colors.cyan,
  },
  tabText: {
    color: colors.textSecondary,
    fontWeight: '900',
    fontSize: 12,
    letterSpacing: 0.4,
  },
  tabTextActive: { color: colors.cyan },

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
  activeBannerDesc: { color: colors.text, fontSize: 12, marginTop: 2, fontVariant: ['tabular-nums'] as any },

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

  winnerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
    backgroundColor: '#FFD70015',
    borderWidth: 1,
    borderColor: '#FFD70088',
  },
  winnerBadgeText: {
    color: '#FFD700',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },

  claimPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  claimPillText: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    gap: 6,
  },
  emptyTitle: { color: colors.text, fontWeight: '900', fontSize: 15, marginTop: 8 },
  emptyDesc: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  ghostBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.cyan,
    backgroundColor: colors.cyan + '15',
  },
  ghostBtnText: { color: colors.cyan, fontWeight: '900', fontSize: 12, letterSpacing: 0.5 },

  footnote: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    marginTop: spacing.md,
    lineHeight: 16,
  },
});
