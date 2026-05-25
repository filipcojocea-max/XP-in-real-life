"""
XP Penalty system — Creator/Admin-only feature.

Endpoints exposed:
  POST /api/admin/players/{player_id}/penalty   (creator only)
  GET  /api/penalties/pending                   (caller's unread penalties)
  POST /api/penalties/{penalty_id}/acknowledge  (caller marks as read)
  GET  /api/penalties/history                   (caller's full history)
  GET  /api/admin/players/{player_id}/penalties (creator only — view a player's history)

Mongo collection used:
  xp_penalties = {
      _id: uuid str,
      creator_id, player_id,
      amount: int (positive — represents XP subtracted),
      note: str,
      created_at: ISO UTC string,
      date: "YYYY-MM-DD" (for chart aggregation),
      acknowledged_at: ISO str | None,
  }

The penalty also writes a negative-XP entry into task_logs so it
shows up on the user's daily XP bar/line charts as a "black" segment
(client-side overlay keys off `penalty_xp` returned by stats endpoints).
"""
from __future__ import annotations

import uuid
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Wired in from server.py via init_penalties(...) at startup
_db = None
_is_admin_user = None
_get_user_or_legacy = None
_now_iso = None
_send_expo_push = None
_serialize_profile = None
_level_from_xp = None


def init_penalties(
    *,
    db,
    is_admin_user,
    get_user_or_legacy,
    now_iso,
    send_expo_push,
    serialize_profile,
    level_from_xp,
):
    """Wire dependencies from server.py so this module stays decoupled."""
    global _db, _is_admin_user, _get_user_or_legacy, _now_iso
    global _send_expo_push, _serialize_profile, _level_from_xp
    _db = db
    _is_admin_user = is_admin_user
    _get_user_or_legacy = get_user_or_legacy
    _now_iso = now_iso
    _send_expo_push = send_expo_push
    _serialize_profile = serialize_profile
    _level_from_xp = level_from_xp


router = APIRouter(prefix="/api")


class PenaltyBody(BaseModel):
    amount: int = Field(..., ge=1, le=10_000_000, description="XP to subtract (positive integer)")
    note: str = Field(default="", max_length=2000)


def _user_dep(user_id: str = Depends(lambda: None)):  # placeholder, overridden below
    return user_id


@router.post("/admin/players/{player_id}/penalty")
async def admin_apply_penalty(player_id: str, body: PenaltyBody):
    """Creator-only. Subtract XP from a player and queue a notification
    for them. Multiple penalties on the same day are summed visually.
    XP may go negative — level is recalculated from total XP."""
    # Resolve the calling user via the shared dependency. We invoke it
    # manually here because module-level `Depends(...)` would need the
    # real function injected at import time and we keep this decoupled.
    from fastapi import Request  # late import for typing only
    # NOTE: The real `caller_id` is injected by server.py via a wrapper
    # below — see `_attach_routes`. This stub stays for type-checkers.
    raise NotImplementedError("Wrapped by server.py")


# ─────────────────────── Implementation helpers ───────────────────────
async def _apply_penalty_impl(caller_id: str, player_id: str, body: PenaltyBody) -> dict:
    if not await _is_admin_user(caller_id):
        raise HTTPException(403, "Creator only.")
    if not player_id or player_id == caller_id:
        raise HTTPException(400, "Cannot penalize yourself.")

    target = await _db.profile.find_one({"_id": player_id})
    if not target:
        raise HTTPException(404, "Player not found.")

    amount = int(body.amount)
    note = (body.note or "").strip()
    now = _now_iso()
    today = datetime.now(timezone.utc).date().isoformat()

    pid = str(uuid.uuid4())
    doc = {
        "_id": pid,
        "creator_id": caller_id,
        "player_id": player_id,
        "amount": amount,
        "note": note,
        "created_at": now,
        "date": today,
        "acknowledged_at": None,
    }
    await _db.xp_penalties.insert_one(doc)

    # Subtract from total_xp atomically. XP allowed to go negative —
    # level is computed from total_xp on every read so it auto-recalcs.
    res = await _db.profile.find_one_and_update(
        {"_id": player_id},
        {"$inc": {"total_xp": -amount}},
        return_document=True,
    )
    new_total_xp = int((res or {}).get("total_xp", 0))
    new_level = int(_level_from_xp(max(0, new_total_xp)))

    # Persist computed level so it's authoritative on player cards.
    await _db.profile.update_one({"_id": player_id}, {"$set": {"level": new_level}})

    # Mirror into task_logs as a negative-XP row so charts can render
    # the day's penalty as a black segment without a separate query.
    log_row = {
        "_id": str(uuid.uuid4()),
        "user_id": player_id,
        "task_id": None,
        "date": today,
        "xp_awarded": -amount,
        "kind": "penalty",
        "penalty_id": pid,
        "note": note[:500],
        "completed_at": now,
    }
    try:
        await _db.task_logs.insert_one(log_row)
    except Exception:
        logger.exception("[penalty] task_logs mirror failed")

    # Fire-and-forget push notification (best-effort — modal will also
    # fire on next app-open via /penalties/pending).
    try:
        tokens = await _db.push_tokens.find({"user_id": player_id}).to_list(10)
        title = f"-{amount} XP from Creator"
        msg = (note[:120] + "…") if len(note) > 120 else (note or "Tap to view details")
        for t in tokens:
            tok = t.get("token") or t.get("push_token")
            if tok:
                await _send_expo_push(tok, title, msg, {"type": "penalty", "penalty_id": pid})
    except Exception:
        logger.exception("[penalty] push send failed")

    return {
        "ok": True,
        "penalty_id": pid,
        "player_id": player_id,
        "amount": amount,
        "note": note,
        "new_total_xp": new_total_xp,
        "new_level": new_level,
        "created_at": now,
    }


