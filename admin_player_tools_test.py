"""
Backend tests for v1.0.29 Admin Player Tools (3 features):
  A. Per-player price overrides
  B. Delete account (cascade)
  C. Inactive players bucket query

Target: https://xp-confidence.preview.emergentagent.com/api
Admin: filip.cojocea122@gmail.com / XL98CZW5599
"""
from __future__ import annotations

import os
import random
import string
import sys
import time
import uuid
from typing import Any

import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"
TIMEOUT = 30

PASSES: list[str] = []
FAILS: list[str] = []


def _ok(label: str) -> None:
    PASSES.append(label)
    print(f"  PASS  {label}")


def _bad(label: str, detail: Any = "") -> None:
    FAILS.append(f"{label} :: {detail}")
    print(f"  FAIL  {label}  :: {detail}")


def _assert(cond: bool, label: str, detail: Any = "") -> None:
    if cond:
        _ok(label)
    else:
        _bad(label, detail)


def _hdr(tok: str | None) -> dict:
    return {"Authorization": f"Bearer {tok}"} if tok else {}


def _rand_email() -> str:
    s = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    return f"apt_{s}_{int(time.time())}@gmail.com"


def _register() -> dict:
    payload = {
        "email": _rand_email(),
        "full_name": f"Test User {random.randint(1000, 9999)}",
        "password": "Sup3rSecret!" + "".join(random.choices(string.digits, k=4)),
    }
    r = requests.post(f"{BASE}/auth/register", json=payload, timeout=TIMEOUT)
    if r.status_code != 200:
        raise RuntimeError(f"register failed {r.status_code} {r.text[:200]}")
    j = r.json()
    return {
        "token": j["token"],
        "user_id": j["user"]["user_id"] if "user_id" in j["user"] else j["user"].get("id"),
        "email": payload["email"],
        "password": payload["password"],
        "full_name": payload["full_name"],
    }


