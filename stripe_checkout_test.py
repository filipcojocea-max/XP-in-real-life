"""
Stripe Checkout integration test.

Endpoints under test (server.py L7400+):
- POST /api/payments/create-checkout
- POST /api/payments/webhook
- GET  /api/payments/session/{id}/verify
- GET  /api/payments/return
"""
from __future__ import annotations
import os
import json
import time
import uuid
import asyncio
import requests

API_BASE = "https://xp-confidence.preview.emergentagent.com/api"

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASS = "XL98CZW5599"

results: list[tuple[str, bool, str]] = []


def assert_eq(label: str, actual, expected) -> bool:
    ok = actual == expected
    results.append((label, ok, f"expected={expected!r} actual={actual!r}"))
    if not ok:
        print(f"❌ {label} :: expected={expected!r} actual={actual!r}")
    else:
        print(f"✅ {label}")
    return ok


def assert_true(label: str, cond: bool, detail: str = "") -> bool:
    results.append((label, bool(cond), detail))
    if not cond:
        print(f"❌ {label} :: {detail}")
    else:
        print(f"✅ {label} {('· ' + detail) if detail else ''}")
    return bool(cond)


def reg_user(name: str) -> tuple[str, str, str]:
    """Returns (token, user_id, email)."""
    email = f"{name.lower().replace(' ', '.')}+{uuid.uuid4().hex[:6]}@gmail.com"
    r = requests.post(f"{API_BASE}/auth/register", json={
        "full_name": name, "email": email, "password": "Maple#Pass!2026"
    }, timeout=20)
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    j = r.json()
    return j["token"], j["user"]["id"], email


def admin_token() -> str:
    r = requests.post(f"{API_BASE}/auth/login", json={
        "email": ADMIN_EMAIL, "password": ADMIN_PASS
    }, timeout=20)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


