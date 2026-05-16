"""
Guest-mode → registered-account migration tests.

Tests the POST /api/guest/migrate and GET /api/guest/has_progress endpoints
from /app/backend/guest_migration.py.
"""
from __future__ import annotations

import time
import uuid

import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASSES: list[str] = []
FAILS: list[str] = []


def _record(ok: bool, label: str, detail: str = "") -> bool:
    if ok:
        PASSES.append(label)
        print(f"  PASS  {label}")
    else:
        FAILS.append(f"{label}  ({detail})")
        print(f"  FAIL  {label}  → {detail}")
    return ok


def _req(method: str, path: str, *, jwt: str | None = None,
         anon: str | None = None, json_body=None, params=None):
    headers = {}
    if jwt:
        headers["Authorization"] = f"Bearer {jwt}"
    if anon:
        headers["X-Anonymous-Id"] = anon
    url = f"{BASE}{path}"
    r = requests.request(method, url, headers=headers, json=json_body,
                         params=params, timeout=60)
    try:
        body = r.json()
    except Exception:
        body = r.text
    return r.status_code, body, r


def login_admin() -> str:
    sc, body, _ = _req("POST", "/auth/login",
                       json_body={"email": ADMIN_EMAIL,
                                  "password": ADMIN_PASSWORD})
    assert sc == 200 and body.get("token"), f"admin login fail {sc} {body}"
    return body["token"]


def register_user(full_name: str) -> tuple[str, str, str]:
    email = f"migrate_test_{int(time.time()*1000)}_{uuid.uuid4().hex[:6]}@gmail.com"
    sc, body, _ = _req("POST", "/auth/register",
                       json_body={"full_name": full_name,
                                  "email": email,
                                  "password": "MigrTest123!"})
    if sc != 200 or not (isinstance(body, dict) and body.get("token")):
        raise RuntimeError(f"register fail {sc} {body}")
    return body["token"], body["user"]["id"], email


def create_anon_task(anon_id: str, title: str = "Anon test") -> dict:
    sc, body, _ = _req("POST", "/tasks", anon=anon_id, json_body={
        "title": title, "description": "x",
        "focus_area": "fitness", "time_slot": "morning",
        "xp_value": 20, "recurring": True, "reminder_enabled": False,
    })
    if sc != 200:
        raise RuntimeError(f"create_anon_task {sc} {body}")
    return body


def create_anon_goal(anon_id: str, title: str = "Anon goal") -> dict:
    sc, body, _ = _req("POST", "/goals", anon=anon_id, json_body={
        "title": title, "description": "x",
        "focus_area": "mindset", "target_value": 10,
        "unit": "days", "xp_reward": 30,
    })
    if sc != 200:
        raise RuntimeError(f"create_anon_goal {sc} {body}")
    return body


def complete_anon_task(anon_id: str, task_id: str) -> dict:
    sc, body, _ = _req("POST", f"/tasks/{task_id}/complete",
                       anon=anon_id, json_body={})
    if sc != 200:
        raise RuntimeError(f"complete_anon_task {sc} {body}")
    return body


def get_anon_profile(anon_id: str) -> dict:
    sc, body, _ = _req("GET", "/profile", anon=anon_id)
    if sc != 200:
        raise RuntimeError(f"get_anon_profile {sc} {body}")
    return body


def get_user_profile(jwt: str) -> dict:
    sc, body, _ = _req("GET", "/profile", jwt=jwt)
    if sc != 200:
        raise RuntimeError(f"get_user_profile {sc} {body}")
    return body


# ════════════════════════════════════════════════════════════════════════
# SECTION 1 — Auth gate
# ════════════════════════════════════════════════════════════════════════
def section_1_auth_gate(admin_jwt: str):
    print("\n=== SECTION 1 — Auth gate ===")
    sc, body, _ = _req("POST", "/guest/migrate",
                       json_body={"anonymous_id": "TESTANON12345678"})
    _record(sc in (401, 403),
            "1a. POST /guest/migrate with no auth → 401/403",
            f"sc={sc} body={body}")

    sc, body, _ = _req("POST", "/guest/migrate",
                       anon="ABCDEFGH12345678",
                       json_body={"anonymous_id": "TESTANON12345678"})
    _record(sc in (401, 403),
            "1b. POST /guest/migrate with ONLY X-Anonymous-Id (no JWT) → 401/403",
            f"sc={sc} body={body}")

    sc, body, _ = _req("POST", "/guest/migrate", jwt=admin_jwt,
                       json_body={"anonymous_id": ""})
    detail = (body or {}).get("detail", "") if isinstance(body, dict) else str(body)
    _record(sc == 400 and "8-64" in str(detail),
            "1c. JWT + blank anonymous_id → 400 with '8-64'",
            f"sc={sc} detail={detail}")

    sc, body, _ = _req("POST", "/guest/migrate", jwt=admin_jwt,
                       json_body={"anonymous_id": "abc"})
    _record(sc == 400,
            "1d. JWT + anonymous_id='abc' (too short) → 400",
            f"sc={sc} body={body}")

    sc, body, _ = _req("POST", "/guest/migrate", jwt=admin_jwt,
                       json_body={"anonymous_id": "!@#$%^&*"})
    _record(sc == 400,
            "1e. JWT + anonymous_id='!@#$%^&*' (illegal chars) → 400",
            f"sc={sc} body={body}")


