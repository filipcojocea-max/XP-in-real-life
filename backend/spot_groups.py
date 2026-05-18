"""
Spot the Object — Permanent Groups (v1.0.29 Phase 1)

The original Spot the Object multiplayer flow created a SINGLE one-off
"match" that vanished after play. Per the v1.0.29 spec we now also
support PERMANENT groups of up to 8 players that:

  • survive across days
  • carry an "auto-challenge" toggle (Phase 2 scheduler reads it)
  • track per-member status (active / left) — Phase 2 adds sleeping
    / at-work derived from the player's profile schedule
  • can be left silently (no broadcast, just a `left_at` stamp) and
    have new players added (max group size 8 always enforced).

Collections
───────────
  spot_groups       — { _id, name, owner_id, created_at,
                        auto_challenge_on, last_challenge_at,
                        timezone_seed? (Phase 2) }
  spot_group_members — { _id (uuid), group_id, user_id,
                         joined_at, left_at?, role:'owner'|'member' }

Endpoints (all under /api/spot)
───────────────────────────────
  POST   /groups              — create with member_ids[]≤8 (incl owner)
  GET    /groups              — list active groups for caller
  GET    /groups/{id}         — detail with members
  POST   /groups/{id}/members — add players (cap 8 total)
  POST   /groups/{id}/leave   — soft-leave (sets left_at, no push)
  PATCH  /groups/{id}         — update name + auto_challenge_on
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException

logger = logging.getLogger(__name__)

# Wired by init_spot_groups() at app startup so we don't have to import
# from server.py (which would be a circular import).
_db = None
_now_iso = None
_friend_ids_fn = None

MAX_GROUP_SIZE = 8


def init_spot_groups(*, db, now_iso, friend_ids_fn):
    global _db, _now_iso, _friend_ids_fn
    _db = db
    _now_iso = now_iso
    _friend_ids_fn = friend_ids_fn


# ───────────────────────── helpers ─────────────────────────
async def _profile_summary(uid: str) -> dict:
    """{id, name, avatar_base64, timezone} — used by every list/detail."""
    if _db is None:
        return {"id": uid, "name": "Player", "avatar_base64": None, "timezone": None}
    p = await _db.profile.find_one(
        {"_id": uid},
        {"full_name": 1, "name": 1, "avatar_base64": 1, "timezone": 1},
    ) or {}
    return {
        "id": uid,
        "name": p.get("full_name") or p.get("name") or "Player",
        "avatar_base64": p.get("avatar_base64"),
        "timezone": p.get("timezone"),
    }


async def _active_member_count(group_id: str) -> int:
    if _db is None:
        return 0
    return await _db.spot_group_members.count_documents({
        "group_id": group_id,
        "left_at": None,
    })


async def _is_active_member(group_id: str, user_id: str) -> bool:
    if _db is None:
        return False
    doc = await _db.spot_group_members.find_one({
        "group_id": group_id,
        "user_id": user_id,
        "left_at": None,
    })
    return doc is not None


async def _serialize_group(g: dict, viewer_id: str) -> dict:
    """Returns the group meta + member list with statuses.

    For Phase 1 statuses are: 'active' | 'left'.
    Phase 2 will derive 'sleeping' / 'at_work' from each member's
    profile.work_schedule + sleep_schedule + timezone.
    """
    members_cur = _db.spot_group_members.find(
        {"group_id": g["_id"]}
    ).sort([("joined_at", 1)])
    members = []
    async for m in members_cur:
        prof = await _profile_summary(m["user_id"])
        status = "left" if m.get("left_at") else "active"
        members.append({
            "user_id": m["user_id"],
            "name": prof["name"],
            "avatar_base64": prof["avatar_base64"],
            "timezone": prof.get("timezone"),
            "role": m.get("role", "member"),
            "status": status,
            "joined_at": m.get("joined_at"),
            "left_at": m.get("left_at"),
        })
    active_count = sum(1 for m in members if m["status"] == "active")
    return {
        "id": g["_id"],
        "name": g.get("name") or "Spot Group",
        "owner_id": g.get("owner_id"),
        "created_at": g.get("created_at"),
        "auto_challenge_on": bool(g.get("auto_challenge_on", False)),
        "last_challenge_at": g.get("last_challenge_at"),
        "member_count": active_count,
        "max_members": MAX_GROUP_SIZE,
        "viewer_is_member": any(
            m["user_id"] == viewer_id and m["status"] == "active" for m in members
        ),
        "members": members,
    }


# ───────────────────────── routes ─────────────────────────
def attach_routes(app, get_user_or_legacy):
    sub = APIRouter(prefix="/api", tags=["spot-groups"])

    @sub.post("/spot/groups")
    async def _create_group(
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        raw_ids = body.get("member_ids") or []
        if not isinstance(raw_ids, list):
            raise HTTPException(400, "member_ids must be a list")
        # Caller is implicitly the owner — dedupe + include them.
        member_ids = list(dict.fromkeys(
            [str(x).strip() for x in raw_ids if str(x).strip()] + [user_id]
        ))
        if len(member_ids) > MAX_GROUP_SIZE:
            raise HTTPException(
                400,
                f"Groups can have at most {MAX_GROUP_SIZE} players "
                f"(you tried {len(member_ids)}).",
            )
        if len(member_ids) < 2:
            raise HTTPException(400, "Pick at least one friend to add to the group.")
        # Validate friendship for every invitee.
        friend_set = set()
        if _friend_ids_fn is not None:
            try:
                friend_set = set(await _friend_ids_fn(user_id))
            except Exception:
                logger.exception("[spot-groups] friend ids fetch failed")
                friend_set = set()
        bad = [m for m in member_ids if m != user_id and m not in friend_set]
        if bad:
            raise HTTPException(
                403,
                "You can only group accepted friends. "
                f"({len(bad)} invitee not your friend)",
            )

        name = (body.get("name") or "").strip()[:60]
        if not name:
            # Default: "Spot Group · 12 May" so users can rename later.
            try:
                d = datetime.now(timezone.utc).strftime("%-d %b")
            except Exception:
                d = "today"
            name = f"Spot Group · {d}"

        gid = str(uuid.uuid4())
        now = _now_iso()
        await _db.spot_groups.insert_one({
            "_id": gid,
            "name": name,
            "owner_id": user_id,
            "created_at": now,
            "auto_challenge_on": False,
            "last_challenge_at": None,
        })
        # Membership rows (one per player) — owner first.
        members = []
        for mid in member_ids:
            members.append({
                "_id": str(uuid.uuid4()),
                "group_id": gid,
                "user_id": mid,
                "joined_at": now,
                "left_at": None,
                "role": "owner" if mid == user_id else "member",
            })
        if members:
            await _db.spot_group_members.insert_many(members)
        g = await _db.spot_groups.find_one({"_id": gid})
        return {"group": await _serialize_group(g, user_id)}

    @sub.get("/spot/groups")
    async def _list_groups(user_id: str = Depends(get_user_or_legacy)):
        # Groups where the caller has an ACTIVE membership.
        my_memberships = _db.spot_group_members.find({
            "user_id": user_id,
            "left_at": None,
        })
        gids = []
        async for m in my_memberships:
            gids.append(m["group_id"])
        if not gids:
            return {"groups": []}
        groups_cur = _db.spot_groups.find({"_id": {"$in": gids}}).sort(
            "created_at", -1
        )
        out = []
        async for g in groups_cur:
            out.append(await _serialize_group(g, user_id))
        return {"groups": out}

    @sub.get("/spot/groups/{gid}")
    async def _get_group(gid: str, user_id: str = Depends(get_user_or_legacy)):
        if not await _is_active_member(gid, user_id):
            raise HTTPException(403, "Not your group.")
        g = await _db.spot_groups.find_one({"_id": gid})
        if not g:
            raise HTTPException(404, "Group not found.")
        return {"group": await _serialize_group(g, user_id)}

    @sub.post("/spot/groups/{gid}/members")
    async def _add_members(
        gid: str,
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        if not await _is_active_member(gid, user_id):
            raise HTTPException(403, "Not your group.")
        raw_ids = body.get("member_ids") or []
        if not isinstance(raw_ids, list) or not raw_ids:
            raise HTTPException(400, "member_ids must be a non-empty list")
        to_add = [str(x).strip() for x in raw_ids if str(x).strip()]
        # Validate friendship for each new player from the CALLER.
        friend_set = set()
        if _friend_ids_fn is not None:
            try:
                friend_set = set(await _friend_ids_fn(user_id))
            except Exception:
                friend_set = set()
        bad = [m for m in to_add if m != user_id and m not in friend_set]
        if bad:
            raise HTTPException(
                403, "You can only add accepted friends to a group.",
            )
        # Filter out anyone already an ACTIVE member.
        existing_cur = _db.spot_group_members.find({
            "group_id": gid, "left_at": None,
        })
        existing_ids = set()
        async for m in existing_cur:
            existing_ids.add(m["user_id"])
        truly_new = [m for m in to_add if m not in existing_ids]

        # Reactivate anyone who LEFT earlier (clear left_at).
        await _db.spot_group_members.update_many(
            {"group_id": gid, "user_id": {"$in": to_add}, "left_at": {"$ne": None}},
            {"$set": {"left_at": None, "rejoined_at": _now_iso()}},
        )

        active_after = await _active_member_count(gid) + len(truly_new)
        if active_after > MAX_GROUP_SIZE:
            raise HTTPException(
                400,
                f"Adding these players would exceed the {MAX_GROUP_SIZE}-player cap "
                f"({active_after} active after add).",
            )
        if truly_new:
            now = _now_iso()
            await _db.spot_group_members.insert_many([
                {
                    "_id": str(uuid.uuid4()),
                    "group_id": gid,
                    "user_id": mid,
                    "joined_at": now,
                    "left_at": None,
                    "role": "member",
                }
                for mid in truly_new
            ])
        g = await _db.spot_groups.find_one({"_id": gid})
        return {
            "group": await _serialize_group(g, user_id),
            "added": truly_new,
            "reactivated": [m for m in to_add if m not in truly_new],
        }

    @sub.post("/spot/groups/{gid}/leave")
    async def _leave_group(gid: str, user_id: str = Depends(get_user_or_legacy)):
        # Soft-leave — set left_at on the membership. We deliberately
        # do NOT broadcast a push (per spec: "no notification is sent
        # to the group"). The remaining members will see "Left this
        # group at <ts>" next to the player's name on their next view.
        now = _now_iso()
        res = await _db.spot_group_members.update_one(
            {"group_id": gid, "user_id": user_id, "left_at": None},
            {"$set": {"left_at": now}},
        )
        if not res.matched_count:
            raise HTTPException(404, "You're not a member of this group.")
        # If the leaver was the owner and others remain, promote the
        # oldest remaining active member to owner so the group is never
        # left orphaned.
        g = await _db.spot_groups.find_one({"_id": gid})
        if g and g.get("owner_id") == user_id:
            next_owner = await _db.spot_group_members.find_one(
                {"group_id": gid, "left_at": None},
                sort=[("joined_at", 1)],
            )
            if next_owner:
                await _db.spot_groups.update_one(
                    {"_id": gid},
                    {"$set": {"owner_id": next_owner["user_id"]}},
                )
                await _db.spot_group_members.update_one(
                    {"_id": next_owner["_id"]},
                    {"$set": {"role": "owner"}},
                )
        return {"left_at": now}

    @sub.patch("/spot/groups/{gid}")
    async def _patch_group(
        gid: str,
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        # Anyone in the group can flip the auto-challenge toggle (per
        # spec: "any member of the group can toggle this setting").
        if not await _is_active_member(gid, user_id):
            raise HTTPException(403, "Not your group.")
        updates: dict = {}
        if "name" in body:
            nm = (body.get("name") or "").strip()[:60]
            if nm:
                updates["name"] = nm
        if "auto_challenge_on" in body:
            updates["auto_challenge_on"] = bool(body.get("auto_challenge_on"))
        if not updates:
            raise HTTPException(400, "No editable fields in body.")
        await _db.spot_groups.update_one({"_id": gid}, {"$set": updates})
        g = await _db.spot_groups.find_one({"_id": gid})
        return {"group": await _serialize_group(g, user_id)}

    app.include_router(sub)
    return sub
