"""
goals_daily_lock_test.py — verifies new Daily-goal once-per-day lockout
on /api/goals/{id}/progress.

Run:  python3 /app/goals_daily_lock_test.py
"""
import os
import sys
import time
import uuid
import json
import secrets
import requests
from datetime import datetime, timedelta, timezone
from pymongo import MongoClient

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

# ── Mongo ───────────────────────────────────────────────────────────────
def _load_env(path: str) -> dict:
    out = {}
    with open(path) as f:
        for ln in f:
            ln = ln.strip()
            if not ln or ln.startswith("#") or "=" not in ln:
                continue
            k, v = ln.split("=", 1)
            v = v.strip().strip('"').strip("'")
            out[k.strip()] = v
    return out


_env = _load_env("/app/backend/.env")
MONGO_URL = _env.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = _env.get("DB_NAME", "test_database")
mc = MongoClient(MONGO_URL)
db = mc[DB_NAME]

PASS = 0
FAIL = 0
FAILS = []


def _r(ok: bool, msg: str):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✅ {msg}")
    else:
        FAIL += 1
        FAILS.append(msg)
        print(f"  ❌ {msg}")


def _hdr(tok: str | None = None) -> dict:
    h = {"Content-Type": "application/json"}
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


# ── helpers ─────────────────────────────────────────────────────────────
def admin_login():
    r = requests.post(f"{BASE}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    r.raise_for_status()
    return r.json()["token"]


def register_user(full_name: str):
    suf = secrets.token_hex(4)
    email = f"locktest_{int(time.time())}_{suf}@gmail.com"
    pw = "DailyLock123!"
    r = requests.post(f"{BASE}/auth/register",
                      json={"full_name": full_name, "email": email, "password": pw})
    r.raise_for_status()
    body = r.json()
    return body["token"], body["user"]["id"], email, pw


def get_profile(tok: str):
    r = requests.get(f"{BASE}/profile", headers=_hdr(tok))
    r.raise_for_status()
    return r.json()


def force_set_morning(user_id: str, day_start_time: str, tz: str):
    """Bypass the PUT /profile 'tz_locked' / 'day_start_locked' guards by
    direct-mongo-patching. Always works regardless of prior state."""
    db.profile.update_one(
        {"_id": user_id},
        {"$set": {"day_start_time": day_start_time, "timezone": tz, "onboarding_tz_done": True}},
        upsert=True,
    )


def create_goal(tok: str, **body):
    payload = {
        "title": body.get("title", "T"),
        "focus_area": body.get("focus_area", "mindset"),
        "target_value": body.get("target_value", 5),
        "unit": body.get("unit", "days"),
        "xp_reward": body.get("xp_reward", 30),
        "description": body.get("description", ""),
    }
    r = requests.post(f"{BASE}/goals", headers=_hdr(tok), json=payload)
    if r.status_code != 200:
        print("create_goal failed:", r.status_code, r.text)
    r.raise_for_status()
    return r.json()


def list_goals(tok: str):
    r = requests.get(f"{BASE}/goals", headers=_hdr(tok))
    r.raise_for_status()
    return r.json()["goals"]


def find_goal(goals: list, gid: str):
    return next((g for g in goals if g.get("id") == gid), None)


def progress(tok: str, gid: str, val: int):
    r = requests.post(f"{BASE}/goals/{gid}/progress", headers=_hdr(tok),
                      json={"current_value": val})
    return r


def delete_goal(tok: str, gid: str):
    r = requests.delete(f"{BASE}/goals/{gid}", headers=_hdr(tok))
    return r.status_code == 200


def iso_to_dt(s: str) -> datetime:
    s2 = s.replace("Z", "+00:00") if s else s
    return datetime.fromisoformat(s2)


# ╔══════════════════════════════════════════════════════════════════════╗
# ║   Test 1 — Daily lock fires after FIRST tick (admin)                ║
# ╚══════════════════════════════════════════════════════════════════════╝
def test_1_admin_daily_lock(admin_tok: str, admin_id: str):
    print("\n=== TEST 1 — Admin daily-goal first-tick lock ===")
    prof = get_profile(admin_tok)
    lvl = prof.get("level")
    print(f"  admin level={lvl} total_xp={prof.get('total_xp')}")
    _r(lvl is not None and isinstance(lvl, int), f"admin profile.level retrieved (={lvl})")

    # Force morning schedule via mongo (works whether or not already set)
    force_set_morning(admin_id, "07:00", "UTC")
    prof2 = get_profile(admin_tok)
    _r(prof2.get("day_start_time") == "07:00", f"admin day_start_time=07:00 (got {prof2.get('day_start_time')})")
    _r(prof2.get("timezone") == "UTC", f"admin timezone=UTC (got {prof2.get('timezone')})")

    # Create daily goal
    g = create_goal(admin_tok,
                    title="DailyLockTest",
                    focus_area="mindset",
                    target_value=5,
                    unit="days",
                    xp_reward=30,
                    description="")
    gid = g["id"]
    _r(g.get("unit") == "days", f"goal unit='days' (got {g.get('unit')})")
    _r(g.get("target_value") == 5, "goal target_value=5")

    # Pre-tick state
    goals = list_goals(admin_tok)
    gg = find_goal(goals, gid)
    _r(gg is not None, "goal listed in /goals")
    _r(gg.get("is_locked") is False, f"pre-tick is_locked=False (got {gg.get('is_locked')})")
    _r(gg.get("next_tick_available_at") is None,
       f"pre-tick next_tick_available_at is null (got {gg.get('next_tick_available_at')})")

    # XP baseline
    pre_xp = get_profile(admin_tok).get("total_xp", 0)

    # First tick
    r1 = progress(admin_tok, gid, 1)
    _r(r1.status_code == 200, f"first +1 tick → 200 (got {r1.status_code})")
    body1 = r1.json() if r1.status_code == 200 else {}
    _r(body1.get("current_value") == 1, f"current_value=1 after first tick (got {body1.get('current_value')})")

    # Re-fetch goal
    goals = list_goals(admin_tok)
    gg = find_goal(goals, gid)
    _r(gg.get("is_locked") is True, f"is_locked=True after tick (got {gg.get('is_locked')})")
    nta_iso = gg.get("next_tick_available_at")
    _r(nta_iso is not None, f"next_tick_available_at NON-null (got {nta_iso})")
    if nta_iso:
        nta = iso_to_dt(nta_iso)
        now = datetime.now(timezone.utc)
        delta_h = (nta - now).total_seconds() / 3600.0
        _r(0 < delta_h < 24.5, f"next_tick within 0–24h (Δ={delta_h:.2f}h)")

    # XP after first tick: daily step XP is fixed 30/step
    xp_after = get_profile(admin_tok).get("total_xp", 0)
    _r(xp_after - pre_xp == 30, f"admin total_xp +30 after first tick (Δ={xp_after-pre_xp})")

    # Second tick attempt → MUST 429
    r2 = progress(admin_tok, gid, 2)
    _r(r2.status_code == 429, f"second tick within day → 429 (got {r2.status_code})")
    if r2.status_code == 429:
        d = r2.json().get("detail", {})
        _r(isinstance(d, dict), f"detail is dict (got type={type(d).__name__})")
        _r(d.get("error") == "daily_locked", f"detail.error=='daily_locked' (got {d.get('error')})")
        _r(d.get("unit") == "days", f"detail.unit=='days' (got {d.get('unit')})")
        _r(bool(d.get("next_tick_available_at")), f"detail.next_tick_available_at set (got {d.get('next_tick_available_at')})")

    # XP must NOT have changed on 429
    xp_after_429 = get_profile(admin_tok).get("total_xp", 0)
    _r(xp_after_429 == xp_after, f"admin total_xp UNCHANGED on 429 (was {xp_after}, now {xp_after_429})")

    return gid


# ╔══════════════════════════════════════════════════════════════════════╗
# ║   Test 2 — Un-tick does NOT release daily cooldown (admin)          ║
# ╚══════════════════════════════════════════════════════════════════════╝
def test_2_admin_untick_keeps_lock(admin_tok: str, gid: str):
    print("\n=== TEST 2 — Admin un-tick does NOT release daily cooldown ===")
    pre_xp = get_profile(admin_tok).get("total_xp", 0)

    # Capture pre-untick lock state
    goals = list_goals(admin_tok)
    gg_pre = find_goal(goals, gid)
    pre_nta = gg_pre.get("next_tick_available_at")
    _r(gg_pre.get("is_locked") is True, "pre-untick is_locked=True")

    # Un-tick (set to 0)
    r = progress(admin_tok, gid, 0)
    _r(r.status_code == 200, f"un-tick to 0 → 200 (got {r.status_code})")
    body = r.json() if r.status_code == 200 else {}
    _r(body.get("current_value") == 0, f"current_value=0 after un-tick (got {body.get('current_value')})")
    _r(body.get("completed") is False, f"completed=False (got {body.get('completed')})")

    # XP refunded -30
    xp_after = get_profile(admin_tok).get("total_xp", 0)
    _r(xp_after - pre_xp == -30, f"admin total_xp refunded by 30 (Δ={xp_after-pre_xp})")

    # CRITICAL: re-fetch — lock should STILL be true
    goals = list_goals(admin_tok)
    gg_post = find_goal(goals, gid)
    _r(gg_post.get("is_locked") is True,
       f"CRITICAL: is_locked STILL True after un-tick (got {gg_post.get('is_locked')})")
    post_nta = gg_post.get("next_tick_available_at")
    _r(post_nta is not None,
       f"CRITICAL: next_tick_available_at STILL non-null after un-tick (got {post_nta})")
    if pre_nta and post_nta:
        d = abs((iso_to_dt(post_nta) - iso_to_dt(pre_nta)).total_seconds())
        _r(d < 2.0, f"next_tick_available_at preserved (diff={d:.2f}s)")

    # Verify mongo `last_ticked_at` is preserved on the daily goal
    raw = db.goals.find_one({"id": gid})
    _r(raw is not None and raw.get("last_ticked_at") not in (None, ""),
       f"Mongo last_ticked_at preserved (got {raw.get('last_ticked_at') if raw else None})")

    # Re-tick attempt → MUST 429
    r2 = progress(admin_tok, gid, 1)
    _r(r2.status_code == 429, f"re-tick after untick → 429 (got {r2.status_code})")
    if r2.status_code == 429:
        d = r2.json().get("detail", {})
        _r(d.get("error") == "daily_locked", f"detail.error=='daily_locked' (got {d.get('error')})")

    # XP must still be unchanged
    xp_after_429 = get_profile(admin_tok).get("total_xp", 0)
    _r(xp_after_429 == xp_after, f"XP unchanged on re-tick 429 (was {xp_after}, now {xp_after_429})")

    # Cleanup
    _r(delete_goal(admin_tok, gid), "admin daily goal deleted")


# ╔══════════════════════════════════════════════════════════════════════╗
# ║   Test 3 — Fresh non-admin user same flow                           ║
# ╚══════════════════════════════════════════════════════════════════════╝
def test_3_nonadmin_flow():
    print("\n=== TEST 3 — Fresh non-admin user end-to-end ===")
    tok, uid, email, _ = register_user("Daily Lock Tester")
    print(f"  registered {email} uid={uid}")

    # Set morning + tz (first write — should work via PUT /profile)
    r = requests.put(f"{BASE}/profile", headers=_hdr(tok),
                     json={"day_start_time": "06:00", "timezone": "Europe/Bucharest"})
    if r.status_code != 200:
        # Fallback: direct patch
        force_set_morning(uid, "06:00", "Europe/Bucharest")
    prof = get_profile(tok)
    _r(prof.get("day_start_time") == "06:00", f"day_start_time=06:00 (got {prof.get('day_start_time')})")
    _r(prof.get("timezone") == "Europe/Bucharest", f"timezone=Europe/Bucharest (got {prof.get('timezone')})")

    # Create daily goal
    g = create_goal(tok, title="NonAdminDaily", focus_area="mindset",
                    target_value=3, unit="days", xp_reward=30, description="")
    gid = g["id"]
    _r(g.get("unit") == "days" and g.get("target_value") == 3, "goal created (unit=days, target=3)")

    pre_xp = prof.get("total_xp", 0)

    # First tick
    r1 = progress(tok, gid, 1)
    _r(r1.status_code == 200, f"non-admin first tick → 200 (got {r1.status_code})")

    # Check locked
    goals = list_goals(tok)
    gg = find_goal(goals, gid)
    _r(gg.get("is_locked") is True, "is_locked=True after first tick")
    _r(gg.get("next_tick_available_at") is not None, "next_tick set")

    # XP +30
    xp_after = get_profile(tok).get("total_xp", 0)
    _r(xp_after - pre_xp == 30, f"non-admin XP +30 (Δ={xp_after-pre_xp})")

    # Second tick → 429
    r2 = progress(tok, gid, 2)
    _r(r2.status_code == 429, f"non-admin 2nd tick → 429 (got {r2.status_code})")
    if r2.status_code == 429:
        d = r2.json().get("detail", {})
        _r(d.get("error") == "daily_locked", f"detail.error=='daily_locked' (got {d.get('error')})")

    # Un-tick
    r3 = progress(tok, gid, 0)
    _r(r3.status_code == 200, f"non-admin un-tick → 200 (got {r3.status_code})")

    # Still locked
    goals = list_goals(tok)
    gg2 = find_goal(goals, gid)
    _r(gg2.get("is_locked") is True, "non-admin CRITICAL: locked stays after un-tick")
    _r(gg2.get("next_tick_available_at") is not None, "next_tick still set after un-tick")

    # Re-tick → 429
    r4 = progress(tok, gid, 1)
    _r(r4.status_code == 429, f"non-admin re-tick → 429 (got {r4.status_code})")
    if r4.status_code == 429:
        d = r4.json().get("detail", {})
        _r(d.get("error") == "daily_locked", f"non-admin re-tick error=='daily_locked' (got {d.get('error')})")

    return tok, uid, gid


# ╔══════════════════════════════════════════════════════════════════════╗
# ║   Test 4 — Weekly/Monthly not affected (regression)                 ║
# ╚══════════════════════════════════════════════════════════════════════╝
def test_4_weekly_regression(tok: str, uid: str):
    print("\n=== TEST 4 — Weekly/Monthly regression on the same user ===")
    # Create weekly goal
    g = create_goal(tok, title="WeeklyRegression", focus_area="mindset",
                    target_value=1, unit="weeks", xp_reward=100, description="")
    gid = g["id"]
    _r(g.get("unit") == "weeks", "weekly goal created")

    # Direct mongo patch created_at to 10 days ago (so first-tick window has expired)
    backdate = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    db.goals.update_one({"id": gid, "user_id": uid}, {"$set": {"created_at": backdate}})

    # Tick to completion
    r1 = progress(tok, gid, 1)
    _r(r1.status_code == 200, f"weekly tick to completion → 200 (got {r1.status_code})")
    body = r1.json() if r1.status_code == 200 else {}
    _r(body.get("completed") is True, f"weekly goal completed (got {body.get('completed')})")

    # Un-tick
    r2 = progress(tok, gid, 0)
    _r(r2.status_code == 200, f"weekly un-tick → 200 (got {r2.status_code})")

    # Verify last_completed_at preserved
    raw = db.goals.find_one({"id": gid})
    _r(raw is not None and raw.get("last_completed_at") not in (None, ""),
       f"Mongo last_completed_at preserved on weekly (got {raw.get('last_completed_at') if raw else None})")

    # Re-tick → 429 cycle_locked (NOT daily_locked)
    r3 = progress(tok, gid, 1)
    _r(r3.status_code == 429, f"weekly re-tick → 429 (got {r3.status_code})")
    if r3.status_code == 429:
        d = r3.json().get("detail", {})
        _r(d.get("error") == "cycle_locked",
           f"weekly detail.error=='cycle_locked' (NOT daily_locked) (got {d.get('error')})")
        _r(d.get("unit") == "weeks", f"weekly detail.unit=='weeks' (got {d.get('unit')})")

    # Cleanup
    _r(delete_goal(tok, gid), "weekly regression goal deleted")

    # Daily next-to-weekly: confirm new daily goal still flows correctly
    g2 = create_goal(tok, title="DailyAlongside", focus_area="mindset",
                     target_value=3, unit="days", xp_reward=30, description="")
    gid2 = g2["id"]
    r4 = progress(tok, gid2, 1)
    _r(r4.status_code == 200, f"alongside daily first tick → 200 (got {r4.status_code})")
    r5 = progress(tok, gid2, 2)
    _r(r5.status_code == 429, f"alongside daily 2nd tick → 429 (got {r5.status_code})")
    if r5.status_code == 429:
        d = r5.json().get("detail", {})
        _r(d.get("error") == "daily_locked",
           f"alongside daily error=='daily_locked' (got {d.get('error')})")
    _r(delete_goal(tok, gid2), "alongside daily goal deleted")


# ╔══════════════════════════════════════════════════════════════════════╗
# ║   Test 5 — Wake-time boundary correctness (admin)                   ║
# ╚══════════════════════════════════════════════════════════════════════╝
def test_5_wake_boundary(admin_tok: str, admin_id: str):
    print("\n=== TEST 5 — Wake-time boundary correctness ===")
    # Ensure admin morning settings = 07:00 UTC
    force_set_morning(admin_id, "07:00", "UTC")

    # Create a fresh daily goal
    g = create_goal(admin_tok, title="WakeBoundaryTest", focus_area="mindset",
                    target_value=5, unit="days", xp_reward=30, description="")
    gid = g["id"]

    # ── Case A: last_ticked_at = 25h ago → must be UNLOCKED now ────────
    t_25h = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
    db.goals.update_one({"id": gid, "user_id": admin_id}, {"$set": {"last_ticked_at": t_25h}})
    goals = list_goals(admin_tok)
    gg = find_goal(goals, gid)
    _r(gg.get("is_locked") is False,
       f"25h-ago tick → is_locked=False (got {gg.get('is_locked')}) | next={gg.get('next_tick_available_at')}")

    # ── Case B: last_ticked_at = 20h ago ────────────────────────────────
    # Whether locked or not depends on whether "now" has crossed 07:00 UTC
    # relative to (now-20h). Compute expected outcome dynamically.
    last_dt = datetime.now(timezone.utc) - timedelta(hours=20)
    today_wake = last_dt.replace(hour=7, minute=0, second=0, microsecond=0)
    next_unlock = today_wake if last_dt < today_wake else today_wake + timedelta(days=1)
    expected_locked = datetime.now(timezone.utc) < next_unlock
    t_20h = last_dt.isoformat()
    db.goals.update_one({"id": gid, "user_id": admin_id}, {"$set": {"last_ticked_at": t_20h}})
    goals = list_goals(admin_tok)
    gg = find_goal(goals, gid)
    nta = gg.get("next_tick_available_at")
    if nta:
        nta_dt = iso_to_dt(nta)
        # tolerate 5-second variance vs expected next_unlock
        diff = abs((nta_dt - next_unlock).total_seconds())
        _r(diff < 5.0,
           f"20h-ago tick: next_unlock matches expected (diff={diff:.2f}s, expected={next_unlock.isoformat()}, got={nta})")
    else:
        # if expected_locked was true, we'd expect a non-null next_tick
        if expected_locked:
            _r(False, "20h-ago tick: expected next_tick_available_at non-null")
        else:
            _r(gg.get("is_locked") is False, "20h-ago tick: unlocked, next_tick null OK")
    _r(gg.get("is_locked") == expected_locked,
       f"20h-ago tick: is_locked={gg.get('is_locked')} matches expected={expected_locked}")

    # Cleanup
    _r(delete_goal(admin_tok, gid), "wake-boundary goal deleted")


def main():
    print(f"BASE = {BASE}")
    admin_tok = admin_login()
    admin_prof = get_profile(admin_tok)
    admin_id = admin_prof.get("user_id") or admin_prof.get("id")
    if not admin_id:
        # Try alt path
        r = requests.get(f"{BASE}/profile", headers=_hdr(admin_tok))
        admin_id = (r.json() or {}).get("user_id") or (r.json() or {}).get("id")
    if not admin_id:
        # Probe DB by email
        u = db.users.find_one({"email": ADMIN_EMAIL.lower()})
        admin_id = u["_id"] if u else None
    print(f"admin uid={admin_id}")
    assert admin_id, "could not resolve admin user id"

    gid_admin = test_1_admin_daily_lock(admin_tok, admin_id)
    test_2_admin_untick_keeps_lock(admin_tok, gid_admin)
    tok_b, uid_b, gid_b = test_3_nonadmin_flow()
    # cleanup that user's daily goal
    delete_goal(tok_b, gid_b)
    test_4_weekly_regression(tok_b, uid_b)
    test_5_wake_boundary(admin_tok, admin_id)

    print("\n" + "=" * 60)
    print(f"  RESULT: {PASS} PASS / {FAIL} FAIL")
    if FAILS:
        print("\nFAILED ASSERTIONS:")
        for f in FAILS:
            print(f"  ❌ {f}")
    print("=" * 60)
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
