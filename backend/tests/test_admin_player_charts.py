"""
Backend regression tests for the admin "Player Progress charts" drill-down,
specifically the new Points+ History + Money-Spent-on-Multipliers fields
added to GET /api/admin/players/{player_id}/charts.

Scenarios covered:
  - 403 for non-admin caller
  - 404 for unknown player
  - Original fields still present (xp, gifted_xp, penalty_xp, goal_xp, tasks, by_area)
  - New top-level field `boost_spend_currency`
  - Per-day `boosts_active: [{type, multiplier, duration_days, label, entry_id}]`
  - Multi-day boost timeline stretching (double_week => 7 consecutive active days)
  - `boost_spend` per day, summed only from sources in {purchase, stripe}
  - Legacy purchase entries (no paid_amount) fall back to current pricing
  - `_grant_boost_to_inventory` snapshots paid_amount + paid_currency

The MongoDB collections are seeded directly via motor (same MONGO_URL the
backend uses) — there is no public endpoint to inject arbitrary
boost_inventory entries. HTTP calls go through the public preview URL so we
match what the mobile client actually sees.
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

# ─── Env wiring ─────────────────────────────────────────────────────────
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

BASE_URL = (
    os.environ.get("EXPO_BACKEND_URL")
    or os.environ.get("EXPO_PUBLIC_BACKEND_URL")
)
if not BASE_URL:
    # Fallback: read frontend/.env for the public preview URL.
    fe_env = Path(__file__).resolve().parents[2] / "frontend" / ".env"
    if fe_env.is_file():
        for line in fe_env.read_text().splitlines():
            if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().strip('"')
                break
BASE_URL = (BASE_URL or "").rstrip("/")
assert BASE_URL, "BASE_URL not configured"

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

TEST_RUN_TAG = f"TEST_charts_{uuid.uuid4().hex[:8]}"


# ─── Module fixtures ────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def s() -> requests.Session:
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module")
def admin(s):
    r = s.post(f"{BASE_URL}/api/auth/login", json={
        "email": ADMIN_EMAIL,
        "password": ADMIN_PASSWORD,
    })
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text[:200]}"
    data = r.json()
    return {
        "token": data["token"],
        "user_id": data["user"]["id"],
        "headers": {"Authorization": f"Bearer {data['token']}"},
    }


@pytest.fixture(scope="module")
def non_admin(s):
    """Register a fresh non-admin user."""
    # Use a real domain (gmail.com); the backend MX-validates email domains.
    email = f"test.charts.{uuid.uuid4().hex[:10]}@gmail.com".lower()
    pw = "Password123!"
    r = s.post(f"{BASE_URL}/api/auth/register", json={
        "email": email,
        "password": pw,
        "full_name": "TEST_charts_user",
    })
    assert r.status_code in (200, 201), f"Register failed: {r.status_code} {r.text[:200]}"
    r2 = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    assert r2.status_code == 200, f"Non-admin login failed: {r2.status_code} {r2.text[:200]}"
    data = r2.json()
    return {
        "token": data["token"],
        "user_id": data["user"]["id"],
        "headers": {"Authorization": f"Bearer {data['token']}"},
        "email": email,
    }


# Pre-computed dates for the seeded inventory.
TODAY = datetime.now(timezone.utc).date()


def _iso(d):
    """ISO-8601 UTC for a date (midnight) or a datetime."""
    if isinstance(d, datetime):
        return d.replace(tzinfo=timezone.utc).isoformat()
    return datetime(d.year, d.month, d.day, 12, 0, 0, tzinfo=timezone.utc).isoformat()


@pytest.fixture(scope="module")
def seeded_player(admin):
    """Seed the admin profile's boost_inventory with a controlled mix of
    entries covering every spend/timeline branch. We use the admin's own
    profile so we don't need to create+activate a second player.

    Layout (D = today):
      1. triple_day  source=purchase  paid_amount=4.99 USD  acquired_at=D
         activated, span D..D                              → spend D = 4.99, active D
      2. double_week source=stripe    paid_amount=9.99 AUD  acquired_at=D-7
         activated, span D-7..D-1 (7 days)                 → spend D-7 = 9.99,
                                                             active D-7..D-1
      3. double_day  source=purchase  NO paid_amount       acquired_at=D-2
         activated, span D-3..D                            → spend D-2 fallback,
                                                             active D-3..D
      4. double_month source=shop     paid_amount=ignored  acquired_at=D-5
         NOT activated                                    → NOT counted in spend,
                                                             NOT in timeline
      5. triple_day  source=leaderboard_winner activated span D..D
                                                          → active D, NOT in spend
    """
    asyncio.run(_seed_async(admin["user_id"]))
    yield admin["user_id"]
    # Cleanup — strip out our test entries by tag.
    asyncio.run(_cleanup_async(admin["user_id"]))


async def _seed_async(user_id: str):
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    try:
        # Ensure boost_pricing rows exist so the fallback path can find a price.
        # We seed via Mongo directly to avoid mutating production-set prices
        # any longer than needed. We snapshot+restore at cleanup time.
        existing_pricing = await db.boost_pricing.find({}).to_list(20)
        await db.profile.update_one(
            {"_id": user_id},
            {
                "$set": {
                    f"_test_pricing_snapshot_{TEST_RUN_TAG}": existing_pricing,
                }
            },
            upsert=True,
        )
        for bid, price in (
            ("triple_day", 4.99),
            ("double_day", 2.99),
            ("double_week", 9.99),
            ("double_month", 19.99),
        ):
            await db.boost_pricing.update_one(
                {"boost_id": bid},
                {
                    "$set": {
                        "boost_id": bid,
                        "price": price,
                        "currency": "AUD",
                        "purchase_url": "",
                        "discount_percent": 0,
                        "discount_starts_at": None,
                        "discount_ends_at": None,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    },
                    "$setOnInsert": {"_id": str(uuid.uuid4())},
                },
                upsert=True,
            )

        # Strip any prior test entries first.
        await db.profile.update_one(
            {"_id": user_id},
            {"$pull": {"boost_inventory": {"_test_tag": TEST_RUN_TAG}}},
        )

        d_today = TODAY
        d_m1 = TODAY - timedelta(days=1)
        d_m2 = TODAY - timedelta(days=2)
        d_m3 = TODAY - timedelta(days=3)
        d_m5 = TODAY - timedelta(days=5)
        d_m7 = TODAY - timedelta(days=7)

        entries = [
            # 1. Triple day, purchase, with snapshot price
            {
                "id": f"{TEST_RUN_TAG}-1", "_test_tag": TEST_RUN_TAG,
                "type": "triple_day", "multiplier": 3, "duration_days": 1,
                "label": "Triple points today",
                "source": "purchase",
                "acquired_at": _iso(d_today),
                "activated": True,
                "activated_at": _iso(d_today),
                "expires_at": _iso(d_today),
                "paid_amount": 4.99,
                "paid_currency": "USD",
            },
            # 2. Double week, stripe, 7-day span
            {
                "id": f"{TEST_RUN_TAG}-2", "_test_tag": TEST_RUN_TAG,
                "type": "double_week", "multiplier": 2, "duration_days": 7,
                "label": "Double points for 7 days",
                "source": "stripe",
                "acquired_at": _iso(d_m7),
                "activated": True,
                "activated_at": _iso(d_m7),
                "expires_at": _iso(d_m1),
                "paid_amount": 9.99,
                "paid_currency": "AUD",
            },
            # 3. Legacy purchase (no paid_amount) — fallback to current price
            {
                "id": f"{TEST_RUN_TAG}-3", "_test_tag": TEST_RUN_TAG,
                "type": "double_day", "multiplier": 2, "duration_days": 1,
                "label": "Double points for 1 day",
                "source": "purchase",
                "acquired_at": _iso(d_m2),
                "activated": True,
                "activated_at": _iso(d_m3),
                "expires_at": _iso(d_today),
            },
            # 4. Shop source — must NOT count in spend, must NOT be in timeline (not activated)
            {
                "id": f"{TEST_RUN_TAG}-4", "_test_tag": TEST_RUN_TAG,
                "type": "double_month", "multiplier": 2, "duration_days": 30,
                "label": "Double points for 1 month",
                "source": "shop",
                "acquired_at": _iso(d_m5),
                "activated": False,
                "paid_amount": 19.99,
                "paid_currency": "AUD",
            },
            # 5. Leaderboard winner — active today, NOT in spend
            {
                "id": f"{TEST_RUN_TAG}-5", "_test_tag": TEST_RUN_TAG,
                "type": "triple_day", "multiplier": 3, "duration_days": 1,
                "label": "Triple points today",
                "source": "leaderboard_winner",
                "acquired_at": _iso(d_today),
                "activated": True,
                "activated_at": _iso(d_today),
                "expires_at": _iso(d_today),
            },
        ]
        await db.profile.update_one(
            {"_id": user_id},
            {"$push": {"boost_inventory": {"$each": entries}}},
            upsert=True,
        )
    finally:
        client.close()


async def _cleanup_async(user_id: str):
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    try:
        # Remove only entries we added.
        await db.profile.update_one(
            {"_id": user_id},
            {"$pull": {"boost_inventory": {"_test_tag": TEST_RUN_TAG}}},
        )
        # Restore boost_pricing snapshot.
        prof = await db.profile.find_one({"_id": user_id})
        snap_key = f"_test_pricing_snapshot_{TEST_RUN_TAG}"
        snap = (prof or {}).get(snap_key)
        if snap is not None:
            # Wipe everything we may have added and reinstate prior rows.
            await db.boost_pricing.delete_many({})
            if snap:
                # Restore _id field where present so docs match originals.
                await db.boost_pricing.insert_many([
                    {**row} for row in snap
                ])
            await db.profile.update_one(
                {"_id": user_id},
                {"$unset": {snap_key: ""}},
            )
    finally:
        client.close()


# ─── Tests ──────────────────────────────────────────────────────────────
class TestAuthGuards:
    def test_non_admin_gets_403(self, s, admin, non_admin):
        r = s.get(
            f"{BASE_URL}/api/admin/players/{admin['user_id']}/charts",
            headers=non_admin["headers"],
        )
        assert r.status_code == 403, f"Expected 403, got {r.status_code}: {r.text[:200]}"

    def test_unknown_player_returns_404(self, s, admin):
        r = s.get(
            f"{BASE_URL}/api/admin/players/does-not-exist-{uuid.uuid4().hex}/charts",
            headers=admin["headers"],
        )
        assert r.status_code == 404, f"Expected 404, got {r.status_code}: {r.text[:200]}"


class TestChartsPayload:
    def test_payload_shape(self, s, admin, seeded_player):
        r = s.get(
            f"{BASE_URL}/api/admin/players/{seeded_player}/charts",
            headers=admin["headers"],
        )
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        # Original fields preserved
        assert data["user_id"] == seeded_player
        assert "weekly" in data and "days" in data["weekly"]
        assert "monthly" in data and "days" in data["monthly"]
        assert "by_area" in data and isinstance(data["by_area"], dict)
        # New top-level
        assert "boost_spend_currency" in data
        assert data["boost_spend_currency"] in ("AUD", "USD", "EUR", "GBP", "CAD")
        # Weekly = 7 days, monthly = 30 days
        assert len(data["weekly"]["days"]) == 7, len(data["weekly"]["days"])
        assert len(data["monthly"]["days"]) == 30, len(data["monthly"]["days"])
        # Per-day field shape
        sample = data["weekly"]["days"][-1]
        for k in ("date", "day", "xp", "gifted_xp", "penalty_xp", "goal_xp",
                  "tasks", "boosts_active", "boost_spend"):
            assert k in sample, f"Missing per-day field: {k}"
        assert isinstance(sample["boosts_active"], list)
        assert isinstance(sample["boost_spend"], (int, float))

    def test_boosts_active_timeline_today(self, s, admin, seeded_player):
        r = s.get(
            f"{BASE_URL}/api/admin/players/{seeded_player}/charts",
            headers=admin["headers"],
        )
        data = r.json()
        today_iso = TODAY.isoformat()
        # Find today's day in weekly bucket
        today_day = next(d for d in data["weekly"]["days"] if d["date"] == today_iso)
        types_today = {b["type"] for b in today_day["boosts_active"]}
        # Today should include triple_day (entry 1), double_day (entry 3 spans D-3..D),
        # and leaderboard_winner triple_day (entry 5). NOT double_week (expired
        # yesterday) and NOT double_month (not activated).
        assert "triple_day" in types_today
        assert "double_day" in types_today
        assert "double_week" not in types_today, types_today
        assert "double_month" not in types_today, types_today
        # Each boost dict has the required keys
        for b in today_day["boosts_active"]:
            for k in ("type", "multiplier", "duration_days", "label", "entry_id"):
                assert k in b, f"Missing boost key: {k} in {b}"

    def test_double_week_spans_seven_consecutive_days(self, s, admin, seeded_player):
        r = s.get(
            f"{BASE_URL}/api/admin/players/{seeded_player}/charts",
            headers=admin["headers"],
        )
        data = r.json()
        # double_week ran from D-7 to D-1 — that's 7 consecutive days.
        days = data["monthly"]["days"]
        by_date = {d["date"]: d for d in days}
        active_days = []
        for offset in range(1, 8):  # D-1 .. D-7
            d_iso = (TODAY - timedelta(days=offset)).isoformat()
            if d_iso in by_date:
                types = {b["type"] for b in by_date[d_iso]["boosts_active"]}
                if "double_week" in types:
                    active_days.append(d_iso)
        assert len(active_days) == 7, (
            f"Expected double_week active on 7 consecutive days, got {active_days}"
        )

    def test_double_day_entry3_active_four_days(self, s, admin, seeded_player):
        r = s.get(
            f"{BASE_URL}/api/admin/players/{seeded_player}/charts",
            headers=admin["headers"],
        )
        data = r.json()
        # Entry 3 (double_day) activated_at D-3, expires_at D — should be
        # active on D-3, D-2, D-1, D = 4 days
        days = data["monthly"]["days"]
        by_date = {d["date"]: d for d in days}
        active = 0
        for offset in range(0, 4):
            d_iso = (TODAY - timedelta(days=offset)).isoformat()
            types = {b["type"] for b in by_date.get(d_iso, {}).get("boosts_active", [])}
            if "double_day" in types:
                active += 1
        assert active == 4, f"Expected double_day active on 4 consecutive days, got {active}"

    def test_boost_spend_purchase_and_stripe_only(self, s, admin, seeded_player):
        r = s.get(
            f"{BASE_URL}/api/admin/players/{seeded_player}/charts",
            headers=admin["headers"],
        )
        data = r.json()
        days = data["monthly"]["days"]
        by_date = {d["date"]: d["boost_spend"] for d in days}
        # Spend on TODAY: entry 1 contributes 4.99 (purchase, snapshot USD)
        # Note: triple_day leaderboard_winner entry does NOT contribute (not purchase/stripe).
        # Tolerance for floating point.
        spend_today = by_date.get(TODAY.isoformat(), 0)
        assert abs(spend_today - 4.99) < 0.01, f"Today spend expected 4.99, got {spend_today}"

        # Spend on D-7: entry 2 = 9.99 (stripe)
        spend_m7 = by_date.get((TODAY - timedelta(days=7)).isoformat(), 0)
        assert abs(spend_m7 - 9.99) < 0.01, f"D-7 spend expected 9.99, got {spend_m7}"

        # Spend on D-2: entry 3 legacy fallback → current pricing double_day = 2.99
        spend_m2 = by_date.get((TODAY - timedelta(days=2)).isoformat(), 0)
        assert abs(spend_m2 - 2.99) < 0.01, (
            f"D-2 spend expected 2.99 (legacy fallback), got {spend_m2}"
        )

        # Shop entry on D-5 must NOT contribute (source=shop)
        spend_m5 = by_date.get((TODAY - timedelta(days=5)).isoformat(), 0)
        assert spend_m5 == 0, f"D-5 spend expected 0 (shop excluded), got {spend_m5}"

    def test_boost_spend_currency_present(self, s, admin, seeded_player):
        r = s.get(
            f"{BASE_URL}/api/admin/players/{seeded_player}/charts",
            headers=admin["headers"],
        )
        data = r.json()
        assert data.get("boost_spend_currency"), data
        # First non-empty paid_currency we seeded is USD (entry 1 today),
        # but iteration order depends on inventory order. Accept any string.
        assert isinstance(data["boost_spend_currency"], str)


class TestGrantBoostSnapshot:
    """Verify _grant_boost_to_inventory snapshots paid_amount/paid_currency.

    We exercise this via POST /api/boosts/purchase which calls
    `_grant_boost_to_inventory(user, boost_id, source='purchase')` for
    paid boosts. Then read the user's profile directly to confirm
    the new entry has paid_amount + paid_currency.
    """

    def test_purchase_endpoint_snapshots_paid_amount(self, s, non_admin):
        # Use the non_admin account so we don't pollute admin inventory.
        boost_id = "triple_day"

        # Ensure pricing row exists with a known value.
        # We can't call /api/boosts/pricing without admin, but the seeding
        # in seeded_player already set triple_day = 4.99 AUD globally.
        # However seeded_player fixture isn't requested here — so seed via mongo.
        async def _ensure_price():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            try:
                await db.boost_pricing.update_one(
                    {"boost_id": boost_id},
                    {
                        "$set": {
                            "boost_id": boost_id,
                            "price": 7.77,
                            "currency": "AUD",
                            "purchase_url": "",
                            "discount_percent": 0,
                            "discount_starts_at": None,
                            "discount_ends_at": None,
                            "updated_at": datetime.now(timezone.utc).isoformat(),
                        },
                        "$setOnInsert": {"_id": str(uuid.uuid4())},
                    },
                    upsert=True,
                )
            finally:
                client.close()

        asyncio.run(_ensure_price())

        r = s.post(
            f"{BASE_URL}/api/boosts/purchase",
            json={"boost_id": boost_id},
            headers=non_admin["headers"],
        )
        assert r.status_code == 200, f"{r.status_code}: {r.text[:200]}"
        body = r.json()
        assert body.get("saved") is True, body
        assert body.get("is_free") is False, body

        # Inspect inventory directly to verify snapshot
        async def _read():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            try:
                p = await db.profile.find_one({"_id": non_admin["user_id"]})
                return (p or {}).get("boost_inventory") or []
            finally:
                client.close()

        inv = asyncio.run(_read())
        purchases = [
            e for e in inv
            if e.get("type") == boost_id and e.get("source") == "purchase"
        ]
        assert purchases, f"No purchase-source triple_day in inventory: {inv}"
        latest = purchases[-1]
        assert "paid_amount" in latest, f"Missing paid_amount: {latest}"
        assert "paid_currency" in latest, f"Missing paid_currency: {latest}"
        assert abs(float(latest["paid_amount"]) - 7.77) < 0.01, latest
        assert latest["paid_currency"] == "AUD", latest


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v", "--tb=short"]))
