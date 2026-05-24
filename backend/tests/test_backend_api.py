"""Backend API regression suite for XP-In-Real-Life clone.

Covers:
  - Health check
  - Auth: register, login (admin), 401 enforcement
  - Profile: admin profile (is_admin), MongoDB _id never leaks
  - Day-anchor / onboarding (timezone + day_start_time setup + lock rule)
  - Challenges endpoints
  - APScheduler status (motivation_tick, spot_surprise_tick,
    streak_warning_tick, match_invite_expiry)
"""
import os
import uuid
import time
import pytest

BASE_URL = os.environ.get("_BASE_URL_OVERRIDE")  # not used; conftest provides it


# ----------------------------- Health -----------------------------
class TestHealth:
    def test_root_health(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("app") == "LevelUp"
        assert data.get("status") == "ok"


# ----------------------------- Auth -------------------------------
class TestAuthLogin:
    def test_admin_login_returns_jwt_and_user(self, api_client, base_url, admin_credentials):
        r = api_client.post(f"{base_url}/api/auth/login", json=admin_credentials, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data.get("token"), str) and len(data["token"]) > 20
        user = data.get("user")
        assert user, "user object missing"
        # MongoDB _id must NOT leak; instead a normalized `id` is expected
        assert "_id" not in user
        assert user.get("id")
        assert user.get("email") == admin_credentials["email"].lower()
        assert user.get("verified") is True

    def test_admin_login_wrong_password(self, api_client, base_url, admin_credentials):
        r = api_client.post(
            f"{base_url}/api/auth/login",
            json={"email": admin_credentials["email"], "password": "wrong-pass-1234"},
            timeout=15,
        )
        assert r.status_code == 401, r.text


class TestAuthRegister:
    def test_register_new_user_creates_account(self, api_client, base_url):
        unique = uuid.uuid4().hex[:10]
        email = f"TEST_user_{unique}@gmail.com"
        payload = {
            "full_name": "TEST User",
            "email": email,
            "password": "StrongPass123",
        }
        r = api_client.post(f"{base_url}/api/auth/register", json=payload, timeout=30)
        # Some mail validators reject DNS MX in sandbox; accept either pass or
        # the explicit 400 validation message — but NOT a 500.
        assert r.status_code in (200, 400), f"unexpected: {r.status_code} {r.text}"
        if r.status_code == 400:
            pytest.skip(f"Email rejected by strict validator: {r.text}")

        data = r.json()
        assert data.get("token")
        user = data.get("user") or {}
        assert "_id" not in user
        assert user.get("email") == email.lower()
        # Verify the new account can log in immediately (verification disabled)
        login = api_client.post(
            f"{base_url}/api/auth/login",
            json={"email": email, "password": payload["password"]},
            timeout=20,
        )
        assert login.status_code == 200, login.text

    def test_register_short_password_rejected(self, api_client, base_url):
        unique = uuid.uuid4().hex[:8]
        r = api_client.post(
            f"{base_url}/api/auth/register",
            json={"full_name": "X", "email": f"TEST_short_{unique}@gmail.com", "password": "12"},
            timeout=15,
        )
        assert r.status_code in (400, 422), r.text


class TestAuthGuards:
    """Strict-JWT endpoints (auth/me) must reject anonymous traffic.

    NOTE: `get_user_or_legacy` (used by /api/profile, /api/challenge/*, etc.)
    intentionally falls back to a `main` / anonymous user when no token is
    supplied — this is by design for the legacy/anon-mode UX, NOT a bug.
    See server.py:308. We therefore only assert 401 on the strict route.
    """

    def test_auth_me_without_token_rejected(self, api_client, base_url):
        import requests
        r = requests.get(f"{base_url}/api/auth/me", timeout=15)
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"

    def test_auth_me_with_garbage_token_rejected(self, api_client, base_url):
        import requests
        r = requests.get(
            f"{base_url}/api/auth/me",
            headers={"Authorization": "Bearer not.a.real.jwt"},
            timeout=15,
        )
        assert r.status_code == 401


# --------------------------- Admin Profile ------------------------
class TestAdminProfile:
    def test_admin_profile_flag(self, api_client, base_url, admin_auth_header):
        r = api_client.get(f"{base_url}/api/profile", headers=admin_auth_header, timeout=15)
        assert r.status_code == 200, r.text
        prof = r.json()
        assert "_id" not in prof, "MongoDB _id leaked in /api/profile response"
        assert prof.get("is_admin") is True, f"admin flag missing: {prof}"

    def test_auth_me_returns_admin(self, api_client, base_url, admin_auth_header, admin_credentials):
        r = api_client.get(f"{base_url}/api/auth/me", headers=admin_auth_header, timeout=15)
        assert r.status_code == 200, r.text
        u = r.json()
        assert "_id" not in u
        assert u.get("email") == admin_credentials["email"].lower()


# ---------------------- Day-Anchor / Onboarding -------------------
class TestDayAnchorOnboarding:
    """Verifies the timezone + day_start_time onboarding lock-rule.
    Admin already has both set (seeded), so a PUT must be rejected with the
    documented `tz_locked` / `day_start_locked` error envelope."""

    def test_profile_has_day_anchor_fields(self, api_client, base_url, admin_auth_header):
        r = api_client.get(f"{base_url}/api/profile", headers=admin_auth_header, timeout=15)
        assert r.status_code == 200
        prof = r.json()
        # Field is always serialized (may be None for fresh users, must be present)
        assert "day_start_time" in prof
        assert "timezone" in prof
        assert "onboarding_tz_done" in prof

    def test_admin_day_anchor_already_locked(self, api_client, base_url, admin_auth_header):
        # Admin is seeded with day_start_time=07:00 + timezone, so PUT must reject
        r = api_client.put(
            f"{base_url}/api/profile",
            headers=admin_auth_header,
            json={"timezone": "America/Los_Angeles"},
            timeout=15,
        )
        # Admin profile should already be locked → 400 expected
        assert r.status_code == 400, f"expected lock 400, got {r.status_code}: {r.text}"
        body = r.json()
        # FastAPI nests our dict under "detail"
        detail = body.get("detail", body)
        if isinstance(detail, dict):
            assert detail.get("error") == "tz_locked"

    def test_new_user_can_set_day_anchor(self, api_client, base_url):
        # Register fresh, then push tz + day_start_time, expect onboarding_tz_done flip
        unique = uuid.uuid4().hex[:10]
        email = f"TEST_anchor_{unique}@gmail.com"
        reg = api_client.post(
            f"{base_url}/api/auth/register",
            json={"full_name": "TEST Anchor", "email": email, "password": "StrongPass123"},
            timeout=30,
        )
        if reg.status_code != 200:
            pytest.skip(f"register blocked: {reg.text}")
        token = reg.json()["token"]
        hdr = {"Authorization": f"Bearer {token}"}

        # Pre-condition: fresh user should NOT have onboarding_tz_done
        prof_before = api_client.get(f"{base_url}/api/profile", headers=hdr, timeout=15).json()
        assert prof_before.get("onboarding_tz_done") in (False, None)

        upd = api_client.put(
            f"{base_url}/api/profile",
            headers=hdr,
            json={"timezone": "Australia/Sydney", "day_start_time": "06:30"},
            timeout=15,
        )
        assert upd.status_code == 200, upd.text
        prof = upd.json()
        assert prof.get("timezone") == "Australia/Sydney"
        assert prof.get("day_start_time") == "06:30"
        assert prof.get("onboarding_tz_done") is True

        # Now the fields should be locked
        relock = api_client.put(
            f"{base_url}/api/profile",
            headers=hdr,
            json={"day_start_time": "08:00"},
            timeout=15,
        )
        assert relock.status_code == 400


# --------------------------- Challenges ---------------------------
class TestChallenges:
    def test_challenge_today(self, api_client, base_url, admin_auth_header):
        r = api_client.get(f"{base_url}/api/challenge/today", headers=admin_auth_header, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        for key in ("date", "greeting", "quote", "challenge", "status", "wake_time"):
            assert key in data, f"missing key {key} in /challenge/today: {list(data.keys())}"
        # status must be a known value
        assert data["status"] in ("ready", "accepted", "rejected", "completed")
        # challenge object should expose an id
        assert isinstance(data["challenge"], dict)
        assert data["challenge"].get("id")

    def test_challenge_past_list(self, api_client, base_url, admin_auth_header):
        r = api_client.get(f"{base_url}/api/challenge/past", headers=admin_auth_header, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        # Should be a list (possibly empty)
        assert isinstance(data, (list, dict))

    def test_challenge_today_works_anon(self, api_client, base_url):
        # /challenge/today uses legacy/anon fallback — no auth required by design
        import requests
        r = requests.get(f"{base_url}/api/challenge/today", timeout=15)
        assert r.status_code == 200, r.text


# --------------------------- Scheduler ----------------------------
class TestScheduler:
    def test_scheduler_status_running_with_all_jobs(self, api_client, base_url, admin_auth_header):
        r = api_client.get(
            f"{base_url}/api/admin/scheduler/status",
            headers=admin_auth_header,
            timeout=15,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("running") is True, f"scheduler not running: {data}"
        job_ids = {j.get("id") for j in (data.get("jobs") or [])}
        # Job IDs (per notif_scheduler.py register_jobs) — NOT function names
        expected = {
            "motivation_tick",
            "spot_surprise_tick",
            "streak_warning_tick",
            "match_invite_expiry",
        }
        missing = expected - job_ids
        assert not missing, f"scheduler missing jobs: {missing} (have {job_ids})"


# --------------------------- Mongo hygiene ------------------------
class TestMongoIdHygiene:
    """Spot-check that no commonly-hit endpoint leaks raw `_id` to clients."""

    @pytest.mark.parametrize("path", [
        "/api/profile",
        "/api/auth/me",
        "/api/challenge/today",
        "/api/tasks",
        "/api/goals",
    ])
    def test_no_mongo_id_in_responses(self, api_client, base_url, admin_auth_header, path):
        r = api_client.get(f"{base_url}{path}", headers=admin_auth_header, timeout=20)
        assert r.status_code == 200, f"{path} returned {r.status_code}: {r.text[:200]}"
        body = r.json()
        # Walk one level deep — these endpoints return either dicts or lists of dicts
        items = body if isinstance(body, list) else [body]
        for it in items:
            if isinstance(it, dict):
                assert "_id" not in it, f"_id leaked in {path}: keys={list(it.keys())}"
