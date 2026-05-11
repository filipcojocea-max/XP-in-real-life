import type { FocusArea, TimeSlot } from './theme';
import { getAuthToken, getAnonymousId, fireUnauthorized, fireAccountSuspended } from './AuthContext';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((opts.headers as Record<string, string>) || {}),
  };
  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    const anon = getAnonymousId();
    if (anon) headers['X-Anonymous-Id'] = anon;
  }
  const res = await fetch(`${BASE}/api${path}`, { ...opts, headers });
  if (res.status === 401) {
    fireUnauthorized();
    const text = await res.text().catch(() => '');
    throw new Error(`Session expired — please sign in again. ${text}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Try to surface the FastAPI `detail` field as a human-readable message
    // so users don't see raw JSON like `{"detail":"..."}` in the UI.
    let pretty = text || path;
    let detail: any = null;
    try {
      const data = JSON.parse(text);
      detail = data?.detail ?? null;
      if (data?.detail) {
        if (typeof data.detail === 'string') pretty = data.detail;
        else if (Array.isArray(data.detail)) {
          pretty = data.detail
            .map((d: any) => d?.msg || JSON.stringify(d))
            .join(', ');
        } else if (typeof data.detail === 'object' && data.detail.message) {
          pretty = data.detail.message;
        } else {
          pretty = JSON.stringify(data.detail);
        }
      } else if (data?.message) {
        pretty = data.message;
      }
    } catch {
      // not JSON — keep raw text
    }
    // Account-suspension trap: 403 with detail.error='account_suspended'
    // forces a global logout via fireAccountSuspended() which the root
    // layout listens for to render the golden "you are suspended" alert.
    if (
      res.status === 403 &&
      detail && typeof detail === 'object' &&
      detail.error === 'account_suspended'
    ) {
      try { fireAccountSuspended(detail); } catch {}
    }
    const err: any = new Error(pretty);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json() as Promise<T>;
}

export type Profile = {
  name: string;
  total_xp: number;
  level: number;
  xp_in_level: number;
  xp_to_next: number;
  xp_progress: number;
  is_max_level: boolean;
  current_streak: number;
  longest_streak: number;
  last_active_date: string | null;
  tasks_completed: number;
  goals_created: number;
  goals_completed: number;
  achievements_unlocked: string[];
  onboarding_complete: boolean;
  onboarding: Record<string, any>;
  bio: string;
  avatar_base64: string | null;
  wake_time?: string;
  morning_setup_done?: boolean;
  boosts_unlocked?: boolean;
  active_boost?: {
    type: string;
    multiplier: number;
    activated_at: string;
    expires_at: string;
  } | null;
  boost_inventory?: BoostInventoryItem[];
  tz_offset_minutes?: number;
  // New day-anchor system
  day_start_time?: string | null;
  timezone?: string | null;
  onboarding_tz_done?: boolean;
  // Spot the Object mini-app
  spot_points?: number;
  spot_random_enabled?: boolean;
  // Creator/Admin (Premium+)
  is_admin?: boolean;
};

export type BoostInventoryItem = {
  id: string;
  type: string;
  multiplier: number;
  duration_days: number;
  label: string;
  source: 'shop' | 'leaderboard_winner' | string;
  acquired_at: string;
};

/**
 * Compute the user's "current day" date string (YYYY-MM-DD) based on their
 * selected `day_start_time` (HH:MM) in their IANA `timezone`. The day rolls
 * over AT day_start_time (not 2h before, not real midnight).
 *
 *   day_start_time = "07:00", tz = "Australia/Sydney"
 *   → before 7am Sydney = yesterday's day
 *   → on/after 7am Sydney = today
 *
 * If timezone is missing, falls back to device local time.
 * Legacy callers pass just a wake_time string — we treat it as day_start_time
 * in the device's local zone for backward compat.
 */
export function userDate(
  dayStartOrWake: string = '07:00',
  timezone?: string | null,
): string {
  const [wh = 7, wm = 0] = (dayStartOrWake || '07:00').split(':').map((x) => parseInt(x, 10));
  let now: { y: number; mo: number; d: number; h: number; mi: number };
  if (timezone && typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const parts: any = {};
      for (const p of fmt.formatToParts(new Date())) if (p.type !== 'literal') parts[p.type] = p.value;
      now = {
        y: parseInt(parts.year, 10),
        mo: parseInt(parts.month, 10),
        d: parseInt(parts.day, 10),
        h: parseInt(parts.hour === '24' ? '0' : parts.hour, 10),
        mi: parseInt(parts.minute, 10),
      };
    } catch {
      const d = new Date();
      now = { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
    }
  } else {
    const d = new Date();
    now = { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  }
  // If current local time < day_start_time → we're still in yesterday
  const before = now.h < wh || (now.h === wh && now.mi < wm);
  const d = new Date(Date.UTC(now.y, now.mo - 1, now.d));
  if (before) d.setUTCDate(d.getUTCDate() - 1);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Helper to pull the right {day_start_time, timezone} tuple from a profile. */
export function userDayAnchor(p: Profile | null | undefined) {
  const day_start = p?.day_start_time || p?.wake_time || '07:00';
  const tz = p?.timezone || null;
  return { day_start, tz };
}

export type Task = {
  id: string;
  title: string;
  description: string;
  focus_area: FocusArea;
  time_slot: TimeSlot;
  xp_value: number;
  recurring: boolean;
  scheduled_time?: string | null;
  reminder_enabled?: boolean;
  is_default?: boolean;
  completed?: boolean;
  created_at: string;
};

export type Goal = {
  id: string;
  title: string;
  description: string;
  focus_area: FocusArea;
  target_value: number;
  current_value: number;
  unit: string;
  xp_reward?: number;
  completed: boolean;
  created_at: string;
  completed_at: string | null;
  awarded_xp?: number;
  // Cycle-lockout fields. Filled in by the backend.
  // `next_tick_available_at` is null until the user has ticked once.
  last_ticked_at?: string | null;
  next_tick_available_at?: string | null;
  is_locked?: boolean;
};

export type Achievement = {
  id: string;
  title: string;
  description: string;
  icon: string;
  type: string;
  threshold: number;
  unlocked: boolean;
};

export type DailyStats = {
  date: string;
  rings: Record<FocusArea, { total: number; done: number; progress: number }>;
  total_tasks: number;
  total_done: number;
  xp_today: number;
};

export type WeeklyStats = { days: { date: string; day: string; xp: number; gifted_xp?: number; tasks: number }[] };

export type OnboardingPayload = {
  name?: string;
  main_goals?: string[];
  experience_level?: string;
  productivity_score?: number;
  loves?: string[];
  loves_other?: string;
  focused_time?: string;
  focused_window?: string;
  good_habits?: string[];
  good_habits_other?: string;
  bad_habits?: string[];
  bad_habits_other?: string;
  age_range?: string;
  gender?: string;
};

export const api = {
  // Auth
  authRegister: (full_name: string, email: string, password: string) =>
    req<{ message: string; email: string; dev_code?: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ full_name, email, password }),
    }),
  authVerify: (email: string, code: string) =>
    req<{ token: string; user: { id: string; full_name: string; email: string; verified: boolean } }>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),
  authLogin: (email: string, password: string) =>
    req<any>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  authResend: (email: string) =>
    req<{ message: string; dev_code?: string }>('/auth/resend', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  authForgotPassword: (email: string, app_origin?: string) =>
    req<{
      message: string;
      email: string;
      email_delivered: boolean;
      dev_code?: string;
      dev_link?: string;
    }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email, app_origin }),
    }),
  authResetPasswordVerifyToken: (token: string) =>
    req<{ valid: boolean; email: string }>('/auth/reset-password-verify-token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  authResetPasswordWithCode: (email: string, code: string, new_password: string) =>
    req<{ token: string; user: any }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email, code, new_password }),
    }),
  authResetPasswordWithToken: (token: string, new_password: string) =>
    req<{ token: string; user: any }>('/auth/reset-password-token', {
      method: 'POST',
      body: JSON.stringify({ token, new_password }),
    }),

  // ── Challenge Tasks mini-app ────────────────────────────────────
  challengeToday: () =>
    req<ChallengeTodayResp>('/challenge/today'),
  challengeAccept: () =>
    req<{ status: string; challenge: ChallengeContent }>('/challenge/accept', { method: 'POST' }),
  challengeReject: () =>
    req<{ status: string }>('/challenge/reject', { method: 'POST' }),
  challengeComplete: (body: {
    completed: boolean;
    how_text?: string;
    difficulty: 'easy' | 'difficult';
    experience_text?: string;
    rating: number;
  }) =>
    req<{ awarded_xp: number; completion: ChallengeCompletion }>('/challenge/complete', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  challengePast: () =>
    req<{ completions: ChallengeCompletion[]; count: number }>('/challenge/past'),
  challengePastDelete: (id: string) =>
    req<{ deleted: number }>(`/challenge/past/${id}`, { method: 'DELETE' }),

  // ─── Friends+ ────────────────────────────────────────────────────────
  listPlayers: (q: string = '') =>
    req<{ players: Player[] }>(`/friends/players?q=${encodeURIComponent(q)}`),
  playerProfile: (userId: string) =>
    req<Player>(`/friends/profile/${userId}`),
  playerProfileDetails: (userId: string) =>
    req<FriendProfileDetails>(`/friends/profile/${userId}/details`),

  // ── Admin: account suspension (Creator only) ─────────────────────
  adminSuspendUser: (
    userId: string,
    opts: { duration_hours?: number; forever?: boolean; reason?: string }
  ) =>
    req<AdminSuspendResult>('/admin/suspend', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, ...opts }),
    }),
  adminUnsuspendUser: (userId: string) =>
    req<{ ok: boolean; user_id: string; modified: number }>('/admin/unsuspend', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    }),
  adminSuspensionStatus: (userId: string) =>
    req<AdminSuspensionStatus>(`/admin/suspension/${userId}`),

  // ── Admin: Players by creation date (Creator only) ────────────────
  // Used by the new "View Players Dates" tab in Friends+. Supports
  // newest/oldest sort, week/month/all time-window filter, free-text
  // search and pagination via `limit`.
  adminPlayersByCreation: (opts: {
    order?: 'newest' | 'oldest';
    since?: 'all' | 'week' | 'month';
    q?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (opts.order) qs.set('order', opts.order);
    if (opts.since) qs.set('since', opts.since);
    if (opts.q) qs.set('q', opts.q);
    if (opts.limit) qs.set('limit', String(opts.limit));
    return req<{ players: AdminPlayerRow[]; count: number; order: string; since: string }>(
      `/admin/players/by-creation?${qs.toString()}`,
    );
  },

  // ── Admin: Player charts bundle (Creator only) ───────────────────
  // Returns the same data shape used by the user's own /stats/weekly +
  // /stats/monthly + /stats/by-area endpoints, bundled together for the
  // "View Progress charts" drill-down on any player profile.
  adminPlayerCharts: (playerId: string) =>
    req<{
      user_id: string;
      weekly: { days: { date: string; day: string; xp: number; gifted_xp: number; tasks: number }[] };
      monthly: { days: { date: string; day: string; xp: number; gifted_xp: number; tasks: number }[] };
      by_area: Record<string, number>;
    }>(`/admin/players/${playerId}/charts`),


  // Top-100 players by total XP, with switchable rolling window.
  adminGlobalLeaderboard: (opts: { period?: 'all' | 'week' | 'month' | 'year'; q?: string }) => {
    const qs = new URLSearchParams();
    if (opts.period) qs.set('period', opts.period);
    if (opts.q) qs.set('q', opts.q);
    return req<{ leaderboard: AdminLeaderboardRow[]; period: string }>(
      `/admin/leaderboard/global?${qs.toString()}`,
    );
  },


  // ── Admin: Gifts (XP / Bonus Top-Up) ────────────────────────────
  adminGiftXP: (userId: string, amount: number, message?: string) =>
    req<{ ok: boolean; gift: GiftEntry }>('/admin/gift/xp', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, amount, message: message || '' }),
    }),
  adminGiftBoost: (
    userId: string,
    opts: {
      boost_type?: string;
      custom_label?: string;
      custom_multiplier?: number;
      custom_duration_days?: number;
      message?: string;
    }
  ) =>
    req<{ ok: boolean; gift: GiftEntry; inventory_entry: any }>('/admin/gift/boost', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, ...opts }),
    }),
  giftsPending: () => req<{ gifts: GiftEntry[] }>('/gifts/pending'),
  giftsAck: (giftId: string) =>
    req<{ ok: boolean; updated: number }>('/gifts/ack', {
      method: 'POST',
      body: JSON.stringify({ gift_id: giftId }),
    }),

  // ── Admin: Spot-the-Object Train Mode ───────────────────────────
  adminSpotTrainingList: () =>
    req<{ objects: SpotTrainingObject[] }>('/admin/spot/training/objects'),
  adminSpotTrainingStart: (objectName?: string) =>
    req<SpotTrainingSession>('/admin/spot/training/start', {
      method: 'POST',
      body: JSON.stringify({ object_name: objectName || null }),
    }),
  adminSpotTrainingCapture: (objectName: string, angle: string, imageBase64: string) =>
    req<SpotTrainingCaptureResult>('/admin/spot/training/capture', {
      method: 'POST',
      body: JSON.stringify({ object_name: objectName, angle, image_base64: imageBase64 }),
    }),
  adminSpotTrainingSkip: (objectName: string) =>
    req<{ ok: boolean }>('/admin/spot/training/skip', {
      method: 'POST',
      body: JSON.stringify({ object_name: objectName }),
    }),
  sendFriendRequest: (userId: string) =>
    req<{ status: FriendStatus; message: string }>('/friends/request', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    }),
  acceptFriendRequest: (fromUserId: string) =>
    req<{ status: FriendStatus }>('/friends/accept', {
      method: 'POST',
      body: JSON.stringify({ user_id: fromUserId }),
    }),
  declineFriendRequest: (otherUserId: string) =>
    req<{ status: FriendStatus }>('/friends/decline', {
      method: 'POST',
      body: JSON.stringify({ user_id: otherUserId }),
    }),
  removeFriend: (otherUserId: string) =>
    req<{ status: FriendStatus }>('/friends/remove', {
      method: 'POST',
      body: JSON.stringify({ user_id: otherUserId }),
    }),
  listFriendRequests: () =>
    req<{ incoming: FriendRequestEntry[]; outgoing: FriendRequestEntry[] }>(
      '/friends/requests'
    ),
  listFriends: () => req<{ friends: Player[] }>('/friends/list'),

  // ─── Points+ XP Boosts ───────────────────────────────────────────────
  unlockBoosts: (code: string) =>
    req<{ boosts_unlocked: boolean; profile: Profile }>('/boosts/unlock', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  activateBoost: (args: { type?: 'triple_day' | 'double_week' | 'double_month' | 'double_day'; inventory_id?: string }) =>
    req<{ active_boost: any; profile: Profile }>('/boosts/activate', {
      method: 'POST',
      body: JSON.stringify(args),
    }),
  claimBoost: (type: 'triple_day' | 'double_week' | 'double_month') =>
    req<{ claimed: BoostInventoryItem; profile: Profile }>('/boosts/claim', {
      method: 'POST',
      body: JSON.stringify({ type }),
    }),
  boostsStatus: () =>
    req<{ boosts_unlocked: boolean; active_boost: any; boost_inventory: BoostInventoryItem[] }>('/boosts/status'),

  // ─── Friends Leaderboard ─────────────────────────────────────────────
  friendsLeaderboard: (tzOffsetMinutes: number) =>
    req<LeaderboardResponse>(`/friends/leaderboard?tz=${encodeURIComponent(String(tzOffsetMinutes))}`),
  leaderboardProfile: (userId: string, tzOffsetMinutes: number) =>
    req<LeaderboardPlayerProfile>(
      `/leaderboard/profile/${userId}?tz=${encodeURIComponent(String(tzOffsetMinutes))}`
    ),
  reportPlayer: (reportedUserId: string, reason: string) =>
    req<{ report: any }>('/leaderboard/report', {
      method: 'POST',
      body: JSON.stringify({ reported_user_id: reportedUserId, reason }),
    }),
  supportReport: (reportId: string) =>
    req<{ supporters_count: number }>(`/leaderboard/report/${reportId}/support`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  unsupportReport: (reportId: string) =>
    req<{ supporters_count: number }>(`/leaderboard/report/${reportId}/support`, {
      method: 'DELETE',
    }),

  // ─── Spot the Object (mini-app) ──────────────────────────────────────
  spotGetObject: () => req<{ object: string; challenge_id: string }>('/spot/object'),
  spotCheck: (target_object: string, photo_base64: string) =>
    req<{ detected: boolean; confidence: number; reason: string; can_capture: boolean }>(
      '/spot/check',
      { method: 'POST', body: JSON.stringify({ target_object, photo_base64 }) },
    ),
  spotComplete: (body: {
    target_object: string;
    photo_base64: string;
    success: boolean;
    remaining_seconds?: number;
    mode?: 'solo_constant' | 'solo_random' | 'friends';
  }) =>
    req<{ entry: SpotEntry; points_delta: number; spot_points: number; profile: Profile }>(
      '/spot/complete',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  spotFeed: (limit = 50) =>
    req<{ entries: SpotEntry[]; count: number }>(`/spot/feed?limit=${limit}`),
  spotEntry: (id: string) => req<SpotEntry>(`/spot/${id}`),
  spotLike: (id: string) =>
    req<{ like_count: number; liked_by_you: boolean }>(`/spot/${id}/like`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  spotComment: (id: string, text: string) =>
    req<{ comments: SpotComment[] }>(`/spot/${id}/comment`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  spotRandomToggle: (enabled: boolean) =>
    req<{ spot_random_enabled: boolean; profile: Profile }>('/spot/random-toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  // Post-capture photo editing — preview an artistic filter then
  // optionally save it over the original spot image.
  spotEditPreview: (entry_id: string, filter: 'painting' | 'bw' | 'auto') =>
    req<{ edited_base64: string }>('/spot/edit/preview', {
      method: 'POST',
      body: JSON.stringify({ entry_id, filter }),
    }),
  spotEditSave: (entry_id: string, edited_base64: string) =>
    req<{ ok: boolean }>('/spot/edit/save', {
      method: 'POST',
      body: JSON.stringify({ entry_id, edited_base64 }),
    }),
  // ── Build Self-Confidence mini-app ──────────────────────────
  // Today's daily challenge for each non-AI track + completion state.
  confidenceDaily: () =>
    req<{
      date: string;
      social: ConfidenceChallenge;
      physical: ConfidenceChallenge;
      gratitude: ConfidenceChallenge;
    }>('/confidence/daily'),
  confidenceComplete: (track: 'social' | 'physical' | 'gratitude' | 'dress', note?: string) =>
    req<{ ok: boolean; already_done: boolean; xp_awarded?: number }>('/confidence/complete', {
      method: 'POST',
      body: JSON.stringify({ track, note: note || '' }),
    }),
  confidenceDressAdvice: (payload: {
    photo_base64?: string;
    message: string;
    event_context?: string;
    weather_hint?: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
  }) =>
    req<{ reply: string; entry_id: string }>('/confidence/dress-advice', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  confidenceDressHistory: (limit: number = 30) =>
    req<{
      items: {
        id: string;
        message: string;
        reply: string;
        event_context?: string;
        weather_hint?: string;
        thumbnail_base64?: string | null;
        has_photo: boolean;
        created_at: string;
      }[];
    }>(`/confidence/dress-history?limit=${limit}`),
  confidenceDressHistoryDelete: (entry_id: string) =>
    req<{ deleted: number }>(`/confidence/dress-history/${entry_id}`, {
      method: 'DELETE',
    }),
  confidenceWeather: (lat: number, lon: number) =>
    req<{
      temperature_c: number | null;
      condition: string;
      precipitation_mm: number | null;
      wind_kmh: number | null;
      hint: string;
    }>(`/confidence/weather?lat=${lat}&lon=${lon}`),

  // ─── Focus Mode ──────────────────────────────────────────────────
  focusSession: (payload: {
    planned_minutes: number;
    actual_seconds: number;
    backgrounded_seconds: number;
    /** Android-only: cumulative seconds the user spent inside a locked
     *  blocklist app, detected via UsageStatsManager. iOS / older
     *  builds simply omit it (defaults to 0 server-side). */
    locked_app_seconds?: number;
    completed: boolean;
    committed_app_count: number;
  }) =>
    req<{ xp_delta: number; reason: string; profile: any }>('/focus/session', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ─── Spot the Object — Multiplayer/Lobby (Phase 2) ──────────────
  spotMatchCreate: (friend_ids: string[]) =>
    req<{ match: SpotMatch }>('/spot/match/create', {
      method: 'POST',
      body: JSON.stringify({ friend_ids }),
    }),
  spotMatchList: () => req<{ matches: SpotMatch[] }>('/spot/match/list'),
  spotMatchGet: (id: string) => req<{ match: SpotMatch }>(`/spot/match/${id}`),
  spotMatchJoin: (id: string) =>
    req<{ match: SpotMatch }>(`/spot/match/${id}/join`, { method: 'POST' }),
  spotMatchDecline: (id: string) =>
    req<{ ok: boolean }>(`/spot/match/${id}/decline`, { method: 'POST' }),
  spotMatchStart: (id: string) =>
    req<{ match: SpotMatch }>(`/spot/match/${id}/start`, { method: 'POST' }),
  spotMatchCancel: (id: string) =>
    req<{ ok: boolean }>(`/spot/match/${id}/cancel`, { method: 'POST' }),
  spotMatchCapture: (id: string, photo_base64: string) =>
    req<{
      detected: boolean;
      confidence: number;
      can_capture: boolean;
      captures: number;
      match: SpotMatch;
    }>(`/spot/match/${id}/capture`, {
      method: 'POST',
      body: JSON.stringify({ photo_base64 }),
    }),

  // ─── Direct Messages (with AI safety guard) ───────────────────
  messagesRefine: (text: string) =>
    req<{ refined: string; flagged: boolean; severity: 'none' | 'mild' | 'severe'; reason: string }>(
      '/messages/refine',
      { method: 'POST', body: JSON.stringify({ text }) },
    ),
  messagesCheckImage: (image_base64: string) =>
    req<{ safe: boolean; severity: string; reason: string }>('/messages/check-image', {
      method: 'POST',
      body: JSON.stringify({ image_base64 }),
    }),
  messagesSend: (
    to_user_id: string,
    refined_text: string,
    original_text?: string,
    image_base64?: string,
  ) =>
    req<{ message: DMMessage }>('/messages/send', {
      method: 'POST',
      body: JSON.stringify({ to_user_id, refined_text, original_text, image_base64 }),
    }),
  messagesThreads: () => req<{ threads: DMThread[] }>('/messages/threads'),
  messagesThread: (friend_id: string) =>
    req<{ messages: DMMessage[] }>(`/messages/thread/${friend_id}`),
  messagesRead: (friend_id: string) =>
    req<{ updated: number }>('/messages/read', {
      method: 'POST',
      body: JSON.stringify({ friend_id }),
    }),
  messagesUnreadSummary: () =>
    req<{ unread_by_friend: Record<string, number>; total_unread: number }>(
      '/messages/unread-summary',
    ),
  pushRegisterToken: (token: string, platform: string) =>
    req<{ ok: boolean }>('/push/register-token', {
      method: 'POST',
      body: JSON.stringify({ token, platform }),
    }),
  // Health Connect debug reporter — used by the Sleep / "Connect Samsung
  // Health" flow to ship native crashes + error messages to the server
  // so we can audit why the system permission dialog never appears.
  reportHealthConnectError: (payload: {
    stage: string;
    message?: string;
    error_name?: string;
    platform?: string;
    os_version?: string;
    device?: string;
    app_version?: string;
    extra?: Record<string, any>;
  }) =>
    req<{ ok: boolean }>('/debug/health-connect-error', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ─── Admin reports (Creator only) ─────────────────────────────
  adminReportsList: () =>
    req<{ reports: AdminReport[]; new_count: number }>('/admin/reports'),
  adminReportView: (id: string) =>
    req<{ ok: boolean }>(`/admin/reports/${id}/view`, { method: 'POST' }),
  adminReportDismiss: (id: string) =>
    req<{ ok: boolean }>(`/admin/reports/${id}/dismiss`, { method: 'POST' }),

  // ─── Admin / Creator catalog ──────────────────────────────────────
  libraryCatalog: () => req<LibraryCatalogResponse>('/library/catalog'),

  authMe: () => req<{ id: string; full_name: string; email: string; verified: boolean }>('/auth/me'),
  getProfile: () => req<Profile>('/profile'),
  updateProfile: (name: string) =>
    req<Profile>('/profile', { method: 'PUT', body: JSON.stringify({ name }) }),
  updateWakeTime: (wake_time: string) =>
    req<Profile>('/profile', { method: 'PUT', body: JSON.stringify({ wake_time }) }),
  completeMorningSetup: (wake_time: string) =>
    req<Profile>('/profile', {
      method: 'PUT',
      body: JSON.stringify({ wake_time, morning_setup_done: true }),
    }),
  // New day-anchor system: set BOTH timezone + day_start_time in a single write.
  setDayAnchor: (timezone: string, day_start_time: string) =>
    req<Profile>('/profile', {
      method: 'PUT',
      body: JSON.stringify({ timezone, day_start_time, onboarding_tz_done: true }),
    }),
  answerPastChallenge: (
    completionId: string,
    body: { completed: boolean; how_text?: string; difficulty?: 'easy' | 'difficult'; experience_text?: string; rating?: number },
  ) =>
    req<{ awarded_xp: number; completion: any }>(`/challenge/past/${completionId}/answer`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  resetProfile: () => req<Profile>('/profile/reset', { method: 'POST' }),
  completeOnboarding: (payload: OnboardingPayload) =>
    req<Profile>('/profile/onboarding', { method: 'PUT', body: JSON.stringify(payload) }),
  setAvatar: (avatar_base64: string | null) =>
    req<Profile>('/profile/avatar', { method: 'POST', body: JSON.stringify({ avatar_base64 }) }),
  seed: () => req<{ seeded: boolean; count?: number }>('/seed', { method: 'POST' }),

  listTasks: (date?: string) =>
    req<{ date: string; tasks: Task[]; order_source_date?: string | null; adaptive_order?: boolean }>(
      `/tasks${date ? `?date=${date}` : ''}`,
    ),
  createTask: (body: { title: string; description?: string; focus_area: FocusArea; time_slot: TimeSlot; xp_value: number; scheduled_time?: string | null; reminder_enabled?: boolean }) =>
    req<Task>('/tasks', { method: 'POST', body: JSON.stringify({ recurring: true, reminder_enabled: true, ...body }) }),
  updateTask: (id: string, body: Partial<Task>) =>
    req<Task>(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTask: (id: string) =>
    req<{ deleted: boolean }>(`/tasks/${id}`, { method: 'DELETE' }),
  completeTask: (id: string, date?: string) =>
    req<{
      task: Task;
      xp_awarded: number;
      leveled_up: boolean;
      new_level: number;
      profile: Profile;
      newly_unlocked_achievements: string[];
    }>(`/tasks/${id}/complete`, { method: 'POST', body: JSON.stringify({ date }) }),
  uncompleteTask: (id: string, date?: string) =>
    req<{ profile: Profile; xp_removed?: number }>(`/tasks/${id}/uncomplete`, { method: 'POST', body: JSON.stringify({ date }) }),

  listGoals: () => req<{ goals: Goal[] }>('/goals'),
  goalsXpCaps: () =>
    req<{ caps: Record<string, number>; default_xp: number }>('/goals/xp-caps'),
  createGoal: (body: {
    title: string;
    description?: string;
    focus_area: FocusArea;
    target_value: number;
    unit?: string;
    xp_reward?: number;
  }) => req<Goal>('/goals', { method: 'POST', body: JSON.stringify(body) }),
  updateGoalProgress: (id: string, current_value: number) =>
    req<Goal>(`/goals/${id}/progress`, { method: 'POST', body: JSON.stringify({ current_value }) }),
  deleteGoal: (id: string) =>
    req<{ deleted: boolean }>(`/goals/${id}`, { method: 'DELETE' }),

  achievements: () =>
    req<{ achievements: Achievement[]; unlocked_count: number; total: number }>('/achievements'),

  statsDaily: (date?: string) =>
    req<DailyStats>(`/stats/daily${date ? `?date=${date}` : ''}`),
  statsWeekly: () => req<WeeklyStats>('/stats/weekly'),
  statsMonthly: () => req<WeeklyStats>('/stats/monthly'),
  statsByArea: () =>
    req<{ by_area: Record<FocusArea, number> }>('/stats/by-area'),

  // ──────── Library+ Mini-App Ratings ────────
  // Returns aggregate stats for all 4 featured mini-apps + the
  // caller's own rating per app (null if never rated).
  libraryRatings: () =>
    req<{
      ratings: Record<
        'sleep' | 'challenges' | 'spot' | 'confidence',
        { average: number; count: number; user_rating: number | null }
      >;
    }>('/library/ratings'),

  // Upserts the caller's rating (1–5) for a single mini-app and
  // returns the freshly recomputed aggregate so the UI can update
  // without a full refetch.
  rateMiniApp: (app_id: 'sleep' | 'challenges' | 'spot' | 'confidence', stars: number) =>
    req<{
      saved: boolean;
      app_id: string;
      stats: { average: number; count: number; user_rating: number };
    }>('/library/ratings', {
      method: 'POST',
      body: JSON.stringify({ app_id, stars }),
    }),

  // ──────── Library+ Mini-App Pricing & Purchases ────────
  // Returns price/currency/discount info for all 4 mini-apps + a
  // per-user `purchased` flag for each. Free apps (price=0) ALWAYS
  // surface as `is_free:true`; the app card renders a green FREE pill
  // for them and a price tag (with optional strikethrough) otherwise.
  libraryPricing: () =>
    req<{
      pricing: Record<
        'sleep' | 'challenges' | 'spot' | 'confidence',
        LibraryAppPricing
      >;
      currencies: string[];
    }>('/library/pricing'),

  // Real-money purchases via Stripe Checkout. The backend looks up
  // server-side pricing (so the client can never tamper with the
  // amount) and returns a hosted Stripe Checkout URL the app opens
  // in the system browser. Webhook flips `purchased=true` upon paid.
  paymentsCreateCheckout: (
    app_id: 'sleep' | 'challenges' | 'spot' | 'confidence',
  ) =>
    req<{
      session_id: string;
      checkout_url: string;
      amount: number;
      currency: string;
      effective_price: number;
      app_id: string;
    }>('/payments/create-checkout', {
      method: 'POST',
      body: JSON.stringify({ app_id }),
    }),

  // Native PaymentSheet flow (mobile only) — returns the secrets
  // PaymentSheet's initPaymentSheet() needs to render an in-app
  // payment form (card field is a Stripe-controlled native component
  // so we never see the raw PAN — PCI-DSS compliant).
  paymentsCreatePaymentIntent: (
    app_id: string,
    kind: 'library' | 'boost' = 'library',
  ) =>
    req<{
      payment_intent_client_secret: string;
      ephemeral_key_secret: string;
      customer_id: string;
      publishable_key: string;
      amount: number;
      currency: string;
      effective_price: number;
      app_id: string;
      kind: string;
      payment_intent_id: string;
    }>('/payments/create-payment-intent', {
      method: 'POST',
      body: JSON.stringify({ app_id, kind }),
    }),

  // Polled after returning from Stripe — finalises OWNED state if the
  // webhook hasn't arrived yet (e.g. whsec not configured locally).
  paymentsVerifySession: (session_id: string) =>
    req<{ paid: boolean; session_id: string; newly_inserted?: boolean; app_id?: string }>(
      `/payments/session/${encodeURIComponent(session_id)}/verify`,
    ),

  // Creator-only: set price + currency + external purchase URL on a
  // mini-app. price=0 means free.
  libraryPricingSet: (
    app_id: 'sleep' | 'challenges' | 'spot' | 'confidence',
    payload: { price: number; currency: string; purchase_url?: string },
  ) =>
    req<{ saved: boolean; pricing: LibraryAppPricing }>(`/library/pricing/${app_id}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Creator-only: add or clear a time-limited discount on a mini-app.
  // percent=0 clears any active discount.
  libraryPricingDiscount: (
    app_id: 'sleep' | 'challenges' | 'spot' | 'confidence',
    payload: { percent: number; duration_value?: number; duration_unit?: 'days' | 'weeks' | 'months' },
  ) =>
    req<{ saved: boolean; pricing: LibraryAppPricing }>(`/library/pricing/${app_id}/discount`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Records a user's purchase of a priced mini-app after they've
  // returned from the external checkout URL. Idempotent.
  libraryPurchase: (app_id: 'sleep' | 'challenges' | 'spot' | 'confidence') =>
    req<{ saved: boolean; already_owned: boolean; is_free: boolean }>(
      `/library/purchase/${app_id}`,
      { method: 'POST' },
    ),

  // ──────── Boost Pricing & Purchases (Points+ Boosts) ────────
  // Same shape as libraryPricing — re-uses the LibraryAppPricing type
  // (app_id is the boost_id like 'triple_day').
  boostsPricing: () =>
    req<{
      pricing: Record<'triple_day' | 'double_week' | 'double_month', LibraryAppPricing>;
      currencies: string[];
    }>('/boosts/pricing'),

  boostsPricingSet: (
    boost_id: 'triple_day' | 'double_week' | 'double_month',
    payload: { price: number; currency: string; purchase_url?: string },
  ) =>
    req<{ saved: boolean; pricing: LibraryAppPricing }>(`/boosts/pricing/${boost_id}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  boostsPricingDiscount: (
    boost_id: 'triple_day' | 'double_week' | 'double_month',
    payload: { percent: number; duration_value?: number; duration_unit?: 'days' | 'weeks' | 'months' },
  ) =>
    req<{ saved: boolean; pricing: LibraryAppPricing }>(`/boosts/pricing/${boost_id}/discount`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Trust-based fallback after returning from external Stripe checkout.
  boostsPurchase: (boost_id: 'triple_day' | 'double_week' | 'double_month') =>
    req<{ saved: boolean; is_free: boolean; profile?: any }>('/boosts/purchase', {
      method: 'POST',
      body: JSON.stringify({ boost_id }),
    }),

  // ──────── Adaptive Work-Life Scheduler ────────
  // Pattern of Day/Night/Off shifts overrides the static day_start_time
  // when enabled. Backend recalculates the boundary every request via
  // user_today_str → _effective_day_start_for. Manual overrides per
  // date take precedence over the rotating pattern.
  scheduleGet: () =>
    req<{ schedule: ShiftSchedule }>('/schedule'),
  schedulePut: (payload: Partial<ShiftSchedule>) =>
    req<{ saved: boolean; schedule: ShiftSchedule }>('/schedule', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  scheduleReset: () =>
    req<{ saved: boolean; schedule: ShiftSchedule }>('/schedule/reset', { method: 'POST' }),
  scheduleDayOverride: (date_iso: string, shift: 'day' | 'night' | 'off' | null) =>
    req<{ saved: boolean; manual_overrides: Record<string, string> }>(
      `/schedule/day/${date_iso}`,
      { method: 'PUT', body: JSON.stringify({ shift }) },
    ),
  schedulePreview: (days = 14, from_iso?: string) =>
    req<{ days: ScheduleDay[]; schedule: ShiftSchedule }>(
      `/schedule/preview?days=${days}${from_iso ? `&from_=${from_iso}` : ''}`,
    ),

  // ──────── In-app feedback + Level-up review prompts ────────  // POST /feedback — store the user's rating + free-text. Used both
  // by the level-up modal AND the standalone Settings → Feedback
  // screen. Once submitted, the level-up prompts skip the inline
  // feedback section on subsequent levels.
  submitFeedback: (payload: {
    rating: number;
    text?: string;
    level_at_submit?: number;
    app_version?: string;
    platform?: string;
  }) =>
    req<{ saved: boolean; id: string }>('/feedback', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // GET /feedback/me — has this user submitted feedback yet? Used
  // by useLevelUpDetector to decide whether to show the inline
  // feedback CTA in the level-up modal.
  feedbackMe: () =>
    req<{ submitted: boolean; submitted_at: string | null }>('/feedback/me'),

  // POST /profile/level-milestone-shown — mark a milestone level as
  // having shown its review/feedback prompt. Optional second arg
  // permanently flags `play_store_review_clicked` (we never re-prompt
  // for the OS store dialog after that — Apple/Google guideline).
  markLevelMilestoneShown: (level: number, playStoreReviewClicked = false) =>
    req<{
      saved: boolean;
      level_milestones_shown: number[];
      play_store_review_clicked: boolean;
    }>('/profile/level-milestone-shown', {
      method: 'POST',
      body: JSON.stringify({
        level,
        play_store_review_clicked: playStoreReviewClicked,
      }),
    }),

  // ──────── Sleep Coach ────────
  sleepProfile: () =>
    req<{
      onboarded: boolean;
      profile?: SleepProfile;
      questions: SleepQuestion[];
      show_checkin_prompt?: boolean;
    }>('/sleep/profile'),
  sleepOnboard: (answers: Record<string, any>) =>
    req<{ profile: SleepProfile }>('/sleep/onboarding', {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),
  sleepRegenerate: (message?: string) =>
    req<{ profile: SleepProfile }>('/sleep/regenerate', {
      method: 'POST',
      body: JSON.stringify({ message: message || '' }),
    }),
  sleepCheckin: (rating: number, hours?: number, notes?: string) =>
    req<{ saved: boolean; entry: SleepCheckin }>('/sleep/checkin', {
      method: 'POST',
      body: JSON.stringify({ rating, hours, notes: notes || '' }),
    }),
  sleepChatHistory: () =>
    req<{ messages: SleepChatMsg[] }>('/sleep/chat'),
  sleepChatSend: (message: string) =>
    req<{ user: SleepChatMsg; assistant: SleepChatMsg }>('/sleep/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  sleepReset: () => req<{ reset: boolean }>('/sleep/reset', { method: 'POST' }),
  sleepHealthMock: () => req<SleepHealthMock>('/sleep/health-mock'),
};

export type SleepQuestion = {
  id: string;
  type: 'scale' | 'time' | 'single' | 'multi' | 'multi_other' | 'text';
  q: string;
  min?: number;
  max?: number;
  options?: string[];
  other_option?: string;
  other_field?: string;
  /** Conditional display: only show this question when the previous answers
   *  match. Example: { "temp_right": "No" } only shows it if the user
   *  answered "No" to temp_right. */
  show_if?: Record<string, string | string[]>;
};
export type SleepRoutineItem = {
  time: string;
  title: string;
  description: string;
  icon: string;
};
export type SleepCheckin = {
  date: string;
  rating: number;
  hours?: number | null;
  notes?: string;
  ts: string;
};
export type SleepProfile = {
  user_id: string;
  answers: Record<string, any>;
  plan: string;
  routine: SleepRoutineItem[];
  check_ins: SleepCheckin[];
  last_checkin_date?: string | null;
  created_at: string;
  updated_at: string;
};
export type SleepChatMsg = {
  user_id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: string;
};
export type SleepHealthNight = {
  date: string;
  day: string;
  total_hours: number;
  deep_hours: number;
  rem_hours: number;
  light_hours: number;
  score: number;
};
export type SleepHealthMock = {
  connected: boolean;
  source: string;
  nights: SleepHealthNight[];
  avg_total_hours: number;
  avg_score: number;
  best_night: SleepHealthNight;
  worst_night: SleepHealthNight;
};

// ── Challenge Tasks mini-app types ────────────────────────────────
export type ChallengeContent = {
  id: string;
  title: string;
  tagline: string;
  description: string;
  icon: string;
  tags: string[];
};
export type ChallengeQuote = { text: string; author: string };
export type ChallengeStatus = 'ready' | 'accepted' | 'rejected' | 'completed';
export type ChallengeTodayResp = {
  date: string;
  greeting: string;
  quote: ChallengeQuote;
  challenge: ChallengeContent;
  status: ChallengeStatus;
  completed_id?: string;
};
export type ChallengeCompletion = {
  id: string;
  date: string;
  challenge_id: string;
  challenge_title: string;
  challenge_tagline: string;
  challenge_description: string;
  challenge_icon: string;
  completed: boolean;
  auto_uncompleted?: boolean;
  how_text: string;
  difficulty: 'easy' | 'difficult';
  experience_text: string;
  rating: number;
  xp_awarded: number;
  completed_at: string;
};

// ───────────────────────── Friends+ ─────────────────────────
export type FriendStatus =
  | 'none'
  | 'pending_outgoing'
  | 'pending_incoming'
  | 'friends'
  | 'self';

/** Admin-roster row returned by /admin/players/by-creation. Extends Player
 *  with an explicit creation timestamp + email for the Creator console. */
export type AdminPlayerRow = Player & {
  created_at: string | null;
  email: string;
  last_seen_at: string | null;
};

/** Admin global-leaderboard row returned by /admin/leaderboard/global. */
export type AdminLeaderboardRow = Player & {
  rank: number;
  period_xp: number;
  created_at: string | null;
};

export type Player = {
  user_id: string;
  name: string;
  level: number;
  total_xp: number;
  current_streak: number;
  best_streak: number;
  goals_completed: number;
  tasks_completed: number;
  bio: string;
  avatar_base64: string | null;
  friend_status: FriendStatus;
  // Creator/Admin flags. When `is_admin_view` is true, all numeric stats
  // arrive as -1 sentinels and the frontend should render them as ∞ + golden.
  is_admin?: boolean;
  is_admin_view?: boolean;
  // ADMIN-ONLY moderation flags. Backend only includes these when the
  // viewer is the Creator/Admin. is_currently_suspended drives the red
  // border around the player's card while their suspension is active;
  // was_suspended_ever drives the permanent red dot that the Creator
  // can see next to that user's name forever (even after the
  // suspension is lifted).
  is_currently_suspended?: boolean;
  was_suspended_ever?: boolean;
  // ISO-8601 UTC timestamp of the last time this player opened the app.
  // Used by Friends → My Friends to render "Active 1.5 hrs ago" labels.
  last_seen_at?: string | null;
  /**
   * Adaptive Work-Life Scheduler signal. Present only when the player has
   * the scheduler enabled. The Spot multiplayer lobby grays the friend
   * out and shows `label` while `in_silence` is true, and the backend
   * skips them from match invite broadcasts.
   */
  silence_state?: {
    in_silence: boolean;
    shift: 'day' | 'night' | 'off' | null;
    label: string | null;
  };
  // When this player became our friend. Populated only on the
  // /friends/list endpoint (null elsewhere). Powers the unfriend
  // confirmation dialog's "You've been friends for X days" subtitle.
  friended_at?: string | null;
};

export type FriendRequestEntry = {
  request_id: string;
  created_at: string;
  player: Player;
};

// ── Friend Profile Detail (only accessible if friend or self) ─────────────
export type FriendMiniApp = {
  id: string;
  title: string;
  icon: string;
  color: 'cyan' | 'green' | 'amber' | 'red' | string;
  description: string;
  stat_label: string;
  active: boolean;
};

export type FriendTaskSummary = {
  id: string;
  title: string;
  description: string;
  focus_area: string;
  time_slot: 'morning' | 'afternoon' | 'evening' | string;
  xp_value: number;
  is_default: boolean;
  recurring: boolean;
};

export type FriendGoalSummary = {
  id: string;
  title: string;
  description: string;
  focus_area: string;
  target_value: number;
  current_value: number;
  unit: string;
  xp_reward: number;
  completed: boolean;
};

export type FriendProfileDetails = {
  user_id: string;
  is_self: boolean;
  mini_apps: FriendMiniApp[];
  tasks: FriendTaskSummary[];
  goals: FriendGoalSummary[];
  counts: {
    tasks_total: number;
    tasks_default: number;
    tasks_custom: number;
    goals_total: number;
    goals_active: number;
    goals_completed: number;
  };
};

// ── Admin Account Suspension ─────────────────────────────────────
export type AdminSuspendResult = {
  ok: boolean;
  user_id: string;
  suspended_until: string | null;
  forever: boolean;
  duration_hours: number | null;
  reason: string;
};

export type AdminSuspensionStatus = {
  user_id: string;
  suspended: boolean;
  forever?: boolean;
  until?: string | null;
  remaining_seconds?: number | null;
  suspended_at?: string;
  suspended_by?: string;
  reason?: string;
};

// ── Admin Gifts (XP / Bonus Top-Up) ───────────────────────────────
export type GiftEntry = {
  id: string;
  kind: 'xp' | 'boost';
  amount: number;                    // for kind=xp
  boost_id?: string | null;          // for kind=boost
  boost_label?: string | null;
  boost_multiplier?: number | null;
  boost_duration_days?: number | null;
  message: string;
  from_user_id: string;
  from_name: string;
  created_at: string;
  acknowledged_at?: string | null;
};

// ── Spot-the-Object Admin Train Mode ──────────────────────────────
export type SpotTrainingObject = {
  object_name: string;
  samples_count: number;
  target_count: number;
  is_complete: boolean;
  is_skipped: boolean;
  last_trained_at?: string | null;
};

export type SpotTrainingSession = {
  object_name: string;
  angles: string[];
  captured_count: number;
  total_count: number;
  next_angle: string | null;
  instructions: string;
};

export type SpotTrainingCaptureResult = {
  ok: boolean;
  rejected: boolean;
  reason?: string;
  captured_count?: number;
  total_count?: number;
  progress_pct?: number;
  next_angle?: string | null;
  is_complete?: boolean;
  confidence?: number;
};

// ───────────────────────── Leaderboard ─────────────────────────
export type LeaderboardRow = {
  user_id: string;
  name: string;
  avatar_base64: string | null;
  level: number;
  total_xp: number;
  weekly_xp: number;
  is_self: boolean;
  // Admin / Creator flags — backend sets level=999 + is_admin_view=true
  // when OTHERS view the Creator so the list renders the golden shield.
  is_admin?: boolean;
  is_admin_view?: boolean;
  tz_offset_minutes: number;
  is_week_closed: boolean;
  medals_count: number;
  medals_revoked: number;
};

export type LeaderboardReport = {
  id: string;
  reporter_id: string;
  reporter_name: string;
  reported_user_id: string;
  reported_name: string;
  reason: string;
  created_at: string;
  week_key: string;
  supporters_count: number;
  viewer_supported: boolean;
  viewer_is_reporter: boolean;
};

export type LeaderboardResponse = {
  week_key: string;
  viewer_is_sunday: boolean;
  winner_declared: boolean;
  winner: (LeaderboardRow & { medal_revoked?: boolean }) | null;
  rows: LeaderboardRow[];
  reports: LeaderboardReport[];
};

export type LeaderboardMedal = {
  week_key: string;
  awarded_at: string;
  revoked: boolean;
  revoked_reason?: string | null;
  xp: number;
};

export type LeaderboardPlayerProfile = Player & {
  weekly_xp: number;
  medals: LeaderboardMedal[];
  is_flagged_cheater: boolean;
};

// ───────────────────────── Spot the Object ─────────────────────────
// ───────────────────────── Library Catalog (admin) ─────────────────────────
export type CatalogItem = {
  id: string;
  title: string;
  description: string;
  category?: string;
  difficulty?: string;
  options?: any[];
};

export type CatalogSection = {
  name: string;
  count: number;
  items: CatalogItem[];
};

export type LibraryCatalogResponse = {
  challenge_tasks: CatalogSection;
  spot_the_object: CatalogSection;
  improve_sleep_questions: CatalogSection;
  points_plus_boosts: CatalogSection;
  confidence_social?: CatalogSection;
  confidence_physical?: CatalogSection;
  confidence_gratitude?: CatalogSection;
  confidence_dress?: CatalogSection;
};

/** Helpers for rendering admin players (∞ + golden treatment). */
export const ADMIN_INFINITY = '∞';
export function adminStatDisplay(value: number, isAdminView?: boolean): string {
  if (isAdminView) return ADMIN_INFINITY;
  if (typeof value !== 'number') return '0';
  return String(value);
}

export type SpotComment = {
  id: string;
  user_id: string;
  user_name: string;
  user_avatar_base64: string | null;
  text: string;
  created_at: string;
};

export type SpotEntry = {
  id: string;
  user_id: string;
  target_object: string;
  photo_base64: string;
  success: boolean;
  remaining_seconds: number;
  mode: 'solo_constant' | 'solo_random' | 'friends' | string;
  points_delta: number;
  taken_at: string;
  likes: string[];
  comments: SpotComment[];
  // enriched server-side in feed/detail responses:
  player_name?: string;
  player_avatar_base64?: string | null;
  player_spot_points?: number;
  liked_by_you?: boolean;
  like_count?: number;
  comment_count?: number;
  is_self?: boolean;
};

// ───────────────────────── Spot the Object — Multiplayer ──────────
export type SpotMatchStatus = 'waiting' | 'active' | 'finished' | 'cancelled';
export type SpotMatchPlayer = {
  user_id: string;
  name: string;
  avatar_base64: string | null;
  is_host: boolean;
  joined: boolean;
  declined: boolean;
  captures: number;
};
export type SpotMatch = {
  id: string;
  host_id: string;
  status: SpotMatchStatus;
  target_object: string | null;
  started_at: string | null;
  ends_at: string | null;
  finished_at: string | null;
  /** Server-computed seconds remaining; null when match is not active. */
  seconds_left: number | null;
  winner_id: string | null;
  players: SpotMatchPlayer[];
  viewer_role: 'host' | 'joined' | 'invited' | 'spectator';
  viewer_captures: number;
  viewer_reward: number;
  created_at: string;
};

// ───────────────────────── Direct Messages ───────────────────────
export type DMSeverity = 'none' | 'mild' | 'severe';
export type DMMessage = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  text: string;
  image_base64: string | null;
  created_at: string;
  read_at: string | null;
  severity: DMSeverity;
};
export type DMThread = {
  friend_id: string;
  friend_name: string;
  friend_avatar_base64: string | null;
  last_message: DMMessage | null;
  unread_count: number;
};
export type AdminReport = {
  id: string;
  reported_user_id: string;
  reported_name: string;
  reported_email: string;
  kind: string;
  severity: string;
  excerpt: string;
  reason: string;
  rating?: number;
  stars?: string;
  level_at_submit?: number;
  platform?: string;
  created_at: string;
  viewed_at: string | null;
  dismissed_at: string | null;
};

export type ShiftType = 'day' | 'night' | 'off';

export type ShiftDef = {
  start_time: string;     // HH:MM 24h
  sleep_time: string;     // HH:MM 24h
  icon: string;           // emoji
  color: string;          // #RRGGBB hex
};

export type ShiftSchedule = {
  enabled: boolean;
  /** 'weekly' = same every Mon..Sun (length-7 pattern). 'rotating' = N-day cycle. */
  pattern_kind: 'weekly' | 'rotating';
  /** Marks the wizard as completed. When false the Profile entry opens the wizard. */
  setup_complete: boolean;
  pattern: ShiftType[];
  pattern_start_date: string;  // YYYY-MM-DD
  shifts: { day: ShiftDef; night: ShiftDef; off: ShiftDef };
  refresh_offset_hours: number;
  manual_overrides: Record<string, ShiftType>;
};

export type ScheduleDay = {
  date: string;
  shift: ShiftType | null;
  start_time: string;
  sleep_time: string;
  icon: string;
  color: string;
  is_override: boolean;
};

export type LibraryAppPricing = {
  app_id: 'sleep' | 'challenges' | 'spot' | 'confidence';
  price: number;
  currency: string;
  purchase_url: string;
  discount_percent: number;
  discount_active: boolean;
  discount_starts_at: string | null;
  discount_ends_at: string | null;
  effective_price: number;
  is_free: boolean;
  purchased: boolean;
};


// ── Build Self-Confidence mini-app ────────────────────────────────
export type ConfidenceChallenge = {
  track: 'social' | 'physical' | 'gratitude';
  title: string;
  body: string;
  tips?: string[];
  examples?: string[];
  drills?: string[];
  affirmation?: string;
  done: boolean;
};
