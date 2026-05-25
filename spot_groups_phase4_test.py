"""
Spot the Object — Permanent Groups (Phase 4 backend) test suite.

Covers:
  1. Invitation lifecycle (pending state, accept, decline, idempotency, 403 for non-invitees)
  2. Start gating (400 with pending invitees, 200 once all accepted, idempotency)
  3. Per-member toggle (self-only, 403 for pending/non-members)
  4. Dispatch eligibility (toggle-OFF excluded entirely; pending excluded)
  5. Round resolution + XP (+5×losers / -1×winners, idempotent, zero edges)
  6. Regression (Phases 1-3 still work; force-tick still functional)

Run:
    python /app/spot_groups_phase4_test.py
"""
from __future__ import annotations

import json
import secrets
import sys
import time
from typing import Any, Dict, List, Optional

import requests
from pymongo import MongoClient

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"
MONGO_URL = "mongodb://localhost:27017"
DB_NAME = "test_database"

PASS = 0
FAIL = 0
FAIL_DETAILS: List[str] = []


def _ok(msg: str):
    global PASS
    PASS += 1
    print(f"  PASS {msg}")


def _fail(msg: str):
    global FAIL
    FAIL += 1
    FAIL_DETAILS.append(msg)
    print(f"  FAIL {msg}")


def assert_eq(actual, expected, msg: str):
    if actual == expected:
        _ok(f"{msg} (={actual!r})")
    else:
        _fail(f"{msg} — expected {expected!r}, got {actual!r}")


def assert_true(cond, msg: str):
    if cond:
        _ok(msg)
    else:
        _fail(msg)


def assert_in(needle, haystack, msg: str):
    if needle in haystack:
        _ok(f"{msg} (found in haystack)")
    else:
        _fail(f"{msg} — {needle!r} not in {haystack!r}")


def assert_not_in(needle, haystack, msg: str):
    if needle not in haystack:
        _ok(msg)
    else:
        _fail(f"{msg} — {needle!r} unexpectedly in {haystack!r}")


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
    email = f"sgp4_{int(time.time())}_{suffix}@gmail.com"
    password = "SpotP4!" + secrets.token_hex(2)
    r = post("/auth/register", body={
        "email": email,
        "password": password,
        "full_name": full_name,
    })
    if r.status_code != 200:
        raise RuntimeError(f"register failed for {full_name}: {r.status_code} {r.text}")
    j = r.json()
    uid = j["user"]["id"]
    # Force the user into UTC + no shift_schedule so Phase 4 dispatch
    # treats them as 'active' + in-daylight regardless of when the test
    # runs. Without this they pick up DEFAULT_TZ=Australia/Sydney from
    # the notif_scheduler fallback and get night-skipped.
    force_daylight_profile(uid)
    return {
        "token": j["token"],
        "user_id": uid,
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
    # Restore admin profile snapshot if we have one
    snap = globals().get("_ADMIN_SNAP")
    aid = globals().get("_ADMIN_ID")
    if snap and aid:
        try:
            restore_profile(aid, snap)
            print(f"\n(restored admin profile from snapshot)")
        except Exception as e:
            print(f"\n(WARN failed to restore admin profile: {e})")
    print(f"\n{'='*70}")
    print(f"RESULT: {PASS} PASS / {FAIL} FAIL")
    if FAIL:
        print("\nFailures:")
        for f in FAIL_DETAILS:
            print(f"  - {f}")
    print(f"{'='*70}\n")
    sys.exit(0 if FAIL == 0 else 1)


# Direct DB for inspecting challenge rows + setting xp prerequisites.
mongo = MongoClient(MONGO_URL)
db = mongo[DB_NAME]


def force_daylight_profile(user_id: str):
    """Set the user to UTC timezone and clear any shift_schedule, so the
    Phase 4 dispatcher treats them as 'active' + in-daylight at *any*
    daylight-band UTC time (06:00-21:00). This is needed for the test
    environment because DEFAULT_TZ falls back to Australia/Sydney which
    flips users into night/sleeping depending on when the test runs."""
    db.profile.update_one(
        {"_id": user_id},
        {"$set": {"timezone": "UTC"}, "$unset": {"shift_schedule": ""}},
    )


def snapshot_profile(user_id: str) -> dict:
    return db.profile.find_one(
        {"_id": user_id},
        {"timezone": 1, "shift_schedule": 1, "day_start_time": 1, "wake_time": 1},
    ) or {}


def restore_profile(user_id: str, snap: dict):
    update_set: dict = {}
    unset: dict = {}
    for k in ("timezone", "shift_schedule", "day_start_time", "wake_time"):
        if k in snap and snap[k] is not None:
            update_set[k] = snap[k]
        else:
            unset[k] = ""
    op = {}
    if update_set:
        op["$set"] = update_set
    if unset:
        op["$unset"] = unset
    if op:
        db.profile.update_one({"_id": user_id}, op)


def get_profile_xp(user_id: str) -> int:
    p = db.profile.find_one({"_id": user_id}, {"total_xp": 1})
    return int((p or {}).get("total_xp") or 0)


def get_latest_challenge(gid: str) -> Optional[dict]:
    return db.spot_group_challenges.find_one({"group_id": gid}, sort=[("fired_at_utc", -1)])


# Tiny valid 1x1 PNG (base64, no data: prefix)
TINY_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7w"
    "AAAABJRU5ErkJggg=="
)


