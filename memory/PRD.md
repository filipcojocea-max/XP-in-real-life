# LevelUp — PRD

## Overview
LevelUp is a personal-progress gamified confidence/self-improvement Expo mobile app. Users create their own tasks and long-term goals across 4 focus areas (Social Confidence, Fitness, Appearance, Mindset), tick them off to earn XP, build daily streaks, level up (1-10), and unlock achievements. Single-user, no community, no AI.

## Tech
- **Frontend**: Expo Router (React Native), react-native-svg, @expo/vector-icons, expo-haptics. Dark theme (#05070D) + neon green (#00FF88) + electric cyan (#00D9FF) + amber XP (#FFB800).
- **Backend**: FastAPI + MongoDB (motor). Singleton profile, task templates, daily task_logs, goals, achievements.
- **Auth**: None (single local profile; can be added later).

## Features (MVP + v1.1 + v1.2)
- **Onboarding (first launch)**: 13-step questionnaire (name, main goals, experience level, productivity 1-10, loves + other, focused time with early/after follow-up, good habits, bad habits, age range, gender, avatar photo), every step skippable. Auto-generated character bio from answers.
- **Push Reminders**: each task can have a scheduled time (HH:MM) + reminder toggle. Local daily repeating notifications via `expo-notifications`.
- **Home**: Hero shield emblem with glowing XP ring, LEVEL badge (1-10), XP bar, Day Streak / Today's Quests / XP Today stat cards, 4 daily focus completion rings, overall daily progress.
- **Quests (Tasks)**: UNLIMITED user-created tasks grouped by Morning/Afternoon/Evening, tick-to-complete with haptic + floating "+XP" animation, FAB add with focus area + time slot + time picker + reminder toggle + XP chips.
- **Goals**: Long-term goals per focus area, +/-/+10 progress controls, auto-complete at target (bonus +100 XP).
- **Progress**: Weekly XP SVG bar chart, Confidence Metric XP distribution, Achievements grid.
- **Profile**: Avatar (photo or shield fallback) with XP ring, auto-generated bio, 6 lifetime stats, Edit Profile, Focus Mode, Reset Progress.
- **Focus Mode**: 5-min lock-in timer with challenge-to-unlock (push-ups OR breathing cycles).
- **Library+ (premium tab — placeholder)**: 6th bottom-right tab. Two segmented sections — **Add** (shows "Apps coming out soon!" with 4 locked coming-soon preview cards and a notify-me badge) and **My Library** (empty state). Mini-apps will be built later.

## XP & Leveling
Cumulative thresholds per level: [0, 100, 250, 500, 900, 1500, 2500, 4000, 6000, 9000, 13000]. Max level 10.

## API
`/api/profile`, `/api/profile/onboarding`, `/api/profile/avatar`, `/api/profile/reset`, `/api/tasks` (+ complete/uncomplete), `/api/goals` (+ progress), `/api/achievements`, `/api/stats/daily|weekly|by-area`, `/api/seed`.
