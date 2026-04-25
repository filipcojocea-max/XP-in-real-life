# LevelUp — PRD

## Overview
LevelUp is a personal-progress gamified confidence/self-improvement Expo mobile app. Users create their own tasks and long-term goals across 4 focus areas (Social Confidence, Fitness, Appearance, Mindset), tick them off to earn XP, build daily streaks, level up (1-10), and unlock achievements. Single-user, no community, no AI.

## Tech
- **Frontend**: Expo Router (React Native), react-native-svg, @expo/vector-icons, expo-haptics. Dark theme (#05070D) + neon green (#00FF88) + electric cyan (#00D9FF) + amber XP (#FFB800).
- **Backend**: FastAPI + MongoDB (motor). Singleton profile, task templates, daily task_logs, goals, achievements.
- **Auth**: None (single local profile; can be added later).

## Features (MVP + v1.1 + v1.2 + v1.3)
- **Onboarding (first launch)**: 13-step questionnaire, skippable, auto-generated bio from answers.
- **Push Reminders + Motivational Notifications**:
  - Per-task scheduled time (HH:MM) + reminder toggle, local daily repeating.
  - **3 motivational notifications daily** at 9 AM / 1 PM / 7 PM with random phrases like "Stay Focused. Stay Committed. Stay Consistent.", "Future you is watching. Make them proud.", "Level up in real life.", etc. Android uses MAX-importance "motivation" channel for heads-up banners; iOS uses time-sensitive interruption level.
- **In-app MotivationBanner**: Sits on Home between greeting and hero emblem. Notification-style card with a rotating half-green/half-cyan border traveling in the same direction, exactly opposite sides. Tap → shuffles to a new message and routes to Quests.
- **Adaptive Task Order**: `GET /api/tasks` reshuffles each time-slot group based on the user's most-recent day's completion order (completed-earliest → top). Cyan "Smart order · reshuffled from your completion pattern on {date}" hint appears above Quests list when active.
- **Home**: Hero shield emblem with glowing XP ring, LEVEL badge, XP bar, MotivationBanner, 3 stat cards, 4 daily focus completion rings, overall daily progress.
- **Quests (Tasks)**: UNLIMITED user-created tasks grouped by Morning/Afternoon/Evening, adaptive smart order, tick-to-complete with haptic + floating "+XP", FAB add with focus area + time slot + time picker + reminder toggle + XP.
- **Goals**: Long-term goals per focus area with progress controls + bonus XP.
- **Progress**: Weekly XP chart, Confidence Metric, Achievements grid.
- **Profile**: Avatar + bio + 6 stats + Edit Profile + Focus Mode + Reset.
- **Focus Mode**: 5-min lock timer with push-ups or breathing challenge to exit early.
- **Library+**: 6th tab, segmented Add / My Library, "Apps coming out soon!" placeholder.

## Important OS Limitation
iOS and Android do NOT allow any app to override notification position, force them to stay visible, or draw a custom animated border on OS notifications. The rotating green/cyan border is therefore implemented as an in-app "MotivationBanner" component matching the user's visual spec; OS notifications are scheduled at MAX/time-sensitive priority for best possible heads-up behavior.

## XP & Leveling
Cumulative thresholds per level: [0, 100, 250, 500, 900, 1500, 2500, 4000, 6000, 9000, 13000]. Max level 10.

## API
`/api/profile`, `/api/profile/onboarding`, `/api/profile/avatar`, `/api/profile/reset`, `/api/tasks` (returns `adaptive_order` + `order_source_date`), `/api/tasks/{id}/complete|uncomplete` (accepts `{date}` body), `/api/goals` (+ progress), `/api/achievements`, `/api/stats/daily|weekly|by-area`, `/api/seed`.

## Update (Apr 2026) — Library+ "Improve Sleeping" Mini-App
- Added AI-powered sleep coach mini-app under Library+ → Add tab
- 19-question evidence-based intake (CBT-I aligned: caffeine, screens, room env, racing thoughts, relaxation prefs, milk preference, etc.)
- Backend uses `emergentintegrations` LLM library with OpenAI gpt-4o-mini via EMERGENT_LLM_KEY for:
  - Personalized sleep plan generation (plan + routine items as JSON)
  - Multi-turn AI coach chat ("Luna") with conversation history + sleep profile context
- 3 sub-tabs: **Plan** (personalized routine + recent check-ins + "let's try something else" regenerate), **Coach** (chat with Luna), **Sleep Data** (simulated dashboard — Apple Health/Google Fit gated behind native build)
- Daily "How was your sleep?" check-in modal — appears on next app entry (not via push notification, per user req)
- New routes: `/sleep/_layout.tsx`, `/sleep/index.tsx`, `/sleep/onboarding.tsx`
- New backend endpoints: `/api/sleep/profile`, `/api/sleep/onboarding`, `/api/sleep/checkin`, `/api/sleep/chat`, `/api/sleep/regenerate`, `/api/sleep/health-mock`, `/api/sleep/reset`
- All 63 backend assertions passed in testing (real LLM calls succeeded; multi-turn context persisted; regeneration verified)

## Update (Apr 2026) — Multi-user Auth + Daily Reset + Task Limits
- **Auth system**: register / verify / login / resend / me with bcrypt + JWT (365-day TTL).
  Email verification: 6-digit code, 30-min expiry. SMTP optional (set SMTP_HOST/USER/PASS).
  In dev mode the code is returned in the response body & logged to backend.err.log.
- **Per-user data isolation**: all routes use `Depends(get_user_or_legacy)` — token's user_id
  scopes profile / tasks / goals / task_logs / sleep_profile / sleep_chat. Each new user
  gets their own seeded 8 default tasks.
- **Frontend auth**: AuthContext with SecureStore (web fallback to AsyncStorage), AuthGate in
  root layout redirects to /auth/login when no token, to / when authed. New screens:
  /auth/login, /auth/register, /auth/verify.
- **Daily reset**: Tasks list uses `userDate(wake_time)` which rolls the day at `wake_time - 2h`.
  No manual refresh button — purely automatic. Wake time editable via PUT /api/profile.
- **11-task limit**: per-user cap on custom (non-default) tasks.
- **Once-per-day tick**: uncomplete endpoint always returns 400. Frontend toggle blocks un-tick.
- **Onboarding tweaks**: age options now `10-14`, `15-17`, `18-20`, `21-25`, `25+`;
  gender options `Male`, `Female` only.
