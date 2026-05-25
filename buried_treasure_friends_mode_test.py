"""
Backend test for Buried Treasure Phase 2 — Friends Mode (Relay Race).

Tests every endpoint in /app/backend/buried_treasure.py against
https://xp-confidence.preview.emergentagent.com/api as per
test_result.md spec.

Run:
    python /app/buried_treasure_friends_mode_test.py
"""
import base64
import os
import random
import string
import sys
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone

import pymongo
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

# Brisbane example
BRIS_LAT = -27.4698
BRIS_LNG = 153.0251
BRIS_RADIUS = 5000

PASS = []
FAIL = []


def _r(method: str, path: str, token: str = None, **kw):
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
    print(f"\n{'═' * 4} {title} {'═' * 4}")


def login(email: str, password: str):
    r = _r("POST", "/auth/login", json={"email": email, "password": password})
    r.raise_for_status()
    return r.json()["token"], r.json()["user"]


def _rand_email():
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    return f"bt_friends_{suffix}@gmail.com"


def register(name: str):
    email = _rand_email()
    password = "Sup3rSecret!_" + uuid.uuid4().hex[:8]
    r = _r("POST", "/auth/register", json={
        "email": email, "password": password, "full_name": name,
    })
    if r.status_code != 200:
        print(f"  REGISTER FAIL: {r.status_code} {r.text[:300]}")
        r.raise_for_status()
    j = r.json()
    return {"token": j["token"], "user_id": j["user"]["user_id"] if "user_id" in j["user"] else j["user"].get("id"), "email": email, "password": password, "name": name}


def set_location(tok: str, lat=BRIS_LAT, lng=BRIS_LNG, radius=BRIS_RADIUS):
    return _r("POST", "/bt/location", token=tok,
              json={"lat": lat, "lng": lng, "radius_m": radius, "label": "Brisbane"})


def friends(a, b):
    """Make a and b friends.  a sends request, b accepts."""
    r1 = _r("POST", "/friends/request", token=a["token"], json={"user_id": b["user_id"]})
    r2 = _r("POST", "/friends/accept", token=b["token"], json={"user_id": a["user_id"]})
    return r1, r2


def get_profile_total_xp(token: str):
    r = _r("GET", "/profile", token=token)
    r.raise_for_status()
    return int(r.json().get("total_xp", 0))


# ── Sample tiny base64 (4x4 transparent PNG) ──
SAMPLE_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).decode()


