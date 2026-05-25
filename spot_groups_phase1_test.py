"""
Spot the Object — Permanent Groups (Phase 1) — backend test suite.

Tests the 6 endpoints under /api/spot/groups:
  POST   /spot/groups
  GET    /spot/groups
  GET    /spot/groups/{gid}
  POST   /spot/groups/{gid}/members
  POST   /spot/groups/{gid}/leave
  PATCH  /spot/groups/{gid}

Plus 1 regression check on legacy /spot/match/create.

Run:
    python /app/spot_groups_phase1_test.py
"""
from __future__ import annotations

import json
import secrets
import sys
import time
from typing import Dict, List, Optional

import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASS = 0
FAIL = 0
FAIL_DETAILS: List[str] = []


def _ok(msg: str):
    global PASS
    PASS += 1
    print(f"  ✅ {msg}")


def _fail(msg: str):
    global FAIL
    FAIL += 1
    FAIL_DETAILS.append(msg)
    print(f"  ❌ {msg}")


def assert_eq(actual, expected, msg: str):
    if actual == expected:
        _ok(f"{msg} (={actual!r})")
    else:
        _fail(f"{msg} — expected {expected!r}, got {actual!r}")


def assert_in(needle, haystack, msg: str):
    if needle in haystack:
        _ok(f"{msg} (found {needle!r})")
    else:
        _fail(f"{msg} — {needle!r} not in {haystack!r}")


def assert_true(cond, msg: str):
    if cond:
        _ok(msg)
    else:
        _fail(msg)


def post(path: str, token: Optional[str] = None, body: Optional[dict] = None, expect_status: Optional[int] = None) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = requests.post(BASE + path, headers=headers, data=json.dumps(body or {}), timeout=30)
    if expect_status is not None and r.status_code != expect_status:
        print(f"     [post {path}] status={r.status_code} body={r.text[:300]}")
    return r


def get(path: str, token: Optional[str] = None, expect_status: Optional[int] = None) -> requests.Response:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = requests.get(BASE + path, headers=headers, timeout=30)
    if expect_status is not None and r.status_code != expect_status:
        print(f"     [get {path}] status={r.status_code} body={r.text[:300]}")
    return r


def patch(path: str, token: Optional[str] = None, body: Optional[dict] = None) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = requests.patch(BASE + path, headers=headers, data=json.dumps(body or {}), timeout=30)
    return r


def register_user(full_name: str) -> Dict:
    """Create a fresh gmail.com user, return {token, user_id, email, password, full_name}."""
    suffix = secrets.token_hex(4)
    email = f"sg_{int(time.time())}_{suffix}@gmail.com"
    password = "SpotGrp123!" + secrets.token_hex(2)
    r = post("/auth/register", body={
        "email": email,
        "password": password,
        "full_name": full_name,
    })
    if r.status_code != 200:
        raise RuntimeError(f"register failed for {full_name}: {r.status_code} {r.text}")
    j = r.json()
    return {
        "token": j["token"],
        "user_id": j["user"]["id"],
        "email": email,
        "password": password,
        "full_name": full_name,
    }


