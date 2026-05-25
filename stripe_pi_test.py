#!/usr/bin/env python3
"""Test plan for Stripe PaymentIntent endpoint (POST /api/payments/create-payment-intent)
+ payment_intent.succeeded webhook signature enforcement.
Runs against the live ingress.
"""
import json
import os
import random
import string
import sys
import time
import requests

BASE = os.environ.get("API_BASE", "https://xp-confidence.preview.emergentagent.com/api")
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

results = []


def log(name, ok, detail=""):
    mark = "✅" if ok else "❌"
    print(f"{mark} {name}: {detail}")
    results.append((ok, name, detail))


def rand_email(label="user"):
    rid = ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
    return f"{label}.pi+{rid}@gmail.com"


def post(path, json_body=None, token=None, headers=None):
    h = headers or {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return requests.post(f"{BASE}{path}", json=json_body, headers=h, timeout=30)


def get(path, token=None, headers=None):
    h = headers or {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return requests.get(f"{BASE}{path}", headers=h, timeout=30)


def admin_login():
    r = post("/auth/login", {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code != 200:
        print(f"Admin login failed: {r.status_code} {r.text}")
        sys.exit(1)
    body = r.json()
    return body.get("token") or body.get("access_token")


def register_user(label):
    email = rand_email(label)
    pw = "TestPass123!"
    full = label.title()
    r = post("/auth/register", {"email": email, "password": pw, "full_name": full})
    if r.status_code != 200:
        print(f"register failed: {r.status_code} {r.text}")
        sys.exit(1)
    body = r.json()
    return {
        "email": email,
        "password": pw,
        "token": body.get("token") or body.get("access_token"),
        "user_id": (body.get("user") or {}).get("id") or body.get("user_id") or body.get("id"),
    }


def main():
    print(f"=== Testing against {BASE} ===\n")

    # ---------- S1: Admin login + set sleep price 9.99 USD ----------
    admin_tok = admin_login()
    log("S1.admin_login", bool(admin_tok), "token acquired")

    r = post("/library/pricing/sleep",
             {"price": 9.99, "currency": "USD", "purchase_url": ""},
             token=admin_tok)
    log("S1.set_sleep_9.99",
        r.status_code == 200 and r.json().get("pricing", {}).get("price") == 9.99,
        f"status={r.status_code}, body={r.text[:200]}")

    # ---------- S2: Fresh user A → /payments/create-payment-intent ----------
    user_a = register_user("maya")
    log("S2.register_A", bool(user_a["token"]), f"user_id={user_a['user_id']}")

    r = post("/payments/create-payment-intent",
             {"app_id": "sleep"}, token=user_a["token"])
    ok = r.status_code == 200
    log("S2.create_payment_intent_sleep",
        ok, f"status={r.status_code} body={r.text[:300]}")
    body_a1 = r.json() if ok else {}

    if ok:
        cs = body_a1.get("payment_intent_client_secret", "")
        log("S2.client_secret_starts_pi_",
            cs.startswith("pi_"),
            f"client_secret={cs[:25]}...")
        log("S2.client_secret_contains_secret",
            "_secret_" in cs, f"contains '_secret_'={'_secret_' in cs}")

        ek = body_a1.get("ephemeral_key_secret", "")
        log("S2.ephemeral_key_starts_ek_test_",
            ek.startswith("ek_test_"), f"ek={ek[:20]}...")

        cu = body_a1.get("customer_id", "")
        log("S2.customer_id_starts_cus_",
            cu.startswith("cus_"), f"customer_id={cu}")

        pk = body_a1.get("publishable_key", "")
        log("S2.publishable_key_starts_pk_test_",
            pk.startswith("pk_test_"), f"pk={pk[:25]}...")

        log("S2.amount_999",
            body_a1.get("amount") == 999, f"amount={body_a1.get('amount')}")
        log("S2.currency_USD",
            body_a1.get("currency") == "USD", f"currency={body_a1.get('currency')}")
        log("S2.effective_price_9.99",
            abs(body_a1.get("effective_price", 0) - 9.99) < 0.01,
            f"effective_price={body_a1.get('effective_price')}")

        pi_id = body_a1.get("payment_intent_id", "")
        log("S2.payment_intent_id_starts_pi_",
            pi_id.startswith("pi_"), f"payment_intent_id={pi_id[:25]}...")

    # ---------- S3: re-call → same customer_id, new payment_intent_id ----------
    r = post("/payments/create-payment-intent",
             {"app_id": "sleep"}, token=user_a["token"])
    ok2 = r.status_code == 200
    log("S3.recall_200", ok2,
        f"status={r.status_code} body={r.text[:200]}")
    if ok2 and body_a1:
        body_a2 = r.json()
        log("S3.same_customer_id",
            body_a2.get("customer_id") == body_a1.get("customer_id"),
            f"a1.cus={body_a1.get('customer_id')} a2.cus={body_a2.get('customer_id')}")
        log("S3.new_payment_intent_id",
            body_a2.get("payment_intent_id") and
            body_a2.get("payment_intent_id") != body_a1.get("payment_intent_id"),
            f"a1.pi={body_a1.get('payment_intent_id')[:18]}... a2.pi={body_a2.get('payment_intent_id', '')[:18]}...")

    # ---------- S4: invalid app_id → 400 ----------
    r = post("/payments/create-payment-intent",
             {"app_id": "foo"}, token=user_a["token"])
    log("S4.invalid_app_id_400",
        r.status_code == 400 and "Invalid app_id" in r.text,
        f"status={r.status_code} body={r.text[:200]}")

    # ---------- S5: free app → 400 'This app is free' ----------
    r = post("/library/pricing/sleep",
             {"price": 0, "currency": "USD"}, token=admin_tok)
    log("S5.set_sleep_free_pre",
        r.status_code == 200, f"status={r.status_code}")

    r = post("/payments/create-payment-intent",
             {"app_id": "sleep"}, token=user_a["token"])
    log("S5.free_app_400",
        r.status_code == 400 and "free" in r.text.lower(),
        f"status={r.status_code} body={r.text[:200]}")

    # ---------- S6: restore 9.99, mark already-owned, → 409 ----------
    r = post("/library/pricing/sleep",
             {"price": 9.99, "currency": "USD"}, token=admin_tok)
    log("S6.restore_9.99",
        r.status_code == 200 and r.json().get("pricing", {}).get("price") == 9.99,
        f"status={r.status_code}")

    r = post("/library/purchase/sleep", {}, token=user_a["token"])
    log("S6.mark_owned",
        r.status_code == 200,
        f"status={r.status_code} body={r.text[:200]}")

    r = post("/payments/create-payment-intent",
             {"app_id": "sleep"}, token=user_a["token"])
    log("S6.already_own_409",
        r.status_code == 409 and "already own" in r.text.lower(),
        f"status={r.status_code} body={r.text[:200]}")

    # ---------- S7: webhook signature now enforced → 401 ----------
    fake_body = {
        "type": "payment_intent.succeeded",
        "data": {
            "object": {
                "id": "pi_test_dummy_unsigned",
                "amount_received": 999,
                "amount": 999,
                "currency": "usd",
                "metadata": {"user_id": "fake-user", "app_id": "sleep"},
            }
        }
    }
    r = requests.post(f"{BASE}/payments/webhook",
                      json=fake_body,
                      timeout=30)
    log("S7.webhook_no_sig_401",
        r.status_code == 401,
        f"status={r.status_code} body={r.text[:200]}")

    # also try with a bogus signature header
    r2 = requests.post(f"{BASE}/payments/webhook",
                       json=fake_body,
                       headers={"stripe-signature": "t=123,v1=bogus"},
                       timeout=30)
    log("S7.webhook_bogus_sig_401",
        r2.status_code == 401,
        f"status={r2.status_code} body={r2.text[:200]}")

    # ---------- S8: Discount math: 50% off 9.99 → amount=500 ----------
    r = post("/library/pricing/sleep/discount",
             {"percent": 50, "duration_value": 3, "duration_unit": "days"},
             token=admin_tok)
    log("S8.set_50pct_discount",
        r.status_code == 200 and r.json().get("pricing", {}).get("discount_active"),
        f"status={r.status_code} body={r.text[:200]}")

    user_c = register_user("aiden")
    log("S8.register_C", bool(user_c["token"]), f"user_id={user_c['user_id']}")

    r = post("/payments/create-payment-intent",
             {"app_id": "sleep"}, token=user_c["token"])
    ok8 = r.status_code == 200
    log("S8.create_pi_with_discount_200",
        ok8, f"status={r.status_code} body={r.text[:300]}")
    if ok8:
        bd = r.json()
        log("S8.amount_500",
            bd.get("amount") == 500, f"amount={bd.get('amount')}")
        log("S8.effective_price_5.0_or_4.995",
            abs(bd.get("effective_price", 0) - 5.0) <= 0.01 or
            abs(bd.get("effective_price", 0) - 4.995) <= 0.01,
            f"effective_price={bd.get('effective_price')}")

    # ---------- Cleanup discount ----------
    r = post("/library/pricing/sleep/discount",
             {"percent": 0, "duration_value": 1, "duration_unit": "days"},
             token=admin_tok)
    log("S8.clear_discount",
        r.status_code == 200, f"status={r.status_code}")

    # ---------- S9: Regression ----------
    # /payments/create-checkout still works (using fresh user D since A owns)
    user_d = register_user("ryan")
    r = post("/payments/create-checkout",
             {"app_id": "sleep"}, token=user_d["token"])
    log("S9.create_checkout_200",
        r.status_code == 200 and r.json().get("session_id", "").startswith("cs_test_"),
        f"status={r.status_code} body={r.text[:300]}")

    # /library/pricing GET
    r = get("/library/pricing", token=user_d["token"])
    log("S9.library_pricing_GET",
        r.status_code == 200 and isinstance(r.json().get("pricing"), dict),
        f"status={r.status_code}")

    # /library/pricing POST (admin)
    r = post("/library/pricing/sleep",
             {"price": 9.99, "currency": "USD"}, token=admin_tok)
    log("S9.library_pricing_POST_admin",
        r.status_code == 200, f"status={r.status_code}")

    # /library/ratings GET + POST
    r = get("/library/ratings", token=user_d["token"])
    log("S9.library_ratings_GET",
        r.status_code == 200 and isinstance(r.json().get("ratings"), dict),
        f"status={r.status_code}")

    r = post("/library/ratings",
             {"app_id": "sleep", "stars": 5}, token=user_d["token"])
    log("S9.library_ratings_POST",
        r.status_code == 200, f"status={r.status_code}")

    # /admin/reports
    r = get("/admin/reports", token=admin_tok)
    log("S9.admin_reports",
        r.status_code == 200 and "reports" in r.json(),
        f"status={r.status_code}")

    # ---------- Summary ----------
    n_pass = sum(1 for ok, _, _ in results if ok)
    n_total = len(results)
    print(f"\n=== {n_pass}/{n_total} passed ===")
    if n_pass < n_total:
        print("\nFAILURES:")
        for ok, name, detail in results:
            if not ok:
                print(f"  ❌ {name}: {detail}")
    return 0 if n_pass == n_total else 1


if __name__ == "__main__":
    sys.exit(main())
