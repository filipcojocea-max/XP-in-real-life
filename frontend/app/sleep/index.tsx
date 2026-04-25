import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Modal,
  Pressable, FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  api,
  SleepProfile,
  SleepChatMsg,
  SleepHealthMock,
  SleepRoutineItem,
} from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';

type SubTab = 'plan' | 'coach' | 'health';

export default function SleepHub() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<SleepProfile | null>(null);
  const [showCheckin, setShowCheckin] = useState(false);
  const [tab, setTab] = useState<SubTab>('plan');

  const load = useCallback(async () => {
    try {
      const r = await api.sleepProfile();
      if (!r.onboarded) {
        router.replace('/sleep/onboarding' as any);
        return;
      }
      setProfile(r.profile || null);
      if (r.show_checkin_prompt) setShowCheckin(true);
    } catch (e) {
      console.log('sleep load', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}><ActivityIndicator size="large" color={colors.cyan} /></View>
      </SafeAreaView>
    );
  }
  if (!profile) return null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.topTitleWrap}>
          <View style={styles.miniIconBox}>
            <Ionicons name="moon" size={14} color={colors.cyan} />
          </View>
          <Text style={styles.topTitle}>Improve Sleeping</Text>
        </View>
        <TouchableOpacity onPress={() => confirmReset(load)} hitSlop={10}>
          <Ionicons name="refresh" size={20} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Sub-tabs */}
      <View style={styles.subTabs}>
        <SubTabBtn active={tab === 'plan'} icon="sparkles" label="Plan" onPress={() => setTab('plan')} testID="sleep-tab-plan" />
        <SubTabBtn active={tab === 'coach'} icon="chatbubbles" label="Coach" onPress={() => setTab('coach')} testID="sleep-tab-coach" />
        <SubTabBtn active={tab === 'health'} icon="pulse" label="Sleep Data" onPress={() => setTab('health')} testID="sleep-tab-health" />
      </View>

      {tab === 'plan' && <PlanTab profile={profile} onChanged={load} />}
      {tab === 'coach' && <CoachTab profile={profile} />}
      {tab === 'health' && <HealthTab />}

      {/* Daily check-in modal */}
      <CheckinModal
        visible={showCheckin}
        onClose={() => setShowCheckin(false)}
        onSaved={() => { setShowCheckin(false); load(); }}
      />
    </SafeAreaView>
  );
}

