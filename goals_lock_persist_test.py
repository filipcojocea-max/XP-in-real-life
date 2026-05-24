"""
XP-cheat fix verification: Goals cycle-lockout must persist through un-ticks.
Tests:
 1) Weekly goal (admin) — lock persists after un-tick, re-tick → 429 cycle_locked
 2) Monthly goal (non-admin) — lock persists after un-tick, re-tick → 429
 3) Sanity — cycle expires (last_completed_at backdated) → re-tick allowed
 4) Step-progress goals — partial un-tick doesn't reset lock
 5) Regression — timeframe change still resets lock (legitimate path)

Backend base: https://xp-confidence.preview.emergentagent.com/api
Admin: filip.cojocea122@gmail.com / XL98CZW5599
"""

import os
import sys
import time
import uuid
import json
from datetime import datetime, timedelta, timezone

import requests
from pymongo import MongoClient
from dotenv import dotenv_values

# ─── Config ───────────────────────────────────────────────────────────────
BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

# Load Mongo URL from backend/.env
env = dotenv_values("/app/backend/.env")
MONGO_URL = env.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = env.get("DB_NAME", "test_database")

# ─── Pass/fail counters ──────────────────────────────────────────────────
PASS = 0
FAIL = 0
FAIL_DETAIL = []


def assert_true(cond, msg):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {msg}")
    else:
        FAIL += 1
        FAIL_DETAIL.append(msg)
        print(f"  ❌ {msg}")


def assert_eq(actual, expected, msg):
    cond = actual == expected
    if not cond:
        msg = f"{msg} (expected {expected!r}, got {actual!r})"
    assert_true(cond, msg)


