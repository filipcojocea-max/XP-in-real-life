# EAS Build Instructions — versionCode 109

This batch ships native code (custom Expo Module for App Blocker), so the
new `.aab` MUST be built via EAS — not Expo Go and not the existing
preview build. All config is already prepped on disk.

## What's already configured for you

- `app.json` → `expo.android.versionCode` = **109**
- `app.json` → `expo.android.permissions` now includes
  `PACKAGE_USAGE_STATS`, `FOREGROUND_SERVICE`, and
  `FOREGROUND_SERVICE_SPECIAL_USE` (required for the Focus-Mode
  app-blocker foreground service).
- `frontend/modules/app-blocker/` → new local Expo Module
  (Kotlin + JS bridge) that polls Android's `UsageStatsManager` and
  emits `onLockedAppOpened` events to JS. Auto-linked because of
  `expo-module.config.json`.
- `frontend/app/focus.tsx` → uses the module on Android and
  gracefully degrades on iOS / web.
- `frontend/app/(tabs)/progress.tsx` → new Weekly/Monthly toggle.
- `_layout.tsx` → splash screen now hides automatically after 1.5s
  hard timeout to fix the "font loading timeout" symptom.

## Run the build

From your local machine (NOT inside the Emergent container — EAS builds
happen on EAS servers and require an interactive login token):

```bash
cd frontend
# 1. Sanity-check the project still resolves on your machine
npx expo install --check

# 2. Authenticate if you haven't already (one-time)
npx eas login

# 3. Build the production .aab. This will run prebuild internally and
#    pick up the new app-blocker module + Kotlin source automatically.
npx eas build --platform android --profile production --non-interactive
```

When the build finishes EAS will print a download link. Install the
`.aab` on a device, or upload to Play Console for internal testing.

## Verifying the new features post-install

1. **Monthly XP toggle** — Open the **Progress** tab. There's now a
   "Weekly / Monthly" pill above the bar chart. Toggle to Monthly →
   the bars + line graph become horizontally scrollable across 30 days
   of data with day-of-month labels.

2. **Background-aware Focus Timer** — Start a focus session, lock the
   phone or background the app for ~30s, return. The countdown should
   reflect the elapsed time correctly (NOT show the same value frozen).
   When the timer hits zero in the background, you'll get a push
   notification "Focus Mode complete!".

3. **App Blocker (Android only)** — Start a Focus session with at
   least one app committed (e.g. YouTube). The first time you start,
   Settings → Usage Access opens — toggle "XP in Real Life" ON,
   return. Persistent low-priority "Focus Mode active" notification
   appears. Open YouTube → within ~2 sec a HIGH-priority notification
   "⚠️ Exit YouTube now — You will lose 15 XP per minute" appears
   over the YouTube UI. Stay in YouTube ~60 sec, return to the app —
   the running session shows a red "−15 XP locked-app penalty" pill.
   End the session → XP is deducted at exactly **−15 per minute**
   spent inside any blocked app, capped at −300.

4. **Splash / loading** — The splash screen disappears within ~1.5 s
   regardless of network speed (no more "font loading timeout").

## iOS notes

- The App Blocker is **Android-only** by design (iOS has no public API
  to detect foreground apps).
- iOS users still get the existing legacy "left the app" detection at
  −2 XP/minute, so leaving the app early during Focus Mode is still
  penalized — just less aggressively than Android's locked-app rule.

## Permission UX (Android)

The first time a user starts a Focus session with apps committed, our
JS code calls `AppBlocker.requestUsageAccessPermission()` which
launches the system **Settings → Usage Access** screen. The user must
manually flip the toggle ON for "XP in Real Life" — this is a
"special permission" Android 14+ requires for ALL apps that read
usage stats (you literally cannot grant it from a runtime dialog).

We surface a banner "Enable real app blocking" on the Focus screen
whenever the permission is missing so users know what to do.
