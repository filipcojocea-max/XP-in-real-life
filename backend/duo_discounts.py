"""
Duo Referral Discounts — Library+ mini-app group-buy system.

Spec recap (locked w/ user 2026-05-16):
  - Creator sets per-mini-app: required_people (1..5) + discounted_price.
  - Coexists with the existing solo % discount — both can be active.
  - Users create a "duo group" → get a shareable 6-char code + deep link.
  - HOLD-UNTIL-FULL: NO ONE pays until the group has the required members.
    Once full, every member can purchase at `discounted_price` (server-side
    enforced via stripe_create_payment_intent extension).
  - Group expires 72h from creation if not filled.
  - Creator gets a "Purchase History" admin view with referral metadata.

Endpoints exposed (all under /api):
  POST   /library/pricing/{app_id}/duo-discount   (creator)
  DELETE /library/pricing/{app_id}/duo-discount   (creator)
  GET    /library/duo-offer/{app_id}              (public — single)
  POST   /duo/create        body {app_id}         (caller becomes host + member#1)
  POST   /duo/join          body {code} | {group_id}
  POST   /duo/{group_id}/leave
  GET    /duo/my                                  (caller's active groups)
  GET    /duo/{group_id}                          (single group state)
  GET    /admin/purchase-history                  (creator)

Mongo collections used:
  - duo_offers:
      { _id: app_id, app_id, active:bool, required_people:int,
        discounted_price:float, currency:str, created_at, updated_at }
  - duo_groups:
      { _id: uuid, app_id, host_id, code:'ABC123', required_people:int,
        discounted_price:float, currency:str, status:'waiting'|'full'|'completed'|'expired',
        members:[{user_id, joined_at, paid_at|None, payment_intent_id|None,
                  name, avatar_base64}],
        created_at, expires_at (+72h), completed_at|None }
"""
from __future__ import annotations

import logging
import random
import string
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException

logger = logging.getLogger(__name__)

# Wired by init_duo_discounts(...)
_db = None
_is_admin_user = None
_now_iso = None
_library_app_ids: list[str] = []
_supported_currencies: list[str] = []
_default_currency = "USD"

DUO_EXPIRY_HOURS = 72
DUO_CODE_ALPHA = string.ascii_uppercase + string.digits  # exclude similar-looking 0/O if needed
DUO_CODE_LEN = 6


