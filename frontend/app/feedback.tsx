/**
 * Standalone feedback screen — reachable from Profile → "Give us
 * feedback". Lets users submit a rating + text any time, not only
 * after a level-up. Uses the same /api/feedback endpoint and the
 * same backend dedupe logic as the level-up modal.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { api } from '../src/api';
import { colors, spacing, radii } from '../src/theme';

export default function FeedbackScreen() {
  const router = useRouter();
  const [rating, setRating] = useState<number>(5);
  const [text, setText] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (rating < 1 || rating > 5) return;
    setSubmitting(true);
    try {
      await api.submitFeedback({
        rating,
        text: text.trim().slice(0, 1000),
        platform: Platform.OS,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setDone(true);
      setTimeout(() => router.back(), 1200);
    } catch (e) {
      console.warn('[feedback] failed', e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Send Feedback</Text>
          <View style={{ width: 24 }} />
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.heroIcon}>
            <Ionicons name="chatbubbles" size={42} color={colors.cyan} />
          </View>
          <Text style={styles.heroTitle}>Help us improve XP in real life</Text>
          <Text style={styles.heroSub}>
            Your feedback shapes the next update — we read every word.
            (Stays private; never posted to the Play Store from here.)
          </Text>
          <Text style={styles.label}>How would you rate the app?</Text>
          <View style={styles.starsRow}>
            {[1, 2, 3, 4, 5].map((n) => {
              const filled = n <= rating;
              return (
                <TouchableOpacity
                  key={n}
                  testID={`fb-star-${n}`}
                  onPress={() => {
                    setRating(n);
                    Haptics.selectionAsync().catch(() => {});
                  }}
                  hitSlop={6}
                  style={{ padding: 6 }}
                >
                  <Ionicons
                    name={filled ? 'star' : 'star-outline'}
                    size={36}
                    color={filled ? colors.cyan : colors.textMuted}
                  />
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.label}>Tell us what you think</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="What do you love? What's missing? Bug reports?"
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={1000}
            style={styles.textInput}
            testID="fb-text"
          />
          <Text style={styles.charCount}>{text.length} / 1000</Text>

          <TouchableOpacity
            onPress={submit}
            disabled={submitting || done}
            style={[
              styles.submitBtn,
              { backgroundColor: done ? colors.green : colors.cyan },
              submitting && { opacity: 0.5 },
            ]}
            testID="fb-submit"
            activeOpacity={0.85}
          >
            {submitting ? (
              <ActivityIndicator color={colors.bg} />
            ) : done ? (
              <>
                <Ionicons name="checkmark" size={18} color={colors.bg} />
                <Text style={styles.submitText}>Thanks!</Text>
              </>
            ) : (
              <Text style={styles.submitText}>Submit Feedback</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  heroIcon: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: colors.cyan + '22',
    borderWidth: 1, borderColor: colors.cyan + '88',
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  heroTitle: { color: colors.text, fontSize: 20, fontWeight: '900', textAlign: 'center', letterSpacing: -0.3 },
  heroSub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 4, lineHeight: 18 },
  label: { color: colors.textSecondary, fontSize: 12, fontWeight: '800', letterSpacing: 0.5, marginTop: spacing.lg, marginBottom: spacing.xs },
  starsRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.xs },
  textInput: {
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    color: colors.text, padding: 14, fontSize: 14,
    minHeight: 120,
    textAlignVertical: 'top',
  },
  charCount: { color: colors.textMuted, fontSize: 11, textAlign: 'right', marginTop: 4 },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, marginTop: spacing.lg,
    borderRadius: radii.pill,
  },
  submitText: { color: colors.bg, fontWeight: '900', fontSize: 14, letterSpacing: 0.3 },
});
