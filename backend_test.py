"""Backend tests for the four newly-added features:
  1. Points+ Boost Inventory (claim / activate-from-inventory / status)
  2. Friends Weekly Leaderboard
  3. Leaderboard Report-Player System
  4. Leaderboard Player Profile

Run via: python /app/backend_test.py
"""
from __future__ import annotations
import sys
import uuid
import json
import requests

# Read the public ingress URL from frontend/.env (EXPO_PUBLIC_BACKEND_URL)
def _read_backend_url() -> str:
    env_path = "/app/frontend/.env"
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("EXPO_PUBLIC_BACKEND_URL not found in /app/frontend/.env")


BASE = _read_backend_url().rstrip("/") + "/api"
print(f"Testing against {BASE}")

PASS, FAIL = [], []


def _check(label: str, cond: bool, info: str = ""):
    if cond:
        PASS.append(label)
        print(f"  ✓ {label}")
    else:
        FAIL.append(f"{label} :: {info}")
        print(f"  ✗ {label} :: {info}")


def _hdr_anon(aid: str) -> dict:
    return {"X-Anonymous-Id": aid, "Content-Type": "application/json"}


def _hdr_auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# 1. POINTS+ BOOST INVENTORY
def test_boost_inventory():
    print("\n═══ 1. Points+ Boost Inventory ═══")
    aid = f"boost-test-{uuid.uuid4().hex[:16]}"
    h = _hdr_anon(aid)

    r = requests.get(f"{BASE}/profile", headers=h)
    _check("profile bootstrap (anon)", r.status_code == 200, f"status={r.status_code}")

    r = requests.get(f"{BASE}/boosts/status", headers=h)
    _check("GET /boosts/status (pre-unlock)", r.status_code == 200, str(r.status_code))
    if r.ok:
        s = r.json()
        _check("status: boosts_unlocked=false", s.get("boosts_unlocked") is False, str(s))
        _check("status: active_boost=null", s.get("active_boost") is None, str(s))
        _check("status: inventory=[]", s.get("boost_inventory") == [], str(s))

    r = requests.post(f"{BASE}/boosts/claim", headers=h,
                      data=json.dumps({"type": "triple_day"}))
    _check("claim without unlock → 403", r.status_code == 403,
           f"got {r.status_code}: {r.text[:200]}")
    if r.status_code == 403:
        try:
            d = r.json().get("detail")
            err = (d or {}).get("error") if isinstance(d, dict) else None
            _check("403 detail.error == 'boosts_locked'", err == "boosts_locked", str(d))
        except Exception as e:
            FAIL.append(f"403 body parse: {e}")

    r = requests.post(f"{BASE}/boosts/unlock", headers=h,
                      data=json.dumps({"code": "WRONGCODE"}))
    _check("unlock wrong code → 400", r.status_code == 400, f"got {r.status_code}")

    r = requests.post(f"{BASE}/boosts/unlock", headers=h,
                      data=json.dumps({"code": "XP270905W20"}))
    _check("unlock correct code → 200", r.status_code == 200,
           f"got {r.status_code}: {r.text[:200]}")
    if r.ok:
        body = r.json()
        _check("unlock: boosts_unlocked=true",
               body.get("boosts_unlocked") is True and
               body.get("profile", {}).get("boosts_unlocked") is True,
               str(body)[:300])

    r = requests.post(f"{BASE}/boosts/claim", headers=h,
                      data=json.dumps({"type": "triple_day"}))
    _check("claim triple_day after unlock → 200", r.status_code == 200,
           f"got {r.status_code}: {r.text[:200]}")
    claimed_id_1 = None
    if r.ok:
        body = r.json()
        claimed = body.get("claimed", {})
        claimed_id_1 = claimed.get("id")
        _check("claim returns 'claimed' with id+type",
               bool(claimed_id_1) and claimed.get("type") == "triple_day", str(claimed))
        _check("claimed multiplier=3, duration_days=1",
               claimed.get("multiplier") == 3 and claimed.get("duration_days") == 1, str(claimed))
        inv = body.get("profile", {}).get("boost_inventory", [])
        _check("profile.boost_inventory grew by 1 after claim",
               len(inv) == 1 and inv[0].get("id") == claimed_id_1, str(inv))

    r = requests.post(f"{BASE}/boosts/claim", headers=h,
                      data=json.dumps({"type": "double_week"}))
    _check("claim double_week → 200", r.status_code == 200, f"got {r.status_code}")
    claimed_id_2 = None
    if r.ok:
        claimed_id_2 = r.json().get("claimed", {}).get("id")
        inv = r.json().get("profile", {}).get("boost_inventory", [])
        _check("inventory now has 2 entries", len(inv) == 2, f"len={len(inv)}")

    r = requests.post(f"{BASE}/boosts/activate", headers=h,
                      data=json.dumps({"inventory_id": "non-existent-uuid-xyz"}))
    _check("activate bogus inventory_id → 404", r.status_code == 404,
           f"got {r.status_code}")

    if claimed_id_1:
        r = requests.post(f"{BASE}/boosts/activate", headers=h,
                          data=json.dumps({"inventory_id": claimed_id_1}))
        _check("activate valid inventory_id → 200", r.status_code == 200,
               f"got {r.status_code}: {r.text[:200]}")
        if r.ok:
            body = r.json()
            ab = body.get("active_boost", {})
            _check("active_boost has multiplier=3", (ab or {}).get("multiplier") == 3, str(ab))
            _check("active_boost has expires_at", bool((ab or {}).get("expires_at")), str(ab))
            _check("active_boost type=triple_day", (ab or {}).get("type") == "triple_day", str(ab))

    r = requests.get(f"{BASE}/boosts/status", headers=h)
    if r.ok:
        s = r.json()
        _check("status.boosts_unlocked=true after unlock", s.get("boosts_unlocked") is True, str(s))
        _check("status.active_boost present after activate",
               s.get("active_boost") is not None and s["active_boost"].get("multiplier") == 3,
               str(s.get("active_boost")))
        inv = s.get("boost_inventory", [])
        ids = [it.get("id") for it in inv]
        _check("status.boost_inventory excludes activated entry",
               claimed_id_1 not in ids, f"ids={ids}, activated={claimed_id_1}")
        _check("status.boost_inventory still has un-activated entry",
               claimed_id_2 in ids, f"ids={ids}, expected={claimed_id_2}")

    r = requests.post(f"{BASE}/boosts/activate", headers=h,
                      data=json.dumps({"type": "double_week"}))
    _check("legacy activate by {type} still works → 200", r.status_code == 200,
           f"got {r.status_code}: {r.text[:200]}")
    if r.ok:
        ab = r.json().get("active_boost", {})
        _check("legacy activate sets active_boost.type=double_week",
               (ab or {}).get("type") == "double_week", str(ab))


