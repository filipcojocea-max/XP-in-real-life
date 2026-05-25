#!/usr/bin/env python3
"""
Adaptive Work-Life Scheduler — refactor regression tests
- /api/schedule (GET, PUT)
- /api/schedule/reset (POST)
- /api/schedule/day/{date_iso} (PUT)
- /api/schedule/preview (GET)
NEW: pattern_kind ('weekly'|'rotating'), setup_complete (bool),
preview cap raised 60→200.
"""
import os, sys, time, uuid, json, random, string
import requests
from datetime import datetime, timezone, timedelta

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASS = "XL98CZW5599"

OK = []
FAIL = []

def assert_eq(name, got, expected):
    if got == expected:
        OK.append(name); print(f"  ✅ {name}")
    else:
        FAIL.append(f"{name}: expected {expected!r} got {got!r}")
        print(f"  ❌ {name}: expected {expected!r} got {got!r}")

def assert_true(name, cond, detail=""):
    if cond:
        OK.append(name); print(f"  ✅ {name}")
    else:
        FAIL.append(f"{name}: {detail}")
        print(f"  ❌ {name}: {detail}")

def rand_email():
    return f"sched_{uuid.uuid4().hex[:10]}@gmail.com"

def register_user():
    email = rand_email()
    pw = "TestPwd_" + uuid.uuid4().hex[:8] + "!1A"
    r = requests.post(f"{BASE}/auth/register", json={
        "email": email,
        "password": pw,
        "full_name": "Sched Tester " + uuid.uuid4().hex[:4],
    }, timeout=30)
    if r.status_code != 200:
        raise SystemExit(f"register failed: {r.status_code} {r.text}")
    j = r.json()
    return j.get("token") or j.get("access_token"), email, pw

