"""Backend tests for 4 newly-added/modified features:
1. 200-level XP system (/api/levels + level computed in profile)
2. Un-tick restored (uncomplete refunds XP)
3. Custom task XP cap = 20 (POST/PUT)
4. Anonymous mode via X-Anonymous-Id header
"""
import sys
import uuid
import requests
from datetime import datetime, timezone

BASE = "https://xp-confidence.preview.emergentagent.com/api"

results = []


def record(name, ok, info=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name} :: {info}")
    results.append((name, ok, info))


def post(path, json=None, headers=None):
    return requests.post(BASE + path, json=json or {}, headers=headers or {}, timeout=30)


def get(path, headers=None):
    return requests.get(BASE + path, headers=headers or {}, timeout=30)


def put(path, json=None, headers=None):
    return requests.put(BASE + path, json=json or {}, headers=headers or {}, timeout=30)


def register_and_verify(full_name, email, password):
    r = post("/auth/register", {"full_name": full_name, "email": email, "password": password})
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    code = r.json().get("dev_code")
    assert code, f"no dev_code returned: {r.text}"
    r2 = post("/auth/verify", {"email": email, "code": code})
    assert r2.status_code == 200, f"verify failed: {r2.status_code} {r2.text}"
    body = r2.json()
    return body["token"], body["user"]


# ===================================================================
# 1. 200-level XP system
# ===================================================================
def test_levels_endpoint():
    print("\n=== Test 1: 200-level XP system ===")
    r = get("/levels")
    if r.status_code != 200:
        record("GET /levels returns 200", False, f"{r.status_code} {r.text}")
        return
    record("GET /levels returns 200", True)
    data = r.json()

    record(
        "max_level == 200",
        data.get("max_level") == 200,
        f"got {data.get('max_level')}",
    )
    record(
        "total_xp_cap == 1000000",
        data.get("total_xp_cap") == 1_000_000,
        f"got {data.get('total_xp_cap')}",
    )
    formula = data.get("formula", "")
    record(
        "formula contains '49.6 * L^1.87'",
        "49.6" in formula and "1.87" in formula,
        f"formula='{formula}'",
    )

    levels = data.get("levels") or []
    record("levels list has 200 entries", len(levels) == 200, f"got {len(levels)}")

    if len(levels) == 200:
        sample = levels[0]
        record(
            "level entry has level/cum_xp/delta_to_reach",
            all(k in sample for k in ("level", "cum_xp", "delta_to_reach")),
            f"keys={list(sample.keys())}",
        )

        l1 = levels[0]
        l50 = levels[49]
        l200 = levels[199]
        record("L1 cum_xp == 0", l1["cum_xp"] == 0, f"got {l1['cum_xp']}")
        record(
            "L50 cum_xp ~75000 (73000-76000)",
            73000 <= l50["cum_xp"] <= 76000,
            f"got {l50['cum_xp']}",
        )
        record(
            "L200 cum_xp ~996000 (990000-1000000)",
            990000 <= l200["cum_xp"] <= 1_000_000,
            f"got {l200['cum_xp']}",
        )


