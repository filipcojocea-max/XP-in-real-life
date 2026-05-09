"""Tests for the new `silence_state` field exposed on multiplayer player
payloads (Spot — Adaptive Work-Life Scheduler integration).

Backend under test: https://xp-confidence.preview.emergentagent.com/api
"""
import os
import sys
import time
import uuid
import requests
from typing import Optional

BASE = os.environ.get("BACKEND_BASE_URL", "https://xp-confidence.preview.emergentagent.com/api")
TIMEOUT = 30

PASS = 0
FAIL = 0
FAILURES = []


def _log(ok: bool, name: str, detail: str = ""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        FAILURES.append((name, detail))
        print(f"  ❌ {name}: {detail}")


def assert_true(cond: bool, name: str, detail: str = ""):
    _log(bool(cond), name, detail)
    return bool(cond)


def http(method: str, path: str, *, token: Optional[str] = None, anon: Optional[str] = None, json=None, params=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if anon:
        headers["X-Anonymous-Id"] = anon
    url = f"{BASE}{path}"
    r = requests.request(method, url, headers=headers, json=json, params=params, timeout=TIMEOUT)
    return r


def register_fresh_user(prefix="test"):
    uniq = uuid.uuid4().hex[:8]
    email = f"{prefix}.{uniq}@gmail.com"
    pwd = "Pwd!" + uuid.uuid4().hex[:10]
    full_name = f"{prefix.title()} {uniq[:4].upper()}"
    r = http("POST", "/auth/register", json={
        "email": email, "password": pwd, "full_name": full_name
    })
    if r.status_code != 200:
        raise RuntimeError(f"register failed {r.status_code}: {r.text}")
    body = r.json()
    return {
        "email": email,
        "password": pwd,
        "full_name": full_name,
        "token": body["token"],
        "user_id": body["user"]["id"],
    }


def login_admin():
    r = http("POST", "/auth/login", json={
        "email": "filip.cojocea122@gmail.com",
        "password": "XL98CZW5599",
    })
    if r.status_code != 200:
        raise RuntimeError(f"admin login failed {r.status_code}: {r.text}")
    body = r.json()
    return body["token"], body["user"]["id"]


# Day shift sleeping 22:00→06:00, plus 7-day all-day pattern
DAY_SHIFT_BODY = {
    "enabled": True,
    "pattern": ["day", "day", "day", "day", "day", "off", "off"],
    "pattern_kind": "weekly",
    "pattern_start_date": "2026-05-04",
    "shifts": {
        "day":   {"start_time": "06:00", "sleep_time": "22:00", "icon": "🌅", "color": "#FFA726"},
        "night": {"start_time": "14:00", "sleep_time": "06:00", "icon": "🌃", "color": "#1E3A8A"},
        "off":   {"start_time": "09:00", "sleep_time": "23:00", "icon": "☕", "color": "#22C55E"},
    },
    "setup_complete": True,
}

NIGHT_SHIFT_BODY = {
    "enabled": True,
    "pattern": ["night", "night", "night", "night", "night", "off", "off"],
    "pattern_kind": "weekly",
    "pattern_start_date": "2026-05-04",
    "shifts": {
        "day":   {"start_time": "06:00", "sleep_time": "22:00", "icon": "🌅", "color": "#FFA726"},
        "night": {"start_time": "14:00", "sleep_time": "06:00", "icon": "🌃", "color": "#1E3A8A"},
        "off":   {"start_time": "09:00", "sleep_time": "23:00", "icon": "☕", "color": "#22C55E"},
    },
    "setup_complete": True,
}

OFF_BODY = {
    "enabled": True,
    "pattern": ["off"],
    "pattern_kind": "weekly",
    "pattern_start_date": "2026-05-04",
    "shifts": {
        "day":   {"start_time": "06:00", "sleep_time": "22:00", "icon": "🌅", "color": "#FFA726"},
        "night": {"start_time": "14:00", "sleep_time": "06:00", "icon": "🌃", "color": "#1E3A8A"},
        # The "off" shift sleeps 00:00→00:01 → in_silence=true at all
        # times of day, so we can deterministically assert label even
        # without controlling the wall clock.
        "off":   {"start_time": "00:01", "sleep_time": "00:00", "icon": "☕", "color": "#22C55E"},
    },
    "setup_complete": True,
}


def find_in_players(token: str, q: str, target_user_id: str):
    r = http("GET", "/friends/players", token=token, params={"q": q})
    if r.status_code != 200:
        return None, r
    players = r.json().get("players", [])
    for p in players:
        if p.get("user_id") == target_user_id:
            return p, r
    return None, r


# ════════════════════════════════════════════════════════════════════════
# 1) Server boot regression — backend healthy + scheduler running
# ════════════════════════════════════════════════════════════════════════
def test_boot_regression():
    print("\n[1] SERVER BOOT REGRESSION")
    r = http("GET", "/profile", anon=f"smoke-{uuid.uuid4().hex[:8]}")
    assert_true(r.status_code == 200, "GET /profile (anon) → 200", f"{r.status_code} {r.text[:200]}")
    # admin scheduler/status should show 4 jobs
    admin_token, _ = login_admin()
    r2 = http("GET", "/admin/scheduler/status", token=admin_token)
    if assert_true(r2.status_code == 200, "GET /admin/scheduler/status → 200", f"{r2.status_code} {r2.text[:200]}"):
        body = r2.json()
        jobs = body.get("jobs", [])
        ids = {j.get("id") for j in jobs}
        assert_true(len(jobs) >= 4, f"scheduler has ≥4 jobs (got {len(jobs)}: {sorted(ids)})", str(ids))
        for jid in ("_motivation_tick", "_spot_surprise_tick", "_streak_warning_tick", "_match_invite_expiry_tick"):
            assert_true(jid in ids, f"scheduler job '{jid}' present", str(ids))
        assert_true(bool(body.get("running")), "scheduler.running=True")


# ════════════════════════════════════════════════════════════════════════
# 2) DEFAULT USER (no schedule enabled) → silence_state OMITTED
# ════════════════════════════════════════════════════════════════════════
def test_default_user_silence_state_omitted():
    print("\n[2] DEFAULT USER — silence_state OMITTED")
    ua = register_fresh_user("ua_default")
    ub = register_fresh_user("ub_observer")

    # 2a. UA's profile shows scheduler disabled by default.
    r = http("GET", "/schedule", token=ua["token"])
    assert_true(r.status_code == 200, "GET /schedule → 200", f"{r.status_code} {r.text[:200]}")
    body = r.json()
    sched = body.get("schedule") or body
    assert_true(sched.get("enabled") is False, "default schedule.enabled is False", str(sched))

    # 2b. UB searches /friends/players for UA — silence_state must NOT
    # appear on UA's player payload.
    p, r = find_in_players(ub["token"], ua["full_name"].split()[0], ua["user_id"])
    assert_true(p is not None, "UA found via /friends/players from UB",
                f"http={r.status_code} body={r.text[:200]}")
    if p is not None:
        assert_true("silence_state" not in p,
                    "silence_state KEY OMITTED on default-user player row",
                    f"keys={sorted(p.keys())}")

        # 2c. Backwards-compat: legacy player fields still present.
        for key in ("user_id", "name", "level", "total_xp", "current_streak",
                    "friend_status", "is_admin", "is_admin_view"):
            assert_true(key in p, f"backwards-compat: '{key}' on player row",
                        f"missing — keys={sorted(p.keys())}")

    return ua, ub


# ════════════════════════════════════════════════════════════════════════
# 3) ENABLE schedule → silence_state PRESENT with correct shape
# ════════════════════════════════════════════════════════════════════════
def test_enabled_schedule_silence_state_shape(ua, ub):
    print("\n[3] SCHEDULE ENABLED — silence_state PRESENT with valid shape")
    r = http("PUT", "/schedule", token=ua["token"], json=DAY_SHIFT_BODY)
    assert_true(r.status_code == 200, "PUT /schedule {day-shift, enabled:true} → 200",
                f"{r.status_code} {r.text[:300]}")

    p, r = find_in_players(ub["token"], ua["full_name"].split()[0], ua["user_id"])
    assert_true(p is not None, "UA still found via /friends/players from UB",
                f"http={r.status_code}")
    if p is not None:
        assert_true("silence_state" in p,
                    "silence_state KEY PRESENT now that scheduler is enabled",
                    f"keys={sorted(p.keys())}")
        ss = p.get("silence_state") or {}
        # shape
        for key in ("in_silence", "shift", "label"):
            assert_true(key in ss, f"silence_state.{key} present", f"silence_state={ss}")
        assert_true(isinstance(ss.get("in_silence"), bool),
                    "silence_state.in_silence is bool", str(type(ss.get("in_silence"))))
        assert_true(ss.get("shift") in ("day", "night", "off", None),
                    "silence_state.shift in {day,night,off,None}",
                    f"got={ss.get('shift')!r}")
        # label rule
        if ss.get("in_silence"):
            assert_true(isinstance(ss.get("label"), str) and ss["label"],
                        "in_silence=true → label is non-empty string",
                        f"label={ss.get('label')!r}")
            shift = ss.get("shift")
            expected = {
                "night": "Sleeping (Night Shift Schedule)",
                "day":   "Resting (Day Shift Schedule)",
                "off":   "Resting (Day Off Schedule)",
            }.get(shift)
            if expected is not None:
                assert_true(ss.get("label") == expected,
                            f"label matches spec for shift={shift!r}",
                            f"got={ss.get('label')!r}, expected={expected!r}")
        else:
            assert_true(ss.get("label") is None,
                        "in_silence=false → label is null",
                        f"label={ss.get('label')!r}")


# ════════════════════════════════════════════════════════════════════════
# 4) Force in_silence=true via the always-sleeping "off" shift (00:00→00:01)
# ════════════════════════════════════════════════════════════════════════
def test_force_in_silence_label():
    print("\n[4] FORCED in_silence=true label assertions (off-shift always-sleeping)")
    ua = register_fresh_user("ua_off")
    ub = register_fresh_user("ub_obs2")
    r = http("PUT", "/schedule", token=ua["token"], json=OFF_BODY)
    assert_true(r.status_code == 200, "PUT /schedule {off-shift always-sleeping} → 200",
                f"{r.status_code} {r.text[:300]}")
    p, r = find_in_players(ub["token"], ua["full_name"].split()[0], ua["user_id"])
    assert_true(p is not None and "silence_state" in (p or {}),
                "silence_state present on off-shift always-sleeping user",
                f"row={p}")
    if p and "silence_state" in p:
        ss = p["silence_state"]
        assert_true(ss.get("in_silence") is True,
                    "silence_state.in_silence is True for always-sleeping off-shift",
                    f"silence_state={ss}")
        assert_true(ss.get("shift") == "off",
                    "silence_state.shift == 'off'", f"silence_state={ss}")
        assert_true(ss.get("label") == "Resting (Day Off Schedule)",
                    "label == 'Resting (Day Off Schedule)'",
                    f"got={ss.get('label')!r}")


# ════════════════════════════════════════════════════════════════════════
# 5) FRIENDS-LIST scenario: silence_state on accepted-friend rows
# ════════════════════════════════════════════════════════════════════════
def test_friends_list_silence_state():
    print("\n[5] /api/friends/list — silence_state on friend rows")
    ua = register_fresh_user("uafl")
    ub = register_fresh_user("ubfl")

    # UA -> UB friend request
    r = http("POST", "/friends/request", token=ua["token"], json={"user_id": ub["user_id"]})
    assert_true(r.status_code == 200, "UA POST /friends/request → 200",
                f"{r.status_code} {r.text[:200]}")
    # UB accepts
    r = http("POST", "/friends/accept", token=ub["token"], json={"user_id": ua["user_id"]})
    assert_true(r.status_code == 200, "UB POST /friends/accept → 200",
                f"{r.status_code} {r.text[:200]}")

    # 5a. UA enables schedule (day-shift) → UB GET /friends/list sees UA with silence_state
    r = http("PUT", "/schedule", token=ua["token"], json=DAY_SHIFT_BODY)
    assert_true(r.status_code == 200, "UA PUT /schedule (day-shift enabled) → 200",
                f"{r.status_code} {r.text[:300]}")

    r = http("GET", "/friends/list", token=ub["token"])
    assert_true(r.status_code == 200, "UB GET /friends/list → 200",
                f"{r.status_code} {r.text[:200]}")
    friends = r.json().get("friends", [])
    assert_true(len(friends) >= 1, "UB friends list has ≥1 friend (UA)",
                f"len={len(friends)}")
    ua_row = next((f for f in friends if f.get("user_id") == ua["user_id"]), None)
    assert_true(ua_row is not None, "UA row found in UB's /friends/list",
                f"friend ids={[f.get('user_id') for f in friends]}")
    if ua_row is not None:
        assert_true("silence_state" in ua_row,
                    "silence_state KEY PRESENT on UA's friend row (scheduler ON)",
                    f"keys={sorted(ua_row.keys())}")
        ss = ua_row.get("silence_state") or {}
        assert_true(set(ss.keys()) >= {"in_silence", "shift", "label"},
                    "silence_state has {in_silence, shift, label}",
                    f"keys={sorted(ss.keys())}")
        # backwards-compat fields preserved
        for key in ("user_id", "name", "level", "total_xp", "current_streak",
                    "friend_status", "is_admin"):
            assert_true(key in ua_row, f"backwards-compat '{key}' on friend row",
                        f"missing — keys={sorted(ua_row.keys())}")
        assert_true(ua_row.get("friend_status") == "friends",
                    "friend_status == 'friends' in friends list",
                    f"got={ua_row.get('friend_status')!r}")

    # 5b. UA toggles enabled=false → silence_state OMITTED on UB's friend row
    disable_body = dict(DAY_SHIFT_BODY)
    disable_body["enabled"] = False
    r = http("PUT", "/schedule", token=ua["token"], json=disable_body)
    assert_true(r.status_code == 200, "UA PUT /schedule {enabled:false} → 200",
                f"{r.status_code} {r.text[:300]}")

    r = http("GET", "/friends/list", token=ub["token"])
    assert_true(r.status_code == 200, "UB GET /friends/list (after disable) → 200",
                f"{r.status_code} {r.text[:200]}")
    friends = r.json().get("friends", [])
    ua_row2 = next((f for f in friends if f.get("user_id") == ua["user_id"]), None)
    assert_true(ua_row2 is not None, "UA still in UB's /friends/list after disable",
                f"ids={[f.get('user_id') for f in friends]}")
    if ua_row2 is not None:
        assert_true("silence_state" not in ua_row2,
                    "silence_state KEY OMITTED on UA's friend row (scheduler OFF)",
                    f"keys={sorted(ua_row2.keys())}")

    return ua, ub


# ════════════════════════════════════════════════════════════════════════
# 6) MATCH-INVITE creation still works (no silence-window crash)
# ════════════════════════════════════════════════════════════════════════
def test_match_invite_create(ua, ub):
    print("\n[6] /spot/match/create regression (silence-window safe)")
    # ub invites ua
    r = http("POST", "/spot/match/create", token=ub["token"],
             json={"friend_ids": [ua["user_id"]]})
    if assert_true(r.status_code == 200, "POST /spot/match/create → 200",
                   f"{r.status_code} {r.text[:300]}"):
        body = r.json()
        match = body.get("match") or {}
        assert_true(bool(match.get("id")), "match.id present", str(match)[:200])
        assert_true(match.get("status") == "waiting",
                    "match.status == 'waiting'", f"status={match.get('status')!r}")


# ════════════════════════════════════════════════════════════════════════
# 7) Schedule endpoints regression (sanity)
# ════════════════════════════════════════════════════════════════════════
def test_schedule_regression():
    print("\n[7] /api/schedule GET/PUT regression sanity")
    u = register_fresh_user("schedreg")
    r = http("GET", "/schedule", token=u["token"])
    if assert_true(r.status_code == 200, "GET /schedule → 200",
                   f"{r.status_code} {r.text[:200]}"):
        sched = r.json().get("schedule") or {}
        for key in ("enabled", "pattern", "pattern_kind", "setup_complete",
                    "shifts", "manual_overrides", "refresh_offset_hours"):
            assert_true(key in sched, f"schedule has '{key}'",
                        f"missing — keys={sorted(sched.keys())}")
    r = http("PUT", "/schedule", token=u["token"], json=DAY_SHIFT_BODY)
    if assert_true(r.status_code == 200, "PUT /schedule (full body) → 200",
                   f"{r.status_code} {r.text[:300]}"):
        sched = r.json().get("schedule") or {}
        assert_true(sched.get("enabled") is True, "round-trip enabled=True", str(sched)[:300])
        assert_true(sched.get("pattern_kind") == "weekly",
                    "round-trip pattern_kind='weekly'", str(sched)[:300])


def main():
    print(f"BASE = {BASE}")
    try:
        test_boot_regression()
        ua, ub = test_default_user_silence_state_omitted()
        test_enabled_schedule_silence_state_shape(ua, ub)
        test_force_in_silence_label()
        ua_f, ub_f = test_friends_list_silence_state()
        test_match_invite_create(ua_f, ub_f)
        test_schedule_regression()
    except Exception as e:
        import traceback
        print(f"FATAL: {e}")
        traceback.print_exc()
        global FAIL
        FAIL += 1

    print("\n" + "=" * 60)
    print(f"PASS={PASS}  FAIL={FAIL}")
    if FAILURES:
        print("\nFailures:")
        for n, d in FAILURES:
            print(f"  - {n}: {d}")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
