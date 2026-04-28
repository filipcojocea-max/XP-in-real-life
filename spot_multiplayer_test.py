"""
Spot the Object — MULTIPLAYER LOBBY (Phase 2) backend tests.

Tests the 7 new endpoints under /api/spot/match/* plus regression on
Phase 1 /api/spot/* endpoints.

Run:   python /app/spot_multiplayer_test.py
"""
import base64
import json
import os
import random
import sys
import time
import uuid
from datetime import datetime, timezone

import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
TIMEOUT = 60

# ──────────────────────────────────────────────────────────────────────
PASS = []
FAIL = []


def chk(label, cond, detail=""):
    if cond:
        PASS.append(label)
        print(f"  ✅ {label}")
    else:
        FAIL.append((label, detail))
        print(f"  ❌ {label} :: {detail}")


def section(title):
    print(f"\n══════ {title} ══════")


def auth_h(token):
    return {"Authorization": f"Bearer {token}"}


# ──────────────────────────────────────────────────────────────────────
# Helpers — fetch real Flickr JPEGs (per /app/image_testing.md rules)
# ──────────────────────────────────────────────────────────────────────
def fetch_real_jpeg(keyword: str, lock: int) -> str:
    """Returns base64 string of a small REAL JPEG from loremflickr.com."""
    url = f"https://loremflickr.com/300/300/{keyword}?lock={lock}"
    for _ in range(3):
        try:
            r = requests.get(url, timeout=20, allow_redirects=True)
            if r.status_code == 200 and len(r.content) > 1000:
                return base64.b64encode(r.content).decode("ascii")
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError(f"Could not fetch real jpeg for {keyword}")


# ──────────────────────────────────────────────────────────────────────
# Auth — register 3 users
# ──────────────────────────────────────────────────────────────────────
def register_user(full_name: str, email: str, password: str):
    r = requests.post(
        f"{BASE}/auth/register",
        json={"full_name": full_name, "email": email, "password": password},
        timeout=TIMEOUT,
    )
    if r.status_code != 200:
        # Maybe the account already exists — try login
        r2 = requests.post(
            f"{BASE}/auth/login",
            json={"email": email, "password": password},
            timeout=TIMEOUT,
        )
        if r2.status_code == 200:
            data = r2.json()
            return data["token"], data["user"]["id"]
        raise RuntimeError(
            f"register failed for {email}: {r.status_code} {r.text}"
        )
    data = r.json()
    return data["token"], data["user"]["id"]


