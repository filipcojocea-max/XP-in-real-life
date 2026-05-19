"""
Buried Treasure — daily solo treasure-hunt mini-app (v1.0.29 Phase 1).

Loop:
  1. User confirms their city's coverage circle (lat, lng, radius_m).
  2. Spawner picks a fresh random spawn point each local-day on PUBLIC
     terrain (parks/ovals/recreation grounds) inside the coverage circle.
     Uses OpenStreetMap Overpass API, falls back to a random point inside
     the coverage circle if Overpass fails (best-effort, never blocks).
  3. User opens the Hunt — compass + live distance + tap-to-find when
     they're inside the 5 m AR proximity ring.
  4. Reports (no-go polygons + bug text + optional photo) are DM'd to
     every admin so they can blacklist coordinates.

Endpoints (all under /api):
  GET  /bt/location                    — current saved location (or null)
  POST /bt/location  body {lat, lng, radius_m, label?}
  GET  /bt/chest/today                 — auto-spawns if missing, returns it
  POST /bt/chest/find body {photo_base64?}
  GET  /bt/finds                       — chronological history
  GET  /bt/settings, POST /bt/settings body {daylight_only:bool}
  GET  /bt/no-go-zones
  POST /bt/no-go-zones body {name, polygon:[{lat,lng},...]}
  DELETE /bt/no-go-zones/{zone_id}
  POST /bt/report  body {kind:'location'|'object', message, lat?, lng?, photo_base64?}

Collections:
  bt_locations    {_id:user_id, lat, lng, radius_m, label, updated_at}
  bt_chests       {_id, user_id, date(local YYYY-MM-DD), lat, lng,
                   spawn_source:'osm_park'|'fallback_random',
                   osm_feature_name?, hint, status:'hidden'|'found'|'expired',
                   found_at?, photo_base64?, spawned_at, expires_at}
  bt_finds        {_id, user_id, chest_id, lat, lng, found_at, photo_base64}
  bt_no_go_zones  {_id, user_id, name, polygon:[{lat,lng}], created_at}
  bt_settings     {_id:user_id, daylight_only:bool, updated_at}
  bt_reports      {_id, user_id, kind, message, lat?, lng?,
                   photo_base64?, created_at, sent_to_admin_ids:[...]}
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

logger = logging.getLogger(__name__)

_db = None
_now_iso = None
_is_admin_user = None
_admin_emails_set: set[str] = set()
_send_push = None             # async fn(token, title, body, data) — wired by init
_friend_ids_fn = None         # async fn(user_id) -> list[str] — wired by init
_match_tick_task = None       # asyncio.Task for the 60s match expiry tick

# ── Friends-mode (Relay-Race) tuning ──
MATCH_DURATION_H = 12             # 12 hours after burial → expires
INVITE_EXPIRY_MIN = 30            # Seeker has 30 min to Accept / Reject
MATCH_FIND_RING_M = 12            # same proximity tolerance as solo
XP_FIND_SEEKER = 100              # awarded to seeker on successful find
XP_FIND_HIDER = 50                # awarded to hider on successful find
XP_EXPIRY_HIDER = 50              # awarded to hider when seeker fails to find
PUSH_CH_BT_INVITE = "bt_invite"   # Android channel for sticky-like priority

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT_S = 7.0
MIN_RADIUS_M = 300
MAX_RADIUS_M = 25_000  # ~25 km — large city coverage
DAY_FORMAT = "%Y-%m-%d"

_HINTS = [
    "Try the green spots near the water.",
    "Hidden where children play and dogs run.",
    "Near a tree. Look low, look high.",
    "Where the grass is greener.",
    "A quiet corner of a public space.",
    "Look around the perimeter, not the centre.",
]


def init_buried_treasure(
    *,
    db,
    is_admin_user,
    now_iso,
    admin_emails: list[str] | None = None,
    send_push=None,
    friend_ids_fn=None,
):
    global _db, _now_iso, _is_admin_user, _admin_emails_set
    global _send_push, _friend_ids_fn, _match_tick_task
    _db = db
    _is_admin_user = is_admin_user
    _now_iso = now_iso
    _admin_emails_set = set((admin_emails or []))
    _send_push = send_push
    _friend_ids_fn = friend_ids_fn

    # Boot the 60-s background tick that handles match expiries +
    # invite expiries. We schedule it only once per process even if the
    # init function is called twice (hot reload, tests).
    if _match_tick_task is None or _match_tick_task.done():
        try:
            loop = asyncio.get_event_loop()
            _match_tick_task = loop.create_task(_match_expiry_loop())
            logger.info("[bt-matches] expiry tick started (60s)")
        except RuntimeError:
            # No running loop yet (called before app startup); the
            # scheduler will get created lazily on the first request.
            logger.warning("[bt-matches] no event loop yet; will lazy-start")


# ─────────────────────── geo helpers ───────────────────────
def _haversine_m(lat1, lng1, lat2, lng2) -> float:
    R = 6_371_000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _random_point_in_radius(lat: float, lng: float, radius_m: float) -> tuple[float, float]:
    # Uniformly distributed point inside a circle on Earth.
    u = random.random()
    v = random.random()
    w = radius_m * math.sqrt(u)
    t = 2 * math.pi * v
    dx = w * math.cos(t)
    dy = w * math.sin(t)
    # Convert metres → degrees (small-area approximation).
    dlat = dy / 111_320.0
    dlng = dx / (111_320.0 * math.cos(math.radians(lat)))
    return (lat + dlat, lng + dlng)


def _today_local_str(tz_offset_minutes: int = 0) -> str:
    """Returns local-date string used as the daily-chest scoping key."""
    now = datetime.now(timezone.utc) + timedelta(minutes=tz_offset_minutes)
    return now.strftime(DAY_FORMAT)


# ────────────── OpenStreetMap park sampling ──────────────
async def _osm_sample_park_point(lat: float, lng: float, radius_m: float) -> Optional[dict]:
    """Query Overpass for parks/ovals/recreation areas inside the circle,
    pick one random feature, and return its centroid + name.
    Returns None on any failure — caller falls back."""
    # We constrain the radius to <=10 km for the OSM query to keep the
    # response size manageable. Spawner still uses the full radius via
    # fallback if OSM is silent in this slice.
    osm_r = int(min(radius_m, 10_000))
    query = f"""
    [out:json][timeout:5];
    (
      way["leisure"="park"](around:{osm_r},{lat},{lng});
      way["landuse"="recreation_ground"](around:{osm_r},{lat},{lng});
      way["leisure"="pitch"](around:{osm_r},{lat},{lng});
      way["leisure"="garden"](around:{osm_r},{lat},{lng});
      relation["leisure"="park"](around:{osm_r},{lat},{lng});
    );
    out center 50;
    """
    try:
        async with httpx.AsyncClient(timeout=OVERPASS_TIMEOUT_S) as client:
            r = await client.post(OVERPASS_URL, data={"data": query})
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        logger.warning("[bt-osm] overpass failed: %s", e)
        return None
    elements = data.get("elements") or []
    centers = []
    for el in elements:
        c = el.get("center") if el.get("type") in ("way", "relation") else None
        if not c and el.get("type") == "node":
            c = {"lat": el.get("lat"), "lon": el.get("lon")}
        if not c:
            continue
        if c.get("lat") is None or c.get("lon") is None:
            continue
        # Reject if the centroid is OUTSIDE the coverage circle (Overpass
        # bounding-box can leak just over the edge).
        d = _haversine_m(lat, lng, c["lat"], c["lon"])
        if d > radius_m:
            continue
        centers.append({
            "lat": c["lat"],
            "lng": c["lon"],
            "name": (el.get("tags") or {}).get("name") or "Public green space",
        })
    if not centers:
        return None
    return random.choice(centers)


# ─────────────── spawn / today's chest ───────────────
async def _filter_against_no_go(user_id: str, lat: float, lng: float) -> bool:
    """Returns True if the (lat,lng) is INSIDE any of the caller's no-go
    polygons (and so should be re-spawned)."""
    zones = await _db.bt_no_go_zones.find({"user_id": user_id}).to_list(50)
    for z in zones:
        poly = z.get("polygon") or []
        if len(poly) < 3:
            continue
        if _point_in_polygon(lat, lng, poly):
            return True
    return False


def _point_in_polygon(lat: float, lng: float, poly: list[dict]) -> bool:
    """Ray-casting algorithm. `poly` is a list of {lat,lng} dicts."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]["lng"], poly[i]["lat"]
        xj, yj = poly[j]["lng"], poly[j]["lat"]
        intersect = ((yi > lat) != (yj > lat)) and (
            lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-9) + xi
        )
        if intersect:
            inside = not inside
        j = i
    return inside


