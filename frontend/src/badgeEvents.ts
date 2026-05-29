/**
 * Tiny in-app pub/sub for newly-unlocked achievement badges.
 *
 * Many backend mutation endpoints (`/tasks/{id}/complete`, etc.) return
 * a `newly_unlocked_achievements: string[]` field whenever an action
 * crosses an achievement threshold. The frontend's `req()` wrapper in
 * `api.ts` calls `emitNewBadges(ids)` when it sees that field; the
 * global `<BadgePopup>` mounted in `_layout.tsx` subscribes and pops
 * up a celebratory modal with the badge's encouraging text.
 *
 * Why a pub/sub instead of React Context: every mutation across the
 * app can emit, and we don't want each screen to thread a callback
 * down through props or re-render the entire context tree.
 */

type Listener = (badgeIds: string[]) => void;
const listeners = new Set<Listener>();

/** Subscribe to "new badges unlocked" events. Returns an unsubscribe fn. */
export function subscribeNewBadges(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Fire a "new badges unlocked" event. Safe to call from anywhere. */
export function emitNewBadges(badgeIds: string[]): void {
  if (!Array.isArray(badgeIds) || badgeIds.length === 0) return;
  // Snapshot listeners so a handler that unsubscribes mid-iteration
  // doesn't break the loop.
  Array.from(listeners).forEach((fn) => {
    try {
      fn(badgeIds);
    } catch {
      /* swallow — never let one bad subscriber kill the rest */
    }
  });
}