# ──────────────────────────────────────────────────────────────────────
def main():
    section("1. Auth & friendship gating")
    suffix = uuid.uuid4().hex[:8]
    host_email = f"spotmp.host.{suffix}@gmail.com"
    f1_email = f"spotmp.friend1.{suffix}@gmail.com"
    f2_email = f"spotmp.friend2.{suffix}@gmail.com"
    pwd = "Spot1234!"

    host_token, host_id = register_user("Olivia Carter", host_email, pwd)
    f1_token, f1_id = register_user("Marcus Bell", f1_email, pwd)
    f2_token, f2_id = register_user("Sophia Reyes", f2_email, pwd)
    chk("registered Host", bool(host_id))
    chk("registered Friend1", bool(f1_id))
    chk("registered Friend2", bool(f2_id))

    # Host → Friend1 friend request, Friend1 accept.
    r = requests.post(
        f"{BASE}/friends/request",
        json={"user_id": f1_id},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk("Host friends/request → 200", r.status_code == 200, r.text)
    r = requests.post(
        f"{BASE}/friends/accept",
        json={"user_id": host_id},
        headers=auth_h(f1_token),
        timeout=TIMEOUT,
    )
    chk(
        "Friend1 friends/accept → 200",
        r.status_code == 200 and r.json().get("status") == "friends",
        r.text,
    )

    # ──────────────────────────────────────────────────────────────────
    section("2. POST /api/spot/match/create")

    # 2a. Empty friend_ids → 400
    r = requests.post(
        f"{BASE}/spot/match/create",
        json={"friend_ids": []},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk(
        "empty friend_ids → 400",
        r.status_code == 400
        and r.json().get("detail") == "Pick at least one friend to invite.",
        f"{r.status_code} {r.text}",
    )

    # 2b. Only stranger → 400
    r = requests.post(
        f"{BASE}/spot/match/create",
        json={"friend_ids": [f2_id]},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk(
        "stranger-only invite → 400",
        r.status_code == 400
        and r.json().get("detail") == "No confirmed friends in the invite list.",
        f"{r.status_code} {r.text}",
    )

    # 2c. Mixed (Friend1 + stranger Friend2) → 200, only Friend1 in players
    r = requests.post(
        f"{BASE}/spot/match/create",
        json={"friend_ids": [f1_id, f2_id]},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk("mixed invite → 200", r.status_code == 200, r.text)
    match = r.json().get("match", {})
    match_id = match.get("id")
    player_ids = {p["user_id"] for p in (match.get("players") or [])}
    chk(
        "match.players include Host & Friend1, exclude Friend2",
        host_id in player_ids
        and f1_id in player_ids
        and f2_id not in player_ids,
        f"players={player_ids}",
    )
    chk(
        "status=waiting and target_object null",
        match.get("status") == "waiting" and match.get("target_object") is None,
        json.dumps(match),
    )

    # SHAPE check — every key the frontend types expect
    expected_keys = {
        "id",
        "host_id",
        "status",
        "target_object",
        "started_at",
        "ends_at",
        "finished_at",
        "seconds_left",
        "winner_id",
        "players",
        "viewer_role",
        "viewer_captures",
        "created_at",
    }
    missing = expected_keys - set(match.keys())
    chk("match shape: all top-level keys present", not missing, f"missing={missing}")
    if match.get("players"):
        p0 = match["players"][0]
        player_keys_expected = {
            "user_id",
            "name",
            "avatar_base64",
            "is_host",
            "joined",
            "declined",
            "captures",
        }
        missing_p = player_keys_expected - set(p0.keys())
        chk("player shape: all keys present", not missing_p, f"missing={missing_p}")

    # ──────────────────────────────────────────────────────────────────
    section("3. GET /api/spot/match/list")

    r = requests.get(
        f"{BASE}/spot/match/list", headers=auth_h(host_token), timeout=TIMEOUT
    )
    chk("Host /list → 200", r.status_code == 200, r.text)
    host_matches = r.json().get("matches", [])
    found = next((m for m in host_matches if m["id"] == match_id), None)
    chk(
        "Host /list contains the new match (status=waiting)",
        found is not None and found.get("status") == "waiting",
        f"matches count={len(host_matches)}",
    )

    r = requests.get(
        f"{BASE}/spot/match/list", headers=auth_h(f1_token), timeout=TIMEOUT
    )
    chk("Friend1 /list → 200", r.status_code == 200)
    f1_matches = r.json().get("matches", [])
    chk(
        "Friend1 /list contains the match (as invitee)",
        any(m["id"] == match_id for m in f1_matches),
    )

    r = requests.get(
        f"{BASE}/spot/match/list", headers=auth_h(f2_token), timeout=TIMEOUT
    )
    chk("Friend2 /list → 200", r.status_code == 200)
    f2_matches = r.json().get("matches", [])
    chk(
        "Friend2 /list does NOT contain the match (filtered out at create)",
        not any(m["id"] == match_id for m in f2_matches),
    )

    # ──────────────────────────────────────────────────────────────────
    section("4. POST /api/spot/match/{id}/join")

    # 4a. Friend2 (not invited) → 403
    r = requests.post(
        f"{BASE}/spot/match/{match_id}/join",
        headers=auth_h(f2_token),
        timeout=TIMEOUT,
    )
    chk("Friend2 join → 403 (not invited)", r.status_code == 403, r.text)

    # 4b. Friend1 join → 200
    r = requests.post(
        f"{BASE}/spot/match/{match_id}/join",
        headers=auth_h(f1_token),
        timeout=TIMEOUT,
    )
    chk("Friend1 join → 200", r.status_code == 200, r.text)
    m_after = r.json().get("match", {})
    f1_player = next(
        (p for p in m_after.get("players", []) if p["user_id"] == f1_id), None
    )
    chk(
        "Friend1 marked joined=true",
        f1_player is not None and f1_player.get("joined") is True,
        json.dumps(f1_player),
    )

    # 4c. Friend1 join again → idempotent 200
    r = requests.post(
        f"{BASE}/spot/match/{match_id}/join",
        headers=auth_h(f1_token),
        timeout=TIMEOUT,
    )
    chk("Friend1 join again → idempotent 200", r.status_code == 200, r.text)

    # ──────────────────────────────────────────────────────────────────
    section("5. POST /api/spot/match/{id}/start (host only)")

    # 5a. Friend1 start → 403
    r = requests.post(
        f"{BASE}/spot/match/{match_id}/start",
        headers=auth_h(f1_token),
        timeout=TIMEOUT,
    )
    chk(
        "Friend1 start → 403",
        r.status_code == 403
        and r.json().get("detail") == "Only the host can start the match.",
        f"{r.status_code} {r.text}",
    )

    # 5b. Host start → 200
    r = requests.post(
        f"{BASE}/spot/match/{match_id}/start",
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk("Host start → 200", r.status_code == 200, r.text)
    started = r.json().get("match", {})
    chk("status=active after start", started.get("status") == "active")
    chk(
        "target_object is a string from SPOT_OBJECTS",
        isinstance(started.get("target_object"), str)
        and len(started["target_object"]) > 0,
        f"target={started.get('target_object')}",
    )
    chk(
        "started_at + ends_at populated",
        bool(started.get("started_at")) and bool(started.get("ends_at")),
    )
    sl = started.get("seconds_left")
    chk(
        "seconds_left ≈ 120 (allow 110-120)",
        isinstance(sl, int) and 110 <= sl <= 120,
        f"seconds_left={sl}",
    )

    # 5c. Host start AGAIN → 400
    r = requests.post(
        f"{BASE}/spot/match/{match_id}/start",
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk(
        "Host start again → 400 not in startable state",
        r.status_code == 400
        and r.json().get("detail") == "Match is not in a startable state.",
        f"{r.status_code} {r.text}",
    )

    # ──────────────────────────────────────────────────────────────────
    section("6. POST /api/spot/match/{id}/capture")

    # 6a. Empty photo → 400
    r = requests.post(
        f"{BASE}/spot/match/{match_id}/capture",
        json={"photo_base64": ""},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk("empty photo → 400", r.status_code == 400, r.text)

    # 6b. Oversized → 400
    big = "A" * 8_000_001
    r = requests.post(
        f"{BASE}/spot/match/{match_id}/capture",
        json={"photo_base64": big},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk(">8MB photo → 400", r.status_code == 400, r.text)

    # 6c. Friend2 (not in match) → 403
    small_b64 = fetch_real_jpeg("leaf", 7777)
    r = requests.post(
        f"{BASE}/spot/match/{match_id}/capture",
        json={"photo_base64": small_b64},
        headers=auth_h(f2_token),
        timeout=TIMEOUT,
    )
    chk(
        "Friend2 (non-participant) capture → 403", r.status_code == 403, r.text
    )

    # 6d. Host capture with real JPEG — accept either polarity
    target_obj = started.get("target_object", "")
    keyword = (
        target_obj.split()[-1] if target_obj else "leaf"
    )  # 'pair of glasses' → 'glasses' etc.
    photo_b64 = fetch_real_jpeg(keyword if keyword else "leaf", 4242)
    host_caps_before = 0  # fresh match, host has 0 captures
    r = requests.post(
        f"{BASE}/spot/match/{match_id}/capture",
        json={"photo_base64": photo_b64},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk("Host capture → 200", r.status_code == 200, r.text)
    body = r.json()
    chk(
        "capture response shape: detected/confidence/can_capture/captures/match",
        all(
            k in body
            for k in ("detected", "confidence", "can_capture", "captures", "match")
        ),
        json.dumps(list(body.keys())),
    )
    chk(
        "detected is bool",
        isinstance(body.get("detected"), bool),
        f"detected={body.get('detected')}",
    )
    chk(
        "confidence is float/int",
        isinstance(body.get("confidence"), (int, float)),
    )
    chk(
        "can_capture invariant matches detected AND confidence>=0.55",
        bool(body.get("can_capture"))
        == (body.get("detected") and float(body.get("confidence", 0)) >= 0.55),
    )
    expected_caps = host_caps_before + (1 if body.get("can_capture") else 0)
    chk(
        f"captures field for Host = {expected_caps} (incremented iff can_capture)",
        body.get("captures") == expected_caps,
        f"got captures={body.get('captures')} can_capture={body.get('can_capture')}",
    )

    # ──────────────────────────────────────────────────────────────────
    section("7. Auto-finalize logic — verify timer counts down")

    r1 = requests.get(
        f"{BASE}/spot/match/{match_id}",
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk("GET /match/{id} #1 → 200", r1.status_code == 200)
    m1 = r1.json().get("match", {})
    sl1 = m1.get("seconds_left")
    chk(
        "GET#1 status=active and seconds_left in (100, 120]",
        m1.get("status") == "active" and isinstance(sl1, int) and 100 < sl1 <= 120,
        f"seconds_left={sl1} status={m1.get('status')}",
    )
    time.sleep(3.5)
    r2 = requests.get(
        f"{BASE}/spot/match/{match_id}",
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    sl2 = r2.json().get("match", {}).get("seconds_left")
    chk(
        "seconds_left counts down between two GETs ~3s apart",
        isinstance(sl2, int) and sl2 < sl1 and (sl1 - sl2) >= 2,
        f"sl1={sl1} sl2={sl2}",
    )

    # ──────────────────────────────────────────────────────────────────
    section("8. POST /api/spot/match/{id}/cancel")

    # Make a fresh waiting match.
    r = requests.post(
        f"{BASE}/spot/match/create",
        json={"friend_ids": [f1_id]},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk("create 2nd match → 200", r.status_code == 200, r.text)
    match2_id = r.json()["match"]["id"]

    # 8a. Friend1 cancel → 403
    r = requests.post(
        f"{BASE}/spot/match/{match2_id}/cancel",
        headers=auth_h(f1_token),
        timeout=TIMEOUT,
    )
    chk("Friend1 cancel → 403 (not host)", r.status_code == 403, r.text)

    # 8b. Host cancel → 200
    r = requests.post(
        f"{BASE}/spot/match/{match2_id}/cancel",
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk(
        "Host cancel → 200 ok:true",
        r.status_code == 200 and r.json().get("ok") is True,
        r.text,
    )

    # 8c. Host start the cancelled match → 400
    r = requests.post(
        f"{BASE}/spot/match/{match2_id}/start",
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk(
        "Host start cancelled match → 400 (not waiting)",
        r.status_code == 400,
        r.text,
    )

    # ──────────────────────────────────────────────────────────────────
    section("9. POST /api/spot/match/{id}/decline")

    r = requests.post(
        f"{BASE}/spot/match/create",
        json={"friend_ids": [f1_id]},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk("create 3rd match → 200", r.status_code == 200, r.text)
    match3_id = r.json()["match"]["id"]

    r = requests.post(
        f"{BASE}/spot/match/{match3_id}/decline",
        headers=auth_h(f1_token),
        timeout=TIMEOUT,
    )
    chk("Friend1 decline → 200", r.status_code == 200, r.text)

    # Friend1 should no longer see the match in /list (decline removes invited+joined)
    r = requests.get(
        f"{BASE}/spot/match/list", headers=auth_h(f1_token), timeout=TIMEOUT
    )
    f1_matches_after = r.json().get("matches", [])
    chk(
        "Friend1 /list no longer shows declined match",
        not any(m["id"] == match3_id for m in f1_matches_after),
        f"still present: {[m['id'] for m in f1_matches_after if m['id']==match3_id]}",
    )

    # ──────────────────────────────────────────────────────────────────
    section("10. REGRESSION on existing /api/spot/* endpoints")

    # /spot/object
    r = requests.get(
        f"{BASE}/spot/object", headers=auth_h(host_token), timeout=TIMEOUT
    )
    chk(
        "/spot/object → 200 with object+challenge_id",
        r.status_code == 200
        and "object" in r.json()
        and "challenge_id" in r.json(),
        r.text,
    )

    # /spot/check (real leaf jpg → detected=true)
    leaf_b64 = fetch_real_jpeg("leaf", 1234)
    r = requests.post(
        f"{BASE}/spot/check",
        json={"target_object": "leaf", "photo_base64": leaf_b64},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk(
        "/spot/check (real leaf) → 200 with detected/confidence/can_capture",
        r.status_code == 200
        and isinstance(r.json().get("detected"), bool)
        and "confidence" in r.json()
        and "can_capture" in r.json(),
        r.text,
    )
    leaf_detected = r.json().get("detected")
    print(f"     (vision detected={leaf_detected}, confidence={r.json().get('confidence')})")

    # /spot/complete success=true → +1 spot point
    prof_pre = requests.get(
        f"{BASE}/profile", headers=auth_h(host_token), timeout=TIMEOUT
    ).json()
    sp_before = int(prof_pre.get("spot_points", 0))
    r = requests.post(
        f"{BASE}/spot/complete",
        json={
            "target_object": "leaf",
            "photo_base64": leaf_b64,
            "success": True,
            "remaining_seconds": 25,
            "mode": "solo_constant",
        },
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk(
        "/spot/complete success=true → 200 with points_delta=1",
        r.status_code == 200 and r.json().get("points_delta") == 1,
        r.text,
    )
    sp_after = int(r.json().get("spot_points", 0))
    chk(
        "/profile.spot_points incremented by 1",
        sp_after == sp_before + 1,
        f"before={sp_before} after={sp_after}",
    )

    # /spot/feed
    r = requests.get(
        f"{BASE}/spot/feed?limit=50", headers=auth_h(host_token), timeout=TIMEOUT
    )
    chk(
        "/spot/feed → 200 with entries[]",
        r.status_code == 200 and isinstance(r.json().get("entries"), list),
        r.text,
    )

    # /spot/random-toggle on
    r = requests.post(
        f"{BASE}/spot/random-toggle",
        json={"enabled": True},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk(
        "/spot/random-toggle enabled=true → 200 spot_random_enabled=true",
        r.status_code == 200 and r.json().get("spot_random_enabled") is True,
        r.text,
    )
    # toggle off
    r = requests.post(
        f"{BASE}/spot/random-toggle",
        json={"enabled": False},
        headers=auth_h(host_token),
        timeout=TIMEOUT,
    )
    chk(
        "/spot/random-toggle enabled=false → 200 spot_random_enabled=false",
        r.status_code == 200 and r.json().get("spot_random_enabled") is False,
        r.text,
    )

    # ──────────────────────────────────────────────────────────────────
    section("RESULTS")
    print(f"\nPASS: {len(PASS)}  FAIL: {len(FAIL)}")
    if FAIL:
        print("\nFailures:")
        for label, detail in FAIL:
            print(f"  - {label}\n    detail: {detail[:300]}")
        sys.exit(1)
    print("✅ All assertions passed.")


if __name__ == "__main__":
    main()
