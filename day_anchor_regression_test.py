"""Day-Anchor Onboarding Hardening — Regression Test
Tests that:
1. Fresh anonymous profile is still gated (onboarding_tz_done=false; tz/day_start null).
2. PUT /profile with both fields flips onboarding_tz_done=true.
3. Lock rules still in effect (tz_locked / day_start_locked).
4. POST /profile/reset clears everything and a new PUT works again.
5. Existing legacy admin profile returns onboarding_tz_done=true with both fields.
6. tz-aware date calculations still work (challenge/today + sleep/checkin entry.date).
7. Regression sanity (auth lifecycle, profile, tasks complete/uncomplete, leaderboard).
"""
import os
import sys
import uuid
import json
import requests
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

passes = 0
fails = []


def check(label, cond, info=""):
    global passes
    if cond:
        passes += 1
        print(f"  ✅ {label}")
    else:
        fails.append(f"{label} :: {info}")
        print(f"  ❌ {label} :: {info}")


def anon_headers(aid=None):
    return {"X-Anonymous-Id": aid or f"daytest-{uuid.uuid4()}"}


def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


# ─── 1. FRESH ANON USER GATED ────────────────────────────────────────
print("\n[1] Fresh anon user — should be GATED to onboarding")
hA = anon_headers()
r = requests.get(f"{BASE}/profile", headers=hA, timeout=30)
check("GET /profile fresh → 200", r.status_code == 200, f"status={r.status_code}, body={r.text[:200]}")
prof = r.json() if r.status_code == 200 else {}
check("onboarding_tz_done == False", prof.get("onboarding_tz_done") is False,
      f"got {prof.get('onboarding_tz_done')!r}")
check("timezone is null", prof.get("timezone") in (None, ""),
      f"got {prof.get('timezone')!r}")
check("day_start_time is null", prof.get("day_start_time") in (None, ""),
      f"got {prof.get('day_start_time')!r}")


# ─── 2. PUT BOTH FIELDS → FLIP TO TRUE ──────────────────────────────
print("\n[2] PUT /profile {timezone, day_start_time} → flips onboarding_tz_done=true")
r = requests.put(f"{BASE}/profile",
                 headers={**hA, "Content-Type": "application/json"},
                 json={"timezone": "Australia/Sydney", "day_start_time": "07:00"},
                 timeout=30)
check("PUT both fields → 200", r.status_code == 200, f"status={r.status_code}, body={r.text[:300]}")
r = requests.get(f"{BASE}/profile", headers=hA, timeout=30)
prof = r.json() if r.status_code == 200 else {}
check("subsequent GET onboarding_tz_done == True",
      prof.get("onboarding_tz_done") is True,
      f"got {prof.get('onboarding_tz_done')!r}")
check("timezone == Australia/Sydney",
      prof.get("timezone") == "Australia/Sydney",
      f"got {prof.get('timezone')!r}")
check("day_start_time == 07:00",
      prof.get("day_start_time") == "07:00",
      f"got {prof.get('day_start_time')!r}")


# ─── 3. LOCK RULES STILL IN EFFECT ──────────────────────────────────
print("\n[3] Lock rules — cannot change tz/day_start once set")
r = requests.put(f"{BASE}/profile",
                 headers={**hA, "Content-Type": "application/json"},
                 json={"timezone": "Australia/Perth"},
                 timeout=30)
check("PUT {timezone:Perth} on locked → 400", r.status_code == 400,
      f"status={r.status_code}, body={r.text[:200]}")
try:
    detail = r.json().get("detail")
    if isinstance(detail, dict):
        err = detail.get("error")
    else:
        err = detail
    check("detail.error == 'tz_locked'", err == "tz_locked", f"got {err!r}")
except Exception as e:
    check("detail.error == 'tz_locked'", False, f"parse: {e}, body={r.text[:200]}")

r = requests.put(f"{BASE}/profile",
                 headers={**hA, "Content-Type": "application/json"},
                 json={"day_start_time": "08:00"},
                 timeout=30)
check("PUT {day_start_time:08:00} on locked → 400", r.status_code == 400,
      f"status={r.status_code}, body={r.text[:200]}")
try:
    detail = r.json().get("detail")
    err = detail.get("error") if isinstance(detail, dict) else detail
    check("detail.error == 'day_start_locked'", err == "day_start_locked", f"got {err!r}")
except Exception as e:
    check("detail.error == 'day_start_locked'", False, f"parse: {e}, body={r.text[:200]}")

# Confirm fields are unchanged
r = requests.get(f"{BASE}/profile", headers=hA, timeout=30)
prof = r.json() if r.status_code == 200 else {}
check("after lock attempts timezone still Sydney",
      prof.get("timezone") == "Australia/Sydney",
      f"got {prof.get('timezone')!r}")
check("after lock attempts day_start_time still 07:00",
      prof.get("day_start_time") == "07:00",
      f"got {prof.get('day_start_time')!r}")


