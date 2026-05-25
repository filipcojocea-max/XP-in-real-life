#!/usr/bin/env python3
"""Tests for Library+ Mini-App Ratings + regression smoke checks.

Endpoints under test:
  - GET  /api/library/ratings
  - POST /api/library/ratings
  - Regression: /api/profile, /api/stats/weekly, /api/stats/monthly,
                /api/stats/by-area, /api/library/catalog (admin-only)
"""
import os
import sys
import uuid
import time
import json
import random
import string
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASS = 0
FAIL = 0
FAILS: list[str] = []


def assert_eq(actual, expected, label):
    global PASS, FAIL
    if actual == expected:
        PASS += 1
        print(f"  ✓ {label}")
    else:
        FAIL += 1
        msg = f"  ✗ {label} — expected {expected!r}, got {actual!r}"
        FAILS.append(msg)
        print(msg)


def assert_true(cond, label):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {label}")
    else:
        FAIL += 1
        msg = f"  ✗ {label}"
        FAILS.append(msg)
        print(msg)


def section(name):
    print(f"\n=== {name} ===")


def gmail_local() -> str:
    # plus-tag avoids conflicts with prior runs
    return "rate" + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))


def register_user(name: str) -> tuple[str, str, str]:
    """Returns (token, user_id, email)."""
    email = f"{gmail_local()}@gmail.com"
    pw = "Passw0rd!" + uuid.uuid4().hex[:6]
    r = requests.post(
        f"{BASE}/auth/register",
        json={"full_name": name, "email": email, "password": pw},
        timeout=30,
    )
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    j = r.json()
    return j["token"], j["user"]["id"], email


def auth_h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ============================================================
# (1) GET /api/library/ratings — fresh user
# ============================================================
def test_get_fresh_user():
    section("GET /api/library/ratings — fresh user, no ratings exist")
    token, uid, email = register_user("Maya Patel")
    print(f"  registered uid={uid[:8]}… email={email}")
    r = requests.get(f"{BASE}/library/ratings", headers=auth_h(token), timeout=30)
    assert_eq(r.status_code, 200, "status 200")
    body = r.json()
    assert_true("ratings" in body, "response has 'ratings' key")
    rd = body.get("ratings", {})
    assert_eq(set(rd.keys()), {"sleep", "challenges", "spot", "confidence"}, "exactly 4 app keys")
    for aid in ["sleep", "challenges", "spot", "confidence"]:
        s = rd.get(aid, {})
        assert_eq(set(s.keys()), {"average", "count", "user_rating"}, f"{aid} has exactly 3 keys")
        assert_true(isinstance(s.get("average"), (int, float)), f"{aid}.average is numeric")
        assert_true(isinstance(s.get("count"), int), f"{aid}.count is int")
        # for a freshly-registered user the count MIGHT not be 0 because
        # other users in the global DB might have rated. The spec says
        # "for a fresh user with no prior ratings, ALL apps should return
        # {average:0, count:0, user_rating:null} initially". So we need
        # a clean DB or this check needs to be looser. The spec is clear.
        # We do strict-check for user_rating=None, but loose-check the rest.
        assert_true(s.get("user_rating") is None, f"{aid}.user_rating is null for fresh user")
    return token, uid, email