# 2. FRIENDS WEEKLY LEADERBOARD
def test_weekly_leaderboard():
    print("\n═══ 2. Friends Weekly Leaderboard ═══")
    aid = f"lb-test-{uuid.uuid4().hex[:16]}"
    h = _hdr_anon(aid)

    r = requests.get(f"{BASE}/profile", headers=h)
    _check("profile bootstrap for LB user", r.status_code == 200, str(r.status_code))

    r = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=h)
    _check("GET /friends/leaderboard?tz=0 → 200", r.status_code == 200,
           f"got {r.status_code}: {r.text[:200]}")
    if r.ok:
        body = r.json()
        rows = body.get("rows", [])
        _check("fresh user: 1 row (self)", len(rows) == 1, f"rows={len(rows)}")
        if rows:
            r0 = rows[0]
            _check("self row weekly_xp=0", r0.get("weekly_xp") == 0, str(r0))
            _check("self row is_self=true", r0.get("is_self") is True, str(r0))
        _check("response has reports[] field", isinstance(body.get("reports"), list),
               str(body)[:200])
        _check("response has viewer_is_sunday boolean",
               isinstance(body.get("viewer_is_sunday"), bool), str(body)[:200])
        _check("response has week_key", bool(body.get("week_key")), str(body)[:200])

    r2 = requests.get(f"{BASE}/friends/leaderboard?tz=330", headers=h)
    _check("LB with tz=330 → 200", r2.status_code == 200, str(r2.status_code))
    pr = requests.get(f"{BASE}/profile", headers=h)
    if pr.ok:
        _check("profile.tz_offset_minutes persisted to 330",
               pr.json().get("tz_offset_minutes") == 330,
               str(pr.json().get("tz_offset_minutes")))

    requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=h)

    tasks_resp = requests.get(f"{BASE}/tasks", headers=h)
    _check("GET /tasks for LB user", tasks_resp.status_code == 200, str(tasks_resp.status_code))
    if not tasks_resp.ok:
        return
    tasks = tasks_resp.json().get("tasks", [])
    if not tasks:
        FAIL.append("LB: no tasks seeded for fresh user")
        return
    target = tasks[0]
    task_id = target["id"]
    expected_xp = int(target["xp_value"])
    cr = requests.post(f"{BASE}/tasks/{task_id}/complete", headers=h, data=json.dumps({}))
    _check("complete first default task → 200", cr.status_code == 200, str(cr.status_code))
    awarded = cr.json().get("xp_awarded", 0) if cr.ok else 0
    _check("xp_awarded matches task xp_value (no boost active)",
           awarded == expected_xp, f"awarded={awarded}, expected={expected_xp}")

    r3 = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=h)
    if r3.ok:
        rows = r3.json().get("rows", [])
        if rows:
            self_row = next((row for row in rows if row.get("is_self")), None)
            _check("self.weekly_xp == awarded XP after task complete",
                   self_row and self_row.get("weekly_xp") == awarded,
                   f"row={self_row}, awarded={awarded}")

    # Sort order check would need ≥2 rows; that's covered indirectly via the
    # registered-users path in test_report_system. Idempotency check:
    r4a = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=h)
    r4b = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=h)
    if r4a.ok and r4b.ok:
        ra = r4a.json().get("rows", [])
        rb = r4b.json().get("rows", [])
        ma = ra[0].get("medals_count") if ra else None
        mb = rb[0].get("medals_count") if rb else None
        _check("medals_count idempotent across same-day calls",
               ma == mb, f"first={ma}, second={mb}")


