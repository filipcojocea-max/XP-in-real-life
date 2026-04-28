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
  SleepRoutineItem,
} from '../../src/api';
import {
  fetchSleepWeek,
  requestPermissions as requestHealthConnectPermissions,
  openHealthConnectSettings,
  HealthConnectAvailability,
  SleepWeekStats,
  RawSleepSession,
  buildLastNightDetail,
  LastNightDetail,
  classifySleepAnimal,
  SleepAnimal,
  computeAchievements,
  Achievement,
} from '../../src/healthConnect';
import { colors, spacing, radii } from '../../src/theme';

type SubTab = 'plan' | 'coach' | 'health';

export default function SleepHub() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<SleepProfile | null>(null);
  const [showCheckin, setShowCheckin] = useState(false);
  const [showCheckinBanner, setShowCheckinBanner] = useState(false);
  const [tab, setTab] = useState<SubTab>('plan');

  const load = useCallback(async () => {
    try {
      const r = await api.sleepProfile();
      if (!r.onboarded) {
        router.replace('/sleep/onboarding' as any);
        return;
      }
      setProfile(r.profile || null);
      // "How was your sleep?" — persistent in-app banner (NOT auto-modal).
      // Only shown when backend says the check-in window is active AND the
      // user hasn't logged their sleep for the current sleep-cycle day.
      setShowCheckinBanner(!!r.show_checkin_prompt);
      setShowCheckin(false);
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

      {/* Persistent "How was your sleep?" banner — stays until user rates sleep */}
      {showCheckinBanner ? (
        <TouchableOpacity
          activeOpacity={0.88}
          onPress={() => setShowCheckin(true)}
          style={styles.sleepBanner}
          testID="sleep-checkin-banner"
        >
          <View style={styles.sleepBannerIcon}>
            <Ionicons name="moon" size={20} color={colors.cyan} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.sleepBannerTitle}>How was your sleep last night?</Text>
            <Text style={styles.sleepBannerSub}>Tap to rate — this card stays here until you do.</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.cyan} />
        </TouchableOpacity>
      ) : null}

      {/* Sub-tabs */}
      <View style={styles.subTabs}>
        <SubTabBtn active={tab === 'plan'} icon="sparkles" label="Plan" onPress={() => setTab('plan')} testID="sleep-tab-plan" />
        <SubTabBtn active={tab === 'coach'} icon="chatbubbles" label="Coach" onPress={() => setTab('coach')} testID="sleep-tab-coach" />
        <SubTabBtn active={tab === 'health'} icon="pulse" label="Sleep Data" onPress={() => setTab('health')} testID="sleep-tab-health" />
      </View>

      {tab === 'plan' && <PlanTab profile={profile} onChanged={load} />}
      {tab === 'coach' && <CoachTab profile={profile} />}
      {tab === 'health' && <HealthTab />}

      {/* Daily check-in modal (only opens when user taps the banner) */}
      <CheckinModal
        visible={showCheckin}
        onClose={() => setShowCheckin(false)}
        onSaved={() => { setShowCheckin(false); setShowCheckinBanner(false); load(); }}
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
// REAL DATA ONLY. We never show fabricated/mock numbers. If Samsung Health
// data isn't available we show a clear empty state explaining how to connect.
function HealthTab() {
  const [hcStats, setHcStats] = useState<SleepWeekStats | null>(null);
  const [hcAvailability, setHcAvailability] = useState<HealthConnectAvailability>('unsupported_platform');
  const [hcGranted, setHcGranted] = useState(false);
  const [lastNight, setLastNight] = useState<LastNightDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchSleepWeek();
      setHcAvailability(r.availability);
      setHcGranted(r.granted);
      setHcStats(r.stats);
      // For the hero "last night" detail, pick the most recent session
      if (r.stats && r.stats.sessions.length > 0) {
        const newest = r.stats.sessions
          .slice()
          .sort((a: RawSleepSession, b: RawSleepSession) => +new Date(b.startTime) - +new Date(a.startTime))[0];
        const detail = await buildLastNightDetail(newest, r.stats.sessions);
        setLastNight(detail);
      } else {
        setLastNight(null);
      }
    } catch (e) {
      console.log('health tab load', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const onConnect = async () => {
    setConnecting(true);
    try {
      const ok = await requestHealthConnectPermissions();
      if (ok) await loadAll();
      else Alert.alert(
        'Permission needed',
        'Open Health Connect → "App permissions" → "XP in Real Life" and grant access to Sleep, Steps, Heart rate and Oxygen saturation.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Health Connect', onPress: () => { openHealthConnectSettings().catch(() => {}); } },
        ],
      );
    } catch (e: any) {
      Alert.alert(
        'Connection failed',
        String(e?.message || e) + '\n\nIf this keeps happening, open Health Connect and grant permissions manually.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Health Connect', onPress: () => { openHealthConnectSettings().catch(() => {}); } },
        ],
      );
    } finally {
      setConnecting(false);
    }
  };

  const onOpenHCSettings = () => {
    openHealthConnectSettings().catch(() => {
      Alert.alert('Could not open Health Connect', 'Please open Health Connect manually from your phone settings.');
    });
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={colors.cyan} /></View>;
  }

  // ── REAL DATA — render the Samsung-style dashboard ───────────────────
  if (hcAvailability === 'available' && hcGranted && hcStats && lastNight) {
    return <SamsungSleepDashboard stats={hcStats} lastNight={lastNight} onRefresh={loadAll} />;
  }

  // ── EMPTY STATE: needs connection ────────────────────────────────────
  return <SleepEmptyState
    availability={hcAvailability}
    connecting={connecting}
    onConnect={onConnect}
    onOpenSettings={onOpenHCSettings}
  />;
}