def auth_headers(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def main():
    print("\n=== STRIPE CHECKOUT INTEGRATION TEST ===\n")

    # --- STEP 1: admin sets sleep price = 9.99 USD ---
    atok = admin_token()
    r = requests.post(
        f"{API_BASE}/library/pricing/sleep",
        headers=auth_headers(atok),
        json={"price": 9.99, "currency": "USD", "purchase_url": ""},
        timeout=20,
    )
    assert_eq("S1 admin set sleep price 9.99 USD", r.status_code, 200)
    if r.status_code == 200:
        assert_eq("S1 returned price=9.99", r.json()["pricing"]["price"], 9.99)
        assert_eq("S1 returned is_free=false", r.json()["pricing"]["is_free"], False)

    # --- STEP 2: register user A and create checkout for sleep ---
    a_tok, a_uid, a_email = reg_user("Maya Patel")
    r = requests.post(
        f"{API_BASE}/payments/create-checkout",
        headers=auth_headers(a_tok),
        json={"app_id": "sleep"},
        timeout=30,
    )
    print(f"Step 2 status={r.status_code} body={r.text[:400]}")
    s2_ok = r.status_code == 200
    if not s2_ok:
        results.append(("S2 create-checkout 200", False,
                        f"got {r.status_code}: {r.text[:300]}"))
    else:
        body = r.json()
        results.append(("S2 create-checkout 200", True, ""))
        print(f"   session_id={body.get('session_id')}")
        print(f"   checkout_url={body.get('checkout_url')[:80]}...")
        sid = body.get("session_id", "")
        url = body.get("checkout_url", "")
        assert_true("S2 session_id starts cs_test_",
                    sid.startswith("cs_test_"), sid[:20])
        assert_true("S2 checkout_url starts https://checkout.stripe.com/",
                    url.startswith("https://checkout.stripe.com/"), url[:60])
        assert_eq("S2 amount=999", body.get("amount"), 999)
        assert_eq("S2 currency=USD", body.get("currency"), "USD")
        assert_eq("S2 effective_price=9.99", body.get("effective_price"), 9.99)
        assert_eq("S2 app_id=sleep", body.get("app_id"), "sleep")

    # --- STEP 3: invalid app_id ---
    r = requests.post(
        f"{API_BASE}/payments/create-checkout",
        headers=auth_headers(a_tok),
        json={"app_id": "foo"},
        timeout=20,
    )
    assert_eq("S3 invalid app_id → 400", r.status_code, 400)
    if r.status_code == 400:
        assert_true("S3 detail contains Invalid app_id",
                    "Invalid app_id" in r.json().get("detail", ""), r.json().get("detail", ""))

    # --- STEP 4: set sleep free, attempt checkout ---
    r = requests.post(
        f"{API_BASE}/library/pricing/sleep",
        headers=auth_headers(atok),
        json={"price": 0, "currency": "USD"},
        timeout=20,
    )
    assert_eq("S4 admin set sleep price=0", r.status_code, 200)

    r = requests.post(
        f"{API_BASE}/payments/create-checkout",
        headers=auth_headers(a_tok),
        json={"app_id": "sleep"},
        timeout=20,
    )
    assert_eq("S4 free app → 400", r.status_code, 400)
    if r.status_code == 400:
        assert_true("S4 detail mentions 'free'",
                    "free" in r.json().get("detail", "").lower(),
                    r.json().get("detail", ""))

    # --- STEP 5: restore price 9.99, mark A as already-owning, then try checkout ---
    r = requests.post(
        f"{API_BASE}/library/pricing/sleep",
        headers=auth_headers(atok),
        json={"price": 9.99, "currency": "USD"},
        timeout=20,
    )
    assert_eq("S5 restore sleep price 9.99", r.status_code, 200)

    r = requests.post(
        f"{API_BASE}/library/purchase/sleep",
        headers=auth_headers(a_tok),
        timeout=20,
    )
    assert_eq("S5 A purchase via legacy fallback → 200", r.status_code, 200)
    if r.status_code == 200:
        body = r.json()
        assert_eq("S5 saved=true", body.get("saved"), True)

    r = requests.post(
        f"{API_BASE}/payments/create-checkout",
        headers=auth_headers(a_tok),
        json={"app_id": "sleep"},
        timeout=20,
    )
    assert_eq("S5 already-owns → 409", r.status_code, 409)
    if r.status_code == 409:
        assert_true("S5 detail mentions 'already own'",
                    "already own" in r.json().get("detail", "").lower(),
                    r.json().get("detail", ""))

    # --- STEP 6: webhook idempotency for fresh user B ---
    b_tok, b_uid, b_email = reg_user("Ryan Chen")
    print(f"\nUser B id={b_uid}")

    # Confirm B doesn't own sleep yet
    r = requests.get(f"{API_BASE}/library/pricing", headers=auth_headers(b_tok), timeout=20)
    assert_eq("S6 GET /library/pricing as B 200", r.status_code, 200)
    if r.status_code == 200:
        assert_eq("S6 B sleep.purchased=false (initial)",
                  r.json()["pricing"]["sleep"]["purchased"], False)

    payload = {
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_test_dummy_b",
                "payment_status": "paid",
                "status": "complete",
                "amount_total": 999,
                "currency": "usd",
                "payment_intent": "pi_test_dummy_b",
                "metadata": {"user_id": b_uid, "app_id": "sleep"},
            }
        },
    }
    r = requests.post(
        f"{API_BASE}/payments/webhook",
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload),
        timeout=20,
    )
    assert_eq("S6 webhook (no-sig) → 200", r.status_code, 200)
    if r.status_code == 200:
        body = r.json()
        assert_eq("S6 webhook received=true", body.get("received"), True)
        assert_eq("S6 webhook type", body.get("type"), "checkout.session.completed")

    # B should now own sleep
    r = requests.get(f"{API_BASE}/library/pricing", headers=auth_headers(b_tok), timeout=20)
    if r.status_code == 200:
        assert_eq("S6 B sleep.purchased=true after webhook",
                  r.json()["pricing"]["sleep"]["purchased"], True)

    # Re-POST same webhook payload — must be idempotent
    r = requests.post(
        f"{API_BASE}/payments/webhook",
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload),
        timeout=20,
    )
    assert_eq("S6 re-webhook → 200", r.status_code, 200)

    # Verify no duplicate row in library_purchases via direct DB count
    try:
        from motor.motor_asyncio import AsyncIOMotorClient
        mongo_url = "mongodb://localhost:27017"
        client = AsyncIOMotorClient(mongo_url)
        db = client["test_database"]

        async def _count():
            return await db.library_purchases.count_documents(
                {"user_id": b_uid, "app_id": "sleep"})
        n = asyncio.get_event_loop().run_until_complete(_count())
        assert_eq("S6 single library_purchases row (idempotent)", n, 1)
        client.close()
    except Exception as e:
        results.append(("S6 db idempotency check", False, f"DB read failed: {e}"))
        print(f"⚠️  DB read failed: {e}")

    # --- STEP 7: Discount math ---
    r = requests.post(
        f"{API_BASE}/library/pricing/sleep/discount",
        headers=auth_headers(atok),
        json={"percent": 50, "duration_value": 3, "duration_unit": "days"},
        timeout=20,
    )
    assert_eq("S7 admin discount 50% 3d → 200", r.status_code, 200)

    c_tok, c_uid, _ = reg_user("Aiden Brooks")
    r = requests.post(
        f"{API_BASE}/payments/create-checkout",
        headers=auth_headers(c_tok),
        json={"app_id": "sleep"},
        timeout=30,
    )
    print(f"S7 create-checkout (discounted) status={r.status_code} body={r.text[:300]}")
    if r.status_code == 200:
        body = r.json()
        amt = body.get("amount")
        eff = body.get("effective_price")
        assert_true("S7 amount in 499..500", amt in (499, 500), f"got {amt}")
        assert_true("S7 effective_price 4.99..5.00",
                    isinstance(eff, (int, float)) and 4.99 <= eff <= 5.00,
                    f"got {eff}")
    else:
        results.append(("S7 create-checkout 200", False, f"{r.status_code}: {r.text[:200]}"))

    # Clear discount to leave price restored to 9.99 plain
    requests.post(
        f"{API_BASE}/library/pricing/sleep/discount",
        headers=auth_headers(atok),
        json={"percent": 0, "duration_value": 1, "duration_unit": "days"},
        timeout=20,
    )

    # --- STEP 8: GET /payments/return success ---
    r = requests.get(
        f"{API_BASE}/payments/return",
        params={"status": "success", "session_id": "cs_test_xyz"},
        timeout=20,
    )
    assert_eq("S8 return success → 200", r.status_code, 200)
    if r.status_code == 200:
        ct = r.headers.get("content-type", "")
        assert_true("S8 content-type text/html", "text/html" in ct, ct)
        body = r.text
        assert_true("S8 body has xpconfidence://payments/return",
                    "xpconfidence://payments/return" in body, "")
        assert_true("S8 body has session_id cs_test_xyz",
                    "cs_test_xyz" in body, "")
        assert_true("S8 body has 'received' or 'Payment received'",
                    "received" in body.lower() or "Payment received" in body, "")

    # --- STEP 9: GET /payments/return cancel ---
    r = requests.get(
        f"{API_BASE}/payments/return",
        params={"status": "cancel", "session_id": "cs_test_xyz"},
        timeout=20,
    )
    assert_eq("S9 return cancel → 200", r.status_code, 200)
    if r.status_code == 200:
        body = r.text
        assert_true("S9 body has 'cancelled'",
                    "cancelled" in body.lower(), "")

    # --- STEP 10: verify nonexistent session ---
    r = requests.get(
        f"{API_BASE}/payments/session/cs_test_does_not_exist_xyz/verify",
        headers=auth_headers(c_tok),
        timeout=20,
    )
    assert_eq("S10 verify nonexistent → 404", r.status_code, 404)
    if r.status_code == 404:
        assert_true("S10 detail mentions Session not found",
                    "Session not found" in r.json().get("detail", ""),
                    r.json().get("detail", ""))

    # --- STEP 11: Regression ---
    r = requests.get(f"{API_BASE}/library/pricing", headers=auth_headers(c_tok), timeout=20)
    assert_eq("S11 /library/pricing → 200", r.status_code, 200)
    r = requests.get(f"{API_BASE}/library/ratings", headers=auth_headers(c_tok), timeout=20)
    assert_eq("S11 /library/ratings → 200", r.status_code, 200)
    r = requests.get(f"{API_BASE}/admin/reports", headers=auth_headers(atok), timeout=20)
    assert_eq("S11 /admin/reports admin → 200", r.status_code, 200)

    # --- SUMMARY ---
    print("\n=== SUMMARY ===")
    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print(f"PASSED: {passed}/{len(results)}")
    if failed:
        print("\n❌ FAILED:")
        for label, ok, detail in results:
            if not ok:
                print(f"  - {label} :: {detail}")
    return failed == 0


if __name__ == "__main__":
    ok = main()
    raise SystemExit(0 if ok else 1)
