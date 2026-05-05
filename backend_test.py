"""
Backend tests for:
(1) GET /api/stats/monthly  — NEW
(2) GET /api/stats/by-area  — RESTORED
(3) POST /api/focus/session — NEW locked_app_seconds field with -15 XP/min penalty
(4) Quick regression smoke (profile/register/tasks/weekly).
"""
from __future__ import annotations
import json
import os
import sys
import uuid
from datetime import datetime, timezone
import requests

BASE = os.environ.get("BACKEND_BASE") or "https://xp-confidence.preview.emergentagent.com/api"

PASS = []
FAIL = []


def _log(ok: bool, msg: str, extra: str = ""):
    line = f"{'PASS' if ok else 'FAIL'}: {msg}"
    if extra and not ok:
        line += f"\n        {extra}"
    print(line)
    (PASS if ok else FAIL).append(line)


def _assert(cond: bool, msg: str, extra: str = ""):
    _log(bool(cond), msg, extra)


def _post(path, body=None, headers=None):
    r = requests.post(f"{BASE}{path}", json=(body or {}), headers=(headers or {}), timeout=30)
    return r


def _get(path, headers=None, params=None):
    r = requests.get(f"{BASE}{path}", headers=(headers or {}), params=params, timeout=30)
    return r


def register_user():
    email = f"maya.patel.{uuid.uuid4().hex[:10]}@gmail.com"
    body = {"full_name": "Maya Patel", "email": email, "password": "Sapphire!Galaxy7392"}
    r = _post("/auth/register", body)
    _assert(r.status_code == 200, "register fresh gmail user → 200",
            extra=f"status={r.status_code} body={r.text[:300]}")
    js = r.json()
    token = js.get("token") or js.get("access_token")
    user = js.get("user") or {}
    uid = user.get("id") or user.get("user_id")
    _assert(bool(token), "register returns JWT")
    _assert(bool(uid), "register returns user.id")
    return email, body["password"], token, uid


def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


