"""Backend regression for Buried Treasure Steps 2 & 3 (Jan 2026).

Covers:
  • /api/bt/schedule  GET + POST (Smart Availability / Awake-Hours)
  • /api/bt/groups/{gid}/toggle  + /api/bt/groups/prefs (Group Notif Toggle)
  • is_active_now field on /api/bt/groups/{mine,available}
  • Regression of /api/bt/settings + /api/bt/solo/current
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or "https://emergent-mobile-app-4.preview.emergentagent.com"
).rstrip("/")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

NYC = (40.7128, -74.006)


def _api(path: str) -> str:
    return f"{BASE_URL}{path}"


def _login(email: str, password: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(_api("/api/auth/login"),
               json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:300]}"
    tok = r.json().get("token")
    assert tok
    s.headers.update({"Authorization": f"Bearer {tok}"})
    s.user_id = r.json()["user"]["id"]
    return s


def _register_helper() -> requests.Session:
    email = f"TEST_btst_{uuid.uuid4().hex[:10]}@gmail.com"
    pw = "TestPass!123"
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(_api("/api/auth/register"),
               json={"email": email, "password": pw, "full_name": "TEST BT Helper"},
               timeout=30)
    if r.status_code != 200:
        pytest.skip(f"could not register helper user: {r.status_code} {r.text[:200]}")
    tok = r.json()["token"]
    s.headers.update({"Authorization": f"Bearer {tok}"})
    s.user_id = r.json()["user"]["id"]
    return s


@pytest.fixture(scope="module")
def admin() -> requests.Session:
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="module")
def helper() -> requests.Session:
    return _register_helper()


# ─────────────────────────────────────────────────────────────────────
# Step 3 — /api/bt/schedule (Awake-Hours / Smart Availability)
# ─────────────────────────────────────────────────────────────────────
class TestSchedule:
    def test_get_schedule_default_when_unsaved(self, admin):
        """First GET (with no doc saved or after a reset) returns defaults.
        Note: admin may have a saved doc from earlier test runs; we
        validate the shape + sensible defaults regardless."""
        r = admin.get(_api("/api/bt/schedule"), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        sched = body.get("schedule") or {}
        assert "awake_start" in sched
        assert "awake_end" in sched
        assert "sleep_all_day" in sched
        assert "timezone" in sched
        assert "is_default" in sched
        assert "is_awake_now" in body
        assert isinstance(body["is_awake_now"], bool)
        # default values must use HH:MM strings
        assert len(sched["awake_start"]) == 5
        assert len(sched["awake_end"]) == 5

    def test_post_schedule_persists_values(self, admin):
        payload = {
            "awake_start": "09:30",
            "awake_end": "22:00",
            "sleep_all_day": False,
            "timezone": "America/New_York",
        }
        r = admin.post(_api("/api/bt/schedule"), json=payload, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        sched = body["schedule"]
        assert sched["awake_start"] == "09:30"
        assert sched["awake_end"] == "22:00"
        assert sched["sleep_all_day"] is False
        assert sched["timezone"] == "America/New_York"

        # GET reflects saved values, is_default=False
        r2 = admin.get(_api("/api/bt/schedule"), timeout=15)
        assert r2.status_code == 200
        s2 = r2.json()["schedule"]
        assert s2["awake_start"] == "09:30"
        assert s2["awake_end"] == "22:00"
        assert s2["sleep_all_day"] is False
        assert s2["timezone"] == "America/New_York"
        assert s2["is_default"] is False

    def test_sleep_all_day_overrides_is_awake_now(self, admin):
        r = admin.post(_api("/api/bt/schedule"),
                       json={"sleep_all_day": True,
                             "awake_start": "09:00",
                             "awake_end": "21:00",
                             "timezone": "America/New_York"},
                       timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["is_awake_now"] is False
        assert body["schedule"]["sleep_all_day"] is True

        # GET should also report is_awake_now=False
        g = admin.get(_api("/api/bt/schedule"), timeout=15).json()
        assert g["is_awake_now"] is False

    def test_garbage_hhmm_coerces_to_default(self, admin):
        # First flip off sleep_all_day so is_awake_now reflects window
        r = admin.post(_api("/api/bt/schedule"),
                       json={"awake_start": "not-a-time",
                             "awake_end": "also-bad",
                             "sleep_all_day": False,
                             "timezone": "America/New_York"},
                       timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        sched = body["schedule"]
        # Garbage should coerce to defaults 08:00/23:00
        assert sched["awake_start"] == "08:00"
        assert sched["awake_end"] == "23:00"

    def test_wrap_around_window_accepted(self, admin):
        r = admin.post(_api("/api/bt/schedule"),
                       json={"awake_start": "22:00",
                             "awake_end": "06:00",
                             "sleep_all_day": False,
                             "timezone": "America/New_York"},
                       timeout=15)
        assert r.status_code == 200, r.text
        sched = r.json()["schedule"]
        assert sched["awake_start"] == "22:00"
        assert sched["awake_end"] == "06:00"

    def test_invalid_timezone_falls_back_silently(self, admin):
        r = admin.post(_api("/api/bt/schedule"),
                       json={"awake_start": "08:00",
                             "awake_end": "23:00",
                             "sleep_all_day": False,
                             "timezone": "Not/A_RealZone"},
                       timeout=15)
        # Should not 500 — bad tz is silently dropped
        assert r.status_code == 200, r.text
        # Restore to a known-good tz for downstream tests
        admin.post(_api("/api/bt/schedule"),
                   json={"awake_start": "08:00", "awake_end": "23:00",
                         "sleep_all_day": False,
                         "timezone": "America/New_York"}, timeout=15)


# ─────────────────────────────────────────────────────────────────────
# Step 2 — Group Notification Toggle
# ─────────────────────────────────────────────────────────────────────
class TestGroupToggle:
    @classmethod
    def _create_group(cls, admin):
        r = admin.post(_api("/api/bt/groups/create"),
                       json={"name": f"TEST_tg_{uuid.uuid4().hex[:6]}",
                             "lat": NYC[0], "lng": NYC[1],
                             "radius_m": 800}, timeout=15)
        assert r.status_code == 200, r.text
        return r.json()

    def test_toggle_off_then_prefs_reflects(self, admin):
        g = self._create_group(admin)
        gid = g["id"]
        TestGroupToggle.gid = gid

        r = admin.post(_api(f"/api/bt/groups/{gid}/toggle"),
                       json={"enabled": False}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["enabled"] is False

        prefs = admin.get(_api("/api/bt/groups/prefs"), timeout=15)
        assert prefs.status_code == 200, prefs.text
        prefs_map = prefs.json().get("prefs") or {}
        assert gid in prefs_map
        assert prefs_map[gid] is False

    def test_toggle_back_on(self, admin):
        gid = TestGroupToggle.gid
        r = admin.post(_api(f"/api/bt/groups/{gid}/toggle"),
                       json={"enabled": True}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["enabled"] is True

        prefs = admin.get(_api("/api/bt/groups/prefs"), timeout=15).json()["prefs"]
        assert prefs.get(gid) is True

    def test_toggle_unknown_group_404(self, admin):
        r = admin.post(_api(f"/api/bt/groups/{uuid.uuid4()}/toggle"),
                       json={"enabled": False}, timeout=15)
        assert r.status_code == 404, r.text

    def test_toggle_non_member_403(self, admin, helper):
        # admin creates fresh group; helper is not a member.
        g = self._create_group(admin)
        r = helper.post(_api(f"/api/bt/groups/{g['id']}/toggle"),
                        json={"enabled": False}, timeout=15)
        assert r.status_code == 403, r.text


# ─────────────────────────────────────────────────────────────────────
# Step 3 — is_active_now exposed on group endpoints
# ─────────────────────────────────────────────────────────────────────
class TestIsActiveNowSerialization:
    def test_groups_mine_has_is_active_now(self, admin):
        # Ensure admin is awake all day so at least one group is active.
        admin.post(_api("/api/bt/schedule"),
                   json={"awake_start": "00:00", "awake_end": "23:59",
                         "sleep_all_day": False,
                         "timezone": "America/New_York"}, timeout=15)
        r = admin.get(_api("/api/bt/groups/mine"), timeout=15)
        assert r.status_code == 200, r.text
        groups = r.json()["groups"]
        assert isinstance(groups, list)
        if not groups:
            pytest.skip("admin has no groups; cannot verify is_active_now serialization")
        for g in groups:
            assert "is_active_now" in g, f"missing field in {g}"
            assert isinstance(g["is_active_now"], bool)

    def test_groups_available_returns_200_with_field(self, admin):
        r = admin.get(_api("/api/bt/groups/available"), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "groups" in body
        assert isinstance(body["groups"], list)
        for g in body["groups"]:
            assert "is_active_now" in g
            assert isinstance(g["is_active_now"], bool)

    def test_sleep_all_day_endpoint_still_200(self, admin):
        # Set sleep_all_day=True; /available endpoint must still 200.
        admin.post(_api("/api/bt/schedule"),
                   json={"sleep_all_day": True,
                         "awake_start": "08:00", "awake_end": "23:00",
                         "timezone": "America/New_York"}, timeout=15)
        r = admin.get(_api("/api/bt/groups/available"), timeout=15)
        assert r.status_code == 200, r.text
        # Restore default
        admin.post(_api("/api/bt/schedule"),
                   json={"awake_start": "08:00", "awake_end": "23:00",
                         "sleep_all_day": False,
                         "timezone": "America/New_York"}, timeout=15)


# ─────────────────────────────────────────────────────────────────────
# Regression — existing BT endpoints still 200
# ─────────────────────────────────────────────────────────────────────
class TestRegression:
    def test_bt_settings_get_200(self, admin):
        r = admin.get(_api("/api/bt/settings"), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "area" in body  # may be None or dict

    def test_bt_solo_current_200(self, admin):
        r = admin.get(_api("/api/bt/solo/current"), timeout=15)
        assert r.status_code == 200, r.text
        assert "hunt" in r.json()

    def test_bt_groups_mine_200(self, admin):
        r = admin.get(_api("/api/bt/groups/mine"), timeout=15)
        assert r.status_code == 200, r.text
        assert "groups" in r.json()
