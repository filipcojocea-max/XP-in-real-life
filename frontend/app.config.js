/**
 * Dynamic Expo config.
 *
 *  Firebase Cloud Messaging (FCM) has been REMOVED from this build per
 *  user request — we now ship without `google-services.json` and the
 *  `com.google.gms:google-services` Gradle plugin. The app still uses
 *  `expo-notifications` for LOCAL notifications (scheduled reminders,
 *  in-app foreground banners, etc.) which work fine without FCM.
 *
 *  REMOTE push from the backend (Expo push) will NOT deliver to Android
 *  devices on this production build because Expo's Android delivery
 *  pipeline requires FCM credentials. Re-enable later by:
 *    1. Restoring `google-services.json`
 *    2. Adding `"googleServicesFile": "./google-services.json"` to the
 *       `expo.android` block of app.json (or piping via EAS file secret).
 *
 *  This file is intentionally a thin pass-through now — it stays around
 *  so the project still has a JS-based config slot if we ever need to
 *  inject env-driven overrides without editing app.json.
 */

module.exports = ({ config }) => {
  return { ...config };
};
