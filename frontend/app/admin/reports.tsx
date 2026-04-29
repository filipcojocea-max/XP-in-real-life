/**
 * /admin/reports — Creator-only inbox of AI-flagged player activity.
 *
 * Each row shows the reported player, the kind of incident
 * (message_text / message_image), the AI's reason, and an excerpt of
 * the offending content. Tapping a row marks it viewed; long-press to
 * dismiss a report once you've actioned it.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showAlert, showConfirm } from '../../src/uiAlert';
import { colors, spacing } from '../../src/theme';
import { api, type AdminReport } from '../../src/api';

export default function AdminReports() {
  const router = useRouter();
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.adminReportsList();
      setReports(r.reports || []);
    } catch (e: any) {
      if (String(e?.message || '').includes('403')) {
        showAlert('Admin only', 'This page is only available to the Creator account.');
        router.back();
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onView = async (r: AdminReport) => {
    if (!r.viewed_at) {
      try {
        await api.adminReportView(r.id);
        setReports((prev) =>
          prev.map((x) => (x.id === r.id ? { ...x, viewed_at: new Date().toISOString() } : x)),
        );
      } catch {}
    }
    showAlert(
      `Report on ${r.reported_name}`,
      `Kind: ${r.kind}\nSeverity: ${r.severity}\nReason: ${r.reason || '(no reason)'}\n\nExcerpt:\n${r.excerpt}`,
    );
  };

  const onDismiss = async (r: AdminReport) => {
    const ok = await showConfirm('Dismiss report?', 'This removes the report from your inbox.');
    if (!ok) return;
    try {
      await api.adminReportDismiss(r.id);
      setReports((prev) => prev.filter((x) => x.id !== r.id));
    } catch (e: any) {
      showAlert('Could not dismiss', String(e?.message || e));
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Admin · Reports</Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#FFD700" />
        </View>
      ) : reports.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="shield-checkmark" size={42} color={colors.green} />
          <Text style={styles.emptyTitle}>All clear</Text>
          <Text style={styles.emptyDesc}>No flagged activity right now. Reports will appear here automatically when the AI guard catches anything inappropriate.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
              tintColor="#FFD700"
            />
          }
        >
          {reports.map((r) => (
            <TouchableOpacity
              key={r.id}
              activeOpacity={0.85}
              style={[styles.row, !r.viewed_at && styles.rowUnviewed]}
              onPress={() => onView(r)}
              onLongPress={() => onDismiss(r)}
              testID={`report-${r.id}`}
            >
              <View style={[styles.icon, { backgroundColor: colors.red + '22', borderColor: colors.red + '88' }]}>
                <Ionicons name={r.kind === 'message_image' ? 'image' : 'chatbubble-ellipses'} size={18} color={colors.red} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {r.reported_name}
                  {!r.viewed_at && <Text style={{ color: colors.red }}>  •  NEW</Text>}
                </Text>
                <Text style={styles.email} numberOfLines={1}>{r.reported_email || '(anonymous account)'}</Text>
                <Text style={styles.excerpt} numberOfLines={2}>{r.excerpt}</Text>
                <View style={styles.metaRow}>
                  <View style={[styles.pill, { backgroundColor: colors.red + '22' }]}>
                    <Text style={[styles.pillText, { color: colors.red }]}>{r.severity.toUpperCase()}</Text>
                  </View>
                  <Text style={styles.metaText}>{new Date(r.created_at).toLocaleString()}</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topTitle: { flex: 1, color: '#FFD700', fontSize: 18, fontWeight: '900', paddingLeft: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '900', marginTop: 12 },
  emptyDesc: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowUnviewed: { borderColor: colors.red, backgroundColor: colors.red + '10' },
  icon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  name: { color: colors.text, fontWeight: '900', fontSize: 14 },
  email: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  excerpt: { color: colors.text, fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  pillText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  metaText: { color: colors.textMuted, fontSize: 10 },
});
