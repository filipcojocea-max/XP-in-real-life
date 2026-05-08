"""Re-test ONLY S4 (challenge_complete chart logging) + S8 (aggregation)
from the prior failing run.

Run: python /app/retest_s4_s8.py
"""
import json
import sys
import uuid
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
    print("ERROR: EXPO_PUBLIC_BACKEND_URL missing")
    sys.exit(1)
API = f"{BASE_URL}/api"
print(f"Using API: {API}")


# --- counters ---------------------------------------------------------
TOTAL = 0
PASSED = 0
FAILS: list[str] = []


def CHECK(name: str, cond: bool, *, info: Any = ""):
    global TOTAL, PASSED
    TOTAL += 1
    if cond:
        PASSED += 1
        print(f"  [PASS] {name}")
    else:
        FAILS.append(f"{name} :: {info}")
        print(f"  [FAIL] {name} :: {info}")


# --- mongo helper -----------------------------------------------------
def _get_db():
    from pymongo import MongoClient
    mongo_url = None
    db_name = None
    for line in Path("/app/backend/.env").read_text().splitlines():
        if line.startswith("MONGO_URL"):
            mongo_url = line.split("=", 1)[1].strip().strip('"')
        elif line.startswith("DB_NAME"):
            db_name = line.split("=", 1)[1].strip().strip('"')
    return MongoClient(mongo_url)[db_name or "test_database"]


# --- helpers ----------------------------------------------------------
def register_user(prefix: str = "retests4") -> tuple[str, dict]:
    """Register a fresh gmail.com user, return (token, user)."""
    suffix = uuid.uuid4().hex[:8]
    email = f"{prefix}_{suffix}@gmail.com"
    body = {
        "full_name": f"Maya Patel {suffix}",
        "email": email,
        "password": "Sky-Walker-99!",
    }
    r = requests.post(f"{API}/auth/register", json=body, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"register failed: {r.status_code} {r.text[:200]}")
    j = r.json()
    return j["token"], j["user"]


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --- S4: challenge_complete chart logging ----------------------------
def scenario_s4():
    print("\n=== S4: challenge_complete logs to chart ===")
    token, user = register_user("s4u")
    user_id = user["id"]
    print(f"  fresh user_id={user_id} email={user['email']}")
    H = auth_headers(token)

    # baseline profile
    p0 = requests.get(f"{API}/profile", headers=H, timeout=20).json()
    base_xp = int(p0.get("total_xp", 0) or 0)
    CHECK("S4 baseline profile fetched", isinstance(base_xp, int), info=f"base_xp={base_xp}")

    # accept challenge
    r = requests.post(f"{API}/challenge/accept", headers=H, json={}, timeout=20)
    CHECK("S4 challenge/accept 200", r.status_code == 200, info=f"{r.status_code} {r.text[:200]}")

    # complete
    body = {"completed": True, "difficulty": "easy", "rating": 5}
    r = requests.post(f"{API}/challenge/complete", headers=H, json=body, timeout=20)
    CHECK("S4 challenge/complete 200", r.status_code == 200, info=f"{r.status_code} {r.text[:200]}")
    j = r.json()
    awarded = int(j.get("awarded_xp", 0) or 0)
    CHECK("S4 awarded_xp >= 30", awarded >= 30, info=f"awarded_xp={awarded}")

    # profile delta
    p1 = requests.get(f"{API}/profile", headers=H, timeout=20).json()
    new_xp = int(p1.get("total_xp", 0) or 0)
    delta = new_xp - base_xp
    CHECK(
        "S4 profile.total_xp went up by awarded_xp",
        delta == awarded,
        info=f"base={base_xp} new={new_xp} delta={delta} awarded={awarded}",
    )

    # /stats/weekly today (last in array)
    r = requests.get(f"{API}/stats/weekly", headers=H, timeout=20)
    CHECK("S4 stats/weekly 200", r.status_code == 200, info=r.text[:200])
    weekly = r.json()
    days = weekly.get("days") or []
    CHECK("S4 stats/weekly days length=7", len(days) == 7, info=f"len={len(days)}")
    today = days[-1] if days else {}
    today_xp = int(today.get("xp", 0) or 0)
    CHECK(
        "S4 stats/weekly today xp >= awarded_xp",
        today_xp >= awarded,
        info=f"today={today} awarded={awarded}",
    )

    # /stats/by-area mindset includes awarded XP
    r = requests.get(f"{API}/stats/by-area", headers=H, timeout=20)
    CHECK("S4 stats/by-area 200", r.status_code == 200, info=r.text[:200])
    by_area = (r.json() or {}).get("by_area", {})
    mindset = int(by_area.get("mindset", 0) or 0)
    CHECK(
        "S4 stats/by-area.mindset >= awarded_xp",
        mindset >= awarded,
        info=f"by_area={by_area} awarded={awarded}",
    )

    # task_logs row with _source=challenge_complete and xp_awarded == awarded
    db = _get_db()
    rows = list(
        db.task_logs.find({"user_id": user_id, "_source": "challenge_complete"})
    )
    CHECK(
        "S4 task_logs row with _source=challenge_complete present",
        len(rows) >= 1,
        info=f"row_count={len(rows)}",
    )
    if rows:
        xp_in_row = int(rows[0].get("xp_awarded", 0) or 0)
        CHECK(
            "S4 task_log row xp_awarded == awarded_xp",
            xp_in_row == awarded,
            info=f"row.xp_awarded={xp_in_row} awarded={awarded}",
        )
        focus_ok = rows[0].get("focus_area") == "mindset"
        CHECK(
            "S4 task_log row focus_area == mindset",
            focus_ok,
            info=f"focus_area={rows[0].get('focus_area')}",
        )


