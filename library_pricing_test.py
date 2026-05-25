"""
Tests for Library+ Mini-App Pricing & Purchases endpoints.
Run against live ingress.
"""
import os, uuid, time, random, string, json, sys
import httpx

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASS = 0
FAIL = 0
FAIL_LINES = []


def _ok(name):
    global PASS
    PASS += 1
    print(f"  PASS: {name}")


def _bad(name, info=""):
    global FAIL
    FAIL += 1
    msg = f"  FAIL: {name} | {info}"
    FAIL_LINES.append(msg)
    print(msg)


def assert_eq(actual, expected, name):
    if actual == expected:
        _ok(name)
    else:
        _bad(name, f"expected={expected!r} actual={actual!r}")


def assert_close(actual, expected, tol, name):
    try:
        if abs(float(actual) - float(expected)) <= tol:
            _ok(name)
            return
    except Exception:
        pass
    _bad(name, f"expected ≈ {expected} ±{tol}, got {actual}")


def assert_status(resp, expected, name):
    if resp.status_code == expected:
        _ok(f"{name} [{resp.status_code}]")
    else:
        body = ""
        try:
            body = resp.text[:200]
        except Exception:
            pass
        _bad(name, f"status expected={expected} got={resp.status_code} body={body}")


def random_email():
    return f"libpricing_{uuid.uuid4().hex[:10]}@gmail.com"


