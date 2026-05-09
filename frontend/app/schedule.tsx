/**
 * Adaptive Work-Life Scheduler — step-by-step wizard + 6-month calendar.
 *
 *  Wizard flow:
 *    Q1 (intro)     → Same every week? Yes / No
 *    Step 2a YES    → Mon..Sun chart, tap each day to assign Day/Night/Off
 *    Step 2b NO     → 30-day grid (start = Mon of the 1st of current month).
 *                     User taps work days, app detects pattern + asks
 *                     "Repeat this schedule?" with a plain-English summary.
 *    Step 3 (sync)  → Tap one cycle day = "today". Anchors pattern_start_date.
 *    Final view     → 6-month vertical calendar with emoji + outline color.
 *                     Tap any day → popup: Day / Night / Off / Clear.
 *
 *  Master toggle lives on the Profile row. Wizard auto-skips when
 *  schedule.setup_complete is true; long-press Profile row reopens it.
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Switch,
  TextInput,
  ActivityIndicator,
  Modal,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, type ShiftSchedule, type ShiftType } from '../src/api';
import { colors, spacing, radii } from '../src/theme';
import { showAlert } from '../src/uiAlert';
import {
  iso,
  addDays,
  fromIso,
  detectPeriod,
  patternFromBinary,
  describePattern,
  buildSixMonths,
  WEEK_LABELS_MON,
} from '../src/scheduleHelpers';

const SHIFT_ORDER: ShiftType[] = ['day', 'night', 'off'];
const SHIFT_LABEL: Record<ShiftType, string> = { day: 'Day Shift', night: 'Night Shift', off: 'Day Off' };
const SHIFT_LABEL_SHORT: Record<ShiftType, string> = { day: 'Day', night: 'Night', off: 'Off' };

type WizardStep = 'intro' | 'weekly' | 'rotating-pick' | 'rotating-confirm' | 'rotating-shifts' | 'anchor' | 'done';

export default function ScheduleScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ wizard?: string }>();
  const forceWizard = params?.wizard === '1';

  const [schedule, setSchedule] = useState<ShiftSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Wizard state
  const [step, setStep] = useState<WizardStep>('intro');
  const [presetEditFor, setPresetEditFor] = useState<ShiftType | null>(null);

  // Weekly pattern (length 7, Mon..Sun)
  const [weekly, setWeekly] = useState<ShiftType[]>(['day', 'day', 'day', 'day', 'day', 'off', 'off']);

  // Rotating selection (30-day binary array)
  const [rotateGrid, setRotateGrid] = useState<number[]>(Array(30).fill(0));
  const [detectedLen, setDetectedLen] = useState<number | null>(null);
  const [confirmRepeat, setConfirmRepeat] = useState(false);
  // Cycle pattern with shift assignment (after rotating-confirm)
  const [cycle, setCycle] = useState<ShiftType[]>([]);
  // Anchor: which index of the cycle is "today"?
  const [anchorIdx, setAnchorIdx] = useState(0);

  // Override popup
  const [overrideFor, setOverrideFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.scheduleGet();
      setSchedule(r.schedule);
      // If setup is complete and not forced, jump to final view.
      if (r.schedule.setup_complete && !forceWizard) {
        setStep('done');
      } else {
        setStep('intro');
      }
    } catch (e: any) {
      showAlert('Could not load schedule', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [forceWizard]);

  useEffect(() => { load(); }, [load]);

  const persist = useCallback(async (next: Partial<ShiftSchedule>) => {
    setSaving(true);
    try {
      const r = await api.schedulePut(next);
      setSchedule(r.schedule);
      return r.schedule;
    } catch (e: any) {
      showAlert('Save failed', String(e?.message || e));
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  // ── Wizard transitions ───────────────────────────────────────────
  const onPickYesWeekly = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    setStep('weekly');
  }, []);

  const onPickNoRotating = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    setStep('rotating-pick');
  }, []);

  const saveWeekly = useCallback(async () => {
    if (!weekly.some((s) => s !== 'off')) {
      showAlert('No work days', 'Tap at least one day in the chart and set it to Day or Night.');
      return;
    }
    // Anchor pattern to most-recent Monday so weekday-0 == Monday.
    const today = new Date();
    const dow = today.getDay(); // 0..6 Sun..Sat
    const back = dow === 0 ? 6 : dow - 1;
    const monday = addDays(today, -back);
    const ok = await persist({
      pattern_kind: 'weekly',
      pattern: weekly,
      pattern_start_date: iso(monday),
      enabled: true,
      setup_complete: true,
    });
    if (ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setStep('done');
    }
  }, [weekly, persist]);

  // ROTATING: detect period each time grid changes
  useEffect(() => {
    if (step !== 'rotating-pick') return;
    const period = detectPeriod(rotateGrid);
    setDetectedLen(period);
  }, [rotateGrid, step]);

  const onContinueRotating = useCallback(() => {
    if (!rotateGrid.some(Boolean)) {
      showAlert('No work days', 'Tap your work days on the calendar before continuing.');
      return;
    }
    setStep('rotating-confirm');
  }, [rotateGrid]);

  const onConfirmCycle = useCallback(() => {
    let cycleLen = detectedLen;
    if (!confirmRepeat || !cycleLen) {
      // Default: use the first contiguous block as the cycle.
      const ones = rotateGrid.filter((x) => x).length;
      const zeros = rotateGrid.filter((x) => !x).length;
      // Best fallback: trim to first non-empty span up to 14 days
      const span = Math.min(14, Math.max(2, Math.min(ones + zeros, rotateGrid.findIndex((x, i) => i > 0 && x === 0 && rotateGrid[i - 1] === 1) + 7)));
      cycleLen = Math.max(2, isFinite(span) ? span : 7);
    }
    const next = patternFromBinary(rotateGrid, cycleLen);
    setCycle(next);
    setStep('rotating-shifts');
  }, [confirmRepeat, detectedLen, rotateGrid]);

  const cycleSetIndex = useCallback((idx: number, s: ShiftType) => {
    setCycle((prev) => prev.map((x, i) => (i === idx ? s : x)));
  }, []);

  const onCycleNext = useCallback(() => {
    if (!cycle.length) return;
    setAnchorIdx(0);
    setStep('anchor');
  }, [cycle]);

  const saveRotatingFinal = useCallback(async () => {
    if (!cycle.length) return;
    // pattern_start_date = today - anchorIdx days
    const today = new Date();
    const startDate = addDays(today, -anchorIdx);
    const ok = await persist({
      pattern_kind: 'rotating',
      pattern: cycle,
      pattern_start_date: iso(startDate),
      enabled: true,
      setup_complete: true,
    });
    if (ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setStep('done');
    }
  }, [cycle, anchorIdx, persist]);

  // Override
  const setOverride = useCallback(async (date_iso: string, shift: ShiftType | null) => {
    try {
      await api.scheduleDayOverride(date_iso, shift);
      const r = await api.scheduleGet();
      setSchedule(r.schedule);
      Haptics.selectionAsync().catch(() => {});
    } catch (e: any) {
      showAlert('Override failed', String(e?.message || e));
    } finally {
      setOverrideFor(null);
    }
  }, []);

  if (loading || !schedule) {
    return (
      <SafeAreaView style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  // ─── Header ──────────────────────────────────────────────────────
  const Header = (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={10} testID="schedule-back">
        <Ionicons name="chevron-back" size={22} color={colors.text} />
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>Adaptive Work-Life Scheduler</Text>
        <Text style={styles.subtitle}>
          {step === 'done' ? '6-month preview · tap any day to override' : `Step ${stepIndex(step)} of 4`}
        </Text>
      </View>
      {saving ? <ActivityIndicator color={colors.cyan} size="small" /> : null}
      {step === 'done' ? (
        <TouchableOpacity
          onPress={() => setStep('intro')}
          hitSlop={10}
          style={styles.editBtn}
          testID="schedule-edit-pattern"
        >
          <Ionicons name="create-outline" size={18} color={colors.cyan} />
        </TouchableOpacity>
      ) : null}
    </View>
  );

  // ─── Body by step ────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      {Header}

      {step === 'intro' && (
        <IntroStep
          onYes={onPickYesWeekly}
          onNo={onPickNoRotating}
          presets={schedule.shifts}
          onEditPreset={(k) => setPresetEditFor(k)}
        />
      )}

      {step === 'weekly' && (
        <WeeklyStep
          insets={insets}
          weekly={weekly}
          setWeekly={setWeekly}
          onBack={() => setStep('intro')}
          onSave={saveWeekly}
          presets={schedule.shifts}
          onEditPreset={(k) => setPresetEditFor(k)}
        />
      )}

      {step === 'rotating-pick' && (
        <RotatingPickStep
          insets={insets}
          grid={rotateGrid}
          setGrid={setRotateGrid}
          detectedLen={detectedLen}
          confirmRepeat={confirmRepeat}
          setConfirmRepeat={setConfirmRepeat}
          presets={schedule.shifts}
          onEditPreset={(k) => setPresetEditFor(k)}
          onBack={() => setStep('intro')}
          onContinue={onContinueRotating}
        />
      )}

      {step === 'rotating-confirm' && (
        <RotatingConfirmStep
          grid={rotateGrid}
          detectedLen={detectedLen}
          confirmRepeat={confirmRepeat}
          onBack={() => setStep('rotating-pick')}
          onConfirm={onConfirmCycle}
        />
      )}

      {step === 'rotating-shifts' && (
        <CycleAssignStep
          insets={insets}
          cycle={cycle}
          setCellShift={cycleSetIndex}
          presets={schedule.shifts}
          onEditPreset={(k) => setPresetEditFor(k)}
          onBack={() => setStep('rotating-confirm')}
          onNext={onCycleNext}
        />
      )}

      {step === 'anchor' && (
        <AnchorStep
          insets={insets}
          cycle={cycle}
          anchorIdx={anchorIdx}
          setAnchorIdx={setAnchorIdx}
          presets={schedule.shifts}
          onBack={() => setStep('rotating-shifts')}
          onSave={saveRotatingFinal}
        />
      )}

      {step === 'done' && (
        <DoneView
          insets={insets}
          schedule={schedule}
          onTapDay={(d) => setOverrideFor(d)}
        />
      )}

      {/* Preset editor (Day/Night/Off times + emoji + color) */}
      <PresetEditorModal
        visible={presetEditFor !== null}
        kind={presetEditFor}
        schedule={schedule}
        onClose={() => setPresetEditFor(null)}
        onSave={async (next) => {
          await persist({ shifts: { ...schedule.shifts, ...next } as any });
          setPresetEditFor(null);
        }}
      />

      {/* Override popup */}
      <OverrideModal
        date={overrideFor}
        schedule={schedule}
        onClose={() => setOverrideFor(null)}
        onPick={(s) => overrideFor && setOverride(overrideFor, s)}
      />
    </SafeAreaView>
  );
}

