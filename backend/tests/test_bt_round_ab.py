"""
Round A + Round B end-to-end backend regression for the Buried Treasure mini-app.

Covers:
  - GET /api/bt/friends-eligible (new) — no friends, no_app, different_region, eligible, no_my_area
  - POST /api/bt/groups/{id}/accept ↔ /reject re-toggle while in "lobby"
  - _group_public payload now exposes responses_locked
  - Round B: bt_invites doc lifecycle — create→pending→view (idempotent)→accept clears→re-invite restores
"""
import os
import uuid
import jwt
import pytest
import requests
from pymongo import MongoClient

def _load_env(path):
    out = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out


_fe = _load_env("/app/frontend/.env")
_be = _load_env("/app/backend/.env")

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL")
            or os.environ.get("EXPO_BACKEND_URL")
            or _fe.get("EXPO_PUBLIC_BACKEND_URL")
            or _fe.get("EXPO_BACKEND_URL"))
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL not found in env or /app/frontend/.env"
BASE_URL = BASE_URL.rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL") or _be.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME") or _be.get("DB_NAME", "test_database")

# Mirrors backend constants — JWT_SECRET / DB_NAME come from server.py defaults
JWT_SECRET = os.environ.get("JWT_SECRET", "xp-real-life-dev-secret-change-in-prod-12345")
JWT_ALG = "HS256"

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"


# ────────────────────────── Fixtures ──────────────────────────────────
@pytest.fixture(scope="module")
def mongo():
    client = MongoClient(MONGO_URL)
    yield client[DB_NAME]
    client.close()


@pytest.fixture(scope="module")
def admin_session():
    """Login as the admin user and return (token, user_id)."""
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    data = r.json()
    token = data["token"]
    user_id = data["user"]["id"]
    return {"token": token, "user_id": user_id, "headers": {"Authorization": f"Bearer {token}"}}


def _mint_token(user_id: str, email: str) -> str:
    import time
    now = int(time.time())
    return jwt.encode(
        {"sub": user_id, "email": email, "iat": now, "exp": now + 60 * 60 * 24 * 30},
        JWT_SECRET,
        algorithm=JWT_ALG,
    )


@pytest.fixture(scope="module")
def seeded_friends(mongo, admin_session):
    """Seed two fresh friend users with profile + friend_requests=accepted.
       friend_close: has bt_settings within the admin's area circle
       friend_far:   has bt_settings far away (different region)
       friend_no_bt: NO bt_settings (no_app reason)
    """
    admin_id = admin_session["user_id"]

    def _mk(name: str):
        uid = f"TEST_BT_{uuid.uuid4().hex[:8]}"
        email = f"{uid.lower()}@test.local"
        mongo.users.insert_one({
            "_id": uid, "email": email, "full_name": name,
            "password_hash": "x", "verified": True,
            "created_at": "2026-01-01T00:00:00+00:00",
        })
        mongo.profile.insert_one({
            "_id": uid, "name": name, "avatar_base64": None,
            "tz_offset_minutes": 0,
        })
        mongo.friend_requests.insert_one({
            "_id": f"TEST_BT_FR_{uid}",
            "from_user_id": admin_id, "to_user_id": uid,
            "status": "accepted", "created_at": "2026-01-01T00:00:00+00:00",
        })
        return uid

    friend_close = _mk("TEST_BT_Close_Friend")
    friend_far = _mk("TEST_BT_Far_Friend")
    friend_no_bt = _mk("TEST_BT_NoBT_Friend")

    # Set admin's bt_player_settings area (Sydney, 800m radius)
    # 2026-06-04 fix: canonical collection is `bt_player_settings` with
    # the flat {lat, lng, radius_m} schema (not nested under `area`).
    prev_admin_bt = mongo.bt_player_settings.find_one({"_id": admin_id})
    mongo.bt_player_settings.update_one(
        {"_id": admin_id},
        {"$set": {
            "_id": admin_id,
            "lat": -33.8688, "lng": 151.2093, "radius_m": 800.0,
        }},
        upsert=True,
    )
    # Close friend: same coords, 800m radius → overlap distance 0 ≤ 1.6km
    mongo.bt_player_settings.update_one(
        {"_id": friend_close},
        {"$set": {"_id": friend_close,
                  "lat": -33.8688, "lng": 151.2093, "radius_m": 800.0}},
        upsert=True,
    )
    # Far friend: ~50km away (Newcastle-ish, well beyond r_mine + r_friend)
    mongo.bt_player_settings.update_one(
        {"_id": friend_far},
        {"$set": {"_id": friend_far,
                  "lat": -32.9283, "lng": 151.7817, "radius_m": 800.0}},
        upsert=True,
    )

    ctx = {
        "admin_id": admin_id,
        "friend_close": friend_close,
        "friend_far": friend_far,
        "friend_no_bt": friend_no_bt,
        "prev_admin_bt": prev_admin_bt,
    }
    yield ctx

    # Teardown — wipe everything we touched
    for uid in [friend_close, friend_far, friend_no_bt]:
        mongo.users.delete_one({"_id": uid})
        mongo.profile.delete_one({"_id": uid})
        mongo.bt_player_settings.delete_one({"_id": uid})
        mongo.friend_requests.delete_one({"_id": f"TEST_BT_FR_{uid}"})
        mongo.bt_invites.delete_many({"user_id": uid})
    if prev_admin_bt is None:
        mongo.bt_player_settings.delete_one({"_id": admin_id})
    else:
        mongo.bt_player_settings.replace_one({"_id": admin_id}, prev_admin_bt)
    # Clean any test groups
    mongo.bt_groups.delete_many({"name": {"$regex": "^TEST_BT_GRP_"}})


