"""
Backend tests for admin roster + global leaderboard endpoints.

Endpoints:
  GET /api/admin/players/by-creation
  GET /api/admin/leaderboard/global

Reference: review request 2026-05-09.

Run:  python /app/admin_roster_leaderboard_test.py
"""
from __future__ import annotations
import os
import sys
import time
import uuid
import json
import math
import datetime as dt
from typing import Any
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASS = 0
FAIL = 0
FAILS: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {label}")
    else:
        FAIL += 1
        FAILS.append(f"{label} :: {detail}")
        print(f"  ❌ {label}  ({detail})")


def login_admin() -> str:
    r = requests.post(f"{BASE}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    r.raise_for_status()
    return r.json()["token"]


def register_anon_user() -> tuple[str, str]:
    suf = uuid.uuid4().hex[:8]
    email = f"roster_test_{suf}@gmail.com"
    body = {"full_name": f"Roster Tester {suf}", "email": email, "password": "Test1234!"}
    r = requests.post(f"{BASE}/auth/register", json=body, timeout=30)
    r.raise_for_status()
    return r.json()["token"], email


def get(token: str, path: str, **params) -> requests.Response:
    return requests.get(f"{BASE}{path}", params=params, headers={"Authorization": f"Bearer {token}"}, timeout=30)


def is_iso(s: Any) -> bool:
    if not isinstance(s, str) or not s:
        return False
    try:
        dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return True
    except Exception:
        return False


def parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


# ───────────────────── Tests ─────────────────────

def test_players_by_creation(admin_tok: str, anon_tok: str) -> None:
    print("\n=== /api/admin/players/by-creation ===")

    # (a) Auth: non-admin → 403
    r = get(anon_tok, "/admin/players/by-creation")
    check("(a) non-admin → 403", r.status_code == 403, f"status={r.status_code} body={r.text[:200]}")
    if r.status_code == 403:
        try:
            check("(a) detail == 'Admin only.'", r.json().get("detail") == "Admin only.", f"detail={r.json().get('detail')}")
        except Exception:
            check("(a) detail == 'Admin only.'", False, "non-json body")

    # (b) Default
    r = get(admin_tok, "/admin/players/by-creation")
    check("(b) admin default → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    body = r.json() if r.status_code == 200 else {}
    players = body.get("players", [])
    check("(b) response.order == 'newest'", body.get("order") == "newest", f"order={body.get('order')}")
    check("(b) response.since == 'all'", body.get("since") == "all", f"since={body.get('since')}")
    check("(b) response.count is int and == len(players)", isinstance(body.get("count"), int) and body.get("count") == len(players), f"count={body.get('count')} len={len(players)}")
    check("(b) players is list non-empty", isinstance(players, list) and len(players) > 0, f"len={len(players)}")
    if players:
        row0 = players[0]
        for k in ("user_id", "name", "level", "total_xp", "friend_status", "created_at", "email", "last_seen_at"):
            check(f"(b) row[0] has key '{k}'", k in row0, f"keys={list(row0.keys())}")
        check("(b) row[0].created_at is ISO", is_iso(row0.get("created_at")), f"v={row0.get('created_at')}")
        check("(b) row[0].email is str", isinstance(row0.get("email"), str), f"v={type(row0.get('email')).__name__}")
        check("(b) row[0].last_seen_at is str|None", row0.get("last_seen_at") is None or isinstance(row0.get("last_seen_at"), str), f"v={row0.get('last_seen_at')}")
    # Sort DESC by created_at
    if len(players) >= 2:
        cas = [p.get("created_at") for p in players if p.get("created_at")]
        sorted_desc = all(cas[i] >= cas[i + 1] for i in range(len(cas) - 1))
        check("(b) rows sorted DESC by created_at", sorted_desc, f"cas[:5]={cas[:5]}")

    # (c) Order=oldest
    r = get(admin_tok, "/admin/players/by-creation", order="oldest")
    body = r.json() if r.status_code == 200 else {}
    players_old = body.get("players", [])
    check("(c) order=oldest → 200", r.status_code == 200, f"status={r.status_code}")
    check("(c) response.order == 'oldest'", body.get("order") == "oldest", f"order={body.get('order')}")
    if len(players_old) >= 2:
        cas = [p.get("created_at") for p in players_old if p.get("created_at")]
        sorted_asc = all(cas[i] <= cas[i + 1] for i in range(len(cas) - 1))
        check("(c) rows sorted ASC by created_at", sorted_asc, f"cas[:5]={cas[:5]}")

    # (d) since=week
    r = get(admin_tok, "/admin/players/by-creation", since="week")
    body = r.json() if r.status_code == 200 else {}
    players_w = body.get("players", [])
    check("(d) since=week → 200", r.status_code == 200, f"status={r.status_code}")
    check("(d) response.since == 'week'", body.get("since") == "week", f"since={body.get('since')}")
    if players_w:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)
        # allow 60s clock skew
        cutoff_skew = cutoff - dt.timedelta(seconds=60)
        bad = [p.get("created_at") for p in players_w if p.get("created_at") and parse_iso(p["created_at"]) < cutoff_skew]
        check("(d) all rows within last 7 days", len(bad) == 0, f"bad={bad[:3]}")

    # (e) since=month
    r = get(admin_tok, "/admin/players/by-creation", since="month")
    body = r.json() if r.status_code == 200 else {}
    players_m = body.get("players", [])
    check("(e) since=month → 200", r.status_code == 200, f"status={r.status_code}")
    check("(e) response.since == 'month'", body.get("since") == "month", f"since={body.get('since')}")
    if players_m:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)
        cutoff_skew = cutoff - dt.timedelta(seconds=60)
        bad = [p.get("created_at") for p in players_m if p.get("created_at") and parse_iso(p["created_at"]) < cutoff_skew]
        check("(e) all rows within last 30 days", len(bad) == 0, f"bad={bad[:3]}")

    # (f) Search q=filip
    r = get(admin_tok, "/admin/players/by-creation", q="filip")
    body = r.json() if r.status_code == 200 else {}
    players_q = body.get("players", [])
    check("(f) q=filip → 200", r.status_code == 200, f"status={r.status_code}")
    check("(f) at least one row", len(players_q) >= 1, f"len={len(players_q)}")
    for row in players_q:
        hay = f"{row.get('name','')} {row.get('email','')}".lower()
        if "filip" not in hay:
            check(f"(f) row name/email contains 'filip'", False, f"row.name={row.get('name')} email={row.get('email')}")
            break
    else:
        if players_q:
            check("(f) every row name/email contains 'filip'", True)

    # (g) Limit clamping
    r = get(admin_tok, "/admin/players/by-creation", limit=10000)
    body = r.json() if r.status_code == 200 else {}
    plen = len(body.get("players", []))
    check("(g) limit=10000 → ≤500 rows", r.status_code == 200 and plen <= 500, f"status={r.status_code} len={plen}")
    r = get(admin_tok, "/admin/players/by-creation", limit=5)
    body = r.json() if r.status_code == 200 else {}
    plen = len(body.get("players", []))
    check("(g) limit=5 → ≤5 rows", r.status_code == 200 and plen <= 5, f"status={r.status_code} len={plen}")

    # (h) Invalid order/since
    r = get(admin_tok, "/admin/players/by-creation", order="garbage", since="garbage")
    check("(h) invalid params → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    body = r.json() if r.status_code == 200 else {}
    check("(h) order falls back to 'newest'", body.get("order") == "newest", f"order={body.get('order')}")
    check("(h) since falls back to 'all'", body.get("since") == "all", f"since={body.get('since')}")


def test_global_leaderboard(admin_tok: str, anon_tok: str) -> None:
    print("\n=== /api/admin/leaderboard/global ===")

    # (a) Auth
    r = get(anon_tok, "/admin/leaderboard/global")
    check("(a) non-admin → 403", r.status_code == 403, f"status={r.status_code}")
    if r.status_code == 403:
        try:
            check("(a) detail == 'Admin only.'", r.json().get("detail") == "Admin only.", f"detail={r.json().get('detail')}")
        except Exception:
            pass

    # (b) Period=all
    r = get(admin_tok, "/admin/leaderboard/global")
    body = r.json() if r.status_code == 200 else {}
    lb = body.get("leaderboard", [])
    check("(b) admin default → 200", r.status_code == 200, f"status={r.status_code}")
    check("(b) response.period == 'all'", body.get("period") == "all", f"period={body.get('period')}")
    check("(b) leaderboard length ≤ 100", len(lb) <= 100, f"len={len(lb)}")
    if lb:
        # sorted DESC by total_xp (period_xp == total_xp here)
        pxs = [r.get("period_xp") for r in lb]
        check("(b) sorted DESC by period_xp", all(pxs[i] >= pxs[i + 1] for i in range(len(pxs) - 1)), f"pxs[:5]={pxs[:5]}")
        # ranks contiguous from 1
        ranks = [r.get("rank") for r in lb]
        check("(b) ranks contiguous 1..N", ranks == list(range(1, len(lb) + 1)), f"ranks[:5]={ranks[:5]}")
        row0 = lb[0]
        for k in ("user_id", "name", "level", "friend_status", "rank", "period_xp", "created_at"):
            check(f"(b) row[0] has '{k}'", k in row0, f"keys={list(row0.keys())}")
        # period_xp == total_xp for period='all' (admin appears with sentinel total_xp=-1 sometimes; check non-admin rows)
        for r2 in lb:
            if r2.get("total_xp", 0) >= 0:
                check("(b) period_xp == total_xp (sample non-admin row)", r2.get("period_xp") == r2.get("total_xp"), f"px={r2.get('period_xp')} tx={r2.get('total_xp')}")
                break
        # period_xp not None / not NaN
        bad_px = [r2.get("period_xp") for r2 in lb if r2.get("period_xp") is None or (isinstance(r2.get("period_xp"), float) and math.isnan(r2.get("period_xp")))]
        check("(b) period_xp never None/NaN", len(bad_px) == 0, f"bad={bad_px[:3]}")

    # (c) Period=week
    r = get(admin_tok, "/admin/leaderboard/global", period="week")
    body = r.json() if r.status_code == 200 else {}
    lb = body.get("leaderboard", [])
    check("(c) period=week → 200", r.status_code == 200, f"status={r.status_code}")
    check("(c) response.period == 'week'", body.get("period") == "week", f"period={body.get('period')}")
    if lb:
        pxs = [r.get("period_xp") for r in lb]
        check("(c) sorted DESC by period_xp", all(pxs[i] >= pxs[i + 1] for i in range(len(pxs) - 1)), f"pxs[:5]={pxs[:5]}")
        ranks = [r.get("rank") for r in lb]
        check("(c) ranks contiguous 1..N", ranks == list(range(1, len(lb) + 1)), f"ranks[:5]={ranks[:5]}")
        bad_px = [r2.get("period_xp") for r2 in lb if r2.get("period_xp") is None or (isinstance(r2.get("period_xp"), float) and math.isnan(r2.get("period_xp")))]
        check("(c) period_xp never None/NaN", len(bad_px) == 0, f"bad={bad_px[:3]}")
        check("(c) all period_xp > 0", all((r2.get("period_xp") or 0) > 0 for r2 in lb), f"min={min(pxs)}")

    # (d) Period=month
    r = get(admin_tok, "/admin/leaderboard/global", period="month")
    body = r.json() if r.status_code == 200 else {}
    lb = body.get("leaderboard", [])
    check("(d) period=month → 200", r.status_code == 200, f"status={r.status_code}")
    check("(d) response.period == 'month'", body.get("period") == "month", f"period={body.get('period')}")
    if lb:
        pxs = [r.get("period_xp") for r in lb]
        check("(d) sorted DESC by period_xp", all(pxs[i] >= pxs[i + 1] for i in range(len(pxs) - 1)), "")
        ranks = [r.get("rank") for r in lb]
        check("(d) ranks contiguous 1..N", ranks == list(range(1, len(lb) + 1)), "")

    # (e) Period=year
    r = get(admin_tok, "/admin/leaderboard/global", period="year")
    body = r.json() if r.status_code == 200 else {}
    lb = body.get("leaderboard", [])
    check("(e) period=year → 200", r.status_code == 200, f"status={r.status_code}")
    check("(e) response.period == 'year'", body.get("period") == "year", f"period={body.get('period')}")
    if lb:
        pxs = [r.get("period_xp") for r in lb]
        check("(e) sorted DESC by period_xp", all(pxs[i] >= pxs[i + 1] for i in range(len(pxs) - 1)), "")
        ranks = [r.get("rank") for r in lb]
        check("(e) ranks contiguous 1..N", ranks == list(range(1, len(lb) + 1)), "")

    # (f) Invalid period
    r = get(admin_tok, "/admin/leaderboard/global", period="foo")
    check("(f) period=foo → 200", r.status_code == 200, f"status={r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("(f) period falls back to 'all'", body.get("period") == "all", f"period={body.get('period')}")

    # (g) Search q=filip period=all
    r = get(admin_tok, "/admin/leaderboard/global", period="all", q="filip")
    body = r.json() if r.status_code == 200 else {}
    lb = body.get("leaderboard", [])
    check("(g) q=filip period=all → 200", r.status_code == 200, f"status={r.status_code}")
    if lb:
        # ranks STILL contiguous starting at 1
        ranks = [r.get("rank") for r in lb]
        check("(g) ranks contiguous 1..N across filtered set", ranks == list(range(1, len(lb) + 1)), f"ranks={ranks}")
        # all rows match name
        bad = [r2.get("name") for r2 in lb if "filip" not in (r2.get("name") or "").lower()]
        check("(g) every row name contains 'filip'", len(bad) == 0, f"bad={bad[:3]}")

    # (h) Empty results
    r = get(admin_tok, "/admin/leaderboard/global", q="zzzzzzz_no_match_xyz")
    body = r.json() if r.status_code == 200 else {}
    check("(h) zero-match q → 200", r.status_code == 200, f"status={r.status_code}")
    check("(h) leaderboard == []", body.get("leaderboard") == [], f"lb={body.get('leaderboard')}")


def test_regressions(admin_tok: str, anon_tok: str) -> None:
    print("\n=== Regressions ===")

    # (i) /admin/reports
    r = get(admin_tok, "/admin/reports")
    check("(i) /admin/reports → 200", r.status_code == 200, f"status={r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("(i) /admin/reports has 'reports' list", isinstance(body.get("reports"), list), f"keys={list(body.keys())}")
    check("(i) /admin/reports has 'new_count' int", isinstance(body.get("new_count"), int), f"v={body.get('new_count')}")

    # (j) /api/profile (anon user)
    r = get(anon_tok, "/profile")
    check("(j) /profile → 200", r.status_code == 200, f"status={r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    for k in ("name", "total_xp", "level"):
        check(f"(j) /profile has '{k}'", k in body, f"keys={list(body.keys())[:10]}")

    # (j) admin /profile
    r = get(admin_tok, "/profile")
    check("(j) admin /profile → 200", r.status_code == 200, f"status={r.status_code}")

    # (k) negative xp_event regression: a fresh user complete + uncomplete a 50-XP custom task
    # → period_xp net 0. Since aggregator filters period_xp>0, user shouldn't appear in week leaderboard.
    # We'll create a 50-XP custom task as admin (to bypass cap), gift to user, and toggle.
    # Simpler: register 2 fresh anon users; pick one's existing default task; complete then uncomplete it
    # and verify the user does NOT appear in /admin/leaderboard/global?period=week (since period_xp filtered),
    # AND that the response contains no NaN/null period_xp anywhere.
    # We've already validated NaN/null in (c). Now also verify a complete/uncomplete pair doesn't break aggregation.
    suf = uuid.uuid4().hex[:8]
    body = {"full_name": f"NegEvent {suf}", "email": f"negevent_{suf}@gmail.com", "password": "Test1234!"}
    rr = requests.post(f"{BASE}/auth/register", json=body, timeout=20)
    check("(k) register fresh user", rr.status_code == 200, f"status={rr.status_code}")
    if rr.status_code == 200:
        new_tok = rr.json()["token"]
        # Get default tasks
        rt = get(new_tok, "/tasks")
        if rt.status_code == 200:
            tasks = rt.json().get("tasks", [])
            if tasks:
                tid = tasks[0]["id"] if "id" in tasks[0] else tasks[0].get("_id")
                # Complete then uncomplete
                c = requests.post(f"{BASE}/tasks/{tid}/complete", json={}, headers={"Authorization": f"Bearer {new_tok}"}, timeout=20)
                check("(k) complete task → 200", c.status_code == 200, f"status={c.status_code} body={c.text[:200]}")
                time.sleep(1.2)  # avoid rate limit
                u = requests.post(f"{BASE}/tasks/{tid}/uncomplete", json={}, headers={"Authorization": f"Bearer {new_tok}"}, timeout=20)
                check("(k) uncomplete task → 200", u.status_code == 200, f"status={u.status_code} body={u.text[:200]}")

                # Now fetch /admin/leaderboard/global?period=week and verify no None/NaN AND aggregation ran cleanly
                r = get(admin_tok, "/admin/leaderboard/global", period="week")
                body = r.json() if r.status_code == 200 else {}
                lb = body.get("leaderboard", [])
                check("(k) week LB after neg event → 200", r.status_code == 200, f"status={r.status_code}")
                bad = [row for row in lb if row.get("period_xp") is None or (isinstance(row.get("period_xp"), float) and math.isnan(row.get("period_xp")))]
                check("(k) period_xp not None/NaN after neg events", len(bad) == 0, f"bad={bad[:3]}")
                # Pipeline filters period_xp>0 — user's net 0 row should NOT appear
                me = rr.json()["user"]["id"] if "id" in rr.json().get("user", {}) else rr.json()["user"].get("user_id")
                if me:
                    appears = any(row.get("user_id") == me for row in lb)
                    check("(k) net-zero user filtered from week LB", not appears, f"user_id={me} appears={appears}")


# ───────────────────── Main ─────────────────────

def main() -> int:
    print(f"BASE: {BASE}")
    admin_tok = login_admin()
    print("Logged in as admin.")
    anon_tok, anon_email = register_anon_user()
    print(f"Registered anon: {anon_email}")

    try:
        test_players_by_creation(admin_tok, anon_tok)
    except Exception:
        import traceback; traceback.print_exc()
    try:
        test_global_leaderboard(admin_tok, anon_tok)
    except Exception:
        import traceback; traceback.print_exc()
    try:
        test_regressions(admin_tok, anon_tok)
    except Exception:
        import traceback; traceback.print_exc()

    print(f"\n=========== {PASS} passed, {FAIL} failed ===========")
    if FAILS:
        print("FAILURES:")
        for f in FAILS:
            print(" -", f)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
