/**
 * /treasure — Buried Treasure entry screen.
 *
 * 2026-06-04 — full redesign per direct product spec:
 *
 *   • The previous "Resume Solo Hunt / Start Hunt / Settings link"
 *     layout is gone.
 *   • Opens straight into TWO big buttons centred on the screen:
 *       PLAY SOLO  ·  PLAY WITH FRIENDS
 *   • Solo is now a single button — it auto-resumes any in-progress
 *     hunt or starts a fresh one if nothing is saved.
 *   • Settings live behind a small gear icon in the top-right corner.
 *
 * State machine:
 *   1. loading  — bootstrap from /api
 *   2. home     — the new two-button hub
 *   3. pickArea — first-time map picker (only shown if no area saved
 *                 yet AND the user clicked one of the play buttons)
 *
 * Pending intents (when the picker fires AFTER a play tap) are stored
 * in `pendingMode` so the area picker knows what to do once confirmed.
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

type Stage = 'loading' | 'home' | 'pickArea';
type PendingMode = 'solo' | 'friends' | null;

export default function TreasureHome() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('loading');
  const [soloHunt, setSoloHunt] = useState<BTSoloHunt | null>(null);
  const [myGroups, setMyGroups] = useState<BTGroup[]>([]);
  // Persistent hunt area from /api/bt/settings. When set the picker is
  // skipped on every subsequent play; users edit it from the gear icon
  // top-right.
  const [savedArea, setSavedArea] = useState<BTAreaPicked | null>(null);
  // What the user intended to do BEFORE we made them pick an area.
  const [pendingMode, setPendingMode] = useState<PendingMode>(null);
  const [busy, setBusy] = useState(false);

  // Bootstrap loads everything in parallel; on first run (no savedArea
  // yet) we DROP STRAIGHT INTO THE MAP PICKER per 2026-06-04 spec so
  // the player picks their hunt area before seeing anything else.
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
        setStage('home');
      } else {
        // First-time visit — force the area picker as the very first
        // thing the user sees. `pendingMode=null` means we just save
        // and return to home; nothing auto-starts.
        setSavedArea(null);
        setPendingMode(null);
        setStage('pickArea');
      }
    } catch (e: any) {
      showAlert('Failed to load', String(e?.message || e));
      setStage('home');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // ── Play Solo (merged "resume" + "new") ────────────────────────────
  // 1. If an active solo hunt is already in progress, jump straight
  //    back into /treasure/solo so the user picks up where they left
  //    off — no extra taps.
  // 2. Otherwise, if we have a saved hunt area, kick off a brand-new
  //    solo hunt against it and go straight into the chase screen.
  // 3. If neither — we need to ask for an area first, so we drop into
  //    the picker stage with `pendingMode='solo'`.
  const onPlaySolo = useCallback(async () => {
    if (busy) return;
    // Active hunt? auto-resume.
    if (soloHunt) {
      router.push('/treasure/solo');
      return;
    }
    if (!savedArea) {
      setPendingMode('solo');
      setStage('pickArea');
      return;
    }
    setBusy(true);
    try {
      await api.btSoloStart(savedArea.lat, savedArea.lng, savedArea.radius_m);
      router.push('/treasure/solo');
    } catch (e: any) {
      showAlert('Could not start hunt', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [busy, soloHunt, savedArea, router]);

  const onPlayFriends = useCallback(() => {
    if (busy) return;
    if (!savedArea) {
      setPendingMode('friends');
      setStage('pickArea');
      return;
    }
    router.push({
      pathname: '/treasure/friends',
      params: {
        lat: String(savedArea.lat),
        lng: String(savedArea.lng),
        radius_m: String(savedArea.radius_m),
      },
    });
  }, [busy, savedArea, router]);

  // After the picker fires (first-run only), persist the area and then
  // honour whatever the user originally clicked.
  const onAreaConfirmed = useCallback(async (area: BTAreaPicked) => {
    const mode = pendingMode;
    setSavedArea(area);
    setPendingMode(null);
    setStage('home');
    // Fire-and-forget settings save — failure here is non-blocking and
    // the user can re-edit from the gear icon any time.
    api.btSaveSettings(area.lat, area.lng, area.radius_m).catch(() => {});
    if (mode === 'solo') {
      setBusy(true);
      try {
        await api.btSoloStart(area.lat, area.lng, area.radius_m);
        router.push('/treasure/solo');
      } catch (e: any) {
        showAlert('Could not start hunt', String(e?.message || e));
      } finally {
        setBusy(false);
      }
    } else if (mode === 'friends') {
      router.push({
        pathname: '/treasure/friends',
        params: {
          lat: String(area.lat),
          lng: String(area.lng),
          radius_m: String(area.radius_m),
        },
      });
    }
  }, [pendingMode, router]);

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
          <TouchableOpacity
            onPress={() => { setPendingMode(null); setStage('home'); }}
            style={styles.headerBtn}
            testID="bt-back-from-picker"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Pick your hunt area</Text>
          <View style={styles.headerBtn} />
        </View>
        <BTMapPicker
          onConfirm={onAreaConfirmed}
          initialRadius={800}
          title={
            !savedArea && pendingMode === null
              ? 'Welcome! Pick where you want to hunt.'
              : 'Pick your hunt area'
          }
          confirmLabel={
            pendingMode === 'solo' ? 'Save & start solo hunt'
              : pendingMode === 'friends' ? 'Save & go to friends'
              : 'Done · Save my hunt area'
          }
        />
      </SafeAreaView>
    );
  }

  // home
  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Buried Treasure</Text>
        {/* Settings gear (top-right) — only entry point to the area /
            awake-hours settings screen now that the inline link is gone. */}
        <TouchableOpacity
          onPress={() => router.push('/treasure/settings')}
          style={styles.headerBtn}
          activeOpacity={0.7}
          testID="bt-open-settings"
        >
          <Ionicons name="settings-outline" size={22} color={colors.cyan} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Ionicons name="map" size={42} color={colors.cyan} />
          <Text style={styles.heroTitle}>Find chests buried near you.</Text>
          <Text style={styles.heroSub}>
            Pick an area on the map, set how wide the hunt is, then play
            solo or with friends. Get within 15 m of the chest and snap a
            photo to claim 100 XP.
          </Text>
        </View>

        {/* ───────── Two BIG buttons in the centre ───────── */}
        <View style={styles.ctaStack}>
          <TouchableOpacity
            style={[styles.bigBtn, { backgroundColor: colors.cyan }]}
            activeOpacity={0.85}
            disabled={busy}
            onPress={onPlaySolo}
            testID="bt-play-solo"
          >
            <Ionicons name="person" size={26} color="#0b0f15" />
            <View style={{ flex: 1 }}>
              <Text style={styles.bigBtnTitle}>PLAY SOLO</Text>
              <Text style={styles.bigBtnSub}>
                {soloHunt ? 'Resume your hunt in progress' : 'Find a randomly-buried chest near you'}
              </Text>
            </View>
            {busy ? (
              <ActivityIndicator color="#0b0f15" />
            ) : (
              <Ionicons name="chevron-forward" size={20} color="#0b0f15" />
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.bigBtn, { backgroundColor: '#FFD166' }]}
            activeOpacity={0.85}
            disabled={busy}
            onPress={onPlayFriends}
            testID="bt-play-friends"
          >
            <Ionicons name="people" size={26} color="#0b0f15" />
            <View style={{ flex: 1 }}>
              <Text style={styles.bigBtnTitle}>PLAY WITH FRIENDS</Text>
              <Text style={styles.bigBtnSub}>Bury a chest, race your crew</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#0b0f15" />
          </TouchableOpacity>
        </View>

        {/* ───────── Compact "your groups" list ─────────
            Kept as a single compact rail so users can dive back into
            an existing group without going through the friends hub.
            Intentionally minimal — the main two CTAs above are the
            only "primary" buttons on this screen. */}
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
                  {g.status !== 'finished' && g.is_active_now === false ? (
                    <View style={styles.inactivePill}>
                      <Ionicons name="moon" size={10} color="#FFB020" />
                      <Text style={styles.inactivePillText}>INACTIVE · NO ONE AWAKE</Text>
                    </View>
                  ) : null}
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
  scroll: { padding: spacing.md, gap: spacing.lg, paddingBottom: spacing.xl ?? 32 },
  hero: {
    alignItems: 'center', padding: spacing.lg, gap: 10,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
  },
  heroTitle: { color: colors.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  heroSub: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  // CTA stack — kept slightly larger than typical buttons so it reads
  // like the "main action area" of the screen.
  ctaStack: { gap: spacing.md, marginTop: spacing.sm },
  bigBtn: {
    borderRadius: radii.lg, paddingVertical: 22, paddingHorizontal: spacing.md,
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  bigBtnTitle: { color: '#0b0f15', fontWeight: '900', fontSize: 16, letterSpacing: 1 },
  bigBtnSub: { color: '#0b0f15CC', fontSize: 12, marginTop: 3 },
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
  inactivePill: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999,
    borderWidth: 1, borderColor: '#FFB02055',
    backgroundColor: '#FFB02022',
    marginTop: 4,
  },
  inactivePillText: { color: '#FFB020', fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
});
