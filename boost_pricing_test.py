"""Backend test for Boost Pricing endpoints + payment-intent kind='boost'.

Coverage matches the 17-step review request (step 18 webhook signature is skipped).
Run with: python /app/boost_pricing_test.py
"""

import os
import uuid
import time
import json
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASS = 0
FAIL = 0
FAILED_DETAILS = []


def _check(cond: bool, label: str, extra: str = ""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {label}")
    else:
        FAIL += 1
        msg = f"  ✗ {label}" + (f"  --  {extra}" if extra else "")
        FAILED_DETAILS.append(msg)
        print(msg)


def _h(token=None, anon=None, extra=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    if anon:
        h["X-Anonymous-Id"] = anon
    if extra:
        h.update(extra)
    return h


def _req(method, path, token=None, anon=None, body=None, expect=None):
    url = BASE + path
    try:
        r = requests.request(method, url, headers=_h(token, anon),
                             data=json.dumps(body) if body is not None else None,
                             timeout=30)
    except Exception as e:
        return 0, {"_err": str(e)}
    try:
        data = r.json() if r.text else {}
    except Exception:
        data = {"_text": r.text}
    return r.status_code, data


def section(title):
    print(f"\n=== {title} ===")


def register_user(label):
    email = f"boost_{label}_{uuid.uuid4().hex[:8]}@gmail.com"
    pwd = "TestPass123!"
    body = {
        "email": email,
        "password": pwd,
        "full_name": f"Test {label.title()}",
        "username": f"u{uuid.uuid4().hex[:8]}",
    }
    sc, d = _req("POST", "/auth/register", body=body)
    if sc != 200:
        # Try alternative shape
        sc, d = _req("POST", "/auth/register", body={"email": email, "password": pwd, "name": f"Test {label.title()}"})
    if sc != 200:
        print(f"register failed for {label}: {sc} {d}")
        return None, None, None
    token = d.get("token") or d.get("access_token")
    user = d.get("user") or {}
    uid = user.get("id") or user.get("user_id") or d.get("user_id")
    return token, uid, email


def admin_login():
    sc, d = _req("POST", "/auth/login", body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if sc != 200:
        print(f"admin login failed {sc} {d}")
        return None, None
    token = d.get("token") or d.get("access_token")
    user = d.get("user") or {}
    uid = user.get("id") or user.get("user_id")
    return token, uid


def main():
    section("Step 0: setup")
    admin_token, admin_id = admin_login()
    _check(bool(admin_token), "admin login")
    if not admin_token:
        return

    # Reset triple_day to known free state first (price=0 clears).
    sc, d = _req("POST", "/boosts/pricing/triple_day", token=admin_token,
                 body={"price": 0, "currency": "USD"})
    _check(sc == 200, "reset triple_day to price=0", f"sc={sc} d={d}")
    # Clear any discount on triple_day
    sc, d = _req("POST", "/boosts/pricing/triple_day/discount", token=admin_token, body={"percent": 0})
    _check(sc == 200, "reset triple_day discount cleared", f"sc={sc} d={d}")

    section("Step 1: Anonymous GET /boosts/pricing")
    anon_id = "anon-" + uuid.uuid4().hex
    sc, d = _req("GET", "/boosts/pricing", anon=anon_id)
    _check(sc == 200, "GET /boosts/pricing anon 200", f"sc={sc}")
    pricing = d.get("pricing") or {}
    _check(set(pricing.keys()) == {"triple_day", "double_week", "double_month"},
           "pricing has 3 boost ids", f"keys={list(pricing.keys())}")
    for bid in ["triple_day", "double_week", "double_month"]:
        e = pricing.get(bid, {})
        _check(e.get("is_free") is True, f"{bid}.is_free=true", f"got {e.get('is_free')}")
        _check(e.get("purchased") is False, f"{bid}.purchased=false", f"got {e.get('purchased')}")
    currencies = d.get("currencies") or []
    _check(len(currencies) >= 10, "currencies >= 10 entries", f"len={len(currencies)}")

    section("Step 2: Non-admin POST /boosts/pricing/triple_day → 403")
    user_token, user_id, _ = register_user("noadmin")
    _check(bool(user_token), "register non-admin user")
    sc, d = _req("POST", "/boosts/pricing/triple_day", token=user_token,
                 body={"price": 2.99, "currency": "USD"})
    _check(sc == 403, "non-admin set pricing → 403", f"sc={sc} d={d}")
    detail = d.get("detail") if isinstance(d.get("detail"), str) else str(d.get("detail"))
    _check("Creator only" in detail, "detail says 'Creator only.'", f"detail={detail}")

    section("Step 3: Admin sets triple_day price=2.99 USD → 200")
    sc, d = _req("POST", "/boosts/pricing/triple_day", token=admin_token,
                 body={"price": 2.99, "currency": "USD"})
    _check(sc == 200, "admin set 2.99 USD 200", f"sc={sc} d={d}")
    pub = (d or {}).get("pricing") or {}
    _check(abs(float(pub.get("price") or 0) - 2.99) < 0.001, "pricing.price=2.99", f"got {pub.get('price')}")
    _check(pub.get("is_free") is False, "is_free=false", f"got {pub.get('is_free')}")
    _check(pub.get("currency") == "USD", "currency=USD", f"got {pub.get('currency')}")

    section("Step 4: invalid boost_id 'foo' → 400")
    sc, d = _req("POST", "/boosts/pricing/foo", token=admin_token, body={"price": 1})
    _check(sc == 400, "invalid boost_id 400", f"sc={sc} d={d}")

    section("Step 5: invalid currency XYZ → 400")
    sc, d = _req("POST", "/boosts/pricing/triple_day", token=admin_token,
                 body={"price": 5, "currency": "XYZ"})
    _check(sc == 400, "invalid currency 400", f"sc={sc} d={d}")

    section("Step 6: negative price → 400")
    sc, d = _req("POST", "/boosts/pricing/triple_day", token=admin_token,
                 body={"price": -1})
    _check(sc == 400, "negative price 400", f"sc={sc} d={d}")

    section("Step 7: discount 50% / 7 days → effective_price ≈ 1.495")
    sc, d = _req("POST", "/boosts/pricing/triple_day/discount", token=admin_token,
                 body={"percent": 50, "duration_value": 7, "duration_unit": "days"})
    _check(sc == 200, "discount 200", f"sc={sc} d={d}")
    p = (d or {}).get("pricing") or {}
    _check(p.get("discount_active") is True, "discount_active=true", f"got {p.get('discount_active')}")
    _check(p.get("discount_percent") == 50, "discount_percent=50", f"got {p.get('discount_percent')}")
    eff = float(p.get("effective_price") or 0)
    _check(abs(eff - 1.495) <= 0.01, f"effective_price≈1.495 (got {eff})", f"got {eff}")

    section("Step 8: percent=0 clears")
    sc, d = _req("POST", "/boosts/pricing/triple_day/discount", token=admin_token,
                 body={"percent": 0})
    _check(sc == 200, "clear discount 200", f"sc={sc}")
    p = (d or {}).get("pricing") or {}
    _check(p.get("discount_active") is False, "discount_active=false", f"got {p.get('discount_active')}")
    _check(abs(float(p.get("effective_price") or 0) - 2.99) < 0.01, "effective_price≈2.99", f"got {p.get('effective_price')}")

    section("Step 9: percent=120 → 400")
    sc, d = _req("POST", "/boosts/pricing/triple_day/discount", token=admin_token,
                 body={"percent": 120})
    _check(sc == 400, "percent=120 400", f"sc={sc} d={d}")

    section("Step 10: non-admin discount → 403")
    sc, d = _req("POST", "/boosts/pricing/triple_day/discount", token=user_token,
                 body={"percent": 10, "duration_value": 1, "duration_unit": "days"})
    _check(sc == 403, "non-admin discount 403", f"sc={sc} d={d}")

    section("Step 11: payment-intent kind=boost (fresh user A)")
    a_token, a_uid, _ = register_user("A")
    _check(bool(a_token), "register user A")
    sc, d = _req("POST", "/payments/create-payment-intent", token=a_token,
                 body={"kind": "boost", "app_id": "triple_day"})
    _check(sc == 200, "PI 200", f"sc={sc} d={d}")
    _check(d.get("kind") == "boost", "resp.kind=boost", f"got {d.get('kind')}")
    _check(d.get("app_id") == "triple_day", "resp.app_id=triple_day", f"got {d.get('app_id')}")
    _check(d.get("amount") == 299, "amount=299", f"got {d.get('amount')}")
    _check((d.get("currency") or "").upper() == "USD", "currency=USD", f"got {d.get('currency')}")
    cs = d.get("payment_intent_client_secret") or ""
    _check(cs.startswith("pi_test_") or cs.startswith("pi_"), "client secret starts with pi_", f"got prefix {cs[:12]}")
    cust = d.get("customer_id") or ""
    _check(cust.startswith("cus_"), "customer_id starts cus_", f"got {cust}")
    pk = d.get("publishable_key") or ""
    _check(pk.startswith("pk_test_") or pk.startswith("pk_"), "publishable_key starts pk_", f"got prefix {pk[:12]}")

    section("Step 12: payment-intent kind=boost invalid app_id → 400")
    sc, d = _req("POST", "/payments/create-payment-intent", token=a_token,
                 body={"kind": "boost", "app_id": "foo"})
    _check(sc == 400, "invalid boost id 400", f"sc={sc} d={d}")

    section("Step 13: free triple_day → PI 400 'This item is free'")
    sc, _d = _req("POST", "/boosts/pricing/triple_day", token=admin_token,
                  body={"price": 0, "currency": "USD"})
    _check(sc == 200, "set triple_day free", f"sc={sc}")
    sc, d = _req("POST", "/payments/create-payment-intent", token=a_token,
                 body={"kind": "boost", "app_id": "triple_day"})
    _check(sc == 400, "PI free 400", f"sc={sc} d={d}")
    detail = d.get("detail") if isinstance(d.get("detail"), str) else str(d.get("detail"))
    _check("free" in (detail or "").lower(), "detail says free", f"detail={detail}")

    section("Step 14: restore 2.99 + user C purchase triple_day → saved=true")
    sc, _d = _req("POST", "/boosts/pricing/triple_day", token=admin_token,
                  body={"price": 2.99, "currency": "USD"})
    _check(sc == 200, "restore 2.99", f"sc={sc}")
    c_token, c_uid, _ = register_user("C")
    _check(bool(c_token), "register user C")
    sc, d = _req("POST", "/boosts/purchase", token=c_token, body={"boost_id": "triple_day"})
    _check(sc == 200, "purchase triple_day 200", f"sc={sc} d={d}")
    _check(d.get("saved") is True, "saved=true", f"got {d.get('saved')}")
    _check(d.get("is_free") is False, "is_free=false", f"got {d.get('is_free')}")
    sc, prof = _req("GET", "/profile", token=c_token)
    _check(sc == 200, "GET /profile C", f"sc={sc}")
    inv = prof.get("boost_inventory") or []
    triple_entries = [e for e in inv if e.get("type") == "triple_day"]
    _check(len(triple_entries) >= 1, "boost_inventory has triple_day", f"inventory={inv}")

    section("Step 15: same user C purchases double_week (free) → saved=false is_free=true")
    sc, d = _req("POST", "/boosts/purchase", token=c_token, body={"boost_id": "double_week"})
    _check(sc == 200, "free purchase 200", f"sc={sc} d={d}")
    _check(d.get("saved") is False, "saved=false", f"got {d.get('saved')}")
    _check(d.get("is_free") is True, "is_free=true", f"got {d.get('is_free')}")
    sc, prof = _req("GET", "/profile", token=c_token)
    _check(sc == 200, "GET /profile C again", f"sc={sc}")
    inv = prof.get("boost_inventory") or []
    dw_entries = [e for e in inv if e.get("type") == "double_week"]
    _check(len(dw_entries) == 0, "no double_week added", f"got {dw_entries}")

    section("Step 16: invalid boost_id → 400")
    sc, d = _req("POST", "/boosts/purchase", token=c_token, body={"boost_id": "foo"})
    _check(sc == 400, "purchase invalid 400", f"sc={sc} d={d}")

    section("Step 17: regression sanity")
    sc, _ = _req("GET", "/library/pricing", token=a_token)
    _check(sc == 200, "/library/pricing 200", f"sc={sc}")
    sc, _ = _req("GET", "/library/ratings", token=a_token)
    _check(sc == 200, "/library/ratings 200", f"sc={sc}")
    sc, _ = _req("GET", "/admin/reports", token=admin_token)
    _check(sc == 200, "/admin/reports 200", f"sc={sc}")
    # /payments/create-checkout (library mode)
    # Sleep app might not be priced; pick one that has a price.
    # First make sure sleep has a price for this regression test.
    sc, d = _req("POST", "/library/pricing/sleep", token=admin_token,
                 body={"price": 9.99, "currency": "USD", "purchase_url": "https://ko-fi.com/example"})
    _check(sc == 200, "set library sleep price for regression", f"sc={sc} d={d}")
    # create-checkout requires a fresh user who doesn't own it
    reg_token, _, _ = register_user("reg")
    sc, d = _req("POST", "/payments/create-checkout", token=reg_token,
                 body={"app_id": "sleep"})
    _check(sc == 200, "/payments/create-checkout (library) 200", f"sc={sc} d={d}")
    sc, d = _req("POST", "/payments/create-payment-intent", token=reg_token,
                 body={"app_id": "sleep"})  # default kind=library
    _check(sc == 200, "PI default kind=library 200", f"sc={sc} d={d}")

    print("\n" + "=" * 60)
    print(f"PASSED: {PASS}")
    print(f"FAILED: {FAIL}")
    if FAILED_DETAILS:
        print("\nFailed assertions:")
        for line in FAILED_DETAILS:
            print(line)
    print("=" * 60)


if __name__ == "__main__":
    main()