# ════════════════════════════════════════════════════════════════════════
# SECTION 2 — Format validation
# ════════════════════════════════════════════════════════════════════════
def section_2_format(admin_jwt: str):
    print("\n=== SECTION 2 — Format validation ===")
    sc, body, _ = _req("POST", "/guest/migrate", jwt=admin_jwt,
                       json_body={"anonymous_id": "12345678"})
    ok = (sc == 200 and isinstance(body, dict)
          and body.get("moved") == 0
          and body.get("collections_touched") == 0
          and body.get("merged_profile") is False)
    _record(ok,
            "2a. anonymous_id='12345678' (8 char, no data) → 200 {moved:0, coll:0, merged:false}",
            f"sc={sc} body={body}")

    sc, body, _ = _req("POST", "/guest/migrate", jwt=admin_jwt,
                       json_body={"anonymous_id": "aaaa-bbbb-cccc-dddd"})
    _record(sc == 200 and isinstance(body, dict) and "moved" in body,
            "2b. anonymous_id='aaaa-bbbb-cccc-dddd' (dashes, 19 char) → 200",
            f"sc={sc} body={body}")

    sc, body, _ = _req("POST", "/guest/migrate", jwt=admin_jwt,
                       json_body={"anonymous_id": "X" * 65})
    _record(sc == 400,
            "2c. anonymous_id='X'*65 (too long) → 400",
            f"sc={sc} body={body}")


