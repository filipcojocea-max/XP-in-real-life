"""
Tests the new goal caps + restart endpoint:
- MAX_ACTIVE_GOALS=8 (overall)
- MAX_ACTIVE_DAILY_GOALS=5 (separate daily cap)
- POST /api/goals/{id}/restart

Run: python3 /app/goals_caps_restart_test.py
"""

import os
import sys
import uuid
import time
import secrets
from datetime import datetime, timezone, timedelta

import requests
from pymongo import MongoClient

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

PASS = 0
FAIL = 0
FAILED_DESC = []


def t(cond, desc):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS — {desc}")
    else:
        FAIL += 1
        FAILED_DESC.append(desc)
        print(f"  FAIL — {desc}")


def hdr(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def register_user(full_name):
    email = f"goalcaps_{int(time.time())}_{secrets.token_hex(3)}@gmail.com"
    pwd = "GoalCapTest123!"
    r = requests.post(
        f"{BASE}/auth/register",
        json={"email": email, "password": pwd, "full_name": full_name},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"register failed: {r.status_code} {r.text}")
    data = r.json()
    token = data.get("access_token") or data.get("token") or data.get("jwt")
    if not token:
        # Try /auth/login
        r2 = requests.post(
            f"{BASE}/auth/login", json={"email": email, "password": pwd}, timeout=30
        )
        token = r2.json().get("access_token") or r2.json().get("token")
    user_obj = data.get("user") or {}
    uid = user_obj.get("id") or user_obj.get("user_id")
    if not uid:
        # Fallback: decode JWT 'sub' claim
        try:
            import base64, json as _json
            payload = token.split(".")[1]
            payload += "=" * (-len(payload) % 4)
            decoded = _json.loads(base64.urlsafe_b64decode(payload))
            uid = decoded.get("sub")
        except Exception:
            pass
    return {"email": email, "password": pwd, "token": token, "user_id": uid, "name": full_name}


def admin_login():
    r = requests.post(
        f"{BASE}/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"admin login failed: {r.status_code} {r.text}")
    data = r.json()
    token = data.get("access_token") or data.get("token") or data.get("jwt")
    r2 = requests.get(f"{BASE}/profile", headers=hdr(token), timeout=30)
    prof = r2.json()
    return {"token": token, "user_id": prof.get("id") or prof.get("user_id")}


def create_goal(token, *, title, focus_area, target_value, unit, xp_reward):
    return requests.post(
        f"{BASE}/goals",
        json={
            "title": title,
            "focus_area": focus_area,
            "target_value": target_value,
            "unit": unit,
            "xp_reward": xp_reward,
            "description": "",
        },
        headers=hdr(token),
        timeout=30,
    )


def list_goals(token):
    return requests.get(f"{BASE}/goals", headers=hdr(token), timeout=30).json().get("goals", [])


def delete_goal(token, gid):
    return requests.delete(f"{BASE}/goals/{gid}", headers=hdr(token), timeout=30)


def progress_goal(token, gid, val):
    return requests.post(
        f"{BASE}/goals/{gid}/progress",
        json={"current_value": val},
        headers=hdr(token),
        timeout=30,
    )


def restart_goal(token, gid):
    return requests.post(f"{BASE}/goals/{gid}/restart", headers=hdr(token), timeout=30)


def get_profile(token):
    return requests.get(f"{BASE}/profile", headers=hdr(token), timeout=30).json()


def main():
    global PASS, FAIL
    mc = MongoClient(MONGO_URL)
    db = mc[DB_NAME]

    admin = admin_login()
    print(f"\n[setup] admin uid={admin['user_id']}")

    # ============================================================
    # TEST A — MAX_ACTIVE_GOALS bumped to 8
    # ============================================================
    print("\n===== TEST A — overall cap = 8 =====")
    user_a = register_user("Cap Tester A")
    print(f"[A] registered user uid={user_a['user_id']} email={user_a['email']}")

    # 5 daily (target=10 xp=20) + 2 weekly (target=5 xp=100) + 1 monthly (target=2 xp=500) = 8
    created_ids_A = []
    for i in range(5):
        r = create_goal(user_a["token"], title=f"A-Daily-{i+1}", focus_area="mindset",
                         target_value=10, unit="days", xp_reward=20)
        t(r.status_code == 200, f"A.{i+1} daily goal create → 200 (got {r.status_code})")
        if r.status_code == 200:
            created_ids_A.append(r.json()["id"])
    for i in range(2):
        r = create_goal(user_a["token"], title=f"A-Weekly-{i+1}", focus_area="fitness",
                         target_value=5, unit="weeks", xp_reward=100)
        t(r.status_code == 200, f"A.{i+6} weekly goal create → 200 (got {r.status_code})")
        if r.status_code == 200:
            created_ids_A.append(r.json()["id"])
    r = create_goal(user_a["token"], title="A-Monthly-1", focus_area="fitness",
                     target_value=2, unit="months", xp_reward=500)
    t(r.status_code == 200, f"A.8 monthly goal create → 200 (got {r.status_code})")
    if r.status_code == 200:
        created_ids_A.append(r.json()["id"])

    t(len(created_ids_A) == 8, f"A — exactly 8 goals active (got {len(created_ids_A)})")

    # 9th goal of any unit
    r = create_goal(user_a["token"], title="A-9th-weekly", focus_area="mindset",
                     target_value=3, unit="weeks", xp_reward=50)
    t(r.status_code == 400, f"A.9 — 9th weekly goal → 400 (got {r.status_code})")
    if r.status_code == 400:
        detail = r.json().get("detail", {})
        t(isinstance(detail, dict) and detail.get("error") == "goal_limit_reached",
          f"A.9 — detail.error == 'goal_limit_reached' (got {detail.get('error') if isinstance(detail, dict) else detail})")
        t(isinstance(detail, dict) and detail.get("limit") == 8,
          f"A.9 — detail.limit == 8 (got {detail.get('limit') if isinstance(detail, dict) else None})")

    # ============================================================
    # TEST B — MAX_ACTIVE_DAILY_GOALS=5
    # ============================================================
    print("\n===== TEST B — daily cap = 5 =====")
    user_b = register_user("Cap Tester B")
    print(f"[B] registered uid={user_b['user_id']}")

    daily_ids_B = []
    for i in range(5):
        r = create_goal(user_b["token"], title=f"B-Daily-{i+1}", focus_area="mindset",
                         target_value=10, unit="days", xp_reward=20)
        t(r.status_code == 200, f"B.{i+1} daily goal create → 200 (got {r.status_code})")
        if r.status_code == 200:
            daily_ids_B.append(r.json()["id"])

    # 6th daily → must hit daily cap
    r = create_goal(user_b["token"], title="B-Daily-6", focus_area="mindset",
                     target_value=5, unit="days", xp_reward=10)
    t(r.status_code == 400, f"B.6 — 6th daily → 400 (got {r.status_code})")
    if r.status_code == 400:
        detail = r.json().get("detail", {})
        t(isinstance(detail, dict) and detail.get("error") == "daily_goal_limit_reached",
          f"B.6 — detail.error == 'daily_goal_limit_reached' (got {detail.get('error')})")
        t(isinstance(detail, dict) and detail.get("limit") == 5,
          f"B.6 — detail.limit == 5 (got {detail.get('limit')})")
        t(isinstance(detail, dict) and detail.get("unit") == "days",
          f"B.6 — detail.unit == 'days' (got {detail.get('unit')})")

    # Weekly should still succeed (5 active daily, overall=5, 3 slots free)
    r = create_goal(user_b["token"], title="B-Weekly-1", focus_area="fitness",
                     target_value=3, unit="weeks", xp_reward=100)
    t(r.status_code == 200, f"B — weekly goal succeeds w/ 5 daily already (got {r.status_code})")
    weekly_B_id = r.json()["id"] if r.status_code == 200 else None

    # ============================================================
    # TEST C — daily cap on PUT timeframe change
    # ============================================================
    print("\n===== TEST C — PUT switch into days hits daily cap =====")

    # Test B user currently has 5 daily + 1 weekly.
    # PUT weekly_B {unit:'days'} → 400 daily_goal_limit_reached
    r = requests.put(
        f"{BASE}/goals/{weekly_B_id}",
        json={"unit": "days"},
        headers=hdr(user_b["token"]),
        timeout=30,
    )
    t(r.status_code == 400, f"C.1 — PUT weekly→days when 5 daily already → 400 (got {r.status_code})")
    if r.status_code == 400:
        detail = r.json().get("detail", {})
        t(isinstance(detail, dict) and detail.get("error") == "daily_goal_limit_reached",
          f"C.1 — detail.error == 'daily_goal_limit_reached' (got {detail.get('error')})")
        t(isinstance(detail, dict) and detail.get("limit") == 5,
          f"C.1 — detail.limit == 5 (got {detail.get('limit')})")

    # Delete one daily goal then re-attempt
    deleted_daily_B = daily_ids_B[0]
    dr = delete_goal(user_b["token"], deleted_daily_B)
    t(dr.status_code == 200, f"C — delete a daily goal → 200 (got {dr.status_code})")

    r = requests.put(
        f"{BASE}/goals/{weekly_B_id}",
        json={"unit": "days"},
        headers=hdr(user_b["token"]),
        timeout=30,
    )
    t(r.status_code == 200, f"C.2 — PUT weekly→days after deleting daily → 200 (got {r.status_code})")
    if r.status_code == 200:
        body = r.json()
        t(body.get("unit") == "days", f"C.2 — unit is now 'days' (got {body.get('unit')})")
        t(body.get("last_completed_at") in (None, ""), f"C.2 — last_completed_at is null (got {body.get('last_completed_at')})")

    # ============================================================
    # TEST D — Restart a completed weekly goal
    # ============================================================
    print("\n===== TEST D — Restart completed goal =====")
    user_d = register_user("Restart Tester D")
    print(f"[D] registered uid={user_d['user_id']}")

    r = create_goal(user_d["token"], title="D-Weekly-Restart", focus_area="fitness",
                     target_value=1, unit="weeks", xp_reward=100)
    t(r.status_code == 200, f"D — create weekly goal → 200 (got {r.status_code})")
    goal_D_id = r.json()["id"]
    orig_title = r.json()["title"]
    orig_target = r.json()["target_value"]
    orig_unit = r.json()["unit"]
    orig_xp = r.json()["xp_reward"]
    orig_focus = r.json()["focus_area"]

    # Patch created_at to 10 days ago to bypass first-tick lock
    ten_days_ago = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    db.goals.update_one(
        {"id": goal_D_id, "user_id": user_d["user_id"]},
        {"$set": {"created_at": ten_days_ago}},
    )

    # Capture XP before completion
    prof_pre = get_profile(user_d["token"])
    xp_pre = int(prof_pre.get("total_xp", 0))

    # Tick to completion
    r = progress_goal(user_d["token"], goal_D_id, 1)
    t(r.status_code == 200, f"D — tick to completion → 200 (got {r.status_code} {r.text[:200]})")
    if r.status_code == 200:
        body = r.json()
        t(body.get("completed") is True, f"D — goal.completed=true (got {body.get('completed')})")
        t(body.get("current_value") == 1, f"D — current_value=1 (got {body.get('current_value')})")
        t(body.get("last_completed_at") is not None, "D — last_completed_at set")

    prof_post = get_profile(user_d["token"])
    xp_post = int(prof_post.get("total_xp", 0))
    t(xp_post == xp_pre + 100, f"D — total_xp increased by +100 (pre={xp_pre} post={xp_post})")
    xp_after_completion = xp_post

    # POST /api/goals/{id}/restart
    r = restart_goal(user_d["token"], goal_D_id)
    t(r.status_code == 200, f"D — restart → 200 (got {r.status_code} {r.text[:300]})")
    if r.status_code == 200:
        body = r.json()
        t(body.get("completed") is False, f"D — restarted completed=false (got {body.get('completed')})")
        t(body.get("current_value") == 0, f"D — restarted current_value=0 (got {body.get('current_value')})")
        t(body.get("completed_at") is None, f"D — completed_at=null (got {body.get('completed_at')})")
        t(body.get("last_completed_at") is None, f"D — last_completed_at=null (got {body.get('last_completed_at')})")
        t(body.get("last_ticked_at") is None, f"D — last_ticked_at=null (got {body.get('last_ticked_at')})")
        t(body.get("xp_awarded_on_complete") is None, f"D — xp_awarded_on_complete=null (got {body.get('xp_awarded_on_complete')})")
        # created_at within last 5s
        try:
            ca = datetime.fromisoformat(body.get("created_at").replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            t(abs((now - ca).total_seconds()) < 5, f"D — created_at within last 5s (delta={(now-ca).total_seconds():.2f}s)")
        except Exception as e:
            t(False, f"D — created_at parseable ({e})")
        # restarted_at within last 5s
        try:
            ra = datetime.fromisoformat(body.get("restarted_at").replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            t(abs((now - ra).total_seconds()) < 5, f"D — restarted_at within last 5s (delta={(now-ra).total_seconds():.2f}s)")
        except Exception as e:
            t(False, f"D — restarted_at parseable ({e})")
        # Preserved fields
        t(body.get("title") == orig_title, f"D — title preserved (got {body.get('title')})")
        t(body.get("target_value") == orig_target, f"D — target_value preserved (got {body.get('target_value')})")
        t(body.get("unit") == orig_unit, f"D — unit preserved (got {body.get('unit')})")
        t(body.get("xp_reward") == orig_xp, f"D — xp_reward preserved (got {body.get('xp_reward')})")
        t(body.get("focus_area") == orig_focus, f"D — focus_area preserved (got {body.get('focus_area')})")
        # is_locked=true (new first-tick weekly lock)
        t(body.get("is_locked") is True, f"D — is_locked=true after restart (got {body.get('is_locked')})")

    # XP must be preserved (not revoked)
    prof_after_restart = get_profile(user_d["token"])
    xp_after_restart = int(prof_after_restart.get("total_xp", 0))
    t(xp_after_restart == xp_after_completion,
      f"D — total_xp preserved after restart (post-completion={xp_after_completion}, post-restart={xp_after_restart})")

    # POST progress 1 → 429 cycle_locked
    r = progress_goal(user_d["token"], goal_D_id, 1)
    t(r.status_code == 429, f"D — re-tick after restart → 429 (got {r.status_code} {r.text[:200]})")
    if r.status_code == 429:
        detail = r.json().get("detail", {})
        t(isinstance(detail, dict) and detail.get("error") == "cycle_locked",
          f"D — detail.error == 'cycle_locked' (got {detail.get('error')})")

    # ============================================================
    # TEST E — Restart rejected if not completed
    # ============================================================
    print("\n===== TEST E — Restart non-completed → 400 =====")
    user_e = register_user("Restart Reject E")
    r = create_goal(user_e["token"], title="E-Daily-NotDone", focus_area="mindset",
                     target_value=5, unit="days", xp_reward=20)
    t(r.status_code == 200, f"E — create daily goal → 200 (got {r.status_code})")
    e_gid = r.json()["id"]
    r = restart_goal(user_e["token"], e_gid)
    t(r.status_code == 400, f"E — restart non-completed → 400 (got {r.status_code})")
    if r.status_code == 400:
        detail = r.json().get("detail", {})
        t(isinstance(detail, dict) and detail.get("error") == "goal_not_completed",
          f"E — detail.error == 'goal_not_completed' (got {detail.get('error')})")

    # ============================================================
    # TEST F — Restart enforces caps
    # ============================================================
    print("\n===== TEST F — Restart enforces daily cap =====")
    user_f = register_user("Restart Caps F")
    print(f"[F] uid={user_f['user_id']}")

    daily_ids_F = []
    for i in range(5):
        # target=1 so we can complete instantly
        r = create_goal(user_f["token"], title=f"F-Daily-{i+1}", focus_area="mindset",
                         target_value=1, unit="days", xp_reward=20)
        t(r.status_code == 200, f"F.{i+1} create daily → 200 (got {r.status_code})")
        if r.status_code == 200:
            daily_ids_F.append(r.json()["id"])

    # Complete one (the 1st) — direct DB patch to avoid daily lock issues
    completed_daily_F = daily_ids_F[0]
    db.goals.update_one(
        {"id": completed_daily_F, "user_id": user_f["user_id"]},
        {"$set": {
            "current_value": 1,
            "completed": True,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "last_completed_at": datetime.now(timezone.utc).isoformat(),
            "xp_awarded_on_complete": 20,
        }},
    )
    print(f"  [F] patched daily goal {completed_daily_F} to completed via direct DB")

    # Verify F now has 4 active + 1 completed
    goals = list_goals(user_f["token"])
    active_daily = [g for g in goals if g.get("unit") == "days" and not g.get("completed")]
    completed_daily = [g for g in goals if g.get("unit") == "days" and g.get("completed")]
    t(len(active_daily) == 4, f"F — 4 active daily (got {len(active_daily)})")
    t(len(completed_daily) == 1, f"F — 1 completed daily (got {len(completed_daily)})")

    # Create another daily → succeeds (4 active + 1 completed → 4 active is below cap)
    r = create_goal(user_f["token"], title="F-Daily-NEW6", focus_area="mindset",
                     target_value=1, unit="days", xp_reward=20)
    t(r.status_code == 200, f"F — create 6th daily (5 active now) → 200 (got {r.status_code})")
    if r.status_code == 200:
        daily_ids_F.append(r.json()["id"])

    # Now: 5 active daily + 1 completed daily.
    goals = list_goals(user_f["token"])
    active_daily = [g for g in goals if g.get("unit") == "days" and not g.get("completed")]
    t(len(active_daily) == 5, f"F — exactly 5 active daily before restart (got {len(active_daily)})")

    # Restart the completed daily → 400 daily_goal_limit_reached
    r = restart_goal(user_f["token"], completed_daily_F)
    t(r.status_code == 400, f"F — restart completed daily w/ 5 active → 400 (got {r.status_code})")
    if r.status_code == 400:
        detail = r.json().get("detail", {})
        t(isinstance(detail, dict) and detail.get("error") == "daily_goal_limit_reached",
          f"F — detail.error == 'daily_goal_limit_reached' (got {detail.get('error')})")
        t(isinstance(detail, dict) and detail.get("limit") == 5,
          f"F — detail.limit == 5 (got {detail.get('limit')})")

    # Delete an active daily, re-attempt restart → 200
    to_delete = active_daily[0]["id"] if active_daily else daily_ids_F[1]
    dr = delete_goal(user_f["token"], to_delete)
    t(dr.status_code == 200, f"F — delete an active daily → 200 (got {dr.status_code})")

    r = restart_goal(user_f["token"], completed_daily_F)
    t(r.status_code == 200, f"F — restart after freeing a slot → 200 (got {r.status_code} {r.text[:200]})")
    if r.status_code == 200:
        body = r.json()
        t(body.get("completed") is False, f"F — restarted daily completed=false")
        t(body.get("current_value") == 0, f"F — restarted daily current_value=0")

    # ============================================================
    # TEST G — Admin bypasses ALL caps
    # ============================================================
    print("\n===== TEST G — Admin bypass =====")
    admin_goal_ids = []
    for i in range(10):
        r = create_goal(admin["token"], title=f"AdminCapTest-{i+1}-{secrets.token_hex(3)}",
                         focus_area="mindset", target_value=10, unit="days", xp_reward=20)
        t(r.status_code == 200, f"G.{i+1} admin daily goal → 200 (got {r.status_code})")
        if r.status_code == 200:
            admin_goal_ids.append(r.json()["id"])

    # Cleanup admin test goals
    print(f"  [G] cleaning up {len(admin_goal_ids)} admin goals...")
    for gid in admin_goal_ids:
        try:
            delete_goal(admin["token"], gid)
        except Exception:
            pass

    # Cleanup other test users
    print("\n[cleanup] deleting test user goals from db...")
    for u in (user_a, user_b, user_d, user_e, user_f):
        try:
            db.goals.delete_many({"user_id": u["user_id"]})
        except Exception:
            pass

    print("\n" + "=" * 60)
    print(f"FINAL: {PASS} PASS / {FAIL} FAIL")
    if FAIL:
        print("\nFailed assertions:")
        for d in FAILED_DESC:
            print(f"  - {d}")
    print("=" * 60)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
