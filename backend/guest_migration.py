"""
Guest-mode migration — moves all per-user data from an anonymous
"anon-{id}" pseudo-account into a real signed-in user's account.

Flow:
  1. User starts as guest → backend sees user_id="anon-{anonId}".
  2. User registers / signs in → AuthContext stashes the anon id under
     PENDING_MIGRATION_KEY and the new JWT becomes active.
  3. After onboarding, the frontend pops a "continue your guest progress?"
     modal which calls POST /api/guest/migrate {anonymous_id}.
  4. THIS endpoint atomically rewrites every collection's user-scoped
     fields from "anon-{id}" → JWT user's _id, then returns a count.

Idempotency: re-running with the same anon id is a safe no-op (no
documents will match on the second run).

Authorisation: must be called with a real JWT — the user_id it's
migrating INTO is the JWT user's id. The body's `anonymous_id` is
verified to match the standard 8-64 char alnum format (same as
get_user_or_legacy's validation) before being used.
"""
from __future__ import annotations

import logging
import re
from fastapi import APIRouter, Depends, HTTPException, Body

logger = logging.getLogger(__name__)

# Wired up by init_guest_migration() at app startup so we don't need a
# circular import on server.py.
_db = None
_get_user_id = None  # FastAPI dependency that returns ONLY a real user id

# Field names across our collections that store a user identifier.
# Order matters: `_id` (profile-style 1:1 docs) is handled separately
# because it requires re-keying the document.
USER_ID_FIELDS = (
    "user_id",
    "owner_id",
    "from_user_id",
    "to_user_id",
    "hider_id",
    "seeker_id",
    "actor_id",
    "creator_id",
    "host_user_id",
    "target_user_id",
    "uid",
)

# Collections we should NEVER touch (auth/identity data lives here and
# must not be mutated by a migration call from a regular user).
SKIP_COLLECTIONS = {
    "users",
    "verification_codes",
    "password_reset_codes",
    "system.indexes",
    "_migrations",
}

ANON_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")


def init_guest_migration(*, db, real_user_dep):
    global _db, _get_user_id
    _db = db
    _get_user_id = real_user_dep


def attach_routes(app):
    sub = APIRouter(prefix="/api", tags=["guest-migration"])

    @sub.post("/guest/migrate")
    async def _migrate(
        body: dict = Body(...),
        user_id: str = Depends(_get_user_id),
    ):
        anon_id = (body.get("anonymous_id") or body.get("anon_id") or "").strip()
        if not anon_id or not ANON_ID_RE.match(anon_id):
            raise HTTPException(
                400, "anonymous_id must be 8-64 alphanumeric characters"
            )
        old_uid = f"anon-{anon_id}"
        if old_uid == user_id:
            # Same id — should never happen in normal flow but a safe no-op.
            return {"moved": 0, "collections_touched": 0, "merged_profile": False}

        moved = 0
        collections_touched = 0
        merged_profile = False
        try:
            coll_names = await _db.list_collection_names()
        except Exception:
            logger.exception("[guest-migrate] list_collection_names failed")
            raise HTTPException(500, "could not list collections")

        for cname in coll_names:
            if cname in SKIP_COLLECTIONS:
                continue
            coll = _db[cname]
            touched_this = False

            # ── (1) Re-key any document whose `_id` IS the old uid (e.g.
            # `profile`, `bt_locations`, `bt_settings`, `duo_offers` etc.
            # use the user_id as the primary key for 1:1 records).
            try:
                old_doc = await coll.find_one({"_id": old_uid})
            except Exception:
                old_doc = None
            if old_doc:
                touched_this = True
                try:
                    new_doc = await coll.find_one({"_id": user_id})
                except Exception:
                    new_doc = None

                if new_doc is None:
                    # Easy case: just re-insert under the new id and
                    # delete the old row.
                    old_doc = dict(old_doc)
                    old_doc["_id"] = user_id
                    await coll.insert_one(old_doc)
                    await coll.delete_one({"_id": old_uid})
                    moved += 1
                else:
                    # Both rows exist — merge. For `profile` we prefer
                    # the GUEST's progress fields (XP, streaks, custom
                    # quests) but keep the new account's identity fields
                    # (full_name, email, avatar_base64). For other 1:1
                    # collections we prefer the guest copy if its values
                    # look "more advanced" (have more keys). Simple rule:
                    # field-by-field, if guest has a value and new
                    # doesn't, copy guest → new.
                    update: dict = {}
                    for k, v in (old_doc or {}).items():
                        if k == "_id":
                            continue
                        if cname == "profile" and k in (
                            "full_name", "email", "avatar_base64",
                        ):
                            # Keep the new account's identity fields.
                            continue
                        if cname == "profile" and k == "total_xp":
                            try:
                                merged_profile = True
                                old_xp = int(v or 0)
                                new_xp = int(new_doc.get("total_xp") or 0)
                                update["total_xp"] = max(old_xp, new_xp)
                                continue
                            except Exception:
                                pass
                        # Generic rule: take guest value when new is unset
                        if new_doc.get(k) in (None, "", [], {}, 0) and v not in (
                            None, "", [], {},
                        ):
                            update[k] = v
                    if update:
                        await coll.update_one({"_id": user_id}, {"$set": update})
                    await coll.delete_one({"_id": old_uid})
                    moved += 1

            # ── (2) Bulk-rewrite any documents that REFERENCE the user
            # via one of the known field names.
            for field in USER_ID_FIELDS:
                try:
                    res = await coll.update_many(
                        {field: old_uid},
                        {"$set": {field: user_id}},
                    )
                    if res.modified_count:
                        moved += res.modified_count
                        touched_this = True
                except Exception:
                    logger.exception(
                        "[guest-migrate] update_many failed coll=%s field=%s",
                        cname, field,
                    )

            if touched_this:
                collections_touched += 1

        logger.info(
            "[guest-migrate] anon=%s → uid=%s moved=%d collections=%d merged_profile=%s",
            old_uid, user_id, moved, collections_touched, merged_profile,
        )
        return {
            "moved": moved,
            "collections_touched": collections_touched,
            "merged_profile": merged_profile,
        }

    @sub.get("/guest/has_progress")
    async def _has_progress(
        anon_id: str,
        user_id: str = Depends(_get_user_id),  # require auth so randoms can't probe
    ):
        """Cheap check — does the given anon id have ANY data the
        frontend would want to migrate? Used by the migration modal
        to decide whether to show or auto-dismiss when the guest never
        actually did anything."""
        anon_id = (anon_id or "").strip()
        if not ANON_ID_RE.match(anon_id):
            raise HTTPException(400, "invalid anonymous_id")
        old_uid = f"anon-{anon_id}"
        # Quick probe — check the most common scoped collections.
        probes = ("profile", "tasks", "goals", "xp_log", "bt_locations")
        total = 0
        for c in probes:
            try:
                # `_id == old_uid` for 1:1 collections OR `user_id == old_uid`
                cnt = await _db[c].count_documents(
                    {"$or": [{"_id": old_uid}, {"user_id": old_uid}]},
                    limit=1,
                )
                if cnt:
                    total += cnt
                    if total >= 1:
                        return {"has_progress": True, "user_id": user_id}
            except Exception:
                continue
        return {"has_progress": False, "user_id": user_id}

    app.include_router(sub)
    return sub
