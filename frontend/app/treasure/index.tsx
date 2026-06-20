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

type PendingInvite = {
  group_id: string;
  group_name: string;
  creator_name: string;
  created_at: string;
};

type PendingReport = {
  report_id: string;
  source: 'solo' | 'group';
  group_name: string | null;
  category: 'chest' | 'location';
  reporter_name: string;
  created_at: string;
};

export default function TreasureHome() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('loading');
  const [soloHunt, setSoloHunt] = useState<BTSoloHunt | null>(null);
  const [myGroups, setMyGroups] = useState<BTGroup[]>([]);
  // Persistent invites (Round B) — stay visible until the player opens
  // the group page, which calls /bt/invites/{id}/view to clear them.
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [pendingReports, setPendingReports] = useState<PendingReport[]>([]);
  const [turnOffers, setTurnOffers] = useState<{ group_id: string; group_name: string; free_for_all: boolean }[]>([]);
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
      const [s, g, settings, inv, rep] = await Promise.all([
        api.btSoloCurrent().catch(() => ({ hunt: null })),
        api.btGroupsMine().catch(() => ({ groups: [] as BTGroup[] })),
        api.btGetSettings().catch(() => ({ area: null as any })),
        api.btInvitesPending().catch(() => ({ invites: [], count: 0 } as any)),
        api.btReportsPending().catch(() => ({ reports: [], count: 0 } as any)),
      ]);
      setSoloHunt(s.hunt || null);
      setMyGroups(g.groups || []);
      // 2026-06-04: also fetch turn-offer state for every group I'm in
      // so we can render "It's your turn!" / "FREE FOR ALL" banner cards.
      // Errors are swallowed per group — one stale group shouldn't blank
      // the whole list.
      try {
        const offers = await Promise.all(
          (g.groups || []).map(async (grp: BTGroup) => {
            try {
              const t = await api.btTurnCurrent(grp.id);
              if (t.is_my_turn || t.free_for_all) {
                return { group_id: grp.id, group_name: grp.name, free_for_all: !!t.free_for_all };
              }
            } catch {/* skip */}
            return null;
          }),
        );
        setTurnOffers(offers.filter(Boolean) as any);
      } catch {
        setTurnOffers([]);
      }
      const rawInvites: any =
        (inv && Array.isArray(inv.invites)) ? inv.invites
          : Array.isArray(inv) ? inv
          : [];
      setPendingInvites(rawInvites as PendingInvite[]);
      const rawReports: any =
        (rep && Array.isArray(rep.reports)) ? rep.reports
          : Array.isArray(rep) ? rep
          : [];
      setPendingReports(rawReports as PendingReport[]);
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
        {/* ───────── PERSISTENT INVITE BANNERS (Round B) ─────────
            One row per unviewed invite. Tapping routes to the group
            page, which calls /bt/invites/{id}/view on mount and clears
            the requires_view flag. The banner stays in the list until
            then — even across app restarts. */}
        {pendingInvites.length > 0 ? (
          <View style={styles.invitesWrap} testID="bt-pending-invites">
            {pendingInvites.map((iv) => (
              <TouchableOpacity
                key={iv.group_id}
                style={styles.inviteBanner}
                onPress={() => router.push(`/treasure/group/${iv.group_id}`)}
                activeOpacity={0.9}
                testID={`bt-invite-${iv.group_id}`}
              >
                <View style={styles.inviteIconBox}>
                  <Ionicons name="mail-unread" size={22} color="#0b0f15" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inviteTitle}>NEW TREASURE INVITE</Text>
                  <Text style={styles.inviteSub} numberOfLines={2}>
                    {iv.creator_name} invited you to “{iv.group_name}” — tap to view
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#0b0f15" />
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {/* ───────── TURN OFFERS / FREE-FOR-ALL (rotation system) ─────────
            One row per group where it's currently the user's turn OR
            the group is in FREE FOR ALL. Tap to land on the group page
            where the Accept / Reject buttons live. */}
        {turnOffers.length > 0 ? (
          <View style={styles.invitesWrap} testID="bt-turn-offers">
            {turnOffers.map((to) => (
              <TouchableOpacity
                key={`turn-${to.group_id}`}
                style={[styles.inviteBanner, to.free_for_all
                  ? { backgroundColor: '#FFE9C4', borderColor: '#FF9500' }
                  : { backgroundColor: '#D4F4E6', borderColor: '#11C28F' }]}
                onPress={() => router.push(`/treasure/group/${to.group_id}`)}
                activeOpacity={0.9}
                testID={`bt-turn-${to.group_id}`}
              >
                <View style={[styles.inviteIconBox, {
                  backgroundColor: to.free_for_all ? '#FF9500' : '#11C28F',
                }]}>
                  <Ionicons name={to.free_for_all ? 'flash' : 'compass'} size={22} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.inviteTitle, {
                    color: to.free_for_all ? '#7A4E0E' : '#0E7A55',
                  }]}>
                    {to.free_for_all ? 'FREE FOR ALL' : "YOUR TURN TO HUNT!"}
                  </Text>
                  <Text style={[styles.inviteSub, {
                    color: to.free_for_all ? '#7A4E0E' : '#0E7A55',
                  }]} numberOfLines={2}>
                    {to.free_for_all
                      ? `Anyone in "${to.group_name}" can find the chest — race to grab it!`
                      : `You've been selected in "${to.group_name}" — tap to accept or reject.`}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={to.free_for_all ? '#7A4E0E' : '#0E7A55'} />
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {/* ───────── PENDING ISSUE REPORTS (for creator/admin review) ─────────
            One row per unviewed report. Tapping routes to the review
            screen which clears it from the reviewer's banner list. */}
        {pendingReports.length > 0 ? (
          <View style={styles.invitesWrap} testID="bt-pending-reports">
            {pendingReports.map((rp) => (
              <TouchableOpacity
                key={rp.report_id}
                style={[styles.inviteBanner, { backgroundColor: '#FFE0E0', borderColor: '#FF3B30' }]}
                onPress={() => router.push(`/treasure/reports/${rp.report_id}`)}
                activeOpacity={0.9}
                testID={`bt-report-${rp.report_id}`}
              >
                <View style={[styles.inviteIconBox, { backgroundColor: '#FF3B30' }]}>
                  <Ionicons name="flag" size={22} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.inviteTitle, { color: '#7A0E0E' }]}>NEW ISSUE REPORT</Text>
                  <Text style={[styles.inviteSub, { color: '#7A0E0E' }]} numberOfLines={2}>
                    {rp.reporter_name} flagged the {rp.category === 'chest' ? 'chest' : 'location'}{rp.group_name ? ` in "${rp.group_name}"` : ''} — tap to review
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#7A0E0E" />
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

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

        {/* 2026-06-20: per spec the main entry screen now shows ONLY
            the two big CTA buttons (Play Solo / Play With Friends).
            The full "Your Groups" list moved into the dedicated
            /treasure/friends screen so all group-related content lives
            in one place. Keep the invite / turn-offer / report banners
            above the CTAs since those are urgent-action items that
            shouldn't be hidden one tap deeper. */}
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
  // Persistent invite banners (Round B)
  invitesWrap: { gap: 8 },
  inviteBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: spacing.md, borderRadius: radii.lg,
    backgroundColor: '#FFD166',
    borderWidth: 2, borderColor: '#FFB020',
    shadowColor: '#FFD166',
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  inviteIconBox: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#0b0f1518',
    alignItems: 'center', justifyContent: 'center',
  },
  inviteTitle: { color: '#0b0f15', fontWeight: '900', fontSize: 12, letterSpacing: 1 },
  inviteSub: { color: '#0b0f15CC', fontSize: 12, marginTop: 2, lineHeight: 17 },
});
