import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Image,
  Platform,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import PremiumShield, { getDynamicShieldLevel } from '../../src/components/PremiumShield';
import { useScrollToTopOnFocus } from '../../src/hooks/useScrollToTopOnFocus';
import { useRouter, useFocusEffect } from 'expo-router';
import Card from '../../src/components/Card';
import Ring from '../../src/components/Ring';
import { api, Profile } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';
import { getMotivationSchedule } from '../../src/notifications';
import { useAuth } from '../../src/AuthContext';
import { formatZoneDisplay, findAuZone } from '../../src/auTimezones';
import { useImmersive } from '../../src/immersive';

export default function ProfileScreen() {
  const router = useRouter();
  const { user, isAnonymous, signOut } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const p = await api.getProfile();
      setProfile(p);
      setName(p.name);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Always show the top of the Profile tab on focus so the avatar/
  // shield/progress ring is the first thing the user sees after tapping
  // the tab — regardless of where they'd previously scrolled to.
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTopOnFocus(scrollRef);

  const saveName = async () => {
    if (!name.trim()) return;
    const p = await api.updateProfile(name.trim());
    setProfile(p);
    setEditing(false);
  };

  const reset = () => {
    const doReset = async () => {
      try {
        await api.resetProfile();
        await api.seed();
        await load();
      } catch (e: any) {
        console.log('reset error', e);
        if (Platform.OS === 'web') {
          // eslint-disable-next-line no-alert
          window.alert('Could not reset progress. Please try again.');
        } else {
          Alert.alert('Could not reset', String(e?.message || e));
        }
      }
    };

    if (Platform.OS === 'web') {
      // React Native Web's Alert.alert doesn't render confirm buttons,
      // so the destructive callback never fires. Use the browser confirm.
      // eslint-disable-next-line no-alert
      const ok = window.confirm(
        'Reset progress?\n\nThis permanently deletes your XP, tasks, goals, and streak.'
      );
      if (ok) doReset();
      return;
    }

    Alert.alert('Reset progress?', 'This permanently deletes your XP, tasks, goals, and streak.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: doReset,
      },
    ]);
  };

  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    // No confirmation dialog: sign-out is non-destructive and the previous
    // Alert.alert/window.confirm flow was unreliable on some platforms.
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } catch (e) {
      console.log('signOut error', e);
    }
    // Always route to the login screen so the user sees something change
    // even if the AuthGate hasn't reacted to the state update yet.
    try {
      router.replace('/auth/login');
    } catch (e) {
      console.log('signOut nav error', e);
    } finally {
      setSigningOut(false);
    }
  };

  if (loading || !profile) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loading}>
          <ActivityIndicator color={colors.green} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.kicker}>{profile.is_admin ? 'CREATOR · PREMIUM+' : 'Character'}</Text>
            <Text style={styles.title}>Profile</Text>
          </View>
          {profile.is_admin && <AdminNotificationBell />}
        </View>

        <View style={styles.avatarWrap}>
          <Ring size={150} stroke={8} progress={profile.xp_progress} color={profile.is_admin ? '#FFD700' : colors.amber}>
            <View style={[styles.avatar, profile.is_admin && { borderColor: '#FFD700', borderWidth: 3 }]}>
              {profile.avatar_base64 ? (
                <Image source={{ uri: profile.avatar_base64 }} style={styles.avatarImg} />
              ) : (
                // Single source of truth for the user's progress emblem.
                // For the admin/Creator → gold Lv999 shield. Otherwise →
                // tier-correct shield matching the leaderboard / friends
                // list / search so what you see in your own profile is
                // exactly what others see in public surfaces.
                <PremiumShield
                  size={120}
                  level={getDynamicShieldLevel({
                    level: profile.level,
                    total_xp: profile.total_xp,
                    is_admin: profile.is_admin,
                  })}
                />
              )}
            </View>
          </Ring>
          <View style={[styles.levelBadge, profile.is_admin && { backgroundColor: '#FFD700', borderColor: '#FFD700' }]}>
            <Text style={[styles.levelBadgeText, profile.is_admin && { color: colors.bg }]}>
              {profile.is_admin ? '∞ PREMIUM+' : `LV ${profile.level}`}
            </Text>
          </View>

          {editing ? (
            <View style={styles.nameEdit}>
              <TextInput
                testID="profile-name-input"
                style={styles.nameInput}
                value={name}
                onChangeText={setName}
                autoFocus
              />
              <TouchableOpacity testID="profile-name-save" style={styles.nameBtn} onPress={saveName}>
                <Ionicons name="checkmark" size={18} color={colors.bg} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              testID="profile-name-edit"
              onPress={() => setEditing(true)}
              style={styles.nameRow}
            >
              <Text style={styles.name}>{profile.name}</Text>
              <Ionicons name="pencil" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {/* Bio */}
        {profile.bio ? (
          <Card style={styles.bioCard} testID="profile-bio">
            <View style={styles.bioHeader}>
              <Ionicons name="sparkles" size={14} color={colors.cyan} />
              <Text style={styles.bioLabel}>Character Bio</Text>
            </View>
            <Text style={styles.bioText}>{profile.bio}</Text>
          </Card>
        ) : null}

        {/* Stats grid */}
        <View style={styles.grid}>
          <Card style={styles.statCard}>
            <Ionicons name="flash" size={22} color={colors.amber} />
            <Text style={styles.statVal}>{profile.total_xp}</Text>
            <Text style={styles.statLbl}>Total XP</Text>
          </Card>
          <Card style={styles.statCard}>
            <Ionicons name="flame" size={22} color={colors.pink} />
            <Text style={styles.statVal}>{profile.current_streak}</Text>
            <Text style={styles.statLbl}>Current Streak</Text>
          </Card>
          <Card style={styles.statCard}>
            <Ionicons name="trophy" size={22} color={colors.amber} />
            <Text style={styles.statVal}>{profile.longest_streak}</Text>
            <Text style={styles.statLbl}>Best Streak</Text>
          </Card>
          <Card style={styles.statCard}>
            <Ionicons name="checkmark-done" size={22} color={colors.green} />
            <Text style={styles.statVal}>{profile.tasks_completed}</Text>
            <Text style={styles.statLbl}>Quests Done</Text>
          </Card>
          <Card style={styles.statCard}>
            <Ionicons name="flag" size={22} color={colors.cyan} />
            <Text style={styles.statVal}>{profile.goals_completed}/{profile.goals_created}</Text>
            <Text style={styles.statLbl}>Goals</Text>
          </Card>
          <Card style={styles.statCard}>
            <Ionicons name="medal" size={22} color={colors.purple} />
            <Text style={styles.statVal}>{profile.achievements_unlocked.length}</Text>
            <Text style={styles.statLbl}>Badges</Text>
          </Card>
        </View>

        {/* Motivation notification schedule */}
        <Card style={styles.motivCard} testID="motivation-schedule">
          <View style={styles.motivHeader}>
            <Ionicons name="notifications" size={16} color={colors.cyan} />
            <Text style={styles.motivLabel}>Daily Motivation</Text>
          </View>
          <Text style={styles.motivDesc}>
            We ping you 4 times a day to keep your character on track.
          </Text>
          <View style={styles.motivRow}>
            {getMotivationSchedule().map((w) => (
              <View key={w.key} style={styles.motivPill} testID={`motiv-pill-${w.key}`}>
                <Text style={styles.motivTime}>{w.time}</Text>
                <Text style={styles.motivKey}>{w.key.toUpperCase()}</Text>
              </View>
            ))}
          </View>
        </Card>

        {/* Day anchor info — locked unless reset */}
        {profile?.timezone && profile?.day_start_time ? (
          <View style={styles.anchorCard}>
            <View style={styles.anchorRow}>
              <View style={[styles.actionIcon, { backgroundColor: colors.cyan + '22', borderColor: colors.cyan + '55' }]}>
                <Ionicons name="earth" size={18} color={colors.cyan} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.anchorLabel}>TIMEZONE</Text>
                <Text style={styles.anchorValue}>{formatZoneDisplay(profile.timezone)}</Text>
              </View>
              <Ionicons name="lock-closed" size={14} color={colors.textMuted} />
            </View>
            <View style={[styles.anchorRow, { marginTop: 8 }]}>
              <View style={[styles.actionIcon, { backgroundColor: colors.amber + '22', borderColor: colors.amber + '55' }]}>
                <Ionicons name="sunny" size={18} color={colors.amber} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.anchorLabel}>MORNING START TIME</Text>
                <Text style={styles.anchorValue}>{profile.day_start_time} (your new day begins here)</Text>
              </View>
              <Ionicons name="lock-closed" size={14} color={colors.textMuted} />
            </View>
            <Text style={styles.anchorFoot}>
              🔒 Locked. To change timezone or morning time, reset progress below.
            </Text>
          </View>
        ) : null}

        {/* Actions */}
        <TouchableOpacity
          testID="profile-edit-btn"
          style={styles.actionRow}
          onPress={() => router.push('/onboarding')}
        >
          <View style={[styles.actionIcon, { backgroundColor: colors.green + '22', borderColor: colors.green + '55' }]}>
            <Ionicons name="create" size={18} color={colors.green} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.actionTitle}>Edit Profile</Text>
            <Text style={styles.actionDesc}>Update interests, goals, avatar and bio</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>

        {/* Immersive Mode toggle — when OFF the bottom tab bar stays
            visible all the time instead of auto-hiding after 5 s. */}
        <ImmersiveToggleRow />

        <TouchableOpacity
          testID="profile-focus-btn"
          style={styles.actionRow}
          onPress={() => router.push('/focus')}
        >
          <View style={[styles.actionIcon, { backgroundColor: colors.cyan + '22', borderColor: colors.cyan + '55' }]}>
            <Ionicons name="lock-closed" size={18} color={colors.cyan} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.actionTitle}>Focus Mode</Text>
            <Text style={styles.actionDesc}>Lock in with a challenge-to-unlock timer</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity testID="profile-reset-btn" style={styles.actionRow} onPress={reset}>
          <View style={[styles.actionIcon, { backgroundColor: colors.red + '22', borderColor: colors.red + '55' }]}>
            <Ionicons name="refresh" size={18} color={colors.red} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.actionTitle}>Reset Progress</Text>
            <Text style={styles.actionDesc}>Start your journey from scratch</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>

        {/* Friends+ — social discovery */}
        <TouchableOpacity
          testID="profile-friends-btn"
          style={styles.actionRow}
          onPress={() => router.push('/friends' as any)}
        >
          <View style={[styles.actionIcon, { backgroundColor: colors.cyan + '22', borderColor: colors.cyan + '55' }]}>
            <Ionicons name="people" size={18} color={colors.cyan} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.actionTitle, { color: colors.cyan }]}>Friends+</Text>
            <Text style={styles.actionDesc}>Connect with other players</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>

        {/* Account section */}
        <View style={styles.accountSection}>
          <Text style={styles.accountSectionLabel}>Account</Text>
          {!isAnonymous && user?.email ? (
            <View style={styles.accountInfoRow} testID="profile-account-info">
              <Ionicons name="mail" size={16} color={colors.textMuted} />
              <Text style={styles.accountEmail} numberOfLines={1}>{user.email}</Text>
              {user.verified ? (
                <View style={styles.verifiedBadge}>
                  <Ionicons name="checkmark-circle" size={11} color={colors.green} />
                  <Text style={styles.verifiedText}>VERIFIED</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {isAnonymous ? (
            <TouchableOpacity
              testID="profile-create-account-btn"
              style={[styles.actionRow, { marginTop: 0 }]}
              onPress={() => router.push('/auth/login' as any)}
            >
              <View style={[styles.actionIcon, { backgroundColor: colors.green + '22', borderColor: colors.green + '55' }]}>
                <Ionicons name="cloud-upload" size={18} color={colors.green} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.actionTitle}>Login / Sign up</Text>
                <Text style={styles.actionDesc}>Save your progress to the cloud</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              testID="profile-signout-btn"
              style={[styles.actionRow, { marginTop: 0 }, signingOut && { opacity: 0.6 }]}
              onPress={handleSignOut}
              disabled={signingOut}
              activeOpacity={0.7}
            >
              <View style={[styles.actionIcon, { backgroundColor: colors.amber + '22', borderColor: colors.amber + '55' }]}>
                {signingOut ? (
                  <ActivityIndicator size="small" color={colors.amber} />
                ) : (
                  <Ionicons name="log-out" size={18} color={colors.amber} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.actionTitle}>{signingOut ? 'Signing out…' : 'Sign Out'}</Text>
                <Text style={styles.actionDesc}>
                  {signingOut ? 'See you soon, hero.' : 'Log out of your account'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        <Text style={styles.footer}>LevelUp · v1.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: spacing.md, paddingBottom: 120 },
  kicker: { color: colors.purple, fontSize: 12, letterSpacing: 2, fontWeight: '800' },
  title: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 2 },

  avatarWrap: { alignItems: 'center', marginTop: spacing.lg },
  avatar: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%' },
  bioCard: { marginTop: spacing.lg },
  bioHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  bioLabel: { color: colors.cyan, fontSize: 11, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  bioText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  levelBadge: {
    marginTop: -14,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.green,
  },
  levelBadgeText: { color: colors.green, fontWeight: '900', letterSpacing: 1.5, fontSize: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.md },
  name: { color: colors.text, fontSize: 22, fontWeight: '800' },
  nameEdit: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.md },
  nameInput: {
    backgroundColor: colors.surfaceGlass,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.md,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 180,
    fontSize: 16,
    fontWeight: '700',
  },
  nameBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
  },

  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  statCard: { width: '31.5%', alignItems: 'center', paddingVertical: spacing.md },
  statVal: { color: colors.text, fontSize: 18, fontWeight: '800', marginTop: 4 },
  statLbl: { color: colors.textMuted, fontSize: 10, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'center' },

  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceGlass,
    marginTop: spacing.md,
  },
  actionIcon: {
    width: 40,
    height: 40,
    borderRadius: radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  actionDesc: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  motivCard: { marginTop: spacing.lg },
  anchorCard: {
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.cyan + '55',
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  anchorRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  anchorLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  anchorValue: { color: colors.text, fontSize: 14, fontWeight: '800', marginTop: 2 },
  anchorFoot: { color: colors.textMuted, fontSize: 11, marginTop: 12, textAlign: 'center' },
  motivHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  motivLabel: { color: colors.cyan, fontSize: 11, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  motivDesc: { color: colors.textSecondary, fontSize: 12, marginTop: 6, lineHeight: 17 },
  motivRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.md, gap: 6 },
  motivPill: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.cyan + '12',
    borderWidth: 1,
    borderColor: colors.cyan + '44',
  },
  motivTime: { color: colors.text, fontWeight: '900', fontSize: 14, letterSpacing: -0.5 },
  motivKey: { color: colors.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginTop: 2 },
  footer: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: spacing.xl },
  accountSection: {
    marginTop: spacing.xl,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  accountSectionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.6,
    marginBottom: 4,
  },
  accountInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.surfaceGlass,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  accountEmail: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.green + '22',
    borderWidth: 1,
    borderColor: colors.green + '55',
  },
  verifiedText: {
    color: colors.green,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
});


/**
 * ImmersiveToggleRow — settings row that lets the user pin the bottom
 * tab bar permanently. When OFF (auto-hide enabled), the bar disappears
 * after 5 s; when ON (toggle below shows green), the bar stays put.
 *
 * Wording: the toggle's "ON" state means "always show tab bar", which
 * matches user expectations (toggle ON = bar visible).
 */
function ImmersiveToggleRow() {
  const { immersiveEnabled, setImmersiveEnabled } = useImmersive();
  // immersiveEnabled === true means auto-hide is ON; the user's setting
  // ("Always show navigation bar") is the LOGICAL NEGATION of that.
  const alwaysShow = !immersiveEnabled;
  return (
    <View style={[settingsStyles.row]} testID="profile-immersive-toggle-row">
      <View style={[settingsStyles.icon, { backgroundColor: colors.cyan + '22', borderColor: colors.cyan + '55' }]}>
        <Ionicons name="layers" size={18} color={colors.cyan} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={settingsStyles.title}>Always show navigation bar</Text>
        <Text style={settingsStyles.desc}>
          {alwaysShow
            ? 'Bottom tab bar is pinned and never auto-hides.'
            : 'Auto-hides after 5s. Swipe up from the bottom to bring it back.'}
        </Text>
      </View>
      <Switch
        testID="profile-immersive-toggle"
        value={alwaysShow}
        onValueChange={(v) => setImmersiveEnabled(!v)}
        trackColor={{ false: colors.border, true: colors.cyan + '88' }}
        thumbColor={alwaysShow ? colors.cyan : '#888'}
      />
    </View>
  );
}

const settingsStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 60,
  },
  icon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: colors.text, fontSize: 14, fontWeight: '800' },
  desc: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
});

/**
 * AdminNotificationBell — top-right bell icon shown ONLY on the Creator
 * account. Polls /api/admin/reports every 8s while focused; when there
 * are unviewed reports we render a red badge with the count. Tapping the
 * bell pushes /admin/reports.
 */
function AdminNotificationBell() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const load = useCallback(async () => {
    try {
      const r = await api.adminReportsList();
      setCount(r.new_count || 0);
    } catch {}
  }, []);
  useFocusEffect(
    useCallback(() => {
      load();
      const id = setInterval(load, 8000);
      return () => clearInterval(id);
    }, [load]),
  );
  return (
    <TouchableOpacity
      onPress={() => router.push('/admin/reports')}
      style={bellStyles.btn}
      hitSlop={8}
      testID="admin-bell"
      activeOpacity={0.7}
    >
      <Ionicons name="notifications" size={22} color="#FFD700" />
      {count > 0 && (
        <View style={bellStyles.badge} testID="admin-bell-badge">
          <Text style={bellStyles.badgeText}>{count > 9 ? '9+' : count}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const bellStyles = StyleSheet.create({
  btn: {
    position: 'relative',
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FFD70022',
    borderWidth: 1,
    borderColor: '#FFD70066',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: colors.red,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bg,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '900' },
});

