# PRD — XP in Real Life (clone of "Xp-Confidence")

## Overview
Full-stack Expo mobile app cloned from `Filipcojocea-Max/XP-In-Real-Life`. Gamified self-improvement / confidence / habit-tracking application with XP, levels, streaks, challenges, focus mode, sleep tracking, friends/social, in-app messaging, library/store, admin/creator tooling, multiplayer "Spot the Object" challenges, and Stripe payments.

## Identifiers
- Android package / iOS bundle: `app.emergent.xpconfidencec2316dfc2`
- Expo scheme: `xpconfidence`
- App name: "XP in Real Life"

## Stack
- Frontend: Expo SDK 54, expo-router, React Native 0.81, TypeScript
- Backend: FastAPI + Motor (async MongoDB) + APScheduler
- DB: MongoDB
- Auth: JWT + bcrypt + email verification code (Resend)
- AI: Emergent Universal LLM Key (litellm / emergentintegrations)
- Push: Expo Notifications + FCM (google-services.json present)
- Payments: Stripe (disabled by default — needs STRIPE_SECRET_KEY)
- Native module: `app-blocker` (Kotlin, Android-only) under `frontend/modules/app-blocker`

## Core Features (imported from source)
- Auth (register, login, email verification, password reset)
- Onboarding + day-anchor (timezone + day_start_time)
- Tabs: Home, Confidence, Progress, Social, Profile
- Challenges (image, dress, spot multiplayer, schedule)
- Focus Mode + Android app blocker
- Sleep tracking + Health Connect integration
- Friends, leaderboards, messages (DM), gifts, motivation banners
- Library catalog + ratings + pricing tiers + Stripe checkout
- Admin tools (roster, suspension, moderation, charts, feedback)
- Level-up review prompt, push notifications, scheduler
- Premium+ golden creator theme

## Environment
- `MONGO_URL`, `DB_NAME` — local Mongo
- `EMERGENT_LLM_KEY` — Universal LLM key (already configured)
- `RESEND_API_KEY` + `RESEND_FROM` — email verification
- `STRIPE_SECRET_KEY` — optional, checkout disabled if missing
- Frontend reads `EXPO_PUBLIC_BACKEND_URL` from `.env` for API calls

## Admin Account (auto-seeded)
- Email: `filip.cojocea122@gmail.com`
- Password: `XL98CZW5599`
