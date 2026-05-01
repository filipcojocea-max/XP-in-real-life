"""Server-side notification scheduler (APScheduler).

Two concerns lived in this module:

1. **Daily Motivation** — sends each opted-in user up to 4 motivational
   pushes per day at fixed local times (09:00, 13:00, 17:00, 20:00). This
   complements the on-device local notifications (which can be killed by
   battery optimisation) so the user is never silently dropped.

2. **Spot the Object Surprise** — for users with
   `spot_random_enabled=true`, picks 3 random slots in 09:00–21:00
   local time per day and pushes a "surprise challenge" notification at
   each slot.

Both jobs run as a single APScheduler tick every minute. Each user-row
is fired exactly once per slot via `last_*_sent_at` guards so a clock
skew, scheduler restart or DB hiccup never produces a double-push.

The scheduler boots on FastAPI's "startup" event and shuts down on
"shutdown". It's an in-process background scheduler — light enough for
this app's scale (no Celery/Redis required).
"""

from __future__ import annotations

import asyncio
import logging
import random
from datetime import datetime, timedelta, timezone, time as dtime
from typing import Awaitable, Callable, Optional
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler

# Astral — local sunrise/sunset calculations (no API key required).
# Falls back to a hardcoded "safe daylight" window if the user's timezone
# can't be resolved to a known city.
try:
    from astral.sun import sun as _astral_sun
    from astral.geocoder import database as _astral_db, lookup as _astral_lookup
    _ASTRAL_DB = _astral_db()
except Exception:  # pragma: no cover
    _astral_sun = None
    _ASTRAL_DB = None

logger = logging.getLogger("notif_scheduler")

# Public hooks: server.py wires these to its own collections + push helper.
_db = None
_send_push: Optional[Callable[..., Awaitable[bool]]] = None
_pick_motivation: Optional[Callable[[], str]] = None

scheduler: Optional[AsyncIOScheduler] = None

# ── Config ────────────────────────────────────────────────────────────
# Fixed local-time slots for motivational pushes. We deliberately spread
# them across waking hours so the user doesn't get bombarded.
MOTIVATION_LOCAL_HOURS = [9, 13, 17, 20]
# Spot-the-Object surprise window — the OUTER bound. The actual upper /
# lower bound is the user's local SUNRISE & SUNSET, intersected with
# this fence so we don't ping someone at 04:00 in arctic summer.
SPOT_RANDOM_FALLBACK_HOUR_MIN = 8
SPOT_RANDOM_FALLBACK_HOUR_MAX = 21
SPOT_RANDOM_DAILY_COUNT = 3

DEFAULT_TZ = "Australia/Sydney"  # safe fallback when user has no TZ set


def _user_tz(prof: dict) -> ZoneInfo:
    tz = (prof.get("timezone") or "").strip()
    try:
        return ZoneInfo(tz) if tz else ZoneInfo(DEFAULT_TZ)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def _today_local(prof: dict) -> str:
    return datetime.now(_user_tz(prof)).date().isoformat()


def _local_now(prof: dict) -> datetime:
    return datetime.now(_user_tz(prof))


# ── Sunrise / sunset (per-user, daylight-aware) ─────────────────────
# Resolves a profile's timezone string → an astral.LocationInfo so we
# can compute today's sunrise + sunset in UTC. Falls back to a fixed
# 06:00–20:00 local-day window if the city can't be resolved.
_GEOCODE_OVERRIDES: dict[str, str] = {
    # Common timezones whose city portion isn't directly findable in the
    # astral built-in DB. Map to a representative city that IS in the DB.
    "America/New_York": "New York",
    "America/Los_Angeles": "Los Angeles",
    "America/Chicago": "Chicago",
    "America/Toronto": "Toronto",
    "America/Mexico_City": "Mexico City",
    "America/Sao_Paulo": "Sao Paulo",
    "America/Argentina/Buenos_Aires": "Buenos Aires",
    "Europe/London": "London",
    "Europe/Paris": "Paris",
    "Europe/Berlin": "Berlin",
    "Europe/Madrid": "Madrid",
    "Europe/Rome": "Rome",
    "Europe/Amsterdam": "Amsterdam",
    "Europe/Stockholm": "Stockholm",
    "Europe/Bucharest": "Bucharest",
    "Europe/Athens": "Athens",
    "Europe/Moscow": "Moscow",
    "Asia/Tokyo": "Tokyo",
    "Asia/Shanghai": "Shanghai",
    "Asia/Singapore": "Singapore",
    "Asia/Kolkata": "Kolkata",
    "Asia/Dubai": "Dubai",
    "Asia/Bangkok": "Bangkok",
    "Asia/Seoul": "Seoul",
    "Australia/Sydney": "Sydney",
    "Australia/Melbourne": "Melbourne",
    "Australia/Perth": "Perth",
    "Africa/Cairo": "Cairo",
    "Africa/Lagos": "Lagos",
    "Africa/Johannesburg": "Johannesburg",
    "Pacific/Auckland": "Auckland",
}


