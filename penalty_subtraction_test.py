"""
Targeted test — XP Penalty Subtraction (Creator-only) + Live public profile fields.
See test_result.md task "XP Penalty Subtraction (Creator-only) + Live public profile fields".
"""
from __future__ import annotations
import json
import os
import time
import uuid
from datetime import datetime, timezone

import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

results: list[tuple[bool, str]] = []


def _rec(cond: bool, label: str, detail: str = ""):
    results.append((cond, label + (f" :: {detail}" if detail and not cond else "")))
    icon = "[OK]" if cond else "[FAIL]"
    print(f"{icon} {label}" + (f" :: {detail}" if detail else ""))


def _auth_h(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def _login(email: str, password: str) -> str:
    r = requests.post(f"{BASE}/auth/login", json={"email": email, "password": password}, timeout=30)
    r.raise_for_status()
    return r.json()["token"]


def _register(email: str, full_name: str, password: str) -> tuple[str, str]:
    r = requests.post(
        f"{BASE}/auth/register",
        json={"email": email, "full_name": full_name, "password": password},
        timeout=30,
    )
    r.raise_for_status()
    j = r.json()
    return j["token"], j["user"]["id"]


def main() -> int:
    print("=" * 80)
    print("XP Penalty Subtraction + Live profile test")
    print(f"Target: {BASE}")
    print("=" * 80)

    # ---------- 0. setup ----------
    admin_tok = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    _rec(bool(admin_tok), "admin login (filip.cojocea122@gmail.com)")
    r = requests.get(f"{BASE}/auth/me", headers=_auth_h(admin_tok), timeout=20)
    r.raise_for_status()
    admin_id = r.json()["id"]
    _rec(bool(admin_id), "admin profile id resolved", admin_id)

    rand = uuid.uuid4().hex[:10]
    userA_email = f"alice.morgan.{rand}@gmail.com"
    userB_email = f"ben.parker.{rand}@gmail.com"
    a_tok, a_id = _register(userA_email, "Alice Morgan", "SecretPass!88x")
    _rec(bool(a_tok and a_id), "userA registered", f"id={a_id}")
    b_tok, b_id = _register(userB_email, "Ben Parker", "SecretPass!99y")
    _rec(bool(b_tok and b_id), "userB registered", f"id={b_id}")

    # ---------- 1. Endpoint authn / authz ----------
    # As non-admin
    r = requests.post(
        f"{BASE}/admin/players/{a_id}/penalty",
        json={"amount": 100, "note": "x"},
        headers=_auth_h(b_tok),
        timeout=20,
    )
    _rec(r.status_code == 403, "POST /admin/players/{id}/penalty as non-admin → 403", f"got {r.status_code}: {r.text[:200]}")

    # As admin amount<1 → 422 (Pydantic)
    r = requests.post(
        f"{BASE}/admin/players/{a_id}/penalty",
        json={"amount": 0, "note": "zero"},
        headers=_auth_h(admin_tok),
        timeout=20,
    )
    _rec(r.status_code == 422, "POST penalty amount=0 as admin → 422", f"got {r.status_code}: {r.text[:200]}")

    r = requests.post(
        f"{BASE}/admin/players/{a_id}/penalty",
        json={"amount": -5, "note": "neg"},
        headers=_auth_h(admin_tok),
        timeout=20,
    )
    _rec(r.status_code == 422, "POST penalty amount=-5 as admin → 422", f"got {r.status_code}: {r.text[:200]}")

    # ---------- 2. Snapshot profile BEFORE ----------
    pre = requests.get(f"{BASE}/friends/profile/{a_id}", headers=_auth_h(admin_tok), timeout=20)
    _rec(pre.status_code == 200, "GET /friends/profile/{userA} (pre) → 200")
    pre_j = pre.json()
    pre_total_xp = int(pre_j.get("total_xp", 0) or 0)
    # Live profile fields presence (pre)
    for k in ("active_goals_count", "total_goals_count", "joined_at", "tasks_completed", "level", "total_xp"):
        _rec(k in pre_j, f"public profile contains '{k}' (pre)")
    _rec(isinstance(pre_j.get("active_goals_count"), int), "active_goals_count is int")
    _rec(isinstance(pre_j.get("total_goals_count"), int), "total_goals_count is int")
    _rec(isinstance(pre_j.get("tasks_completed"), int), "tasks_completed is int")
    _rec(isinstance(pre_j.get("level"), int), "level is int")
    _rec(pre_j.get("joined_at") is None or isinstance(pre_j.get("joined_at"), str), "joined_at is str|null")
    pre_tasks_completed = int(pre_j.get("tasks_completed", 0))

    # /penalties/pending BEFORE → empty
    r = requests.get(f"{BASE}/penalties/pending", headers=_auth_h(a_tok), timeout=20)
    _rec(r.status_code == 200, "GET /penalties/pending (pre) → 200")
    j = r.json()
    _rec(isinstance(j.get("penalties"), list) and len(j["penalties"]) == 0, "pending empty before penalty", f"got {j}")

    # ---------- 3. Apply penalty ----------
    pen_amount = 200
    r = requests.post(
        f"{BASE}/admin/players/{a_id}/penalty",
        json={"amount": pen_amount, "note": "test penalty"},
        headers=_auth_h(admin_tok),
        timeout=20,
    )
    _rec(r.status_code == 200, "POST penalty as admin → 200", f"got {r.status_code}: {r.text[:300]}")
    pen_j = r.json()
    # Expected shape
    for k in ("ok", "penalty_id", "player_id", "amount", "note", "new_total_xp", "new_level", "created_at"):
        _rec(k in pen_j, f"penalty response contains '{k}'")
    _rec(pen_j.get("ok") is True, "ok == true")
    _rec(pen_j.get("player_id") == a_id, "player_id == userA")
    _rec(int(pen_j.get("amount", 0)) == pen_amount, f"amount == {pen_amount}")
    _rec(pen_j.get("note") == "test penalty", "note round-tripped")
    _rec(isinstance(pen_j.get("new_total_xp"), int), "new_total_xp is int (may be negative)")
    _rec(isinstance(pen_j.get("new_level"), int), "new_level is int")
    # penalty_id is a UUID
    pid = pen_j.get("penalty_id", "")
    try:
        uuid.UUID(pid)
        _rec(True, "penalty_id is uuid")
    except Exception as e:
        _rec(False, "penalty_id is uuid", f"value={pid!r} err={e}")
    # created_at is ISO
    ca = pen_j.get("created_at", "")
    try:
        datetime.fromisoformat(ca.replace("Z", "+00:00"))
        _rec(True, "created_at is ISO timestamp")
    except Exception as e:
        _rec(False, "created_at is ISO timestamp", f"value={ca!r} err={e}")

    # ---------- 4. Profile total_xp decremented ----------
    post = requests.get(f"{BASE}/friends/profile/{a_id}", headers=_auth_h(admin_tok), timeout=20)
    _rec(post.status_code == 200, "GET /friends/profile/{userA} (post) → 200")
    post_j = post.json()
    post_total_xp = int(post_j.get("total_xp", 0))
    _rec(post_total_xp == pre_total_xp - pen_amount,
         f"total_xp decreased by {pen_amount}", f"pre={pre_total_xp} post={post_total_xp}")
    # may be negative
    _rec(isinstance(post_total_xp, int), "total_xp is int (may be negative)")
    # tasks_completed should EXCLUDE the negative penalty mirror row
    post_tasks_completed = int(post_j.get("tasks_completed", 0))
    _rec(post_tasks_completed == pre_tasks_completed,
         "tasks_completed unchanged (penalty mirror row excluded)",
         f"pre={pre_tasks_completed} post={post_tasks_completed}")

    # Verify via admin players list as well (best-effort: fetch by_creation)
    r = requests.get(f"{BASE}/admin/players/by-creation?limit=500&since=all&q=", headers=_auth_h(admin_tok), timeout=30)
    if r.status_code == 200:
        rows = r.json().get("players", [])
        row = next((p for p in rows if p.get("user_id") == a_id), None)
        if row is not None:
            _rec(int(row.get("total_xp", 0)) == post_total_xp,
                 "admin/players by-creation row total_xp matches", f"row.total_xp={row.get('total_xp')} expected={post_total_xp}")
    else:
        _rec(False, "GET /admin/players/by-creation returned 200", f"got {r.status_code}")

    # ---------- 5. Pending list now has the penalty ----------
    r = requests.get(f"{BASE}/penalties/pending", headers=_auth_h(a_tok), timeout=20)
    _rec(r.status_code == 200, "GET /penalties/pending (post) → 200")
    j = r.json()
    pens = j.get("penalties") or []
    _rec(len(pens) >= 1, "pending list has ≥1 row")
    row = next((p for p in pens if p.get("id") == pid), None)
    _rec(row is not None, "pending list contains created penalty_id")
    if row:
        for k in ("id", "creator_id", "player_id", "amount", "note", "created_at", "date", "acknowledged_at"):
            _rec(k in row, f"pending row contains '{k}'")
        _rec(row.get("acknowledged_at") is None, "pending row acknowledged_at == null")
        _rec(int(row.get("amount", 0)) == pen_amount, "pending row amount matches")
        _rec(row.get("creator_id") == admin_id, "pending row creator_id == admin_id")
        _rec(row.get("player_id") == a_id, "pending row player_id == userA")

    # ---------- 6. Acknowledge — caller-only ----------
    # different user (userB) → 404
    r = requests.post(f"{BASE}/penalties/{pid}/acknowledge", headers=_auth_h(b_tok), timeout=20)
    _rec(r.status_code == 404, "acknowledge as userB → 404", f"got {r.status_code}: {r.text[:200]}")
    # userA → 200 {ok:true}
    r = requests.post(f"{BASE}/penalties/{pid}/acknowledge", headers=_auth_h(a_tok), timeout=20)
    _rec(r.status_code == 200, "acknowledge as userA → 200")
    j1 = r.json()
    _rec(j1.get("ok") is True, "ack: ok == true")
    # call again → 200 with already:true
    r = requests.post(f"{BASE}/penalties/{pid}/acknowledge", headers=_auth_h(a_tok), timeout=20)
    _rec(r.status_code == 200, "acknowledge again as userA → 200")
    j2 = r.json()
    _rec(j2.get("ok") is True and j2.get("already") is True, "ack again: ok==true & already==true", f"got {j2}")

    # ---------- 7. History — caller-only ----------
    r = requests.get(f"{BASE}/penalties/history?limit=50", headers=_auth_h(a_tok), timeout=20)
    _rec(r.status_code == 200, "GET /penalties/history → 200")
    j = r.json()
    hist = j.get("penalties") or []
    _rec(len(hist) >= 1, "history has ≥1 row")
    hrow = next((p for p in hist if p.get("id") == pid), None)
    _rec(hrow is not None, "history contains penalty_id")
    if hrow:
        ack = hrow.get("acknowledged_at")
        _rec(ack is not None, "history row acknowledged_at != null")
        if ack:
            try:
                datetime.fromisoformat(str(ack).replace("Z", "+00:00"))
                _rec(True, "acknowledged_at is ISO timestamp")
            except Exception as e:
                _rec(False, "acknowledged_at is ISO timestamp", f"value={ack!r} err={e}")

    # ---------- 8. Admin player penalties list ----------
    r = requests.get(f"{BASE}/admin/players/{a_id}/penalties", headers=_auth_h(admin_tok), timeout=20)
    _rec(r.status_code == 200, "GET /admin/players/{userA}/penalties as admin → 200")
    j = r.json()
    admrows = j.get("penalties") or []
    _rec(any(p.get("id") == pid for p in admrows), "admin list contains the same record")

    r = requests.get(f"{BASE}/admin/players/{a_id}/penalties", headers=_auth_h(b_tok), timeout=20)
    _rec(r.status_code == 403, "GET /admin/players/{userA}/penalties as non-admin → 403", f"got {r.status_code}")

    # ---------- 9. Stats endpoints — penalty_xp surfaced ----------
    today_str = datetime.now(timezone.utc).date().isoformat()

    r = requests.get(f"{BASE}/stats/weekly", headers=_auth_h(a_tok), timeout=20)
    _rec(r.status_code == 200, "GET /stats/weekly → 200")
    wk = r.json().get("days") or []
    _rec(len(wk) == 7, "weekly.days length == 7", f"got {len(wk)}")
    for i, d in enumerate(wk):
        keys_ok = all(k in d for k in ("date", "day", "xp", "gifted_xp", "penalty_xp", "tasks"))
        if not keys_ok:
            _rec(False, f"weekly day[{i}] missing keys", f"keys={list(d.keys())}")
            break
    else:
        _rec(True, "weekly: each day has {date,day,xp,gifted_xp,penalty_xp,tasks}")
    today_row = next((d for d in wk if d.get("date") == today_str), None)
    _rec(today_row is not None, "weekly today's row present")
    if today_row:
        _rec(int(today_row.get("penalty_xp", 0)) == pen_amount,
             f"weekly today.penalty_xp == {pen_amount}", f"got {today_row.get('penalty_xp')}")

    r = requests.get(f"{BASE}/stats/monthly", headers=_auth_h(a_tok), timeout=20)
    _rec(r.status_code == 200, "GET /stats/monthly → 200")
    mo = r.json().get("days") or []
    _rec(len(mo) == 30, "monthly.days length == 30", f"got {len(mo)}")
    for i, d in enumerate(mo):
        keys_ok = all(k in d for k in ("date", "day", "xp", "gifted_xp", "penalty_xp", "tasks"))
        if not keys_ok:
            _rec(False, f"monthly day[{i}] missing keys", f"keys={list(d.keys())}")
            break
    else:
        _rec(True, "monthly: each day has {date,day,xp,gifted_xp,penalty_xp,tasks}")

    # admin/players/{a_id}/charts
    r = requests.get(f"{BASE}/admin/players/{a_id}/charts", headers=_auth_h(admin_tok), timeout=20)
    _rec(r.status_code == 200, "GET /admin/players/{userA}/charts as admin → 200")
    cj = r.json()
    wkd = (cj.get("weekly") or {}).get("days") or []
    mod = (cj.get("monthly") or {}).get("days") or []
    _rec(len(wkd) == 7, "admin charts weekly.days length == 7")
    _rec(len(mod) == 30, "admin charts monthly.days length == 30")
    _rec(all("penalty_xp" in d for d in wkd), "admin charts weekly each entry has penalty_xp")
    _rec(all("penalty_xp" in d for d in mod), "admin charts monthly each entry has penalty_xp")
    today_admin = next((d for d in wkd if d.get("date") == today_str), None)
    if today_admin:
        _rec(int(today_admin.get("penalty_xp", 0)) == pen_amount,
             "admin charts weekly today.penalty_xp == 200")

    # ---------- 10. Live profile final assertions ----------
    fp = post_j  # already fetched after penalty
    # joined_at is ISO str or None
    ja = fp.get("joined_at")
    _rec(ja is None or isinstance(ja, str), "joined_at is str|None on post payload")
    # level derived from total_xp (uses level_from_xp(max(0, total_xp)))
    _rec(isinstance(fp.get("level"), int), "level is int on post payload")

    # ---------- Summary ----------
    print("=" * 80)
    passed = sum(1 for ok, _ in results if ok)
    failed = [lbl for ok, lbl in results if not ok]
    print(f"PASSED: {passed}/{len(results)}")
    if failed:
        print(f"FAILED ({len(failed)}):")
        for lbl in failed:
            print(f"  - {lbl}")
    else:
        print("ALL ASSERTIONS PASSED")
    print("=" * 80)
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
