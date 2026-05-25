"""
Backend test for Goal time-lock + Goal XP add/refund + green goal_xp chart segment.

Spec reference: /app/test_result.md, FIRST entry under `backend:` —
task "Goal time-lock (first tick) + Goal XP add/refund on tick/untick + goal_xp chart segment"
status_history entry with agent: main (2026-05-12).

Targets: https://xp-confidence.preview.emergentagent.com/api
Admin: filip.cojocea122@gmail.com / XL98CZW5599
"""
from __future__ import annotations

import sys
import random
import string
from datetime import datetime, timedelta, timezone

import requests

BACKEND_URL = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASS = []
FAIL = []


def record(ok: bool, label: str, detail: str = "") -> bool:
    if ok:
        PASS.append(label)
        print(f"  PASS  {label}")
    else:
        FAIL.append(f"{label} :: {detail}")
        print(f"  FAIL  {label} -- {detail}")
    return ok


def make_headers(token: str | None) -> dict:
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def random_email(seed: str = "") -> str:
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    return f"goal.tester.{seed}.{rand}@gmail.com"


def register_user(name: str, seed: str) -> tuple[str, str]:
    email = random_email(seed)
    pw = "TesterPass!2026" + "".join(random.choices(string.digits, k=4))
    r = requests.post(
        f"{BACKEND_URL}/auth/register",
        json={"email": email, "full_name": name, "password": pw},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"register failed {r.status_code}: {r.text}")
    body = r.json()
    return body["user"]["id"], body["token"]


