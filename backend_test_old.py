"""Backend tests for: 'ALL XP earnings now reflected on Progress charts'

Verifies the new `_log_xp_to_charts` helper writes synthetic task_log rows
for every non-task XP-grant path, and that /stats/weekly + /stats/monthly +
/stats/by-area reflect the earned XP. Gifted XP must remain segregated
(only on the gold stacked bar via /gifts collection — NOT counted twice
through task_logs).

Run:  python /app/backend_test.py
"""
import json
import os
import sys
import time
import uuid
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

# --- env --------------------------------------------------------------
ENV_PATH = Path("/app/frontend/.env")
BASE_URL: str | None = None
for line in ENV_PATH.read_text().splitlines():
    if line.startswith("EXPO_PUBLIC_BACKEND_URL"):
        BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
        break
if not BASE_URL:
    print("ERROR: EXPO_PUBLIC_BACKEND_URL missing"); sys.exit(1)
API = f"{BASE_URL}/api"
print(f"Using API: {API}")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"


# --- mongo helper for test setup that needs DB seeding ---------------
def _get_db():
    """Return a sync pymongo db handle for setup work."""
    from pymongo import MongoClient
    mongo_url = None
    db_name = None
    for line in Path("/app/backend/.env").read_text().splitlines():
        if line.startswith("MONGO_URL"):
            mongo_url = line.split("=", 1)[1].strip().strip('"')
        elif line.startswith("DB_NAME"):
            db_name = line.split("=", 1)[1].strip().strip('"')
    return MongoClient(mongo_url)[db_name or "test_database"]


# --- counters ---------------------------------------------------------
TOTAL = 0
PASSED = 0
FAILS: list[str] = []


def CHECK(name: str, cond: bool, *, info: Any = ""):
    global TOTAL, PASSED
    TOTAL += 1
    if cond:
        PASSED += 1
        print(f"  ✅ {name}")
    else:
        FAILS.append(f"{name} | info={info}")
        print(f"  ❌ {name}  | info={info}")


