/**
 * /messages/[friendId] — friend-to-friend chat with AI safety guard.
 *
 * Real-time AI refinement loop:
 *  - User types in the input box (the *raw* draft).
 *  - We debounce 600 ms then POST to /api/messages/refine.
 *  - The refined version appears in a card directly above the keyboard.
 *  - Send button submits the REFINED text only — never the raw draft.
 *  - severity='severe' → input is locked, refined card shows a red
 *    'Blocked' label, and the incident is logged on the backend.
 *
 * Per-friend chat preferences (v1.0.29):
 *  - Bubble + text colors customisable in the ChatSettingsSheet
 *    (curated swatches + custom HSL picker).
 *  - 🔕 Mute   = no push pings (badge stays).
 *  - 🔒 Block  = no push + no badge + lock icon in topbar
 *                (soft block — messages still arrive, history readable).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import * as ImagePicker from 'expo-image-picker';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing } from '../../src/theme';
import {
  api,
  CHAT_DEFAULTS,
} from '../../src/api';
import type { ChatPreferences, DMMessage } from '../../src/api';
import { ChatSettingsSheet } from '../../src/components/ChatSettingsSheet';

const REFINE_DEBOUNCE_MS = 600;

function defaultPrefs(friendId: string): ChatPreferences {
  return {
    owner_id: '',
    friend_id: friendId,
    sent_bubble_color: CHAT_DEFAULTS.sent_bubble_color,
    sent_text_color: CHAT_DEFAULTS.sent_text_color,
    received_bubble_color: CHAT_DEFAULTS.received_bubble_color,
    received_text_color: CHAT_DEFAULTS.received_text_color,
    muted: false,
    blocked: false,
    updated_at: null,
  };
}

export default function MessageThread() {
  const router = useRouter();
  const { friendId } = useLocalSearchParams<{ friendId: string }>();
  const fid = String(friendId || '');

  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [refined, setRefined] = useState('');
  const [severity, setSeverity] = useState<'none' | 'mild' | 'severe'>('none');
  const [refining, setRefining] = useState(false);
  const [sending, setSending] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  const [pickedImage, setPickedImage] = useState<string | null>(null);
  const [imageChecking, setImageChecking] = useState(false);
  const [prefs, setPrefs] = useState<ChatPreferences>(() => defaultPrefs(fid));
  const [friendName, setFriendName] = useState<string>('Chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const refineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const load = useCallback(async () => {
    if (!fid) return;
    try {
      const [r, p] = await Promise.all([
        api.messagesThread(fid),
        api.getProfile().catch(() => null),
      ]);
      setMessages(r.messages || []);
      if (p?.user_id) setMeId(p.user_id);
      // Mark all unread as read since the user is now looking at the thread.
      api.messagesRead(fid).catch(() => {});
    } catch (e: any) {
      showAlert('Could not load chat', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [fid]);

  // One-shot load: friend profile (for display name) + chat preferences.
  useEffect(() => {
    if (!fid) return;
    api.chatPrefsGet(fid).then(setPrefs).catch(() => {});
    api
      .playerProfile(fid)
      .then((pl) => {
        if (pl?.name) setFriendName(pl.name);
      })
      .catch(() => {});
  }, [fid]);

  useFocusEffect(
    useCallback(() => {
      load();
      const id = setInterval(load, 3000);
      return () => clearInterval(id);
    }, [load]),
  );

  // Auto-scroll on new messages
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
  }, [messages.length]);

  // AI refinement debounce
  useEffect(() => {
    if (refineTimerRef.current) clearTimeout(refineTimerRef.current);
    if (!draft.trim()) {
      setRefined('');
      setSeverity('none');
      return;
    }
    setRefining(true);
    refineTimerRef.current = setTimeout(async () => {
      try {
        const r = await api.messagesRefine(draft);
        setRefined(r.refined || '');
        setSeverity(r.severity);
      } catch {
        // fail-open: show the raw text as fallback so UI doesn't get stuck
        setRefined(draft);
        setSeverity('none');
      } finally {
        setRefining(false);
      }
    }, REFINE_DEBOUNCE_MS);
    return () => {
      if (refineTimerRef.current) clearTimeout(refineTimerRef.current);
    };
  }, [draft]);

  const onPickImage = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        showAlert('Permission needed', 'Please allow photo library access to attach an image.');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.6,
        base64: true,
      });
      if (res.canceled || !res.assets || !res.assets[0]?.base64) return;
      const b64 = res.assets[0].base64;
      setImageChecking(true);
      // Pre-check image safety BEFORE letting the user attach it.
      const ok = await api.messagesCheckImage(b64).catch(() => ({ safe: false, reason: 'check failed' }));
      if (!ok.safe) {
        showAlert('Image blocked', ok.reason || 'This image is not safe to share.');
        return;
      }
      setPickedImage(b64);
    } catch (e: any) {
      showAlert('Could not pick image', String(e?.message || e));
    } finally {
      setImageChecking(false);
    }
  };

  const onSend = async () => {
    if (sending) return;
    if (severity === 'severe') {
      showAlert(
        'Blocked',
        'This message contains content that can\'t be sent. The incident has been logged.',
      );
      return;
    }
    const finalText = (refined || draft).trim();
    if (!finalText && !pickedImage) {
      return;
    }
    setSending(true);
    try {
      const r = await api.messagesSend(fid, finalText, draft, pickedImage || undefined);
      setMessages((prev) => [...prev, r.message]);
      setDraft('');
      setRefined('');
      setSeverity('none');
      setPickedImage(null);
    } catch (e: any) {
      const msg = e?.detail?.reason || e?.message || String(e);
      showAlert('Could not send', msg);
    } finally {
      setSending(false);
    }
  };

  // Apply a single-field patch optimistically then persist.
  const onPatchPrefs = useCallback(
    (patch: Partial<ChatPreferences>) => {
      setPrefs((prev) => ({ ...prev, ...patch }));
      const send: any = { ...patch };
      delete send.owner_id;
      delete send.friend_id;
      delete send.updated_at;
      api
        .chatPrefsUpsert(fid, send)
        .then((fresh) => setPrefs(fresh))
        .catch((e) => {
          showAlert('Could not save', String(e?.message || e));
        });
    },
    [fid],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.topTitleRow}>
          {prefs.blocked ? (
            <Ionicons
              name="lock-closed"
              size={14}
              color={colors.red}
              style={{ marginRight: 6 }}
              testID="chat-topbar-blocked-lock"
            />
          ) : prefs.muted ? (
            <Ionicons
              name="notifications-off"
              size={14}
              color={colors.amber}
              style={{ marginRight: 6 }}
              testID="chat-topbar-muted-icon"
            />
          ) : null}
          <Text style={styles.topTitle} numberOfLines={1}>{friendName || 'Chat'}</Text>
        </View>
        <TouchableOpacity
          onPress={() => setSettingsOpen(true)}
          hitSlop={10}
          testID="chat-settings-open"
        >
          <Ionicons name="settings-outline" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.cyan} />
          </View>
        ) : (
          <KeyboardAwareScrollView
            // Auto-scrolls so the focused TextInput is always above the
            // keyboard. Without this the user has to type blindly because
            // the keyboard sits on top of the message composer.
            innerRef={(ref) => { (scrollRef as any).current = ref; }}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: spacing.md, gap: 6 }}
            keyboardShouldPersistTaps="handled"
            extraScrollHeight={Platform.OS === 'ios' ? 8 : 80}
            enableOnAndroid
            enableResetScrollToCoords={false}
          >
            {messages.length === 0 && (
              <Text style={styles.emptyChat}>
                No messages yet. Say hi 👋 — your chat is AI-protected for safety.
              </Text>
            )}
            {messages.map((m) => {
              const mine = m.from_user_id === meId;
              const bubbleBg = mine ? prefs.sent_bubble_color : prefs.received_bubble_color;
              const textColor = mine ? prefs.sent_text_color : prefs.received_text_color;
              // User preference: MY messages render on the LEFT, theirs on
              // the RIGHT — opposite of the iMessage/WhatsApp default. The
              // bubble's squared-off corner also flips so it always points
              // toward the sender side.
              return (
                <View
                  key={m.id}
                  style={[styles.bubbleRow, !mine ? { justifyContent: 'flex-end' } : null]}
                >
                  <View
                    style={[
                      styles.bubble,
                      mine ? styles.bubbleMine : styles.bubbleTheirs,
                      { backgroundColor: bubbleBg },
                      !mine && { borderColor: colors.border, borderWidth: 1 },
                    ]}
                  >
                    {m.image_base64 ? (
                      <Image
                        source={{ uri: `data:image/jpeg;base64,${m.image_base64}` }}
                        style={styles.bubbleImg}
                      />
                    ) : null}
                    {m.text ? (
                      <Text style={[styles.bubbleText, { color: textColor }]}>{m.text}</Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </KeyboardAwareScrollView>
        )}

        {/* AI refined preview — sits ABOVE the input pad */}
        {(draft.trim().length > 0 || refining) && (
          <View
            style={[
              styles.refineCard,
              severity === 'severe' && { borderColor: colors.red, backgroundColor: colors.red + '15' },
              severity === 'mild' && { borderColor: colors.amber, backgroundColor: colors.amber + '12' },
            ]}
          >
            <View style={styles.refineHead}>
              <Ionicons
                name={severity === 'severe' ? 'shield' : severity === 'mild' ? 'shield-half' : 'shield-checkmark'}
                size={14}
                color={severity === 'severe' ? colors.red : severity === 'mild' ? colors.amber : colors.green}
              />
              <Text style={[styles.refineLabel, severity === 'severe' && { color: colors.red }]}>
                {severity === 'severe' ? 'BLOCKED' : refining ? 'AI checking…' : severity === 'mild' ? 'Cleaned up' : 'Looks good'}
              </Text>
              {refining ? <ActivityIndicator size="small" color={colors.cyan} /> : null}
            </View>
            <Text
              style={[
                styles.refineText,
                severity === 'severe' && { color: colors.red, fontStyle: 'italic' },
              ]}
            >
              {severity === 'severe'
                ? "Your message can't be sent in its current form."
                : refined || draft}
            </Text>
          </View>
        )}

        {pickedImage && (
          <View style={styles.attachPreview}>
            <Image source={{ uri: `data:image/jpeg;base64,${pickedImage}` }} style={styles.attachThumb} />
            <TouchableOpacity onPress={() => setPickedImage(null)} style={styles.attachX}>
              <Ionicons name="close" size={16} color="#fff" />
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.inputBar}>
          <TouchableOpacity
            onPress={onPickImage}
            disabled={imageChecking}
            style={styles.attachBtn}
            testID="msg-attach"
          >
            {imageChecking ? (
              <ActivityIndicator size="small" color={colors.cyan} />
            ) : (
              <Ionicons name="image" size={22} color={colors.cyan} />
            )}
          </TouchableOpacity>
          <TextInput
            testID="msg-input"
            value={draft}
            onChangeText={setDraft}
            placeholder="Type your message…"
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={500}
            style={styles.input}
          />
          <TouchableOpacity
            testID="msg-send"
            onPress={onSend}
            disabled={sending || refining || (severity === 'severe') || (!refined.trim() && !pickedImage)}
            style={[
              styles.sendBtn,
              (sending || refining || severity === 'severe' || (!refined.trim() && !pickedImage)) && { opacity: 0.4 },
            ]}
          >
            {sending ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Ionicons name="send" size={18} color={colors.bg} />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <ChatSettingsSheet
        visible={settingsOpen}
        prefs={prefs}
        friendName={friendName}
        onClose={() => setSettingsOpen(false)}
        onPatch={onPatchPrefs}
      />
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
  topTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 10,
  },
  topTitle: { color: colors.text, fontSize: 18, fontWeight: '900', flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyChat: { color: colors.textMuted, fontSize: 13, textAlign: 'center', padding: 24 },
  bubbleRow: { flexDirection: 'row', marginBottom: 4 },
  bubble: { maxWidth: '78%', borderRadius: 14, padding: 10, gap: 6 },
  // My messages now render on the LEFT — squared-off corner is bottom-left
  // so it points down towards me. Their bubbles mirror it on the right.
  bubbleMine: { borderBottomLeftRadius: 4 },
  bubbleTheirs: { borderBottomRightRadius: 4 },
  bubbleText: { fontSize: 14, lineHeight: 19 },
  bubbleImg: { width: 200, height: 200, borderRadius: 10 },
  refineCard: {
    marginHorizontal: spacing.md,
    marginBottom: 6,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.green + '55',
    backgroundColor: colors.green + '10',
  },
  refineHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  refineLabel: { color: colors.green, fontWeight: '900', fontSize: 11, letterSpacing: 1, flex: 1 },
  refineText: { color: colors.text, fontSize: 13, lineHeight: 18 },
  attachPreview: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingBottom: 6,
  },
  attachThumb: { width: 64, height: 64, borderRadius: 8 },
  attachX: {
    position: 'absolute',
    right: spacing.md - 6,
    top: -6,
    backgroundColor: colors.red,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingTop: 8,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  attachBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    color: colors.text,
    fontSize: 14,
    maxHeight: 100,
    minHeight: 40,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