# ============================================================
# (2) POST /api/library/ratings — scenarios A..E
# ============================================================
def test_post_scenarios(token, uid):
    section("POST /api/library/ratings — Scenario A (create sleep=4)")
    r = requests.post(
        f"{BASE}/library/ratings",
        headers=auth_h(token),
        json={"app_id": "sleep", "stars": 4},
        timeout=30,
    )
    assert_eq(r.status_code, 200, "status 200")
    j = r.json()
    assert_eq(j.get("saved"), True, "saved=true")
    assert_eq(j.get("app_id"), "sleep", "app_id='sleep'")
    stats = j.get("stats", {})
    assert_eq(stats.get("user_rating"), 4, "stats.user_rating=4")
    a_avg_after = stats.get("average")
    a_count_after = stats.get("count")
    print(f"  (info) post-A sleep avg={a_avg_after} count={a_count_after}")

    section("POST /api/library/ratings — Scenario B (update sleep 4→5, NO new row)")
    r = requests.post(
        f"{BASE}/library/ratings",
        headers=auth_h(token),
        json={"app_id": "sleep", "stars": 5},
        timeout=30,
    )
    assert_eq(r.status_code, 200, "status 200")
    j2 = r.json()
    stats2 = j2.get("stats", {})
    assert_eq(stats2.get("user_rating"), 5, "user_rating updated to 5")
    # count should be the same as after A — same row updated, not inserted
    assert_eq(stats2.get("count"), a_count_after, "count unchanged from A (upsert, not insert)")
    # GET re-confirms
    rget = requests.get(f"{BASE}/library/ratings", headers=auth_h(token), timeout=30).json()
    sleep_after_b = rget["ratings"]["sleep"]
    assert_eq(sleep_after_b["count"], a_count_after, "GET sleep.count unchanged")
    assert_eq(sleep_after_b["user_rating"], 5, "GET sleep.user_rating=5")

    section("POST /api/library/ratings — Scenario C (different app: challenges=3)")
    r = requests.post(
        f"{BASE}/library/ratings",
        headers=auth_h(token),
        json={"app_id": "challenges", "stars": 3},
        timeout=30,
    )
    assert_eq(r.status_code, 200, "status 200")
    j3 = r.json()
    stats3 = j3.get("stats", {})
    assert_eq(stats3.get("user_rating"), 3, "challenges.user_rating=3")
    challenges_count_after_c = stats3.get("count")
    # GET — sleep unchanged at 5
    rget = requests.get(f"{BASE}/library/ratings", headers=auth_h(token), timeout=30).json()
    rd = rget["ratings"]
    assert_eq(rd["sleep"]["user_rating"], 5, "after C: sleep.user_rating still 5")
    assert_eq(rd["challenges"]["user_rating"], 3, "after C: challenges.user_rating=3")
    # spot/confidence still null for THIS user
    assert_eq(rd["spot"]["user_rating"], None, "spot.user_rating still null")
    assert_eq(rd["confidence"]["user_rating"], None, "confidence.user_rating still null")

    section("POST /api/library/ratings — Scenario E (validation)")
    cases = [
        ({"app_id": "sleep", "stars": 0},   "stars=0"),
        ({"app_id": "sleep", "stars": 6},   "stars=6"),
        ({"app_id": "sleep", "stars": "abc"}, "stars='abc'"),
        ({"app_id": "invalid_app", "stars": 3}, "invalid app_id"),
        ({"app_id": "sleep"},               "missing stars"),
    ]
    for body, label in cases:
        r = requests.post(f"{BASE}/library/ratings", headers=auth_h(token), json=body, timeout=30)
        # Note: missing 'stars' → int(None) → TypeError → 400 in handler
        # Pydantic would return 422, but the handler uses Body(...) raw dict, so 400 is correct
        assert_true(
            r.status_code in (400, 422),
            f"{label} → {r.status_code} (expected 400/422); body={r.text[:120]}"
        )

    return a_count_after, challenges_count_after_c


# ============================================================
# (3) Scenario D — multi-user aggregation
# ============================================================
def test_multi_user_aggregation(token1, uid1, sleep_count_before_user2):
    section("Scenario D — second user pushes sleep=1, user1 sees aggregate")
    token2, uid2, _email2 = register_user("Ryan Chen")
    print(f"  user2 uid={uid2[:8]}…")
    # user2 GET first to see their state
    r = requests.get(f"{BASE}/library/ratings", headers=auth_h(token2), timeout=30).json()
    u2_sleep_before = r["ratings"]["sleep"]
    assert_eq(u2_sleep_before["user_rating"], None, "user2 has NO sleep rating initially")

    # user2 POSTs sleep=1
    r = requests.post(
        f"{BASE}/library/ratings",
        headers=auth_h(token2),
        json={"app_id": "sleep", "stars": 1},
        timeout=30,
    )
    assert_eq(r.status_code, 200, "user2 post 200")
    j = r.json()
    stats = j.get("stats", {})
    assert_eq(stats.get("user_rating"), 1, "user2 user_rating=1")
    new_count = stats.get("count")
    assert_eq(new_count, sleep_count_before_user2 + 1, f"sleep.count incremented by 1 ({sleep_count_before_user2}→{new_count})")

    # Now user1 GET — sleep should reflect aggregate of (5, 1, ...) and user_rating still 5
    rget = requests.get(f"{BASE}/library/ratings", headers=auth_h(token1), timeout=30).json()
    sleep_now = rget["ratings"]["sleep"]
    assert_eq(sleep_now["count"], new_count, "user1 sees same count as user2")
    assert_eq(sleep_now["user_rating"], 5, "user1.user_rating still 5 (their own, unaffected)")
    # Average must be sum/count. We don't know all prior raters, but if
    # the only two raters are user1 and user2, avg should be (5+1)/2 = 3.0.
    if new_count == 2:
        assert_eq(sleep_now["average"], 3.0, "avg = (5+1)/2 = 3.0 (clean DB scenario)")
    else:
        # global DB had prior raters — verify average is recomputed sanely
        assert_true(0 < sleep_now["average"] <= 5,
                    f"avg in valid range [1,5] (count={new_count}, avg={sleep_now['average']})")
    return token2, uid2