# --- helpers ----------------------------------------------------------
def post(path: str, *, token: str | None = None, json_body=None, headers: dict | None = None, expect: int | None = None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    if headers:
        h.update(headers)
    r = requests.post(f"{API}{path}", json=json_body or {}, headers=h, timeout=30)
    if expect is not None and r.status_code != expect:
        print(f"   ! POST {path} expected {expect} got {r.status_code}: {r.text[:300]}")
    return r


def get(path: str, *, token: str | None = None, headers: dict | None = None, params: dict | None = None, expect: int | None = None):
    h = {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    if headers:
        h.update(headers)
    r = requests.get(f"{API}{path}", headers=h, params=params, timeout=30)
    if expect is not None and r.status_code != expect:
        print(f"   ! GET {path} expected {expect} got {r.status_code}: {r.text[:300]}")
    return r


def patch(path: str, *, token: str | None = None, json_body=None, expect: int | None = None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    r = requests.patch(f"{API}{path}", json=json_body or {}, headers=h, timeout=30)
    if expect is not None and r.status_code != expect:
        print(f"   ! PATCH {path} expected {expect} got {r.status_code}: {r.text[:300]}")
    return r


def register_user(prefix: str = "xpchart") -> tuple[str, str, dict]:
    suffix = uuid.uuid4().hex[:10]
    email = f"{prefix}.{suffix}@gmail.com"
    pwd = "TestPassXP-9981!"
    payload = {"full_name": f"{prefix.capitalize()} User", "email": email, "password": pwd}
    r = post("/auth/register", json_body=payload, expect=200)
    body = r.json()
    user_id = body["user"].get("id") or body["user"].get("user_id")
    token = body["token"]
    print(f"  ▶ Registered {email} → user_id={user_id}")
    return token, user_id, body["user"]


def today_str() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def admin_login() -> str:
    r = post("/auth/login", json_body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, expect=200)
    return r.json()["token"]


def get_today_xp_from_weekly(token: str) -> tuple[int, int]:
    r = get("/stats/weekly", token=token, expect=200)
    days = r.json()["days"]
    last = days[-1]
    return int(last.get("xp", 0)), int(last.get("gifted_xp", 0))


def get_task_logs(user_id: str, with_source: str | None = None) -> list[dict]:
    """Direct DB read of task_logs for assertion of `_source` rows."""
    db = _get_db()
    q: dict = {"user_id": user_id, "date": today_str()}
    if with_source is not None:
        q["_source"] = with_source
    return list(db.task_logs.find(q, {"_id": 0}))


# ---------- TEST SCENARIOS ------------------------------------------

def s1_goal_completion():
    """(1) Goal completion → /stats/weekly today's xp >= xp_reward; _source='goal_complete'."""
    print("\n─── SCENARIO 1: Goal completion ───")
    token, uid, _ = register_user("g1")
    xp0, _ = get_today_xp_from_weekly(token)
    CHECK("S1.0 fresh user today XP=0", xp0 == 0, info=xp0)

    # NOTE: spec says target_value=1 xp_reward=100. For non-admin user
    # with default unit='days' (cap 30) the request is clamped to 30. We
    # still verify the chart logging works for whatever was awarded.
    r = post(
        "/goals", token=token,
        json_body={
            "title": "Be more social",
            "description": "Try social pillar",
            "focus_area": "social",
            "target_value": 1,
            "unit": "days",
            "xp_reward": 100,  # will be capped by backend
        },
        expect=200,
    )
    goal = r.json()
    awarded_xp_expected = int(goal["xp_reward"])  # actual capped value
    CHECK("S1.1 goal created", goal["id"] and goal["focus_area"] == "social", info=goal.get("xp_reward"))
    CHECK("S1.2 xp_reward >0 (capped)", awarded_xp_expected > 0, info=awarded_xp_expected)

    # Use the proper progress endpoint (PATCH /goals/{id} doesn't trigger XP)
    r = post(
        f"/goals/{goal['id']}/progress",
        token=token,
        json_body={"current_value": 1},
        expect=200,
    )
    body = r.json()
    CHECK("S1.3 goal completed=true", body.get("completed") is True, info=body.get("completed"))
    CHECK("S1.4 awarded_xp matches xp_reward", int(body.get("awarded_xp") or 0) == awarded_xp_expected, info=body.get("awarded_xp"))

    # Verify profile XP
    prof = get("/profile", token=token, expect=200).json()
    CHECK("S1.5 profile total_xp == awarded_xp", int(prof["total_xp"]) == awarded_xp_expected, info=prof["total_xp"])

    # Chart updated
    xp_today, gifted = get_today_xp_from_weekly(token)
    CHECK("S1.6 /stats/weekly last-day xp >= awarded", xp_today >= awarded_xp_expected, info=(xp_today, awarded_xp_expected))
    CHECK("S1.7 /stats/weekly gifted_xp == 0", gifted == 0, info=gifted)

    # by-area social bumped
    r = get("/stats/by-area", token=token, expect=200)
    by = r.json()["by_area"]
    CHECK("S1.8 /stats/by-area.social == awarded_xp", int(by.get("social", 0)) == awarded_xp_expected, info=by)

    # Underlying task_log row tagged
    rows = get_task_logs(uid, with_source="goal_complete")
    CHECK("S1.9 task_log _source='goal_complete' exists", len(rows) >= 1, info=len(rows))
    if rows:
        CHECK("S1.10 row.focus_area == social", rows[0].get("focus_area") == "social", info=rows[0])
        CHECK("S1.11 row.xp_awarded == awarded_xp", int(rows[0].get("xp_awarded", 0)) == awarded_xp_expected, info=rows[0])

    return uid, token


def s2_goal_daily_step():
    """(2) Goal daily-step (3 steps × 30 XP + completion bonus) → 3 _source='goal_step' rows."""
    print("\n─── SCENARIO 2: Goal daily-step (unit=days, target=3) ───")
    token, uid, _ = register_user("g2")

    r = post(
        "/goals", token=token,
        json_body={
            "title": "Run 3 days in a row",
            "focus_area": "fitness",
            "target_value": 3,
            "unit": "days",
            "xp_reward": 30,
        },
        expect=200,
    )
    goal = r.json()
    completion_bonus = int(goal["xp_reward"])
    DAILY_STEP_XP = 30
    expected_steps_xp = 3 * DAILY_STEP_XP

    # Tick 3 times
    for v in (1, 2, 3):
        r = post(
            f"/goals/{goal['id']}/progress",
            token=token,
            json_body={"current_value": v},
            expect=200,
        )

    # Profile
    prof = get("/profile", token=token, expect=200).json()
    expected_total = expected_steps_xp + completion_bonus
    CHECK("S2.1 profile.total_xp == 3×30 + completion bonus", int(prof["total_xp"]) == expected_total, info=(prof["total_xp"], expected_total))

    # Chart
    xp_today, _ = get_today_xp_from_weekly(token)
    CHECK("S2.2 /stats/weekly today xp >= 90+bonus", xp_today >= expected_total, info=(xp_today, expected_total))

    # by-area fitness bumped
    by = get("/stats/by-area", token=token, expect=200).json()["by_area"]
    CHECK("S2.3 /stats/by-area.fitness includes step+bonus", int(by.get("fitness", 0)) >= expected_total, info=by)

    # Exactly 3 _source='goal_step' rows
    step_rows = get_task_logs(uid, with_source="goal_step")
    CHECK("S2.4 3 task_log rows with _source='goal_step'", len(step_rows) == 3, info=len(step_rows))
    if step_rows:
        CHECK("S2.5 step rows focus_area==fitness", all(r.get("focus_area") == "fitness" for r in step_rows), info=[r.get("focus_area") for r in step_rows])
        CHECK("S2.6 step rows xp_awarded==30 each", all(int(r.get("xp_awarded", 0)) == 30 for r in step_rows), info=[r.get("xp_awarded") for r in step_rows])

    # And one _source='goal_complete'
    comp_rows = get_task_logs(uid, with_source="goal_complete")
    CHECK("S2.7 1 task_log row with _source='goal_complete'", len(comp_rows) == 1, info=len(comp_rows))

    return uid, token


def s3_focus_session():
    print("\n─── SCENARIO 3: Focus session bonus (+5 XP) ───")
    token, uid, _ = register_user("f3")
    body = {
        "planned_minutes": 25,
        "actual_seconds": 1500,
        "backgrounded_seconds": 0,
        "locked_app_seconds": 0,
        "completed": True,
        "committed_app_count": 3,
    }
    r = post("/focus/session", token=token, json_body=body, expect=200)
    j = r.json()
    CHECK("S3.1 xp_delta=+5", int(j.get("xp_delta", 0)) == 5, info=j.get("xp_delta"))

    xp_today, _ = get_today_xp_from_weekly(token)
    CHECK("S3.2 /stats/weekly today xp += 5", xp_today == 5, info=xp_today)

    by = get("/stats/by-area", token=token, expect=200).json()["by_area"]
    CHECK("S3.3 /stats/by-area.mindset == 5", int(by.get("mindset", 0)) == 5, info=by)

    rows = get_task_logs(uid, with_source="focus_session")
    CHECK("S3.4 task_log row _source='focus_session' exists", len(rows) == 1, info=len(rows))
    if rows:
        CHECK("S3.5 row.focus_area=='mindset'", rows[0].get("focus_area") == "mindset", info=rows[0])
        CHECK("S3.6 row.xp_awarded==5", int(rows[0].get("xp_awarded", 0)) == 5, info=rows[0])
    return uid, token


def s4_challenge_complete():
    print("\n─── SCENARIO 4: Mini-app challenge complete ───")
    token, uid, _ = register_user("c4")
    r = post("/challenge/accept", token=token, expect=200)
    CHECK("S4.1 /challenge/accept 200", r.status_code == 200)

    body = {
        "completed": True,
        "difficulty": "easy",
        "rating": 5,
        "how_text": "Said hi to a stranger.",
        "experience_text": "Felt good.",
    }
    r = post("/challenge/complete", token=token, json_body=body, expect=200)
    j = r.json()
    awarded = int(j.get("awarded_xp", 0))
    CHECK("S4.2 awarded_xp == 30 (easy)", awarded == 30, info=awarded)

    xp_today, _ = get_today_xp_from_weekly(token)
    CHECK("S4.3 /stats/weekly today xp >= 30 (after challenge)", xp_today >= 30, info=xp_today)

    rows = get_task_logs(uid, with_source="challenge_complete")
    CHECK("S4.4 task_log row _source='challenge_complete' exists", len(rows) == 1, info=len(rows))
    return uid, token


def s5_challenge_late():
    print("\n─── SCENARIO 5: Late challenge (auto-uncompleted → late-answer) ───")
    token, uid, _ = register_user("c5")
    # Need to seed an auto_uncompleted challenge_completion for this user
    # so /challenge/past/{id}/answer is allowed.
    db = _get_db()
    fake_id = str(uuid.uuid4())
    today = today_str()
    db.challenge_completions.insert_one({
        "id": fake_id,
        "user_id": uid,
        "date": today,
        "challenge_id": "test-challenge-id",
        "challenge_title": "Test late challenge",
        "challenge_tagline": "test",
        "challenge_description": "Test description",
        "challenge_icon": "flash",
        "completed": False,
        "auto_uncompleted": True,
        "how_text": "",
        "difficulty": "easy",
        "experience_text": "",
        "rating": 0,
        "xp_awarded": 0,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    })

    r = post(
        f"/challenge/past/{fake_id}/answer",
        token=token,
        json_body={
            "completed": True,
            "difficulty": "easy",
            "rating": 5,
            "how_text": "Did it",
            "experience_text": "Late but did it",
        },
        expect=200,
    )
    j = r.json()
    awarded = int(j.get("awarded_xp", 0))
    CHECK("S5.1 late-answer awarded_xp==30", awarded == 30, info=awarded)

    xp_today, _ = get_today_xp_from_weekly(token)
    CHECK("S5.2 /stats/weekly today xp >= 30", xp_today >= 30, info=xp_today)

    rows = get_task_logs(uid, with_source="challenge_late")
    CHECK("S5.3 task_log row _source='challenge_late' exists", len(rows) == 1, info=len(rows))
    return uid, token


def s6_confidence_track():
    print("\n─── SCENARIO 6: Confidence track (+15 XP) ───")
    token, uid, _ = register_user("co6")
    r = post("/confidence/complete", token=token, json_body={"track": "social"}, expect=200)
    j = r.json()
    CHECK("S6.1 ok=True xp_awarded=15", j.get("ok") is True and int(j.get("xp_awarded", 0)) == 15, info=j)

    xp_today, _ = get_today_xp_from_weekly(token)
    CHECK("S6.2 /stats/weekly today xp == 15", xp_today == 15, info=xp_today)

    rows = get_task_logs(uid, with_source="confidence_track")
    CHECK("S6.3 task_log row _source='confidence_track' exists", len(rows) == 1, info=len(rows))
    if rows:
        CHECK("S6.4 row.xp_awarded==15", int(rows[0].get("xp_awarded", 0)) == 15, info=rows[0])
    return uid, token


def s7_gift_xp_not_in_task_logs(admin_token: str):
    print("\n─── SCENARIO 7: Gift XP NOT logged into task_logs ───")
    token, uid, _ = register_user("g7")
    xp0, gift0 = get_today_xp_from_weekly(token)

    r = post(
        "/admin/gift/xp",
        token=admin_token,
        json_body={"user_id": uid, "amount": 50, "message": "test"},
        expect=200,
    )
    CHECK("S7.1 /admin/gift/xp 200", r.status_code == 200)

    xp1, gift1 = get_today_xp_from_weekly(token)
    CHECK("S7.2 today.xp UNCHANGED after gift", xp1 == xp0, info=(xp0, xp1))
    CHECK("S7.3 today.gifted_xp += 50", gift1 - gift0 == 50, info=(gift0, gift1))

    # Profile total_xp moved by 50 (gift counts toward total but not chart-xp)
    prof = get("/profile", token=token, expect=200).json()
    CHECK("S7.4 profile.total_xp == 50 (only gift)", int(prof["total_xp"]) == 50, info=prof["total_xp"])

    # NO row tagged with any _source by gift path
    db = _get_db()
    bad = list(db.task_logs.find({"user_id": uid, "_source": {"$exists": True}}))
    CHECK("S7.5 NO _source rows in task_logs from gift", len(bad) == 0, info=len(bad))
    return uid, token


def s8_aggregation_correctness():
    print("\n─── SCENARIO 8: Aggregation correctness (focus + challenge + step) ───")
    token, uid, _ = register_user("agg8")

    # 1) focus session
    post("/focus/session", token=token, json_body={
        "planned_minutes": 25,
        "actual_seconds": 1500,
        "backgrounded_seconds": 0,
        "locked_app_seconds": 0,
        "completed": True,
        "committed_app_count": 3,
    }, expect=200)

    # 2) challenge complete
    post("/challenge/accept", token=token, expect=200)
    post("/challenge/complete", token=token, json_body={
        "completed": True, "difficulty": "easy", "rating": 5,
        "how_text": "x", "experience_text": "y",
    }, expect=200)

    # 3) goal +1 step (unit=days)
    g = post("/goals", token=token, json_body={
        "title": "Walk every day", "focus_area": "fitness",
        "target_value": 7, "unit": "days", "xp_reward": 30,
    }, expect=200).json()
    post(f"/goals/{g['id']}/progress", token=token, json_body={"current_value": 1}, expect=200)

    # Expected positive XP earned today: 5 (focus) + 30 (challenge) + 30 (step) = 65
    expected_total = 5 + 30 + 30

    xp_today, gift_today = get_today_xp_from_weekly(token)
    CHECK("S8.1 today xp == 65 (focus+challenge+step)", xp_today == expected_total, info=(xp_today, expected_total))
    CHECK("S8.2 today gifted_xp == 0", gift_today == 0, info=gift_today)

    by = get("/stats/by-area", token=token, expect=200).json()["by_area"]
    by_total = sum(int(by.get(a, 0)) for a in ("social", "fitness", "appearance", "mindset"))
    CHECK("S8.3 /stats/by-area sum == today xp", by_total == expected_total, info=(by_total, expected_total))


def s9_no_regression_task_complete():
    print("\n─── SCENARIO 9: regular task complete — no _source row, chart bumps ───")
    token, uid, _ = register_user("rt9")
    tasks = get("/tasks", token=token, expect=200).json()
    # default tasks seeded — pick first 'Morning reflection' or similar
    if isinstance(tasks, dict):
        task_list = tasks.get("tasks", [])
    else:
        task_list = tasks
    default_task = next((t for t in task_list if t.get("is_default")), task_list[0] if task_list else None)
    CHECK("S9.0 default task seeded", default_task is not None, info=len(task_list))

    if default_task:
        xp_val = int(default_task["xp_value"])
        r = post(f"/tasks/{default_task['id']}/complete", token=token, json_body={"date": today_str()}, expect=200)
        j = r.json()
        awarded = int(j.get("xp_awarded", 0))
        CHECK("S9.1 task awarded_xp matches", awarded == xp_val, info=(awarded, xp_val))

        xp_today, _ = get_today_xp_from_weekly(token)
        CHECK("S9.2 today xp >= xp_val", xp_today >= xp_val, info=xp_today)

        # No _source row should be created by regular task complete
        db = _get_db()
        bad_rows = list(db.task_logs.find({"user_id": uid, "_source": {"$exists": True}}))
        CHECK("S9.3 NO _source rows created by regular task complete", len(bad_rows) == 0, info=[r.get("_source") for r in bad_rows])

        # But a regular task_log row IS created (without _source)
        regular_rows = list(db.task_logs.find({"user_id": uid, "_source": {"$exists": False}}))
        CHECK("S9.4 1 regular task_log row created", len(regular_rows) >= 1, info=len(regular_rows))


def s10_cleanup_endpoints(token: str):
    print("\n─── SCENARIO 10: Cleanup — all endpoints 200 ───")
    for path in ("/profile", "/stats/daily", "/stats/weekly", "/stats/monthly", "/stats/by-area"):
        r = get(path, token=token, expect=200)
        CHECK(f"S10 {path} → 200", r.status_code == 200, info=r.status_code)


# ----------------- main -----------------
def main():
    print("\n" + "=" * 70)
    print("ALL XP earnings reflect on Progress charts — backend test")
    print("=" * 70)
    admin_tok = admin_login()
    print(f"Admin login OK")

    s1_goal_completion()
    s2_goal_daily_step()
    s3_focus_session()
    s4_challenge_complete()
    s5_challenge_late()
    s6_confidence_track()
    s7_gift_xp_not_in_task_logs(admin_tok)
    s8_aggregation_correctness()
    s9_no_regression_task_complete()
    # cleanup uses any fresh token
    fresh_tok, _, _ = register_user("clean10")
    s10_cleanup_endpoints(fresh_tok)

    print("\n" + "=" * 70)
    print(f"RESULTS: {PASSED}/{TOTAL} passed")
    if FAILS:
        print("FAILURES:")
        for f in FAILS:
            print(f"  - {f}")
    print("=" * 70)
    sys.exit(0 if not FAILS else 1)


if __name__ == "__main__":
    main()
