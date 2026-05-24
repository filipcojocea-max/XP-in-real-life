import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii } from '../theme';

const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }

function to24h(h12: number, m: number, ampm: 'AM' | 'PM'): string {
  let h = h12 % 12;
  if (ampm === 'PM') h += 12;
  return `${pad(h)}:${pad(m)}`;
}

function from24h(s: string | undefined): { h12: number; m: number; ampm: 'AM' | 'PM' } {
  const [hh = '7', mm = '00'] = (s || '07:00').split(':');
  let h = parseInt(hh, 10);
  const m = parseInt(mm, 10);
  const ampm: 'AM' | 'PM' = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  // Snap minutes to nearest step
  const snapped = MINUTES.reduce((a, b) =>
    Math.abs(b - m) < Math.abs(a - m) ? b : a, MINUTES[0]);
  return { h12: h, m: snapped, ampm };
}

export type MorningTimePickerProps = {
  /** Existing wake_time in HH:MM 24h format. Defaults to 07:00. */
  initialTime?: string;
  /** Headline text shown above the time picker. */
  title?: string;
  /** Sub-headline / explanation. */
  subtitle?: string;
  /** Label of the primary action button. */
  doneLabel?: string;
  /** Show the small footnote below the button. */
  footnote?: string;
  /** Called when user confirms. Should resolve when saved. */
  onDone: (wakeTime: string) => Promise<void> | void;
  /** Optional cancel/skip handler. If absent, no cancel button is shown. */
  onCancel?: () => void;
  /** Show as compact (less padding, smaller hero icon). */
  compact?: boolean;
};

