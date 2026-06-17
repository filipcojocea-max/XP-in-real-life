/**
 * /treasure/group/[id] — Group state machine for the Friends hunt.
 *
 * Renders one of four sub-views based on `group.status`:
 *
 *   lobby     — Invite status list. Invitees see ACCEPT / REJECT.
 *               Creator sees "BURY TREASURE" once everyone accepted.
 *   bury      — Creator-only screen that captures (a) a snapshot of
 *               the map at their current GPS and (b) a camera photo
 *               of the actual spot. Submitting flips the group to
 *               status='hunting' for everyone else.
 *   hunting   — Top: map screenshot + burier photo. Middle: live
 *               compass + distance read-out. Bottom: VIEW CAMERA
 *               button to claim the find.
 *   finished  — Winner card with their find photo.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Magnetometer } from 'expo-sensors';
import MapView, { Marker, Circle, IS_WEB_PLACEHOLDER } from '../../../src/components/MapShim';
import { api, type BTCompassReading, type BTGroup } from '../../../src/api';
import { BTReportIssueModal } from '../../../src/components/BTReportIssueModal';
import { colors, radii, spacing } from '../../../src/theme';
import { showAlert } from '../../../src/uiAlert';

export default function GroupScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [group, setGroup] = useState<BTGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Per-user notification preference for THIS group. ON = "Active —
  // ready to play"; OFF = "Inactive — won't receive treasures".
  // Defaults to true (notifications on) until /bt/groups/prefs resolves.
  const [notifEnabled, setNotifEnabled] = useState(true);
  const [togglingNotif, setTogglingNotif] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  // GPS shared by bury + hunting flows.
  const [gps, setGPS] = useState<{ lat: number; lng: number } | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    // Round B (2026-06-04): clear the persistent invite BEFORE the
    // group fetch so a stale/invalid group_id in bt_invites still
    // gets cleared from the player's banner — otherwise a 404 here
    // would short-circuit the Promise.all and the invite would never
    // be marked viewed. Fire-and-forget — failure here is non-fatal.
    api.btInviteView(String(id)).catch(() => {});
    setLoading(true);
    try {
      const [g, p] = await Promise.all([
        api.btGroupGet(String(id)),
        api.btGroupPrefs().catch(() => ({ prefs: {} as Record<string, boolean> })),
      ]);
      setGroup(g);
      // Default to true when no preference is saved yet (notifs ON).
      const pref = p?.prefs?.[String(id)];
      setNotifEnabled(pref === undefined ? true : pref);
    } catch (e: any) {
      showAlert('Failed to load group', String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  const onToggleNotif = useCallback(async (next: boolean) => {
    if (!group || togglingNotif) return;
    setTogglingNotif(true);
    // Optimistic — flip immediately, revert on error.
    setNotifEnabled(next);
    try {
      await api.btGroupToggle(group.id, next);
    } catch (e: any) {
      setNotifEnabled(!next);
      showAlert('Could not change setting', String(e?.message || e));
    } finally {
      setTogglingNotif(false);
    }
  }, [group, togglingNotif]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  // Poll every 4 s so accept/reject/bury propagates to all members.
  useEffect(() => {
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  // GPS watcher — only needed in bury or hunting view.
  useEffect(() => {
    if (!group || (group.status !== 'bury' && group.status !== 'hunting' && !group.is_creator)) {
      try { watchRef.current?.remove(); } catch {}
      return;
    }
    let cancelled = false;
    (async () => {
      const cur = await Location.getForegroundPermissionsAsync();
      let granted = cur.status === 'granted';
      if (!granted && cur.canAskAgain) {
        const r = await Location.requestForegroundPermissionsAsync();
        granted = r.status === 'granted';
      }
      if (!granted) return;
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 2, timeInterval: 1500 },
        (pos) => { if (!cancelled) setGPS({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      );
      watchRef.current = sub;
    })().catch(() => {});
    return () => { cancelled = true; try { watchRef.current?.remove(); } catch {} };
  }, [group?.status, group?.is_creator]); // eslint-disable-line react-hooks/exhaustive-deps

  // Accept / reject handlers.
  const respond = useCallback(async (accept: boolean) => {
    if (!group || busy) return;
    setBusy(true);
    try {
      const r = accept ? await api.btGroupAccept(group.id) : await api.btGroupReject(group.id);
      setGroup(r);
    } catch (e: any) {
      showAlert(accept ? 'Could not accept' : 'Could not reject', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [group, busy]);

  if (loading || !group) {
    return (
      <SafeAreaView style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace('/treasure')} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{group.name}</Text>
          <Text style={styles.headerSub}>code {group.code}</Text>
        </View>
        <View style={styles.headerBtn} />
      </View>

      {/* Per-group notification toggle. ON  → group is "Active — ready
          to play" and included in treasure selection / pushes. OFF →
          "Inactive — won't receive treasures": the group stays in the
          list but is skipped by the selection algorithm. */}
      <View style={[styles.toggleBar, !notifEnabled && styles.toggleBarOff]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.toggleLabel, !notifEnabled && styles.toggleLabelOff]}>
            {notifEnabled ? 'Active — ready to play' : "Inactive — won't receive treasures"}
          </Text>
          <Text style={styles.toggleHint}>
            {notifEnabled
              ? 'You\'ll be picked when treasures drop for this group.'
              : 'This group is skipped from treasure selection until you turn this back on.'}
          </Text>
        </View>
        <Switch
          value={notifEnabled}
          onValueChange={onToggleNotif}
          disabled={togglingNotif}
          trackColor={{ false: '#3a3f48', true: colors.cyan + '88' }}
          thumbColor={notifEnabled ? colors.cyan : '#9aa4af'}
          testID="bt-group-notif-toggle"
        />
      </View>

      {/* "Found any issues? Report to Creator" — only shown while a
          chest is live (status=hunting). Members AND the creator can
          tap, but the creator's reports just go to admin since they
          ARE the creator. */}
      {group.status === 'hunting' && (group as any).chest_lat != null && (group as any).chest_lng != null ? (
        <TouchableOpacity
          style={styles.reportBar}
          onPress={() => setReportOpen(true)}
          activeOpacity={0.85}
          testID="bt-group-report-issue"
        >
          <Ionicons name="flag-outline" size={16} color="#FF3B30" />
          <Text style={styles.reportBarText}>Found any issues? Report to Creator</Text>
          <Ionicons name="chevron-forward" size={14} color="#FF3B30" />
        </TouchableOpacity>
      ) : null}

      {group.status === 'lobby' ? (
        <LobbyView group={group} busy={busy} onAccept={() => respond(true)} onReject={() => respond(false)} onBegan={load} />
      ) : group.status === 'hunting' ? (
        group.is_creator ? (
          <CreatorWaitingView group={group} />
        ) : (
          <HuntingView group={group} gps={gps} onFound={load} />
        )
      ) : (
        <FinishedView group={group} />
      )}

      {/* Issue report modal — group source. Chest coords are read off
          the group doc (the LobbyView path doesn't expose them yet,
          but the bar above is gated on chest_lat/lng so this is safe). */}
      {(group as any).chest_lat != null && (group as any).chest_lng != null ? (
        <BTReportIssueModal
          visible={reportOpen}
          onClose={() => setReportOpen(false)}
          source="group"
          group_id={group.id}
          chest_lat={(group as any).chest_lat}
          chest_lng={(group as any).chest_lng}
        />
      ) : null}
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Lobby — show member acceptance status
// ─────────────────────────────────────────────────────────────────────
function LobbyView({
  group,
  busy,
  onAccept,
  onReject,
  onBegan,
}: {
  group: BTGroup;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onBegan: () => void;
}) {
  const router = useRouter();
  // 2026-06-04 spec: invitees may FLIP their answer (Accept ↔ Reject)
  // at any point until the group transitions from "lobby" to
  // "hunting" / "finished" — at which point the backend sets
  // `responses_locked: true` and rejects further /accept|/reject hits.
  const responsesLocked = !!(group as any).responses_locked || group.status !== 'lobby';
  const me = group.members.find((m) => m.user_id === group.creator_id);
  const myEntry = group.members.find((m) => m.my_status !== undefined as any) || null;
  // Identify "me" by my_status — server populates it.
  const myPending = group.my_status === 'pending';
  const iAmInvitedNonCreator = group.my_status !== undefined && !group.is_creator;
  const others = group.members.filter((m) => m.user_id !== group.creator_id);
  const allAccepted = others.length > 0 && others.every((m) => m.status === 'accepted');

  const startBury = useCallback(() => {
    router.push(`/treasure/group/${group.id}?bury=1`);
  }, [router, group.id]);

  // If the URL has ?bury=1 we render the Bury view instead of the lobby.
  const params = useLocalSearchParams<{ bury?: string }>();
  if (params.bury === '1' && group.is_creator && allAccepted) {
    return <BuryView group={group} onBuried={onBegan} />;
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
      <View style={styles.card}>
        <Text style={styles.cardKicker}>WHO'S IN</Text>
        {group.members.map((m) => (
          <View key={m.user_id} style={styles.memberRow}>
            <Ionicons
              name={
                m.user_id === group.creator_id ? 'star' :
                m.status === 'accepted' ? 'checkmark-circle' :
                m.status === 'rejected' ? 'close-circle' : 'time'
              }
              size={20}
              color={
                m.user_id === group.creator_id ? '#FFD166' :
                m.status === 'accepted' ? '#22C55E' :
                m.status === 'rejected' ? colors.red : colors.amber
              }
            />
            <Text style={styles.memberName}>{m.name}</Text>
            <Text style={styles.memberStatus}>
              {m.user_id === group.creator_id ? 'Creator' :
               m.status === 'accepted' ? 'Invite Accepted' :
               m.status === 'rejected' ? 'Invite Rejected' : 'Invited — Awaiting Reply'}
            </Text>
          </View>
        ))}
      </View>

      {iAmInvitedNonCreator && !responsesLocked ? (
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[
              styles.actionBtn,
              { backgroundColor: '#22C55E' },
              busy && { opacity: 0.5 },
              group.my_status === 'accepted' && { borderWidth: 2, borderColor: '#0b0f15' },
            ]}
            disabled={busy}
            onPress={onAccept}
            testID="bt-accept"
          >
            <Ionicons name="checkmark" size={20} color="#0b0f15" />
            <Text style={styles.actionText}>{group.my_status === 'accepted' ? 'ACCEPTED' : 'ACCEPT'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.actionBtn,
              { backgroundColor: colors.red },
              busy && { opacity: 0.5 },
              group.my_status === 'rejected' && { borderWidth: 2, borderColor: '#fff' },
            ]}
            disabled={busy}
            onPress={onReject}
            testID="bt-reject"
          >
            <Ionicons name="close" size={20} color="#fff" />
            <Text style={[styles.actionText, { color: '#fff' }]}>{group.my_status === 'rejected' ? 'REJECTED' : 'REJECT'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {group.is_creator ? (
        <View style={styles.card}>
          <Text style={styles.cardKicker}>YOUR MOVE</Text>
          {others.length === 0 ? (
            <Text style={styles.helper}>
              You haven't invited anyone yet. Use the code <Text style={{ color: colors.cyan, fontWeight: '900' }}>{group.code}</Text> to share with friends, or invite from your friends list.
            </Text>
          ) : !allAccepted ? (
            <Text style={styles.helper}>
              {others.filter((m) => m.status === 'pending').length} invitee(s) still need to accept before you can bury the chest.
            </Text>
          ) : (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.cyan, flex: 0, alignSelf: 'stretch' }]}
              onPress={startBury}
              testID="bt-start-bury"
            >
              <Ionicons name="flag" size={20} color="#0b0f15" />
              <Text style={styles.actionText}>BURY TREASURE</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bury — creator captures map screenshot + spot photo
// ─────────────────────────────────────────────────────────────────────
function BuryView({ group, onBuried }: { group: BTGroup; onBuried: () => void }) {
  const router = useRouter();
  const [gps, setGPS] = useState<{ lat: number; lng: number } | null>(null);
  // 2026-06-17: stable initial centre — captured from the FIRST GPS
  // fix only and never mutated, so BTLeafletMap's WebView mounts ONCE
  // and finishes tile-loading reliably. The Buried-Treasure Groups
  // screen was crashing on open because each parent re-render (the
  // 4-second poll in GroupScreen) was bouncing `initialLat` and
  // forcing the WebView to remount mid-tile-fetch on Android.
  const [initialCenter, setInitialCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [mapShot, setMapShot] = useState<string | null>(null);
  const [spotPhoto, setSpotPhoto] = useState<string | null>(null);
  const [camOpen, setCamOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const mapRef = useRef<BTLeafletMapHandle | null>(null);
  const camRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Location.requestForegroundPermissionsAsync();
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null);
      if (!cancelled && pos) {
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setGPS(next);
        // Lock the initial map centre on FIRST fix only (idempotent).
        setInitialCenter((prev) => prev || next);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const snapMap = useCallback(async () => {
    // BTLeafletMap captures via html2canvas inside the WebView. If the
    // capture fails for any reason (canvas tainted, network slow,
    // unmounted mid-call) we degrade gracefully to a placeholder so the
    // bury flow can still complete — the backend treats the map photo
    // as a "best effort" image, not a verification artefact.
    if (!mapRef.current) {
      setMapShot('PLACEHOLDER');
      return;
    }
    try {
      const b64 = await mapRef.current.requestSnapshot();
      if (b64 && b64.length > 200) setMapShot(b64);
      else throw new Error('Map returned empty snapshot.');
    } catch (e: any) {
      // Soft-fail: log + placeholder so the user can still bury.
      // eslint-disable-next-line no-console
      console.warn('[bt] map snapshot failed', e?.message || e);
      setMapShot('PLACEHOLDER');
    }
  }, []);

  const openCam = useCallback(async () => {
    // expo-camera 17: static `Camera` symbol is unreliable on Android prod
    // builds — the dynamic-import pattern (mirrored from /treasure/solo.tsx)
    // is the battle-tested workaround and avoids `TypeError: Cannot read
    // properties of undefined (reading 'requestCameraPermissionsAsync')`.
    const { Camera } = await import('expo-camera');
    const r = await Camera.requestCameraPermissionsAsync();
    if (r.status !== 'granted') {
      showAlert('Camera blocked', 'Allow Camera so you can photograph the spot.');
      return;
    }
    setCamOpen(true);
  }, []);

  const snapPhoto = useCallback(async () => {
    if (!camRef.current) return;
    try {
      const photo = await camRef.current.takePictureAsync({ quality: 0.55, skipProcessing: true });
      const b64 = await FileSystem.readAsStringAsync(photo.uri, { encoding: FileSystem.EncodingType.Base64 });
      setSpotPhoto(b64);
      setCamOpen(false);
    } catch (e: any) {
      showAlert('Photo failed', String(e?.message || e));
    }
  }, []);

  const onSubmit = useCallback(async () => {
    if (!gps || !mapShot || !spotPhoto || submitting) return;
    setSubmitting(true);
    try {
      // Web preview placeholder: send a tiny 1x1 transparent jpg so the
      // backend's "required" check passes during local QA. On real
      // devices we always have an actual base64 map snapshot.
      const mapPayload =
        mapShot === 'PLACEHOLDER'
          ? '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/8M//2Q=='
          : mapShot;
      await api.btGroupBury(group.id, gps.lat, gps.lng, spotPhoto, mapPayload);
      onBuried();
    } catch (e: any) {
      showAlert('Could not bury the chest', String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  }, [gps, mapShot, spotPhoto, submitting, group.id, onBuried]);

  const ready = !!(gps && mapShot && spotPhoto);

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
      <Text style={styles.helper}>
        Walk to the spot where you want to bury the chest, then capture both a snapshot of your map and a real photo of the spot. Friends will use those two images to find it.
      </Text>

      {/* Map preview + capture */}
      <View style={styles.card}>
        <Text style={styles.cardKicker}>1 · MAP SNAPSHOT</Text>
        {initialCenter ? (
          <View style={styles.miniMap}>
            <BTLeafletMap
              ref={mapRef}
              mode="static"
              initialLat={initialCenter.lat}
              initialLng={initialCenter.lng}
              initialZoom={17}
              initialRadius={15}
              ringColor="#FFD166"
              markerColor="#FFD166"
              onReady={() => {
                // Drop the live "you are here" dot immediately on
                // first WebView ready — keeps the map mount stable
                // (no prop-change re-render).
                if (gps) {
                  try { mapRef.current?.setUserLocation(gps.lat, gps.lng); } catch {}
                }
              }}
              style={StyleSheet.absoluteFill}
            />
          </View>
        ) : (
          <ActivityIndicator color={colors.cyan} style={{ marginVertical: 20 }} />
        )}
        <TouchableOpacity
          style={[styles.subBtn, mapShot && { backgroundColor: '#22C55E' }]}
          onPress={snapMap}
          activeOpacity={0.85}
          testID="bt-snap-map"
        >
          <Ionicons name={mapShot ? 'checkmark' : 'camera'} size={18} color="#0b0f15" />
          <Text style={styles.subBtnText}>{mapShot ? 'Map captured' : 'Capture map'}</Text>
        </TouchableOpacity>
      </View>

      {/* Spot photo */}
      <View style={styles.card}>
        <Text style={styles.cardKicker}>2 · SPOT PHOTO</Text>
        {spotPhoto ? (
          <Image source={{ uri: `data:image/jpeg;base64,${spotPhoto}` }} style={styles.spotPreview} />
        ) : (
          <View style={[styles.spotPreview, { alignItems: 'center', justifyContent: 'center' }]}>
            <Ionicons name="image-outline" size={40} color={colors.textMuted} />
          </View>
        )}
        <TouchableOpacity
          style={[styles.subBtn, spotPhoto && { backgroundColor: '#22C55E' }]}
          onPress={openCam}
          activeOpacity={0.85}
          testID="bt-snap-photo"
        >
          <Ionicons name={spotPhoto ? 'checkmark' : 'camera'} size={18} color="#0b0f15" />
          <Text style={styles.subBtnText}>{spotPhoto ? 'Photo captured' : 'Take photo'}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.cta, (!ready || submitting) && { opacity: 0.5 }]}
        disabled={!ready || submitting}
        onPress={onSubmit}
        activeOpacity={0.85}
        testID="bt-bury-submit"
      >
        {submitting ? <ActivityIndicator color="#0b0f15" /> : (
          <>
            <Ionicons name="flag" size={20} color="#0b0f15" />
            <Text style={styles.ctaText}>BURY THE CHEST &amp; START HUNT</Text>
          </>
        )}
      </TouchableOpacity>

      <Modal visible={camOpen} animationType="slide" onRequestClose={() => setCamOpen(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView ref={camRef as any} style={{ flex: 1 }} facing="back" />
          <View style={styles.camControls}>
            <TouchableOpacity onPress={() => setCamOpen(false)} style={{ width: 80, paddingVertical: 10 }}>
              <Text style={{ color: '#fff', fontWeight: '800' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={snapPhoto} style={styles.camShoot}>
              <Ionicons name="camera" size={32} color="#0b0f15" />
            </TouchableOpacity>
            <View style={{ width: 80 }} />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Hunting — non-creator members search for the buried chest
// ─────────────────────────────────────────────────────────────────────
function HuntingView({
  group,
  gps,
  onFound,
}: {
  group: BTGroup;
  gps: { lat: number; lng: number } | null;
  onFound: () => void;
}) {
  const [compass, setCompass] = useState<BTCompassReading | null>(null);
  const [heading, setHeading] = useState(0);
  const [camOpen, setCamOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const camRef = useRef<any>(null);

  useEffect(() => {
    Magnetometer.setUpdateInterval(120);
    const sub = Magnetometer.addListener(({ x, y }) => {
      let d = Math.atan2(y, x) * (180 / Math.PI);
      d = (d + 360 + 90) % 360;
      setHeading(d);
    });
    return () => sub.remove();
  }, []);

  const refreshCompass = useCallback(async () => {
    if (!gps) return;
    try {
      const r = await api.btGroupCompass(group.id, gps.lat, gps.lng);
      setCompass(r);
    } catch {
      // silent; will retry
    }
  }, [gps, group.id]);

  useEffect(() => {
    refreshCompass();
    const t = setInterval(refreshCompass, 2000);
    return () => clearInterval(t);
  }, [refreshCompass]);

  const openCam = useCallback(async () => {
    if (!compass || !compass.in_find_ring) {
      showAlert(
        'Get closer',
        compass ? `You're ${Math.round(compass.distance_m)} m away — get within ${compass.find_ring_m} m.` : 'Waiting for GPS…',
      );
      return;
    }
    // expo-camera 17: dynamic import avoids the static `Camera` symbol
    // being undefined on Android prod builds (same pattern as solo.tsx).
    const { Camera } = await import('expo-camera');
    const r = await Camera.requestCameraPermissionsAsync();
    if (r.status !== 'granted') {
      showAlert('Camera blocked', 'Allow Camera to confirm the find.');
      return;
    }
    setCamOpen(true);
  }, [compass]);

  const claim = useCallback(async () => {
    if (!camRef.current || !gps || submitting) return;
    setSubmitting(true);
    try {
      const photo = await camRef.current.takePictureAsync({ quality: 0.55, skipProcessing: true });
      const b64 = await FileSystem.readAsStringAsync(photo.uri, { encoding: FileSystem.EncodingType.Base64 });
      const res = await api.btGroupFind(group.id, gps.lat, gps.lng, b64);
      setCamOpen(false);
      // 2026-06-04 rotation: backend flips to awaiting_hide + holder_id=user.
      // Finder owes a fresh re-hide before the cycle advances — route them
      // straight into /hide flow.
      showAlert('+100 XP — chest found!', `New total: ${res.new_total_xp.toLocaleString()} XP. Now hide it in a NEW public spot for the next player!`);
      router.replace(`/treasure/group/${group.id}/hide`);
      return;
    } catch (e: any) {
      showAlert('Could not claim', String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  }, [gps, submitting, group.id, onFound]);

  const arrowRot = compass ? (compass.bearing_deg - heading + 360) % 360 : 0;
  const chestPhoto = group.chest?.photo_base64 || null;
  const mapShot = group.chest?.map_screenshot_base64 || null;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
      {/* TOP — map screenshot + burier photo */}
      <View style={styles.card}>
        <Text style={styles.cardKicker}>WHERE IT WAS BURIED</Text>
        {mapShot ? (
          <Image source={{ uri: `data:image/jpeg;base64,${mapShot}` }} style={styles.bigImg} />
        ) : null}
        {chestPhoto ? (
          <Image source={{ uri: `data:image/jpeg;base64,${chestPhoto}` }} style={styles.bigImg} />
        ) : null}
      </View>

      {/* MIDDLE — compass */}
      <View style={styles.compassCard}>
        {!compass ? (
          <ActivityIndicator color={colors.cyan} />
        ) : (
          <>
            <View style={styles.compassFace}>
              {['N', 'E', 'S', 'W'].map((dir, idx) => (
                <Text
                  key={dir}
                  style={[styles.cardinal, {
                    transform: [{ rotate: `${idx * 90}deg` }, { translateY: -90 }],
                  }]}
                >{dir}</Text>
              ))}
              <View style={[styles.arrow, { transform: [{ rotate: `${arrowRot}deg` }] }]}>
                <Ionicons name="navigate" size={100} color={compass.in_find_ring ? '#22C55E' : colors.cyan} />
              </View>
            </View>
            <Text style={[styles.distance, compass.in_find_ring && { color: '#22C55E' }]}>
              {compass.distance_m < 1 ? 'Right here!' : `${Math.round(compass.distance_m)} m away`}
            </Text>
            <Text style={styles.heading}>
              Heading {Math.round(compass.bearing_deg)}° · You're facing {Math.round(heading)}°
            </Text>
          </>
        )}
      </View>

      {/* BOTTOM — camera */}
      <TouchableOpacity
        style={[
          styles.cta,
          compass?.in_find_ring ? { backgroundColor: '#22C55E' } : { backgroundColor: colors.cyan },
        ]}
        onPress={openCam}
        activeOpacity={0.85}
        testID="bt-group-camera"
      >
        <Ionicons name="camera" size={20} color="#0b0f15" />
        <Text style={styles.ctaText}>
          {compass?.in_find_ring ? 'VIEW CAMERA · CONFIRM FIND' : 'VIEW CAMERA · TAKE PHOTO'}
        </Text>
      </TouchableOpacity>

      <Modal visible={camOpen} animationType="slide" onRequestClose={() => setCamOpen(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView ref={camRef as any} style={{ flex: 1 }} facing="back" />
          <View style={styles.camControls}>
            <TouchableOpacity onPress={() => setCamOpen(false)} style={{ width: 80, paddingVertical: 10 }}>
              <Text style={{ color: '#fff', fontWeight: '800' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={claim} disabled={submitting} style={[styles.camShoot, submitting && { opacity: 0.5 }]}>
              {submitting ? <ActivityIndicator color="#0b0f15" /> : <Ionicons name="camera" size={32} color="#0b0f15" />}
            </TouchableOpacity>
            <View style={{ width: 80 }} />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Creator-waiting (status='hunting', I'm the burier)
// ─────────────────────────────────────────────────────────────────────
function CreatorWaitingView({ group }: { group: BTGroup }) {
  return (
    <View style={styles.center}>
      <Ionicons name="hourglass" size={42} color={colors.amber} />
      <Text style={styles.bigTitle}>Hunt is live!</Text>
      <Text style={styles.helper}>
        You buried the chest. Your friends are out hunting it now — you'll get a push when someone finds it.
      </Text>
      {group.chest?.photo_base64 ? (
        <Image source={{ uri: `data:image/jpeg;base64,${group.chest.photo_base64}` }} style={[styles.bigImg, { marginTop: spacing.md }]} />
      ) : null}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Finished
// ─────────────────────────────────────────────────────────────────────
function FinishedView({ group }: { group: BTGroup }) {
  const finder = group.members.find((m) => m.user_id === group.found_by);
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, alignItems: 'center' }}>
      <Ionicons name="trophy" size={48} color="#FFD166" />
      <Text style={styles.bigTitle}>{finder?.name || 'Someone'} found the chest!</Text>
      <Text style={styles.helper}>
        Hunt finished {group.found_at ? `at ${new Date(group.found_at).toLocaleString()}` : ''}.
      </Text>
      {group.chest?.photo_base64 ? (
        <Image source={{ uri: `data:image/jpeg;base64,${group.chest.photo_base64}` }} style={styles.bigImg} />
      ) : null}
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.sm, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerBtn: { width: 40, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  headerSub: { color: colors.textMuted, fontSize: 10, letterSpacing: 1, marginTop: 1 },
  // Status banner between the header and the rest of the screen. Goes
  // greyed-out when notifications are off so the visual matches the
  // "Inactive" label.
  toggleBar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 10, paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderColor: colors.border,
  },
  toggleBarOff: { opacity: 0.55 },
  reportBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginTop: 6,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1A0E10',
    borderWidth: 1, borderColor: '#FF3B30',
  },
  reportBarText: {
    flex: 1, color: '#FF3B30',
    fontSize: 13, fontWeight: '700', letterSpacing: 0.3,
  },
  toggleLabel: { color: colors.text, fontSize: 13, fontWeight: '800' },
  toggleLabelOff: { color: colors.textMuted },
  toggleHint: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, gap: 8,
  },
  cardKicker: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  memberName: { flex: 1, color: colors.text, fontWeight: '700' },
  memberStatus: { color: colors.textSecondary, fontSize: 11, fontWeight: '800' },
  helper: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionBtn: {
    flex: 1, paddingVertical: 14, borderRadius: radii.lg,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  actionText: { color: '#0b0f15', fontWeight: '900', letterSpacing: 0.7 },
  miniMap: { width: '100%', height: 200, backgroundColor: '#0E1218', borderRadius: radii.md, overflow: 'hidden' },
  spotPreview: { width: '100%', height: 200, borderRadius: radii.md, backgroundColor: '#0E1218' },
  subBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.cyan, paddingVertical: 12, borderRadius: radii.md,
  },
  subBtnText: { color: '#0b0f15', fontWeight: '900' },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: radii.lg, backgroundColor: colors.cyan,
  },
  ctaText: { color: '#0b0f15', fontWeight: '900', letterSpacing: 0.5 },
  camControls: {
    position: 'absolute', bottom: 30, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 24,
  },
  camShoot: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 4, borderColor: '#22C55E',
  },
  bigImg: { width: '100%', height: 200, borderRadius: radii.md, backgroundColor: '#0E1218', resizeMode: 'cover' },
  compassCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, alignItems: 'center', gap: 6,
  },
  compassFace: {
    width: 240, height: 240, borderRadius: 120,
    borderWidth: 2, borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center', justifyContent: 'center',
  },
  cardinal: { position: 'absolute', color: colors.textMuted, fontWeight: '900', fontSize: 13 },
  arrow: { alignItems: 'center', justifyContent: 'center' },
  distance: { color: colors.cyan, fontSize: 24, fontWeight: '900', marginTop: 8 },
  heading: { color: colors.textMuted, fontSize: 11 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: 8 },
  bigTitle: { color: colors.text, fontSize: 22, fontWeight: '900', textAlign: 'center' },
});
