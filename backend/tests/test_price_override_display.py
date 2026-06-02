"""
Iteration 11 — Per-player price-override display on Library+ cards.

Backend verification:
  1. GET /api/library/pricing returns 200 and includes `has_override`
     boolean for every mini-app (false on a fresh state).
  2. POST /api/admin/players/{user_id}/price-overrides/{app_id} sets
     an override.
  3. GET /api/library/pricing now has has_override=true,
     override_price=4.99, override_currency=USD, effective_price=4.99
     for `sleep`. Other apps still has_override=false.
  4. DELETE clears the override; GET reverts has_override back to false.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    BASE_URL = "https://emergent-mobile-app-4.preview.emergentagent.com"

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"


@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    token = data["token"]
    user_id = data["user"]["id"]
    s.headers.update({"Authorization": f"Bearer {token}"})
    yield {"session": s, "user_id": user_id}
    # Safety cleanup — always try DELETE for sleep override after tests
    try:
        s.delete(
            f"{BASE_URL}/api/admin/players/{user_id}/price-overrides/sleep",
            timeout=15,
        )
    except Exception:
        pass


class TestLibraryPricingOverrideDisplay:
    """Verifies has_override / override_price / override_currency
    are surfaced on GET /api/library/pricing for the player who has
    the override set."""

    def test_initial_no_override(self, admin_session):
        s = admin_session["session"]
        user_id = admin_session["user_id"]
        # Best-effort cleanup before assertion (in case prior run left state)
        s.delete(
            f"{BASE_URL}/api/admin/players/{user_id}/price-overrides/sleep",
            timeout=15,
        )

        r = s.get(f"{BASE_URL}/api/library/pricing", timeout=15)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        payload = r.json()
        data = payload.get("pricing", payload)
        assert isinstance(data, dict) and data, "pricing payload empty"
        # Every entry must carry the has_override field (boolean)
        for app_id, p in data.items():
            assert "has_override" in p, f"{app_id} missing has_override"
            assert isinstance(p["has_override"], bool), (
                f"{app_id}.has_override is not bool: {type(p['has_override'])}"
            )
            assert p["has_override"] is False, (
                f"{app_id} should not have an override on clean state, got {p}"
            )

    def test_set_override_then_pricing_reflects_it(self, admin_session):
        s = admin_session["session"]
        user_id = admin_session["user_id"]

        # POST the override → $4.99 USD on `sleep`
        r = s.post(
            f"{BASE_URL}/api/admin/players/{user_id}/price-overrides/sleep",
            json={"override_price": 4.99, "currency": "USD"},
            timeout=15,
        )
        assert r.status_code == 200, f"POST override failed: {r.status_code} {r.text}"

        # GET pricing again → sleep has override
        r2 = s.get(f"{BASE_URL}/api/library/pricing", timeout=15)
        assert r2.status_code == 200
        payload = r2.json()
        data = payload.get("pricing", payload)
        sleep = data.get("sleep")
        assert sleep is not None, "sleep entry missing"
        assert sleep["has_override"] is True, f"has_override not true: {sleep}"
        assert float(sleep["override_price"]) == 4.99, sleep
        assert sleep["override_currency"] == "USD", sleep
        assert float(sleep["effective_price"]) == 4.99, sleep
        # Other apps should NOT have the override on
        for aid in ("challenges", "spot", "confidence"):
            if aid in data:
                assert data[aid]["has_override"] is False, (
                    f"{aid} should not be overridden: {data[aid]}"
                )

    def test_clear_override_resets_flag(self, admin_session):
        s = admin_session["session"]
        user_id = admin_session["user_id"]

        # Ensure an override exists first (idempotent set)
        s.post(
            f"{BASE_URL}/api/admin/players/{user_id}/price-overrides/sleep",
            json={"override_price": 4.99, "currency": "USD"},
            timeout=15,
        )

        # DELETE the override
        r = s.delete(
            f"{BASE_URL}/api/admin/players/{user_id}/price-overrides/sleep",
            timeout=15,
        )
        assert r.status_code == 200, f"DELETE failed: {r.status_code} {r.text}"

        # GET → sleep.has_override back to false
        r2 = s.get(f"{BASE_URL}/api/library/pricing", timeout=15)
        assert r2.status_code == 200
        payload = r2.json()
        data = payload.get("pricing", payload)
        sleep = data.get("sleep")
        assert sleep is not None
        assert sleep["has_override"] is False, sleep
        assert "override_price" not in sleep or sleep.get("override_price") is None, (
            "override_price should not leak after delete"
        )
