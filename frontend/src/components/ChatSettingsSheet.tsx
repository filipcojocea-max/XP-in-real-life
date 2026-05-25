/**
 * ChatSettingsSheet — bottom-sheet for per-friend chat preferences.
 *
 * Four user-controllable swatches:
 *   - sent bubble + sent text
 *   - received bubble + received text
 * Plus two toggles:
 *   - 🔕 Mute   = suppress push notifications only (red badge KEEPS)
 *   - 🔒 Block  = suppress push + suppress unread badge + lock icon
 *                 (messages still arrive, soft block)
 *
 * Color picker has two tabs:
 *   1. PRESETS — 12 curated swatches from api.ts/CHAT_PRESET_COLORS
 *   2. CUSTOM  — full HSL picker via reanimated-color-picker
 */
import React, { useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ColorPicker, {
  Panel1,
  HueSlider,
  Preview,
} from 'reanimated-color-picker';
import { colors, spacing } from '../theme';
import {
  CHAT_PRESET_COLORS,
} from '../api';
import type { ChatPreferences } from '../api';

type ColorKey =
  | 'sent_bubble_color'
  | 'sent_text_color'
  | 'received_bubble_color'
  | 'received_text_color';

const COLOR_FIELD_LABELS: Record<ColorKey, string> = {
  sent_bubble_color: 'Bubble',
  sent_text_color: 'Text',
  received_bubble_color: 'Bubble',
  received_text_color: 'Text',
};

type Props = {
  visible: boolean;
  prefs: ChatPreferences;
  friendName: string;
  onClose: () => void;
  /** Called when any single field changes — parent persists via API. */
  onPatch: (patch: Partial<ChatPreferences>) => void;
};

export function ChatSettingsSheet({ visible, prefs, friendName, onClose, onPatch }: Props) {
  const [pickerOpenFor, setPickerOpenFor] = useState<ColorKey | null>(null);

  const renderSwatchRow = (label: string, field: ColorKey) => (
    <TouchableOpacity
      style={styles.swatchRow}
      onPress={() => setPickerOpenFor(field)}
      activeOpacity={0.7}
      testID={`chat-settings-swatch-${field}`}
    >
      <Text style={styles.swatchLabel}>{label}</Text>
      <View style={styles.swatchRight}>
        <View style={[styles.swatchPreview, { backgroundColor: prefs[field] }]} />
        <Text style={styles.swatchHex}>{prefs[field].toUpperCase()}</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
      </View>
    </TouchableOpacity>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={styles.backdropTouch} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handleBar} />
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              Chat with {friendName}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={12} testID="chat-settings-close">
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingBottom: spacing.xl }}>
            {/* Live preview row — matches the actual chat layout:
                YOUR messages on the LEFT, THEIRS on the RIGHT. */}
            <View style={styles.previewBlock}>
              <View style={styles.previewRow}>
                <View style={[styles.previewBubble, { backgroundColor: prefs.sent_bubble_color }]}>
                  <Text style={[styles.previewBubbleText, { color: prefs.sent_text_color }]}>
                    You: Hi there
                  </Text>
                </View>
                <View style={styles.previewSpacer} />
              </View>
              <View style={styles.previewRow}>
                <View style={styles.previewSpacer} />
                <View style={[styles.previewBubble, { backgroundColor: prefs.received_bubble_color, borderWidth: 1, borderColor: colors.border }]}>
                  <Text style={[styles.previewBubbleText, { color: prefs.received_text_color }]}>
                    Them: Hey 👋
                  </Text>
                </View>
              </View>
            </View>

            {/* NB: Section labels are intentionally INVERTED relative
                to the colour-key names (sent_x / received_x). The user
                preference is that the "Your messages" header sits above
                the controls that style the OTHER player's bubble (the
                bubble you see on the right) and vice versa. The
                underlying wiring (sent_x → my bubble on the left,
                received_x → their bubble on the right) is unchanged. */}
            <Text style={styles.sectionLabel}>THEIR MESSAGES</Text>
            {renderSwatchRow('Bubble', 'sent_bubble_color')}
            {renderSwatchRow('Text', 'sent_text_color')}

            <Text style={styles.sectionLabel}>YOUR MESSAGES</Text>
            {renderSwatchRow('Bubble', 'received_bubble_color')}
            {renderSwatchRow('Text', 'received_text_color')}

            <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
            <View style={styles.toggleRow}>
              <View style={styles.toggleLabelBlock}>
                <View style={styles.toggleLabelHead}>
                  <Ionicons name="notifications-off-outline" size={18} color={colors.amber} />
                  <Text style={styles.toggleLabel}>Mute notifications</Text>
                </View>
                <Text style={styles.toggleSubLabel}>
                  No push pings, red unread badge still appears
                </Text>
              </View>
              <Switch
                value={!!prefs.muted}
                onValueChange={(v) => onPatch({ muted: v })}
                trackColor={{ false: colors.border, true: colors.amber + '88' }}
                thumbColor={prefs.muted ? colors.amber : '#f0f0f0'}
                testID="chat-settings-mute"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleLabelBlock}>
                <View style={styles.toggleLabelHead}>
                  <Ionicons name="lock-closed-outline" size={18} color={colors.red} />
                  <Text style={styles.toggleLabel}>Block this player</Text>
                </View>
                <Text style={styles.toggleSubLabel}>
                  No push, no badge — messages still arrive (soft block)
                </Text>
              </View>
              <Switch
                value={!!prefs.blocked}
                onValueChange={(v) => onPatch({ blocked: v })}
                trackColor={{ false: colors.border, true: colors.red + '88' }}
                thumbColor={prefs.blocked ? colors.red : '#f0f0f0'}
                testID="chat-settings-block"
              />
            </View>
          </ScrollView>
        </View>
      </View>

      {/* Nested modal: color picker. Stacked so the sheet stays mounted. */}
      <Modal
        visible={!!pickerOpenFor}
        animationType="fade"
        transparent
        onRequestClose={() => setPickerOpenFor(null)}
      >
        {pickerOpenFor && (
          <ColorPickerOverlay
            currentHex={prefs[pickerOpenFor]}
            label={COLOR_FIELD_LABELS[pickerOpenFor]}
            onClose={() => setPickerOpenFor(null)}
            onPick={(hex) => {
              onPatch({ [pickerOpenFor]: hex } as Partial<ChatPreferences>);
              setPickerOpenFor(null);
            }}
          />
        )}
      </Modal>
    </Modal>
  );
}