def admin_login():
    r = requests.post(f"{BASE}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASS}, timeout=30)
    if r.status_code != 200:
        raise SystemExit(f"admin login failed: {r.status_code} {r.text}")
    return r.json().get("token") or r.json().get("access_token")

def H(token, anon=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    if anon:
        h["X-Anonymous-Id"] = anon
    return h

def get(path, token=None, anon=None):
    return requests.get(f"{BASE}{path}", headers=H(token, anon), timeout=30)

def put(path, body, token=None, anon=None):
    return requests.put(f"{BASE}{path}", headers=H(token, anon), data=json.dumps(body), timeout=30)

def post(path, body, token=None, anon=None):
    return requests.post(f"{BASE}{path}", headers=H(token, anon), data=json.dumps(body), timeout=30)

def main():
    print(f"\nBASE = {BASE}\n")

    # Use a fresh user so we get truly default state
    token, email, pw = register_user()
    print(f"Registered fresh user: {email}\n")

    # ─────────────────────────────────────────────────────────────────
    # 1) Defaults — fresh GET /schedule
    # ─────────────────────────────────────────────────────────────────
    print("[1] Default GET /schedule shape")
    r = get("/schedule", token=token)
    assert_eq("GET /schedule status", r.status_code, 200)
    sched = r.json().get("schedule", {})
    assert_eq("default enabled", sched.get("enabled"), False)
    assert_eq("default pattern_kind", sched.get("pattern_kind"), "rotating")
    assert_eq("default setup_complete", sched.get("setup_complete"), False)
    assert_eq("default pattern", sched.get("pattern"), [])
    today_iso = datetime.utcnow().date().isoformat()
    assert_eq("default pattern_start_date == today UTC", sched.get("pattern_start_date"), today_iso)
    assert_eq("default refresh_offset_hours", float(sched.get("refresh_offset_hours")), 2.0)
    assert_eq("default manual_overrides", sched.get("manual_overrides"), {})
    shifts = sched.get("shifts") or {}
    assert_true("shifts has all 3 keys", set(shifts.keys()) == {"day", "night", "off"},
                f"got keys={list(shifts.keys())}")
    # Verify each shift has the expected default keys + values
    expected = {
        "day":   {"start_time": "06:00", "sleep_time": "22:00", "icon": "🌅", "color": "#FFA726"},
        "night": {"start_time": "14:00", "sleep_time": "06:00", "icon": "🌃", "color": "#1E3A8A"},
        "off":   {"start_time": "09:00", "sleep_time": "23:00", "icon": "☕", "color": "#22C55E"},
    }
    for k, exp in expected.items():
        for fld, v in exp.items():
            assert_eq(f"shifts.{k}.{fld}", shifts.get(k, {}).get(fld), v)

    # ─────────────────────────────────────────────────────────────────
    # 2) NEW: pattern_kind round-trip and validation
    # ─────────────────────────────────────────────────────────────────
    print("\n[2] pattern_kind round-trip + validation")
    r = put("/schedule", {"pattern_kind": "weekly"}, token=token)
    assert_eq("PUT pattern_kind=weekly status", r.status_code, 200)
    assert_eq("PUT pattern_kind=weekly response.pattern_kind", r.json()["schedule"]["pattern_kind"], "weekly")

    r = get("/schedule", token=token)
    assert_eq("GET after weekly pattern_kind", r.json()["schedule"]["pattern_kind"], "weekly")

    r = put("/schedule", {"pattern_kind": "rotating"}, token=token)
    assert_eq("PUT pattern_kind=rotating status", r.status_code, 200)
    assert_eq("PUT pattern_kind=rotating response", r.json()["schedule"]["pattern_kind"], "rotating")

    r = put("/schedule", {"pattern_kind": "invalid_kind"}, token=token)
    assert_eq("PUT pattern_kind=invalid_kind status", r.status_code, 400)
    detail = (r.json().get("detail") or "").lower()
    assert_true("400 detail mentions weekly/rotating",
                "weekly" in detail and "rotating" in detail,
                f"detail={detail!r}")

    r = put("/schedule", {"pattern_kind": ""}, token=token)
    assert_eq("PUT pattern_kind='' status", r.status_code, 400)

    # Verify post-rejection state still 'rotating' (no partial write)
    r = get("/schedule", token=token)
    assert_eq("post-rejection still rotating", r.json()["schedule"]["pattern_kind"], "rotating")

    # ─────────────────────────────────────────────────────────────────
    # 3) NEW: setup_complete round-trip
    # ─────────────────────────────────────────────────────────────────
    print("\n[3] setup_complete round-trip")
    r = put("/schedule", {"setup_complete": True}, token=token)
    assert_eq("PUT setup_complete=true status", r.status_code, 200)
    assert_eq("PUT setup_complete=true response", r.json()["schedule"]["setup_complete"], True)

    r = get("/schedule", token=token)
    assert_eq("GET after setup_complete=true", r.json()["schedule"]["setup_complete"], True)

    r = put("/schedule", {"setup_complete": False}, token=token)
    assert_eq("PUT setup_complete=false status", r.status_code, 200)
    assert_eq("PUT setup_complete=false response", r.json()["schedule"]["setup_complete"], False)

    # ─────────────────────────────────────────────────────────────────
    # 4) NEW: combined PUT — multi-field round-trip
    # ─────────────────────────────────────────────────────────────────
    print("\n[4] Combined multi-field PUT round-trip")
    combined = {
        "pattern_kind": "weekly",
        "pattern": ["day", "day", "off", "off", "day", "day", "off"],
        "pattern_start_date": "2026-05-04",
        "setup_complete": True,
        "enabled": True,
    }
    r = put("/schedule", combined, token=token)
    assert_eq("combined PUT status", r.status_code, 200)
    s = r.json()["schedule"]
    assert_eq("combined.pattern_kind", s["pattern_kind"], "weekly")
    assert_eq("combined.pattern", s["pattern"], ["day", "day", "off", "off", "day", "day", "off"])
    assert_eq("combined.pattern_start_date", s["pattern_start_date"], "2026-05-04")
    assert_eq("combined.setup_complete", s["setup_complete"], True)
    assert_eq("combined.enabled", s["enabled"], True)

    # Round-trip via GET
    r = get("/schedule", token=token)
    s2 = r.json()["schedule"]
    assert_eq("GET combined.pattern_kind", s2["pattern_kind"], "weekly")
    assert_eq("GET combined.pattern", s2["pattern"], ["day", "day", "off", "off", "day", "day", "off"])
    assert_eq("GET combined.setup_complete", s2["setup_complete"], True)
    assert_eq("GET combined.enabled", s2["enabled"], True)

    # ─────────────────────────────────────────────────────────────────
    # 5) NEW: /schedule/preview days cap raised to 200
    # ─────────────────────────────────────────────────────────────────
    print("\n[5] /schedule/preview days cap = 200")
    r = get("/schedule/preview?days=14", token=token)
    assert_eq("preview days=14 status", r.status_code, 200)
    assert_eq("preview days=14 length", len(r.json()["days"]), 14)

    r = get("/schedule/preview?days=180", token=token)
    assert_eq("preview days=180 status", r.status_code, 200)
    assert_eq("preview days=180 length", len(r.json()["days"]), 180)

    r = get("/schedule/preview?days=200", token=token)
    assert_eq("preview days=200 status", r.status_code, 200)
    assert_eq("preview days=200 length", len(r.json()["days"]), 200)

    r = get("/schedule/preview?days=300", token=token)
    assert_eq("preview days=300 status", r.status_code, 200)
    assert_eq("preview days=300 capped to 200", len(r.json()["days"]), 200)

    r = get("/schedule/preview?days=1", token=token)
    assert_eq("preview days=1 length", len(r.json()["days"]), 1)

    r = get("/schedule/preview?days=0", token=token)
    # 0 should clamp to min=1
    assert_eq("preview days=0 length=1 (min clamp)", len(r.json()["days"]), 1)

    # Verify each day entry shape
    r = get("/schedule/preview?days=7", token=token)
    days = r.json()["days"]
    assert_eq("preview entry count", len(days), 7)
    expected_keys = {"date", "shift", "start_time", "sleep_time", "icon", "color", "is_override"}
    assert_true("preview entry has expected keys", set(days[0].keys()) == expected_keys,
                f"got {set(days[0].keys())}")

    # ─────────────────────────────────────────────────────────────────
    # 6) Regression — full PUT of all fields incl. shifts, refresh, overrides
    # ─────────────────────────────────────────────────────────────────
    print("\n[6] Regression PUT (shifts, refresh_offset, manual_overrides)")
    big_put = {
        "enabled": True,
        "pattern": ["day", "night", "off"],
        "pattern_start_date": "2026-05-01",
        "refresh_offset_hours": 4,
        "shifts": {
            "day":   {"start_time": "05:30", "sleep_time": "21:30", "icon": "🌄", "color": "#F97316"},
            "night": {"start_time": "13:00", "sleep_time": "05:00", "icon": "🌃", "color": "#1E3A8A"},
            "off":   {"start_time": "10:00", "sleep_time": "23:30", "icon": "☕", "color": "#22C55E"},
        },
        "manual_overrides": {"2026-05-15": "off", "2026-05-20": "night"},
    }
    r = put("/schedule", big_put, token=token)
    assert_eq("regression PUT status", r.status_code, 200)
    s = r.json()["schedule"]
    assert_eq("regression refresh_offset_hours", float(s["refresh_offset_hours"]), 4.0)
    assert_eq("regression shifts.day.start_time", s["shifts"]["day"]["start_time"], "05:30")
    assert_eq("regression shifts.day.sleep_time", s["shifts"]["day"]["sleep_time"], "21:30")
    assert_eq("regression shifts.day.icon", s["shifts"]["day"]["icon"], "🌄")
    assert_eq("regression shifts.day.color", s["shifts"]["day"]["color"], "#F97316")
    assert_eq("regression manual_overrides", s["manual_overrides"],
              {"2026-05-15": "off", "2026-05-20": "night"})

    # ─────────────────────────────────────────────────────────────────
    # 7) Day override CRUD via /schedule/day/{date}
    # ─────────────────────────────────────────────────────────────────
    print("\n[7] /schedule/day/{date} override CRUD")
    r = put("/schedule/day/2026-06-10", {"shift": "day"}, token=token)
    assert_eq("day override set status", r.status_code, 200)
    mo = r.json()["manual_overrides"]
    assert_eq("day override 2026-06-10 == day", mo.get("2026-06-10"), "day")

    r = put("/schedule/day/2026-06-10", {"shift": None}, token=token)
    assert_eq("day override clear status", r.status_code, 200)
    mo = r.json()["manual_overrides"]
    assert_true("day override 2026-06-10 removed", "2026-06-10" not in mo,
                f"still present: {mo}")

    # Validation
    r = put("/schedule/day/not-a-date", {"shift": "day"}, token=token)
    assert_eq("bad date → 400", r.status_code, 400)
    r = put("/schedule/day/2026-06-10", {"shift": "weird"}, token=token)
    assert_eq("bad shift → 400", r.status_code, 400)

    # ─────────────────────────────────────────────────────────────────
    # 8) Validation regressions
    # ─────────────────────────────────────────────────────────────────
    print("\n[8] Validation regressions")
    r = put("/schedule", {"pattern": ["day", "weird"]}, token=token)
    assert_eq("bad pattern entry → 400", r.status_code, 400)

    r = put("/schedule", {"shifts": {"day": {"color": "notacolor"}}}, token=token)
    assert_eq("bad color → 400", r.status_code, 400)

    r = put("/schedule", {"refresh_offset_hours": 15}, token=token)
    assert_eq("refresh_offset > 12 → 400", r.status_code, 400)

    r = put("/schedule", {"refresh_offset_hours": -1}, token=token)
    assert_eq("refresh_offset < 0 → 400", r.status_code, 400)

    # ─────────────────────────────────────────────────────────────────
    # 9) /schedule/reset zeroes everything (incl. new fields)
    # ─────────────────────────────────────────────────────────────────
    print("\n[9] POST /schedule/reset")
    # First make sure there's stuff to reset
    put("/schedule", {
        "pattern_kind": "weekly",
        "setup_complete": True,
        "enabled": True,
        "pattern": ["day", "off"],
        "refresh_offset_hours": 6,
        "manual_overrides": {"2026-07-01": "night"},
    }, token=token)

    r = post("/schedule/reset", {}, token=token)
    assert_eq("reset status", r.status_code, 200)
    s = r.json()["schedule"]
    assert_eq("reset enabled", s["enabled"], False)
    assert_eq("reset pattern", s["pattern"], [])
    assert_eq("reset manual_overrides", s["manual_overrides"], {})
    assert_eq("reset refresh_offset_hours", float(s["refresh_offset_hours"]), 2.0)
    assert_eq("reset pattern_kind back to rotating", s["pattern_kind"], "rotating")
    assert_eq("reset setup_complete back to false", s["setup_complete"], False)

    # Confirm via GET
    r = get("/schedule", token=token)
    s = r.json()["schedule"]
    assert_eq("post-reset GET enabled", s["enabled"], False)
    assert_eq("post-reset GET pattern_kind", s["pattern_kind"], "rotating")
    assert_eq("post-reset GET setup_complete", s["setup_complete"], False)

    # ─────────────────────────────────────────────────────────────────
    # 10) Profile endpoint regression — shift_schedule with new keys
    # ─────────────────────────────────────────────────────────────────
    print("\n[10] /api/profile exposes shift_schedule incl. new keys")
    # Set to something distinctive so we can verify round-trip via /profile
    put("/schedule", {"pattern_kind": "weekly", "setup_complete": True, "enabled": True}, token=token)
    r = get("/profile", token=token)
    assert_eq("GET /profile status", r.status_code, 200)
    pj = r.json()
    ss = pj.get("shift_schedule")
    assert_true("/profile.shift_schedule present", isinstance(ss, dict),
                f"got {type(ss).__name__}")
    assert_eq("/profile.shift_schedule.pattern_kind", ss.get("pattern_kind"), "weekly")
    assert_eq("/profile.shift_schedule.setup_complete", ss.get("setup_complete"), True)
    assert_eq("/profile.shift_schedule.enabled", ss.get("enabled"), True)

    # Reset for cleanliness
    post("/schedule/reset", {}, token=token)

    # ─────────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print(f"PASSED: {len(OK)}  FAILED: {len(FAIL)}")
    if FAIL:
        print("\n❌ Failures:")
        for f in FAIL:
            print(f"  - {f}")
        sys.exit(1)
    print("\n✅ ALL PASS")
    sys.exit(0)

if __name__ == "__main__":
    main()
