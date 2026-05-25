#!/usr/bin/env python3
"""
Tests for PUT /api/goals/{goal_id} edit endpoint (Goals EDIT functionality).

Covers:
  A) Non-timeframe edit must NOT touch countdown (created_at / last_completed_at preserved).
  B) Changing `unit` resets countdown (created_at=now, last_completed_at=null, timeframe_reset_at=now).
  C) xp_reward clamps to per-unit cap on unit change (non-admin only).
  D) Switching to `months` blocked when non-admin already has 2 active monthly goals.
  E) Editable fields (unit, focus_area, xp_reward) persist.
  F) Admin bypasses XP clamp.
"""
import os, sys, json, time, random, string, uuid
from datetime import datetime, timezone, timedelta
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

results = []
def assert_eq(name, got, want):
    ok = got == want
    results.append((ok, name, f"got={got!r} want={want!r}"))
    print(("PASS" if ok else "FAIL"), "-", name, f"got={got!r} want={want!r}")

def assert_true(name, cond, extra=""):
    results.append((bool(cond), name, extra))
    print(("PASS" if cond else "FAIL"), "-", name, extra)

def post(path, token=None, json_body=None, expect=None):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = f"Bearer {token}"
    r = requests.post(BASE + path, headers=h, json=json_body or {}, timeout=30)
    return r

def put(path, token, json_body=None):
    h = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    return requests.put(BASE + path, headers=h, json=json_body or {}, timeout=30)

def get(path, token=None):
    h = {}
    if token: h["Authorization"] = f"Bearer {token}"
    return requests.get(BASE + path, headers=h, timeout=30)

def delete(path, token):
    h = {"Authorization": f"Bearer {token}"}
    return requests.delete(BASE + path, headers=h, timeout=30)


