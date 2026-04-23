# LevelUp — PRD

## Overview
LevelUp is a personal-progress gamified confidence/self-improvement Expo mobile app. Users create their own tasks and long-term goals across 4 focus areas (Social Confidence, Fitness, Appearance, Mindset), tick them off to earn XP, build daily streaks, level up (1-10), and unlock achievements. Single-user, no community, no AI.

## Tech
- **Frontend**: Expo Router (React Native), react-native-svg, @expo/vector-icons, expo-haptics. Dark theme (#05070D) + neon green (#00FF88) + electric cyan (#00D9FF) + amber XP (#FFB800).
- **Backend**: FastAPI + MongoDB (motor). Singleton profile, task templates, daily task_logs, goals, achievements.
- **Auth**: None (single local profile; can be added later).

## Features (MVP)
- **Home**: Hero shield emblem with glowing XP ring, LEVEL badge (1-10), XP bar, Day Streak / Today's Quests / XP Today stat cards, 4 daily focus completion rings, overall daily progress, CTA to Quests.
- **Quests (Tasks)**: Daily quests grouped by Morning/Afternoon/Evening, tick-to-complete with haptic + floating "+XP" animation, long-press to delete, FAB add with focus area + time slot + XP chips. Pre-seeded 8 default quests.
- **Goals**: Long-term goals per focus area, +/-/+10 progress controls, auto-complete at target (bonus +100 XP).
- **Progress**: Weekly XP SVG bar chart, Total XP / Level / Best Streak stats, Confidence Metric (XP distribution by focus area), Achievements grid (locked/unlocked).
- **Profile**: Character avatar ring, editable name, 6 lifetime stats, link to Focus Mode, Reset Progress.
- **Focus Mode** (modal): 5-min lock-in timer with circular progress. Exit early requires a challenge — either tap-count 20 push-ups or complete 4 breathing cycles (in/hold/out).
- **Achievements**: 12 badges (first task, 10/50/100 tasks, 3/7/30 streak, Level 3/5/10, first goal, first goal complete). Auto-unlocked on stat thresholds.

## XP & Leveling
Cumulative thresholds per level: [0, 100, 250, 500, 900, 1500, 2500, 4000, 6000, 9000, 13000]. Max level 10.

## API
`/api/profile`, `/api/tasks`, `/api/tasks/{id}/complete|uncomplete`, `/api/goals`, `/api/goals/{id}/progress`, `/api/achievements`, `/api/stats/daily`, `/api/stats/weekly`, `/api/stats/by-area`, `/api/seed`, `/api/profile/reset`.
