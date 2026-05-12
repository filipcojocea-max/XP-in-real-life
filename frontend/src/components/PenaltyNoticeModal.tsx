/**
 * PenaltyNoticeModal — full-screen modal shown to a player the next
 * time they open the app after a Creator/Admin has applied an XP
 * penalty against them.
 *
 *  Features:
 *    • Shows the deducted XP amount (large, red).
 *    • Shows the Creator's written note verbatim.
 *    • Bottom button: "Hold to close this notification" — requires
 *      a 2-second long-press so the player can't tap-dismiss by
 *      accident. Visual progress ring fills as they hold.
 *    • Acknowledges the penalty on the backend the moment they close.
 *
 *  Stays modal-locked until acknowledged: there is no ✕ button, no
 *  swipe-down, no Android back-button dismiss. The hold is the only
 *  exit.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  Animated,
  Easing,
  BackHandler,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii } from '../theme';
import type { PenaltyNotice } from '../api';

const HOLD_MS = 2000;

export function PenaltyNoticeModal({
  penalty,
  onClose,
}: {
  penalty: PenaltyNotice | null;
  onClose: () => void;
}) {
  const [progress] = useState(() => new Animated.Value(0));
  const [holding, setHolding] = useState(false);
  const completed = useRef(false);
  const visible = !!penalty;

  // Block hardware back button while the modal is up.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [visible]);

  // Reset state every time a new penalty arrives so the hold starts
  // from 0% even if the player had partially held the previous one.
  useEffect(() => {
    if (!visible) return;
    completed.current = false;
    progress.setValue(0);
    setHolding(false);
  }, [visible, penalty?.id, progress]);

  const startHold = () => {
    if (completed.current) return;
    setHolding(true);
    Animated.timing(progress, {
      toValue: 1,
      duration: HOLD_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && !completed.current) {
        completed.current = true;
        onClose();
      }
    });
  };

  const cancelHold = () => {
    if (completed.current) return;
    setHolding(false);
    Animated.timing(progress, {
      toValue: 0,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  };

  if (!penalty) return null;

  const fillW = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <Modal visible animationType="fade" transparent={false} statusBarTranslucent>
      <SafeAreaView style={styles.root}>
        <View style={styles.headerStripe} />
        <ScrollView contentContainerStyle={styles.body} bounces={false}>
          <View style={styles.iconWrap}>
            <Ionicons name="warning" size={48} color={colors.red} />
          </View>
          <Text style={styles.kicker}>XP PENALTY RECEIVED</Text>
          <Text style={styles.title}>From the Creator</Text>

          <View style={styles.amountBox}>
            <Text style={styles.amountLabel}>XP DEDUCTED</Text>
            <Text style={styles.amountValue}>−{penalty.amount.toLocaleString()} XP</Text>
          </View>

          {penalty.note ? (
            <View style={styles.noteBox}>
              <Text style={styles.noteLabel}>NOTE FROM CREATOR</Text>
              <Text style={styles.noteValue}>{penalty.note}</Text>
            </View>
          ) : (
            <Text style={styles.noNote}>(No note was attached.)</Text>
          )}

          <View style={styles.metaRow}>
            <Ionicons name="time-outline" size={12} color={colors.textMuted} />
            <Text style={styles.metaText}>
              {(() => {
                try {
                  return new Date(penalty.created_at).toLocaleString();
                } catch {
                  return penalty.created_at;
                }
              })()}
            </Text>
          </View>
        </ScrollView>

        {/* Hold-to-close pill */}
        <View style={styles.footer}>
          <Pressable
            onPressIn={startHold}
            onPressOut={cancelHold}
            style={[styles.holdBtn, holding && styles.holdBtnActive]}
            testID="penalty-hold-close"
          >
            <Animated.View style={[styles.holdFill, { width: fillW }]} />
            <View style={styles.holdContent}>
              <Ionicons name={holding ? 'hourglass' : 'hand-left'} size={16} color={colors.text} />
              <Text style={styles.holdText}>
                {holding ? 'Keep holding…' : 'Hold to close this notification'}
              </Text>
            </View>
          </Pressable>
          <Text style={styles.holdHint}>Hold for 2 seconds to acknowledge.</Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  headerStripe: { height: 4, backgroundColor: colors.red },
  body: { flexGrow: 1, padding: spacing.lg, alignItems: 'center' },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.red + '22',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
    borderWidth: 2,
    borderColor: colors.red + '88',
  },
  kicker: {
    color: colors.red,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
    marginTop: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '900',
    marginTop: 4,
    textAlign: 'center',
  },
  amountBox: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.red + '11',
    borderWidth: 1,
    borderColor: colors.red + '55',
    alignItems: 'center',
    minWidth: 240,
  },
  amountLabel: {
    color: colors.red,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 2,
  },
  amountValue: {
    color: colors.red,
    fontSize: 36,
    fontWeight: '900',
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  noteBox: {
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    width: '100%',
  },
  noteLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  noteValue: { color: colors.text, fontSize: 14, lineHeight: 20 },
  noNote: { color: colors.textMuted, fontSize: 12, marginTop: spacing.md, fontStyle: 'italic' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.md },
  metaText: { color: colors.textMuted, fontSize: 11 },

  footer: { padding: spacing.lg, gap: 6 },
  holdBtn: {
    height: 56,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  holdBtnActive: { borderColor: colors.red },
  holdFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.red + '55',
  },
  holdContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.md,
  },
  holdText: { color: colors.text, fontSize: 14, fontWeight: '900' },
  holdHint: { textAlign: 'center', color: colors.textMuted, fontSize: 11 },
});

export default PenaltyNoticeModal;
