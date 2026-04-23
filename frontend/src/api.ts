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
};

export type Task = {
  id: string;
  title: string;
  description: string;
  focus_area: FocusArea;
  time_slot: TimeSlot;
  xp_value: number;
  recurring: boolean;
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

export const api = {
  getProfile: () => req<Profile>('/profile'),
  updateProfile: (name: string) =>
    req<Profile>('/profile', { method: 'PUT', body: JSON.stringify({ name }) }),
  resetProfile: () => req<Profile>('/profile/reset', { method: 'POST' }),
  seed: () => req<{ seeded: boolean; count?: number }>('/seed', { method: 'POST' }),

  listTasks: (date?: string) =>
    req<{ date: string; tasks: Task[] }>(`/tasks${date ? `?date=${date}` : ''}`),
  createTask: (body: Omit<Task, 'id' | 'created_at' | 'completed' | 'recurring'> & { recurring?: boolean }) =>
    req<Task>('/tasks', { method: 'POST', body: JSON.stringify({ recurring: true, ...body }) }),
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
};