def main():
    print(f"Testing against {BASE}")
    print(f"Mongo: {MONGO_URL} / {DB_NAME}")

    # Mongo client
    mc = pymongo.MongoClient(MONGO_URL)
    db = mc[DB_NAME]

    # ── Login admin ──
    section("Setup: admin + fresh users")
    try:
        admin_token, admin_user = login(ADMIN_EMAIL, ADMIN_PASSWORD)
        admin_id = admin_user.get("user_id") or admin_user.get("id")
        assert_ok("Admin login", True, admin_id)
    except Exception as e:
        assert_ok("Admin login", False, repr(e))
        return

    A = register("Alice Hider")
    B = register("Bob Seeker")
    C = register("Carla NonFriend")
    D = register("Dave Other")
    print(f"  A={A['user_id']} {A['email']}")
    print(f"  B={B['user_id']} {B['email']}")
    print(f"  C={C['user_id']} {C['email']}")
    print(f"  D={D['user_id']} {D['email']}")

    # Make A & B friends
    friends(A, B)
    # Set bt_locations for A and B in Brisbane
    rA = set_location(A["token"])
    rB = set_location(B["token"])
    assert_ok("A set bt_location 200", rA.status_code == 200, f"{rA.status_code} {rA.text[:200]}")
    assert_ok("B set bt_location 200", rB.status_code == 200, f"{rB.status_code} {rB.text[:200]}")

    # Verify friendship
    rfr = _r("GET", "/friends/list", token=A["token"])
    a_friend_ids = [x.get("user_id") for x in rfr.json().get("friends", [])] if rfr.status_code == 200 else []
    assert_ok("A↔B friendship recorded", B["user_id"] in a_friend_ids, f"a_friends={a_friend_ids}")

    # ═══════ SECTION 1 — Validation & duplicate guards ═══════
    section("1. Validation & duplicate guards")
    # 1a. Invite without bt_location set (use fresh user with no loc)
    NoLoc = register("NoLoc User")
    friends(NoLoc, B)
    r = _r("POST", "/bt/match/invite", token=NoLoc["token"], json={"friend_id": B["user_id"]})
    assert_ok("1a. Invite without bt_location → 400",
              r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    # 1b. Invite C (not friend) → 403
    r = _r("POST", "/bt/match/invite", token=A["token"], json={"friend_id": C["user_id"]})
    assert_ok("1b. Invite non-friend → 403",
              r.status_code == 403, f"{r.status_code} {r.text[:200]}")
    assert_ok("1b. detail mentions 'accepted friends'",
              "accepted friends" in r.text.lower(), r.text[:200])

    # 1c. Invite self → 400
    r = _r("POST", "/bt/match/invite", token=A["token"], json={"friend_id": A["user_id"]})
    assert_ok("1c. Invite self → 400",
              r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    # 1d. Invite B → 200, returned match has correct shape
    r = _r("POST", "/bt/match/invite", token=A["token"], json={"friend_id": B["user_id"]})
    assert_ok("1d. Invite friend B → 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        m = r.json()["match"]
        match_id = m["id"]
        assert_ok("1d. state==pending_accept", m["state"] == "pending_accept", m["state"])
        assert_ok("1d. invited_at set", bool(m.get("invited_at")), str(m.get("invited_at")))
        assert_ok("1d. hider_id==A", m["hider_id"] == A["user_id"], m["hider_id"])
        assert_ok("1d. seeker_id==B", m["seeker_id"] == B["user_id"], m["seeker_id"])
    else:
        match_id = None

    # 1e. Re-invite B (active match exists) → 409
    r = _r("POST", "/bt/match/invite", token=A["token"], json={"friend_id": B["user_id"]})
    assert_ok("1e. Re-invite (active match) → 409",
              r.status_code == 409, f"{r.status_code} {r.text[:200]}")
    assert_ok("1e. detail mentions 'active match'",
              "active match" in r.text.lower(), r.text[:200])

    # ═══════ SECTION 2 — Accept/Reject (state machine + atomic CAS) ═══════
    section("2. Accept/Reject")
    if match_id:
        # 2a. A (hider) tries to accept → 403
        r = _r("POST", f"/bt/match/{match_id}/accept", token=A["token"])
        assert_ok("2a. Hider accept → 403", r.status_code == 403, f"{r.status_code} {r.text[:200]}")

        # 2b. B (seeker) accept → 200 with state=awaiting_burial
        r = _r("POST", f"/bt/match/{match_id}/accept", token=B["token"])
        assert_ok("2b. Seeker accept → 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        if r.status_code == 200:
            m = r.json()["match"]
            assert_ok("2b. state==awaiting_burial",
                      m["state"] == "awaiting_burial", m["state"])
            assert_ok("2b. accepted_at set ISO",
                      bool(m.get("accepted_at")), str(m.get("accepted_at")))

        # 2c. Re-accept → 400 with state info
        r = _r("POST", f"/bt/match/{match_id}/accept", token=B["token"])
        assert_ok("2c. Re-accept → 400",
                  r.status_code == 400, f"{r.status_code} {r.text[:200]}")
        assert_ok("2c. detail mentions 'awaiting_burial'",
                  "awaiting_burial" in r.text.lower(), r.text[:200])

    # 2d. Fresh scenario for REJECT
    # Need new pair: register fresh user E befriended with A
    E = register("Eve Rejecter")
    friends(A, E)
    set_location(E["token"])  # not strictly needed for seeker but harmless
    r = _r("POST", "/bt/match/invite", token=A["token"], json={"friend_id": E["user_id"]})
    if r.status_code == 200:
        e_match_id = r.json()["match"]["id"]
        r2 = _r("POST", f"/bt/match/{e_match_id}/reject", token=E["token"])
        assert_ok("2d. Seeker reject → 200", r2.status_code == 200, f"{r2.status_code} {r2.text[:200]}")
        if r2.status_code == 200:
            m = r2.json()["match"]
            assert_ok("2d. state==rejected", m["state"] == "rejected", m["state"])
            assert_ok("2d. rejected_at set", bool(m.get("rejected_at")), str(m.get("rejected_at")))
    else:
        assert_ok("2d. setup invite for reject", False, f"{r.status_code} {r.text[:200]}")

    # ═══════ SECTION 3 — Cancel ═══════
    section("3. Cancel")
    # Fresh pair F befriended with A
    F = register("Frank Cancel")
    friends(A, F)
    # 3a. New invite, B (not hider) cancel → 403
    rinv = _r("POST", "/bt/match/invite", token=A["token"], json={"friend_id": F["user_id"]})
    if rinv.status_code == 200:
        f_mid = rinv.json()["match"]["id"]
        r = _r("POST", f"/bt/match/{f_mid}/cancel", token=F["token"])
        assert_ok("3a. Non-hider cancel → 403",
                  r.status_code == 403, f"{r.status_code} {r.text[:200]}")

        # 3b. Hider cancel in pending_accept → 200, state=cancelled
        r = _r("POST", f"/bt/match/{f_mid}/cancel", token=A["token"])
        assert_ok("3b. Hider cancel pending_accept → 200",
                  r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        if r.status_code == 200:
            assert_ok("3b. state==cancelled",
                      r.json()["match"]["state"] == "cancelled",
                      r.json()["match"]["state"])

    # 3c. Hider cancel after accept (awaiting_burial)
    G = register("Greg Cancel2")
    friends(A, G)
    rinv = _r("POST", "/bt/match/invite", token=A["token"], json={"friend_id": G["user_id"]})
    if rinv.status_code == 200:
        g_mid = rinv.json()["match"]["id"]
        _r("POST", f"/bt/match/{g_mid}/accept", token=G["token"])
        r = _r("POST", f"/bt/match/{g_mid}/cancel", token=A["token"])
        assert_ok("3c. Hider cancel awaiting_burial → 200",
                  r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        if r.status_code == 200:
            assert_ok("3c. state==cancelled",
                      r.json()["match"]["state"] == "cancelled",
                      r.json()["match"]["state"])

    # 3d. Cancel after bury → 400
    # (we'll set this up: invite, accept, bury, then cancel)
    H = register("Hank Buryer")
    friends(A, H)
    set_location(H["token"])
    rinv = _r("POST", "/bt/match/invite", token=A["token"], json={"friend_id": H["user_id"]})
    h_mid = rinv.json()["match"]["id"] if rinv.status_code == 200 else None
    if h_mid:
        _r("POST", f"/bt/match/{h_mid}/accept", token=H["token"])
        rbury = _r("POST", f"/bt/match/{h_mid}/bury", token=A["token"], json={
            "lat": BRIS_LAT + 0.0001, "lng": BRIS_LNG + 0.0001,
            "hint": "near oak", "photo_b64": SAMPLE_B64, "allow_photo_post": True,
        })
        assert_ok("3d (prereq). Bury in awaiting_burial → 200",
                  rbury.status_code == 200,
                  f"{rbury.status_code} {rbury.text[:200]}")
        rcancel = _r("POST", f"/bt/match/{h_mid}/cancel", token=A["token"])
        assert_ok("3d. Cancel after bury → 400",
                  rcancel.status_code == 400, f"{rcancel.status_code} {rcancel.text[:200]}")

    # ═══════ SECTION 4 — Bury (anti-cheat) ═══════
    section("4. Bury — anti-cheat")
    # match_id is the original A-B match still in awaiting_burial state
    if match_id:
        # 4a. Seeker bury → 403
        r = _r("POST", f"/bt/match/{match_id}/bury", token=B["token"], json={
            "lat": BRIS_LAT, "lng": BRIS_LNG, "hint": "x"
        })
        assert_ok("4a. Seeker bury → 403",
                  r.status_code == 403, f"{r.status_code} {r.text[:200]}")

        # 4b. Bury in pending_accept — need a new pair where state is pending
        I = register("Ivy Pending")
        friends(A, I)
        rinv = _r("POST", "/bt/match/invite", token=A["token"], json={"friend_id": I["user_id"]})
        if rinv.status_code == 200:
            i_mid = rinv.json()["match"]["id"]
            r = _r("POST", f"/bt/match/{i_mid}/bury", token=A["token"], json={
                "lat": BRIS_LAT, "lng": BRIS_LNG, "hint": "x"
            })
            assert_ok("4b. Hider bury pre-accept → 400",
                      r.status_code == 400, f"{r.status_code} {r.text[:200]}")

        # 4c. Hider bury FAR OUTSIDE (lat=0 lng=0) → 400 mentions 'outside your hunt area'
        r = _r("POST", f"/bt/match/{match_id}/bury", token=A["token"], json={
            "lat": 0, "lng": 0, "hint": "outside",
        })
        assert_ok("4c. Bury outside hunt area → 400",
                  r.status_code == 400, f"{r.status_code} {r.text[:200]}")
        assert_ok("4c. detail mentions 'outside your hunt area'",
                  "outside your hunt area" in r.text.lower(), r.text[:200])

        # 4d. Hider bury INSIDE the circle → 200
        chest_lat = BRIS_LAT + 0.0002
        chest_lng = BRIS_LNG + 0.0002
        before_bury_iso = datetime.now(timezone.utc).isoformat()
        r = _r("POST", f"/bt/match/{match_id}/bury", token=A["token"], json={
            "lat": chest_lat, "lng": chest_lng,
            "hint": "under the oak",
            "photo_b64": SAMPLE_B64,
            "allow_photo_post": True,
        })
        assert_ok("4d. Hider bury inside → 200",
                  r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        if r.status_code == 200:
            m = r.json()["match"]
            assert_ok("4d. state==in_progress",
                      m["state"] == "in_progress", m["state"])
            assert_ok("4d. buried_at set",
                      bool(m.get("buried_at")), str(m.get("buried_at")))
            assert_ok("4d. expires_at set",
                      bool(m.get("expires_at")), str(m.get("expires_at")))
            # Parse and verify 12-hour delta
            try:
                buried_dt = datetime.fromisoformat(m["buried_at"].replace("Z", "+00:00"))
                expires_dt = datetime.fromisoformat(m["expires_at"].replace("Z", "+00:00"))
                delta = (expires_dt - buried_dt).total_seconds()
                ok_delta = abs(delta - 12 * 3600) < 60  # ±60s
                assert_ok("4d. expires_at == buried_at + 12h (±60s)",
                          ok_delta, f"delta_seconds={delta}")
            except Exception as e:
                assert_ok("4d. expires_at == buried_at + 12h (±60s)", False, repr(e))
            assert_ok("4d. hint stored", m.get("hint") == "under the oak", str(m.get("hint")))

        # 4e. GET /bt/match/{id} as SEEKER right after bury → no photo_buried_b64 but lat/lng/hint visible
        r = _r("GET", f"/bt/match/{match_id}", token=B["token"])
        assert_ok("4e. Seeker GET match → 200",
                  r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        if r.status_code == 200:
            j = r.json()
            assert_ok("4e. Seeker view does NOT include photo_buried_b64",
                      "photo_buried_b64" not in j or not j.get("photo_buried_b64"),
                      f"keys={list(j.keys())[:30]}")
            assert_ok("4e. Seeker view INCLUDES lat (in_progress)",
                      j.get("lat") is not None, str(j.get("lat")))
            assert_ok("4e. Seeker view INCLUDES lng",
                      j.get("lng") is not None, str(j.get("lng")))
            assert_ok("4e. Seeker view INCLUDES hint",
                      j.get("hint") == "under the oak", str(j.get("hint")))

        # 4f. GET /bt/match/{id} as HIDER → should include photo_buried_b64
        r = _r("GET", f"/bt/match/{match_id}", token=A["token"])
        if r.status_code == 200:
            j = r.json()
            assert_ok("4f. Hider view INCLUDES photo_buried_b64",
                      bool(j.get("photo_buried_b64")), f"present={bool(j.get('photo_buried_b64'))}")

    # ═══════ SECTION 5 — Find (XP + feed post) ═══════
    section("5. Find — XP awards + feed post")
    if match_id:
        # Capture pre-find XP
        try:
            xp_seeker_before = get_profile_total_xp(B["token"])
            xp_hider_before = get_profile_total_xp(A["token"])
        except Exception as e:
            xp_seeker_before = xp_hider_before = None
            assert_ok("5. capture profile XP", False, repr(e))

        # 5a. Hider tries to find → 403
        r = _r("POST", f"/bt/match/{match_id}/find", token=A["token"], json={
            "lat": chest_lat, "lng": chest_lng,
        })
        assert_ok("5a. Hider find → 403",
                  r.status_code == 403, f"{r.status_code} {r.text[:200]}")

        # 5b. Seeker far away (1 km) → 400 "Still Xm away"
        far_lat = chest_lat + 0.01  # ~1.1 km
        r = _r("POST", f"/bt/match/{match_id}/find", token=B["token"], json={
            "lat": far_lat, "lng": chest_lng,
        })
        assert_ok("5b. Seeker far find → 400",
                  r.status_code == 400, f"{r.status_code} {r.text[:200]}")
        assert_ok("5b. detail mentions 'm away'",
                  "m away" in r.text.lower() or "still" in r.text.lower(),
                  r.text[:200])

        # 5c. Seeker find within 12m → 200
        find_lat = chest_lat + 0.00005
        find_lng = chest_lng + 0.00005
        r = _r("POST", f"/bt/match/{match_id}/find", token=B["token"], json={
            "lat": find_lat, "lng": find_lng,
            "photo_b64": SAMPLE_B64,
        })
        assert_ok("5c. Seeker find within 12m → 200",
                  r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        feed_pid = None
        if r.status_code == 200:
            j = r.json()
            assert_ok("5c. state==found", j.get("state") == "found", str(j.get("state")))
            assert_ok("5c. winner==seeker", j.get("winner") == "seeker", str(j.get("winner")))
            assert_ok("5c. xp_seeker==100", j.get("xp_seeker") == 100, str(j.get("xp_seeker")))
            assert_ok("5c. xp_hider==50", j.get("xp_hider") == 50, str(j.get("xp_hider")))
            assert_ok("5c. found_at set", bool(j.get("found_at")), str(j.get("found_at")))
            feed_pid = j.get("feed_post_id")

        # 5d. Verify profile.total_xp deltas
        if xp_seeker_before is not None:
            try:
                xp_seeker_after = get_profile_total_xp(B["token"])
                xp_hider_after = get_profile_total_xp(A["token"])
                ds = xp_seeker_after - xp_seeker_before
                dh = xp_hider_after - xp_hider_before
                assert_ok(f"5d. Seeker total_xp +=100 (was {xp_seeker_before}→{xp_seeker_after}, Δ={ds})",
                          ds == 100, f"delta={ds}")
                assert_ok(f"5d. Hider total_xp +=50 (was {xp_hider_before}→{xp_hider_after}, Δ={dh})",
                          dh == 50, f"delta={dh}")
            except Exception as e:
                assert_ok("5d. XP delta check", False, repr(e))

        # 5e. Check bt_feed_posts entry via GET /bt/feed as seeker
        r = _r("GET", "/bt/feed", token=B["token"])
        assert_ok("5e. Seeker GET /bt/feed → 200",
                  r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        entry_seeker = None
        if r.status_code == 200:
            entries = r.json().get("entries", [])
            entry_seeker = next((e for e in entries if e.get("match_id") == match_id), None)
            assert_ok("5e. Feed entry exists for match",
                      entry_seeker is not None, f"count={len(entries)}")
            if entry_seeker:
                assert_ok("5e. Entry has seeker name",
                          bool(entry_seeker["seeker"]["name"]),
                          str(entry_seeker["seeker"]["name"]))
                assert_ok("5e. Entry has hider name",
                          bool(entry_seeker["hider"]["name"]),
                          str(entry_seeker["hider"]["name"]))
                assert_ok("5e. duration_seconds > 0 or 0",
                          isinstance(entry_seeker.get("duration_seconds"), int)
                          and entry_seeker.get("duration_seconds") >= 0,
                          str(entry_seeker.get("duration_seconds")))
                # Photos
                assert_ok("5e. photo_found_b64 present",
                          bool(entry_seeker.get("photo_found_b64")),
                          "yes" if entry_seeker.get("photo_found_b64") else "no")
                assert_ok("5e. photo_buried_b64 present",
                          bool(entry_seeker.get("photo_buried_b64")),
                          "yes" if entry_seeker.get("photo_buried_b64") else "no")
                assert_ok("5e. xp_seeker=100", entry_seeker.get("xp_seeker") == 100,
                          str(entry_seeker.get("xp_seeker")))
                assert_ok("5e. xp_hider=50", entry_seeker.get("xp_hider") == 50,
                          str(entry_seeker.get("xp_hider")))
                feed_pid = feed_pid or entry_seeker["id"]

        # 5f. Feed visibility — HIDER
        r = _r("GET", "/bt/feed", token=A["token"])
        if r.status_code == 200:
            ents = r.json().get("entries", [])
            assert_ok("5f. Hider sees the feed entry",
                      any(e.get("match_id") == match_id for e in ents),
                      f"count={len(ents)}")

        # 5g. Feed visibility — stranger C (not friend of either)
        r = _r("GET", "/bt/feed", token=C["token"])
        if r.status_code == 200:
            ents = r.json().get("entries", [])
            assert_ok("5g. Stranger does NOT see the feed entry",
                      not any(e.get("match_id") == match_id for e in ents),
                      f"count={len(ents)}")

        # 5h. Like toggle as A
        if feed_pid:
            r = _r("POST", f"/bt/feed/{feed_pid}/like", token=A["token"])
            assert_ok("5h. A like POST → 200",
                      r.status_code == 200, f"{r.status_code} {r.text[:200]}")
            if r.status_code == 200:
                j = r.json()
                assert_ok("5h. like_count==1", j.get("like_count") == 1, str(j))
                assert_ok("5h. liked_by_you==true", j.get("liked_by_you") is True, str(j))
            # Toggle off
            r = _r("POST", f"/bt/feed/{feed_pid}/like", token=A["token"])
            if r.status_code == 200:
                j = r.json()
                assert_ok("5h. Re-like toggles to 0",
                          j.get("like_count") == 0 and j.get("liked_by_you") is False,
                          str(j))

    # ═══════ SECTION 6 — Background tick: 30-min invite expiry ═══════
    section("6. Background tick — 30-min invite expiry")
    # Insert a backdated pending_accept doc directly via mongo
    expired_mid = str(uuid.uuid4())
    invited_at = (datetime.now(timezone.utc) - timedelta(minutes=31)).isoformat()
    db.bt_matches.insert_one({
        "_id": expired_mid,
        "hider_id": A["user_id"], "seeker_id": B["user_id"],
        "state": "pending_accept",
        "invited_at": invited_at,
        "accepted_at": None, "rejected_at": None, "cancelled_at": None,
        "buried_at": None, "expires_at": None, "found_at": None,
        "found_lat": None, "found_lng": None,
        "lat": None, "lng": None, "hint": None,
        "photo_buried_b64": None, "photo_found_b64": None,
        "allow_photo_post": True,
        "winner": None, "xp_seeker": 0, "xp_hider": 0,
        "resolved_at": None,
    })
    print(f"  Inserted backdated pending_accept _id={expired_mid} invited_at={invited_at}")
    print("  Waiting 65s for tick...")
    time.sleep(65)
    doc = db.bt_matches.find_one({"_id": expired_mid})
    assert_ok("6a. backdated invite → state='expired_invite'",
              doc and doc.get("state") == "expired_invite", str(doc.get("state") if doc else None))
    assert_ok("6a. invite_expired_at set",
              bool(doc.get("invite_expired_at")) if doc else False,
              str(doc.get("invite_expired_at") if doc else None))

    # 6b. Idempotency — already-expired doc untouched
    already_mid = str(uuid.uuid4())
    saved_expired_at = (datetime.now(timezone.utc) - timedelta(minutes=40)).isoformat()
    db.bt_matches.insert_one({
        "_id": already_mid,
        "hider_id": A["user_id"], "seeker_id": B["user_id"],
        "state": "expired_invite",
        "invited_at": (datetime.now(timezone.utc) - timedelta(minutes=100)).isoformat(),
        "invite_expired_at": saved_expired_at,
        "accepted_at": None, "rejected_at": None, "cancelled_at": None,
        "buried_at": None, "expires_at": None, "found_at": None,
        "found_lat": None, "found_lng": None,
        "lat": None, "lng": None, "hint": None,
        "photo_buried_b64": None, "photo_found_b64": None,
        "allow_photo_post": True,
        "winner": None, "xp_seeker": 0, "xp_hider": 0,
        "resolved_at": None,
    })
    print(f"  Inserted already-expired _id={already_mid}, waiting 65s...")
    time.sleep(65)
    doc = db.bt_matches.find_one({"_id": already_mid})
    assert_ok("6b. Idempotency: state stays 'expired_invite'",
              doc and doc.get("state") == "expired_invite", str(doc.get("state") if doc else None))
    assert_ok("6b. Idempotency: invite_expired_at unchanged",
              doc and doc.get("invite_expired_at") == saved_expired_at,
              str(doc.get("invite_expired_at") if doc else None))

    # ═══════ SECTION 7 — Background tick: 12h hunt expiry ═══════
    section("7. Background tick — 12h hunt expiry")
    # Need fresh hider X and seeker Y
    X = register("Xena HunterExpire")
    Y = register("Yann SeekerExpire")
    friends(X, Y)
    set_location(X["token"])
    xp_X_before = get_profile_total_xp(X["token"])
    print(f"  X total_xp before expiry: {xp_X_before}")
    hunt_mid = str(uuid.uuid4())
    db.bt_matches.insert_one({
        "_id": hunt_mid,
        "hider_id": X["user_id"], "seeker_id": Y["user_id"],
        "state": "in_progress",
        "invited_at": (datetime.now(timezone.utc) - timedelta(hours=13)).isoformat(),
        "accepted_at": (datetime.now(timezone.utc) - timedelta(hours=12, minutes=30)).isoformat(),
        "rejected_at": None, "cancelled_at": None,
        "buried_at": (datetime.now(timezone.utc) - timedelta(hours=12, minutes=1)).isoformat(),
        "expires_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        "found_at": None, "found_lat": None, "found_lng": None,
        "lat": BRIS_LAT + 0.0001, "lng": BRIS_LNG + 0.0001, "hint": "test",
        "photo_buried_b64": None, "photo_found_b64": None,
        "allow_photo_post": False,
        "winner": None, "xp_seeker": 0, "xp_hider": 0,
        "resolved_at": None,
    })
    print(f"  Inserted in_progress _id={hunt_mid} expires_at in past. Waiting 65s...")
    time.sleep(65)
    doc = db.bt_matches.find_one({"_id": hunt_mid})
    assert_ok("7a. backdated in_progress → state='expired'",
              doc and doc.get("state") == "expired", str(doc.get("state") if doc else None))
    assert_ok("7a. winner=='hider'",
              doc and doc.get("winner") == "hider", str(doc.get("winner") if doc else None))
    assert_ok("7a. xp_hider==50",
              doc and int(doc.get("xp_hider", 0)) == 50,
              str(doc.get("xp_hider") if doc else None))
    assert_ok("7a. resolved_at set",
              bool(doc.get("resolved_at")) if doc else False,
              str(doc.get("resolved_at") if doc else None))
    # Verify XP incremented
    xp_X_after = get_profile_total_xp(X["token"])
    assert_ok(f"7a. X.total_xp +=50 ({xp_X_before}→{xp_X_after})",
              xp_X_after - xp_X_before == 50, f"delta={xp_X_after - xp_X_before}")

    # 7b. Idempotency — second tick should not double-award
    xp_X_mid = get_profile_total_xp(X["token"])
    print(f"  Waiting 65s for second tick (idempotency check)...")
    time.sleep(65)
    xp_X_final = get_profile_total_xp(X["token"])
    assert_ok(f"7b. Idempotency: no double-award ({xp_X_mid}→{xp_X_final})",
              xp_X_final - xp_X_mid == 0, f"delta={xp_X_final - xp_X_mid}")
    doc = db.bt_matches.find_one({"_id": hunt_mid})
    assert_ok("7b. Idempotency: state still 'expired'",
              doc and doc.get("state") == "expired", str(doc.get("state") if doc else None))

    # ═══════ SECTION 8 — Visibility to friends ═══════
    section("8. Feed visibility to friends")
    # Make C a friend of B (the seeker in main scenario). Now C should see entry.
    friends(C, B)
    r = _r("GET", "/bt/feed", token=C["token"])
    if r.status_code == 200:
        ents = r.json().get("entries", [])
        assert_ok("8. C (friend of B) sees feed entry",
                  any(e.get("match_id") == match_id for e in ents),
                  f"count={len(ents)}")

    # ═══════ SECTION 9 — Solo mode regression ═══════
    section("9. Solo mode regression")
    # GET /bt/location for B
    r = _r("GET", "/bt/location", token=B["token"])
    assert_ok("9a. GET /bt/location → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # POST /bt/location
    r = _r("POST", "/bt/location", token=B["token"], json={
        "lat": BRIS_LAT, "lng": BRIS_LNG, "radius_m": BRIS_RADIUS,
    })
    assert_ok("9b. POST /bt/location → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # GET /bt/chest/today
    r = _r("GET", "/bt/chest/today", token=B["token"])
    assert_ok("9c. GET /bt/chest/today → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:300]}")
    chest_today_lat = chest_today_lng = None
    if r.status_code == 200:
        c = r.json().get("chest", {})
        chest_today_lat = c.get("lat")
        chest_today_lng = c.get("lng")
        assert_ok("9c. chest.id present",
                  bool(c.get("id")), str(c.get("id")))

    # POST /bt/chest/find at exact chest coords
    if chest_today_lat is not None:
        r = _r("POST", "/bt/chest/find", token=B["token"], json={
            "lat": chest_today_lat, "lng": chest_today_lng,
            "photo_base64": SAMPLE_B64,
        })
        assert_ok("9d. POST /bt/chest/find → 200",
                  r.status_code == 200, f"{r.status_code} {r.text[:300]}")

    # GET /bt/finds
    r = _r("GET", "/bt/finds", token=B["token"])
    assert_ok("9e. GET /bt/finds → 200", r.status_code == 200, f"{r.status_code}")

    # GET/POST /bt/settings
    r = _r("GET", "/bt/settings", token=B["token"])
    assert_ok("9f. GET /bt/settings → 200", r.status_code == 200, f"{r.status_code}")
    r = _r("POST", "/bt/settings", token=B["token"], json={"daylight_only": True})
    assert_ok("9f. POST /bt/settings → 200", r.status_code == 200, f"{r.status_code}")

    # GET/POST/DELETE /bt/no-go-zones
    r = _r("GET", "/bt/no-go-zones", token=B["token"])
    assert_ok("9g. GET /bt/no-go-zones → 200", r.status_code == 200, f"{r.status_code}")
    r = _r("POST", "/bt/no-go-zones", token=B["token"], json={
        "name": "test zone",
        "polygon": [
            {"lat": BRIS_LAT, "lng": BRIS_LNG},
            {"lat": BRIS_LAT + 0.001, "lng": BRIS_LNG},
            {"lat": BRIS_LAT, "lng": BRIS_LNG + 0.001},
        ],
    })
    assert_ok("9g. POST /bt/no-go-zones → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    zid = r.json().get("id") if r.status_code == 200 else None
    if zid:
        r = _r("DELETE", f"/bt/no-go-zones/{zid}", token=B["token"])
        assert_ok("9g. DELETE /bt/no-go-zones → 200",
                  r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # POST /bt/report
    r = _r("POST", "/bt/report", token=B["token"], json={
        "kind": "location",
        "message": "Test private property report",
        "lat": BRIS_LAT, "lng": BRIS_LNG,
    })
    assert_ok("9h. POST /bt/report → 200",
              r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # Cleanup test docs
    try:
        db.bt_matches.delete_many({"_id": {"$in": [expired_mid, already_mid, hunt_mid]}})
    except Exception:
        pass

    # ═══════ Summary ═══════
    section("RESULTS")
    print(f"\nPASS: {len(PASS)}")
    print(f"FAIL: {len(FAIL)}")
    if FAIL:
        print("\nFailed:")
        for f in FAIL:
            print(f"  ✗ {f}")
    return len(FAIL) == 0


if __name__ == "__main__":
    try:
        ok = main()
        sys.exit(0 if ok else 1)
    except Exception:
        traceback.print_exc()
        sys.exit(2)