def _register_user(full_name: str) -> tuple[str, str, str]:
    """Register a fresh user. Backend auto-verifies on register and returns JWT."""
    suffix = uuid.uuid4().hex[:10]
    email = f"{full_name.lower().replace(' ', '.')}.{suffix}@gmail.com"
    pwd = f"Pwd-{suffix}-XYZ"
    payload = {"full_name": full_name, "email": email, "password": pwd}
    r = requests.post(f"{BASE}/auth/register",
                      headers={"Content-Type": "application/json"},
                      data=json.dumps(payload))
    if r.status_code != 200:
        raise RuntimeError(f"register failed: {r.status_code} {r.text[:300]}")
    body = r.json()
    token = body.get("token")
    user_id = body.get("user", {}).get("id")
    if not token or not user_id:
        raise RuntimeError(f"register missing token/user.id: {body}")
    return user_id, token, email


# 3. LEADERBOARD REPORT-PLAYER SYSTEM
def test_report_system():
    print("\n═══ 3. Leaderboard Report-Player System ═══")
    try:
        a_id, a_tok, _ = _register_user("Alice Reporter")
        b_id, b_tok, _ = _register_user("Bob Reportee")
        _check("registered user A", bool(a_id and a_tok), f"a_id={a_id}")
        _check("registered user B", bool(b_id and b_tok), f"b_id={b_id}")
    except Exception as e:
        FAIL.append(f"register two users failed: {e}")
        return None

    r = requests.post(f"{BASE}/friends/request",
                      headers=_hdr_auth(a_tok),
                      data=json.dumps({"user_id": b_id}))
    _check("A sends friend request to B", r.status_code == 200,
           str(r.status_code) + " " + r.text[:200])
    r = requests.post(f"{BASE}/friends/accept",
                      headers=_hdr_auth(b_tok),
                      data=json.dumps({"user_id": a_id}))
    _check("B accepts → status=friends",
           r.status_code == 200 and r.json().get("status") == "friends",
           str(r.status_code) + " " + r.text[:200])

    r = requests.post(f"{BASE}/leaderboard/report",
                      headers=_hdr_auth(a_tok),
                      data=json.dumps({"reported_user_id": a_id, "reason": "self"}))
    _check("A self-report → 400", r.status_code == 400, str(r.status_code))

    rand_uid = str(uuid.uuid4())
    r = requests.post(f"{BASE}/leaderboard/report",
                      headers=_hdr_auth(a_tok),
                      data=json.dumps({"reported_user_id": rand_uid, "reason": "stranger"}))
    _check("report non-leaderboard member → 400", r.status_code == 400, str(r.status_code))

    r = requests.post(f"{BASE}/leaderboard/report",
                      headers=_hdr_auth(a_tok),
                      data=json.dumps({"reported_user_id": b_id,
                                        "reason": "Suspicious XP gain"}))
    _check("A reports B → 200", r.status_code == 200,
           str(r.status_code) + " " + r.text[:200])
    report_id = None
    if r.ok:
        report = r.json().get("report", {})
        report_id = report.get("id")
        _check("report has id, reporter_id, reported_user_id, week_key",
               bool(report_id) and report.get("reporter_id") == a_id
               and report.get("reported_user_id") == b_id
               and report.get("week_key"), str(report))
        _check("reporter A auto-supports own report",
               a_id in (report.get("supporters") or []), str(report.get("supporters")))

    r = requests.post(f"{BASE}/leaderboard/report",
                      headers=_hdr_auth(a_tok),
                      data=json.dumps({"reported_user_id": b_id, "reason": "again"}))
    _check("A duplicate report same week → 400", r.status_code == 400, str(r.status_code))

    if not report_id:
        return (a_id, a_tok, b_id, b_tok)

    r = requests.post(f"{BASE}/leaderboard/report/{report_id}/support",
                      headers=_hdr_auth(b_tok))
    _check("B supports report → 200", r.status_code == 200,
           str(r.status_code) + " " + r.text[:200])
    if r.ok:
        cnt = r.json().get("supporters_count")
        _check("supporters_count == 2 after B supports", cnt == 2, f"got {cnt}")

    r = requests.delete(f"{BASE}/leaderboard/report/{report_id}/support",
                        headers=_hdr_auth(b_tok))
    _check("B unsupport → 200", r.status_code == 200, str(r.status_code))
    if r.ok:
        cnt = r.json().get("supporters_count")
        _check("supporters_count decreases after unsupport (=1)", cnt == 1, f"got {cnt}")

    r = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=_hdr_auth(a_tok))
    _check("A GET leaderboard → 200", r.status_code == 200, str(r.status_code))
    if r.ok:
        body = r.json()
        rows = body.get("rows", [])
        # Sort order check: rows sorted desc by weekly_xp
        weekly = [row.get("weekly_xp", 0) for row in rows]
        _check("rows sorted desc by weekly_xp",
               weekly == sorted(weekly, reverse=True), f"weekly={weekly}")
        # A is friends with B → leaderboard should have at least 2 members
        _check("A's leaderboard has >= 2 rows (self + B)", len(rows) >= 2, f"len={len(rows)}")

        reports = body.get("reports", [])
        ids = [rep.get("id") for rep in reports]
        _check("reports[] surfaces A's active report",
               report_id in ids, f"ids={ids}, expected={report_id}")
        match = next((rep for rep in reports if rep.get("id") == report_id), None)
        if match:
            _check("report row has reporter_name + reported_name",
                   bool(match.get("reporter_name")) and bool(match.get("reported_name")),
                   str(match))
            _check("report row has reason + week_key + supporters_count",
                   bool(match.get("reason")) and bool(match.get("week_key"))
                   and isinstance(match.get("supporters_count"), int),
                   str(match))
            _check("viewer_is_reporter=true for reporter A",
                   match.get("viewer_is_reporter") is True, str(match))

    return (a_id, a_tok, b_id, b_tok)


