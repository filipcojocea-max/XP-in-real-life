"""
Spot the Object — Permanent Groups · Phase 2: Auto-Challenge Scheduler
=======================================================================

When `spot_groups.auto_challenge_on == True`, every group with that flag
on is fed THREE surprise challenges per day. The challenges fire at the
EXACT same UTC moment for every group worldwide ("global anchors"). Per
spec choices (1B + 2A + 3A + 4A + 5 = Phase 2 daylight-only):

  • Option 1B — anchor times are 3 random UTC moments inside a global
    daylight band [SPOT_GROUPS_ANCHOR_UTC_MIN .. SPOT_GROUPS_ANCHOR_UTC_MAX]
    so most timezones see ≥1 challenge in their daytime.
  • Option 2A — uses `astral` sunrise/sunset (via _user_daylight_today)
    keyed on the player's profile.timezone. Fall back to 06:00-21:00
    local if astral can't resolve their tz.
  • Option 3A — each anchor picks ONE random target_object that every
    group's members hunt at that same moment (great for community
    'everyone's hunting a coffee mug right now' vibe).
  • Option 4A — push notification per eligible (daylight) member.
  • Option 5 — Phase 2 implements ONLY daylight gating. Phase 3 will
    layer Adaptive Work-Life sleep/work gates + the 1h-defer rule.

Mongo collections
─────────────────
  spot_auto_anchors {
      _id: 'YYYY-MM-DD' (UTC date),
      times: [ { at_utc:iso, target_object:str, fired_group_ids:[gid] } ],
      created_at,
  }
  spot_group_challenges {
      _id (uuid),
      group_id,
      anchor_date,
      anchor_idx (0..2),
      target_object,
      scheduled_at_utc,
      fired_at_utc,
      recipients:[user_id]    (those in daylight),
      skipped_night:[user_id] (those whose local time was night),
  }

Endpoints exposed (under /api):
  GET  /spot/groups/{gid}/challenges  (last 20 challenges for the group)
  POST /admin/spot/scheduler/force-tick  (Creator-only — for testing /
       on-demand dispatch; picks a new anchor for "right now" and fires).

Background job (added to the existing APScheduler that lives in
notif_scheduler.py): `_spot_groups_auto_tick`, runs every minute. Picks
today's anchor row (auto-generates on first tick of the UTC day) and
fires any anchors whose at_utc ≤ now to every auto-on group that hasn't
been fired for that anchor yet.
"""

from __future__ import annotations

import logging
import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException

logger = logging.getLogger(__name__)

# Wired by init_spot_groups_scheduler() — kept module-level (NOT via
# server.py imports) to avoid circulars.
_db = None
_send_push: Optional[Callable[..., Awaitable[bool]]] = None
_is_admin: Optional[Callable[[str], Awaitable[bool]]] = None
_user_daylight_today = None  # callable(prof) -> (sunrise_utc, sunset_utc)
_availability_fn = None      # callable(prof_dict) -> 'sleeping'|'at_work'|'active'
_spot_objects: list[str] = []

# Global daylight band for the 3 anchor times (UTC). 06:00 UTC covers
# Asia/Australia-PM through to Americas-AM; 21:00 UTC stretches the
# Americas afternoon. Outside this we'd ping fewer than ~25% of players.
SPOT_GROUPS_ANCHOR_UTC_MIN_HOUR = 6
SPOT_GROUPS_ANCHOR_UTC_MAX_HOUR = 21
SPOT_GROUPS_DAILY_ANCHOR_COUNT = 3
SPOT_GROUPS_MIN_GAP_MIN = 90  # 1.5h between anchors

# Phase 3 defer rules: when ALL active members are unavailable
# (sleeping / at_work / outside daylight), defer this group's copy of
# the anchor by N hours, up to MAX_DEFERS times. After that, drop the
# anchor for this group (no challenge fires today).
SPOT_GROUPS_DEFER_HOURS = 1
SPOT_GROUPS_MAX_DEFERS = 3

# Phase 4 round-resolution config.
# After the anchor fires, ON+accepted+daylight members have 2 minutes
# to POST /spot/complete with a matching photo. After the window
# closes, the scheduler attributes:
#   * each successful poster ("winner") +5 XP × #losers
#   * each missed poster ("loser")     −1 XP × #winners
# Skipped (sleeping/at_work/night) and toggle-OFF members are excluded.
SPOT_GROUPS_ROUND_SECONDS = 120
SPOT_GROUPS_WIN_XP_PER_LOSER = 5
SPOT_GROUPS_LOSS_XP_PER_WINNER = 1