function stepIndex(s: WizardStep): number {
  if (s === 'intro') return 1;
  if (s === 'weekly' || s === 'rotating-pick' || s === 'rotating-confirm' || s === 'rotating-shifts') return 2;
  if (s === 'anchor') return 3;
  return 4;
}

// ════════════════════ Step components ════════════════════════════
function IntroStep({
  onYes,
  onNo,
  presets,
  onEditPreset,
}: {
  onYes: () => void;
  onNo: () => void;
  presets: ShiftSchedule['shifts'];
  onEditPreset: (k: ShiftType) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <View style={styles.heroCard}>
        <Text style={styles.kicker}>QUESTION 1</Text>
        <Text style={styles.bigQuestion}>Is your shift pattern the same every week?</Text>
        <Text style={styles.helperText}>
          Choose how your week repeats so the app can wake up, reset and silence notifications at the right time.
        </Text>

        <TouchableOpacity style={[styles.bigChoice, { borderColor: colors.green }]} onPress={onYes} testID="intro-yes">
          <Text style={styles.bigChoiceTitle}>Yes — same every week</Text>
          <Text style={styles.bigChoiceSub}>Mon–Sun chart · pick work days · global preset times</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.green} style={styles.bigChoiceChev} />
        </TouchableOpacity>

        <TouchableOpacity style={[styles.bigChoice, { borderColor: colors.cyan }]} onPress={onNo} testID="intro-no">
          <Text style={styles.bigChoiceTitle}>No — rotating shifts</Text>
          <Text style={styles.bigChoiceSub}>30-day calendar · auto-detect cycle · "4 on, 4 off"</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.cyan} style={styles.bigChoiceChev} />
        </TouchableOpacity>
      </View>

      <PresetStrip presets={presets} onEdit={onEditPreset} />
    </ScrollView>
  );
}