export default function MorningTimePicker({
  initialTime,
  title = 'Select the time that\nstarts your morning',
  subtitle = 'Each new day\'s challenge will unlock at this time.\nYou\'ll have exactly 24 hours to complete it.',
  doneLabel = 'Done',
  footnote = 'You can change this anytime from Profile.',
  onDone,
  onCancel,
  compact = false,
}: MorningTimePickerProps) {
  const init = useMemo(() => from24h(initialTime), [initialTime]);
  const [hour12, setHour12] = useState(init.h12);
  const [minute, setMinute] = useState(init.m);
  const [ampm, setAmpm] = useState<'AM' | 'PM'>(init.ampm);
  const [saving, setSaving] = useState(false);

  const wakeTime = useMemo(() => to24h(hour12, minute, ampm), [hour12, minute, ampm]);

  const onPressDone = async () => {
    setSaving(true);
    try {
      await onDone(wakeTime);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[styles.content, compact && styles.contentCompact]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View style={styles.iconHero}>
        <View style={[styles.iconBubble, compact && styles.iconBubbleCompact]}>
          <Ionicons name="sunny" size={compact ? 36 : 48} color={colors.amber} />
        </View>
      </View>
      <Text style={styles.kicker}>BEFORE WE START</Text>
      <Text style={[styles.title, compact && styles.titleCompact]}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>

      {/* Big time display */}
      <View style={styles.timeDisplay}>
        <Text style={[styles.timeBig, compact && styles.timeBigCompact]}>
          {pad(hour12)}<Text style={styles.timeColon}>:</Text>{pad(minute)}
        </Text>
        <View style={styles.ampmGroup}>
          <TouchableOpacity
            testID="ampm-am"
            onPress={() => setAmpm('AM')}
            style={[styles.ampmBtn, ampm === 'AM' && styles.ampmBtnActive]}
          >
            <Text style={[styles.ampmText, ampm === 'AM' && styles.ampmTextActive]}>AM</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="ampm-pm"
            onPress={() => setAmpm('PM')}
            style={[styles.ampmBtn, ampm === 'PM' && styles.ampmBtnActive]}
          >
            <Text style={[styles.ampmText, ampm === 'PM' && styles.ampmTextActive]}>PM</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Hour & Minute steppers */}
      <View style={styles.stepperRow}>
        <Stepper
          testID="hour-stepper"
          label="HOUR"
          value={hour12}
          onDec={() => setHour12((h) => (h === 1 ? 12 : h - 1))}
          onInc={() => setHour12((h) => (h === 12 ? 1 : h + 1))}
          displayFn={(v) => pad(v)}
        />
        <Stepper
          testID="minute-stepper"
          label="MINUTE"
          value={minute}
          onDec={() => {
            const idx = MINUTES.indexOf(minute);
            setMinute(MINUTES[(idx - 1 + MINUTES.length) % MINUTES.length]);
          }}
          onInc={() => {
            const idx = MINUTES.indexOf(minute);
            setMinute(MINUTES[(idx + 1) % MINUTES.length]);
          }}
          displayFn={(v) => pad(v)}
        />
      </View>

      {/* Quick-pick chips */}
      <Text style={styles.quickLabel}>Quick picks</Text>
      <View style={styles.quickRow}>
        {[
          { h: 5, m: 30, ap: 'AM' as const, label: '5:30 AM' },
          { h: 6, m: 0, ap: 'AM' as const, label: '6:00 AM' },
          { h: 7, m: 0, ap: 'AM' as const, label: '7:00 AM' },
          { h: 8, m: 0, ap: 'AM' as const, label: '8:00 AM' },
          { h: 9, m: 0, ap: 'AM' as const, label: '9:00 AM' },
        ].map((q) => {
          const active = hour12 === q.h && minute === q.m && ampm === q.ap;
          return (
            <TouchableOpacity
              key={q.label}
              testID={`quick-${q.label.replace(/[\s:]/g, '')}`}
              onPress={() => { setHour12(q.h); setMinute(q.m); setAmpm(q.ap); }}
              style={[styles.quickChip, active && styles.quickChipActive]}
            >
              <Text style={[styles.quickChipText, active && styles.quickChipTextActive]}>
                {q.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={{ height: spacing.lg }} />

      <TouchableOpacity
        testID="morning-done"
        style={[styles.cta, saving && { opacity: 0.7 }]}
        disabled={saving}
        onPress={onPressDone}
        activeOpacity={0.85}
      >
        {saving ? (
          <ActivityIndicator color={colors.bg} />
        ) : (
          <>
            <Ionicons name="checkmark-circle" size={20} color={colors.bg} />
            <Text style={styles.ctaText}>{doneLabel}</Text>
          </>
        )}
      </TouchableOpacity>

      {onCancel ? (
        <TouchableOpacity
          testID="morning-cancel"
          onPress={onCancel}
          disabled={saving}
          style={styles.cancelBtn}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      ) : null}

      {footnote ? <Text style={styles.footnote}>{footnote}</Text> : null}
    </ScrollView>
  );
}

function Stepper({
  testID, label, value, onDec, onInc, displayFn,
}: {
  testID?: string;
  label: string;
  value: number;
  onDec: () => void;
  onInc: () => void;
  displayFn: (v: number) => string;
}) {
  return (
    <View style={styles.stepperWrap} testID={testID}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperBox}>
        <TouchableOpacity onPress={onDec} style={styles.stepperBtn} testID={`${testID}-dec`}>
          <Ionicons name="remove" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.stepperValue}>{displayFn(value)}</Text>
        <TouchableOpacity onPress={onInc} style={styles.stepperBtn} testID={`${testID}-inc`}>
          <Ionicons name="add" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
  },
  contentCompact: {
    paddingTop: spacing.md,
  },
  iconHero: { alignItems: 'center', marginBottom: spacing.md },
  iconBubble: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.amber + '22',
    borderWidth: 2,
    borderColor: colors.amber + '88',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBubbleCompact: { width: 64, height: 64, borderRadius: 32 },
  kicker: {
    color: colors.amber,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 2.5,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.7,
    lineHeight: 32,
    marginBottom: spacing.md,
  },
  titleCompact: { fontSize: 22, lineHeight: 28 },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: spacing.lg,
  },
  timeDisplay: {
    backgroundColor: colors.surfaceGlass,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  timeBig: {
    color: colors.cyan,
    fontSize: 64,
    fontWeight: '900',
    letterSpacing: -3,
    fontVariant: ['tabular-nums'],
    ...Platform.select({
      web: { fontFamily: 'system-ui, -apple-system, sans-serif' },
    }),
  },
  timeBigCompact: { fontSize: 56 },
  timeColon: { color: colors.textSecondary },
  ampmGroup: {
    flexDirection: 'row',
    gap: 6,
    marginTop: spacing.md,
    backgroundColor: colors.bg,
    padding: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ampmBtn: {
    paddingVertical: 8,
    paddingHorizontal: 22,
    borderRadius: radii.pill,
  },
  ampmBtnActive: { backgroundColor: colors.cyan },
  ampmText: {
    color: colors.textSecondary,
    fontWeight: '900',
    fontSize: 13,
    letterSpacing: 1,
  },
  ampmTextActive: { color: colors.bg },

  stepperRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  stepperWrap: { flex: 1 },
  stepperLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.5,
    textAlign: 'center',
    marginBottom: 6,
  },
  stepperBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceGlass,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  stepperBtn: {
    width: 44,
    height: 44,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  stepperValue: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
    minWidth: 60,
    textAlign: 'center',
  },

  quickLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quickChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
  },
  quickChipActive: { backgroundColor: colors.green, borderColor: colors.green },
  quickChipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  quickChipTextActive: { color: colors.bg, fontWeight: '900' },

  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.green,
    paddingVertical: 18,
    borderRadius: radii.pill,
    marginBottom: 8,
  },
  ctaText: { color: colors.bg, fontWeight: '900', fontSize: 16, letterSpacing: 0.4 },
  cancelBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  footnote: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 4,
  },
});
