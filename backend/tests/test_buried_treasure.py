"""Backend tests for Buried Treasure mini-app endpoints (/api/bt/*).

Validates the regression surface after the recent frontend crash-fix
operations. Stripe is intentionally disabled and skipped.
"""
import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/") or \
           "https://emergent-mobile-app-4.preview.emergentagent.com"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"


# ── Auth fixture (admin login → JWT) ──
@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
               timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    token = r.json().get("token")
    assert token
    s.headers.update({"Authorization": f"Bearer {token}"})
    return s


# ── /api/bt/location GET — initial state may be set or null ──
class TestBtLocation:
    def test_location_get_returns_envelope(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/bt/location", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "location" in body
        # location is either None or an object — both fine
        loc = body["location"]
        assert loc is None or isinstance(loc, dict)
        # If present, no _id leakage
        if isinstance(loc, dict):
            assert "_id" not in loc

    def test_location_post_persists_and_get_reflects(self, admin_session):
        payload = {
            "lat": -33.8688, "lng": 151.2093,
            "radius_m": 1500,
            "label": "TEST_Sydney",
            "tz_offset_minutes": 600,
        }
        r = admin_session.post(f"{BASE_URL}/api/bt/location",
                               json=payload, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json().get("saved") is True
        # GET to verify persistence
        g = admin_session.get(f"{BASE_URL}/api/bt/location", timeout=15)
        assert g.status_code == 200
        loc = g.json().get("location")
        assert loc is not None
        assert abs(loc["lat"] - payload["lat"]) < 1e-6
        assert abs(loc["lng"] - payload["lng"]) < 1e-6
        assert int(loc["radius_m"]) == payload["radius_m"]
        assert loc.get("tz_offset_minutes") == 600

    def test_location_post_rejects_bad_lat(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/bt/location",
                               json={"lat": 999.0, "lng": 0.0,
                                     "radius_m": 1000},
                               timeout=15)
        assert r.status_code == 400, r.text

    def test_location_post_rejects_tiny_radius(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/bt/location",
                               json={"lat": 0.0, "lng": 0.0,
                                     "radius_m": 50},
                               timeout=15)
        assert r.status_code == 400, r.text

    def test_location_post_rejects_huge_radius(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/bt/location",
                               json={"lat": 0.0, "lng": 0.0,
                                     "radius_m": 99_000_000},
                               timeout=15)
        assert r.status_code == 400, r.text

    def test_location_post_rejects_missing_fields(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/bt/location",
                               json={"lat": 0.0}, timeout=15)
        assert r.status_code == 400, r.text


# ── /api/bt/chest/today — after location is set ──
class TestBtChestToday:
    def test_chest_today_returns_object(self, admin_session):
        # Make sure a location is set first
        admin_session.post(f"{BASE_URL}/api/bt/location",
                           json={"lat": -33.8688, "lng": 151.2093,
                                 "radius_m": 1500,
                                 "tz_offset_minutes": 600},
                           timeout=15)
        r = admin_session.get(f"{BASE_URL}/api/bt/chest/today", timeout=30)
        assert r.status_code == 200, r.text
        chest = r.json().get("chest")
        assert chest is not None
        # Required fields
        for k in ("id", "date", "lat", "lng", "status",
                  "spawn_source", "expires_at"):
            assert k in chest, f"missing {k}"
        assert "_id" not in chest
        assert chest["status"] in ("hidden", "found", "expired")


# ── /api/bt/settings ──
class TestBtSettings:
    def test_settings_get(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/bt/settings", timeout=15)
        assert r.status_code == 200, r.text
        s = r.json().get("settings")
        assert s is not None
        assert "daylight_only" in s
        assert isinstance(s["daylight_only"], bool)

    def test_settings_post_updates(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/bt/settings",
                               json={"daylight_only": True}, timeout=15)
        assert r.status_code == 200
        assert r.json().get("saved") is True
        g = admin_session.get(f"{BASE_URL}/api/bt/settings", timeout=15)
        assert g.json()["settings"]["daylight_only"] is True
        # restore
        admin_session.post(f"{BASE_URL}/api/bt/settings",
                          json={"daylight_only": False}, timeout=15)


# ── /api/bt/finds ──
class TestBtFinds:
    def test_finds_returns_list(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/bt/finds", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "finds" in body
        assert isinstance(body["finds"], list)
        for f in body["finds"]:
            assert "_id" not in f
            assert "id" in f


# ── /api/bt/feed ──
class TestBtFeed:
    def test_feed_returns_array(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/bt/feed", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "entries" in body
        assert isinstance(body["entries"], list)


# ── /api/bt/matches ──
class TestBtMatches:
    def test_matches_returns_array(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/bt/matches", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "matches" in body
        assert isinstance(body["matches"], list)
        for m in body["matches"]:
            assert "_id" not in m
            assert "id" in m


# ── /api/bt/no-go-zones full CRUD ──
class TestBtNoGoZones:
    created_zone_id = None

    def test_create_zone(self, admin_session):
        poly = [
            {"lat": -33.86, "lng": 151.20},
            {"lat": -33.86, "lng": 151.21},
            {"lat": -33.87, "lng": 151.21},
            {"lat": -33.87, "lng": 151.20},
        ]
        r = admin_session.post(f"{BASE_URL}/api/bt/no-go-zones",
                               json={"name": f"TEST_zone_{uuid.uuid4().hex[:6]}",
                                     "polygon": poly}, timeout=15)
        assert r.status_code == 200, r.text
        zid = r.json().get("id")
        assert zid
        TestBtNoGoZones.created_zone_id = zid

    def test_list_includes_created(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/bt/no-go-zones", timeout=15)
        assert r.status_code == 200, r.text
        zones = r.json().get("zones", [])
        ids = [z["id"] for z in zones]
        assert TestBtNoGoZones.created_zone_id in ids
        for z in zones:
            assert "_id" not in z

    def test_reject_short_polygon(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/bt/no-go-zones",
                               json={"name": "TEST_bad",
                                     "polygon": [{"lat": 0, "lng": 0}]},
                               timeout=15)
        assert r.status_code == 400, r.text

    def test_delete_zone(self, admin_session):
        zid = TestBtNoGoZones.created_zone_id
        assert zid, "zone wasn't created"
        r = admin_session.delete(f"{BASE_URL}/api/bt/no-go-zones/{zid}",
                                 timeout=15)
        assert r.status_code == 200, r.text
        assert r.json().get("deleted", 0) >= 1
        # Verify gone
        g = admin_session.get(f"{BASE_URL}/api/bt/no-go-zones", timeout=15)
        ids = [z["id"] for z in g.json().get("zones", [])]
        assert zid not in ids


# ── /api/bt/match/invite malformed ──
class TestBtMatchInviteBadInput:
    def test_invite_missing_friend_id(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/bt/match/invite",
                               json={}, timeout=15)
        assert r.status_code in (400, 403), r.text
