"""
Iteration 15 — stability re-test additions for the Library+ storefront
treasure card. Confirms that /api/library/pricing and /api/library/ratings
both expose a `treasure` key in their response payload so the React Native
storefront card can render price badge + star rating without crashing.
"""
import os
import requests
import pytest


def _load_env(path):
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


_fe = _load_env("/app/frontend/.env")
BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or _fe.get("EXPO_PUBLIC_BACKEND_URL")
)
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL not set"
BASE_URL = BASE_URL.rstrip("/")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return {"Authorization": f"Bearer {r.json()['token']}"}


class TestLibraryTreasure:
    def test_pricing_has_treasure_key(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/library/pricing",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "pricing" in body
        assert "treasure" in body["pricing"], \
            f"treasure missing from pricing: {list(body['pricing'].keys())}"
        t = body["pricing"]["treasure"]
        # Schema sanity — storefront card needs these fields.
        assert "effective_price" in t or "price" in t
        assert "currency" in t
        # duo_offer / has_override always present per server.py:8857-8875
        assert "duo_offer" in t
        assert "has_override" in t
        print(f"[pricing.treasure] {t}")

    def test_ratings_has_treasure_key(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/library/ratings",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "ratings" in body
        assert "treasure" in body["ratings"], \
            f"treasure missing from ratings: {list(body['ratings'].keys())}"
        t = body["ratings"]["treasure"]
        assert "average" in t
        assert "count" in t
        assert "user_rating" in t
        assert isinstance(t["count"], int)
        assert isinstance(t["average"], (int, float))
        print(f"[ratings.treasure] {t}")
