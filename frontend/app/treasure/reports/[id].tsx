/**
 * /treasure/reports/[id] — Issue Report review screen.
 *
 * Loaded when a reviewer (group creator or admin) taps a
 * bt_report_received notification OR opens the gold banner card on
 * the Treasure home. Shows the reporter's category + notes + a red-pin
 * map of the reported spot, and lets the reviewer either IGNORE
 * (dismiss) or CONFIRM (add the coord to the permanent block list with
 * a 30 m radius so future hunts skip it).
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../src/api';
import { BTLeafletMap } from '../../../src/components/BTLeafletMap';
import { colors, radii, spacing } from '../../../src/theme';
import { showAlert } from '../../../src/uiAlert';

type Report = Awaited<ReturnType<typeof api.btReportsGet>>;

export default function ReportReviewScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<'confirm' | 'ignore' | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const r = await api.btReportsGet(String(id));
      setReport(r);
    } catch (e: any) {
      showAlert('Failed to load report', String(e?.message || e));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const onConfirm = async () => {
    if (!report || acting) return;
    setActing('confirm');
    try {
      await api.btReportsConfirm(report.report_id);
      showAlert(
        'Report confirmed',
        'That spot is now permanently blocked (30 m radius). Future hunts will skip it.',
      );
      router.back();
    } catch (e: any) {
      showAlert('Could not confirm', String(e?.message || e));
    } finally {
      setActing(null);
    }
  };

  const onIgnore = async () => {
    if (!report || acting) return;
    setActing('ignore');
    try {
      await api.btReportsIgnore(report.report_id);
      router.back();
    } catch (e: any) {
      showAlert('Could not ignore', String(e?.message || e));
    } finally {
      setActing(null);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <Stack.Screen options={{ title: 'Issue report', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
        <View style={styles.center}>
          <ActivityIndicator color={colors.cyan} />
        </View>
      </SafeAreaView>
    );
  }
  if (!report) {
    return (
      <SafeAreaView style={styles.safe}>
        <Stack.Screen options={{ title: 'Issue report', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
        <View style={styles.center}>
          <Text style={styles.muted}>Report not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const isResolved = report.status !== 'pending';
  const canReview = report.can_review && !isResolved;
  const categoryLabel = report.category === 'chest' ? 'The chest itself' : 'The location where it was placed';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <Stack.Screen options={{ title: 'Issue report', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        <View style={styles.statusPill}>
          <Ionicons
            name={isResolved ? (report.status === 'confirmed' ? 'checkmark-circle' : 'close-circle') : 'time-outline'}
            size={16}
            color={isResolved ? (report.status === 'confirmed' ? '#11C28F' : '#FF3B30') : '#FFD166'}
          />
          <Text style={[styles.statusText, {
            color: isResolved ? (report.status === 'confirmed' ? '#11C28F' : '#FF3B30') : '#FFD166',
          }]}>
            {report.status === 'pending' ? 'PENDING REVIEW' : report.status === 'confirmed' ? 'CONFIRMED — SPOT BLOCKED' : 'IGNORED'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Reporter</Text>
          <Text style={styles.value}>{report.reporter_name || 'Unknown player'}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>What's the issue?</Text>
          <Text style={styles.value}>{categoryLabel}</Text>
          {report.notes ? (
            <>
              <Text style={[styles.label, { marginTop: 10 }]}>Notes</Text>
              <Text style={styles.notes}>{report.notes}</Text>
            </>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Reported spot</Text>
          <Text style={styles.hint}>
            Confirming will block this exact coordinate (and a 30 m radius)
            from every future hunt. The active hunt is NOT affected.
          </Text>
          <View style={styles.mapWrap}>
            <BTLeafletMap
              mode="static"
              initialLat={report.chest_lat}
              initialLng={report.chest_lng}
              initialZoom={17}
              initialRadius={30}
              ringColor="#FF3B30"
              markerColor="#FF3B30"
              markerShape="x"
              interactive={false}
            />
          </View>
          <Text style={styles.coords}>
            {report.chest_lat.toFixed(5)}, {report.chest_lng.toFixed(5)}
          </Text>
        </View>

        {report.source === 'group' && report.group_name ? (
          <View style={styles.card}>
            <Text style={styles.label}>Group</Text>
            <Text style={styles.value}>{report.group_name}</Text>
          </View>
        ) : null}

        {isResolved ? (
          <Text style={styles.resolvedFooter}>
            Reviewed on {report.reviewed_at?.slice(0, 16).replace('T', ' ')}.
          </Text>
        ) : !canReview ? (
          <Text style={styles.resolvedFooter}>
            Only the group creator or an admin can review this report.
          </Text>
        ) : null}
      </ScrollView>

      {canReview ? (
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.btn, styles.btnIgnore, acting && styles.btnDisabled]}
            onPress={onIgnore}
            disabled={!!acting}
            activeOpacity={0.85}
            testID="bt-report-ignore"
          >
            {acting === 'ignore' ? <ActivityIndicator color="#fff" /> : (
              <>
                <Ionicons name="close-circle-outline" size={18} color="#fff" />
                <Text style={[styles.btnText, { color: '#fff' }]}>IGNORE</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnConfirm, acting && styles.btnDisabled]}
            onPress={onConfirm}
            disabled={!!acting}
            activeOpacity={0.85}
            testID="bt-report-confirm"
          >
            {acting === 'confirm' ? <ActivityIndicator color="#0b0f15" /> : (
              <>
                <Ionicons name="shield-checkmark" size={18} color="#0b0f15" />
                <Text style={styles.btnText}>CONFIRM &amp; BLOCK</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: spacing.md, paddingBottom: 120, gap: spacing.sm },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, backgroundColor: '#0F1218',
    borderWidth: 1, borderColor: '#1A1A24',
    marginBottom: 4,
  },
  statusText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  card: {
    backgroundColor: '#0F1218',
    borderRadius: radii.md,
    padding: spacing.sm,
    borderWidth: 1, borderColor: '#1A1A24',
    gap: 4,
  },
  label: { color: '#8C92A6', fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  value: { color: colors.text, fontSize: 15, fontWeight: '600' },
  notes: { color: colors.text, fontSize: 14, lineHeight: 20 },
  hint: { color: '#8C92A6', fontSize: 12, marginBottom: 6 },
  mapWrap: {
    height: 200, borderRadius: radii.md, overflow: 'hidden',
    marginTop: 6,
    borderWidth: 1, borderColor: '#FF3B30',
  },
  coords: { color: '#8C92A6', fontSize: 11, alignSelf: 'flex-end', marginTop: 4 },
  muted: { color: '#8C92A6', fontSize: 14 },
  resolvedFooter: { color: '#8C92A6', fontSize: 12, textAlign: 'center', marginTop: spacing.md },
  footer: {
    flexDirection: 'row', gap: 8,
    padding: spacing.md,
    borderTopWidth: 1, borderTopColor: '#1A1A24',
    backgroundColor: colors.bg,
  },
  btn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 14, borderRadius: radii.md,
  },
  btnIgnore: { backgroundColor: '#3A3A44' },
  btnConfirm: { backgroundColor: '#11C28F' },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#0b0f15', fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
});