def init_spot_groups_scheduler(
    *,
    db,
    send_push,
    is_admin,
    user_daylight_today,
    spot_objects: list[str],
    availability_fn=None,
):
    """Hook server.py dependencies. `user_daylight_today(prof)` is the
    helper from notif_scheduler.py that returns today's sunrise/sunset
    in UTC for a given profile."""
    global _db, _send_push, _is_admin, _user_daylight_today, _spot_objects, _availability_fn
    _db = db
    _send_push = send_push
    _is_admin = is_admin
    _user_daylight_today = user_daylight_today
    _availability_fn = availability_fn
    _spot_objects = list(spot_objects) if spot_objects else ["cup", "book", "pen"]


def _today_utc_date() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _pick_random_anchors_for_date(date_iso: str) -> list[dict]:
    """Pick `SPOT_GROUPS_DAILY_ANCHOR_COUNT` random UTC anchor times for
    the given UTC date, spaced ≥SPOT_GROUPS_MIN_GAP_MIN apart, within
    [MIN_HOUR..MAX_HOUR] UTC. Each anchor gets a random target_object."""
    d = datetime.fromisoformat(date_iso).date()
    win_start = datetime(d.year, d.month, d.day, SPOT_GROUPS_ANCHOR_UTC_MIN_HOUR, 0, tzinfo=timezone.utc)
    win_end = datetime(d.year, d.month, d.day, SPOT_GROUPS_ANCHOR_UTC_MAX_HOUR, 0, tzinfo=timezone.utc)
    span_min = int((win_end - win_start).total_seconds() // 60)

    picked: list[datetime] = []
    attempts = 0
    while len(picked) < SPOT_GROUPS_DAILY_ANCHOR_COUNT and attempts < 80:
        attempts += 1
        offset = random.randint(0, span_min)
        cand = win_start + timedelta(minutes=offset)
        if all(abs((cand - p).total_seconds()) / 60 >= SPOT_GROUPS_MIN_GAP_MIN for p in picked):
            picked.append(cand)
    picked.sort()
    # Fallback (shouldn't trigger normally) — evenly space if we couldn't
    # find 3 picks (e.g. extremely narrow window).
    while len(picked) < SPOT_GROUPS_DAILY_ANCHOR_COUNT:
        step = (win_end - win_start) / (SPOT_GROUPS_DAILY_ANCHOR_COUNT + 1)
        picked.append(win_start + step * (len(picked) + 1))

    return [
        {
            "at_utc": p.isoformat(),
            "target_object": random.choice(_spot_objects),
            "fired_group_ids": [],
        }
        for p in picked
    ]


async def _get_or_create_today_anchors() -> dict:
    """Return today's anchor row (auto-generates on first call of the
    UTC day)."""
    if _db is None:
        return {"_id": _today_utc_date(), "times": []}
    date_id = _today_utc_date()
    row = await _db.spot_auto_anchors.find_one({"_id": date_id})
    if row:
        return row
    times = _pick_random_anchors_for_date(date_id)
    doc = {
        "_id": date_id,
        "times": times,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await _db.spot_auto_anchors.insert_one(doc)
    except Exception:
        # Race — another process inserted first. Fetch the winner.
        row = await _db.spot_auto_anchors.find_one({"_id": date_id})
        if row:
            return row
    return doc


async def _is_in_daylight_for_profile(prof: dict, now_utc: datetime) -> bool:
    """Re-uses the notif_scheduler helper. True if `now_utc` is between
    today's sunrise and sunset for the player's local timezone."""
    if _user_daylight_today is None:
        return True  # be lenient if helper not wired (test/dev shim)
    try:
        sunrise_utc, sunset_utc = _user_daylight_today(prof)
        return sunrise_utc <= now_utc <= sunset_utc
    except Exception as e:
        logger.warning("[spot-auto.daylight] %s", e)
        return True


def _defer_doc_id(group_id: str, anchor_date: str, anchor_idx: int) -> str:
    return f"{anchor_date}:{anchor_idx}:{group_id}"


async def _get_defer_state(group_id: str, anchor_date: str, anchor_idx: int) -> dict:
    if _db is None:
        return {"attempts": [], "dropped": False, "next_try_at": None}
    doc = await _db.spot_anchor_deferrals.find_one(
        {"_id": _defer_doc_id(group_id, anchor_date, anchor_idx)}
    ) or {}
    return {
        "attempts": doc.get("attempts") or [],
        "dropped": bool(doc.get("dropped")),
        "next_try_at": doc.get("next_try_at"),
    }


async def _record_defer(
    *, group_id: str, anchor_date: str, anchor_idx: int,
    now_utc: datetime, drop: bool = False,
) -> None:
    """Append an attempt to the deferral row; optionally mark `dropped`
    after exhausting MAX_DEFERS retries."""
    if _db is None:
        return
    next_try_iso = (now_utc + timedelta(hours=SPOT_GROUPS_DEFER_HOURS)).isoformat()
    update = {
        "$push": {"attempts": now_utc.isoformat()},
        "$set": {
            "group_id": group_id,
            "anchor_date": anchor_date,
            "anchor_idx": anchor_idx,
            "next_try_at": None if drop else next_try_iso,
            "dropped": bool(drop),
            "updated_at": now_utc.isoformat(),
        },
    }
    await _db.spot_anchor_deferrals.update_one(
        {"_id": _defer_doc_id(group_id, anchor_date, anchor_idx)},
        update,
        upsert=True,
    )


async def _dispatch_anchor_to_group(
    *,
    group: dict,
    anchor_idx: int,
    anchor_at_utc: datetime,
    target_object: str,
) -> dict:
    """Fire one anchor to one group. Walk all ACCEPTED members with
    notifications_on=True, push to those currently in daylight AND not
    sleeping AND not at work, write a spot_group_challenges row.

    Phase 4 / Rule-3 — Each GROUP draws its target object from its OWN
    non-repeat queue (per-group, scope='group'). The global anchor's
    `target_object` is therefore only used as a fallback if the queue
    fetch fails. This reverses the earlier "same object for all groups
    at one anchor" design (Option 3A) per the user's latest spec:
    DIFFERENT groups should NEVER have the same object at the same
    time."""
    gid = group["_id"]
    now_utc = datetime.now(timezone.utc)
    anchor_date = anchor_at_utc.date().isoformat()

    # Per-group queue pick — Rule-3 (each group's own queue).
    group_target = target_object
    try:
        from challenge_queue import next_item as _cq_next
        picks = await _cq_next(
            _db,
            scope="group", key=gid, pool_id="spot_group",
            full_pool=_spot_objects, count=1,
        )
        if picks:
            group_target = picks[0]
    except Exception:
        logger.exception("[spot-auto.dispatch] per-group queue failed, using anchor target")
    target_object = group_target

    defer = await _get_defer_state(gid, anchor_date, anchor_idx)
    if defer["dropped"]:
        return {"recipients": [], "skipped_night": [], "deferred": True, "dropped": True}
    if defer["next_try_at"]:
        try:
            next_at = datetime.fromisoformat(defer["next_try_at"])
            if next_at > now_utc:
                return {"recipients": [], "skipped_night": [], "deferred": True, "wait_until": defer["next_try_at"]}
        except Exception:
            pass

    # Fetch ACCEPTED + notifications_on members only (Phase 4 gate).
    members_cur = _db.spot_group_members.find({
        "group_id": gid,
        "left_at": None,
        "$or": [
            {"status": "accepted"},
            {"status": {"$exists": False}},  # legacy rows = treated as accepted
        ],
        "$and": [
            {"$or": [
                {"notifications_on": True},
                {"notifications_on": {"$exists": False}},
            ]},
        ],
    })
    member_ids: list[str] = []
    async for m in members_cur:
        member_ids.append(m["user_id"])
    if not member_ids:
        return {"recipients": [], "skipped_night": []}

    profs_cur = _db.profile.find(
        {"_id": {"$in": member_ids}},
        {
            "_id": 1, "timezone": 1, "full_name": 1, "name": 1,
            "shift_schedule": 1, "day_start_time": 1, "wake_time": 1,
        },
    )
    profs: dict[str, dict] = {}
    async for p in profs_cur:
        profs[p["_id"]] = p

    recipients: list[str] = []
    skipped_night: list[str] = []
    skipped_sleeping: list[str] = []
    skipped_work: list[str] = []
    for uid in member_ids:
        prof = profs.get(uid) or {"_id": uid}
        if _availability_fn is not None:
            try:
                avail = _availability_fn(prof)
            except Exception:
                avail = "active"
            if avail == "sleeping":
                skipped_sleeping.append(uid)
                continue
            if avail == "at_work":
                skipped_work.append(uid)
                continue
        in_day = await _is_in_daylight_for_profile(prof, now_utc)
        if not in_day:
            skipped_night.append(uid)
            continue
        recipients.append(uid)
        try:
            tokens_cur = _db.push_tokens.find({"user_id": uid})
            async for tdoc in tokens_cur:
                token = tdoc.get("token")
                if not token or _send_push is None:
                    continue
                try:
                    await _send_push(
                        token,
                        "🔍 Spot the Object!",
                        f"You have 2 minutes — find a {target_object} for {group.get('name') or 'your group'}",
                        {
                            "kind": "spot_group_auto_challenge",
                            "group_id": gid,
                            "target_object": target_object,
                            "anchor_idx": anchor_idx,
                            "round_seconds": SPOT_GROUPS_ROUND_SECONDS,
                        },
                    )
                except Exception as e:
                    logger.warning("[spot-auto.push] %s: %s", uid, e)
        except Exception as e:
            logger.warning("[spot-auto.tokens] %s: %s", uid, e)

    if not recipients:
        attempts = len(defer["attempts"]) + 1
        if attempts >= SPOT_GROUPS_MAX_DEFERS:
            await _record_defer(
                group_id=gid, anchor_date=anchor_date, anchor_idx=anchor_idx,
                now_utc=now_utc, drop=True,
            )
        else:
            await _record_defer(
                group_id=gid, anchor_date=anchor_date, anchor_idx=anchor_idx,
                now_utc=now_utc, drop=False,
            )
        return {
            "recipients": [], "skipped_night": skipped_night,
            "skipped_sleeping": skipped_sleeping, "skipped_work": skipped_work,
            "deferred": True, "attempt": attempts,
            "dropped": attempts >= SPOT_GROUPS_MAX_DEFERS,
        }

    # Persist the challenge row + Phase 4 round_members + resolved=false.
    challenge_id = str(uuid.uuid4())
    await _db.spot_group_challenges.insert_one({
        "_id": challenge_id,
        "group_id": gid,
        "anchor_date": anchor_date,
        "anchor_idx": anchor_idx,
        "target_object": target_object,
        "scheduled_at_utc": anchor_at_utc.isoformat(),
        "fired_at_utc": now_utc.isoformat(),
        "round_ends_at_utc": (now_utc + timedelta(seconds=SPOT_GROUPS_ROUND_SECONDS)).isoformat(),
        "round_seconds": SPOT_GROUPS_ROUND_SECONDS,
        "recipients": recipients,
        "skipped_night": skipped_night,
        "skipped_sleeping": skipped_sleeping,
        "skipped_work": skipped_work,
        "resolved": False,
        "winners": [],
        "losers": [],
        "xp_per_winner": 0,
        "xp_per_loser": 0,
    })

    await _db.spot_groups.update_one(
        {"_id": gid},
        {"$set": {"last_challenge_at": now_utc.isoformat()}},
    )

    return {
        "recipients": recipients,
        "skipped_night": skipped_night,
        "skipped_sleeping": skipped_sleeping,
        "skipped_work": skipped_work,
        "challenge_id": challenge_id,
    }


async def _fire_anchor_if_due(anchor_idx: int, anchor: dict, anchor_date: str) -> int:
    """If the given anchor is in the past, fire it to every auto-on
    group that hasn't already received it. Returns the number of groups
    actually dispatched (deferred / dropped attempts don't count)."""
    at_utc = datetime.fromisoformat(anchor["at_utc"])
    if at_utc > datetime.now(timezone.utc):
        return 0
    already = set(anchor.get("fired_group_ids") or [])
    target_object = anchor["target_object"]

    fired = 0
    # Phase 4 — only fire to groups that have been STARTED. The legacy
    # `auto_challenge_on` flag is mirrored by `started` for backwards
    # compatibility, so either match works for existing groups.
    groups_cur = _db.spot_groups.find({
        "$or": [
            {"started": True},
            {"auto_challenge_on": True},
        ],
    })
    async for g in groups_cur:
        gid = g["_id"]
        if gid in already:
            continue
        try:
            res = await _dispatch_anchor_to_group(
                group=g,
                anchor_idx=anchor_idx,
                anchor_at_utc=at_utc,
                target_object=target_object,
            )
            if res.get("deferred"):
                # Don't mark fired_group_ids on a soft defer — the next
                # minute-tick (after the 1h cooldown) will retry. BUT
                # when MAX_DEFERS is exhausted and dispatch returned
                # `dropped:true`, mark fired_group_ids so we stop
                # retrying for the rest of the day.
                if res.get("dropped"):
                    await _db.spot_auto_anchors.update_one(
                        {"_id": anchor_date},
                        {"$addToSet": {f"times.{anchor_idx}.fired_group_ids": gid}},
                    )
                    logger.info(
                        "[spot-auto] anchor#%s %s DROPPED for group=%s (max defers)",
                        anchor_idx, target_object, gid,
                    )
                continue
            # Real dispatch — mark fired & bump counter.
            await _db.spot_auto_anchors.update_one(
                {"_id": anchor_date},
                {"$addToSet": {f"times.{anchor_idx}.fired_group_ids": gid}},
            )
            fired += 1
            logger.info(
                "[spot-auto] anchor#%s %s → group=%s recipients=%s skipped(night=%s,sleep=%s,work=%s)",
                anchor_idx, target_object, gid,
                len(res.get("recipients", [])),
                len(res.get("skipped_night", [])),
                len(res.get("skipped_sleeping", [])),
                len(res.get("skipped_work", [])),
            )
        except Exception:
            logger.exception("[spot-auto.dispatch] group=%s", gid)
    return fired


async def _resolve_round(challenge: dict) -> dict:
    """Phase 4 — close the 2-minute window on one challenge: compute
    winners/losers from spot_completions, apply XP, mark resolved.
    Idempotent (skips already-resolved rows)."""
    if challenge.get("resolved"):
        return {"already": True}
    gid = challenge["group_id"]
    cid = challenge["_id"]
    target = challenge.get("target_object")
    fired_at = challenge.get("fired_at_utc")
    ends_at = challenge.get("round_ends_at_utc")
    if not (target and fired_at and ends_at):
        return {"skipped": "missing-fields"}
    recipients = list(challenge.get("recipients") or [])
    if not recipients:
        await _db.spot_group_challenges.update_one(
            {"_id": cid},
            {"$set": {"resolved": True, "resolved_at_utc": datetime.now(timezone.utc).isoformat()}},
        )
        return {"empty_round": True}

    # Find members who posted a SUCCESSFUL photo of `target` within the
    # round window. We use the SAME boundary logic as the group feed
    # (taken_at >= fired_at AND taken_at < ends_at), success=true.
    posted_cur = _db.spot_completions.find({
        "user_id": {"$in": recipients},
        "target_object": target,
        "success": True,
        "taken_at": {"$gte": fired_at, "$lt": ends_at},
    }, {"_id": 0, "user_id": 1, "taken_at": 1})
    winners_set: set[str] = set()
    async for r in posted_cur:
        winners_set.add(r["user_id"])

    winners = sorted(winners_set)
    losers = sorted([u for u in recipients if u not in winners_set])

    n_w = len(winners)
    n_l = len(losers)
    xp_per_winner = SPOT_GROUPS_WIN_XP_PER_LOSER * n_l   # +5 × #losers
    xp_per_loser = -SPOT_GROUPS_LOSS_XP_PER_WINNER * n_w  # −1 × #winners

    # Apply XP delta to each player. We use $inc directly on
    # profile.total_xp (same convention used elsewhere in server.py for
    # XP gains/penalties). Floor at 0 to match the existing audit-fix
    # behaviour ("if total_xp < 0 then 0").
    if winners and xp_per_winner > 0:
        await _db.profile.update_many(
            {"_id": {"$in": winners}},
            {"$inc": {"total_xp": xp_per_winner}},
        )
    if losers and xp_per_loser < 0:
        await _db.profile.update_many(
            {"_id": {"$in": losers}},
            {"$inc": {"total_xp": xp_per_loser}},
        )
        # Floor at 0 — same as the audit job.
        await _db.profile.update_many(
            {"_id": {"$in": losers}, "total_xp": {"$lt": 0}},
            {"$set": {"total_xp": 0}},
        )

    await _db.spot_group_challenges.update_one(
        {"_id": cid},
        {"$set": {
            "resolved": True,
            "resolved_at_utc": datetime.now(timezone.utc).isoformat(),
            "winners": winners,
            "losers": losers,
            "xp_per_winner": xp_per_winner,
            "xp_per_loser": xp_per_loser,
        }},
    )
    logger.info(
        "[spot-auto.resolve] group=%s challenge=%s winners=%s losers=%s xp(+%s/%s)",
        gid, cid, n_w, n_l, xp_per_winner, xp_per_loser,
    )
    return {
        "winners": winners, "losers": losers,
        "xp_per_winner": xp_per_winner, "xp_per_loser": xp_per_loser,
    }


async def _resolve_due_rounds() -> int:
    """Find every UNRESOLVED challenge whose round_ends_at_utc <= now
    and resolve it. Returns the number of rounds resolved this tick."""
    if _db is None:
        return 0
    now_iso = datetime.now(timezone.utc).isoformat()
    cur = _db.spot_group_challenges.find({
        "resolved": {"$ne": True},
        "round_ends_at_utc": {"$lte": now_iso},
    })
    n = 0
    async for c in cur:
        try:
            await _resolve_round(c)
            n += 1
        except Exception:
            logger.exception("[spot-auto.resolve] failed %s", c.get("_id"))
    return n


async def spot_groups_auto_tick():
    """The minute-by-minute scheduler tick. Idempotent (fired_group_ids
    + per-anchor index guards prevent double-dispatch; resolved flag
    prevents double-XP)."""
    if _db is None:
        return
    try:
        anchors_doc = await _get_or_create_today_anchors()
        times = anchors_doc.get("times") or []
        for idx, anchor in enumerate(times):
            await _fire_anchor_if_due(idx, anchor, anchors_doc["_id"])
        # Phase 4 — close any expired 2-minute rounds.
        await _resolve_due_rounds()
    except Exception:
        logger.exception("[spot-auto.tick] failed")


# ───────────────────────── HTTP routes ─────────────────────────
def attach_routes(app, get_user_or_legacy, get_current_user):
    sub = APIRouter(prefix="/api", tags=["spot-groups-auto"])

    @sub.get("/spot/groups/{gid}/challenges")
    async def _list_challenges(gid: str, user_id: str = Depends(get_user_or_legacy)):
        if _db is None:
            return {"challenges": []}
        # Must be an active member.
        mem = await _db.spot_group_members.find_one(
            {"group_id": gid, "user_id": user_id, "left_at": None},
        )
        if not mem:
            raise HTTPException(403, "Not your group.")
        # Active member-id set so we can attribute responses correctly.
        members_cur = _db.spot_group_members.find({"group_id": gid, "left_at": None})
        member_ids: set[str] = set()
        async for mm in members_cur:
            member_ids.add(mm["user_id"])

        cur = _db.spot_group_challenges.find({"group_id": gid}).sort("fired_at_utc", -1).limit(20)
        challenges = []
        async for c in cur:
            challenges.append(c)

        # Phase 3 — for each challenge, attach the photos members posted
        # for that target_object since the anchor fired (response window
        # closes at the NEXT challenge's fired_at_utc, or now if it's the
        # latest one).
        out = []
        for i, c in enumerate(challenges):
            fired_at = c.get("fired_at_utc")
            # next-challenge boundary (challenges are sorted DESC, so the
            # PREVIOUS index = the next-newer one, which closes this
            # challenge's response window).
            next_boundary_iso = None
            if i > 0:
                next_boundary_iso = challenges[i - 1].get("fired_at_utc")
            target_object = c.get("target_object")
            responses = []
            if fired_at and target_object:
                q = {
                    "user_id": {"$in": list(member_ids)},
                    "target_object": target_object,
                    "taken_at": {"$gte": fired_at},
                    "success": True,
                }
                if next_boundary_iso:
                    q["taken_at"]["$lt"] = next_boundary_iso
                resp_cur = _db.spot_completions.find(
                    q,
                    {
                        "_id": 0, "id": 1, "user_id": 1, "photo_base64": 1,
                        "taken_at": 1, "remaining_seconds": 1,
                    },
                ).sort("taken_at", 1).limit(50)
                async for r in resp_cur:
                    responses.append({
                        "id": r.get("id"),
                        "user_id": r.get("user_id"),
                        "photo_base64": r.get("photo_base64"),
                        "taken_at": r.get("taken_at"),
                        "remaining_seconds": r.get("remaining_seconds"),
                    })
            out.append({
                "id": c["_id"],
                "group_id": c["group_id"],
                "anchor_date": c.get("anchor_date"),
                "anchor_idx": c.get("anchor_idx"),
                "target_object": target_object,
                "scheduled_at_utc": c.get("scheduled_at_utc"),
                "fired_at_utc": fired_at,
                "round_ends_at_utc": c.get("round_ends_at_utc"),
                "round_seconds": c.get("round_seconds", SPOT_GROUPS_ROUND_SECONDS),
                "recipients_count": len(c.get("recipients") or []),
                "skipped_sleeping_count": len(c.get("skipped_sleeping") or []),
                "skipped_work_count": len(c.get("skipped_work") or []),
                "skipped_night_count": len(c.get("skipped_night") or []),
                "you_received": user_id in (c.get("recipients") or []),
                "responses": responses,
                "response_count": len(responses),
                "you_responded": any(r.get("user_id") == user_id for r in responses),
                # Phase 4 round-result fields:
                "resolved": bool(c.get("resolved")),
                "resolved_at_utc": c.get("resolved_at_utc"),
                "winners": c.get("winners") or [],
                "losers": c.get("losers") or [],
                "xp_per_winner": c.get("xp_per_winner", 0),
                "xp_per_loser": c.get("xp_per_loser", 0),
                "you_won": user_id in (c.get("winners") or []),
                "you_lost": user_id in (c.get("losers") or []),
            })
        return {"challenges": out}

    @sub.get("/admin/spot/scheduler/today")
    async def _admin_today_anchors(user_id: str = Depends(get_current_user)):
        if _is_admin is None or not await _is_admin(user_id):
            raise HTTPException(403, "Creator only.")
        if _db is None:
            return {"anchors": None}
        anchors_doc = await _get_or_create_today_anchors()
        return {
            "date": anchors_doc["_id"],
            "times": anchors_doc.get("times") or [],
            "fired_group_counts": [
                len(t.get("fired_group_ids") or []) for t in (anchors_doc.get("times") or [])
            ],
        }

    @sub.post("/admin/spot/scheduler/force-tick")
    async def _admin_force_tick(user_id: str = Depends(get_current_user)):
        """For testing & on-demand dispatch. Force-creates an anchor for
        RIGHT NOW (in addition to today's regular 3) and fires it to all
        auto-on groups."""
        if _is_admin is None or not await _is_admin(user_id):
            raise HTTPException(403, "Creator only.")
        if _db is None:
            raise HTTPException(503, "DB not ready.")
        anchors_doc = await _get_or_create_today_anchors()
        now_utc = datetime.now(timezone.utc)
        forced_idx = len(anchors_doc.get("times") or [])
        forced_anchor = {
            "at_utc": now_utc.isoformat(),
            "target_object": random.choice(_spot_objects),
            "fired_group_ids": [],
            "forced": True,
        }
        await _db.spot_auto_anchors.update_one(
            {"_id": anchors_doc["_id"]},
            {"$push": {"times": forced_anchor}},
        )
        fired_groups = await _fire_anchor_if_due(forced_idx, forced_anchor, anchors_doc["_id"])
        return {
            "date": anchors_doc["_id"],
            "anchor_idx": forced_idx,
            "fired_to_groups": fired_groups,
            "target_object": forced_anchor["target_object"],
        }

    @sub.post("/admin/spot/scheduler/resolve-now")
    async def _admin_resolve_now(user_id: str = Depends(get_current_user)):
        """Phase 4 — admin endpoint to FORCE-RESOLVE every unresolved
        challenge regardless of round_ends_at_utc. Used by tests to
        bypass the 120s window. Returns counts + per-challenge result."""
        if _is_admin is None or not await _is_admin(user_id):
            raise HTTPException(403, "Creator only.")
        if _db is None:
            raise HTTPException(503, "DB not ready.")
        cur = _db.spot_group_challenges.find({"resolved": {"$ne": True}})
        results = []
        async for c in cur:
            try:
                r = await _resolve_round(c)
                results.append({
                    "challenge_id": c["_id"],
                    "group_id": c["group_id"],
                    **r,
                })
            except Exception as e:
                results.append({"challenge_id": c["_id"], "error": str(e)})
        return {"resolved": len(results), "results": results}

    app.include_router(sub)
    return sub
