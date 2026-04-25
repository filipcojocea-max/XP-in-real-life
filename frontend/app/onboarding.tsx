import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { api, OnboardingPayload } from '../src/api';
import { colors, spacing, radii } from '../src/theme';

type Answers = {
  name: string;
  main_goals: string[];
  experience_level: string;
  productivity_score: number;
  loves: string[];
  loves_other: string;
  focused_time: string;
  focused_window: string;
  good_habits: string[];
  good_habits_other: string;
  bad_habits: string[];
  bad_habits_other: string;
  age_range: string;
  gender: string;
  avatar_base64: string | null;
};

const GOAL_OPTS = [
  { v: 'Productive', icon: 'flash' },
  { v: 'Get Fit', icon: 'barbell' },
  { v: 'Build Confidence', icon: 'shield' },
  { v: 'Sleep Better', icon: 'moon' },
  { v: 'Learn New Skills', icon: 'school' },
  { v: 'Reduce Stress', icon: 'leaf' },
  { v: 'Build Habits', icon: 'checkbox' },
  { v: 'Eat Healthy', icon: 'restaurant' },
  { v: 'Make Friends', icon: 'people' },
  { v: 'Save Money', icon: 'cash' },
];
const LEVEL_OPTS = ['Beginner', 'Intermediate', 'Expert'];
const LOVES_OPTS = ['Walking', 'Running', 'Reading', 'Gaming', 'Cooking', 'Music', 'Art', 'Meditation', 'Gym', 'Hiking', 'Writing', 'Movies', 'Cycling'];
const TIME_OPTS = ['Twilight', 'Morning', 'Midday', 'Afternoon', 'Evening', 'Night', 'Midnight'];
const GOOD_OPTS = ['Good Sleep', 'Walking', 'Exercising', 'Reading', 'Journaling', 'Meditation', 'Eating Healthy', 'Drinking Water', 'Waking Up Early'];
const BAD_OPTS = ['Too Much Video Games', 'Scrolling Social Media', 'Staying Up Late', 'Junk Food', 'Procrastinating', 'Skipping Workouts', 'Smoking'];
const AGE_OPTS = ['10-14', '15-17', '18-20', '21-25', '25+'];
const GENDER_OPTS = ['Male', 'Female'];

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [answers, setAnswers] = useState<Answers>({
    name: '',
    main_goals: [],
    experience_level: '',
    productivity_score: 5,
    loves: [],
    loves_other: '',
    focused_time: '',
    focused_window: '',
    good_habits: [],
    good_habits_other: '',
    bad_habits: [],
    bad_habits_other: '',
    age_range: '',
    gender: '',
    avatar_base64: null,
  });

  const steps = ['intro', 'name', 'goals', 'level', 'productivity', 'loves', 'focus', 'good', 'bad', 'age', 'gender', 'avatar', 'done'] as const;
  const stepName = steps[step];

  const totalInteractive = steps.length - 2; // exclude intro + done from count
  const progressPct = Math.max(0, Math.min(1, (step - 1) / (totalInteractive - 1 || 1)));

  const toggle = (key: 'main_goals' | 'loves' | 'good_habits' | 'bad_habits', val: string) => {
    setAnswers((a) => {
      const set = new Set(a[key]);
      if (set.has(val)) set.delete(val);
      else set.add(val);
      return { ...a, [key]: Array.from(set) };
    });
  };

  const next = () => setStep((s) => Math.min(s + 1, steps.length - 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const skip = () => next();

  const pickImage = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission denied', 'Enable photo access to add an avatar.');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.6,
        base64: true,
      });
      if (!res.canceled && res.assets[0]?.base64) {
        setAnswers((a) => ({ ...a, avatar_base64: `data:image/jpeg;base64,${res.assets[0].base64}` }));
      }
    } catch (e: any) {
      Alert.alert('Error picking image', String(e?.message || e));
    }
  };

  const finish = async () => {
    setSaving(true);
    try {
      const payload: OnboardingPayload = {};
      if (answers.name) payload.name = answers.name;
      if (answers.main_goals.length) payload.main_goals = answers.main_goals;
      if (answers.experience_level) payload.experience_level = answers.experience_level;
      if (answers.productivity_score) payload.productivity_score = answers.productivity_score;
      if (answers.loves.length) payload.loves = answers.loves;
      if (answers.loves_other) payload.loves_other = answers.loves_other;
      if (answers.focused_time) payload.focused_time = answers.focused_time;
      if (answers.focused_window) payload.focused_window = answers.focused_window;
      if (answers.good_habits.length) payload.good_habits = answers.good_habits;
      if (answers.good_habits_other) payload.good_habits_other = answers.good_habits_other;
      if (answers.bad_habits.length) payload.bad_habits = answers.bad_habits;
      if (answers.bad_habits_other) payload.bad_habits_other = answers.bad_habits_other;
      if (answers.age_range) payload.age_range = answers.age_range;
      if (answers.gender) payload.gender = answers.gender;

      await api.completeOnboarding(payload);
      if (answers.avatar_base64) {
        await api.setAvatar(answers.avatar_base64);
      }
      router.replace('/');
    } catch (e: any) {
      Alert.alert('Could not save', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const renderChips = (opts: string[] | { v: string; icon?: string }[], selected: string[], onTap: (v: string) => void, testPrefix: string) => (
    <View style={styles.chipWrap}>
      {opts.map((o) => {
        const v = typeof o === 'string' ? o : o.v;
        const icon = typeof o === 'string' ? null : o.icon;
        const active = selected.includes(v);
        return (
          <TouchableOpacity
            key={v}
            testID={`${testPrefix}-${v.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
            onPress={() => onTap(v)}
            style={[
              styles.chip,
              active && { backgroundColor: colors.green, borderColor: colors.green },
            ]}
          >
            {icon ? (
              <Ionicons name={icon as any} size={14} color={active ? colors.bg : colors.cyan} />
            ) : null}
            <Text style={[styles.chipText, active && { color: colors.bg }]}>{v}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const renderSingle = (opts: string[], current: string, onSelect: (v: string) => void, testPrefix: string) => (
    <View style={styles.chipWrap}>
      {opts.map((v) => {
        const active = current === v;
        return (
          <TouchableOpacity
            key={v}
            testID={`${testPrefix}-${v.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
            onPress={() => onSelect(v)}
            style={[
              styles.chip,
              active && { backgroundColor: colors.cyan, borderColor: colors.cyan },
            ]}
          >
            <Text style={[styles.chipText, active && { color: colors.bg }]}>{v}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  // Content per step
  let title = '';
  let subtitle = '';
  let body: React.ReactNode = null;
  let canSkip = true;

  switch (stepName) {
    case 'intro':
      title = 'Welcome, Hero';
      subtitle = 'A quick 2-min setup to tailor your journey. Skip anything you want — update it later.';
      body = (
        <View style={{ alignItems: 'center', marginTop: spacing.xl }}>
          <View style={styles.heroBadge}>
            <Ionicons name="shield" size={70} color={colors.cyan} />
          </View>
          <Text style={styles.heroCaption}>Level Up in Real Life</Text>
        </View>
      );
      canSkip = false;
      break;

    case 'name':
      title = "What's your name?";
      subtitle = 'Your character name. You can change this later.';
      body = (
        <TextInput
          testID="onb-name-input"
          style={styles.input}
          placeholder="e.g. Alex"
          placeholderTextColor={colors.textMuted}
          value={answers.name}
          onChangeText={(t) => setAnswers((a) => ({ ...a, name: t }))}
        />
      );
      break;

    case 'goals':
      title = "What's your main goal?";
      subtitle = 'Pick as many as you like.';
      body = renderChips(GOAL_OPTS, answers.main_goals, (v) => toggle('main_goals', v), 'onb-goal');
      break;

    case 'level':
      title = 'Your current experience level?';
      subtitle = 'Be honest — this calibrates your XP pace.';
      body = renderSingle(LEVEL_OPTS, answers.experience_level, (v) => setAnswers((a) => ({ ...a, experience_level: v })), 'onb-level');
      break;

    case 'productivity':
      title = 'How productive are you?';
      subtitle = 'Rate yourself from 1 (lazy day) to 10 (machine mode).';
      body = (
        <View style={{ marginTop: spacing.lg }}>
          <View style={styles.scaleRow}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
              const active = answers.productivity_score === n;
              return (
                <TouchableOpacity
                  key={n}
                  testID={`onb-prod-${n}`}
                  onPress={() => setAnswers((a) => ({ ...a, productivity_score: n }))}
                  style={[
                    styles.scaleChip,
                    active && { backgroundColor: colors.amber, borderColor: colors.amber },
                  ]}
                >
                  <Text style={[styles.scaleText, active && { color: colors.bg }]}>{n}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.scaleHint}>
            {answers.productivity_score <= 3 ? 'Room to grow 📈' : answers.productivity_score <= 7 ? 'Solid ground 💪' : 'Beast mode 🔥'}
          </Text>
        </View>
      );
      break;

    case 'loves':
      title = 'What do you love doing?';
      subtitle = 'These inspire future quests for you.';
      body = (
        <>
          {renderChips(LOVES_OPTS, answers.loves, (v) => toggle('loves', v), 'onb-love')}
          <Text style={styles.subLabel}>Other (optional)</Text>
          <TextInput
            testID="onb-loves-other"
            style={styles.input}
            placeholder="e.g. surfing, chess"
            placeholderTextColor={colors.textMuted}
            value={answers.loves_other}
            onChangeText={(t) => setAnswers((a) => ({ ...a, loves_other: t }))}
          />
        </>
      );
      break;

    case 'focus':
      title = 'When are you most focused?';
      subtitle = answers.focused_time ? `Early ${answers.focused_time.toLowerCase()} or after ${answers.focused_time.toLowerCase()}?` : 'Pick your peak window.';
      body = (
        <>
          {renderSingle(TIME_OPTS, answers.focused_time, (v) => setAnswers((a) => ({ ...a, focused_time: v, focused_window: '' })), 'onb-time')}
          {answers.focused_time ? (
            <>
              <Text style={styles.subLabel}>Refine</Text>
              {renderSingle(['early', 'after'], answers.focused_window, (v) => setAnswers((a) => ({ ...a, focused_window: v })), 'onb-window')}
            </>
          ) : null}
        </>
      );
      break;

    case 'good':
      title = 'What good habits do you have?';
      subtitle = 'The ones you already win at.';
      body = (
        <>
          {renderChips(GOOD_OPTS, answers.good_habits, (v) => toggle('good_habits', v), 'onb-good')}
          <Text style={styles.subLabel}>Other</Text>
          <TextInput
            testID="onb-good-other"
            style={styles.input}
            placeholder="e.g. cold showers"
            placeholderTextColor={colors.textMuted}
            value={answers.good_habits_other}
            onChangeText={(t) => setAnswers((a) => ({ ...a, good_habits_other: t }))}
          />
        </>
      );
      break;

    case 'bad':
      title = 'What bad habits do you have?';
      subtitle = "No judgement — we'll help you defeat them.";
      body = (
        <>
          {renderChips(BAD_OPTS, answers.bad_habits, (v) => toggle('bad_habits', v), 'onb-bad')}
          <Text style={styles.subLabel}>Other</Text>
          <TextInput
            testID="onb-bad-other"
            style={styles.input}
            placeholder="type your own"
            placeholderTextColor={colors.textMuted}
            value={answers.bad_habits_other}
            onChangeText={(t) => setAnswers((a) => ({ ...a, bad_habits_other: t }))}
          />
        </>
      );
      break;

    case 'age':
      title = 'How old are you?';
      subtitle = '';
      body = renderSingle(AGE_OPTS, answers.age_range, (v) => setAnswers((a) => ({ ...a, age_range: v })), 'onb-age');
      break;

    case 'gender':
      title = "What's your gender?";
      subtitle = '';
      body = renderSingle(GENDER_OPTS, answers.gender, (v) => setAnswers((a) => ({ ...a, gender: v })), 'onb-gender');
      break;

    case 'avatar':
      title = 'Add a profile photo';
      subtitle = 'Your character avatar. Skip and add later anytime.';
      body = (
        <View style={{ alignItems: 'center', marginTop: spacing.lg }}>
          <TouchableOpacity testID="onb-avatar-pick" onPress={pickImage} style={styles.avatarPicker}>
            {answers.avatar_base64 ? (
              <Image source={{ uri: answers.avatar_base64 }} style={styles.avatarImg} />
            ) : (
              <Ionicons name="camera" size={44} color={colors.cyan} />
            )}
          </TouchableOpacity>
          <Text style={styles.subLabel}>Tap to choose photo</Text>
        </View>
      );
      break;

    case 'done':
      title = "You're set.";
      subtitle = 'Your character is ready to level up in real life.';
      body = (
        <View style={{ alignItems: 'center', marginTop: spacing.xl }}>
          <View style={[styles.heroBadge, { borderColor: colors.green, backgroundColor: colors.green + '22' }]}>
            <Ionicons name="checkmark" size={70} color={colors.green} />
          </View>
          {answers.name ? <Text style={[styles.heroCaption, { color: colors.green }]}>Welcome, {answers.name}</Text> : null}
        </View>
      );
      canSkip = false;
      break;
  }

  const isFirst = step === 0;
  const isLast = stepName === 'done';
  const nextLabel = isFirst ? 'Start' : isLast ? (saving ? 'Saving…' : 'Enter the Game') : 'Next';

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            testID="onb-back"
            onPress={back}
            style={[styles.iconBtn, isFirst && { opacity: 0.3 }]}
            disabled={isFirst}
          >
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${Math.max(4, progressPct * 100)}%` }]} />
          </View>
          {canSkip ? (
            <TouchableOpacity testID="onb-skip" onPress={skip} style={styles.skipBtn}>
              <Text style={styles.skipText}>Skip</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.iconBtn} />
          )}
        </View>

        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {body}
        </ScrollView>

        {/* Footer CTA */}
        <View style={styles.footer}>
          <TouchableOpacity
            testID="onb-next"
            style={[styles.nextBtn, saving && { opacity: 0.7 }]}
            onPress={isLast ? finish : next}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <>
                <Text style={styles.nextText}>{nextLabel}</Text>
                <Ionicons name={isLast ? 'sparkles' : 'arrow-forward'} size={18} color={colors.bg} />
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.sm,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceGlass,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  progressBar: {
    flex: 1,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.green, borderRadius: radii.pill },
  skipBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  skipText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },

  scroll: { padding: spacing.lg, paddingBottom: 140 },
  title: { color: colors.text, fontSize: 28, fontWeight: '900', letterSpacing: -0.5 },
  subtitle: { color: colors.textSecondary, fontSize: 14, marginTop: 8, lineHeight: 20 },

  heroBadge: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: colors.cyan + '18',
    borderWidth: 2,
    borderColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroCaption: { color: colors.cyan, marginTop: spacing.lg, fontWeight: '800', letterSpacing: 1 },

  input: {
    marginTop: spacing.lg,
    backgroundColor: colors.surfaceGlass,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  subLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing.lg, marginBottom: 6 },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceGlass,
  },
  chipText: { color: colors.text, fontWeight: '700', fontSize: 13 },

  scaleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  scaleChip: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceGlass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scaleText: { color: colors.text, fontWeight: '900', fontSize: 16 },
  scaleHint: { color: colors.amber, textAlign: 'center', marginTop: spacing.lg, fontWeight: '700' },

  avatarPicker: {
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 2,
    borderColor: colors.cyan,
    backgroundColor: colors.cyan + '15',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%' },

  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.md,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  nextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 16,
    borderRadius: radii.pill,
    backgroundColor: colors.green,
    shadowColor: colors.green,
    shadowOpacity: 0.6,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
  },
  nextText: { color: colors.bg, fontSize: 16, fontWeight: '900', letterSpacing: 0.5 },
});
