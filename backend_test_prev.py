"""Backend test for Direct Messaging + AI safety guard + Admin reports.

Run: python /app/backend_test.py
"""
import os
import sys
import time
import uuid
import json
import base64
import random
import string
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
TIMEOUT = 90

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASS = []
FAIL = []


def _check(cond: bool, label: str, info=""):
    tag = "PASS" if cond else "FAIL"
    line = f"[{tag}] {label}"
    if info and not cond:
        line += f"  ({info})"
    print(line)
    (PASS if cond else FAIL).append(label)
    return cond


def _post(path, json=None, headers=None):
    return requests.post(BASE + path, json=json, headers=headers or {}, timeout=TIMEOUT)


def _get(path, headers=None):
    return requests.get(BASE + path, headers=headers or {}, timeout=TIMEOUT)


def _rnd_email(prefix):
    return f"{prefix}.{uuid.uuid4().hex[:8]}@gmail.com"


def _hdr(token):
    return {"Authorization": f"Bearer {token}"}


def _register(name, email, password):
    r = _post("/auth/register", json={"full_name": name, "email": email, "password": password})
    if r.status_code != 200:
        raise RuntimeError(f"register failed: {r.status_code} {r.text}")
    body = r.json()
    return body["token"], body["user"]


def _fetch_image_b64():
    """Fetch a real small JPEG (leaf) from loremflickr.com and return b64."""
    try:
        url = f"https://loremflickr.com/200/200/leaf?lock={random.randint(1, 9999)}"
        r = requests.get(url, timeout=20, allow_redirects=True)
        if r.status_code == 200 and len(r.content) > 1000:
            return base64.b64encode(r.content).decode("ascii")
    except Exception as e:
        print(f"image fetch failed: {e}")
    # Fallback: small valid JPEG
    minimal = bytes.fromhex(
        "ffd8ffe000104a46494600010100000100010000ffdb0043000806060706050806070707"
        "0909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837"
        "292c30313434341f27393d38323c2e333432ffdb0043010909090c0b0c180d0d18321f1c"
        "1f3232323232323232323232323232323232323232323232323232323232323232323232"
        "32323232323232323232323232323232ffc0001108000100010301220002110103110103"
        "ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400"
        "b5100002010303020403050504040000017d010203000411051221314106135161072271"
        "1432819114a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363"
        "738393a434445464748494a535455565758595a636465666768696a737475767778797a"
        "8485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3"
        "c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa"
        "ffda0008010100003f00fbfcffd9"
    )
    return base64.b64encode(minimal).decode("ascii")


