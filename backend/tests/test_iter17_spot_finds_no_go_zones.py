"""Iteration 17 — Validate two newly-wired backend endpoint sets.

Endpoints under test:
  * GET    /api/spot/finds              (caller's own Spot completions)
  * GET    /api/bt/no-go-zones          (admin-only list)
  * POST   /api/bt/no-go-zones          (admin-only create)
  * DELETE /api/bt/no-go-zones/{id}     (admin-only delete)

Plus regression on previously-fixed P1 endpoints from iteration 16.
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

VALID_POLYGON = [
    {"lat": -33.86, "lng": 151.20},
    {"lat": -33.86, "lng": 151.21},
    {"lat": -33.87, "lng": 151.21},
    {"lat": -33.87, "lng": 151.20},
]


# ───────────────────── fixtures ─────────────────────

@pytest.fixture(scope="module")
def admin_token() -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"No token in response: {r.json()}"
    return tok


@pytest.fixture
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}",
            "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def non_admin_token() -> str:
    email = f"TEST_nogo_{uuid.uuid4().hex[:10]}@gmail.com"
    r = requests.post(
        f"{BASE_URL}/api/auth/register",
        json={"email": email, "password": "TestPass!123", "full_name": "NoGo Tester"},
        timeout=30,
    )
    if r.status_code != 200:
        pytest.skip(f"Could not register non-admin helper ({r.status_code}): {r.text[:200]}")
    tok = r.json().get("token")
    assert tok
    return tok


@pytest.fixture
def non_admin_headers(non_admin_token):
    return {"Authorization": f"Bearer {non_admin_token}",
            "Content-Type": "application/json"}


# ───────────────────── /api/spot/finds ─────────────────────

class TestSpotFinds:
    def test_spot_finds_authed_shape(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/spot/finds", headers=admin_headers, timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        data = r.json()
        assert "finds" in data, f"Missing 'finds' key: {data}"
        assert "count" in data, f"Missing 'count' key: {data}"
        assert isinstance(data["finds"], list)
        assert isinstance(data["count"], int)
        assert data["count"] == len(data["finds"])
        # Each find object MUST NOT leak Mongo's _id
        for f in data["finds"]:
            assert "_id" not in f, f"Mongo _id leaked: {f}"

    def test_spot_finds_route_registered(self):
        # Should never be 404 (the bug we just fixed)
        r = requests.get(f"{BASE_URL}/api/spot/finds", timeout=30)
        assert r.status_code != 404, "/api/spot/finds returned 404 — route missing!"


# ───────────────────── /api/bt/no-go-zones CRUD ─────────────────────

class TestNoGoZonesCRUD:
    """Create → List (verify) → Delete → List (verify gone)."""

    created_zone_id: str = ""

    def test_create_zone_valid_polygon(self, admin_headers):
        body = {"name": "TEST_zone_iter17", "polygon": VALID_POLYGON}
        r = requests.post(
            f"{BASE_URL}/api/bt/no-go-zones",
            headers=admin_headers, json=body, timeout=30,
        )
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        data = r.json()
        assert "id" in data and isinstance(data["id"], str) and data["id"]
        assert data.get("name") == "TEST_zone_iter17"
        assert isinstance(data.get("polygon"), list) and len(data["polygon"]) == 4
        TestNoGoZonesCRUD.created_zone_id = data["id"]

    def test_list_zones_contains_created(self, admin_headers):
        assert TestNoGoZonesCRUD.created_zone_id, "Prior create test must run first"
        r = requests.get(f"{BASE_URL}/api/bt/no-go-zones", headers=admin_headers, timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        data = r.json()
        assert "zones" in data and isinstance(data["zones"], list)
        # Find our zone
        ids = [z.get("id") for z in data["zones"]]
        assert TestNoGoZonesCRUD.created_zone_id in ids, \
            f"Created zone not found in list. Got ids: {ids[:10]}"
        # No Mongo _id leaks
        for z in data["zones"]:
            assert "_id" not in z, f"Mongo _id leaked in zone: {z}"
            # Each zone must carry the documented shape
            assert "id" in z and "name" in z and "polygon" in z

    def test_create_zone_short_polygon_returns_400(self, admin_headers):
        body = {"name": "TEST_short", "polygon": [{"lat": 0, "lng": 0}]}
        r = requests.post(
            f"{BASE_URL}/api/bt/no-go-zones",
            headers=admin_headers, json=body, timeout=30,
        )
        assert r.status_code == 400, f"Expected 400 got {r.status_code}: {r.text}"

    def test_delete_zone_and_verify_gone(self, admin_headers):
        zid = TestNoGoZonesCRUD.created_zone_id
        assert zid, "Create test must run first"
        r = requests.delete(
            f"{BASE_URL}/api/bt/no-go-zones/{zid}",
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        data = r.json()
        assert data.get("deleted") == 1, f"Expected deleted=1, got {data}"

        # Subsequent GET must not include the deleted zone
        r2 = requests.get(f"{BASE_URL}/api/bt/no-go-zones", headers=admin_headers, timeout=30)
        assert r2.status_code == 200
        ids = [z.get("id") for z in r2.json().get("zones", [])]
        assert zid not in ids, f"Deleted zone still present in list: {ids}"


# ───────────────────── Authorization ─────────────────────

class TestNoGoZonesAuth:
    def test_get_unauthenticated_is_403(self):
        r = requests.get(f"{BASE_URL}/api/bt/no-go-zones", timeout=30)
        assert r.status_code == 403, f"Expected 403, got {r.status_code}: {r.text[:200]}"

    def test_get_non_admin_is_403(self, non_admin_headers):
        r = requests.get(
            f"{BASE_URL}/api/bt/no-go-zones",
            headers=non_admin_headers, timeout=30,
        )
        assert r.status_code == 403, f"Expected 403, got {r.status_code}: {r.text[:200]}"

    def test_post_non_admin_is_403(self, non_admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/bt/no-go-zones",
            headers=non_admin_headers,
            json={"name": "TEST_unauthorized", "polygon": VALID_POLYGON},
            timeout=30,
        )
        assert r.status_code == 403, f"Expected 403, got {r.status_code}: {r.text[:200]}"


# ───────────────────── Regression — P1 endpoints from iter 16 ─────────────────────

class TestP1Regression:
    def test_penalties_pending(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/penalties/pending", headers=admin_headers, timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        assert "penalties" in r.json()

    def test_chat_preferences(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/chat/preferences", headers=admin_headers, timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        assert "preferences" in r.json()

    def test_active_boost(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/active-boost", headers=admin_headers, timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        assert "active_boost" in r.json()

    def test_boost_inventory(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/boost/inventory", headers=admin_headers, timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        data = r.json()
        assert "boost_inventory" in data and "boosts_unlocked" in data
