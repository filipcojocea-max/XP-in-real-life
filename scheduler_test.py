"""Adaptive Work-Life Scheduler — backend test harness.

Runs against the public API base configured in /app/frontend/.env.
"""
import os
import sys
import uuid
import json
import time
import requests
from datetime import datetime, timezone

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASS = "XL98CZW5599"

DEFAULT_SHIFTS = {
    "day":   {"start_time": "06:00", "sleep_time": "22:00", "icon": "🌅", "color": "#FFA726"},
    "night": {"start_time": "14:00", "sleep_time": "06:00", "icon": "🌃", "color": "#1E3A8A"},
    "off":   {"start_time": "09:00", "sleep_time": "23:00", "icon": "☕", "color": "#22C55E"},
}

passes = 0
fails = []

def check(cond, label, extra=""):
    global passes
    if cond:
        passes += 1
        print(f"  ✅ {label}")
    else:
        fails.append(label + (" :: " + extra if extra else ""))
        print(f"  ❌ {label}  {extra}")

def jget(method, path, *, headers=None, json_body=None, params=None, expect=None):
    url = BASE + path
    r = requests.request(method, url, headers=headers or {}, json=json_body, params=params, timeout=30)
    try:
        body = r.json()
    except Exception:
        body = {"_raw": r.text[:500]}
    if expect is not None:
        check(r.status_code == expect, f"{method} {path} status={r.status_code}", extra=f"expected {expect}; body={body}")
    return r.status_code, body


def reg_user(label="Tester"):
    email = f"sched_{uuid.uuid4().hex[:8]}@gmail.com"
    payload = {"email": email, "password": "Pass1234!", "full_name": label}
    r = requests.post(BASE + "/auth/register", json=payload, timeout=30)
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text[:200]}"
    j = r.json()
    tok = j.get("token") or j.get("access_token")
    uid = (j.get("user") or {}).get("id") or j.get("user_id")
    return tok, uid, email