async def _pending_impl(caller_id: str) -> dict:
    rows = await _db.xp_penalties.find(
        {"player_id": caller_id, "acknowledged_at": None}
    ).sort("created_at", 1).to_list(50)
    return {"penalties": [_serialize_penalty(r) for r in rows]}


async def _acknowledge_impl(caller_id: str, penalty_id: str) -> dict:
    row = await _db.xp_penalties.find_one({"_id": penalty_id, "player_id": caller_id})
    if not row:
        raise HTTPException(404, "Penalty not found.")
    if row.get("acknowledged_at"):
        return {"ok": True, "already": True}
    await _db.xp_penalties.update_one(
        {"_id": penalty_id},
        {"$set": {"acknowledged_at": _now_iso()}},
    )
    return {"ok": True, "penalty_id": penalty_id}


async def _history_impl(caller_id: str, limit: int = 50) -> dict:
    rows = await _db.xp_penalties.find(
        {"player_id": caller_id}
    ).sort("created_at", -1).to_list(max(1, min(limit, 200)))
    return {"penalties": [_serialize_penalty(r) for r in rows]}


async def _player_history_impl(caller_id: str, player_id: str) -> dict:
    if not await _is_admin_user(caller_id):
        raise HTTPException(403, "Creator only.")
    rows = await _db.xp_penalties.find(
        {"player_id": player_id}
    ).sort("created_at", -1).to_list(200)
    return {"penalties": [_serialize_penalty(r) for r in rows]}


def _serialize_penalty(row: dict) -> dict:
    return {
        "id": row.get("_id"),
        "creator_id": row.get("creator_id"),
        "player_id": row.get("player_id"),
        "amount": int(row.get("amount", 0)),
        "note": row.get("note", ""),
        "created_at": row.get("created_at"),
        "date": row.get("date"),
        "acknowledged_at": row.get("acknowledged_at"),
    }


def attach_routes(app, get_user_or_legacy):
    """Build the live FastAPI routes here so they can use the real
    `Depends(get_user_or_legacy)` from server.py.

    Call this from server.py after init_penalties(...)."""
    sub = APIRouter(prefix="/api")

    @sub.post("/admin/players/{player_id}/penalty")
    async def _route_apply(player_id: str, body: PenaltyBody, user_id: str = Depends(get_user_or_legacy)):
        return await _apply_penalty_impl(user_id, player_id, body)

    @sub.get("/penalties/pending")
    async def _route_pending(user_id: str = Depends(get_user_or_legacy)):
        return await _pending_impl(user_id)

    @sub.post("/penalties/{penalty_id}/acknowledge")
    async def _route_ack(penalty_id: str, user_id: str = Depends(get_user_or_legacy)):
        return await _acknowledge_impl(user_id, penalty_id)

    @sub.get("/penalties/history")
    async def _route_history(user_id: str = Depends(get_user_or_legacy), limit: int = 50):
        return await _history_impl(user_id, limit)

    @sub.get("/admin/players/{player_id}/penalties")
    async def _route_player_history(player_id: str, user_id: str = Depends(get_user_or_legacy)):
        return await _player_history_impl(user_id, player_id)

    app.include_router(sub)
    return sub
