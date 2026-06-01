/**
 * /treasure — Buried Treasure entry screen.
 *
 * State machine:
 *   1. Loading        → fetch any current solo hunt + groups I'm in
 *   2. Idle           → no current hunts → big START HUNT button
 *   3. PickArea       → BTMapPicker, user confirms area + radius
 *   4. PickMode       → "Play Solo" / "Play with Friends"
 *
 * Resuming an in-progress solo hunt skips straight to /treasure/solo.
 * Active groups are listed at the bottom so you can jump back into them.
 */
import React, { useCallback, useState } from 'react';
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
import { api, type BTGroup, type BTSoloHunt } from '../../src/api';
import { colors, radii, spacing } from '../../src/theme';
import { showAlert } from '../../src/uiAlert';

type Stage = 'loading' | 'idle' | 'pickArea' | 'pickMode';

export default function TreasureHome() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('loading');
  const [soloHunt, setSoloHunt] = useState<BTSoloHunt | null>(null);
  const [myGroups, setMyGroups] = useState<BTGroup[]>([]);
  const [pickedArea, setPickedArea] = useState<BTAreaPicked | null>(null);
  // Persistent area saved on first run from /api/bt/settings. When set
  // we skip the BTMapPicker entirely on subsequent opens — the user
  // can only change the area from /treasure/settings.
  const [savedArea, setSavedArea] = useState<BTAreaPicked | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setStage('loading');
    try {
      const [s, g, settings] = await Promise.all([
        api.btSoloCurrent().catch(() => ({ hunt: null })),
        api.btGroupsMine().catch(() => ({ groups: [] as BTGroup[] })),
        api.btGetSettings().catch(() => ({ area: null as any })),
      ]);
      setSoloHunt(s.hunt || null);
      setMyGroups(g.groups || []);
      if (settings?.area) {
        setSavedArea({
          lat: settings.area.lat,
          lng: settings.area.lng,
          radius_m: settings.area.radius_m,
        });
      } else {
        setSavedArea(null);
      }
      setStage('idle');
    } catch (e: any) {
      showAlert('Failed to load', String(e?.message || e));
      setStage('idle');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onAreaConfirmed = useCallback((area: BTAreaPicked) => {
    setPickedArea(area);
    setStage('pickMode');
  }, []);

  const startSolo = useCallback(async () => {
    if (!pickedArea || busy) return;
    setBusy(true);
    try {
      await api.btSoloStart(pickedArea.lat, pickedArea.lng, pickedArea.radius_m);
      router.replace('/treasure/solo');
    } catch (e: any) {
      showAlert('Could not start hunt', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [pickedArea, busy, router]);

  const startFriends = useCallback(() => {
    if (!pickedArea) return;
    router.push({
      pathname: '/treasure/friends',
      params: {
        lat: String(pickedArea.lat),
        lng: String(pickedArea.lng),
        radius_m: String(pickedArea.radius_m),
      },
    });
  }, [pickedArea, router]);

  // ───────────────────────── render ─────────────────────────
  if (stage === 'loading') {
    return (
      <SafeAreaView style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  if (stage === 'pickArea') {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setStage('idle')} style={styles.headerBtn} testID="bt-back">
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Buried Treasure</Text>
          <View style={styles.headerBtn} />
        </View>
        <BTMapPicker onConfirm={onAreaConfirmed} />
      </SafeAreaView>
    );
  }

  if (stage === 'pickMode' && pickedArea) {
    const radiusLabel = pickedArea.radius_m >= 1000
      ? `${(pickedArea.radius_m / 1000).toFixed(1)} km`
      : `${Math.round(pickedArea.radius_m)} m`;
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setStage('pickArea')} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>How do you want to play?</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.modeBody}>
          <View style={styles.areaPill}>
            <Ionicons name="location" size={14} color={colors.cyan} />
            <Text style={styles.areaPillText}>Hunt area · {radiusLabel}</Text>
          </View>
          <TouchableOpacity
            style={[styles.bigBtn, { backgroundColor: colors.cyan }]}
            activeOpacity={0.85}
            disabled={busy}
            onPress={startSolo}
            testID="bt-mode-solo"
          >
            <Ionicons name="person" size={26} color="#0b0f15" />
            <View>
              <Text style={styles.bigBtnTitle}>PLAY SOLO</Text>
              <Text style={styles.bigBtnSub}>Find a randomly-buried chest near you</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.bigBtn, { backgroundColor: '#FFD166' }]}
            activeOpacity={0.85}
            onPress={startFriends}
            testID="bt-mode-friends"
          >
            <Ionicons name="people" size={26} color="#0b0f15" />
            <View>
              <Text style={styles.bigBtnTitle}>PLAY WITH FRIENDS</Text>
              <Text style={styles.bigBtnSub}>Bury a chest, race your crew</Text>
            </View>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // idle
  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Buried Treasure</Text>
        <View style={styles.headerBtn} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
        <View style={styles.hero}>
          <Ionicons name="map" size={42} color={colors.cyan} />
          <Text style={styles.heroTitle}>Find chests buried near you.</Text>
          <Text style={styles.heroSub}>
            Pick an area on the map, set how wide the hunt is, then play
            solo or with friends. Get within 15 m of the chest and snap a
            photo to claim 100 XP.
          </Text>
        </View>

        {soloHunt ? (
          <TouchableOpacity
            style={styles.resumeCard}
            activeOpacity={0.85}
            onPress={() => router.push('/treasure/solo')}
            testID="bt-resume-solo"
          >
            <Ionicons name="flame" size={22} color={colors.cyan} />
            <View style={{ flex: 1 }}>
              <Text style={styles.resumeTitle}>Resume solo hunt</Text>
              <Text style={styles.resumeSub}>Your chest is still waiting to be found.</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={styles.startBtn}
          activeOpacity={0.85}
          onPress={() => setStage('pickArea')}
          testID="bt-start-hunt"
        >
          <Ionicons name="play" size={20} color="#0b0f15" />
          <Text style={styles.startBtnText}>START HUNT</Text>
        </TouchableOpacity>

        {myGroups.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>YOUR GROUPS</Text>
            {myGroups.map((g) => (
              <TouchableOpacity
                key={g.id}
                style={styles.groupRow}
                onPress={() => router.push(`/treasure/group/${g.id}`)}
                activeOpacity={0.85}
              >
                <Ionicons
                  name={
                    g.status === 'lobby' ? 'people-circle-outline' :
                    g.status === 'hunting' ? 'flag' : 'trophy'
                  }
                  size={22}
                  color={
                    g.status === 'lobby' ? colors.amber :
                    g.status === 'hunting' ? colors.cyan : '#22C55E'
                  }
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.groupName}>{g.name}</Text>
                  <Text style={styles.groupSub}>
                    {g.status === 'lobby' ? 'Waiting for invites · ' :
                     g.status === 'hunting' ? 'Hunting · ' : 'Finished · '}
                    {g.members.length} member{g.members.length === 1 ? '' : 's'}
                  </Text>
                </View>
                <Text style={styles.groupCode}>{g.code}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
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
  hero: {
    alignItems: 'center', padding: spacing.lg, gap: 10,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
  },
  heroTitle: { color: colors.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  heroSub: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  startBtn: {
    backgroundColor: colors.cyan, borderRadius: radii.lg,
    paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  startBtnText: { color: '#0b0f15', fontWeight: '900', fontSize: 16, letterSpacing: 1 },
  resumeCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.cyan + '15', borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.cyan + '55', padding: spacing.md,
  },
  resumeTitle: { color: colors.text, fontWeight: '800', fontSize: 14 },
  resumeSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  modeBody: { padding: spacing.md, gap: spacing.md },
  areaPill: {
    alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999,
    borderWidth: 1, borderColor: colors.cyan + '55', backgroundColor: colors.cyan + '15',
  },
  areaPillText: { color: colors.cyan, fontWeight: '800', fontSize: 11, letterSpacing: 0.5 },
  bigBtn: {
    borderRadius: radii.lg, padding: spacing.md,
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  bigBtnTitle: { color: '#0b0f15', fontWeight: '900', fontSize: 15, letterSpacing: 1 },
  bigBtnSub: { color: '#0b0f15CC', fontSize: 11, marginTop: 2 },
  section: { marginTop: spacing.md, gap: 8 },
  sectionTitle: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  groupRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: spacing.md, backgroundColor: colors.surface,
    borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
  },
  groupName: { color: colors.text, fontWeight: '800' },
  groupSub: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  groupCode: { color: colors.cyan, fontWeight: '900', letterSpacing: 1, fontSize: 12 },
});
