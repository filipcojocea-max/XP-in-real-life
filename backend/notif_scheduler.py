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
# Spot-the-Object surprise window (local time, inclusive).
SPOT_RANDOM_HOUR_MIN = 9
SPOT_RANDOM_HOUR_MAX = 21
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
def _generate_spot_slots(prof_tz: ZoneInfo, day: str) -> list[str]:
    """Pick `SPOT_RANDOM_DAILY_COUNT` random datetimes inside the
    09:00–21:00 local window for `day` (yyyy-mm-dd) and return them as a
    sorted list of UTC iso8601 strings.

    Slots are spaced at least 90 minutes apart so the user doesn't get a
    burst of three pings in five minutes. We keep 30 retries; if we
    can't satisfy the spacing constraint we still return whatever we
    landed on (the spread is large so this rarely happens).
    """
    base = datetime.fromisoformat(f"{day}T00:00:00").replace(tzinfo=prof_tz)
    out: list[datetime] = []
    for _ in range(60):
        if len(out) >= SPOT_RANDOM_DAILY_COUNT:
            break
        hour = random.randint(SPOT_RANDOM_HOUR_MIN, SPOT_RANDOM_HOUR_MAX - 1)
        minute = random.randint(0, 59)
        cand = base.replace(hour=hour, minute=minute)
        if all(abs((cand - prev).total_seconds()) >= 90 * 60 for prev in out):
            out.append(cand)
    out.sort()
    return [c.astimezone(timezone.utc).isoformat() for c in out]


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
            # Re-roll the slot plan once per local day.
            if slots_day != today or not slots:
                slots = _generate_spot_slots(tz, today)
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
