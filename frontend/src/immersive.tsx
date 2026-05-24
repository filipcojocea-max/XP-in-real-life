/**
 * Immersive Mode — global tab-bar auto-hide controller.
 *
 * Rules:
 *  - When the user has Immersive Mode ENABLED (default), the bottom tab
 *    bar is hidden and revealed via swipe-up + 5s auto-hide.
 *  - When the user toggles it OFF (Profile → Settings), the tab bar
 *    stays pinned at the bottom forever — no auto-hide, no swipe gate.
 *  - Setting is persisted in AsyncStorage under `immersive_enabled_v1`.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const HIDE_DELAY_MS = 5000;
const PREF_KEY = 'immersive_enabled_v1';

type Ctx = {
  tabBarVisible: boolean;
  /** User-visible toggle: when false, the tab bar stays pinned. */
  immersiveEnabled: boolean;
  setImmersiveEnabled: (v: boolean) => Promise<void>;
  revealTabBar: () => void;
  hideTabBar: () => void;
  pingTabBar: () => void;
};

const ImmersiveContext = createContext<Ctx>({
  tabBarVisible: true,
  immersiveEnabled: true,
  setImmersiveEnabled: async () => {},
  revealTabBar: () => {},
  hideTabBar: () => {},
  pingTabBar: () => {},
});

export function useImmersive() {
  return useContext(ImmersiveContext);
}

export function ImmersiveProvider({ children }: { children: React.ReactNode }) {
  // Default: immersive OFF (always show the navigation bar). The user's
  // onboarding request is that a fresh install keeps the tab bar visible
  // at all times — they can opt-IN to auto-hide via Profile → Settings.
  const [immersiveEnabled, setImmersiveEnabledState] = useState<boolean>(false);
  // When immersive is OFF, force the bar visible at all times.
  const [tabBarVisible, setTabBarVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate the persisted preference once on mount.
  // '1' → immersive ON (auto-hide), '0' → immersive OFF (always show).
  // Missing key → treat as default (OFF) so new installs always show.
  useEffect(() => {
    (async () => {
      try {
        const v = await AsyncStorage.getItem(PREF_KEY);
        if (v === '1') setImmersiveEnabledState(true);
      } catch {}
    })();
  }, []);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const armTimer = useCallback(() => {
    clearTimer();
    if (!immersiveEnabled) return; // never hide when user disabled it
    timerRef.current = setTimeout(() => {
      setTabBarVisible(false);
      timerRef.current = null;
    }, HIDE_DELAY_MS);
  }, [immersiveEnabled]);

  const revealTabBar = useCallback(() => {
    setTabBarVisible(true);
    armTimer();
  }, [armTimer]);

  const hideTabBar = useCallback(() => {
    if (!immersiveEnabled) return; // ignore hide requests when disabled
    clearTimer();
    setTabBarVisible(false);
  }, [immersiveEnabled]);

  const pingTabBar = useCallback(() => {
    if (timerRef.current || tabBarVisible) {
      armTimer();
    }
  }, [armTimer, tabBarVisible]);

  // Whenever the user toggles immersive OFF, immediately pin the bar
  // and kill any pending hide timer.
  useEffect(() => {
    if (!immersiveEnabled) {
      clearTimer();
      setTabBarVisible(true);
    }
  }, [immersiveEnabled]);

  const setImmersiveEnabled = useCallback(async (v: boolean) => {
    setImmersiveEnabledState(v);
    try {
      await AsyncStorage.setItem(PREF_KEY, v ? '1' : '0');
    } catch {}
  }, []);

  useEffect(() => () => clearTimer(), []);

  return (
    <ImmersiveContext.Provider
      value={{
        tabBarVisible,
        immersiveEnabled,
        setImmersiveEnabled,
        revealTabBar,
        hideTabBar,
        pingTabBar,
      }}
    >
      {children}
    </ImmersiveContext.Provider>
  );
}
