"""
Spot the Object — Permanent Groups (Phase 2) — Auto-Challenge Scheduler
backend test suite.

Endpoints exercised (all /api):
  GET   /spot/groups/{gid}/challenges
  GET   /admin/spot/scheduler/today
  POST  /admin/spot/scheduler/force-tick

Plus a smoke regression on Phase 1's POST /spot/groups.

Run:
    python /app/spot_groups_phase2_test.py
"""
from __future__ import annotations

import json
import secrets
import sys
import time
from datetime import datetime
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


def post(path: str, token: Optional[str] = None, body: Optional[dict] = None) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.post(BASE + path, headers=headers, data=json.dumps(body or {}), timeout=30)


def get(path: str, token: Optional[str] = None) -> requests.Response:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.get(BASE + path, headers=headers, timeout=30)


def patch(path: str, token: Optional[str] = None, body: Optional[dict] = None) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.patch(BASE + path, headers=headers, data=json.dumps(body or {}), timeout=30)


def register_user(full_name: str) -> Dict:
    suffix = secrets.token_hex(4)
    email = f"sgp2_{int(time.time())}_{suffix}@gmail.com"
    password = "SpotP2!" + secrets.token_hex(2)
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
    return {
        "token": j["token"],
        "user_id": j["user"]["id"],
        "email": ADMIN_EMAIL,
        "full_name": j["user"].get("full_name") or "Admin",
    }


def befriend(a: dict, b: dict):
    r1 = post("/friends/request", token=a["token"], body={"user_id": b["user_id"]})
    if r1.status_code != 200:
        raise RuntimeError(f"friend request failed {a['full_name']}→{b['full_name']}: {r1.status_code} {r1.text}")
    if r1.json().get("status") == "friends":
        return
    r2 = post("/friends/accept", token=b["token"], body={"user_id": a["user_id"]})
    if r2.status_code != 200:
        raise RuntimeError(f"friend accept failed {b['full_name']}: {r2.status_code} {r2.text}")


def _summarize():
    print(f"\n{'='*70}")
    print(f"RESULT: {PASS} PASS / {FAIL} FAIL")
    if FAIL:
        print("\nFailures:")
        for f in FAIL_DETAILS:
            print(f"  - {f}")
    print(f"{'='*70}\n")
    sys.exit(0 if FAIL == 0 else 1)


