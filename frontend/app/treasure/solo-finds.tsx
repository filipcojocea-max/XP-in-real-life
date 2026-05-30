/**
 * /treasure/solo-finds — Past Finds gallery for solo treasure hunts.
 *
 * Pulls /bt/solo/finds and renders the chest photos in a 2-column grid
 * with date/XP captions. Tapping a tile pops a full-screen viewer.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api, type BTSoloFind } from '../../src/api';
import { colors, radii, spacing } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

const { width } = Dimensions.get('window');
const TILE = (width - spacing.md * 2 - spacing.sm) / 2;

export default function SoloFinds() {
  const router = useRouter();
  const [rows, setRows] = useState<BTSoloFind[]>([]);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.btSoloFinds();
      setRows(r.finds || []);
    } catch (e: any) {
      showAlert('Failed to load history', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Past Finds</Text>
        <View style={styles.headerBtn} />
      </View>
      {loading ? (
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 60 }} />
      ) : rows.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="file-tray-outline" size={42} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No finds yet</Text>
          <Text style={styles.emptySub}>Find your first treasure chest and a photo of it will land here.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.grid}>
          {rows.map((r) => (
            <TouchableOpacity
              key={r.id}
              style={styles.tile}
              activeOpacity={0.85}
              onPress={() => r.photo_base64 && setZoom(r.photo_base64)}
            >
              {r.photo_base64 ? (
                <Image
                  source={{ uri: `data:image/jpeg;base64,${r.photo_base64}` }}
                  style={styles.tileImg}
                />
              ) : (
                <View style={[styles.tileImg, { alignItems: 'center', justifyContent: 'center' }]}>
                  <Ionicons name="image-outline" size={28} color={colors.textMuted} />
                </View>
              )}
              <View style={styles.tileFooter}>
                <Text style={styles.tileDate} numberOfLines={1}>{fmtDate(r.found_at)}</Text>
                <Text style={styles.tileXp}>+{r.xp_awarded} XP</Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
      <Modal visible={!!zoom} transparent animationType="fade" onRequestClose={() => setZoom(null)}>
        <TouchableOpacity style={styles.zoomBg} activeOpacity={1} onPress={() => setZoom(null)}>
          {zoom ? (
            <Image
              source={{ uri: `data:image/jpeg;base64,${zoom}` }}
              style={{ width: '100%', height: '100%', resizeMode: 'contain' }}
            />
          ) : null}
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.sm, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerBtn: { width: 40, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1, textAlign: 'center' },
  grid: {
    padding: spacing.md, flexDirection: 'row', flexWrap: 'wrap',
    gap: spacing.sm,
  },
  tile: {
    width: TILE, backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  tileImg: { width: '100%', height: TILE, backgroundColor: '#0E1218' },
  tileFooter: { padding: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tileDate: { color: colors.textSecondary, fontSize: 10, flex: 1, marginRight: 6 },
  tileXp: { color: colors.cyan, fontWeight: '900', fontSize: 10 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: 8 },
  emptyTitle: { color: colors.text, fontWeight: '800', fontSize: 16 },
  emptySub: { color: colors.textSecondary, fontSize: 12, textAlign: 'center', maxWidth: 280 },
  zoomBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)' },
});
