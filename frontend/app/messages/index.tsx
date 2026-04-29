/**
 * /messages — list of all conversations with unread badges.
 * Polls every 4 s while focused so new threads / unread counts
 * appear without manual refresh.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
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
import { colors, spacing } from '../../src/theme';
import { api, type DMThread } from '../../src/api';

export default function MessagesIndex() {
  const router = useRouter();
  const [threads, setThreads] = useState<DMThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.messagesThreads();
      setThreads(r.threads || []);
    } catch {}
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      const id = setInterval(load, 4000);
      return () => clearInterval(id);
    }, [load]),
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Messages</Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.cyan} />
        </View>
      ) : threads.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="chatbubbles-outline" size={42} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No conversations yet</Text>
          <Text style={styles.emptyDesc}>
            Open a friend's profile and tap{'\n'}Message to start a chat.
          </Text>
          <TouchableOpacity
            style={styles.emptyBtn}
            onPress={() => router.push('/friends')}
            testID="messages-go-friends"
          >
            <Text style={styles.emptyBtnText}>Open Friends+</Text>
          </TouchableOpacity>
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
              tintColor={colors.cyan}
            />
          }
        >
          {threads.map((t) => (
            <ThreadRow key={t.friend_id} thread={t} onPress={() => router.push(`/messages/${t.friend_id}`)} />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function ThreadRow({ thread, onPress }: { thread: DMThread; onPress: () => void }) {
  const last = thread.last_message;
  const preview = last ? (last.text || '📷 Photo') : 'Say hi!';
  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.row} onPress={onPress} testID={`thread-${thread.friend_id}`}>
      <View style={{ position: 'relative' }}>
        {thread.friend_avatar_base64 ? (
          <Image source={{ uri: `data:image/jpeg;base64,${thread.friend_avatar_base64}` }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarLetter}>{(thread.friend_name || '?').slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        {thread.unread_count > 0 && (
          <View style={styles.unreadDot} testID={`unread-${thread.friend_id}`}>
            <Text style={styles.unreadDotText}>{thread.unread_count > 9 ? '9+' : thread.unread_count}</Text>
          </View>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.name, thread.unread_count > 0 && { color: colors.text, fontWeight: '900' }]} numberOfLines={1}>
          {thread.friend_name}
        </Text>
        <Text style={[styles.preview, thread.unread_count > 0 && { color: colors.text, fontWeight: '700' }]} numberOfLines={1}>
          {preview}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
    </TouchableOpacity>
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
  topTitle: { flex: 1, color: colors.text, fontSize: 18, fontWeight: '900', paddingLeft: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '900', marginTop: 12 },
  emptyDesc: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  emptyBtn: { marginTop: 18, backgroundColor: colors.cyan, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 10 },
  emptyBtnText: { color: colors.bg, fontWeight: '900' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 60,
  },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: { backgroundColor: colors.cyan + '22', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: colors.cyan, fontWeight: '900' },
  unreadDot: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.red,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    borderWidth: 2,
    borderColor: colors.bg,
  },
  unreadDotText: { color: '#fff', fontSize: 10, fontWeight: '900' },
  name: { color: colors.textMuted, fontSize: 14, fontWeight: '700' },
  preview: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
});
