/**
 * /treasure/settings — Mini-App Settings for Buried Treasure.
 *
 * Two sections now live on this single screen:
 *
 *   1. SAVED LOCATION
 *      The persistent area/radius the player saved on their first run.
 *      Per 2026-06-01 spec the map picker no longer fires every time
 *      they enter /treasure — it only fires when there's no area saved.
 *      After that, this card is the only path to edit it.
 *
 *   2. AWAKE HOURS  (added 2026-06-01 — Smart Availability Filter)
 *      HH:MM start/end in the user's local timezone, plus an optional
 *      "Sleep all day" toggle. Saving here updates the server-side
 *      filter that excludes sleeping players from treasure selection
 *      and hides asleep groups from /bt/groups/available.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import BTMapPicker, { type BTAreaPicked } from '../../src/components/BTMapPicker';
import { api } from '../../src/api';
import { colors, radii, spacing } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

type Stage = 'loading' | 'view' | 'editing' | 'saving';

const fmtRadius = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;

// ── Awake-hours helpers ───────────────────────────────────────────────
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const detectTz = (): string => {
  try {
    // Available on every JS runtime we target (Hermes, V8, web).
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const normalizeHHMM = (raw: string, fallback: string): string => {
  const t = (raw || '').trim();
  if (HHMM_RE.test(t)) return t;
  // Try recovering "8:5" → "08:05"
  const m = /^(\d{1,2}):?(\d{0,2})$/.exec(t);
  if (m) {
    const h = Math.min(23, Math.max(0, parseInt(m[1] || '0', 10)));
    const mm = Math.min(59, Math.max(0, parseInt(m[2] || '0', 10)));
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  return fallback;
};

export default function TreasureSettings() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('loading');
  const [area, setArea] = useState<{ lat: number; lng: number; radius_m: number; label?: string | null; updated_at?: string } | null>(null);

  // Schedule state — Smart Availability Filter
  const [awakeStart, setAwakeStart] = useState('08:00');
  const [awakeEnd, setAwakeEnd] = useState('23:00');
  const [sleepAllDay, setSleepAllDay] = useState(false);
  const [tz, setTz] = useState<string>(detectTz());
  const [isAwakeNow, setIsAwakeNow] = useState<boolean>(true);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleDirty, setScheduleDirty] = useState(false);

  const load = useCallback(async () => {
    setStage('loading');
    try {
      const [s, sched] = await Promise.all([
        api.btGetSettings(),
        api.btGetSchedule().catch(() => null as any),
      ]);
      setArea(s.area || null);
      if (sched?.schedule) {
        setAwakeStart(sched.schedule.awake_start || '08:00');
        setAwakeEnd(sched.schedule.awake_end || '23:00');
        setSleepAllDay(!!sched.schedule.sleep_all_day);
        setTz(sched.schedule.timezone || detectTz());
        setIsAwakeNow(!!sched.is_awake_now);
      }
      setScheduleDirty(false);
      setStage('view');
    } catch (e: any) {
      showAlert('Failed to load settings', String(e?.message || e));
      setStage('view');
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onConfirmEdit = useCallback(async (picked: BTAreaPicked) => {
    setStage('saving');
    try {
      const r = await api.btSaveSettings(picked.lat, picked.lng, picked.radius_m);
      setArea(r.area);
      setStage('view');
      showAlert('Saved', 'Your hunt area has been updated.');
    } catch (e: any) {
      showAlert('Save failed', String(e?.message || e));
      setStage('editing');
    }
  }, []);

  const onSaveSchedule = useCallback(async () => {
    if (scheduleSaving) return;
    // Sanitize inputs before sending so a typo doesn't lock the user
    // out — bad HH:MM falls back to the current defaults.
    const start = normalizeHHMM(awakeStart, '08:00');
    const end = normalizeHHMM(awakeEnd, '23:00');
    setAwakeStart(start);
    setAwakeEnd(end);
    setScheduleSaving(true);
    try {
      const r = await api.btSaveSchedule(start, end, sleepAllDay, tz);
      setAwakeStart(r.schedule.awake_start);
      setAwakeEnd(r.schedule.awake_end);
      setSleepAllDay(r.schedule.sleep_all_day);
      setTz(r.schedule.timezone || tz);
      setIsAwakeNow(!!r.is_awake_now);
      setScheduleDirty(false);
      showAlert(
        'Saved',
        r.schedule.sleep_all_day
          ? 'You\'ll be marked Inactive until you turn off "Sleep all day".'
          : 'Your awake hours have been updated.',
      );
    } catch (e: any) {
      showAlert('Could not save', String(e?.message || e));
    } finally {
      setScheduleSaving(false);
    }
  }, [awakeStart, awakeEnd, sleepAllDay, tz, scheduleSaving]);

  const statusLabel = useMemo(() => {
    if (sleepAllDay) return { label: 'Sleeping (all day)', color: '#9aa1a8' };
    return isAwakeNow
      ? { label: 'Active right now', color: '#22C55E' }
      : { label: 'Inactive — outside awake window', color: '#FFB020' };
  }, [sleepAllDay, isAwakeNow]);

  if (stage === 'editing') {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setStage('view')} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Edit hunt area</Text>
          <View style={styles.headerBtn} />
        </View>
        <BTMapPicker
          onConfirm={onConfirmEdit}
          initialRadius={area?.radius_m || 800}
          title="Pick the spot you're at"
          confirmLabel="Save new location"
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Mini-App Settings</Text>
        <View style={styles.headerBtn} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }} keyboardShouldPersistTaps="handled">
        {/* ───────── SAVED LOCATION ───────── */}
        <View style={styles.card}>
          <Text style={styles.cardKicker}>SAVED LOCATION</Text>
          {stage === 'loading' || stage === 'saving' ? (
            <ActivityIndicator color={colors.cyan} style={{ marginVertical: 20 }} />
          ) : area ? (
            <View style={{ gap: 6 }}>
              <View style={styles.row}>
                <Ionicons name="location" size={16} color={colors.cyan} />
                <Text style={styles.val}>
                  {area.lat.toFixed(4)}, {area.lng.toFixed(4)}
                </Text>
              </View>
              <View style={styles.row}>
                <Ionicons name="resize" size={16} color={colors.cyan} />
                <Text style={styles.val}>Hunt radius · {fmtRadius(area.radius_m)}</Text>
              </View>
              {area.updated_at ? (
                <Text style={styles.helper}>
                  Last updated {new Date(area.updated_at).toLocaleString()}
                </Text>
              ) : null}
            </View>
          ) : (
            <Text style={styles.helper}>
              No location saved yet — set one below to start hunting.
            </Text>
          )}
        </View>

        <TouchableOpacity
          style={styles.cta}
          onPress={() => setStage('editing')}
          activeOpacity={0.85}
          testID="bt-edit-location"
        >
          <Ionicons name="map" size={20} color="#0b0f15" />
          <Text style={styles.ctaText}>{area ? 'EDIT LOCATION' : 'PICK LOCATION'}</Text>
        </TouchableOpacity>

        {/* ───────── AWAKE HOURS ───────── */}
        <View style={styles.card}>
          <Text style={styles.cardKicker}>AWAKE HOURS</Text>
          <Text style={styles.helper}>
            Tell us when you're awake so we don't pick a group for a treasure when
            everyone's asleep. Times are in your local timezone.
          </Text>

          <View style={[styles.statusPill, { borderColor: statusLabel.color + '88', backgroundColor: statusLabel.color + '22' }]}>
            <View style={[styles.statusDot, { backgroundColor: statusLabel.color }]} />
            <Text style={[styles.statusText, { color: statusLabel.color }]}>{statusLabel.label}</Text>
          </View>

          <View style={styles.timeRow}>
            <View style={styles.timeBox}>
              <Text style={styles.timeLabel}>Awake from</Text>
              <TextInput
                value={awakeStart}
                onChangeText={(t) => { setAwakeStart(t.slice(0, 5)); setScheduleDirty(true); }}
                onBlur={() => setAwakeStart((v) => normalizeHHMM(v, '08:00'))}
                editable={!sleepAllDay}
                placeholder="HH:MM"
                placeholderTextColor={colors.textMuted}
                keyboardType={Platform.select({ ios: 'numbers-and-punctuation', default: 'default' })}
                style={[styles.timeInput, sleepAllDay && styles.timeInputDisabled]}
                maxLength={5}
                testID="bt-awake-start"
              />
            </View>
            <Ionicons name="arrow-forward" size={16} color={colors.textMuted} />
            <View style={styles.timeBox}>
              <Text style={styles.timeLabel}>Until</Text>
              <TextInput
                value={awakeEnd}
                onChangeText={(t) => { setAwakeEnd(t.slice(0, 5)); setScheduleDirty(true); }}
                onBlur={() => setAwakeEnd((v) => normalizeHHMM(v, '23:00'))}
                editable={!sleepAllDay}
                placeholder="HH:MM"
                placeholderTextColor={colors.textMuted}
                keyboardType={Platform.select({ ios: 'numbers-and-punctuation', default: 'default' })}
                style={[styles.timeInput, sleepAllDay && styles.timeInputDisabled]}
                maxLength={5}
                testID="bt-awake-end"
              />
            </View>
          </View>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Sleep all day</Text>
              <Text style={styles.helper}>
                Always Inactive — you won't be picked for treasures until you turn this off.
              </Text>
            </View>
            <Switch
              value={sleepAllDay}
              onValueChange={(v) => { setSleepAllDay(v); setScheduleDirty(true); }}
              trackColor={{ false: '#3a3f48', true: '#FFB020AA' }}
              thumbColor={sleepAllDay ? '#FFB020' : '#9aa4af'}
              testID="bt-sleep-all-day"
            />
          </View>

          <View style={styles.tzRow}>
            <Ionicons name="globe-outline" size={14} color={colors.textMuted} />
            <Text style={styles.tzText}>Timezone · {tz}</Text>
          </View>

          <TouchableOpacity
            style={[styles.saveBtn, (!scheduleDirty || scheduleSaving) && styles.saveBtnDisabled]}
            onPress={onSaveSchedule}
            disabled={!scheduleDirty || scheduleSaving}
            activeOpacity={0.85}
            testID="bt-save-schedule"
          >
            {scheduleSaving ? (
              <ActivityIndicator color="#0b0f15" />
            ) : (
              <>
                <Ionicons name="checkmark" size={18} color="#0b0f15" />
                <Text style={styles.saveBtnText}>SAVE AWAKE HOURS</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <Text style={styles.footnote}>
          Once you set a hunt area, the Buried Treasure home screen will skip the map picker on every open. You can change your area here at any time.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.sm, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerBtn: { width: 40, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1, textAlign: 'center' },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, gap: 10,
  },
  cardKicker: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  val: { color: colors.text, fontWeight: '700', fontSize: 14 },
  helper: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  cta: {
    backgroundColor: colors.cyan, borderRadius: radii.lg,
    paddingVertical: 14, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  ctaText: { color: '#0b0f15', fontWeight: '900', letterSpacing: 0.7 },
  footnote: {
    color: colors.textMuted, fontSize: 11, fontStyle: 'italic',
    textAlign: 'center', marginTop: spacing.sm, lineHeight: 16,
  },
  // Awake hours section
  statusPill: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1,
    marginTop: 4,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontWeight: '900', fontSize: 11, letterSpacing: 0.5 },
  timeRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 10,
    marginTop: 6,
  },
  timeBox: { flex: 1, gap: 4 },
  timeLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  timeInput: {
    color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: 2,
    backgroundColor: colors.bg, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: 10, paddingHorizontal: 12, textAlign: 'center',
  },
  timeInputDisabled: { opacity: 0.4 },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 6, marginTop: 4,
  },
  toggleLabel: { color: colors.text, fontWeight: '800', fontSize: 13 },
  tzRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  tzText: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  saveBtn: {
    backgroundColor: colors.cyan, borderRadius: radii.md,
    paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 4,
  },
  saveBtnDisabled: { opacity: 0.45 },
  saveBtnText: { color: '#0b0f15', fontWeight: '900', letterSpacing: 0.8 },
});