async def _spawn_today_for(user_id: str) -> dict:
    loc = await _db.bt_locations.find_one({"_id": user_id})
    if not loc:
        raise HTTPException(400, "Set your hunt area first.")
    settings = await _db.bt_settings.find_one({"_id": user_id}) or {}
    daylight_only = bool(settings.get("daylight_only", False))
    tz_off = int(loc.get("tz_offset_minutes") or 0)
    today = _today_local_str(tz_off)
    existing = await _db.bt_chests.find_one({"user_id": user_id, "date": today})
    if existing:
        return existing
    # Try OSM up to 4 times to find a non-no-go spawn.
    spawn_lat = spawn_lng = None
    feature_name = None
    spawn_source = "fallback_random"
    for _ in range(4):
        sample = await _osm_sample_park_point(loc["lat"], loc["lng"], float(loc["radius_m"]))
        if sample is None:
            break
        if await _filter_against_no_go(user_id, sample["lat"], sample["lng"]):
            continue
        spawn_lat = sample["lat"]
        spawn_lng = sample["lng"]
        feature_name = sample["name"]
        spawn_source = "osm_park"
        break
    # Fallback — random point within radius, avoiding no-go zones.
    if spawn_lat is None:
        for _ in range(10):
            cand_lat, cand_lng = _random_point_in_radius(
                loc["lat"], loc["lng"], float(loc["radius_m"])
            )
            if not await _filter_against_no_go(user_id, cand_lat, cand_lng):
                spawn_lat = cand_lat
                spawn_lng = cand_lng
                break
        if spawn_lat is None:  # All slots in no-go → centre point
            spawn_lat = loc["lat"]
            spawn_lng = loc["lng"]
    # Build expiry — end of local day for now-mode, sunset-ish for
    # daylight_only (approximate: 06:00–19:00 local).
    now_utc = datetime.now(timezone.utc)
    expires_at = (now_utc + timedelta(hours=24)).isoformat()
    chest = {
        "_id": str(uuid.uuid4()),
        "user_id": user_id,
        "date": today,
        "lat": float(spawn_lat),
        "lng": float(spawn_lng),
        "spawn_source": spawn_source,
        "osm_feature_name": feature_name,
        "hint": random.choice(_HINTS),
        "status": "hidden",
        "found_at": None,
        "photo_base64": None,
        "spawned_at": _now_iso(),
        "expires_at": expires_at,
        "daylight_only": daylight_only,
    }
    await _db.bt_chests.insert_one(chest)
    return chest


def _serialize_chest(c: dict) -> dict:
    return {
        "id": c.get("_id"),
        "date": c.get("date"),
        "lat": float(c.get("lat") or 0),
        "lng": float(c.get("lng") or 0),
        "hint": c.get("hint"),
        "spawn_source": c.get("spawn_source"),
        "osm_feature_name": c.get("osm_feature_name"),
        "status": c.get("status"),
        "found_at": c.get("found_at"),
        "spawned_at": c.get("spawned_at"),
        "expires_at": c.get("expires_at"),
        "daylight_only": bool(c.get("daylight_only", False)),
        "has_photo": bool(c.get("photo_base64")),
    }


