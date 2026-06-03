"""
Buried Treasure — Issue Reporting System (2026-06-04) backend tests.

Covers:
  • GET  /api/bt/reports/can-report        — rate-limit probe
  • POST /api/bt/reports                   — validation + happy paths (solo + group) + rate limit
  • GET  /api/bt/reports/pending           — banner feed
  • GET  /api/bt/reports/{rid}             — viewed_by + shape + 403 gating
  • POST /api/bt/reports/{rid}/confirm     — adds bt_blocked_coords row
  • POST /api/bt/reports/{rid}/ignore      — no row, atomic guard against double-resolve
  • _pick_public_chest_point integration  — chests skip blocked coords (live solo/start)
  • Regression smoke for pre-existing /api/bt/* routes
"""
import math
import os
import time
import uuid

import jwt
import pytest
import requests
from pymongo import MongoClient


# ─────────────────────── env helpers ────────────────────────────────
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

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or _fe.get("EXPO_PUBLIC_BACKEND_URL")
    or _fe.get("EXPO_BACKEND_URL")
)
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL not found"
BASE_URL = BASE_URL.rstrip("/")

MONGO_URL = os.environ.get("MONGO_URL") or _be.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME") or _be.get("DB_NAME", "test_database")

JWT_SECRET = os.environ.get("JWT_SECRET", "xp-real-life-dev-secret-change-in-prod-12345")
JWT_ALG = "HS256"

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"


def _mint_token(user_id: str, email: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": user_id, "email": email, "iat": now, "exp": now + 60 * 60 * 24},
        JWT_SECRET,
        algorithm=JWT_ALG,
    )


def _haversine_m(lat1, lng1, lat2, lng2):
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ─────────────────────── fixtures ───────────────────────────────────
@pytest.fixture(scope="module")
def mongo():
    cli = MongoClient(MONGO_URL)
    yield cli[DB_NAME]
    cli.close()


@pytest.fixture(scope="module")
def admin_session():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    data = r.json()
    return {
        "token": data["token"],
        "user_id": data["user"]["id"],
        "headers": {"Authorization": f"Bearer {data['token']}"},
    }


@pytest.fixture(scope="module")
def seeded_users(mongo):
    """Seed two non-admin TEST_BT users directly in mongo + return JWTs."""
    users = []
    for label in ("U", "B"):
        uid = f"TEST_BT_RPT_{label}_{uuid.uuid4().hex[:6]}"
        email = f"{uid.lower()}@test.local"
        mongo.users.insert_one({
            "_id": uid,
            "email": email,
            "full_name": f"TEST_BT_RPT_{label}",
            "password_hash": "x",
            "verified": True,
            "created_at": "2026-01-01T00:00:00+00:00",
        })
        mongo.profile.insert_one({
            "_id": uid, "name": f"TEST_BT_RPT_{label}",
            "avatar_base64": None, "tz_offset_minutes": 0,
        })
        token = _mint_token(uid, email)
        users.append({
            "user_id": uid, "email": email, "token": token,
            "headers": {"Authorization": f"Bearer {token}"},
        })
    yield {"U": users[0], "B": users[1]}
    # teardown
    for u in users:
        mongo.users.delete_one({"_id": u["user_id"]})
        mongo.profile.delete_one({"_id": u["user_id"]})
        mongo.bt_solo.delete_one({"_id": u["user_id"]})
        mongo.bt_player_location.delete_one({"_id": u["user_id"]})
        mongo.friend_requests.delete_many({
            "$or": [{"from_user_id": u["user_id"]}, {"to_user_id": u["user_id"]}],
        })
    mongo.bt_issue_reports.delete_many({
        "reporter_id": {"$in": [u["user_id"] for u in users]},
    })


