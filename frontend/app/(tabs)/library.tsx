import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { api, LibraryApp } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';

type Tab = 'add' | 'mine';

export default function Library() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('add');
  const [apps, setApps] = useState<LibraryApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [confirmApp, setConfirmApp] = useState<LibraryApp | null>(null);
  const [justUnlocked, setJustUnlocked] = useState<LibraryApp | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.libraryApps();
      setApps(r.apps);
    } catch (e) {
      console.log('lib load err', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const purchase = async (app: LibraryApp) => {
    setPurchasing(app.id);
    try {
      const res = await api.purchaseApp(app.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setConfirmApp(null);
      setJustUnlocked(res.app as LibraryApp);
      await load();
    } catch (e) {
      console.log('purchase err', e);
    } finally {
      setPurchasing(null);
    }
  };

  const open = (app: LibraryApp) => {
    router.push(app.route as any);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loading}>
          <ActivityIndicator color={colors.green} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const available = apps.filter((a) => !a.purchased);
  const mine = apps.filter((a) => a.purchased);

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
          Unlock bonus mini-apps to tackle life struggles and boost outward confidence.
        </Text>
      </View>

      <View style={styles.segment}>
        <TouchableOpacity
          testID="library-tab-add"
          onPress={() => setTab('add')}
          style={[styles.segmentBtn, tab === 'add' && styles.segmentBtnActive]}
        >
          <Ionicons name="add-circle" size={16} color={tab === 'add' ? colors.bg : colors.textSecondary} />
          <Text style={[styles.segmentText, tab === 'add' && styles.segmentTextActive]}>Add</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="library-tab-mine"
          onPress={() => setTab('mine')}
          style={[styles.segmentBtn, tab === 'mine' && styles.segmentBtnActive]}
        >
          <Ionicons name="albums" size={16} color={tab === 'mine' ? colors.bg : colors.textSecondary} />
          <Text style={[styles.segmentText, tab === 'mine' && styles.segmentTextActive]}>
            My Library {mine.length > 0 ? `(${mine.length})` : ''}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {tab === 'add' ? (
          available.length === 0 ? (
            <View testID="library-add-empty" style={styles.emptyWrap}>
              <View style={styles.emptyGlow}>
                <Ionicons name="trophy" size={52} color={colors.amber} />
              </View>
              <Text style={styles.emptyTitle}>All apps unlocked!</Text>
              <Text style={styles.emptyDesc}>You own every premium mini-app. True Library+ legend.</Text>
            </View>
          ) : (
            <>
              <Text style={styles.sectionLabel}>Available · {available.length}</Text>
              {available.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  onAdd={() => setConfirmApp(app)}
                  loading={purchasing === app.id}
                />
              ))}
              <Text style={styles.footnote}>MOCKED purchase — no real charge. Wire Stripe later.</Text>
            </>
          )
        ) : mine.length === 0 ? (
          <View testID="library-mine-empty" style={styles.emptyWrap}>
            <View style={[styles.emptyGlow, { backgroundColor: colors.green + '18', borderColor: colors.green }]}>
              <Ionicons name="albums" size={52} color={colors.green} />
            </View>
            <Text style={styles.emptyTitle}>Your library is empty</Text>
            <Text style={styles.emptyDesc}>Apps you unlock will appear here for quick access, anytime.</Text>
            <TouchableOpacity
              testID="library-browse-btn"
              style={styles.browseBtn}
              onPress={() => setTab('add')}
            >
              <Ionicons name="arrow-back" size={16} color={colors.bg} />
              <Text style={styles.browseText}>Browse Add</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <Text style={styles.sectionLabel}>My apps · {mine.length}</Text>
            {mine.map((app) => (
              <AppCard key={app.id} app={app} onOpen={() => open(app)} />
            ))}
          </>
        )}
      </ScrollView>

      {/* Purchase confirm */}
      <Modal visible={!!confirmApp} transparent animationType="fade" onRequestClose={() => setConfirmApp(null)}>
        <View style={styles.modalBackdrop} testID="purchase-modal">
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setConfirmApp(null)} />
          <View style={styles.modalSheet}>
            {confirmApp ? (
              <>
                <View style={[styles.appIconLarge, { backgroundColor: confirmApp.accent + '22', borderColor: confirmApp.accent }]}>
                  <Ionicons name={confirmApp.icon as any} size={40} color={confirmApp.accent} />
                </View>
                <Text style={styles.modalTitle}>{confirmApp.title}</Text>
                <Text style={styles.modalTagline}>{confirmApp.tagline}</Text>
                <Text style={styles.modalDesc}>{confirmApp.description}</Text>

                <View style={styles.priceRow}>
                  <Text style={styles.priceLabel}>One-time price</Text>
                  <Text style={[styles.priceValue, { color: confirmApp.accent }]}>{confirmApp.price_label}</Text>
                </View>

                <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.cancelBtn]}
                    onPress={() => setConfirmApp(null)}
                  >
                    <Text style={styles.cancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID="purchase-confirm"
                    style={[styles.actionBtn, { backgroundColor: confirmApp.accent }]}
                    onPress={() => purchase(confirmApp)}
                    disabled={purchasing === confirmApp.id}
                  >
                    {purchasing === confirmApp.id ? (
                      <ActivityIndicator color={colors.bg} />
                    ) : (
                      <>
                        <Ionicons name="lock-open" size={16} color={colors.bg} />
                        <Text style={styles.purchaseText}>Unlock · {confirmApp.price_label}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
                <Text style={styles.mockedNote}>⚠ MOCKED — no real payment yet.</Text>
              </>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* Just unlocked celebration */}
      <Modal visible={!!justUnlocked} transparent animationType="fade" onRequestClose={() => setJustUnlocked(null)}>
        <View style={styles.modalBackdrop} testID="unlocked-modal">
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setJustUnlocked(null)} />
          {justUnlocked ? (
            <View style={styles.unlockedSheet}>
              <Ionicons name="sparkles" size={36} color={colors.amber} />
              <Text style={styles.unlockedTitle}>Unlocked!</Text>
              <Text style={styles.unlockedSub}>{justUnlocked.title} is now in My Library.</Text>
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.cancelBtn]}
                  onPress={() => setJustUnlocked(null)}
                >
                  <Text style={styles.cancelText}>Later</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="unlocked-open"
                  style={[styles.actionBtn, { backgroundColor: justUnlocked.accent }]}
                  onPress={() => {
                    const a = justUnlocked;
                    setJustUnlocked(null);
                    setTab('mine');
                    router.push(a.route as any);
                  }}
                >
                  <Ionicons name="play" size={16} color={colors.bg} />
                  <Text style={styles.purchaseText}>Open</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function AppCard({
  app,
  onAdd,
  onOpen,
  loading,
}: {
  app: LibraryApp;
  onAdd?: () => void;
  onOpen?: () => void;
  loading?: boolean;
}) {
  return (
    <TouchableOpacity
      testID={`app-card-${app.id}`}
      activeOpacity={0.85}
      onPress={onOpen}
      disabled={!onOpen}
      style={[styles.card, { borderColor: app.accent + '55' }]}
    >
      <View style={[styles.cardAccent, { backgroundColor: app.accent }]} />
      <View style={styles.cardRow}>
        <View style={[styles.appIcon, { backgroundColor: app.accent + '22', borderColor: app.accent + '88' }]}>
          <Ionicons name={app.icon as any} size={24} color={app.accent} />
        </View>
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <Text style={styles.appTitle}>{app.title}</Text>
          <Text style={styles.appTagline}>{app.tagline}</Text>
          <Text style={styles.appDesc} numberOfLines={2}>{app.description}</Text>
        </View>
        {app.purchased ? (
          <TouchableOpacity
            testID={`app-open-${app.id}`}
            onPress={onOpen}
            style={[styles.openBtn, { backgroundColor: app.accent }]}
          >
            <Ionicons name="play" size={16} color={colors.bg} />
            <Text style={styles.openBtnText}>Open</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            testID={`app-add-${app.id}`}
            onPress={onAdd}
            disabled={loading}
            style={[styles.addBtn, { borderColor: app.accent, backgroundColor: app.accent + '18' }]}
          >
            {loading ? (
              <ActivityIndicator color={app.accent} size="small" />
            ) : (
              <>
                <Ionicons name="add-circle" size={18} color={app.accent} />
                <Text style={[styles.addBtnText, { color: app.accent }]}>{app.price_label}</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  badgeIcon: {
    width: 36, height: 36, borderRadius: radii.sm,
    backgroundColor: colors.amber + '22',
    borderWidth: 1, borderColor: colors.amber + '55',
    alignItems: 'center', justifyContent: 'center',
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
    borderWidth: 1, borderColor: colors.border,
  },
  segmentBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: radii.pill,
  },
  segmentBtnActive: { backgroundColor: colors.green },
  segmentText: { color: colors.textSecondary, fontSize: 13, fontWeight: '800' },
  segmentTextActive: { color: colors.bg },

  scroll: { padding: spacing.md, paddingBottom: 120 },
  sectionLabel: { color: colors.textMuted, fontSize: 11, letterSpacing: 1.5, fontWeight: '800', textTransform: 'uppercase', marginBottom: spacing.sm },

  card: {
    borderRadius: radii.md,
    borderWidth: 1,
    backgroundColor: colors.surfaceGlass,
    padding: spacing.md,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    position: 'relative',
  },
  cardAccent: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 2,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center' },
  appIcon: {
    width: 52, height: 52, borderRadius: radii.md,
    borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  appTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  appTagline: { color: colors.textSecondary, fontSize: 12, marginTop: 2, fontWeight: '600' },
  appDesc: { color: colors.textMuted, fontSize: 11, marginTop: 4, lineHeight: 15 },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 8, paddingHorizontal: 12,
    borderRadius: radii.pill, borderWidth: 1,
  },
  addBtnText: { fontSize: 12, fontWeight: '800' },
  openBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: radii.pill,
  },
  openBtnText: { color: colors.bg, fontSize: 12, fontWeight: '800' },

  footnote: { color: colors.textMuted, fontSize: 10, textAlign: 'center', marginTop: spacing.md },

  emptyWrap: { alignItems: 'center', paddingVertical: spacing.xl },
  emptyGlow: {
    width: 120, height: 120, borderRadius: 60,
    backgroundColor: colors.amber + '18',
    borderWidth: 2, borderColor: colors.amber,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg,
  },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  emptyDesc: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: spacing.sm, lineHeight: 19, paddingHorizontal: spacing.md },
  browseBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: spacing.xl, paddingVertical: 12, paddingHorizontal: 24,
    borderRadius: radii.pill, backgroundColor: colors.green,
  },
  browseText: { color: colors.bg, fontWeight: '800', fontSize: 14 },

  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.8)',
    alignItems: 'center', justifyContent: 'center', padding: spacing.lg,
  },
  modalSheet: {
    width: '100%', maxWidth: 360,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: spacing.lg, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center',
  },
  appIconLarge: {
    width: 80, height: 80, borderRadius: 40, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md,
  },
  modalTitle: { color: colors.text, fontSize: 22, fontWeight: '900' },
  modalTagline: { color: colors.textSecondary, fontSize: 13, marginTop: 4, fontWeight: '600' },
  modalDesc: { color: colors.textMuted, fontSize: 12, textAlign: 'center', marginTop: spacing.md, lineHeight: 17 },
  priceRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    width: '100%', marginTop: spacing.lg,
    padding: spacing.md, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceGlass,
  },
  priceLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  priceValue: { fontSize: 20, fontWeight: '900' },
  actionBtn: {
    flex: 1, paddingVertical: 14, borderRadius: radii.pill,
    alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 6,
  },
  cancelBtn: { backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.textSecondary, fontWeight: '700' },
  purchaseText: { color: colors.bg, fontWeight: '900', fontSize: 14 },
  mockedNote: { color: colors.amber, fontSize: 10, marginTop: spacing.md, textAlign: 'center' },

  unlockedSheet: {
    width: '100%', maxWidth: 360,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: spacing.xl, borderWidth: 2, borderColor: colors.amber,
    alignItems: 'center',
  },
  unlockedTitle: { color: colors.text, fontSize: 26, fontWeight: '900', marginTop: spacing.sm },
  unlockedSub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 6 },
});
