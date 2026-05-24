/**
 * Social Speaking — today's speaking challenge with tips + examples.
 * User marks as done → +15 XP. Completion is idempotent per day.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api, ConfidenceChallenge } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';
import * as Haptics from 'expo-haptics';

export default function SocialTrack() {
  const [challenge, setChallenge] = useState<ConfidenceChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.confidenceDaily();
      setChallenge(r.social);
    } catch (e: any) {
      showAlert('Could not load', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const markDone = async () => {
    if (!challenge || saving) return;
    setSaving(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      const r = await api.confidenceComplete('social');
      setChallenge({ ...challenge, done: true });
      if (!r.already_done && r.xp_awarded) {
        showAlert('Nice work', `+${r.xp_awarded} XP — see you tomorrow for a new challenge.`);
      }
    } catch (e: any) {
      showAlert('Could not save', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Social Speaking</Text>
        <View style={{ width: 32 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 80, gap: spacing.md }} showsVerticalScrollIndicator={false}>
        {loading || !challenge ? <ActivityIndicator color={colors.cyan} style={{ marginVertical: 40 }} /> : (
          <>
            <View style={styles.kickerRow}>
              <Ionicons name="chatbubbles" size={14} color={colors.cyan} />
              <Text style={styles.kicker}>TODAY'S CHALLENGE</Text>
            </View>
            <Text style={styles.challengeTitle}>{challenge.title}</Text>
            <Text style={styles.body}>{challenge.body}</Text>
            {challenge.tips?.length ? (
              <Section title="Tips" color={colors.cyan}>
                {challenge.tips.map((t, i) => <Bullet key={i} text={t} />)}
              </Section>
            ) : null}
            {challenge.examples?.length ? (
              <Section title="Say something like…" color={colors.green}>
                {challenge.examples.map((ex, i) => (
                  <View key={i} style={styles.exampleBubble}><Text style={styles.exampleText}>{ex}</Text></View>
                ))}
              </Section>
            ) : null}
            <TouchableOpacity
              onPress={markDone}
              disabled={saving || challenge.done}
              activeOpacity={0.85}
              testID="social-done-btn"
              style={[styles.doneBtn, challenge.done && { backgroundColor: colors.green + '33', borderColor: colors.green }]}
            >
              {saving ? <ActivityIndicator color={colors.bg} /> : (
                <>
                  <Ionicons name={challenge.done ? 'checkmark-circle' : 'checkmark'} size={18} color={challenge.done ? colors.green : colors.bg} />
                  <Text style={[styles.doneText, challenge.done && { color: colors.green }]}>
                    {challenge.done ? 'Completed today · come back tomorrow' : 'Mark as done (+15 XP)'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color }]}>{title}</Text>
      {children}
    </View>
  );
}
function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bulletDot} />
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontWeight: '900', fontSize: 17 },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  kicker: { color: colors.cyan, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  challengeTitle: { color: colors.text, fontWeight: '900', fontSize: 22, lineHeight: 28 },
  body: { color: colors.text, fontSize: 14, lineHeight: 22, opacity: 0.92 },
  section: { gap: 8, padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  sectionTitle: { fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
  bulletRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  bulletDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.cyan, marginTop: 8 },
  bulletText: { color: colors.text, fontSize: 13, lineHeight: 20, flex: 1 },
  exampleBubble: { backgroundColor: colors.green + '15', borderLeftWidth: 3, borderLeftColor: colors.green, padding: 10, borderRadius: radii.sm },
  exampleText: { color: colors.text, fontSize: 13, fontStyle: 'italic', lineHeight: 19 },
  doneBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: radii.md, backgroundColor: colors.cyan, minHeight: 48, marginTop: 4, borderWidth: 1, borderColor: colors.cyan },
  doneText: { color: colors.bg, fontWeight: '900', fontSize: 14 },
});
