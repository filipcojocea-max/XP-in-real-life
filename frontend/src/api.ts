import type { FocusArea, TimeSlot } from './theme';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text || path}`);
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
};

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
  completed: boolean;
  created_at: string;
  completed_at: string | null;
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
  getProfile: () => req<Profile>('/profile'),
  updateProfile: (name: string) =>
    req<Profile>('/profile', { method: 'PUT', body: JSON.stringify({ name }) }),
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
    req<{ profile: Profile }>(`/tasks/${id}/uncomplete`, { method: 'POST', body: JSON.stringify({ date }) }),

  listGoals: () => req<{ goals: Goal[] }>('/goals'),
  createGoal: (body: { title: string; description?: string; focus_area: FocusArea; target_value: number; unit?: string }) =>
    req<Goal>('/goals', { method: 'POST', body: JSON.stringify(body) }),
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
  type: 'scale' | 'time' | 'single' | 'multi' | 'text';
  q: string;
  min?: number;
  max?: number;
  options?: string[];
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
