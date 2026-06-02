"""Iteration 8 regression — Buried Treasure map clue + daily gate backend.

Verifies:
1. POST /api/bt/solo/start → 200, response contains chest_lat/chest_lng inside area.
2. GET /api/bt/solo/current → 200 with hunt payload that exposes chest_lat,
   chest_lng (both floats) AND existing keys (area, user_id, status, created_at).
3. GET /api/bt/solo/compass returns previous shape.
4. Regression on /bt/groups/mine, /bt/groups/available, /bt/schedule GET/POST.
"""
from __future__ import annotations
import math
import os
import pytest
import requests

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL")
            or os.environ.get("EXPO_BACKEND_URL")
            or "https://emergent-mobile-app-4.preview.emergentagent.com").rstrip("/")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"
SYDNEY = (-33.8688, 151.2093)
RADIUS_M = 800


def _api(p: str) -> str:
    return f"{BASE_URL}{p}"


def _haversine_m(lat1, lng1, lat2, lng2):
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


@pytest.fixture(scope="module")
def admin():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(_api("/api/auth/login"),
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    tok = r.json().get("token")
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


# ── Solo start exposes chest coords ───────────────────────────────────
class TestSoloStartChestCoords:
    def test_start_returns_chest_coords_inside_area(self, admin):
        r = admin.post(_api("/api/bt/solo/start"),
                       json={"lat": SYDNEY[0], "lng": SYDNEY[1], "radius_m": RADIUS_M},
                       timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        # New chest coords should be present on the start response too.
        assert "chest_lat" in body and "chest_lng" in body, body
        assert isinstance(body["chest_lat"], (int, float))
        assert isinstance(body["chest_lng"], (int, float))
        # And they must lie inside the requested area (+ small slack).
        d = _haversine_m(SYDNEY[0], SYDNEY[1], body["chest_lat"], body["chest_lng"])
        assert d <= RADIUS_M + 10, f"chest {d:.1f}m outside {RADIUS_M}m area"
        # Existing shape preserved.
        assert body["user_id"]
        assert body["status"] == "active"
        assert body["area"]["radius_m"] == RADIUS_M
        assert body["created_at"]

    def test_solo_current_includes_chest_coords(self, admin):
        # Make sure there's an active hunt.
        admin.post(_api("/api/bt/solo/start"),
                   json={"lat": SYDNEY[0], "lng": SYDNEY[1], "radius_m": RADIUS_M},
                   timeout=15)
        r = admin.get(_api("/api/bt/solo/current"), timeout=15)
        assert r.status_code == 200, r.text
        hunt = r.json().get("hunt")
        assert hunt is not None
        # Existing keys
        for k in ("area", "user_id", "status", "created_at"):
            assert k in hunt, f"missing {k} in {hunt}"
        # NEW keys
        assert "chest_lat" in hunt, hunt
        assert "chest_lng" in hunt, hunt
        assert isinstance(hunt["chest_lat"], (int, float))
        assert isinstance(hunt["chest_lng"], (int, float))
        d = _haversine_m(SYDNEY[0], SYDNEY[1], hunt["chest_lat"], hunt["chest_lng"])
        assert d <= RADIUS_M + 10, f"chest {d:.1f}m outside {RADIUS_M}m area"


# ── Compass shape regression ──────────────────────────────────────────
class TestCompassShape:
    def test_compass_shape_unchanged(self, admin):
        admin.post(_api("/api/bt/solo/start"),
                   json={"lat": SYDNEY[0], "lng": SYDNEY[1], "radius_m": RADIUS_M},
                   timeout=15)
        r = admin.get(_api("/api/bt/solo/compass"),
                      params={"lat": SYDNEY[0], "lng": SYDNEY[1]}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        for k in ("distance_m", "bearing_deg", "in_find_ring", "find_ring_m"):
            assert k in body
        assert isinstance(body["distance_m"], (int, float))
        assert isinstance(body["bearing_deg"], (int, float))
        assert isinstance(body["in_find_ring"], bool)
        assert body["find_ring_m"] == 15


# ── Regression sweep on other endpoints ───────────────────────────────
class TestRegressionSweep:
    def test_groups_mine(self, admin):
        r = admin.get(_api("/api/bt/groups/mine"), timeout=15)
        assert r.status_code == 200, r.text
        assert "groups" in r.json()

    def test_groups_available(self, admin):
        r = admin.get(_api("/api/bt/groups/available"), timeout=15)
        assert r.status_code == 200, r.text
        assert "groups" in r.json()

    def test_schedule_get(self, admin):
        r = admin.get(_api("/api/bt/schedule"), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "schedule" in body
        assert "awake_start" in body["schedule"]
        assert "awake_end" in body["schedule"]

    def test_schedule_post(self, admin):
        r = admin.post(_api("/api/bt/schedule"),
                       json={"awake_start": "08:00", "awake_end": "23:00",
                             "sleep_all_day": False}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["schedule"]["awake_start"] == "08:00"
        assert body["schedule"]["awake_end"] == "23:00"
