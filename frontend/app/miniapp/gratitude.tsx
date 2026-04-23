import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { api, GratitudeEntry } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';

const ACCENT = '#9D4CDD';

export default function GratitudeJournal() {
  const router = useRouter();
  const [items, setItems] = useState(['', '', '']);
  const [entries, setEntries] = useState<GratitudeEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api.listGratitude();
      setEntries(r.entries);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const save = async () => {
    const clean = items.map((i) => i.trim()).filter(Boolean);
    if (clean.length === 0) {
      Alert.alert('Add at least one gratitude');
      return;
    }
    setSaving(true);
    try {
      await api.createGratitude(clean);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setItems(['', '', '']);
      await load();
    } catch (e: any) {
      Alert.alert('Save failed', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const todayEntry = entries.find((e) => e.date === today);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity testID="grat-back" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>Library+</Text>
          <Text style={styles.title}>Gratitude Journal</Text>
        </View>
        <View style={styles.tag}>
          <Ionicons name="leaf" size={14} color={ACCENT} />
        </View>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.prompt}>
            <Text style={styles.promptTitle}>3 things I'm grateful for today</Text>
            <Text style={styles.promptDate}>{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</Text>
          </View>

          {items.map((v, i) => (
            <View key={i} style={styles.inputRow}>
              <View style={[styles.inputBadge, { backgroundColor: ACCENT + '22', borderColor: ACCENT }]}>
                <Text style={[styles.inputBadgeText, { color: ACCENT }]}>{i + 1}</Text>
              </View>
              <TextInput
                testID={`grat-input-${i}`}
                style={styles.input}
                value={v}
                onChangeText={(t) => setItems((prev) => prev.map((p, idx) => (idx === i ? t : p)))}
                placeholder={i === 0 ? 'a big win today' : i === 1 ? 'a small joy' : 'someone who helped'}
                placeholderTextColor={colors.textMuted}
                multiline
              />
            </View>
          ))}

          <TouchableOpacity
            testID="grat-save"
            style={[styles.saveBtn, { backgroundColor: ACCENT }]}
            onPress={save}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <>
                <Ionicons name="save" size={18} color={colors.bg} />
                <Text style={styles.saveText}>Save entry</Text>
              </>
            )}
          </TouchableOpacity>

          {todayEntry ? (
            <View style={styles.todayBadge}>
              <Ionicons name="checkmark-circle" size={14} color={ACCENT} />
              <Text style={styles.todayText}>Today's entry saved</Text>
            </View>
          ) : null}

          <View style={styles.historyHeader}>
            <Text style={styles.historyTitle}>History</Text>
            {loading ? <ActivityIndicator size="small" color={ACCENT} /> : null}
          </View>

          {entries.length === 0 ? (
            <Text style={styles.emptyText}>No entries yet. Save your first one above.</Text>
          ) : (
            entries.map((e) => (
              <View key={e.id} style={styles.entryCard}>
                <Text style={styles.entryDate}>{new Date(e.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', weekday: 'short' })}</Text>
                {e.items.map((item, idx) => (
                  <View key={idx} style={styles.entryItem}>
                    <Ionicons name="leaf" size={12} color={ACCENT} />
                    <Text style={styles.entryItemText}>{item}</Text>
                  </View>
                ))}
              </View>
            ))
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surfaceGlass, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  kicker: { color: ACCENT, fontSize: 11, letterSpacing: 2, fontWeight: '800' },
  title: { color: colors.text, fontSize: 20, fontWeight: '900' },
  tag: { width: 36, height: 36, borderRadius: 18, backgroundColor: ACCENT + '22', borderWidth: 1, borderColor: ACCENT, alignItems: 'center', justifyContent: 'center' },

  scroll: { padding: spacing.md, paddingBottom: 120 },
  prompt: { marginBottom: spacing.md },
  promptTitle: { color: colors.text, fontSize: 22, fontWeight: '900' },
  promptDate: { color: colors.textMuted, fontSize: 12, marginTop: 4, fontWeight: '600' },

  inputRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'flex-start' },
  inputBadge: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  inputBadgeText: { fontWeight: '900', fontSize: 12 },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceGlass,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 48,
  },

  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: radii.pill, marginTop: spacing.lg },
  saveText: { color: colors.bg, fontSize: 15, fontWeight: '900' },
  todayBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', marginTop: spacing.md, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radii.pill, backgroundColor: ACCENT + '18', borderWidth: 1, borderColor: ACCENT + '55' },
  todayText: { color: ACCENT, fontSize: 11, fontWeight: '800' },

  historyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.xl, marginBottom: spacing.sm },
  historyTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  emptyText: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic' },
  entryCard: { padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm },
  entryDate: { color: ACCENT, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  entryItem: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: 4 },
  entryItemText: { color: colors.text, fontSize: 13, flex: 1, lineHeight: 18 },
});