// ───────────────────────── Sub-tab button ─────────────────────────
function SubTabBtn({
  active, icon, label, onPress, testID,
}: { active: boolean; icon: string; label: string; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      style={[styles.subTabBtn, active && styles.subTabActive]}
    >
      <Ionicons name={icon as any} size={15} color={active ? colors.bg : colors.textSecondary} />
      <Text style={[styles.subTabText, active && styles.subTabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ───────────────────────── Plan Tab ─────────────────────────
function PlanTab({ profile, onChanged }: { profile: SleepProfile; onChanged: () => void }) {
  const [regenerating, setRegenerating] = useState(false);
  const [showRegen, setShowRegen] = useState(false);
  const [feedback, setFeedback] = useState('');

  const regen = async () => {
    setRegenerating(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      await api.sleepRegenerate(feedback);
      setShowRegen(false);
      setFeedback('');
      onChanged();
    } catch (e: any) {
      Alert.alert('Could not regenerate', String(e.message || e));
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      {/* Plan card */}
      <View style={styles.planCard}>
        <View style={styles.planKickerRow}>
          <Ionicons name="sparkles" size={14} color={colors.cyan} />
          <Text style={styles.planKicker}>YOUR PERSONALIZED PLAN</Text>
        </View>
        <Text style={styles.planText}>{profile.plan}</Text>
      </View>

      {/* Routine */}
      <Text style={styles.sectionTitle}>Tonight's Routine</Text>
      {profile.routine.map((item, i) => (
        <RoutineRow key={`${item.title}-${i}`} item={item} index={i} />
      ))}

      {/* Recent check-ins */}
      {profile.check_ins && profile.check_ins.length > 0 ? (
        <>
          <Text style={[styles.sectionTitle, { marginTop: spacing.lg }]}>Recent Check-ins</Text>
          {profile.check_ins.slice(-5).reverse().map((c) => (
            <View key={c.ts} style={styles.checkinRow}>
              <Text style={styles.checkinDate}>{new Date(c.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</Text>
              <View style={styles.checkinDots}>
                {Array.from({ length: 10 }).map((_, i) => (
                  <View key={i} style={[styles.checkinDot, i < c.rating && { backgroundColor: c.rating >= 7 ? colors.green : c.rating >= 4 ? colors.amber : colors.danger }]} />
                ))}
              </View>
              <Text style={styles.checkinRating}>{c.rating}/10</Text>
            </View>
          ))}
        </>
      ) : null}

      {/* Regenerate plan */}
      <TouchableOpacity
        testID="sleep-regenerate"
        style={styles.regenBtn}
        onPress={() => setShowRegen(true)}
      >
        <Ionicons name="refresh-circle" size={18} color={colors.cyan} />
        <Text style={styles.regenText}>Let's try something else</Text>
      </TouchableOpacity>

      {/* Regen modal */}
      <Modal visible={showRegen} transparent animationType="slide" onRequestClose={() => setShowRegen(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowRegen(false)} />
          <View style={styles.modalSheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.modalTitle}>What's not working?</Text>
            <Text style={styles.modalSub}>Tell Luna what to change — she'll regenerate your plan.</Text>
            <TextInput
              testID="sleep-regen-input"
              value={feedback}
              onChangeText={setFeedback}
              placeholder="e.g. milk gives me indigestion, I want a cooler routine"
              placeholderTextColor={colors.textMuted}
              multiline
              style={styles.modalInput}
            />
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
              <TouchableOpacity style={[styles.modalBtn, styles.cancelBtn]} onPress={() => setShowRegen(false)}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="sleep-regen-confirm" disabled={regenerating} style={[styles.modalBtn, styles.saveBtn]} onPress={regen}>
                {regenerating ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.saveText}>Regenerate</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

function RoutineRow({ item, index }: { item: SleepRoutineItem; index: number }) {
  return (
    <View style={styles.routineCard}>
      <View style={styles.routineNum}>
        <Text style={styles.routineNumText}>{index + 1}</Text>
      </View>
      <View style={styles.routineIcon}>
        <Ionicons name={(item.icon || 'moon') as any} size={20} color={colors.cyan} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.routineHead}>
          <Text style={styles.routineTitle}>{item.title}</Text>
          <Text style={styles.routineTime}>{item.time}</Text>
        </View>
        <Text style={styles.routineDesc}>{item.description}</Text>
      </View>
    </View>
  );
}

// ───────────────────────── Coach Tab ─────────────────────────
function CoachTab({ profile }: { profile: SleepProfile }) {
  const [messages, setMessages] = useState<SleepChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.sleepChatHistory();
        if (r.messages.length === 0) {
          // greeting message (not stored)
          setMessages([{
            user_id: 'main', role: 'assistant',
            content: `Hi! I'm Luna, your sleep coach. I've reviewed your answers — your plan is on the Plan tab. Ask me anything: 'what if I can't fall asleep?', 'should I nap?', or share what's on your mind tonight. 🌙`,
            ts: new Date().toISOString(),
          }]);
        } else {
          setMessages(r.messages);
        }
      } catch (e) {
        console.log('chat history', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    const optimisticUser: SleepChatMsg = { user_id: 'main', role: 'user', content: text, ts: new Date().toISOString() };
    setMessages((m) => [...m, optimisticUser]);
    setSending(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    try {
      const r = await api.sleepChatSend(text);
      setMessages((m) => {
        // replace last optimistic & append assistant
        const filtered = m.slice(0, -1);
        return [...filtered, r.user, r.assistant];
      });
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (e: any) {
      setMessages((m) => [...m, {
        user_id: 'main', role: 'assistant', content: 'Sorry, I had a hiccup. Try again?', ts: new Date().toISOString(),
      }]);
    } finally {
      setSending(false);
    }
  };

  const suggestPrompts = [
    "What if I can't fall asleep?",
    'Should I nap during the day?',
    'I keep waking up at 3am',
    'How was your sleep last night?',
  ];

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={colors.cyan} /></View>;
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={80}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m, i) => `${m.ts}-${i}`}
        contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.lg }}
        renderItem={({ item }) => (
          <View style={[
            styles.bubbleRow,
            item.role === 'user' ? styles.bubbleRowUser : styles.bubbleRowAsst,
          ]}>
            {item.role === 'assistant' ? (
              <View style={styles.lunaAvatar}><Ionicons name="moon" size={14} color={colors.cyan} /></View>
            ) : null}
            <View style={[
              styles.bubble,
              item.role === 'user' ? styles.bubbleUser : styles.bubbleAsst,
            ]}>
              <Text style={item.role === 'user' ? styles.bubbleUserText : styles.bubbleAsstText}>
                {item.content}
              </Text>
            </View>
          </View>
        )}
        ListFooterComponent={sending ? (
          <View style={styles.bubbleRowAsst}>
            <View style={styles.lunaAvatar}><Ionicons name="moon" size={14} color={colors.cyan} /></View>
            <View style={[styles.bubble, styles.bubbleAsst, { paddingHorizontal: 16 }]}>
              <ActivityIndicator size="small" color={colors.cyan} />
            </View>
          </View>
        ) : null}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      {/* Suggestion chips */}
      {messages.length <= 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipScroll}>
          {suggestPrompts.map((p) => (
            <TouchableOpacity key={p} style={styles.suggestChip} onPress={() => setInput(p)}>
              <Text style={styles.suggestChipText}>{p}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}

      {/* Input bar */}
      <View style={styles.inputBar}>
        <TextInput
          testID="sleep-chat-input"
          value={input}
          onChangeText={setInput}
          placeholder="Message Luna…"
          placeholderTextColor={colors.textMuted}
          style={styles.chatInput}
          onSubmitEditing={send}
          returnKeyType="send"
          blurOnSubmit={false}
        />
        <TouchableOpacity
          testID="sleep-chat-send"
          onPress={send}
          disabled={sending || !input.trim()}
          style={[styles.sendBtn, (!input.trim() || sending) && { opacity: 0.4 }]}
        >
          <Ionicons name="send" size={18} color={colors.bg} />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// ───────────────────────── Health (Sleep Data) Tab ─────────────────────────
function HealthTab() {
  const [data, setData] = useState<SleepHealthMock | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.sleepHealthMock();
        setData(r);
      } catch (e) {
        console.log('health mock', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading || !data) {
    return <View style={styles.center}><ActivityIndicator color={colors.cyan} /></View>;
  }

  const maxHours = Math.max(...data.nights.map((n) => n.total_hours));

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      {/* Connect banner */}
      <View style={styles.connectBanner}>
        <View style={styles.connectIconWrap}>
          <Ionicons name="lock-closed" size={18} color={colors.amber} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.connectTitle}>Connect Apple Health / Google Fit</Text>
          <Text style={styles.connectDesc}>
            Activates on production native build. For now we're showing simulated data so you can preview the dashboard.
          </Text>
        </View>
      </View>

      {/* Headline stats */}
      <View style={styles.statRow}>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>AVG SLEEP</Text>
          <Text style={styles.statValue}>{data.avg_total_hours}<Text style={styles.statUnit}>h</Text></Text>
          <Text style={styles.statSub}>Last 7 nights</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>SLEEP SCORE</Text>
          <Text style={[styles.statValue, { color: data.avg_score >= 80 ? colors.green : data.avg_score >= 65 ? colors.amber : colors.danger }]}>{data.avg_score}</Text>
          <Text style={styles.statSub}>out of 100</Text>
        </View>
      </View>

      {/* Bar chart of last 7 nights */}
      <Text style={styles.sectionTitle}>Last 7 nights</Text>
      <View style={styles.chartCard}>
        <View style={styles.chartRow}>
          {data.nights.map((n) => {
            const h = (n.total_hours / maxHours) * 130;
            const color = n.score >= 80 ? colors.green : n.score >= 65 ? colors.amber : colors.danger;
            return (
              <View key={n.date} style={styles.chartCol}>
                <Text style={styles.chartHours}>{n.total_hours}h</Text>
                <View style={styles.chartBarTrack}>
                  <View style={[styles.chartBar, { height: h, backgroundColor: color }]} />
                </View>
                <Text style={styles.chartDay}>{n.day}</Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* Best/worst */}
      <View style={[styles.statRow, { marginTop: spacing.md }]}>
        <View style={[styles.statCard, { borderColor: colors.green + '66' }]}>
          <Text style={[styles.statLabel, { color: colors.green }]}>BEST NIGHT</Text>
          <Text style={styles.statValue}>{data.best_night.score}</Text>
          <Text style={styles.statSub}>{new Date(data.best_night.date).toLocaleDateString(undefined, { weekday: 'long' })} · {data.best_night.total_hours}h</Text>
        </View>
        <View style={[styles.statCard, { borderColor: colors.danger + '66' }]}>
          <Text style={[styles.statLabel, { color: colors.danger }]}>TOUGHEST</Text>
          <Text style={styles.statValue}>{data.worst_night.score}</Text>
          <Text style={styles.statSub}>{new Date(data.worst_night.date).toLocaleDateString(undefined, { weekday: 'long' })} · {data.worst_night.total_hours}h</Text>
        </View>
      </View>

      {/* Stage breakdown */}
      <Text style={[styles.sectionTitle, { marginTop: spacing.lg }]}>Sleep stages (avg)</Text>
      <StageBar label="Deep" hours={avg(data.nights.map((n) => n.deep_hours))} color={colors.cyan} totalAvg={data.avg_total_hours} />
      <StageBar label="REM" hours={avg(data.nights.map((n) => n.rem_hours))} color={colors.amber} totalAvg={data.avg_total_hours} />
      <StageBar label="Light" hours={avg(data.nights.map((n) => n.light_hours))} color={colors.textSecondary} totalAvg={data.avg_total_hours} />

      <Text style={styles.footnote}>Source: {data.source} · Real Apple Health / Google Fit data activates after EAS native build.</Text>
    </ScrollView>
  );
}

function StageBar({ label, hours, color, totalAvg }: { label: string; hours: number; color: string; totalAvg: number }) {
  const pct = totalAvg > 0 ? (hours / totalAvg) * 100 : 0;
  return (
    <View style={styles.stageRow}>
      <Text style={styles.stageLabel}>{label}</Text>
      <View style={styles.stageBarTrack}>
        <View style={[styles.stageBarFill, { width: `${Math.min(pct, 100)}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.stageValue}>{hours.toFixed(1)}h</Text>
    </View>
  );
}

function avg(arr: number[]) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

// ───────────────────────── Check-in Modal ─────────────────────────
function CheckinModal({ visible, onClose, onSaved }: { visible: boolean; onClose: () => void; onSaved: () => void }) {
  const [rating, setRating] = useState<number | null>(null);
  const [hours, setHours] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setRating(null);
      setHours('');
      setNotes('');
    }
  }, [visible]);

  const save = async () => {
    if (rating === null) {
      Alert.alert('Tap a rating from 1 to 10');
      return;
    }
    setSaving(true);
    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      await api.sleepCheckin(rating, hours ? parseFloat(hours) : undefined, notes);
      onSaved();
    } catch (e: any) {
      Alert.alert('Could not save', String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.modalSheet}>
          <View style={styles.sheetHandle} />
          <Text style={styles.modalTitle}>How was your sleep?</Text>
          <Text style={styles.modalSub}>Quick check-in. Helps Luna spot patterns over time.</Text>

          <Text style={styles.inputLabel}>Rating (1 = awful, 10 = perfect)</Text>
          <View style={styles.scaleRow10}>
            {Array.from({ length: 10 }).map((_, i) => {
              const v = i + 1;
              const active = rating === v;
              return (
                <TouchableOpacity
                  key={v}
                  testID={`checkin-rate-${v}`}
                  onPress={() => { setRating(v); Haptics.selectionAsync().catch(() => {}); }}
                  style={[styles.scaleBtn10, active && styles.scaleBtn10Active]}
                >
                  <Text style={[styles.scaleBtnText10, active && styles.scaleBtnTextActive10]}>{v}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.inputLabel}>Hours slept (optional)</Text>
          <TextInput
            testID="checkin-hours"
            value={hours}
            onChangeText={setHours}
            placeholder="e.g. 7.5"
            keyboardType="decimal-pad"
            placeholderTextColor={colors.textMuted}
            style={styles.modalInput}
          />

          <Text style={styles.inputLabel}>Notes (optional)</Text>
          <TextInput
            testID="checkin-notes"
            value={notes}
            onChangeText={setNotes}
            placeholder="What helped or hurt?"
            placeholderTextColor={colors.textMuted}
            multiline
            style={[styles.modalInput, { minHeight: 70 }]}
          />

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
            <TouchableOpacity style={[styles.modalBtn, styles.cancelBtn]} onPress={onClose}>
              <Text style={styles.cancelText}>Skip</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="checkin-save" disabled={saving} style={[styles.modalBtn, styles.saveBtn]} onPress={save}>
              {saving ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.saveText}>Save</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ───────────────────────── Helpers ─────────────────────────
function confirmReset(reload: () => void) {
  Alert.alert(
    'Reset sleep coach?',
    'This will delete your answers, plan and chat history. You can re-take the questionnaire.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.sleepReset();
            router.replace('/sleep/onboarding' as any);
          } catch (e: any) {
            Alert.alert('Could not reset', String(e.message || e));
          }
        },
      },
    ],
  );
}

// ───────────────────────── Styles ─────────────────────────
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  topTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  miniIconBox: {
    width: 26, height: 26, borderRadius: 8,
    backgroundColor: colors.cyan + '22',
    borderWidth: 1, borderColor: colors.cyan + '88',
    alignItems: 'center', justifyContent: 'center',
  },
  topTitle: { color: colors.text, fontSize: 17, fontWeight: '900', letterSpacing: -0.3 },

  subTabs: {
    flexDirection: 'row', marginHorizontal: spacing.md,
    padding: 4, borderRadius: radii.pill,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  subTabBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, paddingVertical: 9, borderRadius: radii.pill,
  },
  subTabActive: { backgroundColor: colors.cyan },
  subTabText: { color: colors.textSecondary, fontSize: 12, fontWeight: '800' },
  subTabTextActive: { color: colors.bg },

  scroll: { padding: spacing.md, paddingBottom: 120 },

  // ── Plan ──
  planCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.cyan + '55',
    padding: spacing.md,
  },
  planKickerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  planKicker: { color: colors.cyan, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  planText: { color: colors.text, fontSize: 13.5, lineHeight: 21 },

  sectionTitle: {
    color: colors.text, fontSize: 16, fontWeight: '900', letterSpacing: -0.3,
    marginTop: spacing.lg, marginBottom: spacing.sm,
  },

  routineCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
    padding: spacing.md, marginBottom: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  routineNum: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: colors.cyan + '22', alignItems: 'center', justifyContent: 'center',
  },
  routineNumText: { color: colors.cyan, fontSize: 11, fontWeight: '900' },
  routineIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.cyan + '15', borderWidth: 1, borderColor: colors.cyan + '55',
    alignItems: 'center', justifyContent: 'center',
  },
  routineHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  routineTitle: { color: colors.text, fontSize: 14, fontWeight: '800', flex: 1 },
  routineTime: { color: colors.cyan, fontSize: 11, fontWeight: '800' },
  routineDesc: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 3 },

  checkinRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: 10, paddingHorizontal: spacing.md, marginBottom: 6,
    borderRadius: radii.md, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  checkinDate: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', width: 90 },
  checkinDots: { flexDirection: 'row', gap: 3, flex: 1 },
  checkinDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.borderStrong },
  checkinRating: { color: colors.text, fontSize: 12, fontWeight: '900' },

  regenBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, borderRadius: radii.pill,
    backgroundColor: colors.cyan + '14', borderWidth: 1, borderColor: colors.cyan + '55',
    marginTop: spacing.lg,
  },
  regenText: { color: colors.cyan, fontSize: 13, fontWeight: '800' },

  // ── Coach ──
  bubbleRow: { flexDirection: 'row', marginBottom: 10, alignItems: 'flex-end', gap: 6 },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubbleRowAsst: { justifyContent: 'flex-start' },
  lunaAvatar: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.cyan + '22', borderWidth: 1, borderColor: colors.cyan + '88',
    alignItems: 'center', justifyContent: 'center',
  },
  bubble: {
    maxWidth: '78%', paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 16,
  },
  bubbleUser: { backgroundColor: colors.cyan, borderBottomRightRadius: 4 },
  bubbleAsst: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderBottomLeftRadius: 4 },
  bubbleUserText: { color: colors.bg, fontSize: 14, fontWeight: '600', lineHeight: 19 },
  bubbleAsstText: { color: colors.text, fontSize: 14, lineHeight: 20 },

  chipScroll: { paddingHorizontal: spacing.md, gap: 8, paddingVertical: 6 },
  suggestChip: {
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.cyan + '55',
    borderRadius: radii.pill, marginRight: 8,
  },
  suggestChipText: { color: colors.cyan, fontSize: 12, fontWeight: '700' },

  inputBar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  chatInput: {
    flex: 1, color: colors.text, fontSize: 14,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.pill, paddingHorizontal: 16, paddingVertical: Platform.OS === 'ios' ? 10 : 8,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.cyan, alignItems: 'center', justifyContent: 'center',
  },

  // ── Health ──
  connectBanner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.md, borderRadius: radii.md,
    backgroundColor: colors.amber + '12', borderWidth: 1, borderColor: colors.amber + '55',
  },
  connectIconWrap: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.amber + '22', borderWidth: 1, borderColor: colors.amber + '66',
    alignItems: 'center', justifyContent: 'center',
  },
  connectTitle: { color: colors.amber, fontSize: 13, fontWeight: '900' },
  connectDesc: { color: colors.textSecondary, fontSize: 11, marginTop: 2, lineHeight: 16 },

  statRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  statCard: {
    flex: 1, padding: spacing.md, borderRadius: radii.md,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  statLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  statValue: { color: colors.text, fontSize: 32, fontWeight: '900', marginTop: 4, letterSpacing: -1 },
  statUnit: { fontSize: 18, color: colors.textSecondary, fontWeight: '800' },
  statSub: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },

  chartCard: {
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md,
  },
  chartRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 180 },
  chartCol: { alignItems: 'center', flex: 1, gap: 4 },
  chartHours: { color: colors.textSecondary, fontSize: 10, fontWeight: '700' },
  chartBarTrack: { height: 130, justifyContent: 'flex-end', width: 22 },
  chartBar: { width: 22, borderRadius: 4 },
  chartDay: { color: colors.textMuted, fontSize: 10, fontWeight: '800', marginTop: 4 },

  stageRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    marginBottom: 8,
  },
  stageLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: '800', width: 50 },
  stageBarTrack: {
    flex: 1, height: 14, borderRadius: 7,
    backgroundColor: colors.surfaceGlass, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
  },
  stageBarFill: { height: '100%', borderRadius: 7 },
  stageValue: { color: colors.text, fontSize: 12, fontWeight: '800', width: 44, textAlign: 'right' },

  footnote: {
    color: colors.textMuted, fontSize: 10, textAlign: 'center',
    marginTop: spacing.lg, paddingHorizontal: spacing.md,
  },

  // ── Modals ──
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.surface, padding: spacing.lg, paddingBottom: spacing.xxl,
    borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg,
    borderTopWidth: 1, borderColor: colors.border,
  },
  sheetHandle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.borderStrong, marginBottom: spacing.md,
  },
  modalTitle: { color: colors.text, fontSize: 22, fontWeight: '900', letterSpacing: -0.3 },
  modalSub: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  inputLabel: {
    color: colors.textSecondary, fontSize: 11, fontWeight: '800',
    textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing.md, marginBottom: 6,
  },
  modalInput: {
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: 12,
    color: colors.text, fontSize: 14, textAlignVertical: 'top',
  },
  modalBtn: {
    flex: 1, paddingVertical: 14, borderRadius: radii.pill,
    alignItems: 'center', justifyContent: 'center',
  },
  cancelBtn: { backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.textSecondary, fontWeight: '700' },
  saveBtn: { backgroundColor: colors.cyan },
  saveText: { color: colors.bg, fontWeight: '900', fontSize: 14 },

  scaleRow10: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'space-between' },
  scaleBtn10: {
    flexBasis: '18%', minWidth: 50, aspectRatio: 1,
    borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceGlass,
  },
  scaleBtn10Active: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  scaleBtnText10: { color: colors.text, fontSize: 16, fontWeight: '900' },
  scaleBtnTextActive10: { color: colors.bg },
});