# --- S8: aggregation correctness -------------------------------------
def scenario_s8():
    print("\n=== S8: same-day aggregation correctness (5+30+15=50) ===")
    token, user = register_user("s8u")
    user_id = user["id"]
    print(f"  fresh user_id={user_id} email={user['email']}")
    H = auth_headers(token)

    # 1) focus session -> +5 XP
    body = {
        "planned_minutes": 25,
        "actual_seconds": 1500,
        "backgrounded_seconds": 0,
        "locked_app_seconds": 0,
        "completed": True,
        "committed_app_count": 3,
    }
    r = requests.post(f"{API}/focus/session", headers=H, json=body, timeout=20)
    CHECK("S8 focus/session 200", r.status_code == 200, info=f"{r.status_code} {r.text[:200]}")
    j = r.json()
    focus_delta = int(j.get("xp_delta", 0) or 0)
    CHECK("S8 focus_session xp_delta == +5", focus_delta == 5, info=f"xp_delta={focus_delta} body={j}")

    # 2) challenge accept + complete -> +30 XP (easy)
    r = requests.post(f"{API}/challenge/accept", headers=H, json={}, timeout=20)
    CHECK("S8 challenge/accept 200", r.status_code == 200, info=f"{r.status_code} {r.text[:200]}")

    r = requests.post(
        f"{API}/challenge/complete",
        headers=H,
        json={"completed": True, "difficulty": "easy", "rating": 5},
        timeout=20,
    )
    CHECK("S8 challenge/complete 200", r.status_code == 200, info=f"{r.status_code} {r.text[:200]}")
    chal_xp = int(r.json().get("awarded_xp", 0) or 0)
    CHECK("S8 challenge awarded_xp == 30", chal_xp == 30, info=f"awarded_xp={chal_xp}")

    # 3) confidence complete -> +15 XP (track 1: social)
    # The endpoint accepts a track from {social,physical,gratitude,dress}; per
    # the spec "track 1" = social (ordered listing).
    r = requests.post(
        f"{API}/confidence/complete",
        headers=H,
        json={"track": "social"},
        timeout=20,
    )
    CHECK("S8 confidence/complete 200", r.status_code == 200, info=f"{r.status_code} {r.text[:200]}")
    j = r.json()
    conf_xp = int(j.get("xp_awarded", 0) or 0)
    CHECK("S8 confidence xp_awarded == 15", conf_xp == 15, info=f"xp_awarded={conf_xp} body={j}")

    # 4) /stats/weekly today.xp == 50
    r = requests.get(f"{API}/stats/weekly", headers=H, timeout=20)
    CHECK("S8 stats/weekly 200", r.status_code == 200, info=r.text[:200])
    days = (r.json() or {}).get("days") or []
    today_xp = int((days[-1] or {}).get("xp", 0) or 0) if days else -1
    CHECK(
        "S8 stats/weekly today.xp == 50",
        today_xp == 50,
        info=f"today_xp={today_xp} today={days[-1] if days else None}",
    )

    # 5) /stats/by-area mindset == 50 (focus_session + challenge_complete + confidence_track all map to mindset)
    r = requests.get(f"{API}/stats/by-area", headers=H, timeout=20)
    CHECK("S8 stats/by-area 200", r.status_code == 200, info=r.text[:200])
    by_area = (r.json() or {}).get("by_area", {})
    mindset = int(by_area.get("mindset", 0) or 0)
    CHECK(
        "S8 stats/by-area.mindset == 50",
        mindset == 50,
        info=f"by_area={by_area}",
    )


def main():
    try:
        scenario_s4()
    except Exception as e:
        FAILS.append(f"S4 raised: {e!r}")
        print(f"  [ERROR] S4 raised: {e!r}")
    try:
        scenario_s8()
    except Exception as e:
        FAILS.append(f"S8 raised: {e!r}")
        print(f"  [ERROR] S8 raised: {e!r}")

    print(f"\n========== {PASSED}/{TOTAL} assertions passed ==========")
    if FAILS:
        print("FAILURES:")
        for f in FAILS:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
