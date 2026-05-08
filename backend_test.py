"""Backend tests for streak-cap (5,000) and streak-bump on gift / focus / challenge XP.

Reviewed behaviours (server.py):
  1. update_streak() hard-caps current_streak/longest_streak at 5000.
  2. _bump_streak_for_xp() is invoked on every positive-XP code-path:
       - admin_gift_xp (POST /admin/gift/xp)
       - focus_session_complete (POST /focus/session) when delta>0
       - challenge_complete (POST /challenge/complete) when xp awarded
  3. Same-day idempotency: a 2nd grant on the same UTC day does NOT re-bump.
  4. /stats/weekly + /stats/monthly emit gifted_xp on today's last-day entry.
  5. Regression: /profile, /stats/{daily,weekly,monthly,by-area},
     /library/{ratings,catalog} continue to return 200.

Run from /app:    python backend_test.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

BASE = os.environ.get(
    "BACKEND_URL",
    "https://xp-confidence.preview.emergentagent.com",
).rstrip("/")
API = f"{BASE}/api"

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASSED = 0
FAILED: list[str] = []


def expect(cond: bool, label: str) -> bool:
    global PASSED
    if cond:
        PASSED += 1
        print(f"  PASS  {label}")
        return True
    FAILED.append(label)
    print(f"  FAIL  {label}")
    return False


def hdr(token: Optional[str] = None) -> dict:
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def jpost(path: str, body: dict, token: Optional[str] = None, timeout: int = 30):
    return requests.post(f"{API}{path}", json=body, headers=hdr(token), timeout=timeout)


def jget(path: str, token: Optional[str] = None, timeout: int = 30):
    return requests.get(f"{API}{path}", headers=hdr(token), timeout=timeout)


def fresh_email(prefix: str = "streak") -> str:
    return f"{prefix}{uuid.uuid4().hex[:10]}@gmail.com"


def register(prefix: str) -> tuple[str, str, str]:
    """Returns (token, user_id, full_name)."""
    full_name = f"Test {prefix.title()} {uuid.uuid4().hex[:4]}"
    email = fresh_email(prefix)
    password = "TestPass!" + uuid.uuid4().hex[:8]
    r = jpost("/auth/register", {
        "full_name": full_name,
        "email": email,
        "password": password,
    })
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text[:200]}"
    j = r.json()
    return j["token"], j["user"]["id"], full_name


def admin_login() -> str:
    r = jpost("/auth/login", {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text[:200]}"
    return r.json()["token"]


def utc_today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# ---------------------------------------------------------------------- TESTS


def test_2_gift_bumps_streak(admin_token: str):
    """(2) Streak preservation on Creator XP gifts. Returns (token,uid)."""
    print("\n[Test 2] Gift XP bumps streak from 0 to 1")
    token, uid, name = register("gift")
    r = jget("/profile", token=token)
    expect(r.status_code == 200, "fresh /profile 200")
    prof0 = r.json()
    expect(prof0.get("current_streak") == 0, "fresh current_streak == 0")
    expect(prof0.get("last_active_date") in (None, ""), "fresh last_active_date is null")
    base_xp = int(prof0.get("total_xp", 0) or 0)

    r = jpost("/admin/gift/xp",
              {"user_id": uid, "amount": 25, "message": "test"},
              token=admin_token)
    expect(r.status_code == 200, f"/admin/gift/xp 200 (got {r.status_code} body={r.text[:120]})")
    if r.status_code == 200:
        gj = r.json()
        expect(gj.get("ok") is True, "gift response ok=true")

    r = jget("/profile", token=token)
    prof1 = r.json()
    expect(prof1.get("current_streak") == 1,
           f"current_streak == 1 (got {prof1.get('current_streak')})")
    expect(prof1.get("last_active_date") == utc_today(),
           f"last_active_date == today UTC {utc_today()} (got {prof1.get('last_active_date')})")
    expect(int(prof1.get("total_xp", 0)) == base_xp + 25,
           f"total_xp += 25 (was {base_xp}, now {prof1.get('total_xp')})")
    return token, uid


def test_5_stats_show_gifted_xp(token: str):
    """(5) /stats/weekly + /stats/monthly today entry has gifted_xp=25, xp=0."""
    print("\n[Test 5] /stats/weekly + /stats/monthly include gifted_xp on today")
    today = utc_today()
    r = jget("/stats/weekly", token=token)
    expect(r.status_code == 200, "/stats/weekly 200")
    if r.status_code == 200:
        days = r.json().get("days", [])
        expect(len(days) == 7, f"weekly days length=7 (got {len(days)})")
        last = days[-1] if days else {}
        expect(last.get("date") == today, f"weekly last day date == today {today}")
        expect(int(last.get("xp", 0) or 0) == 0,
               f"weekly today xp == 0 (got {last.get('xp')})")
        expect(int(last.get("gifted_xp", 0) or 0) == 25,
               f"weekly today gifted_xp == 25 (got {last.get('gifted_xp')})")

    r = jget("/stats/monthly", token=token)
    expect(r.status_code == 200, "/stats/monthly 200")
    if r.status_code == 200:
        days = r.json().get("days", [])
        expect(len(days) == 30, f"monthly days length=30 (got {len(days)})")
        last = days[-1] if days else {}
        expect(last.get("date") == today, "monthly last day date == today")
        expect(int(last.get("gifted_xp", 0) or 0) == 25,
               f"monthly today gifted_xp == 25 (got {last.get('gifted_xp')})")


def test_7_idempotent_same_day(admin_token: str, token: str, uid: str):
    """(7) Second same-day gift does NOT re-bump streak."""
    print("\n[Test 7] Same-day idempotency — 2nd gift keeps streak at 1")
    r = jpost("/admin/gift/xp",
              {"user_id": uid, "amount": 10, "message": "second"},
              token=admin_token)
    expect(r.status_code == 200, "2nd gift 200")
    r = jget("/profile", token=token)
    prof = r.json()
    expect(prof.get("current_streak") == 1,
           f"streak STILL 1 after 2nd same-day gift (got {prof.get('current_streak')})")
    expect(prof.get("last_active_date") == utc_today(), "last_active_date still today")


def test_3_focus_bumps_streak():
    """(3) Focus session completion with positive XP bumps streak from 0 to 1."""
    print("\n[Test 3] Focus session completion bumps streak")
    token, uid, _ = register("focus")
    r = jget("/profile", token=token)
    expect(r.status_code == 200 and r.json().get("current_streak") == 0,
           "fresh focus user streak=0")
    r = jpost("/focus/session", {
        "planned_minutes": 25,
        "actual_seconds": 1500,
        "backgrounded_seconds": 0,
        "locked_app_seconds": 0,
        "completed": True,
        "committed_app_count": 3,
    }, token=token)
    expect(r.status_code == 200, f"/focus/session 200 (got {r.status_code} {r.text[:100]})")
    if r.status_code == 200:
        j = r.json()
        expect(int(j.get("xp_delta", 0)) == 5,
               f"focus xp_delta == 5 (got {j.get('xp_delta')})")
    r = jget("/profile", token=token)
    expect(r.status_code == 200, "/profile 200 after focus")
    prof = r.json()
    expect(prof.get("current_streak") == 1,
           f"focus -> current_streak == 1 (got {prof.get('current_streak')})")


def test_4_challenge_bumps_streak():
    """(4) Challenge complete bumps streak from 0 to 1."""
    print("\n[Test 4] Challenge complete bumps streak")
    token, uid, _ = register("chal")
    r = jget("/profile", token=token)
    expect(r.json().get("current_streak") == 0, "fresh challenge user streak=0")
    r = jpost("/challenge/accept", {}, token=token)
    expect(r.status_code == 200, "/challenge/accept 200")
    r = jpost("/challenge/complete", {
        "completed": True,
        "how_text": "Did it",
        "difficulty": "easy",
        "experience_text": "Felt good",
        "rating": 5,
    }, token=token)
    expect(r.status_code == 200, f"/challenge/complete 200 (got {r.status_code} {r.text[:120]})")
    if r.status_code == 200:
        j = r.json()
        expect(int(j.get("awarded_xp", 0)) > 0,
               f"challenge awarded_xp > 0 (got {j.get('awarded_xp')})")
    r = jget("/profile", token=token)
    expect(r.json().get("current_streak") == 1,
           f"challenge -> current_streak == 1 (got {r.json().get('current_streak')})")


def test_1_streak_cap_indirect():
    """(1a/b) Streak cap exists (indirect): fresh user shows 0, gift bumps to 1
    NOT 2, and idempotent same-day grant doesn't bump beyond 1.
    Already covered by tests 2 + 7 -- this is just a named summary line.
    """
    print("\n[Test 1a/b] Streak cap (indirect) -- covered by tests 2 + 7")


async def test_1c_streak_cap_direct(admin_token: str):
    """(1c) Direct DB seed: set current_streak=5000 + last_active_date=yesterday,
    trigger another gift, verify streak stays exactly 5000 (not 5001).
    """
    print("\n[Test 1c] Streak cap held at 5000 (direct DB seed -> trigger gift)")
    try:
        from motor.motor_asyncio import AsyncIOMotorClient
    except Exception as e:
        print(f"  SKIP  motor unavailable: {e}")
        return

    mongo_url = "mongodb://localhost:27017"
    db_name = "test_database"
    try:
        with open("/app/backend/.env", "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith("MONGO_URL"):
                    mongo_url = line.split("=", 1)[1].strip().strip('"').strip("'")
                elif line.startswith("DB_NAME"):
                    db_name = line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass

    client = AsyncIOMotorClient(mongo_url, serverSelectionTimeoutMS=4000)
    db = client[db_name]
    try:
        await db.command("ping")
    except Exception as e:
        print(f"  SKIP  cannot reach MongoDB at {mongo_url}: {e}")
        return

    token, uid, _ = register("cap")
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    res = await db.profile.update_one(
        {"_id": uid},
        {"$set": {"current_streak": 5000, "longest_streak": 5000,
                  "last_active_date": yesterday}},
    )
    expect(res.modified_count == 1,
           f"db.profile primed (cs=5000, last_active=yesterday) -- modified={res.modified_count}")

    r = jpost("/admin/gift/xp",
              {"user_id": uid, "amount": 1, "message": "cap probe"},
              token=admin_token)
    expect(r.status_code == 200, f"/admin/gift/xp 200 (cap probe; got {r.status_code})")

    r = jget("/profile", token=token)
    expect(r.status_code == 200, "/profile 200 (cap probe)")
    prof = r.json()
    cs = prof.get("current_streak")
    expect(cs == 5000, f"current_streak capped at 5000 (got {cs} -- should NOT be 5001)")
    expect(prof.get("last_active_date") == utc_today(),
           "last_active_date == today UTC after cap probe")
    pdoc = await db.profile.find_one({"_id": uid}, {"longest_streak": 1})
    expect((pdoc or {}).get("longest_streak") == 5000,
           f"longest_streak capped at 5000 (got {(pdoc or {}).get('longest_streak')})")

    client.close()


def test_6_regression(token: str, admin_token: str):
    """(6) No regression on commonly hit endpoints."""
    print("\n[Test 6] Regression -- common endpoints all 200")
    for path in ["/profile", "/stats/daily", "/stats/weekly",
                 "/stats/monthly", "/stats/by-area", "/library/ratings"]:
        r = jget(path, token=token)
        expect(r.status_code == 200, f"GET {path} 200 (got {r.status_code})")
    r = jget("/library/catalog", token=admin_token)
    expect(r.status_code == 200, f"GET /library/catalog (admin) 200 (got {r.status_code})")


def main():
    print(f"BASE = {BASE}")
    print("Logging in as admin...")
    admin_token = admin_login()

    token2, uid2 = test_2_gift_bumps_streak(admin_token)
    test_5_stats_show_gifted_xp(token2)
    test_7_idempotent_same_day(admin_token, token2, uid2)
    test_1_streak_cap_indirect()
    test_3_focus_bumps_streak()
    test_4_challenge_bumps_streak()
    test_6_regression(token2, admin_token)
    asyncio.run(test_1c_streak_cap_direct(admin_token))

    print()
    print("=" * 62)
    print(f"PASSED: {PASSED}    FAILED: {len(FAILED)}")
    if FAILED:
        print("\nFAILURES:")
        for f in FAILED:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL ASSERTIONS PASSED")


if __name__ == "__main__":
    main()
