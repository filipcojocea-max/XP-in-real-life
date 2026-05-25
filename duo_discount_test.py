"""
Duo Referral Discounts backend test — v1.0.29

Target: https://xp-confidence.preview.emergentagent.com/api
Module under test: /app/backend/duo_discounts.py + integrations in server.py.

All scenarios from the review request are executed sequentially. Each step
prints a PASS/FAIL line + a brief description so the main agent can scan
the output quickly.
"""
from __future__ import annotations

import hmac
import hashlib
import json
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
WHSEC = "whsec_wzpkmxkPB7xTYkERRN2QYy51vv6MXUW3"  # from /app/backend/.env

PASS = 0
FAIL = 0
FAIL_LIST: list[str] = []


def _log(ok: bool, label: str, detail: str = ""):
    global PASS, FAIL
    tag = "PASS" if ok else "FAIL"
    if ok:
        PASS += 1
    else:
        FAIL += 1
        FAIL_LIST.append(label + (f" — {detail}" if detail else ""))
    print(f"[{tag}] {label}" + (f" — {detail}" if detail else ""))


def _rand_email(prefix: str) -> str:
    suf = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{prefix}.{suf}@gmail.com"


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def register(prefix: str, full_name: str) -> tuple[str, str, str]:
    email = _rand_email(prefix)
    r = requests.post(
        f"{BASE}/auth/register",
        json={"email": email, "password": "Passw0rd!Test123", "full_name": full_name},
        timeout=30,
    )
    assert r.status_code == 200, f"register {prefix} failed: {r.status_code} {r.text}"
    token = r.json()["token"]
    uid = r.json()["user"]["id"]
    return token, uid, email