def _user_daylight_today(prof: dict) -> tuple[datetime, datetime]:
    """Return today's sunrise and sunset for the user's timezone, both as
    UTC-aware datetimes. Today is whatever date it currently is in the
    user's local timezone (i.e. for a Sydney user at UTC 16:00 it's
    "today UTC + 1 day").

    On any failure, fall back to a generous 06:00–20:00 local-day window
    so the user still gets surprise pings — better than going dark."""
    tz = _user_tz(prof)
    local_today = datetime.now(tz).date()
    # Fallback bounds (06:00 → 20:00 local) → UTC datetimes.
    fb_dawn = datetime.combine(local_today, dtime(6, 0)).replace(tzinfo=tz).astimezone(timezone.utc)
    fb_dusk = datetime.combine(local_today, dtime(20, 0)).replace(tzinfo=tz).astimezone(timezone.utc)

    if _astral_sun is None or _ASTRAL_DB is None:
        return fb_dawn, fb_dusk

    tz_name = (prof.get("timezone") or "").strip() or DEFAULT_TZ
    # Prefer the explicit override map; otherwise try the last segment.
    candidate = _GEOCODE_OVERRIDES.get(tz_name) or tz_name.split("/")[-1].replace("_", " ")
    try:
        loc = _astral_lookup(candidate, _ASTRAL_DB)
        # IMPORTANT: pass the LOCAL tz to astral so it returns local-day
        # sunrise/sunset (not UTC-day, which wraps around midnight UTC
        # for tz offsets >|UTC|. e.g. Sydney sunrise computed with
        # tzinfo='UTC' returns NEXT-day's sunrise because solar noon
        # falls into the previous UTC day). We then convert to UTC.
        s = _astral_sun(loc.observer, date=local_today, tzinfo=tz)
        sunrise = s.get("sunrise")
        sunset = s.get("sunset")
        if not sunrise or not sunset:
            return fb_dawn, fb_dusk
        sunrise_utc = sunrise.astimezone(timezone.utc)
        sunset_utc = sunset.astimezone(timezone.utc)
        if sunset_utc <= sunrise_utc:
            # Pathological — fall back rather than return inverted bounds.
            return fb_dawn, fb_dusk
        return sunrise_utc, sunset_utc
    except Exception as e:
        logger.warning("[daylight] %s lookup failed: %s — using fallback", tz_name, e)
        return fb_dawn, fb_dusk


def _is_daylight_now(prof: dict) -> bool:
    """True iff `datetime.utcnow()` falls between today's sunrise and
    sunset for the given user's timezone. Used as the gate for the
    multiplayer-invite broadcast push: we only ping friends who are
    awake (i.e. in their daylight window)."""
    try:
        dawn, dusk = _user_daylight_today(prof)
        now = datetime.now(timezone.utc)
        return dawn <= now <= dusk
    except Exception:
        return True  # be lenient — never block a legit invite over a lookup error


# ── Token push fan-out helper ─────────────────────────────────────────
async def _push_to_user(user_id: str, title: str, body: str, data: dict | None = None) -> int:
    """Push to every device token registered for a user. Returns count of
    tokens actually contacted."""
    if _db is None or _send_push is None:
        return 0
    sent = 0
    try:
        cur = _db.push_tokens.find({"user_id": user_id})
        async for t in cur:
            tok = t.get("token")
            if not tok:
                continue
            try:
                ok = await _send_push(tok, title, body, data or {})
                if ok:
                    sent += 1
            except Exception as e:
                logger.warning("[scheduler.push] %s: %s", user_id, e)
    except Exception as e:
        logger.warning("[scheduler.push.cur] %s: %s", user_id, e)
    return sent