@pytest.fixture(autouse=True)
def _clean_admin_state(admin_session, mongo):
    """Always start each test with a clean reports table for the admin
    and the seeded users so rate-limit + pending queries are deterministic."""
    admin_id = admin_session["user_id"]
    # Wipe any TEST_BT_ reports & any reports filed BY the admin during the
    # previous test. (Admin filing on their own hunt is harmless because
    # recipients_count = 0; cleaning makes tests order-independent.)
    mongo.bt_issue_reports.delete_many({
        "$or": [
            {"reporter_id": admin_id},
            {"reporter_id": {"$regex": "^TEST_BT_RPT_"}},
            {"recipient_ids": {"$regex": "^TEST_BT_RPT_"}},
        ],
    })
    mongo.bt_blocked_coords.delete_many({"added_by": admin_id})
    mongo.bt_blocked_coords.delete_many({"_id": {"$regex": "^TEST_BT_BLK_"}})
    yield


# ═════════════════════════════════════════════════════════════════════
# 1. /reports/can-report — rate-limit probe
# ═════════════════════════════════════════════════════════════════════
class TestCanReport:
    def test_no_hunt_param(self, admin_session):
        r = requests.get(
            f"{BASE_URL}/api/bt/reports/can-report",
            headers=admin_session["headers"], timeout=10,
        )
        assert r.status_code == 200
        j = r.json()
        assert j["can_report"] is False
        assert j["reason"] == "no_hunt"

    def test_can_report_true_when_no_pending(self, admin_session):
        r = requests.get(
            f"{BASE_URL}/api/bt/reports/can-report",
            headers=admin_session["headers"],
            params={"hunt_id": admin_session["user_id"]},
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json() == {"can_report": True}


# ═════════════════════════════════════════════════════════════════════
# 2. POST /reports — validation
# ═════════════════════════════════════════════════════════════════════
class TestReportValidation:
    def test_invalid_source(self, admin_session):
        r = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=admin_session["headers"],
            json={"source": "bogus", "category": "chest"},
            timeout=10,
        )
        assert r.status_code == 400, r.text

    def test_invalid_category(self, admin_session):
        r = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=admin_session["headers"],
            json={"source": "solo", "category": "spam"},
            timeout=10,
        )
        assert r.status_code == 400, r.text

    def test_group_missing_group_id(self, admin_session):
        r = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=admin_session["headers"],
            json={"source": "group", "category": "chest"},
            timeout=10,
        )
        assert r.status_code == 400

    def test_group_not_found(self, admin_session):
        r = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=admin_session["headers"],
            json={"source": "group", "group_id": "NOPE_NONE", "category": "chest"},
            timeout=10,
        )
        assert r.status_code == 404

    def test_solo_no_active_hunt(self, seeded_users, mongo):
        """User U has no bt_solo row → 404."""
        mongo.bt_solo.delete_one({"_id": seeded_users["U"]["user_id"]})
        r = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=seeded_users["U"]["headers"],
            json={"source": "solo", "category": "chest"},
            timeout=10,
        )
        assert r.status_code == 404


# ═════════════════════════════════════════════════════════════════════
# 3. Happy path SOLO — admin reporting own hunt
# ═════════════════════════════════════════════════════════════════════
class TestSoloAdminSelf:
    def test_admin_reports_own_solo_recipients_zero(self, admin_session, mongo):
        admin_id = admin_session["user_id"]
        # Snapshot prior solo doc for restoration in teardown.
        prev = mongo.bt_solo.find_one({"_id": admin_id})
        # Start a fresh solo hunt (Sydney centre, 800m radius).
        r = requests.post(
            f"{BASE_URL}/api/bt/solo/start",
            headers=admin_session["headers"],
            json={"lat": -33.8688, "lng": 151.2093, "radius_m": 800},
            timeout=90,
        )
        assert r.status_code == 200, r.text
        # File the report.
        r2 = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=admin_session["headers"],
            json={"source": "solo", "category": "chest", "notes": "test admin self"},
            timeout=15,
        )
        assert r2.status_code == 200, r2.text
        j = r2.json()
        assert j["ok"] is True
        assert j["status"] == "pending"
        assert "report_id" in j
        # Edge case: admin reporting own solo → recipients filtered (reporter==admin)
        assert j["recipients_count"] == 0, (
            f"expected 0 recipients (admin filtered out), got {j['recipients_count']}"
        )
        # Verify the doc still got inserted.
        doc = mongo.bt_issue_reports.find_one({"_id": j["report_id"]})
        assert doc is not None
        assert doc["status"] == "pending"
        assert doc["reporter_id"] == admin_id
        assert doc["recipient_ids"] == []
        # restore solo
        if prev:
            mongo.bt_solo.replace_one({"_id": admin_id}, prev)
        else:
            mongo.bt_solo.delete_one({"_id": admin_id})


