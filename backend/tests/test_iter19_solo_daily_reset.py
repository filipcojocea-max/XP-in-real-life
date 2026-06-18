"""Iteration 19 — Solo daily-reset for Buried Treasure.

Validates the on-demand daily-reset closure `_maybe_reset_solo_impl`
inside `buried_treasure.attach_routes()` plus the new
`_rotation_failsafe_tick` background scheduler in server.py.

Scenarios
---------
1. solo_start → force past next_reset_at → /bt/solo/current resets chest.
2. No premature reset — 3x /bt/solo/current with fresh future next_reset_at
   must not change coords.
3. /bt/solo/compass also triggers reset.
4. Backfill — `$unset next_reset_at` must stamp a new one without rolling
   the chest.
5. Background tick is running — startup log + process alive after 70s.
6. Regression — /api/penalties/pending, /api/chat/preferences,
   /api/active-boost, /api/boost/inventory, /api/spot/finds,
   /api/bt/no-go-zones (admin), POST /api/tasks honors goal_quest_max,
   /api/bt/settings.
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from datetime import datetime, timezone

import pytest
import requests
from pymongo import MongoClient

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
).rstrip("/")

# The public ingress times out at ~100s, but solo_start can take 80-100s
# because Overpass primary mirror is currently returning 406 (infra issue,
# not introduced by iter19). For the solo endpoints which hit Overpass we
# go through localhost:8001 (no gateway timeout) so we can still validate
# the daily-reset logic end-to-end. Regression endpoints (fast) stay on
# the public URL.
INTERNAL_URL = os.environ.get("INTERNAL_BACKEND_URL", "http://localhost:8001").rstrip("/")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

TIMEOUT = 30
# solo_start hits Overpass (can be slow / 406 from primary mirror), so give it more time
LONG_TIMEOUT = 180
SYDNEY = {"lat": -33.86, "lng": 151.21, "radius_m": 1500}


# ────────────────────────── helpers ──────────────────────────


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _login(email: str, password: str) -> dict:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    body = r.json()
    return {"token": body["token"], "user_id": body["user"]["id"]}


def _register_fresh_user(label: str) -> dict:
    email = f"test_{label}_{uuid.uuid4().hex[:10]}@gmail.com"
    password = "TestPass!123"
    r = requests.post(
        f"{BASE_URL}/api/auth/register",
        json={"email": email, "password": password, "full_name": f"Test {label}"},
        timeout=TIMEOUT,
    )
    if r.status_code != 200:
        pytest.skip(f"register failed: {r.status_code} {r.text[:200]}")
    body = r.json()
    return {
        "token": body["token"],
        "user_id": body["user"]["id"],
        "email": email,
    }


def _post_location(token: str, lat: float, lng: float):
    r = requests.post(
        f"{BASE_URL}/api/bt/location",
        json={"lat": lat, "lng": lng},
        headers=_headers(token),
        timeout=TIMEOUT,
    )
    assert r.status_code == 200, f"location update failed: {r.status_code} {r.text[:200]}"


def _solo_start(token: str) -> dict:
    r = requests.post(
        f"{INTERNAL_URL}/api/bt/solo/start",
        json=SYDNEY,
        headers=_headers(token),
        timeout=LONG_TIMEOUT,
    )
    assert r.status_code == 200, f"solo_start failed: {r.status_code} {r.text[:200]}"
    return r.json()


def _solo_current(token: str, *, internal: bool = False) -> dict:
    base = INTERNAL_URL if internal else BASE_URL
    r = requests.get(
        f"{base}/api/bt/solo/current",
        headers=_headers(token),
        timeout=LONG_TIMEOUT,
    )
    assert r.status_code == 200, f"solo_current failed: {r.status_code} {r.text[:200]}"
    return r.json()


def _solo_compass(token: str, lat: float, lng: float, *, internal: bool = False) -> requests.Response:
    base = INTERNAL_URL if internal else BASE_URL
    return requests.get(
        f"{base}/api/bt/solo/compass",
        params={"lat": lat, "lng": lng},
        headers=_headers(token),
        timeout=LONG_TIMEOUT,
    )


# ────────────────────────── fixtures ──────────────────────────


@pytest.fixture(scope="module")
def admin_session():
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture()
def mongo_db():
    """Sync pymongo client — Motor's event loop binding doesn't survive
    multiple asyncio.run() calls so we use pymongo directly."""
    client = MongoClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


def _run(coro):
    return asyncio.run(coro)


def _force_past_reset(db, user_id: str):
    db.bt_solo.update_one(
        {"_id": user_id},
        {"$set": {"next_reset_at": "2020-01-01T00:00:00+00:00"}},
    )


def _unset_reset(db, user_id: str):
    db.bt_solo.update_one({"_id": user_id}, {"$unset": {"next_reset_at": ""}})


def _fetch_solo_doc(db, user_id: str):
    return db.bt_solo.find_one({"_id": user_id})


def _cleanup_user(db, user_id: str):
    db.bt_solo.delete_one({"_id": user_id})
    db.bt_player_location.delete_one({"_id": user_id})
    db.bt_solo_finds.delete_many({"user_id": user_id})


# ────────────────────────── tests ──────────────────────────


class TestSoloDailyReset:
    """Daily-reset closure inside attach_routes()."""

    def test_reset_via_solo_current(self, mongo_db):
        user = _register_fresh_user("reset_current")
        try:
            _post_location(user["token"], SYDNEY["lat"], SYDNEY["lng"])
            initial = _solo_start(user["token"])
            assert "chest_lat" in initial and "chest_lng" in initial, initial
            init_lat, init_lng = initial["chest_lat"], initial["chest_lng"]

            doc0 = _fetch_solo_doc(mongo_db, user["user_id"])
            assert doc0 is not None
            assert doc0.get("next_reset_at"), "next_reset_at should be stamped on solo_start"

            # Force the reset window into the past
            _force_past_reset(mongo_db, user["user_id"])

            after = _solo_current(user["token"], internal=True)
            hunt = after.get("hunt") or {}
            assert hunt, after
            # Either chest moved or doc shows auto_reset True + refreshed timestamps
            new_lat = hunt.get("chest_lat")
            new_lng = hunt.get("chest_lng")
            doc1 = _fetch_solo_doc(mongo_db, user["user_id"])
            assert doc1 is not None
            assert doc1.get("auto_reset") is True, f"auto_reset flag missing: {doc1}"
            assert doc1.get("next_reset_at") != "2020-01-01T00:00:00+00:00", "next_reset_at not refreshed"
            assert doc1.get("buried_at") != doc0.get("buried_at"), "buried_at not refreshed"
            # Coords usually change (strict-green pick is randomised), but the
            # primary contract is that the doc was refreshed. Log if coords match.
            if new_lat == init_lat and new_lng == init_lng:
                print(f"[note] chest coords unchanged after reset ({new_lat},{new_lng}); doc refresh OK")
        finally:
            _cleanup_user(mongo_db, user["user_id"])

    def test_no_premature_reset(self, mongo_db):
        user = _register_fresh_user("no_premature")
        try:
            _post_location(user["token"], SYDNEY["lat"], SYDNEY["lng"])
            initial = _solo_start(user["token"])
            lat, lng = initial["chest_lat"], initial["chest_lng"]

            for i in range(3):
                hunt = _solo_current(user["token"])["hunt"]
                assert hunt["chest_lat"] == lat, f"chest_lat changed on call {i}"
                assert hunt["chest_lng"] == lng, f"chest_lng changed on call {i}"
        finally:
            _cleanup_user(mongo_db, user["user_id"])

    def test_reset_via_solo_compass(self, mongo_db):
        user = _register_fresh_user("reset_compass")
        try:
            _post_location(user["token"], SYDNEY["lat"], SYDNEY["lng"])
            initial = _solo_start(user["token"])
            assert "chest_lat" in initial
            doc0 = _fetch_solo_doc(mongo_db, user["user_id"])
            buried0 = doc0.get("buried_at")

            _force_past_reset(mongo_db, user["user_id"])

            r = _solo_compass(user["token"], SYDNEY["lat"], SYDNEY["lng"], internal=True)
            assert r.status_code == 200, f"compass failed: {r.status_code} {r.text[:200]}"

            doc1 = _fetch_solo_doc(mongo_db, user["user_id"])
            assert doc1.get("auto_reset") is True, f"compass did not trigger reset: {doc1}"
            assert doc1.get("buried_at") != buried0, "buried_at not refreshed by compass call"
            assert doc1.get("next_reset_at") != "2020-01-01T00:00:00+00:00"

            # Re-fetch via /current to confirm consistency
            cur = _solo_current(user["token"])["hunt"]
            assert cur["chest_lat"] == doc1["chest"]["lat"]
            assert cur["chest_lng"] == doc1["chest"]["lng"]
        finally:
            _cleanup_user(mongo_db, user["user_id"])

    def test_backfill_when_no_next_reset_at(self, mongo_db):
        user = _register_fresh_user("backfill")
        try:
            _post_location(user["token"], SYDNEY["lat"], SYDNEY["lng"])
            initial = _solo_start(user["token"])
            init_lat, init_lng = initial["chest_lat"], initial["chest_lng"]

            _unset_reset(mongo_db, user["user_id"])
            doc0 = _fetch_solo_doc(mongo_db, user["user_id"])
            assert "next_reset_at" not in doc0 or not doc0.get("next_reset_at")

            hunt = _solo_current(user["token"])["hunt"]
            # Backfill must NOT change chest coords
            assert hunt["chest_lat"] == init_lat, "backfill must not move chest"
            assert hunt["chest_lng"] == init_lng, "backfill must not move chest"

            doc1 = _fetch_solo_doc(mongo_db, user["user_id"])
            assert doc1.get("next_reset_at"), "next_reset_at should have been backfilled"
            # auto_reset must not be set on backfill (no actual reset happened)
            assert not doc1.get("auto_reset"), "auto_reset must not be set on backfill"
        finally:
            _cleanup_user(mongo_db, user["user_id"])


class TestBackgroundTick:
    def test_startup_log_present(self):
        # Read backend log and ensure tick scheduling message was logged at least once
        candidates = [
            "/var/log/supervisor/backend.err.log",
            "/var/log/supervisor/backend.out.log",
        ]
        found = False
        for path in candidates:
            if not os.path.exists(path):
                continue
            with open(path, "r", errors="ignore") as f:
                if "Buried Treasure rotation tick scheduled (60s)" in f.read():
                    found = True
                    break
        assert found, "Startup log message for tick scheduler not found"

    def test_process_alive_after_70s(self):
        # Quick health check at t=0 and t=70s — backend must remain responsive
        r0 = requests.get(f"{BASE_URL}/api/", timeout=TIMEOUT)
        assert r0.status_code in (200, 404, 405), f"backend down at t=0: {r0.status_code}"
        time.sleep(70)
        r1 = requests.get(f"{BASE_URL}/api/", timeout=TIMEOUT)
        assert r1.status_code in (200, 404, 405), f"backend died after 70s: {r1.status_code}"


class TestRegression:
    def test_penalties_pending(self, admin_session):
        r = requests.get(
            f"{BASE_URL}/api/penalties/pending",
            headers=_headers(admin_session["token"]),
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, f"/penalties/pending: {r.status_code} {r.text[:200]}"

    def test_chat_preferences(self, admin_session):
        r = requests.get(
            f"{BASE_URL}/api/chat/preferences",
            headers=_headers(admin_session["token"]),
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, f"/chat/preferences: {r.status_code} {r.text[:200]}"

    def test_active_boost(self, admin_session):
        r = requests.get(
            f"{BASE_URL}/api/active-boost",
            headers=_headers(admin_session["token"]),
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, f"/active-boost: {r.status_code} {r.text[:200]}"

    def test_boost_inventory(self, admin_session):
        r = requests.get(
            f"{BASE_URL}/api/boost/inventory",
            headers=_headers(admin_session["token"]),
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, f"/boost/inventory: {r.status_code} {r.text[:200]}"

    def test_spot_finds(self, admin_session):
        r = requests.get(
            f"{BASE_URL}/api/spot/finds",
            headers=_headers(admin_session["token"]),
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, f"/spot/finds: {r.status_code} {r.text[:200]}"

    def test_no_go_zones_admin(self, admin_session):
        r = requests.get(
            f"{BASE_URL}/api/bt/no-go-zones",
            headers=_headers(admin_session["token"]),
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, f"/bt/no-go-zones: {r.status_code} {r.text[:200]}"

    def test_bt_settings(self, admin_session):
        r = requests.get(
            f"{BASE_URL}/api/bt/settings",
            headers=_headers(admin_session["token"]),
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, f"/bt/settings: {r.status_code} {r.text[:200]}"

    def test_quest_cap_default(self, mongo_db):
        """Fresh user with default goal_quest_max=11 — 12th POST must fail."""
        user = _register_fresh_user("quest_cap")
        try:
            created = 0
            for i in range(11):
                r = requests.post(
                    f"{BASE_URL}/api/tasks",
                    json={
                        "title": f"TEST_iter19_quest_{i}_{uuid.uuid4().hex[:6]}",
                        "description": "iter19 quest cap regression",
                        "focus_area": "mindset",
                        "time_slot": "morning",
                        "xp_value": 10,
                        "recurring": True,
                        "reminder_enabled": False,
                    },
                    headers=_headers(user["token"]),
                    timeout=TIMEOUT,
                )
                if r.status_code == 200:
                    created += 1
                else:
                    print(f"[quest_cap] iter {i} failed: {r.status_code} {r.text[:200]}")
                    break
            assert created == 11, f"default cap should allow 11; got {created}"

            r12 = requests.post(
                f"{BASE_URL}/api/tasks",
                json={
                    "title": f"TEST_iter19_quest_over_{uuid.uuid4().hex[:6]}",
                    "description": "should fail",
                    "focus_area": "mindset",
                    "time_slot": "morning",
                    "xp_value": 10,
                    "recurring": True,
                    "reminder_enabled": False,
                },
                headers=_headers(user["token"]),
                timeout=TIMEOUT,
            )
            assert r12.status_code == 400, f"12th quest should be 400, got {r12.status_code}: {r12.text[:200]}"
        finally:
            mongo_db.tasks.delete_many({"user_id": user["user_id"]})
