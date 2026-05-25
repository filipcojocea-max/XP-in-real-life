# v1.0.29 — Full Offline-First + Chat Customisation (Plan, awaiting v1.0.28 Play Store confirmation)

## 🆕 ADD-ON SCOPE: Chat customisation (locked 2026-05-14)
All five clarifications captured from the user — bundle with offline-first:

| Decision | Answer |
|---|---|
| Q1 Layout | **🅰️ INVERTED** — sent messages on LEFT, received on RIGHT (non-standard, user-requested) |
| Q2 Color picker | **🅒 Both** — curated palette tab + full HSL custom picker tab |
| Q2 Granularity | **Separate** — 4 colors stored per friend: `sent_bubble`, `sent_text`, `received_bubble`, `received_text` |
| Q3 Block semantics | **🅓 SOFT** — messages still arrive on server; blocker can read history, write replies; just no notification + no unread badge on their side |
| Q4 Mute vs Block | **Distinct**: Mute = no push, red badge STAYS · Block = no push + no badge + lock icon, can still read/write |
| Q5 Timing | **🟢 Bundle into v1.0.29** with offline-first |

### Chat backend (new)
- New collection: `chat_preferences` keyed by `(user_id, friend_id)` storing 4 colors + `muted:bool` + `blocked:bool`
- `POST /api/chat/preferences/{friend_id}` — upsert one or more fields
- `GET /api/chat/preferences/{friend_id}` — read current settings (defaults when missing)
- `GET /api/chat/preferences` — bulk fetch all of caller's chat prefs (for friends list lock icons)
- Push hook: when sending a DM, look up the **recipient's** `chat_preferences` for the sender; if `muted` OR `blocked` → skip push, skip unread counter increment

### Chat frontend (modified)
- `/app/frontend/app/messages/[friendId].tsx`:
  - Bubble rendering flipped: `justifyContent` swap (`flex-end` ↔ `flex-start`) when `msg.from_self === true`
  - Apply stored bubble/text colors from `chat_preferences` (fallback to defaults: cyan sent, surface received)
  - ⚙️ gear icon top-right → opens `<ChatSettingsSheet>` bottom-sheet:
    - Section 1: "MY MESSAGES" → swatch picker for bubble + swatch picker for text (separate)
    - Section 2: "THEIR MESSAGES" → same two swatch pickers
    - Section 3: Toggle row "🔕 Mute notifications" (red badge unaffected)
    - Section 4: Toggle row "🔒 Block this player" (no notifs + no badges + lock icon)
  - Palette: 12 preset colors (cyan, green, amber, red, purple, pink, blue, teal, gold, white, slate, black) + "Custom…" tab opening full HSL picker via `reanimated-color-picker`
- `/app/frontend/app/friends/index.tsx`:
  - Friends list: if `chat_preferences.blocked === true` for a friend → render lock icon overlay on the row's "Message" button; suppress the red unread dot/count
  - Cached locally via the new TanStack Query layer (so blocked-state works offline too)
- All chat preference mutations queued via the OfflineMutationQueue (Layer 2)


## Status: PARKED — DO NOT START UNTIL USER CONFIRMS v1.0.28 IS LIVE ON PLAY STORE

## Status: PARKED — DO NOT START UNTIL USER CONFIRMS v1.0.28 IS LIVE ON PLAY STORE
Build v1.0.28 / versionCode 1023 was kicked off 2026-05-13 21:36 UTC,
build id `465744ba-29e2-43a6-92ed-3d2e90c45fbf`. User must verify Play
upload + go-live before this work begins.

## User decisions (locked, 2026-05-13)
| Option | Choice |
|---|---|
| Scope | 🅱️ Full offline-first (read + write) |
| Timing | 🟢 Wait for v1.0.28 to land first |
| Stack | NO Firebase / Firestore — stay on MongoDB+FastAPI |
| UI | Yellow top banner + "Last updated Xh ago" on leaderboard |
| Messaging/Notifications | Skip while offline |

