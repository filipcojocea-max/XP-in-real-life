import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../src/api';
import { showAlert } from '../src/uiAlert';
import { colors, spacing, radii } from '../src/theme';
import { AU_TIMEZONES, AuZone } from '../src/auTimezones';
import MorningTimePicker from '../src/components/MorningTimePicker';

type Step = 'tz' | 'time';

/**
 * Day-Anchor Setup — 2 forced questions asked once per account:
 *   1. "What time zone are you in?" (Australia only)
 *   2. "Select what time you start your morning!"
 *
 * Once answered, both fields are LOCKED and can only be changed via
 * "Reset Progress" in Profile. This is gated in /app/_layout.tsx.
 */
export default function DayAnchorSetup() {
  const [step, setStep] = useState<Step>('tz');
  const [zone, setZone] = useState<AuZone | null>(null);
  const [saving, setSaving] = useState(false);

  const onPickZone = (z: AuZone) => {
    setZone(z);
    setStep('time');
  };

  const onDoneTime = async (wakeTime: string) => {
    if (!zone) {
      showAlert('Pick a timezone first', 'Go back and choose your city.');
      setStep('tz');
      return;
    }
    setSaving(true);
    try {
      await api.setDayAnchor(zone.iana, wakeTime);
      router.replace('/');
    } catch (e: any) {
      // If the fields got persisted by a previous attempt but the gate bounced
      // us back, the backend will respond 400 tz_locked / day_start_locked.
      // In that case the answer is already saved — just continue to home.
      const msg = String(e?.message || '');
      if (msg.includes('tz_locked') || msg.includes('day_start_locked') || msg.includes('locked')) {
        router.replace('/');
        return;
      }
      showAlert('Could not save', msg || 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (step === 'time') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.stepHeader}>
          <TouchableOpacity onPress={() => setStep('tz')} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.text} />
            <Text style={styles.backTxt}>Change city</Text>
          </TouchableOpacity>
          <Text style={styles.stepHint}>Step 2 of 2</Text>
        </View>
        <MorningTimePicker
          title={"Select what time you\nstart your morning"}
          subtitle={`This becomes your new day boundary. Every task, challenge and sleep-cycle rolls over AT this time in ${zone?.city}.\n\nThis answer is LOCKED once saved.`}
          doneLabel="Lock in my morning time"
          footnote="To change later, reset your progress in Profile."
          onDone={onDoneTime}
        />
        {saving ? (
          <View style={styles.savingOverlay}>
            <ActivityIndicator color={colors.cyan} size="large" />
          </View>
        ) : null}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.stepHeader}>
        <View />
        <Text style={styles.stepHint}>Step 1 of 2</Text>
      </View>
      <View style={styles.intro}>
        <View style={styles.iconWrap}>
          <Ionicons name="earth" size={32} color={colors.cyan} />
        </View>
        <Text style={styles.kicker}>ONE LAST THING</Text>
        <Text style={styles.title}>What time zone{'\n'}are you in?</Text>
        <Text style={styles.subtitle}>
          Pick the Australian city closest to you. Your entire app — quests, challenges,
          sleep coach, the leaderboard — will run on your local time.
        </Text>
      </View>
      <FlatList
        data={AU_TIMEZONES}
        keyExtractor={(z) => `${z.iana}-${z.city}-${z.state}`}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.zoneRow, zone?.iana === item.iana && styles.zoneRowActive]}
            activeOpacity={0.85}
            onPress={() => onPickZone(item)}
            testID={`zone-${item.iana}`}
          >
            <View style={styles.zoneFlag}>
              <Text style={styles.zoneFlagTxt}>{item.state}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.zoneCity}>{item.city}</Text>
              <Text style={styles.zoneSub}>
                {item.abbrev} · {item.offset}
                {item.notes ? ` · ${item.notes}` : ''}
              </Text>
            </View>
            <Ionicons
              name={zone?.iana === item.iana ? 'radio-button-on' : 'chevron-forward'}
              size={20}
              color={zone?.iana === item.iana ? colors.cyan : colors.textMuted}
            />
          </TouchableOpacity>
        )}
      />
      <View style={styles.footer}>
        <Text style={styles.footerHint}>
          This answer is locked after step 2. You can only change it by resetting progress.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backTxt: { color: colors.text, fontWeight: '700', fontSize: 13 },
  stepHint: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  intro: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.cyan + '22',
    borderWidth: 1,
    borderColor: colors.cyan + '88',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  kicker: {
    color: colors.cyan,
    fontWeight: '900',
    fontSize: 11,
    letterSpacing: 2,
    marginBottom: 6,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.5,
    lineHeight: 32,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 19,
    paddingHorizontal: spacing.md,
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  zoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: 8,
  },
  zoneRowActive: {
    borderColor: colors.cyan,
    backgroundColor: colors.cyan + '12',
  },
  zoneFlag: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.green + '22',
    borderWidth: 1,
    borderColor: colors.green + '77',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoneFlagTxt: { color: colors.green, fontWeight: '900', fontSize: 11, letterSpacing: 1 },
  zoneCity: { color: colors.text, fontWeight: '900', fontSize: 15 },
  zoneSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },

  footer: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  footerHint: { color: colors.textMuted, fontSize: 11, textAlign: 'center' },

  savingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