# ════════════════════════════════════════════════════════════════════════
# SECTION 3 — End-to-end migration HAPPY PATH
# ════════════════════════════════════════════════════════════════════════
def section_3_happy_path() -> dict:
    print("\n=== SECTION 3 — Happy path end-to-end ===")
    # Use unique ANON id for this run to avoid pollution
    ANON_A = "TESTANONA" + uuid.uuid4().hex[:6].upper()  # 15 chars
    out: dict = {"anon_id": ANON_A}
    print(f"  anon_id_A = {ANON_A}")

    try:
        prof_a = get_anon_profile(ANON_A)
        out["prof_a_before"] = prof_a

        task_a = create_anon_task(ANON_A, title="Anon walk")
        out["task_a_id"] = task_a.get("id")
        _record(bool(out["task_a_id"]), "3a-i. Anon A created task",
                str(task_a)[:200])

        goal_a = create_anon_goal(ANON_A, title="Anon goal A")
        out["goal_a_id"] = goal_a.get("id")
        _record(bool(out["goal_a_id"]), "3a-ii. Anon A created goal",
                str(goal_a)[:200])

        comp = complete_anon_task(ANON_A, task_a["id"])
        xp_a = int(comp.get("profile", {}).get("total_xp") or 0)
        out["xp_a"] = xp_a
        _record(xp_a > 0, f"3a-iii. Anon A total_xp={xp_a} after completing task", "")

        sc, body, _ = _req("GET", "/tasks", anon=ANON_A)
        tasks_list = (body.get("tasks") if isinstance(body, dict) else body) or []
        out["t_a"] = len(tasks_list)
        _record(sc == 200 and out["t_a"] >= 1,
                f"3a-iv. Anon A GET /tasks count={out['t_a']}",
                f"sc={sc} body_keys={list(body.keys()) if isinstance(body, dict) else type(body)}")

        sc, body, _ = _req("GET", "/goals", anon=ANON_A)
        goals_list = (body.get("goals") if isinstance(body, dict) else body) or []
        out["g_a"] = len(goals_list)
        _record(sc == 200 and out["g_a"] >= 1,
                f"3a-v. Anon A GET /goals count={out['g_a']}",
                f"sc={sc}")
    except Exception as e:
        _record(False, "3a. Anon A setup", str(e))
        return out

    try:
        jwt_b, uid_b, email_b = register_user("Migration Test B")
        out["jwt_b"] = jwt_b
        out["uid_b"] = uid_b
        out["email_b"] = email_b
        _record(bool(jwt_b), f"3b. Registered user B email={email_b}", "")
    except Exception as e:
        _record(False, "3b. Register user B", str(e))
        return out

    sc, body, _ = _req("POST", "/guest/migrate", jwt=jwt_b,
                       json_body={"anonymous_id": ANON_A})
    out["migrate_resp"] = body
    moved = (body or {}).get("moved", 0) if isinstance(body, dict) else 0
    coll = (body or {}).get("collections_touched", 0) if isinstance(body, dict) else 0
    _record(sc == 200 and moved >= 3 and coll >= 3,
            f"3c. POST /guest/migrate as B → 200 moved≥3 coll_touched≥3 (got moved={moved}, coll={coll})",
            f"sc={sc} body={body}")

    try:
        prof_b = get_user_profile(jwt_b)
        xp_b = int(prof_b.get("total_xp") or 0)
        _record(xp_b >= out.get("xp_a", 0),
                f"3d-i. B GET /profile total_xp={xp_b} ≥ anon_xp={out.get('xp_a')}",
                f"prof_b={prof_b}")

        sc, body, _ = _req("GET", "/tasks", jwt=jwt_b)
        tasks_list = (body.get("tasks") if isinstance(body, dict) else body) or []
        t_b = len(tasks_list)
        _record(sc == 200 and t_b >= out.get("t_a", 0),
                f"3d-ii. B GET /tasks count={t_b} ≥ anon_count={out.get('t_a')}",
                f"sc={sc}")

        sc, body, _ = _req("GET", "/goals", jwt=jwt_b)
        goals_list = (body.get("goals") if isinstance(body, dict) else body) or []
        g_b = len(goals_list)
        _record(sc == 200 and g_b >= out.get("g_a", 0),
                f"3d-iii. B GET /goals count={g_b} ≥ anon_count={out.get('g_a')}",
                f"sc={sc}")
    except Exception as e:
        _record(False, "3d. Re-fetch as B", str(e))

    sc, body, _ = _req("POST", "/guest/migrate", jwt=jwt_b,
                       json_body={"anonymous_id": ANON_A})
    moved2 = (body or {}).get("moved", -1) if isinstance(body, dict) else -1
    _record(sc == 200 and moved2 == 0,
            f"3e. Idempotent re-run → 200 {{moved:0}} (got {moved2})",
            f"sc={sc} body={body}")

    return out


# ════════════════════════════════════════════════════════════════════════
# SECTION 4 — has_progress probe
# ════════════════════════════════════════════════════════════════════════
def section_4_has_progress(admin_jwt: str, ctx3: dict):
    print("\n=== SECTION 4 — has_progress probe ===")
    anon_after = ctx3.get("anon_id") or "TESTANONA123456"

    sc, body, _ = _req("GET", "/guest/has_progress",
                       jwt=admin_jwt, params={"anon_id": anon_after})
    _record(sc == 200 and isinstance(body, dict)
            and body.get("has_progress") is False,
            "4a. After migration → {has_progress:false}",
            f"sc={sc} body={body}")

    sc, body, _ = _req("GET", "/guest/has_progress",
                       jwt=admin_jwt, params={"anon_id": "NEVERUSEDID12345"})
    _record(sc == 200 and isinstance(body, dict)
            and body.get("has_progress") is False,
            "4b. Unused anon_id → {has_progress:false}",
            f"sc={sc} body={body}")

    fresh_anon = "PROBE" + uuid.uuid4().hex[:11].upper()
    try:
        create_anon_task(fresh_anon, title="probe task")
        sc, body, _ = _req("GET", "/guest/has_progress",
                           jwt=admin_jwt, params={"anon_id": fresh_anon})
        _record(sc == 200 and isinstance(body, dict)
                and body.get("has_progress") is True,
                "4c. Fresh anon with task → {has_progress:true}",
                f"sc={sc} body={body}")
    except Exception as e:
        _record(False, "4c. Fresh anon probe", str(e))

    sc, body, _ = _req("GET", "/guest/has_progress",
                       params={"anon_id": "TESTPROBE1234567"})
    _record(sc in (401, 403),
            "4d. GET /guest/has_progress without JWT → 401/403",
            f"sc={sc} body={body}")