/** Inner overlay with curated swatches + custom HSL picker tabs. */
function ColorPickerOverlay({
  currentHex,
  label,
  onPick,
  onClose,
}: {
  currentHex: string;
  label: string;
  onPick: (hex: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'presets' | 'custom'>('presets');
  const [draft, setDraft] = useState<string>(currentHex);

  return (
    <View style={styles.backdrop}>
      <TouchableOpacity style={styles.backdropTouch} activeOpacity={1} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: spacing.lg }]}>
        <View style={styles.handleBar} />
        <View style={styles.header}>
          <Text style={styles.title}>Pick {label} color</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12} testID="color-picker-close">
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.tabsRow}>
          <TouchableOpacity
            style={[styles.tab, tab === 'presets' && styles.tabActive]}
            onPress={() => setTab('presets')}
            testID="color-picker-tab-presets"
          >
            <Text style={[styles.tabText, tab === 'presets' && styles.tabTextActive]}>
              Presets
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, tab === 'custom' && styles.tabActive]}
            onPress={() => setTab('custom')}
            testID="color-picker-tab-custom"
          >
            <Text style={[styles.tabText, tab === 'custom' && styles.tabTextActive]}>
              Custom
            </Text>
          </TouchableOpacity>
        </View>

        {tab === 'presets' ? (
          <View style={styles.presetGrid}>
            {CHAT_PRESET_COLORS.map((c) => {
              const isCurrent = draft.toUpperCase() === c.hex.toUpperCase();
              return (
                <TouchableOpacity
                  key={c.hex}
                  style={[
                    styles.presetSwatch,
                    { backgroundColor: c.hex },
                    isCurrent && styles.presetSwatchActive,
                  ]}
                  onPress={() => onPick(c.hex)}
                  activeOpacity={0.7}
                  testID={`color-preset-${c.name.toLowerCase()}`}
                >
                  {isCurrent && (
                    <Ionicons
                      name="checkmark"
                      size={20}
                      color={c.hex === '#FFFFFF' || c.hex === '#FFD166' ? '#000' : '#fff'}
                    />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        ) : (
          <View style={{ padding: spacing.md }}>
            <ColorPicker
              value={draft}
              onComplete={(c: { hex: string }) => setDraft(c.hex)}
              style={{ width: '100%', gap: 12 }}
            >
              <Preview style={{ height: 36, borderRadius: 8 }} hideInitialColor />
              <Panel1 style={{ height: 220, borderRadius: 8 }} />
              <HueSlider style={{ height: 28, borderRadius: 14 }} />
            </ColorPicker>
            <TouchableOpacity
              style={styles.applyBtn}
              onPress={() => onPick(draft)}
              testID="color-picker-apply"
            >
              <Text style={styles.applyBtnText}>Apply {draft.toUpperCase()}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  backdropTouch: { flex: 1 },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  handleBar: {
    width: 40,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: spacing.sm,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '900', flex: 1 },

  previewBlock: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: spacing.md,
    gap: 8,
  },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  previewSpacer: { flex: 1 },
  previewBubble: { maxWidth: '70%', borderRadius: 14, padding: 10 },
  previewBubbleText: { fontSize: 13, lineHeight: 18 },

  sectionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.5,
    marginTop: spacing.md,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  swatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    borderRadius: 10,
    marginBottom: 6,
  },
  swatchLabel: { color: colors.text, fontSize: 14, fontWeight: '700' },
  swatchRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatchPreview: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  swatchHex: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    borderRadius: 10,
    marginBottom: 8,
    gap: 12,
  },
  toggleLabelBlock: { flex: 1, gap: 2 },
  toggleLabelHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toggleLabel: { color: colors.text, fontSize: 14, fontWeight: '800' },
  toggleSubLabel: { color: colors.textMuted, fontSize: 11, lineHeight: 14 },

  tabsRow: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 4,
    marginBottom: 8,
  },
  tab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  tabText: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  tabTextActive: { color: colors.cyan },

  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 4,
    paddingVertical: 8,
    marginBottom: spacing.md,
  },
  presetSwatch: {
    width: 56,
    height: 56,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetSwatchActive: {
    borderColor: colors.cyan,
    borderWidth: 3,
  },

  applyBtn: {
    marginTop: 16,
    backgroundColor: colors.cyan,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  applyBtnText: { color: colors.bg, fontSize: 14, fontWeight: '900', letterSpacing: 1 },
});
