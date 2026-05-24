/**
 * RevealZone — invisible 40-px swipe-up target pinned to the bottom edge.
 *
 * Uses react-native-gesture-handler for cross-platform swipe detection
 * (PanResponder on web is unreliable when synthetic-touch events come
 * through different event paths). Gesture handler ships first-class
 * support for pointer/touch on web and native.
 *
 * Behaviour:
 *  - Visible "hot strip" along the bottom of every screen while the
 *    tab bar is hidden.
 *  - Detects clear UPWARD pan gestures (>= 18 px) and calls
 *    revealTabBar(); horizontal motion cancels.
 *  - Quick taps fall through — only a real swipe activates the
 *    PanGestureHandler, leaving normal taps untouched.
 *  - Removed entirely once the bar is on-screen, so it never overlaps
 *    with the tab buttons themselves.
 */
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { useImmersive } from '../immersive';

export function RevealZone() {
  const { tabBarVisible, revealTabBar } = useImmersive();

  // Pan gesture: activates only on a clear upward motion. Tap-only
  // touches (no movement) never activate, so taps fall through to the
  // underlying view (FAB / list / button etc).
  const swipeUp = Gesture.Pan()
    .activeOffsetY([-9999, -10]) // require >= 10 px upward to claim
    .failOffsetX([-15, 15]) // diagonal/horizontal motion fails the gesture
    .minDistance(8)
    .runOnJS(true)
    .onStart(() => {
      revealTabBar();
    });

  if (tabBarVisible) return null;

  return (
    <GestureHandlerRootView style={styles.zone} pointerEvents="box-none">
      <GestureDetector gesture={swipeUp}>
        <View
          // box-only: only the View itself is the responder target.
          // Combined with the gesture's activeOffsetY, taps don't claim.
          pointerEvents="box-only"
          collapsable={false}
          style={StyleSheet.absoluteFill}
          testID="immersive-reveal-zone"
        />
      </GestureDetector>
      {/* Subtle bottom pill — visual hint that the nav can be swiped up,
          mirrors iOS-style home indicator. Decorative only. */}
      <View pointerEvents="none" style={styles.hintPill} />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  zone: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 40,
    // High z so it sits above page content but BELOW the tab bar
    // (which is owned by React Navigation and only mounts when revealed).
    zIndex: 9999,
    elevation: Platform.OS === 'android' ? 24 : undefined,
    backgroundColor: 'transparent',
  },
  hintPill: {
    position: 'absolute',
    bottom: 6,
    alignSelf: 'center',
    width: 64,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 215, 0, 0.45)', // soft golden hint
  },
});
