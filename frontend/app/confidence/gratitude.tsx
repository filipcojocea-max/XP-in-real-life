/** No Negative Thinking — daily gratitude prompt + affirmation + 3 things. */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api, ConfidenceChallenge } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';
import * as Haptics from 'expo-haptics';

export default function GratitudeTrack() {
  const [challenge, setChallenge] = useState<ConfidenceChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [entries, setEntries] = useState<string[]>(['', '', '']);

  const load = useCallback(async () => {
    try { const r = await api.confidenceDaily(); setChallenge(r.gratitude); }
    catch (e: any) { showAlert('Could not load', String(e?.message || e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const anyFilled = entries.some((e) => e.trim().length > 0);

  const markDone = async () => {
    if (!challenge || saving) return;
    if (!anyFilled) {
      showAlert('One thing', 'Write at least one thing you are grateful for before saving.');
      return;
    }
    setSaving(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      const note = entries.filter((e) => e.trim()).map((e, i) => `${i + 1}. ${e.trim()}`).join(' | ');
      const r = await api.confidenceComplete('gratitude', note);
      setChallenge({ ...challenge, done: true });
      if (!r.already_done && r.xp_awarded) showAlert('Beautiful', `+${r.xp_awarded} XP — your mind gets stronger every time you do this.`);
    } catch (e: any) { showAlert('Could not save', String(e?.message || e)); }
    finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Grateful Mind</Text>
        <View style={{ width: 32 }} />
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={20}>
        <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 80, gap: spacing.md }} keyboardShouldPersistTaps="handled">
          {loading || !challenge ? <ActivityIndicator color={PINK} style={{ marginVertical: 40 }} /> : (
            <>
              <View style={styles.kickerRow}>
                <Ionicons name="sparkles" size={14} color={PINK} />
                <Text style={styles.kicker}>TODAY'S PROMPT</Text>
              </View>
              <Text style={styles.challengeTitle}>{challenge.title}</Text>
              <Text style={styles.body}>{challenge.body}</Text>
              {challenge.affirmation ? (
                <View style={styles.affirmation}>
                  <Ionicons name="heart" size={16} color={PINK} />
                  <Text style={styles.affirmationText}>{challenge.affirmation}</Text>
                </View>
              ) : null}
              <Text style={styles.writePrompt}>Write down 3 things you are grateful for today:</Text>
              {entries.map((e, i) => (
                <TextInput
                  key={i}
                  value={e}
                  onChangeText={(v) => setEntries((prev) => { const next = [...prev]; next[i] = v; return next; })}
                  placeholder={`${i + 1}. Something, someone or some moment…`}
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  multiline
                  maxLength={200}
                  editable={!challenge.done}
                  testID={`gratitude-input-${i}`}
                />
              ))}
              <TouchableOpacity
                onPress={markDone}
                disabled={saving || challenge.done}
                activeOpacity={0.85}
                testID="gratitude-done-btn"
                style={[styles.doneBtn, challenge.done && { backgroundColor: colors.green + '33', borderColor: colors.green }]}
              >
                {saving ? <ActivityIndicator color={colors.bg} /> : (
                  <>
                    <Ionicons name={challenge.done ? 'checkmark-circle' : 'heart'} size={18} color={challenge.done ? colors.green : colors.bg} />
                    <Text style={[styles.doneText, challenge.done && { color: colors.green }]}>
                      {challenge.done ? 'Saved for today · new prompt tomorrow' : 'Save my gratitude (+15 XP)'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const PINK = '#ff9fd0';

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontWeight: '900', fontSize: 17 },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kicker: { color: PINK, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  challengeTitle: { color: colors.text, fontWeight: '900', fontSize: 22, lineHeight: 28 },
  body: { color: colors.text, fontSize: 14, lineHeight: 22, opacity: 0.92 },
  affirmation: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: spacing.md, borderRadius: radii.md, backgroundColor: PINK + '14', borderWidth: 1, borderColor: PINK + '66' },
  affirmationText: { color: colors.text, fontSize: 13.5, fontStyle: 'italic', lineHeight: 20, flex: 1 },
  writePrompt: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 1.2, marginTop: spacing.sm },
  input: { color: colors.text, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, padding: spacing.sm, fontSize: 14, minHeight: 48 },
  doneBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: radii.md, backgroundColor: PINK, minHeight: 48, marginTop: 4, borderWidth: 1, borderColor: PINK },
  doneText: { color: colors.bg, fontWeight: '900', fontSize: 14 },
});
