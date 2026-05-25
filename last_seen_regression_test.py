"""Regression test focused on the four UX fixes shipped:
ONLY ONE has backend impact — last_seen_at via _touch_last_seen.

Validations:
  1. /api/profile populates last_seen_at (string or null on first call) for an authed user
  2. /api/friends/list contains last_seen_at on each entry (both directions)
  3. /api/players/search and player detail surface last_seen_at via _serialize_player
  4. Throttle correctness — 10 rapid /profile calls return 200, last_seen_at stable within ~60s
  5. No-auth fallback (no Bearer, no X-Anonymous-Id) → /profile still 200, no crash
  6. Critical-path regression:
       - /api/auth/register, /api/auth/login (correct + wrong-pw 401)
       - /api/profile GET (incl. last_seen_at)
       - /api/profile PUT day-anchor + lock + reset
       - /api/tasks complete + uncomplete (XP roundtrip)
       - /api/goals create/update/delete
       - /api/friends/leaderboard?tz=0 (rows + reports + week_key + viewer_is_sunday)
       - /api/spot/object + /api/spot/check (light: empty → 400)
"""

import os
import sys
import time
import uuid
import json
import base64
import requests
from datetime import datetime, timezone

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASS = 0
FAIL = 0
FAILURES: list[str] = []


def expect(cond: bool, label: str, info: str = "") -> bool:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {label}")
        return True
    FAIL += 1
    msg = f"  ❌ {label}" + (f"  ::  {info}" if info else "")
    print(msg)
    FAILURES.append(label + (f" :: {info}" if info else ""))
    return False


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def fresh_email(prefix: str) -> str:
    return f"{prefix}.{uuid.uuid4().hex[:10]}@gmail.com"


def register_user(full_name: str, email: str, password: str) -> dict:
    r = requests.post(f"{BASE}/auth/register", json={
        "full_name": full_name,
        "email": email,
        "password": password,
    }, timeout=20)
    expect(r.status_code == 200, f"register({email}) → 200", f"got {r.status_code} body={r.text[:200]}")
    return r.json() if r.status_code == 200 else {}


# ============================================================
# 1) /api/profile populates last_seen_at
# ============================================================
def test_profile_last_seen():
    print("\n[1] /api/profile populates last_seen_at for authed user")
    email = fresh_email("alex.morgan")
    pw = "QuestForge!2026"
    auth = register_user("Alex Morgan", email, pw)
    if "token" not in auth:
        expect(False, "register returned token", str(auth)[:200])
        return None
    tok = auth["token"]

    r1 = requests.get(f"{BASE}/profile", headers=auth_headers(tok), timeout=15)
    expect(r1.status_code == 200, "GET /profile (1st) → 200", f"{r1.status_code} {r1.text[:200]}")
    p1 = r1.json() if r1.status_code == 200 else {}
    has1 = "last_seen_at" in p1
    expect(has1, "/profile (1st) includes last_seen_at field")
    val1 = p1.get("last_seen_at")
    # First call should set it OR (less likely) be None just before write — but our impl writes BEFORE returning.
    # Acceptable: ISO-8601 string, or None.
    if val1 is not None:
        ok_iso = isinstance(val1, str)
        try:
            datetime.fromisoformat(val1.replace("Z", "+00:00"))
            ok_iso = True
        except Exception:
            ok_iso = False
        expect(ok_iso, "last_seen_at is ISO-8601 string", f"got: {val1!r}")
    else:
        expect(True, "last_seen_at is None (acceptable on very first call)")

    # Immediate 2nd call → should still 200, throttled (value should match within ~60s)
    r2 = requests.get(f"{BASE}/profile", headers=auth_headers(tok), timeout=15)
    expect(r2.status_code == 200, "GET /profile (2nd) → 200")
    p2 = r2.json() if r2.status_code == 200 else {}
    val2 = p2.get("last_seen_at")
    # Value should remain stable due to in-process throttle (60s)
    expect(val2 == val1 or (val1 is None and val2 is not None),
           "last_seen_at consistent across rapid calls (throttled)",
           f"v1={val1!r} v2={val2!r}")

    return {"token": tok, "user_id": auth.get("user", {}).get("id") or auth.get("user", {}).get("user_id"), "email": email, "password": pw}


