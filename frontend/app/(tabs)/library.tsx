import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii } from '../../src/theme';

type Tab = 'add' | 'mine';

export default function Library() {
  const [tab, setTab] = useState<Tab>('add');

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
          <View testID="library-add-empty" style={styles.emptyWrap}>
            <View style={styles.emptyGlow}>
              <Ionicons name="rocket" size={52} color={colors.amber} />
            </View>
            <Text style={styles.emptyTitle}>Apps coming out soon!</Text>
            <Text style={styles.emptyDesc}>
              Bonus mini-apps for anxiety, social skills, posture, nutrition and more are on the way. Unlock them here the moment they launch.
            </Text>

            <View style={styles.previewGrid}>
              {[
                { icon: 'fitness', label: 'Coming soon' },
                { icon: 'flame', label: 'Coming soon' },
                { icon: 'heart', label: 'Coming soon' },
                { icon: 'moon', label: 'Coming soon' },
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

            <View style={styles.notifyBadge}>
              <Ionicons name="notifications" size={14} color={colors.cyan} />
              <Text style={styles.notifyText}>We'll notify you on launch</Text>
            </View>
          </View>
        ) : (
          <View testID="library-mine-empty" style={styles.emptyWrap}>
            <View style={[styles.emptyGlow, { backgroundColor: colors.green + '18', borderColor: colors.green }]}>
              <Ionicons name="albums" size={52} color={colors.green} />
            </View>
            <Text style={styles.emptyTitle}>Your library is empty</Text>
            <Text style={styles.emptyDesc}>
              Apps you unlock will appear here for quick access, anytime.
            </Text>

            <TouchableOpacity
              testID="library-browse-btn"
              style={styles.browseBtn}
              onPress={() => setTab('add')}
            >
              <Ionicons name="arrow-back" size={16} color={colors.bg} />
              <Text style={styles.browseText}>Browse Add</Text>
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
});
