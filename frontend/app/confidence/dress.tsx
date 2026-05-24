/**
 * Dress with Confidence — AI outfit coach.
 *
 * Flow:
 *   1. User snaps / picks a selfie of their outfit (expo-image-picker).
 *   2. Optionally we auto-fetch their location → weather (open-meteo) so
 *      the AI can mention "it's chilly, layer up" style practical tips.
 *   3. User picks an event chip (Office, Casual, Date, Party, Outside…)
 *      and types a question (e.g. "Is this good for a job interview?").
 *   4. AI replies with a confidence-boosting + honest-feedback answer.
 *   5. Each conversation is saved to history (gallery view at top).
 *
 * Goals:
 *   - REMOVE doubt, not amplify it. Always start with a specific compliment.
 *   - Be honest: gentle "swap X for Y" suggestions when warranted.
 *   - Practical: factor weather + event into the verdict.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Image,
  KeyboardAvoidingView,
  Platform,
  Modal,
  FlatList,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { api } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

type ChatTurn = { role: 'user' | 'assistant'; content: string; photo?: string };

type HistoryItem = {
  id: string;
  message: string;
  reply: string;
  event_context?: string;
  weather_hint?: string;
  thumbnail_base64?: string | null;
  has_photo: boolean;
  created_at: string;
};

const EVENTS: { id: string; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { id: '', label: 'No event', icon: 'help-circle-outline' },
  { id: 'casual', label: 'Casual', icon: 'walk' },
  { id: 'office', label: 'Office', icon: 'briefcase' },
  { id: 'date', label: 'Date', icon: 'heart' },
  { id: 'party', label: 'Party', icon: 'wine' },
  { id: 'outside', label: 'Outside', icon: 'leaf' },
  { id: 'gym', label: 'Gym', icon: 'barbell' },
  { id: 'interview', label: 'Interview', icon: 'document-text' },
];

const ACCENT = '#FFD700'; // gold — distinct from social/physical/gratitude

export default function DressTrack() {
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [event, setEvent] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [sending, setSending] = useState(false);

  // Weather
  const [weatherHint, setWeatherHint] = useState<string>('');
  const [weatherLoading, setWeatherLoading] = useState(false);

  // History
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRefresh, setHistoryRefresh] = useState(false);

  const scrollRef = useRef<ScrollView>(null);

  // ── Weather: ask once on mount, gracefully no-op if denied ────────
  const fetchWeather = useCallback(async (silent = true) => {
    if (Platform.OS === 'web') return; // web preview rarely has GPS
    setWeatherLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (!silent) showAlert('Location off', 'Allow location to factor weather into outfit advice.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Lowest });
      const w = await api.confidenceWeather(pos.coords.latitude, pos.coords.longitude);
      if (w?.hint) setWeatherHint(w.hint);
    } catch (e: any) {
      if (!silent) showAlert('Weather unavailable', String(e?.message || e));
    } finally {
      setWeatherLoading(false);
    }
  }, []);

  useEffect(() => { fetchWeather(true); }, [fetchWeather]);

  // ── Photo picker ──────────────────────────────────────────────────
  const pickPhoto = async (source: 'camera' | 'library') => {
    try {
      const perm = source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        showAlert('Permission needed', `Allow ${source === 'camera' ? 'camera' : 'photos'} access to attach an outfit picture.`);
        return;
      }
      const opts: ImagePicker.ImagePickerOptions = {
        allowsEditing: false,
        quality: 0.7,
        base64: true,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      };
      const r = source === 'camera'
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
      if (r.canceled) return;
      const asset = r.assets?.[0];
      if (!asset?.base64) {
        showAlert('Could not load photo', 'Try again or pick a different photo.');
        return;
      }
      setPhotoBase64(asset.base64);
      setPhotoPreview(asset.uri);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch (e: any) {
      showAlert('Photo error', String(e?.message || e));
    }
  };

  const removePhoto = () => {
    setPhotoBase64(null);
    setPhotoPreview(null);
  };

  // ── Send to AI ─────────────────────────────────────────────────────
  const send = async () => {
    const q = message.trim();
    if (!q || sending) return;
    if (!photoBase64 && chat.length === 0) {
      showAlert('Add a selfie first', 'Snap or pick a photo of your outfit so the coach can give specific feedback.');
      return;
    }
    setSending(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

    // Push user turn immediately so the UI feels snappy.
    const userTurn: ChatTurn = { role: 'user', content: q, photo: photoPreview ?? undefined };
    const nextChat = [...chat, userTurn];
    setChat(nextChat);
    setMessage('');

    // Send only the previous chat (the API already has the new message
    // separately). We trim photos from history to keep payload small.
    const apiHistory = chat.map(t => ({ role: t.role, content: t.content }));

    try {
      const r = await api.confidenceDressAdvice({
        photo_base64: photoBase64 || undefined,
        message: q,
        event_context: event || undefined,
        weather_hint: weatherHint || undefined,
        history: apiHistory,
      });
      setChat([...nextChat, { role: 'assistant', content: r.reply }]);
      // Auto-scroll to bottom after a tick
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    } catch (e: any) {
      setChat([...nextChat, { role: 'assistant', content: '⚠️ Could not reach the coach: ' + String(e?.message || e) }]);
    } finally {
      setSending(false);
    }
  };

  // Once a conversation has at least one assistant reply, fold the picker
  // pane up so the chat fills the screen. Keep a "swap photo" button.
  const hasChat = chat.length > 0;

  // ── History ───────────────────────────────────────────────────────
  const openHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const r = await api.confidenceDressHistory(40);
      setHistory(r.items || []);
    } catch (e: any) {
      showAlert('Could not load history', String(e?.message || e));
    } finally {
      setHistoryLoading(false);
    }
  };

  const refreshHistory = async () => {
    setHistoryRefresh(true);
    try {
      const r = await api.confidenceDressHistory(40);
      setHistory(r.items || []);
    } catch {/* silent */}
    finally { setHistoryRefresh(false); }
  };

  const deleteHistory = async (id: string) => {
    try {
      await api.confidenceDressHistoryDelete(id);
      setHistory(prev => prev.filter(h => h.id !== id));
    } catch (e: any) {
      showAlert('Could not delete', String(e?.message || e));
    }
  };

  const startFresh = () => {
    setChat([]);
    setMessage('');
    setPhotoBase64(null);
    setPhotoPreview(null);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name="shirt" size={16} color={ACCENT} />
          <Text style={styles.title}>Dress with Confidence</Text>
        </View>
        <TouchableOpacity onPress={openHistory} style={styles.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} testID="dress-history-btn">
          <Ionicons name="time-outline" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 24 : 0}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: 120 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Photo card */}
          <View style={styles.photoCard}>
            {photoPreview ? (
              <View style={{ position: 'relative' }}>
                <Image source={{ uri: photoPreview }} style={styles.photo} resizeMode="cover" />
                <TouchableOpacity onPress={removePhoto} style={styles.photoClear} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="close" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.photoEmpty}>
                <Ionicons name="shirt-outline" size={36} color={ACCENT} />
                <Text style={styles.photoEmptyText}>Snap a selfie of your outfit</Text>
                <Text style={styles.photoEmptyHint}>The coach reads colours, fit & vibe to give specific feedback</Text>
              </View>
            )}
            <View style={styles.photoBtnRow}>
              <TouchableOpacity onPress={() => pickPhoto('camera')} style={[styles.photoBtn, { borderColor: ACCENT + '88' }]} testID="dress-camera-btn">
                <Ionicons name="camera" size={16} color={ACCENT} />
                <Text style={[styles.photoBtnText, { color: ACCENT }]}>Camera</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => pickPhoto('library')} style={[styles.photoBtn, { borderColor: colors.cyan + '88' }]} testID="dress-library-btn">
                <Ionicons name="images" size={16} color={colors.cyan} />
                <Text style={[styles.photoBtnText, { color: colors.cyan }]}>Library</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Context row: weather + event */}
          <View style={styles.contextCard}>
            <TouchableOpacity onPress={() => fetchWeather(false)} activeOpacity={0.85} style={styles.weatherRow} testID="dress-weather-btn">
              <Ionicons name="partly-sunny" size={16} color={colors.cyan} />
              {weatherLoading ? (
                <ActivityIndicator size="small" color={colors.cyan} />
              ) : (
                <Text style={styles.weatherText} numberOfLines={1}>
                  {weatherHint ? weatherHint : 'Tap to add local weather'}
                </Text>
              )}
              <Ionicons name="refresh" size={14} color={colors.textMuted} />
            </TouchableOpacity>

            <Text style={styles.eventLabel}>What's the occasion?</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {EVENTS.map(e => {
                const active = event === e.id;
                return (
                  <TouchableOpacity
                    key={e.id || 'none'}
                    onPress={() => { setEvent(e.id); Haptics.selectionAsync().catch(() => {}); }}
                    style={[styles.eventChip, active && { backgroundColor: ACCENT + '22', borderColor: ACCENT }]}
                    testID={`dress-event-${e.id || 'none'}`}
                  >
                    <Ionicons name={e.icon} size={12} color={active ? ACCENT : colors.textMuted} />
                    <Text style={[styles.eventChipText, active && { color: ACCENT }]}>{e.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* Chat thread */}
          {hasChat && (
            <View style={{ gap: spacing.sm }}>
              {chat.map((t, i) => (
                <View
                  key={i}
                  style={[
                    styles.bubble,
                    t.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant,
                  ]}
                >
                  {t.role === 'assistant' && (
                    <View style={styles.coachBadge}>
                      <Ionicons name="sparkles" size={10} color={ACCENT} />
                      <Text style={styles.coachBadgeText}>Style Coach</Text>
                    </View>
                  )}
                  {t.photo && (
                    <Image source={{ uri: t.photo }} style={styles.bubblePhoto} resizeMode="cover" />
                  )}
                  <Text style={styles.bubbleText}>{t.content}</Text>
                </View>
              ))}
              {sending && (
                <View style={[styles.bubble, styles.bubbleAssistant, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                  <ActivityIndicator size="small" color={ACCENT} />
                  <Text style={[styles.bubbleText, { color: colors.textMuted }]}>Coach is thinking…</Text>
                </View>
              )}
              <TouchableOpacity onPress={startFresh} style={styles.startFreshBtn}>
                <Ionicons name="refresh" size={12} color={colors.textMuted} />
                <Text style={styles.startFreshText}>Start a new outfit</Text>
              </TouchableOpacity>
            </View>
          )}

          {!hasChat && (
            <View style={styles.suggestCard}>
              <Text style={styles.suggestTitle}>Ask the coach</Text>
              {[
                'Does this look good for the office?',
                'Is this date-night ready?',
                'Should I add layers?',
                'What can I swap to elevate this fit?',
              ].map((s, i) => (
                <TouchableOpacity key={i} onPress={() => setMessage(s)} style={styles.suggestRow}>
                  <Ionicons name="chatbubble-ellipses-outline" size={14} color={ACCENT} />
                  <Text style={styles.suggestText}>{s}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </ScrollView>

        {/* Composer */}
        <View style={styles.composer}>
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder={hasChat ? 'Reply to the coach…' : 'Ask anything about your outfit…'}
            placeholderTextColor={colors.textMuted}
            style={styles.composerInput}
            multiline
            maxLength={500}
            testID="dress-input"
          />
          <TouchableOpacity
            onPress={send}
            disabled={sending || !message.trim()}
            style={[styles.sendBtn, (sending || !message.trim()) && { opacity: 0.5 }]}
            testID="dress-send-btn"
          >
            {sending ? <ActivityIndicator color={colors.bg} size="small" /> : <Ionicons name="arrow-up" size={18} color={colors.bg} />}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* History modal */}
      <Modal visible={historyOpen} animationType="slide" onRequestClose={() => setHistoryOpen(false)}>
        <SafeAreaView style={styles.safe} edges={['top']}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => setHistoryOpen(false)} style={styles.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.title}>Outfit History</Text>
            <View style={{ width: 32 }} />
          </View>
          {historyLoading && history.length === 0 ? (
            <ActivityIndicator color={ACCENT} style={{ marginTop: 40 }} />
          ) : history.length === 0 ? (
            <View style={styles.emptyHistory}>
              <Ionicons name="shirt-outline" size={36} color={colors.textMuted} />
              <Text style={styles.emptyHistoryText}>No outfits yet</Text>
              <Text style={styles.emptyHistoryHint}>Your past outfit checks will show up here.</Text>
            </View>
          ) : (
            <FlatList
              data={history}
              keyExtractor={item => item.id}
              contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: 64 }}
              refreshControl={<RefreshControl refreshing={historyRefresh} onRefresh={refreshHistory} tintColor={ACCENT} />}
              renderItem={({ item }) => (
                <HistoryCard item={item} onDelete={() => deleteHistory(item.id)} />
              )}
            />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function HistoryCard({ item, onDelete }: { item: HistoryItem; onDelete: () => void }) {
  const date = useMemo(() => {
    try {
      const d = new Date(item.created_at);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' +
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
  }, [item.created_at]);

  return (
    <View style={styles.historyCard}>
      {item.thumbnail_base64 ? (
        <Image
          source={{ uri: `data:image/jpeg;base64,${item.thumbnail_base64}` }}
          style={styles.historyThumb}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.historyThumb, { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }]}>
          <Ionicons name="chatbubbles-outline" size={20} color={colors.textMuted} />
        </View>
      )}
      <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.historyDate}>{date}</Text>
          {item.event_context ? (
            <View style={styles.historyChip}>
              <Text style={styles.historyChipText}>{item.event_context}</Text>
            </View>
          ) : null}
        </View>
        {item.message ? <Text style={styles.historyQ} numberOfLines={2}>“{item.message}”</Text> : null}
        <Text style={styles.historyA} numberOfLines={4}>{item.reply}</Text>
      </View>
      <TouchableOpacity onPress={onDelete} style={styles.historyDelete} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontWeight: '900', fontSize: 17 },

  // Photo card
  photoCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: ACCENT + '33',
    overflow: 'hidden',
  },
  photo: { width: '100%', height: 280, backgroundColor: '#000' },
  photoClear: {
    position: 'absolute', top: 8, right: 8,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  photoEmpty: {
    paddingVertical: 36, paddingHorizontal: spacing.md,
    alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  photoEmptyText: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 4 },
  photoEmptyHint: { color: colors.textMuted, fontSize: 12, textAlign: 'center', maxWidth: 260 },
  photoBtnRow: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.border },
  photoBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, borderRadius: radii.sm, borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  photoBtnText: { fontSize: 13, fontWeight: '800' },

  // Context card (weather + event)
  contextCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 10,
  },
  weatherRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 6,
  },
  weatherText: { color: colors.text, fontSize: 12, flex: 1 },
  eventLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 4 },
  eventChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 999, borderWidth: 1, borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  eventChipText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },

  // Chat
  bubble: {
    padding: 12, borderRadius: radii.md,
    borderWidth: 1,
    maxWidth: '95%',
  },
  bubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: colors.cyan + '15',
    borderColor: colors.cyan + '55',
  },
  bubbleAssistant: {
    alignSelf: 'flex-start',
    backgroundColor: ACCENT + '12',
    borderColor: ACCENT + '55',
  },
  bubbleText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  bubblePhoto: {
    width: 120, height: 160, borderRadius: radii.sm, marginBottom: 8,
    backgroundColor: '#000',
  },
  coachBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4, backgroundColor: ACCENT + '22',
    marginBottom: 6,
  },
  coachBadgeText: { color: ACCENT, fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },

  startFreshBtn: {
    alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 8, paddingHorizontal: 12,
  },
  startFreshText: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },

  // Suggestions
  suggestCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md,
    gap: 8,
  },
  suggestTitle: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  suggestRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  suggestText: { color: colors.text, fontSize: 13, flex: 1 },

  // Composer
  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    padding: spacing.md,
    borderTopWidth: 1, borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  composerInput: {
    flex: 1, color: colors.text, fontSize: 14,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10,
    maxHeight: 120,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: ACCENT,
    alignItems: 'center', justifyContent: 'center',
  },

  // History
  historyCard: {
    flexDirection: 'row', gap: 12,
    padding: 10,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
  },
  historyThumb: {
    width: 64, height: 80, borderRadius: radii.sm,
    backgroundColor: '#000',
  },
  historyDate: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  historyChip: {
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: ACCENT + '22',
  },
  historyChipText: { color: ACCENT, fontSize: 9, fontWeight: '900', letterSpacing: 0.8, textTransform: 'uppercase' },
  historyQ: { color: colors.text, fontSize: 12, fontStyle: 'italic', opacity: 0.85 },
  historyA: { color: colors.text, fontSize: 12, lineHeight: 17, opacity: 0.95 },
  historyDelete: { width: 28, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 4 },

  emptyHistory: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 60 },
  emptyHistoryText: { color: colors.text, fontSize: 14, fontWeight: '800', marginTop: 8 },
  emptyHistoryHint: { color: colors.textMuted, fontSize: 12, textAlign: 'center', maxWidth: 260 },
});
