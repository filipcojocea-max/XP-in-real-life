"""Admin-bypass verification: confirm XP add/refund exact-amount works when xp_reward is NOT clamped.
Admin bypasses _clamp_goal_xp, so xp_reward=150 actually gets stored. Run additional checks:
 - awarded_xp==150, refunded_xp==150, total_xp delta +150/-150, goal_xp==150 on stats."""
from __future__ import annotations
import sys, random, string, time
from datetime import datetime, timezone
import requests

BACKEND_URL = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

P, F = [], []


def rec(ok, label, detail=""):
    (P if ok else F).append(label if ok else f"{label} :: {detail}")
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f" -- {detail}" if not ok else ""))


def h(t): return {"Content-Type":"application/json","Authorization":f"Bearer {t}"}


def login(e, pw):
    r = requests.post(f"{BACKEND_URL}/auth/login", json={"email":e,"password":pw}, timeout=20)
    r.raise_for_status()
    b = r.json()
    return b["user"]["id"], b["token"]


def main():
    print(f"\n=== Admin-bypass: full XP=150 round-trip verification ===\n")
    admin_id, admin_token = login(ADMIN_EMAIL, ADMIN_PASSWORD)
    print(f"admin_id={admin_id}")

    # Snapshot
    p_before = requests.get(f"{BACKEND_URL}/profile", headers=h(admin_token), timeout=15).json()
    xp_before = int(p_before.get("total_xp") or 0)
    print(f"  admin starting total_xp = {xp_before}")

    # Create unique daily goal with xp_reward=150
    title = f"AdminTest-{int(time.time())}-{''.join(random.choices(string.hexdigits,k=4))}"
    r = requests.post(f"{BACKEND_URL}/goals", headers=h(admin_token),
                      json={"title":title,"target_value":1,"unit":"days","xp_reward":150,"focus_area":"mindset"},
                      timeout=15)
    rec(r.status_code in (200,201), "admin daily goal created", f"{r.status_code} {r.text[:120]}")
    g = r.json()
    gid = g["id"]
    rec(g.get("xp_reward") == 150, "admin: xp_reward=150 NOT clamped (admin bypass)", f"got xp_reward={g.get('xp_reward')}")
    rec("is_locked" in g, "create response has is_locked field", f"keys={list(g.keys())}")
    rec("next_tick_available_at" in g, "create response has next_tick_available_at field", f"keys={list(g.keys())}")
    rec(g.get("is_locked") in (False, None), "admin daily goal is_locked is falsy (daily not locked on creation)",
        f"got {g.get('is_locked')}")

    # Tick to complete
    r = requests.post(f"{BACKEND_URL}/goals/{gid}/progress", headers=h(admin_token),
                      json={"current_value":1}, timeout=15)
    rec(r.status_code == 200, "admin tick: status 200")
    body = r.json()
    rec(body.get("completed") is True, "admin tick: completed=true")
    rec(body.get("awarded_xp") == 150, f"admin tick: awarded_xp==150", f"got {body.get('awarded_xp')}")

    p_mid = requests.get(f"{BACKEND_URL}/profile", headers=h(admin_token), timeout=15).json()
    xp_mid = int(p_mid.get("total_xp") or 0)
    rec(xp_mid - xp_before == 150, "admin: total_xp delta == +150", f"delta={xp_mid - xp_before}")

    # Verify xp_awarded_on_complete persisted on the goal
    goals = requests.get(f"{BACKEND_URL}/goals", headers=h(admin_token), timeout=15).json()["goals"]
    found = next((x for x in goals if x["id"] == gid), None)
    rec(found is not None, "GET /goals contains the goal")
    if found:
        rec(found.get("xp_awarded_on_complete") == 150,
            "admin: GET /goals xp_awarded_on_complete==150 persisted",
            f"got {found.get('xp_awarded_on_complete')}")

    # Stats: today's goal_xp should be at least +150 from this goal
    today_iso = datetime.now(timezone.utc).date().isoformat()
    sw = requests.get(f"{BACKEND_URL}/stats/weekly", headers=h(admin_token), timeout=15).json()
    today_row = next((d for d in sw["days"] if d["date"] == today_iso), None)
    if today_row:
        rec(today_row.get("goal_xp", 0) >= 150,
            "admin stats/weekly today.goal_xp >= 150 (this goal's contribution)",
            f"goal_xp={today_row.get('goal_xp')} (other goals may add more)")

    # Un-tick
    r = requests.post(f"{BACKEND_URL}/goals/{gid}/progress", headers=h(admin_token),
                      json={"current_value":0}, timeout=15)
    rec(r.status_code == 200, "admin un-tick: status 200")
    body = r.json()
    rec(body.get("completed") is False, "admin un-tick: completed=false")
    rec(body.get("refunded_xp") == 150, "admin un-tick: refunded_xp==150", f"got {body.get('refunded_xp')}")

    p_after = requests.get(f"{BACKEND_URL}/profile", headers=h(admin_token), timeout=15).json()
    xp_after = int(p_after.get("total_xp") or 0)
    rec(xp_mid - xp_after == 150, "admin un-tick: total_xp decreases by EXACTLY 150",
        f"delta={xp_mid - xp_after}")
    rec(xp_after == xp_before, "admin full round-trip: net XP change == 0 (no drift)",
        f"before={xp_before} after={xp_after}")

    # Cleanup: delete the test goal so admin's stats stay clean
    requests.delete(f"{BACKEND_URL}/goals/{gid}", headers=h(admin_token), timeout=15)

    print(f"\nPASS: {len(P)}  FAIL: {len(F)}")
    for x in F: print(f"  FAIL: {x}")
    return 0 if not F else 1


if __name__ == "__main__":
    sys.exit(main())
