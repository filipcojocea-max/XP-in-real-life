"""Backend regression for the rewritten Buried Treasure feature (Jan 2026 spec).

Covers SOLO + FRIENDS flows on /api/bt/*. Old endpoints (chest/today,
no-go-zones, finds, settings) should be gone and return 404 cleanly.

Uses the admin account as the "creator" and registers two throwaway users
to play the part of friends (one near, one far). MX-validated domains
(gmail.com) are required by /api/auth/register.
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL")
            or os.environ.get("EXPO_BACKEND_URL")
            or "https://emergent-mobile-app-4.preview.emergentagent.com").rstrip("/")

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

# Sydney CBD - used for creator + near friend
SYDNEY = (-33.8688, 151.2093)
# Sydney suburb ~20 km away (within the 50 km friend area)
PARRAMATTA = (-33.8150, 151.0000)
# London - far away (~17000 km from Sydney) → outside 50 km
LONDON = (51.5074, -0.1278)

# Tiny 1×1 PNG (base64) - smallest "valid" photo payload
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB"
    "9Zr5kQ8AAAAASUVORK5CYII="
)


def _api(path: str) -> str:
    return f"{BASE_URL}{path}"


def _login(email: str, password: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(_api("/api/auth/login"),
               json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text[:300]}"
    tok = r.json().get("token")
    assert tok
    s.headers.update({"Authorization": f"Bearer {tok}"})
    s.user_id = r.json()["user"]["id"]
    s.email = email
    return s


def _register(full_name: str) -> requests.Session:
    email = f"TEST_bt_{uuid.uuid4().hex[:10]}@gmail.com"
    pw = "TestPass!123"
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(_api("/api/auth/register"),
               json={"email": email, "password": pw, "full_name": full_name},
               timeout=30)
    if r.status_code != 200:
        pytest.skip(f"could not register helper user ({r.status_code}): {r.text[:200]}")
    tok = r.json()["token"]
    s.headers.update({"Authorization": f"Bearer {tok}"})
    s.user_id = r.json()["user"]["id"]
    s.email = email
    s.password = pw
    return s


def _make_friends(a: requests.Session, b: requests.Session):
    """Create accepted friendship between two sessions via /api/friends/*."""
    r = a.post(_api("/api/friends/request"), json={"user_id": b.user_id}, timeout=15)
    assert r.status_code in (200, 400), r.text
    # b accepts
    r2 = b.post(_api("/api/friends/accept"), json={"user_id": a.user_id}, timeout=15)
    # 200 or 404 (if already accepted)
    assert r2.status_code in (200, 404), r2.text


def _stamp_location(sess: requests.Session, lat: float, lng: float):
    r = sess.post(_api("/api/bt/location"), json={"lat": lat, "lng": lng}, timeout=15)
    assert r.status_code == 200, r.text
    assert r.json().get("ok") is True


# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def admin() -> requests.Session:
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="module")
def near_friend(admin) -> requests.Session:
    s = _register("TEST BT NearFriend")
    _make_friends(admin, s)
    _stamp_location(s, *PARRAMATTA)
    return s


@pytest.fixture(scope="module")
def far_friend(admin) -> requests.Session:
    s = _register("TEST BT FarFriend")
    _make_friends(admin, s)
    _stamp_location(s, *LONDON)
    return s


@pytest.fixture(scope="module")
def cleanup_solo(admin):
    """Yield, then no special teardown — bt_solo is per-user replace_one."""
    yield


# ─────────────────────────────────────────────────────────────────────
# Old endpoints should be gone (clean 404, no traceback)
# ─────────────────────────────────────────────────────────────────────
class TestOldEndpointsGone:
    @pytest.mark.parametrize("path", [
        "/api/bt/chest/today",
        "/api/bt/finds",
        "/api/bt/settings",
        "/api/bt/no-go-zones",
        "/api/bt/feed",
        "/api/bt/matches",
    ])
    def test_old_endpoint_404(self, admin, path):
        r = admin.get(_api(path), timeout=15)
        assert r.status_code == 404, f"{path} -> {r.status_code} {r.text[:200]}"


# ─────────────────────────────────────────────────────────────────────
# /api/bt/location
# ─────────────────────────────────────────────────────────────────────
class TestLocation:
    def test_save_location_returns_ok(self, admin):
        r = admin.post(_api("/api/bt/location"),
                       json={"lat": SYDNEY[0], "lng": SYDNEY[1]}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}


# ─────────────────────────────────────────────────────────────────────
# SOLO flow
# ─────────────────────────────────────────────────────────────────────
class TestSolo:
    def test_solo_start_clamps_radius_too_small(self, admin):
        r = admin.post(_api("/api/bt/solo/start"),
                       json={"lat": SYDNEY[0], "lng": SYDNEY[1], "radius_m": 10},
                       timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["area"]["radius_m"] == 100  # MIN_RADIUS_M

    def test_solo_start_clamps_radius_too_big(self, admin):
        r = admin.post(_api("/api/bt/solo/start"),
                       json={"lat": SYDNEY[0], "lng": SYDNEY[1],
                             "radius_m": 9_999_999},
                       timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["area"]["radius_m"] == 25_000  # MAX_RADIUS_M

    def test_solo_start_creates_hunt(self, admin):
        r = admin.post(_api("/api/bt/solo/start"),
                       json={"lat": SYDNEY[0], "lng": SYDNEY[1],
                             "radius_m": 1500},
                       timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["area"]["radius_m"] == 1500
        assert body["status"] == "active"
        # Hidden chest coords must NOT be leaked
        assert "chest" not in body
        assert "chest_lat" not in body

    def test_solo_current_returns_active(self, admin):
        r = admin.get(_api("/api/bt/solo/current"), timeout=15)
        assert r.status_code == 200, r.text
        hunt = r.json().get("hunt")
        assert hunt is not None
        assert hunt["status"] == "active"
        assert hunt["area"]["radius_m"] == 1500
        assert "chest" not in hunt

    def test_solo_compass_far_returns_distance_and_bearing(self, admin):
        r = admin.get(_api("/api/bt/solo/compass"),
                      params={"lat": LONDON[0], "lng": LONDON[1]}, timeout=15)
        assert r.status_code == 200, r.text
        c = r.json()
        assert "distance_m" in c and c["distance_m"] > 1_000_000  # London->Sydney
        assert 0.0 <= c["bearing_deg"] < 360.0
        assert c["in_find_ring"] is False
        assert c["find_ring_m"] == 15

    def test_solo_find_too_far_returns_400_with_hint(self, admin):
        r = admin.post(_api("/api/bt/solo/find"),
                       json={"lat": LONDON[0], "lng": LONDON[1],
                             "photo_base64": TINY_PNG_B64},
                       timeout=15)
        assert r.status_code == 400, r.text
        # Hint mentions distance and the 15 m ring
        msg = r.json().get("detail", "")
        assert "15" in msg
        assert "m" in msg.lower()

    def test_solo_find_within_ring_awards_xp_and_autoassigns(self, admin):
        # Read the chest coords directly from DB by using the compass with
        # the area center — server returns distance/bearing, but we
        # need exact coords. Instead, we cheat: solo_start sets a random
        # chest inside the circle; we'll teleport ourselves to the chest
        # by reading from MongoDB via an admin-only path? No such path.
        # Workaround: scan a tight grid? Too slow. Instead use the DB
        # collection through the backend's admin-only debug if any.
        # Simpler: directly query MongoDB via motor — but tests run
        # against deployed URL only. We use the fact that a *new* solo
        # start places a chest randomly; we cannot know exact coords.
        # → For this test, we read chest by using motor through the
        #   running backend's /api? Not exposed. Skip the success path
        #   here and validate the integration via /api/bt/solo/finds
        #   list shape (covered separately) plus the 400-too-far path.
        pytest.skip("Cannot resolve the hidden chest coords through any "
                    "public endpoint; success-path is exercised via direct "
                    "DB-coupled test in TestSoloFindDirect.")

    def test_solo_finds_list_envelope(self, admin):
        r = admin.get(_api("/api/bt/solo/finds"), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "finds" in body and isinstance(body["finds"], list)
        assert "count" in body
        # If any historical finds exist they have id (not _id)
        for f in body["finds"]:
            assert "_id" not in f
            assert "id" in f
            assert "photo_base64" in f


# ─────────────────────────────────────────────────────────────────────
# SOLO find success-path — uses MongoDB directly to learn chest coords
# (cannot be done through the public API by design).
# ─────────────────────────────────────────────────────────────────────
class TestSoloFindDirect:
    def test_find_success_awards_xp_and_autoassigns(self, admin):
        try:
            import motor.motor_asyncio  # noqa: F401
        except ImportError:
            pytest.skip("motor not installed in test env")
        import asyncio
        import motor.motor_asyncio as mma
        from dotenv import dotenv_values
        env = dotenv_values("/app/backend/.env")
        mongo_url = env.get("MONGO_URL")
        db_name = env.get("DB_NAME")
        if not mongo_url or not db_name:
            pytest.skip("MONGO_URL/DB_NAME not available")

        async def _resolve_chest():
            client = mma.AsyncIOMotorClient(mongo_url)
            try:
                db = client[db_name]
                doc = await db.bt_solo.find_one({"_id": admin.user_id})
                return doc
            finally:
                client.close()

        # Ensure a fresh hunt
        r = admin.post(_api("/api/bt/solo/start"),
                       json={"lat": SYDNEY[0], "lng": SYDNEY[1],
                             "radius_m": 500}, timeout=15)
        assert r.status_code == 200

        doc = asyncio.get_event_loop().run_until_complete(_resolve_chest())
        assert doc and doc.get("chest")
        c_lat = float(doc["chest"]["lat"])
        c_lng = float(doc["chest"]["lng"])

        # Compass at chest → in_find_ring=True
        cmp = admin.get(_api("/api/bt/solo/compass"),
                        params={"lat": c_lat, "lng": c_lng}, timeout=15)
        assert cmp.status_code == 200
        assert cmp.json()["in_find_ring"] is True
        assert cmp.json()["distance_m"] < 15

        # Find without photo → 400
        bad = admin.post(_api("/api/bt/solo/find"),
                        json={"lat": c_lat, "lng": c_lng}, timeout=15)
        assert bad.status_code == 400, bad.text
        assert "photo" in bad.json().get("detail", "").lower()

        # Find with photo → 200, +100 XP, auto-assigns
        before = admin.get(_api("/api/bt/solo/finds"), timeout=15).json()["count"]
        ok = admin.post(_api("/api/bt/solo/find"),
                        json={"lat": c_lat, "lng": c_lng,
                              "photo_base64": TINY_PNG_B64}, timeout=20)
        assert ok.status_code == 200, ok.text
        payload = ok.json()
        assert payload["ok"] is True
        assert payload["xp_awarded"] == 100
        assert payload["next_chest_ready"] is True
        assert "new_total_xp" in payload

        after = admin.get(_api("/api/bt/solo/finds"), timeout=15).json()
        assert after["count"] == before + 1
        # newest find first (chronological -1)
        latest = after["finds"][0]
        assert latest["xp_awarded"] == 100
        assert latest["photo_base64"]  # not empty

        # Auto-assigned chest in same area → new compass works, and the
        # new chest is NOT at the old coords (random)
        doc2 = asyncio.get_event_loop().run_until_complete(_resolve_chest())
        assert doc2["chest"]["lat"] != c_lat or doc2["chest"]["lng"] != c_lng
        # Area unchanged
        assert doc2["area"]["lat"] == SYDNEY[0]
        assert doc2["area"]["lng"] == SYDNEY[1]
        assert doc2["area"]["radius_m"] == 500


# ─────────────────────────────────────────────────────────────────────
# GROUPS flow — create, invite (near + far + non-friend), accept/reject,
# bury, compass, find, join-by-code.
# ─────────────────────────────────────────────────────────────────────
class TestGroups:
    def test_create_group_yields_6char_code_and_creator_accepted(self, admin):
        # Stamp admin in Sydney so the friend-area check has a known origin
        _stamp_location(admin, *SYDNEY)
        r = admin.post(_api("/api/bt/groups/create"),
                       json={"name": f"TEST_grp_{uuid.uuid4().hex[:6]}",
                             "lat": SYDNEY[0], "lng": SYDNEY[1],
                             "radius_m": 1000}, timeout=15)
        assert r.status_code == 200, r.text
        g = r.json()
        assert g["status"] == "lobby"
        assert g["is_creator"] is True
        assert g["my_status"] == "accepted"
        assert g["code"] and len(g["code"]) == 6
        # only alphabet allowed
        alphabet = set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        assert all(ch in alphabet for ch in g["code"])
        assert g["area"]["radius_m"] == 1000
        # creator is the lone member, accepted
        assert len(g["members"]) == 1
        assert g["members"][0]["user_id"] == admin.user_id
        assert g["members"][0]["status"] == "accepted"
        # No chest revealed yet
        assert g["chest"] is None
        TestGroups.gid = g["id"]
        TestGroups.code = g["code"]

    def test_invite_rejects_far_friend_and_accepts_near(self, admin, near_friend, far_friend):
        # Also try inviting a random non-friend
        non_friend_id = str(uuid.uuid4())
        r = admin.post(_api(f"/api/bt/groups/{TestGroups.gid}/invite"),
                       json={"friend_ids": [near_friend.user_id,
                                            far_friend.user_id,
                                            non_friend_id]},
                       timeout=20)
        assert r.status_code == 200, r.text
        body = r.json()
        invited_ids = [i["user_id"] for i in body["invited"]]
        far_ids = [i["user_id"] for i in body["rejected_too_far"]]
        other_ids = [i["user_id"] for i in body["rejected_other"]]
        assert near_friend.user_id in invited_ids
        assert far_friend.user_id in far_ids, body
        assert non_friend_id in other_ids
        # Far rejection includes a distance hint
        far_entry = next(i for i in body["rejected_too_far"]
                         if i["user_id"] == far_friend.user_id)
        assert far_entry["distance_km"] > 50

    def test_only_creator_can_invite(self, near_friend):
        r = near_friend.post(_api(f"/api/bt/groups/{TestGroups.gid}/invite"),
                             json={"friend_ids": []}, timeout=15)
        assert r.status_code == 403, r.text

    def test_groups_mine_includes_group(self, admin):
        r = admin.get(_api("/api/bt/groups/mine"), timeout=15)
        assert r.status_code == 200, r.text
        ids = [g["id"] for g in r.json()["groups"]]
        assert TestGroups.gid in ids

    def test_invitee_sees_group_in_mine(self, near_friend):
        r = near_friend.get(_api("/api/bt/groups/mine"), timeout=15)
        assert r.status_code == 200
        ids = [g["id"] for g in r.json()["groups"]]
        assert TestGroups.gid in ids
        me = next(g for g in r.json()["groups"] if g["id"] == TestGroups.gid)
        assert me["my_status"] == "pending"
        assert me["is_creator"] is False

    def test_bury_blocked_while_pending(self, admin):
        r = admin.post(_api(f"/api/bt/groups/{TestGroups.gid}/bury"),
                       json={"lat": SYDNEY[0], "lng": SYDNEY[1],
                             "photo_base64": TINY_PNG_B64,
                             "map_screenshot_base64": TINY_PNG_B64},
                       timeout=15)
        assert r.status_code == 400, r.text
        assert "accept" in r.json().get("detail", "").lower()

    def test_reject_only_for_pending(self, near_friend):
        # near_friend accepts
        r = near_friend.post(_api(f"/api/bt/groups/{TestGroups.gid}/accept"),
                             json={}, timeout=15)
        assert r.status_code == 200, r.text
        # Second accept → 400
        r2 = near_friend.post(_api(f"/api/bt/groups/{TestGroups.gid}/accept"),
                              json={}, timeout=15)
        assert r2.status_code == 400, r2.text
        # Reject after accepting → 400
        r3 = near_friend.post(_api(f"/api/bt/groups/{TestGroups.gid}/reject"),
                              json={}, timeout=15)
        assert r3.status_code == 400, r3.text

    def test_creator_can_bury_after_all_accepted(self, admin):
        # Members: admin (creator, accepted) + near_friend (accepted).
        # All invitees accepted → bury allowed.
        r = admin.post(_api(f"/api/bt/groups/{TestGroups.gid}/bury"),
                       json={"lat": SYDNEY[0], "lng": SYDNEY[1],
                             "photo_base64": TINY_PNG_B64,
                             "map_screenshot_base64": TINY_PNG_B64},
                       timeout=15)
        assert r.status_code == 200, r.text
        g = r.json()
        assert g["status"] == "hunting"
        assert g["chest"] is not None
        assert g["chest"]["photo_base64"]
        assert g["chest"]["map_screenshot_base64"]
        # buried_at present
        assert g["chest"]["buried_at"]

    def test_creator_compass_returns_creator_view(self, admin):
        r = admin.get(_api(f"/api/bt/groups/{TestGroups.gid}/compass"),
                      params={"lat": SYDNEY[0], "lng": SYDNEY[1]}, timeout=15)
        assert r.status_code == 200, r.text
        c = r.json()
        assert c.get("creator_view") is True
        assert c["find_ring_m"] == 15

    def test_creator_cannot_find_own_chest(self, admin):
        r = admin.post(_api(f"/api/bt/groups/{TestGroups.gid}/find"),
                       json={"lat": SYDNEY[0], "lng": SYDNEY[1],
                             "photo_base64": TINY_PNG_B64}, timeout=15)
        assert r.status_code == 403, r.text

    def test_member_compass_returns_distance(self, near_friend):
        r = near_friend.get(_api(f"/api/bt/groups/{TestGroups.gid}/compass"),
                            params={"lat": LONDON[0], "lng": LONDON[1]},
                            timeout=15)
        assert r.status_code == 200, r.text
        c = r.json()
        assert c["distance_m"] > 1_000_000
        assert "bearing_deg" in c
        assert c["find_ring_m"] == 15

    def test_member_find_too_far_400(self, near_friend):
        r = near_friend.post(_api(f"/api/bt/groups/{TestGroups.gid}/find"),
                             json={"lat": LONDON[0], "lng": LONDON[1],
                                   "photo_base64": TINY_PNG_B64}, timeout=15)
        assert r.status_code == 400, r.text

    def test_member_find_success(self, near_friend):
        # Read chest coords via direct DB connection
        import asyncio
        try:
            import motor.motor_asyncio as mma
        except ImportError:
            pytest.skip("motor not installed")
        from dotenv import dotenv_values
        env = dotenv_values("/app/backend/.env")
        mongo_url = env.get("MONGO_URL")
        db_name = env.get("DB_NAME")
        if not mongo_url or not db_name:
            pytest.skip("MONGO_URL/DB_NAME unset")

        async def _resolve():
            client = mma.AsyncIOMotorClient(mongo_url)
            try:
                d = await client[db_name].bt_groups.find_one({"_id": TestGroups.gid})
                return d
            finally:
                client.close()
        doc = asyncio.get_event_loop().run_until_complete(_resolve())
        assert doc
        c_lat, c_lng = float(doc["chest_lat"]), float(doc["chest_lng"])

        ok = near_friend.post(_api(f"/api/bt/groups/{TestGroups.gid}/find"),
                              json={"lat": c_lat, "lng": c_lng,
                                    "photo_base64": TINY_PNG_B64}, timeout=20)
        assert ok.status_code == 200, ok.text
        body = ok.json()
        assert body["ok"] is True
        assert body["xp_awarded"] == 100
        assert body["group"]["status"] == "finished"
        assert body["group"]["found_by"] == near_friend.user_id
        assert body["group"]["found_at"]

    def test_after_finished_compass_and_find_blocked(self, near_friend):
        # Group is finished → compass should 400 (not hunting)
        r = near_friend.get(_api(f"/api/bt/groups/{TestGroups.gid}/compass"),
                            params={"lat": SYDNEY[0], "lng": SYDNEY[1]},
                            timeout=15)
        assert r.status_code == 400, r.text
        r2 = near_friend.post(_api(f"/api/bt/groups/{TestGroups.gid}/find"),
                              json={"lat": SYDNEY[0], "lng": SYDNEY[1],
                                    "photo_base64": TINY_PNG_B64}, timeout=15)
        assert r2.status_code == 400, r2.text


# ─────────────────────────────────────────────────────────────────────
# join-by-code (uses a *fresh* group so we don't clobber the one above).
# ─────────────────────────────────────────────────────────────────────
class TestJoinByCode:
    def test_create_then_join_by_code(self, admin, near_friend):
        _stamp_location(admin, *SYDNEY)
        _stamp_location(near_friend, *PARRAMATTA)
        r = admin.post(_api("/api/bt/groups/create"),
                       json={"name": f"TEST_join_{uuid.uuid4().hex[:6]}",
                             "lat": SYDNEY[0], "lng": SYDNEY[1],
                             "radius_m": 1000}, timeout=15)
        assert r.status_code == 200
        code = r.json()["code"]
        gid = r.json()["id"]

        r2 = near_friend.post(_api("/api/bt/groups/join-by-code"),
                              json={"code": code.lower()}, timeout=15)
        # code is uppercased server-side
        assert r2.status_code == 200, r2.text
        g = r2.json()
        assert g["id"] == gid
        member_ids = [m["user_id"] for m in g["members"]]
        assert near_friend.user_id in member_ids

    def test_join_by_code_rejects_far_user(self, admin, far_friend):
        r = admin.post(_api("/api/bt/groups/create"),
                       json={"name": f"TEST_far_{uuid.uuid4().hex[:6]}",
                             "lat": SYDNEY[0], "lng": SYDNEY[1],
                             "radius_m": 1000}, timeout=15)
        assert r.status_code == 200
        code = r.json()["code"]

        _stamp_location(far_friend, *LONDON)
        r2 = far_friend.post(_api("/api/bt/groups/join-by-code"),
                             json={"code": code}, timeout=15)
        assert r2.status_code == 403, r2.text

    def test_join_by_unknown_code_404(self, near_friend):
        r = near_friend.post(_api("/api/bt/groups/join-by-code"),
                             json={"code": "ZZZZZZ"}, timeout=15)
        assert r.status_code == 404, r.text

    def test_join_by_short_code_400(self, near_friend):
        r = near_friend.post(_api("/api/bt/groups/join-by-code"),
                             json={"code": "AB"}, timeout=15)
        assert r.status_code == 400, r.text


# ─────────────────────────────────────────────────────────────────────
# groups/available — should list lobby groups created by my friends
# ─────────────────────────────────────────────────────────────────────
class TestGroupsAvailable:
    def test_available_lists_friend_lobby(self, admin, near_friend):
        _stamp_location(admin, *SYDNEY)
        r = admin.post(_api("/api/bt/groups/create"),
                       json={"name": f"TEST_avail_{uuid.uuid4().hex[:6]}",
                             "lat": SYDNEY[0], "lng": SYDNEY[1],
                             "radius_m": 1000}, timeout=15)
        assert r.status_code == 200
        gid = r.json()["id"]
        # near_friend should see it under /available
        r2 = near_friend.get(_api("/api/bt/groups/available"), timeout=15)
        assert r2.status_code == 200, r2.text
        avail_ids = [g["id"] for g in r2.json()["groups"]]
        assert gid in avail_ids