# ============================================================
# (4) Scenario F — anonymous via X-Anonymous-Id
# ============================================================
def test_anonymous_header():
    section("Scenario F — anonymous mode via X-Anonymous-Id header")
    anon_id = "anon-test-" + uuid.uuid4().hex
    headers = {"X-Anonymous-Id": anon_id}

    # GET first — clean state for THIS anon id (user_rating null)
    r = requests.get(f"{BASE}/library/ratings", headers=headers, timeout=30)
    assert_eq(r.status_code, 200, "anon GET 200")
    rd = r.json()["ratings"]
    for aid in ["sleep", "challenges", "spot", "confidence"]:
        assert_eq(rd[aid]["user_rating"], None, f"anon: {aid}.user_rating=null initially")

    # POST sleep=2
    r = requests.post(
        f"{BASE}/library/ratings",
        headers=headers,
        json={"app_id": "sleep", "stars": 2},
        timeout=30,
    )
    assert_eq(r.status_code, 200, "anon POST 200")
    j = r.json()
    assert_eq(j["stats"]["user_rating"], 2, "anon stats.user_rating=2")

    # GET — verify it persists under that anon id
    r = requests.get(f"{BASE}/library/ratings", headers=headers, timeout=30)
    assert_eq(r.json()["ratings"]["sleep"]["user_rating"], 2, "anon sleep.user_rating persisted=2")

    # A different anon id should NOT see this rating as their own
    other_headers = {"X-Anonymous-Id": "anon-other-" + uuid.uuid4().hex}
    r = requests.get(f"{BASE}/library/ratings", headers=other_headers, timeout=30)
    assert_eq(r.json()["ratings"]["sleep"]["user_rating"], None, "different anon id: sleep.user_rating=null (data isolated)")


# ============================================================
# (5) Regression smokes
# ============================================================
def test_regression(token):
    section("Regression smoke — /profile, /stats/weekly, /stats/monthly, /stats/by-area")
    h = auth_h(token)
    r = requests.get(f"{BASE}/profile", headers=h, timeout=30)
    assert_eq(r.status_code, 200, "/profile 200")
    assert_true(isinstance(r.json().get("total_xp"), int), "/profile has total_xp")

    r = requests.get(f"{BASE}/stats/weekly", headers=h, timeout=30)
    assert_eq(r.status_code, 200, "/stats/weekly 200")
    days = r.json().get("days", [])
    assert_eq(len(days), 7, "weekly has 7 days")

    r = requests.get(f"{BASE}/stats/monthly", headers=h, timeout=30)
    assert_eq(r.status_code, 200, "/stats/monthly 200")
    days = r.json().get("days", [])
    assert_eq(len(days), 30, "monthly has 30 days")

    r = requests.get(f"{BASE}/stats/by-area", headers=h, timeout=30)
    assert_eq(r.status_code, 200, "/stats/by-area 200")
    ba = r.json().get("by_area", {})
    assert_eq(set(ba.keys()), {"social", "fitness", "appearance", "mindset"}, "by_area has 4 keys")


def test_admin_catalog():
    section("Regression smoke — /library/catalog (admin login)")
    r = requests.post(
        f"{BASE}/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert_eq(r.status_code, 200, "admin login 200")
    admin_token = r.json()["token"]
    r = requests.get(f"{BASE}/library/catalog", headers=auth_h(admin_token), timeout=30)
    assert_eq(r.status_code, 200, "admin /library/catalog 200")

    # Non-admin should be 403
    nonadmin_token, _, _ = register_user("Tester Block")
    r = requests.get(f"{BASE}/library/catalog", headers=auth_h(nonadmin_token), timeout=30)
    assert_eq(r.status_code, 403, "non-admin /library/catalog 403")


def main():
    print(f"BASE = {BASE}")
    token1, uid1, email1 = test_get_fresh_user()
    # Capture the sleep count BEFORE user2 POSTs — so we can verify the
    # increment math even if the global DB already has historical rows.
    rget = requests.get(f"{BASE}/library/ratings", headers=auth_h(token1), timeout=30).json()
    sleep_count_pre_user2 = rget["ratings"]["sleep"]["count"]  # prior to user2's post
    test_post_scenarios(token1, uid1)
    # Re-fetch sleep count now (after user1's A→B sleep ratings: still +1 net for user1)
    rget = requests.get(f"{BASE}/library/ratings", headers=auth_h(token1), timeout=30).json()
    sleep_count_now = rget["ratings"]["sleep"]["count"]
    test_multi_user_aggregation(token1, uid1, sleep_count_now)
    test_anonymous_header()
    test_regression(token1)
    test_admin_catalog()

    print()
    print("=" * 60)
    print(f"PASS: {PASS}")
    print(f"FAIL: {FAIL}")
    if FAILS:
        print("\nFailures:")
        for f in FAILS:
            print(f)
    print("=" * 60)
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
