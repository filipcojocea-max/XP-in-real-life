/**
 * /treasure/settings — Mini-App Settings for Buried Treasure.
 *
 * Two sections:
 *
 *   1. SAVED LOCATION
 *      Persistent hunt area / radius. The map picker only fires from
 *      here (or on first run); /treasure home skips it otherwise.
 *
 *   2. AVAILABILITY (read-only, 2026-06-02)
 *      The awake window is now SYNCED with the Work-Scheduler mini-app
 *      (profile.shift_schedule). Per product spec we no longer ask
 *      users to enter the same hours twice — this card simply shows
 *      the resolved window + an "Active right now" status pill. When
 *      the scheduler is disabled / unconfigured we fall back to the
 *      default 08:00–23:00 local window and the card surfaces a quick
 *      link to set the scheduler up.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
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

type ScheduleState = {
  awake_start: string;
  awake_end: string;
  timezone: string;
  source: 'scheduler' | 'default';
  shift?: 'day' | 'night' | 'off' | null;
  is_awake_now: boolean;
};

export default function TreasureSettings() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('loading');
  const [area, setArea] = useState<{ lat: number; lng: number; radius_m: number; label?: string | null; updated_at?: string } | null>(null);
  const [schedule, setSchedule] = useState<ScheduleState | null>(null);

  const load = useCallback(async () => {
    setStage('loading');
    try {
      const [s, sched] = await Promise.all([
        api.btGetSettings(),
        api.btGetSchedule().catch(() => null as any),
      ]);
      setArea(s.area || null);
      if (sched?.schedule) {
        setSchedule({
          awake_start: sched.schedule.awake_start || '08:00',
          awake_end: sched.schedule.awake_end || '23:00',
          timezone: sched.schedule.timezone || 'UTC',
          source: sched.schedule.source || 'default',
          shift: sched.schedule.shift ?? null,
          is_awake_now: !!sched.is_awake_now,
        });
      } else {
        setSchedule(null);
      }
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

  const statusPill = useMemo(() => {
    if (!schedule) {
      return { label: 'Loading…', color: colors.textMuted };
    }
    return schedule.is_awake_now
      ? { label: 'Active right now', color: '#22C55E' }
      : { label: 'Inactive — outside awake window', color: '#FFB020' };
  }, [schedule]);

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

        {/* ───────── AVAILABILITY (synced) ───────── */}
        <View style={styles.card}>
          <Text style={styles.cardKicker}>AVAILABILITY</Text>
          <Text style={styles.helper}>
            Your availability is synced with your Work-Scheduler. If the
            scheduler is off, a default 08:00–23:00 window is used.
          </Text>

          {/* Status pill — kept per spec so users can see their state
              at a glance even though manual inputs are gone. */}
          <View
            style={[
              styles.statusPill,
              {
                borderColor: statusPill.color + '88',
                backgroundColor: statusPill.color + '22',
              },
            ]}
            testID="bt-availability-pill"
          >
            <View style={[styles.statusDot, { backgroundColor: statusPill.color }]} />
            <Text style={[styles.statusText, { color: statusPill.color }]}>
              {statusPill.label}
            </Text>
          </View>

          {schedule ? (
            <View style={styles.syncRow}>
              <Ionicons
                name={schedule.source === 'scheduler' ? 'sync' : 'time-outline'}
                size={14}
                color={schedule.source === 'scheduler' ? colors.cyan : colors.textMuted}
              />
              <Text style={styles.syncText}>
                {schedule.source === 'scheduler'
                  ? `Synced from Work-Scheduler${schedule.shift ? ` · ${schedule.shift.toUpperCase()} shift` : ''}`
                  : 'Work-Scheduler is off — using default window'}
              </Text>
            </View>
          ) : null}

          {schedule ? (
            <View style={styles.windowRow}>
              <View style={styles.windowBox}>
                <Text style={styles.windowLabel}>Awake from</Text>
                <Text style={styles.windowVal}>{schedule.awake_start}</Text>
              </View>
              <Ionicons name="arrow-forward" size={14} color={colors.textMuted} />
              <View style={styles.windowBox}>
                <Text style={styles.windowLabel}>Until</Text>
                <Text style={styles.windowVal}>{schedule.awake_end}</Text>
              </View>
            </View>
          ) : null}

          {schedule ? (
            <View style={styles.tzRow}>
              <Ionicons name="globe-outline" size={14} color={colors.textMuted} />
              <Text style={styles.tzText}>Timezone · {schedule.timezone}</Text>
            </View>
          ) : null}

          {schedule?.source === 'default' ? (
            <TouchableOpacity
              style={styles.linkBtn}
              onPress={() => router.push('/schedule' as any)}
              activeOpacity={0.7}
              testID="bt-open-scheduler"
            >
              <Ionicons name="open-outline" size={16} color={colors.cyan} />
              <Text style={styles.linkBtnText}>OPEN WORK-SCHEDULER</Text>
            </TouchableOpacity>
          ) : null}
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
  // Availability section
  statusPill: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1,
    marginTop: 4,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontWeight: '900', fontSize: 11, letterSpacing: 0.5 },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  syncText: { color: colors.textSecondary, fontSize: 11, fontWeight: '700' },
  windowRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6,
  },
  windowBox: { flex: 1, gap: 4 },
  windowLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  windowVal: {
    color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: 2,
    backgroundColor: colors.bg, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: 10, paddingHorizontal: 12, textAlign: 'center',
  },
  tzRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  tzText: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  linkBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.cyan + '55',
    backgroundColor: colors.cyan + '11',
    marginTop: 6,
  },
  linkBtnText: { color: colors.cyan, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
});
