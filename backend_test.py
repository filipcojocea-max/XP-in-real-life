"""
Day Anchor System + regression test suite.
Covers:
  1. Profile schema additions (day_start_time, timezone, onboarding_tz_done)
  2. Day-anchor write lock (PUT /api/profile lock + reset)
  3. Timezone-aware GET /api/challenge/today
  4. user_today_str propagation in POST /api/sleep/checkin
  5. Challenge past 24h answer window shape + 404 path
  6. Regression: auth, /api/profile, /api/boosts/*, /api/friends/leaderboard,
     /api/leaderboard/report, /api/tasks lifecycle, /api/goals lifecycle.
"""
import os
import sys
import uuid
import json
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"

PASS = []
FAIL = []


def check(label, cond, detail=""):
    if cond:
        PASS.append(label)
        print(f"  ✅ {label}")
    else:
        FAIL.append(f"{label} :: {detail}")
        print(f"  ❌ {label} :: {detail}")


def section(t):
    print(f"\n=== {t} ===")


def H(anon_id=None, token=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    if anon_id:
        h["X-Anonymous-Id"] = anon_id
    return h


# ─────────────────────────────────────────────────────────────────────
# 1 + 2. Profile schema + day-anchor write lock (uses fresh anon id)
# ─────────────────────────────────────────────────────────────────────
section("1+2. Profile schema additions & day-anchor write lock")
anon_a = "anon-test-" + uuid.uuid4().hex[:16]

# Reset to be safe (in case the same anon id was used before)
r = requests.post(f"{BASE}/profile/reset", headers=H(anon_id=anon_a))
check("POST /profile/reset (fresh anon) → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")

r = requests.get(f"{BASE}/profile", headers=H(anon_id=anon_a))
check("GET /profile → 200", r.status_code == 200, r.text[:200])
prof = r.json() if r.ok else {}
check("profile has day_start_time field", "day_start_time" in prof,
      f"keys={list(prof.keys())[:25]}")
check("profile has timezone field", "timezone" in prof)
check("profile has onboarding_tz_done field", "onboarding_tz_done" in prof)
check("fresh: day_start_time is null", prof.get("day_start_time") is None,
      f"got {prof.get('day_start_time')!r}")
check("fresh: timezone is null", prof.get("timezone") is None,
      f"got {prof.get('timezone')!r}")
check("fresh: onboarding_tz_done is False", prof.get("onboarding_tz_done") is False,
      f"got {prof.get('onboarding_tz_done')!r}")

# First write — should succeed and lock both
r = requests.put(
    f"{BASE}/profile",
    headers=H(anon_id=anon_a),
    json={"timezone": "Australia/Sydney", "day_start_time": "07:00"},
)
check("PUT /profile {tz=Sydney, day_start=07:00} → 200", r.status_code == 200,
      f"got {r.status_code} {r.text[:200]}")
if r.ok:
    p = r.json()
    check("persisted timezone=Australia/Sydney", p.get("timezone") == "Australia/Sydney",
          f"got {p.get('timezone')!r}")
    check("persisted day_start_time=07:00", p.get("day_start_time") == "07:00",
          f"got {p.get('day_start_time')!r}")
    check("onboarding_tz_done flipped to True", p.get("onboarding_tz_done") is True,
          f"got {p.get('onboarding_tz_done')!r}")

# Lock test — change timezone
r = requests.put(
    f"{BASE}/profile",
    headers=H(anon_id=anon_a),
    json={"timezone": "Australia/Perth"},
)
check("PUT /profile {tz=Perth} on locked profile → 400", r.status_code == 400,
      f"got {r.status_code} {r.text[:200]}")
if r.status_code == 400:
    detail = (r.json() or {}).get("detail")
    if isinstance(detail, dict):
        check("error code = tz_locked", detail.get("error") == "tz_locked",
              f"got {detail!r}")
    else:
        check("error code = tz_locked", False, f"detail not a dict: {detail!r}")

# Verify timezone unchanged
r = requests.get(f"{BASE}/profile", headers=H(anon_id=anon_a))
check("timezone still Australia/Sydney", r.json().get("timezone") == "Australia/Sydney")

# Lock test — change day_start_time
r = requests.put(
    f"{BASE}/profile",
    headers=H(anon_id=anon_a),
    json={"day_start_time": "08:00"},
)
check("PUT /profile {day_start=08:00} on locked profile → 400", r.status_code == 400)
if r.status_code == 400:
    detail = (r.json() or {}).get("detail")
    if isinstance(detail, dict):
        check("error code = day_start_locked", detail.get("error") == "day_start_locked",
              f"got {detail!r}")

# Reset → fields go back to null, then PUT works again
r = requests.post(f"{BASE}/profile/reset", headers=H(anon_id=anon_a))
check("POST /profile/reset → 200", r.status_code == 200)
if r.ok:
    p = r.json()
    check("after reset: timezone is None", p.get("timezone") is None,
          f"got {p.get('timezone')!r}")
    check("after reset: day_start_time is None", p.get("day_start_time") is None,
          f"got {p.get('day_start_time')!r}")
    check("after reset: onboarding_tz_done is False", p.get("onboarding_tz_done") is False)

r = requests.put(
    f"{BASE}/profile",
    headers=H(anon_id=anon_a),
    json={"timezone": "Australia/Sydney", "day_start_time": "07:00"},
)
check("PUT after reset works again → 200", r.status_code == 200,
      f"got {r.status_code} {r.text[:200]}")

# ─────────────────────────────────────────────────────────────────────
# 3. Timezone-aware GET /api/challenge/today
# ─────────────────────────────────────────────────────────────────────
section("3. Timezone-aware GET /api/challenge/today")
r = requests.get(f"{BASE}/challenge/today", headers=H(anon_id=anon_a))
check("GET /challenge/today (Sydney/07:00) → 200", r.status_code == 200,
      f"got {r.status_code} {r.text[:300]}")
if r.ok:
    cj = r.json()
    check("response has challenge object", isinstance(cj.get("challenge"), dict),
          f"keys={list(cj.keys())}")
    ch = cj.get("challenge") or {}
    check("challenge has id+title", bool(ch.get("id")) and bool(ch.get("title")),
          f"challenge={ch}")

# ─────────────────────────────────────────────────────────────────────
# 4. user_today_str propagation in POST /api/sleep/checkin
# ─────────────────────────────────────────────────────────────────────
section("4. user_today_str propagation in /sleep/checkin")
# need to onboard sleep first
prof_now = requests.get(f"{BASE}/profile", headers=H(anon_id=anon_a)).json()
check("profile timezone still Sydney before sleep", prof_now.get("timezone") == "Australia/Sydney")

# minimal sleep onboarding (answers payload accepts any dict)
sleep_answers = {
    "main_goal": "Sleep deeper and wake refreshed",
    "bedtime": "23:00",
    "wake_time": "07:00",
    "screens_before_bed": "yes",
    "stress_level": 5,
    "noises": ["partner_snoring"],
    "habits_to_unlearn": "scrolling phone in bed",
    "relaxes_me": ["reading"],
}
r = requests.post(
    f"{BASE}/sleep/onboarding",
    headers=H(anon_id=anon_a),
    json={"answers": sleep_answers},
)
check("POST /sleep/onboarding → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")

r = requests.post(
    f"{BASE}/sleep/checkin",
    headers=H(anon_id=anon_a),
    json={"rating": 7, "hours": 7.5, "notes": "Felt rested"},
)
check("POST /sleep/checkin → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
if r.ok:
    entry = r.json().get("entry") or {}
    # Compute expected user_today_str: Australia/Sydney, day_start=07:00
    tz = ZoneInfo("Australia/Sydney")
    local_now = datetime.now(tz)
    if (local_now.hour, local_now.minute) < (7, 0):
        local_now = local_now - timedelta(days=1)
    expected_date = local_now.date().isoformat()
    check(f"entry.date matches user_today_str (expected {expected_date})",
          entry.get("date") == expected_date,
          f"got {entry.get('date')!r}, expected {expected_date}")
    # Verify it's NOT just UTC date — only meaningful when they differ
    utc_today = datetime.utcnow().date().isoformat()
    if expected_date != utc_today:
        check("entry.date != UTC today (proves tz-aware)",
              entry.get("date") != utc_today,
              f"got {entry.get('date')!r}, UTC today={utc_today}")
    else:
        print(f"  ℹ️  Sydney local date == UTC today ({expected_date}); tz-aware check is degenerate now.")

# ─────────────────────────────────────────────────────────────────────
# 5. Challenge past 24h answer window
# ─────────────────────────────────────────────────────────────────────
section("5. Challenge past 24h answer window")
r = requests.get(f"{BASE}/challenge/past", headers=H(anon_id=anon_a))
check("GET /challenge/past → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
if r.ok:
    payload = r.json()
    completions = payload.get("completions", [])
    check("response has completions array", isinstance(completions, list),
          f"got {type(completions)}")
    # No completions yet for a fresh user, but if any: verify shape
    if completions:
        for c in completions[:3]:
            check(f"entry has can_answer:bool", isinstance(c.get("can_answer"), bool),
                  f"got {type(c.get('can_answer'))}")
            check(f"entry has answer_deadline (str or None)",
                  c.get("answer_deadline") is None or isinstance(c.get("answer_deadline"), str),
                  f"got {type(c.get('answer_deadline'))}")
    else:
        # Just verify the endpoint shape is consistent (no completions = OK)
        print(f"  ℹ️  No past completions to inspect (fresh user).")

# Force a past entry: complete a challenge and verify the shape persists.
# (We don't expect can_answer=True since it's not auto_uncompleted.)
r = requests.post(f"{BASE}/challenge/accept", headers=H(anon_id=anon_a))
check("POST /challenge/accept → 200", r.status_code == 200, r.text[:200])
r = requests.post(
    f"{BASE}/challenge/complete",
    headers=H(anon_id=anon_a),
    json={"how_text": "did it", "difficulty": "easy", "experience_text": "great", "rating": 5},
)
check("POST /challenge/complete → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")

r = requests.get(f"{BASE}/challenge/past", headers=H(anon_id=anon_a))
if r.ok:
    completions = r.json().get("completions", [])
    if completions:
        c0 = completions[0]
        check("most recent past has can_answer:bool", isinstance(c0.get("can_answer"), bool),
              f"got {type(c0.get('can_answer'))} {c0.get('can_answer')!r}")
        check("most recent past has answer_deadline field",
              "answer_deadline" in c0,
              f"keys={list(c0.keys())[:15]}")
        check("freshly-completed challenge has can_answer=False",
              c0.get("can_answer") is False,
              f"got {c0.get('can_answer')!r}")

# 404 path
fake_id = "non-existent-completion-" + uuid.uuid4().hex[:8]
r = requests.post(
    f"{BASE}/challenge/past/{fake_id}/answer",
    headers=H(anon_id=anon_a),
    json={"completed": True, "difficulty": "easy", "rating": 5},
)
check("POST /challenge/past/{fake}/answer → 404", r.status_code == 404,
      f"got {r.status_code} {r.text[:200]}")

# ─────────────────────────────────────────────────────────────────────
# 6. Regressions
# ─────────────────────────────────────────────────────────────────────
section("6. REGRESSION: /api/auth/register + login")
email = f"day.anchor.{uuid.uuid4().hex[:10]}@protonmail.com"
pw = "AnchorTest123!"
r = requests.post(
    f"{BASE}/auth/register",
    headers={"Content-Type": "application/json"},
    json={"full_name": "Day Anchor Tester", "email": email, "password": pw},
)
check("POST /auth/register → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
token = None
if r.ok:
    rj = r.json()
    token = rj.get("token")
    check("register returns token (verification disabled)", isinstance(token, str) and len(token) > 20)
    user_obj = rj.get("user") or {}
    check("register user.verified=true", bool(user_obj.get("verified")))

# Auth-me with token
r = requests.get(f"{BASE}/auth/me", headers={"Authorization": f"Bearer {token}"})
check("GET /auth/me → 200", r.status_code == 200, f"got {r.status_code}")

# Login
r = requests.post(
    f"{BASE}/auth/login",
    headers={"Content-Type": "application/json"},
    json={"email": email, "password": pw},
)
check("POST /auth/login → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
if r.ok:
    token = r.json().get("token")

# Wrong password
r = requests.post(
    f"{BASE}/auth/login",
    headers={"Content-Type": "application/json"},
    json={"email": email, "password": "WrongPass!"},
)
check("POST /auth/login wrong pw → 401", r.status_code == 401, f"got {r.status_code}")

section("6. REGRESSION: /api/profile GET (with auth)")
r = requests.get(f"{BASE}/profile", headers=H(token=token))
check("GET /profile (auth) → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
if r.ok:
    p = r.json()
    check("auth profile has day_start_time field", "day_start_time" in p)
    check("auth profile has timezone field", "timezone" in p)
    check("auth profile has onboarding_tz_done field", "onboarding_tz_done" in p)

section("6. REGRESSION: /api/boosts/*")
# Unlock with code
r = requests.post(f"{BASE}/boosts/unlock", headers=H(token=token), json={"code": "XP270905W20"})
check("POST /boosts/unlock (correct code) → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")

# Status
r = requests.get(f"{BASE}/boosts/status", headers=H(token=token))
check("GET /boosts/status → 200", r.status_code == 200)
if r.ok:
    s = r.json()
    check("status has boosts_unlocked=true", s.get("boosts_unlocked") is True,
          f"got {s.get('boosts_unlocked')!r}")
    check("status has boost_inventory list", isinstance(s.get("boost_inventory"), list))

# Claim
r = requests.post(f"{BASE}/boosts/claim", headers=H(token=token), json={"type": "triple_day"})
check("POST /boosts/claim triple_day → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
inv_id = None
if r.ok:
    claimed = r.json().get("claimed") or {}
    inv_id = claimed.get("id")
    check("claimed has id", isinstance(inv_id, str) and len(inv_id) > 5)

# Activate
if inv_id:
    r = requests.post(f"{BASE}/boosts/activate", headers=H(token=token), json={"inventory_id": inv_id})
    check("POST /boosts/activate {inventory_id} → 200", r.status_code == 200,
          f"got {r.status_code} {r.text[:200]}")
    if r.ok:
        ab = r.json().get("active_boost") or {}
        check("active_boost.multiplier=3", ab.get("multiplier") == 3, f"got {ab}")

section("6. REGRESSION: /api/friends/leaderboard")
r = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=H(token=token))
check("GET /friends/leaderboard?tz=0 → 200", r.status_code == 200,
      f"got {r.status_code} {r.text[:200]}")
if r.ok:
    lb = r.json()
    check("leaderboard has rows[]", isinstance(lb.get("rows"), list))
    check("leaderboard has reports[]", isinstance(lb.get("reports"), list))
    check("leaderboard has week_key", isinstance(lb.get("week_key"), str))
    rows = lb.get("rows") or []
    self_rows = [r0 for r0 in rows if r0.get("is_self")]
    check("self row present", len(self_rows) == 1, f"got {len(self_rows)}")

section("6. REGRESSION: /api/leaderboard/report (self-report should 400)")
my_id = (r.json().get("rows") or [{}])[0].get("user_id") if r.ok else None
if my_id:
    r2 = requests.post(
        f"{BASE}/leaderboard/report",
        headers=H(token=token),
        json={"reported_user_id": my_id, "reason": "self-report attempt"},
    )
    check("POST /leaderboard/report (self) → 400", r2.status_code == 400,
          f"got {r2.status_code} {r2.text[:200]}")

section("6. REGRESSION: /api/tasks lifecycle (create, complete, uncomplete with ?date=)")
# Create custom task
r = requests.post(
    f"{BASE}/tasks",
    headers=H(token=token),
    json={
        "title": "Day Anchor Smoke Task",
        "description": "regression",
        "focus_area": "mindset",
        "time_slot": "morning",
        "xp_value": 15,
        "scheduled_time": "08:00",
        "reminder_enabled": False,
    },
)
check("POST /tasks (custom) → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
task_id = None
if r.ok:
    tj = r.json()
    task_id = tj.get("id")
    check("custom task xp_value capped/kept at 15", tj.get("xp_value") == 15, f"got {tj.get('xp_value')}")

# Get profile XP before
prof_before = requests.get(f"{BASE}/profile", headers=H(token=token)).json()
xp_before = int(prof_before.get("total_xp", 0))

# Complete with explicit date (today UTC)
today_iso = datetime.utcnow().date().isoformat()
if task_id:
    r = requests.post(
        f"{BASE}/tasks/{task_id}/complete",
        headers=H(token=token),
        json={"date": today_iso},
    )
    check("POST /tasks/{id}/complete (?date=today) → 200", r.status_code == 200,
          f"got {r.status_code} {r.text[:200]}")
    if r.ok:
        cj = r.json()
        # active boost (3x) is on this account, so awarded should be 45
        awarded = int(cj.get("xp_awarded", 0))
        check("complete returned xp_awarded > 0", awarded > 0, f"got {awarded}")

    # Uncomplete with ?date= via body
    r = requests.post(
        f"{BASE}/tasks/{task_id}/uncomplete",
        headers=H(token=token),
        json={"date": today_iso},
    )
    check("POST /tasks/{id}/uncomplete (?date=today) → 200", r.status_code == 200,
          f"got {r.status_code} {r.text[:200]}")
    if r.ok:
        uj = r.json()
        check("uncomplete returns xp_removed", "xp_removed" in uj,
              f"got keys={list(uj.keys())}")
        prof_after = requests.get(f"{BASE}/profile", headers=H(token=token)).json()
        check("XP rolled back", int(prof_after.get("total_xp", 0)) == xp_before,
              f"before={xp_before} after={prof_after.get('total_xp')}")

section("6. REGRESSION: /api/goals lifecycle")
# Create goal
r = requests.post(
    f"{BASE}/goals",
    headers=H(token=token),
    json={
        "title": "Anchor Goal Smoke",
        "description": "regression",
        "focus_area": "fitness",
        "target_value": 30,
        "unit": "days",
        "xp_reward": 30,
    },
)
check("POST /goals → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
goal_id = None
if r.ok:
    gj = r.json()
    goal_id = gj.get("id")
    check("goal xp_reward clamped to 30", gj.get("xp_reward") == 30, f"got {gj.get('xp_reward')}")

# List
r = requests.get(f"{BASE}/goals", headers=H(token=token))
check("GET /goals → 200", r.status_code == 200)
if r.ok:
    gs = r.json().get("goals") or []
    found = next((g for g in gs if g.get("id") == goal_id), None)
    check("created goal in list", bool(found))

# Update goal
if goal_id:
    r = requests.put(
        f"{BASE}/goals/{goal_id}",
        headers=H(token=token),
        json={"title": "Anchor Goal Smoke (updated)"},
    )
    check("PUT /goals/{id} → 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")

# Progress tick
if goal_id:
    r = requests.post(
        f"{BASE}/goals/{goal_id}/progress",
        headers=H(token=token),
        json={"current_value": 1},
    )
    check("POST /goals/{id}/progress (1/30) → 200", r.status_code == 200,
          f"got {r.status_code} {r.text[:200]}")

# Delete
if goal_id:
    r = requests.delete(f"{BASE}/goals/{goal_id}", headers=H(token=token))
    check("DELETE /goals/{id} → 200", r.status_code in (200, 204),
          f"got {r.status_code} {r.text[:200]}")

# ─────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────
print("\n" + "=" * 60)
print(f"PASSED: {len(PASS)}")
print(f"FAILED: {len(FAIL)}")
if FAIL:
    print("\nFAILURES:")
    for f in FAIL:
        print(f"  - {f}")
sys.exit(0 if not FAIL else 1)