# ---------- (1) stats/monthly ----------
def test_stats_monthly(token, default_tasks):
    H = auth_headers(token)
    r = _get("/stats/monthly", headers=H)
    _assert(r.status_code == 200, "GET /stats/monthly → 200",
            extra=f"status={r.status_code} body={r.text[:300]}")
    if r.status_code != 200:
        return None
    js = r.json()
    days = js.get("days")
    _assert(isinstance(days, list), "monthly.days is list")
    _assert(isinstance(days, list) and len(days) == 30,
            f"monthly.days length = 30 (got {len(days) if isinstance(days, list) else 'N/A'})")
    if not (isinstance(days, list) and len(days) == 30):
        return None

    _assert(days[0]["date"] < days[29]["date"],
            f"monthly oldest→newest (first={days[0]['date']} last={days[29]['date']})")

    required_keys = {"date", "day", "xp", "gifted_xp", "tasks"}
    all_ok = all(required_keys.issubset(set(d.keys())) for d in days)
    _assert(all_ok, "every day has {date, day, xp, gifted_xp, tasks}")

    d0 = days[0]
    is_dom = d0["day"].isdigit() and 1 <= int(d0["day"]) <= 31
    is_weekday = d0["day"] in {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
    _assert(is_dom and not is_weekday,
            f"day is day-of-month string (got '{d0['day']}'), NOT weekday")

    today_utc = datetime.now(timezone.utc).date().isoformat()
    _assert(days[29]["date"] == today_utc,
            f"days[29].date == today UTC ({today_utc}), got {days[29]['date']}")

    # complete a default task → days[29].xp increases
    today = today_utc
    target = next((t for t in default_tasks
                   if t.get("title") == "Morning reflection (5 min)"),
                  default_tasks[0] if default_tasks else None)
    _assert(target is not None, "have a default task to complete")
    if not target:
        return None
    pre_xp = days[29]["xp"]
    cr = _post(f"/tasks/{target['id']}/complete", {"date": today}, H)
    _assert(cr.status_code == 200,
            f"complete default task '{target['title']}' → 200",
            extra=f"status={cr.status_code} body={cr.text[:300]}")
    r2 = _get("/stats/monthly", headers=H)
    _assert(r2.status_code == 200, "GET /stats/monthly post-complete → 200")
    if r2.status_code == 200:
        d2 = r2.json().get("days", [])
        if len(d2) == 30:
            _assert(d2[29]["xp"] > pre_xp,
                    f"days[29].xp increased after complete (pre={pre_xp}, post={d2[29]['xp']})")
    return target


# ---------- (2) stats/by-area ----------
def test_stats_by_area(token):
    H = auth_headers(token)
    r = _get("/stats/by-area", headers=H)
    _assert(r.status_code == 200, "GET /stats/by-area → 200 (NOT 404)",
            extra=f"status={r.status_code} body={r.text[:300]}")
    if r.status_code != 200:
        return
    js = r.json()
    by_area = js.get("by_area")
    _assert(isinstance(by_area, dict), "stats/by-area returns by_area dict")
    expected = {"social", "fitness", "appearance", "mindset"}
    _assert(set(by_area.keys()) >= expected,
            f"by_area has all 4 focus areas (got {list(by_area.keys())})")
    for k in expected:
        _assert(isinstance(by_area.get(k), int), f"by_area.{k} is int")

    pre = int(by_area.get("mindset") or 0)
    today = datetime.now(timezone.utc).date().isoformat()
    tr = _get("/tasks", headers=H)
    tasks = tr.json().get("tasks", []) if tr.status_code == 200 else []
    mindset_task = None
    for t in tasks:
        if (t.get("focus_area") == "mindset" and t.get("is_default")
                and not t.get("completed")):
            mindset_task = t
            break
    _assert(mindset_task is not None, "have a mindset default task uncompleted")
    if not mindset_task:
        return
    cr = _post(f"/tasks/{mindset_task['id']}/complete", {"date": today}, H)
    _assert(cr.status_code == 200, "complete mindset task → 200",
            extra=f"status={cr.status_code} body={cr.text[:300]}")
    r2 = _get("/stats/by-area", headers=H)
    _assert(r2.status_code == 200, "GET /stats/by-area post-complete → 200")
    if r2.status_code == 200:
        post = int(r2.json().get("by_area", {}).get("mindset") or 0)
        _assert(post > pre,
                f"by_area.mindset increased (pre={pre}, post={post})")


# ---------- (3) focus/session ----------
def get_total_xp(token):
    r = _get("/profile", headers=auth_headers(token))
    if r.status_code != 200:
        return None
    return int(r.json().get("total_xp") or 0)


def run_focus(token, label, body, expected_delta, expected_reason, prev_xp):
    H = auth_headers(token)
    r = _post("/focus/session", body, H)
    if expected_delta == "400":
        _assert(r.status_code == 400, f"[{label}] returns 400",
                extra=f"status={r.status_code} body={r.text[:300]} req={json.dumps(body)}")
        return prev_xp
    if r.status_code != 200:
        _log(False, f"[{label}] expected 200 got {r.status_code}",
             extra=f"req={json.dumps(body)} resp={r.text[:300]}")
        return prev_xp
    js = r.json()
    actual_delta = int(js.get("xp_delta", -99999))
    actual_reason = js.get("reason", "")
    new_total = int((js.get("profile") or {}).get("total_xp") or 0)

    _assert(actual_delta == expected_delta,
            f"[{label}] xp_delta == {expected_delta}",
            extra=f"got xp_delta={actual_delta} reason={actual_reason} req={json.dumps(body)} resp={r.text[:400]}")
    _assert(actual_reason == expected_reason,
            f"[{label}] reason == '{expected_reason}'",
            extra=f"got reason='{actual_reason}' req={json.dumps(body)} resp={r.text[:400]}")

    expected_total = max(0, prev_xp + expected_delta)
    _assert(new_total == expected_total,
            f"[{label}] profile.total_xp = max(0, prev+delta) = {expected_total}",
            extra=f"got new_total={new_total} prev={prev_xp} delta={expected_delta}")
    _assert(new_total >= 0, f"[{label}] total_xp >= 0 (got {new_total})")

    rp = _get("/profile", headers=H)
    if rp.status_code == 200:
        pt = int(rp.json().get("total_xp") or 0)
        _assert(pt == new_total, f"[{label}] /profile re-fetch matches session resp",
                extra=f"refetch={pt} session_resp={new_total}")
    return new_total


def test_focus_session(token):
    H = auth_headers(token)
    total = get_total_xp(token)
    _assert(total is not None, "fetch starting total_xp")
    print(f"  [focus] starting total_xp = {total}")

    total = run_focus(token, "A complete clean",
                      {"planned_minutes": 25, "actual_seconds": 1500,
                       "backgrounded_seconds": 0, "locked_app_seconds": 0,
                       "completed": True, "committed_app_count": 3},
                      5, "focus_complete", total)

    total = run_focus(token, "B early-exit locked 4min",
                      {"planned_minutes": 30, "actual_seconds": 300,
                       "backgrounded_seconds": 0, "locked_app_seconds": 240,
                       "completed": False, "committed_app_count": 2},
                      -60, "focus_distracted_locked_apps", total)

    total = run_focus(token, "C complete with penalty",
                      {"planned_minutes": 60, "actual_seconds": 3600,
                       "backgrounded_seconds": 0, "locked_app_seconds": 120,
                       "completed": True, "committed_app_count": 1},
                      -18, "focus_complete_with_penalty", total)

    total = run_focus(token, "D penalty cap",
                      {"planned_minutes": 60, "actual_seconds": 3600,
                       "backgrounded_seconds": 0, "locked_app_seconds": 1320,
                       "completed": True, "committed_app_count": 1},
                      -288, "focus_complete_with_penalty", total)

    # E — legacy iOS, omit locked_app_seconds entirely
    total = run_focus(token, "E legacy iOS bg only",
                      {"planned_minutes": 30, "actual_seconds": 600,
                       "backgrounded_seconds": 120, "completed": False,
                       "committed_app_count": 1},
                      -4, "focus_distracted", total)

    # F — validation
    rF1 = _post("/focus/session",
                {"planned_minutes": 0, "actual_seconds": 0,
                 "backgrounded_seconds": 0, "locked_app_seconds": 0,
                 "completed": False, "committed_app_count": 0}, H)
    _assert(rF1.status_code == 400, "[F] planned_minutes=0 → 400",
            extra=f"status={rF1.status_code} body={rF1.text[:200]}")
    rF2 = _post("/focus/session",
                {"planned_minutes": 200, "actual_seconds": 0,
                 "backgrounded_seconds": 0, "locked_app_seconds": 0,
                 "completed": False, "committed_app_count": 0}, H)
    _assert(rF2.status_code == 400, "[F] planned_minutes=200 → 400",
            extra=f"status={rF2.status_code} body={rF2.text[:200]}")

    total = run_focus(token, "G clean cancel",
                      {"planned_minutes": 25, "actual_seconds": 30,
                       "backgrounded_seconds": 0, "locked_app_seconds": 0,
                       "completed": False, "committed_app_count": 0},
                      0, "focus_cancelled_clean", total)

    final = get_total_xp(token)
    _assert(final is not None and final >= 0,
            f"[final] total_xp >= 0 after all scenarios (got {final})")


# ---------- (4) regression smoke ----------
def test_regression():
    email = f"ryan.chen.{uuid.uuid4().hex[:10]}@gmail.com"
    rr = _post("/auth/register", {"full_name": "Ryan Chen", "email": email,
                                   "password": "Marigold!Mountain8821"})
    _assert(rr.status_code == 200, "[regression] /auth/register (gmail.com) → 200",
            extra=f"status={rr.status_code} body={rr.text[:300]}")
    if rr.status_code != 200:
        return
    js = rr.json()
    token = js.get("token") or js.get("access_token")
    _assert(bool(token), "[regression] register returns JWT")

    rp = _get("/profile", headers=auth_headers(token))
    _assert(rp.status_code == 200, "[regression] /profile via JWT → 200",
            extra=f"status={rp.status_code} body={rp.text[:200]}")

    anon_id = f"device-{uuid.uuid4().hex}"
    ra = _get("/profile", headers={"X-Anonymous-Id": anon_id})
    _assert(ra.status_code == 200, "[regression] /profile via X-Anonymous-Id → 200",
            extra=f"status={ra.status_code} body={ra.text[:200]}")

    rt = _get("/tasks", headers=auth_headers(token))
    _assert(rt.status_code == 200, "[regression] /tasks GET → 200")
    tasks = rt.json().get("tasks", []) if rt.status_code == 200 else []
    defaults = [t for t in tasks if t.get("is_default")]
    _assert(len(defaults) >= 5,
            f"[regression] /tasks returns seeded defaults (got {len(defaults)})")

    rw = _get("/stats/weekly", headers=auth_headers(token))
    _assert(rw.status_code == 200, "[regression] /stats/weekly → 200")
    if rw.status_code == 200:
        days = rw.json().get("days", [])
        _assert(len(days) == 7,
                f"[regression] /stats/weekly days length = 7 (got {len(days)})")
        if days:
            wd_ok = days[0]["day"] in {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
            _assert(wd_ok, f"[regression] weekly day is weekday (got '{days[0]['day']}')")


def main():
    print(f"==> testing against {BASE}")
    email, pw, token, uid = register_user()
    if not token:
        print("FATAL: cannot continue without token")
        sys.exit(1)
    H = auth_headers(token)

    rt = _get("/tasks", headers=H)
    tasks = rt.json().get("tasks", []) if rt.status_code == 200 else []
    default_tasks = [t for t in tasks if t.get("is_default")]
    _assert(len(default_tasks) >= 5,
            f"fresh user has seeded default tasks (got {len(default_tasks)})")

    print("\n--- (1) /stats/monthly ---")
    test_stats_monthly(token, default_tasks)

    print("\n--- (2) /stats/by-area ---")
    test_stats_by_area(token)

    print("\n--- (3) /focus/session ---")
    test_focus_session(token)

    print("\n--- (4) regression smoke ---")
    test_regression()

    print("\n" + "=" * 60)
    print(f"PASSED: {len(PASS)}")
    print(f"FAILED: {len(FAIL)}")
    if FAIL:
        print("\nFAILURES:")
        for f in FAIL:
            print(f"  - {f}")
    print("=" * 60)
    sys.exit(0 if not FAIL else 1)


if __name__ == "__main__":
    main()