# ═════════════════════════════════════════════════════════════════════
# 4. Happy path SOLO — non-admin reporting
# ═════════════════════════════════════════════════════════════════════
class TestSoloNonAdmin:
    def test_non_admin_recipients_admin_only(self, seeded_users, admin_session, mongo):
        u = seeded_users["U"]
        admin_id = admin_session["user_id"]
        # Seed a solo hunt for U directly so we don't depend on Overpass.
        mongo.bt_solo.replace_one(
            {"_id": u["user_id"]},
            {
                "_id": u["user_id"],
                "area": {"lat": -33.8688, "lng": 151.2093, "radius_m": 800.0},
                "chest": {"lat": -33.8690, "lng": 151.2094},
                "created_at": "2026-01-01T00:00:00+00:00",
            },
            upsert=True,
        )
        r = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=u["headers"],
            json={"source": "solo", "category": "location", "notes": "blocked alley"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["recipients_count"] == 1
        doc = mongo.bt_issue_reports.find_one({"_id": j["report_id"]})
        assert doc["recipient_ids"] == [admin_id]
        assert doc["category"] == "location"
        assert doc["notes"] == "blocked alley"
        # can-report should now flip to false
        r2 = requests.get(
            f"{BASE_URL}/api/bt/reports/can-report",
            headers=u["headers"],
            params={"hunt_id": u["user_id"]},
            timeout=10,
        )
        body = r2.json()
        assert body["can_report"] is False
        assert body["reason"] == "already_reported"


# ═════════════════════════════════════════════════════════════════════
# 5. Happy path GROUP — non-member 403; member 200; admin == creator dedupe
# ═════════════════════════════════════════════════════════════════════
class TestGroupReports:
    def _seed_group(self, mongo, admin_id, member_id, status="hunting"):
        gid = f"TEST_BT_RPT_GRP_{uuid.uuid4().hex[:6]}"
        doc = {
            "_id": gid,
            "name": "TEST_BT_GRP_RPT",
            "creator_id": admin_id,
            "lat": -33.8688, "lng": 151.2093, "radius_m": 800.0,
            "status": status,
            "members": [
                {"user_id": admin_id, "role": "creator", "status": "accepted"},
                {"user_id": member_id, "role": "member", "status": "accepted"},
            ],
            "chest_lat": -33.8690, "chest_lng": 151.2094,
            "created_at": "2026-01-01T00:00:00+00:00",
        }
        mongo.bt_groups.insert_one(doc)
        return gid

    def test_group_not_hunting_returns_400(self, admin_session, seeded_users, mongo):
        gid = self._seed_group(mongo, admin_session["user_id"], seeded_users["B"]["user_id"], status="lobby")
        try:
            r = requests.post(
                f"{BASE_URL}/api/bt/reports",
                headers=admin_session["headers"],
                json={"source": "group", "group_id": gid, "category": "chest"},
                timeout=10,
            )
            assert r.status_code == 400, r.text
        finally:
            mongo.bt_groups.delete_one({"_id": gid})

    def test_group_non_member_403(self, admin_session, seeded_users, mongo):
        # Seed a group between admin + B; U tries to report → 403
        gid = self._seed_group(mongo, admin_session["user_id"], seeded_users["B"]["user_id"])
        try:
            r = requests.post(
                f"{BASE_URL}/api/bt/reports",
                headers=seeded_users["U"]["headers"],
                json={"source": "group", "group_id": gid, "category": "chest"},
                timeout=10,
            )
            assert r.status_code == 403, r.text
        finally:
            mongo.bt_groups.delete_one({"_id": gid})

    def test_group_member_reports_recipients_dedupe(self, admin_session, seeded_users, mongo):
        """B reports a group where admin is BOTH creator AND admin →
        recipients = [admin] (deduped). recipients_count = 1."""
        admin_id = admin_session["user_id"]
        b = seeded_users["B"]
        gid = self._seed_group(mongo, admin_id, b["user_id"])
        try:
            r = requests.post(
                f"{BASE_URL}/api/bt/reports",
                headers=b["headers"],
                json={
                    "source": "group", "group_id": gid,
                    "category": "location", "notes": "private property",
                },
                timeout=15,
            )
            assert r.status_code == 200, r.text
            j = r.json()
            assert j["recipients_count"] == 1, j
            doc = mongo.bt_issue_reports.find_one({"_id": j["report_id"]})
            assert doc["recipient_ids"] == [admin_id]
            assert doc["group_id"] == gid
            assert doc["group_name"] == "TEST_BT_GRP_RPT"
            assert doc["source"] == "group"
        finally:
            mongo.bt_groups.delete_one({"_id": gid})


# ═════════════════════════════════════════════════════════════════════
# 6. Rate limit — 409 on second pending
# ═════════════════════════════════════════════════════════════════════
class TestRateLimit:
    def test_second_pending_409_then_ok_after_ignore(self, seeded_users, admin_session, mongo):
        u = seeded_users["U"]
        admin_id = admin_session["user_id"]
        mongo.bt_solo.replace_one(
            {"_id": u["user_id"]},
            {
                "_id": u["user_id"],
                "area": {"lat": -33.8688, "lng": 151.2093, "radius_m": 800.0},
                "chest": {"lat": -33.8690, "lng": 151.2094},
                "created_at": "2026-01-01T00:00:00+00:00",
            },
            upsert=True,
        )
        r1 = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=u["headers"],
            json={"source": "solo", "category": "chest"},
            timeout=15,
        )
        assert r1.status_code == 200, r1.text
        rid = r1.json()["report_id"]

        r2 = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=u["headers"],
            json={"source": "solo", "category": "location"},
            timeout=15,
        )
        assert r2.status_code == 409
        assert "already" in r2.text.lower()

        # Admin ignores → status flips out of pending → next post should succeed.
        r_ig = requests.post(
            f"{BASE_URL}/api/bt/reports/{rid}/ignore",
            headers=admin_session["headers"], timeout=10,
        )
        assert r_ig.status_code == 200, r_ig.text
        assert r_ig.json()["status"] == "ignored"

        r3 = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=u["headers"],
            json={"source": "solo", "category": "chest"},
            timeout=15,
        )
        assert r3.status_code == 200, r3.text


