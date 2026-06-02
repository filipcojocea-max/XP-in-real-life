"""Iteration 10 — Buried Treasure schedule SYNCED with Work-Scheduler.

Backend regression for:
  - GET  /api/bt/schedule new response shape (source, shift, no sleep_all_day/updated_at)
  - default (scheduler off)
  - scheduler on + day pattern
  - scheduler on + night pattern (wrap-around)
  - POST /api/bt/schedule removed (405/404)
  - regression: /bt/groups/mine, /bt/groups/available, /bt/settings, /bt/solo/current 200
"""
from __future__ import annotations
import asyncio
import os
import datetime as dt
import pytest
import requests

from motor.motor_asyncio import AsyncIOMotorClient

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or "https://emergent-mobile-app-4.preview.emergentagent.com"
).rstrip("/")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"


def _api(p: str) -> str:
    return f"{BASE_URL}{p}"


# ── fixtures ─────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def admin():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(
        _api("/api/auth/login"),
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    js = r.json()
    s.headers.update({"Authorization": f"Bearer {js.get('token')}"})
    s.admin_id = js.get("user", {}).get("id") or js.get("user_id") or js.get("id")
    return s


@pytest.fixture(scope="module")
def loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="module")
def db():
    client = AsyncIOMotorClient(MONGO_URL)
    return client[DB_NAME]


# ── mongo helpers ────────────────────────────────────────────────────
async def _get_profile(db, uid):
    return await db.profile.find_one({"_id": uid})


async def _set_shift_schedule(db, uid, sched):
    if sched is None:
        await db.profile.update_one({"_id": uid}, {"$unset": {"shift_schedule": ""}})
    else:
        await db.profile.update_one({"_id": uid}, {"$set": {"shift_schedule": sched}})


@pytest.fixture
def admin_id(admin, db, loop):
    """Resolve admin user id via DB lookup (email). admin.admin_id may be missing
    depending on /api/auth/login response shape."""
    uid = getattr(admin, "admin_id", None)
    if uid:
        return uid

    async def _find():
        doc = await db.profile.find_one({"email": ADMIN_EMAIL})
        return (doc or {}).get("_id")

    uid = loop.run_until_complete(_find())
    assert uid, "couldn't resolve admin user id"
    return uid


@pytest.fixture
def backup_schedule(admin_id, db, loop):
    """Snapshot the admin profile's shift_schedule before, restore after."""
    async def _get():
        p = await _get_profile(db, admin_id)
        return (p or {}).get("shift_schedule")
    original = loop.run_until_complete(_get())
    yield original
    # restore
    loop.run_until_complete(_set_shift_schedule(db, admin_id, original))


