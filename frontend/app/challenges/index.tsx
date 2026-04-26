import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  Pressable,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import {
  api,
  ChallengeTodayResp,
  ChallengeCompletion,
  ChallengeStatus,
} from '../../src/api';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';

export default function ChallengesScreen() {
  const [today, setToday] = useState<ChallengeTodayResp | null>(null);
  const [past, setPast] = useState<ChallengeCompletion[]>([]);
  const [loading, setLoading] = useState(true);
  const [showChallengeModal, setShowChallengeModal] = useState(false);
  const [showReflectModal, setShowReflectModal] = useState(false);
  const [acting, setActing] = useState(false);
  const [now, setNow] = useState<Date>(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, p] = await Promise.all([api.challengeToday(), api.challengePast()]);
      setToday(t);
      setPast(p.completions);
    } catch (e: any) {
      showAlert('Could not load challenges', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Live ticker for the time display
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  const onReady = () => {
    setShowChallengeModal(true);
  };

  const onAccept = async () => {
    setActing(true);
    try {
      await api.challengeAccept();
      setShowChallengeModal(false);
      await load();
    } catch (e: any) {
      showAlert('Failed', String(e?.message || e));
    } finally {
      setActing(false);
    }
  };

  const onReject = async () => {
    setActing(true);
    try {
      await api.challengeReject();
      setShowChallengeModal(false);
      await load();
    } catch (e: any) {
      showAlert('Failed', String(e?.message || e));
    } finally {
      setActing(false);
    }
  };

  if (loading || !today) {
    return (
      <View style={[styles.safe, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.cyan} />
      </View>
    );
  }

  const status = today.status;
  const ch = today.challenge;
  const dateStr = formatDate(now);
  const timeStr = formatTime(now);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Challenge Tasks</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Date / Time / Greeting / Quote */}
        <View style={styles.heroBg}>
          <View style={styles.heroDateRow}>
            <Text style={styles.heroDate}>{dateStr}</Text>
            <Text style={styles.heroTime}>{timeStr}</Text>
          </View>
          <Text style={styles.heroGreeting}>{today.greeting} 👋</Text>
          <View style={styles.quoteCard}>
            <Ionicons name="sparkles" size={14} color={colors.amber} />
            <Text style={styles.quoteText}>"{today.quote.text}"</Text>
            <Text style={styles.quoteAuthor}>— {today.quote.author}</Text>
          </View>

          {/* Main state-driven content */}
          {status === 'ready' ? (
            <View style={{ alignItems: 'center', marginTop: spacing.xl }}>
              <Text style={styles.readyBig}>Ready?</Text>
              <Text style={styles.readyHint}>Today's challenge is waiting for you.</Text>
              <TouchableOpacity testID="challenge-ready-btn" style={styles.readyBtn} onPress={onReady}>
                <Ionicons name="flash" size={18} color={colors.bg} />
                <Text style={styles.readyBtnText}>Ready</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {status === 'rejected' ? (
            <View style={{ alignItems: 'center', marginTop: spacing.xl }}>
              <View style={[styles.stamp, { borderColor: colors.danger, transform: [{ rotate: '-6deg' }] }]}>
                <Text style={[styles.stampText, { color: colors.danger }]}>CHALLENGE REJECTED</Text>
              </View>
              <Text style={styles.rejectedHint}>
                Come back tomorrow for a new challenge — or change your mind:
              </Text>
              <TouchableOpacity style={styles.readyBtn} onPress={onReady}>
                <Ionicons name="refresh" size={18} color={colors.bg} />
                <Text style={styles.readyBtnText}>Reconsider</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {status === 'accepted' || status === 'completed' ? (
            <View style={{ marginTop: spacing.lg }}>
              <View style={styles.challengeCard}>
                <View style={styles.challengeHead}>
                  <View style={[styles.challengeIconBubble, { backgroundColor: colors.cyan + '22', borderColor: colors.cyan + '55' }]}>
                    <Ionicons name={ch.icon as any} size={20} color={colors.cyan} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.challengeTitle}>{ch.title}</Text>
                    {ch.tagline ? <Text style={styles.challengeTagline}>{ch.tagline}</Text> : null}
                  </View>
                </View>
                <Text style={styles.challengeDesc}>{ch.description}</Text>

                <View style={[styles.stamp, { alignSelf: 'center', marginTop: spacing.md, transform: [{ rotate: '-4deg' }] }]}>
                  <Ionicons name="checkmark-circle" size={14} color={colors.green} />
                  <Text style={[styles.stampText, { color: colors.green }]}>
                    {status === 'completed' ? 'CHALLENGE COMPLETED' : 'CHALLENGE ACCEPTED'}
                  </Text>
                </View>

                {status === 'accepted' ? (
                  <TouchableOpacity
                    testID="challenge-complete-btn"
                    style={styles.completeBtn}
                    onPress={() => setShowReflectModal(true)}
                  >
                    <Ionicons name="trophy" size={18} color={colors.bg} />
                    <Text style={styles.completeBtnText}>Challenge Completed Successfully</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.completedNote}>
                    <Ionicons name="time" size={14} color={colors.textMuted} />
                    <Text style={styles.completedNoteText}>
                      Come back tomorrow for a new challenge.
                    </Text>
                  </View>
                )}
              </View>
            </View>
          ) : null}
        </View>

        {/* Past challenges */}
        <Text style={styles.sectionTitle}>Past Completed Challenges</Text>
        {past.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="trophy-outline" size={32} color={colors.textMuted} />
            <Text style={styles.emptyText}>
              You haven't completed any challenges yet. Today's a great day to start.
            </Text>
          </View>
        ) : (
          past.map((c) => <PastChallengeCard key={c.id} c={c} onDelete={async () => {
            await api.challengePastDelete(c.id);
            await load();
          }} />)
        )}
        <View style={{ height: spacing.xl }} />
      </ScrollView>

      {/* ── Challenge full-screen view ──────────────────────────── */}
      <Modal visible={showChallengeModal} animationType="slide" onRequestClose={() => setShowChallengeModal(false)}>
        <SafeAreaView style={styles.fullScreen} testID="challenge-popup">
          {/* Top bar with close */}
          <View style={styles.fsHeader}>
            <TouchableOpacity onPress={() => setShowChallengeModal(false)} style={styles.fsCloseBtn} testID="challenge-popup-close">
              <Ionicons name="close" size={26} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.fsHeaderTitle}>Today's Challenge</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView contentContainerStyle={styles.fsScroll} showsVerticalScrollIndicator={false}>
            {/* Big icon */}
            <View style={styles.fsIconWrap}>
              <View style={styles.fsIconGlow} />
              <View style={styles.fsIconBubble}>
                <Ionicons name={ch.icon as any} size={56} color={colors.cyan} />
              </View>
            </View>

            {/* Tagline kicker */}
            {ch.tagline ? (
              <Text style={styles.fsKicker}>{ch.tagline.toUpperCase()}</Text>
            ) : null}

            {/* HUGE Title */}
            <Text style={styles.fsTitle}>{ch.title}</Text>

            {/* Big description */}
            <View style={styles.fsDescCard}>
              <Text style={styles.fsDesc}>{ch.description}</Text>
            </View>

            {/* XP hint */}
            <View style={styles.fsXpHint}>
              <Ionicons name="flash" size={16} color={colors.amber} />
              <Text style={styles.fsXpHintText}>Earn up to 60 XP for completing this challenge</Text>
            </View>
          </ScrollView>

          {/* Bottom action bar (sticky) */}
          <View style={styles.fsActions}>
            <TouchableOpacity
              testID="challenge-accept-btn"
              style={[styles.fsAcceptBtn, acting && { opacity: 0.6 }]}
              disabled={acting}
              onPress={onAccept}
              activeOpacity={0.85}
            >
              {acting ? <ActivityIndicator color={colors.bg} /> : (
                <>
                  <Ionicons name="checkmark-circle" size={22} color={colors.bg} />
                  <Text style={styles.fsAcceptBtnText}>Challenge Accepted!</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              testID="challenge-reject-btn"
              style={styles.fsRejectBtn}
              disabled={acting}
              onPress={onReject}
              activeOpacity={0.7}
            >
              <Text style={styles.fsRejectBtnText}>Challenge Rejected</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      {/* ── Reflection / completion form ───────────────────────── */}
      <ReflectModal
        visible={showReflectModal}
        onClose={() => setShowReflectModal(false)}
        onDone={async () => {
          setShowReflectModal(false);
          await load();
        }}
      />
    </SafeAreaView>
  );
}

// ── Past-challenge card with view-more ─────────────────────────────────
function PastChallengeCard({ c, onDelete }: { c: ChallengeCompletion; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const dateStr = new Date(c.completed_at).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  const isUncompleted = !!c.auto_uncompleted;
  const accent = isUncompleted ? colors.danger : colors.cyan;
  return (
    <View style={[styles.pastCard, isUncompleted && { borderColor: colors.danger + '55' }]}>
      <TouchableOpacity style={styles.pastHead} onPress={() => setOpen(!open)} activeOpacity={0.7}>
        <View style={[styles.challengeIconBubble, { backgroundColor: accent + '22', borderColor: accent + '55' }]}>
          <Ionicons
            name={(isUncompleted ? 'close-circle' : c.challenge_icon) as any}
            size={16}
            color={accent}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.pastTitle} numberOfLines={1}>{c.challenge_title}</Text>
          <Text style={styles.pastSub} numberOfLines={1}>
            {dateStr}{c.challenge_tagline ? ` · ${c.challenge_tagline}` : ''}
          </Text>
        </View>
        {isUncompleted ? (
          <View style={styles.uncompletedPill} testID="past-uncompleted-pill">
            <Ionicons name="close" size={11} color={colors.danger} />
            <Text style={styles.uncompletedPillText}>UNCOMPLETED</Text>
          </View>
        ) : (
          <View style={[styles.xpPill, { backgroundColor: colors.amber + '22', borderColor: colors.amber + '55' }]}>
            <Ionicons name="flash" size={11} color={colors.amber} />
            <Text style={styles.xpPillText}>+{c.xp_awarded}</Text>
          </View>
        )}
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {!open ? (
        <TouchableOpacity style={styles.viewMoreBtn} onPress={() => setOpen(true)}>
          <Text style={styles.viewMoreText}>View more</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.pastBody}>
          <Text style={styles.pastDesc}>{c.challenge_description}</Text>

          <View style={styles.pastDivider} />

          {isUncompleted ? (
            <View style={styles.uncompletedNotice}>
              <Ionicons name="time" size={14} color={colors.danger} />
              <Text style={styles.uncompletedNoticeText}>
                The 24-hour window expired before this challenge was completed.
              </Text>
            </View>
          ) : (
            <>
              <PastField label="Did you complete it?" value={c.completed ? 'Yes' : 'No'} icon="checkmark-circle" color={c.completed ? colors.green : colors.danger} />
              <PastField label="How was it?" value={c.how_text || '—'} multi />
              <PastField label="Difficulty" value={c.difficulty === 'difficult' ? 'Difficult' : 'Easy'} icon="flash" color={c.difficulty === 'difficult' ? colors.amber : colors.cyan} />
              <PastField label="Your experience" value={c.experience_text || '—'} multi />

              <View style={styles.ratingRow}>
                <Text style={styles.pastFieldLabel}>Rating</Text>
                <View style={{ flexDirection: 'row', gap: 2 }}>
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Ionicons key={s} name={s <= c.rating ? 'star' : 'star-outline'} size={16} color={colors.amber} />
                  ))}
                </View>
              </View>
            </>
          )}

          <TouchableOpacity style={styles.deleteBtn} onPress={onDelete}>
            <Ionicons name="trash" size={14} color={colors.danger} />
            <Text style={styles.deleteText}>Delete entry</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function PastField({ label, value, icon, color, multi = false }: { label: string; value: string; icon?: any; color?: string; multi?: boolean }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={styles.pastFieldLabel}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
        {icon ? <Ionicons name={icon} size={13} color={color || colors.textSecondary} /> : null}
        <Text style={[styles.pastFieldValue, multi && { lineHeight: 18 }, color && !multi ? { color } : null]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

// ── Reflection modal ────────────────────────────────────────────────
function ReflectModal({
  visible, onClose, onDone,
}: { visible: boolean; onClose: () => void; onDone: () => void }) {
  const [completed, setCompleted] = useState<'yes' | 'no'>('yes');
  const [howText, setHowText] = useState('');
  const [difficulty, setDifficulty] = useState<'easy' | 'difficult'>('easy');
  const [experience, setExperience] = useState('');
  const [rating, setRating] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState(0); // 0 form, 1 success
  const [awarded, setAwarded] = useState(0);

  useEffect(() => {
    if (visible) {
      setCompleted('yes');
      setHowText('');
      setDifficulty('easy');
      setExperience('');
      setRating(5);
      setStep(0);
      setAwarded(0);
    }
  }, [visible]);

  const submit = async () => {
    setSubmitting(true);
    try {
      const r = await api.challengeComplete({
        completed: completed === 'yes',
        how_text: howText,
        difficulty,
        experience_text: experience,
        rating,
      });
      setAwarded(r.awarded_xp);
      setStep(1);
    } catch (e: any) {
      showAlert('Could not submit', String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <ScrollView
          style={{ maxHeight: '92%' }}
          contentContainerStyle={styles.popup}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          testID="reflect-modal"
        >
          <View style={styles.popupHandle} />

          {step === 0 ? (
            <>
              <Text style={styles.popupTitle}>How did it go?</Text>
              <Text style={styles.popupTagline}>Reflect on the challenge</Text>

              <Text style={styles.formLabel}>Did you complete the challenge?</Text>
              <View style={styles.choiceRow}>
                <ChoiceChip active={completed === 'yes'} label="Yes ✓" onPress={() => setCompleted('yes')} testID="reflect-completed-yes" />
                <ChoiceChip active={completed === 'no'}  label="No"    onPress={() => setCompleted('no')}  testID="reflect-completed-no" />
              </View>

              <Text style={styles.formLabel}>How was the challenge?</Text>
              <TextInput
                testID="reflect-how"
                placeholder="A few words about how it felt..."
                placeholderTextColor={colors.textMuted}
                style={[styles.formInput, { minHeight: 60 }]}
                multiline
                value={howText}
                onChangeText={setHowText}
              />

              <Text style={styles.formLabel}>Was it difficult?</Text>
              <View style={styles.choiceRow}>
                <ChoiceChip active={difficulty === 'easy'}      label="😌 Easy (30 XP)"        onPress={() => setDifficulty('easy')}      testID="reflect-difficulty-easy" />
                <ChoiceChip active={difficulty === 'difficult'} label="🔥 Difficult (60 XP)" onPress={() => setDifficulty('difficult')} testID="reflect-difficulty-difficult" />
              </View>

              <Text style={styles.formLabel}>Write down your experience</Text>
              <TextInput
                testID="reflect-experience"
                placeholder="What did you learn? How did it change your day?"
                placeholderTextColor={colors.textMuted}
                style={[styles.formInput, { minHeight: 90 }]}
                multiline
                value={experience}
                onChangeText={setExperience}
              />

              <Text style={styles.formLabel}>Did you like this challenge?</Text>
              <View style={styles.starsRow}>
                {[1, 2, 3, 4, 5].map((s) => (
                  <TouchableOpacity
                    key={s}
                    testID={`reflect-rating-${s}`}
                    onPress={() => setRating(s)}
                    style={styles.starBtn}
                  >
                    <Ionicons
                      name={s <= rating ? 'star' : 'star-outline'}
                      size={32}
                      color={colors.amber}
                    />
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity
                testID="reflect-submit"
                style={[styles.acceptBtn, submitting && { opacity: 0.6 }]}
                disabled={submitting}
                onPress={submit}
              >
                {submitting ? <ActivityIndicator color={colors.bg} /> : (
                  <>
                    <Ionicons name="checkmark-done" size={18} color={colors.bg} />
                    <Text style={styles.acceptBtnText}>Submit Reflection</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <View style={{ alignItems: 'center', paddingVertical: spacing.lg }}>
              <View style={[styles.popupIconRow]}>
                <View style={[styles.challengeIconBubble, { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.green + '22', borderColor: colors.green + '55' }]}>
                  <Ionicons name="trophy" size={32} color={colors.green} />
                </View>
              </View>
              <Text style={styles.successTitle}>Challenge Crushed! 🎉</Text>
              <Text style={[styles.popupDesc, { textAlign: 'center' }]}>
                You earned <Text style={{ color: colors.amber, fontWeight: '900' }}>+{awarded} XP</Text> for completing today's challenge.
              </Text>
              <TouchableOpacity style={styles.acceptBtn} onPress={onDone}>
                <Ionicons name="checkmark-circle" size={18} color={colors.bg} />
                <Text style={styles.acceptBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ChoiceChip({ active, label, onPress, testID }: { active: boolean; label: string; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      style={[
        styles.choiceChip,
        active ? { backgroundColor: colors.cyan, borderColor: colors.cyan } : null,
      ]}
    >
      <Text style={[styles.choiceChipText, active && { color: colors.bg }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── helpers ─────────────────────────────────────────────────────────
function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}
function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.3,
  },

  heroBg: {
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  heroDateRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  heroDate: { color: colors.text, fontSize: 14, fontWeight: '900' },
  heroTime: { color: colors.cyan, fontSize: 14, fontWeight: '900' },
  heroGreeting: { color: colors.textSecondary, fontSize: 13, marginTop: 4, fontWeight: '700' },

  quoteCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.bg,
    borderColor: colors.amber + '33',
    borderWidth: 1,
    gap: 4,
  },
  quoteText: {
    color: colors.text,
    fontSize: 14,
    fontStyle: 'italic',
    fontWeight: '700',
    lineHeight: 21,
    marginTop: 4,
  },
  quoteAuthor: { color: colors.amber, fontSize: 11, fontWeight: '900', letterSpacing: 0.5, marginTop: 6 },

  readyBig: {
    color: colors.text,
    fontSize: 56,
    fontWeight: '900',
    letterSpacing: -2,
    marginTop: spacing.md,
  },
  readyHint: { color: colors.textMuted, fontSize: 12, marginBottom: spacing.lg },
  readyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.green,
    paddingVertical: 14,
    paddingHorizontal: 36,
    borderRadius: radii.pill,
  },
  readyBtnText: { color: colors.bg, fontWeight: '900', fontSize: 16, letterSpacing: 0.4 },

  challengeCard: {
    backgroundColor: colors.bg,
    borderColor: colors.green + '55',
    borderWidth: 1.5,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  challengeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  challengeIconBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  challengeTitle: { color: colors.text, fontSize: 16, fontWeight: '900', letterSpacing: -0.3 },
  challengeTagline: { color: colors.cyan, fontSize: 11, fontWeight: '800', marginTop: 2 },
  challengeDesc: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 4 },

  stamp: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 2,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'transparent',
  },
  stampText: { fontSize: 12, fontWeight: '900', letterSpacing: 1.5 },
  rejectedHint: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: spacing.md, marginBottom: spacing.md, paddingHorizontal: spacing.md },

  completeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.green,
    paddingVertical: 13,
    borderRadius: radii.pill,
    marginTop: spacing.md,
  },
  completeBtnText: { color: colors.bg, fontWeight: '900', fontSize: 14 },
  completedNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.md,
  },
  completedNoteText: { color: colors.textMuted, fontSize: 12 },

  sectionTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  emptyCard: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radii.md,
    gap: 6,
  },
  emptyText: { color: colors.textMuted, fontSize: 12, textAlign: 'center', paddingHorizontal: spacing.md, lineHeight: 18 },

  pastCard: {
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    marginBottom: spacing.sm,
  },
  pastHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  pastTitle: { color: colors.text, fontSize: 14, fontWeight: '900' },
  pastSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  xpPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  xpPillText: { color: colors.amber, fontSize: 11, fontWeight: '900', letterSpacing: 0.3 },
  uncompletedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    backgroundColor: colors.danger + '15',
    borderColor: colors.danger + '55',
  },
  uncompletedPillText: {
    color: colors.danger,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  viewMoreBtn: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    paddingTop: 0,
  },
  viewMoreText: { color: colors.cyan, fontSize: 12, fontWeight: '800' },
  pastBody: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  pastDesc: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  pastDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  uncompletedNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.danger + '15',
    borderColor: colors.danger + '55',
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  uncompletedNoticeText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
  },
  pastFieldLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.4, textTransform: 'uppercase' },
  pastFieldValue: { color: colors.text, fontSize: 13, fontWeight: '700' },
  ratingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  deleteBtn: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing.md,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.danger + '15',
    borderWidth: 1,
    borderColor: colors.danger + '55',
  },
  deleteText: { color: colors.danger, fontSize: 11, fontWeight: '900' },

  // Modals
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },

  // ── Full-screen challenge view ──
  fullScreen: { flex: 1, backgroundColor: colors.bg },
  fsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  fsCloseBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fsHeaderTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  fsScroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl,
    alignItems: 'center',
  },
  fsIconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
    position: 'relative',
  },
  fsIconGlow: {
    position: 'absolute',
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: colors.cyan + '15',
  },
  fsIconBubble: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: colors.cyan + '22',
    borderWidth: 2,
    borderColor: colors.cyan + '99',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fsKicker: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 2.5,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  fsTitle: {
    color: colors.text,
    fontSize: 36,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -1,
    lineHeight: 42,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.sm,
  },
  fsDescCard: {
    width: '100%',
    backgroundColor: colors.surfaceGlass,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  fsDesc: {
    color: colors.text,
    fontSize: 18,
    lineHeight: 28,
    fontWeight: '600',
    textAlign: 'center',
  },
  fsXpHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: colors.amber + '15',
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.amber + '55',
  },
  fsXpHintText: {
    color: colors.amber,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  fsActions: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  fsAcceptBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.green,
    paddingVertical: 18,
    borderRadius: radii.pill,
  },
  fsAcceptBtnText: {
    color: colors.bg,
    fontWeight: '900',
    fontSize: 17,
    letterSpacing: 0.4,
  },
  fsRejectBtn: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  fsRejectBtnText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  popup: {
    backgroundColor: colors.surfaceGlass,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  popupHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: colors.textMuted, opacity: 0.4,
    alignSelf: 'center', marginBottom: spacing.md,
  },
  popupIconRow: { alignItems: 'center', marginBottom: spacing.sm },
  popupTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  popupTagline: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 4,
    letterSpacing: 0.3,
  },
  popupDesc: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 22,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  acceptBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.green,
    paddingVertical: 16,
    borderRadius: radii.pill,
    marginTop: spacing.md,
  },
  acceptBtnText: { color: colors.bg, fontWeight: '900', fontSize: 15, letterSpacing: 0.3 },
  rejectBtn: {
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 6,
  },
  rejectBtnText: { color: colors.textMuted, fontSize: 12, fontWeight: '800', textDecorationLine: 'underline' },

  // Reflection form
  formLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: spacing.md,
    marginBottom: 6,
  },
  formInput: {
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  choiceRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  choiceChip: {
    flex: 1,
    minWidth: 100,
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.cyan + '55',
    backgroundColor: 'transparent',
  },
  choiceChipText: { color: colors.cyan, fontSize: 13, fontWeight: '800' },
  starsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.md },
  starBtn: { padding: 4 },
  successTitle: {
    color: colors.green,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.5,
    marginTop: spacing.sm,
  },
});