def test_level_grows_in_profile():
    print("\n=== Test 1b: Profile level reflects XP ===")
    email = f"levels_{uuid.uuid4().hex[:8]}@xprealgame.io"
    token, user = register_and_verify("Level Tester", email, "TestPass123!")
    h = {"Authorization": f"Bearer {token}"}

    r = get("/profile", headers=h)
    if r.status_code != 200:
        record("Initial profile 200", False, f"{r.status_code} {r.text}")
        return
    p = r.json()
    record(
        "Initial level==1, xp==0",
        p.get("level") == 1 and p.get("total_xp") == 0,
        f"level={p.get('level')} xp={p.get('total_xp')}",
    )

    r = get("/tasks", headers=h)
    if r.status_code != 200:
        record("List tasks 200", False, r.text)
        return
    tasks = r.json().get("tasks", [])
    record("Default tasks seeded for new user", len(tasks) >= 8, f"got {len(tasks)}")

    cum5 = round(49.6 * (5 ** 1.87))
    record(
        "Computed L5 cum_xp from formula matches spec (~1006)",
        1000 <= cum5 <= 1015,
        f"cum5={cum5}",
    )
    levels_resp = get("/levels").json().get("levels", [])
    if levels_resp:
        lvl_for_1000 = 1
        for row in levels_resp:
            if row["cum_xp"] <= 1000:
                lvl_for_1000 = row["level"]
            else:
                break
        record(
            "1000 XP -> level 5 per /levels table",
            lvl_for_1000 == 5,
            f"level for 1000 XP = {lvl_for_1000}",
        )

    today = datetime.now(timezone.utc).date().isoformat()
    total_xp_gained = 0
    for t in tasks[:4]:
        r = post(f"/tasks/{t['id']}/complete", {"date": today}, headers=h)
        if r.status_code == 200:
            total_xp_gained += r.json().get("xp_awarded", 0)
    r = get("/profile", headers=h)
    p = r.json()
    record(
        "XP increased after completing 4 tasks",
        p.get("total_xp") == total_xp_gained and total_xp_gained > 0,
        f"profile_xp={p.get('total_xp')} expected={total_xp_gained}",
    )
    record(
        "level field present and >=1",
        isinstance(p.get("level"), int) and p["level"] >= 1,
        f"level={p.get('level')}",
    )