# ─────────────── Round A — friends-eligible ──────────────────────────
class TestFriendsEligible:
    """GET /api/bt/friends-eligible (Round A)"""

    def test_returns_friends_with_correct_reasons(self, admin_session, seeded_friends):
        r = requests.get(
            f"{BASE_URL}/api/bt/friends-eligible",
            headers=admin_session["headers"], timeout=15,
        )
        assert r.status_code == 200
        body = r.json()
        assert "friends" in body and "has_my_area" in body
        assert body["has_my_area"] is True

        by_id = {f["user_id"]: f for f in body["friends"]}
        for fid in [seeded_friends["friend_close"], seeded_friends["friend_far"], seeded_friends["friend_no_bt"]]:
            assert fid in by_id, f"friend {fid} missing from response"

        # Close friend → eligible, reason=None, has_bt=True
        close = by_id[seeded_friends["friend_close"]]
        assert close["has_bt"] is True
        assert close["eligible"] is True
        assert close["reason"] is None
        assert close["distance_km"] is not None and close["distance_km"] >= 0

        # Far friend → not eligible, reason=different_region, distance > 0
        far = by_id[seeded_friends["friend_far"]]
        assert far["has_bt"] is True
        assert far["eligible"] is False
        assert far["reason"] == "different_region"
        assert far["distance_km"] is not None and far["distance_km"] > 100

        # No-BT friend → has_bt=False, reason=no_app, distance None
        nob = by_id[seeded_friends["friend_no_bt"]]
        assert nob["has_bt"] is False
        assert nob["eligible"] is False
        assert nob["reason"] == "no_app"

    def test_no_my_area_sets_reason_for_all(self, mongo, admin_session, seeded_friends):
        """When my own bt_player_settings.{lat,lng} is missing, every friend gets reason=no_my_area
           and has_my_area=False."""
        admin_id = seeded_friends["admin_id"]
        # Snapshot & wipe area
        snapshot = mongo.bt_player_settings.find_one({"_id": admin_id})
        mongo.bt_player_settings.delete_one({"_id": admin_id})
        try:
            r = requests.get(
                f"{BASE_URL}/api/bt/friends-eligible",
                headers=admin_session["headers"], timeout=15,
            )
            assert r.status_code == 200
            body = r.json()
            assert body["has_my_area"] is False
            by_id = {f["user_id"]: f for f in body["friends"]}
            # Friends with BT but no_my_area
            assert by_id[seeded_friends["friend_close"]]["reason"] == "no_my_area"
            assert by_id[seeded_friends["friend_far"]]["reason"] == "no_my_area"
            # Friends without BT still report no_app (no_app branch runs before no_my_area)
            assert by_id[seeded_friends["friend_no_bt"]]["reason"] == "no_app"
        finally:
            if snapshot:
                mongo.bt_player_settings.replace_one({"_id": admin_id}, snapshot, upsert=True)

    def test_empty_friends_list(self, mongo):
        """A user with no friends → friends=[], has_my_area=False (no bt_settings)."""
        uid = f"TEST_BT_LONELY_{uuid.uuid4().hex[:8]}"
        email = f"{uid.lower()}@test.local"
        mongo.users.insert_one({
            "_id": uid, "email": email, "full_name": "Lonely",
            "password_hash": "x", "verified": True,
        })
        mongo.profile.insert_one({"_id": uid, "name": "Lonely"})
        token = _mint_token(uid, email)
        try:
            r = requests.get(
                f"{BASE_URL}/api/bt/friends-eligible",
                headers={"Authorization": f"Bearer {token}"}, timeout=15,
            )
            assert r.status_code == 200
            body = r.json()
            assert body["friends"] == []
            assert body["has_my_area"] is False
        finally:
            mongo.users.delete_one({"_id": uid})
            mongo.profile.delete_one({"_id": uid})


