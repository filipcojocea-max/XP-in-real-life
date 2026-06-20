/**
 * BTReportIssueModal — "Found any issues? Report to Creator" form.
 *
 * Used on both /treasure/solo and /treasure/group/[id] while a chest is
 * actively buried. Two categories only:
 *   chest    — the chest itself is the problem.
 *   location — the SPOT it was placed is the problem (private property,
 *              inaccessible, dangerous, etc).
 *
 * Per the 2026-06-04 spec the player CANNOT pick an arbitrary coord —
 * the report is always tied to the active chest's coordinates. The map
 * preview shows a red pin at that exact spawn so the player can
 * visually confirm what they're reporting.
 *
 * Submission is rate-limited server-side to 1 active report per
 * (reporter, hunt) — the host screen probes /reports/can-report on mount
 * and disables the button if a previous report is still pending.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api';
import { colors, radii, spacing } from '../theme';
import { showAlert } from '../uiAlert';
import { BTLeafletMap } from './BTLeafletMap';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
  source: 'solo' | 'group';
  hunt_id?: string;
  group_id?: string;
  chest_lat: number;
  chest_lng: number;
};

type Category = 'chest' | 'location';

const NOTES_MAX = 500;

export function BTReportIssueModal({
  visible,
  onClose,
  onSubmitted,
  source,
  hunt_id,
  group_id,
  chest_lat,
  chest_lng,
}: Props) {
  const [category, setCategory] = useState<Category | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset state every time the modal opens so a previous attempt
  // doesn't pre-fill the form.
  React.useEffect(() => {
    if (visible) {
      setCategory(null);
      setNotes('');
      setBusy(false);
    }
  }, [visible]);

  const onSubmit = async () => {
    if (!category || busy) return;
    setBusy(true);
    try {
      await api.btReportsCreate({
        source,
        hunt_id,
        group_id,
        category,
        notes: notes.trim() || undefined,
      });
      showAlert(
        'Report sent',
        'Thanks — the creator will review it. The current hunt continues; future hunts will avoid this spot if your report is confirmed.',
      );
      onSubmitted?.();
      onClose();
    } catch (e: any) {
      const msg = String(e?.message || e);
      // Backend returns 409 'already active report' on rate-limit hits.
      showAlert('Could not submit', msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} hitSlop={12} testID="bt-report-close">
              <Ionicons name="close" size={28} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.title}>Report an issue</Text>
            <View style={{ width: 28 }} />
          </View>

          <View style={styles.body}>
            <Text style={styles.sectionLabel}>What's the problem?</Text>
            <View style={styles.catGroup}>
              <CategoryRow
                value="chest"
                label="The chest itself"
                hint="Wrong photo / missing / broken"
                selected={category === 'chest'}
                onPress={() => setCategory('chest')}
              />
              <CategoryRow
                value="location"
                label="The location where it was placed"
                hint="Private property, inaccessible, dangerous, etc."
                selected={category === 'location'}
                onPress={() => setCategory('location')}
              />
            </View>

            {category === 'location' ? (
              <View style={styles.mapBlock}>
                <Text style={styles.sectionLabel}>Reported spot</Text>
                <Text style={styles.sectionHint}>
                  This is the chest's current spawn point. Confirming the
                  report will block this exact spot (30 m radius) from
                  future hunts.
                </Text>
                <View style={styles.mapWrap}>
                  {Number.isFinite(chest_lat) && Number.isFinite(chest_lng) ? (
                    <BTLeafletMap
                      mode="static"
                      initialLat={Number(chest_lat)}
                      initialLng={Number(chest_lng)}
                      initialZoom={17}
                      initialRadius={30}
                      ringColor="#FF3B30"
                      markerColor="#FF3B30"
                      markerShape="x"
                      interactive={false}
                    />
                  ) : (
                    // Defensive: BTLeafletMap's WebView would crash the
                    // whole report modal when chest_lat/lng came through
                    // as undefined (group hunts before the chest is
                    // buried, or solo hunts where the API hasn't loaded
                    // yet). Render a graceful placeholder instead so the
                    // user can still submit a "location" report with
                    // notes — the backend doesn't strictly need the
                    // marker coords to record the issue.
                    <View style={[styles.mapWrap, { alignItems: 'center', justifyContent: 'center', padding: 12 }]}>
                      <Text style={[styles.sectionHint, { textAlign: 'center' }]}>
                        Map preview unavailable — chest coordinates not loaded yet.
                        You can still describe the location issue in the notes below
                        and submit the report.
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            ) : null}

            <Text style={styles.sectionLabel}>Notes (optional)</Text>
            <TextInput
              style={styles.notesInput}
              placeholder="Anything else the creator should know?"
              placeholderTextColor="#8C92A6"
              value={notes}
              onChangeText={(t) => setNotes(t.slice(0, NOTES_MAX))}
              multiline
              numberOfLines={4}
              maxLength={NOTES_MAX}
              testID="bt-report-notes"
            />
            <Text style={styles.charCount}>{notes.length} / {NOTES_MAX}</Text>
          </View>

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.submitBtn, (!category || busy) && styles.submitBtnDisabled]}
              disabled={!category || busy}
              onPress={onSubmit}
              activeOpacity={0.85}
              testID="bt-report-submit"
            >
              {busy ? (
                <ActivityIndicator color="#0b0f15" />
              ) : (
                <>
                  <Ionicons name="flag" size={18} color="#0b0f15" />
                  <Text style={styles.submitText}>SUBMIT REPORT</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function CategoryRow({
  label,
  hint,
  selected,
  onPress,
}: {
  value: Category;
  label: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.catRow,
        selected && styles.catRowSelected,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={[styles.radio, selected && styles.radioOn]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.catLabel, selected && { color: colors.cyan }]}>{label}</Text>
        <Text style={styles.catHint}>{hint}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A24',
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  body: { flex: 1, padding: spacing.md, gap: spacing.sm },
  sectionLabel: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: spacing.xs },
  sectionHint: { color: '#8C92A6', fontSize: 12, marginBottom: 4 },
  catGroup: { gap: 8 },
  catRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: '#1A1A24',
    backgroundColor: '#0F1218',
  },
  catRowSelected: { borderColor: colors.cyan, backgroundColor: '#0F1F24' },
  radio: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: '#5A5F70',
    alignItems: 'center', justifyContent: 'center',
  },
  radioOn: { borderColor: colors.cyan },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.cyan },
  catLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  catHint: { color: '#8C92A6', fontSize: 12, marginTop: 2 },
  mapBlock: { marginTop: spacing.sm, gap: 4 },
  mapWrap: {
    height: 200, borderRadius: radii.md, overflow: 'hidden',
    borderWidth: 1, borderColor: '#FF3B30',
  },
  notesInput: {
    backgroundColor: '#0F1218',
    borderWidth: 1, borderColor: '#1A1A24',
    borderRadius: radii.md,
    color: colors.text,
    padding: 12,
    minHeight: 92,
    textAlignVertical: 'top',
    fontSize: 14,
  },
  charCount: { color: '#5A5F70', fontSize: 11, alignSelf: 'flex-end' },
  footer: {
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: '#1A1A24',
  },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#FF3B30',
    paddingVertical: 14, borderRadius: radii.md,
  },
  submitBtnDisabled: { backgroundColor: '#3A3A44' },
  submitText: { color: '#0b0f15', fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
});