# ── Spot-the-Object surprise slot generation ──────────────────────────
def _generate_spot_slots_for_user(prof: dict) -> list[str]:
    """Pick `SPOT_RANDOM_DAILY_COUNT` random datetimes inside the user's
    sunrise→sunset window TODAY (in their local timezone), clamped by
    SPOT_RANDOM_FALLBACK_HOUR_MIN/MAX so polar summer doesn't ping at
    04:00. Returns sorted UTC iso8601 strings.

    Slots are spaced at least 90 minutes apart.
    """
    tz = _user_tz(prof)
    local_today = datetime.now(tz).date()
    sunrise_utc, sunset_utc = _user_daylight_today(prof)
    # Clamp to the fence so polar latitudes stay reasonable.
    fence_min = datetime.combine(local_today, dtime(SPOT_RANDOM_FALLBACK_HOUR_MIN, 0)).replace(tzinfo=tz).astimezone(timezone.utc)
    fence_max = datetime.combine(local_today, dtime(SPOT_RANDOM_FALLBACK_HOUR_MAX, 0)).replace(tzinfo=tz).astimezone(timezone.utc)
    win_start = max(sunrise_utc, fence_min)
    win_end = min(sunset_utc, fence_max)
    if win_end - win_start < timedelta(minutes=180):
        # Window collapsed (very high latitude winter, or geocode miss);
        # fallback to fence so users still get pinged.
        win_start, win_end = fence_min, fence_max

    span_seconds = max(int((win_end - win_start).total_seconds()), 60)
    out: list[datetime] = []
    for _ in range(80):
        if len(out) >= SPOT_RANDOM_DAILY_COUNT:
            break
        offset = random.randint(0, span_seconds)
        cand = win_start + timedelta(seconds=offset)
        if all(abs((cand - prev).total_seconds()) >= 90 * 60 for prev in out):
            out.append(cand)
    out.sort()
    return [c.isoformat() for c in out]


# ── Tick: motivation ──────────────────────────────────────────────────
async def _motivation_tick():
    if _db is None or _send_push is None:
        return
    now_utc = datetime.now(timezone.utc)
    # Fetch all opted-in profiles. Cap to a reasonable batch so the
    # tick stays bounded.
    cur = _db.profile.find(
        {
            "$and": [
                # Anonymous users without a push token are skipped via the
                # _push_to_user fan-out anyway, so no extra filter needed.
                {"$or": [
                    {"motivation_push_enabled": {"$ne": False}},
                    {"motivation_push_enabled": {"$exists": False}},
                ]},
            ],
        },
        {
            "_id": 1,
            "timezone": 1,
            "motivation_last_sent_at": 1,
            "motivation_last_slot_key": 1,
        },
    ).limit(2000)

    async for prof in cur:
        try:
            tz = _user_tz(prof)
            local = now_utc.astimezone(tz)
            # Match the slot if we're within +/- 5 minutes of a fixed hour
            # AND haven't already fired this slot today.
            slot_hour = next(
                (h for h in MOTIVATION_LOCAL_HOURS if local.hour == h and local.minute < 5),
                None,
            )
            if slot_hour is None:
                continue
            slot_key = f"{local.date().isoformat()}#{slot_hour}"
            if prof.get("motivation_last_slot_key") == slot_key:
                continue
            title = "Critique AI · Daily push"
            body = (_pick_motivation() if _pick_motivation else "You don't need motivation. You need to move.")
            await _push_to_user(
                prof["_id"], title, body,
                data={"kind": "motivation", "slot": slot_key},
            )
            await _db.profile.update_one(
                {"_id": prof["_id"]},
                {"$set": {
                    "motivation_last_sent_at": now_utc.isoformat(),
                    "motivation_last_slot_key": slot_key,
                }},
            )
        except Exception as e:
            logger.warning("[motivation.tick] %s: %s", prof.get("_id"), e)