def admin_login() -> tuple[str, str]:
    r = requests.post(
        f"{BASE}/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["token"], r.json()["user"]["id"]


def stripe_sign(payload: str) -> str:
    ts = int(time.time())
    signed = f"{ts}.{payload}".encode("utf-8")
    sig = hmac.new(WHSEC.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def simulate_webhook(user_id: str, app_id: str, group_id: str, amount: int = 500, currency: str = "usd") -> tuple[int, Any]:
    pi_id = f"pi_test_{uuid.uuid4().hex[:12]}"
    event = {
        "id": f"evt_test_{uuid.uuid4().hex[:12]}",
        "object": "event",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "livemode": False,
        "pending_webhooks": 0,
        "request": {"id": None, "idempotency_key": None},
        "type": "payment_intent.succeeded",
        "data": {
            "object": {
                "id": pi_id,
                "amount_received": amount,
                "amount": amount,
                "currency": currency,
                "metadata": {
                    "user_id": user_id,
                    "kind": "library",
                    "app_id": app_id,
                    "boost_id": "",
                    "currency": currency.upper(),
                    "price": f"{amount/100:.2f}",
                    "duo_group_id": group_id,
                },
            }
        },
    }
    body = json.dumps(event, separators=(",", ":"))
    sig = stripe_sign(body)
    r = requests.post(
        f"{BASE}/payments/webhook",
        data=body,
        headers={"Content-Type": "application/json", "stripe-signature": sig},
        timeout=30,
    )
    return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text)


def main():
    print("=" * 80)
    print("Duo Referral Discounts — backend test (v1.0.29)")
    print("=" * 80)

    # STEP 1 — Register fresh non-admin users A + B, admin login.
    token_a, uid_a, email_a = register("alice", "Alice Duotester")
    token_b, uid_b, email_b = register("bob", "Bob Duotester")
    admin_token, admin_uid = admin_login()
    _log(bool(token_a and token_b and admin_token), "1. Register A+B + admin login",
         f"A={email_a} B={email_b}")

    # STEP 2 — Admin sets baseline pricing for 'sleep'.
    r = requests.post(
        f"{BASE}/library/pricing/sleep",
        json={"price": 9.99, "currency": "USD", "discount_percent": 0},
        headers=_h(admin_token),
        timeout=30,
    )
    _log(r.status_code == 200, "2. Admin baseline /library/pricing/sleep price=9.99",
         f"status={r.status_code} body={r.text[:200]}")

    # STEP 3 — Non-admin A → upsert duo discount → 403 'Creator only.'
    r = requests.post(
        f"{BASE}/library/pricing/sleep/duo-discount",
        json={"required_people": 2, "discounted_price": 5, "currency": "USD"},
        headers=_h(token_a),
        timeout=30,
    )
    detail = ""
    try:
        detail = r.json().get("detail", "")
    except Exception:
        pass
    _log(r.status_code == 403 and detail == "Creator only.",
         "3. A upsert duo-discount → 403 'Creator only.'",
         f"status={r.status_code} detail={detail}")

    # STEP 4 — Admin upsert duo discount → 200 + duo_offer.
    r = requests.post(
        f"{BASE}/library/pricing/sleep/duo-discount",
        json={"required_people": 2, "discounted_price": 5, "currency": "USD"},
        headers=_h(admin_token),
        timeout=30,
    )
    ok4 = False
    body4 = {}
    if r.status_code == 200:
        body4 = r.json()
        offer = body4.get("duo_offer") or {}
        ok4 = (
            offer.get("required_people") == 2
            and float(offer.get("discounted_price", 0)) == 5.0
            and offer.get("currency") == "USD"
            and offer.get("active") is True
        )
    _log(ok4, "4. Admin upsert duo-discount sleep → 200 + duo_offer",
         f"status={r.status_code} body={body4}")

    # STEP 5 — Admin upsert with required_people=6 → 400.
    r = requests.post(
        f"{BASE}/library/pricing/sleep/duo-discount",
        json={"required_people": 6, "discounted_price": 5, "currency": "USD"},
        headers=_h(admin_token),
        timeout=30,
    )
    _log(r.status_code == 400, "5. Admin upsert required_people=6 → 400",
         f"status={r.status_code} body={r.text[:200]}")

    # STEP 6 — Admin upsert discounted_price >= full_price → 400.
    r = requests.post(
        f"{BASE}/library/pricing/sleep/duo-discount",
        json={"required_people": 2, "discounted_price": 9.99, "currency": "USD"},
        headers=_h(admin_token),
        timeout=30,
    )
    _log(r.status_code == 400, "6. Admin upsert discounted_price=full price → 400",
         f"status={r.status_code} body={r.text[:200]}")

    # Re-set step 4 to be safe (no state change expected but reapply).
    requests.post(
        f"{BASE}/library/pricing/sleep/duo-discount",
        json={"required_people": 2, "discounted_price": 5, "currency": "USD"},
        headers=_h(admin_token),
        timeout=30,
    )

    # STEP 7 — A GET /library/pricing → sleep.duo_offer present.
    r = requests.get(f"{BASE}/library/pricing", headers=_h(token_a), timeout=30)
    ok7 = False
    out7 = {}
    if r.status_code == 200:
        body = r.json()
        pricing = body.get("pricing") or {}
        sleep_row = pricing.get("sleep") or {}
        offer = sleep_row.get("duo_offer") or {}
        out7 = {"duo_offer": offer, "price": sleep_row.get("price")}
        ok7 = (
            offer.get("required_people") == 2
            and float(offer.get("discounted_price", 0)) == 5.0
            and offer.get("currency") == "USD"
            and offer.get("active") is True
        )
    _log(ok7, "7. A GET /library/pricing → sleep.duo_offer matches",
         f"status={r.status_code} out={out7}")

    # STEP 8 — A GET /library/duo-offer/sleep.
    r = requests.get(f"{BASE}/library/duo-offer/sleep", headers=_h(token_a), timeout=30)
    ok8 = False
    if r.status_code == 200:
        offer = (r.json() or {}).get("duo_offer") or {}
        ok8 = (
            offer.get("required_people") == 2
            and float(offer.get("discounted_price", 0)) == 5.0
            and offer.get("currency") == "USD"
            and offer.get("active") is True
        )
    _log(ok8, "8. A GET /library/duo-offer/sleep → 200 same shape",
         f"status={r.status_code} body={r.text[:200]}")

    # STEP 9 — A POST /duo/create {app_id:'sleep'} → 200 host.
    r = requests.post(
        f"{BASE}/duo/create",
        json={"app_id": "sleep"},
        headers=_h(token_a),
        timeout=30,
    )
    ok9 = False
    group_id = None
    code = None
    body9 = {}
    if r.status_code == 200:
        body9 = r.json()
        group_id = body9.get("group_id")
        code = body9.get("code")
        try:
            uuid.UUID(group_id)
            uuid_ok = True
        except Exception:
            uuid_ok = False
        code_ok = (
            isinstance(code, str)
            and len(code) == 6
            and all(c in (string.ascii_uppercase + string.digits) for c in code)
        )
        ok9 = (
            uuid_ok and code_ok
            and body9.get("required_people") == 2
            and float(body9.get("discounted_price", 0)) == 5.0
            and body9.get("currency") == "USD"
            and body9.get("status") == "waiting"
            and body9.get("members_count") == 1
            and body9.get("is_full") is False
            and body9.get("is_host") is True
            and body9.get("is_member") is True
            and body9.get("expires_at") is not None
        )
    _log(ok9, "9. A POST /duo/create sleep → 200 with full shape",
         f"status={r.status_code} group_id={group_id} code={code}")

    # STEP 10 — A POST /duo/create again → already_exists, same group_id.
    r = requests.post(
        f"{BASE}/duo/create",
        json={"app_id": "sleep"},
        headers=_h(token_a),
        timeout=30,
    )
    ok10 = False
    if r.status_code == 200:
        b = r.json()
        ok10 = b.get("already_exists") is True and b.get("group_id") == group_id
    _log(ok10, "10. A POST /duo/create sleep AGAIN → already_exists + same group_id",
         f"status={r.status_code} group_id={r.json().get('group_id') if r.headers.get('content-type','').startswith('application/json') else '?'}")

    # STEP 11 — B POST /duo/join {code} → status:'full'.
    r = requests.post(
        f"{BASE}/duo/join",
        json={"code": code},
        headers=_h(token_b),
        timeout=30,
    )
    ok11 = False
    if r.status_code == 200:
        b = r.json()
        ok11 = (
            b.get("status") == "full"
            and b.get("members_count") == 2
            and b.get("is_full") is True
            and b.get("is_host") is False
            and b.get("is_member") is True
        )
    _log(ok11, "11. B /duo/join {code} → status:full, members_count:2",
         f"status={r.status_code} body={r.text[:200]}")

    # STEP 12 — B POST /duo/join again with same code → already_member idempotent.
    r = requests.post(
        f"{BASE}/duo/join",
        json={"code": code},
        headers=_h(token_b),
        timeout=30,
    )
    ok12 = False
    if r.status_code == 200:
        ok12 = r.json().get("already_member") is True
    _log(ok12, "12. B /duo/join AGAIN → already_member:true",
         f"status={r.status_code} body={r.text[:200]}")

    # STEP 13 — Register C, attempt to join full group → 400.
    token_c, uid_c, email_c = register("carol", "Carol Duotester")
    r = requests.post(
        f"{BASE}/duo/join",
        json={"code": code},
        headers=_h(token_c),
        timeout=30,
    )
    _log(r.status_code == 400, "13. C /duo/join (full group) → 400",
         f"status={r.status_code} body={r.text[:200]}")

    # STEP 14 — Non-existent code → 404.
    r = requests.post(
        f"{BASE}/duo/join",
        json={"code": "NOPE99"},
        headers=_h(token_a),
        timeout=30,
    )
    _log(r.status_code == 404, "14. /duo/join {code:'NOPE99'} → 404",
         f"status={r.status_code} body={r.text[:200]}")

    # STEP 15 — B POST /payments/create-payment-intent with duo_group_id.
    r = requests.post(
        f"{BASE}/payments/create-payment-intent",
        json={"app_id": "sleep", "kind": "library", "duo_group_id": group_id},
        headers=_h(token_b),
        timeout=30,
    )
    ok15 = False
    pi_b = None
    body15 = {}
    if r.status_code == 200:
        body15 = r.json()
        pi_b = body15.get("payment_intent_id")
        ok15 = (
            float(body15.get("effective_price", 0)) == 5.0
            and body15.get("currency") == "USD"
            and body15.get("amount") == 500
            and body15.get("duo_group_id") == group_id
            and bool(pi_b)
        )
    _log(ok15, "15. B /payments/create-payment-intent {duo_group_id} → eff=5, amount=500",
         f"status={r.status_code} pi={pi_b} eff={body15.get('effective_price')} amount={body15.get('amount')}")

    # STEP 16 — Simulate webhook for B with signed payload.
    code16, body16 = simulate_webhook(uid_b, "sleep", group_id, amount=500, currency="usd")
    ok16 = code16 == 200 and (isinstance(body16, dict) and body16.get("received") is True)
    _log(ok16, "16. Webhook payment_intent.succeeded for B → 200 {received:true}",
         f"status={code16} body={body16}")

    # STEP 17 — B GET /library/pricing → sleep.purchased == true.
    r = requests.get(f"{BASE}/library/pricing", headers=_h(token_b), timeout=30)
    ok17 = False
    if r.status_code == 200:
        sleep_row = (r.json().get("pricing") or {}).get("sleep") or {}
        ok17 = sleep_row.get("purchased") is True
    _log(ok17, "17. B GET /library/pricing → sleep.purchased:true",
         f"status={r.status_code} purchased={(r.json().get('pricing') or {}).get('sleep', {}).get('purchased') if r.status_code==200 else '?'}")

    # STEP 18 — A GET /duo/<group_id> → status STILL 'full', B paid_at set, A not.
    r = requests.get(f"{BASE}/duo/{group_id}", headers=_h(token_a), timeout=30)
    ok18 = False
    if r.status_code == 200:
        b = r.json()
        members = b.get("members") or []
        b_member = next((m for m in members if m.get("user_id") == uid_b), None)
        a_member = next((m for m in members if m.get("user_id") == uid_a), None)
        ok18 = (
            b.get("status") == "full"
            and b_member is not None
            and b_member.get("paid_at") is not None
            and a_member is not None
            and a_member.get("paid_at") is None
        )
    _log(ok18, "18. A GET /duo/<gid> → status:full, B.paid_at set, A.paid_at None",
         f"status={r.status_code} body={r.text[:300]}")

    # STEP 19 — Simulate webhook for A → group completed.
    code19, body19 = simulate_webhook(uid_a, "sleep", group_id, amount=500, currency="usd")
    ok19_wh = code19 == 200 and (isinstance(body19, dict) and body19.get("received") is True)
    r = requests.get(f"{BASE}/duo/{group_id}", headers=_h(token_a), timeout=30)
    ok19_state = False
    if r.status_code == 200:
        b = r.json()
        ok19_state = b.get("status") == "completed" and b.get("completed_at") is not None
    _log(ok19_wh and ok19_state,
         "19. Webhook for A → group→completed + completed_at set",
         f"wh_status={code19} group_status={r.json().get('status') if r.status_code==200 else '?'} completed_at={r.json().get('completed_at') if r.status_code==200 else '?'}")

    # STEP 20 — Admin GET /admin/purchase-history → both A and B rows present.
    r = requests.get(f"{BASE}/admin/purchase-history", headers=_h(admin_token), timeout=30)
    ok20 = False
    detail20 = ""
    if r.status_code == 200:
        body = r.json()
        purchases = body.get("purchases") or []
        a_row = next((p for p in purchases if p.get("user_id") == uid_a and p.get("app_id") == "sleep"), None)
        b_row = next((p for p in purchases if p.get("user_id") == uid_b and p.get("app_id") == "sleep"), None)
        def _check(row):
            if not row:
                return False
            duo = row.get("duo") or {}
            return (
                row.get("source") == "duo"
                and row.get("duo_group_id") == group_id
                and duo.get("group_id") == group_id
                and duo.get("code") == code
                and duo.get("host_id") == uid_a
                and duo.get("required_people") == 2
                and duo.get("members_count") == 2
            )
        ok20 = _check(a_row) and _check(b_row)
        detail20 = f"a_row={a_row} b_row={b_row}"
    _log(ok20, "20. Admin /admin/purchase-history has A+B rows source='duo' + duo metadata",
         f"status={r.status_code} {detail20[:400]}")

    # STEP 21 — Non-admin C → 403.
    r = requests.get(f"{BASE}/admin/purchase-history", headers=_h(token_c), timeout=30)
    _log(r.status_code == 403, "21. C /admin/purchase-history → 403",
         f"status={r.status_code} body={r.text[:200]}")

    # STEP 22 — Regression: solo % discount on 'challenges' + duo_offer null.
    r = requests.post(
        f"{BASE}/library/pricing/challenges/discount",
        json={"percent": 30, "duration_value": 7, "duration_unit": "days"},
        headers=_h(admin_token),
        timeout=30,
    )
    ok22_disc = r.status_code == 200
    r = requests.get(f"{BASE}/library/pricing", headers=_h(admin_token), timeout=30)
    ok22 = False
    if r.status_code == 200:
        ch = (r.json().get("pricing") or {}).get("challenges") or {}
        ok22 = ch.get("discount_active") is True and ch.get("duo_offer") is None
    _log(ok22_disc and ok22,
         "22. /library/pricing/challenges/discount + duo_offer null regression",
         f"disc_ok={ok22_disc} discount_active={ch.get('discount_active') if r.status_code==200 else '?'} duo_offer={ch.get('duo_offer') if r.status_code==200 else '?'}")

    # STEP 23 — B (owns sleep) attempts to create new duo for sleep → 409.
    r = requests.post(
        f"{BASE}/duo/create",
        json={"app_id": "sleep"},
        headers=_h(token_b),
        timeout=30,
    )
    _log(r.status_code == 409, "23. B /duo/create sleep (already owns) → 409",
         f"status={r.status_code} body={r.text[:200]}")

    # STEP 24 — Lowercase code join on app_id='confidence'.
    token_e, uid_e, _ = register("eve", "Eve Duotester")
    token_f, uid_f, _ = register("frank", "Frank Duotester")
    # Ensure baseline pricing for confidence (>=12 so duo<full holds).
    r = requests.post(
        f"{BASE}/library/pricing/confidence",
        json={"price": 12.0, "currency": "USD"},
        headers=_h(admin_token),
        timeout=30,
    )
    ok24_base = r.status_code == 200
    r = requests.post(
        f"{BASE}/library/pricing/confidence/duo-discount",
        json={"required_people": 2, "discounted_price": 7, "currency": "USD"},
        headers=_h(admin_token),
        timeout=30,
    )
    ok24_offer = r.status_code == 200
    r = requests.post(
        f"{BASE}/duo/create",
        json={"app_id": "confidence"},
        headers=_h(token_e),
        timeout=30,
    )
    code_e = None
    ok24_create = False
    if r.status_code == 200:
        b = r.json()
        code_e = b.get("code")
        ok24_create = (
            isinstance(code_e, str)
            and code_e == code_e.upper()
            and len(code_e) == 6
        )
    # F joins using lowercase version.
    lower = (code_e or "").lower()
    r = requests.post(
        f"{BASE}/duo/join",
        json={"code": lower},
        headers=_h(token_f),
        timeout=30,
    )
    ok24_join = r.status_code == 200 and (r.json().get("status") == "full"
                                          and r.json().get("members_count") == 2)
    _log(ok24_base and ok24_offer and ok24_create and ok24_join,
         "24. Lowercase code join works (server uppercases)",
         f"base={ok24_base} offer={ok24_offer} create={ok24_create} join={ok24_join} code={code_e} lower={lower}")

    # STEP 25 — Host leave cancels group.
    token_g, uid_g, _ = register("gary", "Gary Duotester")
    token_h, uid_h, _ = register("hank", "Hank Duotester")
    r = requests.post(
        f"{BASE}/duo/create",
        json={"app_id": "confidence"},
        headers=_h(token_g),
        timeout=30,
    )
    ok25_create = r.status_code == 200
    g_group_id = r.json().get("group_id") if ok25_create else None
    g_code = r.json().get("code") if ok25_create else None
    r = requests.post(
        f"{BASE}/duo/{g_group_id}/leave",
        headers=_h(token_g),
        timeout=30,
    )
    ok25_leave = r.status_code == 200 and r.json().get("status") == "expired"
    r = requests.post(
        f"{BASE}/duo/join",
        json={"code": g_code},
        headers=_h(token_h),
        timeout=30,
    )
    ok25_join_expired = r.status_code == 400 and "expired" in (r.text or "").lower()
    _log(ok25_create and ok25_leave and ok25_join_expired,
         "25. Host leave → status:expired; H join → 400 'expired'",
         f"create={ok25_create} leave={ok25_leave} join_after={ok25_join_expired} body={r.text[:200]}")

    print("=" * 80)
    print(f"TOTAL: {PASS} PASS / {FAIL} FAIL")
    if FAIL_LIST:
        print("FAILED ITEMS:")
        for f in FAIL_LIST:
            print(f"  - {f}")
    print("=" * 80)
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