def main():
    print(f"=== Direct Messaging + Admin Reports test against {BASE} ===")
    suffix = uuid.uuid4().hex[:6]

    alice_email = _rnd_email(f"alice{suffix}")
    bob_email = _rnd_email(f"bob{suffix}")
    carol_email = _rnd_email(f"carol{suffix}")

    alice_token, alice_user = _register("Alice Morgan", alice_email, "Strong#Pass1A")
    bob_token, bob_user = _register("Bob Carter", bob_email, "Strong#Pass1B")
    carol_token, carol_user = _register("Carol Diaz", carol_email, "Strong#Pass1C")

    alice_id = alice_user["id"]
    bob_id = bob_user["id"]
    carol_id = carol_user["id"]
    print(f"alice={alice_id}\nbob={bob_id}\ncarol={carol_id}")

    A = _hdr(alice_token)
    B = _hdr(bob_token)
    C = _hdr(carol_token)

    # Friend Alice ↔ Bob (use /friends/accept since /friends/respond doesn't exist)
    r = _post("/friends/request", json={"user_id": bob_id}, headers=A)
    _check(r.status_code == 200, "SETUP: Alice → Bob friend request 200", f"{r.status_code} {r.text}")
    r = _post("/friends/accept", json={"user_id": alice_id}, headers=B)
    _check(r.status_code == 200 and r.json().get("status") == "friends",
           "SETUP: Bob accepts → friends", f"{r.status_code} {r.text}")

    # ── 1. /messages/refine ─────────────────────────────────────────────
    print("\n— [1] /messages/refine —")
    r = _post("/messages/refine", json={"text": "hey hows it going lol"}, headers=A)
    if _check(r.status_code == 200, "refine: casual text 200", f"{r.status_code} {r.text}"):
        d = r.json()
        _check(isinstance(d.get("refined"), str) and len(d["refined"]) > 0,
               "refine: refined non-empty for casual text", json.dumps(d))
        _check(d.get("severity") in ("none", "mild"),
               f"refine: severity ∈ none|mild got={d.get('severity')}", json.dumps(d))
        _check(d.get("flagged") is False,
               f"refine: flagged=false got={d.get('flagged')}", json.dumps(d))

    r = _post("/messages/refine", json={"text": ""}, headers=A)
    if _check(r.status_code == 200, "refine: empty 200", f"{r.status_code} {r.text}"):
        d = r.json()
        _check(d.get("refined", "x") == "" and d.get("severity") == "none",
               "refine: empty → refined='' severity='none'", json.dumps(d))

    r = _post("/messages/refine", json={"text": "shit dude this sucks"}, headers=A)
    if _check(r.status_code == 200, "refine: profanity 200", f"{r.status_code} {r.text}"):
        d = r.json()
        _check(d.get("severity") in ("none", "mild"),
               f"refine: profanity severity in (none, mild) got={d.get('severity')}", json.dumps(d))
        _check(isinstance(d.get("refined"), str), "refine: profanity returns string")

    r = _post("/messages/refine", json={"text": "send me nudes right now baby"}, headers=A)
    if _check(r.status_code == 200, "refine: explicit/predatory 200", f"{r.status_code} {r.text}"):
        d = r.json()
        _check(d.get("severity") == "severe",
               f"refine: explicit → severity='severe' got={d.get('severity')}", json.dumps(d))
        _check(d.get("refined", "x") == "",
               "refine: explicit → refined=''", json.dumps(d))
        _check(d.get("flagged") is True,
               "refine: explicit → flagged=true", json.dumps(d))

    # ── 2. /messages/send ───────────────────────────────────────────────
    print("\n— [2] /messages/send —")
    r = _post("/messages/send",
              json={"to_user_id": bob_id,
                    "refined_text": "Hey Bob! How's it going?",
                    "original_text": "hey bob hows it going"},
              headers=A)
    if _check(r.status_code == 200, "send: Alice→Bob good 200", f"{r.status_code} {r.text}"):
        msg = r.json().get("message", {})
        _check(bool(msg.get("id")), "send: msg has id")
        _check(msg.get("from_user_id") == alice_id, "send: from=Alice")
        _check(msg.get("to_user_id") == bob_id, "send: to=Bob")
        _check(bool(msg.get("text")), "send: text non-empty")
        _check(msg.get("severity") in ("none", "mild"),
               f"send: severity none|mild got={msg.get('severity')}")
        _check(msg.get("read_at") is None, "send: read_at=null")

    r = _post("/messages/send", json={"to_user_id": carol_id, "refined_text": "hi"}, headers=A)
    _check(r.status_code == 403, f"send: Alice→Carol stranger 403 got={r.status_code}", r.text)

    r = _post("/messages/send", json={"to_user_id": alice_id, "refined_text": "self note"}, headers=A)
    _check(r.status_code == 400, f"send: self → 400 got={r.status_code}", r.text)

    r = _post("/messages/send", json={"to_user_id": bob_id, "refined_text": ""}, headers=A)
    _check(r.status_code == 400, f"send: empty → 400 got={r.status_code}", r.text)

    r = _post("/messages/send",
              json={"to_user_id": bob_id,
                    "refined_text": "send me nude pics right now baby",
                    "original_text": "send me nude pics right now baby"},
              headers=A)
    if _check(r.status_code == 400, f"send: predatory blocked 400 got={r.status_code}", r.text):
        try:
            payload = r.json()
        except Exception:
            payload = {}
        detail = payload.get("detail", payload)
        if isinstance(detail, dict):
            _check(detail.get("error") == "blocked",
                   f"send: predatory detail.error='blocked' got={detail.get('error')}", json.dumps(detail))
        else:
            _check(False, f"send: predatory detail not dict: {detail}")

    # ── 3. /messages/threads ────────────────────────────────────────────
    print("\n— [3] /messages/threads —")
    r = _get("/messages/threads", headers=A)
    if _check(r.status_code == 200, "threads: Alice GET 200", f"{r.status_code} {r.text}"):
        threads = r.json().get("threads", [])
        bob_t = next((t for t in threads if t.get("friend_id") == bob_id), None)
        _check(bob_t is not None, "threads: Alice has Bob thread")
        if bob_t:
            _check(bob_t.get("last_message") is not None, "threads: last_message present")
            _check(bob_t.get("unread_count") == 0,
                   f"threads: Alice unread=0 got={bob_t.get('unread_count')}")

    r = _get("/messages/threads", headers=B)
    if _check(r.status_code == 200, "threads: Bob GET 200", f"{r.status_code} {r.text}"):
        threads = r.json().get("threads", [])
        alice_t = next((t for t in threads if t.get("friend_id") == alice_id), None)
        _check(alice_t is not None, "threads: Bob has Alice thread")
        if alice_t:
            _check(alice_t.get("unread_count") == 1,
                   f"threads: Bob unread=1 got={alice_t.get('unread_count')}")
            _check((alice_t.get("last_message") or {}).get("text"),
                   "threads: Bob last_message has text")

    r = _get("/messages/threads", headers=C)
    if _check(r.status_code == 200, "threads: Carol GET 200", f"{r.status_code} {r.text}"):
        _check(r.json().get("threads") == [], "threads: Carol empty")

    # ── 4. /messages/thread/{friend_id} ─────────────────────────────────
    print("\n— [4] /messages/thread/{friend_id} —")
    r = _get(f"/messages/thread/{alice_id}", headers=B)
    if _check(r.status_code == 200, "thread: Bob → Alice 200", f"{r.status_code} {r.text}"):
        msgs = r.json().get("messages", [])
        _check(len(msgs) >= 1, f"thread: ≥1 msg got={len(msgs)}")
        if msgs:
            _check(bool(msgs[0].get("id")) and bool(msgs[0].get("text")),
                   "thread: msg shape ok")
            ts = [m.get("created_at", "") for m in msgs]
            _check(ts == sorted(ts), "thread: chronological order")

    r = _get(f"/messages/thread/{carol_id}", headers=B)
    _check(r.status_code == 403, f"thread: Bob → Carol stranger 403 got={r.status_code}")

    # ── 5. /messages/read ───────────────────────────────────────────────
    print("\n— [5] /messages/read —")
    r = _post("/messages/read", json={"friend_id": alice_id}, headers=B)
    if _check(r.status_code == 200, "read: Bob → Alice thread 200", f"{r.status_code} {r.text}"):
        _check(r.json().get("updated", 0) >= 1,
               f"read: updated≥1 got={r.json().get('updated')}")

    r = _get("/messages/threads", headers=B)
    if r.status_code == 200:
        threads = r.json().get("threads", [])
        alice_t = next((t for t in threads if t.get("friend_id") == alice_id), None)
        if alice_t:
            _check(alice_t.get("unread_count") == 0,
                   f"read: post-read unread=0 got={alice_t.get('unread_count')}")

    r = _post("/messages/read", json={"friend_id": carol_id}, headers=B)
    _check(r.status_code == 403, f"read: Bob → Carol stranger 403 got={r.status_code}")

    # ── 6. /messages/unread-summary ─────────────────────────────────────
    print("\n— [6] /messages/unread-summary —")
    for n in (1, 2):
        r = _post("/messages/send",
                  json={"to_user_id": bob_id,
                        "refined_text": f"Following up #{n} — let me know.",
                        "original_text": f"following up #{n}"},
                  headers=A)
        _check(r.status_code == 200, f"unread-summary: prep send #{n}", f"{r.status_code} {r.text}")

    r = _get("/messages/unread-summary", headers=B)
    if _check(r.status_code == 200, "unread-summary: Bob GET 200", f"{r.status_code} {r.text}"):
        d = r.json()
        unread = d.get("unread_by_friend", {})
        _check(unread.get(alice_id) == 2,
               f"unread-summary: Alice→Bob unread=2 got={unread.get(alice_id)}", json.dumps(d))
        _check(d.get("total_unread") == 2,
               f"unread-summary: total_unread=2 got={d.get('total_unread')}", json.dumps(d))

    # ── 7. /push/register-token ─────────────────────────────────────────
    print("\n— [7] /push/register-token —")
    fake_token = "ExponentPushToken[fakebob]"
    r = _post("/push/register-token", json={"token": fake_token, "platform": "android"}, headers=B)
    _check(r.status_code == 200 and r.json().get("ok") is True,
           f"push: register 200 ok=true got={r.status_code} {r.text}")

    r = _post("/push/register-token", json={"token": fake_token, "platform": "android"}, headers=B)
    _check(r.status_code == 200, f"push: re-register 200 (upsert) got={r.status_code}")

    r = _post("/push/register-token", json={"token": "", "platform": "ios"}, headers=B)
    _check(r.status_code == 400, f"push: empty 400 got={r.status_code}")

    r = requests.post(BASE + "/push/register-token",
                      json={"token": "ExponentPushToken[anonGuy]", "platform": "ios"},
                      timeout=TIMEOUT)
    _check(r.status_code == 200, f"push: anonymous 200 got={r.status_code} {r.text}")

    # ── 8. /messages/check-image ────────────────────────────────────────
    print("\n— [8] /messages/check-image —")
    img_b64 = _fetch_image_b64()
    print(f"  (image b64 len={len(img_b64)})")
    r = _post("/messages/check-image", json={"image_base64": img_b64}, headers=A)
    if _check(r.status_code == 200, "check-image: leaf JPEG 200", f"{r.status_code} {r.text[:200]}"):
        d = r.json()
        _check(isinstance(d.get("safe"), bool), f"check-image: safe is bool got={d.get('safe')}")
        _check(d.get("severity") in ("none", "mild", "severe"),
               f"check-image: severity ok got={d.get('severity')}")
        _check("reason" in d, "check-image: has reason")

    r = _post("/messages/check-image", json={"image_base64": ""}, headers=A)
    _check(r.status_code == 400, f"check-image: empty 400 got={r.status_code}")

    big = "A" * 8_000_001
    r = _post("/messages/check-image", json={"image_base64": big}, headers=A)
    _check(r.status_code == 400, f"check-image: >8MB 400 got={r.status_code}")

    # ── 9. Admin endpoints ──────────────────────────────────────────────
    print("\n— [9] Admin endpoints —")
    r = _post("/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if not _check(r.status_code == 200, f"admin: login 200 got={r.status_code}", r.text):
        print("Admin login failed; cannot continue admin tests")
    else:
        admin_token = r.json()["token"]
        AD = _hdr(admin_token)

        r = _get("/admin/reports", headers=AD)
        if _check(r.status_code == 200, f"admin: GET /admin/reports 200 got={r.status_code}"):
            d = r.json()
            _check("reports" in d and isinstance(d["reports"], list), "admin: reports list")
            _check("new_count" in d and isinstance(d["new_count"], int), "admin: new_count int")
            reports = d["reports"]
            new_count_initial = d.get("new_count", 0)
            alice_report = next(
                (rep for rep in reports
                 if rep.get("reported_user_id") == alice_id
                 and rep.get("kind") == "message_text"
                 and rep.get("severity") == "severe"
                 and not rep.get("viewed_at")
                 and not rep.get("dismissed_at")),
                None,
            )
            if not alice_report:
                alice_report = next(
                    (rep for rep in reports
                     if rep.get("reported_user_id") == alice_id
                     and rep.get("kind") == "message_text"),
                    None,
                )
            _check(alice_report is not None,
                   "admin: Alice severe message_text report present",
                   f"reported_user_ids sample={[r.get('reported_user_id') for r in reports[:8]]}")
            if alice_report:
                _check(alice_report.get("severity") == "severe", "admin: severity=severe")
                _check(alice_report.get("kind") == "message_text", "admin: kind=message_text")
                rid = alice_report.get("id")

                r = _get("/admin/reports", headers=B)
                _check(r.status_code == 403, f"admin: Bob non-admin → 403 got={r.status_code}")

                r = _post(f"/admin/reports/{rid}/view", headers=AD)
                _check(r.status_code == 200, f"admin: view 200 got={r.status_code} {r.text}")

                r = _get("/admin/reports", headers=AD)
                d2 = r.json()
                same = next((rep for rep in d2.get("reports", []) if rep.get("id") == rid), None)
                _check(same is not None and same.get("viewed_at") is not None,
                       f"admin: post-view viewed_at populated got={same.get('viewed_at') if same else None}")
                _check(d2.get("new_count", 99) <= max(0, new_count_initial - 1),
                       f"admin: new_count decremented {new_count_initial}→{d2.get('new_count')}")

                r = _post(f"/admin/reports/{rid}/dismiss", headers=AD)
                _check(r.status_code == 200, f"admin: dismiss 200 got={r.status_code}")

                r = _get("/admin/reports", headers=AD)
                d3 = r.json()
                still = next((rep for rep in d3.get("reports", []) if rep.get("id") == rid), None)
                _check(still is None, "admin: dismissed report no longer in inbox")

    # ── 10. Regression ──────────────────────────────────────────────────
    print("\n— [10] Regression —")
    r = _post("/auth/login", json={"email": alice_email, "password": "Strong#Pass1A"})
    _check(r.status_code == 200, f"regression: /auth/login 200 got={r.status_code}", r.text)
    r = _post("/auth/login", json={"email": alice_email, "password": "WrongPass!"})
    _check(r.status_code == 401, f"regression: wrong pw 401 got={r.status_code}")

    r = _get("/profile", headers=A)
    if _check(r.status_code == 200, f"regression: /profile 200 got={r.status_code}"):
        prof = r.json()
        _check("last_seen_at" in prof,
               f"regression: /profile has last_seen_at (keys with seen/tz: {[k for k in prof.keys() if 'seen' in k or 'tz' in k]})")
        _check("onboarding_tz_done" in prof,
               "regression: /profile has onboarding_tz_done")

    # /api/spot/match smoke
    r = _post("/spot/match/create", json={"friend_ids": [bob_id]}, headers=A)
    if _check(r.status_code == 200, f"regression: spot/match/create 200 got={r.status_code} {r.text[:200]}"):
        match = r.json().get("match", {})
        match_id = match.get("id")
        _check(bool(match_id), "regression: match has id")
        _check(match.get("status") == "waiting",
               f"regression: status=waiting got={match.get('status')}")
        if match_id:
            r = _get("/spot/match/list", headers=A)
            _check(r.status_code == 200, f"regression: spot/match/list 200 got={r.status_code}")
            r = _get(f"/spot/match/{match_id}", headers=A)
            _check(r.status_code == 200, f"regression: spot/match/{{id}} 200 got={r.status_code}")
            r = _post(f"/spot/match/{match_id}/cancel", headers=A)
            _check(r.status_code == 200, f"regression: spot/match cancel 200 got={r.status_code}")

    # /friends/list with last_seen_at
    r = _get("/friends/list", headers=A)
    if _check(r.status_code == 200, f"regression: friends/list 200 got={r.status_code}"):
        body = r.json()
        if isinstance(body, list):
            friends = body
        else:
            friends = body.get("friends") or body.get("data") or []
        if friends:
            _check(any("last_seen_at" in f for f in friends),
                   f"regression: friends entry has last_seen_at (keys={list(friends[0].keys())})")
        else:
            _check(False, f"regression: friends list empty: {str(body)[:200]}")

    # /challenge/today — best-effort NOW quote check
    found_now = False
    sample = ""
    for _ in range(3):
        r = _get("/challenge/today", headers=A)
        if r.status_code == 200:
            quote = (r.json().get("quote") or {})
            qtext = quote.get("text", "") or ""
            if not sample:
                sample = qtext
            if "NOW" in qtext:
                found_now = True
                break
    if not found_now:
        try:
            with open("/app/backend/challenges_data.py", "r") as fh:
                src = fh.read()
            _check("is NOW." in src,
                   f"regression: 'is NOW.' present in challenges_data.py (today's user-specific quote='{sample[:60]}')")
        except Exception as e:
            _check(False, f"regression: could not check NOW quote: {e}")
    else:
        _check(True, f"regression: 'NOW' quote surfaced in /challenge/today: '{sample[:80]}'")

    # ───────────────────────────────────────────────────────────────────
    print(f"\n=== {len(PASS)} PASS, {len(FAIL)} FAIL ===")
    if FAIL:
        for f in FAIL:
            print(f"  ✗ {f}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
