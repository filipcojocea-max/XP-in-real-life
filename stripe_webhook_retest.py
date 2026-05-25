"""
Re-test for Stripe Checkout webhook idempotency (step 6 of the prior plan).

After main agent added `import json` at server.py L7, verify:
6a. Admin sets sleep pricing to {price:9.99, currency:'USD'}.
6b. Register fresh gmail.com user B and capture user_id.
6c. POST /api/payments/webhook (no signature header) with checkout.session.completed payload
    -> expect 200 {received:true, type:'checkout.session.completed'}.
6d. GET /api/library/pricing as user B -> sleep.purchased=true.
6e. Re-POST EXACT same payload -> 200; verify NO duplicate row in library_purchases.
   Bonus: vary id with a different cs_test_dummy_b_*; same user_id+app_id pair
   should also be skipped (unique on $or check).
"""
import os
import sys
import uuid
import asyncio
import requests

API_BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

assertions = []


def assert_ok(name, cond, info=""):
    status = "PASS" if cond else "FAIL"
    assertions.append((status, name, info))
    marker = "✅" if cond else "❌"
    print(f"  {marker} [{status}] {name}{(' :: ' + info) if info else ''}")
    return cond


def admin_login():
    r = requests.post(f"{API_BASE}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=20)
    assert_ok("admin login 200", r.status_code == 200, f"got {r.status_code} body={r.text[:160]}")
    body = r.json()
    return body["token"]


def register_user(prefix):
    rand = uuid.uuid4().hex[:8]
    email = f"{prefix}+{rand}@gmail.com"
    payload = {
        "email": email,
        "password": "TestPass123!",
        "full_name": "Ryan Chen",
    }
    r = requests.post(f"{API_BASE}/auth/register", json=payload, timeout=20)
    assert_ok(f"register {prefix} 200", r.status_code == 200, f"got {r.status_code} body={r.text[:160]}")
    body = r.json()
    token = body.get("token")
    user_id = body.get("user", {}).get("id") or body.get("user", {}).get("user_id")
    return token, user_id, email


def get_profile(token):
    r = requests.get(f"{API_BASE}/profile",
                     headers={"Authorization": f"Bearer {token}"}, timeout=20)
    return r.status_code, r.json() if r.status_code == 200 else r.text


async def count_library_purchases(user_id, app_id):
    from motor.motor_asyncio import AsyncIOMotorClient
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "test_database")
    cli = AsyncIOMotorClient(mongo_url)
    try:
        c = await cli[db_name].library_purchases.count_documents({"user_id": user_id, "app_id": app_id})
        rows = []
        async for d in cli[db_name].library_purchases.find({"user_id": user_id, "app_id": app_id}):
            d["_id"] = str(d.get("_id"))
            rows.append(d)
        return c, rows
    finally:
        cli.close()


