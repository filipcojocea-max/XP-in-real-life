import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Modal,
  ScrollView,
  Image,
  RefreshControl,
  Animated,
  Easing,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  api,
  LeaderboardResponse,
  LeaderboardRow,
  LeaderboardReport,
  LeaderboardPlayerProfile,
} from '../api';
import { showAlert } from '../uiAlert';
import { colors, spacing, radii } from '../theme';

const GOLD = '#FFD700';
const GOLD_SOFT = '#FFC727';

function tzOffsetNow(): number {
  // JS getTimezoneOffset returns minutes you have to ADD to local to get UTC (reversed).
  // We want offset_minutes so that local_now = utc_now + offset → offset = -getTimezoneOffset()
  return -new Date().getTimezoneOffset();
}

function formatXp(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function weekDaysLeft(tzMin: number): { label: string; days: number } {
  const nowLocal = new Date(Date.now() + tzMin * 60 * 1000);
  const wd = nowLocal.getUTCDay(); // 0=Sun, 1=Mon..6=Sat (since we shifted)
  if (wd === 0) return { label: "Winner's day", days: 0 };
  // Monday=1 → 6 days until Sunday, Saturday=6 → 1 day until Sunday
  const daysUntilSunday = 7 - wd;
  return { label: `${daysUntilSunday}d until Sunday`, days: daysUntilSunday };
}

export default function LeaderboardTab() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [activeReport, setActiveReport] = useState<LeaderboardReport | null>(null);

  const tz = useMemo(() => tzOffsetNow(), []);

  const load = useCallback(async () => {
    try {
      const r = await api.friendsLeaderboard(tz);
      setData(r);
    } catch (e: any) {
      showAlert('Could not load leaderboard', String(e?.message || e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tz]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const wd = weekDaysLeft(tz);
  const winner = data?.winner;
  const declared = !!data?.winner_declared;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.cyan} />
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.center}>
        <Ionicons name="trophy-outline" size={36} color={colors.textMuted} />
        <Text style={styles.emptyTitle}>Leaderboard unavailable</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Header banner */}
      <View style={styles.banner}>
        <View style={styles.bannerLeft}>
          <Ionicons name="trophy" size={16} color={declared ? GOLD : colors.cyan} />
          <Text style={[styles.bannerLabel, declared && { color: GOLD }]}>
            {declared ? "WINNER'S DAY" : 'WEEKLY XP RACE'}
          </Text>
        </View>
        <Text style={styles.bannerSub}>
          {declared
            ? 'Winner declared — rewards dropped into Available Bonuses'
            : `Mon→Sat · ${wd.label}`}
        </Text>
      </View>

      {/* Winner spotlight */}
      {declared && winner ? (
        <WinnerSpotlight winner={winner} onTap={() => setOpenUser(winner.user_id)} />
      ) : null}

      {/* Reports notification */}
      {data.reports && data.reports.length > 0 ? (
        <ReportsBanner
          reports={data.reports}
          onOpenReport={(rep) => setActiveReport(rep)}
          onRefresh={load}
        />
      ) : null}

      {/* Leaderboard list */}
      <FlatList
        data={data.rows}
        keyExtractor={(r) => r.user_id}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cyan} />}
        ListEmptyComponent={
          <View style={styles.center}>
            <Ionicons name="people-outline" size={36} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No friends yet</Text>
            <Text style={styles.emptyDesc}>Add friends from the Players tab to start competing.</Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <LeaderRow
            row={item}
            rank={index + 1}
            isWinner={declared && winner?.user_id === item.user_id}
            onPress={() => setOpenUser(item.user_id)}
          />
        )}
      />

      {/* Profile/medal modal */}
      <LeaderboardProfileModal
        userId={openUser}
        tz={tz}
        onClose={() => setOpenUser(null)}
        onReportSubmitted={load}
      />

      {/* Report detail modal */}
      <ReportModal
        report={activeReport}
        onClose={() => setActiveReport(null)}
        onChange={load}
      />
    </View>
  );
}