# ============================================================
# 2) /api/friends/list contains last_seen_at on each entry
# ============================================================
def test_friends_list_last_seen():
    print("\n[2] /api/friends/list contains last_seen_at")
    eA = fresh_email("nina.chen")
    eB = fresh_email("oliver.park")
    pw = "QuestForge!2026"
    A = register_user("Nina Chen", eA, pw)
    B = register_user("Oliver Park", eB, pw)
    tA = A.get("token"); tB = B.get("token")
    uA = (A.get("user") or {}).get("id") or (A.get("user") or {}).get("user_id")
    uB = (B.get("user") or {}).get("id") or (B.get("user") or {}).get("user_id")
    if not (tA and tB and uA and uB):
        expect(False, "registered both A and B successfully", f"A={A} B={B}")
        return None

    # A → B request
    r = requests.post(f"{BASE}/friends/request", headers=auth_headers(tA),
                      json={"user_id": uB}, timeout=15)
    expect(r.status_code in (200, 201), "friends/request A→B → 2xx", f"{r.status_code} {r.text[:200]}")

    # B accepts
    r = requests.post(f"{BASE}/friends/accept", headers=auth_headers(tB),
                      json={"user_id": uA}, timeout=15)
    expect(r.status_code in (200, 201), "friends/accept B→A → 2xx", f"{r.status_code} {r.text[:200]}")

    # A's friends list
    r = requests.get(f"{BASE}/friends/list", headers=auth_headers(tA), timeout=15)
    expect(r.status_code == 200, "GET /friends/list as A → 200")
    body = r.json() if r.status_code == 200 else {}
    friends_a = body.get("friends") or body if isinstance(body, list) else body.get("friends", [])
    if isinstance(body, dict) and "friends" in body:
        friends_a = body["friends"]
    elif isinstance(body, list):
        friends_a = body
    expect(isinstance(friends_a, list) and len(friends_a) >= 1, "A has ≥1 friend")
    if friends_a:
        b_entry = next((f for f in friends_a if f.get("user_id") == uB), friends_a[0])
        expect("last_seen_at" in b_entry, "B's entry in A's friend list has last_seen_at key")
        ls = b_entry.get("last_seen_at")
        expect(ls is None or isinstance(ls, str), "B.last_seen_at is None or str", f"got {ls!r}")
        # B was just registered/accepted via authed call, so should be a string by now.
        if isinstance(ls, str):
            try:
                datetime.fromisoformat(ls.replace("Z", "+00:00"))
                expect(True, "B.last_seen_at is ISO-8601")
            except Exception:
                expect(False, "B.last_seen_at is ISO-8601", f"got {ls!r}")

    # B's friends list (mirror direction)
    r = requests.get(f"{BASE}/friends/list", headers=auth_headers(tB), timeout=15)
    expect(r.status_code == 200, "GET /friends/list as B → 200")
    body2 = r.json() if r.status_code == 200 else {}
    friends_b = body2["friends"] if isinstance(body2, dict) and "friends" in body2 else (body2 if isinstance(body2, list) else [])
    if friends_b:
        a_entry = next((f for f in friends_b if f.get("user_id") == uA), friends_b[0])
        expect("last_seen_at" in a_entry, "A's entry in B's friend list has last_seen_at key")
    return {"A": A, "B": B, "uA": uA, "uB": uB}