# ─────────────────────────── MAIN ───────────────────────────
def main():
    print(f"\n{'='*70}\nSpot Phase 2 — Auto-Challenge Scheduler — backend test\n{'='*70}\n")

    # ── SETUP ──────────────────────────────────────────────
    print("\n── SETUP ─────────────────────────────────────────────\n")
    admin = login_admin()
    print(f"  admin user_id={admin['user_id']}")
    A = register_user("Anna AutoSpot")
    B = register_user("Brian AutoSpot")
    C = register_user("Carla NonMember")
    print(f"  registered A={A['user_id'][:8]}.. B={B['user_id'][:8]}.. C={C['user_id'][:8]}..")

    befriend(admin, A)
    befriend(admin, B)
    print("  befriended admin↔A, admin↔B")

    # ── SECTION 1: Auth & permission ───────────────────────
    print("\n── SECTION 1: Auth & permission ─────────────────────\n")

    # 1a no auth
    r = get("/admin/spot/scheduler/today")
    assert_true(r.status_code in (401, 403),
                f"1a GET /admin/spot/scheduler/today no-auth → 401/403 (got {r.status_code})")

    r = post("/admin/spot/scheduler/force-tick")
    assert_true(r.status_code in (401, 403),
                f"1a POST /admin/spot/scheduler/force-tick no-auth → 401/403 (got {r.status_code})")

    # 1b non-admin
    r = get("/admin/spot/scheduler/today", token=A["token"])
    assert_eq(r.status_code, 403, "1b GET today as non-admin status")
    if r.status_code == 403:
        assert_in("creator", (r.json() or {}).get("detail", "").lower(),
                  "1b detail mentions 'Creator'")

    r = post("/admin/spot/scheduler/force-tick", token=A["token"])
    assert_eq(r.status_code, 403, "1b POST force-tick as non-admin status")

    # 1c admin GET today → 200 with date + 3 anchors
    r = get("/admin/spot/scheduler/today", token=admin["token"])
    assert_eq(r.status_code, 200, "1c admin GET today status")
    today_doc = r.json() if r.status_code == 200 else {}
    today_date = today_doc.get("date")
    today_times = today_doc.get("times") or []
    today_utc_iso = datetime.utcnow().date().isoformat()
    assert_eq(today_date, today_utc_iso, "1c date == today UTC")
    # Anchors should be >=3 (could be >3 if a previous test inserted forced anchors today)
    assert_true(len(today_times) >= 3, f"1c times[] has at least 3 anchors (got {len(today_times)})")
    # Check first 3 anchors are 06-21 UTC, target_object str, fired_group_ids list
    initial_anchor_count = len(today_times)
    for i, t in enumerate(today_times[:3]):
        try:
            at_dt = datetime.fromisoformat(t["at_utc"])
        except Exception:
            _fail(f"1c anchor[{i}] at_utc is ISO parseable")
            continue
        h = at_dt.hour
        assert_true(6 <= h <= 21, f"1c anchor[{i}] hour in [6,21] (got {h})")
        assert_true(isinstance(t.get("target_object"), str) and len(t["target_object"]) > 0,
                    f"1c anchor[{i}] target_object is non-empty str")
        assert_true(isinstance(t.get("fired_group_ids"), list),
                    f"1c anchor[{i}] fired_group_ids is list")

    # 1d 90 min pairwise spacing between the first 3 regular anchors
    if len(today_times) >= 3:
        sorted_anchors = sorted(
            today_times[:3], key=lambda a: a["at_utc"]
        )
        ts = [datetime.fromisoformat(a["at_utc"]) for a in sorted_anchors]
        gap1 = abs((ts[1] - ts[0]).total_seconds()) / 60
        gap2 = abs((ts[2] - ts[1]).total_seconds()) / 60
        assert_true(gap1 >= 90, f"1d anchor[0]↔[1] ≥90min (got {gap1:.1f})")
        assert_true(gap2 >= 90, f"1d anchor[1]↔[2] ≥90min (got {gap2:.1f})")

    # 1e fired_group_counts present and same length
    counts = today_doc.get("fired_group_counts")
    assert_true(isinstance(counts, list) and len(counts) == len(today_times),
                "1e fired_group_counts is list of same length as times")

    # ── SECTION 2: Deterministic dispatch via force-tick ───
    print("\n── SECTION 2: Deterministic dispatch via force-tick ─\n")

    # 2a Create a fresh group via POST /spot/groups (admin + A)
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"]],
        "name": "P2 Auto Group",
    })
    assert_eq(r.status_code, 200, "2a create group status")
    if r.status_code != 200:
        print(f"     create failed: {r.text[:300]}")
        _summarize()
        return
    g1 = r.json()["group"]
    gid = g1["id"]
    print(f"     gid={gid}")
    assert_eq(g1["last_challenge_at"], None, "2a last_challenge_at=null on create")
    assert_eq(g1["auto_challenge_on"], False, "2a auto_challenge_on=false on create")

    # 2b PATCH auto_challenge_on=true
    r = patch(f"/spot/groups/{gid}", token=admin["token"], body={"auto_challenge_on": True})
    assert_eq(r.status_code, 200, "2b PATCH auto_challenge_on=true status")
    if r.status_code == 200:
        assert_eq(r.json()["group"]["auto_challenge_on"], True, "2b auto_challenge_on=true")

    # 2c POST force-tick → 200 with fired_to_groups >= 1
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "2c force-tick status")
    if r.status_code != 200:
        print(f"     force-tick failed: {r.text[:300]}")
        _summarize()
        return
    ft = r.json()
    print(f"     force-tick: {ft}")
    assert_eq(ft.get("date"), today_utc_iso, "2c force-tick date == today UTC")
    assert_true(isinstance(ft.get("anchor_idx"), int) and ft["anchor_idx"] >= initial_anchor_count,
                f"2c force-tick anchor_idx >= initial anchor count ({ft.get('anchor_idx')} >= {initial_anchor_count})")
    assert_true(isinstance(ft.get("fired_to_groups"), int) and ft["fired_to_groups"] >= 1,
                f"2c fired_to_groups >= 1 (got {ft.get('fired_to_groups')})")
    assert_true(isinstance(ft.get("target_object"), str) and len(ft["target_object"]) > 0,
                "2c target_object non-empty str")
    forced_anchor_idx_1 = ft["anchor_idx"]
    forced_target_object_1 = ft["target_object"]

    # 2d GET /spot/groups/{gid}/challenges → contains the new challenge
    r = get(f"/spot/groups/{gid}/challenges", token=admin["token"])
    assert_eq(r.status_code, 200, "2d GET challenges status")
    challenges = (r.json() or {}).get("challenges") or []
    assert_true(len(challenges) >= 1, f"2d challenges length >=1 (got {len(challenges)})")
    if challenges:
        c0 = challenges[0]
        assert_eq(c0.get("group_id"), gid, "2d challenges[0].group_id == gid")
        assert_eq(c0.get("target_object"), forced_target_object_1,
                  "2d challenges[0].target_object matches force-tick response")
        assert_eq(c0.get("anchor_idx"), forced_anchor_idx_1,
                  "2d challenges[0].anchor_idx matches force-tick response")
        assert_true(isinstance(c0.get("recipients_count"), int) and c0["recipients_count"] >= 0,
                    "2d challenges[0].recipients_count is int")
        assert_true(c0.get("you_received") in (True, False),
                    f"2d challenges[0].you_received is bool (got {type(c0.get('you_received')).__name__})")
        # fired_at_utc within last ~60s
        try:
            fired_dt = datetime.fromisoformat(c0["fired_at_utc"])
            age = (datetime.utcnow() - fired_dt.replace(tzinfo=None)).total_seconds()
            assert_true(age < 60, f"2d challenges[0].fired_at_utc within last 60s (age={age:.1f}s)")
        except Exception as e:
            _fail(f"2d challenges[0].fired_at_utc parse: {e}")

    # 2e GET /spot/groups/{gid} → last_challenge_at non-null + recent
    r = get(f"/spot/groups/{gid}", token=admin["token"])
    assert_eq(r.status_code, 200, "2e GET group detail status")
    if r.status_code == 200:
        g = r.json()["group"]
        lca = g.get("last_challenge_at")
        assert_true(lca is not None, "2e last_challenge_at is non-null after force-tick")
        if lca:
            try:
                lca_dt = datetime.fromisoformat(lca)
                age = (datetime.utcnow() - lca_dt.replace(tzinfo=None)).total_seconds()
                assert_true(age < 60, f"2e last_challenge_at within last 60s (age={age:.1f}s)")
            except Exception as e:
                _fail(f"2e last_challenge_at parse: {e}")

    # 2f Second force-tick → new challenge appended, newer fired_at_utc
    time.sleep(1.1)
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "2f second force-tick status")
    ft2 = r.json() if r.status_code == 200 else {}
    forced_anchor_idx_2 = ft2.get("anchor_idx")
    forced_target_object_2 = ft2.get("target_object")
    if isinstance(forced_anchor_idx_2, int):
        assert_true(forced_anchor_idx_2 > forced_anchor_idx_1,
                    f"2f second anchor_idx > first ({forced_anchor_idx_2} > {forced_anchor_idx_1})")

    r = get(f"/spot/groups/{gid}/challenges", token=admin["token"])
    assert_eq(r.status_code, 200, "2f GET challenges after 2nd tick status")
    challenges2 = (r.json() or {}).get("challenges") or []
    assert_true(len(challenges2) >= 2, f"2f challenges length >=2 (got {len(challenges2)})")
    if len(challenges2) >= 2:
        c0, c1 = challenges2[0], challenges2[1]
        # sorted DESC by fired_at_utc
        try:
            t0 = datetime.fromisoformat(c0["fired_at_utc"])
            t1 = datetime.fromisoformat(c1["fired_at_utc"])
            assert_true(t0 >= t1, f"2f sorted DESC by fired_at_utc ({t0} >= {t1})")
        except Exception as e:
            _fail(f"2f fired_at_utc sort parse: {e}")
        assert_eq(c0.get("target_object"), forced_target_object_2,
                  "2f challenges[0].target_object matches 2nd force-tick")
        assert_eq(c0.get("anchor_idx"), forced_anchor_idx_2,
                  "2f challenges[0].anchor_idx matches 2nd force-tick")

    # ── SECTION 3: 403 for non-member challenges ───────────
    print("\n── SECTION 3: 403 for non-member /challenges ─────────\n")
    r = get(f"/spot/groups/{gid}/challenges", token=C["token"])
    assert_eq(r.status_code, 403, "3a non-member GET /challenges status")
    if r.status_code == 403:
        assert_in("not your group", (r.json() or {}).get("detail", "").lower(),
                  "3a detail mentions 'Not your group'")

    # B is admin's friend but not in the group either → also 403
    r = get(f"/spot/groups/{gid}/challenges", token=B["token"])
    assert_eq(r.status_code, 403, "3b friend-but-not-member GET /challenges status")

    # ── SECTION 4: auto_challenge_on=False group never fired
    print("\n── SECTION 4: auto_challenge_on=False group ─────────\n")
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"]],
        "name": "P2 Off Group",
    })
    assert_eq(r.status_code, 200, "4a create off-group status")
    if r.status_code == 200:
        gid_off = r.json()["group"]["id"]
        # Explicitly do NOT toggle auto_challenge_on.
        # Force-tick (which fires to any new forced anchor) should still skip this group.
        time.sleep(1.1)
        r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
        assert_eq(r.status_code, 200, "4a force-tick status (off-group present)")
        # GET challenges for the off-group → empty
        r = get(f"/spot/groups/{gid_off}/challenges", token=admin["token"])
        assert_eq(r.status_code, 200, "4a GET challenges for off-group status")
        ch_off = (r.json() or {}).get("challenges") or []
        assert_eq(len(ch_off), 0, "4a off-group has 0 challenges after force-tick")

    # ── SECTION 5: Daylight gating smoke ───────────────────
    print("\n── SECTION 5: Daylight gating smoke ─────────────────\n")
    # Just confirm you_received is a strict bool and recipients_count is consistent.
    r = get(f"/spot/groups/{gid}/challenges", token=admin["token"])
    if r.status_code == 200:
        ch = (r.json() or {}).get("challenges") or []
        if ch:
            yr = ch[0].get("you_received")
            assert_true(yr is True or yr is False, f"5a you_received is strict bool (got {yr!r})")
            rc = ch[0].get("recipients_count")
            assert_true(isinstance(rc, int) and rc >= 0,
                        f"5a recipients_count is non-negative int (got {rc!r})")

    # ── SECTION 6: Idempotency — fired_group_ids tracks the gid
    print("\n── SECTION 6: Idempotency — fired_group_ids ─────────\n")
    r = get("/admin/spot/scheduler/today", token=admin["token"])
    assert_eq(r.status_code, 200, "6a admin GET today after force-ticks status")
    if r.status_code == 200:
        doc = r.json()
        times_after = doc.get("times") or []
        # Find the forced anchor we generated by anchor_idx
        found = False
        for idx, t in enumerate(times_after):
            if idx == forced_anchor_idx_1:
                fids = t.get("fired_group_ids") or []
                if gid in fids:
                    found = True
                    _ok(f"6a forced anchor #{idx} fired_group_ids contains gid")
                else:
                    _fail(f"6a forced anchor #{idx} fired_group_ids does NOT contain gid (got {fids})")
                # Also confirm it's marked as forced
                if t.get("forced") is True:
                    _ok(f"6a forced anchor #{idx} has forced=true")
                else:
                    _fail(f"6a forced anchor #{idx} missing forced=true (got {t.get('forced')!r})")
                break
        if not found and forced_anchor_idx_1 < len(times_after):
            pass  # already failed above
        elif forced_anchor_idx_1 >= len(times_after):
            _fail(f"6a forced anchor_idx={forced_anchor_idx_1} out of range (len={len(times_after)})")
        # fired_group_counts updated
        counts2 = doc.get("fired_group_counts") or []
        if forced_anchor_idx_1 < len(counts2):
            assert_true(counts2[forced_anchor_idx_1] >= 1,
                        f"6a fired_group_counts[{forced_anchor_idx_1}] >= 1 (got {counts2[forced_anchor_idx_1]})")

    # ── SECTION 7: Phase 1 smoke regression ────────────────
    print("\n── SECTION 7: Phase 1 smoke regression ──────────────\n")
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"], B["user_id"]],
        "name": "P1 Smoke Group",
    })
    assert_eq(r.status_code, 200, "7a POST /spot/groups still works")
    if r.status_code == 200:
        g_smoke = r.json()["group"]
        assert_true(g_smoke.get("id"), "7a smoke group has id")
        assert_eq(g_smoke.get("member_count"), 3, "7a smoke group member_count=3")

    # The existing Phase 1 group from this run survives & is still listable
    r = get("/spot/groups", token=admin["token"])
    assert_eq(r.status_code, 200, "7b GET /spot/groups status")
    if r.status_code == 200:
        ids = [g["id"] for g in (r.json().get("groups") or [])]
        assert_in(gid, ids, "7b original gid still in admin's groups list")

    _summarize()


if __name__ == "__main__":
    main()