def init_duo_discounts(
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


# ───────────────────── helpers ─────────────────────
def _gen_code() -> str:
    return "".join(random.choices(DUO_CODE_ALPHA, k=DUO_CODE_LEN))


async def _new_unique_code() -> str:
    # Retry a handful of times in the (vanishingly rare) collision case.
    for _ in range(8):
        c = _gen_code()
        existing = await _db.duo_groups.find_one({"code": c})
        if not existing:
            return c
    # Last resort: append a uuid suffix slice
    return _gen_code() + str(uuid.uuid4())[:2].upper()


def _parse_iso(s: str | None):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return None


def _status_after_expiry(group: dict) -> str:
    """Compute a fresh status taking expiry into account.
    Pure function — does NOT write to db."""
    raw = group.get("status", "waiting")
    if raw in ("completed", "expired"):
        return raw
    ends = _parse_iso(group.get("expires_at"))
    if ends and datetime.utcnow() > ends:
        return "expired"
    return raw


async def _refresh_group_status(group: dict) -> dict:
    """If a group has lapsed past expires_at, flip it to 'expired' once
    so callers always see fresh state. Returns the (possibly updated) doc."""
    fresh = _status_after_expiry(group)
    if fresh != group.get("status"):
        await _db.duo_groups.update_one(
            {"_id": group["_id"]},
            {"$set": {"status": fresh}},
        )
        group["status"] = fresh
    return group


def _serialize_offer(doc: dict | None) -> dict | None:
    if not doc or not doc.get("active"):
        return None
    return {
        "app_id": doc.get("app_id"),
        "required_people": int(doc.get("required_people") or 2),
        "discounted_price": round(float(doc.get("discounted_price") or 0.0), 2),
        "currency": (doc.get("currency") or _default_currency).upper(),
        "active": True,
        "updated_at": doc.get("updated_at"),
    }


async def _enrich_member(m: dict) -> dict:
    """Add name + avatar from profile table (single doc per request)."""
    uid = m.get("user_id")
    prof = await _db.profile.find_one({"_id": uid}, {"full_name": 1, "name": 1, "avatar_base64": 1}) if uid else None
    return {
        "user_id": uid,
        "joined_at": m.get("joined_at"),
        "paid_at": m.get("paid_at"),
        "name": (prof or {}).get("full_name") or (prof or {}).get("name") or "Anonymous",
        "avatar_base64": (prof or {}).get("avatar_base64"),
    }


async def _serialize_group(g: dict, caller_id: str) -> dict:
    g = await _refresh_group_status(g)
    members = [await _enrich_member(m) for m in (g.get("members") or [])]
    return {
        "group_id": g.get("_id"),
        "app_id": g.get("app_id"),
        "code": g.get("code"),
        "host_id": g.get("host_id"),
        "is_host": g.get("host_id") == caller_id,
        "is_member": any(m["user_id"] == caller_id for m in members),
        "required_people": int(g.get("required_people") or 2),
        "discounted_price": round(float(g.get("discounted_price") or 0.0), 2),
        "currency": (g.get("currency") or _default_currency).upper(),
        "status": g.get("status", "waiting"),
        "members": members,
        "members_count": len(members),
        "is_full": len(members) >= int(g.get("required_people") or 2),
        "created_at": g.get("created_at"),
        "expires_at": g.get("expires_at"),
        "completed_at": g.get("completed_at"),
    }


async def get_active_offer(app_id: str) -> dict | None:
    """Public helper used by server.py to enrich /library/pricing payload."""
    if app_id not in _library_app_ids:
        return None
    doc = await _db.duo_offers.find_one({"_id": app_id})
    return _serialize_offer(doc)


async def get_offer_for_payment(app_id: str) -> dict | None:
    """Used by stripe_create_payment_intent to validate duo pricing.
    Returns the RAW config (incl. price/currency) regardless of active flag
    but only when active=True."""
    if app_id not in _library_app_ids:
        return None
    doc = await _db.duo_offers.find_one({"_id": app_id})
    if not doc or not doc.get("active"):
        return None
    return doc


async def validate_duo_for_payment(
    caller_id: str, app_id: str, duo_group_id: str
) -> tuple[float, str, dict]:
    """Server-authoritative price lookup for a duo purchase.
    Raises HTTPException on any validation failure.
    Returns (discounted_price_float, currency, group_doc)."""
    if not duo_group_id:
        raise HTTPException(400, "duo_group_id required")
    g = await _db.duo_groups.find_one({"_id": duo_group_id})
    if not g:
        raise HTTPException(404, "Duo group not found.")
    if g.get("app_id") != app_id:
        raise HTTPException(400, "Duo group is for a different mini-app.")
    g = await _refresh_group_status(g)
    members = g.get("members") or []
    if not any(m.get("user_id") == caller_id for m in members):
        raise HTTPException(403, "You are not a member of this duo group.")
    required = int(g.get("required_people") or 2)
    if len(members) < required:
        raise HTTPException(
            400,
            f"Duo not full yet ({len(members)}/{required}). Wait for more friends to join.",
        )
    if g.get("status") == "expired":
        raise HTTPException(400, "This duo group has expired.")
    # Already paid? (idempotency)
    me = next((m for m in members if m.get("user_id") == caller_id), None)
    if me and me.get("paid_at"):
        raise HTTPException(409, "You already paid for this duo.")
    return float(g.get("discounted_price") or 0.0), (g.get("currency") or _default_currency).upper(), g


async def record_duo_payment(user_id: str, group_id: str, payment_intent_id: str) -> None:
    """Called from the Stripe webhook on payment_intent.succeeded when
    metadata includes a duo_group_id. Marks the member as paid and
    flips group→completed once all members have paid."""
    g = await _db.duo_groups.find_one({"_id": group_id})
    if not g:
        return
    members = g.get("members") or []
    found = False
    for m in members:
        if m.get("user_id") == user_id and not m.get("paid_at"):
            m["paid_at"] = _now_iso()
            m["payment_intent_id"] = payment_intent_id
            found = True
            break
    if not found:
        return
    all_paid = all(m.get("paid_at") for m in members) and len(members) >= int(
        g.get("required_people") or 2
    )
    update = {"$set": {"members": members}}
    if all_paid:
        update["$set"]["status"] = "completed"
        update["$set"]["completed_at"] = _now_iso()
    await _db.duo_groups.update_one({"_id": group_id}, update)


# ───────────────────── endpoint implementations ─────────────────────
async def _upsert_offer(caller_id: str, app_id: str, body: dict) -> dict:
    if not await _is_admin_user(caller_id):
        raise HTTPException(403, "Creator only.")
    if app_id not in _library_app_ids:
        raise HTTPException(400, f"Invalid app_id. Must be one of {_library_app_ids}")
    try:
        rp = int(body.get("required_people"))
    except (TypeError, ValueError):
        raise HTTPException(400, "required_people must be an integer 1..5")
    if rp < 1 or rp > 5:
        raise HTTPException(400, "required_people must be between 1 and 5")
    try:
        dp = float(body.get("discounted_price"))
    except (TypeError, ValueError):
        raise HTTPException(400, "discounted_price must be a number")
    if dp < 0 or dp > 100000:
        raise HTTPException(400, "discounted_price out of range (0..100000)")
    currency = (body.get("currency") or _default_currency).upper()
    if currency not in _supported_currencies:
        raise HTTPException(400, f"currency must be one of {_supported_currencies}")
    # Snap parent app's main price — duo price should be LESS than the
    # solo full price (otherwise it's not a discount).
    parent = await _db.library_pricing.find_one({"app_id": app_id})
    full_price = float((parent or {}).get("price") or 0.0)
    if full_price > 0 and dp >= full_price:
        raise HTTPException(
            400,
            f"Duo price must be less than the full price ({full_price} {currency}).",
        )
    now = _now_iso()
    await _db.duo_offers.update_one(
        {"_id": app_id},
        {
            "$set": {
                "app_id": app_id,
                "active": True,
                "required_people": rp,
                "discounted_price": round(dp, 2),
                "currency": currency,
                "updated_at": now,
            },
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )
    doc = await _db.duo_offers.find_one({"_id": app_id})
    return {"saved": True, "duo_offer": _serialize_offer(doc)}


async def _clear_offer(caller_id: str, app_id: str) -> dict:
    if not await _is_admin_user(caller_id):
        raise HTTPException(403, "Creator only.")
    if app_id not in _library_app_ids:
        raise HTTPException(400, f"Invalid app_id. Must be one of {_library_app_ids}")
    await _db.duo_offers.update_one(
        {"_id": app_id},
        {"$set": {"active": False, "updated_at": _now_iso()}},
    )
    return {"saved": True, "duo_offer": None}


async def _create_group(caller_id: str, body: dict) -> dict:
    app_id = (body.get("app_id") or "").strip()
    if app_id not in _library_app_ids:
        raise HTTPException(400, f"Invalid app_id. Must be one of {_library_app_ids}")
    # Owner already owns the app? Block.
    owned = await _db.library_purchases.find_one({"user_id": caller_id, "app_id": app_id})
    if owned:
        raise HTTPException(409, "You already own this mini-app.")
    offer_doc = await _db.duo_offers.find_one({"_id": app_id})
    if not offer_doc or not offer_doc.get("active"):
        raise HTTPException(400, "No active duo offer for this mini-app.")
    # Don't allow multiple active host groups per (user, app).
    existing = await _db.duo_groups.find_one(
        {"app_id": app_id, "host_id": caller_id, "status": {"$in": ["waiting", "full"]}}
    )
    if existing:
        existing = await _refresh_group_status(existing)
        if existing.get("status") in ("waiting", "full"):
            return await _serialize_group(existing, caller_id) | {"already_exists": True}
    now = _now_iso()
    expires = (datetime.utcnow() + timedelta(hours=DUO_EXPIRY_HOURS)).isoformat()
    group = {
        "_id": str(uuid.uuid4()),
        "app_id": app_id,
        "host_id": caller_id,
        "code": await _new_unique_code(),
        "required_people": int(offer_doc.get("required_people") or 2),
        "discounted_price": round(float(offer_doc.get("discounted_price") or 0.0), 2),
        "currency": (offer_doc.get("currency") or _default_currency).upper(),
        "status": "waiting",
        "members": [
            {
                "user_id": caller_id,
                "joined_at": now,
                "paid_at": None,
                "payment_intent_id": None,
            }
        ],
        "created_at": now,
        "expires_at": expires,
        "completed_at": None,
    }
    # If host alone fills the requirement (required_people==1), it's
    # technically full immediately — flip status accordingly.
    if group["required_people"] <= 1:
        group["status"] = "full"
    await _db.duo_groups.insert_one(group)
    return await _serialize_group(group, caller_id)


async def _join_group(caller_id: str, body: dict) -> dict:
    code = (body.get("code") or "").strip().upper()
    group_id = (body.get("group_id") or "").strip()
    if not code and not group_id:
        raise HTTPException(400, "Provide either code or group_id.")
    query: dict = {}
    if code:
        query["code"] = code
    else:
        query["_id"] = group_id
    g = await _db.duo_groups.find_one(query)
    if not g:
        raise HTTPException(404, "Duo group not found.")
    g = await _refresh_group_status(g)
    if g.get("status") == "expired":
        raise HTTPException(400, "This duo group has expired.")
    if g.get("status") == "completed":
        raise HTTPException(400, "This duo group is already completed.")
    # Already a member?
    members = g.get("members") or []
    if any(m.get("user_id") == caller_id for m in members):
        return await _serialize_group(g, caller_id) | {"already_member": True}
    required = int(g.get("required_people") or 2)
    if len(members) >= required:
        raise HTTPException(400, "This duo group is full.")
    # Caller already owns the app? Block.
    owned = await _db.library_purchases.find_one(
        {"user_id": caller_id, "app_id": g.get("app_id")}
    )
    if owned:
        raise HTTPException(409, "You already own this mini-app.")
    now = _now_iso()
    members.append(
        {
            "user_id": caller_id,
            "joined_at": now,
            "paid_at": None,
            "payment_intent_id": None,
        }
    )
    new_status = "full" if len(members) >= required else "waiting"
    await _db.duo_groups.update_one(
        {"_id": g["_id"]},
        {"$set": {"members": members, "status": new_status}},
    )
    g["members"] = members
    g["status"] = new_status
    return await _serialize_group(g, caller_id)


async def _leave_group(caller_id: str, group_id: str) -> dict:
    g = await _db.duo_groups.find_one({"_id": group_id})
    if not g:
        raise HTTPException(404, "Duo group not found.")
    if g.get("status") in ("completed", "expired"):
        return await _serialize_group(g, caller_id)
    members = g.get("members") or []
    me = next((m for m in members if m.get("user_id") == caller_id), None)
    if not me:
        raise HTTPException(404, "You are not a member of this group.")
    if me.get("paid_at"):
        raise HTTPException(400, "You already paid — cannot leave.")
    # Host leaving → cancel/expire the entire group so it doesn't dangle.
    if g.get("host_id") == caller_id:
        await _db.duo_groups.update_one(
            {"_id": group_id},
            {"$set": {"status": "expired", "completed_at": _now_iso()}},
        )
        g["status"] = "expired"
        return await _serialize_group(g, caller_id)
    remaining = [m for m in members if m.get("user_id") != caller_id]
    new_status = "full" if len(remaining) >= int(g.get("required_people") or 2) else "waiting"
    await _db.duo_groups.update_one(
        {"_id": group_id},
        {"$set": {"members": remaining, "status": new_status}},
    )
    g["members"] = remaining
    g["status"] = new_status
    return await _serialize_group(g, caller_id)


async def _my_groups(caller_id: str) -> dict:
    cur = _db.duo_groups.find(
        {
            "$or": [
                {"host_id": caller_id},
                {"members.user_id": caller_id},
            ]
        }
    ).sort("created_at", -1).limit(50)
    rows = []
    async for g in cur:
        rows.append(await _serialize_group(g, caller_id))
    return {"groups": rows}


async def _get_group(caller_id: str, group_id: str) -> dict:
    g = await _db.duo_groups.find_one({"_id": group_id})
    if not g:
        raise HTTPException(404, "Duo group not found.")
    return await _serialize_group(g, caller_id)


async def _admin_purchase_history(caller_id: str) -> dict:
    if not await _is_admin_user(caller_id):
        raise HTTPException(403, "Creator only.")
    purchases = await _db.library_purchases.find({}).sort("purchased_at", -1).to_list(500)
    enriched = []
    for p in purchases:
        uid = p.get("user_id")
        prof = await _db.profile.find_one({"_id": uid}, {"full_name": 1, "name": 1, "avatar_base64": 1}) if uid else None
        u = await _db.users.find_one({"_id": uid}, {"email": 1}) if uid else None
        group = None
        gid = p.get("duo_group_id")
        if gid:
            g = await _db.duo_groups.find_one(
                {"_id": gid}, {"code": 1, "required_people": 1, "discounted_price": 1, "host_id": 1, "members": 1}
            )
            if g:
                group = {
                    "group_id": gid,
                    "code": g.get("code"),
                    "host_id": g.get("host_id"),
                    "required_people": int(g.get("required_people") or 2),
                    "members_count": len(g.get("members") or []),
                }
        enriched.append(
            {
                "id": p.get("_id"),
                "user_id": uid,
                "user_name": (prof or {}).get("full_name") or (prof or {}).get("name") or "Anonymous",
                "user_email": (u or {}).get("email", ""),
                "user_avatar_base64": (prof or {}).get("avatar_base64"),
                "app_id": p.get("app_id"),
                "paid_amount": p.get("paid_amount"),
                "paid_currency": p.get("paid_currency"),
                "source": p.get("source"),  # 'stripe' / 'koffi' / 'free' / 'duo'
                "stripe_session_id": p.get("stripe_session_id"),
                "stripe_payment_intent": p.get("stripe_payment_intent"),
                "duo_group_id": gid,
                "duo": group,
                "purchased_at": p.get("purchased_at"),
            }
        )
    return {"purchases": enriched, "count": len(enriched)}


# ───────────────────── routes ─────────────────────
def attach_routes(app, get_user_or_legacy):
    sub = APIRouter(prefix="/api")

    @sub.post("/library/pricing/{app_id}/duo-discount")
    async def _route_upsert(
        app_id: str,
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        return await _upsert_offer(user_id, app_id, body)

    @sub.delete("/library/pricing/{app_id}/duo-discount")
    async def _route_clear(app_id: str, user_id: str = Depends(get_user_or_legacy)):
        return await _clear_offer(user_id, app_id)

    @sub.get("/library/duo-offer/{app_id}")
    async def _route_offer(app_id: str, user_id: str = Depends(get_user_or_legacy)):
        return {"duo_offer": await get_active_offer(app_id)}

    @sub.post("/duo/create")
    async def _route_create(
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        return await _create_group(user_id, body)

    @sub.post("/duo/join")
    async def _route_join(
        body: dict = Body(...),
        user_id: str = Depends(get_user_or_legacy),
    ):
        return await _join_group(user_id, body)

    @sub.post("/duo/{group_id}/leave")
    async def _route_leave(group_id: str, user_id: str = Depends(get_user_or_legacy)):
        return await _leave_group(user_id, group_id)

    @sub.get("/duo/my")
    async def _route_my(user_id: str = Depends(get_user_or_legacy)):
        return await _my_groups(user_id)

    @sub.get("/duo/{group_id}")
    async def _route_get(group_id: str, user_id: str = Depends(get_user_or_legacy)):
        return await _get_group(user_id, group_id)

    @sub.get("/admin/purchase-history")
    async def _route_admin_hist(user_id: str = Depends(get_user_or_legacy)):
        return await _admin_purchase_history(user_id)

    app.include_router(sub)
    return sub