// ───────────── Winner spotlight with gold glow ─────────────
function WinnerSpotlight({ winner, onTap }: { winner: LeaderboardRow & { medal_revoked?: boolean }; onTap: () => void }) {
  const glow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(glow, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ])
    ).start();
  }, [glow]);
  const shadowRadius = glow.interpolate({ inputRange: [0, 1], outputRange: [8, 24] });
  const opacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  const revoked = winner.medal_revoked;

  return (
    <TouchableOpacity activeOpacity={0.9} onPress={onTap} style={{ marginHorizontal: spacing.lg, marginBottom: spacing.md }}>
      <Animated.View
        style={[
          styles.winnerCard,
          revoked && { borderColor: colors.red + 'aa', backgroundColor: colors.red + '12' },
          !revoked && {
            shadowColor: GOLD,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: opacity as any,
            shadowRadius: shadowRadius as any,
          },
        ]}
      >
        <View style={[styles.winnerAvatarWrap, !revoked && styles.winnerAvatarGold]}>
          {winner.avatar_base64 ? (
            <Image source={{ uri: `data:image/jpeg;base64,${winner.avatar_base64}` }} style={styles.winnerAvatar} />
          ) : (
            <View style={[styles.winnerAvatar, { backgroundColor: GOLD + '22', alignItems: 'center', justifyContent: 'center' }]}>
              <Text style={{ color: GOLD, fontWeight: '900', fontSize: 26 }}>
                {(winner.name || '?').slice(0, 1).toUpperCase()}
              </Text>
            </View>
          )}
          {revoked ? (
            <View style={styles.brokenMedalOverlay}>
              <Ionicons name="close-circle" size={24} color={colors.red} />
            </View>
          ) : (
            <View style={styles.goldCrown}>
              <Ionicons name="trophy" size={18} color={GOLD} />
            </View>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.winnerKicker}>
            {revoked ? 'DISQUALIFIED' : "THIS WEEK'S CHAMPION"}
          </Text>
          <Text style={[styles.winnerName, !revoked && styles.winnerNameGold]}>
            {winner.name}
          </Text>
          <Text style={styles.winnerXp}>
            {winner.weekly_xp} weekly XP · Lv {winner.level}
          </Text>
          {revoked ? (
            <Text style={styles.revokedNote}>
              Reward revoked — majority flagged cheating
            </Text>
          ) : (
            <View style={styles.rewardChip}>
              <Ionicons name="gift" size={11} color={GOLD} />
              <Text style={styles.rewardChipText}>Rewarded: 2× XP for a day</Text>
            </View>
          )}
        </View>
        <Ionicons name="chevron-forward" size={20} color={revoked ? colors.red : GOLD} />
      </Animated.View>
    </TouchableOpacity>
  );
}

// ───────────── Leaderboard row ─────────────
function LeaderRow({ row, rank, isWinner, onPress }: { row: LeaderboardRow; rank: number; isWinner: boolean; onPress: () => void }) {
  const rankColor = rank === 1 ? GOLD : rank === 2 ? '#C0C0C0' : rank === 3 ? '#CD7F32' : colors.textMuted;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[
        styles.row,
        row.is_self && styles.rowSelf,
        isWinner && styles.rowWinner,
      ]}
      testID={`lb-row-${row.user_id}`}
    >
      <View style={[styles.rankBadge, { borderColor: rankColor + '88', backgroundColor: rankColor + '22' }]}>
        <Text style={[styles.rankText, { color: rankColor }]}>{rank}</Text>
      </View>
      <View style={[styles.avatarWrap, isWinner && styles.avatarGoldRing]}>
        {row.avatar_base64 ? (
          <Image source={{ uri: `data:image/jpeg;base64,${row.avatar_base64}` }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarLetter}>{(row.name || '?').slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.nameRow}>
          <Text
            style={[styles.name, isWinner && styles.nameGold, row.is_self && !isWinner && { color: colors.cyan }]}
            numberOfLines={1}
          >
            {row.name}{row.is_self ? ' (you)' : ''}
          </Text>
          {row.medals_count > 0 ? (
            <View style={styles.medalPill}>
              <Ionicons name="trophy" size={10} color={GOLD} />
              <Text style={styles.medalPillText}>{row.medals_count}</Text>
            </View>
          ) : null}
          {row.medals_revoked > 0 ? (
            <View style={[styles.medalPill, { borderColor: colors.red + '88', backgroundColor: colors.red + '18' }]}>
              <Ionicons name="close-circle" size={10} color={colors.red} />
              <Text style={[styles.medalPillText, { color: colors.red }]}>{row.medals_revoked}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.sub}>Lv {row.level} · Total {formatXp(row.total_xp)} XP</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.weeklyXp, isWinner && { color: GOLD }]}>{row.weekly_xp}</Text>
        <Text style={styles.weeklyXpLabel}>THIS WK</Text>
      </View>
    </TouchableOpacity>
  );
}

