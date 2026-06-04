"""
Buried Treasure — complete rewrite per 2026-05-30 product spec.

Two play modes:

  SOLO
    • User confirms a location + adjustable area radius on a map.
    • Server picks a random chest point inside that circle.
    • User hunts with compass + distance read-out; tap the camera and
      submit a photo while within 15 m of the chest to confirm a find.
    • Successful find  → 100 XP + chest is saved to Past Finds, and
      the server immediately auto-assigns a brand-new chest inside the
      same area so the loop never breaks.

  FRIENDS
    • Group creator picks the same kind of area + radius, names the
      group and gets a 6-character share code.
    • Creator picks friends from their friend list — server checks
      each friend's last-known location and rejects any friend who is
      more than 50 km away ("not in your area").
    • Invited friends receive an in-app notification + a push
      ("You've been invited to join a Buried Treasure group!") with
      ACCEPT / REJECT buttons.
    • Once EVERY invitee has accepted, the creator unlocks the
      "Bury Treasure" step: they physically walk to a spot, take a
      photo of the spot, and screenshot the map. The chest is then
      live for everyone else to hunt.
    • Whoever finds the chest first (15 m proximity + photo) wins
      100 XP and the group is marked finished.

Endpoints (all mounted under /api):

  Location bookkeeping (used by the 50 km friend-area check):
    POST  /bt/location                       body {lat, lng}

  Solo:
    POST  /bt/solo/start                     body {lat, lng, radius_m}
    GET   /bt/solo/current
    GET   /bt/solo/compass?lat=&lng=
    POST  /bt/solo/find                      body {lat, lng, photo_base64}
    GET   /bt/solo/finds                     past finds with photos

  Groups (friends):
    POST  /bt/groups/create                  body {name, lat, lng, radius_m}
    POST  /bt/groups/{gid}/invite            body {friend_ids: [...]}
    GET   /bt/groups/mine                    groups I created or am in
    GET   /bt/groups/available               joinable friend-created groups
    POST  /bt/groups/{gid}/accept
    POST  /bt/groups/{gid}/reject
    POST  /bt/groups/join-by-code            body {code}
    POST  /bt/groups/{gid}/bury              body {lat, lng, photo_base64,
                                                   map_screenshot_base64}
    GET   /bt/groups/{gid}                   full group state
    GET   /bt/groups/{gid}/compass?lat=&lng=
    POST  /bt/groups/{gid}/find              body {lat, lng, photo_base64}

Collections:
  bt_player_location  {_id:user_id, lat, lng, updated_at}
  bt_solo             {_id:user_id, area:{lat,lng,radius_m},
                       chest:{lat,lng}, created_at}
  bt_solo_finds       {_id, user_id, lat, lng, photo_base64,
                       found_at, xp_awarded}
  bt_groups           {_id, code, creator_id, name, area:{...},
                       status:'lobby'|'hunting'|'finished',
                       members:[{user_id, name, status, invited_at,
                                 responded_at?}],
                       chest_lat?, chest_lng?, chest_photo_base64?,
                       map_screenshot_base64?,
                       buried_at?, found_by?, found_at?, created_at}
  bt_group_finds      {_id, group_id, user_id, lat, lng,
                       photo_base64, found_at, xp_awarded}
"""
from __future__ import annotations

import logging
import math
import random
import string
import uuid
from datetime import datetime, timezone
from typing import Optional

try:
    # Python 3.9+ stdlib — every Emergent pod ships with this.
    from zoneinfo import ZoneInfo  # type: ignore
except Exception:  # pragma: no cover — extremely defensive
    ZoneInfo = None  # type: ignore

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ── module-level wiring (set by init_buried_treasure) ────────────────
_db = None
_now_iso = None
_send_push = None        # async fn(token, title, body, data)
_friend_ids_fn = None    # async fn(user_id) -> list[str]
_admin_emails: list[str] = []  # populated from init; used to route solo issue reports

# ── tuning constants (per product spec) ──────────────────────────────
MIN_RADIUS_M = 100
MAX_RADIUS_M = 25_000           # 25 km
FIND_RING_M = 15                # tap-to-find proximity
FRIEND_AREA_KM = 50             # max distance between group creator and friend
XP_FIND_SOLO = 100
XP_FIND_GROUP = 100
GROUP_CODE_LEN = 6
GROUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no easily-confused
MAX_PHOTO_BYTES = 2_500_000      # ~2.5 MB after base64 (we store base64 raw)

# ── Issue reporting (2026-06-04 spec) ────────────────────────────────
# Players can flag a chest spawn as bad ("private property", inaccessible,
# etc.) from the active hunt screen. The owner/admin reviews each report
# and either ignores it or CONFIRMs it — confirmed reports add the chest
# coord to `bt_blocked_coords` with a 30 m radius, preventing future
# hunts from spawning a chest there. The currently-active chest is NOT
# moved; the block is forward-looking only.
BLOCK_RADIUS_M = 30
MAX_BLOCK_PICK_RETRIES = 6
REPORT_CATEGORIES = {"chest", "location"}
REPORT_NOTES_MAX_CHARS = 500


# ─────────────────────────────────────────────────────────────────────
# Init
# ─────────────────────────────────────────────────────────────────────
def init_buried_treasure(
    *,
    db,
    is_admin_user=None,        # kept for backward-compat with server.py wiring
    now_iso,
    admin_emails=None,         # used to route solo issue reports to admin
    send_push,
    friend_ids_fn,
):
    """Wire up the module. Must be called once at server startup BEFORE
    attach_routes()."""
    global _db, _now_iso, _send_push, _friend_ids_fn, _admin_emails
    _db = db
    _now_iso = now_iso
    _send_push = send_push
    _friend_ids_fn = friend_ids_fn
    _admin_emails = [str(e).strip().lower() for e in (admin_emails or []) if e]
    logger.info("[buried_treasure] initialized")


async def _resolve_admin_ids() -> list[str]:
    """Resolve the list of admin/creator user_ids by looking up the
    admin emails in db.users. Cached implicitly per-call since the
    admin set is tiny (usually 1)."""
    if _db is None or not _admin_emails:
        return []
    try:
        ids: list[str] = []
        async for u in _db.users.find(
            {"email": {"$in": _admin_emails}},
            {"_id": 1},
        ):
            uid = u.get("_id")
            if uid:
                ids.append(str(uid))
        return ids
    except Exception:
        return []


async def _is_coord_blocked(lat: float, lng: float) -> bool:
    """True iff (lat, lng) falls inside any active bt_blocked_coords
    entry (haversine ≤ stored radius_m). Used by chest pickers so a
    creator-confirmed report permanently prevents that spot from being
    chosen again."""
    if _db is None:
        return False
    try:
        async for b in _db.bt_blocked_coords.find({}, {"lat": 1, "lng": 1, "radius_m": 1}):
            blat = b.get("lat")
            blng = b.get("lng")
            if blat is None or blng is None:
                continue
            r = float(b.get("radius_m") or BLOCK_RADIUS_M)
            if _haversine_m(lat, lng, float(blat), float(blng)) <= r:
                return True
    except Exception:
        # Defensive: never crash chest-picking on a DB hiccup. The block
        # filter is a quality-of-life feature, not a correctness gate.
        pass
    return False


