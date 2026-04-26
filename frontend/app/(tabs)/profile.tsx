import React, { useCallback, useEffect, useState } from 'react';
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import Card from '../../src/components/Card';
import Ring from '../../src/components/Ring';
import { api, Profile } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';
import { getMotivationSchedule } from '../../src/notifications';
import { useAuth } from '../../src/AuthContext';

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
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.kicker}>Character</Text>
        <Text style={styles.title}>Profile</Text>

        <View style={styles.avatarWrap}>
          <Ring size={150} stroke={8} progress={profile.xp_progress} color={colors.amber}>
            <View style={styles.avatar}>
              {profile.avatar_base64 ? (
                <Image source={{ uri: profile.avatar_base64 }} style={styles.avatarImg} />
              ) : (
                <Ionicons name="shield" size={70} color={colors.cyan} />
              )}
            </View>
          </Ring>
          <View style={styles.levelBadge}>
            <Text style={styles.levelBadgeText}>LV {profile.level}</Text>
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
                <Text style={styles.actionTitle}>Create Account</Text>
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