# ── tests ────────────────────────────────────────────────────────────
class TestScheduleShape:
    """Verify new GET /api/bt/schedule response shape."""

    def test_response_shape_basic(self, admin, admin_id, db, loop, backup_schedule):
        # set scheduler OFF so result is deterministic
        loop.run_until_complete(_set_shift_schedule(db, admin_id, {"enabled": False}))
        r = admin.get(_api("/api/bt/schedule"), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "schedule" in body, body
        sch = body["schedule"]
        # required keys
        assert isinstance(sch.get("awake_start"), str)
        assert isinstance(sch.get("awake_end"), str)
        assert sch["source"] in ("scheduler", "default")
        assert sch.get("shift") in ("day", "night", "off", None)
        assert isinstance(sch.get("timezone"), str)
        assert "is_awake_now" in body
        assert isinstance(body["is_awake_now"], bool)
        # removed keys
        assert "sleep_all_day" not in sch, "sleep_all_day should be removed"
        assert "updated_at" not in sch, "updated_at should be removed"
        assert "is_default" not in sch, "is_default should be removed"


class TestScheduleDefault:
    def test_scheduler_off_default_window(self, admin, admin_id, db, loop, backup_schedule):
        loop.run_until_complete(_set_shift_schedule(db, admin_id, {"enabled": False}))
        r = admin.get(_api("/api/bt/schedule"), timeout=15)
        assert r.status_code == 200, r.text
        sch = r.json()["schedule"]
        assert sch["source"] == "default", sch
        assert sch["awake_start"] == "08:00", sch
        assert sch["awake_end"] == "23:00", sch
        assert sch["shift"] is None, sch


class TestScheduleScheduler:
    def test_day_shift_pattern(self, admin, admin_id, db, loop, backup_schedule):
        today_iso = dt.date.today().isoformat()
        sched = {
            "enabled": True,
            "pattern_kind": "rotating",
            "setup_complete": True,
            "pattern": ["day"],
            "pattern_start_date": today_iso,
            "shifts": {
                "day": {"start_time": "06:00", "sleep_time": "22:00", "icon": "🌅", "color": "#FFA726"},
                "night": {"start_time": "14:00", "sleep_time": "06:00", "icon": "🌃", "color": "#1E3A8A"},
                "off": {"start_time": "09:00", "sleep_time": "23:00", "icon": "☕", "color": "#22C55E"},
            },
            "manual_overrides": {},
        }
        loop.run_until_complete(_set_shift_schedule(db, admin_id, sched))
        r = admin.get(_api("/api/bt/schedule"), timeout=15)
        assert r.status_code == 200, r.text
        sch = r.json()["schedule"]
        assert sch["source"] == "scheduler", sch
        assert sch["shift"] == "day", sch
        assert sch["awake_start"] == "06:00", sch
        assert sch["awake_end"] == "22:00", sch

    def test_night_shift_wrap_around(self, admin, admin_id, db, loop, backup_schedule):
        today_iso = dt.date.today().isoformat()
        sched = {
            "enabled": True,
            "pattern_kind": "rotating",
            "setup_complete": True,
            "pattern": ["night"],
            "pattern_start_date": today_iso,
            "shifts": {
                "day": {"start_time": "06:00", "sleep_time": "22:00", "icon": "🌅", "color": "#FFA726"},
                "night": {"start_time": "14:00", "sleep_time": "06:00", "icon": "🌃", "color": "#1E3A8A"},
                "off": {"start_time": "09:00", "sleep_time": "23:00", "icon": "☕", "color": "#22C55E"},
            },
            "manual_overrides": {},
        }
        loop.run_until_complete(_set_shift_schedule(db, admin_id, sched))
        r = admin.get(_api("/api/bt/schedule"), timeout=15)
        assert r.status_code == 200, r.text
        sch = r.json()["schedule"]
        assert sch["source"] == "scheduler", sch
        assert sch["shift"] == "night", sch
        assert sch["awake_start"] == "14:00", sch
        assert sch["awake_end"] == "06:00", sch


class TestPostRemoved:
    def test_post_schedule_returns_405_or_404(self, admin):
        r = admin.post(
            _api("/api/bt/schedule"),
            json={"awake_start": "08:00", "awake_end": "23:00", "timezone": "UTC"},
            timeout=15,
        )
        assert r.status_code in (404, 405), (
            f"POST /api/bt/schedule should be removed, got {r.status_code}: {r.text[:200]}"
        )


class TestRegression:
    def test_groups_mine_200(self, admin):
        r = admin.get(_api("/api/bt/groups/mine"), timeout=15)
        assert r.status_code == 200, r.text
        assert "groups" in r.json()

    def test_groups_available_200(self, admin):
        r = admin.get(_api("/api/bt/groups/available"), timeout=15)
        assert r.status_code == 200, r.text
        assert "groups" in r.json()

    def test_bt_settings_200(self, admin):
        r = admin.get(_api("/api/bt/settings"), timeout=15)
        assert r.status_code == 200, r.text

    def test_bt_solo_current_200(self, admin):
        r = admin.get(_api("/api/bt/solo/current"), timeout=15)
        assert r.status_code == 200, r.text
        assert "hunt" in r.json()