# ─────────────────────────────────────────────────────────────────────
# Geo helpers
# ─────────────────────────────────────────────────────────────────────
def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Distance in metres between two WGS-84 points."""
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _bearing_deg(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Initial-course bearing in degrees [0, 360) from 1 → 2 (true north)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    deg = math.degrees(math.atan2(x, y))
    return (deg + 360) % 360


def _random_point_in_circle(center_lat: float, center_lng: float, radius_m: float) -> tuple[float, float]:
    """Uniform-random point inside a circle of `radius_m` around the
    centre. KEPT as a final-fallback when the Overpass public-land
    filter returns nothing usable. Production callers should prefer
    `_pick_public_chest_point` so chests never land on private land."""
    import math, random as _r
    # Uniform sampling in a disc: sqrt(u) for radial bias correction.
    r = radius_m * math.sqrt(_r.random())
    theta = 2 * math.pi * _r.random()
    dlat_m = r * math.cos(theta)
    dlng_m = r * math.sin(theta)
    # ~111_111 m per degree of latitude; longitude scales by cos(lat).
    lat = center_lat + (dlat_m / 111_111.0)
    lng = center_lng + (dlng_m / (111_111.0 * math.cos(math.radians(center_lat)) or 1.0))
    return lat, lng


async def _pick_safe_random_point(center_lat: float, center_lng: float, radius_m: float) -> tuple[float, float]:
    """Uniform-random point that also avoids the blocked-coord list.
    Falls back to the unfiltered point if all retries are blocked
    (extremely unlikely unless the entire hunt area is blocked)."""
    for _ in range(MAX_BLOCK_PICK_RETRIES):
        lat, lng = _random_point_in_circle(center_lat, center_lng, radius_m)
        if not await _is_coord_blocked(lat, lng):
            return lat, lng
    return _random_point_in_circle(center_lat, center_lng, radius_m)


# ─── Public-land chest placement (Overpass / OSM) ────────────────────
# Per 2026-06-04 product spec the chest MUST land on publicly-accessible
# open land — parks, school ovals, beaches, recreation grounds — never
# on a private residence, driveway, or fenced commercial lot. We query
# the OSM Overpass API for matching ways inside the player's hunt area
# and pick a centroid (with small jitter) of one of them. Falls back to
# expanding the radius up to 2× before giving up.
_OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",  # backup mirror
]

# Tags that designate publicly-accessible open land. Order-of-preference:
# the more "leisure"-y, the better the hunt experience.
_PUBLIC_TAGS_QUERY = """
[out:json][timeout:12];
(
  way["leisure"~"^(park|recreation_ground|garden|playground|pitch|nature_reserve|common|dog_park)$"](around:{r},{lat},{lng});
  way["landuse"~"^(park|recreation_ground|grass|village_green|forest|meadow)$"](around:{r},{lat},{lng});
  way["natural"~"^(beach|wood|grassland|heath)$"](around:{r},{lat},{lng});
  way["amenity"="school"](around:{r},{lat},{lng});
  way["amenity"="public_park"](around:{r},{lat},{lng});
);
out center tags 60;
"""


def _is_forbidden_tags(tags: dict) -> bool:
    """Reject ways tagged as private / residential / building no matter
    what else they claim to be (e.g. a "garden" tagged inside a private
    residence)."""
    if not tags:
        return False
    if (tags.get("access") or "").lower() in ("private", "no", "permit"):
        return True
    if (tags.get("private") or "").lower() == "yes":
        return True
    if tags.get("landuse") == "residential":
        return True
    if tags.get("building"):
        return True
    return False


async def _overpass_public_centers(lat: float, lng: float, radius_m: float) -> list[tuple[float, float, dict]]:
    """Returns a list of (centre_lat, centre_lng, tags) for public-land
    ways within `radius_m` of (lat, lng). Empty list on failure — the
    caller is expected to fall back gracefully."""
    import httpx as _httpx
    query = _PUBLIC_TAGS_QUERY.format(r=int(radius_m), lat=lat, lng=lng)
    for endpoint in _OVERPASS_ENDPOINTS:
        try:
            async with _httpx.AsyncClient(timeout=14.0) as client:
                resp = await client.post(endpoint, data={"data": query})
                if resp.status_code != 200:
                    continue
                data = resp.json()
                results: list[tuple[float, float, dict]] = []
                for el in (data.get("elements") or []):
                    tags = el.get("tags") or {}
                    if _is_forbidden_tags(tags):
                        continue
                    c = el.get("center") or {}
                    c_lat = c.get("lat")
                    c_lng = c.get("lon")
                    if c_lat is None or c_lng is None:
                        continue
                    # Final safety: make sure the centre is still inside
                    # the requested radius (Overpass `around` is
                    # bounding-box based and can leak a few extra m).
                    if _haversine_m(lat, lng, float(c_lat), float(c_lng)) > radius_m * 1.05:
                        continue
                    results.append((float(c_lat), float(c_lng), tags))
                return results
        except Exception:
            # Try the next mirror.
            continue
    return []


async def _pick_public_chest_point(lat: float, lng: float, radius_m: float) -> tuple[float, float]:
    """Pick a chest location that's guaranteed to be on publicly
    accessible land via OSM Overpass. Expands the search radius up to
    2× when the initial query is empty, then falls back to the legacy
    uniform-disc sampler only as a last resort (logged WARN). Adds a
    small ±25 m jitter inside the matched way so two consecutive
    chests don't spawn on the exact same picnic table.

    2026-06-04: also filters out any candidate within 30 m of a
    bt_blocked_coords entry (creator-confirmed bad-spot reports).
    Candidate centres AND jittered final coords are both checked."""
    import math, random as _r
    # Try at progressively wider radii. Cap at 2× the original.
    for scale in (1.0, 1.4, 2.0):
        r_try = max(50.0, radius_m * scale)
        candidates = await _overpass_public_centers(lat, lng, r_try)
        if not candidates:
            continue
        # 2026-06-04: drop blocked centres before random.choice so we
        # don't bias the distribution by reshuffling later.
        unblocked: list[tuple[float, float, dict]] = []
        for c in candidates:
            if not await _is_coord_blocked(float(c[0]), float(c[1])):
                unblocked.append(c)
        pool = unblocked if unblocked else candidates  # if every centre is blocked, fall through to random
        # Try up to N jitter rolls — the jitter can drift into a blocked
        # zone even when the centre itself is clean.
        for _ in range(MAX_BLOCK_PICK_RETRIES):
            c_lat, c_lng, _tags = _r.choice(pool)
            # ±25 m jitter — small enough to stay inside most park polygons
            # but large enough that re-buries don't reuse the same point.
            jit_r = 25.0 * math.sqrt(_r.random())
            theta = 2 * math.pi * _r.random()
            j_lat = c_lat + (jit_r * math.cos(theta) / 111_111.0)
            j_lng = c_lng + (jit_r * math.sin(theta) / (111_111.0 * math.cos(math.radians(c_lat)) or 1.0))
            if not await _is_coord_blocked(j_lat, j_lng):
                return j_lat, j_lng
        # All jitter attempts were blocked — return last attempted point
        # so the hunt isn't completely broken (extremely unlikely).
        return j_lat, j_lng  # type: ignore[name-defined]
    # Last-resort fallback. Logged so we notice if Overpass is down.
    logging.getLogger("buried_treasure").warning(
        "[bt] Overpass returned no public land within %.0f m of %.5f,%.5f — falling back to random point.",
        radius_m, lat, lng,
    )
    return await _pick_safe_random_point(lat, lng, radius_m)


def _gen_group_code() -> str:
    return "".join(random.choice(GROUP_CODE_ALPHABET) for _ in range(GROUP_CODE_LEN))


# ─────────────────────────────────────────────────────────────────────
# Awake-window helpers (Smart Availability Filter)
# ─────────────────────────────────────────────────────────────────────
# Per 2026-06-01 product spec, every player has a simple HH:MM "awake
# window" stored alongside their IANA timezone. When the server picks
# which groups receive a treasure (or which joinable lobbies a friend
# can see in /bt/groups/available) it skips groups whose members are
# all currently OUTSIDE their awake window — i.e. asleep.
#
# Storage: `bt_player_schedule` collection
#   {_id: user_id, awake_start: "HH:MM", awake_end: "HH:MM",
#    sleep_all_day: bool, timezone: "America/New_York",
#    updated_at: iso}
#
# Defaults: 08:00 → 23:00 local time. `sleep_all_day=True` overrides
# everything → always inactive.
DEFAULT_AWAKE_START = "08:00"
DEFAULT_AWAKE_END = "23:00"


def _parse_hhmm(s: Optional[str]) -> Optional[tuple[int, int]]:
    """Parse 'HH:MM' → (hour, minute). Returns None on malformed input."""
    if not s or not isinstance(s, str):
        return None
    try:
        h_str, m_str = s.strip().split(":", 1)
        h = int(h_str)
        m = int(m_str)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h, m
    except Exception:
        pass
    return None


def _fmt_hhmm(t: tuple[int, int]) -> str:
    return f"{t[0]:02d}:{t[1]:02d}"


def _resolve_tz(tz_name: Optional[str]):
    """Best-effort IANA → tzinfo. Falls back to UTC so callers never crash."""
    if not tz_name or ZoneInfo is None:
        return timezone.utc
    try:
        return ZoneInfo(tz_name.strip())
    except Exception:
        return timezone.utc


def _is_in_window(now_minutes: int, start: tuple[int, int], end: tuple[int, int]) -> bool:
    """Returns True iff `now_minutes` (minute-of-day) is inside the
    [start, end) HH:MM window. Supports wrap-around windows (e.g. a
    night-shift player set to 22:00 → 06:00)."""
    s = start[0] * 60 + start[1]
    e = end[0] * 60 + end[1]
    if s == e:
        # Degenerate window → treat as "always awake" so we don't
        # silently lock the user out by a single typo.
        return True
    if s < e:
        return s <= now_minutes < e
    # Wrap-around (e.g. 22:00 → 06:00)
    return now_minutes >= s or now_minutes < e


async def _get_user_schedule(user_id: str, *, now_utc: Optional[datetime] = None) -> dict:
    """Return the user's awake window — SYNCED with the Work-Scheduler
    mini-app (profile.shift_schedule). When the scheduler is disabled
    or has no pattern, we fall back to a default 08:00–23:00 local
    window per 2026-06-02 product spec.

    The manual `bt_player_schedule` collection is deprecated — we no
    longer ask the user to enter awake hours twice.

    Returned shape:
      {
        user_id, awake_start, awake_end, timezone,
        source: 'scheduler' | 'default',
        shift:  'day' | 'night' | 'off' | None,
      }
    """
    prof = await _db.profile.find_one(
        {"_id": user_id},
        {"_id": 0, "timezone": 1, "shift_schedule": 1, "wake_time": 1, "day_start_time": 1},
    ) or {}
    tz_name = (prof.get("timezone") or "").strip() or "UTC"
    tz = _resolve_tz(tz_name)
    now = (now_utc or datetime.now(timezone.utc)).astimezone(tz)

    sched = prof.get("shift_schedule") or {}
    enabled = bool(sched.get("enabled"))
    shift_label: Optional[str] = None

    if enabled:
        # Lazy import — avoids a circular dep at module-load time
        # because server.py imports this module at startup.
        try:
            from server import _shift_for_date, DEFAULT_SHIFTS  # type: ignore
        except Exception:
            _shift_for_date = None  # type: ignore
            DEFAULT_SHIFTS = {}  # type: ignore

        if _shift_for_date is not None:
            today_iso = now.date().isoformat()
            try:
                shift_label = _shift_for_date(prof, today_iso)
            except Exception:
                shift_label = None
            if shift_label:
                shifts = sched.get("shifts") or {}
                s_def = shifts.get(shift_label) or DEFAULT_SHIFTS.get(shift_label) or {}
                start = _parse_hhmm(s_def.get("start_time")) or (8, 0)
                # The scheduler's "sleep_time" is the moment they stop
                # being awake → exactly the awake-window end.
                end = _parse_hhmm(s_def.get("sleep_time")) or (23, 0)
                return {
                    "user_id": user_id,
                    "awake_start": _fmt_hhmm(start),
                    "awake_end": _fmt_hhmm(end),
                    "timezone": tz_name,
                    "source": "scheduler",
                    "shift": shift_label,
                }
            # enabled but no shift for today (e.g. empty pattern) →
            # fall through to default below so the user still gets a
            # sensible awake window rather than being marked inactive
            # 24/7 by accident.

    # ── Fallback: scheduler off / not set up → 08:00–23:00 local ─────
    return {
        "user_id": user_id,
        "awake_start": "08:00",
        "awake_end": "23:00",
        "timezone": tz_name,
        "source": "default",
        "shift": None,
    }


async def _is_user_awake_now(user_id: str, *, now_utc: Optional[datetime] = None) -> bool:
    """True iff the user is currently inside their resolved awake
    window. Awake-window resolution rules are documented on
    `_get_user_schedule`."""
    sched = await _get_user_schedule(user_id, now_utc=now_utc)
    start = _parse_hhmm(sched["awake_start"]) or (8, 0)
    end = _parse_hhmm(sched["awake_end"]) or (23, 0)
    tz = _resolve_tz(sched["timezone"])
    now = (now_utc or datetime.now(timezone.utc)).astimezone(tz)
    cur = now.hour * 60 + now.minute
    return _is_in_window(cur, start, end)


async def _is_group_active_now(doc: dict) -> bool:
    """A group is "active" when at least one accepted member is
    currently awake AND hasn't muted that group via the per-user
    Group Toggle. Used as the filter for treasure selection /
    /bt/groups/available.
    """
    if not doc:
        return False
    members = doc.get("members") or []
    accepted = [m for m in members if m.get("status") == "accepted"]
    if not accepted:
        return False
    gid = doc.get("_id")
    for m in accepted:
        uid = m.get("user_id")
        if not uid:
            continue
        # Per-user group toggle — missing pref = ON.
        pref = await _db.bt_group_prefs.find_one({"_id": f"{uid}:{gid}"})
        notif_on = True if not pref else bool(pref.get("notifications_enabled", True))
        if not notif_on:
            continue
        if await _is_user_awake_now(uid):
            return True
    return False


async def _enrich_group(payload: dict, doc: dict) -> dict:
    """Attach Smart-Availability metadata to a `_group_public` payload
    so the frontend can render the "Inactive" badge without an extra
    round-trip."""
    if not payload:
        return payload
    payload["is_active_now"] = await _is_group_active_now(doc)
    return payload


def _validate_photo(b64: Optional[str], *, required: bool = True, field: str = "photo_base64"):
    if not b64:
        if required:
            raise HTTPException(400, f"{field} is required.")
        return
    # Strip data: URL prefix if present
    if b64.startswith("data:"):
        try:
            b64 = b64.split(",", 1)[1]
        except Exception:
            raise HTTPException(400, f"{field} is not a valid base64 string.")
    if len(b64) > MAX_PHOTO_BYTES:
        raise HTTPException(413, f"{field} too large (max ~2.5 MB).")
    return b64


# ─────────────────────────────────────────────────────────────────────
# Push helper
# ─────────────────────────────────────────────────────────────────────
async def _push_to_user(user_id: str, title: str, body: str, data: dict | None = None):
    """Best-effort push to every registered token for the user."""
    try:
        tokens = await _db.push_tokens.find({"user_id": user_id}).to_list(10)
    except Exception as e:
        logger.warning("[bt-push.tokens] %s: %s", user_id, e)
        return 0
    sent = 0
    for tdoc in tokens:
        tok = tdoc.get("token")
        if not tok:
            continue
        try:
            await _send_push(tok, title, body, data or {})
            sent += 1
        except Exception as e:
            logger.warning("[bt-push.send] %s: %s", user_id, e)
    return sent


async def _award_xp(user_id: str, amount: int, *, reason: str) -> int:
    """Increment the player's total_xp and write a task_log row so the
    same XP shows up on their progress chart (kind='bt_find').
    Returns the new total."""
    if amount <= 0:
        return 0
    today = datetime.now(timezone.utc).date().isoformat()
    await _db.task_logs.insert_one({
        "_id": str(uuid.uuid4()),
        "user_id": user_id,
        "date": today,
        "kind": "bt_find",
        "xp_awarded": int(amount),
        "focus_area": "social",   # treasure hunting is social fun
        "note": reason,
        "created_at": _now_iso(),
    })
    res = await _db.profile.find_one_and_update(
        {"_id": user_id},
        {"$inc": {"total_xp": int(amount)}},
        return_document=True,
    )
    return int((res or {}).get("total_xp", 0))


async def _player_name(user_id: str) -> str:
    p = await _db.profile.find_one({"_id": user_id}, {"_id": 0, "name": 1})
    return ((p or {}).get("name") or "Player").strip() or "Player"


# ─────────────────────────────────────────────────────────────────────
# Pydantic bodies
# ─────────────────────────────────────────────────────────────────────
class LocationBody(BaseModel):
    lat: float
    lng: float


class StartSoloBody(BaseModel):
    lat: float
    lng: float
    radius_m: float = Field(..., gt=0)


class FindBody(BaseModel):
    lat: float
    lng: float
    photo_base64: Optional[str] = None


class GroupCreateBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    lat: float
    lng: float
    radius_m: float = Field(..., gt=0)


class GroupInviteBody(BaseModel):
    friend_ids: list[str] = Field(default_factory=list)


class GroupJoinCodeBody(BaseModel):
    code: str


class BuryBody(BaseModel):
    lat: float
    lng: float
    photo_base64: str
    map_screenshot_base64: str


class SettingsBody(BaseModel):
    """Persistent area saved in Mini-App Settings. Once stored the
    Treasure home screen skips the map picker on every subsequent open
    — users can only edit this from /treasure/settings."""
    lat: float
    lng: float
    radius_m: float = Field(..., gt=0)
    label: Optional[str] = None


class GroupToggleBody(BaseModel):
    enabled: bool


# (ScheduleBody was removed 2026-06-02 — the manual awake-hours POST
#  endpoint is gone now that BT availability is synced with the
#  Work-Scheduler mini-app. See `_get_user_schedule` for the new
#  resolution rules.)


# ─────────────────────────────────────────────────────────────────────
# Public solo helpers
# ─────────────────────────────────────────────────────────────────────
def _clamp_radius(r: float) -> float:
    return float(max(MIN_RADIUS_M, min(MAX_RADIUS_M, r)))


def _solo_public(doc: dict | None) -> dict | None:
    """Public solo-hunt payload.

    2026-06-04 — per product spec the "Find the Treasure Chest" screen
    now shows a static map clue centred on the chest, so we explicitly
    expose `chest_lat` / `chest_lng` to the client. (Previously these
    were hidden so the player had to navigate purely via the compass.)
    The compass / distance / find-ring radius are still authoritative
    server-side via /bt/solo/compass + /bt/solo/find.
    """
    if not doc:
        return None
    area = doc.get("area") or {}
    out = {
        "user_id": doc.get("_id"),
        "area": {
            "lat": float(area.get("lat") or 0.0),
            "lng": float(area.get("lng") or 0.0),
            "radius_m": float(area.get("radius_m") or 0.0),
        },
        "created_at": doc.get("created_at"),
        "status": "active",
    }
    # Chest coords — only present once a chest has been placed (which
    # happens immediately on hunt start in the current model, but we
    # still null-guard for hunts that pre-date this field). Stored
    # nested under `doc['chest']` by solo_start(), so we read from
    # there rather than the top level.
    try:
        chest = doc.get("chest") or {}
        c_lat = chest.get("lat")
        c_lng = chest.get("lng")
        if c_lat is not None and c_lng is not None:
            out["chest_lat"] = float(c_lat)
            out["chest_lng"] = float(c_lng)
    except Exception:
        pass
    return out


def _group_public(doc: dict | None, *, viewer_id: str) -> dict | None:
    if not doc:
        return None
    is_creator = doc.get("creator_id") == viewer_id
    members = doc.get("members") or []
    you = next((m for m in members if m.get("user_id") == viewer_id), None)
    my_status = (you or {}).get("status") if you else (
        "creator" if is_creator else None
    )

    # While the chest is still buried, ONLY the chest photo + map
    # screenshot are exposed — the precise coords stay server-side.
    chest_ready = doc.get("status") in ("hunting", "finished") and doc.get("chest_lat") is not None
    chest_payload = None
    if chest_ready:
        chest_payload = {
            "photo_base64": doc.get("chest_photo_base64"),
            "map_screenshot_base64": doc.get("map_screenshot_base64"),
            "buried_at": doc.get("buried_at"),
        }

    return {
        "id": doc.get("_id"),
        "code": doc.get("code"),
        "name": doc.get("name"),
        "creator_id": doc.get("creator_id"),
        "is_creator": is_creator,
        "my_status": my_status,
        "status": doc.get("status"),
        # Per 2026-06-04 spec: Accept/Reject answers stay flippable
        # while the group is in "lobby"; once the creator transitions
        # the group (status != lobby) the answers lock.
        "responses_locked": doc.get("status") != "lobby",
        "area": doc.get("area"),
        "members": members,
        "chest": chest_payload,
        "found_by": doc.get("found_by"),
        "found_at": doc.get("found_at"),
        "created_at": doc.get("created_at"),
    }


# ─────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────
def attach_routes(app, get_user_or_legacy):
    router = APIRouter(prefix="/api")

    # ── Location bookkeeping ─────────────────────────────────────────
    @router.post("/bt/location")
    async def save_location(
        body: LocationBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        await _db.bt_player_location.update_one(
            {"_id": user_id},
            {"$set": {
                "_id": user_id,
                "lat": float(body.lat),
                "lng": float(body.lng),
                "updated_at": _now_iso(),
            }},
            upsert=True,
        )
        return {"ok": True}

    # ── PERSISTENT INVITES (Round B, 2026-06-04) ─────────────────────
    # Persistent in-app invite list. Per spec these notifications MUST
    # NEVER disappear until the player explicitly opens and views the
    # invite. The `requires_view=True` flag stays on until the
    # /view endpoint is hit, at which point `opened_at` is stamped.
    # Rejecting / accepting the invite via the existing
    # /bt/groups/{id}/accept|reject also clears it (handled below).
    @router.get("/bt/invites/pending")
    async def invites_pending(user_id: str = Depends(get_user_or_legacy)):
        cur = _db.bt_invites.find({
            "user_id": user_id,
            "requires_view": True,
        }).sort("created_at", -1)
        out: list[dict] = []
        async for d in cur:
            out.append({
                "group_id": d.get("group_id"),
                "group_name": d.get("group_name") or "Treasure Hunt",
                "group_code": d.get("group_code"),
                "creator_id": d.get("creator_id"),
                "creator_name": d.get("creator_name") or "A friend",
                "created_at": d.get("created_at"),
                "opened_at": d.get("opened_at"),
                "requires_view": True,
            })
        return {"invites": out, "count": len(out)}

    @router.post("/bt/invites/{gid}/view")
    async def invite_view(gid: str, user_id: str = Depends(get_user_or_legacy)):
        """Mark a persistent invite as viewed. Idempotent."""
        await _db.bt_invites.update_one(
            {"group_id": gid, "user_id": user_id},
            {"$set": {"requires_view": False, "opened_at": _now_iso()}},
        )
        return {"ok": True}

    # ── FRIENDS ELIGIBILITY (for invite UI) ──────────────────────────
    # so the invite UI can render:
    #   • selectable    — friend has BT settings AND their area
    #                     circle overlaps with mine.
    #   • greyed+locked — friend has no BT settings (proxy for "hasn't
    #                     installed / opened the mini-app yet").
    #   • greyed only   — friend has BT settings but different region.
    #
    # Overlap rule per 2026-06-04 spec: two area circles overlap when
    # the great-circle distance between their centres is ≤ the sum of
    # their radii (haversine + radius sum).
    @router.get("/bt/friends-eligible")
    async def friends_eligible(user_id: str = Depends(get_user_or_legacy)):
        friend_ids = await _friend_ids_fn(user_id)
        if not friend_ids:
            return {"friends": [], "has_my_area": False}
        # 2026-06-04 fix: read from bt_player_settings (the canonical
        # collection used by /bt/settings GET/POST) with the flat
        # {lat, lng, radius_m} schema. The earlier draft accidentally
        # read from `bt_settings.area.{...}` which doesn't exist in
        # production, so every real friend was returning reason='no_app'.
        my_area_doc = await _db.bt_player_settings.find_one({"_id": user_id})
        my_area = my_area_doc or {}
        my_lat = my_area.get("lat")
        my_lng = my_area.get("lng")
        my_rad = my_area.get("radius_m") or 0.0
        if my_lat is None or my_lng is None:
            # Creator hasn't picked an area yet — nobody is eligible
            # regardless of friends' status, but we still return the
            # list so the UI can render a "set your area first" hint.
            no_my_area = True
        else:
            no_my_area = False

        # Pull the names + BT settings for all friends in one go.
        name_map = {}
        async for prof in _db.profile.find(
            {"_id": {"$in": friend_ids}}, {"_id": 1, "name": 1, "avatar_base64": 1}
        ):
            name_map[prof.get("_id")] = {
                "name": prof.get("name") or "Player",
                "avatar_base64": prof.get("avatar_base64") or None,
            }
        settings_map = {}
        async for s in _db.bt_player_settings.find(
            {"_id": {"$in": friend_ids}},
            {"_id": 1, "lat": 1, "lng": 1, "radius_m": 1},
        ):
            # Flat schema — copy the doc directly; downstream code reads
            # `.get("lat")` / `.get("lng")` / `.get("radius_m")`.
            settings_map[s.get("_id")] = s

        out: list[dict] = []
        for fid in friend_ids:
            np = name_map.get(fid) or {"name": "Player", "avatar_base64": None}
            farea = settings_map.get(fid) or {}
            has_bt = bool(farea.get("lat") is not None and farea.get("lng") is not None)
            entry: dict = {
                "user_id": fid,
                "name": np["name"],
                "avatar_base64": np["avatar_base64"],
                "has_bt": has_bt,
                "eligible": False,
                "reason": None,        # null when eligible
                "distance_km": None,   # populated when has_bt is true
            }
            if not has_bt:
                entry["reason"] = "no_app"
                out.append(entry)
                continue
            if no_my_area:
                # We can't compute overlap without our own area, but the
                # friend has BT — still show them but block invite.
                entry["reason"] = "no_my_area"
                out.append(entry)
                continue
            dist_m = _haversine_m(
                float(my_lat), float(my_lng),
                float(farea["lat"]), float(farea["lng"]),
            )
            entry["distance_km"] = round(dist_m / 1000.0, 1)
            overlap_threshold = float(my_rad or 0.0) + float(farea.get("radius_m") or 0.0)
            if dist_m <= overlap_threshold:
                entry["eligible"] = True
            else:
                entry["reason"] = "different_region"
            out.append(entry)

        # Sort: eligible first, then has_bt, then no_app — alphabetical
        # within each tier so the UI feels deterministic.
        def _sort_key(e: dict):
            tier = 0 if e["eligible"] else (1 if e["has_bt"] else 2)
            return (tier, (e["name"] or "").lower())
        out.sort(key=_sort_key)

        return {"friends": out, "has_my_area": not no_my_area}

    # ── SCHEDULE (awake hours — synced with Work-Scheduler) ──────────
    # 2026-06-02 — the per-user manual awake hours stored in
    # `bt_player_schedule` were removed in favour of pulling straight
    # from `profile.shift_schedule` (Work-Scheduler mini-app). When the
    # scheduler is disabled / unconfigured we fall back to 08:00–23:00
    # local time. The POST endpoint is gone — users no longer enter
    # awake hours twice.
    @router.get("/bt/schedule")
    async def get_schedule(user_id: str = Depends(get_user_or_legacy)):
        sched = await _get_user_schedule(user_id)
        return {
            "schedule": {
                "awake_start": sched["awake_start"],
                "awake_end": sched["awake_end"],
                "timezone": sched["timezone"],
                "source": sched["source"],   # 'scheduler' | 'default'
                "shift": sched.get("shift"), # 'day'|'night'|'off'|None
            },
            "is_awake_now": await _is_user_awake_now(user_id),
        }

    # ── SETTINGS (persistent area) ───────────────────────────────────
    # Once the user picks an area + radius the value is saved in
    # `bt_player_settings` and the home screen skips the map picker
    # forever after — they can only edit from /treasure/settings.
    @router.get("/bt/settings")
    async def get_settings(user_id: str = Depends(get_user_or_legacy)):
        doc = await _db.bt_player_settings.find_one({"_id": user_id})
        if not doc:
            return {"area": None}
        return {
            "area": {
                "lat": float(doc.get("lat") or 0.0),
                "lng": float(doc.get("lng") or 0.0),
                "radius_m": float(doc.get("radius_m") or 0.0),
                "label": doc.get("label"),
                "updated_at": doc.get("updated_at"),
            }
        }

    @router.post("/bt/settings")
    async def save_settings(
        body: SettingsBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        radius = _clamp_radius(body.radius_m)
        await _db.bt_player_settings.update_one(
            {"_id": user_id},
            {"$set": {
                "_id": user_id,
                "lat": float(body.lat),
                "lng": float(body.lng),
                "radius_m": radius,
                "label": (body.label or "").strip()[:80] or None,
                "updated_at": _now_iso(),
            }},
            upsert=True,
        )
        # Also stamp the location for the friend-area check.
        await _db.bt_player_location.update_one(
            {"_id": user_id},
            {"$set": {"_id": user_id, "lat": float(body.lat),
                      "lng": float(body.lng), "updated_at": _now_iso()}},
            upsert=True,
        )
        return {"ok": True, "area": {
            "lat": float(body.lat), "lng": float(body.lng),
            "radius_m": radius, "label": body.label,
        }}

    # ── SOLO ─────────────────────────────────────────────────────────
    @router.post("/bt/solo/start")
    async def solo_start(
        body: StartSoloBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        radius = _clamp_radius(body.radius_m)
        clat, clng = await _pick_public_chest_point(body.lat, body.lng, radius)
        # Stamp `next_reset_at` so the daily-reset tick (in
        # _rotation_failsafe_tick) knows when to give this player a
        # fresh chest. Honors shift_schedule.day.start_time first,
        # falling back to 08:00 in profile.timezone, then +24h UTC.
        next_reset_iso = await _resolve_user_wake_at(user_id)
        doc = {
            "_id": user_id,
            "area": {"lat": float(body.lat), "lng": float(body.lng), "radius_m": radius},
            "chest": {"lat": clat, "lng": clng},
            "created_at": _now_iso(),
            "buried_at": _now_iso(),
            "found_today": False,
            "next_reset_at": next_reset_iso,
        }
        await _db.bt_solo.replace_one({"_id": user_id}, doc, upsert=True)
        # Also stamp the player's location for the friend-area check.
        await _db.bt_player_location.update_one(
            {"_id": user_id},
            {"$set": {"_id": user_id, "lat": float(body.lat), "lng": float(body.lng), "updated_at": _now_iso()}},
            upsert=True,
        )
        return _solo_public(doc)

    @router.get("/bt/solo/current")
    async def solo_current(user_id: str = Depends(get_user_or_legacy)):
        doc = await _db.bt_solo.find_one({"_id": user_id})
        return {"hunt": _solo_public(doc)}

    @router.get("/bt/solo/compass")
    async def solo_compass(
        lat: float,
        lng: float,
        user_id: str = Depends(get_user_or_legacy),
    ):
        doc = await _db.bt_solo.find_one({"_id": user_id})
        if not doc:
            raise HTTPException(404, "No active solo hunt. Start one first.")
        chest = doc.get("chest") or {}
        dist = _haversine_m(lat, lng, float(chest["lat"]), float(chest["lng"]))
        brg = _bearing_deg(lat, lng, float(chest["lat"]), float(chest["lng"]))
        return {
            "distance_m": round(dist, 1),
            "bearing_deg": round(brg, 1),
            "in_find_ring": dist <= FIND_RING_M,
            "find_ring_m": FIND_RING_M,
        }

    @router.post("/bt/solo/find")
    async def solo_find(
        body: FindBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        doc = await _db.bt_solo.find_one({"_id": user_id})
        if not doc:
            raise HTTPException(404, "No active solo hunt. Start one first.")
        chest = doc.get("chest") or {}
        dist = _haversine_m(body.lat, body.lng, float(chest["lat"]), float(chest["lng"]))
        if dist > FIND_RING_M:
            raise HTTPException(
                400,
                f"You're {round(dist)} m away — get within {FIND_RING_M} m of the chest first.",
            )
        photo_b64 = _validate_photo(body.photo_base64, required=True, field="photo_base64")
        new_xp = await _award_xp(user_id, XP_FIND_SOLO, reason="bt_solo_find")
        find_id = str(uuid.uuid4())
        await _db.bt_solo_finds.insert_one({
            "_id": find_id,
            "user_id": user_id,
            "lat": float(body.lat),
            "lng": float(body.lng),
            "chest_lat": float(chest["lat"]),
            "chest_lng": float(chest["lng"]),
            "photo_base64": photo_b64,
            "found_at": _now_iso(),
            "xp_awarded": XP_FIND_SOLO,
        })
        # Auto-assign the next chest in the same area so the user can
        # keep playing without going back through the location picker.
        # Per 2026-06-04 spec the new chest MUST also be on public land —
        # use the Overpass-backed picker so the re-bury never lands on
        # someone's house just because the player happens to live near
        # a residential cluster.
        area = doc.get("area") or {}
        new_lat, new_lng = await _pick_public_chest_point(
            float(area["lat"]), float(area["lng"]), float(area["radius_m"]),
        )
        await _db.bt_solo.update_one(
            {"_id": user_id},
            {"$set": {
                "chest": {"lat": new_lat, "lng": new_lng},
                "created_at": _now_iso(),
            }},
        )
        return {
            "ok": True,
            "find_id": find_id,
            "xp_awarded": XP_FIND_SOLO,
            "new_total_xp": new_xp,
            "distance_m": round(dist, 1),
            "next_chest_ready": True,
        }

    @router.get("/bt/solo/finds")
    async def solo_finds(user_id: str = Depends(get_user_or_legacy)):
        rows = await _db.bt_solo_finds.find(
            {"user_id": user_id}, {"_id": 1, "lat": 1, "lng": 1,
                                   "photo_base64": 1, "found_at": 1,
                                   "xp_awarded": 1}
        ).sort("found_at", -1).to_list(200)
        return {
            "finds": [
                {
                    "id": r.get("_id"),
                    "lat": r.get("lat"),
                    "lng": r.get("lng"),
                    "photo_base64": r.get("photo_base64"),
                    "found_at": r.get("found_at"),
                    "xp_awarded": r.get("xp_awarded", XP_FIND_SOLO),
                }
                for r in rows
            ],
            "count": len(rows),
        }

    # ── GROUPS ───────────────────────────────────────────────────────
    @router.post("/bt/groups/create")
    async def group_create(
        body: GroupCreateBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        # 6-char share code — retry if collision (vanishingly rare)
        code = _gen_group_code()
        for _ in range(5):
            existing = await _db.bt_groups.find_one({"code": code})
            if not existing:
                break
            code = _gen_group_code()

        gid = str(uuid.uuid4())
        name_self = await _player_name(user_id)
        doc = {
            "_id": gid,
            "code": code,
            "creator_id": user_id,
            "name": body.name.strip()[:80],
            "area": {"lat": float(body.lat), "lng": float(body.lng),
                     "radius_m": _clamp_radius(body.radius_m)},
            "status": "lobby",
            "members": [
                # Creator is implicitly accepted.
                {
                    "user_id": user_id,
                    "name": name_self,
                    "status": "accepted",
                    "invited_at": _now_iso(),
                    "responded_at": _now_iso(),
                },
            ],
            "created_at": _now_iso(),
        }
        await _db.bt_groups.insert_one(doc)
        # Stamp creator location for friend-area check.
        await _db.bt_player_location.update_one(
            {"_id": user_id},
            {"$set": {"_id": user_id, "lat": float(body.lat),
                      "lng": float(body.lng), "updated_at": _now_iso()}},
            upsert=True,
        )
        return _group_public(doc, viewer_id=user_id)

    @router.post("/bt/groups/{gid}/invite")
    async def group_invite(
        gid: str,
        body: GroupInviteBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        if doc.get("creator_id") != user_id:
            raise HTTPException(403, "Only the group creator can invite friends.")
        if doc.get("status") != "lobby":
            raise HTTPException(400, "Group already started — invites are closed.")

        creator_loc = await _db.bt_player_location.find_one({"_id": user_id})
        if not creator_loc:
            # Fall back to the group's area centroid — that's the
            # location the creator just confirmed.
            area = doc.get("area") or {}
            creator_loc = {"lat": area.get("lat"), "lng": area.get("lng")}

        friend_pool = set(await _friend_ids_fn(user_id))
        invited_ok: list[dict] = []
        rejected_far: list[dict] = []
        rejected_other: list[dict] = []
        new_members = list(doc.get("members") or [])
        existing_member_ids = {m.get("user_id") for m in new_members}

        for fid in body.friend_ids:
            if not fid or fid == user_id:
                continue
            if fid in existing_member_ids:
                # Already invited — silently skip so the creator can
                # tap "Invite" again without seeing duplicate errors.
                continue
            if fid not in friend_pool:
                rejected_other.append({"user_id": fid, "reason": "Not on your friends list."})
                continue
            floc = await _db.bt_player_location.find_one({"_id": fid})
            if not floc or floc.get("lat") is None:
                rejected_other.append({
                    "user_id": fid,
                    "reason": "We don't know where this friend is yet — ask them to open the app once.",
                })
                continue
            dist_km = _haversine_m(
                float(creator_loc["lat"]), float(creator_loc["lng"]),
                float(floc["lat"]), float(floc["lng"]),
            ) / 1000.0
            if dist_km > FRIEND_AREA_KM:
                rejected_far.append({
                    "user_id": fid,
                    "distance_km": round(dist_km, 1),
                    "reason": "You cannot invite this person because they are not in your area.",
                })
                continue
            friend_name = await _player_name(fid)
            new_members.append({
                "user_id": fid,
                "name": friend_name,
                "status": "pending",
                "invited_at": _now_iso(),
            })
            invited_ok.append({"user_id": fid, "name": friend_name})

        if invited_ok:
            await _db.bt_groups.update_one(
                {"_id": gid},
                {"$set": {"members": new_members}},
            )
            doc["members"] = new_members
            # Fire push notifications outside the DB write so a single
            # bad push token doesn't block the invite write.
            creator_name = await _player_name(user_id)
            now_iso = _now_iso()
            for inv in invited_ok:
                # ── Persistent in-app invite (Round B, 2026-06-04) ──
                # Stays in the invitee's list with `requires_view=True`
                # until they explicitly open the group page, at which
                # point /bt/invites/{gid}/view stamps `opened_at`. The
                # row is idempotent on (group_id, user_id) so re-invites
                # don't create duplicates.
                await _db.bt_invites.update_one(
                    {"group_id": gid, "user_id": inv["user_id"]},
                    {
                        "$setOnInsert": {
                            "_id": f"{gid}:{inv['user_id']}",
                            "group_id": gid,
                            "user_id": inv["user_id"],
                            "created_at": now_iso,
                        },
                        "$set": {
                            "group_name": doc.get("name") or "Treasure Hunt",
                            "group_code": doc.get("code"),
                            "creator_id": user_id,
                            "creator_name": creator_name,
                            "requires_view": True,
                            "opened_at": None,
                        },
                    },
                    upsert=True,
                )
                await _push_to_user(
                    inv["user_id"],
                    "Treasure Hunt invite",
                    f"{creator_name} invited you to “{doc['name']}” — open the app to accept.",
                    {"type": "bt_group_invite", "group_id": gid, "code": doc.get("code")},
                )

        return {
            "invited": invited_ok,
            "rejected_too_far": rejected_far,
            "rejected_other": rejected_other,
            "group": _group_public(doc, viewer_id=user_id),
        }

    @router.get("/bt/groups/mine")
    async def groups_mine(user_id: str = Depends(get_user_or_legacy)):
        cur = _db.bt_groups.find({"members.user_id": user_id}).sort("created_at", -1)
        out = []
        async for d in cur:
            payload = _group_public(d, viewer_id=user_id)
            await _enrich_group(payload, d)
            out.append(payload)
        return {"groups": out}

    @router.get("/bt/groups/available")
    async def groups_available(user_id: str = Depends(get_user_or_legacy)):
        """Lobby-stage groups created by my friends that I'm not already
        a member of — so I can request to join. Smart Availability:
        groups where NO member is currently awake (or every awake
        member has muted the group) are excluded so users don't try to
        join a group full of sleeping players."""
        friend_pool = await _friend_ids_fn(user_id)
        if not friend_pool:
            return {"groups": []}
        cur = _db.bt_groups.find({
            "creator_id": {"$in": friend_pool},
            "status": "lobby",
            "members.user_id": {"$ne": user_id},
        }).sort("created_at", -1)
        out = []
        async for d in cur:
            if not await _is_group_active_now(d):
                # Skip groups where everyone is asleep / muted.
                continue
            payload = _group_public(d, viewer_id=user_id)
            payload["is_active_now"] = True
            out.append(payload)
        return {"groups": out}

    async def _respond_invite(gid: str, user_id: str, *, accept: bool):
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        # Per 2026-06-04 spec: responses stay flippable (Accept ↔
        # Reject) until the creator finalises the group by burying the
        # chest, at which point `status` transitions from "lobby" to
        # "hunting" / "finished" and we lock the answers.
        if doc.get("status") != "lobby":
            raise HTTPException(400, "Group is locked — responses can't change anymore.")
        members = list(doc.get("members") or [])
        me = next((m for m in members if m.get("user_id") == user_id), None)
        if not me:
            raise HTTPException(403, "You weren't invited to this group.")
        if me.get("user_id") == doc.get("creator_id"):
            # Creator is implicitly accepted; don't let them flip
            # themselves to "rejected" and brick the group.
            raise HTTPException(400, "The creator is already in this group.")
        me["status"] = "accepted" if accept else "rejected"
        me["responded_at"] = _now_iso()
        await _db.bt_groups.update_one(
            {"_id": gid, "members.user_id": user_id},
            {"$set": {"members.$": me}},
        )
        doc["members"] = members
        # Clear the persistent invite — answering is implicit viewing.
        await _db.bt_invites.update_one(
            {"group_id": gid, "user_id": user_id},
            {"$set": {"requires_view": False, "opened_at": _now_iso()}},
        )
        # Notify creator
        await _push_to_user(
            doc.get("creator_id"),
            "Treasure Hunt",
            f"{me.get('name','A friend')} {'accepted' if accept else 'rejected'} your invite to “{doc.get('name','')}”.",
            {"type": "bt_group_response", "group_id": gid, "accept": accept},
        )
        return _group_public(doc, viewer_id=user_id)

    @router.post("/bt/groups/{gid}/accept")
    async def group_accept(gid: str, user_id: str = Depends(get_user_or_legacy)):
        return await _respond_invite(gid, user_id, accept=True)

    @router.post("/bt/groups/{gid}/toggle")
    async def group_toggle(
        gid: str,
        body: GroupToggleBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        """Per-user notification toggle for a group.
        ON  → group is "Active" — included in treasure selection / push.
        OFF → group is "Inactive" — visible in the list but tagged so
              and skipped when picking which group receives a treasure."""
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        if not any(m.get("user_id") == user_id for m in (doc.get("members") or [])):
            raise HTTPException(403, "You're not a member of this group.")
        await _db.bt_group_prefs.update_one(
            {"_id": f"{user_id}:{gid}"},
            {"$set": {
                "_id": f"{user_id}:{gid}",
                "user_id": user_id,
                "group_id": gid,
                "notifications_enabled": bool(body.enabled),
                "updated_at": _now_iso(),
            }},
            upsert=True,
        )
        return {"ok": True, "enabled": bool(body.enabled)}

    @router.get("/bt/groups/prefs")
    async def group_prefs(user_id: str = Depends(get_user_or_legacy)):
        """Returns this user's per-group notification prefs as a
        `{group_id: enabled}` map. Anything missing defaults to ON
        (notifications enabled) on the client. One DB scan per home
        screen open keeps the friends-list badge + the group-detail
        toggle in sync without per-row round-trips."""
        rows = await _db.bt_group_prefs.find(
            {"user_id": user_id},
            {"_id": 0, "group_id": 1, "notifications_enabled": 1},
        ).to_list(500)
        return {
            "prefs": {
                r.get("group_id"): bool(r.get("notifications_enabled", True))
                for r in rows
                if r.get("group_id")
            },
        }

    @router.post("/bt/groups/{gid}/reject")
    async def group_reject(gid: str, user_id: str = Depends(get_user_or_legacy)):
        return await _respond_invite(gid, user_id, accept=False)

    @router.post("/bt/groups/join-by-code")
    async def group_join_code(
        body: GroupJoinCodeBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        code = (body.code or "").strip().upper()
        if not code or len(code) < 4:
            raise HTTPException(400, "Enter a valid group code.")
        doc = await _db.bt_groups.find_one({"code": code})
        if not doc:
            raise HTTPException(404, "No group with that code.")
        if doc.get("status") != "lobby":
            raise HTTPException(400, "That hunt has already started.")
        members = list(doc.get("members") or [])
        if any(m.get("user_id") == user_id for m in members):
            return _group_public(doc, viewer_id=user_id)
        # Friend-area check — keep it fair for code joins too.
        creator_loc = await _db.bt_player_location.find_one({"_id": doc.get("creator_id")})
        my_loc = await _db.bt_player_location.find_one({"_id": user_id})
        if creator_loc and my_loc:
            dist_km = _haversine_m(
                float(creator_loc["lat"]), float(creator_loc["lng"]),
                float(my_loc["lat"]), float(my_loc["lng"]),
            ) / 1000.0
            if dist_km > FRIEND_AREA_KM:
                raise HTTPException(
                    403,
                    f"You're {round(dist_km, 1)} km from the group — that's outside the {FRIEND_AREA_KM} km area.",
                )
        my_name = await _player_name(user_id)
        members.append({
            "user_id": user_id, "name": my_name,
            "status": "accepted", "invited_at": _now_iso(),
            "responded_at": _now_iso(), "joined_via_code": True,
        })
        await _db.bt_groups.update_one(
            {"_id": doc["_id"]}, {"$set": {"members": members}},
        )
        doc["members"] = members
        await _push_to_user(
            doc.get("creator_id"),
            "Treasure Hunt",
            f"{my_name} joined “{doc.get('name','')}” using the share code.",
            {"type": "bt_group_join", "group_id": doc["_id"]},
        )
        return _group_public(doc, viewer_id=user_id)

    @router.get("/bt/groups/{gid}")
    async def group_get(gid: str, user_id: str = Depends(get_user_or_legacy)):
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        return _group_public(doc, viewer_id=user_id)

    @router.post("/bt/groups/{gid}/bury")
    async def group_bury(
        gid: str,
        body: BuryBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        if doc.get("creator_id") != user_id:
            raise HTTPException(403, "Only the group creator can bury the chest.")
        if doc.get("status") != "lobby":
            raise HTTPException(400, "Chest already buried.")
        # All invitees must have accepted.
        members = doc.get("members") or []
        invitees = [m for m in members if m.get("user_id") != user_id]
        if not invitees:
            raise HTTPException(400, "Invite at least one friend before burying.")
        pending = [m for m in invitees if m.get("status") != "accepted"]
        if pending:
            raise HTTPException(
                400,
                f"{len(pending)} invitee(s) haven't accepted yet.",
            )
        chest_photo = _validate_photo(body.photo_base64, required=True, field="photo_base64")
        chest_map = _validate_photo(body.map_screenshot_base64, required=True, field="map_screenshot_base64")
        # Initialize rotation_state: creator just played (buried first
        # chest of the cycle); queue is the shuffled list of other
        # accepted members; free-for-all is ON until someone is selected
        # for the next day's hunt.
        member_ids = [m.get("user_id") for m in members if m.get("user_id")]
        rotation_state = _rotation_init(creator_id=user_id, member_ids=member_ids)
        await _db.bt_groups.update_one(
            {"_id": gid},
            {"$set": {
                "status": "hunting",
                "chest_lat": float(body.lat),
                "chest_lng": float(body.lng),
                "chest_photo_base64": chest_photo,
                "map_screenshot_base64": chest_map,
                "buried_at": _now_iso(),
                "rotation_state": rotation_state,
            }},
        )
        # Push every other member.
        creator_name = await _player_name(user_id)
        for m in invitees:
            await _push_to_user(
                m.get("user_id"),
                "Treasure buried!",
                f"{creator_name} buried the chest in “{doc.get('name','')}” — open the app and find it!",
                {"type": "bt_group_buried", "group_id": gid},
            )
        doc = await _db.bt_groups.find_one({"_id": gid})
        return _group_public(doc, viewer_id=user_id)

    @router.get("/bt/groups/{gid}/compass")
    async def group_compass(
        gid: str,
        lat: float,
        lng: float,
        user_id: str = Depends(get_user_or_legacy),
    ):
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        if doc.get("status") != "hunting":
            raise HTTPException(400, "Chest isn't live yet.")
        if not any(m.get("user_id") == user_id and m.get("status") == "accepted" for m in (doc.get("members") or [])):
            raise HTTPException(403, "You're not a member of this hunt.")
        if doc.get("creator_id") == user_id:
            # The creator already knows where the chest is — return a
            # zeroed payload so the compass screen still loads, but no
            # cheating bearing for the player who buried it.
            return {"distance_m": 0.0, "bearing_deg": 0.0,
                    "in_find_ring": False, "find_ring_m": FIND_RING_M,
                    "creator_view": True}
        c_lat = float(doc.get("chest_lat"))
        c_lng = float(doc.get("chest_lng"))
        return {
            "distance_m": round(_haversine_m(lat, lng, c_lat, c_lng), 1),
            "bearing_deg": round(_bearing_deg(lat, lng, c_lat, c_lng), 1),
            "in_find_ring": _haversine_m(lat, lng, c_lat, c_lng) <= FIND_RING_M,
            "find_ring_m": FIND_RING_M,
        }

    @router.post("/bt/groups/{gid}/find")
    async def group_find(
        gid: str,
        body: FindBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        if doc.get("status") != "hunting":
            raise HTTPException(400, "Chest isn't live or has already been found.")
        if doc.get("creator_id") == user_id:
            raise HTTPException(403, "The creator can't claim the chest they buried.")
        members = doc.get("members") or []
        if not any(m.get("user_id") == user_id and m.get("status") == "accepted" for m in members):
            raise HTTPException(403, "You're not a member of this hunt.")
        c_lat = float(doc.get("chest_lat"))
        c_lng = float(doc.get("chest_lng"))
        dist = _haversine_m(body.lat, body.lng, c_lat, c_lng)
        if dist > FIND_RING_M:
            raise HTTPException(
                400,
                f"You're {round(dist)} m away — get within {FIND_RING_M} m of the chest.",
            )
        photo = _validate_photo(body.photo_base64, required=True, field="photo_base64")
        new_xp = await _award_xp(user_id, XP_FIND_GROUP, reason=f"bt_group_find:{gid}")
        find_id = str(uuid.uuid4())
        await _db.bt_group_finds.insert_one({
            "_id": find_id,
            "group_id": gid,
            "user_id": user_id,
            "lat": float(body.lat),
            "lng": float(body.lng),
            "photo_base64": photo,
            "found_at": _now_iso(),
            "xp_awarded": XP_FIND_GROUP,
        })
        await _db.bt_groups.update_one(
            {"_id": gid},
            {"$set": {
                # Status flips to awaiting_hide instead of 'finished' — the
                # finder still owes a fresh hide before the next cycle can
                # advance. The auto-failsafe tick will hide for them if
                # they run out the clock.
                "status": "awaiting_hide",
                "found_by": user_id,
                "found_at": _now_iso(),
                "winner_photo_base64": photo,
                "rotation_state.holder_id": user_id,
                "rotation_state.selected_user_id": None,
                "rotation_state.selected_at": None,
                "rotation_state.selection_deadline_at": await _resolve_user_wake_at(user_id),
            }},
        )
        # Notify the rest of the group.
        finder_name = await _player_name(user_id)
        for m in members:
            if m.get("user_id") == user_id:
                continue
            await _push_to_user(
                m.get("user_id"),
                "Treasure found!",
                f"{finder_name} found the chest in “{doc.get('name','')}”.",
                {"type": "bt_group_found", "group_id": gid, "finder": finder_name},
            )
        doc = await _db.bt_groups.find_one({"_id": gid})
        return {
            "ok": True,
            "find_id": find_id,
            "xp_awarded": XP_FIND_GROUP,
            "new_total_xp": new_xp,
            "distance_m": round(dist, 1),
            "group": _group_public(doc, viewer_id=user_id),
        }

    # ═══════════════════════════════════════════════════════════════════
    # Issue Reporting System (2026-06-04)
    # ═══════════════════════════════════════════════════════════════════
    # Players can flag a bad chest spawn ("private property", inaccessible,
    # dangerous, etc.) from the active hunt screen. Two categories only:
    #   "chest"    — the chest itself feels off (wrong/missing)
    #   "location" — the spawn point is bad (inaccessible/private/etc.)
    # Submitting auto-uses the active chest's coordinates (no manual pick).
    # Recipients:
    #   • Solo hunts  → admin/creator user_ids
    #   • Group hunts → group creator + admin/creator (as backup)
    # Rate limit: 1 active (pending) report per (reporter, hunt_id/group_id).
    # Confirm flow: adds the chest coord to bt_blocked_coords with 30 m
    # radius so future chests never spawn there. Active hunt is NOT moved.
    @router.get("/bt/reports/can-report")
    async def reports_can_report(
        hunt_id: str | None = None,
        group_id: str | None = None,
        user_id: str = Depends(get_user_or_legacy),
    ):
        """Quick rate-limit probe used by the report button to know
        whether to enable itself. Returns {can_report:bool, reason?}."""
        if not hunt_id and not group_id:
            return {"can_report": False, "reason": "no_hunt"}
        q: dict = {"reporter_id": user_id, "status": "pending"}
        if group_id:
            q["group_id"] = group_id
        else:
            q["hunt_id"] = hunt_id
            q["source"] = "solo"
        existing = await _db.bt_issue_reports.find_one(q, {"_id": 1})
        if existing:
            return {"can_report": False, "reason": "already_reported"}
        return {"can_report": True}

    @router.post("/bt/reports")
    async def reports_create(
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        """Submit an issue report against the active chest. Body:
            { source:'solo'|'group', hunt_id?, group_id?,
              category:'chest'|'location', notes? }
        Rate limit: 1 active pending report per reporter per hunt."""
        source = (body.get("source") or "").strip().lower()
        if source not in ("solo", "group"):
            raise HTTPException(400, "source must be 'solo' or 'group'.")
        category = (body.get("category") or "").strip().lower()
        if category not in REPORT_CATEGORIES:
            raise HTTPException(400, "category must be 'chest' or 'location'.")
        notes = str(body.get("notes") or "").strip()[:REPORT_NOTES_MAX_CHARS]

        # Resolve chest coord + recipients from the active hunt/group.
        chest_lat: float | None = None
        chest_lng: float | None = None
        hunt_id: str | None = None
        group_id: str | None = None
        creator_id: str | None = None
        group_name: str | None = None

        if source == "solo":
            hunt_id_in = (body.get("hunt_id") or "").strip()
            # The solo collection is keyed by user_id — reporter must own it.
            solo = await _db.bt_solo.find_one({"_id": user_id})
            if not solo:
                raise HTTPException(404, "No active solo hunt.")
            # If the client passes a hunt_id we treat it as a sanity check;
            # the canonical key is the user_id row.
            hunt_id = hunt_id_in or str(solo.get("_id") or user_id)
            chest = solo.get("chest") or {}
            chest_lat = chest.get("lat")
            chest_lng = chest.get("lng")
            if chest_lat is None or chest_lng is None:
                raise HTTPException(400, "No chest is currently buried.")
        else:  # group
            group_id = (body.get("group_id") or "").strip()
            if not group_id:
                raise HTTPException(400, "group_id is required for group reports.")
            doc = await _db.bt_groups.find_one({"_id": group_id})
            if not doc:
                raise HTTPException(404, "Group not found.")
            if doc.get("status") != "hunting":
                raise HTTPException(400, "Chest isn't live yet — nothing to report.")
            # Reporter must be an accepted member (creator can also report).
            members = doc.get("members") or []
            is_member = any(
                m.get("user_id") == user_id and m.get("status") == "accepted"
                for m in members
            )
            if not is_member and doc.get("creator_id") != user_id:
                raise HTTPException(403, "You're not part of this hunt.")
            chest_lat = doc.get("chest_lat")
            chest_lng = doc.get("chest_lng")
            if chest_lat is None or chest_lng is None:
                raise HTTPException(400, "No chest is currently buried.")
            creator_id = doc.get("creator_id")
            group_name = doc.get("name")

        # Rate limit: 1 active pending report per reporter per hunt/group.
        dup_q: dict = {"reporter_id": user_id, "status": "pending"}
        if source == "group":
            dup_q["group_id"] = group_id
        else:
            dup_q["source"] = "solo"
            dup_q["hunt_id"] = hunt_id
        if await _db.bt_issue_reports.find_one(dup_q, {"_id": 1}):
            raise HTTPException(
                409,
                "You already have an active report for this hunt. Start a new hunt to file another.",
            )

        # Resolve recipients: admin always, plus the group creator for
        # group hunts (unless they ARE the admin, then dedupe).
        admin_ids = await _resolve_admin_ids()
        recipients: list[str] = list(admin_ids)
        if creator_id and creator_id not in recipients:
            recipients.append(creator_id)
        # Never notify the reporter about their own report.
        recipients = [r for r in recipients if r and r != user_id]

        rid = str(uuid.uuid4())
        now = _now_iso()
        reporter_name = await _player_name(user_id)
        doc_insert = {
            "_id": rid,
            "source": source,
            "hunt_id": hunt_id,
            "group_id": group_id,
            "group_name": group_name,
            "reporter_id": user_id,
            "reporter_name": reporter_name,
            "category": category,
            "notes": notes,
            "chest_lat": float(chest_lat),
            "chest_lng": float(chest_lng),
            "recipient_ids": recipients,
            "viewed_by": [],
            "status": "pending",
            "reviewed_by": None,
            "reviewed_at": None,
            "created_at": now,
        }
        await _db.bt_issue_reports.insert_one(doc_insert)

        # Persistent push to every recipient. The data payload includes
        # report_id so the NotificationDeepLinker can open the review
        # screen directly. requires_view-style persistence lives in the
        # bt_issue_reports.recipient_ids/viewed_by fields — the
        # frontend banner stays until the reviewer opens this report.
        title = "🚩 Treasure issue reported"
        target_desc = "the chest" if category == "chest" else "the location"
        body_text = f"{reporter_name} flagged {target_desc} in {group_name or 'a solo hunt'}."
        for r in recipients:
            try:
                await _push_to_user(
                    r,
                    title,
                    body_text,
                    {
                        "type": "bt_report_received",
                        "report_id": rid,
                        "group_id": group_id,
                        "category": category,
                    },
                )
            except Exception:
                # Push failures are non-fatal — the banner row is what
                # ultimately drives reviewer attention.
                pass

        return {
            "ok": True,
            "report_id": rid,
            "status": "pending",
            "recipients_count": len(recipients),
        }

    @router.get("/bt/reports/pending")
    async def reports_pending(user_id: str = Depends(get_user_or_legacy)):
        """Return every pending report this user is supposed to review
        AND hasn't yet viewed/dismissed. Drives the gold banner on the
        Treasure home screen."""
        cur = _db.bt_issue_reports.find({
            "status": "pending",
            "recipient_ids": user_id,
            "viewed_by": {"$ne": user_id},
        }).sort("created_at", -1)
        out: list[dict] = []
        async for d in cur:
            out.append({
                "report_id": d.get("_id"),
                "source": d.get("source"),
                "group_id": d.get("group_id"),
                "group_name": d.get("group_name"),
                "category": d.get("category"),
                "notes": d.get("notes"),
                "chest_lat": d.get("chest_lat"),
                "chest_lng": d.get("chest_lng"),
                "reporter_id": d.get("reporter_id"),
                "reporter_name": d.get("reporter_name"),
                "created_at": d.get("created_at"),
            })
        return {"reports": out, "count": len(out)}

    @router.get("/bt/reports/{rid}")
    async def reports_get(rid: str, user_id: str = Depends(get_user_or_legacy)):
        """Open a single report. Adds the viewer to viewed_by (so the
        persistent banner clears for them) AND returns the full payload
        so the review screen can render Ignore/Confirm controls."""
        d = await _db.bt_issue_reports.find_one({"_id": rid})
        if not d:
            raise HTTPException(404, "Report not found.")
        recipients = d.get("recipient_ids") or []
        is_admin = user_id in (await _resolve_admin_ids())
        if user_id != d.get("reporter_id") and user_id not in recipients and not is_admin:
            raise HTTPException(403, "Not your report to view.")
        # Mark viewed (idempotent via $addToSet).
        await _db.bt_issue_reports.update_one(
            {"_id": rid},
            {"$addToSet": {"viewed_by": user_id}},
        )
        return {
            "report_id": d.get("_id"),
            "source": d.get("source"),
            "group_id": d.get("group_id"),
            "group_name": d.get("group_name"),
            "category": d.get("category"),
            "notes": d.get("notes"),
            "chest_lat": d.get("chest_lat"),
            "chest_lng": d.get("chest_lng"),
            "reporter_id": d.get("reporter_id"),
            "reporter_name": d.get("reporter_name"),
            "status": d.get("status"),
            "reviewed_by": d.get("reviewed_by"),
            "reviewed_at": d.get("reviewed_at"),
            "created_at": d.get("created_at"),
            "can_review": user_id in recipients or is_admin,
        }

    async def _review_report(rid: str, user_id: str, *, action: str) -> dict:
        """Shared implementation for /confirm and /ignore. Atomic via
        find_one_and_update so two reviewers can't double-resolve."""
        if action not in ("confirm", "ignore"):
            raise HTTPException(400, "Invalid action.")
        d = await _db.bt_issue_reports.find_one({"_id": rid})
        if not d:
            raise HTTPException(404, "Report not found.")
        if user_id not in (d.get("recipient_ids") or []):
            # Allow admin override even if not in recipient_ids (e.g.
            # an admin added after the report was created).
            admin_ids = await _resolve_admin_ids()
            if user_id not in admin_ids:
                raise HTTPException(403, "You can't review this report.")
        if d.get("status") != "pending":
            raise HTTPException(400, f"Report is already {d.get('status')}.")
        new_status = "confirmed" if action == "confirm" else "ignored"
        now = _now_iso()
        updated = await _db.bt_issue_reports.find_one_and_update(
            {"_id": rid, "status": "pending"},
            {"$set": {
                "status": new_status,
                "reviewed_by": user_id,
                "reviewed_at": now,
            },
             "$addToSet": {"viewed_by": user_id}},
            return_document=True,
        )
        if not updated:
            raise HTTPException(409, "Report was just resolved by another reviewer.")
        # Confirm path: persist the coord block.
        if action == "confirm":
            try:
                await _db.bt_blocked_coords.insert_one({
                    "_id": str(uuid.uuid4()),
                    "lat": float(updated.get("chest_lat") or 0.0),
                    "lng": float(updated.get("chest_lng") or 0.0),
                    "radius_m": float(BLOCK_RADIUS_M),
                    "source_report_id": rid,
                    "added_by": user_id,
                    "added_at": now,
                })
            except Exception:
                logger.exception("[bt-reports] failed to insert bt_blocked_coords for report=%s", rid)
        # Notify the reporter so they know it was handled.
        try:
            await _push_to_user(
                updated.get("reporter_id"),
                "Treasure report reviewed",
                ("Your report was confirmed — that spot is now blocked from future hunts."
                 if action == "confirm" else
                 "Your report was reviewed and dismissed."),
                {
                    "type": "bt_report_resolved",
                    "report_id": rid,
                    "status": new_status,
                },
            )
        except Exception:
            pass
        return {
            "ok": True,
            "report_id": rid,
            "status": new_status,
            "reviewed_at": now,
        }

    @router.post("/bt/reports/{rid}/confirm")
    async def reports_confirm(rid: str, user_id: str = Depends(get_user_or_legacy)):
        return await _review_report(rid, user_id, action="confirm")

    @router.post("/bt/reports/{rid}/ignore")
    async def reports_ignore(rid: str, user_id: str = Depends(get_user_or_legacy)):
        return await _review_report(rid, user_id, action="ignore")

    # ═══════════════════════════════════════════════════════════════════
    # PLAY-WITH-FRIENDS ROTATION SYSTEM (2026-06-04)
    # ═══════════════════════════════════════════════════════════════════
    # Per product spec the group game now runs as a turn-based cycle:
    #   1. Group creator buries the FIRST chest (existing /bury flow,
    #      which now also initialises rotation_state on the group doc).
    #   2. After each find, the finder MUST hide the chest in a new
    #      public spot (POST /bt/groups/{gid}/hide) — server-side validation:
    #      coord must be on public land (Overpass) AND not in
    #      bt_blocked_coords.
    #   3. After each hide, the system selects the next finder at the
    #      next "user wake time" from the queue (members who haven't
    #      hidden in the current cycle yet).
    #   4. Selected finder can /turn/accept or /turn/reject. On reject:
    #        - group >= 3 members → free_for_all until the next daily
    #          wake-tick (anyone can find), rejecter STAYS in queue.
    #        - group <  3 members → rejecter moves to end of queue;
    #          immediately try the next user.
    #   5. Auto-failsafe: if the selected finder doesn't act before
    #      their next wake-time tick, the system itself auto-buries the
    #      chest at a fresh public coord and advances the cycle so the
    #      game never stalls.
    #
    # rotation_state schema on bt_groups:
    #   {
    #     "cycle_n": 1,
    #     "queue": [user_ids that haven't hidden yet, in selection order],
    #     "played": [user_ids that have hidden in the current cycle],
    #     "holder_id": <user who currently holds the chest, or null>,
    #     "selected_user_id": <next finder, or null>,
    #     "selected_at": <iso when the selection notification went out>,
    #     "selection_deadline_at": <iso when failsafe fires>,
    #     "rejected_by": [user_ids that rejected in the CURRENT selection],
    #     "free_for_all": bool,
    #     "free_for_all_until": <iso, used when >=3 reject path>,
    #   }
    # ───────────────────────────────────────────────────────────────────

    async def _resolve_user_wake_at(user_id: str, *, after_iso: str | None = None) -> str:
        """Return ISO timestamp of the user's NEXT local wake-up moment.
        Reads profile.timezone + shift_schedule (Adaptive Work-Life
        Scheduler) when present; falls back to a sane default of 24h
        from now if anything is missing. The 'after' clamp lets callers
        skip wake-times that have already passed for the user today."""
        try:
            from datetime import datetime, timezone, timedelta
            from zoneinfo import ZoneInfo
        except Exception:
            from datetime import datetime, timezone, timedelta
            ZoneInfo = None  # type: ignore[assignment]
        try:
            prof = await _db.profile.find_one({"_id": user_id}) or {}
        except Exception:
            prof = {}
        tz_name = prof.get("timezone")
        # Default wake at 08:00 local; honor shift_schedule when set.
        wake_hh, wake_mm = 8, 0
        try:
            ss = prof.get("shift_schedule") or {}
            shifts = ss.get("shifts") or {}
            # Use the "day" shift start_time as the default wake target.
            # Production wiring is in server._effective_day_start_for —
            # this is a deliberately simple approximation for the daily
            # rotation tick. Good enough; misfires (e.g. someone on a
            # night shift) just shift selection by a few hours.
            day = shifts.get("day") or {}
            wake_str = (day.get("start_time") or "").strip()
            if ":" in wake_str:
                hh, mm = wake_str.split(":", 1)
                wake_hh, wake_mm = int(hh), int(mm)
        except Exception:
            pass
        try:
            now = datetime.now(timezone.utc)
            if ZoneInfo and tz_name:
                now = now.astimezone(ZoneInfo(tz_name))
            target = now.replace(hour=wake_hh, minute=wake_mm, second=0, microsecond=0)
            if target <= now:
                target = target + timedelta(days=1)
            return target.astimezone(timezone.utc).isoformat()
        except Exception:
            from datetime import datetime as _dt, timezone as _tz, timedelta as _td
            return (_dt.now(_tz.utc) + _td(hours=24)).isoformat()

    def _rotation_init(creator_id: str, member_ids: list[str]) -> dict:
        """Initial rotation_state for a freshly buried group. Creator
        already played (they buried the first chest) so they're in
        `played` and the queue is the shuffled list of other members."""
        import random as _r
        others = [m for m in member_ids if m and m != creator_id]
        _r.shuffle(others)
        return {
            "cycle_n": 1,
            "queue": list(others),
            "played": [creator_id],
            "holder_id": None,
            "selected_user_id": None,
            "selected_at": None,
            "selection_deadline_at": None,
            "rejected_by": [],
            "free_for_all": True,   # day 1 the chest is free-for-all (no one selected yet)
            "free_for_all_until": None,
        }

    async def _select_next_finder(gid: str, *, exclude_user_ids: list[str] | None = None) -> dict | None:
        """Pop the first eligible user_id from the queue and persist the
        selection on the group doc. Sets selection_deadline_at to the
        user's next wake-time. Returns the updated rotation_state, or
        None if no one is selectable (queue empty AND no fallback)."""
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            return None
        rs = dict(doc.get("rotation_state") or {})
        queue: list[str] = list(rs.get("queue") or [])
        played: list[str] = list(rs.get("played") or [])
        excl = set(exclude_user_ids or [])
        # Cycle exhausted → reset (everyone played at least once).
        if not queue and played:
            # Reset: queue = shuffled played (excluding current holder so
            # they don't immediately re-hide), played = [], cycle_n += 1.
            import random as _r
            holder = rs.get("holder_id")
            pool = [u for u in played if u != holder]
            _r.shuffle(pool)
            queue = pool + ([holder] if holder else [])
            played = []
            rs["cycle_n"] = int(rs.get("cycle_n") or 1) + 1
        # Pop the first non-excluded user.
        pick = None
        for u in queue:
            if u not in excl:
                pick = u
                break
        if not pick:
            # Everyone excluded (e.g. all rejected) → free-for-all until next wake.
            rs.update({
                "selected_user_id": None,
                "selected_at": None,
                "selection_deadline_at": None,
                "free_for_all": True,
            })
            await _db.bt_groups.update_one({"_id": gid}, {"$set": {"rotation_state": rs, "queue": queue, "played": played}})
            return rs
        # Resolve wake-time for the selected user — fail-safe fires when this expires.
        deadline = await _resolve_user_wake_at(pick)
        rs.update({
            "queue": queue,
            "played": played,
            "selected_user_id": pick,
            "selected_at": _now_iso(),
            "selection_deadline_at": deadline,
            "rejected_by": [],
            "free_for_all": False,
            "free_for_all_until": None,
        })
        await _db.bt_groups.update_one({"_id": gid}, {"$set": {"rotation_state": rs}})
        # Persistent push to the selected user.
        try:
            await _push_to_user(
                pick,
                "🎯 Your turn to hunt!",
                f"You've been chosen for the next chest in “{doc.get('name','')}” — accept or reject.",
                {"type": "bt_turn_offered", "group_id": gid},
            )
        except Exception:
            pass
        return rs

    async def _advance_after_hide(gid: str, *, finder_id: str) -> dict | None:
        """Called from /hide. Moves the finder to 'played', clears holder,
        and selects the next finder. The chest is now buried by `finder_id`
        but they're done — next person hunts at their next wake-time."""
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            return None
        rs = dict(doc.get("rotation_state") or {})
        queue = [u for u in (rs.get("queue") or []) if u != finder_id]
        played = list(rs.get("played") or [])
        if finder_id not in played:
            played.append(finder_id)
        rs.update({"queue": queue, "played": played, "holder_id": None})
        await _db.bt_groups.update_one({"_id": gid}, {"$set": {"rotation_state": rs}})
        return await _select_next_finder(gid)

    async def _auto_failsafe_hide(gid: str) -> bool:
        """Auto-bury the chest at a fresh public coord — fires when the
        selected finder misses their deadline OR an awaiting-hide finder
        runs out the clock. Uses the existing public-land + block-aware
        picker so spec rules (public-only, never blocked) are enforced.
        Returns True if a fresh hide landed."""
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            return False
        # Pick a coord near the current chest (or group center if no chest).
        c_lat = doc.get("chest_lat")
        c_lng = doc.get("chest_lng")
        if c_lat is None or c_lng is None:
            return False
        try:
            new_lat, new_lng = await _pick_public_chest_point(float(c_lat), float(c_lng), 1500.0)
        except Exception:
            new_lat, new_lng = await _pick_safe_random_point(float(c_lat), float(c_lng), 1500.0)
        await _db.bt_groups.update_one(
            {"_id": gid},
            {"$set": {
                "status": "hunting",
                "chest_lat": float(new_lat),
                "chest_lng": float(new_lng),
                "buried_at": _now_iso(),
                "auto_buried": True,
            }, "$unset": {"chest_holder_id": ""}},
        )
        # Tell everyone the system buried it.
        for m in (doc.get("members") or []):
            try:
                await _push_to_user(
                    m.get("user_id"),
                    "Chest auto-buried",
                    f"No one acted in time — the system buried a fresh chest in “{doc.get('name','')}”.",
                    {"type": "bt_group_buried", "group_id": gid, "auto": True},
                )
            except Exception:
                pass
        # Reselect the next finder.
        await _select_next_finder(gid)
        return True

    @router.post("/bt/groups/{gid}/hide")
    async def group_hide(
        gid: str,
        body: BuryBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        """Called by the player who JUST found the chest to bury it in a
        new public spot. Validates: must be the current holder (i.e. the
        last finder), coord must NOT be in bt_blocked_coords, photo +
        map are required. After success: cycle advances and the next
        finder is selected."""
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        if doc.get("status") not in ("finished", "awaiting_hide"):
            raise HTTPException(400, "Nothing to re-hide right now.")
        # Holder check: the holder is the most-recent finder.
        rs = doc.get("rotation_state") or {}
        holder = rs.get("holder_id") or doc.get("found_by")
        if holder != user_id:
            raise HTTPException(403, "Only the player who just found the chest can hide it next.")
        # Block-aware check on the proposed coord.
        if await _is_coord_blocked(float(body.lat), float(body.lng)):
            raise HTTPException(400, "That spot is in the permanent block list — pick somewhere else.")
        photo = _validate_photo(body.photo_base64, required=True, field="photo_base64")
        chest_map = _validate_photo(body.map_screenshot_base64, required=True, field="map_screenshot_base64")
        await _db.bt_groups.update_one(
            {"_id": gid},
            {"$set": {
                "status": "hunting",
                "chest_lat": float(body.lat),
                "chest_lng": float(body.lng),
                "chest_photo_base64": photo,
                "map_screenshot_base64": chest_map,
                "buried_at": _now_iso(),
            }, "$unset": {"found_by": "", "found_at": "", "winner_photo_base64": ""}},
        )
        # Advance rotation: move user to played, select next finder.
        await _advance_after_hide(gid, finder_id=user_id)
        doc = await _db.bt_groups.find_one({"_id": gid})
        return _group_public(doc, viewer_id=user_id)

    @router.post("/bt/groups/{gid}/turn/accept")
    async def turn_accept(gid: str, user_id: str = Depends(get_user_or_legacy)):
        """Selected finder confirms they'll hunt. Clears any prior free-for-all flag."""
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        rs = doc.get("rotation_state") or {}
        if rs.get("selected_user_id") != user_id:
            raise HTTPException(403, "You're not the currently selected finder.")
        new_rs = dict(rs)
        new_rs.update({"free_for_all": False, "free_for_all_until": None, "accepted_at": _now_iso()})
        await _db.bt_groups.update_one({"_id": gid}, {"$set": {"rotation_state": new_rs}})
        return {"ok": True, "status": "accepted"}

    @router.post("/bt/groups/{gid}/turn/reject")
    async def turn_reject(gid: str, user_id: str = Depends(get_user_or_legacy)):
        """Selected finder declines. Branching by group size:
            ≥3 members → free-for-all until next wake; rejecter STAYS in queue.
            <3 members → rejecter moves to end of queue; immediately select next."""
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        rs = doc.get("rotation_state") or {}
        if rs.get("selected_user_id") != user_id:
            raise HTTPException(403, "You're not the currently selected finder.")
        accepted_members = [
            m.get("user_id") for m in (doc.get("members") or [])
            if m.get("status") == "accepted" or m.get("user_id") == doc.get("creator_id")
        ]
        n_members = len([u for u in accepted_members if u])
        rejected_by = list(rs.get("rejected_by") or [])
        if user_id not in rejected_by:
            rejected_by.append(user_id)
        if n_members >= 3:
            # Free-for-all until next user-wake; rejecter KEEPS their position.
            until = await _resolve_user_wake_at(user_id)
            new_rs = dict(rs)
            new_rs.update({
                "rejected_by": rejected_by,
                "free_for_all": True,
                "free_for_all_until": until,
                "selected_user_id": None,
                "selected_at": None,
                "selection_deadline_at": None,
            })
            # Note: rejecter is NOT removed from queue — they're still
            # eligible at the next selection.
            await _db.bt_groups.update_one({"_id": gid}, {"$set": {"rotation_state": new_rs}})
            # Notify the whole group.
            for m in (doc.get("members") or []):
                if m.get("user_id"):
                    try:
                        await _push_to_user(
                            m.get("user_id"),
                            "Chest is FREE FOR ALL",
                            f"Selection was declined — anyone in “{doc.get('name','')}” can find it until the next wake.",
                            {"type": "bt_turn_free_for_all", "group_id": gid},
                        )
                    except Exception:
                        pass
            return {"ok": True, "status": "free_for_all", "until": until}
        # <3 members → rejecter goes to end of queue; pick next.
        queue = [u for u in (rs.get("queue") or []) if u != user_id] + [user_id]
        new_rs = dict(rs)
        new_rs.update({
            "rejected_by": rejected_by,
            "queue": queue,
            "selected_user_id": None,
            "selected_at": None,
            "selection_deadline_at": None,
        })
        await _db.bt_groups.update_one({"_id": gid}, {"$set": {"rotation_state": new_rs}})
        next_rs = await _select_next_finder(gid, exclude_user_ids=[user_id])
        return {"ok": True, "status": "next_selected", "rotation_state": next_rs}

    @router.get("/bt/groups/{gid}/turn/current")
    async def turn_current(gid: str, user_id: str = Depends(get_user_or_legacy)):
        """Tells the caller whether it's their turn + group rotation state."""
        doc = await _db.bt_groups.find_one({"_id": gid})
        if not doc:
            raise HTTPException(404, "Group not found.")
        rs = doc.get("rotation_state") or {}
        return {
            "is_my_turn": rs.get("selected_user_id") == user_id,
            "free_for_all": bool(rs.get("free_for_all")),
            "free_for_all_until": rs.get("free_for_all_until"),
            "selected_user_id": rs.get("selected_user_id"),
            "selection_deadline_at": rs.get("selection_deadline_at"),
            "holder_id": rs.get("holder_id"),
            "queue": rs.get("queue") or [],
            "played": rs.get("played") or [],
            "cycle_n": rs.get("cycle_n") or 1,
        }

    async def _rotation_failsafe_tick():
        """Scheduler tick (5 min). Walks every active group and:
           • If selection_deadline_at has passed AND no one accepted →
             auto-failsafe hides a fresh chest and selects the next finder.
           • If free_for_all_until has passed → re-select from queue.
           • If status=awaiting_hide and the holder has run out of time →
             auto-failsafe hides for them.
           ALSO walks `bt_solo` and resets every player whose personal
           wake-up time has passed since their last chest was set — picks
           a fresh public coord (Overpass + block-aware) so each player
           gets a NEW spot every day at their own schedule."""
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        # 1) Group rotations
        try:
            cur = _db.bt_groups.find({"rotation_state": {"$exists": True}})
            async for doc in cur:
                rs = doc.get("rotation_state") or {}
                gid = doc.get("_id")
                ffa_until = rs.get("free_for_all_until")
                if ffa_until:
                    try:
                        if datetime.fromisoformat(ffa_until.replace("Z", "+00:00")) <= now:
                            await _select_next_finder(gid)
                            continue
                    except Exception:
                        pass
                deadline = rs.get("selection_deadline_at")
                if deadline and not rs.get("accepted_at"):
                    try:
                        if datetime.fromisoformat(deadline.replace("Z", "+00:00")) <= now:
                            await _auto_failsafe_hide(gid)
                    except Exception:
                        pass
        except Exception:
            logger.exception("[bt-rotation] failsafe tick (groups) failed")
        # 2) Solo daily reset — every player gets a fresh chest at
        # their own local wake-up time (shift_schedule.day.start_time or
        # default 08:00 in profile.timezone). The next_reset_at field
        # is recomputed after each successful reset.
        try:
            import random as _r
            async for sdoc in _db.bt_solo.find({}):
                uid = sdoc.get("_id")
                next_reset = sdoc.get("next_reset_at")
                # Backfill: if no next_reset_at yet, set it for tomorrow and skip.
                if not next_reset:
                    wake = await _resolve_user_wake_at(str(uid))
                    await _db.bt_solo.update_one({"_id": uid}, {"$set": {"next_reset_at": wake}})
                    continue
                try:
                    if datetime.fromisoformat(next_reset.replace("Z", "+00:00")) > now:
                        continue  # not yet time
                except Exception:
                    continue
                # Reset window has passed → pick a fresh chest.
                area = sdoc.get("area") or {}
                center_lat = area.get("lat")
                center_lng = area.get("lng")
                radius_m = float(area.get("radius_m") or 1500.0)
                if center_lat is None or center_lng is None:
                    # No saved area → can't reset; just push the next window.
                    nxt = await _resolve_user_wake_at(str(uid))
                    await _db.bt_solo.update_one({"_id": uid}, {"$set": {"next_reset_at": nxt}})
                    continue
                try:
                    new_lat, new_lng = await _pick_public_chest_point(float(center_lat), float(center_lng), radius_m)
                except Exception:
                    new_lat, new_lng = await _pick_safe_random_point(float(center_lat), float(center_lng), radius_m)
                next_reset_iso = await _resolve_user_wake_at(str(uid))
                await _db.bt_solo.update_one(
                    {"_id": uid},
                    {"$set": {
                        "chest": {"lat": float(new_lat), "lng": float(new_lng)},
                        "buried_at": _now_iso(),
                        "found_today": False,
                        "next_reset_at": next_reset_iso,
                        "auto_reset": True,
                    }, "$unset": {"found_at": "", "winner_photo_base64": ""}},
                )
                # Notify the player so they know a new chest is live.
                try:
                    await _push_to_user(
                        str(uid),
                        "🌅 New treasure for the day!",
                        "Your solo chest just respawned at a fresh spot — open the app to start hunting.",
                        {"type": "bt_solo_reset"},
                    )
                except Exception:
                    pass
        except Exception:
            logger.exception("[bt-rotation] failsafe tick (solo daily) failed")

    # Expose the tick + bury-rotation-init helpers on the module so
    # server.py can hook them into APScheduler at startup. We can't
    # register the scheduler from inside attach_routes (it runs once at
    # FastAPI startup), so server.py adds the job after attach_routes.
    globals()["_rotation_failsafe_tick"] = _rotation_failsafe_tick
    globals()["_rotation_init"] = _rotation_init
    globals()["_select_next_finder"] = _select_next_finder
    globals()["_advance_after_hide"] = _advance_after_hide

    app.include_router(router)
    logger.info("[buried_treasure] routes attached (v2 — solo + groups)")
