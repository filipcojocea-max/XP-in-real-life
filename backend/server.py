from fastapi import FastAPI, APIRouter, HTTPException, Depends, Header, Request, Body
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import json
import logging
import random
import secrets
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal
import uuid
from datetime import datetime, timezone, timedelta, date as date_cls
import jwt as pyjwt
from passlib.context import CryptContext
from contextvars import ContextVar

# ContextVar holding the current request's user_id.
# Defaults to "main" so unauthenticated calls fall back to the legacy account.
_current_user: ContextVar[str] = ContextVar("_current_user", default="main")


def current_user_id() -> str:
    """Return the user_id of the current request (or 'main' if unauthenticated)."""
    return _current_user.get()

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI(title="LevelUp API")
api_router = APIRouter(prefix="/api")

# ------------------------------------------------------------------
# Auth (JWT + bcrypt + email verification code)
# ------------------------------------------------------------------
JWT_SECRET = os.environ.get("JWT_SECRET", "xp-real-life-dev-secret-change-in-prod-12345")
JWT_ALG = "HS256"
JWT_TTL_DAYS = 365  # Stay signed in for a year

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(plain: str) -> str:
    return pwd_ctx.hash(plain)


# ═══════════════ Creator / Admin (Premium+) ═══════════════
# A single hard-coded creator account with elevated privileges:
#  - All XP caps & time/amount lock-outs are bypassed.
#  - Other users see this player with "unlimited" stats + a golden treatment.
#  - Has access to the full mini-app catalog.
ADMIN_EMAILS = {"filip.cojocea122@gmail.com"}
ADMIN_DEFAULT_PASSWORD = os.environ.get("ADMIN_DEFAULT_PASSWORD", "XL98CZW5599")
ADMIN_DEFAULT_NAME = "Admin · Creator"
# Public-facing name shown to OTHER users whenever they see the Creator
# in any list/modal/thread. Even if the Creator's full_name is set to
# something else in their own profile, non-admin viewers always see
# this label so the Creator account has a single, recognizable brand.
ADMIN_PUBLIC_DISPLAY_NAME = "Admin · Creator"


def _is_admin_email(email: Optional[str]) -> bool:
    return bool(email) and email.strip().lower() in ADMIN_EMAILS


async def _is_admin_user(user_id: str) -> bool:
    if not user_id:
        return False
    u = await db.users.find_one({"_id": user_id}, {"email": 1})
    return _is_admin_email((u or {}).get("email"))


# ═══════════════ Account Suspension (Admin power) ═══════════════
def _suspension_state(prof: Optional[dict]) -> Optional[dict]:
    """Return {until, forever, remaining_seconds, suspended_at, suspended_by_admin,
    reason} if a profile is currently suspended, else None.

    "Forever" suspensions persist until the admin manually un-suspends — the
    `suspended_until` field is the literal string 'forever'. Timed
    suspensions store an ISO-8601 UTC timestamp; once `now > until` the
    suspension is treated as expired and the function returns None.
    """
    if not prof:
        return None
    until = prof.get("suspended_until")
    if not until:
        return None
    if until == "forever":
        return {
            "until": None,
            "forever": True,
            "remaining_seconds": None,
            "suspended_at": prof.get("suspended_at"),
            "suspended_by": prof.get("suspended_by_admin"),
            "reason": prof.get("suspension_reason") or "",
        }
    try:
        until_dt = datetime.fromisoformat(until.replace("Z", "+00:00"))
        if until_dt.tzinfo is None:
            until_dt = until_dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None
    now = datetime.now(timezone.utc)
    if now >= until_dt:
        return None
    return {
        "until": until_dt.isoformat(),
        "forever": False,
        "remaining_seconds": int((until_dt - now).total_seconds()),
        "suspended_at": prof.get("suspended_at"),
        "suspended_by": prof.get("suspended_by_admin"),
        "reason": prof.get("suspension_reason") or "",
    }


async def _check_not_suspended(user_id: str) -> None:
    """Raise 403 with structured detail if the given user is currently suspended.
    Admin/Creator accounts are exempt — they cannot be suspended out of the system.
    Anonymous + 'main' legacy IDs are also exempt (no profile to suspend).
    """
    if not user_id or user_id == "main" or user_id.startswith("anon-"):
        return
    if await _is_admin_user(user_id):
        return  # admins can never be suspended
    prof = await db.profile.find_one({"_id": user_id}, {
        "suspended_until": 1,
        "suspended_at": 1,
        "suspended_by_admin": 1,
        "suspension_reason": 1,
    })
    state = _suspension_state(prof)
    if state:
        raise HTTPException(status_code=403, detail={
            "error": "account_suspended",
            "message": "This account has been suspended.",
            **state,
        })


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return pwd_ctx.verify(plain, hashed)
    except Exception:
        return False


def make_token(user_id: str, email: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "email": email,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=JWT_TTL_DAYS)).timestamp()),
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str) -> dict:
    return pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])


def _gen_code() -> str:
    """6-digit numeric verification code."""
    return f"{random.randint(0, 999999):06d}"


def _gen_reset_token() -> str:
    """Long, URL-safe, single-use token for the password-reset magic link."""
    import secrets
    return secrets.token_urlsafe(32)


# ─────────────── Email security: validation + delivery ───────────────
# Built-in blocklist of common disposable / temporary email domains so
# users cannot register with throwaway inboxes like Mailinator.
_DISPOSABLE_EMAIL_DOMAINS = {
    "mailinator.com", "10minutemail.com", "10minutemail.net", "20minutemail.com",
    "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz",
    "guerrillamail.info", "guerrillamailblock.com", "sharklasers.com", "grr.la",
    "throwawaymail.com", "throwaway.email", "yopmail.com", "yopmail.fr", "yopmail.net",
    "tempmail.com", "tempmail.net", "temp-mail.org", "temp-mail.io", "tmpmail.org",
    "dispostable.com", "fakeinbox.com", "trashmail.com", "trashmail.net",
    "maildrop.cc", "mintemail.com", "spam4.me", "tempinbox.com", "fakemail.net",
    "getnada.com", "nada.email", "inboxbear.com", "burnermail.io", "emailondeck.com",
    "tempmailaddress.com", "harakirimail.com", "mailcatch.com", "mohmal.com",
    "moakt.com", "mvrht.com", "tempr.email", "mailnesia.com", "mailnull.com",
    "spambox.us", "spambog.com", "spamgourmet.com", "spamdecoy.net",
    "fake.com", "fake.fake", "test.test", "example.com", "example.org", "example.net",
    "asdasd.com", "asdf.com", "qwerty.com", "1secmail.com", "1secmail.net",
    "wegwerfemail.de", "byom.de", "discard.email", "mailtemp.info",
}


class EmailValidationError(Exception):
    """Raised when the supplied email is invalid, fake, or disposable."""


def _validate_real_email(email: str) -> str:
    """Multi-layered email validation:
       1. Strict syntax (RFC 5322)
       2. DNS MX-record check (the domain actually accepts mail)
       3. Disposable / throwaway domain blocklist

       Returns the normalized email or raises EmailValidationError.
    """
    from email_validator import validate_email, EmailNotValidError
    try:
        # check_deliverability=True triggers DNS MX lookup
        v = validate_email(email, check_deliverability=True)
    except EmailNotValidError as e:
        raise EmailValidationError(str(e))
    norm = v.normalized.lower()
    domain = norm.split("@", 1)[1]
    if domain in _DISPOSABLE_EMAIL_DOMAINS:
        raise EmailValidationError(
            "Disposable / temporary email addresses are not allowed. "
            "Please use a real, personal email."
        )
    # Reject obvious nonsense like x@x.x  (single-letter TLDs)
    parts = domain.split(".")
    if len(parts[-1]) < 2 or any(len(p) == 0 for p in parts):
        raise EmailValidationError("That email domain looks invalid.")
    return norm


def _send_verification_email(email: str, code: str, full_name: str = "") -> bool:
    """Send the 6-digit verification code via Resend. Returns True on success.

    Falls back to logging the code to the server log only if RESEND_API_KEY is
    NOT set (dev mode). In production with the key set, raises if Resend fails
    so the caller can decline registration.
    """
    auth_log = logging.getLogger("auth")
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        auth_log.warning(
            "[DEV-EMAIL] To: %s  Code: %s  (set RESEND_API_KEY to send real emails)",
            email, code,
        )
        return False
    try:
        import resend  # type: ignore
        resend.api_key = api_key
        sender = os.environ.get("RESEND_FROM", "XP in Real Life <onboarding@resend.dev>")
        html = (
            f"<div style='font-family:-apple-system,Segoe UI,sans-serif;background:#0b0d12;"
            f"color:#fff;padding:32px;border-radius:12px;max-width:480px;margin:auto'>"
            f"<h2 style='color:#5cffb1;margin:0 0 8px'>Welcome, {full_name or 'hero'} 👋</h2>"
            f"<p style='color:#aab1c2;margin:0 0 20px'>Use this 6-digit code to finish creating your XP in Real Life account.</p>"
            f"<div style='font-size:36px;font-weight:900;letter-spacing:10px;color:#5fd2ff;"
            f"background:#11151c;border:2px solid #1f2733;padding:18px;border-radius:8px;"
            f"text-align:center;font-variant:tabular-nums'>{code}</div>"
            f"<p style='color:#7a8294;font-size:12px;margin-top:20px'>"
            f"This code expires in 30 minutes. If you didn't request this, ignore this email.</p>"
            f"</div>"
        )
        resend.Emails.send({
            "from": sender,
            "to": [email],
            "subject": f"Your XP in Real Life code: {code}",
            "html": html,
            "text": (
                f"Hi {full_name or 'there'},\n\n"
                f"Your XP in Real Life verification code is: {code}\n\n"
                "It expires in 30 minutes.\n\n"
                "If you didn't request this, please ignore this email."
            ),
        })
        auth_log.info("Resend email sent to %s", email)
        return True
    except Exception as e:
        auth_log.exception("Resend send failed for %s: %s", email, e)
        # Re-raise so the caller (register) can return a useful error.
        raise


async def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> str:
    """Return the authenticated user_id (raises 401 otherwise)."""
    if not creds or not creds.credentials:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = decode_token(creds.credentials)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired — please log in again")
    except Exception:
        raise HTTPException(401, "Invalid token")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(401, "Invalid token")
    user = await db.users.find_one({"_id": user_id}, {"password_hash": 0})
    if not user:
        raise HTTPException(401, "User not found")
    if not user.get("verified"):
        raise HTTPException(403, "Email not verified")
    return user_id


async def get_user_or_legacy(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    x_anonymous_id: Optional[str] = Header(None, alias="X-Anonymous-Id"),
) -> str:
    """Return user_id from JWT, or X-Anonymous-Id (anonymous mode), or 'main' fallback.
    Anonymous IDs are prefixed with 'anon-' so they can't collide with real user UUIDs.
    Side-effect: refreshes the user's `last_seen_at` timestamp at most once per
    minute so the Friends list can show "Last seen X hrs ago" without
    hammering MongoDB on every API call."""
    user_id: Optional[str] = None
    if creds and creds.credentials:
        try:
            payload = decode_token(creds.credentials)
            uid = payload.get("sub")
            if uid:
                user = await db.users.find_one({"_id": uid}, {"password_hash": 0})
                if user and user.get("verified"):
                    user_id = uid
        except Exception:
            pass
    if not user_id and x_anonymous_id and len(x_anonymous_id) >= 8 and len(x_anonymous_id) <= 64:
        clean = "".join(c for c in x_anonymous_id if c.isalnum() or c == "-")[:64]
        user_id = f"anon-{clean}"
    if not user_id:
        user_id = "main"
    # Block suspended accounts on EVERY authed call. Admin-as-target is
    # exempt inside _check_not_suspended; legacy/anon IDs are no-ops.
    await _check_not_suspended(user_id)
    await _touch_last_seen(user_id)
    return user_id


# In-memory cache: user_id → last write timestamp (UTC). Lets us skip the
# DB write when we've already updated within the past minute.
_LAST_SEEN_THROTTLE: dict[str, datetime] = {}
_LAST_SEEN_THROTTLE_SECONDS = 60


async def _touch_last_seen(user_id: str) -> None:
    """Best-effort refresh of profile.last_seen_at. Throttled per-process so
    we don't issue a DB write on every single API call. Failures are
    swallowed — `last_seen_at` is a soft, non-critical field."""
    try:
        now = datetime.now(timezone.utc)
        prev = _LAST_SEEN_THROTTLE.get(user_id)
        if prev and (now - prev).total_seconds() < _LAST_SEEN_THROTTLE_SECONDS:
            return
        _LAST_SEEN_THROTTLE[user_id] = now
        await db.profile.update_one(
            {"_id": user_id},
            {"$set": {"last_seen_at": now.isoformat()}},
            upsert=False,  # don't create empty profiles for unauth pings
        )
    except Exception:
        pass


# ------------------------------------------------------------------
# Constants
# ------------------------------------------------------------------
FOCUS_AREAS = ("social", "fitness", "appearance", "mindset")
TIME_SLOTS = ("morning", "afternoon", "evening")

# Cumulative XP required to reach each level (index = level)
# 200-level exponential progression curve.
# Formula:  cum_xp(L) = round(LEVEL_COEFF * L ** LEVEL_EXP)
# Tuned so that:
#   • Level 1   → 50 XP (low double-digit start)
#   • Level 10  → ~3,677 XP cumulative
#   • Level 50  → ~75,000 XP cumulative (matches user spec)
#   • Level 110 → per-level cost ≈ 5,500 XP (avg per-level only hit late)
#   • Level 200 → ~1,000,000 XP cumulative (matches user spec)
LEVEL_COEFF = 49.6
LEVEL_EXP = 1.87
MAX_LEVEL = 200
TOTAL_XP_CAP = 1_000_000


def _cum_xp_for_level(L: int) -> int:
    """Cumulative XP required to *reach* level L.  level 1 = 0 XP needed (you start there)."""
    if L <= 1:
        return 0
    if L > MAX_LEVEL:
        return TOTAL_XP_CAP
    return round(LEVEL_COEFF * (L ** LEVEL_EXP))


# Pre-computed thresholds for fast lookup; index = level (1-based), value = cumulative XP at start of that level.
LEVEL_THRESHOLDS = [0] + [_cum_xp_for_level(L) for L in range(2, MAX_LEVEL + 2)]
LEVEL_THRESHOLDS[-1] = TOTAL_XP_CAP  # cap final threshold

ACHIEVEMENT_DEFS = [
    {"id": "first_task", "title": "First Step", "description": "Complete your first task", "icon": "footsteps", "type": "tasks_completed", "threshold": 1},
    {"id": "task_10", "title": "Getting Started", "description": "Complete 10 tasks", "icon": "flash", "type": "tasks_completed", "threshold": 10},
    {"id": "task_50", "title": "Dedicated", "description": "Complete 50 tasks", "icon": "trophy", "type": "tasks_completed", "threshold": 50},
    {"id": "task_100", "title": "Centurion", "description": "Complete 100 tasks", "icon": "medal", "type": "tasks_completed", "threshold": 100},
    {"id": "streak_3", "title": "On Fire", "description": "3-day streak", "icon": "flame", "type": "streak", "threshold": 3},
    {"id": "streak_7", "title": "Week Warrior", "description": "7-day streak", "icon": "calendar", "type": "streak", "threshold": 7},
    {"id": "streak_30", "title": "Unstoppable", "description": "30-day streak", "icon": "rocket", "type": "streak", "threshold": 30},
    {"id": "level_5", "title": "Rising Star", "description": "Reach Level 5", "icon": "star", "type": "level", "threshold": 5},
    {"id": "level_25", "title": "Quarter Way", "description": "Reach Level 25", "icon": "ribbon", "type": "level", "threshold": 25},
    {"id": "level_50", "title": "Hero", "description": "Reach Level 50", "icon": "diamond", "type": "level", "threshold": 50},
    {"id": "level_100", "title": "Champion", "description": "Reach Level 100", "icon": "trophy", "type": "level", "threshold": 100},
    {"id": "level_200", "title": "Apex Legend", "description": "Reach max Level 200", "icon": "shield-checkmark", "type": "level", "threshold": 200},
    {"id": "first_goal", "title": "Goal Setter", "description": "Create your first goal", "icon": "flag", "type": "goals_created", "threshold": 1},
    {"id": "goal_done", "title": "Achiever", "description": "Complete a goal", "icon": "checkmark-done", "type": "goals_completed", "threshold": 1},
]


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def today_str() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def user_today_str(prof: Optional[dict]) -> str:
    """Return the user's current 'today' as YYYY-MM-DD, using their
    `timezone` (IANA) and `day_start_time` (HH:MM) as the day boundary.

    The day rolls over at `day_start_time` local — NOT at midnight.
    Falls back to server UTC if either field is unset.
    """
    if not prof:
        return today_str()
    tz_name = prof.get("timezone")
    day_start = prof.get("day_start_time") or prof.get("wake_time") or "07:00"
    if not tz_name:
        return today_str()
    try:
        from zoneinfo import ZoneInfo
        local_now = datetime.now(ZoneInfo(tz_name))
        hh, mm = [int(x) for x in (day_start or "07:00").split(":")[:2]]
        # If local now is BEFORE day_start, we still belong to yesterday
        if (local_now.hour, local_now.minute) < (hh, mm):
            local_now = local_now - timedelta(days=1)
        return local_now.date().isoformat()
    except Exception:
        return today_str()


async def user_today_str_for(user_id: str) -> str:
    prof = await db.profile.find_one({"_id": user_id}, {"timezone": 1, "day_start_time": 1, "wake_time": 1})
    return user_today_str(prof)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def level_from_xp(xp: int) -> int:
    if xp <= 0:
        return 1
    if xp >= TOTAL_XP_CAP:
        return MAX_LEVEL
    # Binary search the thresholds (1-indexed: thresholds[L] = cum needed to be at level L+1)
    lo, hi = 1, MAX_LEVEL
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if xp >= LEVEL_THRESHOLDS[mid - 1]:
            lo = mid
        else:
            hi = mid - 1
    return lo


def xp_progress(xp: int):
    lvl = level_from_xp(xp)
    if lvl >= MAX_LEVEL:
        return {
            "level": MAX_LEVEL,
            "xp_in_level": 0,
            "xp_to_next": 0,
            "xp_total": xp,
            "progress": 1.0,
            "is_max": True,
        }
    current_threshold = LEVEL_THRESHOLDS[lvl - 1]
    next_threshold = LEVEL_THRESHOLDS[lvl]
    xp_in_level = xp - current_threshold
    xp_to_next = next_threshold - current_threshold
    return {
        "level": lvl,
        "xp_in_level": xp_in_level,
        "xp_to_next": xp_to_next,
        "xp_total": xp,
        "progress": xp_in_level / xp_to_next if xp_to_next else 0,
        "is_max": False,
    }


@api_router.get("/levels")
async def get_levels():
    """Return the full level table (cumulative XP per level + delta to reach it)."""
    rows = []
    for L in range(1, MAX_LEVEL + 1):
        cum = LEVEL_THRESHOLDS[L - 1]
        prev = LEVEL_THRESHOLDS[L - 2] if L > 1 else 0
        rows.append({"level": L, "cum_xp": cum, "delta_to_reach": cum - prev})
    return {"max_level": MAX_LEVEL, "total_xp_cap": TOTAL_XP_CAP, "formula": "cum_xp(L) = round(49.6 * L^1.87)", "levels": rows}


async def get_or_create_profile_for(user_id: str, full_name: str = "Hero") -> dict:
    prof = await db.profile.find_one({"_id": user_id})
    if not prof:
        prof = {
            "_id": user_id,
            "name": full_name or "Hero",
            "total_xp": 0,
            "current_streak": 0,
            "longest_streak": 0,
            "last_active_date": None,
            "tasks_completed": 0,
            "goals_created": 0,
            "goals_completed": 0,
            "achievements_unlocked": [],
            "onboarding_complete": False,
            "onboarding": {},
            "bio": "",
            "avatar_base64": None,
            "wake_time": "07:00",                   # legacy — kept for backward compat
            "morning_setup_done": False,
            # New day-boundary system: `day_start_time` in user's `timezone` is
            # the authoritative "start of day" for tasks/challenges/sleep.
            "day_start_time": None,                 # "HH:MM" — null until answered
            "timezone": None,                       # IANA zone e.g. "Australia/Sydney"
            "onboarding_tz_done": False,            # forces existing users to re-answer
            # Spot-the-Object mini-app
            "spot_points": 0,
            "spot_random_enabled": False,
            "created_at": now_iso(),
        }
        await db.profile.insert_one(prof)
        # Auto-seed default tasks for the new profile (fresh users — including anon mode — get the starter set)
        try:
            await seed_default_tasks_for_user(user_id)
        except Exception:
            logger.exception("auto-seed failed for %s", user_id)
    return prof


# Legacy alias used internally — new code should use the _for variant
async def get_or_create_profile(user_id: str = "main") -> dict:
    return await get_or_create_profile_for(user_id)


def serialize_profile(prof: dict) -> dict:
    xp = prof.get("total_xp", 0)
    prog = xp_progress(xp)
    return {
        "name": prof.get("name", "Hero"),
        "total_xp": xp,
        "level": prog["level"],
        "xp_in_level": prog["xp_in_level"],
        "xp_to_next": prog["xp_to_next"],
        "xp_progress": prog["progress"],
        "is_max_level": prog["is_max"],
        "current_streak": prof.get("current_streak", 0),
        "longest_streak": prof.get("longest_streak", 0),
        "last_active_date": prof.get("last_active_date"),
        "tasks_completed": prof.get("tasks_completed", 0),
        "goals_created": prof.get("goals_created", 0),
        "goals_completed": prof.get("goals_completed", 0),
        "achievements_unlocked": prof.get("achievements_unlocked", []),
        "onboarding_complete": prof.get("onboarding_complete", False),
        "onboarding": prof.get("onboarding", {}),
        "bio": prof.get("bio", ""),
        "avatar_base64": prof.get("avatar_base64"),
        "wake_time": prof.get("wake_time", "07:00"),
        "morning_setup_done": prof.get("morning_setup_done", False),
        # New day-anchor system
        "day_start_time": prof.get("day_start_time"),
        "timezone": prof.get("timezone"),
        # Treat the day-anchor onboarding as DONE if either the explicit
        # flag is set OR the two source fields (timezone + day_start_time)
        # are both populated. This prevents legacy/upgrade users — whose
        # documents pre-date the `onboarding_tz_done` flag — from being
        # re-prompted to choose their timezone & morning start time after
        # an app update.
        "onboarding_tz_done": bool(
            prof.get("onboarding_tz_done")
            or (prof.get("timezone") and prof.get("day_start_time"))
        ),
        # Spot-the-Object mini-app
        "spot_points": int(prof.get("spot_points", 0) or 0),
        "spot_random_enabled": bool(prof.get("spot_random_enabled", False)),
        # Creator/Admin (Premium+) — derived from the user's email; never stored on profile
        "is_admin": _is_admin_email(prof.get("_email_cache")),
        # XP Boost state (Points+ feature)
        "boosts_unlocked": prof.get("boosts_unlocked", False),
        "active_boost": _serialize_active_boost(prof),
        "boost_inventory": _serialize_boost_inventory(prof),
        "tz_offset_minutes": int(prof.get("tz_offset_minutes", 0) or 0),
        "created_at": prof.get("created_at"),
        # Last time this user opened the app — kept on the personal
        # profile too for symmetry with `_serialize_player` so any future
        # UI surface that reads /api/profile can render an "Active X hrs
        # ago" label without an extra round-trip.
        "last_seen_at": prof.get("last_seen_at"),
    }


# ──── XP Boosts (Points+) ─────────────────────────────────────────────
BOOST_UNLOCK_CODE = "XP270905W20"

BOOST_DEFS = {
    "triple_day":   {"multiplier": 3, "duration_days": 1,  "label": "Triple points today"},
    "double_week":  {"multiplier": 2, "duration_days": 7,  "label": "Double points for 7 days"},
    "double_month": {"multiplier": 2, "duration_days": 30, "label": "Double points for 1 month"},
}


def _serialize_active_boost(prof: dict) -> Optional[dict]:
    """Return the active boost if still within its window, else None."""
    boost = prof.get("xp_boost") or {}
    exp = boost.get("expires_at")
    if not exp:
        return None
    try:
        exp_dt = datetime.fromisoformat(exp.replace("Z", "+00:00"))
        if exp_dt.tzinfo is None:
            exp_dt = exp_dt.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) >= exp_dt:
            return None
    except Exception:
        return None
    return {
        "type": boost.get("type"),
        "multiplier": int(boost.get("multiplier", 1)),
        "activated_at": boost.get("activated_at"),
        "expires_at": exp,
    }


async def _current_xp_multiplier(user_id: str) -> int:
    """Fetch the multiplier currently applicable to this user (1, 2, or 3)."""
    prof = await db.profile.find_one({"_id": user_id})
    if not prof:
        return 1
    active = _serialize_active_boost(prof)
    return int(active["multiplier"]) if active else 1


def _serialize_boost_inventory(prof: dict) -> list:
    """Return the user's inventory of owned (un-activated) boosts.
    Each entry: {id, type, multiplier, duration_days, label, source, acquired_at}.
    Filters out already-activated entries."""
    inv = prof.get("boost_inventory") or []
    out = []
    for it in inv:
        if it.get("activated"):
            continue
        cfg = BOOST_DEFS.get(it.get("type")) or {}
        out.append({
            "id": it.get("id"),
            "type": it.get("type"),
            "multiplier": int(it.get("multiplier") or cfg.get("multiplier", 1)),
            "duration_days": int(it.get("duration_days") or cfg.get("duration_days", 1)),
            "label": it.get("label") or cfg.get("label", ""),
            "source": it.get("source") or "shop",     # shop | leaderboard_winner
            "acquired_at": it.get("acquired_at"),
        })
    return out


async def check_and_unlock_achievements(prof: dict) -> List[str]:
    if not prof:
        return []
    unlocked = set(prof.get("achievements_unlocked", []))
    newly = []
    level = level_from_xp(prof.get("total_xp", 0))
    stats = {
        "tasks_completed": prof.get("tasks_completed", 0),
        "streak": prof.get("longest_streak", 0),
        "level": level,
        "goals_created": prof.get("goals_created", 0),
        "goals_completed": prof.get("goals_completed", 0),
    }
    for ach in ACHIEVEMENT_DEFS:
        if ach["id"] in unlocked:
            continue
        if stats.get(ach["type"], 0) >= ach["threshold"]:
            unlocked.add(ach["id"])
            newly.append(ach["id"])
    if newly:
        await db.profile.update_one(
            {"_id": prof["_id"]},
            {"$set": {"achievements_unlocked": list(unlocked)}},
        )
    return newly


async def update_streak(prof: dict) -> dict:
    today = today_str()
    last = prof.get("last_active_date")
    if last == today:
        return prof
    new_streak = prof.get("current_streak", 0)
    if last is None:
        new_streak = 1
    else:
        try:
            last_date = datetime.fromisoformat(last).date()
            today_date = datetime.now(timezone.utc).date()
            diff = (today_date - last_date).days
            if diff == 1:
                new_streak += 1
            elif diff > 1:
                new_streak = 1
            else:
                new_streak = max(new_streak, 1)
        except Exception:
            new_streak = 1
    # Hard cap: 5,000 days. Anything beyond is purely cosmetic and can
    # cause UI issues (>4-digit text overflowing the streak badge), and
    # is functionally irrelevant — staying engaged for ~13.7 years
    # already qualifies as a champion regardless of the displayed digit.
    if new_streak > 5000:
        new_streak = 5000
    longest = max(prof.get("longest_streak", 0), new_streak)
    if longest > 5000:
        longest = 5000
    await db.profile.update_one(
        {"_id": prof["_id"]},
        {"$set": {
            "last_active_date": today,
            "current_streak": new_streak,
            "longest_streak": longest,
        }}
    )
    prof["last_active_date"] = today
    prof["current_streak"] = new_streak
    prof["longest_streak"] = longest
    return prof


async def _bump_streak_for_xp(user_id: str) -> None:
    """Mark today as an active day for streak purposes, called from every
    code-path that grants the user POSITIVE XP (task complete, goal
    complete, challenge complete, sleep check-in, focus session,
    gifted XP from creator, etc.). Streaks now persist as long as the
    user earns ANY XP that day — they are no longer task-only.

    Never raises. Streak math is non-critical and must not block the
    actual XP grant if the DB is hot or the profile doc is missing.
    """
    try:
        prof = await db.profile.find_one({"_id": user_id})
        if prof:
            await update_streak(prof)
    except Exception as e:
        logger.warning("[streak] bump failed for %s: %s", user_id, e)


# ------------------------------------------------------------------
# Models
# ------------------------------------------------------------------
class TaskCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    focus_area: Literal["social", "fitness", "appearance", "mindset"]
    time_slot: Literal["morning", "afternoon", "evening"]
    xp_value: int = 20
    recurring: bool = True
    scheduled_time: Optional[str] = None  # "HH:MM" 24h
    reminder_enabled: bool = True


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    focus_area: Optional[Literal["social", "fitness", "appearance", "mindset"]] = None
    time_slot: Optional[Literal["morning", "afternoon", "evening"]] = None
    xp_value: Optional[int] = None
    recurring: Optional[bool] = None
    scheduled_time: Optional[str] = None
    reminder_enabled: Optional[bool] = None


# Fields that are LOCKED for default (seeded) tasks
LOCKED_DEFAULT_FIELDS = {"focus_area", "time_slot", "scheduled_time", "recurring"}

# Maximum custom (non-default) tasks a user can create
MAX_CUSTOM_TASKS = 11


class GoalCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    focus_area: Literal["social", "fitness", "appearance", "mindset"]
    target_value: int = 100
    unit: Optional[str] = "days"
    xp_reward: Optional[int] = None  # capped on backend by unit; defaults sensibly


class GoalUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    current_value: Optional[int] = None
    target_value: Optional[int] = None


class GoalProgress(BaseModel):
    current_value: int


# ─────────────── Goal XP cap by duration unit ───────────────
# Long-term goals award XP on completion. The XP value is capped based on
# how long the user is committing to (longer = bigger reward, up to a max).
GOAL_XP_CAPS: dict = {
    "days": 30,
    "weeks": 225,
    "months": 900,
}
GOAL_XP_DEFAULT = 100  # fallback for legacy goals without xp_reward


def _clamp_goal_xp(unit: Optional[str], xp: Optional[int]) -> int:
    """Clamp the user-requested XP reward to the cap for the chosen unit.
       If no unit cap exists (legacy free-text units like 'km'), use 100 as a hard cap."""
    cap = GOAL_XP_CAPS.get((unit or "").lower(), GOAL_XP_DEFAULT)
    if xp is None or xp < 1:
        # Sensible default: half of the cap, rounded to nearest 5
        return max(5, (cap // 2 // 5) * 5)
    return max(1, min(int(xp), cap))


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    wake_time: Optional[str] = None  # legacy — kept for backward compat
    morning_setup_done: Optional[bool] = None
    tz_offset_minutes: Optional[int] = None  # viewer's current UTC offset (weekly leaderboard)
    # New day-anchor system — LOCKED once set (only profile/reset clears them).
    day_start_time: Optional[str] = None  # "HH:MM" 24h, in user's timezone
    timezone: Optional[str] = None         # IANA e.g. "Australia/Sydney"
    onboarding_tz_done: Optional[bool] = None


class CompleteTaskBody(BaseModel):
    date: Optional[str] = None  # YYYY-MM-DD


# ------------------------------------------------------------------
# Auth Routes
# ------------------------------------------------------------------
class RegisterPayload(BaseModel):
    full_name: str = Field(min_length=1)
    email: EmailStr
    password: str = Field(min_length=5)


class VerifyPayload(BaseModel):
    email: EmailStr
    code: str


class LoginPayload(BaseModel):
    email: EmailStr
    password: str


class ResendPayload(BaseModel):
    email: EmailStr


class ForgotPasswordPayload(BaseModel):
    email: EmailStr
    app_origin: Optional[str] = None  # frontend origin (e.g. https://app.example.com)


class ResetPasswordWithCodePayload(BaseModel):
    email: EmailStr
    code: str = Field(min_length=4, max_length=10)
    new_password: str = Field(min_length=5)


class ResetPasswordWithTokenPayload(BaseModel):
    token: str = Field(min_length=10)
    new_password: str = Field(min_length=5)


class VerifyResetTokenPayload(BaseModel):
    token: str = Field(min_length=10)


def _serialize_user(u: dict) -> dict:
    return {
        "id": u.get("_id"),
        "full_name": u.get("full_name"),
        "email": u.get("email"),
        "verified": bool(u.get("verified")),
        "created_at": u.get("created_at"),
    }


@api_router.post("/auth/register")
async def auth_register(body: RegisterPayload):
    # 1. Strict email validation: format + DNS MX + disposable blocklist
    try:
        email_norm = _validate_real_email(body.email)
    except EmailValidationError as e:
        raise HTTPException(400, str(e))

    existing = await db.users.find_one({"email": email_norm})
    if existing and existing.get("verified"):
        raise HTTPException(400, "An account with this email already exists. Please log in.")
    user_id = existing["_id"] if existing else str(uuid.uuid4())
    # Email verification has been disabled — accounts are usable immediately
    # after registration. We still validate the email format + MX records so
    # garbage addresses are rejected, but no 6-digit code is required.
    doc = {
        "_id": user_id,
        "email": email_norm,
        "full_name": body.full_name.strip(),
        "password_hash": hash_password(body.password),
        "verified": True,
        "verified_at": now_iso(),
        "created_at": now_iso(),
    }
    await db.users.replace_one({"_id": user_id}, doc, upsert=True)
    # Ensure a profile exists so the user can immediately start using the app
    await get_or_create_profile_for(user_id, body.full_name.strip())
    token = make_token(user_id, email_norm)
    user_doc = await db.users.find_one({"_id": user_id})
    return {
        "token": token,
        "user": _serialize_user(user_doc),
        "message": "Account created. You're signed in.",
    }


@api_router.post("/auth/verify")
async def auth_verify(body: VerifyPayload):
    email_norm = body.email.lower().strip()
    user = await db.users.find_one({"email": email_norm})
    if not user:
        raise HTTPException(404, "Account not found — please register first.")
    if user.get("verified"):
        token = make_token(user["_id"], email_norm)
        return {"token": token, "user": _serialize_user(user)}
    if user.get("verification_code") != body.code.strip():
        raise HTTPException(400, "Wrong code. Please try again.")
    try:
        exp = datetime.fromisoformat(user.get("verification_expires") or "")
        if exp < datetime.now(timezone.utc):
            raise HTTPException(400, "Code expired. Tap 'Resend code' to get a fresh one.")
    except HTTPException:
        raise
    except Exception:
        pass
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"verified": True, "verified_at": now_iso()}, "$unset": {"verification_code": "", "verification_expires": ""}},
    )
    user = await db.users.find_one({"_id": user["_id"]})
    # Bootstrap profile + default tasks for this user
    await get_or_create_profile_for(user["_id"], user.get("full_name", ""))
    await seed_default_tasks_for_user(user["_id"])
    token = make_token(user["_id"], email_norm)
    return {"token": token, "user": _serialize_user(user)}


@api_router.post("/auth/resend")
async def auth_resend(body: ResendPayload):
    email_norm = body.email.lower().strip()
    user = await db.users.find_one({"email": email_norm})
    if not user:
        raise HTTPException(404, "Account not found")
    if user.get("verified"):
        return {"message": "Already verified — please log in."}
    code = _gen_code()
    expires = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"verification_code": code, "verification_expires": expires}},
    )
    sent_real = False
    try:
        sent_real = _send_verification_email(email_norm, code, user.get("full_name", ""))
    except Exception as e:
        raise HTTPException(400, f"Could not deliver email: {str(e)[:120]}")
    response = {"message": "Code resent.", "email_delivered": sent_real}
    if not os.environ.get("RESEND_API_KEY"):
        response["dev_code"] = code
    return response


@api_router.post("/auth/login")
async def auth_login(body: LoginPayload):
    email_norm = body.email.lower().strip()
    user = await db.users.find_one({"email": email_norm})
    if not user or not verify_password(body.password, user.get("password_hash", "")):
        raise HTTPException(401, "Wrong email or password.")
    # Block suspended accounts at the login boundary so they get the
    # explicit reason instead of generic 401. Admin accounts are exempt
    # (no profile.suspended_until is ever set on them).
    await _check_not_suspended(user["_id"])
    # Email verification is no longer required — accounts are usable
    # immediately after registration. Log the user in unconditionally.
    if not user.get("verified"):
        await db.users.update_one(
            {"_id": user["_id"]},
            {"$set": {"verified": True, "verified_at": now_iso()},
             "$unset": {"verification_code": "", "verification_expires": ""}},
        )
        user["verified"] = True
    token = make_token(user["_id"], email_norm)
    return {"token": token, "user": _serialize_user(user)}


@api_router.get("/auth/me")
async def auth_me(user_id: str = Depends(get_current_user)):
    user = await db.users.find_one({"_id": user_id})
    if not user:
        raise HTTPException(404, "User not found")
    return _serialize_user(user)


# ─────────────── Password Reset (forgot password) ───────────────
def _send_password_reset_email(
    email: str, code: str, link: str, full_name: str = ""
) -> bool:
    """Send the password-reset email containing BOTH:
       a) a clickable magic-link button to /auth/reset-password?token=...
       b) a 6-digit fallback code for manual entry inside the app

       Returns True if Resend actually delivered, False if dev-mode log only.
       Raises if Resend is configured but the send fails (so caller can refuse).
    """
    auth_log = logging.getLogger("auth")
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        auth_log.warning(
            "[DEV-EMAIL] PWD-RESET → %s  link=%s  code=%s",
            email, link, code,
        )
        return False
    try:
        import resend  # type: ignore
        resend.api_key = api_key
        sender = os.environ.get("RESEND_FROM", "XP in Real Life <onboarding@resend.dev>")
        html = (
            f"<div style='font-family:-apple-system,Segoe UI,sans-serif;background:#0b0d12;"
            f"color:#fff;padding:32px;border-radius:12px;max-width:480px;margin:auto'>"
            f"<h2 style='color:#5cffb1;margin:0 0 6px'>Reset your password 🔑</h2>"
            f"<p style='color:#aab1c2;margin:0 0 24px'>"
            f"Hi {full_name or 'there'} — we got a request to reset your XP in Real Life password. "
            f"Choose either option below:</p>"

            f"<div style='background:#11151c;border:1px solid #1f2733;border-radius:8px;"
            f"padding:18px;margin-bottom:14px'>"
            f"<p style='color:#aab1c2;font-size:11px;letter-spacing:1.2px;font-weight:800;"
            f"margin:0 0 10px;text-transform:uppercase'>Option 1 · Tap the link</p>"
            f"<a href='{link}' style='display:inline-block;background:#5cffb1;color:#0b0d12;"
            f"padding:14px 28px;border-radius:8px;font-weight:900;text-decoration:none;"
            f"letter-spacing:0.4px'>🔓 Reset Password</a>"
            f"<p style='color:#7a8294;font-size:11px;margin:12px 0 0'>"
            f"Or copy this URL: <span style='color:#5fd2ff'>{link}</span></p>"
            f"</div>"

            f"<div style='background:#11151c;border:1px solid #1f2733;border-radius:8px;"
            f"padding:18px;margin-bottom:14px'>"
            f"<p style='color:#aab1c2;font-size:11px;letter-spacing:1.2px;font-weight:800;"
            f"margin:0 0 10px;text-transform:uppercase'>Option 2 · Use this 6-digit code in the app</p>"
            f"<div style='font-size:36px;font-weight:900;letter-spacing:10px;color:#5fd2ff;"
            f"text-align:center;font-variant:tabular-nums;padding:14px 0;"
            f"background:#0b0d12;border-radius:6px'>{code}</div>"
            f"</div>"

            f"<p style='color:#7a8294;font-size:12px;margin:24px 0 0;line-height:1.5'>"
            f"Both options expire in 30 minutes. If you didn't request this, just ignore this "
            f"email — your password won't change.</p>"
            f"</div>"
        )
        text = (
            f"Hi {full_name or 'there'},\n\n"
            "We got a request to reset your XP in Real Life password.\n\n"
            f"Option 1 — open this link:\n{link}\n\n"
            f"Option 2 — paste this code in the app: {code}\n\n"
            "Both expire in 30 minutes.\n\n"
            "If you didn't request this, ignore this email."
        )
        resend.Emails.send({
            "from": sender,
            "to": [email],
            "subject": "Reset your XP in Real Life password",
            "html": html,
            "text": text,
        })
        auth_log.info("Password-reset email sent to %s", email)
        return True
    except Exception as e:
        auth_log.exception("Resend send failed for reset to %s: %s", email, e)
        raise


def _build_reset_link(token: str, email: str, request: Request, app_origin: Optional[str]) -> str:
    """Build the magic link the user clicks in the email.
       Priority: explicit app_origin → request Origin/Referer header → APP_URL env.
    """
    origin: Optional[str] = (app_origin or "").strip().rstrip("/") or None
    if not origin:
        # Try the Origin / Referer header from the calling browser
        h = request.headers.get("origin") or request.headers.get("referer") or ""
        if h:
            from urllib.parse import urlparse
            p = urlparse(h)
            if p.scheme and p.netloc:
                origin = f"{p.scheme}://{p.netloc}"
    if not origin:
        origin = (os.environ.get("APP_URL") or "").rstrip("/") or "http://localhost:3000"
    from urllib.parse import quote
    return f"{origin}/auth/reset-password?token={quote(token)}&email={quote(email)}"


@api_router.post("/auth/forgot-password")
async def auth_forgot_password(body: ForgotPasswordPayload, request: Request):
    """Step 1: user enters email. We:
       a) check the email is actually registered
       b) generate a fresh 6-digit code AND a long URL token
       c) email both the link and the code
    """
    email_norm = body.email.lower().strip()
    user = await db.users.find_one({"email": email_norm})
    if not user:
        raise HTTPException(
            404,
            "We couldn't find an account with that email. "
            "Double-check it, or register a new account.",
        )
    code = _gen_code()
    token = _gen_reset_token()
    expires = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {
            "reset_code": code,
            "reset_token": token,
            "reset_expires": expires,
        }},
    )
    link = _build_reset_link(token, email_norm, request, body.app_origin)
    sent_real = False
    try:
        sent_real = _send_password_reset_email(
            email_norm, code, link, user.get("full_name", "")
        )
    except Exception as e:
        raise HTTPException(
            400,
            f"We couldn't deliver the reset email to {email_norm}. ({str(e)[:120]})",
        )
    response = {
        "message": (
            "Reset email sent. Check your inbox (and spam folder) — it includes a link AND a 6-digit code."
            if sent_real else
            "Reset email sent. Check backend logs in dev mode."
        ),
        "email": email_norm,
        "email_delivered": sent_real,
    }
    if not os.environ.get("RESEND_API_KEY"):
        # dev mode: surface code + link so the tester can verify without an inbox
        response["dev_code"] = code
        response["dev_link"] = link
    return response


@api_router.post("/auth/reset-password-verify-token")
async def auth_reset_password_verify_token(body: VerifyResetTokenPayload):
    """Optional helper: lets the reset-password screen check a magic-link token
       BEFORE asking the user for a new password. Returns the email so the UI
       can display 'Resetting password for foo@bar.com'.
    """
    user = await db.users.find_one({"reset_token": body.token})
    if not user:
        raise HTTPException(400, "This reset link is invalid or has already been used.")
    expires = user.get("reset_expires")
    if not expires:
        raise HTTPException(400, "This reset link has expired.")
    try:
        exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > exp_dt:
            raise HTTPException(400, "This reset link has expired. Request a new one.")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "This reset link is invalid.")
    return {"valid": True, "email": user.get("email")}


@api_router.post("/auth/reset-password")
async def auth_reset_password(body: ResetPasswordWithCodePayload):
    """Reset using the email + 6-digit code combo (Option 2 in the email)."""
    email_norm = body.email.lower().strip()
    user = await db.users.find_one({"email": email_norm})
    if not user:
        raise HTTPException(404, "No account with that email.")
    stored_code = user.get("reset_code")
    expires = user.get("reset_expires")
    if not stored_code or not expires:
        raise HTTPException(400, "No active password-reset request. Tap 'Forgot password?' again.")
    try:
        exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > exp_dt:
            raise HTTPException(400, "This reset code has expired. Request a new one.")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "Reset request is invalid.")
    if body.code.strip() != stored_code:
        raise HTTPException(400, "That code is incorrect. Double-check the email.")
    # Update password + invalidate the reset code/token
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {
            "password_hash": hash_password(body.new_password),
            "verified": True,  # email ownership is proven by receiving the code
        },
        "$unset": {
            "reset_code": "",
            "reset_token": "",
            "reset_expires": "",
        }},
    )
    user = await db.users.find_one({"_id": user["_id"]})
    token = make_token(user["_id"], email_norm)
    return {"token": token, "user": _serialize_user(user)}


@api_router.post("/auth/reset-password-token")
async def auth_reset_password_token(body: ResetPasswordWithTokenPayload):
    """Reset using the magic-link token (Option 1 in the email)."""
    user = await db.users.find_one({"reset_token": body.token})
    if not user:
        raise HTTPException(400, "This reset link is invalid or has already been used.")
    expires = user.get("reset_expires")
    if not expires:
        raise HTTPException(400, "This reset link has expired.")
    try:
        exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > exp_dt:
            raise HTTPException(400, "This reset link has expired. Request a new one.")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "Reset request is invalid.")
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {
            "password_hash": hash_password(body.new_password),
            "verified": True,
        },
        "$unset": {
            "reset_code": "",
            "reset_token": "",
            "reset_expires": "",
        }},
    )
    user = await db.users.find_one({"_id": user["_id"]})
    token = make_token(user["_id"], user.get("email"))
    return {"token": token, "user": _serialize_user(user)}


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@api_router.get("/")
async def root():
    return {"app": "LevelUp", "status": "ok"}


@api_router.get("/profile")
async def get_profile(user_id: str = Depends(get_user_or_legacy)):
    prof = await get_or_create_profile_for(user_id)
    # Inject email cache so serialize_profile can derive is_admin
    u = await db.users.find_one({"_id": user_id}, {"email": 1})
    if u and u.get("email"):
        prof["_email_cache"] = u.get("email")
    return serialize_profile(prof)


@api_router.put("/profile")
async def update_profile(body: ProfileUpdate, user_id: str = Depends(get_user_or_legacy)):
    prof = await get_or_create_profile_for(user_id)
    update = {k: v for k, v in body.dict().items() if v is not None}

    # Lock rule: once `timezone` / `day_start_time` are set, they can only be
    # changed via POST /api/profile/reset. Allow the first-write transparently.
    if "timezone" in update and prof.get("timezone"):
        raise HTTPException(400, detail={
            "error": "tz_locked",
            "message": "Timezone is locked. Reset your progress in Profile to change it.",
        })
    if "day_start_time" in update and prof.get("day_start_time"):
        raise HTTPException(400, detail={
            "error": "day_start_locked",
            "message": "Morning start time is locked. Reset your progress in Profile to change it.",
        })
    # When user answers the two onboarding questions, auto-flip the flag
    if ("timezone" in update or "day_start_time" in update) and (
        update.get("timezone") or prof.get("timezone")
    ) and (update.get("day_start_time") or prof.get("day_start_time")):
        update["onboarding_tz_done"] = True

    if update:
        await db.profile.update_one({"_id": user_id}, {"$set": update})
    prof = await db.profile.find_one({"_id": user_id})
    return serialize_profile(prof)


@api_router.post("/profile/reset")
async def reset_profile(user_id: str = Depends(get_user_or_legacy)):
    await db.profile.delete_one({"_id": user_id})
    await db.tasks.delete_many({"user_id": user_id})
    await db.goals.delete_many({"user_id": user_id})
    await db.task_logs.delete_many({"user_id": user_id})
    prof = await get_or_create_profile_for(user_id)
    return serialize_profile(prof)


class OnboardingData(BaseModel):
    name: Optional[str] = None
    main_goals: Optional[List[str]] = None
    experience_level: Optional[str] = None  # beginner / intermediate / expert
    productivity_score: Optional[int] = None  # 1-10
    loves: Optional[List[str]] = None
    loves_other: Optional[str] = None
    focused_time: Optional[str] = None  # morning, midday, evening, etc
    focused_window: Optional[str] = None  # early / after
    good_habits: Optional[List[str]] = None
    good_habits_other: Optional[str] = None
    bad_habits: Optional[List[str]] = None
    bad_habits_other: Optional[str] = None
    age_range: Optional[str] = None  # 12-16, 17-20, 21-25, 25-30, 31-40, 41+
    gender: Optional[str] = None  # boy / girl / other
    skip_complete: bool = False


class AvatarData(BaseModel):
    avatar_base64: Optional[str] = None


def _build_bio(data: dict) -> str:
    parts: List[str] = []
    age = data.get("age_range")
    gender = data.get("gender")
    exp = data.get("experience_level")

    intro_bits = []
    if age:
        intro_bits.append(f"{age}")
    if gender and gender.lower() != "other":
        intro_bits.append(gender.lower())
    if exp:
        intro_bits.append(exp.lower())

    if intro_bits:
        parts.append(f"A {' · '.join(intro_bits)} on a self-improvement quest.")
    else:
        parts.append("On a self-improvement quest.")

    goals = data.get("main_goals") or []
    if goals:
        parts.append(f"Main focus: {', '.join(goals[:4]).lower()}.")

    loves = list(data.get("loves") or [])
    if data.get("loves_other"):
        loves.append(data["loves_other"])
    if loves:
        parts.append(f"Loves {', '.join(loves[:5]).lower()}.")

    ft = data.get("focused_time")
    fw = data.get("focused_window")
    if ft:
        window = f"{fw} " if fw else ""
        parts.append(f"Most productive in the {window}{ft}.".lower().capitalize())

    good = list(data.get("good_habits") or [])
    if data.get("good_habits_other"):
        good.append(data["good_habits_other"])
    if good:
        parts.append(f"Good habits: {', '.join(good[:5]).lower()}.")

    bad = list(data.get("bad_habits") or [])
    if data.get("bad_habits_other"):
        bad.append(data["bad_habits_other"])
    if bad:
        parts.append(f"Working on reducing: {', '.join(bad[:5]).lower()}.")

    prod = data.get("productivity_score")
    if prod is not None:
        parts.append(f"Current productivity: {prod}/10 — leveling up.")

    return " ".join(parts)


@api_router.put("/profile/onboarding")
async def update_onboarding(body: OnboardingData, user_id: str = Depends(get_user_or_legacy)):
    await get_or_create_profile_for(user_id)
    payload = {k: v for k, v in body.dict().items() if v is not None and k != "skip_complete"}

    prof = await db.profile.find_one({"_id": user_id})
    existing = dict(prof.get("onboarding") or {})
    existing.update(payload)

    update = {"onboarding": existing}
    if body.name:
        update["name"] = body.name
    update["bio"] = _build_bio(existing)
    update["onboarding_complete"] = True

    await db.profile.update_one({"_id": user_id}, {"$set": update})
    prof = await db.profile.find_one({"_id": user_id})
    return serialize_profile(prof)


@api_router.post("/profile/avatar")
async def set_avatar(body: AvatarData, user_id: str = Depends(get_user_or_legacy)):
    await get_or_create_profile_for(user_id)
    await db.profile.update_one(
        {"_id": user_id},
        {"$set": {"avatar_base64": body.avatar_base64}},
    )
    prof = await db.profile.find_one({"_id": user_id})
    return serialize_profile(prof)


# --------- Tasks ---------
@api_router.get("/tasks")
async def list_tasks(date: Optional[str] = None, user_id: str = Depends(get_user_or_legacy)):
    """List all task templates with completion status for the given date.

    Order is adaptive: within each time slot, tasks are sorted by the user's
    completion order from the most recent day that had completions. Tasks the
    user completed earliest yesterday float to the top today.
    """
    target_date = date or today_str()
    tasks = await db.tasks.find({"user_id": user_id}, {"_id": 0}).to_list(1000)
    logs = await db.task_logs.find({"user_id": user_id, "date": target_date}, {"_id": 0}).to_list(1000)
    done_ids = {log["task_id"] for log in logs}
    for t in tasks:
        t["completed"] = t["id"] in done_ids

    # Build adaptive rank from the most recent prior day with completions
    rank_map: dict = {}
    rank_source_date: Optional[str] = None
    today_d = datetime.now(timezone.utc).date()
    try:
        target_d = datetime.fromisoformat(target_date).date()
    except Exception:
        target_d = today_d
    for delta in range(1, 15):  # look back up to 14 days
        d_str = (target_d - timedelta(days=delta)).isoformat()
        prior = await db.task_logs.find({"user_id": user_id, "date": d_str}, {"_id": 0}).sort("completed_at", 1).to_list(1000)
        if prior:
            rank_map = {log["task_id"]: i for i, log in enumerate(prior)}
            rank_source_date = d_str
            break

    slot_order = {"morning": 0, "afternoon": 1, "evening": 2}

    def sort_key(t):
        return (
            slot_order.get(t.get("time_slot", "morning"), 3),
            rank_map.get(t["id"], 10_000),  # unseen/new tasks go last within slot
            t.get("created_at", ""),
        )

    tasks.sort(key=sort_key)
    return {
        "date": target_date,
        "tasks": tasks,
        "order_source_date": rank_source_date,
        "adaptive_order": bool(rank_map),
    }


@api_router.post("/tasks")
async def create_task(body: TaskCreate, user_id: str = Depends(get_user_or_legacy)):
    # enforce 11-custom-task limit per-user (defaults don't count)
    custom_count = await db.tasks.count_documents({"user_id": user_id, "is_default": {"$ne": True}})
    if custom_count >= MAX_CUSTOM_TASKS:
        raise HTTPException(
            400,
            f"You've hit the {MAX_CUSTOM_TASKS}-quest limit. Delete a custom quest before adding another.",
        )
    task = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "title": body.title,
        "description": body.description or "",
        "focus_area": body.focus_area,
        "time_slot": body.time_slot,
        # Custom (user-created) tasks are capped at 20 XP. Default seeded tasks
        # bypass this and can be 5-200 (set in seed_default_tasks_for_user).
        # Creator/Admin bypass the cap entirely (Premium+).
        "xp_value": (int(body.xp_value) if await _is_admin_user(user_id) else max(5, min(20, body.xp_value))),
        "recurring": body.recurring,
        "scheduled_time": body.scheduled_time,
        "reminder_enabled": body.reminder_enabled,
        "is_default": False,
        "created_at": now_iso(),
    }
    await db.tasks.insert_one(task)
    task.pop("_id", None)
    return task


@api_router.put("/tasks/{task_id}")
async def update_task(task_id: str, body: TaskUpdate, user_id: str = Depends(get_user_or_legacy)):
    existing = await db.tasks.find_one({"id": task_id, "user_id": user_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Task not found")
    update = {k: v for k, v in body.dict().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")
    if existing.get("is_default"):
        blocked = [k for k in update.keys() if k in LOCKED_DEFAULT_FIELDS]
        if blocked:
            raise HTTPException(
                400,
                f"Cannot change {', '.join(blocked)} on a default quest — only title, description, XP and reminder are editable.",
            )
    # Custom (non-default) tasks: cap XP at 20.  Default tasks are unrestricted.
    # Creator/Admin bypass the cap entirely.
    if "xp_value" in update and not existing.get("is_default") and not await _is_admin_user(user_id):
        update["xp_value"] = max(5, min(20, int(update["xp_value"])))
    await db.tasks.update_one({"id": task_id, "user_id": user_id}, {"$set": update})
    task = await db.tasks.find_one({"id": task_id, "user_id": user_id}, {"_id": 0})
    return task


@api_router.delete("/tasks/{task_id}")
async def delete_task(task_id: str, user_id: str = Depends(get_user_or_legacy)):
    existing = await db.tasks.find_one({"id": task_id, "user_id": user_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Task not found")
    if existing.get("is_default"):
        raise HTTPException(
            400,
            "Default quests cannot be deleted — you can only edit the title, description, XP and reminder.",
        )
    res = await db.tasks.delete_one({"id": task_id, "user_id": user_id})
    await db.task_logs.delete_many({"task_id": task_id, "user_id": user_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Task not found")
    return {"deleted": True}


@api_router.post("/tasks/{task_id}/complete")
async def complete_task(task_id: str, body: CompleteTaskBody, user_id: str = Depends(get_user_or_legacy)):
    target_date = body.date or today_str()
    task = await db.tasks.find_one({"id": task_id, "user_id": user_id}, {"_id": 0})
    if not task:
        raise HTTPException(404, "Task not found")
    existing = await db.task_logs.find_one({"task_id": task_id, "user_id": user_id, "date": target_date})
    if existing:
        return {"already_completed": True, "task": task}
    # XP Boost multiplier (Points+ feature). When the user has an active
    # boost, the XP awarded for each quest is scaled (2x or 3x) accordingly.
    multiplier = await _current_xp_multiplier(user_id)
    awarded = int(task["xp_value"]) * multiplier
    log = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "task_id": task_id,
        "date": target_date,
        "focus_area": task["focus_area"],
        "xp_awarded": awarded,
        "xp_multiplier": multiplier,
        "completed_at": now_iso(),
    }
    await db.task_logs.insert_one(log)

    # Get current profile level BEFORE update to detect level-up
    prof = await get_or_create_profile_for(user_id)
    prev_level = level_from_xp(prof.get("total_xp", 0))

    await db.profile.update_one(
        {"_id": user_id},
        {"$inc": {"total_xp": awarded, "tasks_completed": 1}},
    )
    # Weekly leaderboard: log XP event with user's local tz (for Mon-Sat window).
    try:
        tz_off = int((await db.profile.find_one({"_id": user_id}, {"tz_offset_minutes": 1}) or {}).get("tz_offset_minutes", 0) or 0)
        await _log_xp_event(user_id, awarded, tz_off)
    except Exception as _e:
        pass
    prof = await db.profile.find_one({"_id": user_id})
    prof = await update_streak(prof)
    new_level = level_from_xp(prof.get("total_xp", 0))
    newly_unlocked = await check_and_unlock_achievements(prof)
    prof = await db.profile.find_one({"_id": user_id})
    return {
        "task": task,
        "xp_awarded": awarded,
        "xp_multiplier": multiplier,
        "leveled_up": new_level > prev_level,
        "new_level": new_level,
        "profile": serialize_profile(prof),
        "newly_unlocked_achievements": newly_unlocked,
    }


@api_router.post("/tasks/{task_id}/uncomplete")
async def uncomplete_task(task_id: str, body: CompleteTaskBody, user_id: str = Depends(get_user_or_legacy)):
    target_date = body.date or today_str()
    log = await db.task_logs.find_one({"task_id": task_id, "user_id": user_id, "date": target_date})
    if not log:
        return {"already_uncompleted": True}
    await db.task_logs.delete_one({"task_id": task_id, "user_id": user_id, "date": target_date})
    await db.profile.update_one(
        {"_id": user_id},
        {"$inc": {"total_xp": -log["xp_awarded"], "tasks_completed": -1}},
    )
    # Clamp negative values
    prof = await db.profile.find_one({"_id": user_id})
    fixes = {}
    if prof.get("total_xp", 0) < 0:
        fixes["total_xp"] = 0
    if prof.get("tasks_completed", 0) < 0:
        fixes["tasks_completed"] = 0
    if fixes:
        await db.profile.update_one({"_id": user_id}, {"$set": fixes})
    prof = await db.profile.find_one({"_id": user_id})
    return {"profile": serialize_profile(prof), "xp_removed": log["xp_awarded"]}


# --------- Goals ---------
# ─────────────── Goal cycle lockout (per-tick rate limit) ───────────────
# Long-term goals can only be ticked once per cycle. The cycle length depends
# on the goal's `unit`:
#   days   →  one tick per **calendar date** (resets at local midnight)
#   weeks  →  one tick per 7-day rolling window (from last tick)
#   months →  one tick per 29-day rolling window
GOAL_CYCLE_LOCKOUT: dict = {
    "weeks": timedelta(days=7),
    "months": timedelta(days=29),
}


def _goal_lockout_for(unit: Optional[str]) -> Optional[timedelta]:
    return GOAL_CYCLE_LOCKOUT.get((unit or "").lower())


def _is_goal_locked(goal: dict) -> tuple[bool, Optional[datetime]]:
    """Returns (locked, next_unlock_dt). For `days` we use calendar-date
    boundaries — a goal ticked on 2026-04-27 is locked until 2026-04-28 00:00
    *local* (midnight). For weeks/months we use a rolling-window timedelta."""
    unit = (goal.get("unit") or "").lower()
    last_iso = goal.get("last_ticked_at")
    if not last_iso:
        return False, None
    try:
        last = datetime.fromisoformat(last_iso.replace("Z", "+00:00"))
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
    except Exception:
        return False, None

    if unit == "days":
        # Calendar-day reset: next unlock is the start of the day AFTER
        # the day on which we last ticked.
        last_local = last.astimezone()
        next_local_midnight = (last_local + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        now = datetime.now(next_local_midnight.tzinfo)
        return now < next_local_midnight, next_local_midnight

    lock = GOAL_CYCLE_LOCKOUT.get(unit)
    if not lock:
        return False, None
    next_at = last + lock
    return datetime.now(timezone.utc) < next_at, next_at


def _enrich_goal_lock_state(goal: dict) -> dict:
    """Compute and attach `next_tick_available_at` / `is_locked` so the
    frontend can render the cycle-lock UI without re-implementing the rules."""
    locked, next_at = _is_goal_locked(goal)
    goal["is_locked"] = locked
    goal["next_tick_available_at"] = next_at.isoformat() if next_at else None
    return goal


def _enrich_goals(goals: list[dict]) -> list[dict]:
    return [_enrich_goal_lock_state(g) for g in goals]


@api_router.get("/goals")
async def list_goals(user_id: str = Depends(get_user_or_legacy)):
    goals = await db.goals.find({"user_id": user_id}, {"_id": 0}).to_list(1000)
    goals.sort(key=lambda g: g.get("created_at", ""), reverse=True)
    return {"goals": _enrich_goals(goals)}


@api_router.post("/goals")
async def create_goal(body: GoalCreate, user_id: str = Depends(get_user_or_legacy)):
    # Cap users to 5 active long-term goals at any time. Completed goals
    # don't count toward the limit so users always have room to add more
    # once they finish older ones.
    MAX_ACTIVE_GOALS = 5
    is_admin = await _is_admin_user(user_id)
    active_count = await db.goals.count_documents({"user_id": user_id, "completed": False})
    if active_count >= MAX_ACTIVE_GOALS and not is_admin:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "goal_limit_reached",
                "message": f"You can have up to {MAX_ACTIVE_GOALS} active goals at once. Finish or delete one to add a new goal.",
                "limit": MAX_ACTIVE_GOALS,
            },
        )
    unit_norm = (body.unit or "days").lower()
    xp_reward = body.xp_reward if is_admin else _clamp_goal_xp(unit_norm, body.xp_reward)
    goal = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "title": body.title,
        "description": body.description or "",
        "focus_area": body.focus_area,
        "target_value": body.target_value,
        "current_value": 0,
        "unit": unit_norm,
        "xp_reward": xp_reward,
        "completed": False,
        "created_at": now_iso(),
        "completed_at": None,
    }
    await db.goals.insert_one(goal)
    await db.profile.update_one({"_id": user_id}, {"$inc": {"goals_created": 1}})
    prof = await db.profile.find_one({"_id": user_id})
    await check_and_unlock_achievements(prof)
    goal.pop("_id", None)
    return goal


@api_router.put("/goals/{goal_id}")
async def update_goal(goal_id: str, body: GoalUpdate, user_id: str = Depends(get_user_or_legacy)):
    update = {k: v for k, v in body.dict().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")
    res = await db.goals.update_one({"id": goal_id, "user_id": user_id}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(404, "Goal not found")
    goal = await db.goals.find_one({"id": goal_id, "user_id": user_id}, {"_id": 0})
    return goal


@api_router.post("/goals/{goal_id}/progress")
async def update_goal_progress(goal_id: str, body: GoalProgress, user_id: str = Depends(get_user_or_legacy)):
    goal = await db.goals.find_one({"id": goal_id, "user_id": user_id}, {"_id": 0})
    if not goal:
        raise HTTPException(404, "Goal not found")

    # Cycle-lockout enforcement: if the user is *increasing* the tick count
    # but the goal is still inside its lockout window, refuse the request
    # with a clear "next available" timestamp so the UI can show the proper
    # message. The unit-aware logic lives in `_is_goal_locked`.
    requested_value = max(0, min(body.current_value, goal["target_value"]))
    incrementing = requested_value > int(goal.get("current_value", 0))
    if incrementing:
        locked, next_at = _is_goal_locked(goal)
        if locked and next_at is not None:
            raise HTTPException(
                status_code=429,
                detail={
                    "error": "cycle_locked",
                    "message": f"This goal is locked until the next {(goal.get('unit') or 'cycle').rstrip('s')} cycle.",
                    "next_tick_available_at": next_at.isoformat(),
                    "unit": goal.get("unit"),
                },
            )

    completed = requested_value >= goal["target_value"]
    update = {"current_value": requested_value, "completed": completed}
    if incrementing:
        update["last_ticked_at"] = now_iso()
    elif requested_value < int(goal.get("current_value", 0)):
        # User un-ticked: clear the lockout so they can re-tick immediately
        # (matches the "until it's clicked again" UX).
        update["last_ticked_at"] = None

    # ── Per-step XP for DAILY goals ──
    # Daily goals (unit == "days") award 30 XP per +1 step up to (but not
    # past) the target. When the user un-ticks, we refund 30 XP per step.
    # No step-XP is awarded for non-daily goals — only the completion
    # bonus (`xp_reward`) applies to those, preserving existing behavior.
    DAILY_STEP_XP = 30
    step_xp_delta = 0
    prev_value = int(goal.get("current_value", 0))
    unit_is_daily = (goal.get("unit") or "").lower() == "days"
    if unit_is_daily and requested_value != prev_value:
        target = int(goal.get("target_value", 0))
        # Steps that cross below/at target earn/refund XP. Steps past the
        # target are capped (extra ticks don't grant more XP per user's
        # "stop awarding XP once target is complete" rule).
        old_capped = min(prev_value, target)
        new_capped = min(requested_value, target)
        step_delta = new_capped - old_capped
        if step_delta != 0:
            step_xp_delta = step_delta * DAILY_STEP_XP
            await db.profile.update_one(
                {"_id": user_id},
                {"$inc": {"total_xp": step_xp_delta}},
            )
            # Tick a daily goal forward → log XP to charts so the bar /
            # line graphs reflect the new XP that was just earned. We
            # only log POSITIVE deltas — un-ticking refunds XP but
            # shouldn't go on the chart as a negative bar (the chart
            # shows earnings, not refunds).
            if step_xp_delta > 0:
                await _log_xp_to_charts(
                    user_id, step_xp_delta,
                    source="goal_step",
                    focus_area=goal.get("focus_area") or "mindset",
                )

    awarded_xp = 0
    refunded_xp = 0
    if completed and not goal.get("completed"):
        update["completed_at"] = now_iso()
        awarded_xp = int(goal.get("xp_reward") or GOAL_XP_DEFAULT)
        await db.profile.update_one(
            {"_id": user_id},
            {"$inc": {"goals_completed": 1, "total_xp": awarded_xp}},
        )
        # Goal completion → keep streak alive AND show on charts.
        await _bump_streak_for_xp(user_id)
        await _log_xp_to_charts(
            user_id, awarded_xp,
            source="goal_complete",
            focus_area=goal.get("focus_area") or "mindset",
        )
        prof = await db.profile.find_one({"_id": user_id})
        await check_and_unlock_achievements(prof)
    elif goal.get("completed") and not completed:
        # User reduced progress below target after the goal had already been
        # marked complete → revoke the previously-awarded XP.
        refunded_xp = int(goal.get("xp_reward") or GOAL_XP_DEFAULT)
        update["completed_at"] = None
        await db.profile.update_one(
            {"_id": user_id},
            {"$inc": {"goals_completed": -1, "total_xp": -refunded_xp}},
        )
    await db.goals.update_one({"id": goal_id, "user_id": user_id}, {"$set": update})
    goal = await db.goals.find_one({"id": goal_id, "user_id": user_id}, {"_id": 0})
    goal = _enrich_goal_lock_state(goal)
    if awarded_xp:
        goal["awarded_xp"] = awarded_xp
    if refunded_xp:
        goal["refunded_xp"] = refunded_xp
    if step_xp_delta:
        # Positive = XP gained on +1 step; negative = XP refunded on un-tick.
        goal["step_xp_delta"] = step_xp_delta
    return goal


@api_router.get("/goals/xp-caps")
async def goals_xp_caps():
    """Public: max XP a goal can award based on its duration unit."""
    return {"caps": GOAL_XP_CAPS, "default_xp": GOAL_XP_DEFAULT}


@api_router.delete("/goals/{goal_id}")
async def delete_goal(goal_id: str, user_id: str = Depends(get_user_or_legacy)):
    res = await db.goals.delete_one({"id": goal_id, "user_id": user_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Goal not found")
    return {"deleted": True}


# --------- Achievements ---------
@api_router.get("/achievements")
async def get_achievements(user_id: str = Depends(get_user_or_legacy)):
    prof = await get_or_create_profile_for(user_id)
    unlocked = set(prof.get("achievements_unlocked", []))
    result = []
    for ach in ACHIEVEMENT_DEFS:
        result.append({
            **ach,
            "unlocked": ach["id"] in unlocked,
        })
    return {"achievements": result, "unlocked_count": len(unlocked), "total": len(ACHIEVEMENT_DEFS)}


# --------- Stats ---------
@api_router.get("/stats/daily")
async def stats_daily(date: Optional[str] = None, user_id: str = Depends(get_user_or_legacy)):
    """Return completion rings per focus area for the date."""
    target = date or today_str()
    tasks = await db.tasks.find({"user_id": user_id}, {"_id": 0}).to_list(1000)
    logs = await db.task_logs.find({"user_id": user_id, "date": target}, {"_id": 0}).to_list(1000)
    done_ids = {log["task_id"] for log in logs}
    result = {}
    for area in FOCUS_AREAS:
        area_tasks = [t for t in tasks if t["focus_area"] == area]
        total = len(area_tasks)
        done = sum(1 for t in area_tasks if t["id"] in done_ids)
        result[area] = {
            "total": total,
            "done": done,
            "progress": (done / total) if total else 0,
        }
    total_tasks = len(tasks)
    total_done = sum(1 for t in tasks if t["id"] in done_ids)
    xp_today = sum(log["xp_awarded"] for log in logs)
    return {
        "date": target,
        "rings": result,
        "total_tasks": total_tasks,
        "total_done": total_done,
        "xp_today": xp_today,
    }


@api_router.get("/stats/weekly")
async def stats_weekly(user_id: str = Depends(get_user_or_legacy)):
    today_d = datetime.now(timezone.utc).date()
    days = []
    # Pre-aggregate gifted XP per day-string for fast lookup. Only XP-kind
    # gifts contribute; boost gifts don't add to the chart.
    gift_cur = db.gifts.find(
        {"to_user_id": user_id, "kind": "xp"},
        {"_id": 0, "created_at": 1, "amount": 1},
    )
    gifted_by_day: dict[str, int] = {}
    async for g in gift_cur:
        dt = (g.get("created_at") or "")[:10]
        if dt:
            gifted_by_day[dt] = gifted_by_day.get(dt, 0) + int(g.get("amount", 0) or 0)
    for i in range(6, -1, -1):
        d = today_d - timedelta(days=i)
        d_str = d.isoformat()
        logs = await db.task_logs.find({"user_id": user_id, "date": d_str}, {"_id": 0}).to_list(1000)
        xp = sum(entry["xp_awarded"] for entry in logs)
        gifted_xp = int(gifted_by_day.get(d_str, 0))
        days.append({
            "date": d_str,
            "day": d.strftime("%a"),
            "xp": xp,
            "gifted_xp": gifted_xp,
            "tasks": len(logs),
        })
    return {"days": days}


@api_router.get("/stats/monthly")
async def stats_monthly(user_id: str = Depends(get_user_or_legacy)):
    """Last 30 days of XP, oldest→newest. Same shape as /stats/weekly so
    the front-end can swap in the new dataset without re-doing layout —
    `day` is the 'd' (day-of-month, e.g. '15') for compact x-axis labels
    instead of the weekday abbrev.
    """
    today_d = datetime.now(timezone.utc).date()
    days: list[dict] = []
    # Pre-aggregate gifted XP per day-string for fast lookup, exactly like
    # the weekly endpoint above.
    gift_cur = db.gifts.find(
        {"to_user_id": user_id, "kind": "xp"},
        {"_id": 0, "created_at": 1, "amount": 1},
    )
    gifted_by_day: dict[str, int] = {}
    async for g in gift_cur:
        dt = (g.get("created_at") or "")[:10]
        if dt:
            gifted_by_day[dt] = gifted_by_day.get(dt, 0) + int(g.get("amount", 0) or 0)
    # 30-day window — covers a calendar month at the visual level even
    # though we don't anchor on the 1st.
    for i in range(29, -1, -1):
        d = today_d - timedelta(days=i)
        d_str = d.isoformat()
        logs = await db.task_logs.find(
            {"user_id": user_id, "date": d_str}, {"_id": 0}
        ).to_list(1000)
        xp = sum(entry["xp_awarded"] for entry in logs)
        gifted_xp = int(gifted_by_day.get(d_str, 0))
        days.append({
            "date": d_str,
            "day": d.strftime("%-d"),  # day-of-month for compact axis
            "xp": xp,
            "gifted_xp": gifted_xp,
            "tasks": len(logs),
        })
    return {"days": days}


@api_router.get("/stats/by-area")
async def stats_by_area(user_id: str = Depends(get_user_or_legacy)):
    """Total XP earned per focus area (all time) — scoped to caller."""
    logs = await db.task_logs.find({"user_id": user_id}, {"_id": 0}).to_list(10000)
    result = {area: 0 for area in FOCUS_AREAS}
    for entry in logs:
        area = entry.get("focus_area")
        if area in result:
            result[area] += entry.get("xp_awarded", 0)
    return {"by_area": result}


# --------- Seed default tasks ---------
DEFAULT_TASK_TEMPLATES = [
    {"title": "Morning reflection (5 min)", "focus_area": "mindset", "time_slot": "morning", "xp_value": 15, "description": "Set intentions for the day", "scheduled_time": "08:00"},
    {"title": "Workout session", "focus_area": "fitness", "time_slot": "morning", "xp_value": 40, "description": "30 min training", "scheduled_time": "09:00"},
    {"title": "Pick a clean outfit", "focus_area": "appearance", "time_slot": "morning", "xp_value": 10, "description": "Plan your look", "scheduled_time": "07:30"},
    {"title": "Start 3 conversations", "focus_area": "social", "time_slot": "afternoon", "xp_value": 30, "description": "Practice social skills", "scheduled_time": "13:00"},
    {"title": "Drink 2L water", "focus_area": "fitness", "time_slot": "afternoon", "xp_value": 15, "description": "Stay hydrated", "scheduled_time": "15:00"},
    {"title": "Gratitude journal", "focus_area": "mindset", "time_slot": "evening", "xp_value": 20, "description": "3 things you are grateful for", "scheduled_time": "20:00"},
    {"title": "Skincare routine", "focus_area": "appearance", "time_slot": "evening", "xp_value": 10, "description": "Take care of your skin", "scheduled_time": "21:30"},
    {"title": "Read 10 pages", "focus_area": "mindset", "time_slot": "evening", "xp_value": 20, "description": "Feed your mind", "scheduled_time": "22:00"},
]


async def seed_default_tasks_for_user(user_id: str) -> int:
    """Seed default task templates for a user if they have none."""
    existing = await db.tasks.count_documents({"user_id": user_id})
    if existing > 0:
        return 0
    now = now_iso()
    docs = [
        {
            **d, "id": str(uuid.uuid4()),
            "user_id": user_id,
            "recurring": True, "reminder_enabled": True,
            "is_default": True, "created_at": now,
        }
        for d in DEFAULT_TASK_TEMPLATES
    ]
    await db.tasks.insert_many(docs)
    return len(docs)


@api_router.post("/seed")
async def seed_defaults(user_id: str = Depends(get_user_or_legacy)):
    n = await seed_default_tasks_for_user(user_id)
    return {"seeded": n > 0, "count": n}


# ------------------------------------------------------------------
# Sleep Coach Mini-App
# ------------------------------------------------------------------
user_id = "main"  # single-user mode

SLEEP_QUESTIONS = [
    {"id": "struggle_level", "type": "scale", "min": 1, "max": 10, "q": "How much do you struggle to fall asleep at night? (1 = never, 10 = every night)"},
    {"id": "avg_hours", "type": "scale", "min": 3, "max": 12, "q": "How many hours of sleep do you typically get?"},
    {"id": "bedtime", "type": "time", "q": "What time do you usually try to go to bed?"},
    {"id": "wake_time", "type": "time", "q": "What time do you usually wake up?"},
    {"id": "wakes_at_night", "type": "single", "options": ["Never", "Sometimes", "Often", "Every night"], "q": "Do you wake up during the night?"},
    {"id": "racing_thoughts", "type": "single", "options": ["Rarely", "Sometimes", "Often", "Always"], "q": "How often do racing thoughts keep you awake?"},
    {"id": "screens_before_bed", "type": "single", "options": ["No screens 1+ hr", "30 min before", "Right up to bed", "In bed"], "q": "When do you stop using screens before bed?"},
    {"id": "caffeine_cutoff", "type": "single", "options": ["I don't drink caffeine", "Morning only", "Before 2pm", "Before 6pm", "Anytime / no limit"], "q": "When is your last caffeine of the day?"},
    {"id": "alcohol", "type": "single", "options": ["Never", "Occasionally", "A few nights/week", "Most nights"], "q": "How often do you drink alcohol in the evening?"},
    {"id": "exercise", "type": "single", "options": ["Daily", "A few times/week", "Rarely", "Never"], "q": "How often do you exercise?"},
    {"id": "exercise_time", "type": "single", "options": ["Morning", "Afternoon", "Evening", "Late night", "I don't exercise"], "q": "When do you usually exercise?"},
    {"id": "temp_right", "type": "single", "options": ["Yes", "Most times", "Sometimes", "No"], "q": "Is your bed usually the right temperature for you to sleep well at night?"},
    {"id": "temp_problem", "type": "single", "options": ["Is your bed too hot?", "Is your bed too cool?"], "q": "Which one is the problem?", "show_if": {"temp_right": ["No", "Sometimes", "Most times"]}},
    {"id": "temp_frequency", "type": "single", "options": ["A few times", "Often", "Always"], "q": "How often does this happen?", "show_if": {"temp_right": ["No", "Sometimes", "Most times"]}},
    {"id": "room_dark", "type": "single", "options": ["Pitch black", "Mostly dark", "Some light", "Lots of light"], "q": "How dark is your bedroom?"},
    {"id": "noise", "type": "single", "options": ["Silent", "White noise", "Some noise", "Very noisy"], "q": "How quiet is your sleep environment?"},
    {"id": "relaxing_activities", "type": "multi", "options": ["Reading", "Drawing", "Journaling", "Music", "Podcasts", "Meditation", "Stretching", "Bath/shower", "Tea", "Breathing exercises"], "q": "What activities do you find relaxing? (pick all that apply)"},
    {"id": "likes_milk", "type": "single", "options": ["Love it", "It's okay", "Don't really like it", "Lactose intolerant"], "q": "Do you like drinking milk?"},
    {"id": "warm_drinks", "type": "multi_other", "options": ["Tea", "Milk", "Decaf coffee", "Hot chocolate", "Water", "Other"], "other_option": "Other", "other_field": "warm_drinks_other", "q": "Which drinks would you enjoy before bed?"},
    {"id": "tried_before", "type": "text", "q": "Anything you've tried that helped (or didn't)? (optional)"},
    {"id": "main_goal", "type": "single", "options": ["Fall asleep faster", "Sleep through the night", "Wake up rested", "Sleep more hours", "All of the above"], "q": "Your main sleep goal?"},
]


class SleepOnboardingPayload(BaseModel):
    answers: dict


class SleepCheckinPayload(BaseModel):
    rating: int  # 1-10 quality
    hours: Optional[float] = None
    notes: Optional[str] = ""


class SleepChatPayload(BaseModel):
    message: str


def _sleep_user_filter(user_id: str):
    return {"user_id": user_id}


async def _generate_sleep_plan(answers: dict) -> dict:
    """Use LLM to generate a personalized sleep plan + routine items based on answers."""
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        api_key = os.environ.get("EMERGENT_LLM_KEY")
        if not api_key:
            return _fallback_plan(answers)

        system = (
            "You are an expert evidence-based sleep coach (CBT-I trained). "
            "Generate a JSON object with exactly two keys: "
            "'plan' (a friendly markdown string ~250 words with 4-6 specific personalized recommendations based on the user's answers), "
            "and 'routine' (a JSON array of 4-7 routine items, each with keys: time (e.g. '9:00 PM' or '~30 min before bed'), title (short), description (1 sentence), icon (one of: 'bed','moon','book','musical-notes','water','cafe','flame','walk','leaf','time','phone-portrait','flash-off')). "
            "Pull only from the activities and drinks the user actually likes. "
            "Use evidence-based interventions: stimulus control, sleep restriction, cool dark room (60-67°F), "
            "screen cutoff, caffeine cutoff (8+ hrs before bed), wind-down routine, breathing exercises (4-7-8 box breathing), "
            "consistent wake time, light morning exposure. "
            "Do NOT recommend warm milk or herbal teas the user dislikes or is intolerant to. "
            "Output strict JSON only, no markdown fences."
        )
        user_text = f"User's sleep questionnaire answers:\n{answers}\n\nGenerate the personalized JSON plan now."

        chat = LlmChat(
            api_key=api_key,
            session_id=f"sleep-plan-{uuid.uuid4()}",
            system_message=system,
        ).with_model("openai", "gpt-4o-mini")

        response = await chat.send_message(UserMessage(text=user_text))
        # Try to extract JSON
        import json, re
        text = response.strip()
        # strip code fences if any
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        try:
            data = json.loads(text)
            if "plan" in data and "routine" in data:
                return data
        except Exception:
            logger.exception("LLM JSON parse failed; raw=%s", text[:500])
        return _fallback_plan(answers)
    except Exception:
        logger.exception("sleep plan LLM failure")
        return _fallback_plan(answers)


def _fallback_plan(answers: dict) -> dict:
    likes_milk = answers.get("likes_milk") in ("Love it", "It's okay")
    relax = answers.get("relaxing_activities") or []
    warm_drinks = answers.get("warm_drinks") or []
    warm_drinks_other = (answers.get("warm_drinks_other") or "").strip()
    routine = [
        {"time": "~3 hours before bed", "title": "Caffeine cutoff", "description": "No coffee, tea or energy drinks. Caffeine has a 5-6 hour half-life.", "icon": "flash-off"},
        {"time": "~1 hour before bed", "title": "Dim the lights", "description": "Lower lights & switch screens to night mode to cue melatonin release.", "icon": "moon"},
        {"time": "~45 min before bed", "title": "Light stretch", "description": "5-10 min of gentle stretches to release muscle tension.", "icon": "walk"},
        {"time": "~30 min before bed", "title": "Wind-down activity", "description": f"Try {(relax[0] if relax else 'reading')} — calming, no screens.", "icon": "book"},
    ]
    # Prefer milk if user likes it, else honor their picks (excluding 'Other' placeholder)
    drink_pick: Optional[str] = None
    if likes_milk or "Milk" in warm_drinks:
        drink_pick = "Warm milk"
    else:
        for d in warm_drinks:
            if d and d != "Other":
                drink_pick = d
                break
        if not drink_pick and warm_drinks_other:
            drink_pick = warm_drinks_other
    if drink_pick:
        is_milk = drink_pick.lower().startswith("warm milk") or drink_pick.lower() == "milk"
        routine.append({
            "time": "~20 min before bed",
            "title": drink_pick,
            "description": (
                "Tryptophan + ritual = signal to your brain it's bedtime."
                if is_milk else
                "A warm caffeine-free drink helps trigger sleepiness."
            ),
            "icon": "cafe",
        })
    routine.append({"time": "In bed", "title": "4-7-8 Breathing", "description": "Inhale 4s, hold 7s, exhale 8s. Repeat 4 times. Activates parasympathetic.", "icon": "leaf"})
    plan = (
        "**Your personalized sleep plan**\n\n"
        "Based on your answers, here's an evidence-based routine tuned to you:\n\n"
        "1. **Consistent schedule** — same wake time every day (yes, weekends too) anchors your circadian rhythm.\n"
        "2. **Cool, dark room** — aim for 60-67°F and blackout darkness; even small amounts of light fragment sleep.\n"
        "3. **Wind-down ritual** — pick activities you actually enjoy from your relaxing list and do them every night.\n"
        "4. **No screens 30-60 min before bed** — blue light suppresses melatonin.\n"
        "5. **Caffeine cutoff at least 8 hours before bed** — even if you don't feel it, it disrupts deep sleep.\n"
        "6. **If you can't sleep in 20 min, get out of bed** — read a paper book in dim light then come back. Don't lie there worrying.\n\n"
        "Your routine card on the right has timing tuned to *you*. Tap the Coach tab when something isn't working — we'll iterate."
    )
    return {"plan": plan, "routine": routine}


async def _build_coach_system(profile: Optional[dict]) -> str:
    base = (
        "You are 'Luna', a warm, evidence-based AI sleep coach. "
        "You sound like a calm, supportive friend who happens to be a CBT-I expert. "
        "Keep replies concise (3-5 sentences usually), use plain language, no medical disclaimers in every message. "
        "Reference the user's specific habits/preferences when relevant. "
        "If they ask for a tip, give one specific, actionable tip with the *why* in 1 sentence. "
        "If they want to change something, suggest a concrete swap. "
        "Never recommend prescription meds or supplements without a doctor. "
        "Encourage consistency over perfection."
    )
    if profile:
        ans = profile.get("answers", {})
        relax = ans.get("relaxing_activities") or []
        likes_milk = ans.get("likes_milk")
        struggle = ans.get("struggle_level")
        bed = ans.get("bedtime")
        wake = ans.get("wake_time")
        base += (
            f"\n\nUser context (use sparingly, don't quote the survey):\n"
            f"- Struggles to fall asleep: {struggle}/10\n"
            f"- Bed/wake target: {bed} → {wake}\n"
            f"- Likes milk: {likes_milk}\n"
            f"- Enjoys: {', '.join(relax) if relax else 'unspecified'}\n"
            f"- Goal: {ans.get('main_goal', 'better sleep')}"
        )
    return base


@api_router.get("/sleep/profile")
async def sleep_profile(user_id: str = Depends(get_user_or_legacy)):
    p = await db.sleep_profile.find_one({"user_id": user_id}, {"_id": 0})
    if not p:
        return {"onboarded": False, "questions": SLEEP_QUESTIONS}
    # "How was your sleep?" prompt:
    #  - Uses the user's own `day_start_time` + `timezone` to anchor the sleep-cycle day.
    #  - Prompt is active from (day_start - 2h) until the NEXT day_start.
    #  - Disappears once the user has logged a check-in for the current sleep-cycle day.
    prof = await db.profile.find_one({"_id": user_id}, {"timezone": 1, "day_start_time": 1, "wake_time": 1})
    today_user = user_today_str(prof)
    last = p.get("last_checkin_date")
    show_checkin = last != today_user
    # Is the viewer currently within the [day_start - 2h, next day_start) window?
    in_window = True
    try:
        if prof and prof.get("timezone"):
            from zoneinfo import ZoneInfo
            day_start = prof.get("day_start_time") or prof.get("wake_time") or "07:00"
            hh, mm = [int(x) for x in day_start.split(":")[:2]]
            local_now = datetime.now(ZoneInfo(prof["timezone"]))
            start_today = local_now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            window_start = start_today - timedelta(hours=2)
            # If local_now is BEFORE day_start, today's window is still yesterday's
            if local_now < start_today:
                window_start = start_today - timedelta(days=1, hours=2)
                in_window = local_now >= window_start
            else:
                in_window = True  # after start_today → we're in today's cycle
    except Exception:
        pass
    return {
        "onboarded": True,
        "profile": p,
        "questions": SLEEP_QUESTIONS,
        "show_checkin_prompt": bool(show_checkin and in_window),
        "checkin_day": today_user,
    }


@api_router.post("/sleep/onboarding")
async def sleep_onboarding(body: SleepOnboardingPayload, user_id: str = Depends(get_user_or_legacy)):
    answers = body.answers or {}
    plan_obj = await _generate_sleep_plan(answers)
    doc = {
        "user_id": user_id,
        "answers": answers,
        "plan": plan_obj.get("plan", ""),
        "routine": plan_obj.get("routine", []),
        "check_ins": [],
        "last_checkin_date": None,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.sleep_profile.replace_one({"user_id": user_id}, doc, upsert=True)
    # also clear chat history on fresh onboarding
    await db.sleep_chat.delete_many({"user_id": user_id})
    saved = await db.sleep_profile.find_one({"user_id": user_id}, {"_id": 0})
    return {"profile": saved}


@api_router.post("/sleep/regenerate")
async def sleep_regenerate(body: Optional[SleepChatPayload] = None, user_id: str = Depends(get_user_or_legacy)):
    p = await db.sleep_profile.find_one({"user_id": user_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Onboard first")
    feedback = (body.message if body else "") or ""
    answers = dict(p.get("answers", {}))
    if feedback:
        answers["_recent_feedback"] = feedback
    plan_obj = await _generate_sleep_plan(answers)
    await db.sleep_profile.update_one(
        {"user_id": user_id},
        {"$set": {"plan": plan_obj.get("plan", ""), "routine": plan_obj.get("routine", []), "updated_at": now_iso()}},
    )
    saved = await db.sleep_profile.find_one({"user_id": user_id}, {"_id": 0})
    return {"profile": saved}


@api_router.post("/sleep/checkin")
async def sleep_checkin(body: SleepCheckinPayload, user_id: str = Depends(get_user_or_legacy)):
    p = await db.sleep_profile.find_one({"user_id": user_id})
    if not p:
        raise HTTPException(404, "Onboard first")
    prof = await db.profile.find_one({"_id": user_id}, {"timezone": 1, "day_start_time": 1, "wake_time": 1})
    entry = {
        "date": user_today_str(prof),
        "rating": int(body.rating),
        "hours": body.hours,
        "notes": body.notes or "",
        "ts": now_iso(),
    }
    await db.sleep_profile.update_one(
        {"user_id": user_id},
        {"$push": {"check_ins": {"$each": [entry], "$slice": -60}}, "$set": {"last_checkin_date": entry["date"], "updated_at": now_iso()}},
    )
    return {"saved": True, "entry": entry}


@api_router.get("/sleep/chat")
async def sleep_chat_history(user_id: str = Depends(get_user_or_legacy)):
    msgs = await db.sleep_chat.find({"user_id": user_id}, {"_id": 0}).sort("ts", 1).to_list(500)
    return {"messages": msgs}


@api_router.post("/sleep/chat")
async def sleep_chat_send(body: SleepChatPayload, user_id: str = Depends(get_user_or_legacy)):
    text = (body.message or "").strip()
    if not text:
        raise HTTPException(400, "Empty message")
    profile = await db.sleep_profile.find_one({"user_id": user_id}, {"_id": 0})
    # save user message
    user_msg = {"user_id": user_id, "role": "user", "content": text, "ts": now_iso()}
    await db.sleep_chat.insert_one(dict(user_msg))

    reply = ""
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        api_key = os.environ.get("EMERGENT_LLM_KEY")
        if not api_key:
            reply = "(LLM key not configured — please ask the agent for help.)"
        else:
            system = await _build_coach_system(profile)
            # Use the existing chat history as context (last 20 turns for token budget)
            history = await db.sleep_chat.find({"user_id": user_id}, {"_id": 0}).sort("ts", 1).to_list(500)
            # We'll roll history into the system prompt as a compact transcript
            recent = history[-20:]
            transcript = "\n".join(
                f"{m['role'].upper()}: {m['content']}" for m in recent[:-1]  # exclude the just-saved user msg
            )
            sys_with_history = system + (f"\n\n--- Recent conversation ---\n{transcript}" if transcript else "")
            chat = LlmChat(
                api_key=api_key,
                session_id=f"sleep-chat-{user_id}-{uuid.uuid4()}",
                system_message=sys_with_history,
            ).with_model("openai", "gpt-4o-mini")
            reply = await chat.send_message(UserMessage(text=text))
    except Exception:
        logger.exception("sleep chat LLM failed")
        reply = "Sorry, I had a hiccup connecting just now. Try again in a sec — I'm here when you need me."

    asst_msg = {"user_id": user_id, "role": "assistant", "content": reply, "ts": now_iso()}
    await db.sleep_chat.insert_one(dict(asst_msg))
    user_msg.pop("_id", None)
    asst_msg.pop("_id", None)
    return {"user": user_msg, "assistant": asst_msg}


@api_router.post("/sleep/reset")
async def sleep_reset(user_id: str = Depends(get_user_or_legacy)):
    await db.sleep_profile.delete_many({"user_id": user_id})
    await db.sleep_chat.delete_many({"user_id": user_id})
    return {"reset": True}


@api_router.get("/sleep/health-mock")
async def sleep_health_mock(user_id: str = Depends(get_user_or_legacy)):
    """Simulated health-app data while real HealthKit/Health Connect is gated behind a native build."""
    import random
    rng = random.Random(today_str())  # deterministic for the day
    nights = []
    for i in range(7):
        d = (datetime.now(timezone.utc).date() - timedelta(days=6 - i))
        total = round(rng.uniform(5.5, 8.4), 1)
        deep = round(total * rng.uniform(0.13, 0.22), 1)
        rem = round(total * rng.uniform(0.18, 0.27), 1)
        light = round(total - deep - rem, 1)
        nights.append({
            "date": d.isoformat(),
            "day": d.strftime("%a"),
            "total_hours": total,
            "deep_hours": deep,
            "rem_hours": rem,
            "light_hours": max(light, 0.1),
            "score": int(rng.uniform(62, 92)),
        })
    avg_total = round(sum(n["total_hours"] for n in nights) / len(nights), 1)
    avg_score = int(sum(n["score"] for n in nights) / len(nights))
    return {
        "connected": False,
        "source": "Simulated data",
        "nights": nights,
        "avg_total_hours": avg_total,
        "avg_score": avg_score,
        "best_night": max(nights, key=lambda n: n["score"]),
        "worst_night": min(nights, key=lambda n: n["score"]),
    }


# ------------------------------------------------------------------
# App setup
# ------------------------------------------------------------------


# ═════════════════════ Challenge Tasks Mini-App ═════════════════════
from challenges_data import (
    get_today_quote,
    get_today_challenge,
    find_challenge,
    CHALLENGES as _ALL_CHALLENGES,
)


def _greeting_for_now() -> str:
    """Local-server greeting based on hour of day. Falls through to Evening."""
    h = datetime.now().hour
    if 5 <= h < 12:
        return "Good morning"
    if 12 <= h < 17:
        return "Good afternoon"
    if 17 <= h < 22:
        return "Good evening"
    return "Good night"


def _parse_hhmm(s: str | None, default: tuple[int, int] = (7, 0)) -> tuple[int, int]:
    try:
        h, m = (s or "").split(":")
        return max(0, min(23, int(h))), max(0, min(59, int(m)))
    except Exception:
        return default


def _challenge_day_for_user(now_dt: datetime, wake_str: str | None, tz_name: Optional[str] = None) -> "datetime.date":
    """Return the 'challenge day' the user is currently in.
    A challenge day starts at `wake_str` (HH:MM) in the user's IANA timezone
    and lasts 24h. If `now` is BEFORE today's wake-time, we are still in
    yesterday's challenge day.
    """
    wake_h, wake_m = _parse_hhmm(wake_str)
    local_now = now_dt
    if tz_name:
        try:
            from zoneinfo import ZoneInfo
            local_now = datetime.now(ZoneInfo(tz_name))
        except Exception:
            pass
    today_wake = local_now.replace(hour=wake_h, minute=wake_m, second=0, microsecond=0)
    if local_now < today_wake:
        return (local_now - timedelta(days=1)).date()
    return local_now.date()


async def _wake_for_user(user_id: str) -> str:
    prof = await db.profile.find_one({"_id": user_id})
    return (prof or {}).get("day_start_time") or (prof or {}).get("wake_time") or "07:00"


async def _tz_for_user(user_id: str) -> Optional[str]:
    prof = await db.profile.find_one({"_id": user_id})
    return (prof or {}).get("timezone") or None


async def _autoroll_uncompleted_challenges(user_id: str, current_day: "datetime.date") -> None:
    """For any challenge_state docs older than the current challenge day where
    the user did NOT complete the challenge, write an `Uncompleted` past entry
    and remove the stale state doc. This makes the mini-app self-cleaning even
    if the user never re-opens it for several days."""
    current_iso = current_day.isoformat()
    cur = db.challenge_state.find({
        "user_id": user_id,
        "date": {"$lt": current_iso},
        "status": {"$ne": "completed"},
    })
    async for state in cur:
        ch_id = state.get("challenge_id")
        ch = find_challenge(ch_id) if ch_id else None
        if not ch:
            # Best-effort: rebuild from the seeded RNG using the original date
            try:
                from datetime import date as _d
                d = _d.fromisoformat(state.get("date"))
                ch = get_today_challenge(user_id, d)
            except Exception:
                ch = {"id": "unknown", "title": "Unknown Challenge",
                      "tagline": "", "description": "", "icon": "flash"}
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "date": state.get("date"),
            "challenge_id": ch.get("id", "unknown"),
            "challenge_title": ch.get("title", "Unknown Challenge"),
            "challenge_tagline": ch.get("tagline", ""),
            "challenge_description": ch.get("description", ""),
            "challenge_icon": ch.get("icon", "flash"),
            "completed": False,
            "auto_uncompleted": True,
            "how_text": "",
            "difficulty": "easy",
            "experience_text": "",
            "rating": 0,
            "xp_awarded": 0,
            "completed_at": now_iso(),
        }
        await db.challenge_completions.insert_one(doc)
    # Now nuke all stale state docs (regardless of original status)
    await db.challenge_state.delete_many({
        "user_id": user_id,
        "date": {"$lt": current_iso},
    })


class ChallengeRejectPayload(BaseModel):
    challenge_id: Optional[str] = None  # for safety; ignored when stale


class ChallengeCompletePayload(BaseModel):
    completed: bool = True
    how_text: Optional[str] = ""
    difficulty: str = "easy"           # "easy" | "difficult"
    experience_text: Optional[str] = ""
    rating: int = 5                    # 1..5


@api_router.get("/challenge/today")
async def challenge_today(user_id: str = Depends(get_user_or_legacy)):
    """Returns today's quote, challenge, current state and the greeting.
    Honors the user's `day_start_time` + `timezone` so the 24-hour cycle
    starts at their morning in their local zone.
    """
    wake = await _wake_for_user(user_id)
    tz_name = await _tz_for_user(user_id)
    now_dt = datetime.now()
    cur_day = _challenge_day_for_user(now_dt, wake, tz_name)
    # Self-clean stale state → past as Uncompleted
    await _autoroll_uncompleted_challenges(user_id, cur_day)

    today = cur_day.isoformat()
    quote = get_today_quote(user_id, cur_day)
    ch = get_today_challenge(user_id, cur_day)
    state_doc = await db.challenge_state.find_one(
        {"user_id": user_id, "date": today}
    )
    status = (state_doc or {}).get("status", "ready")
    return {
        "date": today,
        "greeting": _greeting_for_now(),
        "quote": quote,
        "challenge": ch,
        "status": status,        # ready | accepted | rejected | completed
        "completed_id": (state_doc or {}).get("completed_doc_id"),
        "wake_time": wake,
    }


@api_router.post("/challenge/accept")
async def challenge_accept(user_id: str = Depends(get_user_or_legacy)):
    wake = await _wake_for_user(user_id)
    tz_name = await _tz_for_user(user_id)
    cur_day = _challenge_day_for_user(datetime.now(), wake, tz_name)
    await _autoroll_uncompleted_challenges(user_id, cur_day)
    today = cur_day.isoformat()
    ch = get_today_challenge(user_id, cur_day)
    await db.challenge_state.update_one(
        {"user_id": user_id, "date": today},
        {"$set": {
            "user_id": user_id,
            "date": today,
            "challenge_id": ch["id"],
            "status": "accepted",
            "accepted_at": now_iso(),
        }},
        upsert=True,
    )
    return {"status": "accepted", "challenge": ch}


@api_router.post("/challenge/reject")
async def challenge_reject(user_id: str = Depends(get_user_or_legacy)):
    wake = await _wake_for_user(user_id)
    tz_name = await _tz_for_user(user_id)
    cur_day = _challenge_day_for_user(datetime.now(), wake, tz_name)
    await _autoroll_uncompleted_challenges(user_id, cur_day)
    today = cur_day.isoformat()
    ch = get_today_challenge(user_id, cur_day)
    await db.challenge_state.update_one(
        {"user_id": user_id, "date": today},
        {"$set": {
            "user_id": user_id,
            "date": today,
            "challenge_id": ch["id"],
            "status": "rejected",
            "rejected_at": now_iso(),
        }},
        upsert=True,
    )
    return {"status": "rejected"}


@api_router.post("/challenge/complete")
async def challenge_complete(
    body: ChallengeCompletePayload,
    user_id: str = Depends(get_user_or_legacy),
):
    wake = await _wake_for_user(user_id)
    tz_name = await _tz_for_user(user_id)
    cur_day = _challenge_day_for_user(datetime.now(), wake, tz_name)
    await _autoroll_uncompleted_challenges(user_id, cur_day)
    today = cur_day.isoformat()
    ch = get_today_challenge(user_id, cur_day)
    # Difficulty-based XP: easy=30, difficult=60. Don't award if !completed.
    awarded_xp = 0
    if body.completed:
        awarded_xp = 60 if (body.difficulty or "").lower() == "difficult" else 30
    rating = max(1, min(5, int(body.rating or 5)))
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "date": today,
        "challenge_id": ch["id"],
        "challenge_title": ch["title"],
        "challenge_tagline": ch.get("tagline", ""),
        "challenge_description": ch["description"],
        "challenge_icon": ch.get("icon", "flash"),
        "completed": bool(body.completed),
        "auto_uncompleted": False,
        "how_text": (body.how_text or "").strip(),
        "difficulty": (body.difficulty or "easy").lower(),
        "experience_text": (body.experience_text or "").strip(),
        "rating": rating,
        "xp_awarded": awarded_xp,
        "completed_at": now_iso(),
    }
    await db.challenge_completions.insert_one(doc)
    if awarded_xp:
        await db.profile.update_one(
            {"_id": user_id}, {"$inc": {"total_xp": awarded_xp}}
        )
        # Challenge complete → keep streak alive AND surface on the
        # Progress-tab charts (was previously invisible there because
        # mini-app challenge XP bypassed the task_logs collection).
        await _bump_streak_for_xp(user_id)
        await _log_xp_to_charts(
            user_id, awarded_xp, source="challenge_complete", focus_area="mindset",
        )
    await db.challenge_state.update_one(
        {"user_id": user_id, "date": today},
        {"$set": {
            "user_id": user_id,
            "date": today,
            "challenge_id": ch["id"],
            "status": "completed",
            "completed_doc_id": doc["id"],
            "completed_at": doc["completed_at"],
        }},
        upsert=True,
    )
    doc.pop("_id", None)
    return {"awarded_xp": awarded_xp, "completion": doc}


@api_router.get("/challenge/past")
async def challenge_past(user_id: str = Depends(get_user_or_legacy)):
    wake = await _wake_for_user(user_id)
    tz_name = await _tz_for_user(user_id)
    cur_day = _challenge_day_for_user(datetime.now(), wake, tz_name)
    await _autoroll_uncompleted_challenges(user_id, cur_day)
    cur = (
        db.challenge_completions.find({"user_id": user_id})
        .sort("completed_at", -1)
        .limit(200)
    )
    out: list = []
    # Compute answer window: auto-uncompleted entries can still be answered
    # within 24h of their day's rollover. After that window, locked.
    now_utc = datetime.now(timezone.utc)
    async for d in cur:
        d.pop("_id", None)
        # Answer window: 24h from the day AFTER the challenge's date
        # (i.e., the rollover moment), honoring tz+day_start.
        can_answer = False
        answer_deadline_iso: Optional[str] = None
        try:
            from zoneinfo import ZoneInfo as _ZI
            from datetime import date as _d
            ch_date = _d.fromisoformat(d["date"])
            wh, wm = _parse_hhmm(wake)
            tz = _ZI(tz_name) if tz_name else timezone.utc
            # Rollover was (ch_date + 1 day) at wake local
            rollover_local = datetime(ch_date.year, ch_date.month, ch_date.day,
                                       wh, wm, tzinfo=tz) + timedelta(days=1)
            deadline = rollover_local + timedelta(hours=24)
            answer_deadline_iso = deadline.astimezone(timezone.utc).isoformat()
            can_answer = (now_utc < deadline.astimezone(timezone.utc)) and bool(d.get("auto_uncompleted"))
        except Exception:
            pass
        d["can_answer"] = can_answer
        d["answer_deadline"] = answer_deadline_iso
        out.append(d)
    return {"completions": out, "count": len(out)}


class ChallengePastAnswerPayload(BaseModel):
    completed: bool = True
    how_text: Optional[str] = ""
    difficulty: str = "easy"
    experience_text: Optional[str] = ""
    rating: int = 5


@api_router.post("/challenge/past/{completion_id}/answer")
async def challenge_past_answer(
    completion_id: str,
    body: ChallengePastAnswerPayload,
    user_id: str = Depends(get_user_or_legacy),
):
    """Late-answer a past challenge. Only allowed inside the 24h window."""
    d = await db.challenge_completions.find_one({"id": completion_id, "user_id": user_id})
    if not d:
        raise HTTPException(404, "Past challenge not found")
    if not d.get("auto_uncompleted"):
        raise HTTPException(400, "This challenge was already answered.")
    # Check window
    wake = await _wake_for_user(user_id)
    tz_name = await _tz_for_user(user_id)
    try:
        from zoneinfo import ZoneInfo as _ZI
        from datetime import date as _d
        ch_date = _d.fromisoformat(d["date"])
        wh, wm = _parse_hhmm(wake)
        tz = _ZI(tz_name) if tz_name else timezone.utc
        rollover_local = datetime(ch_date.year, ch_date.month, ch_date.day,
                                   wh, wm, tzinfo=tz) + timedelta(days=1)
        deadline_utc = (rollover_local + timedelta(hours=24)).astimezone(timezone.utc)
        if datetime.now(timezone.utc) >= deadline_utc:
            raise HTTPException(400, "The 24-hour answer window has closed for this challenge.")
    except HTTPException:
        raise
    except Exception:
        pass

    awarded_xp = 0
    if body.completed:
        awarded_xp = 60 if (body.difficulty or "").lower() == "difficult" else 30
    rating = max(1, min(5, int(body.rating or 5)))
    update = {
        "completed": bool(body.completed),
        "auto_uncompleted": False,
        "how_text": (body.how_text or "").strip(),
        "difficulty": (body.difficulty or "easy").lower(),
        "experience_text": (body.experience_text or "").strip(),
        "rating": rating,
        "xp_awarded": awarded_xp,
        "late_answered_at": now_iso(),
    }
    await db.challenge_completions.update_one(
        {"id": completion_id, "user_id": user_id}, {"$set": update}
    )
    if awarded_xp:
        await db.profile.update_one(
            {"_id": user_id}, {"$inc": {"total_xp": awarded_xp}}
        )
        # Late-answered challenge → still counts as activity for streak +
        # logged onto the Progress charts so the user sees the credit.
        await _bump_streak_for_xp(user_id)
        await _log_xp_to_charts(
            user_id, awarded_xp, source="challenge_late", focus_area="mindset",
        )
    updated = await db.challenge_completions.find_one({"id": completion_id}, {"_id": 0})
    return {"awarded_xp": awarded_xp, "completion": updated}


@api_router.delete("/challenge/past/{completion_id}")
async def challenge_past_delete(
    completion_id: str, user_id: str = Depends(get_user_or_legacy)
):
    res = await db.challenge_completions.delete_one(
        {"id": completion_id, "user_id": user_id}
    )
    return {"deleted": res.deleted_count}


# ═════════════════════ Friends+ (Social Layer) ═════════════════════════
# Lets registered users discover each other, send friend requests, and
# build a friends list. Anonymous device users are intentionally excluded
# from search results — only people with a real account are listed.

class FriendActionPayload(BaseModel):
    user_id: str  # the other user's id (target of the request / action)


def _friend_pair_key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


async def _find_relationship(user_a: str, user_b: str) -> Optional[dict]:
    """Return the most recent friend_request doc between two users (in any
    direction). The relationship status reflects whichever doc was created
    last."""
    return await db.friend_requests.find_one(
        {
            "$or": [
                {"from_user_id": user_a, "to_user_id": user_b},
                {"from_user_id": user_b, "to_user_id": user_a},
            ],
        },
        sort=[("created_at", -1)],
    )


def _relationship_status(rel: Optional[dict], me: str) -> str:
    """Translate the relationship doc into a UI-friendly status label."""
    if not rel:
        return "none"
    if rel.get("status") == "accepted":
        return "friends"
    if rel.get("status") == "declined":
        return "none"
    # pending — direction matters for UI
    if rel.get("from_user_id") == me:
        return "pending_outgoing"
    return "pending_incoming"


async def _enrich_emails(profs: list) -> list:
    """Batch-fetch the user emails for a list of profile dicts, attach as
    `_email_cache` on each (in-place). This lets `_serialize_player` derive
    `is_admin` from the user's email without a per-row lookup."""
    if not profs:
        return profs
    ids = [p.get("_id") or p.get("user_id") for p in profs if p]
    ids = [i for i in ids if i]
    if not ids:
        return profs
    email_map: dict = {}
    async for u in db.users.find({"_id": {"$in": ids}}, {"email": 1}):
        email_map[u["_id"]] = u.get("email")
    for p in profs:
        if p is None:
            continue
        pid = p.get("_id") or p.get("user_id")
        if pid in email_map and email_map[pid]:
            p["_email_cache"] = email_map[pid]
    return profs


def _serialize_player(prof: dict, status: str = "none", viewer_is_admin: bool = False) -> dict:
    """Public-facing trimmed profile for player cards / detail views.

    Special-case for the Creator/Admin: when OTHERS view this player,
    stats are replaced with infinity, the bio is hidden, and an `is_admin_view`
    flag is set so the frontend can render a golden treatment.

    `viewer_is_admin` adds two ADMIN-ONLY moderation flags to the payload:
      - is_currently_suspended → true while the suspension window is active
      - was_suspended_ever → true if the user has EVER been suspended (even
        if it has been lifted or expired). Used to render a permanent red
        dot next to their name in the admin's view of every list.
    These fields are omitted entirely for non-admin viewers so a regular
    user CANNOT discover that a player was previously suspended.
    """
    total_xp = int(prof.get("total_xp", 0) or 0)
    user_id = prof.get("_id") or prof.get("user_id")
    is_admin = _is_admin_email(prof.get("_email_cache"))
    viewing_self = status == "self"
    show_unlimited = is_admin and not viewing_self

    base = {
        "user_id": user_id,
        # Admins see their own real name; everyone else sees the brand
        # "Admin · Creator" (e.g. in Players, Friends, Leaderboard, DM
        # headers). This ensures consistent Creator branding without
        # leaking the admin's personal full name.
        "name": (
            ADMIN_PUBLIC_DISPLAY_NAME
            if (is_admin and not viewing_self)
            else (prof.get("full_name") or prof.get("name") or "Anonymous")
        ),
        "level": int(prof.get("level", 1) or 1),
        "total_xp": total_xp,
        "current_streak": int(prof.get("current_streak", 0) or 0),
        "best_streak": int(prof.get("best_streak", 0) or 0),
        "goals_completed": int(prof.get("goals_completed", 0) or 0),
        "tasks_completed": int(prof.get("tasks_completed", 0) or 0),
        "bio": prof.get("bio") or "",
        "avatar_base64": prof.get("avatar_base64"),
        "friend_status": status,  # none | pending_outgoing | pending_incoming | friends | self
        "is_admin": bool(is_admin),
        "is_admin_view": bool(show_unlimited),  # frontend renders ∞ + golden when true
        # ISO-8601 UTC timestamp of the last time this user opened the
        # app / hit our API. Refreshed (throttled to once-per-minute) by
        # `_touch_last_seen` inside `get_user_or_legacy`.
        "last_seen_at": prof.get("last_seen_at"),
    }
    if show_unlimited:
        base.update({
            "level": 999,         # special sentinel, frontend renders ∞
            "total_xp": -1,        # sentinel for ∞
            "current_streak": -1,
            "best_streak": -1,
            "goals_completed": -1,
            "tasks_completed": -1,
            "bio": "",            # cleared as requested
        })
    if viewer_is_admin and not is_admin:
        # Only the Creator sees these moderation badges. We compute
        # `is_currently_suspended` from the live suspended_until field via
        # _suspension_state so an expired suspension correctly renders as
        # "ever-suspended only" (red dot, no red border).
        state = _suspension_state(prof)
        base["is_currently_suspended"] = bool(state)
        base["was_suspended_ever"] = bool(prof.get("was_suspended_ever") or state)
    return base


def _fuzzy_score(needle: str, haystack: str) -> int:
    """Tiny soft-match score used to surface 'similar' names when the user
    misspells. Higher is better. 0 = no match."""
    n = (needle or "").lower().strip()
    h = (haystack or "").lower().strip()
    if not n:
        return 1  # empty query — show everything
    if h.startswith(n):
        return 1000 - len(h)
    if n in h:
        return 800 - len(h)
    # Levenshtein-ish: count matching chars in order
    score = 0
    j = 0
    for ch in h:
        if j < len(n) and ch == n[j]:
            score += 5
            j += 1
    if j == len(n):
        score += 100  # all chars in order
    return score if score > 30 else 0


@api_router.get("/friends/players")
async def list_players(q: str = "", user_id: str = Depends(get_user_or_legacy)):
    """List of all real (signed-in) users, optionally filtered by name.
    Soft-matches misspellings so e.g. "alise" still surfaces "Alice"."""
    # Only registered users (those that have a row in `users`). Their _id
    # equals the profile _id, so we use that as the join key.
    user_ids = []
    async for u in db.users.find({}, {"_id": 1}):
        user_ids.append(u["_id"])
    if not user_ids:
        return {"players": []}
    profs_cur = db.profile.find({"_id": {"$in": user_ids}})
    profs: list[dict] = [p async for p in profs_cur]

    # Pre-compute fuzzy scores so we can sort by relevance.
    scored: list[tuple[int, dict]] = []
    for p in profs:
        if p.get("_id") == user_id:
            continue  # skip self in player list
        name = p.get("full_name") or p.get("name") or ""
        score = _fuzzy_score(q, name)
        if score > 0:
            scored.append((score, p))
    scored.sort(key=lambda x: (-x[0], (x[1].get("full_name") or "").lower()))

    # Batch-load relationships in a single query to avoid N queries.
    other_ids = [p.get("_id") for _, p in scored]
    rels: dict[tuple[str, str], dict] = {}
    if other_ids:
        async for r in db.friend_requests.find({
            "$or": [
                {"from_user_id": user_id, "to_user_id": {"$in": other_ids}},
                {"to_user_id": user_id, "from_user_id": {"$in": other_ids}},
            ],
        }).sort("created_at", -1):
            other = r["to_user_id"] if r["from_user_id"] == user_id else r["from_user_id"]
            key = (user_id, other)
            if key not in rels:  # keep the most recent only
                rels[key] = r

    out = []
    profs_to_enrich = [p for _, p in scored[:200]]
    await _enrich_emails(profs_to_enrich)
    viewer_is_admin = await _is_admin_user(user_id)
    for _, p in scored[:200]:
        other_id = p.get("_id")
        rel = rels.get((user_id, other_id))
        status = _relationship_status(rel, user_id)
        out.append(_serialize_player(p, status, viewer_is_admin=viewer_is_admin))
    # Pin Creator/Admin accounts to the TOP of the Players list so every
    # user sees the Creator first regardless of search ordering. Admin
    # entries still respect name search — if the query doesn't match the
    # admin's name they simply won't be in `out` to pin. Otherwise we
    # promote them to position 0 (preserve relative order if multiple).
    admin_rows = [r for r in out if r.get("is_admin")]
    non_admin_rows = [r for r in out if not r.get("is_admin")]
    out = admin_rows + non_admin_rows
    return {"players": out}


@api_router.get("/friends/profile/{other_id}")
async def player_profile(other_id: str, user_id: str = Depends(get_user_or_legacy)):
    """Public profile of any single user — used by the player detail modal."""
    prof = await db.profile.find_one({"_id": other_id})
    if not prof:
        raise HTTPException(404, "Player not found")
    await _enrich_emails([prof])
    rel = await _find_relationship(user_id, other_id)
    status = "self" if other_id == user_id else _relationship_status(rel, user_id)
    viewer_is_admin = await _is_admin_user(user_id)
    return _serialize_player(prof, status, viewer_is_admin=viewer_is_admin)


@api_router.get("/friends/profile/{other_id}/details")
async def player_profile_details(other_id: str, user_id: str = Depends(get_user_or_legacy)):
    """Detailed profile for a confirmed friend (or self): mini-apps usage,
    tasks/quests with descriptions and goals.

    Strict access control — anything other than `self` or `friends` returns
    403 so non-friends NEVER see another user's quest list. This is the
    contract that powers the in-app friend Profile detail modal.
    """
    prof = await db.profile.find_one({"_id": other_id})
    if not prof:
        raise HTTPException(404, "Player not found")
    is_self = (other_id == user_id)
    if not is_self:
        rel = await _find_relationship(user_id, other_id)
        status = _relationship_status(rel, user_id)
        if status != "friends":
            raise HTTPException(403, "Add this player as a friend to view their full profile.")

    # Tasks & goals
    raw_tasks = await db.tasks.find({"user_id": other_id}, {"_id": 0}).to_list(1000)
    raw_goals = await db.goals.find({"user_id": other_id}, {"_id": 0}).to_list(1000)
    raw_goals.sort(key=lambda g: g.get("created_at", ""), reverse=True)
    tasks_out = [
        {
            "id": t.get("id"),
            "title": t.get("title", ""),
            "description": t.get("description", "") or "",
            "focus_area": t.get("focus_area", "personal"),
            "time_slot": t.get("time_slot", "morning"),
            "xp_value": int(t.get("xp_value", 10) or 0),
            "is_default": bool(t.get("is_default", False)),
            "recurring": bool(t.get("recurring", True)),
        }
        for t in raw_tasks
    ]
    # group: defaults first by time_slot, then customs
    slot_order = {"morning": 0, "afternoon": 1, "evening": 2}
    tasks_out.sort(key=lambda t: (
        0 if t["is_default"] else 1,
        slot_order.get(t["time_slot"], 3),
        t["title"].lower(),
    ))
    goals_out = [
        {
            "id": g.get("id"),
            "title": g.get("title", ""),
            "description": g.get("description", "") or "",
            "focus_area": g.get("focus_area", "personal"),
            "target_value": int(g.get("target_value", 0) or 0),
            "current_value": int(g.get("current_value", 0) or 0),
            "unit": (g.get("unit") or "days"),
            "xp_reward": int(g.get("xp_reward", 0) or 0),
            "completed": bool(g.get("completed", False)),
        }
        for g in raw_goals
    ]

    # Mini-app surface — every user has the same 3 mini-apps; we compute
    # per-user usage stats so friends see what their friend has actually
    # been engaging with.
    sleep_prof = await db.sleep_profile.find_one({"user_id": other_id}, {"_id": 0}) or {}
    sleep_onboarded = bool(sleep_prof.get("onboarded") or sleep_prof.get("answers"))
    try:
        sleep_checkin_count = await db.sleep_checkins.count_documents({"user_id": other_id})
    except Exception:
        sleep_checkin_count = 0
    try:
        challenges_completed = await db.challenge_completions.count_documents({"user_id": other_id})
    except Exception:
        challenges_completed = 0
    try:
        spot_completed = await db.spot_entries.count_documents({"user_id": other_id, "success": True})
    except Exception:
        spot_completed = 0

    mini_apps = [
        {
            "id": "sleep",
            "title": "Improve Sleeping",
            "icon": "moon",
            "color": "cyan",
            "description": "AI sleep coach + nightly check-ins.",
            "stat_label": (
                "Onboarded · " + (f"{sleep_checkin_count} check-ins logged" if sleep_checkin_count else "no check-ins yet")
                if sleep_onboarded else "Not onboarded yet"
            ),
            "active": sleep_onboarded,
        },
        {
            "id": "challenges",
            "title": "Challenge Tasks",
            "icon": "flash",
            "color": "green",
            "description": "Daily mini-challenges that build confidence.",
            "stat_label": (
                f"{challenges_completed} challenge{'s' if challenges_completed != 1 else ''} completed"
                if challenges_completed else "No challenges completed yet"
            ),
            "active": challenges_completed > 0,
        },
        {
            "id": "spot",
            "title": "Spot the Object",
            "icon": "camera",
            "color": "amber",
            "description": "Mindful camera challenges with your friends.",
            "stat_label": (
                f"{int(prof.get('spot_points', 0) or 0)} Spot Points · {spot_completed} captures"
                if (spot_completed or int(prof.get('spot_points', 0) or 0))
                else "No captures yet"
            ),
            "active": spot_completed > 0 or int(prof.get("spot_points", 0) or 0) > 0,
        },
    ]

    return {
        "user_id": other_id,
        "is_self": is_self,
        "mini_apps": mini_apps,
        "tasks": tasks_out,
        "goals": goals_out,
        "counts": {
            "tasks_total": len(tasks_out),
            "tasks_default": sum(1 for t in tasks_out if t["is_default"]),
            "tasks_custom": sum(1 for t in tasks_out if not t["is_default"]),
            "goals_total": len(goals_out),
            "goals_active": sum(1 for g in goals_out if not g["completed"]),
            "goals_completed": sum(1 for g in goals_out if g["completed"]),
        },
    }


@api_router.post("/friends/request")
async def friends_request(body: FriendActionPayload, user_id: str = Depends(get_user_or_legacy)):
    target = body.user_id
    if target == user_id:
        raise HTTPException(400, "You can't friend yourself.")
    target_user = await db.users.find_one({"_id": target})
    if not target_user:
        raise HTTPException(404, "Target account not found.")
    existing = await _find_relationship(user_id, target)
    if existing and existing.get("status") == "accepted":
        return {"status": "friends", "message": "Already friends"}
    if existing and existing.get("status") == "pending":
        # If they previously sent us a request, accept it instead.
        if existing.get("from_user_id") == target:
            await db.friend_requests.update_one(
                {"id": existing["id"]},
                {"$set": {"status": "accepted", "accepted_at": now_iso()}},
            )
            return {"status": "friends", "message": "Request accepted"}
        return {"status": "pending_outgoing", "message": "Request already sent"}
    doc = {
        "id": str(uuid.uuid4()),
        "from_user_id": user_id,
        "to_user_id": target,
        "status": "pending",
        "created_at": now_iso(),
    }
    await db.friend_requests.insert_one(doc)
    return {"status": "pending_outgoing", "message": "Friend request sent", "request_id": doc["id"]}


@api_router.post("/friends/accept")
async def friends_accept(body: FriendActionPayload, user_id: str = Depends(get_user_or_legacy)):
    """Accept a pending request that was sent BY `body.user_id` TO me."""
    rel = await db.friend_requests.find_one({
        "from_user_id": body.user_id,
        "to_user_id": user_id,
        "status": "pending",
    })
    if not rel:
        raise HTTPException(404, "No pending request from this user.")
    await db.friend_requests.update_one(
        {"id": rel["id"]},
        {"$set": {"status": "accepted", "accepted_at": now_iso()}},
    )
    return {"status": "friends"}


@api_router.post("/friends/decline")
async def friends_decline(body: FriendActionPayload, user_id: str = Depends(get_user_or_legacy)):
    """Decline a pending incoming request, OR cancel an outgoing one."""
    res = await db.friend_requests.delete_many({
        "$or": [
            {"from_user_id": body.user_id, "to_user_id": user_id, "status": "pending"},
            {"from_user_id": user_id, "to_user_id": body.user_id, "status": "pending"},
        ],
    })
    return {"deleted": res.deleted_count, "status": "none"}


@api_router.post("/friends/remove")
async def friends_remove(body: FriendActionPayload, user_id: str = Depends(get_user_or_legacy)):
    res = await db.friend_requests.delete_many({
        "$or": [
            {"from_user_id": user_id, "to_user_id": body.user_id, "status": "accepted"},
            {"from_user_id": body.user_id, "to_user_id": user_id, "status": "accepted"},
        ],
    })
    return {"deleted": res.deleted_count, "status": "none"}


@api_router.get("/friends/requests")
async def list_friend_requests(user_id: str = Depends(get_user_or_legacy)):
    """Pending requests *received* by me (incoming) — shown in the
    'Friend Requests' tab."""
    viewer_is_admin = await _is_admin_user(user_id)
    out_incoming: list = []
    async for r in db.friend_requests.find({"to_user_id": user_id, "status": "pending"}).sort("created_at", -1):
        from_id = r["from_user_id"]
        prof = await db.profile.find_one({"_id": from_id})
        if not prof:
            continue
        out_incoming.append({
            "request_id": r["id"],
            "created_at": r.get("created_at"),
            "player": _serialize_player(prof, "pending_incoming", viewer_is_admin=viewer_is_admin),
        })
    out_outgoing: list = []
    async for r in db.friend_requests.find({"from_user_id": user_id, "status": "pending"}).sort("created_at", -1):
        to_id = r["to_user_id"]
        prof = await db.profile.find_one({"_id": to_id})
        if not prof:
            continue
        out_outgoing.append({
            "request_id": r["id"],
            "created_at": r.get("created_at"),
            "player": _serialize_player(prof, "pending_outgoing", viewer_is_admin=viewer_is_admin),
        })
    return {"incoming": out_incoming, "outgoing": out_outgoing}


@api_router.get("/friends/list")
async def list_friends(user_id: str = Depends(get_user_or_legacy)):
    out: list = []
    viewer_is_admin = await _is_admin_user(user_id)
    async for r in db.friend_requests.find({
        "status": "accepted",
        "$or": [{"from_user_id": user_id}, {"to_user_id": user_id}],
    }).sort("accepted_at", -1):
        other_id = r["to_user_id"] if r["from_user_id"] == user_id else r["from_user_id"]
        prof = await db.profile.find_one({"_id": other_id})
        if not prof:
            continue
        row = _serialize_player(prof, "friends", viewer_is_admin=viewer_is_admin)
        # Surface the friendship start timestamp so the unfriend dialog
        # can show "You've been friends for X days" subtitle on the
        # client. Fallback to created_at for legacy rows.
        row["friended_at"] = r.get("accepted_at") or r.get("created_at")
        out.append(row)
    return {"friends": out}


# ═════════════════════ Points+ (XP Boost endpoints) ═════════════════════
class BoostUnlockPayload(BaseModel):
    code: str


class BoostActivatePayload(BaseModel):
    type: Optional[str] = None           # legacy: triple_day | double_week | double_month
    inventory_id: Optional[str] = None   # new: activate a specific inventory entry


class BoostClaimPayload(BaseModel):
    type: str                            # triple_day | double_week | double_month


def _make_inventory_entry(boost_type: str, source: str = "shop") -> dict:
    cfg = BOOST_DEFS.get(boost_type) or {}
    return {
        "id": str(uuid.uuid4()),
        "type": boost_type,
        "multiplier": int(cfg.get("multiplier", 1)),
        "duration_days": int(cfg.get("duration_days", 1)),
        "label": cfg.get("label", ""),
        "source": source,                 # shop | leaderboard_winner
        "acquired_at": now_iso(),
        "activated": False,
    }


@api_router.post("/boosts/unlock")
async def boosts_unlock(body: BoostUnlockPayload, user_id: str = Depends(get_user_or_legacy)):
    code = (body.code or "").strip().upper()
    if code != BOOST_UNLOCK_CODE.upper():
        raise HTTPException(400, "Invalid code")
    await get_or_create_profile_for(user_id)
    await db.profile.update_one(
        {"_id": user_id},
        {"$set": {"boosts_unlocked": True, "boosts_unlocked_at": now_iso()}},
    )
    prof = await db.profile.find_one({"_id": user_id})
    return {"boosts_unlocked": True, "profile": serialize_profile(prof)}


@api_router.post("/boosts/claim")
async def boosts_claim(body: BoostClaimPayload, user_id: str = Depends(get_user_or_legacy)):
    """Bonus Top Up — adds a boost to the user's inventory (not activated)."""
    prof = await db.profile.find_one({"_id": user_id})
    if not prof:
        raise HTTPException(404, "Profile not found")
    if not prof.get("boosts_unlocked"):
        raise HTTPException(403, detail={
            "error": "boosts_locked",
            "message": "Enter the unlock code first to access XP boosts.",
        })
    if body.type not in BOOST_DEFS:
        raise HTTPException(400, "Unknown boost type")
    entry = _make_inventory_entry(body.type, source="shop")
    await db.profile.update_one(
        {"_id": user_id},
        {"$push": {"boost_inventory": entry}},
    )
    prof = await db.profile.find_one({"_id": user_id})
    return {"claimed": entry, "profile": serialize_profile(prof)}


@api_router.post("/boosts/activate")
async def boosts_activate(body: BoostActivatePayload, user_id: str = Depends(get_user_or_legacy)):
    prof = await db.profile.find_one({"_id": user_id})
    if not prof:
        raise HTTPException(404, "Profile not found")
    if not prof.get("boosts_unlocked"):
        raise HTTPException(403, detail={
            "error": "boosts_locked",
            "message": "Enter the unlock code first to access XP boosts.",
        })

    # ── Resolve the boost to activate ─────────────────────────────────
    # Two valid paths:
    #   (A) inventory_id  → consume an entry from boost_inventory
    #       (preferred — used by gifted boosts + claimed shop boosts)
    #   (B) type only     → legacy, auto-creates a one-shot from BOOST_DEFS
    inv: list = prof.get("boost_inventory") or []
    entry = None
    boost_type: Optional[str] = None
    multiplier: Optional[int] = None
    duration_days: Optional[int] = None
    label: Optional[str] = None

    if body.inventory_id:
        # Find the requested inventory entry. Be explicit about the
        # failure mode so the client can show a useful message.
        for it in inv:
            if it.get("id") == body.inventory_id:
                entry = it
                break
        if not entry:
            raise HTTPException(404, "Boost not in your inventory")
        if entry.get("activated"):
            # Idempotent guard — don't re-activate the same gift twice.
            raise HTTPException(409, "This boost has already been activated.")
        boost_type = entry.get("type") or "custom_gift"
        # CRITICAL FIX: prefer the inventory entry's own metadata. Gifted
        # entries (especially custom_gift) carry their multiplier +
        # duration_days inline and their `type` may NOT exist in BOOST_DEFS.
        # Falling back to BOOST_DEFS[type] without these guards used to
        # crash with `TypeError: 'NoneType' object is not subscriptable`
        # → 500 Internal Server Error on activation of any custom gift.
        try:
            multiplier = int(entry.get("multiplier") or 0)
        except (TypeError, ValueError):
            multiplier = 0
        try:
            duration_days = int(entry.get("duration_days") or 0)
        except (TypeError, ValueError):
            duration_days = 0
        label = entry.get("label")
        # Fill any missing piece from BOOST_DEFS as a last-ditch fallback.
        if (not multiplier or not duration_days) and boost_type in BOOST_DEFS:
            cfg = BOOST_DEFS[boost_type]
            multiplier = multiplier or int(cfg.get("multiplier") or 0)
            duration_days = duration_days or int(cfg.get("duration_days") or 0)
            label = label or cfg.get("label")
    elif body.type:
        if body.type not in BOOST_DEFS:
            raise HTTPException(400, "Unknown boost type")
        boost_type = body.type
        cfg = BOOST_DEFS[boost_type]
        multiplier = int(cfg.get("multiplier") or 0)
        duration_days = int(cfg.get("duration_days") or 0)
        label = cfg.get("label")
    else:
        raise HTTPException(400, "inventory_id or type required")

    # Sanity-check the resolved metadata before we burn it into the
    # profile. A malformed record (e.g. a partially-written gift) used
    # to slip through and 500 later when serialize_profile tried to
    # parse expires_at. We catch those here with a clear 400.
    if not (isinstance(multiplier, int) and 2 <= multiplier <= 10):
        raise HTTPException(400, "Boost multiplier is invalid (expected 2..10).")
    if not (isinstance(duration_days, int) and 1 <= duration_days <= 365):
        raise HTTPException(400, "Boost duration is invalid (expected 1..365 days).")

    activated_at_dt = datetime.now(timezone.utc)
    expires_dt = activated_at_dt + timedelta(days=duration_days)
    boost_doc = {
        "type": boost_type,
        "multiplier": multiplier,
        "duration_days": duration_days,
        "label": label or boost_type,
        "activated_at": activated_at_dt.isoformat(),
        "expires_at": expires_dt.isoformat(),
    }

    # If we consumed an inventory entry, mark it activated (keeps history)
    try:
        if entry:
            res = await db.profile.update_one(
                {
                    "_id": user_id,
                    # $elemMatch ensures we look at the SPECIFIC entry by id
                    # AND check that *that* entry is not yet activated, in
                    # one atomic query. (Without $elemMatch the activated
                    # check would scan the whole array and reject any user
                    # who has ANY other previously-activated boost.)
                    "boost_inventory": {
                        "$elemMatch": {
                            "id": entry["id"],
                            "activated": {"$ne": True},
                        }
                    },
                },
                {"$set": {
                    "xp_boost": boost_doc,
                    "boost_inventory.$.activated": True,
                    "boost_inventory.$.activated_at": activated_at_dt.isoformat(),
                    "boost_inventory.$.expires_at": expires_dt.isoformat(),
                    # Persist any metadata that was missing on the gift
                    # entry so future reads don't have to back-fill.
                    "boost_inventory.$.multiplier": multiplier,
                    "boost_inventory.$.duration_days": duration_days,
                }},
            )
            if res.matched_count == 0:
                # Either someone else already activated this entry (race)
                # or it was deleted between the lookup and the update.
                raise HTTPException(409, "This boost has already been activated.")
        else:
            await db.profile.update_one(
                {"_id": user_id},
                {"$set": {"xp_boost": boost_doc}},
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[boosts/activate] db update failed for user=%s: %s", user_id, e)
        raise HTTPException(500, "Could not activate the boost. Please try again.")

    prof = await db.profile.find_one({"_id": user_id})
    return {"active_boost": _serialize_active_boost(prof), "profile": serialize_profile(prof)}


@api_router.get("/boosts/status")
async def boosts_status(user_id: str = Depends(get_user_or_legacy)):
    prof = await db.profile.find_one({"_id": user_id}) or {}
    return {
        "boosts_unlocked": bool(prof.get("boosts_unlocked")),
        "active_boost": _serialize_active_boost(prof),
        "boost_inventory": _serialize_boost_inventory(prof),
    }


# ═════════════════════ Friends Leaderboard (weekly XP) ═════════════════════
# Weekly window = Mon 00:00 → Sat 23:59:59 in each player's LOCAL time.
# Sunday is rest/winner day — week is closed, winner gets a 2x-day boost
# auto-dropped into their Available Bonuses.
# ──────────────────────────────────────────────────────────────────────

def _local_now(tz_offset_minutes: int) -> datetime:
    """Return the user's local-now as a naive datetime."""
    return datetime.now(timezone.utc) + timedelta(minutes=int(tz_offset_minutes or 0))


def _local_week_bounds(tz_offset_minutes: int, anchor: Optional[datetime] = None):
    """Return (local_monday_00_utc, local_sunday_00_utc, local_week_key)
    for the week CONTAINING the anchor instant (default: now).
    Monday 00:00 local → converted to UTC. Sunday 00:00 local → converted to UTC.
    local_week_key = 'YYYY-Www' using ISO week of local Monday."""
    off = int(tz_offset_minutes or 0)
    if anchor is None:
        anchor = datetime.now(timezone.utc)
    local = anchor + timedelta(minutes=off)
    # Monday of local week (Python: Monday=0)
    local_monday = (local - timedelta(days=local.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    local_sunday = local_monday + timedelta(days=6)  # Sunday same week
    # Convert local → UTC by subtracting the tz offset
    utc_monday = local_monday - timedelta(minutes=off)
    utc_sunday = local_sunday - timedelta(minutes=off)
    iso_year, iso_week, _ = local_monday.isocalendar()
    return utc_monday.replace(tzinfo=timezone.utc), utc_sunday.replace(tzinfo=timezone.utc), f"{iso_year}-W{iso_week:02d}"


def _is_local_sunday(tz_offset_minutes: int) -> bool:
    """True if user is currently in their local Sunday."""
    local = _local_now(tz_offset_minutes)
    return local.weekday() == 6  # Monday=0 … Sunday=6


async def _log_xp_event(user_id: str, xp: int, tz_offset: int):
    """Append an XP-earn event to xp_events collection (for leaderboard)."""
    if xp <= 0:
        return
    monday_utc, _, week_key = _local_week_bounds(tz_offset)
    await db.xp_events.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "xp": int(xp),
        "earned_at": now_iso(),
        "earned_at_utc": datetime.now(timezone.utc),
        "tz_offset_minutes": int(tz_offset or 0),
        "local_week_key": week_key,
    })


async def _log_xp_to_charts(
    user_id: str,
    amount: int,
    source: str,
    focus_area: str = "mindset",
) -> None:
    """Write an XP row that the Progress-tab charts read.

    The /stats/weekly and /stats/monthly endpoints sum `xp_awarded` from
    the `task_logs` collection. Originally only regular task completions
    inserted there, which meant XP earned from goals, focus sessions,
    mini-app challenges (sleep / confidence / dress-with-confidence /
    challenge tasks) was invisible on the charts even though it bumped
    the user's total_xp profile counter.

    This helper inserts a synthetic task_log row tagged with the XP
    source (so we can debug analytics later) using a UUID-prefixed
    task_id so it never collides with a real task. Whatever string is
    passed as `focus_area` will also be reflected in /stats/by-area —
    callers should pick the most accurate one (e.g. a goal in the
    "social" pillar should pass focus_area="social").

    GIFTED XP is intentionally NOT logged here. Creator gifts are
    surfaced separately by the chart endpoints via the `gifts`
    collection (rendered as the gold stacked segment), and double-
    logging them would inflate the daily totals.

    Never raises — chart logging is non-critical and must not block the
    XP grant if Mongo is hot.
    """
    if amount <= 0:
        return
    try:
        # Normalise focus_area to one of the four canonical pillars.
        # Anything unknown collapses to "mindset" so /stats/by-area
        # doesn't get a garbage bucket.
        if focus_area not in FOCUS_AREAS:
            focus_area = "mindset"
        await db.task_logs.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            # Synthetic task_id so this row can never be confused with a
            # real task completion when we list past task logs.
            "task_id": f"_xp:{source}:{uuid.uuid4()}",
            "task_title": source,
            "date": today_str(),
            "focus_area": focus_area,
            "xp_awarded": int(amount),
            "xp_multiplier": 1.0,
            "completed_at": now_iso(),
            "_source": source,  # tag for analytics; not read by chart
        })
    except Exception as e:
        logger.warning("[xp-chart-log] failed for source=%s: %s", source, e)


async def _sum_week_xp(user_id: str, tz_offset: int, anchor: Optional[datetime] = None) -> int:
    """Sum xp earned in the week CONTAINING the anchor, relative to this user's local timezone."""
    monday_utc, sunday_utc, _ = _local_week_bounds(tz_offset, anchor)
    cursor = db.xp_events.find({
        "user_id": user_id,
        "earned_at_utc": {"$gte": monday_utc, "$lt": sunday_utc},
    })
    total = 0
    async for ev in cursor:
        total += int(ev.get("xp", 0) or 0)
    return total


async def _friend_ids(user_id: str) -> list:
    """Return list of user_ids who are friends (accepted) with user_id."""
    out = []
    async for r in db.friend_requests.find({
        "status": "accepted",
        "$or": [{"from_user_id": user_id}, {"to_user_id": user_id}],
    }):
        other = r["to_user_id"] if r["from_user_id"] == user_id else r["from_user_id"]
        out.append(other)
    return out


async def _get_profile_tz(uid: str) -> int:
    prof = await db.profile.find_one({"_id": uid}, {"tz_offset_minutes": 1})
    return int((prof or {}).get("tz_offset_minutes", 0) or 0)


async def _compute_medals(user_id: str) -> list:
    """Return all medals awarded to this user (gold for wins, broken for revoked)."""
    out = []
    async for m in db.leaderboard_medals.find({"user_id": user_id}).sort("week_key", -1):
        out.append({
            "week_key": m.get("week_key"),
            "awarded_at": m.get("awarded_at"),
            "revoked": bool(m.get("revoked")),
            "revoked_reason": m.get("revoked_reason"),
            "xp": int(m.get("xp", 0)),
        })
    return out


async def _grant_winner_medal(winner_id: str, week_key: str, xp_total: int):
    """Idempotently award a gold medal + 2x-day boost to the winner's inventory."""
    existing = await db.leaderboard_medals.find_one({
        "user_id": winner_id,
        "week_key": week_key,
    })
    if existing:
        return existing
    medal = {
        "id": str(uuid.uuid4()),
        "user_id": winner_id,
        "week_key": week_key,
        "awarded_at": now_iso(),
        "xp": int(xp_total),
        "revoked": False,
    }
    await db.leaderboard_medals.insert_one(medal)
    # Auto-grant the 2x-day boost to Available Bonuses
    entry = _make_inventory_entry("triple_day", source="leaderboard_winner")
    # Use "double_day" concept — but since BOOST_DEFS only has triple_day/double_week/double_month,
    # use a special 2x-for-a-day entry: override multiplier & duration.
    entry.update({
        "type": "double_day",
        "multiplier": 2,
        "duration_days": 1,
        "label": "2× XP for a day (Leaderboard Winner)",
    })
    await db.profile.update_one(
        {"_id": winner_id},
        {"$push": {"boost_inventory": entry}, "$set": {"boosts_unlocked": True}},
    )
    return medal


# Extend BOOST_DEFS at runtime to support the winner's reward type on activate
BOOST_DEFS["double_day"] = {"multiplier": 2, "duration_days": 1, "label": "2× points for a day"}


@api_router.get("/friends/leaderboard")
async def friends_leaderboard(
    tz: int = 0,
    user_id: str = Depends(get_user_or_legacy),
):
    """Weekly (Mon-Sat local) XP leaderboard among friends + self.
    `tz` = viewer's local UTC offset in minutes (e.g. -420 for PST, +330 for IST).

    On the viewer's local Sunday, we compute the winner of the WEEK THAT JUST
    ENDED and lazily grant them a gold medal + 2x-day boost (idempotent)."""

    # Persist viewer's tz so background tasks can use it later
    await db.profile.update_one(
        {"_id": user_id},
        {"$set": {"tz_offset_minutes": int(tz or 0)}},
    )

    member_ids = [user_id] + await _friend_ids(user_id)
    # De-dupe
    member_ids = list(dict.fromkeys(member_ids))

    viewer_is_sunday = _is_local_sunday(tz)
    # For "which week to show":
    #  - Mon-Sat local → show THIS week's progress (still in play)
    #  - Sun local     → show LAST week's final totals (it's rest/winner day)
    anchor = datetime.now(timezone.utc)
    if viewer_is_sunday:
        anchor = anchor - timedelta(days=1)   # shift into Saturday → same ISO week
    _, _, display_week_key = _local_week_bounds(tz, anchor)

    rows = []
    for uid in member_ids:
        prof = await db.profile.find_one({"_id": uid})
        if not prof:
            continue
        # Use each player's OWN tz so their Mon-Sat window is relative to them
        their_tz = int(prof.get("tz_offset_minutes", tz) or tz)
        weekly_xp = await _sum_week_xp(uid, their_tz, anchor)
        medals = await _compute_medals(uid)
        # Admin visibility: others see them as ∞ / level 999 / "Admin · Creator"
        # so the leaderboard renders the golden Creator shield instead of a
        # generic blue shield. Admin-on-self continues to see their real
        # name/level to keep the admin dashboard truthful.
        u = await db.users.find_one({"_id": uid}, {"email": 1}) or {}
        is_admin = _is_admin_email(u.get("email"))
        viewing_self = (uid == user_id)
        show_unlimited = is_admin and not viewing_self
        display_name = (
            ADMIN_PUBLIC_DISPLAY_NAME
            if show_unlimited
            else (prof.get("full_name") or prof.get("name") or "Anonymous")
        )
        display_level = 999 if show_unlimited else int(prof.get("level", 1) or 1)
        display_total_xp = -1 if show_unlimited else int(prof.get("total_xp", 0) or 0)
        rows.append({
            "user_id": uid,
            "name": display_name,
            "avatar_base64": prof.get("avatar_base64"),
            "level": display_level,
            "total_xp": display_total_xp,
            "weekly_xp": int(weekly_xp),
            "is_self": viewing_self,
            "is_admin": bool(is_admin),
            "is_admin_view": bool(show_unlimited),
            "tz_offset_minutes": their_tz,
            "is_week_closed": _is_local_sunday(their_tz),  # already in Sunday locally
            "medals_count": len([m for m in medals if not m.get("revoked")]),
            "medals_revoked": len([m for m in medals if m.get("revoked")]),
        })
    # Sort highest → lowest
    rows.sort(key=lambda r: (-r["weekly_xp"], r["name"].lower()))

    winner = None
    declared = False
    if rows and viewer_is_sunday and rows[0]["weekly_xp"] > 0:
        declared = True
        winner = rows[0]
        # Award medal to winner for the week that just ended (display_week_key)
        # Check if there are unresolved active reports against the winner for this week
        active_reports = await _winner_report_verdict(winner["user_id"], display_week_key, member_ids)
        if active_reports.get("guilty"):
            # Revoked winner — do NOT grant bonus, but mark medal as revoked
            existing = await db.leaderboard_medals.find_one({
                "user_id": winner["user_id"],
                "week_key": display_week_key,
            })
            if not existing:
                await db.leaderboard_medals.insert_one({
                    "id": str(uuid.uuid4()),
                    "user_id": winner["user_id"],
                    "week_key": display_week_key,
                    "awarded_at": now_iso(),
                    "xp": winner["weekly_xp"],
                    "revoked": True,
                    "revoked_reason": "Reported for cheating by majority of leaderboard",
                })
            winner["medal_revoked"] = True
        else:
            await _grant_winner_medal(winner["user_id"], display_week_key, winner["weekly_xp"])
            winner["medal_revoked"] = False

    # Pending reports visible to this viewer
    reports = await _active_reports_for_viewer(user_id, member_ids, display_week_key)

    return {
        "week_key": display_week_key,
        "viewer_is_sunday": viewer_is_sunday,
        "winner_declared": declared,
        "winner": winner,
        "rows": rows,
        "reports": reports,
    }


@api_router.get("/leaderboard/profile/{other_id}")
async def leaderboard_profile(
    other_id: str,
    tz: int = 0,
    user_id: str = Depends(get_user_or_legacy),
):
    """Profile view from leaderboard: player + medals + cheating-flag history."""
    prof = await db.profile.find_one({"_id": other_id})
    if not prof:
        raise HTTPException(404, "Player not found")
    their_tz = int(prof.get("tz_offset_minutes", tz) or tz)
    weekly_xp = await _sum_week_xp(other_id, their_tz)
    medals = await _compute_medals(other_id)
    rel = await _find_relationship(user_id, other_id)
    status = "self" if other_id == user_id else _relationship_status(rel, user_id)
    viewer_is_admin = await _is_admin_user(user_id)
    base = _serialize_player(prof, status, viewer_is_admin=viewer_is_admin)
    base.update({
        "weekly_xp": int(weekly_xp),
        "medals": medals,
        "is_flagged_cheater": any(m.get("revoked") for m in medals),
    })
    return base


# ═════════════════════ Leaderboard Report System ═════════════════════
class ReportSubmitPayload(BaseModel):
    reported_user_id: str
    reason: str


async def _leaderboard_member_ids(user_id: str) -> list:
    """Return list of user_ids who are on this viewer's leaderboard
    (viewer + their friends)."""
    ids = [user_id] + await _friend_ids(user_id)
    return list(dict.fromkeys(ids))


async def _winner_report_verdict(winner_id: str, week_key: str, leaderboard_member_ids: list) -> dict:
    """Evaluate whether the winner has been reported by > half of leaderboard.
    Counts unique reporters + unique 'likers' as supporters."""
    reports_cur = db.leaderboard_reports.find({
        "reported_user_id": winner_id,
        "week_key": week_key,
    })
    supporters = set()
    has_report = False
    async for r in reports_cur:
        has_report = True
        supporters.add(r.get("reporter_id"))
        for sup in (r.get("supporters") or []):
            supporters.add(sup)
    # Only count supporters who are on this week's leaderboard (friends+winner)
    valid = [s for s in supporters if s in leaderboard_member_ids]
    threshold = max(1, (len(leaderboard_member_ids) // 2) + 1)
    return {
        "has_report": has_report,
        "supporters": valid,
        "threshold": threshold,
        "guilty": has_report and len(valid) >= threshold,
    }


async def _active_reports_for_viewer(viewer_id: str, member_ids: list, week_key: str) -> list:
    """Return list of active reports this viewer should see in their notifications."""
    out = []
    cursor = db.leaderboard_reports.find({
        "week_key": week_key,
        "reporter_id": {"$in": member_ids},
    }).sort("created_at", -1)
    async for r in cursor:
        reporter = await db.profile.find_one(
            {"_id": r["reporter_id"]},
            {"full_name": 1, "name": 1, "avatar_base64": 1},
        )
        reported = await db.profile.find_one(
            {"_id": r["reported_user_id"]},
            {"full_name": 1, "name": 1, "avatar_base64": 1},
        )
        supporters = r.get("supporters") or []
        out.append({
            "id": r["id"],
            "reporter_id": r["reporter_id"],
            "reporter_name": (reporter or {}).get("full_name") or (reporter or {}).get("name") or "Anonymous",
            "reported_user_id": r["reported_user_id"],
            "reported_name": (reported or {}).get("full_name") or (reported or {}).get("name") or "Anonymous",
            "reason": r.get("reason", ""),
            "created_at": r.get("created_at"),
            "week_key": r.get("week_key"),
            "supporters_count": len(supporters),
            "viewer_supported": viewer_id in supporters,
            "viewer_is_reporter": viewer_id == r["reporter_id"],
        })
    return out


@api_router.post("/leaderboard/report")
async def leaderboard_report(body: ReportSubmitPayload, user_id: str = Depends(get_user_or_legacy)):
    if not body.reason or not body.reason.strip():
        raise HTTPException(400, "Please include a reason for the report.")
    if body.reported_user_id == user_id:
        raise HTTPException(400, "You can't report yourself.")
    # Must be on viewer's leaderboard
    member_ids = await _leaderboard_member_ids(user_id)
    if body.reported_user_id not in member_ids:
        raise HTTPException(400, "Player not on your leaderboard.")
    tz = await _get_profile_tz(user_id)
    _, _, week_key = _local_week_bounds(tz)
    # One active report per reporter per reported-player per week
    existing = await db.leaderboard_reports.find_one({
        "reporter_id": user_id,
        "reported_user_id": body.reported_user_id,
        "week_key": week_key,
    })
    if existing:
        raise HTTPException(400, "You've already reported this player this week.")
    doc = {
        "id": str(uuid.uuid4()),
        "reporter_id": user_id,
        "reported_user_id": body.reported_user_id,
        "reason": body.reason.strip()[:500],
        "week_key": week_key,
        "created_at": now_iso(),
        "supporters": [user_id],   # reporter auto-supports
    }
    await db.leaderboard_reports.insert_one(doc)
    doc.pop("_id", None)
    return {"report": doc}


@api_router.post("/leaderboard/report/{report_id}/support")
async def leaderboard_report_support(report_id: str, user_id: str = Depends(get_user_or_legacy)):
    report = await db.leaderboard_reports.find_one({"id": report_id})
    if not report:
        raise HTTPException(404, "Report not found")
    member_ids = await _leaderboard_member_ids(user_id)
    if report["reporter_id"] not in member_ids and report["reported_user_id"] not in member_ids:
        raise HTTPException(403, "Not visible to you.")
    supporters = set(report.get("supporters") or [])
    supporters.add(user_id)
    await db.leaderboard_reports.update_one(
        {"id": report_id},
        {"$set": {"supporters": list(supporters)}},
    )
    return {"supporters_count": len(supporters)}


@api_router.delete("/leaderboard/report/{report_id}/support")
async def leaderboard_report_unsupport(report_id: str, user_id: str = Depends(get_user_or_legacy)):
    report = await db.leaderboard_reports.find_one({"id": report_id})
    if not report:
        raise HTTPException(404, "Report not found")
    supporters = [s for s in (report.get("supporters") or []) if s != user_id]
    await db.leaderboard_reports.update_one(
        {"id": report_id},
        {"$set": {"supporters": supporters}},
    )
    return {"supporters_count": len(supporters)}


# ═════════════════════ Spot the Object (mini-app) ═════════════════════
# Phase 1: Solo mode + GPT-4o vision validation + photo gallery + spot points.
# Phase 2 (future): Friends event lobby + likes/comments + penalty math.
# ──────────────────────────────────────────────────────────────────────

SPOT_OBJECTS = [
    "leaf", "tree", "flower", "indoor plant", "blade of grass",
    "dog", "cat", "bird",
    "book", "pen", "your phone", "laptop", "headphones", "keyboard", "computer mouse",
    "cup", "mug", "bottle of water", "plate", "fork", "spoon",
    "chair", "table", "lamp", "mirror", "window", "door handle",
    "shoe", "hat", "wristwatch", "pair of glasses", "wallet", "set of keys",
    "pillow", "blanket", "towel",
    "anything pink", "anything blue", "anything red", "anything yellow", "anything green",
    "piece of fruit", "apple", "banana",
    "car", "bicycle", "ball",
    "remote control", "candle", "clock", "scissors", "toothbrush",
    "bowl", "fridge magnet", "soft toy", "coin", "battery", "spoon",
]


class SpotCheckPayload(BaseModel):
    target_object: str
    photo_base64: str    # raw base64 (no data: prefix)


class SpotCompletePayload(BaseModel):
    target_object: str
    photo_base64: str
    success: bool
    remaining_seconds: int = 0
    mode: str = "solo_constant"   # solo_constant | solo_random | friends


class SpotCommentPayload(BaseModel):
    text: str


class SpotRandomTogglePayload(BaseModel):
    enabled: bool


@api_router.get("/spot/object")
async def spot_get_object(user_id: str = Depends(get_user_or_legacy)):
    """Return a fresh random object for the user to find."""
    obj = random.choice(SPOT_OBJECTS)
    return {"object": obj, "challenge_id": str(uuid.uuid4())}


# ═══════════════ Admin Train Mode (Spot the Object) ═══════════════
# Object-specific angle prompts the AI walks the Creator through. If an
# object isn't in this map we fall back to a generic 4-angle sequence.
SPOT_TRAIN_ANGLES: dict[str, list[str]] = {
    "scissors": ["closed (handles together)", "fully opened", "side angle", "tilted at 45°"],
    "cat": ["face zoomed in", "side profile of body", "from above looking down", "full body in frame"],
    "dog": ["face zoomed in", "side profile of body", "from above looking down", "full body in frame"],
    "bird": ["close-up of head", "side profile", "wings/feathers detail", "full body in frame"],
    "book": ["front cover flat", "spine view", "pages slightly open", "tilted at an angle"],
    "pen": ["full length on flat surface", "tip close-up", "tilted in hand", "from above"],
    "your phone": ["front screen on", "back side", "from edge", "tilted at angle"],
    "laptop": ["open with screen visible", "closed lid", "side profile", "keyboard close-up"],
    "headphones": ["both ear cups visible", "side profile", "folded flat", "from above"],
    "cup": ["from the side", "from above showing rim", "tilted to show handle", "from below"],
    "mug": ["from the side", "from above showing rim", "tilted to show handle", "from below"],
    "bottle of water": ["full body label visible", "from the top", "tilted on its side", "close-up of cap"],
    "shoe": ["side profile", "top down view", "sole visible", "back/heel view"],
    "hat": ["worn or upright", "from above (top)", "side profile", "from inside (interior)"],
    "wristwatch": ["face dial close-up", "side profile of band", "back of watch", "tilted at angle"],
    "pair of glasses": ["folded flat", "open from front", "side profile", "tilted at angle"],
    "wallet": ["closed flat", "open showing slots", "side profile (thickness)", "from above"],
    "set of keys": ["spread on flat surface", "held bunched together", "close-up of one key", "from above"],
    "remote control": ["front buttons facing up", "side profile", "back side", "tilted at angle"],
    "candle": ["full standing", "from above (wick)", "side profile", "lit (flame visible)"],
    "clock": ["face dial close-up", "side profile", "tilted at angle", "from below"],
    "toothbrush": ["side profile bristles up", "from above (bristles)", "tilted at angle", "handle close-up"],
    "bowl": ["from above (interior)", "side profile", "tilted at angle", "from below"],
    "soft toy": ["face zoomed in", "side profile", "from above", "full body in frame"],
}
DEFAULT_TRAIN_ANGLES = ["front view", "side view", "top-down view", "tilted at an angle"]


def _angles_for(object_name: str) -> list[str]:
    return SPOT_TRAIN_ANGLES.get((object_name or "").lower().strip(), DEFAULT_TRAIN_ANGLES)


@api_router.get("/admin/spot/training/objects")
async def admin_spot_training_list(user_id: str = Depends(get_user_or_legacy)):
    """Returns the master list of trainable objects with completion status.
    Used by the Train Mode home screen to show progress + pick what's next.
    """
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator-only action.")
    docs = await db.spot_training.find({}, {"_id": 0}).to_list(2000)
    by_name = {(d.get("object_name") or "").lower(): d for d in docs}
    out = []
    for obj in SPOT_OBJECTS:
        d = by_name.get(obj.lower())
        samples = (d or {}).get("samples") or []
        target_count = len(_angles_for(obj))
        out.append({
            "object_name": obj,
            "samples_count": len(samples),
            "target_count": target_count,
            "is_complete": len(samples) >= target_count,
            "is_skipped": bool((d or {}).get("skipped")),
            "last_trained_at": (d or {}).get("last_trained_at"),
        })
    return {"objects": out}


class AdminSpotStartBody(BaseModel):
    object_name: Optional[str] = None  # explicit pick, else next un-trained


@api_router.post("/admin/spot/training/start")
async def admin_spot_training_start(body: AdminSpotStartBody, user_id: str = Depends(get_user_or_legacy)):
    """Pick an object to train. If body.object_name omitted, returns the
    next un-trained, non-skipped object. If none left, falls back to
    skipped objects so the Creator can revisit them later.
    """
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator-only action.")
    pick = (body.object_name or "").strip().lower()
    if pick:
        if not any(o.lower() == pick for o in SPOT_OBJECTS):
            raise HTTPException(404, "Unknown object.")
        target = pick
    else:
        # Pick the first non-skipped, non-complete object. If everything
        # is either complete or skipped, return the oldest skipped one.
        docs = {(d.get("object_name") or "").lower(): d for d in await db.spot_training.find({}, {"_id": 0}).to_list(2000)}
        next_obj = None
        skipped_pool: list[str] = []
        for obj in SPOT_OBJECTS:
            d = docs.get(obj.lower(), {})
            samples = d.get("samples") or []
            if len(samples) >= len(_angles_for(obj)):
                continue
            if d.get("skipped"):
                skipped_pool.append(obj)
                continue
            next_obj = obj
            break
        target = (next_obj or (skipped_pool[0] if skipped_pool else None) or random.choice(SPOT_OBJECTS))
    target_l = target.lower()
    angles = _angles_for(target_l)
    existing = await db.spot_training.find_one({"object_name": target_l}, {"_id": 0}) or {}
    captured = [s.get("angle") for s in (existing.get("samples") or [])]
    next_angle_idx = min(len(captured), len(angles) - 1)
    return {
        "object_name": target,
        "angles": angles,
        "captured_count": len(captured),
        "total_count": len(angles),
        "next_angle": angles[next_angle_idx] if len(captured) < len(angles) else None,
        "instructions": (
            f"Find a real {target} and capture each angle below. "
            "After each shot, tap 'This is correct object' to save it."
        ),
    }


class AdminSpotCaptureBody(BaseModel):
    object_name: str
    angle: str
    image_base64: str


@api_router.post("/admin/spot/training/capture")
async def admin_spot_training_capture(body: AdminSpotCaptureBody, user_id: str = Depends(get_user_or_legacy)):
    """Save a Creator-confirmed reference photo for the given object/angle.
    The vision model is asked to verify it's actually the right object —
    if not, the sample is REJECTED and not saved (so the Creator's
    training data stays clean).
    """
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator-only action.")
    if not body.image_base64:
        raise HTTPException(400, "image_base64 required")
    if len(body.image_base64) > 8_000_000:
        raise HTTPException(400, "Image too large (8MB).")
    obj = body.object_name.strip().lower()
    if not any(o.lower() == obj for o in SPOT_OBJECTS):
        raise HTTPException(404, "Unknown object.")
    # Verify the photo really shows the object (admin trust, but double-check
    # so we don't poison the few-shot reference set with bad samples).
    check = await _spot_vision_check(body.object_name, body.image_base64)
    if not (check.get("detected") and check.get("confidence", 0) >= 0.55):
        return {
            "ok": False,
            "rejected": True,
            "reason": check.get("reason") or "Object not clearly visible in this photo.",
            "confidence": check.get("confidence"),
        }
    sample = {
        "angle": body.angle.strip()[:80] or "unknown",
        "image_base64": body.image_base64,
        "captured_at": now_iso(),
        "captured_by": user_id,
    }
    await db.spot_training.update_one(
        {"object_name": obj},
        {
            "$push": {"samples": sample},
            "$set": {"last_trained_at": now_iso(), "skipped": False},
            "$setOnInsert": {"object_name": obj, "created_at": now_iso()},
        },
        upsert=True,
    )
    doc = await db.spot_training.find_one({"object_name": obj}, {"_id": 0})
    samples = (doc or {}).get("samples") or []
    angles = _angles_for(obj)
    captured_angles = [s.get("angle") for s in samples]
    is_complete = len(samples) >= len(angles)
    next_angle = None
    if not is_complete:
        # Pick the next angle from the canonical sequence that hasn't
        # been captured yet — falls back to the index-th if none missing.
        for a in angles:
            if a not in captured_angles:
                next_angle = a
                break
        if not next_angle:
            next_angle = angles[len(samples) % len(angles)]
    return {
        "ok": True,
        "rejected": False,
        "captured_count": len(samples),
        "total_count": len(angles),
        "progress_pct": int(round(100 * len(samples) / max(len(angles), 1))),
        "next_angle": next_angle,
        "is_complete": is_complete,
        "confidence": check.get("confidence"),
    }


class AdminSpotSkipBody(BaseModel):
    object_name: str


@api_router.post("/admin/spot/training/skip")
async def admin_spot_training_skip(body: AdminSpotSkipBody, user_id: str = Depends(get_user_or_legacy)):
    """Skip the current object — kept in the pool, just not surfaced as
    'next' until everything else is either complete or also skipped.
    """
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator-only action.")
    obj = body.object_name.strip().lower()
    await db.spot_training.update_one(
        {"object_name": obj},
        {"$set": {"skipped": True, "skipped_at": now_iso()},
         "$setOnInsert": {"object_name": obj, "samples": [], "created_at": now_iso()}},
        upsert=True,
    )
    return {"ok": True}


def _downscale_image_b64(b64: str, max_dim: int = 512, quality: int = 72) -> str:
    """Shrink a base64 JPEG/PNG down to `max_dim` on its longest edge.
    Vision-model inference time is dominated by image-token encoding —
    halving the pixel count halves the tokens and roughly halves
    latency. 512 px is more than enough to identify most everyday
    objects and still produces recognisable detail for GPT-4o-mini.

    Falls back to the original string if anything goes wrong (bad
    base64, unsupported format, Pillow import failure). Pure best-effort.
    """
    try:
        import io, base64 as _b64
        from PIL import Image
        data = _b64.b64decode(b64)
        im = Image.open(io.BytesIO(data))
        im = im.convert("RGB")
        w, h = im.size
        longest = max(w, h)
        if longest > max_dim:
            scale = max_dim / float(longest)
            im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=quality, optimize=True)
        return _b64.b64encode(out.getvalue()).decode("ascii")
    except Exception as e:
        # Downscaling is a perf optimisation, not a correctness requirement.
        logger.warning("[spot] downscale failed, sending original: %s", e)
        return b64


async def _spot_vision_check(target_object: str, photo_base64: str, distance_aware: bool = False) -> dict:
    """Ultra-fast Vision check. Asks GPT-4o-mini a targeted binary
    question about ONE specific object and returns a tiny JSON.

    Speed optimizations applied in this call:
    - The user's photo is downscaled to 512 px longest edge before being
      sent (cuts image-token count ~4-8× and halves end-to-end latency).
    - Creator-trained reference photos are downscaled to 384 px and
      capped to 2 samples, kept ONLY to bias recognition toward the
      correct answer without blowing up the payload.
    - A short system prompt replaces the previous verbose referee
      persona. The model outputs at most ~50 tokens.
    - `distance_aware=True` adds only a single extra JSON key; we no
      longer do a separate distance-classifier pass.

    Global fast-track: the Creator's "Test & Train AI" captures are
    stored per object in `spot_training.samples` and are re-used for
    EVERY player who later tries to spot the same object — this is the
    "training system" that makes identification instantly faster for
    everyone once the Creator has trained an object.
    """
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
        api_key = os.environ.get("EMERGENT_LLM_KEY")
        if not api_key:
            return {"detected": False, "confidence": 0.0, "reason": "No LLM key configured", "distance": "good"}

        # Downscale the user's photo aggressively — this is the single
        # biggest win for vision latency.
        small_user_img = _downscale_image_b64(photo_base64, max_dim=512, quality=72)

        # Load Creator-trained reference samples for this object.
        # Cap at 2 and downscale to 384 to stay fast on every player call.
        ref_doc = await db.spot_training.find_one(
            {"object_name": (target_object or "").lower().strip()},
            {"_id": 0, "samples": 1},
        )
        ref_samples = (ref_doc or {}).get("samples") or []
        ref_imgs: list = []
        seen_angles: set = set()
        for s in reversed(ref_samples):  # newest first
            ang = (s.get("angle") or "").lower()
            if ang in seen_angles:
                continue
            seen_angles.add(ang)
            sb = s.get("image_base64")
            if sb:
                small_ref = _downscale_image_b64(sb, max_dim=384, quality=68)
                ref_imgs.append(ImageContent(image_base64=small_ref))
            if len(ref_imgs) >= 2:
                break

        # Terse, binary-style prompt — exactly what the user asked for.
        # We still keep `confidence` + `reason` + `distance` in the JSON
        # because the live-scan UI uses them for "too close / too far"
        # toasts, but the model's total output stays tiny (~40 tokens).
        if distance_aware:
            system = (
                f"Is there a CLEARLY visible '{target_object}' in the user photo? "
                "Answer only with compact JSON: "
                '{"y":true/false,"c":0-1,"d":"good"|"too_far"|"too_close","r":"1-6 words"}. '
                "y=true only if the object dominates the frame and is recognisable. "
                "d classifies framing. No prose."
            )
        else:
            system = (
                f"Is there a CLEARLY visible '{target_object}' in the user photo? "
                "Answer only with compact JSON: "
                '{"y":true/false,"c":0-1,"r":"1-6 words"}. '
                "y=true only if the object dominates the frame and is recognisable. No prose."
            )
        if ref_imgs:
            system += " The attached REFERENCE images (after the user's photo) are ground-truth captures of the SAME object by the Creator — use them to calibrate."

        chat = LlmChat(
            api_key=api_key,
            session_id=f"spot-{uuid.uuid4().hex[:8]}",
            system_message=system,
        ).with_model("openai", "gpt-4o-mini")
        msg = UserMessage(
            text=f"Target: {target_object}",
            file_contents=[ImageContent(image_base64=small_user_img)] + ref_imgs,
        )
        response = await chat.send_message(msg)
        raw = (response or "").strip()
        import re, json as _json
        m = re.search(r"\{.*?\}", raw, re.S)
        data = _json.loads(m.group(0)) if m else {}
        # Back-compat keys so callers keep working.
        return {
            "detected": bool(data.get("y", data.get("detected", False))),
            "confidence": float(data.get("c", data.get("confidence", 0)) or 0),
            "reason": str(data.get("r", data.get("reason", ""))),
            "distance": str(data.get("d", data.get("distance", "good"))),
        }
    except Exception as e:
        return {"detected": False, "confidence": 0.0, "reason": f"vision unavailable: {e}", "distance": "good"}


@api_router.post("/spot/check")
async def spot_check(body: SpotCheckPayload, user_id: str = Depends(get_user_or_legacy)):
    """Live check during scanning — frontend calls this every ~2 seconds with a
    frame. Returns whether the shutter should be unlocked."""
    if not body.photo_base64:
        raise HTTPException(400, "photo_base64 required")
    if len(body.photo_base64) > 8_000_000:
        raise HTTPException(400, "Image too large (8MB limit)")
    # distance_aware so the frontend can show "too close / too far" toasts.
    result = await _spot_vision_check(body.target_object, body.photo_base64, distance_aware=True)
    result["can_capture"] = bool(result.get("detected") and result.get("confidence", 0) >= 0.55)
    return result


# ───────────────────── Spot the Object — Photo Editing ─────────────────
# Post-capture filter pipeline. All three filters are computed server-side
# via Pillow so the client doesn't need heavy image-processing libraries
# and the round-trip is <500 ms for a 1 MB photo on a warm connection.
#
# Why server-side:
#   - Pillow gives us deterministic, tested ImageEnhance primitives that
#     produce the same result on every device (no GPU-driver variance).
#   - Keeps the mobile app's bundle lean — no native skia / gl-react.
#   - Leaves the door open to a true AI "painting" model later (gpt-image-1
#     edit) without a mobile rebuild.
#
# Filters:
#   - painting: Pillow edge-smoothed + posterize + saturation boost. Gives a
#     clean oil-painting-esque result without an external API call.
#   - bw: Pillow L-convert + autocontrast — crisp high-contrast black & white.
#   - auto: Pillow autocontrast + saturation & contrast enhancement + mild
#     highlight roll-off (tone curve pulls pure whites back to ~240) so the
#     image looks punchier without blowing out.

class SpotEditPreviewPayload(BaseModel):
    entry_id: str
    filter: Literal["painting", "bw", "auto"]


class SpotEditSavePayload(BaseModel):
    entry_id: str
    edited_base64: str


def _apply_spot_filter(b64: str, which: str) -> str:
    """Apply an instant on-device-equivalent filter to a JPEG base64 photo."""
    try:
        import io, base64 as _b64
        from PIL import Image, ImageEnhance, ImageFilter, ImageOps
        data = _b64.b64decode(b64)
        im = Image.open(io.BytesIO(data)).convert("RGB")
        # Cap the working size at 1600 px longest edge — our spot photos
        # are typically 1080-1200 px already so this is a safety net.
        w, h = im.size
        longest = max(w, h)
        if longest > 1600:
            scale = 1600 / float(longest)
            im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        if which == "bw":
            # Neutral black & white with an autocontrast stretch so the
            # result isn't muddy. A 1 % cutoff eliminates outliers.
            im = ImageOps.grayscale(im).convert("RGB")
            im = ImageOps.autocontrast(im, cutoff=1)
        elif which == "auto":
            # Punchier colors + slightly reduced highlights.
            im = ImageOps.autocontrast(im, cutoff=0.5)
            im = ImageEnhance.Color(im).enhance(1.18)     # +18 % saturation
            im = ImageEnhance.Contrast(im).enhance(1.08)  # +8 % contrast
            im = ImageEnhance.Brightness(im).enhance(1.02)
            # Light highlight roll-off via a LUT: pixels > 245 get pulled
            # down to blunt blown-out areas.
            lut = []
            for v in range(256):
                lut.append(int(min(v, 250)))
            im = im.point(lut * 3)
        elif which == "painting":
            # Edge-preserving smoothing to flatten fine detail → paint-like
            # surfaces, then posterize to simulate brush strokes and a
            # saturation bump for richer colors.
            im = im.filter(ImageFilter.SMOOTH_MORE)
            im = im.filter(ImageFilter.MedianFilter(size=5))
            im = ImageOps.posterize(im, 5)                 # 32 colors/channel
            im = ImageEnhance.Color(im).enhance(1.25)
            im = ImageEnhance.Contrast(im).enhance(1.08)
        else:
            raise ValueError(f"unknown filter: {which}")

        out = io.BytesIO()
        im.save(out, format="JPEG", quality=88, optimize=True)
        return _b64.b64encode(out.getvalue()).decode("ascii")
    except Exception as e:
        raise HTTPException(400, f"edit failed: {e}")


@api_router.post("/spot/edit/preview")
async def spot_edit_preview(body: SpotEditPreviewPayload, user_id: str = Depends(get_user_or_legacy)):
    """Return a preview of the chosen filter applied to the user's OWN
    spot photo. Doesn't persist — the client must call /spot/edit/save
    if the user hits the "Save Photo" button."""
    entry = await db.spot_completions.find_one({"id": body.entry_id})
    if not entry:
        raise HTTPException(404, "Spot entry not found")
    if entry.get("user_id") != user_id:
        raise HTTPException(403, "You can only edit your own spot photos")
    orig = entry.get("photo_base64") or ""
    if not orig:
        raise HTTPException(400, "No photo to edit")
    edited = _apply_spot_filter(orig, body.filter)
    return {"edited_base64": edited}


@api_router.post("/spot/edit/save")
async def spot_edit_save(body: SpotEditSavePayload, user_id: str = Depends(get_user_or_legacy)):
    """Overwrite the spot photo with the edited version returned by
    /spot/edit/preview. Only the owner of the spot can save."""
    entry = await db.spot_completions.find_one({"id": body.entry_id})
    if not entry:
        raise HTTPException(404, "Spot entry not found")
    if entry.get("user_id") != user_id:
        raise HTTPException(403, "You can only edit your own spot photos")
    if not body.edited_base64 or len(body.edited_base64) > 12_000_000:
        raise HTTPException(400, "Invalid edited image")
    await db.spot_completions.update_one(
        {"id": body.entry_id},
        {"$set": {"photo_base64": body.edited_base64, "edited_at": now_iso()}},
    )
    return {"ok": True}


@api_router.post("/spot/complete")
async def spot_complete(body: SpotCompletePayload, user_id: str = Depends(get_user_or_legacy)):
    """Save a completed spot attempt. Awards +1 spot point for successful solo
    finds (Phase 1). Friends penalties land in Phase 2."""
    if not body.photo_base64:
        raise HTTPException(400, "photo_base64 required")
    delta = 1 if body.success else 0
    entry = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "target_object": body.target_object,
        "photo_base64": body.photo_base64,
        "success": bool(body.success),
        "remaining_seconds": int(body.remaining_seconds or 0),
        "mode": body.mode or "solo_constant",
        "points_delta": delta,
        "taken_at": now_iso(),
        "likes": [],
        "comments": [],
    }
    await db.spot_completions.insert_one(entry)
    if delta:
        await db.profile.update_one({"_id": user_id}, {"$inc": {"spot_points": delta}})
    prof = await db.profile.find_one({"_id": user_id})
    out = {**entry}
    out.pop("_id", None)
    return {
        "entry": out,
        "points_delta": delta,
        "spot_points": int((prof or {}).get("spot_points", 0)),
        "profile": serialize_profile(prof) if prof else None,
    }


@api_router.get("/spot/feed")
async def spot_feed(user_id: str = Depends(get_user_or_legacy), limit: int = 50):
    """Return recent Spot entries from self + accepted friends (gallery)."""
    member_ids = [user_id] + await _friend_ids(user_id)
    member_ids = list(dict.fromkeys(member_ids))
    cur = (
        db.spot_completions.find({"user_id": {"$in": member_ids}})
        .sort("taken_at", -1)
        .limit(int(max(1, min(200, limit))))
    )
    out = []
    async for e in cur:
        e.pop("_id", None)
        p = await db.profile.find_one(
            {"_id": e["user_id"]},
            {"full_name": 1, "name": 1, "avatar_base64": 1, "spot_points": 1},
        )
        e["player_name"] = (p or {}).get("full_name") or (p or {}).get("name") or "Anonymous"
        e["player_avatar_base64"] = (p or {}).get("avatar_base64")
        e["player_spot_points"] = int((p or {}).get("spot_points", 0))
        e["liked_by_you"] = user_id in (e.get("likes") or [])
        e["like_count"] = len(e.get("likes") or [])
        e["comment_count"] = len(e.get("comments") or [])
        e["is_self"] = e["user_id"] == user_id
        out.append(e)
    return {"entries": out, "count": len(out)}


@api_router.post("/spot/{entry_id}/like")
async def spot_like(entry_id: str, user_id: str = Depends(get_user_or_legacy)):
    e = await db.spot_completions.find_one({"id": entry_id})
    if not e:
        raise HTTPException(404, "Photo not found")
    likes = set(e.get("likes") or [])
    if user_id in likes:
        likes.remove(user_id)
    else:
        likes.add(user_id)
    await db.spot_completions.update_one({"id": entry_id}, {"$set": {"likes": list(likes)}})
    return {"like_count": len(likes), "liked_by_you": user_id in likes}


@api_router.post("/spot/{entry_id}/comment")
async def spot_comment(entry_id: str, body: SpotCommentPayload, user_id: str = Depends(get_user_or_legacy)):
    txt = (body.text or "").strip()
    if not txt:
        raise HTTPException(400, "Comment can't be empty")
    if len(txt) > 280:
        txt = txt[:280]
    e = await db.spot_completions.find_one({"id": entry_id})
    if not e:
        raise HTTPException(404, "Photo not found")
    p = await db.profile.find_one({"_id": user_id}, {"full_name": 1, "name": 1, "avatar_base64": 1})
    comment = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "user_name": (p or {}).get("full_name") or (p or {}).get("name") or "Anonymous",
        "user_avatar_base64": (p or {}).get("avatar_base64"),
        "text": txt,
        "created_at": now_iso(),
    }
    await db.spot_completions.update_one({"id": entry_id}, {"$push": {"comments": comment}})
    e2 = await db.spot_completions.find_one({"id": entry_id}, {"_id": 0, "comments": 1})
    return {"comments": (e2 or {}).get("comments", [])}


@api_router.get("/spot/{entry_id}")
async def spot_entry_detail(entry_id: str, user_id: str = Depends(get_user_or_legacy)):
    e = await db.spot_completions.find_one({"id": entry_id}, {"_id": 0})
    if not e:
        raise HTTPException(404, "Photo not found")
    p = await db.profile.find_one(
        {"_id": e["user_id"]}, {"full_name": 1, "name": 1, "avatar_base64": 1, "spot_points": 1}
    )
    e["player_name"] = (p or {}).get("full_name") or (p or {}).get("name") or "Anonymous"
    e["player_avatar_base64"] = (p or {}).get("avatar_base64")
    e["player_spot_points"] = int((p or {}).get("spot_points", 0))
    e["liked_by_you"] = user_id in (e.get("likes") or [])
    e["like_count"] = len(e.get("likes") or [])
    return e


@api_router.post("/spot/random-toggle")
async def spot_random_toggle(body: SpotRandomTogglePayload, user_id: str = Depends(get_user_or_legacy)):
    """Toggle the 'random object at random time' mode. When enabled, the
    'Play Solo' practice mode is locked client-side and the device schedules
    3 local notifications per day (handled in the frontend)."""
    await db.profile.update_one(
        {"_id": user_id}, {"$set": {"spot_random_enabled": bool(body.enabled)}}
    )
    prof = await db.profile.find_one({"_id": user_id})
    return {"spot_random_enabled": bool(body.enabled), "profile": serialize_profile(prof)}


# ════════════════════════════════════════════════════════════════════
# SPOT THE OBJECT — MULTIPLAYER LOBBY (Phase 2)
# ════════════════════════════════════════════════════════════════════
# Flow:
#   1) Host POST /api/spot/match/create with friend_ids → match status='waiting'
#   2) Each invited friend POST /api/spot/match/{id}/join (or /decline)
#   3) Host POST /api/spot/match/{id}/start → status='active', server picks
#      target_object, sets started_at + ends_at = started_at + 2 min
#   4) Players POST /api/spot/match/{id}/capture with photo_b64 — successful
#      detections increment captures[user_id]; multiple captures allowed
#      throughout the 2-minute window (per design pick #3 = B "everyone has
#      full 2 min, top scorer wins").
#   5) On any read of an active match, server lazily checks if the window
#      is over and finalizes the match — winner = player with most captures
#      (ties = no winner). Winner +5 spot_points; everyone else -1.
# Polling: clients GET /api/spot/match/{id} every ~2 seconds while in lobby
# or active to drive UI state transitions.
MATCH_DURATION_SECONDS = 120        # 2 minutes
MATCH_WINNER_REWARD = 5             # spot_points
MATCH_LOSER_PENALTY = -1
MATCH_MAX_INVITES = 7               # up to 8 players incl. host
MATCH_RECENT_WINDOW_HOURS = 24      # show finished matches for one day


class SpotMatchCreatePayload(BaseModel):
    friend_ids: List[str]


class SpotMatchCapturePayload(BaseModel):
    photo_base64: str


def _serialize_match(match: dict, viewer_id: str, profiles_by_id: dict) -> dict:
    """Trim a match doc into the shape the frontend wants. `profiles_by_id`
    is a {user_id: profile_doc} cache so we can attach `name` + `avatar`
    onto each player without a per-player Mongo round-trip."""
    captures = match.get("captures", {}) or {}
    joined = match.get("joined", []) or []
    invited = match.get("invited", []) or []
    host_id = match.get("host_id")
    # All known participants (host + invited + joined, dedup, ordered)
    all_uids: list[str] = []
    seen = set()
    for uid in [host_id] + invited + joined:
        if uid and uid not in seen:
            all_uids.append(uid)
            seen.add(uid)
    players = []
    for uid in all_uids:
        prof = profiles_by_id.get(uid) or {}
        players.append({
            "user_id": uid,
            "name": prof.get("full_name") or prof.get("name") or "Anonymous",
            "avatar_base64": prof.get("avatar_base64"),
            "is_host": uid == host_id,
            "joined": uid in joined or uid == host_id,
            "declined": uid in (match.get("declined", []) or []),
            "captures": int(captures.get(uid, 0)),
        })
    started_at = match.get("started_at")
    ends_at = match.get("ends_at")
    seconds_left = None
    if match.get("status") == "active" and ends_at:
        try:
            ends_dt = datetime.fromisoformat(ends_at.replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            seconds_left = max(0, int((ends_dt - now).total_seconds()))
        except Exception:
            seconds_left = None
    return {
        "id": match["id"],
        "host_id": host_id,
        "status": match.get("status", "waiting"),
        "target_object": match.get("target_object"),
        "started_at": started_at,
        "ends_at": ends_at,
        "finished_at": match.get("finished_at"),
        "seconds_left": seconds_left,
        "winner_id": match.get("winner_id"),
        "players": players,
        "viewer_role": (
            "host" if viewer_id == host_id
            else "joined" if viewer_id in joined
            else "invited" if viewer_id in invited
            else "spectator"
        ),
        "viewer_captures": int(captures.get(viewer_id, 0)),
        # Always include viewer_reward so the TS type stays narrow — it's
        # 0 until the match has finalized.
        "viewer_reward": int((match.get("rewards", {}) or {}).get(viewer_id, 0)),
        "created_at": match.get("created_at"),
    }


async def _finalize_match_if_due(match: dict) -> dict:
    """If a match is past its end time, settle it: pick winner, apply
    rewards/penalties to spot_points, mark status='finished'. Returns the
    (possibly updated) match document."""
    if match.get("status") != "active":
        return match
    ends_at = match.get("ends_at")
    if not ends_at:
        return match
    try:
        ends_dt = datetime.fromisoformat(ends_at.replace("Z", "+00:00"))
    except Exception:
        return match
    if datetime.now(timezone.utc) < ends_dt:
        return match
    # Time's up — settle.
    captures: dict = match.get("captures", {}) or {}
    joined = list({match.get("host_id"), *(match.get("joined") or [])})
    joined = [u for u in joined if u]
    # Find winner: highest captures, no ties.
    if joined:
        scored = [(uid, int(captures.get(uid, 0))) for uid in joined]
        scored.sort(key=lambda x: x[1], reverse=True)
        top_score = scored[0][1]
        leaders = [uid for uid, s in scored if s == top_score]
        winner_id = leaders[0] if (len(leaders) == 1 and top_score > 0) else None
    else:
        winner_id = None
    # Compute & apply rewards.
    rewards: dict = {}
    for uid in joined:
        if winner_id and uid == winner_id:
            rewards[uid] = MATCH_WINNER_REWARD
        elif winner_id:  # there IS a winner and this user isn't them
            rewards[uid] = MATCH_LOSER_PENALTY
        else:
            rewards[uid] = 0  # tie / no captures — no swing
        if rewards[uid]:
            await db.profile.update_one(
                {"_id": uid}, {"$inc": {"spot_points": rewards[uid]}}
            )
    finalized_at = now_iso()
    await db.spot_matches.update_one(
        {"id": match["id"]},
        {"$set": {
            "status": "finished",
            "winner_id": winner_id,
            "rewards": rewards,
            "finished_at": finalized_at,
        }},
    )
    match["status"] = "finished"
    match["winner_id"] = winner_id
    match["rewards"] = rewards
    match["finished_at"] = finalized_at
    return match


async def _load_profiles_cache(user_ids: list[str]) -> dict:
    """Bulk-fetch profile docs for a list of ids → {uid: doc}."""
    if not user_ids:
        return {}
    cur = db.profile.find(
        {"_id": {"$in": list(set(user_ids))}},
        {"full_name": 1, "name": 1, "avatar_base64": 1, "spot_points": 1, "last_seen_at": 1},
    )
    out = {}
    async for p in cur:
        out[p["_id"]] = p
    return out


@api_router.post("/spot/match/create")
async def spot_match_create(
    body: SpotMatchCreatePayload, user_id: str = Depends(get_user_or_legacy)
):
    """Host creates a new lobby. Match starts in status='waiting'; the
    target_object is NOT picked until the host taps Start (so anyone
    peeking at the lobby can't pre-cheat)."""
    friend_ids = [fid for fid in (body.friend_ids or []) if fid and fid != user_id]
    friend_ids = list(dict.fromkeys(friend_ids))[:MATCH_MAX_INVITES]
    if not friend_ids:
        raise HTTPException(400, "Pick at least one friend to invite.")
    # Sanity: only invite actual confirmed friends.
    confirmed = []
    for fid in friend_ids:
        rel = await db.friend_requests.find_one({
            "$or": [
                {"from_user_id": user_id, "to_user_id": fid, "status": "accepted"},
                {"from_user_id": fid, "to_user_id": user_id, "status": "accepted"},
            ]
        })
        if rel:
            confirmed.append(fid)
    if not confirmed:
        raise HTTPException(400, "No confirmed friends in the invite list.")
    match_doc = {
        "id": str(uuid.uuid4()),
        "host_id": user_id,
        "invited": confirmed,
        "joined": [user_id],   # host auto-joins
        "declined": [],
        "captures": {user_id: 0},
        "status": "waiting",
        "target_object": None,
        "started_at": None,
        "ends_at": None,
        "finished_at": None,
        "winner_id": None,
        "rewards": {},
        "created_at": now_iso(),
    }
    await db.spot_matches.insert_one(match_doc)
    profiles = await _load_profiles_cache([user_id, *confirmed])

    # Broadcast a push notification to every confirmed friend so they see
    # the invite even if they don't have the app open. Each friend gets a
    # tap-action that deep-links them straight into the lobby (the
    # 2-minute countdown begins on the host's clock at *insert* time —
    # see _match_invite_expiry_tick which auto-cancels lobbies older
    # than 120s when no one has accepted).
    #
    # DAYLIGHT-ONLY GATE: only push to friends currently inside their
    # local sunrise→sunset window. A friend in night-mode (e.g. 02:00
    # local) is silently skipped — the match still creates so the host
    # can play, but we don't wake the friend up.
    try:
        from notif_scheduler import _is_daylight_now as _scheduler_is_daylight_now  # noqa: E402
    except Exception:
        _scheduler_is_daylight_now = None
    try:
        host_name = (
            profiles.get(user_id, {}).get("full_name")
            or profiles.get(user_id, {}).get("name")
            or "A friend"
        )
        broadcast_count = 0
        skipped_night = 0
        for fid in confirmed:
            # Pull the friend's profile to check daylight. profiles cache
            # already has it from _load_profiles_cache above.
            fprof = profiles.get(fid) or await db.profile.find_one({"_id": fid}) or {}
            if _scheduler_is_daylight_now and not _scheduler_is_daylight_now(fprof):
                skipped_night += 1
                logger.info("[match.invite.skip_night] user=%s tz=%s", fid, fprof.get("timezone"))
                continue
            tokens = await db.push_tokens.find({"user_id": fid}).to_list(10)
            for t in tokens:
                tok = t.get("token")
                if not tok:
                    continue
                try:
                    await _send_expo_push(
                        tok,
                        f"🎯 {host_name} invited you to a 2-min Spot match",
                        "Tap within 2 minutes to accept and join the lobby.",
                        {
                            "kind": "spot_match_invite",
                            "match_id": match_doc["id"],
                            "deeplink": f"/spot/multiplayer/{match_doc['id']}",
                            "expires_at": (
                                datetime.now(timezone.utc) + timedelta(seconds=120)
                            ).isoformat(),
                            "channelId": "spot_surprise",
                        },
                    )
                    broadcast_count += 1
                except Exception as e:
                    logger.warning("[match.invite.push] %s: %s", fid, e)
        logger.info(
            "[match.invite.broadcast] match=%s pushed=%d skipped_night=%d",
            match_doc["id"], broadcast_count, skipped_night,
        )
    except Exception as e:
        logger.warning("[match.invite.broadcast] %s", e)

    return {"match": _serialize_match(match_doc, user_id, profiles)}


@api_router.get("/spot/match/list")
async def spot_match_list(user_id: str = Depends(get_user_or_legacy)):
    """All matches relevant to this user — open lobbies, active games,
    plus finished matches inside the last 24h so the user sees their
    recent results without us bloating the response forever."""
    cutoff_dt = datetime.now(timezone.utc) - timedelta(hours=MATCH_RECENT_WINDOW_HOURS)
    cutoff_iso = cutoff_dt.isoformat()
    cur = db.spot_matches.find({
        "$and": [
            {"$or": [
                {"host_id": user_id},
                {"invited": user_id},
                {"joined": user_id},
            ]},
            {"$or": [
                {"status": {"$in": ["waiting", "active"]}},
                {"status": "finished", "finished_at": {"$gte": cutoff_iso}},
                {"status": "cancelled", "created_at": {"$gte": cutoff_iso}},
            ]},
        ]
    }).sort("created_at", -1).limit(50)
    matches: list[dict] = []
    needs_finalize: list[dict] = []
    all_uids: set[str] = set()
    async for m in cur:
        m.pop("_id", None)
        if m.get("status") == "active":
            needs_finalize.append(m)
        matches.append(m)
        all_uids.add(m.get("host_id"))
        for u in (m.get("invited") or []):
            all_uids.add(u)
        for u in (m.get("joined") or []):
            all_uids.add(u)
    # Finalize any expired-active matches in-place
    for m in needs_finalize:
        await _finalize_match_if_due(m)
    profiles = await _load_profiles_cache([u for u in all_uids if u])
    return {"matches": [_serialize_match(m, user_id, profiles) for m in matches]}


@api_router.get("/spot/match/{match_id}")
async def spot_match_get(match_id: str, user_id: str = Depends(get_user_or_legacy)):
    m = await db.spot_matches.find_one({"id": match_id})
    if not m:
        raise HTTPException(404, "Match not found.")
    m.pop("_id", None)
    m = await _finalize_match_if_due(m)
    uids = [m.get("host_id"), *(m.get("invited") or []), *(m.get("joined") or [])]
    profiles = await _load_profiles_cache([u for u in uids if u])
    return {"match": _serialize_match(m, user_id, profiles)}


@api_router.post("/spot/match/{match_id}/join")
async def spot_match_join(match_id: str, user_id: str = Depends(get_user_or_legacy)):
    m = await db.spot_matches.find_one({"id": match_id})
    if not m:
        raise HTTPException(404, "Match not found.")
    if m.get("status") not in ("waiting", "active"):
        raise HTTPException(400, "This match has already finished.")
    if user_id != m.get("host_id") and user_id not in (m.get("invited") or []):
        raise HTTPException(403, "You weren't invited to this match.")
    await db.spot_matches.update_one(
        {"id": match_id},
        {"$addToSet": {"joined": user_id},
         "$pull": {"declined": user_id},
         "$set": {f"captures.{user_id}": (m.get("captures", {}) or {}).get(user_id, 0)}},
    )
    m = await db.spot_matches.find_one({"id": match_id})
    m.pop("_id", None)
    uids = [m.get("host_id"), *(m.get("invited") or []), *(m.get("joined") or [])]
    profiles = await _load_profiles_cache([u for u in uids if u])
    return {"match": _serialize_match(m, user_id, profiles)}


@api_router.post("/spot/match/{match_id}/decline")
async def spot_match_decline(match_id: str, user_id: str = Depends(get_user_or_legacy)):
    m = await db.spot_matches.find_one({"id": match_id})
    if not m:
        raise HTTPException(404, "Match not found.")
    if m.get("status") not in ("waiting", "active"):
        raise HTTPException(400, "This match has already finished.")
    await db.spot_matches.update_one(
        {"id": match_id},
        {"$addToSet": {"declined": user_id},
         "$pull": {"joined": user_id, "invited": user_id}},
    )
    return {"ok": True}


@api_router.post("/spot/match/{match_id}/start")
async def spot_match_start(match_id: str, user_id: str = Depends(get_user_or_legacy)):
    """Host taps Start Now → match goes active, target_object is rolled."""
    m = await db.spot_matches.find_one({"id": match_id})
    if not m:
        raise HTTPException(404, "Match not found.")
    if m.get("host_id") != user_id:
        raise HTTPException(403, "Only the host can start the match.")
    if m.get("status") != "waiting":
        raise HTTPException(400, "Match is not in a startable state.")
    if len(m.get("joined", []) or []) < 1:
        raise HTTPException(400, "At least one player must join before starting.")
    started_at = datetime.now(timezone.utc)
    ends_at = started_at + timedelta(seconds=MATCH_DURATION_SECONDS)
    target = random.choice(SPOT_OBJECTS)
    await db.spot_matches.update_one(
        {"id": match_id},
        {"$set": {
            "status": "active",
            "target_object": target,
            "started_at": started_at.isoformat(),
            "ends_at": ends_at.isoformat(),
        }},
    )
    m = await db.spot_matches.find_one({"id": match_id})
    m.pop("_id", None)
    uids = [m.get("host_id"), *(m.get("invited") or []), *(m.get("joined") or [])]
    profiles = await _load_profiles_cache([u for u in uids if u])
    return {"match": _serialize_match(m, user_id, profiles)}


@api_router.post("/spot/match/{match_id}/cancel")
async def spot_match_cancel(match_id: str, user_id: str = Depends(get_user_or_legacy)):
    m = await db.spot_matches.find_one({"id": match_id})
    if not m:
        raise HTTPException(404, "Match not found.")
    if m.get("host_id") != user_id:
        raise HTTPException(403, "Only the host can cancel the match.")
    if m.get("status") != "waiting":
        raise HTTPException(400, "Match has already started.")
    await db.spot_matches.update_one(
        {"id": match_id}, {"$set": {"status": "cancelled", "finished_at": now_iso()}}
    )
    return {"ok": True}


@api_router.post("/spot/match/{match_id}/capture")
async def spot_match_capture(
    match_id: str,
    body: SpotMatchCapturePayload,
    user_id: str = Depends(get_user_or_legacy),
):
    """Player snaps the object during an active match. We re-run vision
    against the match's locked-in target_object; on success we increment
    captures[user_id] (no upper bound — top scorer wins)."""
    if not body.photo_base64:
        raise HTTPException(400, "photo_base64 required")
    if len(body.photo_base64) > 8_000_000:
        raise HTTPException(400, "Image too large (8MB limit)")
    m = await db.spot_matches.find_one({"id": match_id})
    if not m:
        raise HTTPException(404, "Match not found.")
    m = await _finalize_match_if_due(m)
    if m.get("status") != "active":
        raise HTTPException(400, "Match is not active.")
    if user_id != m.get("host_id") and user_id not in (m.get("joined") or []):
        raise HTTPException(403, "You aren't part of this match.")
    target = m.get("target_object") or ""
    result = await _spot_vision_check(target, body.photo_base64)
    detected = bool(result.get("detected"))
    confidence = float(result.get("confidence") or 0.0)
    can_capture = detected and confidence >= 0.55
    new_count = int((m.get("captures", {}) or {}).get(user_id, 0))
    if can_capture:
        new_count += 1
        await db.spot_matches.update_one(
            {"id": match_id},
            {"$set": {f"captures.{user_id}": new_count}},
        )
    # Re-fetch + lazy finalize in case the capture pushed us past the deadline
    m = await db.spot_matches.find_one({"id": match_id})
    m.pop("_id", None)
    m = await _finalize_match_if_due(m)
    uids = [m.get("host_id"), *(m.get("invited") or []), *(m.get("joined") or [])]
    profiles = await _load_profiles_cache([u for u in uids if u])
    return {
        "detected": detected,
        "confidence": confidence,
        "can_capture": can_capture,
        "captures": new_count,
        "match": _serialize_match(m, user_id, profiles),
    }
# ════════════════════════════════════════════════════════════════════


# ------------------------------------------------------------------
# Final app wiring (must be AFTER all api_router routes are declared)
# ------------------------------------------------------------------
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()

# ════════════════════════════════════════════════════════════════════
# DIRECT MESSAGES — friend-to-friend chat with AI safety guard
# ════════════════════════════════════════════════════════════════════
PUSH_API_URL = "https://exp.host/--/api/v2/push/send"
MAX_MESSAGE_TEXT_LEN = 500


class MessageRefinePayload(BaseModel):
    text: str


class MessageImageCheckPayload(BaseModel):
    image_base64: str


class MessageSendPayload(BaseModel):
    to_user_id: str
    refined_text: str
    original_text: Optional[str] = None
    image_base64: Optional[str] = None


class MessageReadPayload(BaseModel):
    friend_id: str


class PushTokenRegisterPayload(BaseModel):
    token: str
    platform: Optional[str] = None


def _thread_key(a: str, b: str) -> str:
    return ":".join(sorted([a, b]))


async def _are_friends(a: str, b: str) -> bool:
    if not a or not b or a == b:
        return False
    rel = await db.friend_requests.find_one({
        "$or": [
            {"from_user_id": a, "to_user_id": b, "status": "accepted"},
            {"from_user_id": b, "to_user_id": a, "status": "accepted"},
        ]
    })
    return rel is not None


async def _refine_message_text(text: str) -> dict:
    """GPT-4o-mini grammar fix + safety scrubbing.
    Returns {refined, flagged, severity, reason}.
    severity: 'none'|'mild'|'severe'. severe → refined='' and admin reported."""
    if not text or not text.strip():
        return {"refined": "", "flagged": False, "severity": "none", "reason": ""}
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        api_key = os.environ.get("EMERGENT_LLM_KEY")
        if not api_key:
            return {"refined": text.strip()[:MAX_MESSAGE_TEXT_LEN], "flagged": False, "severity": "none", "reason": "no-llm-key"}
        chat = LlmChat(
            api_key=api_key,
            session_id=f"msg-refine-{uuid.uuid4().hex[:8]}",
            system_message=(
                "You are a strict but FRIENDLY message-safety + grammar editor for "
                "private chat between friends inside a self-improvement app.\n"
                "INPUT: a single draft message the user is about to send.\n"
                "TASKS:\n"
                " 1. PRESERVE the original meaning and tone — refine, don't rewrite.\n"
                " 2. Fix obvious typos and grammar.\n"
                " 3. Replace profanity / swear words with PG-rated equivalents.\n"
                " 4. Soften or remove direct threats, insults, or hate speech.\n"
                " 5. If the draft contains anything sexual/explicit/predatory, threats of "
                "violence, or self-harm encouragement → refined='' and severity='severe'.\n"
                "    Otherwise: severity='mild' if you had to censor, else 'none'.\n"
                "    flagged=true ONLY if severity='severe'.\n"
                "OUTPUT — return EXACTLY this JSON, no markdown:\n"
                '{"refined": "<cleaned message>", "flagged": true|false, "severity": "none"|"mild"|"severe", "reason": "<short>"}'
            ),
        ).with_model("openai", "gpt-4o-mini")
        msg = UserMessage(text=text[:MAX_MESSAGE_TEXT_LEN])
        response = await chat.send_message(msg)
        raw = (response or "").strip()
        import re, json as _json
        m = re.search(r"\{.*\}", raw, re.S)
        data = _json.loads(m.group(0)) if m else {}
        refined = str(data.get("refined", text)).strip()[:MAX_MESSAGE_TEXT_LEN]
        severity = str(data.get("severity", "none")).lower()
        if severity not in ("none", "mild", "severe"):
            severity = "none"
        flagged = bool(data.get("flagged", False)) or severity == "severe"
        if severity == "severe":
            refined = ""
        return {"refined": refined, "flagged": flagged, "severity": severity, "reason": str(data.get("reason", ""))[:200]}
    except Exception as e:
        return {"refined": text.strip()[:MAX_MESSAGE_TEXT_LEN], "flagged": False, "severity": "none", "reason": f"refine-fallback: {e}"}


async def _check_image_safety(image_base64: str) -> dict:
    if not image_base64:
        return {"safe": False, "severity": "severe", "reason": "no image"}
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
        api_key = os.environ.get("EMERGENT_LLM_KEY")
        if not api_key:
            return {"safe": False, "severity": "severe", "reason": "no-llm-key"}
        chat = LlmChat(
            api_key=api_key,
            session_id=f"msg-img-{uuid.uuid4().hex[:8]}",
            system_message=(
                "You review images for a friend-to-friend DM in a self-improvement app. "
                "Reject anything sexual/explicit/nude, violent/gore, hate-speech, or "
                "minors. Reply ONLY with this JSON: "
                '{"safe": true|false, "severity": "none"|"mild"|"severe", "reason": "<short>"}'
            ),
        ).with_model("openai", "gpt-4o-mini")
        msg = UserMessage(text="Is this image safe to send?", file_contents=[ImageContent(image_base64=image_base64)])
        response = await chat.send_message(msg)
        raw = (response or "").strip()
        import re, json as _json
        m = re.search(r"\{.*\}", raw, re.S)
        data = _json.loads(m.group(0)) if m else {}
        sev = str(data.get("severity", "severe")).lower()
        if sev not in ("none", "mild", "severe"):
            sev = "severe"
        return {"safe": bool(data.get("safe", False)), "severity": sev, "reason": str(data.get("reason", ""))[:200]}
    except Exception as e:
        return {"safe": False, "severity": "severe", "reason": f"check failed: {e}"}


async def _file_admin_report(reported_user_id: str, kind: str, severity: str, excerpt: str, reason: str):
    if severity != "severe":
        return
    try:
        prof = await db.profile.find_one({"_id": reported_user_id}) or {}
        user = await db.users.find_one({"_id": reported_user_id}) or {}
        await db.admin_reports.insert_one({
            "id": str(uuid.uuid4()),
            "reported_user_id": reported_user_id,
            "reported_name": prof.get("full_name") or prof.get("name") or "Anonymous",
            "reported_email": user.get("email", ""),
            "kind": kind,
            "severity": severity,
            "excerpt": (excerpt or "")[:200],
            "reason": (reason or "")[:200],
            "created_at": now_iso(),
            "viewed_at": None,
            "dismissed_at": None,
        })
    except Exception as e:
        logger.warning(f"[admin-report] failed: {e}")


async def _send_expo_push(token: str, title: str, body: str, data: dict | None = None):
    """Send a visible push notification via the Expo Push API.

    Returns {"ok": bool, "status": int|None, "body": dict|str|None, "token_valid": bool}
    so callers can diagnose failures. The payload always includes BOTH
    `title` and `body` (plus `sound`+`priority`) so iOS/Android always
    show the banner — never a silent/data-only push that the OS would
    suppress.
    """
    if not token:
        logger.warning("[push] skipped send: empty token")
        return {"ok": False, "status": None, "body": None, "token_valid": False, "reason": "empty_token"}
    # Expo tokens always start with ExponentPushToken[ or ExpoPushToken[
    valid_prefix = token.startswith("ExponentPushToken[") or token.startswith("ExpoPushToken[")
    if not valid_prefix:
        logger.warning(f"[push] invalid token format: {token[:30]}...")
        return {"ok": False, "status": None, "body": None, "token_valid": False, "reason": "bad_format"}
    try:
        import httpx
        # Allow callers to override the Android channel via data.channelId
        # (e.g. "spot_surprise" so the custom Spot notification sound plays).
        channel = "motivational"
        sound: str | dict = "default"
        if isinstance(data, dict):
            ch = (data.get("channelId") or "").strip()
            if ch:
                channel = ch
            # iOS uses an explicit sound filename — for spot surprises we
            # ship `spot_surprise.caf` (mapped from spot_surprise.mp3 in
            # the Expo plugin) which plays the Creator-supplied sound.
            if channel == "spot_surprise":
                sound = "spot_surprise.wav"
        payload = {
            "to": token,
            "title": title[:80] or "XP in real life",
            "body": body[:200] or "You have a new update",
            "sound": sound,
            "priority": "high",
            "channelId": channel,
            "data": data or {},
        }
        async with httpx.AsyncClient(timeout=8.0) as cl:
            resp = await cl.post(PUSH_API_URL, json=payload)
            try:
                body_json = resp.json()
            except Exception:
                body_json = resp.text
            # Expo returns {"data":{"status":"ok"|"error", ...}}
            inner_ok = False
            err_reason = None
            if isinstance(body_json, dict):
                d = body_json.get("data") or {}
                if isinstance(d, list) and d:
                    d = d[0]
                inner_ok = isinstance(d, dict) and d.get("status") == "ok"
                if isinstance(d, dict) and d.get("status") == "error":
                    err_reason = d.get("message") or d.get("details", {}).get("error")
            logger.info(
                f"[push] to={token[:30]}... status={resp.status_code} "
                f"ok={inner_ok} err={err_reason} body={str(body_json)[:200]}"
            )
            return {
                "ok": resp.status_code == 200 and inner_ok,
                "status": resp.status_code,
                "body": body_json,
                "token_valid": True,
                "reason": err_reason,
            }
    except Exception as e:
        logger.warning(f"[push] send failed: {e}")
        return {"ok": False, "status": None, "body": None, "token_valid": True, "reason": str(e)}


def _serialize_message(m: dict) -> dict:
    return {
        "id": m["id"],
        "from_user_id": m["from_user_id"],
        "to_user_id": m["to_user_id"],
        "text": m.get("refined_text") or "",
        "image_base64": m.get("image_base64"),
        "created_at": m.get("created_at"),
        "read_at": m.get("read_at"),
        "severity": m.get("severity", "none"),
    }


@api_router.post("/messages/refine")
async def messages_refine(body: MessageRefinePayload, user_id: str = Depends(get_user_or_legacy)):
    if not body.text:
        return {"refined": "", "flagged": False, "severity": "none", "reason": ""}
    return await _refine_message_text(body.text)


@api_router.post("/messages/check-image")
async def messages_check_image(body: MessageImageCheckPayload, user_id: str = Depends(get_user_or_legacy)):
    if not body.image_base64:
        raise HTTPException(400, "image_base64 required")
    if len(body.image_base64) > 8_000_000:
        raise HTTPException(400, "Image too large (8MB limit).")
    result = await _check_image_safety(body.image_base64)
    if not result.get("safe"):
        await _file_admin_report(user_id, "message_image", result.get("severity", "severe"), "<image>", result.get("reason", ""))
    return result


@api_router.post("/messages/send")
async def messages_send(body: MessageSendPayload, user_id: str = Depends(get_user_or_legacy)):
    if not body.to_user_id or body.to_user_id == user_id:
        raise HTTPException(400, "Invalid recipient.")
    # Admin/Creator can DM anyone, and any user can reply to an admin
    # thread even without friendship — this is the only exception to the
    # "friends only" gate. Everyone else must be friends.
    sender_is_admin = await _is_admin_user(user_id)
    recipient_is_admin = await _is_admin_user(body.to_user_id)
    if not (sender_is_admin or recipient_is_admin):
        if not await _are_friends(user_id, body.to_user_id):
            raise HTTPException(403, "You can only message friends.")
    refined = (body.refined_text or "").strip()
    image_b64 = body.image_base64 or None
    if not refined and not image_b64:
        raise HTTPException(400, "Message is empty.")
    if len(refined) > MAX_MESSAGE_TEXT_LEN:
        refined = refined[:MAX_MESSAGE_TEXT_LEN]
    severity = "none"
    if refined and not sender_is_admin:
        # Admin/Creator messages bypass the safety/refinement filter —
        # the Creator's text is trusted. /messages/refine is still
        # available so the Creator can opt-in to grammar polishing.
        check = await _refine_message_text(refined)
        refined = (check.get("refined") or refined).strip()[:MAX_MESSAGE_TEXT_LEN]
        severity = check.get("severity", "none")
        if check.get("severity") == "severe":
            await _file_admin_report(user_id, "message_text", "severe", body.original_text or refined, check.get("reason", ""))
            raise HTTPException(400, detail={"error": "blocked", "reason": "Message contains content that can't be sent. The incident has been logged."})
    if image_b64 and not sender_is_admin:
        ic = await _check_image_safety(image_b64)
        if not ic.get("safe"):
            await _file_admin_report(user_id, "message_image", ic.get("severity", "severe"), "<image>", ic.get("reason", ""))
            raise HTTPException(400, detail={"error": "image_blocked", "reason": ic.get("reason", "Image rejected.")})
    msg = {
        "id": str(uuid.uuid4()),
        "thread_id": _thread_key(user_id, body.to_user_id),
        "from_user_id": user_id,
        "to_user_id": body.to_user_id,
        "original_text": (body.original_text or "")[:1000],
        "refined_text": refined,
        "image_base64": image_b64,
        "created_at": now_iso(),
        "read_at": None,
        "severity": severity,
        "is_admin_thread": bool(sender_is_admin or recipient_is_admin),
    }
    await db.messages.insert_one(msg)
    sender_prof = await db.profile.find_one({"_id": user_id}) or {}
    sender_name = sender_prof.get("full_name") or sender_prof.get("name") or "A friend"
    if sender_is_admin:
        sender_name = ADMIN_PUBLIC_DISPLAY_NAME
    recipient_tokens = await db.push_tokens.find({"user_id": body.to_user_id}).to_list(10)
    for tok_doc in recipient_tokens:
        await _send_expo_push(
            tok_doc.get("token", ""),
            f"💬 {sender_name}",
            (refined or "📷 Sent you a photo")[:200],
            {"type": "message", "from_user_id": user_id, "message_id": msg["id"]},
        )
    return {"message": _serialize_message(msg)}


@api_router.get("/messages/threads")
async def messages_threads(user_id: str = Depends(get_user_or_legacy)):
    cur = db.friend_requests.find({
        "$or": [
            {"from_user_id": user_id, "status": "accepted"},
            {"to_user_id": user_id, "status": "accepted"},
        ]
    })
    friend_ids: set[str] = set()
    async for r in cur:
        friend_ids.add(r["from_user_id"] if r["to_user_id"] == user_id else r["to_user_id"])
    # Admin DM bypass: include any user we have an existing message
    # thread with — even if no friendship exists. This surfaces threads
    # initiated by the Creator/Admin to the recipient (and vice-versa).
    msg_partner_cur = db.messages.find(
        {"$or": [{"from_user_id": user_id}, {"to_user_id": user_id}]},
        {"from_user_id": 1, "to_user_id": 1},
    )
    async for m in msg_partner_cur:
        other = m.get("from_user_id") if m.get("to_user_id") == user_id else m.get("to_user_id")
        if other and other != user_id:
            friend_ids.add(other)
    rows = []
    for fid in friend_ids:
        thread_id = _thread_key(user_id, fid)
        last = await db.messages.find_one({"thread_id": thread_id}, sort=[("created_at", -1)])
        unread = await db.messages.count_documents({"thread_id": thread_id, "to_user_id": user_id, "read_at": None})
        prof = await db.profile.find_one({"_id": fid}) or {}
        u = await db.users.find_one({"_id": fid}, {"email": 1}) or {}
        is_admin = _is_admin_email(u.get("email"))
        rows.append({
            "friend_id": fid,
            "friend_name": (ADMIN_PUBLIC_DISPLAY_NAME if is_admin else (prof.get("full_name") or prof.get("name") or "Anonymous")),
            "friend_avatar_base64": prof.get("avatar_base64"),
            "last_message": _serialize_message(last) if last else None,
            "unread_count": int(unread),
            "is_admin_thread": bool(is_admin),
        })
    rows.sort(key=lambda r: (r["last_message"] or {}).get("created_at") or "", reverse=True)
    return {"threads": rows}


@api_router.get("/messages/thread/{friend_id}")
async def messages_thread(friend_id: str, user_id: str = Depends(get_user_or_legacy)):
    # Admin DM bypass: friendship not required if either party is admin
    sender_is_admin = await _is_admin_user(user_id)
    recipient_is_admin = await _is_admin_user(friend_id)
    if not (sender_is_admin or recipient_is_admin) and not await _are_friends(user_id, friend_id):
        raise HTTPException(403, "Not friends.")
    thread_id = _thread_key(user_id, friend_id)
    cur = db.messages.find({"thread_id": thread_id}).sort("created_at", 1).limit(500)
    items = []
    async for m in cur:
        m.pop("_id", None)
        items.append(_serialize_message(m))
    return {"messages": items}


@api_router.post("/messages/read")
async def messages_read(body: MessageReadPayload, user_id: str = Depends(get_user_or_legacy)):
    # Admin DM bypass for marking-read on admin threads
    sender_is_admin = await _is_admin_user(user_id)
    recipient_is_admin = await _is_admin_user(body.friend_id)
    if not (sender_is_admin or recipient_is_admin) and not await _are_friends(user_id, body.friend_id):
        raise HTTPException(403, "Not friends.")
    thread_id = _thread_key(user_id, body.friend_id)
    res = await db.messages.update_many(
        {"thread_id": thread_id, "to_user_id": user_id, "read_at": None},
        {"$set": {"read_at": now_iso()}},
    )
    return {"updated": int(res.modified_count)}


@api_router.get("/messages/unread-summary")
async def messages_unread_summary(user_id: str = Depends(get_user_or_legacy)):
    pipeline = [
        {"$match": {"to_user_id": user_id, "read_at": None}},
        {"$group": {"_id": "$from_user_id", "unread": {"$sum": 1}}},
    ]
    summary = {}
    async for row in db.messages.aggregate(pipeline):
        summary[row["_id"]] = int(row["unread"])
    return {"unread_by_friend": summary, "total_unread": sum(summary.values())}


@api_router.post("/push/register-token")
async def push_register_token(body: PushTokenRegisterPayload, user_id: str = Depends(get_user_or_legacy)):
    print(
        f"[push/register-token] HIT user_id={user_id} "
        f"token_prefix={(body.token or '')[:30]!r} "
        f"platform={body.platform!r}",
        flush=True,
    )
    logger.info(
        "[push/register-token] user_id=%s platform=%s token_prefix=%s",
        user_id, body.platform, (body.token or "")[:30],
    )
    if not body.token:
        print(f"[push/register-token] REJECT user_id={user_id} reason=empty_token", flush=True)
        raise HTTPException(400, "token required")
    res = await db.push_tokens.update_one(
        {"user_id": user_id, "token": body.token},
        {"$set": {
            "user_id": user_id,
            "token": body.token,
            "platform": body.platform or "unknown",
            "updated_at": now_iso(),
        }},
        upsert=True,
    )
    print(
        f"[push/register-token] OK user_id={user_id} "
        f"matched={res.matched_count} modified={res.modified_count} "
        f"upserted_id={res.upserted_id}",
        flush=True,
    )
    return {"ok": True, "matched": res.matched_count, "modified": res.modified_count, "upserted": bool(res.upserted_id)}


# ── Client-side crash audit (Health Connect) ─────────────────────
# Receives error reports from the Samsung Health "Connect" button
# when the native Health Connect handshake fails. We log them loudly
# to stdout AND persist to MongoDB so the developer can diagnose even
# without direct logcat access to the user's device.
class HealthConnectErrorPayload(BaseModel):
    stage: str            # e.g. "availability", "initialize", "requestPermission", "onConnect_catch"
    message: Optional[str] = None
    error_name: Optional[str] = None
    platform: Optional[str] = None
    os_version: Optional[str] = None
    device: Optional[str] = None
    app_version: Optional[str] = None
    extra: Optional[dict] = None


@api_router.post("/debug/health-connect-error")
async def debug_health_connect_error(
    body: HealthConnectErrorPayload,
    user_id: str = Depends(get_user_or_legacy),
):
    now = now_iso()
    print(
        f"[HC-ERROR] user_id={user_id} stage={body.stage!r} "
        f"msg={(body.message or '')[:200]!r} platform={body.platform!r} "
        f"os={body.os_version!r} device={body.device!r} app_v={body.app_version!r}",
        flush=True,
    )
    logger.warning(
        "[HC-ERROR] uid=%s stage=%s msg=%s", user_id, body.stage, body.message,
    )
    await db.health_connect_errors.insert_one({
        "user_id": user_id,
        "stage": body.stage,
        "message": body.message,
        "error_name": body.error_name,
        "platform": body.platform,
        "os_version": body.os_version,
        "device": body.device,
        "app_version": body.app_version,
        "extra": body.extra or {},
        "created_at": now,
    })
    return {"ok": True}


# ══════════════ Build Self-Confidence mini-app ══════════════════════
# A new Library+ mini-app with four tracks:
#   1) Social Speaking — daily speaking challenge + tips
#   2) Physical Appearance — daily posture/movement challenge
#   3) Dress with Confidence — AI photo coach (GPT-4o Vision) + weather
#   4) Gratitude / Affirmations — daily prompt + positive statements
#
# Each track rotates a curated challenge per day so the user gets a
# fresh prompt without repetition. Completions land in
# `db.confidence_completions` and award a small XP nudge.

CONFIDENCE_SOCIAL_CHALLENGES = [
    {
        "title": "Compliment a Stranger's Outfit",
        "body": "Pay one genuine compliment to someone you don't know today — a barista, a classmate, a colleague. Keep it specific: 'That jacket suits you' beats 'You look nice'.",
        "tips": [
            "Lead with a smile so the compliment feels warm.",
            "Be specific — mention the colour, the fit or the style.",
            "Walk away after they thank you; don't hover for a reaction.",
        ],
        "examples": [
            "\"Those shoes are clean — where'd you get them?\"",
            "\"Great colour on that jumper, really suits you.\"",
            "\"I love how you styled that shirt.\"",
        ],
    },
    {
        "title": "Ask a Question in Public",
        "body": "Ask a cashier, a librarian or a coffee shop worker a real, non-transactional question today. 'What's your favourite thing on the menu?' counts.",
        "tips": [
            "Eye contact, then the question. Not a mumble downward.",
            "Listen for 3 seconds after they answer — that's where the warmth lives.",
        ],
        "examples": [
            "\"What's the most-loved drink you guys make?\"",
            "\"What book would you recommend to someone who reads zero books?\"",
            "\"Have you worked here long?\"",
        ],
    },
    {
        "title": "Speak Up in a Group",
        "body": "In any group conversation today, share one opinion you'd normally keep to yourself. Even if it's small. Just voice it.",
        "tips": [
            "Don't open with 'this is probably stupid but…' — just say the thing.",
            "Short sentences. Confidence isn't length, it's conviction.",
        ],
        "examples": [
            "\"I actually disagree — I think the first option is better because…\"",
            "\"I liked that movie.\" (and don't apologise for it)",
        ],
    },
    {
        "title": "Make Eye Contact for 3 Seconds",
        "body": "In every conversation today, hold eye contact for at least three full seconds before breaking. Practice this with every person you speak to.",
        "tips": [
            "Aim between the eyes if direct contact feels too intense.",
            "Blink naturally — no staring contest.",
        ],
        "examples": [
            "Cashier hands you your change → 3 seconds + 'thanks'.",
            "Coworker asks how your day is → 3 seconds + real answer.",
        ],
    },
    {
        "title": "Say Someone's Name",
        "body": "Use the name of every person you talk to today at least once. Baristas, colleagues, the delivery driver. Names unlock warmth.",
        "tips": [
            "Read name-tags. 'Thanks, Maria.' is instant rapport.",
            "If you forget a name, ask. 'Sorry, remind me?' is never awkward.",
        ],
        "examples": [
            "\"Good one, Marcus.\"",
            "\"Thanks for that, Aisha.\"",
            "\"How was your weekend, Tom?\"",
        ],
    },
    {
        "title": "Start a Conversation with One Question",
        "body": "Initiate ONE conversation today with someone you don't know well. A neighbour, a gym regular, a co-worker on another team. One open question gets it started.",
        "tips": [
            "'How's your day been?' almost always works.",
            "Follow-up matters more than the opener. Ask a second question.",
        ],
        "examples": [
            "\"What brings you here today?\"",
            "\"Have you tried the [thing nearby] yet?\"",
            "\"How long have you lived around here?\"",
        ],
    },
    {
        "title": "Tell a Short Story",
        "body": "In one conversation today, tell a 60-second story from your week. Not a list of facts — a story with a beginning, a middle, and a small point.",
        "tips": [
            "Start with a hook: 'So the weirdest thing happened to me yesterday…'",
            "Land it. End with 'and that's why I now…' or a punchline.",
        ],
        "examples": [
            "The time you got on the wrong bus.",
            "The argument you had with a self-checkout machine.",
        ],
    },
    {
        "title": "Accept a Compliment Cleanly",
        "body": "If anyone compliments you today, say 'thank you' and nothing else. No deflecting, no downplaying, no 'oh this old thing'.",
        "tips": [
            "Accepting a compliment is a skill. It tells your brain you deserve it.",
            "A smile + 'thank you' is a complete answer. Full stop.",
        ],
        "examples": [
            "\"That's kind of you — thank you.\"",
            "Just: \"Thank you.\"",
        ],
    },
    {
        "title": "Ask for Someone's Recommendation",
        "body": "Ask one person for a recommendation today — a show, a book, a restaurant. People LOVE to recommend. It's instant connection.",
        "tips": [
            "Ask one follow-up: 'Why that one?'",
            "Actually try their recommendation and report back another day.",
        ],
        "examples": [
            "\"What's a show I should be watching right now?\"",
            "\"If I only ever tried one thing on this menu, what would it be?\"",
        ],
    },
    {
        "title": "Disagree Politely With Someone",
        "body": "Practice respectful disagreement today. Not aggression — just standing by your view. 'I see it differently. Here's why…' builds real self-respect.",
        "tips": [
            "Acknowledge first: 'I hear you, but I actually think…'",
            "Disagree with the idea, not the person.",
        ],
        "examples": [
            "\"Interesting — I actually think the opposite, because…\"",
            "\"Respectfully, I'd push back on that.\"",
        ],
    },
    {
        "title": "Pause Before You Answer",
        "body": "Today, pause 2 whole seconds before answering any question. No rushing, no filler words. Silence reads as confidence.",
        "tips": [
            "'Hmm' is not a pause. Real silence is.",
            "Your answer comes out cleaner, too.",
        ],
        "examples": [
            "\"What are you doing this weekend?\" → (pause) → \"Actually, I'm…\"",
        ],
    },
    {
        "title": "Compliment a Friend's Character",
        "body": "Compliment one friend today on who they are, not what they did. 'You're so dependable' lands deeper than 'thanks for the ride'.",
        "tips": [
            "Specific traits > generic. 'You're really loyal' > 'You're great'.",
            "Say it out loud. Not a text message.",
        ],
        "examples": [
            "\"You're one of the funniest people I know.\"",
            "\"I admire how calm you stay under pressure.\"",
        ],
    },
    {
        "title": "Speak Slightly Louder",
        "body": "All day today, speak 10% louder than you normally would. Not shouting — just clearer. It forces your body to own the space.",
        "tips": [
            "Project from your chest, not your throat.",
            "If someone looks at you when you talk, you nailed it.",
        ],
        "examples": [
            "Order your coffee at 10% volume.",
            "Say 'good morning' at 10% volume.",
        ],
    },
    {
        "title": "End a Conversation Confidently",
        "body": "Practice ending a conversation cleanly today. 'Hey, I've gotta run — great to chat.' No awkward trailing off. You decide when you leave.",
        "tips": [
            "A clean exit beats a mumbled 'anyway…' every time.",
            "Smile. Walk. Don't look back.",
        ],
        "examples": [
            "\"This was great — I'll catch up with you soon.\"",
            "\"Okay, I'm off. Have a good one!\"",
        ],
    },
    {
        "title": "Ask for What You Want",
        "body": "Ask directly for ONE thing you want today. A discount, an extra sauce, a different seat, a favour. No apologies, no 'sorry to bother you'.",
        "tips": [
            "'Could I…' is confident. 'Sorry, would it be possible to maybe…' is not.",
            "The worst they say is no — and that's still a clean outcome.",
        ],
        "examples": [
            "\"Could I swap this for a window seat?\"",
            "\"Any chance of a student discount?\"",
        ],
    },
]

CONFIDENCE_PHYSICAL_CHALLENGES = [
    {
        "title": "Walk Tall — Eyes on the Horizon",
        "body": "Every time you walk today, look 15 metres ahead — not down at your phone or your feet. Chin parallel to the ground, shoulders back.",
        "tips": [
            "Pretend there's a string pulling the top of your head up.",
            "Pick a distant point and walk toward it.",
        ],
        "drills": [
            "3 laps around your block, eyes forward.",
            "Supermarket trip — phone in pocket the whole time.",
        ],
    },
    {
        "title": "The Shoulder Reset",
        "body": "Every hour today, do the shoulder reset: pull shoulders up to ears, back, then down. Hold 5 seconds. It undoes hunching from screens.",
        "tips": [
            "Set an hourly phone reminder.",
            "Your back should feel slightly stretched each time.",
        ],
        "drills": ["10 reps per hour for 8 waking hours = 80 reps."],
    },
    {
        "title": "50 Push-ups (Break 'Em Up)",
        "body": "50 push-ups total by end of day. Break them into any number of sets. Knees down is fine. Form > ego.",
        "tips": [
            "Keep a flat back — no sagging hips.",
            "Full range of motion. Chest to floor.",
        ],
        "drills": ["5 × 10 spread through the day works great."],
    },
    {
        "title": "Plank — 3 Holds",
        "body": "Hold a plank 3 times today. Aim for 30-60 seconds each. Core strength = posture = presence.",
        "tips": [
            "Straight line from heels to head.",
            "Squeeze your glutes the whole time — it protects your lower back.",
        ],
        "drills": ["Morning, midday, evening."],
    },
    {
        "title": "Walk 6,000+ Steps",
        "body": "Hit 6,000 steps today. Break it into two walks if needed. Fresh air + motion = confidence shift.",
        "tips": [
            "Count a lunch walk as your commute.",
            "Leave the earphones out for one of them. Notice the world.",
        ],
        "drills": ["Use your phone's step counter or Health Connect."],
    },
    {
        "title": "Mirror Posture Check — 5 times",
        "body": "Catch yourself in any mirror today and reset your posture: chin up, shoulders back, belly pulled in slightly. Do it 5 times throughout the day.",
        "tips": [
            "Don't judge the reflection — just correct the posture and move on.",
            "Each reset trains muscle memory.",
        ],
        "drills": ["Bathroom mirror, shop windows, phone front-camera."],
    },
    {
        "title": "30 Squats",
        "body": "Do 30 bodyweight squats at any point today. Quads and glutes are posture muscles — stronger legs = stronger stance.",
        "tips": [
            "Knees tracking over toes.",
            "Chest tall, don't collapse forward.",
        ],
        "drills": ["2 × 15 works. Or 3 × 10."],
    },
    {
        "title": "5-Minute Stretch Flow",
        "body": "Five minutes of stretching today. Focus on chest, hip flexors and hamstrings — the areas that get locked from sitting.",
        "tips": [
            "Doorframe chest stretch: 30 seconds each side.",
            "Couch stretch for hip flexors: 60 seconds each leg.",
        ],
        "drills": ["First thing after waking, or right before bed."],
    },
    {
        "title": "Power-Pose Before Something Intimidating",
        "body": "Before any intimidating thing today — a meeting, a call, a workout — stand feet wide, hands on hips, chin up for 60 seconds. Yes, it actually works.",
        "tips": [
            "Do it in the bathroom if it feels weird.",
            "Breathe deep — slow in, slow out.",
        ],
        "drills": ["Aim for at least one power-pose today."],
    },
    {
        "title": "Drink 2 Litres of Water",
        "body": "Hydration = skin quality + energy = confidence by the afternoon. 2L today.",
        "tips": [
            "Big bottle on your desk. Refill when empty.",
            "One glass before every meal is an easy win.",
        ],
        "drills": ["Fill a 1L bottle twice. Done."],
    },
    {
        "title": "No Slouching While Sitting",
        "body": "Every time you sit today — desk, couch, car — make sure your spine is tall. If your phone or laptop forces you to hunch, raise it.",
        "tips": [
            "Laptop at eye level. Phone at eye level.",
            "If your chair forces a slouch, swap chairs.",
        ],
        "drills": ["Every 20 minutes: check your back against the chair."],
    },
    {
        "title": "Go Outside for 20 Minutes",
        "body": "20 minutes outdoors today, phone-free if possible. Sunlight + movement + perspective. Nothing builds presence faster.",
        "tips": [
            "Morning sun hits different. It sets your circadian rhythm.",
            "Wear something you feel good in — even just for a walk.",
        ],
        "drills": ["Morning coffee outside. Evening walk after dinner."],
    },
    {
        "title": "Walk Without Your Phone — 10 Minutes",
        "body": "Leave the phone behind for one 10-minute walk today. Just you, your breath and the world. Phones destroy posture and presence.",
        "tips": [
            "Around the block after dinner works perfectly.",
            "Notice 3 things you've never noticed before.",
        ],
        "drills": ["One 10-minute phone-free walk."],
    },
    {
        "title": "Breath Work — 4-7-8 × 4 rounds",
        "body": "Practice the 4-7-8 breath today: inhale 4 seconds, hold 7, exhale 8. Four full rounds. Drops your heart rate and gives you a grounded, calm presence.",
        "tips": [
            "Nose in, mouth out.",
            "If you're new, start 3-5-7 and build up.",
        ],
        "drills": ["Morning. Before bed. Before anything stressful."],
    },
    {
        "title": "Walk a Little Slower",
        "body": "All day today, walk 10% slower than usual. Rushed walking reads as nervous. Slower, deliberate steps read as grounded.",
        "tips": [
            "Longer strides, heel to toe.",
            "You'll still arrive on time. Try it.",
        ],
        "drills": ["Commute. Grocery store. Any corridor."],
    },
]

CONFIDENCE_GRATITUDE_PROMPTS = [
    {
        "title": "Three Things You're Grateful For",
        "body": "Write 3 specific things you're grateful for today. Specific, not generic. 'My morning coffee' beats 'health'.",
        "affirmation": "I have more than I realise. I am taken care of.",
    },
    {
        "title": "Speak Truth Over Yourself",
        "body": "Say these out loud, slowly: \"I am loved. I am smart. I am unique. I am worthy of good things. I am growing every day.\"",
        "affirmation": "My words shape my mind. I choose words that build me up.",
    },
    {
        "title": "One Thing You Did Well Yesterday",
        "body": "Write ONE thing you did well yesterday — however small. Made your bed? That counts. Held a difficult conversation? That counts more.",
        "affirmation": "I'm allowed to be proud of my small wins.",
    },
    {
        "title": "Someone Who Loves You",
        "body": "Name one person who loves you. Write WHY they love you. You're not imagining it — they genuinely do. Let that sink in.",
        "affirmation": "I am someone worth loving.",
    },
    {
        "title": "A Compliment You Received",
        "body": "Recall a compliment someone gave you recently. Write it out. Believe it — they saw something real.",
        "affirmation": "When others see good in me, I trust their eyes.",
    },
    {
        "title": "Your Unique Strength",
        "body": "Name one strength ONLY you have in your current group of friends or colleagues. The one thing you bring that they don't.",
        "affirmation": "My strengths are needed. I bring value no one else can.",
    },
    {
        "title": "A Small Joy Today",
        "body": "Point to one small joy already in your day — a song, a taste, a warm feeling. Let it count.",
        "affirmation": "Joy isn't rare. I just have to notice it.",
    },
    {
        "title": "A Battle You've Survived",
        "body": "Name one hard season you've already survived. Write one sentence about how it made you stronger.",
        "affirmation": "I've been through worse and I'm still here. I'm resilient.",
    },
    {
        "title": "Something You Handled Well",
        "body": "Describe one thing you handled well this week. However small. Pay yourself the credit you'd pay a friend.",
        "affirmation": "I'm capable. I'm proving it every day.",
    },
    {
        "title": "Let Go of One Heavy Thing",
        "body": "Name one thing weighing on your mind. Write it down, then write: 'I release this for today.' You can pick it up tomorrow if you must.",
        "affirmation": "I'm not obligated to carry everything all at once.",
    },
    {
        "title": "Your Body Did a Good Thing",
        "body": "Your body woke up, breathed, moved you through the day. Thank one specific part of it. Your legs for walking. Your hands for holding.",
        "affirmation": "My body is on my team. I appreciate it.",
    },
    {
        "title": "Who You're Becoming",
        "body": "Write one sentence describing who you're BECOMING — not who you are right now. That future person is already showing up.",
        "affirmation": "I'm becoming the person I want to be, step by step.",
    },
    {
        "title": "Three Words About You",
        "body": "List 3 adjectives that describe the BEST version of you. Read them back. Out loud. Mean them.",
        "affirmation": "These words are mine. I own them.",
    },
    {
        "title": "A Tiny Miracle",
        "body": "Describe one thing today that, if you really thought about it, is actually a small miracle. Coffee. A warm shower. The sunrise.",
        "affirmation": "Ordinary moments are full of wonder when I pay attention.",
    },
    {
        "title": "Kindness You Received",
        "body": "Recall one act of kindness someone showed you recently. Name the person. Thank them silently (or actually).",
        "affirmation": "I am surrounded by kindness. I notice it more each day.",
    },
]


def _today_index(n: int, offset: int = 0) -> int:
    """Rotate a challenge list by day-of-year so every user sees the
    same content on the same calendar day, and the list cycles without
    repetition inside a single rotation window."""
    today = datetime.utcnow().date()
    return (today.toordinal() + offset) % n


@api_router.get("/confidence/daily")
async def confidence_daily(user_id: str = Depends(get_user_or_legacy)):
    """Return today's challenge for each non-AI track + the user's
    completion status for today. The frontend uses this to paint the
    landing page of the mini-app."""
    social = CONFIDENCE_SOCIAL_CHALLENGES[_today_index(len(CONFIDENCE_SOCIAL_CHALLENGES))]
    physical = CONFIDENCE_PHYSICAL_CHALLENGES[_today_index(len(CONFIDENCE_PHYSICAL_CHALLENGES), 3)]
    gratitude = CONFIDENCE_GRATITUDE_PROMPTS[_today_index(len(CONFIDENCE_GRATITUDE_PROMPTS), 7)]
    today = datetime.utcnow().date().isoformat()
    done = await db.confidence_completions.find(
        {"user_id": user_id, "date": today},
        {"_id": 0, "track": 1},
    ).to_list(10)
    done_tracks = {d.get("track") for d in done}
    return {
        "date": today,
        "social": {**social, "track": "social", "done": "social" in done_tracks},
        "physical": {**physical, "track": "physical", "done": "physical" in done_tracks},
        "gratitude": {**gratitude, "track": "gratitude", "done": "gratitude" in done_tracks},
    }


class ConfidenceCompletePayload(BaseModel):
    track: Literal["social", "physical", "gratitude", "dress"]
    note: Optional[str] = None


@api_router.post("/confidence/complete")
async def confidence_complete(
    body: ConfidenceCompletePayload,
    user_id: str = Depends(get_user_or_legacy),
):
    """Mark a daily confidence challenge as done for today. Idempotent:
    a second POST for the same track on the same day is a no-op. Awards
    +15 XP per completion (small nudge, but it adds up to ~60 XP/day if
    you hit all four tracks)."""
    today = datetime.utcnow().date().isoformat()
    existing = await db.confidence_completions.find_one(
        {"user_id": user_id, "date": today, "track": body.track}
    )
    if existing:
        return {"ok": True, "already_done": True}
    await db.confidence_completions.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "date": today,
        "track": body.track,
        "note": (body.note or "")[:500],
        "created_at": now_iso(),
    })
    # Tiny XP nudge — 15 per completion. 4 tracks = 60 XP for the day.
    try:
        xp_gain = 15
        await db.profile.update_one(
            {"_id": user_id},
            {"$inc": {"total_xp": xp_gain}},
        )
        tz_off = int((await db.profile.find_one({"_id": user_id}, {"tz_offset_minutes": 1}) or {}).get("tz_offset_minutes", 0) or 0)
        await _log_xp_event(user_id, xp_gain, tz_off)
        # Confidence track completion → keep streak alive AND show on
        # the Progress-tab charts (was previously invisible there).
        await _bump_streak_for_xp(user_id)
        await _log_xp_to_charts(
            user_id, xp_gain, source="confidence_track", focus_area="mindset",
        )
    except Exception as e:
        logger.warning("[confidence] XP award failed: %s", e)
    return {"ok": True, "already_done": False, "xp_awarded": 15}


# ── Dress with Confidence — AI outfit coach ───────────────────────
class DressAdvicePayload(BaseModel):
    photo_base64: Optional[str] = None      # optional selfie of the outfit
    message: str                             # the user's question
    event_context: Optional[str] = None      # e.g. "party", "office", "outside walk"
    weather_hint: Optional[str] = None       # e.g. "15°C, light rain"
    history: Optional[List[dict]] = None  # [{role, content}] for multi-turn


@api_router.post("/confidence/dress-advice")
async def confidence_dress_advice(
    body: DressAdvicePayload,
    user_id: str = Depends(get_user_or_legacy),
):
    """A warm, positive AI stylist that reads a user's selfie of their
    outfit and answers questions like 'is this good for a party?' Its
    JOB is to remove doubt, not amplify it. It compliments specifically,
    explains style, and flags weather/event practicalities.

    We use GPT-4o-mini (cheap + fast) via emergentintegrations with the
    Emergent LLM key. Photo is downscaled to 640 px for speed.
    """
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
    except Exception as e:
        raise HTTPException(503, f"AI not available: {e}")
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(503, "No LLM key configured")

    system = (
        "You are a warm, encouraging personal-style coach helping someone "
        "feel confident about what they're wearing. Your #1 job is to "
        "REMOVE DOUBT, not create it. Be genuine — don't flatter empty "
        "compliments — but be firmly on their side.\n\n"
        "RULES:\n"
        "- If a photo is attached, start with ONE specific compliment about "
        "the outfit (colour, cut, fit, or vibe) before answering.\n"
        "- If they ask 'is this good for X event', describe the style of the "
        "outfit in one short line, then give a confident YES / YES WITH ONE "
        "TWEAK / CONSIDER ONE SWAP verdict.\n"
        "- If event_context is 'outside' or 'party' or 'office', factor that "
        "in. If weather_hint is present, mention it practically (bring a "
        "jacket, layer up, etc).\n"
        "- Keep the whole reply under 120 words. No lists unless asked.\n"
        "- NEVER say 'this won't look good' or 'you should change'. Always "
        "frame as 'try swapping X for Y' or 'add Z to elevate it'.\n"
        "- End with a one-line confidence booster.\n"
        f"\nEvent context: {body.event_context or 'not specified'}"
        f"\nWeather context: {body.weather_hint or 'not provided'}"
    )

    chat = LlmChat(
        api_key=api_key,
        session_id=f"dress-{user_id[:8]}-{uuid.uuid4().hex[:6]}",
        system_message=system,
    ).with_model("openai", "gpt-4o-mini")

    # Feed prior turns so the coach remembers what's been discussed.
    for turn in (body.history or [])[-6:]:  # cap to last 6 for latency
        role = (turn.get("role") or "").lower()
        content = turn.get("content") or ""
        if not content:
            continue
        if role == "user":
            await chat.send_message(UserMessage(text=content))

    # Attach photo if present — downscaled for speed.
    file_contents = []
    if body.photo_base64:
        small = _downscale_image_b64(body.photo_base64, max_dim=640, quality=80)
        file_contents.append(ImageContent(image_base64=small))
    try:
        response = await chat.send_message(UserMessage(
            text=body.message,
            file_contents=file_contents if file_contents else None,
        ))
    except Exception as e:
        raise HTTPException(502, f"AI error: {e}")
    reply = (response or "").strip()

    # Persist to history — store a small thumbnail (max 320px) so
    # the user can scroll back through past outfits without blowing
    # up DB size. We only save when there's a photo attached since
    # pure-text chats aren't that useful to replay.
    entry_id = str(uuid.uuid4())
    try:
        thumb = None
        if body.photo_base64:
            thumb = _downscale_image_b64(body.photo_base64, max_dim=320, quality=70)
        await db.confidence_dress_history.insert_one({
            "id": entry_id,
            "user_id": user_id,
            "message": (body.message or "")[:500],
            "reply": reply[:2000],
            "event_context": (body.event_context or "")[:80],
            "weather_hint": (body.weather_hint or "")[:80],
            "thumbnail_base64": thumb,
            "has_photo": bool(body.photo_base64),
            "created_at": now_iso(),
        })
    except Exception as e:
        logger.warning("[dress] history save failed: %s", e)

    return {"reply": reply, "entry_id": entry_id}


@api_router.get("/confidence/dress-history")
async def confidence_dress_history(
    limit: int = 30,
    user_id: str = Depends(get_user_or_legacy),
):
    """Return the user's recent 'Dress with confidence' conversations,
    newest first. Each entry carries a thumbnail + the original message
    + the AI's reply so the UI can render a gallery/scroll view.
    """
    limit = max(1, min(100, int(limit)))
    rows = await db.confidence_dress_history.find(
        {"user_id": user_id},
        {"_id": 0, "user_id": 0},
    ).sort("created_at", -1).to_list(limit)
    return {"items": rows}


@api_router.delete("/confidence/dress-history/{entry_id}")
async def confidence_dress_history_delete(
    entry_id: str,
    user_id: str = Depends(get_user_or_legacy),
):
    """Delete a single outfit-advice history entry. Users appreciate being
    able to remove selfies they no longer want stored."""
    res = await db.confidence_dress_history.delete_one({"id": entry_id, "user_id": user_id})
    return {"deleted": res.deleted_count}


@api_router.get("/confidence/weather")
async def confidence_weather(lat: float, lon: float):
    """Thin wrapper over open-meteo (no API key needed) — returns a
    compact weather snapshot the stylist can use. Purposely minimal so
    we don't require a third-party key to ship this feature."""
    try:
        import httpx
        url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            "&current=temperature_2m,precipitation,wind_speed_10m,weather_code"
            "&timezone=auto"
        )
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            data = r.json()
        cur = (data or {}).get("current") or {}
        temp = cur.get("temperature_2m")
        precip = cur.get("precipitation")
        wind = cur.get("wind_speed_10m")
        code = cur.get("weather_code")
        # Turn the numeric weather code into a short string.
        code_map = {
            0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
            45: "foggy", 48: "foggy",
            51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
            61: "light rain", 63: "rain", 65: "heavy rain",
            71: "light snow", 73: "snow", 75: "heavy snow",
            80: "rain showers", 81: "rain showers", 82: "heavy showers",
            95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm",
        }
        condition = code_map.get(int(code or -1), "unknown")
        hint_bits = [f"{temp}°C" if temp is not None else "", condition]
        if (precip or 0) > 0.1:
            hint_bits.append(f"rain {precip}mm")
        if (wind or 0) >= 8:
            hint_bits.append(f"windy ({wind} km/h)")
        return {
            "temperature_c": temp,
            "condition": condition,
            "precipitation_mm": precip,
            "wind_kmh": wind,
            "hint": ", ".join([b for b in hint_bits if b]),
        }
    except Exception as e:
        raise HTTPException(502, f"weather unavailable: {e}")



#    receiving notifications). Returns the caller's registered token(s),
#    platform, last update time. If the list is empty, the device has
#    never successfully registered — that alone explains why no push
#    has ever been delivered to this profile. The `debug_send` flag
#    triggers a live test push so you can confirm delivery end-to-end.
@api_router.get("/push/status")
async def push_status(debug_send: bool = False, user_id: str = Depends(get_user_or_legacy)):
    tokens = await db.push_tokens.find(
        {"user_id": user_id},
        {"_id": 0, "token": 1, "platform": 1, "updated_at": 1},
    ).to_list(20)
    send_results: list = []
    if debug_send and tokens:
        for t in tokens:
            r = await _send_expo_push(
                t.get("token", ""),
                "🔔 XP in real life",
                "Push notification test — you should see this banner.",
                {"type": "test"},
            )
            send_results.append({
                "token_prefix": (t.get("token", "") or "")[:25],
                "platform": t.get("platform"),
                **r,
            })
    return {
        "user_id": user_id,
        "registered_tokens": len(tokens),
        "tokens": [{
            "token_prefix": (t.get("token", "") or "")[:25] + "...",
            "platform": t.get("platform"),
            "updated_at": t.get("updated_at"),
        } for t in tokens],
        "debug_send_results": send_results if debug_send else None,
    }


# ───────────────── Admin reports (Creator only) ─────────────────
@api_router.get("/admin/reports")
async def admin_reports_list(user_id: str = Depends(get_user_or_legacy)):
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Admin only.")
    cur = db.admin_reports.find({"dismissed_at": None}).sort("created_at", -1).limit(200)
    items = []
    new_count = 0
    async for r in cur:
        r.pop("_id", None)
        if not r.get("viewed_at"):
            new_count += 1
        items.append(r)
    return {"reports": items, "new_count": new_count}


@api_router.post("/admin/reports/{report_id}/view")
async def admin_reports_view(report_id: str, user_id: str = Depends(get_user_or_legacy)):
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Admin only.")
    await db.admin_reports.update_one(
        {"id": report_id}, {"$set": {"viewed_at": now_iso()}}
    )
    return {"ok": True}


@api_router.post("/admin/reports/{report_id}/dismiss")
async def admin_reports_dismiss(report_id: str, user_id: str = Depends(get_user_or_legacy)):
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Admin only.")
    await db.admin_reports.update_one(
        {"id": report_id}, {"$set": {"dismissed_at": now_iso()}}
    )
    return {"ok": True}
# ════════════════════════════════════════════════════════════════════



@app.on_event("startup")
async def _seed_admin_account():
    """Idempotently create the Creator/Admin account so its credentials always
    work. Existing password is preserved if the user has changed it via the
    forgot-password flow."""
    try:
        for email_lower in ADMIN_EMAILS:
            existing = await db.users.find_one({"email": email_lower})
            if existing:
                # Make sure the email is verified so the user can log in.
                if not existing.get("email_verified"):
                    await db.users.update_one(
                        {"_id": existing["_id"]},
                        {"$set": {"email_verified": True}},
                    )
                # Backfill profile so the admin lands directly on home (no onboarding loop).
                await db.profile.update_one(
                    {"_id": existing["_id"]},
                    {"$set": {
                        "onboarding_complete": True,
                        "morning_setup_done": True,
                        "onboarding_tz_done": True,
                        "day_start_time": "07:00",
                        "timezone": "Australia/Sydney",
                        "boosts_unlocked": True,
                    }},
                    upsert=False,
                )
                continue
            user_id = str(uuid.uuid4())
            now = now_iso()
            await db.users.insert_one({
                "_id": user_id,
                "email": email_lower,
                "password_hash": hash_password(ADMIN_DEFAULT_PASSWORD),
                "email_verified": True,
                "created_at": now,
            })
            # Profile auto-creates on first login; pre-seed a basic one so
            # the admin badge surfaces immediately.
            await db.profile.insert_one({
                "_id": user_id,
                "name": ADMIN_DEFAULT_NAME,
                "full_name": ADMIN_DEFAULT_NAME,
                "level": 1,
                "total_xp": 0,
                "current_streak": 0,
                "best_streak": 0,
                "tasks_completed": 0,
                "goals_completed": 0,
                "bio": "",
                "avatar_base64": None,
                "wake_time": "07:00",
                "morning_setup_done": True,
                "day_start_time": "07:00",
                "timezone": "Australia/Sydney",
                "onboarding_tz_done": True,
                "onboarding_complete": True,
                "spot_points": 0,
                "spot_random_enabled": False,
                "boosts_unlocked": True,
                "boost_inventory": [],
                "created_at": now,
            })
            logger.info(f"[admin-seed] Created Creator account: {email_lower}")
    except Exception as e:
        logger.warning(f"[admin-seed] failed: {e}")


@app.on_event("startup")
async def _backfill_onboarding_tz_done_flag():
    """One-time idempotent migration: any profile that already has BOTH
    `timezone` and `day_start_time` populated should be considered as
    having completed the day-anchor onboarding. This guarantees that
    after an app update, returning users with the data already on file
    are NEVER re-prompted to choose timezone / morning start time again,
    even if they pre-date the `onboarding_tz_done` flag.

    Cheap to run on every startup — the filter excludes anything that
    is already correctly flagged."""
    try:
        result = await db.profile.update_many(
            {
                "timezone": {"$exists": True, "$nin": [None, ""]},
                "day_start_time": {"$exists": True, "$nin": [None, ""]},
                "$or": [
                    {"onboarding_tz_done": {"$exists": False}},
                    {"onboarding_tz_done": False},
                    {"onboarding_tz_done": None},
                ],
            },
            {"$set": {"onboarding_tz_done": True}},
        )
        if result.modified_count:
            logger.info(
                f"[migrate] Backfilled onboarding_tz_done=true on "
                f"{result.modified_count} legacy profile(s)."
            )
    except Exception as e:
        logger.warning(f"[migrate] backfill onboarding_tz_done failed: {e}")


# ═══════════════ Admin Suspension Endpoints ═══════════════
class AdminSuspendBody(BaseModel):
    user_id: str
    duration_hours: Optional[float] = None  # 12, 24, 48, 168, or custom; None+forever=true → indefinite
    forever: Optional[bool] = False
    reason: Optional[str] = ""


@api_router.post("/admin/suspend")
async def admin_suspend(body: AdminSuspendBody, user_id: str = Depends(get_user_or_legacy)):
    """Admin/Creator suspends another user's account.

    The suspended user's next API call (or login attempt) returns 403 with
    detail.error='account_suspended' and a `remaining_seconds`/`forever`
    flag, plus `until` ISO timestamp. Frontends listen for this and
    force-logout + display the reason.

    Suspending an admin is a no-op (admins are never suspended); attempting
    to suspend yourself returns 400.
    """
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator-only action.")
    if body.user_id == user_id:
        raise HTTPException(400, "You cannot suspend your own account.")
    target = await db.users.find_one({"_id": body.user_id}, {"email": 1})
    if not target:
        raise HTTPException(404, "Target account not found.")
    if _is_admin_email(target.get("email")):
        raise HTTPException(400, "You can't suspend another Creator/Admin.")

    now = datetime.now(timezone.utc)
    if body.forever:
        until_value = "forever"
        until_iso = None
    else:
        if not body.duration_hours or body.duration_hours <= 0:
            raise HTTPException(400, "Provide duration_hours > 0 or forever=true.")
        if body.duration_hours > 24 * 365 * 5:  # cap at 5 years for safety
            raise HTTPException(400, "Duration too long.")
        until_dt = now + timedelta(hours=float(body.duration_hours))
        until_value = until_dt.isoformat()
        until_iso = until_value

    await db.profile.update_one(
        {"_id": body.user_id},
        {"$set": {
            "suspended_until": until_value,
            "suspended_at": now.isoformat(),
            "suspended_by_admin": user_id,
            "suspension_reason": (body.reason or "").strip()[:280],
            # Permanent flag — once true, never gets unset. Drives the
            # red dot the Creator sees forever next to that user's name.
            "was_suspended_ever": True,
        }},
        upsert=True,
    )
    return {
        "ok": True,
        "user_id": body.user_id,
        "suspended_until": until_iso,
        "forever": bool(body.forever),
        "duration_hours": body.duration_hours if not body.forever else None,
        "reason": (body.reason or "").strip()[:280],
    }


class AdminUnsuspendBody(BaseModel):
    user_id: str


@api_router.post("/admin/unsuspend")
async def admin_unsuspend(body: AdminUnsuspendBody, user_id: str = Depends(get_user_or_legacy)):
    """Admin/Creator lifts a previously-applied suspension."""
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator-only action.")
    res = await db.profile.update_one(
        {"_id": body.user_id},
        {"$unset": {
            "suspended_until": "",
            "suspended_at": "",
            "suspended_by_admin": "",
            "suspension_reason": "",
        }},
    )
    return {"ok": True, "user_id": body.user_id, "modified": res.modified_count}


@api_router.get("/admin/suspension/{target_id}")
async def admin_suspension_status(target_id: str, user_id: str = Depends(get_user_or_legacy)):
    """Admin reads current suspension status for a user (for the modal toggle)."""
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator-only action.")
    prof = await db.profile.find_one({"_id": target_id})
    state = _suspension_state(prof)
    return {
        "user_id": target_id,
        "suspended": bool(state),
        **(state or {}),
    }


# ═══════════════ Admin Gifts (XP / Bonus Top-Up) ═══════════════
class AdminGiftXPBody(BaseModel):
    user_id: str
    amount: int                     # 1..100_000
    message: Optional[str] = ""


class AdminGiftBoostBody(BaseModel):
    user_id: str
    boost_type: Optional[str] = None   # triple_day | double_week | double_month | None for custom
    custom_label: Optional[str] = None
    custom_multiplier: Optional[int] = None     # 2..10
    custom_duration_days: Optional[int] = None  # 1..365
    message: Optional[str] = ""


GIFT_MAX_XP = 100_000


def _serialize_gift(g: dict) -> dict:
    return {
        "id": g.get("id"),
        "kind": g.get("kind"),
        "amount": int(g.get("amount", 0) or 0),
        "boost_id": g.get("boost_id"),
        "boost_label": g.get("boost_label"),
        "boost_multiplier": g.get("boost_multiplier"),
        "boost_duration_days": g.get("boost_duration_days"),
        "message": g.get("message", ""),
        "from_user_id": g.get("from_user_id"),
        "from_name": g.get("from_name", "Creator"),
        "created_at": g.get("created_at"),
        "acknowledged_at": g.get("acknowledged_at"),
    }


@api_router.post("/admin/gift/xp")
async def admin_gift_xp(body: AdminGiftXPBody, user_id: str = Depends(get_user_or_legacy)):
    """Creator gifts custom XP points to a player. Adds to total_xp
    immediately AND records the amount as `gifted_xp` on the per-day
    chart so the recipient sees a yellow stacked segment in their
    Progress chart on top of regular cyan earned-XP bars.
    """
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator-only action.")
    if body.user_id == user_id:
        raise HTTPException(400, "You can't gift yourself.")
    target = await db.users.find_one({"_id": body.user_id})
    if not target:
        raise HTTPException(404, "Recipient not found.")
    amount = int(body.amount)
    if amount <= 0 or amount > GIFT_MAX_XP:
        raise HTTPException(400, f"Amount must be 1..{GIFT_MAX_XP}.")

    # Increment user's total_xp; stash gifted_xp_total too.
    await db.profile.update_one(
        {"_id": body.user_id},
        {"$inc": {"total_xp": amount, "gifted_xp_total": amount}},
        upsert=True,
    )
    # Receiving a Creator XP gift counts as activity → preserves streak.
    # Spec: "as long as the user earns a little XP points each day,
    # the streak will still be counted as Streak kept."
    await _bump_streak_for_xp(body.user_id)
    sender_prof = await db.profile.find_one({"_id": user_id}) or {}
    sender_name = ADMIN_PUBLIC_DISPLAY_NAME
    gift = {
        "id": str(uuid.uuid4()),
        "kind": "xp",
        "amount": amount,
        "to_user_id": body.user_id,
        "from_user_id": user_id,
        "from_name": sender_name,
        "message": (body.message or "").strip()[:500],
        "created_at": now_iso(),
        "acknowledged_at": None,
    }
    await db.gifts.insert_one(gift)
    # Push notification (non-blocking — push delivery is best-effort)
    tokens = await db.push_tokens.find({"user_id": body.user_id}).to_list(10)
    for tok_doc in tokens:
        try:
            await _send_expo_push(
                tok_doc.get("token", ""),
                "🎁 Gift from the Creator!",
                f"You received {amount} XP! {body.message or ''}".strip()[:200],
                {"type": "gift_xp", "amount": amount, "gift_id": gift["id"]},
            )
        except Exception:
            pass
    return {"ok": True, "gift": _serialize_gift(gift)}


@api_router.post("/admin/gift/boost")
async def admin_gift_boost(body: AdminGiftBoostBody, user_id: str = Depends(get_user_or_legacy)):
    """Creator gifts a Bonus Top-Up to a player. Adds the boost entry to
    the recipient's `boost_inventory` (un-activated) and records the
    gift so the recipient's golden welcome modal can announce it.

    Either pass `boost_type` for a preset (triple_day, double_week,
    double_month — each defaulted to 1 day duration as agreed) OR pass
    a fully custom triplet (custom_label, custom_multiplier 2..10,
    custom_duration_days 1..365).
    """
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator-only action.")
    if body.user_id == user_id:
        raise HTTPException(400, "You can't gift yourself.")
    target = await db.users.find_one({"_id": body.user_id})
    if not target:
        raise HTTPException(404, "Recipient not found.")

    if body.boost_type and body.boost_type in BOOST_DEFS:
        # Use the preset definition but override duration to 1 day so
        # gifts always behave like "today's bonus" by default.
        cfg = BOOST_DEFS[body.boost_type]
        entry = {
            "id": str(uuid.uuid4()),
            "type": body.boost_type,
            "multiplier": int(cfg.get("multiplier", 2)),
            "duration_days": 1,
            "label": cfg.get("label", body.boost_type) + " (Gift)",
            "source": "gift",
            "acquired_at": now_iso(),
            "activated": False,
        }
    else:
        mult = int(body.custom_multiplier or 0)
        dur = int(body.custom_duration_days or 0)
        if not (2 <= mult <= 10) or not (1 <= dur <= 365):
            raise HTTPException(400, "Provide custom_multiplier 2..10 and custom_duration_days 1..365 (or a known boost_type).")
        entry = {
            "id": str(uuid.uuid4()),
            "type": "custom_gift",
            "multiplier": mult,
            "duration_days": dur,
            "label": (body.custom_label or f"{mult}x for {dur} day{'s' if dur != 1 else ''}").strip()[:80],
            "source": "gift",
            "acquired_at": now_iso(),
            "activated": False,
        }

    # Make sure boosts feature is unlocked for the recipient so they can
    # actually activate the gifted boost without entering an unlock code.
    await db.profile.update_one(
        {"_id": body.user_id},
        {
            "$set": {"boosts_unlocked": True, "boosts_unlocked_at": now_iso()},
            "$push": {"boost_inventory": entry},
        },
        upsert=True,
    )
    sender_prof = await db.profile.find_one({"_id": user_id}) or {}
    sender_name = ADMIN_PUBLIC_DISPLAY_NAME
    gift = {
        "id": str(uuid.uuid4()),
        "kind": "boost",
        "amount": 0,
        "boost_id": entry["id"],
        "boost_label": entry["label"],
        "boost_multiplier": entry["multiplier"],
        "boost_duration_days": entry["duration_days"],
        "to_user_id": body.user_id,
        "from_user_id": user_id,
        "from_name": sender_name,
        "message": (body.message or "").strip()[:500],
        "created_at": now_iso(),
        "acknowledged_at": None,
    }
    await db.gifts.insert_one(gift)
    tokens = await db.push_tokens.find({"user_id": body.user_id}).to_list(10)
    for tok_doc in tokens:
        try:
            await _send_expo_push(
                tok_doc.get("token", ""),
                "🎁 Gift from the Creator!",
                f"Bonus Top-Up: {entry['label']}".strip()[:200],
                {"type": "gift_boost", "gift_id": gift["id"]},
            )
        except Exception:
            pass
    return {"ok": True, "gift": _serialize_gift(gift), "inventory_entry": entry}


# ── Recipient endpoints ───────────────────────────────────────────
@api_router.get("/gifts/pending")
async def gifts_pending(user_id: str = Depends(get_user_or_legacy)):
    """All gifts that haven't been acknowledged yet by this user.
    Drives the golden 'Congratulations!' modal that appears the first
    time the recipient opens the app after receiving a gift.
    """
    cur = db.gifts.find({"to_user_id": user_id, "acknowledged_at": None}, {"_id": 0}).sort("created_at", 1)
    items = []
    async for g in cur:
        items.append(_serialize_gift(g))
    return {"gifts": items}


class GiftAckBody(BaseModel):
    gift_id: str


@api_router.post("/gifts/ack")
async def gifts_ack(body: GiftAckBody, user_id: str = Depends(get_user_or_legacy)):
    res = await db.gifts.update_one(
        {"id": body.gift_id, "to_user_id": user_id, "acknowledged_at": None},
        {"$set": {"acknowledged_at": now_iso()}},
    )
    return {"ok": True, "updated": res.modified_count}


# ═══════════════ Mini-app Catalog (Admin-only) ═══════════════
@api_router.get("/library/catalog")
async def library_catalog(user_id: str = Depends(get_user_or_legacy)):
    """Full content catalog of every mini-app. Used by the Creator/Admin
    dashboard to inspect every challenge / object / sleep question.
    Restricted to admin users."""
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Admin access only.")
    # Challenge Tasks
    try:
        from challenges_data import CHALLENGES as RAW_CHALLENGES
        challenges = list(RAW_CHALLENGES) if RAW_CHALLENGES else []
    except Exception:
        challenges = []
    # Spot the Object
    spot_objects = list(SPOT_OBJECTS)
    # Sleep questions
    sleep_questions = list(SLEEP_QUESTIONS)
    # Boost types (Points+ shop)
    boost_defs = [
        {"type": k, **v} for k, v in BOOST_DEFS.items()
    ]
    # Build Self-Confidence — all 4 tracks
    social_items = [
        {
            "id": f"social-{i}",
            "title": c.get("title", ""),
            "description": c.get("body", ""),
            "options": (c.get("tips") or []) + (c.get("examples") or []),
            "category": "Social Speaking",
        }
        for i, c in enumerate(CONFIDENCE_SOCIAL_CHALLENGES)
    ]
    physical_items = [
        {
            "id": f"physical-{i}",
            "title": c.get("title", ""),
            "description": c.get("body", ""),
            "options": (c.get("tips") or []) + (c.get("examples") or []),
            "category": "Physical Appearance",
        }
        for i, c in enumerate(CONFIDENCE_PHYSICAL_CHALLENGES)
    ]
    gratitude_items = [
        {
            "id": f"gratitude-{i}",
            "title": c.get("title", ""),
            "description": c.get("body", ""),
            "options": (c.get("tips") or []) + (c.get("examples") or []),
            "category": "No Negative Thinking",
        }
        for i, c in enumerate(CONFIDENCE_GRATITUDE_PROMPTS)
    ]
    # Dress with Confidence — describe the AI-driven flow for admin inspection.
    dress_items = [
        {
            "id": "dress-overview",
            "title": "Dress with Confidence · AI Style Coach",
            "description": (
                "User snaps a selfie of their outfit, picks an event context "
                "(casual/office/date/party/outside/gym/interview), and asks a "
                "question. GPT-4o-mini Vision (via emergentintegrations + "
                "EMERGENT_LLM_KEY) analyses the photo and answers in under "
                "120 words. Local weather is auto-fetched via open-meteo and "
                "passed as context. Each conversation is saved to history "
                "with a 320px thumbnail for replay; caller can delete any "
                "past entry."
            ),
            "options": [
                "Start with ONE specific compliment (colour / cut / fit / vibe)",
                "Verdict format: YES / YES WITH ONE TWEAK / CONSIDER ONE SWAP",
                "Factor in event_context (party, office, date, outside, gym, interview)",
                "Factor in weather_hint (e.g. 15°C, light rain, windy)",
                "Frame suggestions positively: 'try swapping X for Y', 'add Z to elevate'",
                "End with a one-line confidence booster",
            ],
            "category": "AI Photo Coach",
        },
        {
            "id": "dress-endpoints",
            "title": "Backend endpoints",
            "description": (
                "POST /confidence/dress-advice {photo_base64?, message, "
                "event_context?, weather_hint?, history?} → {reply, entry_id}.\n"
                "GET /confidence/dress-history?limit=30 → {items[]}.\n"
                "DELETE /confidence/dress-history/{id} → {deleted}.\n"
                "GET /confidence/weather?lat=&lon= → open-meteo snapshot."
            ),
            "options": [
                "Photo downscaled to 640px JPEG q=80 before vision call",
                "Thumbnail downscaled to 320px JPEG q=70 for history replay",
                "History scoped to caller (JWT or X-Anonymous-Id)",
                "Cross-user delete is silent no-op ({deleted:0})",
            ],
            "category": "AI Photo Coach",
        },
        {
            "id": "dress-events",
            "title": "Event chips the user can select",
            "description": "Shown as horizontal scroll chips in the dress.tsx composer to anchor the AI's verdict to a specific occasion.",
            "options": ["No event", "Casual", "Office", "Date", "Party", "Outside", "Gym", "Interview"],
            "category": "AI Photo Coach",
        },
    ]

    return {
        "challenge_tasks": {
            "name": "Challenge Tasks",
            "count": len(challenges),
            "items": [
                {
                    "id": c.get("id"),
                    "title": c.get("title"),
                    "description": c.get("description") or c.get("desc") or "",
                    "category": c.get("category", ""),
                    "difficulty": c.get("difficulty", ""),
                }
                for c in challenges
            ],
        },
        "spot_the_object": {
            "name": "Spot the Object",
            "count": len(spot_objects),
            "items": [{"id": str(i), "title": o, "description": f"Find and photograph: {o}."} for i, o in enumerate(spot_objects)],
        },
        "improve_sleep_questions": {
            "name": "Improve Sleeping (Onboarding Questions)",
            "count": len(sleep_questions),
            "items": [
                {
                    "id": q.get("id"),
                    "title": q.get("q") or q.get("question") or "",
                    "description": f"Type: {q.get('type', '')}",
                    "options": q.get("options") or [],
                }
                for q in sleep_questions
            ],
        },
        "points_plus_boosts": {
            "name": "Points+ Boosts",
            "count": len(boost_defs),
            "items": [
                {
                    "id": b.get("type"),
                    "title": b.get("label", ""),
                    "description": f"{b.get('multiplier')}x XP for {b.get('duration_days')} day(s)",
                }
                for b in boost_defs
            ],
        },
        "confidence_social": {
            "name": "Build Self-Confidence · Social Speaking",
            "count": len(social_items),
            "items": social_items,
        },
        "confidence_physical": {
            "name": "Build Self-Confidence · Physical Appearance",
            "count": len(physical_items),
            "items": physical_items,
        },
        "confidence_gratitude": {
            "name": "Build Self-Confidence · No Negative Thinking",
            "count": len(gratitude_items),
            "items": gratitude_items,
        },
        "confidence_dress": {
            "name": "Build Self-Confidence · Dress with Confidence (AI Coach)",
            "count": len(dress_items),
            "items": dress_items,
        },
    }


# ═════════════════════ Library+ Mini-App Ratings ═════════════════════
# Each authenticated user (incl. anonymous) can rate any of the four
# featured mini-apps from 1–5 stars. The UI shows a vertical 5-star
# strip on the left side of every mini-app card with the running
# average + reviewer count, and lets the user tap to give/change
# their rating at any time.
#
# Storage model — `library_ratings` collection:
#   {
#     "_id":          "<uuid>",          # internal row id
#     "user_id":      "<uid>",
#     "app_id":       "sleep" | "challenges" | "spot" | "confidence",
#     "stars":        1..5 (int),
#     "updated_at":   "<iso8601>",
#   }
# Composite uniqueness: (user_id, app_id). We enforce it via upsert.

LIBRARY_APP_IDS = ["sleep", "challenges", "spot", "confidence"]
APP_PRETTY = {
    "sleep": "Improve Sleeping",
    "challenges": "Challenge Tasks",
    "spot": "Spot the Object",
    "confidence": "Build Self-Confidence",
}


# ═════════════════════ User Feedback (in-app survey) ═════════════════
# Stored separately from Library+ ratings because:
#   • Library+ ratings are per-mini-app (4 buckets); feedback is global.
#   • Feedback contains free-text the user typed, mini-app ratings don't.
#   • Feedback drives the level-up "rate-us" prompt frequency cap so
#     we never re-prompt a user who already gave feedback.
#
# Storage model — `feedback` collection:
#   {
#     "_id":               "<uuid>",
#     "user_id":           "<uid>",
#     "rating":            1..5 (int),
#     "text":              str (≤1000 chars),
#     "level_at_submit":   int,
#     "app_version":       str,
#     "platform":          "ios" | "android" | "web",
#     "created_at":        "<iso8601>",
#   }


@api_router.post("/feedback")
async def feedback_post(
    body: dict = Body(...),
    user_id: str = Depends(get_user_or_legacy),
):
    """User submits in-app feedback (rating + free-text). Once a user
    has POSTed once, subsequent level-up prompts will skip the "Give us
    feedback" pop-up — the rate-us-on-Play-Store dialog still shows
    until they tap it (we can't actually detect Play Store rating; we
    only track our own button click)."""
    try:
        rating = int(body.get("rating") or 0)
    except (TypeError, ValueError):
        rating = 0
    if rating < 1 or rating > 5:
        raise HTTPException(400, "rating must be between 1 and 5")
    text = (body.get("text") or "").strip()
    if len(text) > 1000:
        raise HTTPException(400, "text exceeds 1000 chars")
    level_at = int(body.get("level_at_submit") or 0)
    app_version = (body.get("app_version") or "")[:32]
    platform_str = (body.get("platform") or "")[:16]
    doc = {
        "_id": str(uuid.uuid4()),
        "user_id": user_id,
        "rating": rating,
        "text": text,
        "level_at_submit": level_at,
        "app_version": app_version,
        "platform": platform_str,
        "created_at": now_iso(),
    }
    await db.feedback.insert_one(doc)
    # Mark on profile so level-up modal stops nagging for feedback.
    await db.profile.update_one(
        {"_id": user_id},
        {"$set": {"feedback_submitted_at": now_iso()}},
    )
    # ── Notify the Creator (admin) by adding an entry to admin_reports
    # so it shows up in the Creator's notification bell + /admin/reports
    # inbox alongside abuse reports. We use a distinct kind="feedback"
    # so the UI can render it differently (stars instead of red flag).
    try:
        prof = await db.profile.find_one({"_id": user_id}) or {}
        user_doc = await db.users.find_one({"_id": user_id}) or {}
        stars = "★" * rating + "☆" * (5 - rating)
        excerpt_str = text if text else "(no comment)"
        await db.admin_reports.insert_one({
            "id": str(uuid.uuid4()),
            "reported_user_id": user_id,
            "reported_name": prof.get("full_name") or prof.get("name") or "Anonymous",
            "reported_email": user_doc.get("email", ""),
            "kind": "feedback",
            "severity": "info",
            "rating": rating,
            "stars": stars,
            "excerpt": excerpt_str[:500],
            "reason": f"In-app feedback ({rating}/5 stars)" + (f" · Level {level_at}" if level_at else ""),
            "level_at_submit": level_at,
            "platform": platform_str,
            "created_at": now_iso(),
            "viewed_at": None,
            "dismissed_at": None,
        })
    except Exception as e:
        logger.warning(f"[feedback] admin notify failed: {e}")
    return {"saved": True, "id": doc["_id"]}


@api_router.get("/feedback/me")
async def feedback_me(user_id: str = Depends(get_user_or_legacy)):
    """Returns whether the user has ever submitted feedback. Used by
    the level-up prompt to decide whether to show the in-app feedback
    section."""
    prof = await db.profile.find_one({"_id": user_id}, {"feedback_submitted_at": 1})
    submitted = bool(prof and prof.get("feedback_submitted_at"))
    return {"submitted": submitted, "submitted_at": prof.get("feedback_submitted_at") if prof else None}


@api_router.post("/profile/level-milestone-shown")
async def level_milestone_shown(
    body: dict = Body(...),
    user_id: str = Depends(get_user_or_legacy),
):
    """Mark a level-up milestone (e.g. 2, 3, 4, 5, 6) as having shown
    its review/feedback prompt. The profile field
    `level_milestones_shown` is a sorted unique list of integers; we
    use it on the client as the source of truth for "have we already
    pestered the user at this level?".

    Also accepts optional `play_store_review_clicked: bool` — once true
    we permanently stop the Play-Store CTA (Apple/Google guidelines
    forbid repeat-asking once they've had their chance to rate)."""
    try:
        level = int(body.get("level") or 0)
    except (TypeError, ValueError):
        level = 0
    if level < 1 or level > 200:
        raise HTTPException(400, "level out of range")
    update_set: dict = {}
    if body.get("play_store_review_clicked"):
        update_set["play_store_review_clicked"] = True
        update_set["play_store_review_clicked_at"] = now_iso()
    await db.profile.update_one(
        {"_id": user_id},
        {
            "$addToSet": {"level_milestones_shown": level},
            **({"$set": update_set} if update_set else {}),
        },
    )
    prof = await db.profile.find_one({"_id": user_id})
    return {
        "saved": True,
        "level_milestones_shown": sorted(prof.get("level_milestones_shown") or []),
        "play_store_review_clicked": bool(prof.get("play_store_review_clicked")),
    }


@api_router.get("/library/ratings")
async def library_ratings_get(user_id: str = Depends(get_user_or_legacy)):
    """Aggregate rating stats for all four mini-apps PLUS the caller's
    own rating per app (so the UI can pre-highlight their stars in the
    "change my rating" modal).

    Returns:
      {
        "ratings": {
          "sleep":      {"average": 4.5, "count": 12, "user_rating": 4 | null},
          "challenges": {...},
          "spot":       {...},
          "confidence": {...}
        }
      }
    """
    out: dict = {}
    # Pull everything in one round-trip then bucket in Python — the
    # collection is small (max ~4 rows per user) so a per-app
    # aggregate pipeline would be more I/O than this.
    rows = await db.library_ratings.find({}, {"_id": 0}).to_list(100000)
    by_app: dict[str, list[int]] = {a: [] for a in LIBRARY_APP_IDS}
    user_rating: dict[str, int | None] = {a: None for a in LIBRARY_APP_IDS}
    for r in rows:
        aid = r.get("app_id")
        if aid not in by_app:
            continue
        try:
            stars = int(r.get("stars") or 0)
        except (TypeError, ValueError):
            continue
        if 1 <= stars <= 5:
            by_app[aid].append(stars)
            if r.get("user_id") == user_id:
                user_rating[aid] = stars
    for aid in LIBRARY_APP_IDS:
        votes = by_app[aid]
        avg = round(sum(votes) / len(votes), 2) if votes else 0.0
        out[aid] = {
            "average": avg,
            "count": len(votes),
            "user_rating": user_rating[aid],
        }
    return {"ratings": out}


@api_router.post("/library/ratings")
async def library_ratings_post(
    body: dict = Body(...),
    user_id: str = Depends(get_user_or_legacy),
):
    """Upsert the caller's rating for a mini-app. Returns the freshly
    recomputed aggregate for THAT app so the UI can update without a
    full refetch.

    Body:  { "app_id": "sleep", "stars": 4 }
    """
    app_id = (body.get("app_id") or "").strip()
    if app_id not in LIBRARY_APP_IDS:
        raise HTTPException(400, f"Invalid app_id. Must be one of {LIBRARY_APP_IDS}")
    try:
        stars = int(body.get("stars"))
    except (TypeError, ValueError):
        raise HTTPException(400, "stars must be an integer 1..5")
    if stars < 1 or stars > 5:
        raise HTTPException(400, "stars must be between 1 and 5")

    # Upsert: composite (user_id, app_id). Mongo's update_one with
    # upsert=True gives us the right semantics — one row per user/app.
    await db.library_ratings.update_one(
        {"user_id": user_id, "app_id": app_id},
        {
            "$set": {
                "stars": stars,
                "updated_at": now_iso(),
                "user_id": user_id,
                "app_id": app_id,
            },
            "$setOnInsert": {"_id": str(uuid.uuid4())},
        },
        upsert=True,
    )

    # Recompute aggregate for the affected app only.
    rows = await db.library_ratings.find(
        {"app_id": app_id}, {"_id": 0, "stars": 1}
    ).to_list(100000)
    votes = [int(r["stars"]) for r in rows if isinstance(r.get("stars"), int) and 1 <= r["stars"] <= 5]
    avg = round(sum(votes) / len(votes), 2) if votes else 0.0
    return {
        "saved": True,
        "app_id": app_id,
        "stats": {
            "average": avg,
            "count": len(votes),
            "user_rating": stars,
        },
    }


# ═══════════════════ Library+ Mini-App Pricing & Purchases ═══════════
# Creator can:
#   • set a price + currency + external purchase URL (Ko-fi/Stripe) per app
#   • add a discount (% off, time-limited) that auto-expires
#   • free apps display "FREE" badge (price=0 means free; default for all)
#
# Users (non-Creator):
#   • see "FREE" or the current price (with strikethrough if discounted)
#   • tapping a priced/locked app opens a Buy modal that links externally
#   • after returning, they self-attest "I purchased it" → unlock for life
#
# Storage:
#   • db.library_pricing  — one row per app_id (upsert)
#       {_id, app_id, price (float), currency (str), purchase_url (str),
#        discount_percent (int 0..100), discount_starts_at (iso), discount_ends_at (iso),
#        updated_at}
#   • db.library_purchases — one row per (user_id, app_id) (upsert, unique pair)
#       {_id, user_id, app_id, purchased_at, paid_amount, paid_currency}
# Effective price = price * (1 - discount_percent/100) if discount_active else price.
# Discount considered active when now() ∈ [starts_at, ends_at].

DEFAULT_PRICE_CURRENCY = "USD"
SUPPORTED_PRICE_CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "JPY", "INR", "RON", "CHF", "BRL"]

# Boost IDs that the Creator can price in Points+ section (Progress tab).
BOOST_IDS = ["triple_day", "double_week", "double_month"]
BOOST_PRETTY = {
    "triple_day": "Triple your points today!",
    "double_week": "Double your points for 7 days!",
    "double_month": "Double your points for 1 month!",
}


def _pricing_doc_to_pub(doc: dict | None, app_id: str, purchased: bool) -> dict:
    """Translate the stored pricing doc into the public payload the
    frontend wants (computes effective price + discount-active flag)."""
    if not doc:
        return {
            "app_id": app_id,
            "price": 0.0,
            "currency": DEFAULT_PRICE_CURRENCY,
            "purchase_url": "",
            "discount_percent": 0,
            "discount_active": False,
            "discount_starts_at": None,
            "discount_ends_at": None,
            "effective_price": 0.0,
            "is_free": True,
            "purchased": purchased,
        }
    try:
        price = float(doc.get("price") or 0.0)
    except (TypeError, ValueError):
        price = 0.0
    currency = (doc.get("currency") or DEFAULT_PRICE_CURRENCY).upper()
    try:
        pct = int(doc.get("discount_percent") or 0)
    except (TypeError, ValueError):
        pct = 0
    starts = doc.get("discount_starts_at")
    ends = doc.get("discount_ends_at")
    discount_active = False
    if pct > 0 and starts and ends:
        try:
            now = datetime.utcnow()
            s = datetime.fromisoformat(starts.replace("Z", "+00:00")).replace(tzinfo=None)
            e = datetime.fromisoformat(ends.replace("Z", "+00:00")).replace(tzinfo=None)
            discount_active = s <= now <= e
        except Exception:
            discount_active = False
    eff = price * (1 - pct / 100.0) if discount_active and price > 0 else price
    eff = round(max(0.0, eff), 2)
    return {
        "app_id": app_id,
        "price": round(price, 2),
        "currency": currency,
        "purchase_url": doc.get("purchase_url") or "",
        "discount_percent": pct if discount_active else 0,
        "discount_active": discount_active,
        "discount_starts_at": starts if discount_active else None,
        "discount_ends_at": ends if discount_active else None,
        "effective_price": eff,
        "is_free": price <= 0.0,
        "purchased": purchased,
    }


@api_router.get("/library/pricing")
async def library_pricing_get(user_id: str = Depends(get_user_or_legacy)):
    """Returns pricing config for all 4 mini-apps + per-user purchase
    status. Used by Library+ to render FREE pills, price tags with
    optional strikethrough, and lock/unlock state."""
    rows = await db.library_pricing.find({}, {"_id": 0}).to_list(100)
    by_app = {r.get("app_id"): r for r in rows if r.get("app_id") in LIBRARY_APP_IDS}
    purchased_rows = await db.library_purchases.find(
        {"user_id": user_id}, {"_id": 0, "app_id": 1}
    ).to_list(100)
    purchased_set = {p.get("app_id") for p in purchased_rows}
    out = {}
    for aid in LIBRARY_APP_IDS:
        out[aid] = _pricing_doc_to_pub(by_app.get(aid), aid, aid in purchased_set)
    return {"pricing": out, "currencies": SUPPORTED_PRICE_CURRENCIES}


@api_router.post("/library/pricing/{app_id}")
async def library_pricing_set(
    app_id: str,
    body: dict = Body(...),
    user_id: str = Depends(get_user_or_legacy),
):
    """Creator-only: set price + currency + purchase URL for a mini-app.
    Pass price=0 to mark the app as free. Currency must be one of
    SUPPORTED_PRICE_CURRENCIES. purchase_url is optional but strongly
    recommended (Ko-fi / Stripe checkout link)."""
    if app_id not in LIBRARY_APP_IDS:
        raise HTTPException(400, f"Invalid app_id. Must be one of {LIBRARY_APP_IDS}")
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator only.")
    try:
        price = float(body.get("price") if body.get("price") is not None else 0.0)
    except (TypeError, ValueError):
        raise HTTPException(400, "price must be a number")
    if price < 0 or price > 100000:
        raise HTTPException(400, "price out of range (0..100000)")
    currency = (body.get("currency") or DEFAULT_PRICE_CURRENCY).upper()
    if currency not in SUPPORTED_PRICE_CURRENCIES:
        raise HTTPException(400, f"currency must be one of {SUPPORTED_PRICE_CURRENCIES}")
    purchase_url = (body.get("purchase_url") or "").strip()[:500]
    if purchase_url and not (purchase_url.startswith("http://") or purchase_url.startswith("https://")):
        raise HTTPException(400, "purchase_url must start with http:// or https://")
    await db.library_pricing.update_one(
        {"app_id": app_id},
        {
            "$set": {
                "app_id": app_id,
                "price": round(price, 2),
                "currency": currency,
                "purchase_url": purchase_url,
                "updated_at": now_iso(),
            },
            "$setOnInsert": {"_id": str(uuid.uuid4())},
        },
        upsert=True,
    )
    doc = await db.library_pricing.find_one({"app_id": app_id}, {"_id": 0})
    return {"saved": True, "pricing": _pricing_doc_to_pub(doc, app_id, False)}


@api_router.post("/library/pricing/{app_id}/discount")
async def library_pricing_discount(
    app_id: str,
    body: dict = Body(...),
    user_id: str = Depends(get_user_or_legacy),
):
    """Creator-only: add or clear a time-limited discount on a mini-app.
    Body:
      { "percent": 50, "duration_value": 7, "duration_unit": "days" }   # set
      { "percent": 0 }                                                  # clear
    duration_unit ∈ {days, weeks, months}.
    """
    if app_id not in LIBRARY_APP_IDS:
        raise HTTPException(400, f"Invalid app_id. Must be one of {LIBRARY_APP_IDS}")
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator only.")
    try:
        pct = int(body.get("percent") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "percent must be an integer 0..99")
    if pct < 0 or pct > 99:
        raise HTTPException(400, "percent must be 0..99")
    set_doc: dict = {"app_id": app_id, "updated_at": now_iso()}
    if pct == 0:
        set_doc["discount_percent"] = 0
        set_doc["discount_starts_at"] = None
        set_doc["discount_ends_at"] = None
    else:
        try:
            dur_val = int(body.get("duration_value") or 0)
        except (TypeError, ValueError):
            raise HTTPException(400, "duration_value must be a positive integer")
        if dur_val <= 0 or dur_val > 1000:
            raise HTTPException(400, "duration_value must be 1..1000")
        unit = (body.get("duration_unit") or "days").lower().strip()
        if unit not in ("days", "weeks", "months"):
            raise HTTPException(400, "duration_unit must be days|weeks|months")
        days = {"days": 1, "weeks": 7, "months": 30}[unit] * dur_val
        now = datetime.utcnow()
        starts = now.isoformat()
        ends = (now + timedelta(days=days)).isoformat()
        set_doc["discount_percent"] = pct
        set_doc["discount_starts_at"] = starts
        set_doc["discount_ends_at"] = ends
    await db.library_pricing.update_one(
        {"app_id": app_id},
        {"$set": set_doc, "$setOnInsert": {"_id": str(uuid.uuid4())}},
        upsert=True,
    )
    doc = await db.library_pricing.find_one({"app_id": app_id}, {"_id": 0})
    return {"saved": True, "pricing": _pricing_doc_to_pub(doc, app_id, False)}


@api_router.post("/library/purchase/{app_id}")
async def library_purchase_record(
    app_id: str,
    body: dict = Body(default=None),
    user_id: str = Depends(get_user_or_legacy),
):
    """Records that the caller has purchased the mini-app. Trust-based:
    after returning from the external payment URL the frontend POSTs
    here. Idempotent — re-POSTing returns already_owned=true."""
    if app_id not in LIBRARY_APP_IDS:
        raise HTTPException(400, f"Invalid app_id. Must be one of {LIBRARY_APP_IDS}")
    pricing_doc = await db.library_pricing.find_one({"app_id": app_id}, {"_id": 0})
    pricing_pub = _pricing_doc_to_pub(pricing_doc, app_id, False)
    # Free apps don't need a purchase record — just no-op.
    if pricing_pub["is_free"]:
        return {"saved": False, "already_owned": True, "is_free": True}
    existing = await db.library_purchases.find_one({"user_id": user_id, "app_id": app_id})
    if existing:
        return {"saved": True, "already_owned": True, "is_free": False}
    await db.library_purchases.insert_one({
        "_id": str(uuid.uuid4()),
        "user_id": user_id,
        "app_id": app_id,
        "purchased_at": now_iso(),
        "paid_amount": pricing_pub["effective_price"],
        "paid_currency": pricing_pub["currency"],
    })
    return {"saved": True, "already_owned": False, "is_free": False}


# ═══════════════════ Stripe Checkout (real payments) ═════════════════
# Uses server-side Checkout Sessions ONLY (no client SDK). Flow:
#   1. Frontend calls POST /payments/create-checkout {app_id} →
#      backend looks up the current effective price from library_pricing
#      (so the user can never tamper with the amount), creates a Stripe
#      Checkout Session, embeds {user_id, app_id, anonymous_id} in
#      session.metadata, and returns the hosted checkout URL.
#   2. User pays on Stripe. Stripe fires `checkout.session.completed`
#      webhook → POST /payments/webhook → we verify signature + insert
#      library_purchases row idempotently (so the next /library/pricing
#      call returns purchased=true → mini-app unlocks for life).
#   3. Stripe redirects user back to STRIPE_RETURN_BASE/payments/return
#      ?status=success&session_id=… → frontend deep-links into the app
#      and refreshes pricing/ownership.
#   4. Fallback: GET /payments/session/{session_id}/verify lets the
#      frontend self-verify if the webhook hasn't arrived yet (e.g.
#      whsec not configured); we query Stripe directly and insert the
#      purchase row if payment_status == 'paid'.
import stripe as _stripe_mod

_stripe_secret = os.getenv("STRIPE_SECRET_KEY", "").strip()
_stripe_whsec = os.getenv("STRIPE_WEBHOOK_SECRET", "").strip()
_stripe_return_base = os.getenv("STRIPE_RETURN_BASE", "").strip().rstrip("/")
if _stripe_secret:
    _stripe_mod.api_key = _stripe_secret
    logger.info("[stripe] configured (test mode=%s)", _stripe_secret.startswith("sk_test_"))
else:
    logger.warning("[stripe] STRIPE_SECRET_KEY missing — checkout disabled")

# Stripe minor-unit multiplier per ISO-4217 currency (zero-decimal vs. 2-decimal).
_STRIPE_MINOR_UNITS = {
    "USD": 100, "EUR": 100, "GBP": 100, "AUD": 100, "CAD": 100,
    "INR": 100, "RON": 100, "CHF": 100, "BRL": 100,
    "JPY": 1,  # zero-decimal
}


def _stripe_amount(price: float, currency: str) -> int:
    mult = _STRIPE_MINOR_UNITS.get(currency.upper())
    if mult is None:
        raise HTTPException(400, f"Unsupported currency for Stripe: {currency}")
    return max(1, int(round(price * mult)))


async def _stripe_record_purchase(
    user_id: str, app_id: str, session_id: str,
    payment_intent: str | None, amount: int, currency: str,
):
    """Idempotent purchase record from Stripe events."""
    if not user_id or not app_id:
        logger.warning("[stripe] record_purchase missing user/app ids")
        return False
    if app_id not in LIBRARY_APP_IDS:
        return False
    existing = await db.library_purchases.find_one({
        "$or": [{"stripe_session_id": session_id},
                {"user_id": user_id, "app_id": app_id}],
    })
    if existing:
        # Backfill stripe_session_id if record was created via /library/purchase fallback.
        if not existing.get("stripe_session_id"):
            await db.library_purchases.update_one(
                {"_id": existing["_id"]},
                {"$set": {"stripe_session_id": session_id,
                          "stripe_payment_intent": payment_intent}},
            )
        return False
    await db.library_purchases.insert_one({
        "_id": str(uuid.uuid4()),
        "user_id": user_id,
        "app_id": app_id,
        "purchased_at": now_iso(),
        "paid_amount": round(amount / _STRIPE_MINOR_UNITS.get(currency.upper(), 100), 2),
        "paid_currency": currency.upper(),
        "stripe_session_id": session_id,
        "stripe_payment_intent": payment_intent,
        "source": "stripe",
    })
    logger.info("[stripe] purchase recorded user=%s app=%s session=%s", user_id, app_id, session_id)
    return True


@api_router.post("/payments/create-payment-intent")
async def stripe_create_payment_intent(
    body: dict = Body(...),
    user_id: str = Depends(get_user_or_legacy),
):
    """Creates a Stripe PaymentIntent + ephemeral key for the in-app
    PaymentSheet (mobile native). Returns everything PaymentSheet's
    `initPaymentSheet({ paymentIntentClientSecret, customerId,
    customerEphemeralKeySecret, publishableKey })` needs.

    Body: { app_id, kind?:'library'|'boost' } — if kind='boost', the
    app_id is treated as a BOOST_ID (`triple_day` etc.) and the price
    is read from db.boost_pricing instead of db.library_pricing.
    Server-side amount lookup so the user can NEVER tamper with price.
    """
    if not _stripe_secret:
        raise HTTPException(503, "Stripe not configured.")
    kind = (body.get("kind") or "library").strip().lower()
    item_id = (body.get("app_id") or body.get("boost_id") or "").strip()
    if kind == "boost":
        if item_id not in BOOST_IDS:
            raise HTTPException(400, f"Invalid boost_id. Must be one of {BOOST_IDS}")
        pricing_doc = await db.boost_pricing.find_one({"boost_id": item_id}, {"_id": 0})
        pretty = BOOST_PRETTY.get(item_id, item_id)
    else:
        if item_id not in LIBRARY_APP_IDS:
            raise HTTPException(400, f"Invalid app_id. Must be one of {LIBRARY_APP_IDS}")
        pricing_doc = await db.library_pricing.find_one({"app_id": item_id}, {"_id": 0})
        pretty = APP_PRETTY.get(item_id, item_id)
    pub = _pricing_doc_to_pub(pricing_doc, item_id, False)
    if pub["is_free"] or pub["effective_price"] <= 0:
        raise HTTPException(400, "This item is free — no checkout needed.")
    if kind == "library":
        owns = await db.library_purchases.find_one({"user_id": user_id, "app_id": item_id})
        if owns:
            raise HTTPException(409, "You already own this mini-app.")
    currency = pub["currency"]
    amount = _stripe_amount(pub["effective_price"], currency)

    user_doc = await db.users.find_one({"_id": user_id}) or {}
    prof_doc = await db.profile.find_one({"_id": user_id}) or {}
    customer_email = user_doc.get("email") or None
    customer_name = prof_doc.get("full_name") or prof_doc.get("name") or None
    stripe_customer_id = user_doc.get("stripe_customer_id")
    try:
        if not stripe_customer_id:
            cust = _stripe_mod.Customer.create(
                email=customer_email,
                name=customer_name,
                metadata={"user_id": user_id},
            )
            stripe_customer_id = cust.id
            await db.users.update_one(
                {"_id": user_id},
                {"$set": {"stripe_customer_id": stripe_customer_id}},
            )
        ephemeral_key = _stripe_mod.EphemeralKey.create(
            customer=stripe_customer_id,
            stripe_version="2024-06-20",
        )
        intent = _stripe_mod.PaymentIntent.create(
            amount=amount,
            currency=currency.lower(),
            customer=stripe_customer_id,
            automatic_payment_methods={"enabled": True},
            metadata={
                "user_id": user_id,
                "kind": kind,
                "app_id": item_id if kind == "library" else "",
                "boost_id": item_id if kind == "boost" else "",
                "currency": currency,
                "price": str(pub["effective_price"]),
            },
            description=f"{pretty} — {'Library+' if kind == 'library' else 'Points+ Boost'}",
        )
    except Exception as e:
        logger.error("[stripe] create payment intent failed: %s", e)
        raise HTTPException(502, f"Stripe error: {e}")

    pk = os.getenv("STRIPE_PUBLISHABLE_KEY", "").strip()
    return {
        "payment_intent_client_secret": intent.client_secret,
        "ephemeral_key_secret": ephemeral_key.secret,
        "customer_id": stripe_customer_id,
        "publishable_key": pk,
        "amount": amount,
        "currency": currency,
        "effective_price": pub["effective_price"],
        "app_id": item_id,
        "kind": kind,
        "payment_intent_id": intent.id,
    }


@api_router.post("/payments/create-checkout")
async def stripe_create_checkout(
    body: dict = Body(...),
    user_id: str = Depends(get_user_or_legacy),
):
    """Create a Stripe Checkout Session for the requested mini-app.
    Body: { app_id }. Price/currency come from server-side library_pricing
    so the client can NEVER tamper with the amount."""
    if not _stripe_secret:
        raise HTTPException(503, "Stripe not configured.")
    app_id = (body.get("app_id") or "").strip()
    if app_id not in LIBRARY_APP_IDS:
        raise HTTPException(400, f"Invalid app_id. Must be one of {LIBRARY_APP_IDS}")
    pricing_doc = await db.library_pricing.find_one({"app_id": app_id}, {"_id": 0})
    pub = _pricing_doc_to_pub(pricing_doc, app_id, False)
    if pub["is_free"]:
        raise HTTPException(400, "This app is free — no checkout needed.")
    if pub["effective_price"] <= 0:
        raise HTTPException(400, "Effective price is 0; cannot checkout.")
    # Already owned — short-circuit.
    owns = await db.library_purchases.find_one({"user_id": user_id, "app_id": app_id})
    if owns:
        raise HTTPException(409, "You already own this mini-app.")
    currency = pub["currency"]
    amount = _stripe_amount(pub["effective_price"], currency)
    # Look up display name + owner email for receipts.
    user_doc = await db.users.find_one({"_id": user_id}) or {}
    customer_email = user_doc.get("email") if user_doc.get("email") else None
    pretty = {
        "sleep": "Improve Sleeping",
        "challenges": "Challenge Tasks",
        "spot": "Spot the Object",
        "confidence": "Build Self-Confidence",
    }.get(app_id, app_id)
    return_base = _stripe_return_base or "https://xp-confidence.preview.emergentagent.com"
    success_url = f"{return_base}/api/payments/return?status=success&session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{return_base}/api/payments/return?status=cancel&session_id={{CHECKOUT_SESSION_ID}}"
    try:
        session = _stripe_mod.checkout.Session.create(
            mode="payment",
            payment_method_types=["card"],
            line_items=[{
                "price_data": {
                    "currency": currency.lower(),
                    "product_data": {
                        "name": f"{pretty} — Library+ Premium",
                        "description": "One-time purchase. Lifetime access on this account.",
                    },
                    "unit_amount": amount,
                },
                "quantity": 1,
            }],
            metadata={
                "user_id": user_id,
                "app_id": app_id,
                "price": str(pub["effective_price"]),
                "currency": currency,
            },
            customer_email=customer_email,
            success_url=success_url,
            cancel_url=cancel_url,
            allow_promotion_codes=False,
        )
    except Exception as e:
        logger.error("[stripe] create session failed: %s", e)
        raise HTTPException(502, f"Stripe error: {e}")
    return {
        "session_id": session.id,
        "checkout_url": session.url,
        "amount": amount,
        "currency": currency,
        "effective_price": pub["effective_price"],
        "app_id": app_id,
    }


@api_router.post("/payments/webhook")
async def stripe_webhook(request: Request):
    """Stripe fires this on `checkout.session.completed`. We verify
    signature (when whsec configured) and idempotently insert the
    library_purchases row so /library/pricing flips purchased=true."""
    body = await request.body()
    sig = request.headers.get("stripe-signature", "")
    event = None
    if _stripe_whsec:
        try:
            event = _stripe_mod.Webhook.construct_event(body, sig, _stripe_whsec)
        except Exception as e:
            logger.warning("[stripe] webhook signature verify failed: %s", e)
            raise HTTPException(401, "Invalid signature")
    else:
        # No whsec configured yet — accept un-verified payload (DEV ONLY).
        try:
            event = json.loads(body.decode("utf-8") or "{}")
        except Exception:
            raise HTTPException(400, "Invalid JSON")
        logger.warning("[stripe] webhook received without whsec verification (set STRIPE_WEBHOOK_SECRET)")
    etype = event.get("type") if isinstance(event, dict) else getattr(event, "type", None)
    obj = (event.get("data", {}).get("object") if isinstance(event, dict)
           else event["data"]["object"])
    if etype == "checkout.session.completed":
        if obj.get("payment_status") == "paid" or obj.get("status") == "complete":
            md = obj.get("metadata") or {}
            await _stripe_record_purchase(
                user_id=md.get("user_id", ""),
                app_id=md.get("app_id", ""),
                session_id=obj.get("id", ""),
                payment_intent=obj.get("payment_intent"),
                amount=obj.get("amount_total", 0) or 0,
                currency=(obj.get("currency") or "USD").upper(),
            )
    elif etype == "payment_intent.succeeded":
        # PaymentSheet flow — Stripe fires this when the in-app
        # PaymentIntent is captured. Reuses the same idempotent insert
        # for library purchases, OR grants a boost when kind='boost'.
        md = obj.get("metadata") or {}
        kind = (md.get("kind") or "library").lower()
        if kind == "boost":
            boost_id = md.get("boost_id") or ""
            user = md.get("user_id") or ""
            if user and boost_id in BOOST_IDS:
                # Idempotency: dedupe by stripe payment_intent.id stored
                # alongside the boost_inventory entry.
                pi_id = obj.get("id") or ""
                already = await db.profile.find_one({
                    "_id": user,
                    "boost_inventory.stripe_payment_intent": pi_id,
                })
                if not already and pi_id:
                    entry = _make_inventory_entry(boost_id, source="purchase")
                    entry["stripe_payment_intent"] = pi_id
                    await db.profile.update_one(
                        {"_id": user},
                        {"$push": {"boost_inventory": entry}, "$set": {"boosts_unlocked": True}},
                        upsert=True,
                    )
                    logger.info("[stripe] boost granted user=%s boost=%s pi=%s", user, boost_id, pi_id)
        else:
            await _stripe_record_purchase(
                user_id=md.get("user_id", ""),
                app_id=md.get("app_id", ""),
                session_id=obj.get("id", ""),
                payment_intent=obj.get("id"),
                amount=obj.get("amount_received", 0) or obj.get("amount", 0) or 0,
                currency=(obj.get("currency") or "USD").upper(),
            )
    return {"received": True, "type": etype}


@api_router.get("/payments/session/{session_id}/verify")
async def stripe_verify_session(
    session_id: str,
    user_id: str = Depends(get_user_or_legacy),
):
    """Frontend fallback after returning from Stripe — fetches the
    session and finalises the purchase if Stripe says it's paid.
    Useful when the webhook hasn't been configured yet."""
    if not _stripe_secret:
        raise HTTPException(503, "Stripe not configured.")
    try:
        session = _stripe_mod.checkout.Session.retrieve(session_id)
    except Exception as e:
        raise HTTPException(404, f"Session not found: {e}")
    md = (session.get("metadata") or {}) if isinstance(session, dict) else (session.metadata or {})
    sess_user = md.get("user_id", "")
    sess_app = md.get("app_id", "")
    paid = (session.get("payment_status") if isinstance(session, dict) else session.payment_status) == "paid"
    if not paid:
        return {"paid": False, "session_id": session_id}
    if sess_user and sess_user != user_id:
        # Don't credit a different user.
        raise HTTPException(403, "Session belongs to another user.")
    inserted = await _stripe_record_purchase(
        user_id=sess_user or user_id,
        app_id=sess_app,
        session_id=session_id,
        payment_intent=(session.get("payment_intent") if isinstance(session, dict) else session.payment_intent),
        amount=(session.get("amount_total") if isinstance(session, dict) else session.amount_total) or 0,
        currency=((session.get("currency") if isinstance(session, dict) else session.currency) or "USD").upper(),
    )
    return {"paid": True, "session_id": session_id, "newly_inserted": inserted, "app_id": sess_app}


@api_router.get("/payments/return")
async def stripe_return(status: str = "success", session_id: str = ""):
    """Stripe's success/cancel URL lands here. Renders a tiny HTML page
    that auto-deeplinks back into the Expo app. The app's deep-link
    handler then calls /payments/session/{id}/verify to finalise
    OWNED state in case the webhook hasn't arrived yet."""
    deep = f"xpconfidence://payments/return?status={status}&session_id={session_id}"
    web = f"/?stripe_status={status}&stripe_session={session_id}#payments-return"
    body = f"""<!doctype html><html><head><meta charset="utf-8">
<title>Returning to XP in Real Life…</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{{margin:0;background:#0a0a0f;color:#eaeaea;font-family:-apple-system,Segoe UI,Roboto,sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh}}
  .card{{background:#11121a;border:1px solid rgba(255,255,255,.1);border-radius:24px;
         padding:32px 28px;max-width:360px;text-align:center}}
  h1{{font-size:20px;margin:8px 0 6px;color:{'#33ff95' if status == 'success' else '#ff7777'}}}
  p{{font-size:13px;color:#aaa;line-height:1.5;margin:8px 0}}
  a.btn{{display:inline-block;margin-top:16px;background:#33ff95;color:#0a0a0f;
         padding:10px 18px;border-radius:999px;font-weight:800;text-decoration:none}}
  .spin{{width:48px;height:48px;border-radius:50%;border:4px solid #222;
         border-top-color:#33ff95;border-right-color:#33ff95;
         animation:s 1s linear infinite;margin:0 auto 12px}}
  @keyframes s{{to{{transform:rotate(360deg)}}}}
</style></head><body><div class="card">
<div class="spin"></div>
<h1>{'Payment received ✓' if status == 'success' else 'Payment cancelled'}</h1>
<p>{'Returning you to <b>XP in Real Life</b> — your mini-app is unlocking now.' if status == 'success' else 'No charge was made. You can try again from inside the app.'}</p>
<a class="btn" href="{deep}">Open the app</a>
<p style="margin-top:14px;font-size:11px;color:#666">If nothing happens, return to the app manually.</p>
</div>
<script>
  // Try to auto-redirect to the deep link (mobile); fall back to web URL.
  setTimeout(function(){{
    window.location.href = "{deep}";
    setTimeout(function(){{ window.location.href = "{web}"; }}, 800);
  }}, 250);
</script>
</body></html>"""
    from fastapi.responses import HTMLResponse
    return HTMLResponse(content=body)


# ═══════════════════ Boost Pricing & Purchases (Points+) ═════════════
# Mirrors library pricing but for the 3 XP boosts in Points+ tab.
# Storage: db.boost_pricing — {boost_id, price, currency, purchase_url,
#   discount_percent, discount_starts_at, discount_ends_at, updated_at}.
# After payment, the boost is added to the user's `profile.boost_inventory`
# (un-activated; user activates manually). NOT permanent — once activated
# and consumed it's gone, but the user can re-buy (unlike library apps).


@api_router.get("/boosts/pricing")
async def boost_pricing_get(user_id: str = Depends(get_user_or_legacy)):
    rows = await db.boost_pricing.find({}, {"_id": 0}).to_list(100)
    by_id = {r.get("boost_id"): r for r in rows if r.get("boost_id") in BOOST_IDS}
    out = {}
    for bid in BOOST_IDS:
        # Boosts are NEVER "purchased forever" — re-purchasable per session.
        # `purchased=false` always so the Buy modal stays accessible.
        out[bid] = _pricing_doc_to_pub(by_id.get(bid), bid, False)
    return {"pricing": out, "currencies": SUPPORTED_PRICE_CURRENCIES}


@api_router.post("/boosts/pricing/{boost_id}")
async def boost_pricing_set(
    boost_id: str,
    body: dict = Body(...),
    user_id: str = Depends(get_user_or_legacy),
):
    if boost_id not in BOOST_IDS:
        raise HTTPException(400, f"Invalid boost_id. Must be one of {BOOST_IDS}")
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator only.")
    try:
        price = float(body.get("price") if body.get("price") is not None else 0.0)
    except (TypeError, ValueError):
        raise HTTPException(400, "price must be a number")
    if price < 0 or price > 100000:
        raise HTTPException(400, "price out of range (0..100000)")
    currency = (body.get("currency") or DEFAULT_PRICE_CURRENCY).upper()
    if currency not in SUPPORTED_PRICE_CURRENCIES:
        raise HTTPException(400, f"currency must be one of {SUPPORTED_PRICE_CURRENCIES}")
    purchase_url = (body.get("purchase_url") or "").strip()[:500]
    if purchase_url and not (purchase_url.startswith("http://") or purchase_url.startswith("https://")):
        raise HTTPException(400, "purchase_url must start with http:// or https://")
    await db.boost_pricing.update_one(
        {"boost_id": boost_id},
        {
            "$set": {
                "boost_id": boost_id,
                "price": round(price, 2),
                "currency": currency,
                "purchase_url": purchase_url,
                "updated_at": now_iso(),
            },
            "$setOnInsert": {"_id": str(uuid.uuid4())},
        },
        upsert=True,
    )
    doc = await db.boost_pricing.find_one({"boost_id": boost_id}, {"_id": 0})
    pub = _pricing_doc_to_pub(doc, boost_id, False)
    return {"saved": True, "pricing": pub}


@api_router.post("/boosts/pricing/{boost_id}/discount")
async def boost_pricing_discount(
    boost_id: str,
    body: dict = Body(...),
    user_id: str = Depends(get_user_or_legacy),
):
    if boost_id not in BOOST_IDS:
        raise HTTPException(400, f"Invalid boost_id. Must be one of {BOOST_IDS}")
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Creator only.")
    try:
        pct = int(body.get("percent") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "percent must be 0..99")
    if pct < 0 or pct > 99:
        raise HTTPException(400, "percent must be 0..99")
    set_doc: dict = {"boost_id": boost_id, "updated_at": now_iso()}
    if pct == 0:
        set_doc.update({"discount_percent": 0, "discount_starts_at": None, "discount_ends_at": None})
    else:
        try:
            dur_val = int(body.get("duration_value") or 0)
        except (TypeError, ValueError):
            raise HTTPException(400, "duration_value must be a positive integer")
        if dur_val <= 0 or dur_val > 1000:
            raise HTTPException(400, "duration_value must be 1..1000")
        unit = (body.get("duration_unit") or "days").lower().strip()
        if unit not in ("days", "weeks", "months"):
            raise HTTPException(400, "duration_unit must be days|weeks|months")
        days = {"days": 1, "weeks": 7, "months": 30}[unit] * dur_val
        now = datetime.utcnow()
        set_doc.update({
            "discount_percent": pct,
            "discount_starts_at": now.isoformat(),
            "discount_ends_at": (now + timedelta(days=days)).isoformat(),
        })
    await db.boost_pricing.update_one(
        {"boost_id": boost_id},
        {"$set": set_doc, "$setOnInsert": {"_id": str(uuid.uuid4())}},
        upsert=True,
    )
    doc = await db.boost_pricing.find_one({"boost_id": boost_id}, {"_id": 0})
    return {"saved": True, "pricing": _pricing_doc_to_pub(doc, boost_id, False)}


async def _grant_boost_to_inventory(user_id: str, boost_id: str, source: str = "stripe"):
    """Adds a boost to the user's inventory (idempotent per Stripe txn)."""
    if boost_id not in BOOST_DEFS:
        return False
    entry = _make_inventory_entry(boost_id, source=source)
    await db.profile.update_one(
        {"_id": user_id},
        {
            "$push": {"boost_inventory": entry},
            "$set": {"boosts_unlocked": True},
        },
        upsert=True,
    )
    return True


@api_router.post("/boosts/purchase")
async def boost_purchase_record(
    body: dict = Body(default=None),
    user_id: str = Depends(get_user_or_legacy),
):
    """Trust-based fallback after returning from external Stripe checkout.
    For paid boosts, grants the boost into inventory. Free boosts no-op."""
    body = body or {}
    boost_id = (body.get("boost_id") or "").strip()
    if boost_id not in BOOST_IDS:
        raise HTTPException(400, f"Invalid boost_id. Must be one of {BOOST_IDS}")
    pricing_doc = await db.boost_pricing.find_one({"boost_id": boost_id}, {"_id": 0})
    pub = _pricing_doc_to_pub(pricing_doc, boost_id, False)
    if pub["is_free"]:
        return {"saved": False, "is_free": True, "message": "This boost is free — use the unlock code instead."}
    await _grant_boost_to_inventory(user_id, boost_id, source="purchase")
    prof = await db.profile.find_one({"_id": user_id})
    return {"saved": True, "is_free": False, "profile": serialize_profile(prof) if prof else None}


# ════════════════════════════════════════════════════════════════════
# ── Server-side notification scheduler ──────────────────────────────
# 4× daily motivational pushes + 3× daily Spot-the-Object surprises
# + 2-minute multiplayer-invite expiry sweep. Lives in
# notif_scheduler.py to keep the lookup table of scheduled jobs small
# and isolated from the request handlers above.
try:
    from notif_scheduler import init_scheduler as _init_notif_scheduler  # noqa: E402
    from notif_scheduler import shutdown_scheduler as _shutdown_notif_scheduler  # noqa: E402
except Exception as _imp_err:  # pragma: no cover
    _init_notif_scheduler = None
    _shutdown_notif_scheduler = None
    logger.warning("[scheduler] module import failed: %s", _imp_err)


# Server-side bank of motivational lines. Mirrors the front-end array
# in src/notifications.ts so users get the same brand voice whether
# the push came from the device's local schedule or our scheduler.
_SERVER_MOTIVATIONAL_LINES = [
    "Stay Focused. Stay Committed. Stay Consistent.",
    "One more rep. One more win.",
    "Future you is watching. Make them proud.",
    "Small steps. Big quests. Stack XP.",
    "Your streak is waiting for you.",
    "Show up. Even now. Especially now.",
    "Discipline is freedom. Tap in.",
    "Every tick is a level up.",
    "You don't need motivation. You need to move.",
    "Legends are built 10 minutes at a time.",
    "Your character is leveling up. Claim the XP.",
    "Win the next 60 seconds.",
    "The best version of you is one tap away.",
    "No zero days.",
    "Focus beats talent. Commit.",
    "Keep the promise you made to yourself.",
    "You are not behind. You are becoming.",
    "Today's quest is waiting. Press play.",
    "Confidence is built. Start building.",
    "Level up in real life.",
]


def _server_pick_motivation() -> str:
    import random as _r
    return _r.choice(_SERVER_MOTIVATIONAL_LINES)


async def _push_send_bool_wrapper(token: str, title: str, body: str, data: dict | None = None) -> bool:
    """Adapter that turns _send_expo_push's dict response into a bool
    for the scheduler module's typed signature."""
    res = await _send_expo_push(token, title, body, data)
    return bool(res and res.get("ok"))


@app.on_event("startup")
async def _start_notification_scheduler():
    if _init_notif_scheduler is None:
        return
    try:
        _init_notif_scheduler(
            db=db,
            send_push=_push_send_bool_wrapper,
            pick_motivation=_server_pick_motivation,
        )
    except Exception as e:
        logger.warning("[scheduler] start failed: %s", e)


@app.on_event("shutdown")
async def _stop_notification_scheduler():
    if _shutdown_notif_scheduler is None:
        return
    try:
        _shutdown_notif_scheduler()
    except Exception:
        pass


# Re-attach api_router so endpoints declared after the original include
# (admin-seed, catalog) are reachable.
app.include_router(api_router)


# ── Admin scheduler diagnostics ──────────────────────────────────────
# These endpoints only respond for admins and are aimed at the
# operator: "is the scheduler running? what jobs? when's the next run?".
# They are useful both during dev and during a live incident.
@api_router.get("/admin/scheduler/status")
async def admin_scheduler_status(user_id: str = Depends(get_user_or_legacy)):
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Admin only")
    try:
        from notif_scheduler import scheduler as _sched
    except Exception:
        return {"running": False, "jobs": []}
    if _sched is None:
        return {"running": False, "jobs": []}
    jobs = []
    try:
        for j in _sched.get_jobs():
            jobs.append({
                "id": j.id,
                "name": j.name,
                "next_run_time": j.next_run_time.isoformat() if j.next_run_time else None,
                "trigger": str(j.trigger),
                "max_instances": getattr(j, "max_instances", None),
            })
    except Exception as e:
        logger.warning("[scheduler.status] %s", e)
    return {"running": _sched.running, "jobs": jobs}


@api_router.post("/admin/scheduler/test-push")
async def admin_scheduler_test_push(
    body: dict, user_id: str = Depends(get_user_or_legacy),
):
    """Send an immediate push to a target user (or self) for QA. Body:
    `{user_id?: str, kind?: 'motivation'|'spot_surprise'|'custom',
       title?: str, body?: str}`. Admin-only."""
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Admin only")
    target = (body or {}).get("user_id") or user_id
    kind = (body or {}).get("kind") or "motivation"
    title = (body or {}).get("title")
    msg = (body or {}).get("body")
    if not title or not msg:
        if kind == "spot_surprise":
            title = "🎯 Spot the Object — Surprise Challenge"
            msg = "Tap to start a 60-second hunt before the timer expires."
        else:
            title = "Critique AI · Daily push"
            msg = _server_pick_motivation()
    tokens = await db.push_tokens.find({"user_id": target}).to_list(20)
    sent = 0
    for t in tokens:
        tok = t.get("token")
        if not tok:
            continue
        res = await _send_expo_push(
            tok, title, msg,
            {"kind": kind, "channelId": "spot_surprise" if kind == "spot_surprise" else "motivational"},
        )
        if res and res.get("ok"):
            sent += 1
    return {"target": target, "tokens": len(tokens), "sent": sent, "kind": kind}


@api_router.get("/admin/scheduler/daylight")
async def admin_scheduler_daylight(
    user_id: str = Depends(get_user_or_legacy),
    target_user_id: Optional[str] = None,
):
    """Inspect a user's daylight window and surprise-slot plan for today.
    Useful for verifying the sunrise/sunset calc is sane in production.
    Admin-only."""
    if not await _is_admin_user(user_id):
        raise HTTPException(403, "Admin only")
    target = target_user_id or user_id
    prof = await db.profile.find_one({"_id": target})
    if not prof:
        raise HTTPException(404, "Profile not found")
    try:
        from notif_scheduler import (  # noqa: E402
            _user_daylight_today,
            _is_daylight_now,
            _generate_spot_slots_for_user,
        )
    except Exception as e:
        raise HTTPException(500, f"Scheduler unavailable: {e}")
    sunrise, sunset = _user_daylight_today(prof)
    return {
        "user_id": target,
        "timezone": prof.get("timezone"),
        "now_utc": datetime.now(timezone.utc).isoformat(),
        "sunrise_utc": sunrise.isoformat(),
        "sunset_utc": sunset.isoformat(),
        "is_daylight_now": _is_daylight_now(prof),
        "next_3_random_slots_utc": _generate_spot_slots_for_user(prof),
        "stored_slots": prof.get("spot_random_slots") or [],
        "stored_slots_day": prof.get("spot_random_slots_day"),
        "stored_consumed": prof.get("spot_random_consumed") or [],
    }


@api_router.post("/focus/session")
async def focus_session_complete(
    body: dict, user_id: str = Depends(get_user_or_legacy),
):
    """Record the outcome of a Focus Mode session and apply XP deltas.

    Body:
      {
        planned_minutes: int (1..180),
        actual_seconds: int,         # how many seconds the timer ran before stop
        backgrounded_seconds: int,   # cumulative time the app was in background
        locked_app_seconds: int,     # cumulative time the user was inside a
                                     #  locked-blocklist app (Android only;
                                     #  detected via UsageStatsManager).
        completed: bool,             # True iff timer reached 0
        committed_app_count: int,
      }

    XP rules:
      - On COMPLETION (with no locked-app time):
          +1 XP per 5 planned minutes (min 1, max 30) bonus.
      - PENALTY: -15 XP per MINUTE the user spent inside a locked app
        (rounded down). This applies whether or not the session
        completed — opening a locked app is the violation.
      - Backwards compat: if no `locked_app_seconds` is sent (older builds
        / iOS), fall back to the legacy -2 XP/min on `backgrounded_seconds`
        for early exits so iOS users still get a softer accountability hit.
      - Total penalty capped to -300 XP so a single bad session can hurt
        but won't permanently devastate progress.
    """
    prof = await db.profile.find_one({"_id": user_id})
    if not prof:
        raise HTTPException(404, "Profile not found")

    try:
        planned_min = int(body.get("planned_minutes") or 0)
        actual_sec = int(body.get("actual_seconds") or 0)
        bg_sec = int(body.get("backgrounded_seconds") or 0)
        # NEW: only Android sends this. Default 0 keeps iOS behaviour intact.
        locked_sec = int(body.get("locked_app_seconds") or 0)
        completed = bool(body.get("completed"))
        committed_count = int(body.get("committed_app_count") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid payload")

    if planned_min < 1 or planned_min > 180:
        raise HTTPException(400, "planned_minutes must be 1..180")

    bg_min = bg_sec // 60
    locked_min = locked_sec // 60
    delta = 0
    reason = ""

    # Compute the locked-app penalty FIRST — it always applies, even
    # if the session completed (opening a blocked app is the violation).
    locked_penalty = min(300, locked_min * 15) if locked_min > 0 else 0

    if completed:
        bonus = max(1, min(30, planned_min // 5))
        delta = bonus - locked_penalty
        reason = "focus_complete_with_penalty" if locked_penalty > 0 else "focus_complete"
    elif locked_min > 0:
        # Early exit AND opened locked apps → full -15/min hit.
        delta = -locked_penalty
        reason = "focus_distracted_locked_apps"
    elif bg_min > 0:
        # Legacy fallback (iOS / no usage-stats permission). -2 XP/min.
        delta = -min(50, bg_min * 2)
        reason = "focus_distracted"
    else:
        reason = "focus_cancelled_clean"

    # Update totals.
    if delta != 0:
        new_total = int(prof.get("total_xp", 0) or 0) + delta
        if new_total < 0:
            new_total = 0
        new_level = level_from_xp(new_total)
        await db.profile.update_one(
            {"_id": user_id},
            {"$set": {"total_xp": new_total, "level": new_level}},
        )
        if delta > 0:
            await _log_xp_event(user_id, delta, int(prof.get("tz_offset_minutes") or 0))
            # Focus session bonus → keep streak alive AND show on charts.
            await _bump_streak_for_xp(user_id)
            await _log_xp_to_charts(
                user_id, delta, source="focus_session", focus_area="mindset",
            )

    # Log the session row for history / anti-abuse.
    await db.focus_sessions.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "planned_minutes": planned_min,
        "actual_seconds": actual_sec,
        "backgrounded_seconds": bg_sec,
        "locked_app_seconds": locked_sec,
        "committed_app_count": committed_count,
        "completed": completed,
        "xp_delta": delta,
        "reason": reason,
        "created_at": now_iso(),
    })

    prof = await db.profile.find_one({"_id": user_id})
    return {
        "xp_delta": delta,
        "reason": reason,
        "profile": serialize_profile(prof),
    }


# Final include for any endpoints declared AFTER the previous includes —
# specifically the /admin/scheduler/* diagnostic endpoints above.
app.include_router(api_router)