# ─────────────── Round A — accept/reject re-toggle ──────────────────
class TestGroupAcceptRejectToggle:
    """POST /api/bt/groups/{id}/accept ↔ /reject re-toggle while in lobby."""

    def test_retoggle_in_lobby_and_lock_after_bury(self, mongo, admin_session, seeded_friends):
        admin_id = seeded_friends["admin_id"]
        friend_close = seeded_friends["friend_close"]

        # Ensure friend_close has a player location so the invite passes the area check
        mongo.bt_player_location.update_one(
            {"_id": friend_close},
            {"$set": {"_id": friend_close, "lat": 37.7749, "lng": -122.4194,
                      "updated_at": "2026-01-01T00:00:00+00:00"}},
            upsert=True,
        )
        # Create a group via API as admin
        create = requests.post(
            f"{BASE_URL}/api/bt/groups/create",
            headers=admin_session["headers"],
            json={"name": "TEST_BT_GRP_toggle", "lat": 37.7749, "lng": -122.4194, "radius_m": 1000.0},
            timeout=15,
        )
        assert create.status_code == 200, create.text
        gid = create.json()["id"]

        # Invite the close friend
        inv = requests.post(
            f"{BASE_URL}/api/bt/groups/{gid}/invite",
            headers=admin_session["headers"],
            json={"friend_ids": [friend_close]},
            timeout=15,
        )
        assert inv.status_code == 200, inv.text
        assert any(x["user_id"] == friend_close for x in inv.json().get("invited", []))

        # Friend's token to act on accept/reject
        fr_email = mongo.users.find_one({"_id": friend_close})["email"]
        fr_token = _mint_token(friend_close, fr_email)
        fr_headers = {"Authorization": f"Bearer {fr_token}"}

        # Accept → Reject → Accept all 200 while in lobby
        for path in ("accept", "reject", "accept"):
            r = requests.post(
                f"{BASE_URL}/api/bt/groups/{gid}/{path}",
                headers=fr_headers, timeout=15,
            )
            assert r.status_code == 200, f"{path} failed: {r.status_code} {r.text}"
            payload = r.json()
            assert payload.get("responses_locked") is False, "responses_locked should be False in lobby"

        # Now bury the chest as the creator (transitions to "hunting")
        # Need a tiny base64 payload for photo + map screenshot
        tiny_b64 = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        )
        bury = requests.post(
            f"{BASE_URL}/api/bt/groups/{gid}/bury",
            headers=admin_session["headers"],
            json={
                "lat": 37.7749, "lng": -122.4194,
                "photo_base64": tiny_b64,
                "map_screenshot_base64": tiny_b64,
            },
            timeout=20,
        )
        assert bury.status_code == 200, bury.text
        assert bury.json().get("responses_locked") is True, "responses_locked should flip to True after bury"

        # After bury, accept/reject must 400 with the "locked" message
        r = requests.post(f"{BASE_URL}/api/bt/groups/{gid}/accept", headers=fr_headers, timeout=15)
        assert r.status_code == 400
        assert "locked" in r.text.lower()


