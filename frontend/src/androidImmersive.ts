/**
 * androidImmersive.ts — wraps `expo-navigation-bar` so we can hide the
 * Samsung 3-button (or pill) navigation bar at app launch and let the
 * user reveal it transiently with a swipe-up from the bottom edge.
 *
 * Behaviour we want:
 *  1. App launches → system nav bar is HIDDEN, content goes edge-to-edge.
 *  2. Setting `behavior` to 'overlay-swipe' tells Android: "user can
 *     swipe up to peek the nav bar; it will auto-hide after a few
 *     seconds without me needing to reschedule it."
 *  3. We re-assert hidden state on re-focus / state change so any
 *     OS-driven re-show (e.g. after a permission dialog) resets cleanly.
 *
 * Web / iOS are no-ops — the API is Android-only (Samsung, Pixel, etc.).
 */
import { Platform } from 'react-native';

let _enabled = false;

export async function enableAndroidImmersive() {
  if (Platform.OS !== 'android' || _enabled) return;
  _enabled = true;
  try {
    const NB = await import('expo-navigation-bar');
    // 'overlay-swipe' = user swipes up to bring the bar back as a
    // transient overlay; the system auto-hides it again. This matches
    // the spec request: "user has to swipe up from the middle bottom
    // of the phone to access it for 5 seconds, before it hides itself".
    if (NB.setBehaviorAsync) {
      await NB.setBehaviorAsync('overlay-swipe').catch(() => {});
    }
    if (NB.setVisibilityAsync) {
      await NB.setVisibilityAsync('hidden').catch(() => {});
    }
  } catch {
    // module not available in Expo Go / web preview — silently skip
  }
}

export async function reassertAndroidImmersive() {
  if (Platform.OS !== 'android') return;
  try {
    const NB = await import('expo-navigation-bar');
    if (NB.setVisibilityAsync) {
      await NB.setVisibilityAsync('hidden').catch(() => {});
    }
  } catch {
    // ignore
  }
}
