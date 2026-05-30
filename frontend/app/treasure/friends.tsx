/**
 * /treasure/friends — Group hub.
 *
 * Two paths in:
 *   1. From /treasure pickMode — we've just picked an area and want
 *      to CREATE a new group. We receive lat / lng / radius_m as
 *      route params and surface a big primary CREATE button.
 *   2. From the home tab when groups already exist — same screen,
 *      but the CREATE button just shows a hint to start from /treasure.
 *
 * Always shows:
 *   - Friend-created groups that are still in the lobby (join)
 *   - "Enter Group Code" input + button
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api, type BTGroup } from '../../src/api';
import { colors, radii, spacing } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

export default function TreasureFriends() {
  const router = useRouter();
  const params = useLocalSearchParams<{ lat?: string; lng?: string; radius_m?: string }>();
  const hasPickedArea = !!(params.lat && params.lng && params.radius_m);

  const [available, setAvailable] = useState<BTGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.btGroupsAvailable();
      setAvailable(r.groups || []);
    } catch (e: any) {
      // 4xx is OK — just show empty list
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onCreate = useCallback(() => {
    if (!hasPickedArea) {
      showAlert(
        'Pick an area first',
        'Open Buried Treasure → START HUNT, confirm where you are, then come back to create a group.',
      );
      return;
    }
    router.push({
      pathname: '/treasure/group-create',
      params: {
        lat: String(params.lat),
        lng: String(params.lng),
        radius_m: String(params.radius_m),
      },
    });
  }, [hasPickedArea, params, router]);

  const onJoinCode = useCallback(async () => {
    const c = code.trim().toUpperCase();
    if (c.length < 4) {
      showAlert('Enter a group code', 'Group codes are 6 characters.');
      return;
    }
    setJoining(true);
    try {
      const g = await api.btGroupJoinByCode(c);
      router.replace(`/treasure/group/${g.id}`);
    } catch (e: any) {
      showAlert('Could not join', String(e?.message || e));
    } finally {
      setJoining(false);
    }
  }, [code, router]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Play with Friends</Text>
        <View style={styles.headerBtn} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
        <TouchableOpacity
          style={[styles.primaryBtn, !hasPickedArea && styles.btnDisabled]}
          onPress={onCreate}
          activeOpacity={0.85}
          testID="bt-create-group"
        >
          <Ionicons name="add-circle" size={22} color="#0b0f15" />
          <Text style={styles.primaryBtnText}>CREATE YOUR OWN GROUP</Text>
        </TouchableOpacity>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>OR</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Enter group code */}
        <View style={styles.codeRow}>
          <View style={styles.codeInputWrap}>
            <Ionicons name="key" size={16} color={colors.cyan} />
            <TextInput
              value={code}
              onChangeText={(t) => setCode(t.toUpperCase().slice(0, 6))}
              placeholder="Enter 6-char code"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="characters"
              maxLength={6}
              style={styles.codeInput}
              testID="bt-code-input"
            />
          </View>
          <TouchableOpacity
            style={[styles.joinBtn, joining && { opacity: 0.5 }]}
            disabled={joining}
            onPress={onJoinCode}
            testID="bt-join-code"
          >
            {joining ? <ActivityIndicator color="#0b0f15" /> : <Text style={styles.joinBtnText}>JOIN</Text>}
          </TouchableOpacity>
        </View>

        {/* Friend-created lobbies */}
        <Text style={styles.sectionTitle}>JOIN ANOTHER GROUP</Text>
        {loading ? (
          <ActivityIndicator color={colors.cyan} style={{ marginVertical: 20 }} />
        ) : available.length === 0 ? (
          <View style={styles.emptyBlock}>
            <Ionicons name="people-outline" size={26} color={colors.textMuted} />
            <Text style={styles.emptyText}>
              None of your friends have an open lobby right now. Use a code above or invite
              your friends to your own group.
            </Text>
          </View>
        ) : (
          available.map((g) => (
            <TouchableOpacity
              key={g.id}
              style={styles.groupRow}
              activeOpacity={0.85}
              onPress={() => router.push(`/treasure/group/${g.id}`)}
            >
              <Ionicons name="people-circle" size={26} color={colors.cyan} />
              <View style={{ flex: 1 }}>
                <Text style={styles.groupName}>{g.name}</Text>
                <Text style={styles.groupSub}>
                  {g.members.length} member{g.members.length === 1 ? '' : 's'} · code {g.code}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          ))
        )}
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
  primaryBtn: {
    backgroundColor: colors.cyan,
    borderRadius: radii.lg,
    paddingVertical: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  primaryBtnText: { color: '#0b0f15', fontWeight: '900', fontSize: 14, letterSpacing: 0.7 },
  btnDisabled: { opacity: 0.55 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  codeRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  codeInputWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12,
  },
  codeInput: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '800', letterSpacing: 3, paddingVertical: 12 },
  joinBtn: {
    backgroundColor: colors.amber, borderRadius: radii.md,
    paddingHorizontal: 18, paddingVertical: 12,
  },
  joinBtnText: { color: '#0b0f15', fontWeight: '900', letterSpacing: 1 },
  sectionTitle: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1, marginTop: spacing.md },
  emptyBlock: {
    alignItems: 'center', padding: spacing.lg, gap: 6,
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
  },
  emptyText: { color: colors.textSecondary, fontSize: 12, textAlign: 'center', lineHeight: 17, maxWidth: 280 },
  groupRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: spacing.md, backgroundColor: colors.surface,
    borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
  },
  groupName: { color: colors.text, fontWeight: '800' },
  groupSub: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
});