// ── Empty state component (no data available yet) ────────────────────────
function SleepEmptyState({
  availability,
  connecting,
  onConnect,
  onOpenSettings,
}: {
  availability: HealthConnectAvailability;
  connecting: boolean;
  onConnect: () => void;
  onOpenSettings: () => void;
}) {
  // Pick title/message/cta per state
  let title = 'Connect Samsung Health';
  let desc =
    "Pull your real sleep records — sleep score, timeline, stages, heart rate, SpO₂, achievements and your sleep animal — directly from Samsung Health on this phone.";
  let icon: any = 'pulse';
  let iconColor = colors.cyan;
  let primary = (
    <TouchableOpacity
      testID="hc-connect-btn"
      disabled={connecting}
      style={[styles.connectBtn, connecting && { opacity: 0.6 }]}
      onPress={onConnect}
    >
      {connecting ? <ActivityIndicator color={colors.bg} /> : (
        <>
          <Ionicons name="link" size={18} color={colors.bg} />
          <Text style={styles.connectBtnText}>Connect Samsung Health</Text>
        </>
      )}
    </TouchableOpacity>
  );

  if (availability === 'not_installed' || availability === 'update_required') {
    title = availability === 'update_required' ? 'Update Health Connect' : 'Install Health Connect';
    desc = availability === 'update_required'
      ? 'Your Health Connect app is out of date. Update it from the Play Store, then come back.'
      : "Samsung Health on Android 14+ talks to apps through Google's free Health Connect. Install it to share your sleep data with this app.";
    icon = 'cloud-download';
    iconColor = colors.amber;
    primary = (
      <TouchableOpacity
        style={styles.connectBtn}
        onPress={() => {
          const url = 'https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata';
          try { require('expo-linking').openURL(url); }
          catch { Alert.alert('Open Play Store', url); }
        }}
      >
        <Ionicons name="logo-google-playstore" size={18} color={colors.bg} />
        <Text style={styles.connectBtnText}>Open Play Store</Text>
      </TouchableOpacity>
    );
  }

  if (availability === 'unsupported_platform' || availability === 'expo_go_unsupported') {
    title = Platform.OS === 'ios' ? 'Apple HealthKit coming next' : 'Open this on your Android phone';
    desc = Platform.OS === 'ios'
      ? "Reading sleep data on iPhone needs Apple HealthKit. We'll add it next."
      : Platform.OS === 'android'
        ? "Real Samsung Health data needs a custom Android dev build. Run `expo prebuild + expo run:android` on a phone with Samsung Health installed."
        : "Sleep tracking needs a phone with Samsung Health (Android) or Apple HealthKit (iOS). The web preview can't read your real data.";
    icon = 'phone-portrait';
    iconColor = colors.amber;
    primary = (
      <View style={[styles.connectBtn, { backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border }]}>
        <Ionicons name="lock-closed" size={16} color={colors.textMuted} />
        <Text style={[styles.connectBtnText, { color: colors.textSecondary }]}>Phone-only feature</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.connectHero}>
        <View style={[styles.connectIconWrap, { backgroundColor: iconColor + '22', borderColor: iconColor + '55' }]}>
          <Ionicons name={icon} size={28} color={iconColor} />
        </View>
        <Text style={styles.connectTitleBig}>{title}</Text>
        <Text style={styles.connectDescBig}>{desc}</Text>
        {primary}
        {availability === 'available' ? (
          <>
            <TouchableOpacity
              testID="hc-open-settings-btn"
              onPress={onOpenSettings}
              style={styles.connectSecondaryBtn}
              activeOpacity={0.85}
            >
              <Ionicons name="settings-outline" size={16} color={colors.cyan} />
              <Text style={styles.connectSecondaryBtnText}>
                Open Health Connect settings
              </Text>
            </TouchableOpacity>
            <Text style={styles.connectFootnote}>
              Read-only access. We never write data. You can revoke at any time from Health Connect settings.
            </Text>
          </>
        ) : null}
      </View>

      {/* Preview of what they'll get when connected */}
      <Text style={styles.previewLabel}>WHEN CONNECTED YOU'LL SEE</Text>
      <View style={styles.previewGrid}>
        {[
          { i: 'speedometer', t: 'Sleep score',         d: '0–100, with 5 sub-factors' },
          { i: 'analytics',   t: 'Sleep timeline',      d: 'Stages over the night' },
          { i: 'layers',      t: 'Sleep stages',        d: 'Deep / REM / Light / Awake' },
          { i: 'heart',       t: 'Heart rate & SpO₂',   d: 'Avg, min and max' },
          { i: 'paw',         t: 'Sleep animal',        d: 'Discover your archetype' },
          { i: 'trophy',      t: 'Achievement badges',  d: 'Unlock streaks & milestones' },
        ].map((p) => (
          <View key={p.t} style={styles.previewCard}>
            <View style={[styles.previewIcon, { backgroundColor: colors.cyan + '22', borderColor: colors.cyan + '55' }]}>
              <Ionicons name={p.i as any} size={18} color={colors.cyan} />
            </View>
            <Text style={styles.previewTitle}>{p.t}</Text>
            <Text style={styles.previewDesc}>{p.d}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ── Real Samsung-Health-style dashboard ──────────────────────────────────
function SamsungSleepDashboard({
  stats, lastNight, onRefresh,
}: { stats: SleepWeekStats; lastNight: LastNightDetail; onRefresh: () => void }) {
  const sourceLabel =
    lastNight.session.source?.replace('com.samsung.android.app.', 'Samsung ') || 'Samsung Health';
  const animal: SleepAnimal = useMemoSafe(() => classifySleepAnimal(stats.sessions), [stats.sessions]);
  const achievements: Achievement[] = useMemoSafe(() => computeAchievements(stats.sessions), [stats.sessions]);
  const factors = lastNight.factors;
  const totalH = (lastNight.session.total_minutes / 60).toFixed(1);
  const startStr = new Date(lastNight.session.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endStr = new Date(lastNight.session.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = new Date(lastNight.session.startTime).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });

  // 7-day chart
  const days = stats.sessions.map((s) => {
    const d = new Date(s.startTime);
    return {
      day: d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3),
      hours: +(s.total_minutes / 60).toFixed(1),
    };
  });
  const maxH = Math.max(...days.map((d) => d.hours), 1);

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={[styles.connectBanner, { backgroundColor: colors.green + '15', borderColor: colors.green + '55' }]}>
        <View style={[styles.connectIconWrap, { backgroundColor: colors.green + '22', borderColor: colors.green + '55' }]}>
          <Ionicons name="checkmark-circle" size={18} color={colors.green} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.connectTitle, { color: colors.green }]}>Live from {sourceLabel}</Text>
          <Text style={styles.connectDesc}>{stats.sessions.length} sessions · last 7 days</Text>
        </View>
        <TouchableOpacity onPress={onRefresh} style={{ padding: 8 }} testID="hc-refresh">
          <Ionicons name="refresh" size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* HERO — last-night sleep score (Samsung-style) */}
      <View style={styles.heroCard}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
          <Text style={styles.heroDate}>{dateStr}</Text>
          <Text style={styles.heroTime}>· {startStr} → {endStr}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 12 }}>
          <ScoreCircle value={factors.total_score} />
          <View style={{ flex: 1 }}>
            <Text style={styles.heroTotalH}>{totalH}h</Text>
            <Text style={styles.heroSub}>Time asleep</Text>
            <View style={styles.heroChips}>
              <Chip icon="bed" label={`${lastNight.efficiency}% efficient`} color={colors.cyan} />
              <Chip icon="alert-circle" label={`${lastNight.awakenings} awakening${lastNight.awakenings === 1 ? '' : 's'}`} color={colors.amber} />
            </View>
          </View>
        </View>
      </View>

      {/* SLEEP TIMELINE — visual stage strip */}
      <Text style={styles.sectionTitle}>Sleep timeline</Text>
      <View style={styles.timelineCard}>
        <SleepTimeline session={lastNight.session} />
        <View style={styles.timelineLabels}>
          <Text style={styles.timelineTime}>{startStr}</Text>
          <Text style={styles.timelineTime}>{endStr}</Text>
        </View>
        <View style={styles.legendRow}>
          <LegendDot color={colors.danger}        label="Awake" />
          <LegendDot color={colors.textSecondary} label="Light" />
          <LegendDot color={colors.cyan}          label="Deep" />
          <LegendDot color={colors.amber}         label="REM" />
        </View>
      </View>

      {/* SLEEP STAGES DETAIL */}
      <Text style={styles.sectionTitle}>Sleep stages</Text>
      <View style={styles.stagesCard}>
        <StageRow label="Deep"  color={colors.cyan}          mins={minutesIn(lastNight.session, 'deep')}  total={lastNight.session.total_minutes} />
        <StageRow label="REM"   color={colors.amber}         mins={minutesIn(lastNight.session, 'rem')}   total={lastNight.session.total_minutes} />
        <StageRow label="Light" color={colors.textSecondary} mins={minutesIn(lastNight.session, 'light') + minutesIn(lastNight.session, 'sleeping')} total={lastNight.session.total_minutes} />
        <StageRow label="Awake" color={colors.danger}        mins={minutesIn(lastNight.session, 'awake')} total={lastNight.session.total_minutes} />
      </View>

      {/* SLEEP SCORE FACTORS */}
      <Text style={styles.sectionTitle}>Sleep score factors</Text>
      <View style={styles.factorsCard}>
        <FactorBar label="Total time"        value={factors.duration} />
        <FactorBar label="Sleep cycle"       value={factors.consistency} />
        <FactorBar label="Awakenings"        value={factors.awakenings} />
        <FactorBar label="Physical recovery" value={factors.physical_recovery} />
        <FactorBar label="Mental recovery"   value={factors.mental_recovery} />
      </View>

      {/* HEART & BLOOD OXYGEN */}
      <Text style={styles.sectionTitle}>Heart & blood oxygen</Text>
      <View style={styles.statRow}>
        <View style={[styles.statCard, { borderColor: colors.danger + '55' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="heart" size={14} color={colors.danger} />
            <Text style={[styles.statLabel, { color: colors.danger }]}>HEART RATE</Text>
          </View>
          <Text style={styles.statValue}>{lastNight.hr.avg || '—'}<Text style={styles.statUnit}>{lastNight.hr.avg ? ' bpm' : ''}</Text></Text>
          <Text style={styles.statSub}>{lastNight.hr.avg ? `min ${lastNight.hr.min} · max ${lastNight.hr.max}` : 'No data this night'}</Text>
        </View>
        <View style={[styles.statCard, { borderColor: colors.cyan + '55' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="water" size={14} color={colors.cyan} />
            <Text style={[styles.statLabel, { color: colors.cyan }]}>BLOOD O₂ (SpO₂)</Text>
          </View>
          <Text style={styles.statValue}>{lastNight.spo2.avg || '—'}<Text style={styles.statUnit}>{lastNight.spo2.avg ? '%' : ''}</Text></Text>
          <Text style={styles.statSub}>{lastNight.spo2.avg ? `min ${lastNight.spo2.min}%` : 'No data this night'}</Text>
        </View>
      </View>

      {/* SLEEP ANIMAL */}
      <Text style={styles.sectionTitle}>Discover your sleep animal</Text>
      <View style={styles.animalCard}>
        <Text style={styles.animalEmoji}>{animal.emoji}</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.animalName}>{animal.name}</Text>
          <Text style={styles.animalTrait}>{animal.trait}</Text>
          <Text style={styles.animalDesc}>{animal.description}</Text>
        </View>
      </View>

      {/* ACHIEVEMENTS */}
      <Text style={styles.sectionTitle}>Achievements</Text>
      <View style={styles.badgesRow}>
        {achievements.map((a) => {
          const c = a.color === 'green' ? colors.green : a.color === 'cyan' ? colors.cyan : a.color === 'amber' ? colors.amber : '#ff7eb6';
          return (
            <View key={a.key} style={[styles.badge, !a.unlocked && { opacity: 0.45 }]}>
              <View style={[styles.badgeIcon, { backgroundColor: c + '22', borderColor: c + '66' }]}>
                <Ionicons name={a.icon as any} size={20} color={c} />
                {!a.unlocked ? (
                  <View style={styles.lockOverlay}>
                    <Ionicons name="lock-closed" size={11} color={colors.textMuted} />
                  </View>
                ) : null}
              </View>
              <Text style={styles.badgeName}>{a.name}</Text>
              <Text style={styles.badgeDesc}>{a.description}</Text>
            </View>
          );
        })}
      </View>

      {/* 7-day weekly chart */}
      <Text style={styles.sectionTitle}>Last {days.length} nights</Text>
      <View style={styles.chartCard}>
        <View style={styles.chartRow}>
          {days.map((n, i) => {
            const h = (n.hours / maxH) * 130;
            const color = n.hours >= 7 ? colors.green : n.hours >= 6 ? colors.amber : colors.danger;
            return (
              <View key={i} style={styles.chartCol}>
                <Text style={styles.chartHours}>{n.hours}h</Text>
                <View style={styles.chartBarTrack}>
                  <View style={[styles.chartBar, { height: h, backgroundColor: color }]} />
                </View>
                <Text style={styles.chartDay}>{n.day}</Text>
              </View>
            );
          })}
        </View>
      </View>

      <Text style={styles.footnote}>Source: {sourceLabel} via Health Connect · Read-only</Text>
    </ScrollView>
  );
}

// ── Small UI primitives ────────────────────────────────────────────────
function ScoreCircle({ value }: { value: number }) {
  const color = value >= 80 ? colors.green : value >= 65 ? colors.amber : colors.danger;
  const label = value >= 80 ? 'Good' : value >= 65 ? 'Fair' : 'Poor';
  return (
    <View style={[styles.scoreCircle, { borderColor: color }]}>
      <Text style={[styles.scoreValue, { color }]}>{value}</Text>
      <Text style={[styles.scoreLabel, { color }]}>{label}</Text>
    </View>
  );
}

function Chip({ icon, label, color }: { icon: any; label: string; color: string }) {
  return (
    <View style={[styles.chipPill, { borderColor: color + '55', backgroundColor: color + '15' }]}>
      <Ionicons name={icon} size={11} color={color} />
      <Text style={[styles.chipPillText, { color }]}>{label}</Text>
    </View>
  );
}

function SleepTimeline({ session }: { session: RawSleepSession }) {
  const total = Math.max(1, session.total_minutes);
  return (
    <View style={styles.timelineTrack}>
      {session.stages.map((st, idx) => {
        const w = (st.duration_minutes / total) * 100;
        const color =
          st.stage === 'awake' ? colors.danger :
          st.stage === 'deep' ? colors.cyan :
          st.stage === 'rem' ? colors.amber :
          colors.textSecondary;
        const top =
          st.stage === 'awake' ? 0 :
          st.stage === 'rem'   ? 6 :
          st.stage === 'light' || st.stage === 'sleeping' ? 18 :
          st.stage === 'deep'  ? 30 : 18;
        return (
          <View key={idx} style={{ width: `${w}%`, height: '100%', justifyContent: 'flex-start' }}>
            <View style={{ position: 'absolute', top, left: 0, right: 0, height: 14, backgroundColor: color, borderRadius: 3 }} />
          </View>
        );
      })}
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

function StageRow({ label, color, mins, total }: { label: string; color: string; mins: number; total: number }) {
  const pct = total > 0 ? Math.round((mins / total) * 100) : 0;
  const h = Math.floor(mins / 60), m = mins % 60;
  return (
    <View style={styles.stageRow}>
      <View style={[styles.stageDot, { backgroundColor: color }]} />
      <Text style={styles.stageLabel}>{label}</Text>
      <View style={styles.stageBarTrack}>
        <View style={[styles.stageBarFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.stageMin}>{h}h {m}m</Text>
      <Text style={styles.stagePct}>{pct}%</Text>
    </View>
  );
}

function FactorBar({ label, value }: { label: string; value: number }) {
  const c = value >= 80 ? colors.green : value >= 65 ? colors.amber : colors.danger;
  return (
    <View style={styles.factorRow}>
      <Text style={styles.factorLabel}>{label}</Text>
      <View style={styles.factorBarTrack}>
        <View style={[styles.factorBarFill, { width: `${value}%`, backgroundColor: c }]} />
      </View>
      <Text style={[styles.factorValue, { color: c }]}>{value}</Text>
    </View>
  );
}

function minutesIn(session: RawSleepSession, stage: string): number {
  return session.stages.filter((s) => s.stage === stage).reduce((a, s) => a + s.duration_minutes, 0);
}

// Helpful safe useMemo wrapper since we don't want to introduce noise on
// a top-level import refactor — call the function inline if React 18+ memo is
// not friendly for some reason.
function useMemoSafe<T>(fn: () => T, deps: any[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(fn, deps);
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
  sleepBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.cyan + '18',
    borderWidth: 1,
    borderColor: colors.cyan + '88',
  },
  sleepBannerIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.cyan + '22',
    borderWidth: 1, borderColor: colors.cyan + '55',
  },
  sleepBannerTitle: { color: colors.cyan, fontWeight: '900', fontSize: 14 },
  sleepBannerSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
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
  connectHero: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  connectTitleBig: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  connectDescBig: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingHorizontal: spacing.sm,
  },
  connectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.cyan,
    borderRadius: radii.pill,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    minWidth: 220,
  },
  connectBtnText: {
    color: colors.bg,
    fontWeight: '900',
    fontSize: 14,
    letterSpacing: 0.3,
  },
  connectSecondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    marginTop: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.cyan + '55',
    backgroundColor: colors.cyan + '12',
  },
  connectSecondaryBtnText: {
    color: colors.cyan,
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.2,
  },
  connectFootnote: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 16,
    paddingHorizontal: spacing.sm,
  },
  // ── Samsung-style dashboard ──────────────────────────────────────────
  heroCard: {
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  heroDate: { color: colors.text, fontSize: 14, fontWeight: '900', letterSpacing: -0.3 },
  heroTime: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  heroTotalH: { color: colors.text, fontSize: 32, fontWeight: '900', letterSpacing: -1 },
  heroSub: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  heroChips: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  scoreCircle: {
    width: 110, height: 110, borderRadius: 55, borderWidth: 6,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  scoreValue: { fontSize: 36, fontWeight: '900', letterSpacing: -1 },
  scoreLabel: { fontSize: 10, fontWeight: '900', letterSpacing: 2, marginTop: -2 },
  chipPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderRadius: radii.pill, borderWidth: 1,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  chipPillText: { fontSize: 11, fontWeight: '800' },

  timelineCard: {
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  timelineTrack: {
    height: 56,
    backgroundColor: colors.bg,
    borderRadius: 6,
    flexDirection: 'row',
    overflow: 'hidden',
    position: 'relative',
  },
  timelineLabels: {
    flexDirection: 'row', justifyContent: 'space-between', marginTop: 6,
  },
  timelineTime: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  legendRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 14,
    marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border,
  },
  legendText: { color: colors.textSecondary, fontSize: 11, fontWeight: '700' },

  stagesCard: {
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: 12,
  },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stageDot: { width: 10, height: 10, borderRadius: 5 },
  stageLabel: { color: colors.text, fontSize: 13, fontWeight: '800', width: 56 },
  stageBarTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  stageBarFill: { height: '100%', borderRadius: 4 },
  stageMin: { color: colors.text, fontSize: 12, fontWeight: '800', width: 56, textAlign: 'right' },
  stagePct: { color: colors.textMuted, fontSize: 11, fontWeight: '800', width: 36, textAlign: 'right' },

  factorsCard: {
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: 10,
  },
  factorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  factorLabel: { color: colors.text, fontSize: 12, fontWeight: '800', width: 130 },
  factorBarTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' },
  factorBarFill: { height: '100%', borderRadius: 3 },
  factorValue: { fontSize: 12, fontWeight: '900', width: 28, textAlign: 'right' },

  animalCard: {
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.cyan + '55',
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  animalEmoji: { fontSize: 56 },
  animalName: { color: colors.cyan, fontSize: 16, fontWeight: '900', letterSpacing: -0.3 },
  animalTrait: { color: colors.amber, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 2 },
  animalDesc: { color: colors.textSecondary, fontSize: 12, marginTop: 6, lineHeight: 17 },

  badgesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  badge: { width: '31%', alignItems: 'center', paddingVertical: 8 },
  badgeIcon: {
    width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, marginBottom: 6, position: 'relative',
  },
  lockOverlay: {
    position: 'absolute', right: -2, bottom: -2,
    backgroundColor: colors.bg, borderRadius: 8, padding: 2,
    borderWidth: 1, borderColor: colors.border,
  },
  badgeName: { color: colors.text, fontSize: 11, fontWeight: '800', textAlign: 'center' },
  badgeDesc: { color: colors.textMuted, fontSize: 9, fontWeight: '700', textAlign: 'center', marginTop: 2 },

  previewLabel: {
    color: colors.textMuted, fontSize: 10, fontWeight: '900',
    letterSpacing: 1.6, textAlign: 'center', marginTop: spacing.lg, marginBottom: spacing.sm,
  },
  previewGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  previewCard: {
    width: '47%',
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.sm,
  },
  previewIcon: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, marginBottom: 6,
  },
  previewTitle: { color: colors.text, fontSize: 12, fontWeight: '800' },
  previewDesc: { color: colors.textMuted, fontSize: 11, marginTop: 2 },

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