# 4. LEADERBOARD PLAYER PROFILE
def test_player_profile(ctx):
    print("\n═══ 4. Leaderboard Player Profile ═══")
    if not ctx:
        FAIL.append("player profile test skipped — report test setup failed")
        return
    a_id, a_tok, b_id, b_tok = ctx

    r = requests.get(f"{BASE}/leaderboard/profile/{b_id}?tz=0",
                     headers=_hdr_auth(a_tok))
    _check("GET /leaderboard/profile/{other_id} → 200", r.status_code == 200,
           f"got {r.status_code}: {r.text[:200]}")
    if r.ok:
        body = r.json()
        _check("profile.user_id matches B",
               body.get("user_id") == b_id, f"user_id={body.get('user_id')}")
        _check("profile has weekly_xp (int)",
               isinstance(body.get("weekly_xp"), int),
               f"weekly_xp={body.get('weekly_xp')}")
        _check("profile.medals == [] (fresh user)",
               body.get("medals") == [], str(body.get("medals")))
        _check("profile.is_flagged_cheater == false",
               body.get("is_flagged_cheater") is False,
               f"is_flagged_cheater={body.get('is_flagged_cheater')}")
        _check("profile.friend_status valid",
               body.get("friend_status") in ("friends", "self", "none",
                                              "pending_outgoing", "pending_incoming"),
               f"friend_status={body.get('friend_status')}")
        _check("profile has level + total_xp + name",
               isinstance(body.get("level"), int) and isinstance(body.get("total_xp"), int)
               and bool(body.get("name")), str(body)[:300])

    r2 = requests.get(f"{BASE}/leaderboard/profile/{uuid.uuid4()}?tz=0",
                      headers=_hdr_auth(a_tok))
    _check("GET /leaderboard/profile/<bogus> → 404", r2.status_code == 404, str(r2.status_code))


def main():
    test_boost_inventory()
    test_weekly_leaderboard()
    ctx = test_report_system()
    test_player_profile(ctx)

    print("\n" + "=" * 60)
    print(f"PASS: {len(PASS)}  FAIL: {len(FAIL)}")
    if FAIL:
        print("\nFAILURES:")
        for f in FAIL:
            print(f"  - {f}")
        sys.exit(1)
    print("\nAll tests passed.")


if __name__ == "__main__":
    main()