# ─────────────── Round B — invite lifecycle ─────────────────────────
class TestInviteLifecycle:
    """bt_invites collection lifecycle (Round B)."""

    def test_full_invite_lifecycle(self, mongo, admin_session, seeded_friends):
        admin_id = seeded_friends["admin_id"]
        friend_close = seeded_friends["friend_close"]

        mongo.bt_player_location.update_one(
            {"_id": friend_close},
            {"$set": {"_id": friend_close, "lat": 37.7749, "lng": -122.4194,
                      "updated_at": "2026-01-01T00:00:00+00:00"}},
            upsert=True,
        )
        create = requests.post(
            f"{BASE_URL}/api/bt/groups/create",
            headers=admin_session["headers"],
            json={"name": "TEST_BT_GRP_invite", "lat": 37.7749, "lng": -122.4194, "radius_m": 1000.0},
            timeout=15,
        )
        assert create.status_code == 200, create.text
        gid = create.json()["id"]

        # Step 1 — invite → bt_invites doc must exist
        inv = requests.post(
            f"{BASE_URL}/api/bt/groups/{gid}/invite",
            headers=admin_session["headers"],
            json={"friend_ids": [friend_close]},
            timeout=15,
        )
        assert inv.status_code == 200, inv.text
        invite_doc = mongo.bt_invites.find_one({"group_id": gid, "user_id": friend_close})
        assert invite_doc is not None, "bt_invites doc was not created"
        assert invite_doc.get("requires_view") is True
        assert invite_doc.get("opened_at") is None
        assert invite_doc.get("creator_name")
        assert invite_doc.get("group_name") == "TEST_BT_GRP_invite"

        # Step 2 — friend hits /api/bt/invites/pending
        fr_email = mongo.users.find_one({"_id": friend_close})["email"]
        fr_token = _mint_token(friend_close, fr_email)
        fr_headers = {"Authorization": f"Bearer {fr_token}"}
        pending = requests.get(
            f"{BASE_URL}/api/bt/invites/pending",
            headers=fr_headers, timeout=15,
        )
        assert pending.status_code == 200
        pj = pending.json()
        assert any(p["group_id"] == gid for p in pj.get("invites", [])), \
            f"invite {gid} not returned in pending list"

        # Step 3 — call /invites/{gid}/view → 200, idempotent (call twice)
        for _ in range(2):
            v = requests.post(
                f"{BASE_URL}/api/bt/invites/{gid}/view",
                headers=fr_headers, timeout=15,
            )
            assert v.status_code == 200
            assert v.json().get("ok") is True

        # pending should NOT contain it anymore
        pending2 = requests.get(
            f"{BASE_URL}/api/bt/invites/pending",
            headers=fr_headers, timeout=15,
        )
        assert pending2.status_code == 200
        assert not any(p["group_id"] == gid for p in pending2.json().get("invites", []))
        # DB confirms requires_view=False, opened_at set
        doc2 = mongo.bt_invites.find_one({"group_id": gid, "user_id": friend_close})
        assert doc2["requires_view"] is False
        assert doc2["opened_at"] is not None

        # Step 4 — accept the invite — should ALSO keep it cleared (idempotency)
        acc = requests.post(
            f"{BASE_URL}/api/bt/groups/{gid}/accept",
            headers=fr_headers, timeout=15,
        )
        assert acc.status_code == 200
        doc3 = mongo.bt_invites.find_one({"group_id": gid, "user_id": friend_close})
        assert doc3["requires_view"] is False, "accept should keep invite cleared"

        # Step 5 — re-invite the same user → requires_view should flip back to True
        # First reset their status so the invite path runs (delete from members)
        mongo.bt_groups.update_one(
            {"_id": gid},
            {"$pull": {"members": {"user_id": friend_close}}},
        )
        re_inv = requests.post(
            f"{BASE_URL}/api/bt/groups/{gid}/invite",
            headers=admin_session["headers"],
            json={"friend_ids": [friend_close]},
            timeout=15,
        )
        assert re_inv.status_code == 200, re_inv.text
        doc4 = mongo.bt_invites.find_one({"group_id": gid, "user_id": friend_close})
        assert doc4["requires_view"] is True, "re-invite should restore requires_view=True"
        assert doc4["opened_at"] is None