def main():
    print("=" * 80)
    print("Stripe Checkout — webhook idempotency re-test")
    print(f"API_BASE={API_BASE}")
    print("=" * 80)

    # 6a — admin sets sleep pricing
    print("\n[6a] admin login + set sleep pricing 9.99/USD")
    admin_token = admin_login()
    r = requests.post(f"{API_BASE}/library/pricing/sleep",
                      headers={"Authorization": f"Bearer {admin_token}"},
                      json={"price": 9.99, "currency": "USD", "purchase_url": ""},
                      timeout=20)
    assert_ok("admin set sleep 9.99/USD -> 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        pub = r.json().get("pricing", {})
        assert_ok("pricing.price == 9.99", pub.get("price") == 9.99, f"got {pub.get('price')}")
        assert_ok("pricing.currency == USD", pub.get("currency") == "USD", f"got {pub.get('currency')}")
        assert_ok("pricing.is_free == false", pub.get("is_free") is False, f"got {pub.get('is_free')}")

    # 6b — register fresh gmail user B
    print("\n[6b] register fresh gmail.com user B")
    token_b, user_b, email_b = register_user("ryan.chen.webhook")
    assert_ok("user_b id non-empty", bool(user_b), f"id={user_b}")
    print(f"      B user_id = {user_b}, email = {email_b}")

    # confirm sleep.purchased=false to start
    r = requests.get(f"{API_BASE}/library/pricing",
                     headers={"Authorization": f"Bearer {token_b}"}, timeout=20)
    assert_ok("B GET /library/pricing -> 200", r.status_code == 200, f"got {r.status_code}")
    if r.status_code == 200:
        sleep = r.json().get("pricing", {}).get("sleep", {})
        assert_ok("B sleep.purchased == false (pre-webhook)", sleep.get("purchased") is False,
                  f"got {sleep.get('purchased')}")

    # 6c — POST webhook (no signature header)
    print("\n[6c] POST /api/payments/webhook (no sig header) — checkout.session.completed")
    session_id_1 = f"cs_test_dummy_b_{uuid.uuid4().hex[:12]}"
    payload = {
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": session_id_1,
                "payment_status": "paid",
                "status": "complete",
                "amount_total": 999,
                "currency": "usd",
                "payment_intent": "pi_test_dummy_b",
                "metadata": {"user_id": user_b, "app_id": "sleep"},
            }
        }
    }
    r = requests.post(f"{API_BASE}/payments/webhook", json=payload, timeout=20)
    assert_ok("webhook POST -> 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        wb = r.json()
        assert_ok("webhook body.received == true", wb.get("received") is True, f"got {wb.get('received')}")
        assert_ok("webhook body.type == 'checkout.session.completed'",
                  wb.get("type") == "checkout.session.completed",
                  f"got {wb.get('type')}")

    # 6d — sleep.purchased should be true now
    print("\n[6d] B GET /library/pricing -> sleep.purchased=true")
    r = requests.get(f"{API_BASE}/library/pricing",
                     headers={"Authorization": f"Bearer {token_b}"}, timeout=20)
    assert_ok("B GET /library/pricing -> 200 (post-webhook)", r.status_code == 200, f"got {r.status_code}")
    if r.status_code == 200:
        sleep = r.json().get("pricing", {}).get("sleep", {})
        assert_ok("B sleep.purchased == true (post-webhook)", sleep.get("purchased") is True,
                  f"got {sleep.get('purchased')}")

    # Direct DB check — exactly 1 row in library_purchases for (B, sleep)
    print("\n[6d-db] direct count of library_purchases rows (post first webhook)")
    cnt1, rows1 = asyncio.run(count_library_purchases(user_b, "sleep"))
    assert_ok("library_purchases count == 1 after first webhook", cnt1 == 1, f"got {cnt1} rows; rows={rows1}")
    if rows1:
        r0 = rows1[0]
        assert_ok("library_purchases row.source == 'stripe'", r0.get("source") == "stripe",
                  f"got source={r0.get('source')}")
        assert_ok(f"library_purchases row.stripe_session_id == {session_id_1}",
                  r0.get("stripe_session_id") == session_id_1,
                  f"got {r0.get('stripe_session_id')}")
        assert_ok("library_purchases row.paid_amount == 9.99", r0.get("paid_amount") == 9.99,
                  f"got {r0.get('paid_amount')}")
        assert_ok("library_purchases row.paid_currency == 'USD'", r0.get("paid_currency") == "USD",
                  f"got {r0.get('paid_currency')}")

    # 6e — re-POST EXACT same payload — should be no-op idempotent
    print("\n[6e] re-POST EXACT SAME payload -> 200 + no duplicate row")
    r = requests.post(f"{API_BASE}/payments/webhook", json=payload, timeout=20)
    assert_ok("webhook re-POST same payload -> 200", r.status_code == 200, f"got {r.status_code}")
    if r.status_code == 200:
        wb = r.json()
        assert_ok("re-POST body.received == true", wb.get("received") is True, f"got {wb.get('received')}")
        assert_ok("re-POST body.type == 'checkout.session.completed'",
                  wb.get("type") == "checkout.session.completed",
                  f"got {wb.get('type')}")
    cnt2, rows2 = asyncio.run(count_library_purchases(user_b, "sleep"))
    assert_ok("library_purchases count STILL == 1 after duplicate webhook (idempotent)",
              cnt2 == 1, f"got {cnt2} rows")

    # Bonus: vary the id with a different cs_test_dummy_b_*; same user_id+app_id pair → skipped
    print("\n[6e-bonus] vary id but SAME user_id+app_id -> still no duplicate (uniqueness via $or)")
    session_id_2 = f"cs_test_dummy_b_{uuid.uuid4().hex[:12]}"
    payload2 = dict(payload)
    payload2["data"] = {"object": dict(payload["data"]["object"])}
    payload2["data"]["object"]["id"] = session_id_2
    payload2["data"]["object"]["payment_intent"] = "pi_test_dummy_b_v2"
    r = requests.post(f"{API_BASE}/payments/webhook", json=payload2, timeout=20)
    assert_ok("webhook POST varied-id same-user+app -> 200", r.status_code == 200, f"got {r.status_code}")
    cnt3, rows3 = asyncio.run(count_library_purchases(user_b, "sleep"))
    assert_ok("library_purchases count STILL == 1 even for varied session_id (user+app pair unique)",
              cnt3 == 1, f"got {cnt3} rows")

    # And sleep.purchased remains true.
    r = requests.get(f"{API_BASE}/library/pricing",
                     headers={"Authorization": f"Bearer {token_b}"}, timeout=20)
    if r.status_code == 200:
        sleep = r.json().get("pricing", {}).get("sleep", {})
        assert_ok("B sleep.purchased remains true after duplicates", sleep.get("purchased") is True,
                  f"got {sleep.get('purchased')}")

    # Bonus 2: confirm the original row still has the FIRST session_id (we don't overwrite)
    if rows3:
        r0 = rows3[0]
        # The behaviour in _stripe_record_purchase is: if user_id+app_id already exists,
        # backfill stripe_session_id ONLY if it was empty. Our row already has session_id_1
        # so it should NOT be overwritten.
        assert_ok("original row.stripe_session_id NOT overwritten by varied-id duplicate",
                  r0.get("stripe_session_id") == session_id_1,
                  f"got {r0.get('stripe_session_id')}, expected {session_id_1}")

    print("\n" + "=" * 80)
    p = sum(1 for s, _, _ in assertions if s == "PASS")
    f = sum(1 for s, _, _ in assertions if s == "FAIL")
    print(f"RESULT: {p}/{p+f} PASS")
    if f:
        print("\nFAILED:")
        for s, n, info in assertions:
            if s == "FAIL":
                print(f"  ❌ {n} :: {info}")
    print("=" * 80)
    sys.exit(0 if f == 0 else 1)


if __name__ == "__main__":
    main()