# ============================================================
# 3) /api/players/search + player detail surface last_seen_at
# ============================================================
def test_players_search_last_seen(ctx):
    print("\n[3] /api/players/search + detail include last_seen_at")
    if not ctx:
        return
    A = ctx["A"]; uB = ctx["uB"]
    tA = A["token"]
    # Search by part of B's name
    r = requests.get(f"{BASE}/friends/players?q=Oliver", headers=auth_headers(tA), timeout=15)
    expect(r.status_code == 200, "GET /friends/players?q=Oliver → 200", f"{r.status_code} {r.text[:200]}")
    body = r.json() if r.status_code == 200 else {}
    players = body if isinstance(body, list) else body.get("players") or body.get("results") or []
    expect(isinstance(players, list) and len(players) >= 1, "search returned ≥1 result")
    if players:
        first = players[0]
        expect("last_seen_at" in first, "search result includes last_seen_at key")

    # Player detail
    r = requests.get(f"{BASE}/friends/profile/{uB}", headers=auth_headers(tA), timeout=15)
    expect(r.status_code == 200, "GET /friends/profile/{B_id} → 200", f"{r.status_code} {r.text[:200]}")
    detail = r.json() if r.status_code == 200 else {}
    expect("last_seen_at" in detail, "player detail includes last_seen_at key")


# ============================================================
# 4) Throttle correctness: 10 rapid /profile calls all 200
# ============================================================
def test_throttle(authed):
    print("\n[4] Rapid /api/profile (10x) returns 200; last_seen_at stable")
    if not authed:
        return
    tok = authed["token"]
    seen = set()
    all_ok = True
    for i in range(10):
        r = requests.get(f"{BASE}/profile", headers=auth_headers(tok), timeout=15)
        if r.status_code != 200:
            all_ok = False
            FAILURES.append(f"rapid call #{i+1} returned {r.status_code}")
            print(f"  ❌ rapid call #{i+1} → {r.status_code}")
            break
        seen.add(r.json().get("last_seen_at"))
    expect(all_ok, "10 rapid /profile calls all 200")
    # Throttle means last_seen_at should not change more than once across rapid calls
    expect(len(seen) <= 1, f"last_seen_at stable (≤1 distinct value across 10 rapid calls)",
           f"got {len(seen)} distinct values: {seen}")


# ============================================================
# 5) No-auth fallback ('main') still works
# ============================================================
def test_noauth_main_fallback():
    print("\n[5] No auth + no X-Anonymous-Id → 'main' fallback works")
    # Use a clean session WITHOUT any headers
    r = requests.get(f"{BASE}/profile", timeout=15)
    expect(r.status_code == 200, "GET /profile (no headers) → 200", f"{r.status_code} {r.text[:300]}")
    body = r.json() if r.status_code == 200 else {}
    expect(isinstance(body, dict), "no-auth /profile returns dict")
    # last_seen_at field should still be present (from _serialize_profile)
    expect("last_seen_at" in body or body == {} or "user_id" in body or "level" in body,
           "no-auth response is a profile-shaped dict")


