"""
Test for GET /api/friends/profile/{other_id}/details (friend-gated profile detail).

Test plan steps 1-9 from the review request.
"""
import os
import sys
import time
import uuid
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"

PASS = 0
FAIL = 0
FAILURES = []


def check(label: str, cond: bool, info: str = ""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {label}")
    else:
        FAIL += 1
        FAILURES.append(f"{label}{(' :: ' + info) if info else ''}")
        print(f"  ❌ {label}{(' :: ' + info) if info else ''}")


def register(name: str):
    suffix = uuid.uuid4().hex[:10]
    email = f"{name.lower().replace(' ', '.')}.{suffix}@gmail.com"
    payload = {"full_name": name, "email": email, "password": "Secret123!aB"}
    r = requests.post(f"{BASE}/auth/register", json=payload, timeout=30)
    if r.status_code != 200:
        raise SystemExit(f"register {name} failed: {r.status_code} {r.text}")
    body = r.json()
    token = body.get("token") or body.get("access_token")
    user = body.get("user") or {}
    user_id = user.get("user_id") or user.get("id")
    if not token or not user_id:
        raise SystemExit(f"register {name} unexpected payload: {body}")
    return {"name": name, "email": email, "password": payload["password"], "token": token, "user_id": user_id}


def hdr(u):
    return {"Authorization": f"Bearer {u['token']}"}


def main():
    print("=== Step 1: register A and B ===")
    A = register("Nina Chen")
    B = register("Oliver Park")
    print(f"  A.user_id={A['user_id']}")
    print(f"  B.user_id={B['user_id']}")

    print("\n=== Step 2: A → details(B) before friendship → 403 ===")
    r = requests.get(f"{BASE}/friends/profile/{B['user_id']}/details", headers=hdr(A), timeout=30)
    check("status==403", r.status_code == 403, f"got {r.status_code} body={r.text[:200]}")
    if r.status_code == 403:
        try:
            detail = (r.json() or {}).get("detail", "")
        except Exception:
            detail = r.text
        check("detail mentions 'friend'", "friend" in str(detail).lower(), f"detail={detail!r}")

    print("\n=== Step 3: send + accept friend request ===")
    r = requests.post(f"{BASE}/friends/request", headers=hdr(A), json={"user_id": B["user_id"]}, timeout=30)
    check("A POST /friends/request → 200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")
    r = requests.post(f"{BASE}/friends/accept", headers=hdr(B), json={"user_id": A["user_id"]}, timeout=30)
    check("B POST /friends/accept → 200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")
    if r.status_code == 200:
        try:
            ab = r.json()
            check("accept body status=='friends'", ab.get("status") == "friends", f"status={ab.get('status')!r}")
        except Exception as e:
            check("accept body parses JSON", False, str(e))

    print("\n=== Step 4: A → details(B) after friendship → 200 + shape ===")
    r = requests.get(f"{BASE}/friends/profile/{B['user_id']}/details", headers=hdr(A), timeout=30)
    check("status==200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")
    if r.status_code == 200:
        body = r.json()
        check("user_id == B", body.get("user_id") == B["user_id"], f"got {body.get('user_id')!r}")
        check("is_self == False", body.get("is_self") is False, f"got {body.get('is_self')!r}")

        ma = body.get("mini_apps")
        check("mini_apps is list", isinstance(ma, list))
        if isinstance(ma, list):
            check("mini_apps len==3", len(ma) == 3, f"got {len(ma)}")
            ids = sorted([m.get("id") for m in ma])
            check("mini_apps ids == {sleep, challenges, spot}", ids == ["challenges", "sleep", "spot"], f"got {ids}")
            required_keys = {"id", "title", "icon", "color", "description", "stat_label", "active"}
            for m in ma:
                missing = required_keys - set(m.keys())
                check(f"mini_app[{m.get('id')}] has all keys", not missing, f"missing={missing}")

        tasks = body.get("tasks")
        check("tasks is non-empty list", isinstance(tasks, list) and len(tasks) > 0, f"len={len(tasks) if isinstance(tasks, list) else 'NA'}")
        if isinstance(tasks, list) and tasks:
            req_t = {"id", "title", "description", "focus_area", "time_slot", "xp_value", "is_default", "recurring"}
            sample = tasks[0]
            missing_t = req_t - set(sample.keys())
            check("task has required keys", not missing_t, f"missing={missing_t} sample={sample}")
            defaults_with_desc = [t for t in tasks if t.get("is_default") and (t.get("description") or "").strip()]
            check("≥1 default task with non-empty description", len(defaults_with_desc) >= 1,
                  f"defaults_with_desc={len(defaults_with_desc)}")

        goals = body.get("goals")
        check("goals is list", isinstance(goals, list))

        counts = body.get("counts")
        check("counts is dict", isinstance(counts, dict))
        if isinstance(counts, dict):
            req_c = {"tasks_total", "tasks_default", "tasks_custom", "goals_total", "goals_active", "goals_completed"}
            missing_c = req_c - set(counts.keys())
            check("counts has all keys", not missing_c, f"missing={missing_c}")
            check("counts.tasks_total == len(tasks)",
                  counts.get("tasks_total") == len(tasks or []),
                  f"counts.tasks_total={counts.get('tasks_total')} vs len={len(tasks or [])}")
            expected_def = sum(1 for t in (tasks or []) if t.get("is_default"))
            check("counts.tasks_default == sum(is_default)",
                  counts.get("tasks_default") == expected_def,
                  f"counts.tasks_default={counts.get('tasks_default')} vs expected={expected_def}")
            check("counts.goals_total == len(goals)",
                  counts.get("goals_total") == len(goals or []),
                  f"counts.goals_total={counts.get('goals_total')} vs len={len(goals or [])}")

    print("\n=== Step 5: A → details(A) → 200 with is_self=True (no friendship) ===")
    r = requests.get(f"{BASE}/friends/profile/{A['user_id']}/details", headers=hdr(A), timeout=30)
    check("self-call status==200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        body = r.json()
        check("self-call body.is_self == True", body.get("is_self") is True, f"got {body.get('is_self')!r}")
        check("self-call body.user_id == A", body.get("user_id") == A["user_id"], f"got {body.get('user_id')!r}")

    print("\n=== Step 6: A creates a goal, then re-fetch self details ===")
    goal_payload = {
        "title": "Run a marathon",
        "description": "Train 3x week",
        "focus_area": "fitness",
        "target_value": 30,
        "unit": "days",
        "xp_reward": 30,
    }
    r = requests.post(f"{BASE}/goals", headers=hdr(A), json=goal_payload, timeout=30)
    check("POST /goals → 200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")

    r = requests.get(f"{BASE}/friends/profile/{A['user_id']}/details", headers=hdr(A), timeout=30)
    check("re-fetch self details → 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        body = r.json()
        goals = body.get("goals") or []
        match = next((g for g in goals if (g.get("title") or "").strip() == "Run a marathon"), None)
        check("new goal appears in goals[]", match is not None, f"goals_titles={[g.get('title') for g in goals]}")
        if match:
            check("goal.target_value == 30", int(match.get("target_value") or 0) == 30, f"got {match.get('target_value')!r}")
            check("goal.unit == 'days'", match.get("unit") == "days", f"got {match.get('unit')!r}")
            check("goal.completed == False", match.get("completed") is False, f"got {match.get('completed')!r}")
            check("goal.current_value == 0", int(match.get("current_value") or 0) == 0, f"got {match.get('current_value')!r}")
            check("goal.xp_reward == 30", int(match.get("xp_reward") or 0) == 30, f"got {match.get('xp_reward')!r}")
        counts = body.get("counts") or {}
        check("counts.goals_total ≥ 1", int(counts.get("goals_total") or 0) >= 1, f"got {counts.get('goals_total')!r}")
        check("counts.goals_active ≥ 1", int(counts.get("goals_active") or 0) >= 1, f"got {counts.get('goals_active')!r}")

    print("\n=== Step 7: B → details(A) (mutual visibility) → 200 ===")
    r = requests.get(f"{BASE}/friends/profile/{A['user_id']}/details", headers=hdr(B), timeout=30)
    check("B→A details status==200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")
    if r.status_code == 200:
        body = r.json()
        check("B→A body.is_self == False", body.get("is_self") is False, f"got {body.get('is_self')!r}")
        check("B→A body.user_id == A", body.get("user_id") == A["user_id"], f"got {body.get('user_id')!r}")

    print("\n=== Step 8: register C (no friendship) → A details = 403 ===")
    C = register("Mara Lopez")
    r = requests.get(f"{BASE}/friends/profile/{A['user_id']}/details", headers=hdr(C), timeout=30)
    check("C→A details status==403", r.status_code == 403, f"got {r.status_code} body={r.text[:200]}")
    if r.status_code == 403:
        try:
            detail = (r.json() or {}).get("detail", "")
        except Exception:
            detail = r.text
        check("C→A detail mentions 'friend'", "friend" in str(detail).lower(), f"detail={detail!r}")

    print("\n=== Step 9: light regression sanity ===")
    r = requests.get(f"{BASE}/profile", headers=hdr(A), timeout=30)
    check("GET /profile (auth) → 200", r.status_code == 200, f"got {r.status_code}")

    r = requests.post(f"{BASE}/auth/login", json={"email": A["email"], "password": A["password"]}, timeout=30)
    check("POST /auth/login (correct) → 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")

    r = requests.get(f"{BASE}/friends/list", headers=hdr(A), timeout=30)
    check("GET /friends/list → 200", r.status_code == 200, f"got {r.status_code}")
    if r.status_code == 200:
        try:
            ll = r.json()
            friends = ll.get("friends") or ll.get("accepted") or []
            check("friends list contains B", any((f.get("user_id") == B["user_id"]) for f in friends),
                  f"friends_user_ids={[f.get('user_id') for f in friends]}")
        except Exception as e:
            check("friends list parses JSON", False, str(e))

    print(f"\n=== RESULT: {PASS} pass / {FAIL} fail ===")
    if FAILURES:
        print("FAILURES:")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)


if __name__ == "__main__":
    main()
