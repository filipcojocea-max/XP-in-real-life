"""
Admin Account Suspension test suite.
Tests POST /api/admin/suspend, /api/admin/unsuspend, GET /api/admin/suspension/{id},
plus the global authgate hook that returns 403 'account_suspended' for suspended users.
"""

import json
import time
import uuid
import sys
from datetime import datetime
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASS = 0
FAIL = 0
FAILS = []


def assert_(cond, label, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {label}")
    else:
        FAIL += 1
        FAILS.append(f"{label} | {extra}")
        print(f"  ❌ {label} :: {extra}")


def hdr(token=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def main():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})

    # ─── Step 1: Admin login + register fresh user U
    print("\n=== Step 1: admin login + register fresh user U ===")
    r = sess.post(f"{BASE}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert_(r.status_code == 200, f"admin login → 200", f"got {r.status_code} {r.text[:200]}")
    if r.status_code != 200:
        print("FATAL: admin login failed; aborting.")
        return
    admin_data = r.json()
    TOKEN_ADMIN = admin_data["token"]
    admin_user = admin_data["user"]
    ADMIN_ID = admin_user.get("user_id") or admin_user.get("id")
    assert_(bool(TOKEN_ADMIN), "admin token present")

    # Register a fresh user U with realistic data
    suffix = uuid.uuid4().hex[:8]
    U_email = f"sasha.morgan.{suffix}@gmail.com"
    U_password = "Marathon2026!"
    r = sess.post(f"{BASE}/auth/register", json={
        "full_name": "Sasha Morgan",
        "email": U_email,
        "password": U_password,
    })
    assert_(r.status_code == 200, f"register U → 200", f"got {r.status_code} {r.text[:200]}")
    if r.status_code != 200:
        print("FATAL: register U failed")
        return
    U_data = r.json()
    TOKEN_U = U_data.get("token")
    u_user = U_data.get("user", {})
    U_ID = u_user.get("user_id") or u_user.get("id")
    assert_(bool(TOKEN_U), "U token returned immediately")
    assert_(bool(U_ID), "U user_id present")

    # ─── Step 2: GET /admin/suspension/{U_ID} permissions
    print("\n=== Step 2: GET /admin/suspension as non-admin / admin ===")
    r = sess.get(f"{BASE}/admin/suspension/{U_ID}", headers=hdr(TOKEN_U))
    assert_(r.status_code == 403, f"GET /admin/suspension as U → 403 (Creator-only)", f"got {r.status_code} {r.text[:200]}")

    r = sess.get(f"{BASE}/admin/suspension/{U_ID}", headers=hdr(TOKEN_ADMIN))
    assert_(r.status_code == 200, f"GET /admin/suspension as admin → 200", f"got {r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        body = r.json()
        assert_(body.get("suspended") is False, f"admin suspension status: suspended=False", f"body={body}")
        assert_(body.get("user_id") == U_ID, "user_id matches")

    # ─── Step 3: POST /admin/suspend with short timed suspension
    print("\n=== Step 3: POST /admin/suspend (duration_hours=0.001) ===")
    r = sess.post(f"{BASE}/admin/suspend", headers=hdr(TOKEN_ADMIN), json={
        "user_id": U_ID,
        "duration_hours": 0.001,
        "reason": "automated test",
    })
    assert_(r.status_code == 200, f"suspend U → 200", f"got {r.status_code} {r.text[:200]}")
    suspend_t0 = time.time()
    if r.status_code == 200:
        body = r.json()
        assert_(isinstance(body.get("suspended_until"), str) and len(body["suspended_until"]) > 0,
                "suspended_until is non-empty ISO string", f"got {body.get('suspended_until')}")
        try:
            datetime.fromisoformat(body["suspended_until"].replace("Z", "+00:00"))
            iso_ok = True
        except Exception as e:
            iso_ok = False
        assert_(iso_ok, "suspended_until parses as ISO")
        assert_(body.get("forever") is False, "forever=False on timed suspension")
        assert_(body.get("duration_hours") == 0.001, f"duration_hours echoed=0.001", f"got {body.get('duration_hours')}")

    # ─── Step 4: As U: GET /profile → 403 with detail dict
    print("\n=== Step 4: As U GET /profile → 403 account_suspended ===")
    r = sess.get(f"{BASE}/profile", headers=hdr(TOKEN_U))
    assert_(r.status_code == 403, f"U GET /profile → 403", f"got {r.status_code} {r.text[:200]}")
    if r.status_code == 403:
        try:
            j = r.json()
        except Exception:
            j = {}
        detail = j.get("detail")
        assert_(isinstance(detail, dict), f"detail is a dict", f"got type {type(detail).__name__}: {detail}")
        if isinstance(detail, dict):
            assert_(detail.get("error") == "account_suspended", f"detail.error == 'account_suspended'", f"got {detail.get('error')}")
            assert_(isinstance(detail.get("message"), str) and len(detail["message"]) > 0, "detail.message non-empty")
            until_val = detail.get("until")
            assert_(isinstance(until_val, str) and len(until_val) > 0, "detail.until is string")
            try:
                datetime.fromisoformat(until_val.replace("Z", "+00:00"))
                until_ok = True
            except Exception:
                until_ok = False
            assert_(until_ok, f"detail.until parses as ISO", f"value={until_val}")
            assert_(detail.get("forever") is False, "detail.forever == False")
            rs = detail.get("remaining_seconds")
            assert_(isinstance(rs, int) and 0 <= rs <= 5,
                    f"detail.remaining_seconds is int 0..5", f"got {rs} (type {type(rs).__name__})")
            assert_(detail.get("reason") == "automated test", f"detail.reason == 'automated test'", f"got {detail.get('reason')}")

    # ─── Step 5: POST /auth/login with U's creds → 403 same shape
    print("\n=== Step 5: U login → 403 account_suspended ===")
    r = sess.post(f"{BASE}/auth/login", json={"email": U_email, "password": U_password})
    assert_(r.status_code == 403, f"U login → 403", f"got {r.status_code} {r.text[:200]}")
    if r.status_code == 403:
        try:
            j = r.json()
        except Exception:
            j = {}
        detail = j.get("detail")
        assert_(isinstance(detail, dict), "login 403 detail is dict")
        if isinstance(detail, dict):
            assert_(detail.get("error") == "account_suspended", "login 403 detail.error == 'account_suspended'")

    # ─── Step 6: Wait for expiry, then GET /profile → 200
    print("\n=== Step 6: wait for suspension expiry then GET /profile ===")
    elapsed = time.time() - suspend_t0
    sleep_for = max(0, 6.0 - elapsed)
    print(f"  sleeping {sleep_for:.1f}s for expiry…")
    time.sleep(sleep_for)
    r = sess.get(f"{BASE}/profile", headers=hdr(TOKEN_U))
    assert_(r.status_code == 200, f"U GET /profile after expiry → 200", f"got {r.status_code} {r.text[:200]}")

    # ─── Step 7: forever suspension
    print("\n=== Step 7: POST /admin/suspend forever=true ===")
    r = sess.post(f"{BASE}/admin/suspend", headers=hdr(TOKEN_ADMIN), json={
        "user_id": U_ID,
        "forever": True,
        "reason": "ban hammer",
    })
    assert_(r.status_code == 200, f"forever suspend → 200", f"got {r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        body = r.json()
        assert_(body.get("forever") is True, "forever=True echoed")
        assert_(body.get("suspended_until") is None, f"suspended_until is null", f"got {body.get('suspended_until')}")

    # ─── Step 8: GET /profile as U → 403 forever shape
    print("\n=== Step 8: GET /profile as U → 403 detail.forever==True ===")
    r = sess.get(f"{BASE}/profile", headers=hdr(TOKEN_U))
    assert_(r.status_code == 403, f"U GET /profile (forever) → 403", f"got {r.status_code} {r.text[:200]}")
    if r.status_code == 403:
        detail = r.json().get("detail")
        assert_(isinstance(detail, dict), "forever detail is dict")
        if isinstance(detail, dict):
            assert_(detail.get("forever") is True, "detail.forever==True")
            assert_(detail.get("remaining_seconds") is None, f"detail.remaining_seconds==None", f"got {detail.get('remaining_seconds')}")
            assert_(detail.get("error") == "account_suspended", "detail.error correct")

    # ─── Step 9: unsuspend → 200, profile works again
    print("\n=== Step 9: POST /admin/unsuspend ===")
    r = sess.post(f"{BASE}/admin/unsuspend", headers=hdr(TOKEN_ADMIN), json={"user_id": U_ID})
    assert_(r.status_code == 200, f"unsuspend → 200", f"got {r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        body = r.json()
        modified = body.get("modified", 0)
        assert_(modified >= 1, f"modified >= 1", f"got modified={modified}")

    r = sess.get(f"{BASE}/profile", headers=hdr(TOKEN_U))
    assert_(r.status_code == 200, f"U GET /profile after unsuspend → 200", f"got {r.status_code} {r.text[:200]}")

    # ─── Step 10: Negative cases
    print("\n=== Step 10: negative cases ===")
    # 10a: non-admin suspend
    r = sess.post(f"{BASE}/admin/suspend", headers=hdr(TOKEN_U), json={
        "user_id": U_ID, "duration_hours": 1, "reason": "x"
    })
    assert_(r.status_code == 403, f"non-admin suspend → 403", f"got {r.status_code} {r.text[:200]}")
    if r.status_code == 403:
        msg = r.json().get("detail", "")
        assert_("Creator" in str(msg), f"403 message contains 'Creator'", f"got '{msg}'")

    # 10b: admin suspending self
    r = sess.post(f"{BASE}/admin/suspend", headers=hdr(TOKEN_ADMIN), json={
        "user_id": ADMIN_ID, "duration_hours": 1
    })
    assert_(r.status_code == 400, f"admin suspending self → 400", f"got {r.status_code} {r.text[:200]}")

    # 10c: nonexistent user
    r = sess.post(f"{BASE}/admin/suspend", headers=hdr(TOKEN_ADMIN), json={
        "user_id": "nonexistent-uuid-zzz", "duration_hours": 1
    })
    assert_(r.status_code == 404, f"nonexistent user → 404", f"got {r.status_code} {r.text[:200]}")

    # 10d: duration_hours=0
    r = sess.post(f"{BASE}/admin/suspend", headers=hdr(TOKEN_ADMIN), json={
        "user_id": U_ID, "duration_hours": 0
    })
    assert_(r.status_code == 400, f"duration_hours=0 → 400", f"got {r.status_code} {r.text[:200]}")

    # 10e: duration_hours=50000 (>5 years)
    r = sess.post(f"{BASE}/admin/suspend", headers=hdr(TOKEN_ADMIN), json={
        "user_id": U_ID, "duration_hours": 50000
    })
    assert_(r.status_code == 400, f"duration_hours=50000 → 400", f"got {r.status_code} {r.text[:200]}")

    # 10f: no duration, no forever
    r = sess.post(f"{BASE}/admin/suspend", headers=hdr(TOKEN_ADMIN), json={
        "user_id": U_ID
    })
    assert_(r.status_code == 400, f"no duration & forever omitted → 400", f"got {r.status_code} {r.text[:200]}")

    # ─── Step 11: Regression — non-suspended user core endpoints
    print("\n=== Step 11: Regression on non-suspended U ===")
    for path in ["/profile", "/tasks", "/goals", "/levels", "/friends/list"]:
        r = sess.get(f"{BASE}{path}", headers=hdr(TOKEN_U))
        assert_(r.status_code == 200, f"GET {path} as non-suspended U → 200", f"got {r.status_code} {r.text[:200]}")

    # ─── Step 12: suspend then immediately unsuspend → suspension status false
    print("\n=== Step 12: suspend then unsuspend, GET /admin/suspension ===")
    r = sess.post(f"{BASE}/admin/suspend", headers=hdr(TOKEN_ADMIN), json={
        "user_id": U_ID, "duration_hours": 1, "reason": "temp"
    })
    assert_(r.status_code == 200, "temp suspend → 200")
    r = sess.post(f"{BASE}/admin/unsuspend", headers=hdr(TOKEN_ADMIN), json={"user_id": U_ID})
    assert_(r.status_code == 200, "immediate unsuspend → 200")
    r = sess.get(f"{BASE}/admin/suspension/{U_ID}", headers=hdr(TOKEN_ADMIN))
    assert_(r.status_code == 200, f"final GET /admin/suspension → 200", f"got {r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        body = r.json()
        assert_(body.get("suspended") is False, f"final suspended=False", f"got body={body}")

    # Final summary
    print(f"\n========================================")
    print(f"PASS: {PASS}    FAIL: {FAIL}")
    if FAILS:
        print("\nFailed assertions:")
        for f in FAILS:
            print(f"  - {f}")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
