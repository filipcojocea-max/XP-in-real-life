"""Backend regression for iteration 6 (Buried Treasure redesign + Leaflet swap).

No new endpoints this round — we just verify the BT endpoints the new
home screen relies on still respond 200 with the expected shape:

  • GET  /api/bt/settings
  • POST /api/bt/settings           (lat/lng/radius_m)
  • GET  /api/bt/groups/available   -> {groups:[...]}
  • GET  /api/bt/groups/mine        -> {groups:[...]}
  • POST /api/bt/groups/create      -> created group
  • GET  /api/bt/schedule
  • POST /api/bt/schedule
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
).rstrip("/")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

SYDNEY = (-33.8688, 151.2093)


def _api(p): return f"{BASE_URL}{p}"


@pytest.fixture(scope="module")
def admin():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(_api("/api/auth/login"),
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    tok = r.json()["token"]
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


class TestBTSettings:
    def test_get_settings_200(self, admin):
        r = admin.get(_api("/api/bt/settings"), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "area" in body  # may be None or dict with lat/lng/radius_m

    def test_post_settings_saves_area(self, admin):
        payload = {"lat": SYDNEY[0], "lng": SYDNEY[1], "radius_m": 1200}
        r = admin.post(_api("/api/bt/settings"), json=payload, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        # Verify persisted via GET
        g = admin.get(_api("/api/bt/settings"), timeout=15)
        assert g.status_code == 200
        area = g.json().get("area")
        assert area is not None
        assert abs(area["lat"] - SYDNEY[0]) < 1e-6
        assert abs(area["lng"] - SYDNEY[1]) < 1e-6
        assert area["radius_m"] == 1200


class TestBTGroupsLists:
    def test_groups_mine_200(self, admin):
        r = admin.get(_api("/api/bt/groups/mine"), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "groups" in body
        assert isinstance(body["groups"], list)

    def test_groups_available_200(self, admin):
        r = admin.get(_api("/api/bt/groups/available"), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "groups" in body
        assert isinstance(body["groups"], list)


class TestBTGroupsCreate:
    def test_create_group_returns_created(self, admin):
        name = f"TEST_iter6_{uuid.uuid4().hex[:6]}"
        r = admin.post(_api("/api/bt/groups/create"),
                       json={"name": name,
                             "lat": SYDNEY[0], "lng": SYDNEY[1],
                             "radius_m": 1000}, timeout=15)
        assert r.status_code == 200, r.text
        g = r.json()
        assert g["name"] == name
        assert g["status"] == "lobby"
        assert g["is_creator"] is True
        assert g["code"] and len(g["code"]) == 6
        assert g["area"]["radius_m"] == 1000
        # Should now appear in /mine
        mine = admin.get(_api("/api/bt/groups/mine"), timeout=15).json()["groups"]
        assert any(x["id"] == g["id"] for x in mine)


class TestBTSchedule:
    def test_get_schedule_200(self, admin):
        r = admin.get(_api("/api/bt/schedule"), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "schedule" in body
        assert "is_awake_now" in body
        s = body["schedule"]
        for k in ("awake_start", "awake_end", "sleep_all_day", "timezone", "is_default"):
            assert k in s

    def test_post_schedule_200(self, admin):
        r = admin.post(_api("/api/bt/schedule"),
                       json={"awake_start": "08:00", "awake_end": "23:00",
                             "sleep_all_day": False,
                             "timezone": "America/New_York"}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["schedule"]["awake_start"] == "08:00"
        assert body["schedule"]["awake_end"] == "23:00"