def login_admin():
    r = requests.post(BASE + "/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASS}, timeout=30)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text[:200]}"
    j = r.json()
    return j.get("token") or j.get("access_token")


def hdrs(tok):
    return {"Authorization": f"Bearer {tok}"}


def section(title):
    print(f"\n=== {title} ===")


def main():
    # ─────────────────── 1. Anonymous default schedule ───────────────────
    section("1. Anonymous GET /schedule → 200 with defaults")
    anon_id = f"anon-sched-{uuid.uuid4().hex}"
    sc, body = jget("GET", "/schedule", headers={"X-Anonymous-Id": anon_id}, expect=200)
    sched = body.get("schedule") or {}
    check(sched.get("enabled") is False, "default enabled=false")
    check(sched.get("pattern") == [], "default pattern=[]")
    sh = sched.get("shifts") or {}
    for k, expected in DEFAULT_SHIFTS.items():
        for f in ("start_time", "sleep_time", "icon", "color"):
            v = (sh.get(k) or {}).get(f)
            check(v == expected[f], f"shifts.{k}.{f} == {expected[f]!r}", extra=f"got {v!r}")
    check(abs(float(sched.get("refresh_offset_hours") or 0) - 2.0) < 1e-6, "refresh_offset_hours=2.0")
    check(sched.get("manual_overrides") == {}, "manual_overrides={}")

    # ─────────────────── 2. Register fresh user A and PUT enabled schedule ───────────────────
    section("2. PUT /schedule (enable + pattern + pattern_start_date)")
    tokA, uidA, emailA = reg_user("Maya Patel")
    body2 = {
        "enabled": True,
        "pattern": ["day", "day", "night", "night", "off", "off", "off", "off"],
        "pattern_start_date": "2026-05-09",
    }
    sc, b = jget("PUT", "/schedule", headers=hdrs(tokA), json_body=body2, expect=200)
    check(b.get("saved") is True, "saved=true on PUT")
    sched2 = b.get("schedule") or {}
    check(sched2.get("enabled") is True, "schedule.enabled now true")
    check(sched2.get("pattern") == body2["pattern"], "pattern reflected verbatim")
    check(sched2.get("pattern_start_date") == "2026-05-09", "pattern_start_date reflected")

    # ─────────────────── 3. Bad pattern entry ───────────────────
    section("3. PUT /schedule {pattern:['lunch']} → 400")
    jget("PUT", "/schedule", headers=hdrs(tokA), json_body={"pattern": ["lunch"]}, expect=400)

    # ─────────────────── 4. Bad colour ───────────────────
    section("4. PUT /schedule shifts.day.color=#ZZZZZZ → 400")
    jget("PUT", "/schedule", headers=hdrs(tokA), json_body={"shifts": {"day": {"color": "#ZZZZZZ"}}}, expect=400)

    # ─────────────────── 5. refresh_offset_hours too big ───────────────────
    section("5. PUT refresh_offset_hours=15 → 400")
    jget("PUT", "/schedule", headers=hdrs(tokA), json_body={"refresh_offset_hours": 15}, expect=400)

    # ─────────────────── 6. refresh_offset_hours negative ───────────────────
    section("6. PUT refresh_offset_hours=-1 → 400")
    jget("PUT", "/schedule", headers=hdrs(tokA), json_body={"refresh_offset_hours": -1}, expect=400)

    # ─────────────────── 7. Bad start_time HH:MM ───────────────────
    section("7. PUT shifts.day.start_time=25:99 → 400")
    jget("PUT", "/schedule", headers=hdrs(tokA), json_body={"shifts": {"day": {"start_time": "25:99"}}}, expect=400)

    # ─────────────────── 8. Update night icon + colour ───────────────────
    section("8. PUT shifts.night.icon='🌙', color preserved → 200")
    sc, b = jget("PUT", "/schedule", headers=hdrs(tokA), json_body={"shifts": {"night": {"icon": "🌙", "color": "#1E3A8A"}}}, expect=200)
    sched8 = b.get("schedule") or {}
    night = (sched8.get("shifts") or {}).get("night") or {}
    check(night.get("icon") == "🌙", "night.icon == 🌙", extra=f"got {night.get('icon')!r}")
    check(night.get("color") == "#1E3A8A", "night.color preserved")

    # ─────────────────── 9. Day override 2026-05-15 -> off ───────────────────
    section("9. PUT /schedule/day/2026-05-15 {shift:'off'} → 200")
    sc, b = jget("PUT", "/schedule/day/2026-05-15", headers=hdrs(tokA), json_body={"shift": "off"}, expect=200)
    overrides = b.get("manual_overrides") or {}
    check(overrides.get("2026-05-15") == "off", "manual_overrides[2026-05-15] == 'off'", extra=f"got {overrides!r}")

    # ─────────────────── 10. Clear override ───────────────────
    section("10. PUT /schedule/day/2026-05-15 {shift:null} → 200, override removed")
    sc, b = jget("PUT", "/schedule/day/2026-05-15", headers=hdrs(tokA), json_body={"shift": None}, expect=200)
    overrides = b.get("manual_overrides") or {}
    check("2026-05-15" not in overrides, "2026-05-15 absent after clearing", extra=f"got {overrides!r}")

    # ─────────────────── 11. Bad date ───────────────────
    section("11. PUT /schedule/day/foo {shift:'day'} → 400")
    jget("PUT", "/schedule/day/foo", headers=hdrs(tokA), json_body={"shift": "day"}, expect=400)

    # ─────────────────── 12. Bad shift value ───────────────────
    section("12. PUT /schedule/day/2026-05-15 {shift:'lunch'} → 400")
    jget("PUT", "/schedule/day/2026-05-15", headers=hdrs(tokA), json_body={"shift": "lunch"}, expect=400)

    # ─────────────────── 13. Re-apply override and verify preview ───────────────────
    section("13. Re-apply override + GET /schedule/preview?days=14 with from_=2026-05-09")
    jget("PUT", "/schedule/day/2026-05-15", headers=hdrs(tokA), json_body={"shift": "off"}, expect=200)
    sc, b = jget("GET", "/schedule/preview", headers=hdrs(tokA), params={"days": 14, "from_": "2026-05-09"}, expect=200)
    days = b.get("days") or []
    check(len(days) == 14, "preview length=14", extra=f"got {len(days)}")
    target = next((d for d in days if d.get("date") == "2026-05-15"), None)
    check(target is not None, "found entry for 2026-05-15")
    if target:
        check(target.get("is_override") is True, "is_override=true on 2026-05-15", extra=f"entry={target}")
        check(target.get("shift") == "off", "shift='off'")
        check(target.get("icon") == "☕", "icon='☕'", extra=f"got {target.get('icon')!r}")

    # ─────────────────── 14. Preview with no from_ → starts today UTC ───────────────────
    section("14. GET /schedule/preview?days=14 (no from_) → days[0].date == today UTC")
    sc, b = jget("GET", "/schedule/preview", headers=hdrs(tokA), params={"days": 14}, expect=200)
    days = b.get("days") or []
    today_utc = datetime.now(timezone.utc).date().isoformat()
    if days:
        check(days[0].get("date") == today_utc,
              f"days[0].date == today UTC ({today_utc})",
              extra=f"got {days[0].get('date')}")

    # ─────────────────── 15. Reset ───────────────────
    section("15. POST /schedule/reset → defaults restored")
    sc, b = jget("POST", "/schedule/reset", headers=hdrs(tokA), expect=200)
    check(b.get("saved") is True, "reset saved=true")
    sc, b = jget("GET", "/schedule", headers=hdrs(tokA), expect=200)
    sched_r = b.get("schedule") or {}
    check(sched_r.get("enabled") is False, "after reset enabled=false")
    check(sched_r.get("pattern") == [], "after reset pattern=[]")
    check(sched_r.get("manual_overrides") == {}, "after reset manual_overrides={}")
    check(abs(float(sched_r.get("refresh_offset_hours") or 0) - 2.0) < 1e-6, "after reset refresh_offset_hours=2")

    # ─────────────────── 16. Regression on common endpoints ───────────────────
    section("16. Regression: /profile (with shift_schedule), /tasks, /library/pricing, /admin/reports")
    sc, b = jget("GET", "/profile", headers=hdrs(tokA), expect=200)
    check("shift_schedule" in b, "profile.shift_schedule field present")
    jget("GET", "/tasks", headers=hdrs(tokA), expect=200)
    jget("GET", "/library/pricing", headers=hdrs(tokA), expect=200)
    admin_tok = login_admin()
    jget("GET", "/admin/reports", headers=hdrs(admin_tok), expect=200)

    # ─────────────────── 17. Per-shift edit shape ───────────────────
    section("17. Per-shift edit verbatim round-trip")
    payload = {"shifts": {"day": {"start_time": "05:30", "sleep_time": "21:30", "icon": "🌄", "color": "#F97316"}}}
    sc, b = jget("PUT", "/schedule", headers=hdrs(tokA), json_body=payload, expect=200)
    sc, b = jget("GET", "/schedule", headers=hdrs(tokA), expect=200)
    day = ((b.get("schedule") or {}).get("shifts") or {}).get("day") or {}
    check(day.get("start_time") == "05:30", "day.start_time=='05:30'", extra=f"got {day.get('start_time')!r}")
    check(day.get("sleep_time") == "21:30", "day.sleep_time=='21:30'", extra=f"got {day.get('sleep_time')!r}")
    check(day.get("icon") == "🌄", "day.icon=='🌄'", extra=f"got {day.get('icon')!r}")
    check(day.get("color") == "#F97316", "day.color=='#F97316'", extra=f"got {day.get('color')!r}")

    print(f"\n\n=========================\nPASS: {passes}    FAIL: {len(fails)}\n=========================")
    if fails:
        print("\nFailures:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)


if __name__ == "__main__":
    main()