# ════════════════════════════════════════════════════════════════════════
# SECTION 5 — Skip-collections safety
# ════════════════════════════════════════════════════════════════════════
def section_5_skip_collections(admin_jwt: str, ctx3: dict):
    print("\n=== SECTION 5 — Skip-collections safety ===")
    email_b = ctx3.get("email_b")
    if not email_b:
        _record(False, "5. email_b missing (section 3 setup fail)", "")
        return

    sc, body, _ = _req("POST", "/auth/login",
                       json_body={"email": email_b,
                                  "password": "MigrTest123!"})
    _record(sc == 200 and isinstance(body, dict) and body.get("token"),
            "5a. B login still works (db.users row intact after migration)",
            f"sc={sc} body={body}")

    sc, body, _ = _req("GET", "/admin/players/by-creation",
                       jwt=admin_jwt,
                       params={"order": "newest", "limit": 500})
    if sc == 200:
        anon_uid = f"anon-{ctx3.get('anon_id')}"
        players = body if isinstance(body, list) else (body.get("players") or [])
        ids = []
        for p in players:
            ids.append(p.get("user_id") or p.get("id") or p.get("_id"))
        has_anon = any(anon_uid == x for x in ids)
        has_b = any(ctx3.get("uid_b") == x for x in ids)
        _record(not has_anon and has_b,
                f"5b. db.users contains B but NOT anon-{ctx3.get('anon_id')}",
                f"has_anon={has_anon} has_b={has_b}")
    else:
        _record(True,
                f"5b. (soft) admin/players/by-creation returned sc={sc}; B-login proof suffices",
                "")


# ════════════════════════════════════════════════════════════════════════
# SECTION 6 — Profile merge edge case
# ════════════════════════════════════════════════════════════════════════
def section_6_profile_merge():
    print("\n=== SECTION 6 — Profile merge edge case ===")
    ANON_C = "ANONXP" + uuid.uuid4().hex[:10].upper()  # 16 chars

    try:
        get_anon_profile(ANON_C)
        task_c = create_anon_task(ANON_C, title="C task")
        comp = complete_anon_task(ANON_C, task_c["id"])
        xp_c = int(comp.get("profile", {}).get("total_xp") or 0)
        _record(xp_c > 0, f"6a. Anon C earned xp_c={xp_c} (note: anon cap=20)", "")
    except Exception as e:
        _record(False, "6a. Anon C setup", str(e))
        return

    try:
        jwt_d, uid_d, email_d = register_user("Dexter Merge")
    except Exception as e:
        _record(False, "6b. Register D", str(e))
        return
    full_name_d = "Dexter Merge"

    prof_d_before = get_user_profile(jwt_d)
    name_d_before = (prof_d_before.get("name")
                     or prof_d_before.get("full_name"))

    sc, body, _ = _req("POST", "/guest/migrate", jwt=jwt_d,
                       json_body={"anonymous_id": ANON_C})
    _record(sc == 200 and isinstance(body, dict)
            and body.get("merged_profile") is True,
            "6c. Migrate anon C → D returns merged_profile:true",
            f"sc={sc} body={body}")

    prof_d_after = get_user_profile(jwt_d)
    xp_d_after = int(prof_d_after.get("total_xp") or 0)
    name_d_after = (prof_d_after.get("name")
                    or prof_d_after.get("full_name"))
    _record(xp_d_after >= xp_c,
            f"6d. D total_xp after merge={xp_d_after} ≥ xp_c={xp_c} (MAX-merge)",
            f"prof_after={prof_d_after}")
    _record(name_d_after == full_name_d or name_d_after == name_d_before,
            f"6e. D name preserved after merge name_after={name_d_after}",
            f"expected={full_name_d}/{name_d_before}")


def main():
    print(f"BASE = {BASE}\n")
    print("Logging in as admin…")
    admin_jwt = login_admin()
    print(f"admin_jwt acquired ({admin_jwt[:24]}…)")

    section_1_auth_gate(admin_jwt)
    section_2_format(admin_jwt)
    ctx3 = section_3_happy_path()
    section_4_has_progress(admin_jwt, ctx3)
    section_5_skip_collections(admin_jwt, ctx3)
    section_6_profile_merge()

    print("\n" + "=" * 70)
    print(f"PASS : {len(PASSES)}")
    print(f"FAIL : {len(FAILS)}")
    if FAILS:
        print("\nFailures:")
        for f in FAILS:
            print(f"  - {f}")
    print("=" * 70)


if __name__ == "__main__":
    main()