def admin_token(client):
    r = client.post(f"{BASE}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"admin login failed {r.status_code} {r.text[:200]}"
    return r.json()["token"]


def register_user(client, name="Maya Patel"):
    email = random_email()
    pw = "SecretPass!" + uuid.uuid4().hex[:6]
    r = client.post(f"{BASE}/auth/register", json={
        "full_name": name, "email": email, "password": pw,
    })
    assert r.status_code == 200, f"register failed {r.status_code} {r.text[:200]}"
    body = r.json()
    return body["token"], (body.get("user") or {}).get("id"), email, pw


def main():
    with httpx.Client(timeout=30.0) as client:
        admin_tok = admin_token(client)
        admin_h = {"Authorization": f"Bearer {admin_tok}"}

        # ============== STEP 1: Anonymous GET /library/pricing ==============
        anon_id_1 = "anon-libpricing-" + uuid.uuid4().hex[:12]
        anon_h = {"X-Anonymous-Id": anon_id_1}

        # First, clear any existing pricing for sleep so we can test the "no doc yet" case for at least some apps.
        # Reset to free first to control state below — but we need a baseline read first.
        # The spec says: "for an app with no doc yet" → defaults. Some apps may already have docs.
        # We'll test the shape and verify it for at least one app where backend has no doc OR price=0.
        r = client.get(f"{BASE}/library/pricing", headers=anon_h)
        assert_status(r, 200, "S1 GET /library/pricing anonymous")
        body = r.json()
        if "pricing" not in body or "currencies" not in body:
            _bad("S1 response shape", f"missing keys: {list(body.keys())}")
        else:
            _ok("S1 response shape has pricing+currencies")

        currencies = body.get("currencies", [])
        if isinstance(currencies, list) and len(currencies) >= 10:
            _ok(f"S1 currencies length>=10 (={len(currencies)})")
        else:
            _bad("S1 currencies length>=10", f"got {currencies}")

        pricing = body.get("pricing", {})
        for aid in ("sleep", "challenges", "spot", "confidence"):
            if aid in pricing:
                _ok(f"S1 pricing has app '{aid}'")
            else:
                _bad(f"S1 pricing has app '{aid}'", f"keys={list(pricing.keys())}")

        # ============== STEP 1 — verify default shape on a no-doc app ==========
        # Reset all 4 apps to free so we can later check defaults more cleanly.
        # Actually, we'll handle the "no doc" check after we ensure step 7 doesn't pollute.
        # Spec: for an app with no doc yet, expect price=0, currency=USD, purchase_url='', discount_percent=0,
        # discount_active=false, effective_price=0, is_free=true, purchased=false.
        # If sleep currently has a doc from a prior test run, _pricing_doc_to_pub will still return is_free=true if price=0.
        # Best: use a simple shape check on whatever app is currently free.
        free_app = None
        for aid, p in pricing.items():
            if p.get("is_free"):
                free_app = aid
                break
        if free_app:
            p = pricing[free_app]
            checks = [
                (p.get("price") == 0 or p.get("price") == 0.0, "price=0"),
                (p.get("currency") == "USD", "currency=USD"),
                (p.get("purchase_url") == "", "purchase_url=''"),
                (p.get("discount_percent") == 0, "discount_percent=0"),
                (p.get("discount_active") is False, "discount_active=false"),
                (p.get("effective_price") == 0 or p.get("effective_price") == 0.0, "effective_price=0"),
                (p.get("is_free") is True, "is_free=true"),
                (p.get("purchased") is False, "purchased=false"),
            ]
            for ok, lbl in checks:
                if ok:
                    _ok(f"S1 free-app '{free_app}' {lbl}")
                else:
                    _bad(f"S1 free-app '{free_app}' {lbl}", f"got {p}")
        else:
            _bad("S1 no free app to verify default shape", f"pricing={pricing}")

        # ============== STEP 2: non-admin POST pricing → 403 ==============
        u_tok, u_id, u_email, u_pw = register_user(client, "Ryan Chen")
        u_h = {"Authorization": f"Bearer {u_tok}"}

        r = client.post(f"{BASE}/library/pricing/sleep",
                        json={"price": 9.99},
                        headers=u_h)
        assert_status(r, 403, "S2 non-admin POST pricing 403")
        if r.status_code == 403:
            try:
                detail = r.json().get("detail", "")
                if "Creator" in str(detail):
                    _ok("S2 detail mentions Creator")
                else:
                    _bad("S2 detail mentions Creator", f"detail={detail}")
            except Exception:
                _bad("S2 detail json parse", str(r.text)[:200])

        # ============== STEP 3: admin POST pricing/sleep set 9.99 ==============
        r = client.post(f"{BASE}/library/pricing/sleep",
                        json={"price": 9.99, "currency": "USD",
                              "purchase_url": "https://ko-fi.com/example"},
                        headers=admin_h)
        assert_status(r, 200, "S3 admin POST pricing/sleep 200")
        if r.status_code == 200:
            p = r.json().get("pricing") or {}
            assert_eq(p.get("price"), 9.99, "S3 price=9.99")
            assert_eq(p.get("currency"), "USD", "S3 currency=USD")
            assert_eq(p.get("is_free"), False, "S3 is_free=false")
            assert_close(p.get("effective_price"), 9.99, 0.01, "S3 effective_price=9.99")
            assert_eq(p.get("purchase_url"), "https://ko-fi.com/example", "S3 purchase_url echoed")
            assert_eq(p.get("discount_active"), False, "S3 discount_active=false")

        # ============== STEP 4: admin invalid currency ==============
        r = client.post(f"{BASE}/library/pricing/sleep",
                        json={"price": 5, "currency": "XYZ", "purchase_url": ""},
                        headers=admin_h)
        assert_status(r, 400, "S4 invalid currency 400")

        # ============== STEP 5: admin invalid purchase_url ==============
        r = client.post(f"{BASE}/library/pricing/sleep",
                        json={"price": 5, "currency": "USD", "purchase_url": "ftp://bad"},
                        headers=admin_h)
        assert_status(r, 400, "S5 invalid purchase_url 400")

        # ============== STEP 6: admin negative price ==============
        r = client.post(f"{BASE}/library/pricing/sleep",
                        json={"price": -1, "currency": "USD"},
                        headers=admin_h)
        assert_status(r, 400, "S6 negative price 400")

        # ============== STEP 7: admin invalid app_id ==============
        r = client.post(f"{BASE}/library/pricing/foo",
                        json={"price": 1},
                        headers=admin_h)
        assert_status(r, 400, "S7 invalid app_id 400")

        # ============== Re-confirm sleep is still 9.99 after rejected calls ==============
        r = client.get(f"{BASE}/library/pricing", headers=admin_h)
        assert_status(r, 200, "S7b GET pricing (verify sleep still 9.99 after invalid posts)")
        if r.status_code == 200:
            sleep_p = r.json().get("pricing", {}).get("sleep", {})
            assert_eq(sleep_p.get("price"), 9.99, "S7b sleep.price still 9.99")

        # ============== STEP 8: admin POST discount 50% for 7 days ==============
        r = client.post(f"{BASE}/library/pricing/sleep/discount",
                        json={"percent": 50, "duration_value": 7, "duration_unit": "days"},
                        headers=admin_h)
        assert_status(r, 200, "S8 admin POST discount 50%/7d 200")
        if r.status_code == 200:
            p = r.json().get("pricing") or {}
            assert_eq(p.get("discount_active"), True, "S8 discount_active=true")
            assert_eq(p.get("discount_percent"), 50, "S8 discount_percent=50")
            if p.get("discount_starts_at"):
                _ok("S8 discount_starts_at not null")
            else:
                _bad("S8 discount_starts_at not null", f"={p.get('discount_starts_at')}")
            if p.get("discount_ends_at"):
                _ok("S8 discount_ends_at not null")
            else:
                _bad("S8 discount_ends_at not null", f"={p.get('discount_ends_at')}")
            # effective_price ≈ 5.0 (or 4.995) within ±0.01
            assert_close(p.get("effective_price"), 5.0, 0.01, "S8 effective_price≈5.0")
            # ends_at ~7 days ahead — backend stores ISO; just verify ~ now+7d
            try:
                from datetime import datetime
                ends = p.get("discount_ends_at")
                e = datetime.fromisoformat(ends.replace("Z", "+00:00")).replace(tzinfo=None)
                delta_days = (e - datetime.utcnow()).total_seconds() / 86400.0
                if 6.9 < delta_days < 7.1:
                    _ok(f"S8 ends_at ~7d ahead (delta={delta_days:.3f}d)")
                else:
                    _bad("S8 ends_at ~7d ahead", f"delta_days={delta_days}")
            except Exception as ex:
                _bad("S8 ends_at parse", str(ex))

        # ============== STEP 9: admin POST discount percent=0 clears ==============
        r = client.post(f"{BASE}/library/pricing/sleep/discount",
                        json={"percent": 0},
                        headers=admin_h)
        assert_status(r, 200, "S9 admin POST discount percent=0 200")
        if r.status_code == 200:
            p = r.json().get("pricing") or {}
            assert_eq(p.get("discount_active"), False, "S9 discount_active=false")
            assert_close(p.get("effective_price"), 9.99, 0.01, "S9 effective_price=9.99")

        # ============== STEP 10: discount duration=0 → 400 ==============
        r = client.post(f"{BASE}/library/pricing/sleep/discount",
                        json={"percent": 50, "duration_value": 0, "duration_unit": "days"},
                        headers=admin_h)
        assert_status(r, 400, "S10 discount duration=0 → 400")

        # ============== STEP 11: discount percent=120 → 400 ==============
        r = client.post(f"{BASE}/library/pricing/sleep/discount",
                        json={"percent": 120, "duration_value": 7, "duration_unit": "days"},
                        headers=admin_h)
        assert_status(r, 400, "S11 discount percent=120 → 400")

        # ============== STEP 12: discount duration_unit=years → 400 ==============
        r = client.post(f"{BASE}/library/pricing/sleep/discount",
                        json={"percent": 30, "duration_value": 1, "duration_unit": "years"},
                        headers=admin_h)
        assert_status(r, 400, "S12 discount duration_unit=years → 400")

        # ============== STEP 13: non-admin POST discount → 403 ==============
        r = client.post(f"{BASE}/library/pricing/sleep/discount",
                        json={"percent": 10, "duration_value": 1, "duration_unit": "days"},
                        headers=u_h)
        assert_status(r, 403, "S13 non-admin POST discount → 403")

        # ============== STEP 14: register fresh user A; purchase flow ==============
        a_tok, a_id, a_email, a_pw = register_user(client, "Aria Park")
        a_h = {"Authorization": f"Bearer {a_tok}"}

        r = client.get(f"{BASE}/library/pricing", headers=a_h)
        assert_status(r, 200, "S14a GET pricing as A")
        if r.status_code == 200:
            sleep_p = r.json().get("pricing", {}).get("sleep", {})
            assert_eq(sleep_p.get("purchased"), False, "S14a A.sleep.purchased=false")
            assert_eq(sleep_p.get("is_free"), False, "S14a A.sleep.is_free=false")

        r = client.post(f"{BASE}/library/purchase/sleep", json={}, headers=a_h)
        assert_status(r, 200, "S14b A POST /purchase/sleep 200")
        if r.status_code == 200:
            j = r.json()
            assert_eq(j.get("saved"), True, "S14b saved=true")
            assert_eq(j.get("already_owned"), False, "S14b already_owned=false")
            assert_eq(j.get("is_free"), False, "S14b is_free=false")

        r = client.post(f"{BASE}/library/purchase/sleep", json={}, headers=a_h)
        assert_status(r, 200, "S14c A repost /purchase/sleep 200")
        if r.status_code == 200:
            j = r.json()
            assert_eq(j.get("saved"), True, "S14c saved=true (idempotent)")
            assert_eq(j.get("already_owned"), True, "S14c already_owned=true")
            assert_eq(j.get("is_free"), False, "S14c is_free=false")

        r = client.get(f"{BASE}/library/pricing", headers=a_h)
        assert_status(r, 200, "S14d A GET pricing after purchase")
        if r.status_code == 200:
            sleep_p = r.json().get("pricing", {}).get("sleep", {})
            assert_eq(sleep_p.get("purchased"), True, "S14d A.sleep.purchased=true")

        # ============== STEP 15: A purchase challenges (free) ==============
        # Ensure challenges has no doc OR is free. We'll first force it to free state.
        # Per spec, "challenges still has no pricing doc → free" — but a prior test may have set it.
        # The behaviour is identical in both cases: pricing_pub.is_free=True → return saved=False, already_owned=True.
        r = client.post(f"{BASE}/library/purchase/challenges", json={}, headers=a_h)
        assert_status(r, 200, "S15a A POST /purchase/challenges (free) 200")
        if r.status_code == 200:
            j = r.json()
            assert_eq(j.get("saved"), False, "S15a saved=false (free no-op)")
            assert_eq(j.get("already_owned"), True, "S15a already_owned=true")
            assert_eq(j.get("is_free"), True, "S15a is_free=true")

        # Verify GET pricing — challenges.purchased should remain false (no row inserted)
        r = client.get(f"{BASE}/library/pricing", headers=a_h)
        if r.status_code == 200:
            ch = r.json().get("pricing", {}).get("challenges", {})
            # Spec: "remains purchased=false for challenges OR optionally true if backend chose to mark"
            # Backend implementation does NOT insert when free — so expect false.
            if ch.get("purchased") is False:
                _ok("S15b challenges.purchased=false (no row inserted for free)")
            elif ch.get("purchased") is True:
                _ok(f"S15b challenges.purchased=true (observed; spec allows this)")
            else:
                _bad("S15b challenges.purchased", f"={ch.get('purchased')}")

        # ============== STEP 16: invalid app_id → 400 ==============
        r = client.post(f"{BASE}/library/purchase/foo", json={}, headers=a_h)
        assert_status(r, 400, "S16 POST /purchase/foo invalid app_id 400")

        # ============== STEP 17: anonymous purchase flow ==============
        anon_id_2 = "anon-libpricing-" + uuid.uuid4().hex[:12]
        anon2_h = {"X-Anonymous-Id": anon_id_2}

        r = client.get(f"{BASE}/library/pricing", headers=anon2_h)
        assert_status(r, 200, "S17a anon GET pricing")
        if r.status_code == 200:
            sleep_p = r.json().get("pricing", {}).get("sleep", {})
            assert_eq(sleep_p.get("purchased"), False, "S17a anon sleep.purchased=false (initial)")

        r = client.post(f"{BASE}/library/purchase/sleep", json={}, headers=anon2_h)
        assert_status(r, 200, "S17b anon POST /purchase/sleep 200")
        if r.status_code == 200:
            j = r.json()
            assert_eq(j.get("saved"), True, "S17b anon saved=true")

        r = client.get(f"{BASE}/library/pricing", headers=anon2_h)
        if r.status_code == 200:
            sleep_p = r.json().get("pricing", {}).get("sleep", {})
            assert_eq(sleep_p.get("purchased"), True, "S17c anon sleep.purchased=true after purchase")

        # Different anon id — should still see purchased=false for sleep
        anon_id_3 = "anon-libpricing-" + uuid.uuid4().hex[:12]
        anon3_h = {"X-Anonymous-Id": anon_id_3}
        r = client.get(f"{BASE}/library/pricing", headers=anon3_h)
        if r.status_code == 200:
            sleep_p = r.json().get("pricing", {}).get("sleep", {})
            assert_eq(sleep_p.get("purchased"), False, "S17d different anon id sleep.purchased=false (isolation)")

        # ============== STEP 18: admin sets sleep back to free ==============
        r = client.post(f"{BASE}/library/pricing/sleep",
                        json={"price": 0, "currency": "USD"},
                        headers=admin_h)
        assert_status(r, 200, "S18a admin sets sleep free")
        if r.status_code == 200:
            p = r.json().get("pricing") or {}
            assert_eq(p.get("is_free"), True, "S18a is_free=true")

        # User A still sees purchased=true (their library_purchases row persists)
        r = client.get(f"{BASE}/library/pricing", headers=a_h)
        if r.status_code == 200:
            sleep_p = r.json().get("pricing", {}).get("sleep", {})
            assert_eq(sleep_p.get("purchased"), True, "S18b A.sleep.purchased=true persists after free")
            assert_eq(sleep_p.get("is_free"), True, "S18b A.sleep.is_free=true")

        # ============== STEP 19: regression — /library/ratings still works ==============
        r = client.get(f"{BASE}/library/ratings", headers=admin_h)
        assert_status(r, 200, "S19a admin GET /library/ratings")
        if r.status_code == 200:
            ratings = r.json().get("ratings", {})
            apps_ok = all(a in ratings for a in ("sleep", "challenges", "spot", "confidence"))
            if apps_ok:
                _ok("S19a ratings has 4 apps")
            else:
                _bad("S19a ratings has 4 apps", f"keys={list(ratings.keys())}")

        # Fresh user
        f_tok, f_id, _, _ = register_user(client, "Sasha Kim")
        f_h = {"Authorization": f"Bearer {f_tok}"}
        r = client.get(f"{BASE}/library/ratings", headers=f_h)
        assert_status(r, 200, "S19b fresh user GET /library/ratings")
        if r.status_code == 200:
            ratings = r.json().get("ratings", {})
            apps_ok = all(a in ratings for a in ("sleep", "challenges", "spot", "confidence"))
            if apps_ok:
                _ok("S19b fresh user ratings has 4 apps")

        # ============== STEP 20: GET pricing returns all 4 apps ==============
        r = client.get(f"{BASE}/library/pricing", headers=f_h)
        assert_status(r, 200, "S20 GET pricing fresh user")
        if r.status_code == 200:
            pricing = r.json().get("pricing", {})
            for aid in ("sleep", "challenges", "spot", "confidence"):
                if aid in pricing:
                    _ok(f"S20 pricing has '{aid}'")
                else:
                    _bad(f"S20 pricing has '{aid}'", f"keys={list(pricing.keys())}")
            # sleep was just set to price=0 so is_free=true now
            assert_eq(pricing.get("sleep", {}).get("is_free"), True, "S20 sleep.is_free=true (after S18 reset)")
            # challenges/spot/confidence — only assert is_free=true if backend has no doc OR price=0
            # We did NOT set pricing for challenges/spot/confidence in this test (or any prior test of this run),
            # so they should all be is_free=true by default.
            for aid in ("challenges", "spot", "confidence"):
                p = pricing.get(aid, {})
                # If a prior test or config set them, this could fail; report observed.
                if p.get("is_free") is True:
                    _ok(f"S20 {aid}.is_free=true (default)")
                else:
                    _bad(f"S20 {aid}.is_free=true (default)",
                         f"observed price={p.get('price')} is_free={p.get('is_free')}")

    # ============== summary ==============
    print("\n" + "=" * 60)
    print(f"PASS: {PASS}    FAIL: {FAIL}")
    print("=" * 60)
    if FAIL:
        print("FAILURES:")
        for line in FAIL_LINES:
            print(line)
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