# ═════════════════════════════════════════════════════════════════════
# 7. /reports/pending — admin-visible until viewed/resolved
# ═════════════════════════════════════════════════════════════════════
class TestPendingFeed:
    def test_pending_shows_then_clears_on_ignore(self, seeded_users, admin_session, mongo):
        u = seeded_users["U"]
        mongo.bt_solo.replace_one(
            {"_id": u["user_id"]},
            {
                "_id": u["user_id"],
                "area": {"lat": -33.8688, "lng": 151.2093, "radius_m": 800.0},
                "chest": {"lat": -33.8690, "lng": 151.2094},
                "created_at": "2026-01-01T00:00:00+00:00",
            },
            upsert=True,
        )
        r = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=u["headers"],
            json={"source": "solo", "category": "chest", "notes": "pending-feed-test"},
            timeout=15,
        )
        assert r.status_code == 200
        rid = r.json()["report_id"]

        # Admin should see it in /pending
        rp = requests.get(
            f"{BASE_URL}/api/bt/reports/pending",
            headers=admin_session["headers"], timeout=10,
        )
        assert rp.status_code == 200
        j = rp.json()
        assert j["count"] >= 1
        assert any(rec["report_id"] == rid for rec in j["reports"])

        # Ignore it
        ri = requests.post(
            f"{BASE_URL}/api/bt/reports/{rid}/ignore",
            headers=admin_session["headers"], timeout=10,
        )
        assert ri.status_code == 200

        rp2 = requests.get(
            f"{BASE_URL}/api/bt/reports/pending",
            headers=admin_session["headers"], timeout=10,
        )
        ids_after = [rec["report_id"] for rec in rp2.json()["reports"]]
        assert rid not in ids_after


