"""Quick regression smoke checks for the BT endpoints that existed before
Round A — verifies no 5xx after the SyntaxError fix in buried_treasure.py.
Only checks status codes & basic JSON shape.
"""
import os
import requests
import pytest

def _load(path):
    out = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out

_fe = _load("/app/frontend/.env")
BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL")
            or _fe.get("EXPO_PUBLIC_BACKEND_URL")).rstrip("/")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.mark.parametrize("path", [
    "/api/bt/settings",
    "/api/bt/schedule",
    "/api/bt/solo/current",
    "/api/bt/groups/mine",
    "/api/bt/groups/available",
    "/api/bt/invites/pending",
    "/api/bt/friends-eligible",
])
def test_get_endpoints_return_2xx(admin_headers, path):
    r = requests.get(f"{BASE_URL}{path}", headers=admin_headers, timeout=15)
    assert r.status_code == 200, f"{path} → {r.status_code} {r.text[:200]}"
    # All return JSON object
    j = r.json()
    assert isinstance(j, (dict, list))


def test_post_settings_roundtrip(admin_headers):
    """POST then GET /bt/settings to verify persistence (regression)."""
    payload = {"lat": -33.8688, "lng": 151.2093, "radius_m": 800.0}
    r = requests.post(f"{BASE_URL}/api/bt/settings",
                      headers=admin_headers, json=payload, timeout=15)
    assert r.status_code == 200, r.text
    g = requests.get(f"{BASE_URL}/api/bt/settings", headers=admin_headers, timeout=15)
    assert g.status_code == 200
    s = g.json()
    # /bt/settings GET returns area nested under {"area": {...}}
    area = s.get("area") or s
    assert area.get("lat") == payload["lat"]
    assert area.get("lng") == payload["lng"]


def test_post_location(admin_headers):
    r = requests.post(f"{BASE_URL}/api/bt/location",
                      headers=admin_headers,
                      json={"lat": 37.7749, "lng": -122.4194}, timeout=15)
    assert r.status_code == 200, r.text


def test_solo_start_and_current(admin_headers):
    """Solo start should be 200 or a domain-specific 400 (e.g. cooldown); never 5xx."""
    r = requests.post(f"{BASE_URL}/api/bt/solo/start",
                      headers=admin_headers, json={}, timeout=20)
    assert r.status_code < 500, f"solo/start → {r.status_code} {r.text[:200]}"
    c = requests.get(f"{BASE_URL}/api/bt/solo/current", headers=admin_headers, timeout=15)
    assert c.status_code == 200
