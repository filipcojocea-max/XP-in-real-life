/**
 * useScrollToTopOnFocus — attaches to a ScrollView / FlatList ref and
 * resets the scroll position to y=0 every time the screen re-gains focus.
 *
 * Why: Expo-Router's tab navigator preserves the scroll position of each
 * tab screen across navigation. Users expect "tapping a tab always takes
 * me to the top of that section" — this hook wires exactly that. The
 * reset is non-animated so the top content is immediately visible on
 * arrival (no jarring auto-scroll while the screen is also
 * loading/animating in).
 *
 * Usage:
 *   const scrollRef = React.useRef<ScrollView>(null);
 *   useScrollToTopOnFocus(scrollRef);
 *   return <ScrollView ref={scrollRef}>…</ScrollView>;
 *
 * Works with both `ScrollView` (uses `scrollTo`) and `FlatList /
 * SectionList` (uses `scrollToOffset`). The hook sniffs which method is
 * available at call time so consumers don't need to branch.
 */
import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';

export function useScrollToTopOnFocus(ref: React.RefObject<any>) {
  useFocusEffect(
    useCallback(() => {
      // Defer one tick so any layout measurement that happens on focus
      // (e.g. refreshing data shifting content height) still ends up
      // showing from the top. Without this, on some Android devices the
      // reset would fire BEFORE the new content mounted and get
      // overridden by re-layout.
      const t = setTimeout(() => {
        const node = ref?.current;
        if (!node) return;
        try {
          if (typeof node.scrollTo === 'function') {
            node.scrollTo({ y: 0, animated: false });
          } else if (typeof node.scrollToOffset === 'function') {
            node.scrollToOffset({ offset: 0, animated: false });
          } else if (typeof node.scrollToIndex === 'function') {
            node.scrollToIndex({ index: 0, animated: false });
          }
        } catch {
          // Silent — e.g. empty list scrolling is a no-op on some devices.
        }
      }, 0);
      return () => clearTimeout(t);
    }, [ref]),
  );
}

export default useScrollToTopOnFocus;
