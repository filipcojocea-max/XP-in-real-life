"""
Creator-only Admin Player Tools (v1.0.29).

Three feature areas, all admin-only:

  1. Per-player price overrides
       Creator sets a custom price for a specific player on any of the 4
       Library+ mini-apps. The override beats the public/solo/duo price
       and is only visible to THAT player. Used for refunds, MVP early-
       access discounts, comp tickets, etc.

  2. Delete player account
       Hard-delete a player. Two-step confirmation (UI types DELETE)
       cascades to every collection that references the user_id so no
       orphaned rows are left behind. Admin/Creator accounts are
       protected — `_is_admin_user` short-circuits.

  3. Inactive accounts
       Lists players sorted longest-inactive → shortest-inactive,
       filtered by bucket (2 weeks / 1 month / 6 months). Inactivity =
       max(profile.last_seen_at, latest task_logs.completed_at).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException

logger = logging.getLogger(__name__)

# ─── wired by init_admin_player_tools ───
_db = None
_is_admin_user = None
_now_iso = None
_library_app_ids: list[str] = []
_supported_currencies: list[str] = []
_default_currency = "USD"


def init_admin_player_tools(
    *,
    db,
    is_admin_user,
    now_iso,
    library_app_ids: list[str],
    supported_currencies: list[str],
    default_currency: str = "USD",
):
    global _db, _is_admin_user, _now_iso
    global _library_app_ids, _supported_currencies, _default_currency
    _db = db
    _is_admin_user = is_admin_user
    _now_iso = now_iso
    _library_app_ids = list(library_app_ids)
    _supported_currencies = list(supported_currencies)
    _default_currency = default_currency


# ═════════════════════════ public helpers ═════════════════════════
async def get_price_override_for(user_id: str, app_id: str) -> Optional[dict]:
    """Used by server.py library_pricing_get to fold the override into
    each app's public payload. Returns dict {override_price, currency}
    or None when no override exists."""
    if app_id not in _library_app_ids or not user_id:
        return None
    row = await _db.library_price_overrides.find_one(
        {"_id": f"{user_id}:{app_id}"}
    )
    if not row:
        return None
    return {
        "override_price": round(float(row.get("override_price") or 0.0), 2),
        "currency": (row.get("currency") or _default_currency).upper(),
    }


# ═════════════════════ cascade delete impl ════════════════════════
# Collections that store user-scoped rows keyed on user_id (or equivalent).
# When deleting an account we wipe every row matching the user across all of
# these so no orphans remain. Each tuple is (collection_name, field_name).
USER_COLLECTIONS: list[tuple[str, str]] = [
    ("users", "_id"),
    ("profile", "_id"),
    ("tasks", "user_id"),
    ("goals", "user_id"),
    ("task_logs", "user_id"),
    ("library_purchases", "user_id"),
    ("xp_penalties", "player_id"),
    ("penalties", "player_id"),
    ("friends", "user_id"),
    ("friend_requests", "from_user_id"),
    ("notifications", "user_id"),
    ("push_tokens", "user_id"),
    ("chat_preferences", "owner_id"),
    ("library_price_overrides", "user_id"),
    ("gifts", "to_user_id"),
    ("xp_events", "user_id"),
    ("badges_unlocked", "user_id"),
    ("achievements", "user_id"),
    ("ratings", "user_id"),
    ("feedback", "user_id"),
]


async def _cascade_delete_account(user_id: str) -> dict:
    """Hard-delete every row that references the user. Returns a per-
    collection count of deleted rows for the admin UI receipt.

    Special-cases:
      • messages — delete where from_user_id OR to_user_id matches.
      • friends  — delete rows where the user is owner_id OR friend_id.
      • friend_requests — delete rows where from OR to matches.
      • duo_groups — REMOVE this user from members[] only; if they were
        the host, mark the group expired (don't hard-delete so other
        members keep their rows).
      • chat_preferences — also delete rows where friend_id matches so
        no leftover preferences for the deleted player exist anywhere.
    """
    summary: dict[str, int] = {}

    # Standard single-field collections
    for coll, field in USER_COLLECTIONS:
        try:
            res = await _db[coll].delete_many({field: user_id})
            if res.deleted_count:
                summary[coll] = res.deleted_count
        except Exception:
            logger.exception("[admin-delete] %s delete failed", coll)

    # messages — two directions
    try:
        res = await _db.messages.delete_many(
            {"$or": [{"from_user_id": user_id}, {"to_user_id": user_id}]}
        )
        if res.deleted_count:
            summary["messages"] = res.deleted_count
    except Exception:
        logger.exception("[admin-delete] messages")

    # friends — owner_id OR friend_id (defensive, depends on schema)
    try:
        res = await _db.friends.delete_many(
            {"$or": [{"user_id": user_id}, {"friend_id": user_id}, {"owner_id": user_id}]}
        )
        if res.deleted_count:
            summary["friends"] = max(summary.get("friends", 0), res.deleted_count)
    except Exception:
        logger.exception("[admin-delete] friends-both")

    # friend_requests — both directions
    try:
        res = await _db.friend_requests.delete_many(
            {"$or": [{"from_user_id": user_id}, {"to_user_id": user_id}]}
        )
        if res.deleted_count:
            summary["friend_requests"] = max(summary.get("friend_requests", 0), res.deleted_count)
    except Exception:
        logger.exception("[admin-delete] friend_requests")

    # chat_preferences — also rows where this user is the friend_id
    try:
        res = await _db.chat_preferences.delete_many({"friend_id": user_id})
        if res.deleted_count:
            summary["chat_preferences"] = (
                summary.get("chat_preferences", 0) + res.deleted_count
            )
    except Exception:
        logger.exception("[admin-delete] chat_preferences friend-side")

    # gifts from this user too
    try:
        res = await _db.gifts.delete_many({"from_user_id": user_id})
        if res.deleted_count:
            summary["gifts"] = summary.get("gifts", 0) + res.deleted_count
    except Exception:
        logger.exception("[admin-delete] gifts from-side")

    # duo_groups — remove user from members, expire any group they hosted
    try:
        hosted = _db.duo_groups.find({"host_id": user_id})
        async for g in hosted:
            await _db.duo_groups.update_one(
                {"_id": g["_id"]},
                {"$set": {"status": "expired", "completed_at": _now_iso()}},
            )
            summary["duo_groups_hosted_expired"] = (
                summary.get("duo_groups_hosted_expired", 0) + 1
            )
        # Pull the user out of any group's members array.
        res = await _db.duo_groups.update_many(
            {"members.user_id": user_id},
            {"$pull": {"members": {"user_id": user_id}}},
        )
        if res.modified_count:
            summary["duo_groups_member_pulled"] = res.modified_count
    except Exception:
        logger.exception("[admin-delete] duo_groups cleanup")

    return summary


# ═════════════════════════ endpoint impls ═════════════════════════
async def _list_overrides_impl(caller_id: str, target_id: str) -> dict:
    if not await _is_admin_user(caller_id):
        raise HTTPException(403, "Creator only.")
    rows = await _db.library_price_overrides.find(
        {"user_id": target_id}
    ).to_list(50)
    overrides: dict[str, dict] = {}
    for r in rows:
        overrides[r.get("app_id")] = {
            "app_id": r.get("app_id"),
            "override_price": round(float(r.get("override_price") or 0.0), 2),
            "currency": (r.get("currency") or _default_currency).upper(),
            "updated_at": r.get("updated_at"),
        }
    return {"overrides": overrides, "user_id": target_id}


async def _upsert_override_impl(
    caller_id: str, target_id: str, app_id: str, body: dict
) -> dict:
    if not await _is_admin_user(caller_id):
        raise HTTPException(403, "Creator only.")
    if app_id not in _library_app_ids:
        raise HTTPException(400, f"Invalid app_id. Must be one of {_library_app_ids}")
    # Ensure target exists
    target_prof = await _db.profile.find_one({"_id": target_id})
    if not target_prof:
        raise HTTPException(404, "Player not found.")
    try:
        op = float(body.get("override_price"))
    except (TypeError, ValueError):
        raise HTTPException(400, "override_price must be a number")
    if op < 0 or op > 100000:
        raise HTTPException(400, "override_price out of range (0..100000)")
    currency = (body.get("currency") or _default_currency).upper()
    if currency not in _supported_currencies:
        raise HTTPException(400, f"currency must be one of {_supported_currencies}")
    now = _now_iso()
    await _db.library_price_overrides.update_one(
        {"_id": f"{target_id}:{app_id}"},
        {
            "$set": {
                "user_id": target_id,
                "app_id": app_id,
                "override_price": round(op, 2),
                "currency": currency,
                "updated_at": now,
                "set_by": caller_id,
            },
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )
    return await _list_overrides_impl(caller_id, target_id)


async def _clear_override_impl(
    caller_id: str, target_id: str, app_id: str
) -> dict:
    if not await _is_admin_user(caller_id):
        raise HTTPException(403, "Creator only.")
    if app_id not in _library_app_ids:
        raise HTTPException(400, f"Invalid app_id. Must be one of {_library_app_ids}")
    await _db.library_price_overrides.delete_one(
        {"_id": f"{target_id}:{app_id}"}
    )
    return await _list_overrides_impl(caller_id, target_id)


async def _delete_account_impl(caller_id: str, target_id: str, body: dict) -> dict:
    if not await _is_admin_user(caller_id):
        raise HTTPException(403, "Creator only.")
    if caller_id == target_id:
        raise HTTPException(400, "You cannot delete your own account.")
    confirm = str(body.get("confirm") or "").strip()
    if confirm != "DELETE":
        raise HTTPException(
            400, "confirm must be the exact string 'DELETE' (case-sensitive)."
        )
    target_user = await _db.users.find_one({"_id": target_id})
    target_prof = await _db.profile.find_one({"_id": target_id})
    if not target_user and not target_prof:
        raise HTTPException(404, "Player not found.")
    # Refuse to delete another admin account — protect creators from each other.
    if await _is_admin_user(target_id):
        raise HTTPException(403, "Cannot delete another Creator account.")
    deleted_email = (target_user or {}).get("email")
    deleted_name = (target_prof or {}).get("full_name") or (target_prof or {}).get("name")
    summary = await _cascade_delete_account(target_id)
    logger.warning(
        "[admin-delete] caller=%s deleted user_id=%s email=%s summary=%s",
        caller_id, target_id, deleted_email, summary,
    )
    return {
        "deleted": True,
        "user_id": target_id,
        "email": deleted_email,
        "name": deleted_name,
        "summary": summary,
    }


async def _inactive_players_impl(caller_id: str, bucket: str) -> dict:
    if not await _is_admin_user(caller_id):
        raise HTTPException(403, "Creator only.")
    threshold_map = {
        "2w": timedelta(weeks=2),
        "1m": timedelta(days=30),
        "6m": timedelta(days=180),
    }
    if bucket not in threshold_map:
        raise HTTPException(
            400, "bucket must be one of '2w', '1m', '6m'"
        )
    threshold = threshold_map[bucket]
    now = datetime.now(timezone.utc)
    cutoff = now - threshold

    # Fetch every profile. For each, compute the "last_active" timestamp =
    # max(profile.last_seen_at, latest task_logs.completed_at for this user).
    rows = []
    profiles = await _db.profile.find({}).to_list(5000)
    # Pre-aggregate latest task_log per user_id in one pass.
    last_log_by_user: dict[str, datetime] = {}
    cur = _db.task_logs.find({}, {"_id": 0, "user_id": 1, "completed_at": 1})
    async for log in cur:
        uid = log.get("user_id")
        ts_raw = log.get("completed_at")
        if not uid or not ts_raw:
            continue
        try:
            ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        prev = last_log_by_user.get(uid)
        if prev is None or ts > prev:
            last_log_by_user[uid] = ts

    for prof in profiles:
        uid = prof.get("_id")
        if not uid:
            continue
        # Skip admin/creator accounts — they don't go on the inactive list.
        if await _is_admin_user(uid):
            continue
        # Compute last_active = max(last_seen_at, latest task_log)
        last_seen_raw = prof.get("last_seen_at")
        last_seen_dt: Optional[datetime] = None
        if last_seen_raw:
            try:
                last_seen_dt = datetime.fromisoformat(
                    str(last_seen_raw).replace("Z", "+00:00")
                )
                if last_seen_dt.tzinfo is None:
                    last_seen_dt = last_seen_dt.replace(tzinfo=timezone.utc)
            except Exception:
                last_seen_dt = None
        log_dt = last_log_by_user.get(uid)
        candidates = [d for d in (last_seen_dt, log_dt) if d is not None]
        if not candidates:
            # Never seen, never earned XP — treat created_at as the
            # last-active timestamp so freshly registered accounts don't
            # accidentally count as inactive 6m+.
            try:
                created_at = datetime.fromisoformat(
                    str(prof.get("created_at") or "").replace("Z", "+00:00")
                )
                if created_at.tzinfo is None:
                    created_at = created_at.replace(tzinfo=timezone.utc)
                last_active = created_at
            except Exception:
                # Bad/missing created_at → skip the user entirely.
                continue
        else:
            last_active = max(candidates)
        if last_active > cutoff:
            continue  # Still active relative to this bucket.
        u = await _db.users.find_one({"_id": uid}, {"email": 1}) or {}
        days_inactive = int((now - last_active).total_seconds() // 86400)
        rows.append({
            "user_id": uid,
            "name": prof.get("full_name") or prof.get("name") or "Anonymous",
            "email": u.get("email", ""),
            "avatar_base64": prof.get("avatar_base64"),
            "level": int(prof.get("level") or 1),
            "total_xp": int(prof.get("total_xp") or 0),
            "last_active_at": last_active.isoformat(),
            "days_inactive": days_inactive,
        })
    # Sort longest-inactive first.
    rows.sort(key=lambda r: r["days_inactive"], reverse=True)
    return {
        "bucket": bucket,
        "threshold_days": int(threshold.total_seconds() // 86400),
        "count": len(rows),
        "players": rows,
    }


# ═════════════════════════ routes ═════════════════════════
def attach_routes(app, get_user_or_legacy):
    sub = APIRouter(prefix="/api")

    @sub.get("/admin/players/{user_id}/price-overrides")
    async def _list_overrides(
        user_id: str, caller_id: str = Depends(get_user_or_legacy)
    ):
        return await _list_overrides_impl(caller_id, user_id)

    @sub.post("/admin/players/{user_id}/price-overrides/{app_id}")
    async def _upsert_override(
        user_id: str,
        app_id: str,
        body: dict = Body(...),
        caller_id: str = Depends(get_user_or_legacy),
    ):
        return await _upsert_override_impl(caller_id, user_id, app_id, body)

    @sub.delete("/admin/players/{user_id}/price-overrides/{app_id}")
    async def _clear_override(
        user_id: str, app_id: str, caller_id: str = Depends(get_user_or_legacy)
    ):
        return await _clear_override_impl(caller_id, user_id, app_id)

    @sub.delete("/admin/players/{user_id}")
    async def _delete_account(
        user_id: str,
        body: dict = Body(...),
        caller_id: str = Depends(get_user_or_legacy),
    ):
        return await _delete_account_impl(caller_id, user_id, body)

    @sub.get("/admin/players/inactive")
    async def _inactive_players(
        bucket: str = "2w", caller_id: str = Depends(get_user_or_legacy)
    ):
        return await _inactive_players_impl(caller_id, bucket)

    app.include_router(sub)
    return sub
