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
_availability_fn = None
# Phase 4 — when wired, called once per invited user with
#   (user_id:str, title:str, body:str, data:dict). Best-effort; failures
#   are logged but don't break the create/add flow.
_push_to_user_fn = None

MAX_GROUP_SIZE = 8


def init_spot_groups(*, db, now_iso, friend_ids_fn, availability_fn=None, push_to_user_fn=None):
    global _db, _now_iso, _friend_ids_fn, _availability_fn, _push_to_user_fn
    _db = db
    _now_iso = now_iso
    _friend_ids_fn = friend_ids_fn
    _availability_fn = availability_fn
    _push_to_user_fn = push_to_user_fn


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


async def _is_accepted_member(group_id: str, user_id: str) -> bool:
    """Phase 4 — distinguishes accepted vs pending invitees. Pending
    users can VIEW the group (to see the Accept/Decline buttons) but
    can't add players, leave-as-decline, or toggle settings until they
    accept."""
    if _db is None:
        return False
    doc = await _db.spot_group_members.find_one({
        "group_id": group_id,
        "user_id": user_id,
        "left_at": None,
    })
    if not doc:
        return False
    return (doc.get("status") or "accepted") == "accepted"


async def _membership(group_id: str, user_id: str) -> Optional[dict]:
    if _db is None:
        return None
    return await _db.spot_group_members.find_one({
        "group_id": group_id,
        "user_id": user_id,
    })