# ─── 4. RESET CLEARS EVERYTHING ─────────────────────────────────────
print("\n[4] POST /profile/reset clears tz/day_start; new PUT works again")
r = requests.post(f"{BASE}/profile/reset", headers=hA, timeout=30)
check("POST /profile/reset → 200", r.status_code == 200,
      f"status={r.status_code}, body={r.text[:200]}")
r = requests.get(f"{BASE}/profile", headers=hA, timeout=30)
prof = r.json() if r.status_code == 200 else {}
check("after reset onboarding_tz_done == False",
      prof.get("onboarding_tz_done") is False,
      f"got {prof.get('onboarding_tz_done')!r}")
check("after reset timezone is null",
      prof.get("timezone") in (None, ""),
      f"got {prof.get('timezone')!r}")
check("after reset day_start_time is null",
      prof.get("day_start_time") in (None, ""),
      f"got {prof.get('day_start_time')!r}")

# New PUT should work again
r = requests.put(f"{BASE}/profile",
                 headers={**hA, "Content-Type": "application/json"},
                 json={"timezone": "Australia/Sydney", "day_start_time": "07:00"},
                 timeout=30)
check("re-PUT both fields after reset → 200", r.status_code == 200,
      f"status={r.status_code}, body={r.text[:200]}")
r = requests.get(f"{BASE}/profile", headers=hA, timeout=30)
prof = r.json() if r.status_code == 200 else {}
check("onboarding_tz_done back to True after re-PUT",
      prof.get("onboarding_tz_done") is True,
      f"got {prof.get('onboarding_tz_done')!r}")


# ─── 5. EXISTING LEGACY ADMIN PROFILE ───────────────────────────────
print("\n[5] Admin (legacy) login → onboarding_tz_done=true (Sydney 07:00 pre-seeded)")
r = requests.post(f"{BASE}/auth/login",
                  json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                  timeout=30)
check("admin /auth/login → 200", r.status_code == 200,
      f"status={r.status_code}, body={r.text[:200]}")
admin_token = None
if r.status_code == 200:
    body = r.json()
    admin_token = body.get("token") or body.get("access_token")
check("admin login returned a token", bool(admin_token), f"body keys: {list(r.json().keys()) if r.ok else 'n/a'}")

if admin_token:
    r = requests.get(f"{BASE}/profile", headers=auth_headers(admin_token), timeout=30)
    check("admin GET /profile → 200", r.status_code == 200,
          f"status={r.status_code}, body={r.text[:200]}")
    prof = r.json() if r.status_code == 200 else {}
    check("admin onboarding_tz_done == True (legacy backfilled)",
          prof.get("onboarding_tz_done") is True,
          f"got {prof.get('onboarding_tz_done')!r} (this is the migration target)")
    check("admin timezone == Australia/Sydney",
          prof.get("timezone") == "Australia/Sydney",
          f"got {prof.get('timezone')!r}")
    check("admin day_start_time == 07:00",
          prof.get("day_start_time") == "07:00",
          f"got {prof.get('day_start_time')!r}")
    check("admin is_admin == True",
          prof.get("is_admin") is True,
          f"got {prof.get('is_admin')!r}")


# ─── 6. TZ-AWARE DATE CALCULATIONS ──────────────────────────────────
print("\n[6] Tz-aware computations — challenge/today + sleep/checkin entry.date")
# Use a fresh anon user, set Sydney timezone, then verify
hC = anon_headers()
requests.put(f"{BASE}/profile",
             headers={**hC, "Content-Type": "application/json"},
             json={"timezone": "Australia/Sydney", "day_start_time": "07:00"},
             timeout=30)

r = requests.get(f"{BASE}/challenge/today", headers=hC, timeout=30)
check("GET /challenge/today (Sydney) → 200", r.status_code == 200,
      f"status={r.status_code}, body={r.text[:200]}")
if r.status_code == 200:
    body = r.json()
    challenge = body.get("challenge") if isinstance(body, dict) else None
    if not challenge and isinstance(body, dict):
        # Some implementations return the challenge at the top level
        challenge = body if body.get("id") or body.get("title") else None
    check("challenge object has id/title",
          bool(challenge and (challenge.get("id") or challenge.get("title"))),
          f"body={json.dumps(body)[:300]}")

# Sleep flow — onboard then checkin
# Sleep onboarding requires the 19-question payload
qs_resp = requests.get(f"{BASE}/sleep/profile", headers=hC, timeout=30)
if qs_resp.status_code == 200:
    questions = qs_resp.json().get("questions", [])
    answers = {}
    for q in questions:
        qid = q.get("id")
        qtype = q.get("type")
        if qtype == "scale":
            answers[qid] = 5
        elif qtype == "time":
            answers[qid] = "23:00"
        elif qtype == "single":
            opts = q.get("options") or []
            answers[qid] = opts[0] if opts else "yes"
        elif qtype == "multi":
            opts = q.get("options") or []
            answers[qid] = [opts[0]] if opts else []
        elif qtype == "text":
            answers[qid] = "n/a"
        else:
            answers[qid] = "n/a"
    r = requests.post(f"{BASE}/sleep/onboarding",
                      headers={**hC, "Content-Type": "application/json"},
                      json={"answers": answers},
                      timeout=120)
    check("sleep onboarding → 200", r.status_code == 200,
          f"status={r.status_code}, body={r.text[:300]}")