# ── Tick: spot surprise ───────────────────────────────────────────────
async def _spot_surprise_tick():
    if _db is None or _send_push is None:
        return
    now_utc = datetime.now(timezone.utc)
    cur = _db.profile.find(
        {"spot_random_enabled": True},
        {
            "_id": 1,
            "timezone": 1,
            "spot_random_slots": 1,        # list[iso utc str]
            "spot_random_slots_day": 1,    # yyyy-mm-dd local
            "spot_random_consumed": 1,     # list[iso utc str]
        },
    ).limit(5000)
    async for prof in cur:
        try:
            tz = _user_tz(prof)
            today = now_utc.astimezone(tz).date().isoformat()
            slots = prof.get("spot_random_slots") or []
            consumed = set(prof.get("spot_random_consumed") or [])
            slots_day = prof.get("spot_random_slots_day")
            # Re-roll the slot plan once per local day. The new generator
            # uses the user's actual sunrise→sunset window so we never
            # ping someone in the middle of the night, and the spread
            # auto-adjusts to long summer / short winter days.
            if slots_day != today or not slots:
                slots = _generate_spot_slots_for_user(prof)
                consumed = set()
                await _db.profile.update_one(
                    {"_id": prof["_id"]},
                    {"$set": {
                        "spot_random_slots": slots,
                        "spot_random_slots_day": today,
                        "spot_random_consumed": [],
                    }},
                )
            # Fire any slot that is now ≤ now (and not yet consumed).
            fired_any = False
            for slot_iso in list(slots):
                if slot_iso in consumed:
                    continue
                try:
                    slot_dt = datetime.fromisoformat(slot_iso.replace("Z", "+00:00"))
                except Exception:
                    continue
                if slot_dt > now_utc:
                    continue
                # Don't fire more than 30 minutes late — assume the user
                # was offline; just consume the slot to avoid spam.
                late_minutes = (now_utc - slot_dt).total_seconds() / 60.0
                if 0 <= late_minutes <= 30:
                    await _push_to_user(
                        prof["_id"],
                        "🎯 Spot the Object — Surprise Challenge",
                        "Tap to start a 60-second hunt before the timer expires.",
                        data={
                            "kind": "spot_surprise",
                            "deeplink": "/spot/play",
                            "slot": slot_iso,
                            # The Android channel key the client listens on so
                            # this notification plays the custom sound.
                            "channelId": "spot_surprise",
                        },
                    )
                consumed.add(slot_iso)
                fired_any = True
            if fired_any:
                await _db.profile.update_one(
                    {"_id": prof["_id"]},
                    {"$set": {"spot_random_consumed": list(consumed)}},
                )
        except Exception as e:
            logger.warning("[spot_surprise.tick] %s: %s", prof.get("_id"), e)


# ── Match invite expiry sweep ─────────────────────────────────────────
# Expires lobby invites that no one accepted within the 2-minute window.
async def _match_invite_expiry_tick():
    if _db is None:
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
    try:
        # Match still in 'waiting' status, only the host has joined, and
        # was created over 2 minutes ago → cancel it.
        res = await _db.spot_matches.update_many(
            {
                "status": "waiting",
                "created_at": {"$lt": cutoff},
                "$expr": {"$lte": [{"$size": {"$ifNull": ["$joined", []]}}, 1]},
            },
            {"$set": {
                "status": "cancelled",
                "cancelled_reason": "invite_window_expired",
                "finished_at": datetime.now(timezone.utc).isoformat(),
            }},
        )
        if getattr(res, "modified_count", 0):
            logger.info("[match.expiry] cancelled %d stale lobbies", res.modified_count)
    except Exception as e:
        logger.warning("[match.expiry] %s", e)


# ── Wiring ────────────────────────────────────────────────────────────
def init_scheduler(
    *,
    db,
    send_push: Callable[..., Awaitable[bool]],
    pick_motivation: Callable[[], str],
) -> AsyncIOScheduler:
    """Wire dependencies and start the scheduler. Idempotent — calling
    twice replaces the old jobs."""
    global _db, _send_push, _pick_motivation, scheduler
    _db = db
    _send_push = send_push
    _pick_motivation = pick_motivation

    if scheduler and scheduler.running:
        try:
            scheduler.shutdown(wait=False)
        except Exception:
            pass

    sched = AsyncIOScheduler(timezone=timezone.utc)
    # Every minute is plenty: motivation slots are checked with a 5-min
    # window, surprises with a 30-min window, and the match-expiry sweep
    # is cheap.
    sched.add_job(_motivation_tick, "interval", minutes=1, id="motivation_tick", max_instances=1, coalesce=True)
    sched.add_job(_spot_surprise_tick, "interval", minutes=1, id="spot_surprise_tick", max_instances=1, coalesce=True)
    sched.add_job(_match_invite_expiry_tick, "interval", seconds=20, id="match_invite_expiry", max_instances=1, coalesce=True)
    sched.start()
    scheduler = sched
    logger.info("[scheduler] started: motivation_tick + spot_surprise_tick + match_invite_expiry")
    return sched


def shutdown_scheduler():
    global scheduler
    if scheduler:
        try:
            scheduler.shutdown(wait=False)
        except Exception:
            pass
    scheduler = None
