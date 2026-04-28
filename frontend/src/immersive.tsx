/**
 * Immersive Mode — global tab-bar auto-hide controller.
 *
 * Rules (per spec):
 *  - The bottom tab bar is HIDDEN by default so the app content can use
 *    the full screen height.
 *  - It becomes visible when revealTabBar() is called (e.g. via the
 *    bottom 40-px swipe-up reveal zone, or when the user actively taps
 *    a tab).
 *  - After 5 seconds of inactivity, it auto-hides again.
 *  - Instant show/hide — no slide animation (matches user pick #4=B).
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const HIDE_DELAY_MS = 5000;

type Ctx = {
  tabBarVisible: boolean;
  revealTabBar: () => void;
  hideTabBar: () => void;
  /** Reset the auto-hide timer without changing visibility — call this
   *  whenever the user is actively interacting with the tab bar. */
  pingTabBar: () => void;
};

const ImmersiveContext = createContext<Ctx>({
  tabBarVisible: false,
  revealTabBar: () => {},
  hideTabBar: () => {},
  pingTabBar: () => {},
});

export function useImmersive() {
  return useContext(ImmersiveContext);
}

export function ImmersiveProvider({ children }: { children: React.ReactNode }) {
  // Default = hidden. The tabs layout calls revealTabBar() on first mount
  // so the user gets a 5-second peek as soon as the navigation is on
  // screen (post-auth), and pre-auth screens never need the bar.
  const [tabBarVisible, setTabBarVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const armTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      setTabBarVisible(false);
      timerRef.current = null;
    }, HIDE_DELAY_MS);
  }, []);

  const revealTabBar = useCallback(() => {
    setTabBarVisible(true);
    armTimer();
  }, [armTimer]);

  const hideTabBar = useCallback(() => {
    clearTimer();
    setTabBarVisible(false);
  }, []);

  const pingTabBar = useCallback(() => {
    if (timerRef.current || tabBarVisible) {
      armTimer();
    }
  }, [armTimer, tabBarVisible]);

  useEffect(() => () => clearTimer(), []);

  return (
    <ImmersiveContext.Provider value={{ tabBarVisible, revealTabBar, hideTabBar, pingTabBar }}>
      {children}
    </ImmersiveContext.Provider>
  );
}