def main():
    print("=" * 70)
    print("Spot Groups Phase 4 backend test")
    print("=" * 70)

    admin = login_admin()
    print(f"\nAdmin user_id={admin['user_id']}")

    # Snapshot admin profile so we can restore at the end. The test env
    # may have admin with timezone=Australia/Sydney + shift_schedule
    # enabled (left over from Phase 3 tests), which would put admin in
    # 'sleeping' state and skip every dispatch. Force admin to UTC + no
    # shift for the duration of the test.
    admin_snap = snapshot_profile(admin["user_id"])
    globals()["_ADMIN_SNAP"] = admin_snap
    globals()["_ADMIN_ID"] = admin["user_id"]
    force_daylight_profile(admin["user_id"])
    print(f"  (admin profile forced to UTC; will restore at end. snap keys={list(admin_snap.keys())})")

    # ─────────────────── SECTION 1 — Invitation lifecycle ───────────────────
    print("\n─── Section 1: Invitation lifecycle ───")
    A = register_user("Alice P4")
    B = register_user("Bob P4")
    C = register_user("Carol P4")
    D = register_user("Dave NonInvitee")
    print(f"Registered A={A['user_id']} B={B['user_id']} C={C['user_id']} D={D['user_id']}")

    befriend(admin, A)
    befriend(admin, B)
    befriend(admin, C)
    befriend(admin, D)
    _ok("Befriended admin↔A,B,C,D")

    # 1b — Create group with pending invitees
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"], B["user_id"], C["user_id"]],
        "name": "P4 Invite Lifecycle",
    })
    assert_eq(r.status_code, 200, "1b create group with 3 invitees → 200")
    if r.status_code != 200:
        print(f"  body: {r.text}")
        _summarize()
    g = r.json()["group"]
    gid = g["id"]
    print(f"  gid={gid}")
    assert_eq(g["member_count"], 4, "1b member_count=4")
    assert_eq(g["pending_count"], 3, "1b pending_count=3")
    assert_eq(g["accepted_count"], 1, "1b accepted_count=1")
    assert_eq(g["all_accepted"], False, "1b all_accepted=false")
    assert_eq(g["started"], False, "1b started=false")
    # member statuses
    by_id = {m["user_id"]: m for m in g["members"]}
    assert_eq(by_id[A["user_id"]]["status"], "pending", "1b A.status=pending")
    assert_eq(by_id[B["user_id"]]["status"], "pending", "1b B.status=pending")
    assert_eq(by_id[C["user_id"]]["status"], "pending", "1b C.status=pending")
    # admin should be accepted/active (not pending)
    assert_true(by_id[admin["user_id"]]["status"] != "pending", "1b admin.status != pending")

    # 1c — pending invitee can VIEW the group
    r = get(f"/spot/groups/{gid}", token=B["token"])
    assert_eq(r.status_code, 200, "1c B (pending) GET group → 200")
    g_b = r.json()["group"]
    assert_eq(g_b["viewer_status"], "pending", "1c B.viewer_status=pending")

    # 1d — B accepts
    r = post(f"/spot/groups/{gid}/accept", token=B["token"])
    assert_eq(r.status_code, 200, "1d B accept → 200")
    j = r.json()
    by_id = {m["user_id"]: m for m in j["group"]["members"]}
    assert_true(by_id[B["user_id"]]["status"] != "pending", "1d B.status no longer pending")
    assert_eq(j["group"]["pending_count"], 2, "1d pending_count=2")

    # 1e — B accept idempotent
    r = post(f"/spot/groups/{gid}/accept", token=B["token"])
    assert_eq(r.status_code, 200, "1e B re-accept → 200")
    assert_eq(r.json().get("no_op"), True, "1e re-accept has no_op:true")

    # 1f — C declines
    r = post(f"/spot/groups/{gid}/decline", token=C["token"])
    assert_eq(r.status_code, 200, "1f C decline → 200")
    j = r.json()
    assert_true(bool(j.get("left_at")), "1f decline returns left_at ISO")
    assert_eq(j.get("declined"), True, "1f declined=true")
    # GET — C now status='left'
    r = get(f"/spot/groups/{gid}", token=admin["token"])
    g2 = r.json()["group"]
    by_id = {m["user_id"]: m for m in g2["members"]}
    assert_eq(by_id[C["user_id"]]["status"], "left", "1f C.status=left after decline")
    assert_eq(g2["pending_count"], 1, "1f pending_count=1 (A only)")
    assert_eq(g2["accepted_count"], 2, "1f accepted_count=2 (admin+B)")
    assert_eq(g2["member_count"], 3, "1f member_count=3 (excludes declined)")

    # 1g — D not invited → 403
    r = get(f"/spot/groups/{gid}", token=D["token"])
    assert_eq(r.status_code, 403, "1g D (non-invitee) GET → 403")

    # 1h — C decline again should 404 or 400 (already left)
    r = post(f"/spot/groups/{gid}/decline", token=C["token"])
    assert_true(r.status_code in (400, 404), f"1h C re-decline → 400/404 (got {r.status_code})")

    # 1i — D (not invited) accept → 404
    r = post(f"/spot/groups/{gid}/accept", token=D["token"])
    assert_eq(r.status_code, 404, "1i D (non-invitee) accept → 404")

    # ─────────────────── SECTION 2 — Start gating ───────────────────
    print("\n─── Section 2: Start gating ───")

    # 2a — admin starts while A is still pending → 400
    r = post(f"/spot/groups/{gid}/start", token=admin["token"])
    assert_eq(r.status_code, 400, "2a /start with pending invitee → 400")
    if r.status_code == 400:
        detail = (r.json().get("detail") or "").lower()
        assert_true("pending" in detail, "2a detail mentions 'pending'")

    # 2b — A accepts
    r = post(f"/spot/groups/{gid}/accept", token=A["token"])
    assert_eq(r.status_code, 200, "2b A accept → 200")

    # 2c — admin starts → 200
    r = post(f"/spot/groups/{gid}/start", token=admin["token"])
    assert_eq(r.status_code, 200, "2c admin /start → 200")
    j = r.json()
    assert_eq(j["group"]["started"], True, "2c started=true")
    assert_true(bool(j["group"].get("started_at")), "2c started_at set")
    assert_eq(j["group"]["auto_challenge_on"], True, "2c auto_challenge_on=true (mirrored)")

    # 2d — start again → no_op:true
    r = post(f"/spot/groups/{gid}/start", token=admin["token"])
    assert_eq(r.status_code, 200, "2d re-start → 200")
    assert_eq(r.json().get("no_op"), True, "2d no_op:true on repeat /start")

    # 2e — Edge: create new group with admin + 1 friend, accept immediately, /start → 200
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"]], "name": "P4 Min2"})
    assert_eq(r.status_code, 200, "2e create min-2 group → 200")
    gid_min = r.json()["group"]["id"]
    r = post(f"/spot/groups/{gid_min}/accept", token=A["token"])
    assert_eq(r.status_code, 200, "2e A accept min-2 → 200")
    r = post(f"/spot/groups/{gid_min}/start", token=A["token"])
    assert_eq(r.status_code, 200, "2e /start min-2 group as A (any accepted member) → 200")

    # 2f — empty member_ids on create → 400
    r = post("/spot/groups", token=admin["token"], body={"member_ids": []})
    assert_eq(r.status_code, 400, "2f empty member_ids → 400")

    # 2g — D (non-member) /start on existing started group → 403
    r = post(f"/spot/groups/{gid}/start", token=D["token"])
    assert_eq(r.status_code, 403, "2g D (non-member) /start → 403")

    # ─────────────────── SECTION 3 — Per-member toggle ───────────────────
    print("\n─── Section 3: Per-member toggle ───")

    # 3a — B toggle off
    r = post(f"/spot/groups/{gid}/notifications", token=B["token"], body={"on": False})
    assert_eq(r.status_code, 200, "3a B notifications:off → 200")
    assert_eq(r.json().get("notifications_on"), False, "3a notifications_on=false in resp")
    # confirm via GET — B.status='off'
    r = get(f"/spot/groups/{gid}", token=admin["token"])
    by_id = {m["user_id"]: m for m in r.json()["group"]["members"]}
    assert_eq(by_id[B["user_id"]]["status"], "off", "3a B.status='off' after toggle off")
    assert_eq(by_id[B["user_id"]]["notifications_on"], False, "3a B.notifications_on=false in members[]")

    # 3b — B toggle back on
    r = post(f"/spot/groups/{gid}/notifications", token=B["token"], body={"on": True})
    assert_eq(r.status_code, 200, "3b B notifications:on → 200")
    r = get(f"/spot/groups/{gid}", token=admin["token"])
    by_id = {m["user_id"]: m for m in r.json()["group"]["members"]}
    assert_true(by_id[B["user_id"]]["status"] != "off", "3b B.status no longer 'off'")

    # 3c — D (non-member) → 403
    r = post(f"/spot/groups/{gid}/notifications", token=D["token"], body={"on": False})
    assert_eq(r.status_code, 403, "3c D (non-member) /notifications → 403")

    # 3d — pending invitee → 403. Create a new group, then toggle while pending.
    E = register_user("Eve PendingP4")
    befriend(admin, E)
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [E["user_id"]], "name": "P4 Pending Toggle Test"})
    gid_pending = r.json()["group"]["id"]
    r = post(f"/spot/groups/{gid_pending}/notifications", token=E["token"], body={"on": False})
    assert_eq(r.status_code, 403, "3d pending invitee /notifications → 403")

    # 3e — missing 'on' key → 400
    r = post(f"/spot/groups/{gid}/notifications", token=B["token"], body={})
    assert_eq(r.status_code, 400, "3e /notifications missing 'on' → 400")

    # ─────────────────── SECTION 4 — Dispatch eligibility ───────────────────
    print("\n─── Section 4: Dispatch eligibility ───")

    # Create fresh started group with admin + A + B (all accepted, all on)
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"], B["user_id"]], "name": "P4 Dispatch Test"})
    gid_disp = r.json()["group"]["id"]
    post(f"/spot/groups/{gid_disp}/accept", token=A["token"])
    post(f"/spot/groups/{gid_disp}/accept", token=B["token"])
    r = post(f"/spot/groups/{gid_disp}/start", token=admin["token"])
    assert_eq(r.status_code, 200, "4 setup: start dispatch group → 200")

    # 4a — toggle B off
    r = post(f"/spot/groups/{gid_disp}/notifications", token=B["token"], body={"on": False})
    assert_eq(r.status_code, 200, "4a B toggle off → 200")

    # 4b — force-tick
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "4b force-tick → 200")
    if r.status_code == 200:
        ft = r.json()
        assert_true(ft.get("fired_to_groups", 0) >= 1, f"4b fired_to_groups>=1 (got {ft.get('fired_to_groups')})")

    # Wait briefly for DB consistency
    time.sleep(0.5)

    # 4c — Inspect challenge via direct DB (to see recipients + skipped_* arrays exactly)
    ch = get_latest_challenge(gid_disp)
    assert_true(ch is not None, "4c challenge row created in DB")
    if ch:
        recipients = ch.get("recipients") or []
        sk_sleep = ch.get("skipped_sleeping") or []
        sk_work = ch.get("skipped_work") or []
        sk_night = ch.get("skipped_night") or []
        # B should NOT be in recipients or any skipped_* (silent exclusion)
        assert_not_in(B["user_id"], recipients, "4c B (toggle OFF) NOT in recipients")
        assert_not_in(B["user_id"], sk_sleep, "4c B NOT in skipped_sleeping")
        assert_not_in(B["user_id"], sk_work, "4c B NOT in skipped_work")
        assert_not_in(B["user_id"], sk_night, "4c B NOT in skipped_night")
        # admin and A should be in recipients (assuming daylight UTC — tests may run any time)
        # We tolerate them being in skipped_night if at night, but B must be excluded.
        all_appearances = set(recipients) | set(sk_sleep) | set(sk_work) | set(sk_night)
        # admin + A should appear *somewhere* (either recipients or skipped_night based on time)
        assert_in(admin["user_id"], all_appearances, "4c admin appears in recipients or skipped_*")
        assert_in(A["user_id"], all_appearances, "4c A appears in recipients or skipped_*")
        # round fields
        assert_true("round_ends_at_utc" in ch, "4c challenge has round_ends_at_utc")
        assert_eq(ch.get("round_seconds"), 120, "4c round_seconds=120")
        assert_eq(ch.get("resolved"), False, "4c resolved=false initially")

    # 4d — GET via API for new fields
    r = get(f"/spot/groups/{gid_disp}/challenges", token=admin["token"])
    assert_eq(r.status_code, 200, "4d GET /challenges → 200")
    if r.status_code == 200:
        ch_list = r.json()["challenges"]
        assert_true(len(ch_list) >= 1, "4d at least 1 challenge in list")
        if ch_list:
            c0 = ch_list[0]
            assert_true("round_ends_at_utc" in c0, "4d API has round_ends_at_utc")
            assert_eq(c0.get("round_seconds"), 120, "4d API round_seconds=120")
            assert_true("resolved" in c0, "4d API has resolved")
            assert_true("winners" in c0, "4d API has winners")
            assert_true("losers" in c0, "4d API has losers")
            assert_true("xp_per_winner" in c0, "4d API has xp_per_winner")
            assert_true("xp_per_loser" in c0, "4d API has xp_per_loser")
            assert_true("you_won" in c0, "4d API has you_won")
            assert_true("you_lost" in c0, "4d API has you_lost")

    # ─────────────────── SECTION 5 — Round resolution + XP ───────────────────
    print("\n─── Section 5: Round resolution + XP ───")

    # Create a fresh started group with admin + A + B all accepted + all on
    F = register_user("Frank P4 Resolver")
    G = register_user("Grace P4 Resolver")
    befriend(admin, F)
    befriend(admin, G)

    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [F["user_id"], G["user_id"]], "name": "P4 XP Resolve"})
    gid_xp = r.json()["group"]["id"]
    post(f"/spot/groups/{gid_xp}/accept", token=F["token"])
    post(f"/spot/groups/{gid_xp}/accept", token=G["token"])
    post(f"/spot/groups/{gid_xp}/start", token=admin["token"])

    # Force-tick to fire a challenge
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "5 force-tick #1 → 200")
    time.sleep(0.5)

    ch = get_latest_challenge(gid_xp)
    assert_true(ch is not None, "5 challenge row exists for xp group")
    if ch is None:
        _summarize()
    target = ch.get("target_object")
    recipients = set(ch.get("recipients") or [])
    print(f"  target={target} recipients={recipients}")

    # Skip XP section if all members are in night (no recipients)
    if not recipients:
        _fail("5 SKIP — no recipients (all in night); XP section requires daylight")
    else:
        # Capture XP before resolution
        adm_xp_before = get_profile_xp(admin["user_id"])
        f_xp_before = get_profile_xp(F["user_id"])
        g_xp_before = get_profile_xp(G["user_id"])
        print(f"  XP before: admin={adm_xp_before} F={f_xp_before} G={g_xp_before}")

        # 5a — Decide who's a winner: if admin is in recipients, post for admin only
        # so admin wins and F/G lose (if they're in recipients too).
        winners_planned: List[str] = []
        losers_planned: List[str] = []
        if admin["user_id"] in recipients:
            r = post("/spot/complete", token=admin["token"], body={
                "target_object": target,
                "photo_base64": TINY_PNG,
                "success": True,
                "remaining_seconds": 80,
                "mode": "friends",
            })
            assert_eq(r.status_code, 200, "5a admin /spot/complete → 200")
            winners_planned.append(admin["user_id"])
        for uid in [F["user_id"], G["user_id"]]:
            if uid in recipients and uid not in winners_planned:
                losers_planned.append(uid)
        # If admin not in recipients, just have F post and rest lose
        if not winners_planned and F["user_id"] in recipients:
            r = post("/spot/complete", token=F["token"], body={
                "target_object": target,
                "photo_base64": TINY_PNG,
                "success": True,
                "remaining_seconds": 80,
                "mode": "friends",
            })
            assert_eq(r.status_code, 200, "5a F /spot/complete → 200 (admin not in recipients)")
            winners_planned.append(F["user_id"])
            losers_planned = [u for u in recipients if u not in winners_planned]

        # 5b — Resolve now
        r = post("/admin/spot/scheduler/resolve-now", token=admin["token"])
        assert_eq(r.status_code, 200, "5b resolve-now → 200")
        if r.status_code == 200:
            res_j = r.json()
            assert_true(res_j.get("resolved", 0) >= 1, f"5b resolved>=1 (got {res_j.get('resolved')})")

        # 5c — Re-fetch the challenge
        ch2 = db.spot_group_challenges.find_one({"_id": ch["_id"]})
        assert_eq(ch2.get("resolved"), True, "5c challenge resolved=true")
        winners_actual = sorted(ch2.get("winners") or [])
        losers_actual = sorted(ch2.get("losers") or [])
        n_w = len(winners_actual)
        n_l = len(losers_actual)
        xp_pw = ch2.get("xp_per_winner")
        xp_pl = ch2.get("xp_per_loser")
        print(f"  winners={winners_actual} losers={losers_actual} xp(+{xp_pw}/{xp_pl})")
        assert_eq(winners_actual, sorted(winners_planned), "5c winners match planned")
        assert_eq(losers_actual, sorted(losers_planned), "5c losers match planned")
        # XP math: winner gets +5*nL, loser gets -1*nW
        assert_eq(xp_pw, 5 * n_l, f"5c xp_per_winner = 5*{n_l}")
        assert_eq(xp_pl, -1 * n_w, f"5c xp_per_loser = -1*{n_w}")

        # 5d — Verify XP applied. NOTE: force-tick dispatches the same
        # target_object to ALL started groups, so admin (member of
        # several test groups) may win MULTIPLE challenges at once. We
        # assert ≥ this challenge's delta, not equality.
        adm_xp_after = get_profile_xp(admin["user_id"])
        f_xp_after = get_profile_xp(F["user_id"])
        g_xp_after = get_profile_xp(G["user_id"])
        print(f"  XP after: admin={adm_xp_after} F={f_xp_after} G={g_xp_after}")
        if admin["user_id"] in winners_actual:
            assert_true(adm_xp_after - adm_xp_before >= 5 * n_l,
                        f"5d admin XP delta ≥ +5*losers={5*n_l} (got {adm_xp_after - adm_xp_before}, may be > due to cross-group dispatch)")
        elif admin["user_id"] in losers_actual:
            expected = max(0, adm_xp_before - n_w) - adm_xp_before
            assert_true(adm_xp_after - adm_xp_before <= expected,
                        f"5d admin XP delta ≤ {expected} (loser; got {adm_xp_after - adm_xp_before})")
        if F["user_id"] in winners_actual:
            assert_true(f_xp_after - f_xp_before >= 5 * n_l, "5d F XP delta ≥ +5*losers")
        elif F["user_id"] in losers_actual:
            # F starts at 0 → floor at 0 → delta = 0 (no further negative possible)
            assert_eq(f_xp_after, 0, "5d F XP floored at 0 (loser)")
        if G["user_id"] in winners_actual:
            assert_true(g_xp_after - g_xp_before >= 5 * n_l, "5d G XP delta ≥ +5*losers")
        elif G["user_id"] in losers_actual:
            assert_eq(g_xp_after, 0, "5d G XP floored at 0 (loser)")

        # 5e — Resolve-now again → should be idempotent (no double-apply XP for THIS challenge)
        adm_xp_pre2 = get_profile_xp(admin["user_id"])
        f_xp_pre2 = get_profile_xp(F["user_id"])
        g_xp_pre2 = get_profile_xp(G["user_id"])
        r = post("/admin/spot/scheduler/resolve-now", token=admin["token"])
        assert_eq(r.status_code, 200, "5e resolve-now second call → 200")
        # Just verify the SAME challenge isn't re-resolved (it's already marked resolved=true and the
        # resolver short-circuits on already-resolved rows).
        # Verify XP unchanged for the participants of THIS specific resolved challenge
        adm_xp_post2 = get_profile_xp(admin["user_id"])
        f_xp_post2 = get_profile_xp(F["user_id"])
        g_xp_post2 = get_profile_xp(G["user_id"])
        # NOTE: other unresolved challenges from earlier tests may be resolved here. So we can't
        # blanket-assert no change. Instead, verify the challenge's resolved_at_utc is unchanged.
        ch3 = db.spot_group_challenges.find_one({"_id": ch["_id"]})
        assert_eq(ch3.get("resolved"), True, "5e challenge still resolved=true")
        assert_eq(ch3.get("winners"), ch2.get("winners"), "5e winners unchanged after re-resolve")
        assert_eq(ch3.get("losers"), ch2.get("losers"), "5e losers unchanged after re-resolve")
        assert_eq(ch3.get("xp_per_winner"), ch2.get("xp_per_winner"), "5e xp_per_winner unchanged")
        assert_eq(ch3.get("xp_per_loser"), ch2.get("xp_per_loser"), "5e xp_per_loser unchanged")

    # 5f — Zero-winner edge: force-tick, NO ONE posts, resolve-now.
    # Spec: zero winners → no XP applied to losers (xp_per_loser=-1*0=0).
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "5f force-tick #2 (zero-winner) → 200")
    time.sleep(0.5)
    ch_zw = get_latest_challenge(gid_xp)
    if ch_zw and ch_zw.get("recipients"):
        recip_zw = set(ch_zw.get("recipients") or [])
        xp_before_zw = {u: get_profile_xp(u) for u in recip_zw}
        r = post("/admin/spot/scheduler/resolve-now", token=admin["token"])
        assert_eq(r.status_code, 200, "5f resolve-now #2 → 200")
        ch_zw2 = db.spot_group_challenges.find_one({"_id": ch_zw["_id"]})
        assert_eq(ch_zw2.get("resolved"), True, "5f zero-winner resolved=true")
        assert_eq(ch_zw2.get("winners"), [], "5f winners=[]")
        # Spec invariant: with 0 winners → xp_per_loser must be 0 (no XP
        # debit applied to losers). The xp_per_winner field may be
        # non-zero (=5*#losers) but it's never APPLIED since winners=[].
        assert_eq(ch_zw2.get("xp_per_loser"), 0, "5f xp_per_loser=0 (no winners → no loss applied)")
        # XP delta from THIS challenge for losers = 0 — but other
        # simultaneously-resolved challenges may change recipients'
        # XP, so we don't blanket-assert recipient XP unchanged.
        print(f"  5f zero-winner challenge: xp_per_winner={ch_zw2.get('xp_per_winner')} (not applied), xp_per_loser={ch_zw2.get('xp_per_loser')}")
    else:
        print("  SKIP 5f (no recipients in this anchor)")

    # 5g — Zero-loser edge: force-tick, EVERYONE posts
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "5g force-tick #3 (zero-loser) → 200")
    time.sleep(0.5)
    ch_zl = get_latest_challenge(gid_xp)
    if ch_zl and ch_zl.get("recipients"):
        target_zl = ch_zl.get("target_object")
        recip_zl = set(ch_zl.get("recipients") or [])
        xp_before_zl = {u: get_profile_xp(u) for u in recip_zl}
        # Map user_id -> token for posting
        tok_map = {
            admin["user_id"]: admin["token"],
            F["user_id"]: F["token"],
            G["user_id"]: G["token"],
        }
        for uid in recip_zl:
            if uid in tok_map:
                rr = post("/spot/complete", token=tok_map[uid], body={
                    "target_object": target_zl,
                    "photo_base64": TINY_PNG,
                    "success": True,
                    "remaining_seconds": 60,
                    "mode": "friends",
                })
                if rr.status_code != 200:
                    print(f"  WARN /spot/complete failed for {uid[:8]}: {rr.status_code}")
        r = post("/admin/spot/scheduler/resolve-now", token=admin["token"])
        assert_eq(r.status_code, 200, "5g resolve-now #3 → 200")
        ch_zl2 = db.spot_group_challenges.find_one({"_id": ch_zl["_id"]})
        assert_eq(ch_zl2.get("resolved"), True, "5g zero-loser resolved=true")
        assert_eq(sorted(ch_zl2.get("winners") or []), sorted(recip_zl), "5g winners=all recipients")
        assert_eq(ch_zl2.get("losers"), [], "5g losers=[]")
        # Spec invariant: with 0 losers → xp_per_winner must be 0 (no
        # XP credit applied to winners). The xp_per_loser field may be
        # non-zero (=-1*#winners) but it's never APPLIED since losers=[].
        assert_eq(ch_zl2.get("xp_per_winner"), 0, "5g xp_per_winner=0 (no losers → no win XP applied)")
        print(f"  5g zero-loser challenge: xp_per_winner={ch_zl2.get('xp_per_winner')}, xp_per_loser={ch_zl2.get('xp_per_loser')} (not applied)")
    else:
        print("  SKIP 5g (no recipients)")

    # ─────────────────── SECTION 6 — Regression ───────────────────
    print("\n─── Section 6: Regression Phase 1-3 ───")

    # 6a — list groups still works
    r = get("/spot/groups", token=admin["token"])
    assert_eq(r.status_code, 200, "6a GET /spot/groups → 200")
    if r.status_code == 200:
        gids = [g["id"] for g in r.json()["groups"]]
        assert_in(gid, gids, "6a our gid in list")

    # 6b — leave still works on an accepted member
    # Use B (accepted in gid) — leave
    r = post(f"/spot/groups/{gid}/leave", token=B["token"])
    assert_eq(r.status_code, 200, "6b B leaves → 200")

    # 6c — PATCH name still works; auto_challenge_on NOT editable
    r = patch(f"/spot/groups/{gid}", token=admin["token"], body={"name": "P4 Renamed"})
    assert_eq(r.status_code, 200, "6c PATCH name → 200")
    assert_eq(r.json()["group"]["name"], "P4 Renamed", "6c name updated")

    # 6d — PATCH auto_challenge_on attempt → either ignored OR 400 (since only name is editable)
    r = patch(f"/spot/groups/{gid}", token=admin["token"], body={"auto_challenge_on": False})
    # 400 'No editable fields in body' OR 200 with auto_challenge_on unchanged
    if r.status_code == 400:
        _ok("6d PATCH auto_challenge_on only → 400 (no editable fields)")
    elif r.status_code == 200:
        # Confirm started/auto_challenge_on NOT toggled to False
        gx = r.json()["group"]
        assert_eq(gx.get("started"), True, "6d /start still true (auto_challenge_on not editable)")
        assert_eq(gx.get("auto_challenge_on"), True, "6d auto_challenge_on still mirrored to started")
    else:
        _fail(f"6d unexpected status {r.status_code}")

    # 6e — Phase 2 today endpoint still works
    r = get("/admin/spot/scheduler/today", token=admin["token"])
    assert_eq(r.status_code, 200, "6e admin /scheduler/today → 200")
    if r.status_code == 200:
        assert_true("date" in r.json(), "6e today has date")
        assert_true("times" in r.json(), "6e today has times")

    # 6f — Phase 1 create new group still works (admin solo + 1 friend)
    H = register_user("Henry RegressionP4")
    befriend(admin, H)
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [H["user_id"]], "name": "P4 Regression Create"})
    assert_eq(r.status_code, 200, "6f Phase 1 create → 200")
    if r.status_code == 200:
        gh = r.json()["group"]
        assert_eq(gh["pending_count"], 1, "6f new invitee in pending state")
        assert_eq(gh["started"], False, "6f started=false on create")
        assert_eq(gh["auto_challenge_on"], False, "6f auto_challenge_on=false on create")

    _summarize()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        _summarize()
    except Exception as e:
        import traceback
        traceback.print_exc()
        _fail(f"UNCAUGHT: {e}")
        _summarize()