def login_admin() -> Dict:
    r = post("/auth/login", body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code != 200:
        raise RuntimeError(f"admin login failed: {r.status_code} {r.text}")
    j = r.json()
    return {"token": j["token"], "user_id": j["user"]["id"], "email": ADMIN_EMAIL,
            "full_name": j["user"].get("full_name") or "Admin"}


def befriend(a: dict, b: dict):
    """A sends request to B, B accepts."""
    r1 = post("/friends/request", token=a["token"], body={"user_id": b["user_id"]})
    if r1.status_code != 200:
        raise RuntimeError(f"friend request failed {a['full_name']}→{b['full_name']}: {r1.status_code} {r1.text}")
    if r1.json().get("status") == "friends":
        return  # auto-accepted
    r2 = post("/friends/accept", token=b["token"], body={"user_id": a["user_id"]})
    if r2.status_code != 200:
        raise RuntimeError(f"friend accept failed {b['full_name']}←{a['full_name']}: {r2.status_code} {r2.text}")


# ─────────────────────────── MAIN ───────────────────────────
def main():
    print(f"\n{'='*70}\nSpot the Object — Permanent Groups (Phase 1) — backend test\n{'='*70}\n")

    # ── Setup: admin + 9 fresh users ────────────────────────
    print("\n── SETUP ─────────────────────────────────────────────\n")
    admin = login_admin()
    print(f"  admin user_id={admin['user_id']}")
    # 9 fresh gmail users
    A = register_user("Anna Spotter")
    B = register_user("Brian Spotter")
    C = register_user("Carla Spotter")
    D = register_user("Diana Spotter")
    E = register_user("Ethan Spotter")
    F = register_user("Felix Spotter")
    G = register_user("Greta Spotter")
    H = register_user("Henry Spotter")
    I = register_user("Iris Spotter")
    print(f"  registered A..I ({A['user_id'][:8]}..)")

    # Mutually befriend admin↔(A..G)
    for u in [A, B, C, D, E, F, G]:
        befriend(admin, u)
    print("  befriended admin↔A..G")

    # ── SECTION 1: Auth gate ────────────────────────────────
    print("\n── SECTION 1: Auth gate (no Bearer) ─────────────────\n")
    r = post("/spot/groups", body={"member_ids": [A["user_id"]]})
    assert_true(r.status_code in (401, 403), f"POST /spot/groups no-auth → 401/403 (got {r.status_code})")
    r = get("/spot/groups")
    assert_true(r.status_code in (401, 403), f"GET /spot/groups no-auth → 401/403 (got {r.status_code})")
    r = get(f"/spot/groups/fake-gid")
    assert_true(r.status_code in (401, 403), f"GET /spot/groups/{{gid}} no-auth → 401/403 (got {r.status_code})")
    r = post(f"/spot/groups/fake-gid/leave")
    assert_true(r.status_code in (401, 403), f"POST /spot/groups/{{gid}}/leave no-auth → 401/403 (got {r.status_code})")
    r = patch(f"/spot/groups/fake-gid", body={"name": "X"})
    assert_true(r.status_code in (401, 403), f"PATCH /spot/groups/{{gid}} no-auth → 401/403 (got {r.status_code})")

    # ── SECTION 2: Create validation ────────────────────────
    print("\n── SECTION 2: Create validation ─────────────────────\n")

    # 2a empty member_ids → 400 "Pick at least one friend"
    r = post("/spot/groups", token=admin["token"], body={"member_ids": []})
    assert_eq(r.status_code, 400, "2a empty member_ids status")
    if r.status_code == 400:
        detail = (r.json() or {}).get("detail", "")
        assert_in("at least one friend", detail.lower(), "2a detail mentions 'at least one friend'")

    # 2b member_ids not a list
    r = post("/spot/groups", token=admin["token"], body={"member_ids": "not-a-list"})
    assert_eq(r.status_code, 400, "2b non-list member_ids status")
    if r.status_code == 400:
        assert_in("must be a list", (r.json() or {}).get("detail", "").lower(), "2b detail says 'must be a list'")

    # 2c size cap — 8 invitees + admin = 9 → 400
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"], B["user_id"], C["user_id"], D["user_id"],
                       E["user_id"], F["user_id"], G["user_id"], H["user_id"]]
    })
    assert_eq(r.status_code, 400, "2c 8 invitees (+admin=9) status")
    if r.status_code == 400:
        detail = (r.json() or {}).get("detail", "")
        assert_in("at most 8", detail.lower(), "2c detail mentions 'at most 8'")

    # 2d only-strangers (admin is NOT friends with I) → 403
    r = post("/spot/groups", token=admin["token"], body={"member_ids": [I["user_id"]]})
    assert_eq(r.status_code, 403, "2d stranger invitee status")
    if r.status_code == 403:
        detail = (r.json() or {}).get("detail", "")
        assert_in("accepted friends", detail.lower(), "2d detail mentions 'accepted friends'")

    # 2e Happy path — 7 invitees + admin = 8 (cap)
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"], B["user_id"], C["user_id"], D["user_id"],
                       E["user_id"], F["user_id"], G["user_id"]]
    })
    assert_eq(r.status_code, 200, "2e create 8-member group status")
    if r.status_code != 200:
        print("     fatal — cannot proceed without group_1; aborting")
        _summarize()
        return
    g1 = r.json()["group"]
    group_1_id = g1["id"]
    print(f"     group_1_id={group_1_id}")
    assert_eq(g1["member_count"], 8, "2e group.member_count=8")
    assert_eq(g1["max_members"], 8, "2e group.max_members=8")
    assert_eq(g1["owner_id"], admin["user_id"], "2e owner_id=admin")
    assert_eq(g1["auto_challenge_on"], False, "2e auto_challenge_on=false")
    assert_eq(g1["last_challenge_at"], None, "2e last_challenge_at=null")
    assert_true(g1["name"].startswith("Spot Group"), f"2e default name starts with 'Spot Group' (got {g1['name']!r})")
    assert_eq(len(g1["members"]), 8, "2e members[] length=8")
    # Owner has role 'owner', others 'member'
    owner_rows = [m for m in g1["members"] if m["role"] == "owner"]
    assert_eq(len(owner_rows), 1, "2e exactly one owner row")
    if owner_rows:
        assert_eq(owner_rows[0]["user_id"], admin["user_id"], "2e owner row user_id=admin")
        assert_eq(owner_rows[0]["status"], "active", "2e owner row status=active")
    # All statuses 'active'
    statuses = [m["status"] for m in g1["members"]]
    assert_true(all(s == "active" for s in statuses), "2e all members status=active")

    # 2f Only-self invite — caller deduped to single id → len<2 → 400
    r = post("/spot/groups", token=admin["token"], body={"member_ids": [admin["user_id"]]})
    assert_eq(r.status_code, 400, "2f self-only invite status")
    if r.status_code == 400:
        assert_in("at least one friend", (r.json() or {}).get("detail", "").lower(),
                  "2f detail mentions 'at least one friend'")

    # 2g name truncation — 200-char name capped at 60
    long_name = "A very long group name that goes well past sixty characters " * 5
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"]], "name": long_name
    })
    assert_eq(r.status_code, 200, "2g long-name create status")
    if r.status_code == 200:
        g_long = r.json()["group"]
        assert_true(len(g_long["name"]) <= 60, f"2g name truncated to ≤60 (len={len(g_long['name'])})")
        # Leave it dangling — not used later.

    # ── SECTION 3: List & Get ───────────────────────────────
    print("\n── SECTION 3: List & Get ────────────────────────────\n")

    # 3a admin GET /spot/groups → contains both groups
    r = get("/spot/groups", token=admin["token"])
    assert_eq(r.status_code, 200, "3a admin GET /spot/groups status")
    if r.status_code == 200:
        groups = r.json()["groups"]
        ids = [g["id"] for g in groups]
        assert_in(group_1_id, ids, "3a group_1 in admin's list")
        assert_true(len(groups) >= 2, f"3a admin has ≥2 groups (got {len(groups)})")
        # Sorted DESC by created_at — the long-name group was created LAST so it should be first
        if len(groups) >= 2:
            t0 = groups[0]["created_at"]
            t1 = groups[1]["created_at"]
            assert_true(t0 >= t1, f"3a sorted DESC by created_at ({t0} >= {t1})")

    # 3b As B, GET /spot/groups — should contain group_1, not group_2
    r = get("/spot/groups", token=B["token"])
    assert_eq(r.status_code, 200, "3b B GET /spot/groups status")
    if r.status_code == 200:
        b_groups = r.json()["groups"]
        b_ids = [g["id"] for g in b_groups]
        assert_in(group_1_id, b_ids, "3b group_1 in B's list")

    # 3c As B, GET /spot/groups/{group_1_id} → 200 with all 8 active members
    r = get(f"/spot/groups/{group_1_id}", token=B["token"])
    assert_eq(r.status_code, 200, "3c B GET /spot/groups/{id} status")
    if r.status_code == 200:
        g = r.json()["group"]
        assert_eq(len(g["members"]), 8, "3c members[] length=8")
        assert_true(all(m["status"] == "active" for m in g["members"]),
                    "3c all members status=active")
        assert_eq(g["viewer_is_member"], True, "3c viewer_is_member=true (B is a member)")

    # 3d As I (not a member), GET /spot/groups/{group_1_id} → 403
    r = get(f"/spot/groups/{group_1_id}", token=I["token"])
    assert_eq(r.status_code, 403, "3d non-member GET status")
    if r.status_code == 403:
        assert_in("not your group", (r.json() or {}).get("detail", "").lower(),
                  "3d detail mentions 'Not your group'")

    # ── SECTION 4: Add members ──────────────────────────────
    print("\n── SECTION 4: Add members ───────────────────────────\n")

    # 4a As B, POST /members {[I]} → 403 (I is not B's friend)
    r = post(f"/spot/groups/{group_1_id}/members", token=B["token"],
             body={"member_ids": [I["user_id"]]})
    assert_eq(r.status_code, 403, "4a non-friend add by B status")
    if r.status_code == 403:
        assert_in("accepted friends", (r.json() or {}).get("detail", "").lower(),
                  "4a detail mentions 'accepted friends'")

    # 4b As admin, POST /members {[I]} → 403 (I is not admin's friend either)
    r = post(f"/spot/groups/{group_1_id}/members", token=admin["token"],
             body={"member_ids": [I["user_id"]]})
    assert_eq(r.status_code, 403, "4b non-friend add by admin status")

    # 4b' empty member_ids → 400
    r = post(f"/spot/groups/{group_1_id}/members", token=admin["token"],
             body={"member_ids": []})
    assert_eq(r.status_code, 400, "4b' empty add status")
    if r.status_code == 400:
        assert_in("non-empty", (r.json() or {}).get("detail", "").lower(),
                  "4b' detail mentions 'non-empty'")

    # 4c Befriend admin↔H. Now add H → 400 cap (group already 8 active)
    befriend(admin, H)
    r = post(f"/spot/groups/{group_1_id}/members", token=admin["token"],
             body={"member_ids": [H["user_id"]]})
    assert_eq(r.status_code, 400, "4c add H over cap status")
    if r.status_code == 400:
        detail = (r.json() or {}).get("detail", "")
        assert_in("exceed", detail.lower(), "4c detail mentions 'exceed'")
        assert_in("8-player", detail.lower(), "4c detail mentions '8-player'")

    # 4d Have B leave; then admin re-adds B (reactivation)
    r = post(f"/spot/groups/{group_1_id}/leave", token=B["token"])
    assert_eq(r.status_code, 200, "4d-pre B leave status")
    # admin GET /spot/groups/{id} → B status='left'
    r = get(f"/spot/groups/{group_1_id}", token=admin["token"])
    assert_eq(r.status_code, 200, "4d B-left detail status")
    if r.status_code == 200:
        g = r.json()["group"]
        b_row = next((m for m in g["members"] if m["user_id"] == B["user_id"]), None)
        assert_true(b_row is not None, "4d B row present")
        if b_row:
            assert_eq(b_row["status"], "left", "4d B row status=left")
            assert_true(b_row["left_at"] is not None, "4d B left_at set")
        # member_count = active only = 7
        assert_eq(g["member_count"], 7, "4d member_count drops to 7 after B leaves")

    # admin re-adds B → reactivated
    r = post(f"/spot/groups/{group_1_id}/members", token=admin["token"],
             body={"member_ids": [B["user_id"]]})
    assert_eq(r.status_code, 200, "4d re-add B status")
    if r.status_code == 200:
        body = r.json()
        assert_in(B["user_id"], body.get("reactivated", []), "4d B in reactivated[]")
        # B should NOT be in added[] (was previously a member)
        assert_true(B["user_id"] not in body.get("added", []), "4d B NOT in added[] (was a prior member)")
        g = body["group"]
        b_row = next((m for m in g["members"] if m["user_id"] == B["user_id"]), None)
        assert_true(b_row is not None and b_row["status"] == "active",
                    "4d B status back to active after re-add")
        if b_row:
            assert_eq(b_row["left_at"], None, "4d B left_at cleared after re-add")
        assert_eq(g["member_count"], 8, "4d member_count back to 8 after re-add")

    # ── SECTION 5: Leave + owner auto-promote ───────────────
    print("\n── SECTION 5: Leave + owner auto-promote ────────────\n")

    # Create a fresh group with admin + A + B + C so we can test owner-leave promotion
    # without disturbing group_1
    r = post("/spot/groups", token=admin["token"], body={
        "name": "Leave Test Group",
        "member_ids": [A["user_id"], B["user_id"], C["user_id"]]
    })
    assert_eq(r.status_code, 200, "5-setup create leave-test group status")
    if r.status_code != 200:
        _summarize()
        return
    gL = r.json()["group"]
    gL_id = gL["id"]
    assert_eq(gL["owner_id"], admin["user_id"], "5-setup admin is owner")

    # 5a C leaves
    r = post(f"/spot/groups/{gL_id}/leave", token=C["token"])
    assert_eq(r.status_code, 200, "5a C leave status")
    if r.status_code == 200:
        assert_true(r.json().get("left_at") is not None, "5a left_at returned ISO")

    # 5b C leaves AGAIN → 404
    r = post(f"/spot/groups/{gL_id}/leave", token=C["token"])
    assert_eq(r.status_code, 404, "5b C double-leave status")
    if r.status_code == 404:
        assert_in("not a member", (r.json() or {}).get("detail", "").lower(),
                  "5b detail mentions 'not a member'")

    # 5c Owner-leave auto-promotion. Admin leaves → A (oldest remaining active) becomes owner.
    r = post(f"/spot/groups/{gL_id}/leave", token=admin["token"])
    assert_eq(r.status_code, 200, "5c admin leave status")
    # GET as A — should now be owner
    r = get(f"/spot/groups/{gL_id}", token=A["token"])
    assert_eq(r.status_code, 200, "5c GET as A after admin leave status")
    if r.status_code == 200:
        g = r.json()["group"]
        assert_eq(g["owner_id"], A["user_id"], "5c new owner_id=A (oldest remaining active)")
        a_row = next((m for m in g["members"] if m["user_id"] == A["user_id"]), None)
        assert_true(a_row is not None, "5c A row present")
        if a_row:
            assert_eq(a_row["role"], "owner", "5c A.role=owner")
            assert_eq(a_row["status"], "active", "5c A.status=active")
        # admin's row should still exist with status=left
        admin_row = next((m for m in g["members"] if m["user_id"] == admin["user_id"]), None)
        assert_true(admin_row is not None, "5c admin row still present")
        if admin_row:
            assert_eq(admin_row["status"], "left", "5c admin row status=left")

    # Bonus: admin (now left) tries to GET → 403
    r = get(f"/spot/groups/{gL_id}", token=admin["token"])
    assert_eq(r.status_code, 403, "5c+ left-admin GET → 403")

    # ── SECTION 6: Patch ────────────────────────────────────
    print("\n── SECTION 6: Patch ─────────────────────────────────\n")

    # 6a As A (new owner of gL), PATCH auto_challenge_on=true
    r = patch(f"/spot/groups/{gL_id}", token=A["token"], body={"auto_challenge_on": True})
    assert_eq(r.status_code, 200, "6a A PATCH auto_challenge_on=true status")
    if r.status_code == 200:
        assert_eq(r.json()["group"]["auto_challenge_on"], True, "6a auto_challenge_on=true")

    # 6b As B (a member), PATCH auto_challenge_on=false → 200 (any member may toggle)
    r = patch(f"/spot/groups/{gL_id}", token=B["token"], body={"auto_challenge_on": False})
    assert_eq(r.status_code, 200, "6b B PATCH auto_challenge_on=false status")
    if r.status_code == 200:
        assert_eq(r.json()["group"]["auto_challenge_on"], False, "6b auto_challenge_on=false (member toggled)")

    # 6c As I (not a member), PATCH → 403
    r = patch(f"/spot/groups/{gL_id}", token=I["token"], body={"auto_challenge_on": True})
    assert_eq(r.status_code, 403, "6c non-member PATCH status")

    # 6c' As C (left member), PATCH → 403
    r = patch(f"/spot/groups/{gL_id}", token=C["token"], body={"auto_challenge_on": True})
    assert_eq(r.status_code, 403, "6c' left-member PATCH status")

    # 6d PATCH {name: 'Coffee Crew'}
    r = patch(f"/spot/groups/{gL_id}", token=A["token"], body={"name": "Coffee Crew"})
    assert_eq(r.status_code, 200, "6d rename status")
    if r.status_code == 200:
        assert_eq(r.json()["group"]["name"], "Coffee Crew", "6d name=Coffee Crew")

    # 6d' PATCH name truncation
    long_n = "X" * 200
    r = patch(f"/spot/groups/{gL_id}", token=A["token"], body={"name": long_n})
    assert_eq(r.status_code, 200, "6d' name truncation status")
    if r.status_code == 200:
        nm = r.json()["group"]["name"]
        assert_true(len(nm) <= 60, f"6d' name capped at 60 (len={len(nm)})")

    # 6d'' PATCH name='' (empty/whitespace) → ignored, but body has no other fields → 400
    r = patch(f"/spot/groups/{gL_id}", token=A["token"], body={"name": "   "})
    assert_eq(r.status_code, 400, "6d'' empty-name-only PATCH status")
    if r.status_code == 400:
        assert_in("no editable fields", (r.json() or {}).get("detail", "").lower(),
                  "6d'' detail mentions 'No editable fields'")

    # 6e PATCH {} → 400
    r = patch(f"/spot/groups/{gL_id}", token=A["token"], body={})
    assert_eq(r.status_code, 400, "6e empty-body PATCH status")
    if r.status_code == 400:
        assert_in("no editable fields", (r.json() or {}).get("detail", "").lower(),
                  "6e detail mentions 'No editable fields'")

    # ── SECTION 7: Regression — legacy /spot/match/create ───
    print("\n── SECTION 7: Regression — legacy /spot/match/create ─\n")

    r = post("/spot/match/create", token=admin["token"],
             body={"friend_ids": [A["user_id"]]})
    assert_eq(r.status_code, 200, "7 legacy /spot/match/create status")
    if r.status_code == 200:
        m = r.json().get("match") or r.json()
        # Should have a match object with status='waiting'
        assert_true(m.get("status") in ("waiting", "active") or "id" in m,
                    f"7 legacy match created (shape sample={list(m.keys())[:6]!r})")

    _summarize()


def _summarize():
    print(f"\n{'='*70}")
    print(f"RESULT: {PASS} PASS / {FAIL} FAIL")
    if FAIL:
        print("\nFailures:")
        for f in FAIL_DETAILS:
            print(f"  - {f}")
    print(f"{'='*70}\n")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
