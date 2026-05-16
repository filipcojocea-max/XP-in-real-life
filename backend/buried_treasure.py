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


def init_buried_treasure(*, db, is_admin_user, now_iso, admin_emails: list[str] | None = None):
    global _db, _now_iso, _is_admin_user, _admin_emails_set
    _db = db
    _is_admin_user = is_admin_user
    _now_iso = now_iso
    _admin_emails_set = set((admin_emails or []))


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
                    "thread_id": "_".join(sorted([user_id, aid])),
                    "from_user_id": user_id,
                    "to_user_id": aid,
                    "text": dm_text,
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

    app.include_router(sub)
    return sub
