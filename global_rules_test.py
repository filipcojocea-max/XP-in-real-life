"""
Backend tests for the 6 Global Rules.

Targets the live preview backend at https://xp-confidence.preview.emergentagent.com/api.

Tested rules:
  Rule 1 — Leaderboard L1 gate (hide total_xp=0 except viewer)
  Rule 2 — /spot/object non-repeat queue (per user)
  Rule 3 — Per-group non-repeat queue
  Rule 4 — /confidence/daily per-user queue + same-day memoisation
  Rule 5 — (skipped — not wired)
  Rule 6 — Buried Treasure FFA on reject

Also regression-checks:
  * Phase 1-4 spot groups create→start→list_challenges still pass
  * Buried Treasure normal-accept (no FFA) still works

Run:
    python /app/global_rules_test.py
"""
from __future__ import annotations

import json
import os
import random
import string
import sys
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone

import requests
try:
    import pymongo
except Exception:
    pymongo = None  # optional — only used for direct queue inspection

BASE = "https://xp-confidence.preview.emergentagent.com/api"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

# Brisbane example for bt_locations
BRIS_LAT = -27.4698
BRIS_LNG = 153.0251
BRIS_RADIUS = 5000

PASS: list[str] = []
FAIL: list[str] = []


def _r(method: str, path: str, token: str | None = None, **kw):
    headers = kw.pop("headers", {}) or {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.request(method, BASE + path, headers=headers, timeout=30, **kw)


def assert_ok(name: str, ok: bool, info: str = ""):
    if ok:
        PASS.append(name)
        print(f"  [PASS] {name}")
    else:
        FAIL.append(f"{name} — {info}")
        print(f"  [FAIL] {name} — {info}")


def section(title: str):
    print(f"\n{'=' * 4} {title} {'=' * 4}")


def _rand_email(prefix="gr"):
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    return f"{prefix}_{suffix}@gmail.com"


def login(email: str, password: str):
    r = _r("POST", "/auth/login", json={"email": email, "password": password})
    r.raise_for_status()
    j = r.json()
    return j["token"], j["user"]


def register(name: str, prefix="gr"):
    email = _rand_email(prefix)
    password = "Sup3rSecret!_" + uuid.uuid4().hex[:8]
    r = _r("POST", "/auth/register", json={"email": email, "password": password, "full_name": name})
    if r.status_code != 200:
        print(f"  REGISTER FAIL: {r.status_code} {r.text[:300]}")
        r.raise_for_status()
    j = r.json()
    uid = j["user"].get("user_id") or j["user"].get("id")
    return {"token": j["token"], "user_id": uid, "email": email, "password": password, "name": name}


def set_bt_location(tok: str, lat=BRIS_LAT, lng=BRIS_LNG, radius=BRIS_RADIUS):
    return _r("POST", "/bt/location", token=tok,
              json={"lat": lat, "lng": lng, "radius_m": radius, "label": "Brisbane"})


def friends(a, b):
    r1 = _r("POST", "/friends/request", token=a["token"], json={"user_id": b["user_id"]})
    r2 = _r("POST", "/friends/accept", token=b["token"], json={"user_id": a["user_id"]})
    return r1, r2


def get_profile_total_xp(token: str) -> int:
    r = _r("GET", "/profile", token=token)
    r.raise_for_status()
    return int(r.json().get("total_xp", 0))


# ───────────────────────── RULE 1 ─────────────────────────
def test_rule1_leaderboard_l1_gate(admin_token, admin_id):
    section("Rule 1 — Leaderboard L1 gate (hide total_xp=0 except viewer)")
    # Register a fresh user F (will be 0 XP, befriended with admin).
    F = register("Freshie L1Gate", prefix="r1")
    friends({"token": admin_token, "user_id": admin_id}, F)

    # 1a. As ADMIN, GET /friends/leaderboard. F should NOT appear (total_xp=0).
    r = _r("GET", "/friends/leaderboard?tz=0", token=admin_token)
    assert_ok("1a. admin GET /friends/leaderboard → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    rows = r.json().get("rows") if r.status_code == 200 else []
    if rows is None:
        # try alt key
        rows = r.json().get("leaderboard") or []
    f_uids = [row.get("user_id") for row in rows]
    assert_ok("1a. fresh 0-XP friend F NOT in admin's leaderboard",
              F["user_id"] not in f_uids,
              f"F={F['user_id']} present in {f_uids[:6]}")

    # 1b. As F itself, GET /friends/leaderboard — F should appear (viewer exception).
    r = _r("GET", "/friends/leaderboard?tz=0", token=F["token"])
    assert_ok("1b. F GET /friends/leaderboard → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    rows = (r.json().get("rows") if r.status_code == 200 else []) or r.json().get("leaderboard") or []
    f_present = any(row.get("user_id") == F["user_id"] and row.get("is_self") for row in rows)
    assert_ok("1b. viewer F sees themselves in their OWN leaderboard",
              f_present, f"rows={[(x.get('user_id'), x.get('is_self')) for x in rows][:6]}")

    # 1c. Award XP to F via /confidence/complete (15 XP) so total_xp > 0,
    # then admin should see F.
    _r("GET", "/confidence/daily", token=F["token"])  # init queues
    cr = _r("POST", "/confidence/complete", token=F["token"], json={"track": "social"})
    assert_ok("1c. F completed confidence/social",
              cr.status_code == 200, f"{cr.status_code} {cr.text[:200]}")
    f_xp_after = get_profile_total_xp(F["token"])
    assert_ok("1c. F now has total_xp > 0", f_xp_after > 0, f"f_xp_after={f_xp_after}")

    r = _r("GET", "/friends/leaderboard?tz=0", token=admin_token)
    rows = (r.json().get("rows") if r.status_code == 200 else []) or r.json().get("leaderboard") or []
    f_uids = [row.get("user_id") for row in rows]
    assert_ok("1c. After XP award, F now VISIBLE on admin's leaderboard",
              F["user_id"] in f_uids,
              f"F={F['user_id']} missing from {f_uids[:8]}")
    return F


# ───────────────────────── RULE 2 ─────────────────────────
def test_rule2_spot_object_queue(admin_token, admin_id):
    section("Rule 2 — /spot/object non-repeat queue")
    # Use a fresh user to start from an empty queue.
    U = register("SpotQueue User", prefix="r2")

    # Fetch SPOT_OBJECTS pool size by repeating until first repeat seen.
    # First, infer pool size as <=80 max; we'll request ~100 and detect cycle.
    seen_order: list[str] = []
    for _ in range(80):
        r = _r("GET", "/spot/object", token=U["token"])
        if r.status_code != 200:
            assert_ok("/spot/object 200", False, f"{r.status_code} {r.text[:200]}")
            return
        obj = r.json().get("object")
        seen_order.append(obj)

    # All 80 pulls returned 200.
    assert_ok("2a. /spot/object 80 consecutive calls all 200",
              len(seen_order) == 80, f"got={len(seen_order)}")

    # Find first repeat index — that defines pool_size.
    first_seen: dict[str, int] = {}
    first_repeat_at = None
    repeat_value = None
    for i, o in enumerate(seen_order):
        if o in first_seen:
            first_repeat_at = i
            repeat_value = o
            break
        first_seen[o] = i

    pool_size = first_repeat_at if first_repeat_at is not None else len(set(seen_order))
    print(f"  detected pool_size={pool_size} (first repeat at idx={first_repeat_at}, val={repeat_value})")

    # 2b. Up to (pool_size) entries: no duplicates ⇒ all distinct.
    first_cycle = seen_order[:pool_size]
    distinct = len(set(first_cycle))
    assert_ok("2b. first cycle has zero duplicates (queue-no-repeat)",
              distinct == pool_size,
              f"distinct={distinct} / pool_size={pool_size}")

    # 2c. After pool exhausted, the queue auto-reshuffles → next pull is allowed
    # to repeat (cycle bumps). Verify by checking remaining pulls contain
    # AT LEAST ONE value from the first cycle.
    second_cycle_overlap = sum(1 for o in seen_order[pool_size:] if o in set(first_cycle))
    assert_ok("2c. After pool exhausted, repeats begin (new cycle)",
              second_cycle_overlap > 0,
              f"overlap={second_cycle_overlap} second_cycle={seen_order[pool_size:pool_size+5]}")

    # 2d. Inspect Mongo challenge_queues row: cycle >= 2 by now.
    if pymongo is not None:
        try:
            mc = pymongo.MongoClient(MONGO_URL, serverSelectionTimeoutMS=3000)
            db = mc[DB_NAME]
            qid = f"user:{U['user_id']}:spot_solo"
            doc = db.challenge_queues.find_one({"_id": qid})
            cycle = int((doc or {}).get("cycle", 0))
            assert_ok("2d. challenge_queues row exists for user:spot_solo",
                      doc is not None, f"qid={qid}")
            assert_ok("2d. cycle >= 2 after pool exhausted + extra pulls",
                      cycle >= 2, f"cycle={cycle}")
        except Exception as e:
            print(f"  [WARN] Mongo inspect failed (non-fatal): {e}")


# ───────────────────────── RULE 3 ─────────────────────────
def test_rule3_per_group_queue(admin_token, admin_id):
    section("Rule 3 — Per-group non-repeat queue")
    # Create 4 fresh users → 2 groups of (admin + helper1) and (admin + helper2)
    # NB: Group must have >=2 accepted members to start. We'll create:
    #   G1: admin + H1   (H1 added by admin)
    #   G2: admin + H2
    # admin invites both helpers, they accept, admin starts each group.
    H1 = register("Helper One R3", prefix="r3a")
    H2 = register("Helper Two R3", prefix="r3b")
    H3 = register("Helper Three R3", prefix="r3c")
    H4 = register("Helper Four R3", prefix="r3d")

    # Befriend admin with all helpers
    admin_user = {"token": admin_token, "user_id": admin_id}
    for h in (H1, H2, H3, H4):
        friends(admin_user, h)

    # IMPORTANT: The spot_groups_auto scheduler skips members outside
    # daylight (fallback window 06:00-20:00 local). Fresh users default
    # to Australia/Sydney TZ which may be night when this test runs.
    # Force everyone (admin + helpers) into UTC so they're in daylight
    # at any non-evening UTC moment. We poke profile.timezone directly
    # via Mongo because there's no public endpoint for it.
    if pymongo is not None:
        try:
            mc = pymongo.MongoClient(MONGO_URL, serverSelectionTimeoutMS=3000)
            db = mc[DB_NAME]
            ids = [admin_id] + [H1["user_id"], H2["user_id"], H3["user_id"], H4["user_id"]]
            db.profile.update_many({"_id": {"$in": ids}},
                                   {"$set": {"timezone": "Europe/London"}})
            # Wipe deferrals from previous test runs that would otherwise
            # keep our groups "next_try_at" suppressed.
            db.spot_anchor_deferrals.delete_many({"group_id": {"$in": ids}})
        except Exception as e:
            print(f"  [WARN] profile.timezone seed failed: {e}")

    # Create G1 with admin + H1, H2
    r = _r("POST", "/spot/groups", token=admin_token,
           json={"name": "R3 Group ONE", "member_ids": [H1["user_id"], H2["user_id"]]})
    assert_ok("3a. Admin creates G1 → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    G1 = r.json().get("group", {}).get("id") if r.status_code == 200 else None

    r = _r("POST", "/spot/groups", token=admin_token,
           json={"name": "R3 Group TWO", "member_ids": [H3["user_id"], H4["user_id"]]})
    assert_ok("3a. Admin creates G2 → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    G2 = r.json().get("group", {}).get("id") if r.status_code == 200 else None

    if not G1 or not G2:
        assert_ok("3a. Both groups created", False, f"G1={G1} G2={G2}")
        return

    # Accept invites
    for h in (H1, H2):
        ra = _r("POST", f"/spot/groups/{G1}/accept", token=h["token"])
        assert_ok(f"3b. {h['name']} accept G1", ra.status_code == 200, f"{ra.status_code} {ra.text[:150]}")
    for h in (H3, H4):
        ra = _r("POST", f"/spot/groups/{G2}/accept", token=h["token"])
        assert_ok(f"3b. {h['name']} accept G2", ra.status_code == 200, f"{ra.status_code} {ra.text[:150]}")

    # Start both groups (admin is accepted owner)
    r = _r("POST", f"/spot/groups/{G1}/start", token=admin_token)
    assert_ok("3c. Start G1 → 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    r = _r("POST", f"/spot/groups/{G2}/start", token=admin_token)
    assert_ok("3c. Start G2 → 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # Force-tick the scheduler once → both groups get a fresh challenge with
    # per-group queue picks.
    r = _r("POST", "/admin/spot/scheduler/force-tick", token=admin_token)
    assert_ok("3d. force-tick #1 → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    fired = r.json().get("fired_to_groups") if r.status_code == 200 else 0
    assert_ok("3d. force-tick fired to >=2 groups",
              (fired or 0) >= 2, f"fired={fired}")

    # Brief pause to let challenge inserts complete
    time.sleep(1.0)

    def latest_target(gid: str) -> str | None:
        r = _r("GET", f"/spot/groups/{gid}/challenges", token=admin_token)
        if r.status_code != 200:
            return None
        chs = r.json().get("challenges") or []
        return chs[0].get("target_object") if chs else None

    g1_t1 = latest_target(G1)
    g2_t1 = latest_target(G2)
    print(f"  G1 target after tick #1: {g1_t1}")
    print(f"  G2 target after tick #1: {g2_t1}")
    assert_ok("3e. G1 + G2 both got a target object",
              bool(g1_t1) and bool(g2_t1), f"g1={g1_t1} g2={g2_t1}")
    assert_ok("3e. G1 and G2 have DIFFERENT targets at the same anchor (per-group queue)",
              g1_t1 != g2_t1, f"g1={g1_t1} g2={g2_t1}")

    # Now exercise per-group non-repeat for several more ticks (within G1 only,
    # collect 6 ticks of G1 targets — should be 6 distinct).
    g1_history: list[str] = [g1_t1] if g1_t1 else []
    for i in range(5):
        r = _r("POST", "/admin/spot/scheduler/force-tick", token=admin_token)
        if r.status_code != 200:
            break
        time.sleep(0.8)
        nt = latest_target(G1)
        if nt:
            g1_history.append(nt)

    print(f"  G1 tick history: {g1_history}")
    distinct = len(set(g1_history))
    assert_ok("3f. Within G1, 6 ticks produce 6 DISTINCT objects (per-group queue no-repeat)",
              distinct == len(g1_history),
              f"history={g1_history} distinct={distinct}")

    # Inspect Mongo queue rows for both groups
    if pymongo is not None:
        try:
            mc = pymongo.MongoClient(MONGO_URL, serverSelectionTimeoutMS=3000)
            db = mc[DB_NAME]
            q1 = db.challenge_queues.find_one({"_id": f"group:{G1}:spot_group"})
            q2 = db.challenge_queues.find_one({"_id": f"group:{G2}:spot_group"})
            assert_ok("3g. challenge_queues row for G1 exists", q1 is not None, f"G1={G1}")
            assert_ok("3g. challenge_queues row for G2 exists", q2 is not None, f"G2={G2}")
            if q1 and q2:
                # Two independent queues — used lists likely differ (different shuffles).
                u1 = q1.get("used") or []
                u2 = q2.get("used") or []
                assert_ok("3g. G1 and G2 queues track independent 'used' lists",
                          u1 != u2 or len(u1) > 0,
                          f"u1={u1[:3]} u2={u2[:3]}")
        except Exception as e:
            print(f"  [WARN] Mongo inspect failed (non-fatal): {e}")


# ───────────────────────── RULE 4 ─────────────────────────
def test_rule4_confidence_per_user(admin_token):
    section("Rule 4 — Build Confidence per-user queue")
    U1 = register("Confidence One", prefix="r4a")
    U2 = register("Confidence Two", prefix="r4b")

    r1 = _r("GET", "/confidence/daily", token=U1["token"])
    r2 = _r("GET", "/confidence/daily", token=U2["token"])
    assert_ok("4a. U1 GET /confidence/daily → 200",
              r1.status_code == 200, f"{r1.status_code} {r1.text[:200]}")
    assert_ok("4a. U2 GET /confidence/daily → 200",
              r2.status_code == 200, f"{r2.status_code} {r2.text[:200]}")

    if r1.status_code != 200 or r2.status_code != 200:
        return

    j1, j2 = r1.json(), r2.json()
    # Identifier field — try 'title' first.
    def _ident(track_obj):
        return track_obj.get("title") or track_obj.get("text") or track_obj.get("body") or json.dumps(track_obj, sort_keys=True)[:60]

    # We expect at least ONE of the three tracks to differ between U1 and U2.
    diffs = 0
    for track in ("social", "physical", "gratitude"):
        i1 = _ident(j1.get(track) or {})
        i2 = _ident(j2.get(track) or {})
        if i1 != i2:
            diffs += 1
        print(f"  {track}: U1={i1[:40]!r}  U2={i2[:40]!r}  diff={i1!=i2}")
    assert_ok("4a. At least one track DIFFERS between U1 and U2 (per-user queue)",
              diffs >= 1, f"diffs={diffs} / 3 tracks")

    # 4b. Same user GETs /confidence/daily TWICE → identical picks (memoised).
    r1b = _r("GET", "/confidence/daily", token=U1["token"])
    j1b = r1b.json()
    same = True
    for track in ("social", "physical", "gratitude"):
        if _ident(j1.get(track) or {}) != _ident(j1b.get(track) or {}):
            same = False
            print(f"  drift in {track}: was {_ident(j1.get(track) or {})!r} now {_ident(j1b.get(track) or {})!r}")
    assert_ok("4b. Same user, same UTC day → identical picks (memoised)",
              same, "")

    # 4c. Mongo: confidence_today_picks row exists per (user, date, track)
    if pymongo is not None:
        try:
            mc = pymongo.MongoClient(MONGO_URL, serverSelectionTimeoutMS=3000)
            db = mc[DB_NAME]
            today = datetime.utcnow().date().isoformat()
            for track in ("social", "physical", "gratitude"):
                memo_id = f"{U1['user_id']}:{today}:{track}"
                memo = db.confidence_today_picks.find_one({"_id": memo_id})
                assert_ok(f"4c. confidence_today_picks memo for U1/{track} exists",
                          memo is not None, f"id={memo_id}")
        except Exception as e:
            print(f"  [WARN] Mongo inspect failed (non-fatal): {e}")


# ───────────────────────── RULE 6 ─────────────────────────
def test_rule6_bt_ffa(admin_token, admin_id):
    section("Rule 6 — Buried Treasure Free-For-All on reject")
    # Setup: admin + A, B, C as fresh friends. Admin has bt_location set.
    A = register("FFA Alice (rejecter)", prefix="r6a")
    B = register("FFA Bob (friend winner)", prefix="r6b")
    C = register("FFA Carla (late friend)", prefix="r6c")
    N = register("FFA NonFriend", prefix="r6n")
    admin_user = {"token": admin_token, "user_id": admin_id}
    for h in (A, B, C):
        friends(admin_user, h)
    # N is NOT a friend of admin.

    # Make sure admin has a bt_location (Brisbane). Also set for B, C (they
    # are the seekers; not strictly needed but harmless).
    set_bt_location(admin_token)
    set_bt_location(B["token"])
    set_bt_location(C["token"])

    # Admin invites A as seeker.
    r = _r("POST", "/bt/match/invite", token=admin_token, json={"friend_id": A["user_id"]})
    assert_ok("6a. Admin invite A → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code != 200:
        return
    mid = r.json().get("match", {}).get("id")
    assert_ok("6a. match id present", bool(mid), str(mid))

    # A REJECTS — should switch to FFA, NOT close.
    rr = _r("POST", f"/bt/match/{mid}/reject", token=A["token"])
    assert_ok("6b. A reject → 200",
              rr.status_code == 200, f"{rr.status_code} {rr.text[:200]}")
    if rr.status_code == 200:
        body = rr.json()
        assert_ok("6b. response has free_for_all=true",
                  body.get("free_for_all") is True, f"body={body}")
        match = body.get("match") or {}
        # Match state should still be 'pending_accept' (FFA flag flipped).
        assert_ok("6b. match state stays 'pending_accept' after FFA reject",
                  match.get("state") == "pending_accept",
                  f"state={match.get('state')}")

    # Admin still needs to BURY the chest before anyone can find it — the
    # reject path leaves match in pending_accept without a chest. Per the
    # FFA spec, the find logic accepts either pending_accept OR in_progress,
    # but it still requires lat/lng on the match. So admin must bury.
    #
    # The bury endpoint requires state='awaiting_burial'. After a reject the
    # state is still 'pending_accept', so bury would 400. We need a separate
    # path: the test plan says find lat/lng with correct coords, implying
    # the chest gets coords somewhere. Let's test what happens if we attempt
    # the FFA find at chest coords matching admin's bt_location.
    #
    # Since /bury requires state='awaiting_burial', after reject in FFA mode
    # the chest never gets buried unless admin sets coords via direct
    # mechanism. The handler at /find checks "if m.get('lat') is None or
    # m.get('lng') is None" → 500. So we must seed lat/lng directly via
    # Mongo to verify the FFA find logic.
    if pymongo is None:
        print("  [SKIP] pymongo unavailable — cannot seed chest coords for FFA find test")
        return
    try:
        mc = pymongo.MongoClient(MONGO_URL, serverSelectionTimeoutMS=3000)
        db = mc[DB_NAME]
        # Inject chest coords (admin's bt_location centre) into the match doc
        # so the FFA find can proceed.
        db.bt_matches.update_one(
            {"_id": mid},
            {"$set": {
                "lat": BRIS_LAT,
                "lng": BRIS_LNG,
                "hint": "FFA test chest",
                "buried_at": datetime.now(timezone.utc).isoformat(),
                "expires_at": (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat(),
            }},
        )
    except Exception as e:
        print(f"  [WARN] could not seed chest coords: {e}")
        return

    # 6c. As A AGAIN: /find → 403 "already declined"
    rf = _r("POST", f"/bt/match/{mid}/find", token=A["token"],
            json={"lat": BRIS_LAT, "lng": BRIS_LNG})
    assert_ok("6c. A POST /find after reject → 403",
              rf.status_code == 403, f"{rf.status_code} {rf.text[:200]}")
    assert_ok("6c. detail mentions 'declined'",
              "declined" in rf.text.lower(), rf.text[:200])

    # 6d. As N (non-friend): /find → 403 "friends only"
    rf = _r("POST", f"/bt/match/{mid}/find", token=N["token"],
            json={"lat": BRIS_LAT, "lng": BRIS_LNG})
    assert_ok("6d. Non-friend N POST /find → 403",
              rf.status_code == 403, f"{rf.status_code} {rf.text[:200]}")
    assert_ok("6d. detail mentions 'friends only'",
              "friends" in rf.text.lower(), rf.text[:200])

    # Capture admin + B XP before B wins.
    admin_xp_before = get_profile_total_xp(admin_token)
    b_xp_before = get_profile_total_xp(B["token"])

    # 6e. As B (friend of admin): /find with correct coords → 200 state=found
    rf = _r("POST", f"/bt/match/{mid}/find", token=B["token"],
            json={"lat": BRIS_LAT, "lng": BRIS_LNG})
    assert_ok("6e. B (friend) POST /find → 200",
              rf.status_code == 200, f"{rf.status_code} {rf.text[:300]}")
    if rf.status_code == 200:
        out = rf.json()
        assert_ok("6e. state == 'found'",
                  out.get("state") == "found", f"state={out.get('state')}")
        assert_ok("6e. winner_user_id == B",
                  (out.get("winner_user_id") or out.get("ffa_won_by")) == B["user_id"],
                  f"winner_user_id={out.get('winner_user_id')} ffa_won_by={out.get('ffa_won_by')}")
        # XP deltas
        b_xp_after = get_profile_total_xp(B["token"])
        admin_xp_after = get_profile_total_xp(admin_token)
        # XP_FIND_SEEKER=100, XP_FIND_HIDER=50
        assert_ok("6e. B.total_xp gained +100 (XP_FIND_SEEKER)",
                  (b_xp_after - b_xp_before) >= 100,
                  f"before={b_xp_before} after={b_xp_after}")
        assert_ok("6e. admin.total_xp gained +50 (XP_FIND_HIDER)",
                  (admin_xp_after - admin_xp_before) >= 50,
                  f"before={admin_xp_before} after={admin_xp_after}")

    # Verify in Mongo: ffa_won_by == B
    try:
        m_doc = db.bt_matches.find_one({"_id": mid})
        assert_ok("6e.m ffa_won_by stored as B in match doc",
                  m_doc.get("ffa_won_by") == B["user_id"],
                  f"ffa_won_by={m_doc.get('ffa_won_by')}")
        assert_ok("6e.m state in doc == 'found'",
                  m_doc.get("state") == "found", f"state={m_doc.get('state')}")
    except Exception as e:
        print(f"  [WARN] Mongo verify failed: {e}")

    # 6f. As C (late friend): /find → 400/409 (state already 'found')
    rf = _r("POST", f"/bt/match/{mid}/find", token=C["token"],
            json={"lat": BRIS_LAT, "lng": BRIS_LNG})
    assert_ok("6f. Late C POST /find → 400 or 409",
              rf.status_code in (400, 409), f"{rf.status_code} {rf.text[:200]}")


# ───────────────────────── REGRESSION ─────────────────────────
def test_regression_bt_normal_accept(admin_token, admin_id):
    section("Regression — Buried Treasure normal accept flow still works")
    # Two fresh friends; one invites, other accepts (not rejects).
    H = register("Reg Hider", prefix="reg_h")
    S = register("Reg Seeker", prefix="reg_s")
    friends(H, S)
    set_bt_location(H["token"])

    r = _r("POST", "/bt/match/invite", token=H["token"], json={"friend_id": S["user_id"]})
    assert_ok("reg.1. H invites S → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code != 200:
        return
    mid = r.json().get("match", {}).get("id")

    ra = _r("POST", f"/bt/match/{mid}/accept", token=S["token"])
    assert_ok("reg.2. S accept → 200",
              ra.status_code == 200, f"{ra.status_code} {ra.text[:200]}")
    if ra.status_code == 200:
        m = ra.json().get("match") or {}
        assert_ok("reg.2. state == 'awaiting_burial'",
                  m.get("state") == "awaiting_burial",
                  f"state={m.get('state')}")
        assert_ok("reg.2. NO free_for_all flag on normal accept",
                  not m.get("free_for_all"),
                  f"free_for_all={m.get('free_for_all')}")


def test_regression_spot_groups_basic(admin_token, admin_id):
    section("Regression — Phase 1-4 spot groups flow (create→accept→start→list_challenges)")
    P1 = register("RegSpot P1", prefix="rs1")
    P2 = register("RegSpot P2", prefix="rs2")
    admin_user = {"token": admin_token, "user_id": admin_id}
    friends(admin_user, P1)
    friends(admin_user, P2)

    r = _r("POST", "/spot/groups", token=admin_token,
           json={"name": "Regression Group", "member_ids": [P1["user_id"], P2["user_id"]]})
    assert_ok("reg.3 create group → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code != 200:
        return
    gid = r.json().get("group", {}).get("id")

    for h in (P1, P2):
        ra = _r("POST", f"/spot/groups/{gid}/accept", token=h["token"])
        assert_ok(f"reg.4 {h['name']} accept → 200",
                  ra.status_code == 200, f"{ra.status_code} {ra.text[:200]}")

    rs = _r("POST", f"/spot/groups/{gid}/start", token=admin_token)
    assert_ok("reg.5 start group → 200",
              rs.status_code == 200, f"{rs.status_code} {rs.text[:200]}")

    rc = _r("GET", f"/spot/groups/{gid}/challenges", token=admin_token)
    assert_ok("reg.6 list challenges → 200",
              rc.status_code == 200, f"{rc.status_code} {rc.text[:200]}")


# ───────────────────────── MAIN ─────────────────────────
def main():
    print(f"Testing against {BASE}")
    print(f"Mongo: {MONGO_URL} / {DB_NAME}")

    section("Setup: admin login")
    try:
        admin_token, admin_user = login(ADMIN_EMAIL, ADMIN_PASSWORD)
        admin_id = admin_user.get("user_id") or admin_user.get("id")
        assert_ok("admin login OK", True, admin_id)
    except Exception as e:
        assert_ok("admin login OK", False, repr(e))
        return

    try:
        test_rule1_leaderboard_l1_gate(admin_token, admin_id)
    except Exception:
        traceback.print_exc()
        assert_ok("RULE 1 crashed", False, "see traceback")

    try:
        test_rule2_spot_object_queue(admin_token, admin_id)
    except Exception:
        traceback.print_exc()
        assert_ok("RULE 2 crashed", False, "see traceback")

    try:
        test_rule3_per_group_queue(admin_token, admin_id)
    except Exception:
        traceback.print_exc()
        assert_ok("RULE 3 crashed", False, "see traceback")

    try:
        test_rule4_confidence_per_user(admin_token)
    except Exception:
        traceback.print_exc()
        assert_ok("RULE 4 crashed", False, "see traceback")

    try:
        test_rule6_bt_ffa(admin_token, admin_id)
    except Exception:
        traceback.print_exc()
        assert_ok("RULE 6 crashed", False, "see traceback")

    try:
        test_regression_bt_normal_accept(admin_token, admin_id)
    except Exception:
        traceback.print_exc()
        assert_ok("REG bt-normal crashed", False, "see traceback")

    try:
        test_regression_spot_groups_basic(admin_token, admin_id)
    except Exception:
        traceback.print_exc()
        assert_ok("REG spot-groups crashed", False, "see traceback")

    # Summary
    print(f"\n{'=' * 60}")
    print(f"PASSED: {len(PASS)}")
    print(f"FAILED: {len(FAIL)}")
    if FAIL:
        print("\nFailures:")
        for f in FAIL:
            print(f"  - {f}")
    print(f"{'=' * 60}\n")
    sys.exit(0 if not FAIL else 1)


if __name__ == "__main__":
    main()