async def _serialize_group(g: dict, viewer_id: str) -> dict:
    """Returns the group meta + member list with statuses.

    Phase 3 — member.status is now one of:
      'left'      — soft-left/declined the group (left_at != null)
      'pending'   — invited but hasn't accepted yet
      'off'       — accepted but has muted their per-member toggle
      'sleeping'  — accepted+on, in their Adaptive Work-Life Scheduler sleep window
      'at_work'   — accepted+on, between shift start_time and work_end_time
      'active'    — accepted+on, awake, off-work (the only state that
                    receives challenge pushes if also in daylight)
    A member is considered to be 'in the lobby' (counts toward the 8-cap
    and shows up in this list) so long as `left_at` is null.
    """
    members_cur = _db.spot_group_members.find(
        {"group_id": g["_id"]}
    ).sort([("joined_at", 1)])
    members = []
    member_ids_pending: list[str] = []
    raw_rows: list[dict] = []
    async for m in members_cur:
        raw_rows.append(m)
        if not m.get("left_at") and (m.get("status") in (None, "accepted")):
            member_ids_pending.append(m["user_id"])
    profs_full: dict[str, dict] = {}
    if member_ids_pending:
        profs_cur = _db.profile.find(
            {"_id": {"$in": member_ids_pending}},
            {
                "full_name": 1, "name": 1, "avatar_base64": 1,
                "timezone": 1, "shift_schedule": 1,
                "day_start_time": 1, "wake_time": 1,
            },
        )
        async for pf in profs_cur:
            profs_full[pf["_id"]] = pf

    pending_count = 0
    accepted_count = 0
    for m in raw_rows:
        prof = await _profile_summary(m["user_id"])
        # Backwards compatibility — legacy rows without `status` are
        # treated as already-accepted (preserves Phase 1/2 behaviour).
        raw_status = m.get("status")
        if raw_status is None:
            raw_status = "accepted"
        notifications_on = m.get("notifications_on", True)

        if m.get("left_at"):
            status = "left"
        elif raw_status == "pending":
            status = "pending"
            pending_count += 1
        elif notifications_on is False:
            status = "off"
            accepted_count += 1
        else:
            accepted_count += 1
            status = "active"
            if _availability_fn is not None:
                try:
                    pf = profs_full.get(m["user_id"]) or {}
                    s = _availability_fn(pf)
                    if s in ("sleeping", "at_work", "active"):
                        status = s
                except Exception as e:
                    logger.warning("[spot_groups.avail] %s: %s", m["user_id"], e)

        members.append({
            "user_id": m["user_id"],
            "name": prof["name"],
            "avatar_base64": prof["avatar_base64"],
            "timezone": prof.get("timezone"),
            "role": m.get("role", "member"),
            "status": status,
            "notifications_on": notifications_on,
            "accepted_at": m.get("accepted_at"),
            "joined_at": m.get("joined_at"),
            "left_at": m.get("left_at"),
        })
    # active_count = non-left members (incl. pending). max_members cap
    # applies to this count.
    active_count = sum(1 for m in members if m["status"] != "left")
    started = bool(g.get("started", False))
    # All-accepted = no pending invites among non-left members. The
    # "Start new game" button only enables in this state.
    all_accepted = pending_count == 0 and accepted_count > 0
    # Viewer's own membership state — drives Accept/Decline buttons.
    viewer_row = next((m for m in members if m["user_id"] == viewer_id), None)
    viewer_status = (viewer_row or {}).get("status", "none")
    return {
        "id": g["_id"],
        "name": g.get("name") or "Spot Group",
        "owner_id": g.get("owner_id"),
        "created_at": g.get("created_at"),
        "started": started,
        "started_at": g.get("started_at"),
        # Backwards compat — Phase 2 ticks read `auto_challenge_on`. We
        # mirror it to `started` so old code keeps working.
        "auto_challenge_on": started,
        "last_challenge_at": g.get("last_challenge_at"),
        "member_count": active_count,
        "pending_count": pending_count,
        "accepted_count": accepted_count,
        "all_accepted": all_accepted,
        "max_members": MAX_GROUP_SIZE,
        "viewer_is_member": any(
            m["user_id"] == viewer_id and m["status"] != "left" for m in members
        ),
        "viewer_status": viewer_status,
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
            "started": False,
            "started_at": None,
            "auto_challenge_on": False,  # mirrors `started` after Phase 4
            "last_challenge_at": None,
        })
        # Membership rows — creator is auto-accepted, everyone else is
        # 'pending' (must accept via POST /spot/groups/{gid}/accept).
        members = []
        for mid in member_ids:
            is_self = mid == user_id
            members.append({
                "_id": str(uuid.uuid4()),
                "group_id": gid,
                "user_id": mid,
                "joined_at": now,
                "left_at": None,
                "role": "owner" if is_self else "member",
                "status": "accepted" if is_self else "pending",
                "accepted_at": now if is_self else None,
                "notifications_on": True,
            })
        if members:
            await _db.spot_group_members.insert_many(members)

        # Push invitations to every invitee. Best-effort — push failures
        # don't break the create flow.
        if _push_to_user_fn is not None:
            try:
                inviter_prof = await _profile_summary(user_id)
                inviter_name = inviter_prof.get("name") or "A friend"
            except Exception:
                inviter_name = "A friend"
            for mid in member_ids:
                if mid == user_id:
                    continue
                try:
                    await _push_to_user_fn(
                        mid,
                        "👀 You've been invited!",
                        f"{inviter_name} invited you to a Spot the Object group: {name}",
                        {"kind": "spot_group_invite", "group_id": gid},
                    )
                except Exception as e:
                    logger.warning("[spot-groups.invite-push] %s: %s", mid, e)

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
        # Both ACCEPTED and PENDING members can fetch the detail page
        # (pending users need to see the Accept/Decline buttons).
        if not await _is_active_member(gid, user_id):
            raise HTTPException(403, "Not your group.")
        g = await _db.spot_groups.find_one({"_id": gid})
        if not g:
            raise HTTPException(404, "Group not found.")
        return {"group": await _serialize_group(g, user_id)}

    @sub.post("/spot/groups/{gid}/accept")
    async def _accept_invite(gid: str, user_id: str = Depends(get_user_or_legacy)):
        """Phase 4 — Pending invitee accepts. Sets status='accepted',
        accepted_at, notifications_on=True. Idempotent (already-accepted
        users get 200 with no-op)."""
        mem = await _membership(gid, user_id)
        if not mem or mem.get("left_at"):
            raise HTTPException(404, "You're not an invitee of this group.")
        cur_status = mem.get("status") or "accepted"
        if cur_status == "accepted":
            g = await _db.spot_groups.find_one({"_id": gid})
            return {"group": await _serialize_group(g, user_id), "no_op": True}
        now = _now_iso()
        await _db.spot_group_members.update_one(
            {"_id": mem["_id"]},
            {"$set": {
                "status": "accepted",
                "accepted_at": now,
                "notifications_on": True,
            }},
        )
        g = await _db.spot_groups.find_one({"_id": gid})
        return {"group": await _serialize_group(g, user_id), "accepted_at": now}

    @sub.post("/spot/groups/{gid}/decline")
    async def _decline_invite(gid: str, user_id: str = Depends(get_user_or_legacy)):
        """Phase 4 — Pending invitee declines. Soft-leaves (sets
        left_at + declined=true). The slot frees up for the creator to
        invite someone else."""
        mem = await _membership(gid, user_id)
        if not mem or mem.get("left_at"):
            raise HTTPException(404, "You're not an invitee of this group.")
        if (mem.get("status") or "accepted") == "accepted":
            raise HTTPException(400, "You've already accepted — use Leave Group instead.")
        now = _now_iso()
        await _db.spot_group_members.update_one(
            {"_id": mem["_id"]},
            {"$set": {"left_at": now, "declined": True}},
        )
        return {"left_at": now, "declined": True}

    @sub.post("/spot/groups/{gid}/start")
    async def _start_group(gid: str, user_id: str = Depends(get_user_or_legacy)):
        """Phase 4 — Any ACCEPTED member can start the game once ALL
        invitees have accepted. Sets started=True, started_at, and
        mirrors auto_challenge_on=True (so Phase 2 scheduler picks it
        up). Idempotent on already-started groups."""
        if not await _is_accepted_member(gid, user_id):
            raise HTTPException(403, "You need to accept the invite first.")
        g = await _db.spot_groups.find_one({"_id": gid})
        if not g:
            raise HTTPException(404, "Group not found.")
        if g.get("started"):
            return {"group": await _serialize_group(g, user_id), "no_op": True}
        # Verify there are NO pending invitees.
        pending = await _db.spot_group_members.count_documents({
            "group_id": gid, "left_at": None, "status": "pending",
        })
        if pending > 0:
            raise HTTPException(
                400,
                f"Can't start yet — {pending} invitee still pending. "
                "Wait for everyone to accept, or remove them from the lobby.",
            )
        # Min 2 accepted players to start.
        accepted = await _db.spot_group_members.count_documents({
            "group_id": gid, "left_at": None, "status": {"$ne": "pending"},
        })
        if accepted < 2:
            raise HTTPException(400, "Need at least 2 accepted players to start.")
        now = _now_iso()
        await _db.spot_groups.update_one(
            {"_id": gid},
            {"$set": {
                "started": True,
                "started_at": now,
                "auto_challenge_on": True,  # mirror for Phase 2 ticks
            }},
        )
        g = await _db.spot_groups.find_one({"_id": gid})
        return {"group": await _serialize_group(g, user_id), "started_at": now}

    @sub.post("/spot/groups/{gid}/notifications")
    async def _toggle_notifications(
        gid: str,
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        """Phase 4 — Per-member ON/OFF toggle (self only). When OFF the
        user is excluded from challenges, XP gain, and XP penalties for
        THIS group. Body: {"on": bool}."""
        if not await _is_accepted_member(gid, user_id):
            raise HTTPException(403, "Accept the invite first.")
        if "on" not in body:
            raise HTTPException(400, "Body must include 'on' (bool).")
        on = bool(body.get("on"))
        await _db.spot_group_members.update_one(
            {"group_id": gid, "user_id": user_id, "left_at": None},
            {"$set": {"notifications_on": on}},
        )
        g = await _db.spot_groups.find_one({"_id": gid})
        return {"group": await _serialize_group(g, user_id), "notifications_on": on}

    @sub.post("/spot/groups/{gid}/members")
    async def _add_members(
        gid: str,
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        # Only ACCEPTED members can invite more friends — a pending
        # invitee can't grow the lobby before they themselves are in.
        if not await _is_accepted_member(gid, user_id):
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
        # Filter out anyone already in the group (any non-left status).
        existing_cur = _db.spot_group_members.find({
            "group_id": gid, "left_at": None,
        })
        existing_ids = set()
        async for m in existing_cur:
            existing_ids.add(m["user_id"])

        # Identify previously-LEFT members in the to_add set BEFORE the
        # reactivation. These will become active again WITHOUT a new
        # spot_group_members row, so they must NOT be counted in
        # `truly_new` (which is reserved for brand-new memberships).
        left_cur = _db.spot_group_members.find({
            "group_id": gid,
            "user_id": {"$in": to_add},
            "left_at": {"$ne": None},
        })
        left_ids = set()
        async for m in left_cur:
            left_ids.add(m["user_id"])

        # Brand-new = not currently active AND has no prior (left) row.
        truly_new = [m for m in to_add if m not in existing_ids and m not in left_ids]

        # Reactivate anyone who LEFT earlier (clear left_at). They come
        # back in 'pending' state and must re-accept.
        now = _now_iso()
        await _db.spot_group_members.update_many(
            {"group_id": gid, "user_id": {"$in": to_add}, "left_at": {"$ne": None}},
            {"$set": {
                "left_at": None,
                "status": "pending",
                "accepted_at": None,
                "notifications_on": True,
                "rejoined_at": now,
            }},
        )

        active_after = await _active_member_count(gid) + len(truly_new)
        if active_after > MAX_GROUP_SIZE:
            raise HTTPException(
                400,
                f"Adding these players would exceed the {MAX_GROUP_SIZE}-player cap "
                f"({active_after} active after add).",
            )
        if truly_new:
            await _db.spot_group_members.insert_many([
                {
                    "_id": str(uuid.uuid4()),
                    "group_id": gid,
                    "user_id": mid,
                    "joined_at": now,
                    "left_at": None,
                    "role": "member",
                    "status": "pending",
                    "accepted_at": None,
                    "notifications_on": True,
                }
                for mid in truly_new
            ])

        # Phase 4 invite-push to every brand-new AND reactivated user.
        if _push_to_user_fn is not None and (truly_new or left_ids):
            try:
                inviter_prof = await _profile_summary(user_id)
                inviter_name = inviter_prof.get("name") or "A friend"
            except Exception:
                inviter_name = "A friend"
            g_doc = await _db.spot_groups.find_one({"_id": gid}, {"name": 1})
            gname = (g_doc or {}).get("name") or "your group"
            for mid in list(set(truly_new) | left_ids):
                try:
                    await _push_to_user_fn(
                        mid,
                        "👀 You've been invited!",
                        f"{inviter_name} invited you to a Spot the Object group: {gname}",
                        {"kind": "spot_group_invite", "group_id": gid},
                    )
                except Exception as e:
                    logger.warning("[spot-groups.invite-push] %s: %s", mid, e)

        g = await _db.spot_groups.find_one({"_id": gid})
        return {
            "group": await _serialize_group(g, user_id),
            "added": truly_new,
            "reactivated": sorted(left_ids),
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
        # Any ACCEPTED member can rename the group. (auto_challenge_on
        # is no longer toggled here — the lifecycle is invite → accept
        # → start, and per-member toggles are at /notifications.)
        if not await _is_accepted_member(gid, user_id):
            raise HTTPException(403, "Not your group.")
        updates: dict = {}
        if "name" in body:
            nm = (body.get("name") or "").strip()[:60]
            if nm:
                updates["name"] = nm
        if not updates:
            raise HTTPException(400, "No editable fields in body.")
        await _db.spot_groups.update_one({"_id": gid}, {"$set": updates})
        g = await _db.spot_groups.find_one({"_id": gid})
        return {"group": await _serialize_group(g, user_id)}

    app.include_router(sub)
    return sub