# ═════════════════════ Friends-Mode (Relay Race) ═════════════════════
#
# A "match" is a 1-on-1 challenge between a Hider and a Seeker. Phase
# transitions (see `state` enum below):
#
#   pending_accept  → Hider invited Seeker. Seeker can Accept or Reject
#                     within 30 min, else state becomes `expired_invite`.
#   awaiting_burial → Seeker accepted. Hider must physically walk to the
#                     spot and call /bury (uses live GPS) to plant.
#   in_progress     → Chest is buried. Seeker has 12 h to find it.
#   found           → Seeker tapped /find inside the 12 m proximity ring.
#                     Awards: Seeker +100 XP, Hider +50 XP.
#   expired         → 12 h passed without a find. Hider wins +50 XP, the
#                     Seeker gets 0.
#   rejected        → Seeker declined the invite.
#   cancelled       → Hider cancelled before chest was buried.
#   expired_invite  → Seeker didn't respond in 30 min.
#
# Persistence: collection `bt_matches`. Auto-posts (when allow_photo_post
# is on) go into `bt_feed_posts`, visible to both players + friends.
async def _push_to_user(user_id: str, title: str, body: str, data: dict | None = None):
    """Best-effort push to ALL of a user's registered Expo tokens.
    Never raises — push failures must never break a match transition.
    """
    if _send_push is None or _db is None:
        return
    try:
        tokens = await _db.push_tokens.find({"user_id": user_id}).to_list(20)
    except Exception:
        logger.exception("[bt-push] token lookup failed")
        return
    for t in tokens or []:
        tok = t.get("token") or ""
        if not tok:
            continue
        try:
            await _send_push(tok, title, body, data or {})
        except Exception:
            logger.warning("[bt-push] send failed for %s", user_id, exc_info=False)


async def _profile_summary(uid: str) -> dict:
    """Lightweight {id,name,avatar_base64} for the match opponent card."""
    if _db is None:
        return {"id": uid, "name": "Player", "avatar_base64": None}
    p = await _db.profile.find_one(
        {"_id": uid}, {"full_name": 1, "name": 1, "avatar_base64": 1}
    ) or {}
    return {
        "id": uid,
        "name": p.get("full_name") or p.get("name") or "Player",
        "avatar_base64": p.get("avatar_base64"),
    }


async def _are_friends(a: str, b: str) -> bool:
    if a == b:
        return False
    if _friend_ids_fn is not None:
        try:
            return b in (await _friend_ids_fn(a))
        except Exception:
            logger.exception("[bt-friends] fn failed; fallback to direct query")
    # Fallback: direct DB query
    if _db is None:
        return False
    fr = await _db.friend_requests.find_one({
        "status": "accepted",
        "$or": [
            {"from_user_id": a, "to_user_id": b},
            {"from_user_id": b, "to_user_id": a},
        ],
    })
    return fr is not None


def _serialize_match(m: dict, viewer_id: str | None = None) -> dict:
    """Strip internal _id, normalise fields. If viewer_id is given, also
    annotate the viewer's role (hider/seeker) for client convenience.
    """
    out = {
        "id": m.get("_id"),
        "hider_id": m.get("hider_id"),
        "seeker_id": m.get("seeker_id"),
        "state": m.get("state"),
        "invited_at": m.get("invited_at"),
        "accepted_at": m.get("accepted_at"),
        "rejected_at": m.get("rejected_at"),
        "cancelled_at": m.get("cancelled_at"),
        "buried_at": m.get("buried_at"),
        "expires_at": m.get("expires_at"),
        "found_at": m.get("found_at"),
        "winner": m.get("winner"),
        "xp_seeker": int(m.get("xp_seeker", 0)),
        "xp_hider": int(m.get("xp_hider", 0)),
        "hint": m.get("hint"),
        "allow_photo_post": bool(m.get("allow_photo_post", False)),
        # Chest coords + photos are only revealed to the seeker AFTER
        # burial (so the hider can't post the answer in the match list).
        # Hider always sees them. After resolution, both see them.
        "lat": None,
        "lng": None,
        "has_chest_photo": bool(m.get("photo_buried_b64")),
        "has_found_photo": bool(m.get("photo_found_b64")),
    }
    state = m.get("state")
    reveal_to_all = state in ("found", "expired")
    if viewer_id == m.get("hider_id") or reveal_to_all or state == "in_progress":
        out["lat"] = m.get("lat")
        out["lng"] = m.get("lng")
    return out


async def _award_xp(user_id: str, amount: int, *, reason: str):
    if _db is None or amount <= 0:
        return
    try:
        await _db.profile.update_one(
            {"_id": user_id}, {"$inc": {"total_xp": int(amount)}}
        )
    except Exception:
        logger.exception("[bt-xp] award failed user=%s reason=%s", user_id, reason)


async def _match_expiry_loop():
    """Background tick — fires every 60 s.

    Two cleanups:
      1. Pending-accept invites older than INVITE_EXPIRY_MIN → expire,
         notify the Hider (state = `expired_invite`).
      2. In-progress matches whose `expires_at` is in the past →
         resolve as Hider-win, award +50 XP, notify both players,
         auto-post to feed if `allow_photo_post` was on.
    """
    while True:
        try:
            await asyncio.sleep(60)
            if _db is None:
                continue
            now_dt = datetime.now(timezone.utc)
            now = now_dt.isoformat()

            # ── (1) 30-min invite expiry ──────────────────────────────
            invite_cutoff = (
                now_dt - timedelta(minutes=INVITE_EXPIRY_MIN)
            ).isoformat()
            cursor = _db.bt_matches.find({
                "state": "pending_accept",
                "invited_at": {"$lt": invite_cutoff},
            })
            async for m in cursor:
                upd = await _db.bt_matches.find_one_and_update(
                    {"_id": m["_id"], "state": "pending_accept"},
                    {"$set": {
                        "state": "expired_invite",
                        "invite_expired_at": now,
                    }},
                    return_document=True,
                )
                if not upd:
                    continue
                try:
                    seeker = await _profile_summary(m["seeker_id"])
                    await _push_to_user(
                        m["hider_id"],
                        "🏴‍☠️ Invite expired",
                        f"{seeker['name']} didn't respond in 30 min.",
                        {"kind": "bt_match_invite_expired",
                         "match_id": m["_id"], "channelId": PUSH_CH_BT_INVITE},
                    )
                except Exception:
                    logger.exception("[bt-tick] invite-expired notify failed")

            # ── (2) 12-h hunt expiry → Hider wins ─────────────────────
            cursor = _db.bt_matches.find({
                "state": "in_progress",
                "expires_at": {"$lte": now},
            })
            async for m in cursor:
                upd = await _db.bt_matches.find_one_and_update(
                    {"_id": m["_id"], "state": "in_progress"},
                    {"$set": {
                        "state": "expired",
                        "winner": "hider",
                        "resolved_at": now,
                        "xp_hider": XP_EXPIRY_HIDER,
                        "xp_seeker": 0,
                    }},
                    return_document=True,
                )
                if not upd:
                    continue
                await _award_xp(m["hider_id"], XP_EXPIRY_HIDER,
                                reason="bt_match_expiry_win")
                try:
                    hider = await _profile_summary(m["hider_id"])
                    seeker = await _profile_summary(m["seeker_id"])
                    await _push_to_user(
                        m["hider_id"],
                        "⏰ Time's up — you win!",
                        f"{seeker['name']} didn't find your chest. +{XP_EXPIRY_HIDER} XP.",
                        {"kind": "bt_match_expired_win",
                         "match_id": m["_id"], "channelId": PUSH_CH_BT_INVITE},
                    )
                    await _push_to_user(
                        m["seeker_id"],
                        "⏰ Hunt expired",
                        f"{hider['name']}'s chest got away. Better luck next round.",
                        {"kind": "bt_match_expired_loss",
                         "match_id": m["_id"], "channelId": PUSH_CH_BT_INVITE},
                    )
                except Exception:
                    logger.exception("[bt-tick] hunt-expired notify failed")

        except asyncio.CancelledError:
            logger.info("[bt-matches] expiry loop cancelled")
            return
        except Exception:
            logger.exception("[bt-matches] tick crashed; sleeping")


