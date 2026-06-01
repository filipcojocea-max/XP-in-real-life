/**
 * /treasure/settings — Mini-App Settings for Buried Treasure.
 *
 * Surface for editing the persistent area/radius the player saved on
 * their FIRST run. Per 2026-06-01 spec the map picker no longer fires
 * on every entry into /treasure — it only fires when there's no area
 * saved yet. After that, this is the only place the player can change
 * their location/radius.
 *
 * UI:
 *   • Current saved area summary (lat/lng + radius)
 *   • Big "EDIT LOCATION" button → re-opens BTMapPicker, on confirm
 *     saves through /api/bt/settings and pops back.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import BTMapPicker, { type BTAreaPicked } from '../../src/components/BTMapPicker';
import { api } from '../../src/api';
import { colors, radii, spacing } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

type Stage = 'loading' | 'view' | 'editing' | 'saving';

const fmtRadius = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;

export default function TreasureSettings() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('loading');
  const [area, setArea] = useState<{ lat: number; lng: number; radius_m: number; label?: string | null; updated_at?: string } | null>(null);

  const load = useCallback(async () => {
    setStage('loading');
    try {
      const r = await api.btGetSettings();
      setArea(r.area || null);
      setStage('view');
    } catch (e: any) {
      showAlert('Failed to load settings', String(e?.message || e));
      setStage('view');
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onConfirmEdit = useCallback(async (picked: BTAreaPicked) => {
    setStage('saving');
    try {
      const r = await api.btSaveSettings(picked.lat, picked.lng, picked.radius_m);
      setArea(r.area);
      setStage('view');
      showAlert('Saved', 'Your hunt area has been updated.');
    } catch (e: any) {
      showAlert('Save failed', String(e?.message || e));
      setStage('editing');
    }
  }, []);

  if (stage === 'editing') {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setStage('view')} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Edit hunt area</Text>
          <View style={styles.headerBtn} />
        </View>
        <BTMapPicker
          onConfirm={onConfirmEdit}
          initialRadius={area?.radius_m || 800}
          title="Pick the spot you're at"
          confirmLabel="Save new location"
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Mini-App Settings</Text>
        <View style={styles.headerBtn} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
        <View style={styles.card}>
          <Text style={styles.cardKicker}>SAVED LOCATION</Text>
          {stage === 'loading' || stage === 'saving' ? (
            <ActivityIndicator color={colors.cyan} style={{ marginVertical: 20 }} />
          ) : area ? (
            <View style={{ gap: 6 }}>
              <View style={styles.row}>
                <Ionicons name="location" size={16} color={colors.cyan} />
                <Text style={styles.val}>
                  {area.lat.toFixed(4)}, {area.lng.toFixed(4)}
                </Text>
              </View>
              <View style={styles.row}>
                <Ionicons name="resize" size={16} color={colors.cyan} />
                <Text style={styles.val}>Hunt radius · {fmtRadius(area.radius_m)}</Text>
              </View>
              {area.updated_at ? (
                <Text style={styles.helper}>
                  Last updated {new Date(area.updated_at).toLocaleString()}
                </Text>
              ) : null}
            </View>
          ) : (
            <Text style={styles.helper}>
              No location saved yet — set one below to start hunting.
            </Text>
          )}
        </View>

        <TouchableOpacity
          style={styles.cta}
          onPress={() => setStage('editing')}
          activeOpacity={0.85}
          testID="bt-edit-location"
        >
          <Ionicons name="map" size={20} color="#0b0f15" />
          <Text style={styles.ctaText}>{area ? 'EDIT LOCATION' : 'PICK LOCATION'}</Text>
        </TouchableOpacity>

        <Text style={styles.footnote}>
          Once you set a hunt area, the Buried Treasure home screen will skip the map picker on every open. You can change your area here at any time.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
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
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, gap: 8,
  },
  cardKicker: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  val: { color: colors.text, fontWeight: '700', fontSize: 14 },
  helper: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  cta: {
    backgroundColor: colors.cyan, borderRadius: radii.lg,
    paddingVertical: 14, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  ctaText: { color: '#0b0f15', fontWeight: '900', letterSpacing: 0.7 },
  footnote: {
    color: colors.textMuted, fontSize: 11, fontStyle: 'italic',
    textAlign: 'center', marginTop: spacing.sm, lineHeight: 16,
  },
});