def parse_iso(s):
    if not s: return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def main():
    # ── Login admin ──
    r = post("/auth/login", json_body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert_eq("admin login 200", r.status_code, 200)
    if r.status_code != 200:
        print(r.text); return
    admin_token = r.json()["token"]
    admin_user_id = r.json()["user"]["id"]

    # ── Register fresh non-admin user ──
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    user_email = f"edittester+{rand}@gmail.com"
    user_password = "EditTester123!"
    r = post("/auth/register", json_body={
        "full_name": "Edit Tester",
        "email": user_email,
        "password": user_password,
    })
    assert_eq("non-admin register 200", r.status_code, 200)
    if r.status_code != 200:
        print(r.text); return
    user_token = r.json()["token"]
    user_id = r.json()["user"]["id"]
    print(f"[setup] admin_token=...{admin_token[-12:]} user={user_email} uid={user_id}")

    # ── Step 2: create a fresh admin goal (weeks) ──
    r = post("/goals", token=admin_token, json_body={
        "title": "EditTest",
        "focus_area": "fitness",
        "target_value": 30,
        "unit": "weeks",
        "xp_reward": 100,
        "description": "Initial",
    })
    assert_eq("admin create EditTest 200", r.status_code, 200)
    if r.status_code != 200:
        print(r.text); return
    g = r.json()
    admin_goal_id = g["id"]
    initial_created_at = g["created_at"]
    initial_last_completed_at = g.get("last_completed_at")
    initial_unit = g["unit"]
    initial_timeframe_reset_at = g.get("timeframe_reset_at")
    assert_eq("initial unit weeks", initial_unit, "weeks")
    assert_eq("initial xp_reward 100", g["xp_reward"], 100)
    print(f"[step2] goal_id={admin_goal_id} created_at={initial_created_at} lca={initial_last_completed_at}")

    # ── Test A: non-timeframe edit preserves countdown ──
    print("\n=== TEST A: non-timeframe edit preserves countdown ===")
    r = put(f"/goals/{admin_goal_id}", admin_token, {
        "title": "EditTest UPDATED",
        "target_value": 50,
        "xp_reward": 120,
    })
    assert_eq("A: PUT 200", r.status_code, 200)
    if r.status_code == 200:
        ga = r.json()
        assert_eq("A: title updated", ga["title"], "EditTest UPDATED")
        assert_eq("A: target_value updated", ga["target_value"], 50)
        assert_eq("A: xp_reward updated", ga["xp_reward"], 120)
        assert_eq("A: created_at unchanged", ga["created_at"], initial_created_at)
        assert_eq("A: last_completed_at unchanged", ga.get("last_completed_at"), initial_last_completed_at)
        assert_eq("A: timeframe_reset_at unchanged", ga.get("timeframe_reset_at"), initial_timeframe_reset_at)
        assert_eq("A: unit unchanged (weeks)", ga["unit"], "weeks")
    else:
        print(r.text)

    # ── Test B: timeframe change resets countdown ──
    print("\n=== TEST B: timeframe change resets countdown ===")
    pre_change_created_at = ga["created_at"]
    now_utc_before = datetime.now(timezone.utc)
    r = put(f"/goals/{admin_goal_id}", admin_token, {"unit": "months"})
    assert_eq("B: PUT unit=months 200", r.status_code, 200)
    if r.status_code == 200:
        gb = r.json()
        assert_eq("B: unit==months", gb["unit"], "months")
        new_created_at = gb["created_at"]
        assert_true("B: created_at changed", new_created_at != pre_change_created_at,
                    f"old={pre_change_created_at} new={new_created_at}")
        # within last 60 seconds (allow latency)
        new_dt = parse_iso(new_created_at)
        delta_s = abs((new_dt - now_utc_before).total_seconds()) if new_dt else 9999
        assert_true("B: created_at ~ now (≤60s)", delta_s <= 60, f"Δ={delta_s:.2f}s")
        assert_eq("B: last_completed_at is null", gb.get("last_completed_at"), None)
        assert_true("B: timeframe_reset_at present", gb.get("timeframe_reset_at") is not None,
                    f"val={gb.get('timeframe_reset_at')}")
        tfr = parse_iso(gb.get("timeframe_reset_at"))
        if tfr:
            assert_true("B: timeframe_reset_at ~ now (≤60s)",
                        abs((tfr - now_utc_before).total_seconds()) <= 60,
                        f"Δ={abs((tfr - now_utc_before).total_seconds()):.2f}s")
        # is_locked + next_tick_available_at ~ 30 days
        assert_eq("B: is_locked True", gb.get("is_locked"), True)
        next_at = parse_iso(gb.get("next_tick_available_at"))
        if next_at and new_dt:
            window_days = (next_at - new_dt).total_seconds() / 86400
            assert_true("B: next_tick_available_at ~30 days from created_at",
                        25 <= window_days <= 35, f"window={window_days:.2f}d")
    else:
        print(r.text)

    # ── Test C: XP clamp on unit change (non-admin) ──
    print("\n=== TEST C: non-admin XP clamp on unit change ===")
    r = post("/goals", token=user_token, json_body={
        "title": "C-Test",
        "focus_area": "mindset",
        "target_value": 10,
        "unit": "months",
        "xp_reward": 900,
    })
    assert_eq("C: create months goal xp=900 200", r.status_code, 200)
    if r.status_code != 200:
        print(r.text)
    else:
        c_goal = r.json()
        c_goal_id = c_goal["id"]
        assert_eq("C: created xp_reward=900 (months cap)", c_goal["xp_reward"], 900)
        # PUT unit=days (cap 30) without xp_reward → backend re-clamps existing 900 to 30
        r = put(f"/goals/{c_goal_id}", user_token, {"unit": "days"})
        assert_eq("C: PUT unit=days 200", r.status_code, 200)
        if r.status_code == 200:
            gc = r.json()
            assert_eq("C: unit==days", gc["unit"], "days")
            assert_eq("C: xp_reward clamped to days cap (30)", gc["xp_reward"], 30)
        else:
            print(r.text)
        # cleanup
        delete(f"/goals/{c_goal_id}", user_token)

    # ── Test D: monthly cap blocks unit switch (non-admin) ──
    print("\n=== TEST D: monthly cap blocks unit switch ===")
    monthly_ids = []
    for i in range(2):
        r = post("/goals", token=user_token, json_body={
            "title": f"Monthly-{i+1}",
            "focus_area": "fitness",
            "target_value": 5,
            "unit": "months",
            "xp_reward": 500,
        })
        assert_eq(f"D: create monthly#{i+1} 200", r.status_code, 200)
        if r.status_code == 200:
            monthly_ids.append(r.json()["id"])
        else:
            print(r.text)

    # Create G_test with unit=weeks
    r = post("/goals", token=user_token, json_body={
        "title": "G_test",
        "focus_area": "fitness",
        "target_value": 5,
        "unit": "weeks",
        "xp_reward": 100,
    })
    assert_eq("D: create G_test weeks 200", r.status_code, 200)
    g_test_id = None
    if r.status_code == 200:
        g_test_id = r.json()["id"]
        # Try switching G_test to months
        r = put(f"/goals/{g_test_id}", user_token, {"unit": "months"})
        assert_eq("D: PUT unit=months → 400", r.status_code, 400)
        if r.status_code == 400:
            try:
                detail = r.json().get("detail")
                if isinstance(detail, dict):
                    assert_eq("D: detail.error == monthly_goal_limit_reached",
                              detail.get("error"), "monthly_goal_limit_reached")
                else:
                    assert_true("D: detail is dict with error", False, f"detail={detail!r}")
            except Exception as e:
                assert_true("D: parse detail JSON", False, str(e))
        else:
            print("D: PUT body:", r.text)

    # Cleanup D
    for gid in monthly_ids:
        delete(f"/goals/{gid}", user_token)
    if g_test_id:
        delete(f"/goals/{g_test_id}", user_token)

    # ── Test E: admin bypasses XP clamp ──
    print("\n=== TEST E: admin bypasses XP clamp & monthly cap ===")
    # admin_goal_id is currently unit=months from Test B
    r = put(f"/goals/{admin_goal_id}", admin_token, {"xp_reward": 50000})
    assert_eq("E: admin PUT xp_reward=50000 200", r.status_code, 200)
    if r.status_code == 200:
        ge = r.json()
        assert_eq("E: admin xp_reward NOT clamped (=50000)", ge["xp_reward"], 50000)
        assert_eq("E: unit still months", ge["unit"], "months")
    else:
        print(r.text)

    # ── Cleanup admin goal ──
    r = delete(f"/goals/{admin_goal_id}", admin_token)
    print(f"[cleanup] DELETE admin goal → {r.status_code}")

    # Summary
    passed = sum(1 for ok, *_ in results if ok)
    failed = sum(1 for ok, *_ in results if not ok)
    print(f"\n========== SUMMARY: {passed} PASS / {failed} FAIL ==========")
    if failed:
        print("Failed assertions:")
        for ok, name, extra in results:
            if not ok:
                print(f"  - {name}: {extra}")
    return failed


if __name__ == "__main__":
    sys.exit(0 if main() == 0 else 1)
