"""
Spot the Object — Permanent Groups (Phase 3 backend) — Availability +
Defer + Group Feed backend test suite.

Run:
    python /app/spot_groups_phase3_test.py
"""
from __future__ import annotations

import json
import secrets
import sys
import time
from datetime import datetime, timedelta, timezone
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
        _ok(f"{msg} (found {needle!r})")
    else:
        _fail(f"{msg} — {needle!r} not in {haystack!r}")


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
    email = f"sgp3_{int(time.time())}_{suffix}@gmail.com"
    password = "SpotP3!" + secrets.token_hex(2)
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


# ─────────────────── direct-DB helpers (for sleep/work overrides) ───────────────────
mongo = MongoClient(MONGO_URL)
db = mongo[DB_NAME]


def set_profile_sleeping_all_day(user_id: str):
    """Patch profile to force _is_in_silence_window=True for all local times.
    shift_schedule.enabled=true, pattern=['day'], shifts.day.sleep_time='00:00',
    start_time='23:59' → sleep window covers ~all 24h."""
    today_iso = datetime.now(timezone.utc).date().isoformat()
    db.profile.update_one(
        {"_id": user_id},
        {"$set": {
            "timezone": "UTC",
            "shift_schedule": {
                "enabled": True,
                "setup_complete": True,
                "pattern_kind": "rotating",
                "pattern": ["day"],
                "pattern_start_date": today_iso,
                "refresh_offset_hours": 2,
                "manual_overrides": {},
                "shifts": {
                    "day": {
                        "start_time": "23:59",
                        "sleep_time": "00:00",
                        "icon": "☀",
                        "color": "#ffcc00",
                    },
                    "night": {
                        "start_time": "22:00",
                        "sleep_time": "06:00",
                        "icon": "🌙",
                        "color": "#3344aa",
                    },
                    "off": {
                        "start_time": "08:00",
                        "sleep_time": "23:00",
                        "icon": "🛌",
                        "color": "#888888",
                    },
                },
            },
        }},
        upsert=True,
    )


def set_profile_at_work_all_day(user_id: str):
    """Force at_work status. shift_schedule.enabled, pattern=['day'],
    shifts.day.start_time='00:00', work_end_time='23:59', sleep_time='23:59'
    so sleeping is FALSE and at_work is TRUE for ~all 24h.

    NOTE: server validator strips work_end_time, so we MUST write directly to DB."""
    today_iso = datetime.now(timezone.utc).date().isoformat()
    db.profile.update_one(
        {"_id": user_id},
        {"$set": {
            "timezone": "UTC",
            "shift_schedule": {
                "enabled": True,
                "setup_complete": True,
                "pattern_kind": "rotating",
                "pattern": ["day"],
                "pattern_start_date": today_iso,
                "refresh_offset_hours": 2,
                "manual_overrides": {},
                "shifts": {
                    "day": {
                        "start_time": "00:00",
                        "work_end_time": "23:59",
                        "sleep_time": "23:59",
                        "icon": "🏢",
                        "color": "#0066cc",
                    },
                    "night": {
                        "start_time": "22:00",
                        "sleep_time": "06:00",
                        "icon": "🌙",
                        "color": "#3344aa",
                    },
                    "off": {
                        "start_time": "08:00",
                        "sleep_time": "23:00",
                        "icon": "🛌",
                        "color": "#888888",
                    },
                },
            },
        }},
        upsert=True,
    )


def clear_profile_schedule(user_id: str):
    db.profile.update_one(
        {"_id": user_id},
        {"$set": {"shift_schedule": {
            "enabled": False,
            "setup_complete": False,
            "pattern_kind": "rotating",
            "pattern": [],
            "pattern_start_date": datetime.now(timezone.utc).date().isoformat(),
            "refresh_offset_hours": 2,
            "manual_overrides": {},
            "shifts": {},
        }}},
    )


def find_defer_row(group_id: str, anchor_date: str, anchor_idx: int) -> Optional[dict]:
    return db.spot_anchor_deferrals.find_one({"_id": f"{anchor_date}:{anchor_idx}:{group_id}"})