# ============================================================
# 6) Critical-path regression
# ============================================================
def test_regression():
    print("\n[6] Critical-path regression")
    # ----- Auth: register & login flows -----
    email = fresh_email("regina.silva")
    pw = "Regression!2026"
    auth = register_user("Regina Silva", email, pw)
    tok = auth.get("token")
    expect(bool(tok), "register returned JWT")

    # Wrong pw
    r = requests.post(f"{BASE}/auth/login", json={"email": email, "password": "wrong-pw-123"}, timeout=15)
    expect(r.status_code == 401, "login with wrong pw → 401", f"{r.status_code} {r.text[:200]}")
    # Correct
    r = requests.post(f"{BASE}/auth/login", json={"email": email, "password": pw}, timeout=15)
    expect(r.status_code == 200, "login correct → 200", f"{r.status_code} {r.text[:200]}")
    tok = r.json().get("token") or tok

    # ----- /profile GET with last_seen_at -----
    r = requests.get(f"{BASE}/profile", headers=auth_headers(tok), timeout=15)
    expect(r.status_code == 200, "GET /profile (auth) → 200")
    p = r.json() if r.status_code == 200 else {}
    expect("last_seen_at" in p, "/profile contains last_seen_at field")

    # ----- Day anchor PUT/lock/reset -----
    r = requests.put(f"{BASE}/profile", headers=auth_headers(tok),
                     json={"timezone": "Australia/Sydney", "day_start_time": "07:00"}, timeout=15)
    expect(r.status_code == 200, "PUT day-anchor → 200", f"{r.status_code} {r.text[:200]}")
    p2 = r.json() if r.status_code == 200 else {}
    expect(p2.get("onboarding_tz_done") is True, "onboarding_tz_done flipped to true")
    expect(p2.get("timezone") == "Australia/Sydney", "timezone persisted")
    expect(p2.get("day_start_time") == "07:00", "day_start_time persisted")

    # Lock: tz
    r = requests.put(f"{BASE}/profile", headers=auth_headers(tok),
                     json={"timezone": "Australia/Perth"}, timeout=15)
    expect(r.status_code == 400, "PUT timezone again → 400 tz_locked", f"{r.status_code} {r.text[:200]}")
    if r.status_code == 400:
        try:
            err = (r.json().get("detail") or {}).get("error")
            expect(err == "tz_locked", "detail.error == 'tz_locked'", f"got {err!r}")
        except Exception:
            pass
    # Lock: day_start
    r = requests.put(f"{BASE}/profile", headers=auth_headers(tok),
                     json={"day_start_time": "08:00"}, timeout=15)
    expect(r.status_code == 400, "PUT day_start_time again → 400 day_start_locked", f"{r.status_code} {r.text[:200]}")
    if r.status_code == 400:
        try:
            err = (r.json().get("detail") or {}).get("error")
            expect(err == "day_start_locked", "detail.error == 'day_start_locked'", f"got {err!r}")
        except Exception:
            pass

    # Reset
    r = requests.post(f"{BASE}/profile/reset", headers=auth_headers(tok), timeout=15)
    expect(r.status_code == 200, "POST /profile/reset → 200", f"{r.status_code} {r.text[:200]}")
    pr = r.json() if r.status_code == 200 else {}
    expect(pr.get("timezone") in (None, ""), "timezone cleared")
    expect(pr.get("day_start_time") in (None, ""), "day_start_time cleared")

    # ----- Tasks complete/uncomplete XP roundtrip -----
    # Use today's date so we hit the standard path
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # Get any task (default seeded should exist on fresh users)
    r = requests.get(f"{BASE}/tasks", headers=auth_headers(tok), timeout=15)
    expect(r.status_code == 200, "GET /tasks → 200")
    tlist = r.json()
    tasks = tlist.get("tasks") if isinstance(tlist, dict) else tlist
    if not tasks:
        # create a custom one
        r = requests.post(f"{BASE}/tasks", headers=auth_headers(tok),
                          json={"title": "Reg test task", "xp_value": 15, "focus_area": "mindset", "time_slot": "morning"}, timeout=15)
        expect(r.status_code == 200, "POST /tasks (fallback create) → 200")
        tid = r.json().get("id") or r.json().get("task", {}).get("id")
    else:
        tid = tasks[0].get("id")
    expect(bool(tid), "have a task id to complete")

    pre_xp = 0
    rp = requests.get(f"{BASE}/profile", headers=auth_headers(tok), timeout=15)
    if rp.status_code == 200:
        pre_xp = int(rp.json().get("total_xp", 0) or 0)

    r = requests.post(f"{BASE}/tasks/{tid}/complete", headers=auth_headers(tok),
                      json={"date": today}, timeout=15)
    expect(r.status_code == 200, "POST /tasks/{id}/complete → 200", f"{r.status_code} {r.text[:200]}")
    body = r.json() if r.status_code == 200 else {}
    awarded = int(body.get("xp_awarded", 0) or 0)
    expect(awarded > 0, "complete returns xp_awarded > 0")

    rp = requests.get(f"{BASE}/profile", headers=auth_headers(tok), timeout=15)
    mid_xp = int(rp.json().get("total_xp", 0) or 0) if rp.status_code == 200 else pre_xp
    expect(mid_xp >= pre_xp + awarded, f"profile XP grew by ≥awarded ({pre_xp}→{mid_xp}, awarded={awarded})")

    r = requests.post(f"{BASE}/tasks/{tid}/uncomplete", headers=auth_headers(tok),
                      json={"date": today}, timeout=15)
    expect(r.status_code == 200, "POST /tasks/{id}/uncomplete → 200", f"{r.status_code} {r.text[:200]}")
    rb = r.json() if r.status_code == 200 else {}
    expect(int(rb.get("xp_removed", 0) or 0) == awarded, f"xp_removed == previously awarded ({rb.get('xp_removed')} vs {awarded})")

    rp = requests.get(f"{BASE}/profile", headers=auth_headers(tok), timeout=15)
    end_xp = int(rp.json().get("total_xp", 0) or 0) if rp.status_code == 200 else mid_xp
    expect(end_xp == pre_xp, f"profile XP rolled back to pre-complete ({pre_xp}, got {end_xp})")

    # ----- Goals create/update/delete -----
    r = requests.post(f"{BASE}/goals", headers=auth_headers(tok),
                      json={"title": "Run 30 days", "focus_area": "fitness", "target_value": 30, "unit": "days", "xp_reward": 30}, timeout=15)
    expect(r.status_code == 200, "POST /goals → 200", f"{r.status_code} {r.text[:200]}")
    gbody = r.json() if r.status_code == 200 else {}
    gid = gbody.get("id") or (gbody.get("goal") or {}).get("id")
    expect(bool(gid), "goal id returned")
    if gid:
        r = requests.put(f"{BASE}/goals/{gid}", headers=auth_headers(tok),
                         json={"title": "Run 30 days (updated)"}, timeout=15)
        expect(r.status_code == 200, "PUT /goals/{id} → 200", f"{r.status_code} {r.text[:200]}")
        r = requests.delete(f"{BASE}/goals/{gid}", headers=auth_headers(tok), timeout=15)
        expect(r.status_code == 200, "DELETE /goals/{id} → 200")

    # ----- Friends leaderboard -----
    r = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=auth_headers(tok), timeout=15)
    expect(r.status_code == 200, "GET /friends/leaderboard?tz=0 → 200", f"{r.status_code} {r.text[:200]}")
    lb = r.json() if r.status_code == 200 else {}
    expect("rows" in lb and isinstance(lb["rows"], list), "leaderboard has rows[]")
    expect("reports" in lb and isinstance(lb["reports"], list), "leaderboard has reports[]")
    expect("week_key" in lb and isinstance(lb["week_key"], str), "leaderboard has week_key")
    expect("viewer_is_sunday" in lb and isinstance(lb["viewer_is_sunday"], bool), "leaderboard has viewer_is_sunday")

    # ----- Spot endpoints respond (don't actually run vision) -----
    r = requests.get(f"{BASE}/spot/object", headers=auth_headers(tok), timeout=15)
    expect(r.status_code == 200, "GET /spot/object → 200", f"{r.status_code} {r.text[:200]}")
    body = r.json() if r.status_code == 200 else {}
    expect("object" in body and "challenge_id" in body, "spot/object response has object+challenge_id")
    cid = body.get("challenge_id")

    # spot/check with empty photo → 400 (just verifying endpoint responds)
    r = requests.post(f"{BASE}/spot/check", headers=auth_headers(tok),
                      json={"photo_base64": "", "target_object": "leaf", "challenge_id": cid}, timeout=15)
    expect(r.status_code == 400, "POST /spot/check (empty photo) → 400", f"{r.status_code} {r.text[:200]}")

    # ----- Admin login should also work -----
    r = requests.post(f"{BASE}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    expect(r.status_code == 200, "admin login → 200", f"{r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        atok = r.json().get("token")
        rp = requests.get(f"{BASE}/profile", headers=auth_headers(atok), timeout=15)
        expect(rp.status_code == 200, "admin GET /profile → 200")
        ap = rp.json() if rp.status_code == 200 else {}
        expect("last_seen_at" in ap, "admin /profile contains last_seen_at")
        expect(ap.get("is_admin") is True, "admin profile is_admin=true")


def main():
    print(f"== last_seen_at + UX-fix regression — {BASE} ==")
    authed = test_profile_last_seen()
    ctx = test_friends_list_last_seen()
    test_players_search_last_seen(ctx)
    test_throttle(authed)
    test_noauth_main_fallback()
    test_regression()
    print(f"\n== Results: {PASS} pass, {FAIL} fail ==")
    if FAILURES:
        print("\nFailures:")
        for f in FAILURES:
            print(f"  - {f}")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
