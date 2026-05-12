/**
 * PenaltyHost — polls /api/penalties/pending on app launch + every
 * time the app returns to the foreground, and queues penalties into
 * the full-screen PenaltyNoticeModal one at a time. Each penalty is
 * acknowledged on the backend the moment the player completes the
 * hold-to-close gesture.
 *
 * Mounted ONCE inside <AuthGate> so we never poll on auth screens
 * and never run twice for the same user.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { api, type PenaltyNotice } from './api';
import { PenaltyNoticeModal } from './components/PenaltyNoticeModal';
import { useAuth } from './AuthContext';

// Lightweight emitter so any code that just applied a penalty (e.g.
// the Creator tools modal) can force the receiving player's host to
// refresh next render. Cross-account in test mode only — in
// production the polling on focus is enough.
let _bump = 0;
let _listener: (() => void) | null = null;
export function bumpPenaltyHost() {
  _bump += 1;
  _listener?.();
}

export function PenaltyHost() {
  const { token, anonymousId } = useAuth();
  const hasAccess = !!token || !!anonymousId;
  const [queue, setQueue] = useState<PenaltyNotice[]>([]);
  const inFlight = useRef(false);

  const fetchPending = useCallback(async () => {
    if (!hasAccess) return;
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await api.penaltiesPending();
      // De-dupe against any items already in the queue so a poll
      // mid-hold doesn't re-enqueue the same one.
      setQueue((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const fresh = (r.penalties || []).filter((p) => !seen.has(p.id));
        return prev.concat(fresh);
      });
    } catch {
      // Silent — every list endpoint can fail transiently; we just
      // try again on the next AppState change.
    } finally {
      inFlight.current = false;
    }
  }, [hasAccess]);

  // Poll on mount, on foreground, and whenever bumpPenaltyHost() is fired.
  useEffect(() => {
    if (!hasAccess) return;
    fetchPending();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetchPending();
    });
    _listener = () => fetchPending();
    return () => {
      sub.remove();
      _listener = null;
    };
  }, [hasAccess, fetchPending]);

  const head = queue[0] || null;

  const dismissHead = useCallback(async () => {
    if (!head) return;
    const id = head.id;
    setQueue((prev) => prev.slice(1));
    try {
      await api.penaltyAcknowledge(id);
    } catch {
      // Re-queue at tail on failure so we try again on the next poll
      setQueue((prev) => [...prev, head]);
    }
  }, [head]);

  return <PenaltyNoticeModal penalty={head} onClose={dismissHead} />;
}

export default PenaltyHost;