## Architecture — 4 layers
### Layer 1: Read cache (offline reads)
- Add `@tanstack/react-query` v5 + `@tanstack/query-async-storage-persister`
- Wrap every `api.*` GET in `useQuery` with shared queryClient
- AsyncStorage persister: maxAge 24h, dehydrate after each successful response
- On cold-start with no network → instant cached UI, no spinners

### Layer 2: Mutation queue (offline writes)
- New file: `/app/frontend/src/offline/mutationQueue.ts`
- Each queued op: `{ id: uuid, endpoint, method, body, headers, queuedAt, retries }`
- Persisted in AsyncStorage under key `_xp:offline_queue`
- On NetInfo `isConnected: true` event → drain queue FIFO, exponential backoff on failure
- Server-authoritative responses: 200 → remove from queue; 409 (duplicate) → also remove; 5xx → retry; 4xx other → mark dead-letter for manual review

### Layer 3: Network detector
- Add `@react-native-community/netinfo`
- Provider in `/app/frontend/app/_layout.tsx` after AuthGate
- Exposes `useNetwork()` hook → `{ isConnected, isInternetReachable, since }`
- Drives banner + DM disable + queue drain trigger

### Layer 4: UI
- `<OfflineBanner />` — yellow strip at top, mounts above tabs
  - "📡 Offline · 3 changes will sync when reconnected" (count from queue length)
  - Slide-down animation, persistent until online
- DM screen: input disabled, button shows "Offline" + clock icon (cached messages still visible)
- Leaderboard: subtitle "Last updated 2h ago · cached" when offline
- Notifications: scheduler skips sends when offline (already client-side, no backend change)

## Conflict resolution rules
| Op | Strategy |
|---|---|
| `completeTask(taskId)` | Server-authoritative. Backend already idempotent — duplicates return 200 with `already_completed: true`. Client treats both as success. |
| `tickGoal(goalId)` | Same — backend's `is_locked` check is the source of truth. If goal was already ticked online by another device, client just clears the queued op. |
| `applyPenalty` (admin) | Not queued — admin-only flow, requires online (penalty needs server-side XP recompute). UI shows "Online required" if attempted offline. |
| `sendMessage` | Queued. Backend assigns final timestamp on receipt. Client shows "Sending…" until 200. |
| `gift XP` | Queued, idempotent via client-generated UUID in body. |

## Out-of-scope for v1.0.29 (defer to v1.0.30+)
- Real-time pub/sub when reconnecting (poll on focus is enough)
- Encryption of cached data
- Cache eviction beyond TTL (will revisit if AsyncStorage > 50MB)
- Multi-device merge (assume single device per user)

## Files that will be touched
- `/app/frontend/package.json` — add deps
- `/app/frontend/src/api.ts` — wrap fetch in `queuedFetch`
- `/app/frontend/src/offline/` — NEW folder (mutationQueue.ts, queryClient.ts, networkHook.ts)
- `/app/frontend/src/components/OfflineBanner.tsx` — NEW
- `/app/frontend/app/_layout.tsx` — mount provider + banner
- `/app/frontend/app/(tabs)/tasks.tsx` — adapt to optimistic completion
- `/app/frontend/app/(tabs)/goals.tsx` — adapt tick to queue
- `/app/frontend/app/(tabs)/progress.tsx` — cached charts + subtitle
- `/app/frontend/app/messages/[friendId].tsx` — offline send queue + disabled state
- `/app/frontend/app/friends/index.tsx` — "Last updated" subtitle on leaderboard
- Backend: NO changes required (all endpoints already idempotent via task_logs uniqueness + goal `xp_awarded_on_complete` flag)

## Bump on completion
- app.json: 1.0.29 / versionCode 1024 / buildNumber 1024
- Reuse the same local credentials.json + .jks (signed by 7C:51:3B:61…)

---

REMINDER: Do not start coding this until user explicitly says "v1.0.28 is live, start v1.0.29".