def backdate_defer_next_try(group_id: str, anchor_date: str, anchor_idx: int, attempts_to_set: int):
    """Force the defer row to look like it's already had `attempts_to_set` attempts
    AND next_try_at is in the past (so cooldown does not block)."""
    now_utc = datetime.now(timezone.utc)
    past_iso = (now_utc - timedelta(minutes=1)).isoformat()
    fake_attempts = [(now_utc - timedelta(hours=2 + i)).isoformat() for i in range(attempts_to_set)]
    db.spot_anchor_deferrals.update_one(
        {"_id": f"{anchor_date}:{anchor_idx}:{group_id}"},
        {"$set": {
            "attempts": fake_attempts,
            "next_try_at": past_iso,
            "dropped": False,
            "updated_at": now_utc.isoformat(),
            "group_id": group_id,
            "anchor_date": anchor_date,
            "anchor_idx": anchor_idx,
        }},
        upsert=True,
    )


# Tiny 1x1 PNG (transparent) — used for spot/complete photo payload.
TINY_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjC"
    "B0C8AAAAASUVORK5CYII="
)


# ─────────────────────────── MAIN ───────────────────────────
def main():
    print(f"\n{'='*70}\nSpot Phase 3 — Availability + Defer + Feed — backend test\n{'='*70}\n")

    # ── SETUP ──────────────────────────────────────────────
    print("\n── SETUP ─────────────────────────────────────────────\n")
    admin = login_admin()
    print(f"  admin user_id={admin['user_id']}")
    A = register_user("Owen SpotP3")
    B = register_user("Bella SpotP3")
    C = register_user("Cara NonMember")
    print(f"  registered A={A['user_id'][:8]}.. B={B['user_id'][:8]}.. C={C['user_id'][:8]}..")

    befriend(admin, A)
    befriend(admin, B)
    print("  befriended admin<->A, admin<->B")

    # Save originals so we can restore later.
    orig_admin = db.profile.find_one({"_id": admin["user_id"]}) or {}
    orig_admin_sched = orig_admin.get("shift_schedule")

    # ─────────── SECTION 1: Availability statuses ───────────
    print("\n── SECTION 1: Availability statuses ─────────────────\n")

    # 1a Create a permanent group admin+A+B (all fresh users so status='active')
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"], B["user_id"]],
        "name": "P3 Status Group",
    })
    assert_eq(r.status_code, 200, "1a POST /spot/groups admin+A+B status")
    if r.status_code != 200:
        print(f"     create failed: {r.text[:300]}")
        _summarize()
        return
    g_status = r.json()["group"]
    gid_status = g_status["id"]
    print(f"     gid_status={gid_status}")

    # Verify shape: members[].status field exists and is in the expected set
    members = g_status.get("members") or []
    assert_eq(len(members), 3, "1a members.length == 3 (admin+A+B)")
    valid_statuses = {"active", "sleeping", "at_work", "left"}
    for m in members:
        assert_in(m.get("status"), valid_statuses,
                  f"1a member[{m.get('user_id','?')[:8]}..].status in {valid_statuses}")

    # 1b Fresh test users A and B should be 'active' (no shift_schedule)
    m_by_uid = {m["user_id"]: m for m in members}
    assert_eq(m_by_uid[A["user_id"]]["status"], "active",
              "1b A (fresh user) status=='active'")
    assert_eq(m_by_uid[B["user_id"]]["status"], "active",
              "1b B (fresh user) status=='active'")

    # 1c Force A to 'sleeping' via direct DB. Confirm.
    set_profile_sleeping_all_day(A["user_id"])
    r = get(f"/spot/groups/{gid_status}", token=admin["token"])
    assert_eq(r.status_code, 200, "1c GET group after A sleeping override")
    if r.status_code == 200:
        ms = {m["user_id"]: m for m in r.json()["group"]["members"]}
        assert_eq(ms[A["user_id"]]["status"], "sleeping",
                  "1c A status=='sleeping' after silence-window override")
        # B unchanged
        assert_eq(ms[B["user_id"]]["status"], "active",
                  "1c B status still 'active' (no override)")

    # 1d Force B to 'at_work' via direct DB. Confirm.
    set_profile_at_work_all_day(B["user_id"])
    r = get(f"/spot/groups/{gid_status}", token=admin["token"])
    assert_eq(r.status_code, 200, "1d GET group after B at_work override")
    if r.status_code == 200:
        ms = {m["user_id"]: m for m in r.json()["group"]["members"]}
        assert_eq(ms[B["user_id"]]["status"], "at_work",
                  "1d B status=='at_work' after work-window override")
        assert_eq(ms[A["user_id"]]["status"], "sleeping",
                  "1d A status still 'sleeping'")

    # Cleanup: restore A & B for the rest of the test (we'll re-apply per section)
    clear_profile_schedule(A["user_id"])
    clear_profile_schedule(B["user_id"])
    r = get(f"/spot/groups/{gid_status}", token=admin["token"])
    if r.status_code == 200:
        ms = {m["user_id"]: m for m in r.json()["group"]["members"]}
        assert_eq(ms[A["user_id"]]["status"], "active",
                  "1e A status back to 'active' after clearing schedule")
        assert_eq(ms[B["user_id"]]["status"], "active",
                  "1e B status back to 'active' after clearing schedule")

    # ─────────── SECTION 2: Defer logic ───────────
    print("\n── SECTION 2: Defer logic ───────────────────────────\n")

    # 2a Create a fresh group P3 Defer (admin + A), turn auto on
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"]],
        "name": "P3 Defer Group",
    })
    assert_eq(r.status_code, 200, "2a create P3 Defer group status")
    if r.status_code != 200:
        print(f"     create failed: {r.text[:300]}")
        _summarize()
        return
    gid_defer = r.json()["group"]["id"]
    print(f"     gid_defer={gid_defer}")

    r = patch(f"/spot/groups/{gid_defer}", token=admin["token"],
              body={"auto_challenge_on": True})
    assert_eq(r.status_code, 200, "2a PATCH auto_challenge_on=true status")

    # 2b Force BOTH admin and A to 'sleeping'
    set_profile_sleeping_all_day(admin["user_id"])
    set_profile_sleeping_all_day(A["user_id"])
    r = get(f"/spot/groups/{gid_defer}", token=admin["token"])
    if r.status_code == 200:
        ms = {m["user_id"]: m for m in r.json()["group"]["members"]}
        assert_eq(ms[admin["user_id"]]["status"], "sleeping",
                  "2b admin status=='sleeping'")
        assert_eq(ms[A["user_id"]]["status"], "sleeping",
                  "2b A status=='sleeping'")

    # 2c force-tick #1 — should DEFER (recipients=0, no fire)
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "2c force-tick #1 status")
    j = r.json() if r.status_code == 200 else {}
    fired1 = j.get("fired_to_groups")
    anchor_idx1 = j.get("anchor_idx")
    anchor_date = j.get("date")
    assert_eq(fired1, 0, "2c fired_to_groups==0 (all sleeping → no real dispatch)")
    print(f"     anchor_idx1={anchor_idx1} date={anchor_date}")

    # Wait a tick for any async write to settle.
    time.sleep(0.5)

    # 2d Inspect spot_anchor_deferrals row
    defer_row = find_defer_row(gid_defer, anchor_date, anchor_idx1)
    assert_true(defer_row is not None,
                "2d spot_anchor_deferrals row exists for (gid, today, anchor#1)")
    if defer_row:
        attempts = defer_row.get("attempts") or []
        assert_eq(len(attempts), 1, "2d attempts.length==1")
        assert_eq(bool(defer_row.get("dropped")), False, "2d dropped==False")
        assert_true(defer_row.get("next_try_at") is not None,
                    "2d next_try_at is set (cooldown)")
        # next_try_at should be ~1h in the future
        try:
            nt = datetime.fromisoformat(defer_row["next_try_at"])
            now = datetime.now(timezone.utc)
            delta_min = (nt - now).total_seconds() / 60
            assert_true(55 <= delta_min <= 65,
                        f"2d next_try_at ~1h ahead (got {delta_min:.1f}min)")
        except Exception as e:
            _fail(f"2d next_try_at ISO parse — {e}")
        assert_eq(defer_row.get("group_id"), gid_defer, "2d row.group_id matches")
        assert_eq(defer_row.get("anchor_date"), anchor_date, "2d row.anchor_date matches")
        assert_eq(defer_row.get("anchor_idx"), anchor_idx1, "2d row.anchor_idx matches")

    # No challenge row should exist for this anchor
    chall_count = db.spot_group_challenges.count_documents({
        "group_id": gid_defer,
        "anchor_date": anchor_date,
        "anchor_idx": anchor_idx1,
    })
    assert_eq(chall_count, 0, "2d no spot_group_challenges row for deferred anchor")

    # GET /challenges should also not include this anchor
    r = get(f"/spot/groups/{gid_defer}/challenges", token=admin["token"])
    assert_eq(r.status_code, 200, "2d GET /challenges status")
    if r.status_code == 200:
        chs = r.json().get("challenges") or []
        ids = {c.get("anchor_idx") for c in chs}
        assert_true(anchor_idx1 not in ids,
                    "2d /challenges does NOT contain deferred anchor row")

    # 2e Simulate ALREADY 2 attempts + cooldown elapsed for THIS anchor.
    # Then trigger one more dispatch — should DROP (3rd attempt).
    backdate_defer_next_try(gid_defer, anchor_date, anchor_idx1, attempts_to_set=2)
    # The minute-tick runs every 60s. Wait up to 75s and check whether
    # this anchor was re-dispatched. We know it's still un-fired
    # (fired_group_ids does NOT contain gid_defer for soft defers).
    print("     waiting up to 75s for minute-tick to re-dispatch the soft-deferred anchor...")
    dropped = False
    attempts_final = None
    for sec in range(0, 80, 5):
        time.sleep(5)
        row = find_defer_row(gid_defer, anchor_date, anchor_idx1)
        if row and len(row.get("attempts") or []) >= 3:
            dropped = bool(row.get("dropped"))
            attempts_final = len(row.get("attempts") or [])
            print(f"     minute-tick fired after ~{sec+5}s; attempts={attempts_final} dropped={dropped}")
            break
    assert_true(attempts_final == 3,
                f"2e attempts==3 after minute-tick (got {attempts_final})")
    assert_true(dropped is True, "2e dropped==True after 3rd attempt")

    # 2f After drop, the anchor should be marked in fired_group_ids
    # (per code: dropped path $addToSet's gid).
    anchors_doc = db.spot_auto_anchors.find_one({"_id": anchor_date})
    times_list = (anchors_doc or {}).get("times") or []
    if anchor_idx1 is not None and 0 <= anchor_idx1 < len(times_list):
        fired_ids = times_list[anchor_idx1].get("fired_group_ids") or []
        assert_in(gid_defer, fired_ids,
                  "2f anchor.fired_group_ids contains gid after DROP (stops future retries)")

    # 2g After drop, another force-tick creates a NEW anchor. It should
    # also defer (because users are still sleeping), but the OLD anchor
    # remains untouched.
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "2g force-tick after drop status")
    if r.status_code == 200:
        jj = r.json()
        assert_eq(jj.get("fired_to_groups"), 0,
                  "2g fired_to_groups==0 (users still sleeping)")

    # 2h Cleanup — restore admin & A profiles to allow regression test.
    if orig_admin_sched is not None:
        db.profile.update_one({"_id": admin["user_id"]},
                              {"$set": {"shift_schedule": orig_admin_sched}})
    else:
        db.profile.update_one({"_id": admin["user_id"]},
                              {"$unset": {"shift_schedule": ""}})
    clear_profile_schedule(A["user_id"])

    # ─────────── SECTION 3: Group feed responses ───────────
    print("\n── SECTION 3: Group feed responses ──────────────────\n")

    # 3a Create a fresh group "P3 Feed Group" with admin + A + B all active.
    r = post("/spot/groups", token=admin["token"], body={
        "member_ids": [A["user_id"], B["user_id"]],
        "name": "P3 Feed Group",
    })
    assert_eq(r.status_code, 200, "3a create P3 Feed group status")
    if r.status_code != 200:
        print(f"     create failed: {r.text[:300]}")
        _summarize()
        return
    gid_feed = r.json()["group"]["id"]

    r = patch(f"/spot/groups/{gid_feed}", token=admin["token"],
              body={"auto_challenge_on": True})
    assert_eq(r.status_code, 200, "3a PATCH auto_challenge_on=true status")

    # 3b Verify admin/A/B all 'active'
    r = get(f"/spot/groups/{gid_feed}", token=admin["token"])
    if r.status_code == 200:
        ms = {m["user_id"]: m for m in r.json()["group"]["members"]}
        assert_eq(ms[admin["user_id"]]["status"], "active", "3b admin status=='active'")
        assert_eq(ms[A["user_id"]]["status"], "active", "3b A status=='active'")
        assert_eq(ms[B["user_id"]]["status"], "active", "3b B status=='active'")

    # 3c force-tick → should fire to this group (recipients_count==3)
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "3c force-tick status")
    j = r.json() if r.status_code == 200 else {}
    target1 = j.get("target_object")
    fired_n = j.get("fired_to_groups")
    assert_true(isinstance(target1, str) and target1,
                f"3c target_object is a non-empty string (got {target1!r})")
    assert_true(fired_n is not None and fired_n >= 1,
                f"3c fired_to_groups >= 1 (got {fired_n})")

    time.sleep(0.5)

    # 3d GET /challenges as admin → at least one challenge with target=target1.
    r = get(f"/spot/groups/{gid_feed}/challenges", token=admin["token"])
    assert_eq(r.status_code, 200, "3d GET /challenges status")
    chs = r.json().get("challenges") or [] if r.status_code == 200 else []
    assert_true(len(chs) >= 1, f"3d /challenges has at least 1 row (got {len(chs)})")
    ch1 = chs[0] if chs else None
    assert_true(ch1 is not None, "3d ch1 is not None")
    if ch1:
        assert_eq(ch1.get("target_object"), target1, "3d ch1.target_object matches forced anchor")
        # New Phase 3 fields
        for k in ("skipped_sleeping_count", "skipped_work_count",
                  "skipped_night_count", "response_count",
                  "you_responded", "responses", "recipients_count"):
            assert_in(k, ch1.keys(), f"3d ch1 has '{k}' key")
        assert_true(ch1.get("recipients_count") >= 3,
                    f"3d recipients_count>=3 (got {ch1.get('recipients_count')})")
        assert_eq(ch1.get("skipped_sleeping_count"), 0, "3d skipped_sleeping_count==0")
        assert_eq(ch1.get("skipped_work_count"), 0, "3d skipped_work_count==0")
        assert_eq(ch1.get("response_count"), 0, "3d response_count==0 initially")
        assert_eq(ch1.get("you_responded"), False, "3d you_responded==false initially")
        assert_eq(ch1.get("responses"), [], "3d responses==[] initially")

    # 3e Post matching spots from admin and B with target=target1
    # admin completes
    r = post("/spot/complete", token=admin["token"], body={
        "target_object": target1,
        "photo_base64": TINY_B64,
        "success": True,
        "remaining_seconds": 9,
        "mode": "solo_constant",
    })
    assert_eq(r.status_code, 200, "3e admin POST /spot/complete (target1) status")

    r = post("/spot/complete", token=B["token"], body={
        "target_object": target1,
        "photo_base64": TINY_B64,
        "success": True,
        "remaining_seconds": 8,
        "mode": "solo_constant",
    })
    assert_eq(r.status_code, 200, "3e B POST /spot/complete (target1) status")

    # 3f GET /challenges → response_count==2, you_responded=true (for admin)
    r = get(f"/spot/groups/{gid_feed}/challenges", token=admin["token"])
    if r.status_code == 200:
        chs = r.json().get("challenges") or []
        # ch with target_object==target1 and matching anchor_idx of force-tick (most recent)
        ch1n = next((c for c in chs if c.get("target_object") == target1), None)
        assert_true(ch1n is not None, "3f ch1 still present in /challenges")
        if ch1n:
            assert_eq(ch1n.get("response_count"), 2,
                      "3f response_count==2 after 2 spots")
            assert_eq(ch1n.get("you_responded"), True,
                      "3f you_responded==true (admin posted)")
            resps = ch1n.get("responses") or []
            uids = {r.get("user_id") for r in resps}
            assert_in(admin["user_id"], uids, "3f responses contain admin")
            assert_in(B["user_id"], uids, "3f responses contain B")
            # Each response has the required keys
            if resps:
                rkeys = set(resps[0].keys())
                for k in ("id", "user_id", "photo_base64", "taken_at", "remaining_seconds"):
                    assert_in(k, rkeys, f"3f response has '{k}'")

    # 3g Force-tick #2 — fires a SECOND challenge, target2 (may equal target1).
    # We need the response window for ch1 to CLOSE at ch2.fired_at_utc.
    # We'll then post a spot for target1 AFTER ch2 and verify it does NOT
    # land under ch1.
    time.sleep(1.5)  # ensure ch2.fired_at_utc > ch1.taken_ats
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "3g force-tick #2 status")
    j2 = r.json() if r.status_code == 200 else {}
    target2 = j2.get("target_object")
    fired2 = j2.get("fired_to_groups")
    assert_true(fired2 is not None and fired2 >= 1,
                f"3g #2 fired_to_groups>=1 (got {fired2})")
    print(f"     target1={target1!r} target2={target2!r}")
    time.sleep(0.5)

    # 3h Now A posts for target1 (which is now OUTSIDE ch1's response
    # window because ch2 has fired). Verify response_count for ch1 stays 2.
    r = post("/spot/complete", token=A["token"], body={
        "target_object": target1,
        "photo_base64": TINY_B64,
        "success": True,
        "remaining_seconds": 4,
        "mode": "solo_constant",
    })
    assert_eq(r.status_code, 200, "3h A POST /spot/complete (late target1) status")

    r = get(f"/spot/groups/{gid_feed}/challenges", token=admin["token"])
    if r.status_code == 200:
        chs = r.json().get("challenges") or []
        # Find the OLDER challenge by selecting the one with the lower
        # fired_at_utc (the response from challenges endpoint is sorted DESC).
        chs_sorted = sorted(chs, key=lambda c: c.get("fired_at_utc") or "")
        ch_old = None
        # match by target_object to find ch1 specifically (might be 2 with
        # same target — pick the OLDEST one matching target1)
        for c in chs_sorted:
            if c.get("target_object") == target1:
                ch_old = c
                break
        assert_true(ch_old is not None, "3h ch_old (older challenge with target1) found")
        if ch_old:
            assert_eq(ch_old.get("response_count"), 2,
                      "3h ch1.response_count still 2 (A's late post excluded)")
            uids = {r.get("user_id") for r in (ch_old.get("responses") or [])}
            assert_true(A["user_id"] not in uids,
                        "3h ch1.responses does NOT contain A's late post")
        # If target2 == target1, the LATEST ch should now include A's response.
        if target2 == target1:
            ch_new = chs_sorted[-1] if chs_sorted else None
            if ch_new and ch_new.get("target_object") == target1:
                uids_new = {r.get("user_id") for r in (ch_new.get("responses") or [])}
                assert_in(A["user_id"], uids_new,
                          "3h (same-target) latest challenge picks up A's response")
        else:
            # different target — A's response should NOT appear on ch2 either.
            ch2 = next((c for c in chs_sorted if c.get("target_object") == target2 and c is not ch_old), None)
            if ch2:
                resp_ct = ch2.get("response_count") or 0
                assert_eq(resp_ct, 0,
                          "3h (diff target) ch2.response_count==0 (A targeted wrong obj)")

    # 3i Non-member C → GET /challenges → 403
    r = get(f"/spot/groups/{gid_feed}/challenges", token=C["token"])
    assert_eq(r.status_code, 403, "3i non-member C GET /challenges → 403")

    # ─────────── SECTION 4: Regression — Phase 1 + Phase 2 ───────────
    print("\n── SECTION 4: Regression ────────────────────────────\n")

    # 4a Phase 1: list groups (admin should see status, defer, feed)
    r = get("/spot/groups", token=admin["token"])
    assert_eq(r.status_code, 200, "4a GET /spot/groups status")
    if r.status_code == 200:
        groups_listed = {g["id"] for g in r.json().get("groups") or []}
        assert_in(gid_status, groups_listed, "4a list contains gid_status")
        assert_in(gid_defer, groups_listed, "4a list contains gid_defer")
        assert_in(gid_feed, groups_listed, "4a list contains gid_feed")

    # 4b Phase 1: GET single group
    r = get(f"/spot/groups/{gid_feed}", token=admin["token"])
    assert_eq(r.status_code, 200, "4b GET /spot/groups/{gid_feed} status")

    # 4c Phase 1: PATCH name
    r = patch(f"/spot/groups/{gid_feed}", token=admin["token"],
              body={"name": "P3 Feed Group (renamed)"})
    assert_eq(r.status_code, 200, "4c PATCH name status")
    if r.status_code == 200:
        assert_eq(r.json()["group"]["name"], "P3 Feed Group (renamed)",
                  "4c name updated")

    # 4d Phase 1: leave gid_status as A
    r = post(f"/spot/groups/{gid_status}/leave", token=A["token"])
    assert_eq(r.status_code, 200, "4d A POST /leave gid_status status")

    # 4e Phase 2 regression: force-tick on an all-active group fires
    # normally. We've already done this in section 3 (3c/3g); just
    # verify once more on gid_feed.
    r = post("/admin/spot/scheduler/force-tick", token=admin["token"])
    assert_eq(r.status_code, 200, "4e force-tick (all active) status")
    if r.status_code == 200:
        ft = r.json().get("fired_to_groups")
        assert_true(ft is not None and ft >= 1,
                    f"4e fired_to_groups>=1 on all-active group (got {ft})")

    # 4f Non-member C → GET /challenges → 403 (regression)
    r = get(f"/spot/groups/{gid_feed}/challenges", token=C["token"])
    assert_eq(r.status_code, 403, "4f non-member C GET /challenges → 403 (regression)")

    # 4g Phase 1: leave gid_defer as A to drop the auto-on test group
    post(f"/spot/groups/{gid_defer}/leave", token=A["token"])
    post(f"/spot/groups/{gid_defer}/leave", token=admin["token"])

    _summarize()


if __name__ == "__main__":
    main()