function WeeklyStep({
  insets,
  weekly,
  setWeekly,
  onBack,
  onSave,
  presets,
  onEditPreset,
}: {
  insets: any;
  weekly: ShiftType[];
  setWeekly: (w: ShiftType[]) => void;
  onBack: () => void;
  onSave: () => void;
  presets: ShiftSchedule['shifts'];
  onEditPreset: (k: ShiftType) => void;
}) {
  const [pickerForDay, setPickerForDay] = useState<number | null>(null);

  const cycleDay = (idx: number, s: ShiftType) => {
    Haptics.selectionAsync().catch(() => {});
    const next = weekly.slice();
    next[idx] = s;
    setWeekly(next);
    setPickerForDay(null);
  };

  return (
    <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + spacing.xl + 80 }]}>
      <Text style={styles.kicker}>STEP 2 · WEEKLY CHART</Text>
      <Text style={styles.bigQuestion}>Tap each day to set Day, Night or Off.</Text>
      <Text style={styles.helperText}>The wake/sleep times come from your three global presets — edit them below if needed.</Text>

      <PresetStrip presets={presets} onEdit={onEditPreset} compact />

      <View style={styles.weeklyChart}>
        {WEEK_LABELS_MON.map((label, i) => {
          const s = weekly[i];
          const def = presets[s];
          return (
            <TouchableOpacity
              key={label}
              activeOpacity={0.85}
              onPress={() => setPickerForDay(i)}
              style={[styles.weekCol, { borderColor: def.color }]}
              testID={`weekly-${label.toLowerCase()}`}
            >
              <Text style={styles.weekColLabel}>{label}</Text>
              <Text style={styles.weekColEmoji}>{def.icon}</Text>
              <Text style={[styles.weekColShift, { color: def.color }]}>{SHIFT_LABEL_SHORT[s]}</Text>
              <Text style={styles.weekColTime}>{def.start_time}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.legendRow}>
        {SHIFT_ORDER.map((s) => (
          <View key={s} style={[styles.legendChip, { borderColor: presets[s].color }]}>
            <Text style={{ fontSize: 14 }}>{presets[s].icon}</Text>
            <Text style={[styles.legendText, { color: presets[s].color }]}>{SHIFT_LABEL_SHORT[s]}</Text>
          </View>
        ))}
      </View>

      <View style={styles.btnRow}>
        <TouchableOpacity onPress={onBack} style={[styles.btn, styles.btnGhost]} testID="weekly-back">
          <Text style={styles.btnGhostText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onSave} style={[styles.btn, styles.btnPrimary]} testID="weekly-save">
          <Text style={styles.btnPrimaryText}>Save & generate calendar</Text>
        </TouchableOpacity>
      </View>

      <DayShiftPicker
        visible={pickerForDay !== null}
        title={pickerForDay !== null ? `Set ${WEEK_LABELS_MON[pickerForDay]}` : ''}
        presets={presets}
        onPick={(s) => pickerForDay !== null && cycleDay(pickerForDay, s)}
        onClose={() => setPickerForDay(null)}
      />
    </ScrollView>
  );
}

function RotatingPickStep({
  insets,
  grid,
  setGrid,
  detectedLen,
  confirmRepeat,
  setConfirmRepeat,
  presets,
  onEditPreset,
  onBack,
  onContinue,
}: {
  insets: any;
  grid: number[];
  setGrid: (g: number[]) => void;
  detectedLen: number | null;
  confirmRepeat: boolean;
  setConfirmRepeat: (v: boolean) => void;
  presets: ShiftSchedule['shifts'];
  onEditPreset: (k: ShiftType) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const tap = (i: number) => {
    Haptics.selectionAsync().catch(() => {});
    const next = grid.slice();
    next[i] = next[i] ? 0 : 1;
    setGrid(next);
  };
  const any = grid.some(Boolean);
  const desc = detectedLen ? describePattern(patternFromBinary(grid, detectedLen)) : null;

  return (
    <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + spacing.xl + 80 }]}>
      <Text style={styles.kicker}>STEP 2 · 30-DAY GRID</Text>
      <Text style={styles.bigQuestion}>Tap your work days on the calendar.</Text>
      <Text style={styles.helperText}>
        Mark the first block of work days. We'll spot the pattern (e.g. "4 on, 4 off") and project it 6 months ahead.
      </Text>

      <PresetStrip presets={presets} onEdit={onEditPreset} compact />

      {/* 30-day grid: 7 cols, starting Mon */}
      <View style={styles.thirtyGrid}>
        {WEEK_LABELS_MON.map((d) => (
          <Text key={d} style={styles.thirtyGridHead}>{d}</Text>
        ))}
        {grid.map((v, i) => (
          <TouchableOpacity
            key={i}
            onPress={() => tap(i)}
            style={[styles.thirtyCell, v ? styles.thirtyCellOn : null]}
            activeOpacity={0.85}
            testID={`rotate-cell-${i}`}
          >
            <Text style={[styles.thirtyCellText, v ? styles.thirtyCellTextOn : null]}>{i + 1}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Detection banner */}
      <View style={[styles.detectBanner, detectedLen ? styles.detectBannerOk : null]}>
        <Ionicons
          name={detectedLen ? 'flash' : 'information-circle-outline'}
          size={18}
          color={detectedLen ? colors.green : colors.textMuted}
        />
        <Text style={[styles.detectText, detectedLen ? { color: colors.green } : null]}>
          {detectedLen
            ? `Looks like a ${detectedLen}-day cycle — ${desc}.`
            : any
              ? 'No clean pattern yet. Mark a few more days.'
              : 'Tap days above to begin.'}
        </Text>
      </View>

      {detectedLen ? (
        <View style={styles.repeatRow}>
          <Switch
            value={confirmRepeat}
            onValueChange={(v) => { Haptics.selectionAsync().catch(() => {}); setConfirmRepeat(v); }}
            trackColor={{ false: '#333', true: colors.green + '88' }}
            thumbColor={confirmRepeat ? colors.green : '#999'}
            testID="rotate-repeat-toggle"
          />
          <Text style={styles.repeatText}>Repeat this {detectedLen}-day schedule indefinitely</Text>
        </View>
      ) : null}

      <View style={styles.btnRow}>
        <TouchableOpacity onPress={onBack} style={[styles.btn, styles.btnGhost]}>
          <Text style={styles.btnGhostText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onContinue}
          style={[styles.btn, styles.btnPrimary, !any && { opacity: 0.5 }]}
          disabled={!any}
          testID="rotate-continue"
        >
          <Text style={styles.btnPrimaryText}>Continue</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function RotatingConfirmStep({
  grid,
  detectedLen,
  confirmRepeat,
  onBack,
  onConfirm,
}: {
  grid: number[];
  detectedLen: number | null;
  confirmRepeat: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const cycleLen = detectedLen && confirmRepeat ? detectedLen : Math.min(14, grid.length);
  const previewPat = patternFromBinary(grid, cycleLen);
  const desc = describePattern(previewPat);

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.kicker}>CONFIRM PATTERN</Text>
      <Text style={styles.bigQuestion}>{desc || `${cycleLen}-day cycle`}</Text>
      <Text style={styles.helperText}>
        We'll repeat this {cycleLen}-day cycle for the next 6 months. You can fine-tune any day later by tapping it on the calendar.
      </Text>

      <View style={styles.previewCycleRow}>
        {previewPat.map((s, i) => (
          <View key={i} style={[styles.previewCycleCell, { borderColor: s === 'off' ? colors.border : colors.cyan }]}>
            <Text style={styles.previewCycleIdx}>{i + 1}</Text>
            <Text style={styles.previewCycleEmoji}>{s === 'off' ? '☕' : '🌅'}</Text>
            <Text style={[styles.previewCycleLabel, { color: s === 'off' ? colors.textMuted : colors.cyan }]}>
              {SHIFT_LABEL_SHORT[s]}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.btnRow}>
        <TouchableOpacity onPress={onBack} style={[styles.btn, styles.btnGhost]}>
          <Text style={styles.btnGhostText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onConfirm} style={[styles.btn, styles.btnPrimary]} testID="rotate-confirm">
          <Text style={styles.btnPrimaryText}>Looks right</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function CycleAssignStep({
  insets,
  cycle,
  setCellShift,
  presets,
  onEditPreset,
  onBack,
  onNext,
}: {
  insets: any;
  cycle: ShiftType[];
  setCellShift: (idx: number, s: ShiftType) => void;
  presets: ShiftSchedule['shifts'];
  onEditPreset: (k: ShiftType) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [pickerForIdx, setPickerForIdx] = useState<number | null>(null);

  return (
    <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + spacing.xl + 80 }]}>
      <Text style={styles.kicker}>ASSIGN SHIFT TYPES</Text>
      <Text style={styles.bigQuestion}>Tap any cycle day to switch between Day, Night, or Off.</Text>
      <Text style={styles.helperText}>
        Workers on rotating shifts often have a few Night days inside a "work block". Tap each cell to refine.
      </Text>

      <PresetStrip presets={presets} onEdit={onEditPreset} compact />

      <View style={styles.previewCycleRow}>
        {cycle.map((s, i) => {
          const def = presets[s];
          return (
            <TouchableOpacity
              key={i}
              onPress={() => setPickerForIdx(i)}
              activeOpacity={0.85}
              style={[styles.previewCycleCell, { borderColor: def.color }]}
              testID={`cycle-cell-${i}`}
            >
              <Text style={styles.previewCycleIdx}>{i + 1}</Text>
              <Text style={styles.previewCycleEmoji}>{def.icon}</Text>
              <Text style={[styles.previewCycleLabel, { color: def.color }]}>{SHIFT_LABEL_SHORT[s]}</Text>
              <Text style={styles.previewCycleTime}>{def.start_time}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.btnRow}>
        <TouchableOpacity onPress={onBack} style={[styles.btn, styles.btnGhost]}>
          <Text style={styles.btnGhostText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onNext} style={[styles.btn, styles.btnPrimary]} testID="cycle-next">
          <Text style={styles.btnPrimaryText}>Next: anchor today</Text>
        </TouchableOpacity>
      </View>

      <DayShiftPicker
        visible={pickerForIdx !== null}
        title={pickerForIdx !== null ? `Cycle day #${pickerForIdx + 1}` : ''}
        presets={presets}
        onPick={(s) => {
          if (pickerForIdx !== null) setCellShift(pickerForIdx, s);
          setPickerForIdx(null);
        }}
        onClose={() => setPickerForIdx(null)}
      />
    </ScrollView>
  );
}

function AnchorStep({
  insets,
  cycle,
  anchorIdx,
  setAnchorIdx,
  presets,
  onBack,
  onSave,
}: {
  insets: any;
  cycle: ShiftType[];
  anchorIdx: number;
  setAnchorIdx: (n: number) => void;
  presets: ShiftSchedule['shifts'];
  onBack: () => void;
  onSave: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + spacing.xl + 80 }]}>
      <Text style={styles.kicker}>STEP 3 · SYNC TODAY</Text>
      <Text style={styles.bigQuestion}>What day of this pattern are you on today?</Text>
      <Text style={styles.helperText}>
        Tap one cell to mark TODAY. We'll line up the rest of your 6-month calendar from there.
      </Text>

      <View style={styles.previewCycleRow}>
        {cycle.map((s, i) => {
          const def = presets[s];
          const selected = i === anchorIdx;
          return (
            <TouchableOpacity
              key={i}
              activeOpacity={0.85}
              onPress={() => { Haptics.selectionAsync().catch(() => {}); setAnchorIdx(i); }}
              style={[
                styles.previewCycleCell,
                { borderColor: def.color },
                selected && styles.anchorSelected,
              ]}
              testID={`anchor-cell-${i}`}
            >
              {selected ? <Text style={styles.todayBadge}>TODAY</Text> : null}
              <Text style={styles.previewCycleIdx}>{i + 1}</Text>
              <Text style={styles.previewCycleEmoji}>{def.icon}</Text>
              <Text style={[styles.previewCycleLabel, { color: def.color }]}>{SHIFT_LABEL_SHORT[s]}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.btnRow}>
        <TouchableOpacity onPress={onBack} style={[styles.btn, styles.btnGhost]}>
          <Text style={styles.btnGhostText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onSave} style={[styles.btn, styles.btnPrimary]} testID="anchor-save">
          <Text style={styles.btnPrimaryText}>Save & generate calendar</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ════════════════════ Final 6-month view ════════════════════════════
function DoneView({
  insets,
  schedule,
  onTapDay,
}: {
  insets: any;
  schedule: ShiftSchedule;
  onTapDay: (date_iso: string) => void;
}) {
  const months = useMemo(() => buildSixMonths(new Date()), []);
  const todayIso = iso(new Date());

  // Compute shift for each date locally (mirrors backend _shift_for_date).
  const shiftFor = useCallback((date_iso: string): ShiftType | null => {
    const sched = schedule;
    if (!sched.enabled) return null;
    if (!sched.pattern.length) return null;
    const ov = sched.manual_overrides || {};
    if (ov[date_iso] && SHIFT_ORDER.includes(ov[date_iso] as ShiftType)) {
      return ov[date_iso] as ShiftType;
    }
    try {
      const anchor = fromIso(sched.pattern_start_date || todayIso);
      const target = fromIso(date_iso);
      const ms = target.getTime() - anchor.getTime();
      const days = Math.round(ms / (24 * 3600 * 1000));
      const len = sched.pattern.length;
      let idx = ((days % len) + len) % len;
      return sched.pattern[idx] || null;
    } catch {
      return null;
    }
  }, [schedule, todayIso]);

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
      <View style={styles.legendRow}>
        {SHIFT_ORDER.map((s) => (
          <View key={s} style={[styles.legendChip, { borderColor: schedule.shifts[s].color }]}>
            <Text style={{ fontSize: 14 }}>{schedule.shifts[s].icon}</Text>
            <Text style={[styles.legendText, { color: schedule.shifts[s].color }]}>{SHIFT_LABEL_SHORT[s]}</Text>
          </View>
        ))}
      </View>

      {months.map((m) => (
        <View key={m.key} style={styles.monthCard}>
          <Text style={styles.monthLabel}>{m.label}</Text>
          <View style={styles.monthHeaderRow}>
            {WEEK_LABELS_MON.map((w) => (
              <Text key={w} style={styles.monthHeadCell}>{w}</Text>
            ))}
          </View>
          <View style={styles.monthGrid}>
            {Array.from({ length: m.firstWeekday }).map((_, i) => (
              <View key={`b-${i}`} style={styles.monthCell} />
            ))}
            {m.days.map((d) => {
              const s = shiftFor(d);
              const def = s ? schedule.shifts[s] : null;
              const isToday = d === todayIso;
              const isOverride = !!schedule.manual_overrides?.[d];
              const isPast = d < todayIso;
              return (
                <TouchableOpacity
                  key={d}
                  style={[
                    styles.monthCell,
                    def && { borderColor: def.color, backgroundColor: def.color + '14' },
                    isToday && styles.monthCellToday,
                    isPast && { opacity: 0.55 },
                  ]}
                  onPress={() => !isPast && onTapDay(d)}
                  activeOpacity={isPast ? 1 : 0.7}
                  testID={`mcal-${d}`}
                >
                  <Text style={[styles.monthCellDay, isToday && { color: colors.cyan, fontWeight: '900' }]}>
                    {d.slice(8)}
                  </Text>
                  {def ? <Text style={styles.monthCellEmoji}>{def.icon}</Text> : null}
                  {isOverride ? <View style={styles.overrideDot} /> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

// ════════════════════ Day picker ════════════════════════════
function DayShiftPicker({
  visible,
  title,
  presets,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  presets: ShiftSchedule['shifts'];
  onPick: (s: ShiftType) => void;
  onClose: () => void;
}) {
  if (!visible) return null;
  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={modalStyles.backdrop}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={modalStyles.sheet}>
          <View style={modalStyles.handle} />
          <Text style={modalStyles.kicker}>{title.toUpperCase()}</Text>
          <Text style={modalStyles.title}>Set this day to…</Text>
          {SHIFT_ORDER.map((s) => {
            const def = presets[s];
            return (
              <TouchableOpacity
                key={s}
                onPress={() => onPick(s)}
                style={[modalStyles.row, { borderColor: def.color }]}
                activeOpacity={0.85}
                testID={`day-pick-${s}`}
              >
                <Text style={{ fontSize: 22 }}>{def.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[modalStyles.rowText, { color: def.color }]}>{SHIFT_LABEL[s]}</Text>
                  <Text style={modalStyles.rowSub}>Wake {def.start_time} · Sleep {def.sleep_time}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity onPress={onClose} style={modalStyles.cancel}>
            <Text style={modalStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ════════════════════ Override modal (final view) ══════════════════
function OverrideModal({
  date,
  schedule,
  onClose,
  onPick,
}: {
  date: string | null;
  schedule: ShiftSchedule;
  onClose: () => void;
  onPick: (s: ShiftType | null) => void;
}) {
  if (!date) return null;
  const isExisting = !!schedule.manual_overrides?.[date];
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={modalStyles.backdrop}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={modalStyles.sheet}>
          <View style={modalStyles.handle} />
          <Text style={modalStyles.kicker}>OVERRIDE · {date}</Text>
          <Text style={modalStyles.title}>Change this day to…</Text>
          {SHIFT_ORDER.map((s) => {
            const def = schedule.shifts[s];
            return (
              <TouchableOpacity
                key={s}
                onPress={() => onPick(s)}
                style={[modalStyles.row, { borderColor: def.color }]}
                activeOpacity={0.85}
                testID={`override-${s}`}
              >
                <Text style={{ fontSize: 22 }}>{def.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[modalStyles.rowText, { color: def.color }]}>{SHIFT_LABEL[s]}</Text>
                  <Text style={modalStyles.rowSub}>Wake {def.start_time} · Sleep {def.sleep_time}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            );
          })}
          {isExisting ? (
            <TouchableOpacity onPress={() => onPick(null)} style={modalStyles.cancel} testID="override-clear">
              <Text style={modalStyles.cancelText}>Clear override · use pattern</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={onClose} style={modalStyles.cancel}>
              <Text style={modalStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ════════════════════ Preset strip ════════════════════════════
function PresetStrip({
  presets,
  onEdit,
  compact = false,
}: {
  presets: ShiftSchedule['shifts'];
  onEdit: (k: ShiftType) => void;
  compact?: boolean;
}) {
  return (
    <View style={[styles.presetStrip, compact && { marginVertical: spacing.sm }]}>
      <Text style={styles.presetStripTitle}>{compact ? 'Presets' : 'Edit your three presets'}</Text>
      <View style={styles.presetRow}>
        {SHIFT_ORDER.map((s) => {
          const def = presets[s];
          return (
            <TouchableOpacity
              key={s}
              activeOpacity={0.85}
              onPress={() => onEdit(s)}
              style={[styles.presetCard, { borderColor: def.color }]}
              testID={`preset-${s}`}
            >
              <Text style={{ fontSize: 18 }}>{def.icon}</Text>
              <Text style={[styles.presetCardLabel, { color: def.color }]}>{SHIFT_LABEL[s]}</Text>
              <Text style={styles.presetCardTime}>{def.start_time} → {def.sleep_time}</Text>
              <Ionicons name="create-outline" size={14} color={colors.textMuted} style={{ marginTop: 4 }} />
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ════════════════════ Preset editor modal ════════════════════════════
const EMOJI_PRESETS: Record<ShiftType, string[]> = {
  day: ['🌅', '🌄', '☀️', '🏢', '🚗', '🏗️', '🛠️'],
  night: ['🌃', '🌙', '🦉', '⭐', '🛌', '🌌'],
  off: ['☕', '🛋️', '🏡', '🍿', '🏖️', '🎮', '😎'],
};
const PRESET_COLORS = [
  '#FFA726', '#F97316', '#FF7043', '#EF4444',
  '#1E3A8A', '#3B82F6', '#0EA5E9', '#06B6D4',
  '#22C55E', '#10B981', '#84CC16', '#A3E635',
  '#A855F7', '#D946EF', '#EC4899', '#F472B6',
  '#FFFFFF', '#9CA3AF', '#374151', '#000000',
];

function PresetEditorModal({
  visible,
  kind,
  schedule,
  onClose,
  onSave,
}: {
  visible: boolean;
  kind: ShiftType | null;
  schedule: ShiftSchedule;
  onClose: () => void;
  onSave: (next: Partial<ShiftSchedule['shifts']>) => void;
}) {
  const def = kind ? schedule.shifts[kind] : null;
  const [startTime, setStartTime] = useState('06:00');
  const [sleepTime, setSleepTime] = useState('22:00');
  const [icon, setIcon] = useState('🌅');
  const [color, setColor] = useState('#FFA726');

  useEffect(() => {
    if (!def) return;
    setStartTime(def.start_time);
    setSleepTime(def.sleep_time);
    setIcon(def.icon);
    setColor(def.color);
  }, [def, kind]);

  if (!kind || !def) return null;

  const submit = () => {
    if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(startTime)) {
      showAlert('Invalid wake time', 'Use HH:MM 24-hour format like 06:00 or 14:30.');
      return;
    }
    if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(sleepTime)) {
      showAlert('Invalid sleep time', 'Use HH:MM 24-hour format like 22:00 or 06:00.');
      return;
    }
    onSave({ [kind]: { start_time: startTime, sleep_time: sleepTime, icon, color } } as any);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={modalStyles.backdrop}>
        <ScrollView contentContainerStyle={modalStyles.scroll} keyboardShouldPersistTaps="handled">
          <View style={modalStyles.card}>
            <Text style={modalStyles.kicker}>EDIT · {SHIFT_LABEL[kind].toUpperCase()}</Text>

            <Text style={modalStyles.label}>Wake-up time (Start)</Text>
            <TextInput
              value={startTime}
              onChangeText={setStartTime}
              placeholder="06:00"
              placeholderTextColor={colors.textMuted}
              style={modalStyles.timeInput}
              testID="shift-start-time"
            />

            <Text style={modalStyles.label}>Sleep time (Silence push)</Text>
            <TextInput
              value={sleepTime}
              onChangeText={setSleepTime}
              placeholder="22:00"
              placeholderTextColor={colors.textMuted}
              style={modalStyles.timeInput}
              testID="shift-sleep-time"
            />

            <Text style={modalStyles.label}>Emoji</Text>
            <View style={modalStyles.emojiRow}>
              {EMOJI_PRESETS[kind].map((e) => (
                <TouchableOpacity
                  key={e}
                  onPress={() => setIcon(e)}
                  style={[modalStyles.emojiBtn, icon === e && modalStyles.emojiBtnActive]}
                  testID={`emoji-${e}`}
                >
                  <Text style={{ fontSize: 22 }}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={modalStyles.label}>Outline color</Text>
            <View style={modalStyles.colorGrid}>
              {PRESET_COLORS.map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setColor(c)}
                  style={[
                    modalStyles.colorSwatch,
                    { backgroundColor: c, borderColor: color === c ? '#fff' : '#333' },
                  ]}
                  testID={`color-${c}`}
                />
              ))}
            </View>

            <View style={modalStyles.btnRow}>
              <TouchableOpacity onPress={onClose} style={[modalStyles.btn, modalStyles.btnGhost]}>
                <Text style={modalStyles.btnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                style={[modalStyles.btn, modalStyles.btnPrimary]}
                testID="shift-save"
              >
                <Text style={modalStyles.btnPrimaryText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ════════════════════ Styles ════════════════════════════
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderColor: colors.border,
  },
  backBtn: { padding: 4 },
  editBtn: { padding: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.cyan + '88' },
  title: { color: colors.text, fontSize: 16, fontWeight: '900' },
  subtitle: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },

  body: { padding: spacing.md, paddingBottom: spacing.xl },
  kicker: { color: colors.cyan, fontSize: 11, fontWeight: '900', letterSpacing: 2, marginBottom: 6 },
  bigQuestion: { color: colors.text, fontSize: 22, fontWeight: '900', lineHeight: 28, marginBottom: 8 },
  helperText: { color: colors.textSecondary, fontSize: 13, lineHeight: 20, marginBottom: spacing.md },

  heroCard: { paddingVertical: spacing.sm },
  bigChoice: {
    borderWidth: 2, borderRadius: radii.lg, padding: spacing.md, marginTop: spacing.sm,
    backgroundColor: colors.surface, position: 'relative',
  },
  bigChoiceTitle: { color: colors.text, fontSize: 16, fontWeight: '900' },
  bigChoiceSub: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  bigChoiceChev: { position: 'absolute', right: 12, top: 18 },

  // Preset strip
  presetStrip: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg,
    padding: spacing.sm, marginVertical: spacing.md,
  },
  presetStripTitle: { color: colors.textSecondary, fontSize: 11, fontWeight: '900', letterSpacing: 1.4, marginBottom: 8, textTransform: 'uppercase' as const },
  presetRow: { flexDirection: 'row', gap: spacing.sm },
  presetCard: {
    flex: 1, alignItems: 'center', padding: spacing.sm, borderRadius: radii.md, borderWidth: 1.5,
    backgroundColor: colors.bg,
  },
  presetCardLabel: { fontSize: 12, fontWeight: '900', marginTop: 4 },
  presetCardTime: { color: colors.textSecondary, fontSize: 10, marginTop: 2 },

  // Weekly chart (Mon-Sun)
  weeklyChart: { flexDirection: 'row', gap: 6, marginTop: spacing.sm, marginBottom: spacing.md },
  weekCol: {
    flex: 1, aspectRatio: 0.55,
    borderWidth: 2, borderRadius: radii.md, backgroundColor: colors.bg,
    alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6,
  },
  weekColLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '800' },
  weekColEmoji: { fontSize: 22 },
  weekColShift: { fontSize: 11, fontWeight: '900' },
  weekColTime: { color: colors.textSecondary, fontSize: 10, fontWeight: '700' },

  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: spacing.sm, alignItems: 'center' },
  legendChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radii.pill, borderWidth: 1.5 },
  legendText: { fontSize: 11, fontWeight: '900' },

  // 30-day grid
  thirtyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, width: '100%', marginVertical: spacing.sm },
  thirtyGridHead: { width: `${100/7 - 1}%`, color: colors.textMuted, fontSize: 10, fontWeight: '800', textAlign: 'center', marginBottom: 2 },
  thirtyCell: {
    width: `${100/7 - 1}%`, aspectRatio: 1,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  thirtyCellOn: { backgroundColor: colors.cyan + '22', borderColor: colors.cyan },
  thirtyCellText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  thirtyCellTextOn: { color: colors.cyan, fontWeight: '900' },

  // Pattern detection banner
  detectBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: spacing.sm, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.bg, marginTop: spacing.sm,
  },
  detectBannerOk: { borderColor: colors.green, backgroundColor: colors.green + '10' },
  detectText: { color: colors.textMuted, fontSize: 12, flex: 1, fontWeight: '700' },

  repeatRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: spacing.sm,
    padding: spacing.sm, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  repeatText: { color: colors.text, fontSize: 13, fontWeight: '800', flex: 1 },

  previewCycleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: spacing.md },
  previewCycleCell: {
    width: 64, paddingVertical: 8,
    borderWidth: 2, borderRadius: radii.md, backgroundColor: colors.bg,
    alignItems: 'center', justifyContent: 'center', gap: 2,
    position: 'relative',
  },
  previewCycleIdx: { color: colors.textMuted, fontSize: 9, fontWeight: '900' },
  previewCycleEmoji: { fontSize: 18 },
  previewCycleLabel: { fontSize: 10, fontWeight: '900' },
  previewCycleTime: { color: colors.textSecondary, fontSize: 9 },
  anchorSelected: { borderColor: colors.cyan, borderWidth: 3, backgroundColor: colors.cyan + '20' },
  todayBadge: {
    position: 'absolute', top: -8, alignSelf: 'center',
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999,
    backgroundColor: colors.cyan, color: colors.bg, fontSize: 8, fontWeight: '900', letterSpacing: 0.5,
  },

  btnRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  btn: { flex: 1, paddingVertical: 14, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  btnGhostText: { color: colors.textSecondary, fontWeight: '800', fontSize: 13 },
  btnPrimary: { backgroundColor: colors.cyan },
  btnPrimaryText: { color: colors.bg, fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },

  // Final 6-month view
  monthCard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.lg, padding: spacing.sm, marginBottom: spacing.md,
  },
  monthLabel: { color: colors.text, fontSize: 14, fontWeight: '900', marginBottom: 8, textTransform: 'uppercase' as const, letterSpacing: 1 },
  monthHeaderRow: { flexDirection: 'row', marginBottom: 4 },
  monthHeadCell: { flex: 1, color: colors.textMuted, fontSize: 9, fontWeight: '800', textAlign: 'center' },
  monthGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  monthCell: {
    width: `${100 / 7}%`, aspectRatio: 1, padding: 1.5,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'transparent',
    borderRadius: radii.sm,
  },
  monthCellToday: { borderColor: colors.cyan },
  monthCellDay: { color: colors.text, fontSize: 11, fontWeight: '700' },
  monthCellEmoji: { fontSize: 12, marginTop: 1 },
  overrideDot: {
    position: 'absolute', top: 2, right: 2,
    width: 5, height: 5, borderRadius: 3, backgroundColor: '#FFD700',
  },
});

const modalStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)' },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border,
    padding: spacing.lg,
  },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg,
    padding: spacing.lg, paddingBottom: spacing.xl, gap: 8,
    borderTopWidth: 1, borderColor: colors.border, marginTop: 'auto',
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
  kicker: { color: colors.cyan, fontSize: 10, fontWeight: '900', letterSpacing: 2, textAlign: 'center' },
  title: { color: colors.text, fontSize: 16, fontWeight: '900', textAlign: 'center', marginBottom: 8 },
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, marginTop: spacing.sm, marginBottom: 6 },
  timeInput: {
    backgroundColor: colors.bg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 12, fontSize: 16, fontWeight: '900', textAlign: 'center', letterSpacing: 1,
  },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  emojiBtn: {
    width: 44, height: 44, borderRadius: radii.md,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  emojiBtnActive: { borderColor: colors.cyan, backgroundColor: colors.cyan + '22' },
  colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  colorSwatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2 },
  btnRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  btn: { flex: 1, paddingVertical: 12, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  btnGhostText: { color: colors.textSecondary, fontWeight: '800', fontSize: 13 },
  btnPrimary: { backgroundColor: colors.cyan },
  btnPrimaryText: { color: colors.bg, fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 14, borderRadius: radii.md, borderWidth: 1.5,
    backgroundColor: colors.bg, marginTop: 8,
  },
  rowText: { color: colors.text, fontSize: 14, fontWeight: '900' },
  rowSub: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  cancel: { paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  cancelText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
});