r = requests.post(f"{BASE}/sleep/checkin",
                  headers={**hC, "Content-Type": "application/json"},
                  json={"rating": 7, "hours": 7.5, "notes": "Slept ok"},
                  timeout=60)
check("POST /sleep/checkin → 200", r.status_code == 200,
      f"status={r.status_code}, body={r.text[:300]}")
if r.status_code == 200:
    entry = r.json().get("entry") or {}
    sydney_today = datetime.now(ZoneInfo("Australia/Sydney")).strftime("%Y-%m-%d")
    utc_today = datetime.utcnow().strftime("%Y-%m-%d")
    check("entry.date matches Sydney-local date (tz-aware, not UTC)",
          entry.get("date") == sydney_today,
          f"entry.date={entry.get('date')!r}; sydney_today={sydney_today}; utc_today={utc_today}")


# ─── 7. REGRESSION SANITY ────────────────────────────────────────────
print("\n[7] Regression sanity — auth, tasks complete/uncomplete, leaderboard")
unique = uuid.uuid4().hex[:8]
email = f"regression.{unique}@gmail.com"
password = "Test1234!Reg"

r = requests.post(f"{BASE}/auth/register",
                  json={"full_name": "Regression Tester", "email": email, "password": password},
                  timeout=30)
check("auth/register → 200", r.status_code == 200,
      f"status={r.status_code}, body={r.text[:200]}")
token = None
if r.status_code == 200:
    body = r.json()
    token = body.get("token") or body.get("access_token")
check("register returned token", bool(token))

r = requests.post(f"{BASE}/auth/login",
                  json={"email": email, "password": password},
                  timeout=30)
check("auth/login (correct creds) → 200", r.status_code == 200,
      f"status={r.status_code}")
if r.status_code == 200:
    token = r.json().get("token") or r.json().get("access_token") or token

r = requests.post(f"{BASE}/auth/login",
                  json={"email": email, "password": "WRONGPW123!"},
                  timeout=30)
check("auth/login (wrong pw) → 401", r.status_code == 401,
      f"status={r.status_code}")

r = requests.get(f"{BASE}/profile", headers=auth_headers(token), timeout=30)
check("GET /profile (auth) → 200", r.status_code == 200,
      f"status={r.status_code}")
xp_before = r.json().get("total_xp", 0) if r.status_code == 200 else 0

# Get tasks list & complete one
r = requests.get(f"{BASE}/tasks", headers=auth_headers(token), timeout=30)
tasks = r.json().get("tasks", []) if r.status_code == 200 else []
check("GET /tasks returns ≥1 default task", len(tasks) >= 1, f"len={len(tasks)}")
if tasks:
    task = tasks[0]
    today = datetime.utcnow().strftime("%Y-%m-%d")
    r = requests.post(f"{BASE}/tasks/{task['id']}/complete",
                      headers={**auth_headers(token), "Content-Type": "application/json"},
                      json={"date": today},
                      timeout=30)
    check("POST /tasks/{id}/complete → 200", r.status_code == 200,
          f"status={r.status_code}, body={r.text[:200]}")
    body = r.json() if r.status_code == 200 else {}
    xp_awarded = body.get("xp_awarded", 0)
    check("xp_awarded > 0", xp_awarded > 0, f"got {xp_awarded}")

    r = requests.post(f"{BASE}/tasks/{task['id']}/uncomplete",
                      headers={**auth_headers(token), "Content-Type": "application/json"},
                      json={"date": today},
                      timeout=30)
    check("POST /tasks/{id}/uncomplete → 200", r.status_code == 200,
          f"status={r.status_code}, body={r.text[:200]}")
    body = r.json() if r.status_code == 200 else {}
    xp_removed = body.get("xp_removed", 0)
    check("xp_removed > 0", xp_removed > 0, f"got {xp_removed}")

# Leaderboard
r = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=auth_headers(token), timeout=30)
check("GET /friends/leaderboard?tz=0 → 200", r.status_code == 200,
      f"status={r.status_code}, body={r.text[:200]}")
if r.status_code == 200:
    body = r.json()
    check("leaderboard has rows[]", isinstance(body.get("rows"), list),
          f"got {type(body.get('rows'))}")
    check("leaderboard has reports[]", isinstance(body.get("reports"), list),
          f"got {type(body.get('reports'))}")
    check("leaderboard has week_key", "week_key" in body and bool(body.get("week_key")),
          f"got {body.get('week_key')!r}")


# ─── SUMMARY ─────────────────────────────────────────────────────────
total = passes + len(fails)
print("\n" + "═" * 60)
print(f"RESULT: {passes}/{total} PASS")
if fails:
    print(f"\n{len(fails)} FAILURE(S):")
    for f in fails:
        print(f"  ❌ {f}")
    sys.exit(1)
else:
    print("All Day-Anchor regression assertions PASS ✅")
    sys.exit(0)
