"""
Per-friend chat preferences — bubble/text colors, mute & soft-block.

Endpoints exposed (all under /api):
  GET  /chat/preferences                — bulk fetch all of caller's prefs
  GET  /chat/preferences/{friend_id}    — single friend's prefs (defaults
                                          when missing)
  POST /chat/preferences/{friend_id}    — upsert any subset of fields
  POST /chat/preferences/{friend_id}/mute     — toggle convenience route
  POST /chat/preferences/{friend_id}/block    — toggle convenience route

Mongo collection used:
  chat_preferences = {
      _id: f"{owner_id}:{friend_id}",
      owner_id: str,
      friend_id: str,
      sent_bubble_color: str (hex),
      sent_text_color: str (hex),
      received_bubble_color: str (hex),
      received_text_color: str (hex),
      muted: bool,    # no push, badge stays
      blocked: bool,  # no push + no unread badge + lock icon (soft block)
      updated_at: ISO,
  }

Semantics (locked w/ user 2026-05):
  - Mute  = sender's pushes suppressed, red badge for that thread STILL accrues
  - Block = sender's pushes suppressed + red badge SKIPPED + lock icon shown,
            but messages still arrive in MongoDB; blocker can read history
            and reply normally (it's a SOFT block, no hard rejection).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_db = None
_get_user_or_legacy = None
_now_iso = None


# ─────────────────── Defaults (mirrored on the client) ───────────────────
DEFAULT_SENT_BUBBLE = "#00E1FF"      # colors.cyan
DEFAULT_SENT_TEXT = "#0A0A0F"        # colors.bg (dark on cyan)
DEFAULT_RECEIVED_BUBBLE = "#1A1A24"  # colors.surface
DEFAULT_RECEIVED_TEXT = "#E6E6F0"    # colors.text


def init_chat_preferences(*, db, get_user_or_legacy, now_iso):
    global _db, _get_user_or_legacy, _now_iso
    _db = db
    _get_user_or_legacy = get_user_or_legacy
    _now_iso = now_iso


# ─────────────────────── Pydantic payloads ───────────────────────
HEX_RE = r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"


class ChatPrefsBody(BaseModel):
    sent_bubble_color: Optional[str] = Field(default=None, pattern=HEX_RE)
    sent_text_color: Optional[str] = Field(default=None, pattern=HEX_RE)
    received_bubble_color: Optional[str] = Field(default=None, pattern=HEX_RE)
    received_text_color: Optional[str] = Field(default=None, pattern=HEX_RE)
    muted: Optional[bool] = None
    blocked: Optional[bool] = None


class ToggleBody(BaseModel):
    value: bool


# ─────────────────────── Helpers ───────────────────────
def _key(owner_id: str, friend_id: str) -> str:
    return f"{owner_id}:{friend_id}"


def _default_doc(owner_id: str, friend_id: str) -> dict:
    return {
        "_id": _key(owner_id, friend_id),
        "owner_id": owner_id,
        "friend_id": friend_id,
        "sent_bubble_color": DEFAULT_SENT_BUBBLE,
        "sent_text_color": DEFAULT_SENT_TEXT,
        "received_bubble_color": DEFAULT_RECEIVED_BUBBLE,
        "received_text_color": DEFAULT_RECEIVED_TEXT,
        "muted": False,
        "blocked": False,
        "updated_at": None,
    }


def _serialize(row: Optional[dict], owner_id: str, friend_id: str) -> dict:
    if not row:
        out = _default_doc(owner_id, friend_id)
        out.pop("_id", None)
        return out
    return {
        "owner_id": row.get("owner_id", owner_id),
        "friend_id": row.get("friend_id", friend_id),
        "sent_bubble_color": row.get("sent_bubble_color") or DEFAULT_SENT_BUBBLE,
        "sent_text_color": row.get("sent_text_color") or DEFAULT_SENT_TEXT,
        "received_bubble_color": row.get("received_bubble_color") or DEFAULT_RECEIVED_BUBBLE,
        "received_text_color": row.get("received_text_color") or DEFAULT_RECEIVED_TEXT,
        "muted": bool(row.get("muted", False)),
        "blocked": bool(row.get("blocked", False)),
        "updated_at": row.get("updated_at"),
    }


async def get_pref_for_pair(owner_id: str, friend_id: str) -> dict:
    """Public helper used by server.py's messages_send to look up the
    recipient's preferences for the sender (decide push & badge)."""
    row = await _db.chat_preferences.find_one({"_id": _key(owner_id, friend_id)})
    return _serialize(row, owner_id, friend_id)


async def list_blocked_for(owner_id: str) -> set[str]:
    """Return the set of friend_ids that owner_id has soft-blocked.
    Used by messages_unread_summary + messages_threads to suppress badges."""
    cur = _db.chat_preferences.find(
        {"owner_id": owner_id, "blocked": True}, {"friend_id": 1}
    )
    out: set[str] = set()
    async for r in cur:
        fid = r.get("friend_id")
        if fid:
            out.add(fid)
    return out


# ─────────────────────── Implementations ───────────────────────
async def _bulk_impl(caller_id: str) -> dict:
    rows = await _db.chat_preferences.find({"owner_id": caller_id}).to_list(2000)
    return {
        "preferences": [
            _serialize(r, caller_id, r.get("friend_id", "")) for r in rows
        ]
    }


async def _get_impl(caller_id: str, friend_id: str) -> dict:
    if not friend_id or friend_id == caller_id:
        raise HTTPException(400, "Invalid friend id.")
    row = await _db.chat_preferences.find_one({"_id": _key(caller_id, friend_id)})
    return _serialize(row, caller_id, friend_id)


async def _upsert_impl(caller_id: str, friend_id: str, body: ChatPrefsBody) -> dict:
    if not friend_id or friend_id == caller_id:
        raise HTTPException(400, "Invalid friend id.")
    payload = body.model_dump(exclude_none=True)
    if not payload:
        # No-op, still return current state
        return await _get_impl(caller_id, friend_id)
    payload["updated_at"] = _now_iso()
    await _db.chat_preferences.update_one(
        {"_id": _key(caller_id, friend_id)},
        {
            "$set": payload,
            "$setOnInsert": {
                "owner_id": caller_id,
                "friend_id": friend_id,
            },
        },
        upsert=True,
    )
    return await _get_impl(caller_id, friend_id)


# ─────────────────────── Routes ───────────────────────
def attach_routes(app, get_user_or_legacy):
    sub = APIRouter(prefix="/api")

    @sub.get("/chat/preferences")
    async def _bulk(user_id: str = Depends(get_user_or_legacy)):
        return await _bulk_impl(user_id)

    @sub.get("/chat/preferences/{friend_id}")
    async def _get(friend_id: str, user_id: str = Depends(get_user_or_legacy)):
        return await _get_impl(user_id, friend_id)

    @sub.post("/chat/preferences/{friend_id}")
    async def _upsert(
        friend_id: str,
        body: ChatPrefsBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        return await _upsert_impl(user_id, friend_id, body)

    @sub.post("/chat/preferences/{friend_id}/mute")
    async def _mute(
        friend_id: str,
        body: ToggleBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        return await _upsert_impl(
            user_id, friend_id, ChatPrefsBody(muted=bool(body.value))
        )

    @sub.post("/chat/preferences/{friend_id}/block")
    async def _block(
        friend_id: str,
        body: ToggleBody,
        user_id: str = Depends(get_user_or_legacy),
    ):
        return await _upsert_impl(
            user_id, friend_id, ChatPrefsBody(blocked=bool(body.value))
        )

    app.include_router(sub)
    return sub
