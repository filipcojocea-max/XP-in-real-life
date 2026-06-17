"""Iteration 16 — Validate P1 backend endpoint fixes.

Tests:
  * GET /api/penalties/pending (newly wired)
  * GET /api/chat/preferences (newly wired)
  * GET /api/active-boost (new alias)
  * GET /api/boost/inventory (new alias)
Plus regressions against previously-working endpoints.
"""

import os
import pytest
import requests

BASE_URL = "https://emergent-mobile-app-4.preview.emergentagent.com"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"


@pytest.fixture(scope="module")
def auth_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    token = data.get("token") or data.get("access_token") or data.get("jwt")
    assert token, f"No token in login response: {data}"
    return token


@pytest.fixture
def auth_headers(auth_token):
    return {"Authorization": f"Bearer {auth_token}"}


# ---------- P1 new/aliased endpoints ----------

class TestP1Endpoints:
    def test_penalties_pending(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/penalties/pending", headers=auth_headers, timeout=30)
        assert r.status_code == 200, f"Got {r.status_code}: {r.text}"
        data = r.json()
        assert "penalties" in data, f"Missing 'penalties' key: {data}"
        assert isinstance(data["penalties"], list)

    def test_chat_preferences(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/chat/preferences", headers=auth_headers, timeout=30)
        assert r.status_code == 200, f"Got {r.status_code}: {r.text}"
        data = r.json()
        assert "preferences" in data, f"Missing 'preferences' key: {data}"
        assert isinstance(data["preferences"], list)

    def test_active_boost(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/active-boost", headers=auth_headers, timeout=30)
        assert r.status_code == 200, f"Got {r.status_code}: {r.text}"
        data = r.json()
        assert "active_boost" in data, f"Missing 'active_boost' key: {data}"
        # active_boost can be None or dict
        assert data["active_boost"] is None or isinstance(data["active_boost"], dict)

    def test_boost_inventory(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/boost/inventory", headers=auth_headers, timeout=30)
        assert r.status_code == 200, f"Got {r.status_code}: {r.text}"
        data = r.json()
        assert "boost_inventory" in data, f"Missing 'boost_inventory' key: {data}"
        assert isinstance(data["boost_inventory"], list)
        assert "boosts_unlocked" in data, f"Missing 'boosts_unlocked' key: {data}"
        assert isinstance(data["boosts_unlocked"], bool)


# ---------- Regression — previously-working endpoints ----------

class TestRegression:
    def test_profile(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/profile", headers=auth_headers, timeout=30)
        assert r.status_code == 200, f"/api/profile broken: {r.status_code} {r.text}"
        data = r.json()
        # Profile body returned flat — expect at least some standard profile field
        assert isinstance(data, dict) and len(data) > 0
        assert any(k in data for k in ("email", "user", "bio", "avatar_base64", "achievements_unlocked"))

    def test_login_again(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
            timeout=30,
        )
        assert r.status_code == 200

    def test_bt_settings(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/bt/settings", headers=auth_headers, timeout=30)
        assert r.status_code == 200, f"/api/bt/settings broken: {r.status_code} {r.text}"

    def test_schedule(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/schedule", headers=auth_headers, timeout=30)
        assert r.status_code == 200, f"/api/schedule broken: {r.status_code} {r.text}"

    def test_boosts_status(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/boosts/status", headers=auth_headers, timeout=30)
        assert r.status_code == 200, f"/api/boosts/status broken: {r.status_code} {r.text}"

    def test_boosts_pricing(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/boosts/pricing", headers=auth_headers, timeout=30)
        assert r.status_code == 200, f"/api/boosts/pricing broken: {r.status_code} {r.text}"


# ---------- Unauthenticated smoke: ensure endpoints exist (NOT 404) ----------

class TestNotFoundRegression:
    """Just confirms routes are registered. Auth may 401, but never 404."""

    @pytest.mark.parametrize("path", [
        "/api/penalties/pending",
        "/api/chat/preferences",
        "/api/active-boost",
        "/api/boost/inventory",
    ])
    def test_route_registered(self, path):
        r = requests.get(f"{BASE_URL}{path}", timeout=30)
        assert r.status_code != 404, f"{path} returned 404 — route not registered"