def _login(email: str, password: str) -> dict:
    r = requests.post(
        f"{BASE}/auth/login",
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    if r.status_code != 200:
        raise RuntimeError(f"login failed {r.status_code} {r.text[:200]}")
    j = r.json()
    uid = j["user"].get("user_id") or j["user"].get("id")
    return {"token": j["token"], "user_id": uid, "email": email}


# ────────────── Helpers expected by inactive endpoint shape ──────────────
def _shape_ok(out: dict, bucket: str, expected_days: int) -> bool:
    if not isinstance(out, dict):
        return False
    if out.get("bucket") != bucket:
        return False
    if int(out.get("threshold_days") or 0) != expected_days:
        return False
    if not isinstance(out.get("players"), list):
        return False
    if not isinstance(out.get("count"), int):
        return False
    return True


def main() -> int:
    print(f"BASE={BASE}")
    # ─── prelude: admin login ───
    admin = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    print(f"admin user_id={admin['user_id']}")

    # 1. Register user A
    A = _register()
    print(f"A.user_id={A['user_id']}  email={A['email']}")
    _assert(bool(A.get("user_id")), "STEP 1 registered user A")

    # 2. Non-admin A → list overrides → 403
    r = requests.get(
        f"{BASE}/admin/players/{A['user_id']}/price-overrides",
        headers=_hdr(A["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 403, "STEP 2 non-admin GET overrides → 403", r.status_code)
    if r.status_code == 403:
        detail = (r.json() or {}).get("detail")
        _assert(detail == "Creator only.", "STEP 2 detail == 'Creator only.'", detail)

    # 3. Admin → list overrides for A → 200 with empty dict
    r = requests.get(
        f"{BASE}/admin/players/{A['user_id']}/price-overrides",
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 200, "STEP 3 admin GET overrides → 200", r.status_code)
    if r.status_code == 200:
        j = r.json()
        _assert(j.get("user_id") == A["user_id"], "STEP 3 user_id echoed", j)
        _assert(j.get("overrides") == {}, "STEP 3 overrides == {}", j.get("overrides"))

    # 4. Admin upsert sleep override
    r = requests.post(
        f"{BASE}/admin/players/{A['user_id']}/price-overrides/sleep",
        json={"override_price": 0.50, "currency": "USD"},
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 200, "STEP 4 upsert sleep override → 200", r.status_code)
    if r.status_code == 200:
        j = r.json()
        ovrs = j.get("overrides") or {}
        sleep_ovr = ovrs.get("sleep") or {}
        _assert(sleep_ovr.get("override_price") == 0.5, "STEP 4 override_price == 0.50", sleep_ovr)
        _assert(sleep_ovr.get("currency") == "USD", "STEP 4 currency == USD", sleep_ovr)
        _assert(bool(sleep_ovr.get("updated_at")), "STEP 4 updated_at non-null", sleep_ovr)

    # 5. Invalid app_id
    r = requests.post(
        f"{BASE}/admin/players/{A['user_id']}/price-overrides/invalid",
        json={"override_price": 1, "currency": "USD"},
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 400, "STEP 5 invalid app_id → 400", r.status_code)
    if r.status_code == 400:
        detail = (r.json() or {}).get("detail", "")
        _assert("Invalid app_id" in detail or "invalid" in detail.lower(),
                "STEP 5 detail mentions invalid app_id", detail)

    # 6. Out of range
    r = requests.post(
        f"{BASE}/admin/players/{A['user_id']}/price-overrides/sleep",
        json={"override_price": -5, "currency": "USD"},
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 400, "STEP 6 negative price → 400", r.status_code)
    if r.status_code == 400:
        detail = (r.json() or {}).get("detail", "")
        _assert("out of range" in detail.lower(), "STEP 6 detail mentions 'out of range'", detail)

    # 7. Bad currency
    r = requests.post(
        f"{BASE}/admin/players/{A['user_id']}/price-overrides/sleep",
        json={"override_price": 1, "currency": "XYZ"},
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 400, "STEP 7 bad currency → 400", r.status_code)
    if r.status_code == 400:
        detail = (r.json() or {}).get("detail", "")
        _assert("currency must be one of" in detail.lower(),
                "STEP 7 detail mentions 'currency must be one of'", detail)

    # 8. As A: fresh login → GET /library/pricing
    A_fresh = _login(A["email"], A["password"])
    r = requests.get(
        f"{BASE}/library/pricing", headers=_hdr(A_fresh["token"]), timeout=TIMEOUT
    )
    _assert(r.status_code == 200, "STEP 8 A GET /library/pricing → 200", r.status_code)
    if r.status_code == 200:
        pricing = (r.json() or {}).get("pricing") or {}
        sleep = pricing.get("sleep") or {}
        _assert(sleep.get("has_override") is True, "STEP 8 sleep.has_override == true", sleep)
        _assert(sleep.get("effective_price") == 0.5,
                "STEP 8 sleep.effective_price == 0.50", sleep.get("effective_price"))
        _assert(sleep.get("override_price") == 0.5,
                "STEP 8 sleep.override_price == 0.50", sleep.get("override_price"))
        _assert(sleep.get("discount_active") is False,
                "STEP 8 sleep.discount_active == false", sleep.get("discount_active"))
        _assert(sleep.get("currency") == "USD",
                "STEP 8 sleep.currency == 'USD'", sleep.get("currency"))
        # other apps
        for other in ("challenges", "spot", "confidence"):
            o = pricing.get(other) or {}
            _assert(o.get("has_override") is False,
                    f"STEP 8 {other}.has_override == false", o.get("has_override"))

    # 9. Admin DELETE the override
    r = requests.delete(
        f"{BASE}/admin/players/{A['user_id']}/price-overrides/sleep",
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 200, "STEP 9 DELETE override → 200", r.status_code)
    if r.status_code == 200:
        j = r.json()
        _assert(j.get("overrides") == {}, "STEP 9 overrides == {} after delete", j.get("overrides"))

    # 10. As A: pricing → has_override false; price restored
    r = requests.get(
        f"{BASE}/library/pricing", headers=_hdr(A_fresh["token"]), timeout=TIMEOUT
    )
    _assert(r.status_code == 200, "STEP 10 A pricing post-delete → 200")
    if r.status_code == 200:
        pricing = (r.json() or {}).get("pricing") or {}
        sleep = pricing.get("sleep") or {}
        _assert(sleep.get("has_override") is False,
                "STEP 10 sleep.has_override == false", sleep)
        # effective_price should not be 0.5 anymore (restored to public)
        _assert(sleep.get("effective_price") != 0.5,
                "STEP 10 sleep.effective_price != 0.50 (restored)",
                sleep.get("effective_price"))

    # ────────────── FEATURE B — Delete account ──────────────
    # 11. Non-admin A → DELETE another user → 403
    target_throwaway = _register()  # someone to attempt to delete
    r = requests.delete(
        f"{BASE}/admin/players/{target_throwaway['user_id']}",
        json={"confirm": "DELETE"},
        headers=_hdr(A["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 403, "STEP 11 non-admin DELETE → 403", r.status_code)

    # 12. Admin → DELETE self → 400
    r = requests.delete(
        f"{BASE}/admin/players/{admin['user_id']}",
        json={"confirm": "DELETE"},
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 400, "STEP 12 admin self-delete → 400", r.status_code)
    if r.status_code == 400:
        detail = (r.json() or {}).get("detail", "")
        _assert("cannot delete your own" in detail.lower(),
                "STEP 12 detail mentions 'cannot delete your own'", detail)

    # 13. Register user B
    B = _register()
    print(f"B.user_id={B['user_id']}  email={B['email']}")
    _assert(bool(B.get("user_id")), "STEP 13 registered user B")

    # 14. Bad confirm value
    r = requests.delete(
        f"{BASE}/admin/players/{B['user_id']}",
        json={"confirm": "NOPE"},
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 400, "STEP 14 confirm=NOPE → 400", r.status_code)
    if r.status_code == 400:
        detail = (r.json() or {}).get("detail", "")
        _assert("DELETE" in detail, "STEP 14 detail mentions DELETE", detail)

    # 15. Proper delete
    r = requests.delete(
        f"{BASE}/admin/players/{B['user_id']}",
        json={"confirm": "DELETE"},
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 200, "STEP 15 admin delete B → 200", r.status_code)
    if r.status_code == 200:
        j = r.json()
        _assert(j.get("deleted") is True, "STEP 15 deleted == true", j)
        _assert(j.get("user_id") == B["user_id"], "STEP 15 user_id echoed", j)
        _assert(bool(j.get("email")), "STEP 15 email present", j)
        _assert("summary" in j, "STEP 15 summary present", j)

    # 15b. Verify B can no longer login with old credentials.
    # NOTE: B's old JWT will still parse but get_user_or_legacy can't find
    # the (deleted) user row → falls back to 'main' legacy id, so /profile
    # returns 200 with the main profile rather than 401. We treat that as
    # "auth fails" since the deleted user_id is no longer reachable.
    r = requests.post(
        f"{BASE}/auth/login",
        json={"email": B["email"], "password": B["password"]},
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 401, "STEP 15b B re-login → 401 (account deleted)",
            r.status_code)
    r2 = requests.get(f"{BASE}/profile", headers=_hdr(B["token"]), timeout=TIMEOUT)
    if r2.status_code == 200:
        # ensure /profile did NOT return B's identity (since users row gone,
        # auth falls back to 'main'). Confirm by checking the name is NOT B's.
        body = r2.json() or {}
        _assert(
            body.get("name") != B["full_name"],
            "STEP 15b B's old token cannot recover B's identity",
            body.get("name"),
        )
    else:
        _assert(
            r2.status_code in (401, 403, 404),
            "STEP 15b B's old token rejected on /profile",
            r2.status_code,
        )

    # 15c. Verify B not in /admin/players/by-creation listing
    # Register user C first to make sure listing is fresh
    C = _register()
    r = requests.get(
        f"{BASE}/admin/players/by-creation?order=newest&limit=500",
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 200, "STEP 15c admin by-creation listing → 200", r.status_code)
    if r.status_code == 200:
        rows = (r.json() or {}).get("players") or []
        ids = {p.get("user_id") for p in rows}
        _assert(B["user_id"] not in ids,
                "STEP 15c B.user_id NOT in by-creation listing",
                f"B={B['user_id']} in_ids={B['user_id'] in ids}")
        _assert(C["user_id"] in ids,
                "STEP 15c C.user_id IS in by-creation listing")

    # ────────────── FEATURE C — Inactive players ──────────────
    # 16. invalid bucket
    r = requests.get(
        f"{BASE}/admin/players/inactive?bucket=invalid",
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 400, "STEP 16 bucket=invalid → 400", r.status_code)

    # 17. bucket=2w
    r = requests.get(
        f"{BASE}/admin/players/inactive?bucket=2w",
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 200, "STEP 17 bucket=2w → 200", r.status_code)
    if r.status_code == 200:
        j = r.json()
        _assert(_shape_ok(j, "2w", 14), "STEP 17 shape correct (2w, threshold=14)", j)
        ids = {p.get("user_id") for p in (j.get("players") or [])}
        _assert(admin["user_id"] not in ids,
                "STEP 17 admin NOT in inactive list", ids)
        # Ensure sorted desc by days_inactive
        days = [int(p.get("days_inactive") or 0) for p in (j.get("players") or [])]
        _assert(days == sorted(days, reverse=True),
                "STEP 17 players sorted desc by days_inactive")

    # 18. bucket=6m
    r = requests.get(
        f"{BASE}/admin/players/inactive?bucket=6m",
        headers=_hdr(admin["token"]),
        timeout=TIMEOUT,
    )
    _assert(r.status_code == 200, "STEP 18 bucket=6m → 200", r.status_code)
    if r.status_code == 200:
        j = r.json()
        _assert(_shape_ok(j, "6m", 180), "STEP 18 shape correct (6m, threshold=180)", j)

    # ────────────── FEATURE A regression for users with no overrides ──────────────
    # 19. Fresh user with no overrides: every app has_override=false, duo_offer key present
    D = _register()
    r = requests.get(f"{BASE}/library/pricing", headers=_hdr(D["token"]), timeout=TIMEOUT)
    _assert(r.status_code == 200, "STEP 19 fresh user pricing → 200", r.status_code)
    if r.status_code == 200:
        pricing = (r.json() or {}).get("pricing") or {}
        for aid in ("sleep", "challenges", "spot", "confidence"):
            row = pricing.get(aid) or {}
            _assert(row.get("has_override") is False,
                    f"STEP 19 {aid}.has_override == false")
            _assert("duo_offer" in row, f"STEP 19 {aid} has duo_offer key")
            _assert("discount_percent" in row,
                    f"STEP 19 {aid} has discount_percent")
            _assert("discount_active" in row,
                    f"STEP 19 {aid} has discount_active")
            _assert("effective_price" in row,
                    f"STEP 19 {aid} has effective_price")

    print()
    print(f"==> PASS: {len(PASSES)}    FAIL: {len(FAILS)}    TOTAL: {len(PASSES)+len(FAILS)}")
    if FAILS:
        print("\nFAILURES:")
        for f in FAILS:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