# ─────────────────────── routes ───────────────────────
def attach_routes(app, get_user_or_legacy):
    sub = APIRouter(prefix="/api")

    @sub.get("/bt/location")
    async def _loc_get(user_id: str = Depends(get_user_or_legacy)):
        loc = await _db.bt_locations.find_one({"_id": user_id})
        if not loc:
            return {"location": None}
        return {"location": {
            "lat": loc["lat"], "lng": loc["lng"],
            "radius_m": loc["radius_m"], "label": loc.get("label"),
            "updated_at": loc.get("updated_at"),
            "tz_offset_minutes": loc.get("tz_offset_minutes") or 0,
        }}

    @sub.post("/bt/location")
    async def _loc_set(
        body: dict = Body(...), user_id: str = Depends(get_user_or_legacy)
    ):
        try:
            lat = float(body.get("lat"))
            lng = float(body.get("lng"))
            radius = float(body.get("radius_m"))
        except (TypeError, ValueError):
            raise HTTPException(400, "lat, lng, radius_m required (numeric)")
        if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
            raise HTTPException(400, "lat/lng out of range")
        if not (MIN_RADIUS_M <= radius <= MAX_RADIUS_M):
            raise HTTPException(
                400, f"radius_m must be {MIN_RADIUS_M}…{MAX_RADIUS_M}"
            )
        try:
            tz_off = int(body.get("tz_offset_minutes") or 0)
        except (TypeError, ValueError):
            tz_off = 0
        await _db.bt_locations.update_one(
            {"_id": user_id},
            {"$set": {
                "lat": lat, "lng": lng, "radius_m": radius,
                "label": (body.get("label") or "").strip() or None,
                "tz_offset_minutes": tz_off,
                "updated_at": _now_iso(),
            }},
            upsert=True,
        )
        return {"saved": True}

    @sub.get("/bt/chest/today")
    async def _chest_today(user_id: str = Depends(get_user_or_legacy)):
        c = await _spawn_today_for(user_id)
        return {"chest": _serialize_chest(c)}

    @sub.post("/bt/chest/find")
    async def _chest_find(
        body: dict = Body(...), user_id: str = Depends(get_user_or_legacy)
    ):
        loc = await _db.bt_locations.find_one({"_id": user_id})
        if not loc:
            raise HTTPException(400, "Set your hunt area first.")
        tz_off = int(loc.get("tz_offset_minutes") or 0)
        today = _today_local_str(tz_off)
        chest = await _db.bt_chests.find_one({"user_id": user_id, "date": today})
        if not chest:
            raise HTTPException(404, "No chest spawned today.")
        if chest.get("status") == "found":
            return {"chest": _serialize_chest(chest), "already_found": True}
        try:
            here_lat = float(body.get("lat"))
            here_lng = float(body.get("lng"))
        except (TypeError, ValueError):
            raise HTTPException(400, "lat/lng required")
        dist = _haversine_m(chest["lat"], chest["lng"], here_lat, here_lng)
        if dist > 12.0:  # tolerance ~12 m
            raise HTTPException(
                400, f"Still {int(dist)} m away — get closer to the chest."
            )
        photo = (body.get("photo_base64") or "")[:500_000] or None
        now = _now_iso()
        await _db.bt_chests.update_one(
            {"_id": chest["_id"]},
            {"$set": {
                "status": "found", "found_at": now,
                "photo_base64": photo,
            }},
        )
        await _db.bt_finds.insert_one({
            "_id": str(uuid.uuid4()),
            "user_id": user_id,
            "chest_id": chest["_id"],
            "lat": chest["lat"], "lng": chest["lng"],
            "found_at": now,
            "photo_base64": photo,
        })
        # Award a small XP bump on a find.
        try:
            await _db.profile.update_one(
                {"_id": user_id}, {"$inc": {"total_xp": 50}}
            )
        except Exception:
            logger.exception("[bt-find] XP bump failed")
        chest["status"] = "found"
        chest["found_at"] = now
        chest["photo_base64"] = photo
        return {"chest": _serialize_chest(chest), "xp_awarded": 50}

    @sub.get("/bt/finds")
    async def _finds(user_id: str = Depends(get_user_or_legacy)):
        rows = await _db.bt_finds.find({"user_id": user_id}).sort(
            "found_at", -1
        ).to_list(100)
        return {"finds": [{
            "id": r["_id"], "chest_id": r.get("chest_id"),
            "lat": r["lat"], "lng": r["lng"], "found_at": r["found_at"],
            "has_photo": bool(r.get("photo_base64")),
            "photo_base64": r.get("photo_base64"),
        } for r in rows]}

    @sub.get("/bt/settings")
    async def _set_get(user_id: str = Depends(get_user_or_legacy)):
        s = await _db.bt_settings.find_one({"_id": user_id}) or {}
        return {"settings": {"daylight_only": bool(s.get("daylight_only", False))}}

    @sub.post("/bt/settings")
    async def _set_post(
        body: dict = Body(...), user_id: str = Depends(get_user_or_legacy)
    ):
        await _db.bt_settings.update_one(
            {"_id": user_id},
            {"$set": {
                "daylight_only": bool(body.get("daylight_only", False)),
                "updated_at": _now_iso(),
            }},
            upsert=True,
        )
        return {"saved": True}

    @sub.get("/bt/no-go-zones")
    async def _zones_get(user_id: str = Depends(get_user_or_legacy)):
        rows = await _db.bt_no_go_zones.find({"user_id": user_id}).to_list(100)
        return {"zones": [{
            "id": r["_id"], "name": r.get("name") or "No-go zone",
            "polygon": r.get("polygon") or [],
            "created_at": r.get("created_at"),
        } for r in rows]}

    @sub.post("/bt/no-go-zones")
    async def _zones_post(
        body: dict = Body(...), user_id: str = Depends(get_user_or_legacy)
    ):
        name = (body.get("name") or "").strip() or "No-go zone"
        poly = body.get("polygon") or []
        if not isinstance(poly, list) or len(poly) < 3:
            raise HTTPException(400, "polygon must have at least 3 points")
        cleaned = []
        for p in poly:
            try:
                cleaned.append({"lat": float(p["lat"]), "lng": float(p["lng"])})
            except (KeyError, TypeError, ValueError):
                raise HTTPException(400, "polygon points need numeric lat/lng")
        zid = str(uuid.uuid4())
        await _db.bt_no_go_zones.insert_one({
            "_id": zid, "user_id": user_id,
            "name": name, "polygon": cleaned,
            "created_at": _now_iso(),
        })
        return {"id": zid, "created": True}

    @sub.delete("/bt/no-go-zones/{zone_id}")
    async def _zones_del(zone_id: str, user_id: str = Depends(get_user_or_legacy)):
        res = await _db.bt_no_go_zones.delete_one(
            {"_id": zone_id, "user_id": user_id}
        )
        return {"deleted": res.deleted_count}

    @sub.post("/bt/report")
    async def _report(
        body: dict = Body(...), user_id: str = Depends(get_user_or_legacy)
    ):
        kind = (body.get("kind") or "").lower()
        if kind not in ("location", "object"):
            raise HTTPException(400, "kind must be 'location' or 'object'")
        message = (body.get("message") or "").strip()
        if not message and not body.get("photo_base64") and not body.get("lat"):
            raise HTTPException(400, "Include a message, location, or photo.")
        rid = str(uuid.uuid4())
        now = _now_iso()
        rec = {
            "_id": rid, "user_id": user_id, "kind": kind,
            "message": message[:1000],
            "lat": body.get("lat"), "lng": body.get("lng"),
            "photo_base64": (body.get("photo_base64") or "")[:500_000] or None,
            "created_at": now,
        }
        # DM to every admin so they can review + blacklist coordinates.
        sent_ids: list[str] = []
        try:
            cur = _db.users.find(
                {"email": {"$in": list(_admin_emails_set)}}, {"_id": 1}
            )
            async for u in cur:
                aid = u["_id"]
                if aid == user_id:
                    continue
                dm_text = (
                    f"🏴‍☠️ Buried Treasure report ({kind})\n"
                    f"{message[:400]}\n"
                    f"{('📍 ' + str(rec.get('lat')) + ', ' + str(rec.get('lng'))) if rec.get('lat') is not None else ''}"
                ).strip()
                msg = {
                    "id": str(uuid.uuid4()),
                    "thread_id": ":".join(sorted([user_id, aid])),
                    "from_user_id": user_id,
                    "to_user_id": aid,
                    "refined_text": dm_text,
                    "original_text": dm_text,
                    "image_base64": rec.get("photo_base64"),
                    "created_at": now,
                    "read_at": None,
                    "severity": "none",
                }
                await _db.messages.insert_one(msg)
                sent_ids.append(aid)
        except Exception:
            logger.exception("[bt-report] DM dispatch failed")
        rec["sent_to_admin_ids"] = sent_ids
        await _db.bt_reports.insert_one(rec)
        return {"id": rid, "sent_to_admin_count": len(sent_ids)}

    # NB: app.include_router(sub) is intentionally deferred until AFTER
    # the Friends-Mode endpoints are registered below — FastAPI snapshots
    # the router's routes at include_router time, so calling it early
    # makes the new /bt/match/* routes return 404. See the bottom of
    # this function for the actual include_router call.

    # ═════════════════ Friends-Mode (Relay Race) endpoints ═════════════════
    @sub.post("/bt/match/invite")
    async def _match_invite(
        body: dict = Body(...), user_id: str = Depends(get_user_or_legacy)
    ):
        friend_id = (body.get("friend_id") or "").strip()
        if not friend_id or friend_id == user_id:
            raise HTTPException(400, "friend_id required")
        if not await _are_friends(user_id, friend_id):
            raise HTTPException(403, "You can only invite accepted friends.")
        # Reject if there's already an active (pending/awaiting/in_progress)
        # match between these two — don't allow duplicates.
        existing = await _db.bt_matches.find_one({
            "$or": [
                {"hider_id": user_id, "seeker_id": friend_id},
                {"hider_id": friend_id, "seeker_id": user_id},
            ],
            "state": {"$in": [
                "pending_accept", "awaiting_burial", "in_progress",
            ]},
        })
        if existing:
            raise HTTPException(
                409, "There's already an active match between you two."
            )
        # Hider needs a location set so the chest spawn area is defined.
        # (Seeker doesn't strictly need one for Friends Mode — chest
        # coords come from the Hider's GPS at /bury time.)
        if not await _db.bt_locations.find_one({"_id": user_id}):
            raise HTTPException(400, "Set your hunt area first.")
        mid = str(uuid.uuid4())
        now = _now_iso()
        doc = {
            "_id": mid,
            "hider_id": user_id,
            "seeker_id": friend_id,
            "state": "pending_accept",
            "invited_at": now,
            "accepted_at": None,
            "rejected_at": None,
            "cancelled_at": None,
            "buried_at": None,
            "expires_at": None,
            "found_at": None,
            "found_lat": None,
            "found_lng": None,
            "lat": None,
            "lng": None,
            "hint": None,
            "photo_buried_b64": None,
            "photo_found_b64": None,
            "allow_photo_post": True,  # default ON, hider can flip at /bury
            "winner": None,
            "xp_seeker": 0,
            "xp_hider": 0,
            "resolved_at": None,
        }
        await _db.bt_matches.insert_one(doc)
        try:
            hider = await _profile_summary(user_id)
            await _push_to_user(
                friend_id,
                "🏴‍☠️ Treasure Challenge",
                f"{hider['name']} invited you to a 12-hour hunt!",
                {
                    "kind": "bt_match_invite",
                    "match_id": mid,
                    "channelId": PUSH_CH_BT_INVITE,
                    "sticky": True,
                },
            )
        except Exception:
            logger.exception("[bt-invite] push failed")
        return {"match": _serialize_match(doc, user_id)}

    async def _load_match_or_404(mid: str, user_id: str) -> dict:
        m = await _db.bt_matches.find_one({"_id": mid})
        if not m:
            raise HTTPException(404, "Match not found.")
        # Rule-6 — in Free-For-All mode, any friend of the hider is
        # allowed to claim, so we let non-participants through here and
        # defer the friendship check to /find. Other endpoints (e.g.
        # /accept, /reject) re-verify the caller's role explicitly.
        if not m.get("free_for_all") and user_id not in (m.get("hider_id"), m.get("seeker_id")):
            raise HTTPException(403, "Not your match.")
        return m

    @sub.post("/bt/match/{mid}/accept")
    async def _match_accept(mid: str, user_id: str = Depends(get_user_or_legacy)):
        m = await _load_match_or_404(mid, user_id)
        if user_id != m["seeker_id"]:
            raise HTTPException(403, "Only the invited seeker can accept.")
        if m["state"] != "pending_accept":
            raise HTTPException(400, f"Can't accept — state is {m['state']}.")
        now = _now_iso()
        upd = await _db.bt_matches.find_one_and_update(
            {"_id": mid, "state": "pending_accept"},
            {"$set": {"state": "awaiting_burial", "accepted_at": now}},
            return_document=True,
        )
        if not upd:
            raise HTTPException(409, "Match state changed — refresh.")
        try:
            seeker = await _profile_summary(user_id)
            await _push_to_user(
                m["hider_id"],
                "🏴‍☠️ Hunt accepted!",
                f"{seeker['name']} is ready. Walk to your spot and bury the chest.",
                {"kind": "bt_match_accepted", "match_id": mid,
                 "channelId": PUSH_CH_BT_INVITE},
            )
        except Exception:
            logger.exception("[bt-accept] push failed")
        return {"match": _serialize_match(upd, user_id)}

    @sub.post("/bt/match/{mid}/reject")
    async def _match_reject(mid: str, user_id: str = Depends(get_user_or_legacy)):
        m = await _load_match_or_404(mid, user_id)
        if user_id != m["seeker_id"]:
            raise HTTPException(403, "Only the invited seeker can reject.")
        if m["state"] != "pending_accept":
            raise HTTPException(400, f"Can't reject — state is {m['state']}.")
        now = _now_iso()
        # Rule-6: instead of dead-ending the match, switch it to
        # Free-For-All — any friend of the hider who's not the rejecter
        # can claim the treasure on a first-come basis. The match stays
        # in `pending_accept` state but with a `free_for_all=true` flag
        # so the find endpoint can let any FFA participant win.
        upd = await _db.bt_matches.find_one_and_update(
            {"_id": mid, "state": "pending_accept"},
            {"$set": {
                "free_for_all": True,
                "free_for_all_started_at": now,
                "free_for_all_started_by_reject_of": user_id,
            }},
            return_document=True,
        )
        if not upd:
            raise HTTPException(409, "Match state changed — refresh.")
        # Broadcast push to every friend of the hider (excluding the
        # rejecter + hider themselves). Best-effort; failures logged.
        try:
            seeker = await _profile_summary(user_id)
            hider = await _profile_summary(m["hider_id"])
            recipients: list[str] = []
            try:
                fids = await _friend_ids_fn(m["hider_id"]) if callable(_friend_ids_fn) else []
                recipients = [f for f in fids if f and f != user_id and f != m["hider_id"]]
            except Exception:
                recipients = []
            ffa_msg = (
                f"⚡ FREE-FOR-ALL! {seeker['name']} declined the hunt. "
                f"First friend to find {hider['name']}'s treasure wins the XP!"
            )
            for rid in recipients:
                try:
                    await _push_to_user(
                        rid,
                        "Free-For-All Treasure!",
                        ffa_msg,
                        {
                            "kind": "bt_match_ffa",
                            "match_id": mid,
                            "channelId": PUSH_CH_BT_INVITE,
                            "sticky": True,
                        },
                    )
                except Exception:
                    logger.exception("[bt-reject.ffa] push failed to %s", rid)
            # Also notify the hider so they see what happened.
            try:
                await _push_to_user(
                    m["hider_id"],
                    "Hunt re-released",
                    f"{seeker['name']} declined — your treasure is now Free-For-All for {len(recipients)} friend(s).",
                    {"kind": "bt_match_ffa_hider", "match_id": mid,
                     "channelId": PUSH_CH_BT_INVITE},
                )
            except Exception:
                logger.exception("[bt-reject.ffa-hider] push failed")
        except Exception:
            logger.exception("[bt-reject] FFA broadcast failed")
        return {
            "match": _serialize_match(upd, user_id),
            "free_for_all": True,
        }

    @sub.post("/bt/match/{mid}/cancel")
    async def _match_cancel(mid: str, user_id: str = Depends(get_user_or_legacy)):
        m = await _load_match_or_404(mid, user_id)
        if user_id != m["hider_id"]:
            raise HTTPException(403, "Only the hider can cancel.")
        if m["state"] not in ("pending_accept", "awaiting_burial"):
            raise HTTPException(400, "Can't cancel once the hunt is live.")
        now = _now_iso()
        upd = await _db.bt_matches.find_one_and_update(
            {"_id": mid, "state": m["state"]},
            {"$set": {"state": "cancelled", "cancelled_at": now}},
            return_document=True,
        )
        if not upd:
            raise HTTPException(409, "Match state changed — refresh.")
        try:
            hider = await _profile_summary(user_id)
            await _push_to_user(
                m["seeker_id"],
                "Hunt cancelled",
                f"{hider['name']} cancelled the match.",
                {"kind": "bt_match_cancelled", "match_id": mid,
                 "channelId": PUSH_CH_BT_INVITE},
            )
        except Exception:
            logger.exception("[bt-cancel] push failed")
        return {"match": _serialize_match(upd, user_id)}

    @sub.post("/bt/match/{mid}/bury")
    async def _match_bury(
        mid: str,
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        m = await _load_match_or_404(mid, user_id)
        if user_id != m["hider_id"]:
            raise HTTPException(403, "Only the hider can bury the chest.")
        if m["state"] != "awaiting_burial":
            raise HTTPException(
                400, f"Can't bury — state is {m['state']}. Need accept first."
            )
        try:
            lat = float(body.get("lat"))
            lng = float(body.get("lng"))
        except (TypeError, ValueError):
            raise HTTPException(400, "lat/lng required (numeric)")
        if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
            raise HTTPException(400, "lat/lng out of range")
        # Burial must be inside Hider's hunt area (anti-cheat: stops
        # remote pinning from anywhere on Earth).
        loc = await _db.bt_locations.find_one({"_id": user_id})
        if loc and _haversine_m(loc["lat"], loc["lng"], lat, lng) > float(loc["radius_m"]):
            raise HTTPException(
                400, "You're outside your hunt area — walk into the circle to bury.",
            )
        hint = (body.get("hint") or "").strip()[:240] or "Look around — it's nearby."
        photo_b64 = (body.get("photo_b64") or body.get("photo_base64") or "")[:500_000] or None
        allow_post = bool(body.get("allow_photo_post", True))
        now_dt = datetime.now(timezone.utc)
        expires_at = (now_dt + timedelta(hours=MATCH_DURATION_H)).isoformat()
        upd = await _db.bt_matches.find_one_and_update(
            {"_id": mid, "state": "awaiting_burial"},
            {"$set": {
                "state": "in_progress",
                "lat": lat, "lng": lng,
                "hint": hint,
                "photo_buried_b64": photo_b64,
                "allow_photo_post": allow_post,
                "buried_at": _now_iso(),
                "expires_at": expires_at,
            }},
            return_document=True,
        )
        if not upd:
            raise HTTPException(409, "Match state changed — refresh.")
        try:
            hider = await _profile_summary(user_id)
            await _push_to_user(
                m["seeker_id"],
                "🏴‍☠️ Chest is buried!",
                f"{hider['name']} hid it. 12h to find it. Hint: {hint[:80]}",
                {"kind": "bt_match_buried", "match_id": mid,
                 "channelId": PUSH_CH_BT_INVITE},
            )
        except Exception:
            logger.exception("[bt-bury] push failed")
        return {"match": _serialize_match(upd, user_id)}

    @sub.post("/bt/match/{mid}/find")
    async def _match_find(
        mid: str,
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        m = await _load_match_or_404(mid, user_id)
        is_ffa = bool(m.get("free_for_all"))
        # Rule-6 — in Free-For-All mode any friend of the hider can claim
        # the chest (except the rejecter and the hider themselves). The
        # match stays in 'pending_accept' state in this branch, so we
        # widen the allowed states accordingly. In normal mode only the
        # invited seeker can claim, and the state must be 'in_progress'.
        if is_ffa:
            if user_id == m["hider_id"]:
                raise HTTPException(403, "The hider can't find their own treasure.")
            if user_id == m.get("free_for_all_started_by_reject_of"):
                raise HTTPException(403, "You already declined this hunt.")
            try:
                fids = await _friend_ids_fn(m["hider_id"]) if callable(_friend_ids_fn) else []
            except Exception:
                fids = []
            if user_id not in set(fids):
                raise HTTPException(403, "Free-For-All is open to the hider's friends only.")
            if m["state"] not in ("pending_accept", "in_progress"):
                raise HTTPException(400, f"Can't find — state is {m['state']}.")
        else:
            if user_id != m["seeker_id"]:
                raise HTTPException(403, "Only the seeker can claim a find.")
            if m["state"] != "in_progress":
                raise HTTPException(400, f"Can't find — state is {m['state']}.")
        try:
            lat = float(body.get("lat"))
            lng = float(body.get("lng"))
        except (TypeError, ValueError):
            raise HTTPException(400, "lat/lng required")
        if m.get("lat") is None or m.get("lng") is None:
            raise HTTPException(500, "Chest coords missing — contact support.")
        dist = _haversine_m(m["lat"], m["lng"], lat, lng)
        if dist > MATCH_FIND_RING_M:
            raise HTTPException(
                400,
                f"Still {int(dist)} m away — get within {MATCH_FIND_RING_M} m.",
            )
        photo_b64 = (body.get("photo_b64") or body.get("photo_base64") or "")[:500_000] or None
        now = _now_iso()
        # In FFA the state may be 'pending_accept' — we still flip it to
        # 'found' atomically. Add `winner_user_id` so the UI can show the
        # actual finder (not the originally-invited seeker).
        state_filter = ["pending_accept", "in_progress"] if is_ffa else ["in_progress"]
        upd = await _db.bt_matches.find_one_and_update(
            {"_id": mid, "state": {"$in": state_filter}},
            {"$set": {
                "state": "found",
                "winner": "seeker",
                "winner_user_id": user_id,
                "found_at": now,
                "found_lat": lat,
                "found_lng": lng,
                "photo_found_b64": photo_b64,
                "resolved_at": now,
                "xp_seeker": XP_FIND_SEEKER,
                "xp_hider": XP_FIND_HIDER,
                "ffa_won_by": user_id if is_ffa else None,
            }},
            return_document=True,
        )
        if not upd:
            raise HTTPException(409, "Match state changed — refresh.")
        await _award_xp(user_id, XP_FIND_SEEKER, reason="bt_match_seeker_win")
        await _award_xp(m["hider_id"], XP_FIND_HIDER, reason="bt_match_hider_complete")

        # ── Auto-post to bt_feed_posts if hider consented at burial ──
        feed_post_id = None
        if upd.get("allow_photo_post"):
            try:
                seeker = await _profile_summary(user_id)
                hider = await _profile_summary(m["hider_id"])
                # duration string
                try:
                    b_dt = datetime.fromisoformat(
                        (upd.get("buried_at") or "").replace("Z", "+00:00")
                    )
                    f_dt = datetime.fromisoformat(now.replace("Z", "+00:00"))
                    secs = max(0, int((f_dt - b_dt).total_seconds()))
                except Exception:
                    secs = 0
                feed_post_id = str(uuid.uuid4())
                await _db.bt_feed_posts.insert_one({
                    "_id": feed_post_id,
                    "match_id": mid,
                    "seeker_id": user_id,
                    "hider_id": m["hider_id"],
                    "seeker_name": seeker["name"],
                    "seeker_avatar_base64": seeker["avatar_base64"],
                    "hider_name": hider["name"],
                    "hider_avatar_base64": hider["avatar_base64"],
                    "duration_seconds": secs,
                    "hint": upd.get("hint"),
                    "photo_found_b64": photo_b64,
                    "photo_buried_b64": upd.get("photo_buried_b64"),
                    "lat": upd.get("lat"),
                    "lng": upd.get("lng"),
                    "xp_seeker": XP_FIND_SEEKER,
                    "xp_hider": XP_FIND_HIDER,
                    "created_at": now,
                    "likes": [],
                    "comments": [],
                })
            except Exception:
                logger.exception("[bt-feed] auto-post failed (non-fatal)")

        # Notify the hider that their chest got found
        try:
            seeker_p = await _profile_summary(user_id)
            await _push_to_user(
                m["hider_id"],
                "🏴‍☠️ Your chest was found!",
                f"{seeker_p['name']} found it. +{XP_FIND_HIDER} XP earned.",
                {"kind": "bt_match_found", "match_id": mid,
                 "channelId": PUSH_CH_BT_INVITE},
            )
        except Exception:
            logger.exception("[bt-find] push failed")
        out = _serialize_match(upd, user_id)
        out["xp_awarded"] = XP_FIND_SEEKER
        out["feed_post_id"] = feed_post_id
        return out

    @sub.get("/bt/matches")
    async def _matches_list(user_id: str = Depends(get_user_or_legacy)):
        """All matches I'm part of, newest first. Includes opponent info."""
        cur = _db.bt_matches.find({
            "$or": [{"hider_id": user_id}, {"seeker_id": user_id}],
        }).sort("invited_at", -1).limit(50)
        rows = []
        async for m in cur:
            other_id = m["seeker_id"] if m["hider_id"] == user_id else m["hider_id"]
            op = await _profile_summary(other_id)
            out = _serialize_match(m, user_id)
            out["my_role"] = "hider" if m["hider_id"] == user_id else "seeker"
            out["opponent"] = op
            rows.append(out)
        return {"matches": rows}

    @sub.get("/bt/match/{mid}")
    async def _match_get(mid: str, user_id: str = Depends(get_user_or_legacy)):
        m = await _load_match_or_404(mid, user_id)
        other_id = m["seeker_id"] if m["hider_id"] == user_id else m["hider_id"]
        op = await _profile_summary(other_id)
        out = _serialize_match(m, user_id)
        out["my_role"] = "hider" if m["hider_id"] == user_id else "seeker"
        out["opponent"] = op
        # Embed the photos only when the requester is allowed to see them
        # (Hider always, Seeker only after the hunt is resolved or chest
        # is buried for hint preview).
        if m.get("photo_buried_b64") and (
            user_id == m["hider_id"] or m.get("state") in ("found", "expired")
        ):
            out["photo_buried_b64"] = m["photo_buried_b64"]
        if m.get("photo_found_b64"):
            out["photo_found_b64"] = m["photo_found_b64"]
        return out

    @sub.get("/bt/feed")
    async def _bt_feed(user_id: str = Depends(get_user_or_legacy), limit: int = 50):
        """Friends-mode feed: posts where I'm a participant or where I'm
        friends with the seeker or the hider."""
        friend_ids: list[str] = []
        if _friend_ids_fn is not None:
            try:
                friend_ids = await _friend_ids_fn(user_id)
            except Exception:
                friend_ids = []
        visible_ids = list({user_id, *friend_ids})
        cur = _db.bt_feed_posts.find({
            "$or": [
                {"seeker_id": {"$in": visible_ids}},
                {"hider_id": {"$in": visible_ids}},
            ],
        }).sort("created_at", -1).limit(max(1, min(200, int(limit))))
        out = []
        async for p in cur:
            out.append({
                "id": p["_id"],
                "match_id": p.get("match_id"),
                "seeker": {
                    "id": p.get("seeker_id"),
                    "name": p.get("seeker_name"),
                    "avatar_base64": p.get("seeker_avatar_base64"),
                },
                "hider": {
                    "id": p.get("hider_id"),
                    "name": p.get("hider_name"),
                    "avatar_base64": p.get("hider_avatar_base64"),
                },
                "duration_seconds": int(p.get("duration_seconds", 0)),
                "hint": p.get("hint"),
                "photo_found_b64": p.get("photo_found_b64"),
                "photo_buried_b64": p.get("photo_buried_b64"),
                "xp_seeker": int(p.get("xp_seeker", 0)),
                "xp_hider": int(p.get("xp_hider", 0)),
                "created_at": p.get("created_at"),
                "likes": p.get("likes") or [],
                "like_count": len(p.get("likes") or []),
                "comment_count": len(p.get("comments") or []),
                "liked_by_you": user_id in (p.get("likes") or []),
                "is_self": user_id in (p.get("seeker_id"), p.get("hider_id")),
            })
        return {"entries": out, "count": len(out)}

    @sub.post("/bt/feed/{pid}/like")
    async def _bt_feed_like(pid: str, user_id: str = Depends(get_user_or_legacy)):
        p = await _db.bt_feed_posts.find_one({"_id": pid})
        if not p:
            raise HTTPException(404, "Post not found.")
        likes = set(p.get("likes") or [])
        if user_id in likes:
            likes.remove(user_id)
        else:
            likes.add(user_id)
        await _db.bt_feed_posts.update_one(
            {"_id": pid}, {"$set": {"likes": list(likes)}}
        )
        return {"like_count": len(likes), "liked_by_you": user_id in likes}

    # Finally register the router AFTER all routes are decorated, so the
    # Friends-Mode endpoints are included (see note higher up in this
    # function for why the early include_router was wrong).
    app.include_router(sub)
    return sub
