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


# ─────────────────────────────────────────────────────────────────────
# Init
# ─────────────────────────────────────────────────────────────────────
def init_buried_treasure(
    *,
    db,
    is_admin_user=None,        # kept for backward-compat with server.py wiring
    now_iso,
    admin_emails=None,         # ignored — kept for backward-compat
    send_push,
    friend_ids_fn,
):
    """Wire up the module. Must be called once at server startup BEFORE
    attach_routes()."""
    global _db, _now_iso, _send_push, _friend_ids_fn
    _db = db
    _now_iso = now_iso
    _send_push = send_push
    _friend_ids_fn = friend_ids_fn
    logger.info("[buried_treasure] initialized")


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
    centre. Pulls the spawn ~15 % short of the edge so the chest never
    lands on the boundary line itself."""
    # Square-root keeps the distribution uniform by area.
    r = radius_m * math.sqrt(random.random()) * 0.85
    theta = random.random() * 2 * math.pi
    # 1° latitude  ≈ 111_320 m, longitude scales with cos(lat).
    dlat = (r * math.cos(theta)) / 111_320.0
    dlng = (r * math.sin(theta)) / (111_320.0 * max(0.01, math.cos(math.radians(center_lat))))
    return center_lat + dlat, center_lng + dlng


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


async def _get_user_schedule(user_id: str) -> dict:
    """Return the user's awake-hours doc, falling back to sensible
    defaults when nothing is saved yet. Always non-None."""
    doc = await _db.bt_player_schedule.find_one({"_id": user_id}) or {}
    # Resolve timezone — explicit on schedule wins; profile.timezone
    # is the fallback so existing users get a sane default without
    # having to open the settings screen first.
    tz_name = (doc.get("timezone") or "").strip()
    if not tz_name:
        prof = await _db.profile.find_one({"_id": user_id}, {"_id": 0, "timezone": 1})
        tz_name = ((prof or {}).get("timezone") or "").strip() or "UTC"
    return {
        "user_id": user_id,
        "awake_start": (doc.get("awake_start") or DEFAULT_AWAKE_START),
        "awake_end": (doc.get("awake_end") or DEFAULT_AWAKE_END),
        "sleep_all_day": bool(doc.get("sleep_all_day", False)),
        "timezone": tz_name,
        "updated_at": doc.get("updated_at"),
        "_saved": bool(doc),
    }


async def _is_user_awake_now(user_id: str, *, now_utc: Optional[datetime] = None) -> bool:
    """True iff the user is currently inside their saved awake window.
    Users with no schedule saved default to 08:00–23:00 local time —
    so they're treated as awake during normal daytime hours without
    needing to opt in. `sleep_all_day=True` always returns False."""
    sched = await _get_user_schedule(user_id)
    if sched["sleep_all_day"]:
        return False
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


class ScheduleBody(BaseModel):
    """Awake-hours schedule for Smart Availability Filter.

    awake_start / awake_end are HH:MM strings in the user's local
    timezone. `sleep_all_day=True` ignores both values and locks the
    user out of treasure selection entirely until they turn it off.
    `timezone` is optional — when omitted we fall back to the user's
    profile timezone. Sending it lets the client stamp the device's
    current IANA zone in one call (e.g. via
    `Intl.DateTimeFormat().resolvedOptions().timeZone`).
    """
    awake_start: Optional[str] = None
    awake_end: Optional[str] = None
    sleep_all_day: bool = False
    timezone: Optional[str] = None


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
    # still null-guard for hunts that pre-date this field).
    try:
        c_lat = doc.get("chest_lat")
        c_lng = doc.get("chest_lng")
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

    # ── SCHEDULE (awake hours — Smart Availability Filter) ───────────
    # Storage: bt_player_schedule. Default behaviour (no doc saved):
    # the user is treated as awake 08:00–23:00 local time so the
    # filter never silently locks people out.
    @router.get("/bt/schedule")
    async def get_schedule(user_id: str = Depends(get_user_or_legacy)):
        sched = await _get_user_schedule(user_id)
        return {
            "schedule": {
                "awake_start": sched["awake_start"],
                "awake_end": sched["awake_end"],
                "sleep_all_day": sched["sleep_all_day"],
                "timezone": sched["timezone"],
                "updated_at": sched["updated_at"],
                "is_default": not sched["_saved"],
            },
            "is_awake_now": await _is_user_awake_now(user_id),
        }

    @router.post("/bt/schedule")
    async def save_schedule(
        body: ScheduleBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        # Validate HH:MM — coerce to defaults if user sent garbage so
        # the filter never breaks on bad input.
        start = _parse_hhmm(body.awake_start) or _parse_hhmm(DEFAULT_AWAKE_START) or (8, 0)
        end = _parse_hhmm(body.awake_end) or _parse_hhmm(DEFAULT_AWAKE_END) or (23, 0)
        tz_name = (body.timezone or "").strip()
        # Best-effort timezone validation — fall back silently to the
        # user's profile timezone so we never reject a save.
        if tz_name and ZoneInfo is not None:
            try:
                ZoneInfo(tz_name)
            except Exception:
                tz_name = ""
        update_doc = {
            "_id": user_id,
            "awake_start": _fmt_hhmm(start),
            "awake_end": _fmt_hhmm(end),
            "sleep_all_day": bool(body.sleep_all_day),
            "updated_at": _now_iso(),
        }
        if tz_name:
            update_doc["timezone"] = tz_name
        await _db.bt_player_schedule.update_one(
            {"_id": user_id},
            {"$set": update_doc},
            upsert=True,
        )
        sched = await _get_user_schedule(user_id)
        return {
            "ok": True,
            "schedule": {
                "awake_start": sched["awake_start"],
                "awake_end": sched["awake_end"],
                "sleep_all_day": sched["sleep_all_day"],
                "timezone": sched["timezone"],
                "updated_at": sched["updated_at"],
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
        clat, clng = _random_point_in_circle(body.lat, body.lng, radius)
        doc = {
            "_id": user_id,
            "area": {"lat": float(body.lat), "lng": float(body.lng), "radius_m": radius},
            "chest": {"lat": clat, "lng": clng},
            "created_at": _now_iso(),
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
        area = doc.get("area") or {}
        new_lat, new_lng = _random_point_in_circle(
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
            for inv in invited_ok:
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
        members = list(doc.get("members") or [])
        me = next((m for m in members if m.get("user_id") == user_id), None)
        if not me:
            raise HTTPException(403, "You weren't invited to this group.")
        if me.get("status") not in ("pending",):
            raise HTTPException(400, f"Already responded ({me.get('status')}).")
        me["status"] = "accepted" if accept else "rejected"
        me["responded_at"] = _now_iso()
        await _db.bt_groups.update_one(
            {"_id": gid, "members.user_id": user_id},
            {"$set": {"members.$": me}},
        )
        doc["members"] = members
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
        await _db.bt_groups.update_one(
            {"_id": gid},
            {"$set": {
                "status": "hunting",
                "chest_lat": float(body.lat),
                "chest_lng": float(body.lng),
                "chest_photo_base64": chest_photo,
                "map_screenshot_base64": chest_map,
                "buried_at": _now_iso(),
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
                "status": "finished",
                "found_by": user_id,
                "found_at": _now_iso(),
                "winner_photo_base64": photo,
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

    app.include_router(router)
    logger.info("[buried_treasure] routes attached (v2 — solo + groups)")