// ───────────── Reports banner ─────────────
function ReportsBanner({
  reports, onOpenReport, onRefresh,
}: { reports: LeaderboardReport[]; onOpenReport: (r: LeaderboardReport) => void; onRefresh: () => void }) {
  return (
    <View style={styles.reportsWrap}>
      {reports.slice(0, 3).map((r) => (
        <TouchableOpacity
          key={r.id}
          activeOpacity={0.85}
          onPress={() => onOpenReport(r)}
          style={styles.reportRow}
        >
          <Ionicons name="warning" size={18} color={colors.amber} />
          <View style={{ flex: 1 }}>
            <Text style={styles.reportTitle} numberOfLines={1}>
              {r.reporter_name} reports {r.reported_name} for cheating
            </Text>
            <Text style={styles.reportMeta}>
              {r.supporters_count} agree · tap to review
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ───────────── Report detail modal ─────────────
function ReportModal({
  report, onClose, onChange,
}: { report: LeaderboardReport | null; onClose: () => void; onChange: () => void }) {
  const [working, setWorking] = useState(false);
  if (!report) return null;

  const toggleSupport = async () => {
    setWorking(true);
    try {
      if (report.viewer_supported) {
        await api.unsupportReport(report.id);
      } else {
        await api.supportReport(report.id);
      }
      onChange();
      onClose();
    } catch (e: any) {
      showAlert('Could not update', String(e?.message || e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <Ionicons name="warning" size={22} color={colors.amber} />
            <Text style={styles.modalTitle}>Cheating Report</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
            <Text style={styles.modalLabel}>REPORTED PLAYER</Text>
            <Text style={styles.modalBigText}>{report.reported_name}</Text>
            <Text style={styles.modalLabel}>REPORTED BY</Text>
            <Text style={styles.modalText}>{report.reporter_name}</Text>
            <Text style={styles.modalLabel}>REASON</Text>
            <View style={styles.reasonBox}>
              <Text style={styles.reasonText}>{report.reason}</Text>
            </View>
            <Text style={styles.modalLabel}>WEEK</Text>
            <Text style={styles.modalText}>{report.week_key}</Text>
            <Text style={styles.modalLabel}>AGREEMENT</Text>
            <Text style={styles.modalText}>
              {report.supporters_count} {report.supporters_count === 1 ? 'person' : 'people'} currently agree
            </Text>
            <View style={{ height: spacing.lg }} />
            {report.viewer_is_reporter ? (
              <View style={[styles.cta, { backgroundColor: colors.amber + '22', borderColor: colors.amber }]}>
                <Ionicons name="checkmark" size={16} color={colors.amber} />
                <Text style={[styles.ctaText, { color: colors.amber }]}>You filed this report</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={[
                  styles.cta,
                  report.viewer_supported
                    ? { backgroundColor: colors.red + '22', borderColor: colors.red }
                    : { backgroundColor: colors.amber, borderColor: colors.amber },
                ]}
                onPress={toggleSupport}
                disabled={working}
              >
                {working ? (
                  <ActivityIndicator color={colors.bg} />
                ) : (
                  <>
                    <Ionicons
                      name={report.viewer_supported ? 'close-circle' : 'thumbs-up'}
                      size={16}
                      color={report.viewer_supported ? colors.red : colors.bg}
                    />
                    <Text style={[styles.ctaText, { color: report.viewer_supported ? colors.red : colors.bg }]}>
                      {report.viewer_supported ? 'Withdraw agreement' : 'I agree this is cheating'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}
            <Text style={styles.footnote}>
              If more than half of the leaderboard agrees, the reported player will lose this week's bonus.
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ───────────── Leaderboard player profile modal (with medals + report button) ─────────────
function LeaderboardProfileModal({
  userId, tz, onClose, onReportSubmitted,
}: { userId: string | null; tz: number; onClose: () => void; onReportSubmitted: () => void }) {
  const [profile, setProfile] = useState<LeaderboardPlayerProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [showReportForm, setShowReportForm] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      setShowReportForm(false);
      setReason('');
      return;
    }
    setLoading(true);
    api
      .leaderboardProfile(userId, tz)
      .then(setProfile)
      .catch((e) => showAlert('Could not load profile', String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [userId, tz]);

  const submit = async () => {
    if (!profile) return;
    if (!reason.trim()) {
      showAlert('Missing reason', 'Please explain why you think this player is cheating.');
      return;
    }
    setSubmitting(true);
    try {
      await api.reportPlayer(profile.user_id, reason.trim());
      showAlert('Report submitted', 'Other leaderboard members will see your report and can agree with it.');
      setShowReportForm(false);
      setReason('');
      onReportSubmitted();
      onClose();
    } catch (e: any) {
      showAlert('Could not report', String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  if (!userId) return null;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={styles.pageHeader}>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.pageTitle}>Player</Text>
            <View style={{ width: 24 }} />
          </View>
          {loading || !profile ? (
            <View style={styles.center}><ActivityIndicator color={colors.cyan} /></View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl }}>
              {/* Avatar */}
              <View style={styles.profileHead}>
                <View style={[styles.profileAvatarWrap, profile.is_flagged_cheater && { borderColor: colors.red }]}>
                  {profile.avatar_base64 ? (
                    <Image
                      source={{ uri: `data:image/jpeg;base64,${profile.avatar_base64}` }}
                      style={styles.profileAvatar}
                    />
                  ) : (
                    <View style={[styles.profileAvatar, styles.avatarFallback]}>
                      <Text style={{ color: colors.cyan, fontWeight: '900', fontSize: 42 }}>
                        {(profile.name || '?').slice(0, 1).toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.profileName, profile.is_flagged_cheater && { color: colors.red }]}>
                  {profile.name}
                </Text>
                <Text style={styles.profileSub}>Lv {profile.level} · {profile.total_xp} total XP</Text>
                {profile.is_flagged_cheater ? (
                  <View style={styles.cheaterBadge}>
                    <Ionicons name="alert-circle" size={12} color={colors.red} />
                    <Text style={styles.cheaterBadgeText}>FLAGGED FOR CHEATING</Text>
                  </View>
                ) : null}
              </View>

              {/* Stats */}
              <View style={styles.statsGrid}>
                <Stat icon="flash" color={colors.amber} value={String(profile.weekly_xp)} label="This Week" />
                <Stat icon="flame" color={colors.red} value={String(profile.current_streak)} label="Streak" />
                <Stat icon="trophy" color={GOLD} value={String(profile.medals.filter((m) => !m.revoked).length)} label="Medals" />
              </View>

              {/* Medals timeline */}
              <Text style={styles.sectionLabel}>WINNING HISTORY</Text>
              {profile.medals.length === 0 ? (
                <Text style={styles.emptyDesc}>No weekly wins yet.</Text>
              ) : (
                profile.medals.map((m, i) => (
                  <View key={`${m.week_key}-${i}`} style={[styles.medalRow, m.revoked && styles.medalRowRevoked]}>
                    <Ionicons
                      name={m.revoked ? 'close-circle' : 'trophy'}
                      size={22}
                      color={m.revoked ? colors.red : GOLD}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.medalTitle}>
                        Week {m.week_key} {m.revoked ? '(revoked)' : 'Winner'}
                      </Text>
                      <Text style={styles.medalSub}>
                        {m.xp} weekly XP{m.revoked ? ` · ${m.revoked_reason || 'flagged'}` : ' · +2× XP bonus rewarded'}
                      </Text>
                    </View>
                  </View>
                ))
              )}

              {/* Report action */}
              {profile.friend_status !== 'self' ? (
                <View style={{ marginTop: spacing.lg }}>
                  {showReportForm ? (
                    <View style={styles.reportForm}>
                      <Text style={styles.sectionLabel}>REPORT REASON</Text>
                      <TextInput
                        value={reason}
                        onChangeText={setReason}
                        placeholder="Explain why you think this player is cheating..."
                        placeholderTextColor={colors.textMuted}
                        style={styles.reasonInput}
                        multiline
                        maxLength={500}
                      />
                      <Text style={styles.charCount}>{reason.length}/500</Text>
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <TouchableOpacity
                          style={[styles.cta, { flex: 1, backgroundColor: colors.surfaceGlass, borderColor: colors.border }]}
                          onPress={() => { setShowReportForm(false); setReason(''); }}
                        >
                          <Text style={[styles.ctaText, { color: colors.textMuted }]}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.cta, { flex: 1, backgroundColor: colors.red, borderColor: colors.red }]}
                          onPress={submit}
                          disabled={submitting}
                        >
                          {submitting ? <ActivityIndicator color={colors.bg} /> :
                            <Text style={[styles.ctaText, { color: colors.bg }]}>Submit report</Text>}
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={[styles.cta, { borderColor: colors.red, backgroundColor: colors.red + '15' }]}
                      onPress={() => setShowReportForm(true)}
                    >
                      <Ionicons name="warning" size={16} color={colors.red} />
                      <Text style={[styles.ctaText, { color: colors.red }]}>Report player as cheating</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : null}
            </ScrollView>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function Stat({ icon, color, value, label }: { icon: string; color: string; value: string; label: string }) {
  return (
    <View style={styles.statBox}>
      <Ionicons name={icon as any} size={18} color={color} />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: 8 },
  emptyTitle: { color: colors.text, fontWeight: '900', fontSize: 15, marginTop: 6 },
  emptyDesc: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },

  banner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.lg,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bannerLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bannerLabel: { color: colors.cyan, fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
  bannerSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  winnerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: GOLD + '12',
    borderWidth: 2,
    borderColor: GOLD + 'bb',
    borderRadius: radii.lg,
    padding: spacing.md,
    elevation: 8,
  },
  winnerAvatarWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    position: 'relative',
  },
  winnerAvatarGold: {
    borderWidth: 3,
    borderColor: GOLD,
  },
  winnerAvatar: { width: 58, height: 58, borderRadius: 29 },
  goldCrown: {
    position: 'absolute',
    bottom: -4,
    right: -4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: GOLD,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brokenMedalOverlay: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginLeft: -12,
    marginTop: -12,
  },
  winnerKicker: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  winnerName: { color: colors.text, fontSize: 20, fontWeight: '900', marginTop: 2 },
  winnerNameGold: { color: GOLD_SOFT, textShadowColor: GOLD, textShadowRadius: 8 },
  winnerXp: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  rewardChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
    backgroundColor: GOLD + '22',
    borderWidth: 1,
    borderColor: GOLD + '88',
  },
  rewardChipText: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  revokedNote: { color: colors.red, fontSize: 12, fontWeight: '700', marginTop: 6 },

  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: 8,
  },
  rowSelf: { borderColor: colors.cyan + '88', backgroundColor: colors.cyan + '08' },
  rowWinner: { borderColor: GOLD + '99', backgroundColor: GOLD + '10' },
  rankBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  rankText: { fontWeight: '900', fontSize: 13 },
  avatarWrap: { position: 'relative' },
  avatarGoldRing: {
    padding: 2,
    borderRadius: 26,
    borderWidth: 2,
    borderColor: GOLD,
  },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  avatarFallback: {
    backgroundColor: colors.cyan + '22',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.cyan + '55',
  },
  avatarLetter: { color: colors.cyan, fontWeight: '900', fontSize: 16 },

  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  name: { color: colors.text, fontWeight: '900', fontSize: 14, flexShrink: 1 },
  nameGold: { color: GOLD },
  sub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  weeklyXp: { color: colors.amber, fontWeight: '900', fontSize: 16 },
  weeklyXpLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },

  medalPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: GOLD + '18',
    borderWidth: 1,
    borderColor: GOLD + '88',
  },
  medalPillText: { color: GOLD, fontSize: 10, fontWeight: '900' },

  reportsWrap: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.amber + '10',
    borderWidth: 1,
    borderColor: colors.amber + '55',
    overflow: 'hidden',
  },
  reportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.amber + '22',
  },
  reportTitle: { color: colors.text, fontWeight: '800', fontSize: 13 },
  reportMeta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    maxHeight: '85%',
    backgroundColor: colors.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: colors.amber + '55',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 10,
  },
  modalTitle: { flex: 1, color: colors.text, fontWeight: '900', fontSize: 16 },
  modalLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginTop: 12 },
  modalText: { color: colors.text, fontSize: 14, marginTop: 4 },
  modalBigText: { color: colors.text, fontSize: 20, fontWeight: '900', marginTop: 4 },
  reasonBox: {
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: 10,
    marginTop: 4,
  },
  reasonText: { color: colors.text, fontSize: 13, lineHeight: 18 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  ctaText: { fontWeight: '900', fontSize: 14, letterSpacing: 0.4 },
  footnote: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: spacing.md, lineHeight: 16 },

  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pageTitle: { color: colors.text, fontWeight: '900', fontSize: 16 },

  profileHead: { alignItems: 'center', marginBottom: spacing.lg },
  profileAvatarWrap: {
    width: 106,
    height: 106,
    borderRadius: 53,
    padding: 3,
    borderWidth: 2,
    borderColor: colors.cyan,
  },
  profileAvatar: { width: 96, height: 96, borderRadius: 48 },
  profileName: { color: colors.text, fontWeight: '900', fontSize: 22, marginTop: 10 },
  profileSub: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  cheaterBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.red + '22',
    borderWidth: 1,
    borderColor: colors.red,
  },
  cheaterBadgeText: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },

  statsGrid: { flexDirection: 'row', gap: 8, marginBottom: spacing.md },
  statBox: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  statValue: { color: colors.text, fontWeight: '900', fontSize: 18 },
  statLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },

  sectionLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginTop: 8, marginBottom: 8 },
  medalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: GOLD + '12',
    borderWidth: 1,
    borderColor: GOLD + '55',
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: 6,
  },
  medalRowRevoked: { backgroundColor: colors.red + '12', borderColor: colors.red + '55' },
  medalTitle: { color: colors.text, fontWeight: '900', fontSize: 13 },
  medalSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },

  reportForm: {
    backgroundColor: colors.surfaceGlass,
    borderWidth: 1,
    borderColor: colors.red + '55',
    borderRadius: radii.md,
    padding: spacing.md,
  },
  reasonInput: {
    minHeight: 80,
    color: colors.text,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: 10,
    fontSize: 14,
    textAlignVertical: 'top',
    marginTop: 4,
  },
  charCount: { color: colors.textMuted, fontSize: 10, textAlign: 'right', marginTop: 4 },
});