def login(email: str, password: str) -> tuple[str, str]:
    r = requests.post(
        f"{BACKEND_URL}/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"login {email} failed {r.status_code}: {r.text}")
    body = r.json()
    return body["user"]["id"], body["token"]


def get_profile(token: str) -> dict:
    r = requests.get(f"{BACKEND_URL}/profile", headers=make_headers(token), timeout=15)
    r.raise_for_status()
    return r.json()


def total_xp_of(token: str) -> int:
    p = get_profile(token)
    return int(p.get("total_xp") or 0)


def list_goals(token: str) -> list[dict]:
    r = requests.get(f"{BACKEND_URL}/goals", headers=make_headers(token), timeout=15)
    r.raise_for_status()
    return r.json().get("goals", [])


def create_goal(token: str, title: str, target_value: int, unit: str, xp_reward: int, focus_area: str = "mindset") -> dict:
    r = requests.post(
        f"{BACKEND_URL}/goals",
        headers=make_headers(token),
        json={
            "title": title,
            "target_value": target_value,
            "unit": unit,
            "xp_reward": xp_reward,
            "focus_area": focus_area,
        },
        timeout=15,
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(f"create_goal failed {r.status_code}: {r.text}")
    return r.json()


def tick_goal(token: str, goal_id: str, current_value: int) -> requests.Response:
    return requests.post(
        f"{BACKEND_URL}/goals/{goal_id}/progress",
        headers=make_headers(token),
        json={"current_value": current_value},
        timeout=15,
    )


def main() -> int:
    print(f"\n=== Goal time-lock / XP add+refund / goal_xp chart segment test ===")
    print(f"Backend: {BACKEND_URL}\n")

    print("[setup] Admin login …")
    admin_id, admin_token = login(ADMIN_EMAIL, ADMIN_PASSWORD)
    record(bool(admin_id and admin_token), "admin login")

    print("\n[setup] Register fresh user A (gmail.com) …")
    user_a_id, user_a_token = register_user("Alex Rivera", "userA")
    record(bool(user_a_id and user_a_token), "user A registered")

    starting_xp = total_xp_of(user_a_token)
    print(f"  user A starting total_xp = {starting_xp}")

    # ============================================================
    # (1) MONTHLY goal target_value=1 → first-tick lock
    # ============================================================
    print("\n[1] MONTHLY goal target=1 first-tick lock (THE TARGET=1 BUG FIX)")
    m_goal = create_goal(user_a_token, "Read book", 1, "months", 200, "mindset")
    record("id" in m_goal, "monthly goal created with id",
           f"keys={list(m_goal.keys())}")
    record(m_goal.get("is_locked") is True, "monthly goal is_locked=true on creation",
           f"got is_locked={m_goal.get('is_locked')}")
    try:
        created_at = datetime.fromisoformat(m_goal["created_at"].replace("Z", "+00:00"))
        nta = datetime.fromisoformat(m_goal["next_tick_available_at"].replace("Z", "+00:00"))
        delta = nta - created_at
        record(abs(delta - timedelta(days=30)) < timedelta(seconds=2),
               "monthly next_tick_available_at == created_at + 30 days",
               f"delta={delta}")
    except Exception as e:
        record(False, "monthly next_tick_available_at parses & equals +30d", str(e))

    xp_before = total_xp_of(user_a_token)
    rr = tick_goal(user_a_token, m_goal["id"], 1)
    record(rr.status_code == 429, "monthly POST progress {cv:1} returns 429",
           f"got {rr.status_code}: {rr.text[:200]}")
    if rr.status_code == 429:
        body = rr.json()
        det = body.get("detail") if isinstance(body, dict) else None
        record(isinstance(det, dict) and det.get("error") == "cycle_locked",
               "monthly 429 detail.error == 'cycle_locked'", f"detail={det}")
        record(isinstance(det, dict) and bool(det.get("next_tick_available_at")),
               "monthly 429 detail.next_tick_available_at populated",
               f"got {det.get('next_tick_available_at') if isinstance(det, dict) else None}")
        record(isinstance(det, dict) and det.get("unit") == "months",
               "monthly 429 detail.unit == 'months'",
               f"got {det.get('unit') if isinstance(det, dict) else None}")
    xp_after = total_xp_of(user_a_token)
    record(xp_after == xp_before, "monthly failed tick did NOT change total_xp",
           f"before={xp_before} after={xp_after}")

    # ============================================================
    # (2) WEEKLY goal target_value=1 → first-tick lock (7d)
    # ============================================================
    print("\n[2] WEEKLY goal target=1 first-tick lock (7d from created_at)")
    w_goal = create_goal(user_a_token, "Weekly walk", 1, "weeks", 100, "fitness")
    record(w_goal.get("is_locked") is True, "weekly goal is_locked=true on creation",
           f"got is_locked={w_goal.get('is_locked')}")
    try:
        c2 = datetime.fromisoformat(w_goal["created_at"].replace("Z", "+00:00"))
        n2 = datetime.fromisoformat(w_goal["next_tick_available_at"].replace("Z", "+00:00"))
        record(abs((n2 - c2) - timedelta(days=7)) < timedelta(seconds=2),
               "weekly next_tick_available_at == created_at + 7 days",
               f"delta={n2 - c2}")
    except Exception as e:
        record(False, "weekly next_tick parses & equals +7d", str(e))

    xp_before = total_xp_of(user_a_token)
    rr = tick_goal(user_a_token, w_goal["id"], 1)
    record(rr.status_code == 429, "weekly POST progress {cv:1} returns 429",
           f"got {rr.status_code}: {rr.text[:200]}")
    if rr.status_code == 429:
        det = rr.json().get("detail", {})
        record(det.get("error") == "cycle_locked", "weekly 429 detail.error=='cycle_locked'",
               f"detail={det}")
        record(det.get("unit") == "weeks", "weekly 429 detail.unit=='weeks'",
               f"detail.unit={det.get('unit')}")
    xp_after = total_xp_of(user_a_token)
    record(xp_after == xp_before, "weekly failed tick did NOT change total_xp",
           f"before={xp_before} after={xp_after}")

    # ============================================================
    # (3) DAILY goal target_value=1 → 200, completed=true, awarded_xp=150
    # ============================================================
    print("\n[3] DAILY goal target=1 → award 150 XP, xp_awarded_on_complete persists")
    xp_before = total_xp_of(user_a_token)
    d_goal = create_goal(user_a_token, "Morning meditation", 1, "days", 150, "mindset")
    record(d_goal.get("is_locked") in (False, None), "daily goal not locked on creation",
           f"got is_locked={d_goal.get('is_locked')}")
    rr = tick_goal(user_a_token, d_goal["id"], 1)
    record(rr.status_code == 200, "daily POST progress {cv:1} returns 200",
           f"got {rr.status_code}: {rr.text[:200]}")
    body = rr.json() if rr.status_code == 200 else {}
    record(body.get("completed") is True, "daily response.completed==true",
           f"completed={body.get('completed')}")
    record(body.get("awarded_xp") == 150, "daily response.awarded_xp==150",
           f"awarded_xp={body.get('awarded_xp')}")
    xp_after = total_xp_of(user_a_token)
    # Spec says profile.total_xp +=150. (Note: daily goals with target=1 also
    # award 30 XP "step XP" so delta may be 180. Spec assertion: +=150
    # interpretation — we test for delta >= 150 AND record exact delta.)
    record(xp_after - xp_before == 150,
           "daily profile.total_xp += 150 (completion bonus)",
           f"delta={xp_after - xp_before} (before={xp_before} after={xp_after})")
    goals = list_goals(user_a_token)
    g_found = next((g for g in goals if g["id"] == d_goal["id"]), None)
    record(g_found is not None, "GET /goals returns the daily goal")
    if g_found:
        record(g_found.get("xp_awarded_on_complete") == 150,
               "GET /goals: daily goal xp_awarded_on_complete==150 persisted",
               f"value={g_found.get('xp_awarded_on_complete')}")

    # ============================================================
    # (4) UN-TICK refund (scoped by goal_id)
    # ============================================================
    print("\n[4] UN-TICK daily goal → refund 150, task_logs goal_complete row deleted")
    xp_before = total_xp_of(user_a_token)
    rr = tick_goal(user_a_token, d_goal["id"], 0)
    record(rr.status_code == 200, "un-tick POST progress {cv:0} returns 200",
           f"got {rr.status_code}: {rr.text[:200]}")
    body = rr.json() if rr.status_code == 200 else {}
    record(body.get("completed") is False, "un-tick response.completed==false",
           f"completed={body.get('completed')}")
    record(body.get("refunded_xp") == 150, "un-tick response.refunded_xp==150",
           f"refunded_xp={body.get('refunded_xp')}")
    xp_after = total_xp_of(user_a_token)
    record(xp_before - xp_after == 150, "un-tick profile.total_xp decreases by 150",
           f"delta={xp_before - xp_after} (before={xp_before} after={xp_after})")

    sw = requests.get(f"{BACKEND_URL}/stats/weekly", headers=make_headers(user_a_token), timeout=15).json()
    today_iso = datetime.now(timezone.utc).date().isoformat()
    today_row = next((d for d in sw.get("days", []) if d.get("date") == today_iso), None)
    record(today_row is not None, "weekly stats has today's row")
    if today_row:
        record(today_row.get("goal_xp", -1) == 0,
               "after un-tick, today's goal_xp == 0 (task_logs goal_complete row deleted)",
               f"goal_xp={today_row.get('goal_xp')} full row={today_row}")

    # ============================================================
    # (5) Stats endpoints carry NEW `goal_xp`
    # ============================================================
    print("\n[5] Re-create daily goal, complete, verify goal_xp on weekly/monthly + admin charts")
    xp_before = total_xp_of(user_a_token)
    d2 = create_goal(user_a_token, "Read 10 pages", 1, "days", 150, "mindset")
    rr = tick_goal(user_a_token, d2["id"], 1)
    record(rr.status_code == 200 and rr.json().get("awarded_xp") == 150,
           "second daily goal awarded 150 XP",
           f"status={rr.status_code} body={rr.text[:200]}")
    xp_after = total_xp_of(user_a_token)
    record(xp_after - xp_before == 150,
           "second daily goal: total_xp delta == +150",
           f"delta={xp_after - xp_before}")

    sw = requests.get(f"{BACKEND_URL}/stats/weekly", headers=make_headers(user_a_token), timeout=15)
    record(sw.status_code == 200, "/stats/weekly returns 200")
    sw_j = sw.json() if sw.status_code == 200 else {}
    days = sw_j.get("days") or []
    record(len(days) == 7, "/stats/weekly days length==7", f"got {len(days)}")
    record(all(isinstance(d.get("goal_xp"), int) for d in days),
           "every weekly day has goal_xp:int",
           f"missing rows: {[d for d in days if not isinstance(d.get('goal_xp'), int)]}")
    today_row = next((d for d in days if d.get("date") == today_iso), None)
    record(today_row is not None, "weekly: today's row present")
    if today_row:
        record(today_row.get("goal_xp") == 150,
               "weekly: today's goal_xp == 150",
               f"row={today_row}")
        # xp key should NOT double-count the 150 from goal_complete.
        record(today_row.get("xp", 0) != 150,
               "weekly: today's xp key does NOT == goal_xp (no double-counting)",
               f"today.xp={today_row.get('xp')} today.goal_xp={today_row.get('goal_xp')}")

    sm = requests.get(f"{BACKEND_URL}/stats/monthly", headers=make_headers(user_a_token), timeout=15)
    record(sm.status_code == 200, "/stats/monthly returns 200")
    sm_j = sm.json() if sm.status_code == 200 else {}
    m_days = sm_j.get("days") or []
    record(len(m_days) == 30, "/stats/monthly days length==30", f"got {len(m_days)}")
    record(all(isinstance(d.get("goal_xp"), int) for d in m_days),
           "every monthly day has goal_xp:int")
    m_today = next((d for d in m_days if d.get("date") == today_iso), None)
    record(m_today is not None, "monthly: today's row present")
    if m_today:
        record(m_today.get("goal_xp") == 150, "monthly: today's goal_xp == 150",
               f"row={m_today}")

    ac = requests.get(
        f"{BACKEND_URL}/admin/players/{user_a_id}/charts",
        headers=make_headers(admin_token), timeout=15,
    )
    record(ac.status_code == 200, "/admin/players/{userA}/charts returns 200 for admin")
    if ac.status_code == 200:
        ac_j = ac.json()
        ac_weekly = (ac_j.get("weekly") or {}).get("days") or []
        ac_monthly = (ac_j.get("monthly") or {}).get("days") or []
        record(len(ac_weekly) == 7 and len(ac_monthly) == 30,
               "admin charts weekly.days=7, monthly.days=30",
               f"w={len(ac_weekly)} m={len(ac_monthly)}")
        record(all(isinstance(d.get("goal_xp"), int) for d in ac_weekly),
               "admin charts: every weekly entry has goal_xp:int")
        record(all(isinstance(d.get("goal_xp"), int) for d in ac_monthly),
               "admin charts: every monthly entry has goal_xp:int")
        ac_w_today = next((d for d in ac_weekly if d.get("date") == today_iso), None)
        if ac_w_today:
            record(ac_w_today.get("goal_xp") == 150,
                   "admin charts weekly today.goal_xp == 150",
                   f"row={ac_w_today}")

    # ============================================================
    # (6) Regressions
    # ============================================================
    print("\n[6] Regressions: penalties, /stats/by-area, additional daily goal works")
    pen_p = requests.get(f"{BACKEND_URL}/penalties/pending", headers=make_headers(user_a_token), timeout=15)
    record(pen_p.status_code == 200, "/penalties/pending returns 200",
           f"got {pen_p.status_code}: {pen_p.text[:120]}")
    pen_h = requests.get(f"{BACKEND_URL}/penalties/history?limit=50",
                         headers=make_headers(user_a_token), timeout=15)
    record(pen_h.status_code == 200, "/penalties/history?limit=50 returns 200",
           f"got {pen_h.status_code}: {pen_h.text[:120]}")
    sba = requests.get(f"{BACKEND_URL}/stats/by-area", headers=make_headers(user_a_token), timeout=15)
    record(sba.status_code == 200, "/stats/by-area returns 200",
           f"got {sba.status_code}: {sba.text[:120]}")

    d3 = create_goal(user_a_token, "Drink water", 1, "days", 50, "fitness")
    rr = tick_goal(user_a_token, d3["id"], 1)
    record(rr.status_code == 200 and rr.json().get("completed") is True,
           "3rd daily goal still completes normally (no lockout)",
           f"status={rr.status_code} body={rr.text[:150]}")

    # ============================================================
    print("\n" + "=" * 70)
    print(f"PASS: {len(PASS)}")
    print(f"FAIL: {len(FAIL)}")
    if FAIL:
        print("\nFAILURES:")
        for f in FAIL:
            print(f"  - {f}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
