/** Physical Appearance — posture/body daily challenge. */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api, ConfidenceChallenge } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';
import * as Haptics from 'expo-haptics';

export default function PhysicalTrack() {
  const [challenge, setChallenge] = useState<ConfidenceChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.confidenceDaily(); setChallenge(r.physical); }
    catch (e: any) { showAlert('Could not load', String(e?.message || e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const markDone = async () => {
    if (!challenge || saving) return;
    setSaving(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      const r = await api.confidenceComplete('physical');
      setChallenge({ ...challenge, done: true });
      if (!r.already_done && r.xp_awarded) showAlert('Strong work', `+${r.xp_awarded} XP — your posture thanks you.`);
    } catch (e: any) { showAlert('Could not save', String(e?.message || e)); }
    finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Physical Appearance</Text>
        <View style={{ width: 32 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 80, gap: spacing.md }} showsVerticalScrollIndicator={false}>
        {loading || !challenge ? <ActivityIndicator color={colors.green} style={{ marginVertical: 40 }} /> : (
          <>
            <View style={styles.kickerRow}>
              <Ionicons name="body" size={14} color={colors.green} />
              <Text style={styles.kicker}>TODAY'S MOVEMENT</Text>
            </View>
            <Text style={styles.challengeTitle}>{challenge.title}</Text>
            <Text style={styles.body}>{challenge.body}</Text>
            {challenge.tips?.length ? (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.green }]}>FORM</Text>
                {challenge.tips.map((t, i) => (
                  <View key={i} style={styles.bulletRow}>
                    <View style={[styles.bulletDot, { backgroundColor: colors.green }]} />
                    <Text style={styles.bulletText}>{t}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            {challenge.drills?.length ? (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.cyan }]}>HOW TO FIT IT IN</Text>
                {challenge.drills.map((d, i) => (
                  <View key={i} style={styles.bulletRow}>
                    <Ionicons name="timer-outline" size={14} color={colors.cyan} style={{ marginTop: 3 }} />
                    <Text style={styles.bulletText}>{d}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            <TouchableOpacity
              onPress={markDone}
              disabled={saving || challenge.done}
              activeOpacity={0.85}
              testID="physical-done-btn"
              style={[styles.doneBtn, challenge.done && { backgroundColor: colors.green + '33', borderColor: colors.green }]}
            >
              {saving ? <ActivityIndicator color={colors.bg} /> : (
                <>
                  <Ionicons name={challenge.done ? 'checkmark-circle' : 'checkmark'} size={18} color={challenge.done ? colors.green : colors.bg} />
                  <Text style={[styles.doneText, challenge.done && { color: colors.green }]}>
                    {challenge.done ? 'Completed today · new drill tomorrow' : 'Mark as done (+15 XP)'}
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontWeight: '900', fontSize: 17 },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kicker: { color: colors.green, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  challengeTitle: { color: colors.text, fontWeight: '900', fontSize: 22, lineHeight: 28 },
  body: { color: colors.text, fontSize: 14, lineHeight: 22, opacity: 0.92 },
  section: { gap: 8, padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  sectionTitle: { fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
  bulletRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  bulletDot: { width: 6, height: 6, borderRadius: 3, marginTop: 8 },
  bulletText: { color: colors.text, fontSize: 13, lineHeight: 20, flex: 1 },
  doneBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: radii.md, backgroundColor: colors.green, minHeight: 48, marginTop: 4, borderWidth: 1, borderColor: colors.green },
  doneText: { color: colors.bg, fontWeight: '900', fontSize: 14 },
});