# ═════════════════════════════════════════════════════════════════════
# 8. GET /reports/{rid} — shape + viewed_by + 403 gating
# ═════════════════════════════════════════════════════════════════════
class TestGetSingleReport:
    def test_shape_and_viewed_by(self, seeded_users, admin_session, mongo):
        u = seeded_users["U"]
        admin_id = admin_session["user_id"]
        mongo.bt_solo.replace_one(
            {"_id": u["user_id"]},
            {
                "_id": u["user_id"],
                "area": {"lat": -33.8688, "lng": 151.2093, "radius_m": 800.0},
                "chest": {"lat": -33.8690, "lng": 151.2094},
                "created_at": "2026-01-01T00:00:00+00:00",
            },
            upsert=True,
        )
        r = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=u["headers"],
            json={"source": "solo", "category": "location", "notes": "shape-test"},
            timeout=15,
        )
        assert r.status_code == 200
        rid = r.json()["report_id"]
        # Admin opens (recipient) — should mark viewed
        rg = requests.get(
            f"{BASE_URL}/api/bt/reports/{rid}",
            headers=admin_session["headers"], timeout=10,
        )
        assert rg.status_code == 200, rg.text
        body = rg.json()
        for k in ["report_id", "source", "category", "notes", "chest_lat",
                  "chest_lng", "reporter_id", "reporter_name", "status",
                  "created_at", "can_review"]:
            assert k in body, f"missing key {k}"
        assert body["can_review"] is True
        # viewed_by should now include admin
        doc = mongo.bt_issue_reports.find_one({"_id": rid})
        assert admin_id in (doc.get("viewed_by") or [])

    def test_non_recipient_non_reporter_non_admin_403(self, seeded_users, admin_session, mongo):
        u = seeded_users["U"]
        b = seeded_users["B"]
        mongo.bt_solo.replace_one(
            {"_id": u["user_id"]},
            {
                "_id": u["user_id"],
                "area": {"lat": -33.8688, "lng": 151.2093, "radius_m": 800.0},
                "chest": {"lat": -33.8690, "lng": 151.2094},
                "created_at": "2026-01-01T00:00:00+00:00",
            },
            upsert=True,
        )
        r = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=u["headers"],
            json={"source": "solo", "category": "chest"},
            timeout=15,
        )
        rid = r.json()["report_id"]
        # B is neither reporter nor recipient nor admin
        rg = requests.get(
            f"{BASE_URL}/api/bt/reports/{rid}",
            headers=b["headers"], timeout=10,
        )
        assert rg.status_code == 403