# ===================================================================
# 2. Un-tick (uncomplete) restored
# ===================================================================
def test_uncomplete_refunds_xp():
    print("\n=== Test 2: Un-tick / uncomplete ===")
    email = f"untick_{uuid.uuid4().hex[:8]}@xprealgame.io"
    token, user = register_and_verify("Untick Tester", email, "TestPass123!")
    h = {"Authorization": f"Bearer {token}"}

    r = get("/tasks", headers=h)
    tasks = r.json().get("tasks", [])
    if not tasks:
        record("Default tasks present", False, "none")
        return
    task = tasks[0]

    today = datetime.now(timezone.utc).date().isoformat()
    p_before = get("/profile", headers=h).json()
    xp_before = p_before.get("total_xp", 0)

    r = post(f"/tasks/{task['id']}/complete", {"date": today}, headers=h)
    if r.status_code != 200:
        record("Complete task 200", False, f"{r.status_code} {r.text}")
        return
    cdata = r.json()
    awarded = cdata.get("xp_awarded", 0)
    record(
        "complete returns xp_awarded 15-40 (default range)",
        15 <= awarded <= 40,
        f"awarded={awarded}",
    )
    p_mid = get("/profile", headers=h).json()
    record(
        "profile XP increased by awarded amount",
        p_mid["total_xp"] == xp_before + awarded,
        f"before={xp_before} after={p_mid['total_xp']} awarded={awarded}",
    )

    r = post(f"/tasks/{task['id']}/uncomplete", {"date": today}, headers=h)
    record("uncomplete returns 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        ud = r.json()
        record(
            "uncomplete response has xp_removed field",
            "xp_removed" in ud,
            f"keys={list(ud.keys())}",
        )
        record(
            "xp_removed == awarded",
            ud.get("xp_removed") == awarded,
            f"xp_removed={ud.get('xp_removed')} awarded={awarded}",
        )

    p_after = get("/profile", headers=h).json()
    record(
        "profile XP rolled back to before",
        p_after["total_xp"] == xp_before,
        f"before={xp_before} after={p_after['total_xp']}",
    )

    r = get("/tasks", headers=h)
    tlist = r.json().get("tasks", [])
    target = next((t for t in tlist if t["id"] == task["id"]), None)
    record(
        "task back to completed=false",
        target is not None and target.get("completed") is False,
        f"task.completed={target.get('completed') if target else 'NOT-FOUND'}",
    )


# ===================================================================
# 3. Custom task XP cap = 20
# ===================================================================
def test_custom_task_xp_cap():
    print("\n=== Test 3: Custom task XP cap = 20 ===")
    email = f"xpcap_{uuid.uuid4().hex[:8]}@xprealgame.io"
    token, user = register_and_verify("XP Cap Tester", email, "TestPass123!")
    h = {"Authorization": f"Bearer {token}"}

    base_payload = {
        "description": "Test",
        "focus_area": "mindset",
        "time_slot": "morning",
        "recurring": True,
        "scheduled_time": "10:00",
        "reminder_enabled": True,
    }

    r = post("/tasks", {**base_payload, "title": "QC1", "xp_value": 150}, headers=h)
    record(
        "POST /tasks xp_value=150 -> 20 (capped)",
        r.status_code == 200 and r.json().get("xp_value") == 20,
        f"{r.status_code} body={r.text[:200]}",
    )

    r = post("/tasks", {**base_payload, "title": "QC2", "xp_value": 10}, headers=h)
    record(
        "POST /tasks xp_value=10 -> 10 (unchanged)",
        r.status_code == 200 and r.json().get("xp_value") == 10,
        f"{r.status_code} body={r.text[:200]}",
    )

    r = post("/tasks", {**base_payload, "title": "QC3", "xp_value": 20}, headers=h)
    custom_task_id = r.json()["id"] if r.status_code == 200 else None
    record(
        "POST /tasks xp_value=20 -> 20",
        r.status_code == 200 and r.json().get("xp_value") == 20,
        f"{r.status_code} body={r.text[:200]}",
    )

    if custom_task_id:
        r = put(f"/tasks/{custom_task_id}", {"xp_value": 999}, headers=h)
        record(
            "PUT custom task xp_value=999 -> 20 (capped)",
            r.status_code == 200 and r.json().get("xp_value") == 20,
            f"{r.status_code} body={r.text[:200]}",
        )

    r = get("/tasks", headers=h)
    tasks = r.json().get("tasks", [])
    default_task = next((t for t in tasks if t.get("is_default")), None)
    record("Found default task", default_task is not None)
    if default_task:
        r = put(f"/tasks/{default_task['id']}", {"xp_value": 80}, headers=h)
        record(
            "PUT default task xp_value=80 -> 80 (NOT capped)",
            r.status_code == 200 and r.json().get("xp_value") == 80,
            f"{r.status_code} body={r.text[:200]}",
        )

    # Defaults still allow 10-40 XP for fresh user
    email2 = f"xpcap2_{uuid.uuid4().hex[:8]}@xprealgame.io"
    token2, _ = register_and_verify("Default XP Tester", email2, "TestPass123!")
    h2 = {"Authorization": f"Bearer {token2}"}
    r = get("/tasks", headers=h2)
    if r.status_code == 200:
        tasks2 = r.json().get("tasks", [])
        workout = next((t for t in tasks2 if "Workout" in t.get("title", "")), None)
        record(
            "Default 'Workout session' has 40 XP (defaults unrestricted)",
            workout is not None and workout.get("xp_value") == 40,
            f"workout.xp={workout.get('xp_value') if workout else 'NOT-FOUND'}",
        )
        defaults = [t for t in tasks2 if t.get("is_default")]
        xps = [t["xp_value"] for t in defaults]
        record(
            "Default XP values within original 10-40 range",
            all(10 <= x <= 40 for x in xps) and len(xps) >= 8,
            f"xps={xps}",
        )


# ===================================================================
# 4. Anonymous mode via X-Anonymous-Id header
# ===================================================================
def test_anonymous_mode():
    print("\n=== Test 4: Anonymous mode via X-Anonymous-Id ===")
    r1 = get("/profile")
    record(
        "GET /profile no header -> 200 (main account)",
        r1.status_code == 200,
        f"{r1.status_code}",
    )
    main_profile = r1.json() if r1.status_code == 200 else {}
    main_xp = main_profile.get("total_xp")
    main_name = main_profile.get("name")

    anon_a = f"device-aaa-{uuid.uuid4().hex[:8]}"
    anon_b = f"device-bbb-{uuid.uuid4().hex[:8]}"

    ra = get("/profile", headers={"X-Anonymous-Id": anon_a})
    rb = get("/profile", headers={"X-Anonymous-Id": anon_b})
    record("anon A profile 200", ra.status_code == 200, f"{ra.status_code}")
    record("anon B profile 200", rb.status_code == 200, f"{rb.status_code}")

    # Create a custom task for anon A and complete it (anon mode does not auto-seed defaults)
    rt = get("/tasks", headers={"X-Anonymous-Id": anon_a})
    a_tasks = rt.json().get("tasks", []) if rt.status_code == 200 else []
    if not a_tasks:
        rc = post(
            "/tasks",
            {
                "title": "Anon A solo quest",
                "focus_area": "mindset",
                "time_slot": "morning",
                "xp_value": 20,
                "recurring": True,
                "reminder_enabled": True,
            },
            headers={"X-Anonymous-Id": anon_a},
        )
        if rc.status_code == 200:
            a_tasks = [rc.json()]

    if a_tasks:
        today = datetime.now(timezone.utc).date().isoformat()
        post(
            f"/tasks/{a_tasks[0]['id']}/complete",
            {"date": today},
            headers={"X-Anonymous-Id": anon_a},
        )

    pa2 = get("/profile", headers={"X-Anonymous-Id": anon_a}).json()
    pb2 = get("/profile", headers={"X-Anonymous-Id": anon_b}).json()
    record(
        "anon A and anon B have different profiles (data isolation)",
        pa2.get("total_xp", 0) != pb2.get("total_xp", 0),
        f"A.xp={pa2.get('total_xp')} B.xp={pb2.get('total_xp')}",
    )
    record(
        "anon B is fresh isolated profile (xp=0)",
        pb2.get("total_xp") == 0,
        f"B.xp={pb2.get('total_xp')}",
    )

    rs = get("/profile", headers={"X-Anonymous-Id": "ab"})
    record(
        "Too-short X-Anonymous-Id falls back to main",
        rs.status_code == 200 and rs.json().get("total_xp") == main_xp and rs.json().get("name") == main_name,
        f"short.xp={rs.json().get('total_xp') if rs.status_code == 200 else 'err'} main.xp={main_xp}",
    )

    email = f"jwtignore_{uuid.uuid4().hex[:8]}@xprealgame.io"
    token, user = register_and_verify("JWT Tester", email, "TestPass123!")
    rj = get(
        "/profile",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Anonymous-Id": "device-ignored-12345678",
        },
    )
    record(
        "Authenticated request ignores X-Anonymous-Id (uses JWT user)",
        rj.status_code == 200 and rj.json().get("name") == user["full_name"],
        f"name={rj.json().get('name')} expected={user['full_name']}",
    )
    record(
        "JWT user has fresh xp=0 (not anon's xp)",
        rj.status_code == 200 and rj.json().get("total_xp") == 0,
        f"xp={rj.json().get('total_xp')}",
    )


if __name__ == "__main__":
    try:
        test_levels_endpoint()
        test_level_grows_in_profile()
        test_uncomplete_refunds_xp()
        test_custom_task_xp_cap()
        test_anonymous_mode()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"\nFATAL: {e}")
        sys.exit(1)

    fails = [r for r in results if not r[1]]
    print("\n" + "=" * 60)
    print(f"TOTAL: {len(results)}  PASS: {len(results) - len(fails)}  FAIL: {len(fails)}")
    print("=" * 60)
    if fails:
        print("\nFAILURES:")
        for n, _, info in fails:
            print(f"  - {n} :: {info}")
        sys.exit(1)
    sys.exit(0)
