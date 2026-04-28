import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api, LibraryCatalogResponse, CatalogSection } from '../src/api';
import { showAlert } from '../src/uiAlert';
import { colors, spacing, radii, GOLD, GOLD_SOFT } from '../src/theme';

export default function LibraryCatalog() {
  const [data, setData] = useState<LibraryCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [openSection, setOpenSection] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.libraryCatalog();
        setData(r);
      } catch (e: any) {
        showAlert('Access denied', String(e?.message || 'Admin access only.'));
        router.back();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading || !data) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}><ActivityIndicator color={GOLD} size="large" /></View>
      </SafeAreaView>
    );
  }

  const sections: { key: string; section: CatalogSection; icon: string }[] = [
    { key: 'challenge_tasks', section: data.challenge_tasks, icon: 'flash' },
    { key: 'spot_the_object', section: data.spot_the_object, icon: 'scan-circle' },
    { key: 'improve_sleep_questions', section: data.improve_sleep_questions, icon: 'moon' },
    { key: 'points_plus_boosts', section: data.points_plus_boosts, icon: 'flame' },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={GOLD} />
        </TouchableOpacity>
        <View style={styles.titleWrap}>
          <Ionicons name="library" size={16} color={GOLD} />
          <Text style={styles.title}>Mini-App Catalog</Text>
        </View>
        <View style={{ width: 26 }} />
      </View>
      <View style={styles.subBanner}>
        <Ionicons name="shield-checkmark" size={14} color={GOLD} />
        <Text style={styles.subBannerText}>CREATOR-ONLY · Full content inspector</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl }}>
        {sections.map(({ key, section, icon }) => {
          const isOpen = openSection === key;
          return (
            <View key={key} style={styles.section}>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => setOpenSection(isOpen ? null : key)}
                style={styles.sectionHead}
                testID={`catalog-section-${key}`}
              >
                <View style={styles.sectionIcon}>
                  <Ionicons name={icon as any} size={20} color={GOLD} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sectionName}>{section.name}</Text>
                  <Text style={styles.sectionMeta}>
                    {section.count} {section.count === 1 ? 'item' : 'items'} available
                  </Text>
                </View>
                <Ionicons
                  name={isOpen ? 'chevron-down' : 'chevron-forward'}
                  size={18}
                  color={GOLD}
                />
              </TouchableOpacity>
              {isOpen ? (
                <View style={styles.sectionBody}>
                  {section.items.length === 0 ? (
                    <Text style={styles.empty}>No items configured yet.</Text>
                  ) : (
                    section.items.map((it, idx) => (
                      <View key={`${it.id}-${idx}`} style={styles.item}>
                        <View style={styles.itemNumberPill}>
                          <Text style={styles.itemNumberText}>{idx + 1}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.itemTitle} numberOfLines={2}>
                            {it.title || '(untitled)'}
                          </Text>
                          {it.description ? (
                            <Text style={styles.itemDesc}>{it.description}</Text>
                          ) : null}
                          {it.options && it.options.length ? (
                            <View style={styles.tagsRow}>
                              {it.options.slice(0, 6).map((o: any, i: number) => (
                                <View key={i} style={styles.tag}>
                                  <Text style={styles.tagText}>
                                    {typeof o === 'string' ? o : o?.label || JSON.stringify(o)}
                                  </Text>
                                </View>
                              ))}
                              {it.options.length > 6 ? (
                                <Text style={styles.moreText}>+{it.options.length - 6} more</Text>
                              ) : null}
                            </View>
                          ) : null}
                          {(it.category || it.difficulty) ? (
                            <View style={styles.tagsRow}>
                              {it.category ? (
                                <View style={[styles.tag, { borderColor: colors.cyan + '88' }]}>
                                  <Text style={[styles.tagText, { color: colors.cyan }]}>{it.category}</Text>
                                </View>
                              ) : null}
                              {it.difficulty ? (
                                <View style={[styles.tag, { borderColor: colors.amber + '88' }]}>
                                  <Text style={[styles.tagText, { color: colors.amber }]}>{it.difficulty}</Text>
                                </View>
                              ) : null}
                            </View>
                          ) : null}
                        </View>
                      </View>
                    ))
                  )}
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: GOLD + '33',
  },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: GOLD, fontWeight: '900', fontSize: 16 },
  subBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: spacing.lg, paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: GOLD + '22',
  },
  subBannerText: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },

  section: {
    marginBottom: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: GOLD + '08',
    borderWidth: 1, borderColor: GOLD + '55',
    overflow: 'hidden',
  },
  sectionHead: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: spacing.md,
  },
  sectionIcon: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: GOLD + '18', borderWidth: 1, borderColor: GOLD + '88',
  },
  sectionName: { color: GOLD, fontWeight: '900', fontSize: 15 },
  sectionMeta: { color: GOLD_SOFT, fontSize: 12, marginTop: 2 },
  sectionBody: {
    paddingHorizontal: spacing.md, paddingBottom: spacing.md,
    borderTopWidth: 1, borderTopColor: GOLD + '22',
  },
  empty: { color: colors.textMuted, fontSize: 12, padding: 12, textAlign: 'center' },
  item: {
    flexDirection: 'row', gap: 10,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: GOLD + '15',
  },
  itemNumberPill: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: GOLD + '22', borderWidth: 1, borderColor: GOLD + '88',
  },
  itemNumberText: { color: GOLD, fontWeight: '900', fontSize: 11 },
  itemTitle: { color: colors.text, fontWeight: '900', fontSize: 13, textTransform: 'capitalize' },
  itemDesc: { color: colors.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 16 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6, alignItems: 'center' },
  tag: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: radii.pill,
    borderWidth: 1, borderColor: GOLD + '55', backgroundColor: GOLD + '12',
  },
  tagText: { color: GOLD, fontSize: 10, fontWeight: '700' },
  moreText: { color: colors.textMuted, fontSize: 10, marginLeft: 4 },
});
