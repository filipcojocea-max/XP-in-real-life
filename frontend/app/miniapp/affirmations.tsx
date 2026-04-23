import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radii } from '../../src/theme';

const ACCENT = '#FFB800';
const AFFIRMATIONS = [
  'I am the author of my own story.',
  'I show up for myself every day.',
  'My growth compounds. Small wins matter.',
  'I am confident in my own pace.',
  'I deserve peace and focus.',
  'My voice is worth hearing.',
  'I am stronger than my doubts.',
  'I build my body, my mind, my life.',
  'I choose courage over comfort.',
  'I attract opportunities by taking action.',
  'My energy is magnetic.',
  'I am not behind. I am becoming.',
  'I release what no longer serves me.',
  'My discipline is my freedom.',
  'I speak kindly to myself.',
  'I am designed to rise.',
  'I am safe in my own company.',
  'My presence is a gift.',
  'I forgive my past self and lead my future self.',
  'I am allowed to take up space.',
  'My efforts today create the person I will be.',
  'I am calm, grounded, and clear.',
  'I trust my intuition.',
  'I celebrate every tiny victory.',
  'I turn fear into fuel.',
  'I am worthy of deep rest.',
  'I choose progress over perfection.',
  'I am becoming unstoppable.',
  'My face softens. My shoulders drop.',
  'I belong to the life I am building.',
];

export default function AffirmationVault() {
  const router = useRouter();
  const [idx, setIdx] = useState(0);
  const [favorites, setFavorites] = useState<Set<number>>(new Set());
  const [view, setView] = useState<'deck' | 'favorites'>('deck');

  const shuffle = () => {
    let n = idx;
    while (n === idx && AFFIRMATIONS.length > 1) {
      n = Math.floor(Math.random() * AFFIRMATIONS.length);
    }
    setIdx(n);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };

  const toggleFav = () => {
    setFavorites((prev) => {
      const s = new Set(prev);
      if (s.has(idx)) s.delete(idx);
      else s.add(idx);
      return s;
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  };

  const favIds = useMemo(() => Array.from(favorites), [favorites]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity testID="aff-back" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>Library+</Text>
          <Text style={styles.title}>Affirmation Vault</Text>
        </View>
        <View style={styles.tag}>
          <Ionicons name="sparkles" size={14} color={ACCENT} />
        </View>
      </View>

      <View style={styles.segment}>
        <TouchableOpacity
          testID="aff-tab-deck"
          onPress={() => setView('deck')}
          style={[styles.segBtn, view === 'deck' && { backgroundColor: ACCENT }]}
        >
          <Text style={[styles.segText, view === 'deck' && { color: colors.bg }]}>Deck</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="aff-tab-fav"
          onPress={() => setView('favorites')}
          style={[styles.segBtn, view === 'favorites' && { backgroundColor: ACCENT }]}
        >
          <Text style={[styles.segText, view === 'favorites' && { color: colors.bg }]}>
            Favorites ({favorites.size})
          </Text>
        </TouchableOpacity>
      </View>

      {view === 'deck' ? (
        <View style={styles.body}>
          <View style={styles.card} testID="aff-card">
            <Ionicons name="chatbubble-ellipses" size={24} color={ACCENT} style={{ opacity: 0.6 }} />
            <Text style={styles.quote}>{AFFIRMATIONS[idx]}</Text>
            <Text style={styles.counter}>{idx + 1} / {AFFIRMATIONS.length}</Text>
          </View>

          <View style={styles.actions}>
            <TouchableOpacity testID="aff-fav" onPress={toggleFav} style={[styles.roundBtn, favorites.has(idx) && { backgroundColor: ACCENT, borderColor: ACCENT }]}>
              <Ionicons name={favorites.has(idx) ? 'heart' : 'heart-outline'} size={22} color={favorites.has(idx) ? colors.bg : ACCENT} />
            </TouchableOpacity>
            <TouchableOpacity testID="aff-next" onPress={shuffle} style={[styles.primaryBtn, { backgroundColor: ACCENT }]}>
              <Ionicons name="shuffle" size={18} color={colors.bg} />
              <Text style={styles.primaryText}>Next</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}>
          {favIds.length === 0 ? (
            <View style={styles.emptyBox} testID="aff-empty">
              <Ionicons name="heart-outline" size={56} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>No favorites yet</Text>
              <Text style={styles.emptyDesc}>Tap the heart on an affirmation to save it here.</Text>
            </View>
          ) : (
            favIds.map((i) => (
              <View key={i} style={styles.favRow}>
                <Ionicons name="heart" size={18} color={ACCENT} />
                <Text style={styles.favText}>{AFFIRMATIONS[i]}</Text>
              </View>
            ))
          )}
        </ScrollView>
      )}
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

  segment: { flexDirection: 'row', marginHorizontal: spacing.md, padding: 4, borderRadius: radii.pill, backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border },
  segBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radii.pill },
  segText: { color: colors.textSecondary, fontWeight: '800', fontSize: 12 },

  body: { flex: 1, padding: spacing.md, alignItems: 'center', justifyContent: 'center' },
  card: { width: '100%', padding: spacing.xl, borderRadius: radii.lg, borderWidth: 1, borderColor: ACCENT + '55', backgroundColor: ACCENT + '10', alignItems: 'center' },
  quote: { color: colors.text, fontSize: 22, lineHeight: 30, fontWeight: '800', textAlign: 'center', marginVertical: spacing.lg },
  counter: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },

  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  roundBtn: { width: 54, height: 54, borderRadius: 27, borderWidth: 1, borderColor: ACCENT + '66', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceGlass },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 28, borderRadius: radii.pill, flex: 1, justifyContent: 'center' },
  primaryText: { color: colors.bg, fontWeight: '900', fontSize: 15 },

  favRow: { flexDirection: 'row', gap: 10, padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border, alignItems: 'flex-start' },
  favText: { color: colors.text, fontSize: 14, flex: 1, lineHeight: 20 },
  emptyBox: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginTop: spacing.md },
  emptyDesc: { color: colors.textMuted, fontSize: 13, marginTop: 6, textAlign: 'center' },
});
