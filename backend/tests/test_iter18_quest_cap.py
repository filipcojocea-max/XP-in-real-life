"""Iteration 18 — Per-player Quest cap (profile.goal_quest_max) for POST /api/tasks.

Validates the fix at server.py:~1845 (create_task) that swaps the hard-coded
MAX_CUSTOM_TASKS=11 for the per-user `profile.goal_quest_max` value, set by
Creator via POST /api/admin/players/{id}/goal-quest-max.

Scenarios
---------
1. Default cap (11) when goal_quest_max is unset.
2. Raised cap (20) honored after admin sets goal_quest_max=20.
3. Lowered cap (5) blocks new creates without deleting existing quests.
4. Creator/Admin bypass the cap completely.
5. Regression: POST /api/goals still enforces goal_quest_max (default 8).
6. Regression: /api/spot/finds + /api/bt/no-go-zones (admin) still 200.
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

TIMEOUT = 30


# ────────────────────────── helpers ──────────────────────────

def _login(email: str, password: str) -> dict:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    body = r.json()
    return {"token": body["token"], "user_id": body["user"]["id"]}


def _register_fresh_user(label: str) -> dict:
    """Register a brand-new test user and return {token, user_id, email}.

    Email uses gmail.com so MX validation passes; unique uuid prefix avoids
    collisions across runs.
    """
    email = f"test_{label}_{uuid.uuid4().hex[:12]}@gmail.com"
    password = "TestPass!123"
    r = requests.post(
        f"{BASE_URL}/api/auth/register",
        json={"email": email, "password": password, "full_name": f"Test {label}"},
        timeout=TIMEOUT,
    )
    if r.status_code != 200:
        pytest.skip(f"Could not register user ({r.status_code}): {r.text[:200]}")
    body = r.json()
    return {
        "token": body["token"],
        "user_id": body["user"]["id"],
        "email": email,
        "password": password,
    }


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _create_task(token: str, idx: int = 0):
    payload = {
        "title": f"TEST_quest_{uuid.uuid4().hex[:6]}_{idx}",
        "description": "iter18 cap test",
        "focus_area": "mindset",
        "time_slot": "morning",
        "xp_value": 10,
        "recurring": True,
        "reminder_enabled": False,
    }
    return requests.post(
        f"{BASE_URL}/api/tasks",
        json=payload,
        headers=_headers(token),
        timeout=TIMEOUT,
    )


def _admin_set_quest_max(admin_token: str, target_user_id: str, value: int):
    return requests.post(
        f"{BASE_URL}/api/admin/players/{target_user_id}/goal-quest-max",
        json={"max": value},
        headers=_headers(admin_token),
        timeout=TIMEOUT,
    )


# ────────────────────────── fixtures ──────────────────────────

@pytest.fixture(scope="module")
def admin():
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


# ─────────────────────── 1. default cap (11) ───────────────────────

class TestDefaultCap:
    def test_default_cap_blocks_at_12(self, admin):
        user = _register_fresh_user("defcap")
        # Sanity: no custom quests yet
        for i in range(11):
            r = _create_task(user["token"], i)
            assert r.status_code == 200, (
                f"Quest #{i+1}/11 failed unexpectedly: {r.status_code} {r.text[:200]}"
            )

        # 12th must fail with 11-quest limit message.
        r12 = _create_task(user["token"], 11)
        assert r12.status_code == 400, (
            f"Expected 400 on 12th quest, got {r12.status_code}: {r12.text[:200]}"
        )
        body = r12.json()
        detail = body.get("detail") if isinstance(body, dict) else str(body)
        assert "11-quest limit" in str(detail), (
            f"Error message missing '11-quest limit': {detail}"
        )


# ─────────────────────── 2. raised cap (20) ───────────────────────

class TestRaisedCap:
    def test_raised_cap_to_20(self, admin):
        user = _register_fresh_user("raised")

        # Admin bumps user's cap to 20.
        sr = _admin_set_quest_max(admin["token"], user["user_id"], 20)
        assert sr.status_code == 200, f"set goal_quest_max failed: {sr.status_code} {sr.text[:200]}"
        assert sr.json().get("goal_quest_max") == 20

        # Create 20 custom quests — all should succeed.
        for i in range(20):
            r = _create_task(user["token"], i)
            assert r.status_code == 200, (
                f"Quest #{i+1}/20 failed: {r.status_code} {r.text[:200]}"
            )

        # 21st must fail with 20-quest limit message.
        r21 = _create_task(user["token"], 20)
        assert r21.status_code == 400, (
            f"Expected 400 on 21st quest, got {r21.status_code}: {r21.text[:200]}"
        )
        detail = r21.json().get("detail", "")
        assert "20-quest limit" in str(detail), (
            f"Error message missing '20-quest limit': {detail}"
        )


# ─────────────────────── 3. lowered cap (5) ───────────────────────

class TestLoweredCap:
    def test_lowered_cap_blocks_new_without_deleting_existing(self, admin):
        user = _register_fresh_user("lowered")

        # First raise the cap and create 7 quests.
        sr = _admin_set_quest_max(admin["token"], user["user_id"], 20)
        assert sr.status_code == 200
        for i in range(7):
            r = _create_task(user["token"], i)
            assert r.status_code == 200, f"setup quest #{i+1} failed: {r.text[:200]}"

        # Snapshot existing custom quest count via GET /api/tasks.
        list_r = requests.get(
            f"{BASE_URL}/api/tasks", headers=_headers(user["token"]), timeout=TIMEOUT
        )
        assert list_r.status_code == 200
        before = list_r.json()
        before_tasks = before["tasks"] if isinstance(before, dict) else before
        before_custom = [t for t in before_tasks if not t.get("is_default")]
        assert len(before_custom) == 7, f"Expected 7 custom quests, got {len(before_custom)}"

        # Lower cap to 5.
        sr2 = _admin_set_quest_max(admin["token"], user["user_id"], 5)
        assert sr2.status_code == 200
        assert sr2.json().get("goal_quest_max") == 5

        # Existing quests should NOT have been deleted.
        list_r2 = requests.get(
            f"{BASE_URL}/api/tasks", headers=_headers(user["token"]), timeout=TIMEOUT
        )
        assert list_r2.status_code == 200
        after_body = list_r2.json()
        after_tasks = after_body["tasks"] if isinstance(after_body, dict) else after_body
        after_custom = [t for t in after_tasks if not t.get("is_default")]
        assert len(after_custom) == 7, (
            f"Lowering cap deleted quests! Before=7 After={len(after_custom)}"
        )

        # New create must fail with 5-quest limit.
        r_new = _create_task(user["token"], 99)
        assert r_new.status_code == 400, (
            f"Expected 400 with lowered cap, got {r_new.status_code}: {r_new.text[:200]}"
        )
        detail = r_new.json().get("detail", "")
        assert "5-quest limit" in str(detail), (
            f"Error message missing '5-quest limit': {detail}"
        )


# ─────────────────────── 4. admin bypass ───────────────────────

class TestAdminBypass:
    def test_admin_can_exceed_cap(self, admin):
        # Count admin's current custom quests so we know our starting point.
        list_r = requests.get(
            f"{BASE_URL}/api/tasks", headers=_headers(admin["token"]), timeout=TIMEOUT
        )
        assert list_r.status_code == 200
        body = list_r.json()
        tasks_list = body["tasks"] if isinstance(body, dict) else body
        existing_custom = [
            t for t in tasks_list
            if not t.get("is_default") and t.get("title", "").startswith("TEST_admin_bypass_")
        ]
        # Clean any TEST_ leftovers from prior runs of this scenario (best-effort).
        for t in existing_custom:
            requests.delete(
                f"{BASE_URL}/api/tasks/{t['id']}",
                headers=_headers(admin["token"]),
                timeout=TIMEOUT,
            )

        created_ids = []
        try:
            # Create 13 custom quests as admin (above default cap of 11).
            for i in range(13):
                payload = {
                    "title": f"TEST_admin_bypass_{uuid.uuid4().hex[:6]}_{i}",
                    "description": "iter18 admin bypass",
                    "focus_area": "mindset",
                    "time_slot": "morning",
                    "xp_value": 10,
                    "recurring": True,
                    "reminder_enabled": False,
                }
                r = requests.post(
                    f"{BASE_URL}/api/tasks",
                    json=payload,
                    headers=_headers(admin["token"]),
                    timeout=TIMEOUT,
                )
                assert r.status_code == 200, (
                    f"Admin quest #{i+1} blocked: {r.status_code} {r.text[:200]}"
                )
                created_ids.append(r.json()["id"])
        finally:
            # Cleanup
            for tid in created_ids:
                requests.delete(
                    f"{BASE_URL}/api/tasks/{tid}",
                    headers=_headers(admin["token"]),
                    timeout=TIMEOUT,
                )


# ─────────────────────── 5. goal-cap regression ───────────────────────

class TestGoalCapRegression:
    def test_default_goal_cap_blocks_at_9(self):
        """Goals still enforce goal_quest_max (default 8). Use 'weeks' unit to
        skirt the daily(5)/monthly(2) sub-caps so we cleanly hit the global 8."""
        user = _register_fresh_user("goalcap")

        for i in range(8):
            r = requests.post(
                f"{BASE_URL}/api/goals",
                json={
                    "title": f"TEST_goal_{i}",
                    "focus_area": "mindset",
                    "target_value": 10,
                    "unit": "weeks",
                    "xp_reward": 50,
                },
                headers=_headers(user["token"]),
                timeout=TIMEOUT,
            )
            assert r.status_code == 200, (
                f"Goal #{i+1}/8 failed: {r.status_code} {r.text[:200]}"
            )

        # 9th must fail.
        r9 = requests.post(
            f"{BASE_URL}/api/goals",
            json={
                "title": "TEST_goal_overflow",
                "focus_area": "mindset",
                "target_value": 10,
                "unit": "weeks",
                "xp_reward": 50,
            },
            headers=_headers(user["token"]),
            timeout=TIMEOUT,
        )
        assert r9.status_code == 400, (
            f"Expected 400 on 9th goal, got {r9.status_code}: {r9.text[:200]}"
        )
        body = r9.json()
        # Detail is a structured dict for goals.
        detail = body.get("detail", {})
        if isinstance(detail, dict):
            assert detail.get("error") == "goal_limit_reached", f"Wrong error code: {detail}"
            assert detail.get("limit") == 8, f"Wrong limit in detail: {detail}"
        else:
            assert "8" in str(detail)


# ─────────────────────── 6. iter17 regressions ───────────────────────

class TestIter17Regression:
    def test_spot_finds_still_200(self, admin):
        r = requests.get(
            f"{BASE_URL}/api/spot/finds",
            headers=_headers(admin["token"]),
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, f"{r.status_code}: {r.text[:200]}"
        data = r.json()
        assert "finds" in data and "count" in data

    def test_bt_no_go_zones_admin_get_200(self, admin):
        r = requests.get(
            f"{BASE_URL}/api/bt/no-go-zones",
            headers=_headers(admin["token"]),
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, f"{r.status_code}: {r.text[:200]}"