# ═════════════════════════════════════════════════════════════════════
# 9. /confirm — inserts bt_blocked_coords; /ignore — does not
# ═════════════════════════════════════════════════════════════════════
class TestConfirmIgnore:
    def _file_solo_report(self, mongo, seeded_users):
        u = seeded_users["U"]
        mongo.bt_solo.replace_one(
            {"_id": u["user_id"]},
            {
                "_id": u["user_id"],
                "area": {"lat": -33.8688, "lng": 151.2093, "radius_m": 800.0},
                "chest": {"lat": -33.8690, "lng": 151.2094},
                "created_at": "2026-01-01T00:00:00+00:00",
            },
            upsert=True,
        )
        r = requests.post(
            f"{BASE_URL}/api/bt/reports",
            headers=u["headers"],
            json={"source": "solo", "category": "chest"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        return r.json()["report_id"]

    def test_confirm_inserts_block_then_409_on_second(self, seeded_users, admin_session, mongo):
        rid = self._file_solo_report(mongo, seeded_users)
        # Confirm
        r = requests.post(
            f"{BASE_URL}/api/bt/reports/{rid}/confirm",
            headers=admin_session["headers"], timeout=10,
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["status"] == "confirmed"
        # bt_blocked_coords row inserted
        blk = mongo.bt_blocked_coords.find_one({"source_report_id": rid})
        assert blk is not None
        assert abs(blk["lat"] - (-33.8690)) < 1e-6
        assert abs(blk["lng"] - 151.2094) < 1e-6
        assert blk["radius_m"] == 30.0
        assert blk["added_by"] == admin_session["user_id"]
        # Second confirm → 400 ("already confirmed/ignored")
        r2 = requests.post(
            f"{BASE_URL}/api/bt/reports/{rid}/confirm",
            headers=admin_session["headers"], timeout=10,
        )
        assert r2.status_code == 400, r2.text
        # cleanup
        mongo.bt_blocked_coords.delete_many({"source_report_id": rid})

    def test_ignore_no_block_then_400_on_second(self, seeded_users, admin_session, mongo):
        rid = self._file_solo_report(mongo, seeded_users)
        r = requests.post(
            f"{BASE_URL}/api/bt/reports/{rid}/ignore",
            headers=admin_session["headers"], timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["status"] == "ignored"
        # No blocked coord row
        assert mongo.bt_blocked_coords.find_one({"source_report_id": rid}) is None
        r2 = requests.post(
            f"{BASE_URL}/api/bt/reports/{rid}/ignore",
            headers=admin_session["headers"], timeout=10,
        )
        assert r2.status_code == 400


# ═════════════════════════════════════════════════════════════════════
# 10. Block-aware chest picker integration test
# ═════════════════════════════════════════════════════════════════════
class TestBlockedChestPicker:
    def test_chest_avoids_blocked_coord(self, admin_session, mongo):
        """Seed a bt_blocked_coords at a fixed coord, then create a tiny
        solo hunt CENTERED there with a small radius. The picker should
        steer the chest away from the 30 m block. Repeat 5x for stability."""
        admin_id = admin_session["user_id"]
        # Use a remote rural coord so Overpass likely returns nothing
        # and we exercise both branches (overpass-filter AND random-fallback).
        block_lat, block_lng = 70.0, -130.0  # Arctic Canada — barren
        block_id = f"TEST_BT_BLK_{uuid.uuid4().hex[:6]}"
        mongo.bt_blocked_coords.insert_one({
            "_id": block_id,
            "lat": block_lat, "lng": block_lng,
            "radius_m": 30.0,
            "source_report_id": "TEST_INTEGRATION",
            "added_by": admin_id,
            "added_at": "2026-01-01T00:00:00+00:00",
        })
        # Snapshot admin solo doc for restoration
        prev = mongo.bt_solo.find_one({"_id": admin_id})
        try:
            for i in range(5):
                r = requests.post(
                    f"{BASE_URL}/api/bt/solo/start",
                    headers=admin_session["headers"],
                    json={"lat": block_lat, "lng": block_lng, "radius_m": 100},
                    timeout=90,
                )
                assert r.status_code == 200, r.text
                doc = mongo.bt_solo.find_one({"_id": admin_id})
                chest = doc.get("chest") or {}
                dist = _haversine_m(block_lat, block_lng, chest["lat"], chest["lng"])
                assert dist > 30.0, (
                    f"attempt {i}: chest {chest} only {dist:.1f}m from blocked coord"
                )
        finally:
            mongo.bt_blocked_coords.delete_one({"_id": block_id})
            if prev:
                mongo.bt_solo.replace_one({"_id": admin_id}, prev)
            else:
                mongo.bt_solo.delete_one({"_id": admin_id})


# ═════════════════════════════════════════════════════════════════════
# 11. Regression smoke — existing /api/bt/* endpoints still 200
# ═════════════════════════════════════════════════════════════════════
class TestRegressionSmoke:
    @pytest.mark.parametrize("path", [
        "/api/bt/settings",
        "/api/bt/schedule",
        "/api/bt/solo/current",
        "/api/bt/groups/mine",
        "/api/bt/groups/available",
        "/api/bt/friends-eligible",
        "/api/bt/invites/pending",
        "/api/bt/reports/pending",
    ])
    def test_get_endpoint_200(self, admin_session, path):
        r = requests.get(f"{BASE_URL}{path}", headers=admin_session["headers"], timeout=15)
        assert r.status_code == 200, f"{path} → {r.status_code} {r.text[:200]}"

    def test_post_location(self, admin_session):
        r = requests.post(
            f"{BASE_URL}/api/bt/location",
            headers=admin_session["headers"],
            json={"lat": -33.8688, "lng": 151.2093},
            timeout=10,
        )
        assert r.status_code == 200
