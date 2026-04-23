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