def hdrs(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def req(method, path, token=None, **kw):
    url = f"{BASE}{path}"
    if token:
        h = kw.pop("headers", {}) or {}
        h["Authorization"] = f"Bearer {token}"
        kw["headers"] = h
    r = requests.request(method, url, timeout=30, **kw)
    return r


def login_admin():
    r = req("POST", "/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    body = r.json()
    return body["token"], body["user"].get("id") or body["user"].get("user_id")


def register_user(suffix):
    email = f"locktest_{int(time.time())}_{uuid.uuid4().hex[:6]}_{suffix}@gmail.com"
    pw = "LockTest123!"
    full_name = f"Lock Tester {suffix.upper()}"
    r = req("POST", "/auth/register", json={"email": email, "password": pw, "full_name": full_name})
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    body = r.json()
    return body["token"], body["user"].get("id") or body["user"].get("user_id"), email


def get_profile(token):
    r = req("GET", "/profile", token=token)
    assert r.status_code == 200, f"profile fetch failed: {r.status_code} {r.text}"
    return r.json()


def create_goal(token, payload):
    r = req("POST", "/goals", token=token, json=payload)
    assert r.status_code == 200, f"create goal failed: {r.status_code} {r.text}"
    return r.json()


def get_goal(token, goal_id):
    r = req("GET", "/goals", token=token)
    assert r.status_code == 200, f"list goals failed: {r.status_code} {r.text}"
    goals = r.json().get("goals", [])
    for g in goals:
        if g.get("id") == goal_id:
            return g
    return None


def progress(token, goal_id, value):
    r = req("POST", f"/goals/{goal_id}/progress", token=token, json={"current_value": value})
    return r


def delete_goal(token, goal_id):
    r = req("DELETE", f"/goals/{goal_id}", token=token)
    return r


def mongo_patch_goal(goal_id, set_doc):
    client = MongoClient(MONGO_URL)
    try:
        db = client[DB_NAME]
        res = db.goals.update_one({"id": goal_id}, {"$set": set_doc})
        return res.modified_count
    finally:
        client.close()


def mongo_read_goal(goal_id):
    client = MongoClient(MONGO_URL)
    try:
        db = client[DB_NAME]
        return db.goals.find_one({"id": goal_id}, {"_id": 0})
    finally:
        client.close()


def parse_iso(s):
    if not s:
        return None
    return datetime.fromisoformat(str(s).replace("Z", "+00:00"))


def banner(title):
    print(f"\n{'='*70}\n  {title}\n{'='*70}")


# ─── TEST 1 — Weekly goal lock persists after un-tick (admin) ────────────
def test_weekly_admin_lock_persists(admin_token, admin_uid):
    banner("TEST 1 — Weekly goal lock persists after un-tick (admin)")

    # Step 1: Capture baseline
    prof_before = get_profile(admin_token)
    xp_before = int(prof_before.get("total_xp") or 0)
    level = prof_before.get("level")
    print(f"  ℹ️  admin xp_before={xp_before} level={level}")
    assert_true(level == 200, f"admin level=200 (got {level})")

    # Step 2: Create weekly goal
    goal = create_goal(admin_token, {
        "title": "LockTest-W",
        "focus_area": "fitness",
        "target_value": 1,
        "unit": "weeks",
        "xp_reward": 225,
    })
    gid = goal["id"]
    print(f"  ℹ️  created weekly goal id={gid}")

    # Step 3: Backdate created_at 10 days
    backdated = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    modified = mongo_patch_goal(gid, {"created_at": backdated})
    assert_eq(modified, 1, "Step 3 — mongo patched created_at (10 days ago)")

    # Step 4: GET /goals — confirm is_locked == False
    g = get_goal(admin_token, gid)
    assert_true(g is not None, "Step 4 — goal fetched")
    assert_eq(g.get("is_locked"), False, "Step 4 — is_locked == False after first-tick window expired")
    next_at = parse_iso(g.get("next_tick_available_at"))
    assert_true(next_at is None or next_at <= datetime.now(timezone.utc),
                "Step 4 — next_tick_available_at is null or in the past")

    # Step 5: POST progress current_value=1 → 200, lock fires
    r = progress(admin_token, gid, 1)
    assert_eq(r.status_code, 200, "Step 5 — progress=1 returns 200")
    g = get_goal(admin_token, gid)
    assert_eq(g.get("completed"), True, "Step 5 — goal completed")
    assert_eq(g.get("is_locked"), True, "Step 5 — goal is now LOCKED")
    next_at = parse_iso(g.get("next_tick_available_at"))
    assert_true(next_at is not None, "Step 5 — next_tick_available_at is set")
    # Should be ~7 days from now
    delta = (next_at - datetime.now(timezone.utc)).total_seconds() / 86400.0
    assert_true(6.99 <= delta <= 7.01, f"Step 5 — next_tick ~7d from now (got {delta:.4f}d)")

    prof_after_tick = get_profile(admin_token)
    xp_after_tick = int(prof_after_tick.get("total_xp") or 0)
    assert_eq(xp_after_tick - xp_before, 225, "Step 5 — admin total_xp increased by 225")

    # Capture next_tick before un-tick for comparison
    next_at_before_untick = next_at

    # Step 6: POST progress current_value=0 (UN-TICK)
    r = progress(admin_token, gid, 0)
    assert_eq(r.status_code, 200, "Step 6 — un-tick returns 200")
    g = get_goal(admin_token, gid)
    assert_eq(g.get("completed"), False, "Step 6 — completed=false after un-tick")
    assert_true(g.get("xp_awarded_on_complete") in (None, 0),
                "Step 6 — xp_awarded_on_complete cleared")
    prof_after_untick = get_profile(admin_token)
    xp_after_untick = int(prof_after_untick.get("total_xp") or 0)
    assert_eq(xp_after_untick, xp_before, "Step 6 — total_xp refunded (-225)")

    # ── CRITICAL: lock MUST persist ──
    assert_eq(g.get("is_locked"), True, "Step 6 CRITICAL — is_locked STILL TRUE after un-tick")
    next_at_after = parse_iso(g.get("next_tick_available_at"))
    assert_true(next_at_after is not None, "Step 6 CRITICAL — next_tick_available_at NOT null")
    if next_at_after and next_at_before_untick:
        # Should be ~the same (within seconds) since last_completed_at preserved
        diff = abs((next_at_after - next_at_before_untick).total_seconds())
        assert_true(diff < 5.0,
                    f"Step 6 CRITICAL — next_tick same as before un-tick (diff={diff:.2f}s)")

    # Verify last_completed_at NOT null in Mongo
    mongo_goal = mongo_read_goal(gid)
    lca = mongo_goal.get("last_completed_at") if mongo_goal else None
    assert_true(lca is not None,
                f"Step 6 CRITICAL — Mongo last_completed_at NOT null after un-tick (got {lca!r})")

    # Step 7: POST progress current_value=1 (RE-TICK ATTEMPT) — must 429
    r = progress(admin_token, gid, 1)
    assert_eq(r.status_code, 429, "Step 7 — re-tick returns 429")
    try:
        detail = r.json().get("detail") or {}
        if isinstance(detail, dict):
            assert_eq(detail.get("error"), "cycle_locked", "Step 7 — detail.error == 'cycle_locked'")
        else:
            assert_true(False, f"Step 7 — detail is not dict: {detail!r}")
    except Exception as e:
        assert_true(False, f"Step 7 — could not parse 429 body: {e}")

    prof_after_retick = get_profile(admin_token)
    xp_after_retick = int(prof_after_retick.get("total_xp") or 0)
    assert_eq(xp_after_retick, xp_before, "Step 7 — admin total_xp UNCHANGED (no XP awarded)")

    # Step 8: cleanup
    delete_goal(admin_token, gid)


# ─── TEST 2 — Monthly goal (non-admin) ───────────────────────────────────
def test_monthly_nonadmin_lock_persists():
    banner("TEST 2 — Monthly goal lock persists after un-tick (non-admin)")
    token, uid, email = register_user("monthly")
    print(f"  ℹ️  registered non-admin uid={uid} email={email}")

    prof_before = get_profile(token)
    xp_before = int(prof_before.get("total_xp") or 0)
    level = prof_before.get("level")
    print(f"  ℹ️  user xp_before={xp_before} level={level}")

    goal = create_goal(token, {
        "title": "LockTest-M",
        "focus_area": "fitness",
        "target_value": 1,
        "unit": "months",
        "xp_reward": 900,
    })
    gid = goal["id"]

    # Backdate 35 days
    backdated = (datetime.now(timezone.utc) - timedelta(days=35)).isoformat()
    modified = mongo_patch_goal(gid, {"created_at": backdated})
    assert_eq(modified, 1, "T2 — mongo patched created_at (35d ago)")

    g = get_goal(token, gid)
    assert_eq(g.get("is_locked"), False, "T2 — is_locked=False after first-tick window expired")

    # Tick to completion
    r = progress(token, gid, 1)
    assert_eq(r.status_code, 200, "T2 — progress=1 returns 200")
    g = get_goal(token, gid)
    assert_eq(g.get("completed"), True, "T2 — goal completed")
    assert_eq(g.get("is_locked"), True, "T2 — goal now locked")
    next_at = parse_iso(g.get("next_tick_available_at"))
    assert_true(next_at is not None, "T2 — next_tick set")
    delta_days = (next_at - datetime.now(timezone.utc)).total_seconds() / 86400.0
    assert_true(29.99 <= delta_days <= 30.01, f"T2 — next_tick ~30d (got {delta_days:.4f}d)")

    prof_after = get_profile(token)
    xp_after = int(prof_after.get("total_xp") or 0)
    assert_eq(xp_after - xp_before, 900, "T2 — total_xp += 900")

    next_at_before = next_at

    # UN-TICK
    r = progress(token, gid, 0)
    assert_eq(r.status_code, 200, "T2 — un-tick returns 200")
    g = get_goal(token, gid)
    assert_eq(g.get("completed"), False, "T2 — completed=false after un-tick")

    prof_after_untick = get_profile(token)
    xp_after_untick = int(prof_after_untick.get("total_xp") or 0)
    assert_eq(xp_after_untick, xp_before, "T2 — total_xp refunded -900")

    # CRITICAL: lock persists
    assert_eq(g.get("is_locked"), True, "T2 CRITICAL — is_locked STILL TRUE after un-tick")
    next_at_after = parse_iso(g.get("next_tick_available_at"))
    assert_true(next_at_after is not None, "T2 CRITICAL — next_tick NOT null after un-tick")
    diff = abs((next_at_after - next_at_before).total_seconds()) if next_at_after else 999
    assert_true(diff < 5.0, f"T2 CRITICAL — next_tick same as before (diff={diff:.2f}s)")

    mongo_goal = mongo_read_goal(gid)
    lca = mongo_goal.get("last_completed_at") if mongo_goal else None
    assert_true(lca is not None, f"T2 CRITICAL — Mongo last_completed_at NOT null (got {lca!r})")

    # RE-TICK attempt → 429
    r = progress(token, gid, 1)
    assert_eq(r.status_code, 429, "T2 — re-tick returns 429")
    detail = r.json().get("detail") or {}
    if isinstance(detail, dict):
        assert_eq(detail.get("error"), "cycle_locked", "T2 — detail.error == 'cycle_locked'")

    prof_after_retick = get_profile(token)
    assert_eq(int(prof_after_retick.get("total_xp") or 0), xp_before,
              "T2 — total_xp unchanged after 429")

    delete_goal(token, gid)


# ─── TEST 3 — Cycle expiration allows re-tick ────────────────────────────
def test_cycle_expires_allows_retick(admin_token):
    banner("TEST 3 — Sanity: when cycle expires, re-tick allowed")
    prof_before = get_profile(admin_token)
    xp_before = int(prof_before.get("total_xp") or 0)

    goal = create_goal(admin_token, {
        "title": "LockTest-W-Expire",
        "focus_area": "fitness",
        "target_value": 1,
        "unit": "weeks",
        "xp_reward": 225,
    })
    gid = goal["id"]

    # Backdate created_at 10 days
    backdated = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    mongo_patch_goal(gid, {"created_at": backdated})

    # Tick to completion
    r = progress(admin_token, gid, 1)
    assert_eq(r.status_code, 200, "T3 — progress=1 returns 200")

    # Un-tick
    r = progress(admin_token, gid, 0)
    assert_eq(r.status_code, 200, "T3 — un-tick returns 200")

    # Verify currently locked
    g = get_goal(admin_token, gid)
    assert_eq(g.get("is_locked"), True, "T3 — locked after un-tick")

    # Now backdate last_completed_at to 8 days ago (simulating cycle expiration)
    expired_lca = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
    modified = mongo_patch_goal(gid, {"last_completed_at": expired_lca})
    assert_eq(modified, 1, "T3 — mongo patched last_completed_at (8d ago)")

    # Re-fetch — should be unlocked
    g = get_goal(admin_token, gid)
    assert_eq(g.get("is_locked"), False, "T3 — is_locked=False after cycle expires")

    # Re-tick should succeed
    r = progress(admin_token, gid, 1)
    assert_eq(r.status_code, 200, "T3 — re-tick succeeds (cycle expired)")

    delete_goal(admin_token, gid)


# ─── TEST 4 — Step-progress goals ────────────────────────────────────────
def test_step_progress_partial_untick(admin_token):
    banner("TEST 4 — Step-progress goals (target > 1) — partial un-ticks don't reset lock")

    goal = create_goal(admin_token, {
        "title": "LockTest-Steps",
        "focus_area": "mindset",
        "target_value": 3,
        "unit": "weeks",
        "xp_reward": 225,
    })
    gid = goal["id"]

    # Backdate
    backdated = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    mongo_patch_goal(gid, {"created_at": backdated})

    # Tick 1, 2, 3
    for v in (1, 2, 3):
        r = progress(admin_token, gid, v)
        assert_eq(r.status_code, 200, f"T4 — progress={v} returns 200")

    g = get_goal(admin_token, gid)
    assert_eq(g.get("completed"), True, "T4 — goal completed at 3/3")
    assert_eq(g.get("is_locked"), True, "T4 — locked after completion")

    mongo_goal = mongo_read_goal(gid)
    assert_true(mongo_goal.get("last_completed_at") is not None,
                "T4 — last_completed_at set")

    # Partial un-tick: 3 → 2
    r = progress(admin_token, gid, 2)
    assert_eq(r.status_code, 200, "T4 — partial un-tick (3→2) returns 200")
    g = get_goal(admin_token, gid)
    assert_eq(g.get("completed"), False, "T4 — completed=false after partial un-tick")

    # CRITICAL: lock persists
    assert_eq(g.get("is_locked"), True, "T4 CRITICAL — is_locked STILL TRUE after partial un-tick")
    mongo_goal = mongo_read_goal(gid)
    assert_true(mongo_goal.get("last_completed_at") is not None,
                "T4 CRITICAL — Mongo last_completed_at preserved after partial un-tick")

    # Re-tick to 3 → must 429
    r = progress(admin_token, gid, 3)
    assert_eq(r.status_code, 429, "T4 — re-tick to 3 returns 429")
    detail = r.json().get("detail") or {}
    if isinstance(detail, dict):
        assert_eq(detail.get("error"), "cycle_locked", "T4 — detail.error == 'cycle_locked'")

    delete_goal(admin_token, gid)


# ─── TEST 5 — Regression: timeframe change resets lock ───────────────────
def test_timeframe_change_resets_lock(admin_token):
    banner("TEST 5 — Regression: GoalUpdate timeframe change still resets lock")

    goal = create_goal(admin_token, {
        "title": "LockTest-Regression",
        "focus_area": "fitness",
        "target_value": 5,
        "unit": "weeks",
        "xp_reward": 100,
    })
    gid = goal["id"]

    # Backdate so we can tick within window
    backdated = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    mongo_patch_goal(gid, {"created_at": backdated})

    # Tick progress so last_ticked_at + last_completed_at are set
    for v in (1, 2, 3, 4, 5):
        r = progress(admin_token, gid, v)
        assert_eq(r.status_code, 200, f"T5 — progress={v} returns 200")

    g = get_goal(admin_token, gid)
    assert_eq(g.get("completed"), True, "T5 — completed")
    assert_eq(g.get("is_locked"), True, "T5 — locked after completion")

    # PUT — change unit weeks → months
    r = req("PUT", f"/goals/{gid}", token=admin_token, json={"unit": "months"})
    assert_eq(r.status_code, 200, "T5 — PUT unit=months returns 200")

    # Verify created_at reset + last_completed_at cleared
    mongo_goal = mongo_read_goal(gid)
    lca = mongo_goal.get("last_completed_at")
    assert_true(lca is None, f"T5 — last_completed_at cleared after unit change (got {lca!r})")
    created = parse_iso(mongo_goal.get("created_at"))
    if created:
        age = (datetime.now(timezone.utc) - created).total_seconds()
        assert_true(age < 30, f"T5 — created_at reset to now-ish (age={age:.1f}s)")

    # Goal should be locked under new monthly cycle (first-tick lock)
    g = get_goal(admin_token, gid)
    assert_eq(g.get("is_locked"), True, "T5 — locked under new monthly cycle")
    assert_eq(g.get("unit"), "months", "T5 — unit is now 'months'")

    # current_value should also have been reset? Let's check — but the new
    # progress=1 should still fail because cycle just started.
    # Re-fetch current_value from mongo
    mongo_goal = mongo_read_goal(gid)
    cv = int(mongo_goal.get("current_value") or 0)
    print(f"  ℹ️  current_value after unit change = {cv}")

    # Re-tick attempt — must 429 cycle_locked
    target = int(mongo_goal.get("target_value") or 5)
    # increment to target if not already
    next_val = min(cv + 1, target)
    if next_val == cv:
        next_val = cv + 1
    r = progress(admin_token, gid, next_val)
    assert_eq(r.status_code, 429, "T5 — re-tick under fresh monthly cycle returns 429")
    detail = r.json().get("detail") or {}
    if isinstance(detail, dict):
        assert_eq(detail.get("error"), "cycle_locked", "T5 — detail.error == 'cycle_locked'")

    delete_goal(admin_token, gid)


# ─── Main ─────────────────────────────────────────────────────────────────
def main():
    print(f"Backend: {BASE}")
    print(f"Mongo:   {MONGO_URL} db={DB_NAME}")
    admin_token, admin_uid = login_admin()
    print(f"Admin logged in as uid={admin_uid}")

    try:
        test_weekly_admin_lock_persists(admin_token, admin_uid)
    except Exception as e:
        global FAIL
        FAIL += 1
        FAIL_DETAIL.append(f"TEST 1 crashed: {e!r}")
        print(f"  ❌ TEST 1 crashed: {e!r}")

    try:
        test_monthly_nonadmin_lock_persists()
    except Exception as e:
        FAIL += 1
        FAIL_DETAIL.append(f"TEST 2 crashed: {e!r}")
        print(f"  ❌ TEST 2 crashed: {e!r}")

    try:
        test_cycle_expires_allows_retick(admin_token)
    except Exception as e:
        FAIL += 1
        FAIL_DETAIL.append(f"TEST 3 crashed: {e!r}")
        print(f"  ❌ TEST 3 crashed: {e!r}")

    try:
        test_step_progress_partial_untick(admin_token)
    except Exception as e:
        FAIL += 1
        FAIL_DETAIL.append(f"TEST 4 crashed: {e!r}")
        print(f"  ❌ TEST 4 crashed: {e!r}")

    try:
        test_timeframe_change_resets_lock(admin_token)
    except Exception as e:
        FAIL += 1
        FAIL_DETAIL.append(f"TEST 5 crashed: {e!r}")
        print(f"  ❌ TEST 5 crashed: {e!r}")

    print(f"\n{'='*70}")
    print(f"  FINAL: {PASS} PASS / {FAIL} FAIL")
    print(f"{'='*70}")
    if FAIL_DETAIL:
        print("Failures:")
        for d in FAIL_DETAIL:
            print(f"  • {d}")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
