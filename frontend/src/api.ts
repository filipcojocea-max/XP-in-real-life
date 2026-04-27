import type { FocusArea, TimeSlot } from './theme';
import { getAuthToken, getAnonymousId, fireUnauthorized } from './AuthContext';

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
};

/**
 * Compute the user's "current day" date string (YYYY-MM-DD) based on local time
 * and their wake-up time. The day rolls over 2 hours BEFORE wake-time.
 *
 *   wake_time = "07:00" → boundary = 05:00. Before 5 AM = yesterday's day.
 */
export function userDate(wake_time: string = '07:00'): string {
  const [wh = 7, wm = 0] = wake_time.split(':').map((x) => parseInt(x, 10));
  // boundary = wake_time - 2 hours (handle wrap)
  let bh = wh - 2;
  let bm = wm;
  if (bh < 0) bh += 24;
  const now = new Date();
  const beforeBoundary =
    now.getHours() < bh || (now.getHours() === bh && now.getMinutes() < bm);
  const d = new Date(now);
  if (beforeBoundary) {
    d.setDate(d.getDate() - 1);
  }
  // Format as YYYY-MM-DD in local time (not UTC)
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
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

export type WeeklyStats = { days: { date: string; day: string; xp: number; tasks: number }[] };

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
  statsByArea: () =>
    req<{ by_area: Record<FocusArea, number> }>('/stats/by-area'),

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
