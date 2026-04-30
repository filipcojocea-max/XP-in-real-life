import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { colors, spacing, radii, GOLD } from '../../src/theme';
import { api } from '../../src/api';

type Tab = 'add' | 'mine';

export default function Library() {
  const [tab, setTab] = useState<Tab>('add');
  const [isAdmin, setIsAdmin] = useState(false);

  const checkAdmin = React.useCallback(async () => {
    try {
      const p = await api.getProfile();
      setIsAdmin(!!p.is_admin);
    } catch {}
  }, []);
  useEffect(() => { checkAdmin(); }, [checkAdmin]);
  useFocusEffect(React.useCallback(() => { checkAdmin(); }, [checkAdmin]));

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={styles.badgeIcon}>
            <Ionicons name="sparkles" size={16} color={colors.amber} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.kicker}>Premium</Text>
            <Text style={styles.title}>Library+</Text>
          </View>
        </View>
        <Text style={styles.subtitle}>
          Level-up faster with bonus mini-apps designed to tackle life struggles and boost your outward confidence.
        </Text>
      </View>

      {/* Segmented tabs */}
      <View style={styles.segment}>
        <TouchableOpacity
          testID="library-tab-add"
          onPress={() => setTab('add')}
          style={[styles.segmentBtn, tab === 'add' && styles.segmentBtnActive]}
        >
          <Ionicons
            name="add-circle"
            size={16}
            color={tab === 'add' ? colors.bg : colors.textSecondary}
          />
          <Text style={[styles.segmentText, tab === 'add' && styles.segmentTextActive]}>
            Add
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="library-tab-mine"
          onPress={() => setTab('mine')}
          style={[styles.segmentBtn, tab === 'mine' && styles.segmentBtnActive]}
        >
          <Ionicons
            name="albums"
            size={16}
            color={tab === 'mine' ? colors.bg : colors.textSecondary}
          />
          <Text style={[styles.segmentText, tab === 'mine' && styles.segmentTextActive]}>
            My Library
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {tab === 'add' ? (
          <View>
            {/* Admin-only Catalog tile */}
            {isAdmin ? (
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => router.push('/library-catalog' as any)}
                style={[styles.featureCard, { borderColor: GOLD + '88', backgroundColor: GOLD + '08', marginBottom: spacing.md }]}
                testID="library-card-catalog"
              >
                <View style={[styles.featureGlow, { backgroundColor: GOLD + '22' }]} />
                <View style={styles.featureRow}>
                  <View style={[styles.featureIcon, { backgroundColor: GOLD + '22', borderColor: GOLD + '88' }]}>
                    <Ionicons name="library" size={32} color={GOLD} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.featureKickerRow}>
                      <Text style={[styles.featureKicker, { color: GOLD }]}>CREATOR · PREMIUM+</Text>
                    </View>
                    <Text style={[styles.featureTitle, { color: GOLD }]}>Mini-App Catalog</Text>
                    <Text style={styles.featureDesc}>
                      Full details on every challenge, object, sleep question and boost. Visible only on the Creator account.
                    </Text>
                    <View style={[styles.featureCta, { backgroundColor: GOLD }]}>
                      <Text style={[styles.featureCtaText, { color: colors.bg }]}>Open catalog</Text>
                      <Ionicons name="arrow-forward" size={14} color={colors.bg} />
                    </View>
                  </View>
                </View>
              </TouchableOpacity>
            ) : null}
            {/* Sleep mini-app — featured */}
            <TouchableOpacity
              testID="library-card-sleep"
              activeOpacity={0.85}
              onPress={() => router.push('/sleep' as any)}
              style={styles.featureCard}
            >
              <View style={styles.featureGlow} />
              <View style={styles.featureRow}>
                <View style={styles.featureIcon}>
                  <Ionicons name="moon" size={32} color={colors.cyan} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.featureKickerRow}>
                    <Text style={styles.featureKicker}>NEW · AI COACH</Text>
                    <View style={styles.unlockedPill}>
                      <Ionicons name="checkmark" size={10} color={colors.green} />
                      <Text style={styles.unlockedText}>UNLOCKED</Text>
                    </View>
                  </View>
                  <Text style={styles.featureTitle}>Improve Sleeping</Text>
                  <Text style={styles.featureDesc}>
                    Smart questionnaire → personalized routine. Chat with Luna, your CBT-I sleep coach. Evidence-based tips that actually work.
                  </Text>
                  <View style={styles.tagRow}>
                    <View style={styles.featTag}>
                      <Ionicons name="bed" size={10} color={colors.cyan} />
                      <Text style={styles.featTagText}>Personalized plan</Text>
                    </View>
                    <View style={styles.featTag}>
                      <Ionicons name="chatbubbles" size={10} color={colors.cyan} />
                      <Text style={styles.featTagText}>AI coach chat</Text>
                    </View>
                    <View style={styles.featTag}>
                      <Ionicons name="pulse" size={10} color={colors.cyan} />
                      <Text style={styles.featTagText}>Sleep insights</Text>
                    </View>
                  </View>
                  <View style={styles.featureCta}>
                    <Text style={styles.featureCtaText}>Open mini-app</Text>
                    <Ionicons name="arrow-forward" size={14} color={colors.bg} />
                  </View>
                </View>
              </View>
            </TouchableOpacity>

            {/* Challenge Tasks mini-app — featured */}
            <TouchableOpacity
              testID="library-card-challenges"
              activeOpacity={0.85}
              onPress={() => router.push('/challenges' as any)}
              style={[styles.featureCard, { marginTop: spacing.md, borderColor: colors.green + '55' }]}
            >
              <View style={[styles.featureGlow, { backgroundColor: colors.green + '22' }]} />
              <View style={styles.featureRow}>
                <View style={[styles.featureIcon, { backgroundColor: colors.green + '22', borderColor: colors.green + '88' }]}>
                  <Ionicons name="flash" size={32} color={colors.green} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.featureKickerRow}>
                    <Text style={[styles.featureKicker, { color: colors.green }]}>NEW · DAILY GROWTH</Text>
                    <View style={styles.unlockedPill}>
                      <Ionicons name="checkmark" size={10} color={colors.green} />
                      <Text style={styles.unlockedText}>UNLOCKED</Text>
                    </View>
                  </View>
                  <Text style={styles.featureTitle}>Challenge Tasks</Text>
                  <Text style={styles.featureDesc}>
                    A new uncomfortable challenge every day. Step outside your comfort zone, reflect on it, and earn XP for real growth.
                  </Text>
                  <View style={styles.tagRow}>
                    <View style={[styles.featTag, { backgroundColor: colors.green + '15', borderColor: colors.green + '33' }]}>
                      <Ionicons name="sparkles" size={10} color={colors.green} />
                      <Text style={[styles.featTagText, { color: colors.green }]}>Daily quote</Text>
                    </View>
                    <View style={[styles.featTag, { backgroundColor: colors.green + '15', borderColor: colors.green + '33' }]}>
                      <Ionicons name="trophy" size={10} color={colors.green} />
                      <Text style={[styles.featTagText, { color: colors.green }]}>Up to 60 XP</Text>
                    </View>
                    <View style={[styles.featTag, { backgroundColor: colors.green + '15', borderColor: colors.green + '33' }]}>
                      <Ionicons name="time" size={10} color={colors.green} />
                      <Text style={[styles.featTagText, { color: colors.green }]}>History log</Text>
                    </View>
                  </View>
                  <View style={[styles.featureCta, { backgroundColor: colors.green }]}>
                    <Text style={styles.featureCtaText}>Open mini-app</Text>
                    <Ionicons name="arrow-forward" size={14} color={colors.bg} />
                  </View>
                </View>
              </View>
            </TouchableOpacity>

            {/* Spot the Object mini-app — featured */}
            <TouchableOpacity
              testID="library-card-spot"
              activeOpacity={0.85}
              onPress={() => router.push('/spot' as any)}
              style={[styles.featureCard, { marginTop: spacing.md, borderColor: colors.amber + '55' }]}
            >
              <View style={[styles.featureGlow, { backgroundColor: colors.amber + '22' }]} />
              <View style={styles.featureRow}>
                <View style={[styles.featureIcon, { backgroundColor: colors.amber + '22', borderColor: colors.amber + '88' }]}>
                  <Ionicons name="scan-circle" size={32} color={colors.amber} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.featureKickerRow}>
                    <Text style={[styles.featureKicker, { color: colors.amber }]}>NEW · MOVE & SPOT</Text>
                    <View style={styles.unlockedPill}>
                      <Ionicons name="checkmark" size={10} color={colors.green} />
                      <Text style={styles.unlockedText}>UNLOCKED</Text>
                    </View>
                  </View>
                  <Text style={styles.featureTitle}>Spot the Object</Text>
                  <Text style={styles.featureDesc}>
                    Take a photo of a leaf, a dog, anything pink — AI checks if you found it. Endless solo practice or surprise 2-minute challenges.
                  </Text>
                  <View style={styles.tagRow}>
                    <View style={[styles.featTag, { backgroundColor: colors.amber + '15', borderColor: colors.amber + '33' }]}>
                      <Ionicons name="walk" size={10} color={colors.amber} />
                      <Text style={[styles.featTagText, { color: colors.amber }]}>Get moving</Text>
                    </View>
                    <View style={[styles.featTag, { backgroundColor: colors.amber + '15', borderColor: colors.amber + '33' }]}>
                      <Ionicons name="trophy" size={10} color={colors.amber} />
                      <Text style={[styles.featTagText, { color: colors.amber }]}>Spot Points</Text>
                    </View>
                    <View style={[styles.featTag, { backgroundColor: colors.amber + '15', borderColor: colors.amber + '33' }]}>
                      <Ionicons name="people" size={10} color={colors.amber} />
                      <Text style={[styles.featTagText, { color: colors.amber }]}>Solo + friends*</Text>
                    </View>
                  </View>
                  <View style={[styles.featureCta, { backgroundColor: colors.amber }]}>
                    <Text style={styles.featureCtaText}>Open mini-app</Text>
                    <Ionicons name="arrow-forward" size={14} color={colors.bg} />
                  </View>
                </View>
              </View>
            </TouchableOpacity>
            {/* Build Self-Confidence mini-app — featured */}
            <TouchableOpacity
              testID="library-card-confidence"
              activeOpacity={0.85}
              onPress={() => router.push('/confidence' as any)}
              style={[styles.featureCard, { marginTop: spacing.md, borderColor: '#FFD70055' }]}
            >
              <View style={[styles.featureGlow, { backgroundColor: '#FFD70022' }]} />
              <View style={styles.featureRow}>
                <View style={[styles.featureIcon, { backgroundColor: '#FFD70022', borderColor: '#FFD70088' }]}>
                  <Ionicons name="shirt" size={32} color={'#FFD700'} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.featureKickerRow}>
                    <Text style={[styles.featureKicker, { color: '#FFD700' }]}>NEW · 4 TRACKS</Text>
                    <View style={styles.unlockedPill}>
                      <Ionicons name="checkmark" size={10} color={colors.green} />
                      <Text style={styles.unlockedText}>UNLOCKED</Text>
                    </View>
                  </View>
                  <Text style={styles.featureTitle}>Build Self-Confidence</Text>
                  <Text style={styles.featureDesc}>
                    Daily speaking + posture challenges, gratitude prompts, and an AI Style Coach that reviews your outfit photos.
                  </Text>
                  <View style={styles.tagRow}>
                    <View style={[styles.featTag, { backgroundColor: '#FFD70015', borderColor: '#FFD70033' }]}>
                      <Ionicons name="chatbubbles" size={10} color={'#FFD700'} />
                      <Text style={[styles.featTagText, { color: '#FFD700' }]}>Social</Text>
                    </View>
                    <View style={[styles.featTag, { backgroundColor: '#FFD70015', borderColor: '#FFD70033' }]}>
                      <Ionicons name="body" size={10} color={'#FFD700'} />
                      <Text style={[styles.featTagText, { color: '#FFD700' }]}>Posture</Text>
                    </View>
                    <View style={[styles.featTag, { backgroundColor: '#FFD70015', borderColor: '#FFD70033' }]}>
                      <Ionicons name="sparkles" size={10} color={'#FFD700'} />
                      <Text style={[styles.featTagText, { color: '#FFD700' }]}>AI Stylist</Text>
                    </View>
                  </View>
                  <View style={[styles.featureCta, { backgroundColor: '#FFD700' }]}>
                    <Text style={styles.featureCtaText}>Open mini-app</Text>
                    <Ionicons name="arrow-forward" size={14} color={colors.bg} />
                  </View>
                </View>
              </View>
            </TouchableOpacity>
            <Text style={styles.sectionLabel}>Coming soon</Text>
            <View style={styles.previewGrid}>
              {[
                { icon: 'fitness', label: 'Posture Coach' },
                { icon: 'flame', label: 'Anxiety Reset' },
                { icon: 'heart', label: 'Affirmations' },
                { icon: 'restaurant', label: 'Nutrition' },
              ].map((p, i) => (
                <View key={i} style={styles.lockedCard}>
                  <View style={styles.lockedIcon}>
                    <Ionicons name={p.icon as any} size={24} color={colors.textMuted} />
                  </View>
                  <View style={styles.lockBadge}>
                    <Ionicons name="lock-closed" size={10} color={colors.textMuted} />
                  </View>
                  <Text style={styles.lockedText}>{p.label}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : (
          <View style={{ gap: spacing.sm }}>
            {/* My library — show Sleep as installed */}
            <TouchableOpacity
              testID="library-mine-sleep"
              activeOpacity={0.85}
              onPress={() => router.push('/sleep' as any)}
              style={styles.mineCard}
            >
              <View style={[styles.featureIcon, { width: 48, height: 48, borderRadius: 12 }]}>
                <Ionicons name="moon" size={24} color={colors.cyan} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.mineTitle}>Improve Sleeping</Text>
                <Text style={styles.mineDesc}>Personalized sleep coach · AI chat</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </TouchableOpacity>

            {/* Challenge Tasks installed */}
            <TouchableOpacity
              testID="library-mine-challenges"
              activeOpacity={0.85}
              onPress={() => router.push('/challenges' as any)}
              style={[styles.mineCard, { borderColor: colors.green + '55' }]}
            >
              <View style={[styles.featureIcon, { width: 48, height: 48, borderRadius: 12, backgroundColor: colors.green + '22', borderColor: colors.green + '88' }]}>
                <Ionicons name="flash" size={24} color={colors.green} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.mineTitle}>Challenge Tasks</Text>
                <Text style={styles.mineDesc}>Daily growth challenges · XP rewards</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </TouchableOpacity>

            {/* Spot the Object installed */}
            <TouchableOpacity
              testID="library-mine-spot"
              activeOpacity={0.85}
              onPress={() => router.push('/spot' as any)}
              style={[styles.mineCard, { borderColor: colors.amber + '55' }]}
            >
              <View style={[styles.featureIcon, { width: 48, height: 48, borderRadius: 12, backgroundColor: colors.amber + '22', borderColor: colors.amber + '88' }]}>
                <Ionicons name="scan-circle" size={24} color={colors.amber} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.mineTitle}>Spot the Object</Text>
                <Text style={styles.mineDesc}>Photo challenges · AI verified</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </TouchableOpacity>

            {/* Build Self-Confidence installed */}
            <TouchableOpacity
              testID="library-mine-confidence"
              activeOpacity={0.85}
              onPress={() => router.push('/confidence' as any)}
              style={[styles.mineCard, { borderColor: '#FFD70055' }]}
            >
              <View style={[styles.featureIcon, { width: 48, height: 48, borderRadius: 12, backgroundColor: '#FFD70022', borderColor: '#FFD70088' }]}>
                <Ionicons name="shirt" size={24} color={'#FFD700'} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.mineTitle}>Build Self-Confidence</Text>
                <Text style={styles.mineDesc}>4 daily tracks · AI Style Coach</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  badgeIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    backgroundColor: colors.amber + '22',
    borderWidth: 1,
    borderColor: colors.amber + '55',
    alignItems: 'center',
    justifyContent: 'center',
  },
  kicker: { color: colors.amber, fontSize: 11, letterSpacing: 2, fontWeight: '800' },
  title: { color: colors.text, fontSize: 26, fontWeight: '900', letterSpacing: -0.5 },
  subtitle: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.sm, lineHeight: 19 },

  segment: {
    flexDirection: 'row',
    marginHorizontal: spacing.md,
    padding: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: radii.pill,
  },
  segmentBtnActive: {
    backgroundColor: colors.green,
    shadowColor: colors.green,
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  segmentText: { color: colors.textSecondary, fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
  segmentTextActive: { color: colors.bg },

  scroll: { padding: spacing.md, paddingBottom: 120 },
  emptyWrap: { alignItems: 'center', paddingVertical: spacing.xl },
  emptyGlow: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.amber + '18',
    borderWidth: 2,
    borderColor: colors.amber,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  emptyDesc: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 19,
    paddingHorizontal: spacing.md,
  },

  previewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xl,
    justifyContent: 'center',
  },
  lockedCard: {
    width: '46%',
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    position: 'relative',
  },
  lockedIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  lockBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockedText: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },

  notifyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.xl,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: radii.pill,
    backgroundColor: colors.cyan + '15',
    borderWidth: 1,
    borderColor: colors.cyan + '55',
  },
  notifyText: { color: colors.cyan, fontSize: 12, fontWeight: '700' },

  browseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.xl,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: radii.pill,
    backgroundColor: colors.green,
    shadowColor: colors.green,
    shadowOpacity: 0.5,
    shadowRadius: 12,
  },
  browseText: { color: colors.bg, fontWeight: '800', fontSize: 14 },

  // ── Featured mini-app card ──
  featureCard: {
    position: 'relative',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.cyan + '55',
    padding: spacing.md,
    overflow: 'hidden',
  },
  featureGlow: {
    position: 'absolute',
    top: -40,
    right: -40,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: colors.cyan + '22',
  },
  featureRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  featureIcon: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: colors.cyan + '22',
    borderWidth: 1,
    borderColor: colors.cyan + '88',
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureKickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 4,
  },
  featureKicker: { color: colors.cyan, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  unlockedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.green + '22',
    borderWidth: 1,
    borderColor: colors.green + '66',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.pill,
  },
  unlockedText: { color: colors.green, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  featureTitle: { color: colors.text, fontSize: 19, fontWeight: '900', letterSpacing: -0.3 },
  featureDesc: { color: colors.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 4 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.sm },
  featTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.cyan + '15',
    borderWidth: 1,
    borderColor: colors.cyan + '33',
  },
  featTagText: { color: colors.cyan, fontSize: 10, fontWeight: '700' },
  featureCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.md,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.cyan,
  },
  featureCtaText: { color: colors.bg, fontWeight: '800', fontSize: 13, letterSpacing: 0.3 },

  sectionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  mineCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.cyan + '55',
  },
  mineTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  mineDesc: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
});
