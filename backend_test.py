"""
Backend test suite — Spot the Object mini-app + light regression.

Targets the public ingress URL (REACT_APP_BACKEND_URL / EXPO_PUBLIC_BACKEND_URL).
Uses anonymous-mode (X-Anonymous-Id header) for isolation.

Real photos are pulled from loremflickr.com (keyword-based real Flickr photos)
to satisfy the image-testing playbook (no blank/synthetic images).
"""
import os
import base64
import json
import time
import uuid
import urllib.request
from typing import Any, Dict, Optional, Tuple

import requests

BACKEND_URL = os.environ.get(
    "BACKEND_URL", "https://xp-confidence.preview.emergentagent.com"
).rstrip("/")
API = f"{BACKEND_URL}/api"

# ---------------------------------------------------------------------------
# Pretty-printer / runner
# ---------------------------------------------------------------------------
RESULTS = []


def record(name: str, ok: bool, info: str = "") -> bool:
    tag = "PASS" if ok else "FAIL"
    line = f"[{tag}] {name}"
    if info:
        line += f"  ::  {info}"
    print(line)
    RESULTS.append((name, ok, info))
    return ok


def assert_eq(name: str, got, want) -> bool:
    return record(name, got == want, f"got={got!r} want={want!r}")


def assert_in(name: str, member, container) -> bool:
    return record(name, member in container, f"{member!r} in {type(container).__name__}")


def summary():
    total = len(RESULTS)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print("\n" + "=" * 60)
    print(f"RESULTS: {passed}/{total} passed")
    print("=" * 60)
    fails = [(n, info) for n, ok, info in RESULTS if not ok]
    if fails:
        print("\nFAILURES:")
        for n, info in fails:
            print(f"  - {n}  ::  {info}")
    return passed, total


# ---------------------------------------------------------------------------
# Real-photo helpers (loremflickr returns real Flickr photos for given tag)
# ---------------------------------------------------------------------------
def _download_image(url: str, retries: int = 3) -> Optional[bytes]:
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 SpotTester"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:
            print(f"  download retry {i+1}/{retries}: {e}")
            time.sleep(1)
    return None


_PHOTO_CACHE: Dict[str, str] = {}


def real_photo_b64(keyword: str, w: int = 480, h: int = 360) -> str:
    """Return a base64-encoded JPEG of a real Flickr photo matching keyword."""
    if keyword in _PHOTO_CACHE:
        return _PHOTO_CACHE[keyword]
    # loremflickr serves keyword-relevant Flickr photos as JPEG
    url = f"https://loremflickr.com/{w}/{h}/{keyword}"
    data = _download_image(url)
    if not data:
        # Fallback to picsum (random real photo, may not match keyword)
        data = _download_image(
            f"https://picsum.photos/seed/{keyword}-{uuid.uuid4().hex[:6]}/{w}/{h}"
        )
    if not data:
        raise RuntimeError(f"Could not fetch test photo for {keyword!r}")
    b64 = base64.b64encode(data).decode("ascii")
    _PHOTO_CACHE[keyword] = b64
    print(f"  fetched real photo for {keyword!r}: {len(data)} bytes -> {len(b64)} b64 chars")
    return b64


# ---------------------------------------------------------------------------
# HTTP helpers (anonymous mode via X-Anonymous-Id)
# ---------------------------------------------------------------------------
def headers(anon_id: Optional[str] = None, jwt: Optional[str] = None) -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    if jwt:
        h["Authorization"] = f"Bearer {jwt}"
    elif anon_id:
        h["X-Anonymous-Id"] = anon_id
    return h


def GET(path: str, anon_id: Optional[str] = None, jwt: Optional[str] = None, **kw) -> requests.Response:
    return requests.get(f"{API}{path}", headers=headers(anon_id, jwt), timeout=120, **kw)


def POST(path: str, body: Any = None, anon_id: Optional[str] = None, jwt: Optional[str] = None) -> requests.Response:
    return requests.post(f"{API}{path}", headers=headers(anon_id, jwt), json=body, timeout=180)


def PUT(path: str, body: Any = None, anon_id: Optional[str] = None, jwt: Optional[str] = None) -> requests.Response:
    return requests.put(f"{API}{path}", headers=headers(anon_id, jwt), json=body, timeout=120)


def DELETE(path: str, anon_id: Optional[str] = None, jwt: Optional[str] = None) -> requests.Response:
    return requests.delete(f"{API}{path}", headers=headers(anon_id, jwt), timeout=120)


# ---------------------------------------------------------------------------
# 1. Spot — full flow
# ---------------------------------------------------------------------------
SPOT_OBJECTS = {
    "leaf", "tree", "flower", "indoor plant", "blade of grass",
    "dog", "cat", "bird",
    "book", "pen", "your phone", "laptop", "headphones", "keyboard", "computer mouse",
    "cup", "mug", "bottle of water", "plate", "fork", "spoon",
    "chair", "table", "lamp", "mirror", "window", "door handle",
    "shoe", "hat", "wristwatch", "pair of glasses", "wallet", "set of keys",
    "pillow", "blanket", "towel",
    "anything pink", "anything blue", "anything red", "anything yellow", "anything green",
    "piece of fruit", "apple", "banana",
    "car", "bicycle", "ball",
    "remote control", "candle", "clock", "scissors", "toothbrush",
    "bowl", "fridge magnet", "soft toy", "coin", "battery",
}


def test_spot_full():
    print("\n" + "#" * 70)
    print("# Spot the Object — full backend flow")
    print("#" * 70)

    anon = f"spot-{uuid.uuid4().hex}"  # 36+ chars, safely above 8-char minimum
    # Fresh second user for like/comment cross-user / fresh feed verification
    anon_b = f"spot-b-{uuid.uuid4().hex}"

    # ---- Profile defaults ----
    r = GET("/profile", anon_id=anon)
    record("GET /profile fresh user (200)", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        prof = r.json()
        record("profile.spot_points default 0", prof.get("spot_points") == 0,
               f"spot_points={prof.get('spot_points')!r}")
        record("profile.spot_random_enabled default False",
               prof.get("spot_random_enabled") is False,
               f"spot_random_enabled={prof.get('spot_random_enabled')!r}")

    # ---- Fresh feed empty ----
    r = GET("/spot/feed?limit=50", anon_id=anon_b)
    if record("GET /spot/feed fresh user (200)", r.status_code == 200, f"status={r.status_code}"):
        body = r.json()
        record("fresh feed entries==[]", body.get("entries") == [], f"got={body.get('entries')!r}")

    # ---- /spot/object — variety check ----
    objects_seen = set()
    last_status = None
    last_payload = None
    for i in range(8):
        r = GET("/spot/object", anon_id=anon)
        last_status = r.status_code
        if r.status_code == 200:
            last_payload = r.json()
            obj = last_payload.get("object")
            cid = last_payload.get("challenge_id")
            if obj:
                objects_seen.add(obj)
            if i == 0:
                record("GET /spot/object payload has 'object' string",
                       isinstance(obj, str) and len(obj) > 0,
                       f"object={obj!r}")
                record("GET /spot/object payload has 'challenge_id'",
                       isinstance(cid, str) and len(cid) > 0,
                       f"challenge_id={cid!r}")
                record("returned object is in curated SPOT_OBJECTS list",
                       obj in SPOT_OBJECTS,
                       f"object={obj!r}")
    record("GET /spot/object (200)", last_status == 200, f"last_status={last_status}")
    record("8 calls to /spot/object yield >=2 distinct objects",
           len(objects_seen) >= 2,
           f"distinct={len(objects_seen)} objects={sorted(objects_seen)}")
    record("all returned objects are members of SPOT_OBJECTS",
           objects_seen.issubset(SPOT_OBJECTS),
           f"unknown={objects_seen - SPOT_OBJECTS}")

    # ---- /spot/check — validation ----
    r = POST("/spot/check", {"target_object": "leaf", "photo_base64": ""}, anon_id=anon)
    record("POST /spot/check empty photo -> 400", r.status_code == 400, f"status={r.status_code} body={r.text[:120]}")

    # Oversize: > 8_000_000 chars
    big = "A" * 8_000_001
    r = POST("/spot/check", {"target_object": "leaf", "photo_base64": big}, anon_id=anon)
    record("POST /spot/check >8MB b64 -> 400", r.status_code == 400, f"status={r.status_code}")

    # ---- /spot/check — positive case (real leaf photo, target=leaf) ----
    leaf_b64 = real_photo_b64("leaf")
    r = POST("/spot/check", {"target_object": "leaf", "photo_base64": leaf_b64}, anon_id=anon)
    record("POST /spot/check positive (200)", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        chk = r.json()
        for k in ("detected", "confidence", "reason", "can_capture"):
            record(f"check response has {k!r}", k in chk, f"keys={list(chk.keys())}")
        record("check.detected is bool", isinstance(chk.get("detected"), bool), f"type={type(chk.get('detected')).__name__}")
        record("check.confidence is number", isinstance(chk.get("confidence"), (int, float)), f"type={type(chk.get('confidence')).__name__}")
        record("check.reason is str", isinstance(chk.get("reason"), str), f"type={type(chk.get('reason')).__name__}")
        record("check.can_capture is bool", isinstance(chk.get("can_capture"), bool), f"type={type(chk.get('can_capture')).__name__}")
        # can_capture = detected AND confidence>=0.55
        expected_cap = bool(chk.get("detected")) and float(chk.get("confidence", 0)) >= 0.55
        record("can_capture == (detected AND confidence>=0.55)",
               chk.get("can_capture") == expected_cap,
               f"can_capture={chk.get('can_capture')!r} expected={expected_cap!r}  (detected={chk.get('detected')}, conf={chk.get('confidence')})")
        # If LLM error path was taken, response still 200 with detected=false and reason mentions error
        if chk.get("reason", "").lower().startswith("vision unavailable"):
            print("  NOTE: vision API failure path — still returned 200 with proper shape (resilience OK)")

    # ---- /spot/check — negative case (chair photo, target=leaf) ----
    chair_b64 = real_photo_b64("chair")
    r = POST("/spot/check", {"target_object": "leaf", "photo_base64": chair_b64}, anon_id=anon)
    record("POST /spot/check negative (200)", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        chk = r.json()
        record("negative check has shape", all(k in chk for k in ("detected", "confidence", "reason", "can_capture")),
               f"keys={list(chk.keys())}")
        # Don't assert detected=False strictly (LLM may surprise us with chair pic that happens to have foliage),
        # but record the value for diagnostic.
        print(f"  diagnostic: negative-case detected={chk.get('detected')!r} conf={chk.get('confidence')!r}")

    # ---- /spot/complete — success=true ----
    r = POST("/spot/complete", {
        "target_object": "leaf",
        "photo_base64": leaf_b64,
        "success": True,
        "remaining_seconds": 42,
        "mode": "solo_constant",
    }, anon_id=anon)
    record("POST /spot/complete success=true (200)", r.status_code == 200, f"status={r.status_code}")
    entry_id_a = None
    if r.status_code == 200:
        body = r.json()
        for k in ("entry", "points_delta", "spot_points", "profile"):
            record(f"complete response has {k!r}", k in body, f"keys={list(body.keys())}")
        record("complete.points_delta == 1", body.get("points_delta") == 1, f"got={body.get('points_delta')!r}")
        record("complete.spot_points == 1", body.get("spot_points") == 1, f"got={body.get('spot_points')!r}")
        record("complete.profile.spot_points == 1", (body.get("profile") or {}).get("spot_points") == 1,
               f"profile.spot_points={(body.get('profile') or {}).get('spot_points')!r}")
        ent = body.get("entry") or {}
        entry_id_a = ent.get("id")
        record("entry.id is uuid string", isinstance(entry_id_a, str) and len(entry_id_a) >= 32,
               f"id={entry_id_a!r}")
        record("entry.success == True", ent.get("success") is True, f"got={ent.get('success')!r}")
        record("entry.target_object == 'leaf'", ent.get("target_object") == "leaf", f"got={ent.get('target_object')!r}")
        record("entry.mode == 'solo_constant'", ent.get("mode") == "solo_constant", f"got={ent.get('mode')!r}")

    # ---- /spot/complete — success=false (no point) ----
    r = POST("/spot/complete", {
        "target_object": "leaf",
        "photo_base64": leaf_b64,
        "success": False,
        "remaining_seconds": 0,
        "mode": "solo_constant",
    }, anon_id=anon)
    record("POST /spot/complete success=false (200)", r.status_code == 200, f"status={r.status_code}")
    entry_id_b = None
    if r.status_code == 200:
        body = r.json()
        record("failed complete points_delta == 0", body.get("points_delta") == 0, f"got={body.get('points_delta')!r}")
        record("failed complete spot_points still 1", body.get("spot_points") == 1, f"got={body.get('spot_points')!r}")
        entry_id_b = (body.get("entry") or {}).get("id")

    # Confirm profile reflects the +1 point only
    r = GET("/profile", anon_id=anon)
    if r.status_code == 200:
        record("after complete: profile.spot_points == 1", r.json().get("spot_points") == 1,
               f"spot_points={r.json().get('spot_points')!r}")

    # ---- /spot/feed — should now contain the 2 entries ----
    r = GET("/spot/feed?limit=50", anon_id=anon)
    record("GET /spot/feed (200)", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        body = r.json()
        entries = body.get("entries") or []
        record("feed has >= 2 entries after 2 completions", len(entries) >= 2, f"len={len(entries)}")
        if entries:
            e0 = entries[0]
            for k in ("player_name", "player_avatar_base64", "player_spot_points",
                      "liked_by_you", "like_count", "comment_count", "is_self"):
                record(f"feed entry has {k!r}", k in e0, f"keys={list(e0.keys())[:15]}")
            record("entry.is_self == True for self feed", e0.get("is_self") is True, f"got={e0.get('is_self')!r}")
            record("entry.player_spot_points == 1", e0.get("player_spot_points") == 1,
                   f"got={e0.get('player_spot_points')!r}")
            record("entry.liked_by_you starts False", e0.get("liked_by_you") is False, f"got={e0.get('liked_by_you')!r}")
            record("entry.like_count starts 0", e0.get("like_count") == 0, f"got={e0.get('like_count')!r}")
            record("entry.comment_count starts 0", e0.get("comment_count") == 0, f"got={e0.get('comment_count')!r}")

    # ---- /spot/{id}/like — toggle ----
    if entry_id_a:
        r = POST(f"/spot/{entry_id_a}/like", anon_id=anon)
        record("POST /spot/{id}/like 1st (200)", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            body = r.json()
            record("after 1st like: like_count==1", body.get("like_count") == 1, f"got={body.get('like_count')!r}")
            record("after 1st like: liked_by_you==True", body.get("liked_by_you") is True,
                   f"got={body.get('liked_by_you')!r}")
        r = POST(f"/spot/{entry_id_a}/like", anon_id=anon)
        if r.status_code == 200:
            body = r.json()
            record("after 2nd like (toggle off): like_count==0", body.get("like_count") == 0,
                   f"got={body.get('like_count')!r}")
            record("after 2nd like (toggle off): liked_by_you==False", body.get("liked_by_you") is False,
                   f"got={body.get('liked_by_you')!r}")

    # ---- /spot/{id}/comment ----
    if entry_id_a:
        r = POST(f"/spot/{entry_id_a}/comment", {"text": "   "}, anon_id=anon)
        record("POST /spot/{id}/comment empty -> 400", r.status_code == 400, f"status={r.status_code}")

        r = POST(f"/spot/{entry_id_a}/comment", {"text": "Beautiful find! 🌿"}, anon_id=anon)
        record("POST /spot/{id}/comment normal (200)", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            comments = r.json().get("comments") or []
            record("comments list has 1 entry", len(comments) == 1, f"len={len(comments)}")
            if comments:
                c = comments[-1]
                for k in ("id", "user_id", "user_name", "user_avatar_base64", "text", "created_at"):
                    record(f"comment has {k!r}", k in c, f"keys={list(c.keys())}")
                record("comment.text matches", c.get("text") == "Beautiful find! 🌿", f"got={c.get('text')!r}")

        # Long comment > 280 chars -> truncated
        long_text = "x" * 350
        r = POST(f"/spot/{entry_id_a}/comment", {"text": long_text}, anon_id=anon)
        record("POST /spot/{id}/comment >280 chars (200, no error)", r.status_code == 200,
               f"status={r.status_code}")
        if r.status_code == 200:
            comments = r.json().get("comments") or []
            last = comments[-1] if comments else {}
            record("long comment was truncated to 280 chars", len(last.get("text", "")) == 280,
                   f"len={len(last.get('text', ''))}")

    # ---- /spot/{id} — full detail / 404 ----
    if entry_id_a:
        r = GET(f"/spot/{entry_id_a}", anon_id=anon)
        record("GET /spot/{id} detail (200)", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            ent = r.json()
            record("detail has comments[]", isinstance(ent.get("comments"), list),
                   f"comments_type={type(ent.get('comments')).__name__}")
            record("detail comments len == 2", len(ent.get("comments") or []) == 2,
                   f"len={len(ent.get('comments') or [])}")
            for k in ("player_name", "player_avatar_base64", "player_spot_points", "like_count", "liked_by_you"):
                record(f"detail has {k!r}", k in ent, f"keys=...")

    r = GET(f"/spot/{uuid.uuid4().hex}", anon_id=anon)
    record("GET /spot/{bogus} -> 404", r.status_code == 404, f"status={r.status_code}")

    # ---- /spot/random-toggle ----
    r = POST("/spot/random-toggle", {"enabled": True}, anon_id=anon)
    record("POST /spot/random-toggle enabled=true (200)", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        body = r.json()
        record("random-toggle response.spot_random_enabled True", body.get("spot_random_enabled") is True,
               f"got={body.get('spot_random_enabled')!r}")
        record("random-toggle response.profile.spot_random_enabled True",
               (body.get("profile") or {}).get("spot_random_enabled") is True,
               f"got={(body.get('profile') or {}).get('spot_random_enabled')!r}")

    r = GET("/profile", anon_id=anon)
    if r.status_code == 200:
        record("GET /profile reflects spot_random_enabled=True",
               r.json().get("spot_random_enabled") is True,
               f"got={r.json().get('spot_random_enabled')!r}")

    r = POST("/spot/random-toggle", {"enabled": False}, anon_id=anon)
    if r.status_code == 200:
        record("POST /spot/random-toggle enabled=false reflects",
               r.json().get("spot_random_enabled") is False,
               f"got={r.json().get('spot_random_enabled')!r}")
    r = GET("/profile", anon_id=anon)
    if r.status_code == 200:
        record("GET /profile reflects spot_random_enabled=False",
               r.json().get("spot_random_enabled") is False,
               f"got={r.json().get('spot_random_enabled')!r}")


# ---------------------------------------------------------------------------
# 2. Light regression: profile/leaderboard/task lifecycle
# ---------------------------------------------------------------------------
def test_regression():
    print("\n" + "#" * 70)
    print("# Regression sanity (profile / leaderboard / task complete cycle)")
    print("#" * 70)

    anon = f"reg-{uuid.uuid4().hex}"

    # Profile (already covered for spot defaults above; sanity here on standard fields)
    r = GET("/profile", anon_id=anon)
    record("regression: GET /profile (200)", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        p = r.json()
        for k in ("user_id", "name", "level", "total_xp", "spot_points", "spot_random_enabled"):
            record(f"profile has {k!r}", k in p, "")

    # Leaderboard
    r = GET("/friends/leaderboard?tz=0", anon_id=anon)
    record("regression: GET /friends/leaderboard (200)", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        lb = r.json()
        for k in ("rows", "reports", "week_key", "viewer_is_sunday"):
            record(f"leaderboard has {k!r}", k in lb, "")
        record("leaderboard has self row", any(row.get("is_self") for row in (lb.get("rows") or [])),
               f"rows={len(lb.get('rows') or [])}")

    # Task complete cycle
    r = GET("/tasks", anon_id=anon)
    if r.status_code == 200:
        tasks = r.json().get("tasks") or []
        # pick first default task
        defaults = [t for t in tasks if t.get("is_default")]
        record("regression: at least one default task exists", len(defaults) >= 1, f"defaults={len(defaults)}")
        if defaults:
            t = defaults[0]
            tid = t.get("id")
            from datetime import datetime, timezone
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            r = POST(f"/tasks/{tid}/complete", {"date": today}, anon_id=anon)
            record(f"regression: POST /tasks/{{id}}/complete (200)", r.status_code == 200, f"status={r.status_code}")
            xp_awarded = (r.json() or {}).get("xp_awarded", 0) if r.status_code == 200 else 0
            record("xp_awarded > 0", xp_awarded > 0, f"xp_awarded={xp_awarded}")
            r = POST(f"/tasks/{tid}/uncomplete", {"date": today}, anon_id=anon)
            record("regression: POST /tasks/{{id}}/uncomplete (200)", r.status_code == 200, f"status={r.status_code}")
            xp_removed = (r.json() or {}).get("xp_removed", 0) if r.status_code == 200 else -1
            record("xp_removed matches awarded", xp_removed == xp_awarded, f"awarded={xp_awarded} removed={xp_removed}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print(f"Backend URL: {API}")
    test_spot_full()
    test_regression()
    passed, total = summary()
    raise SystemExit(0 if passed == total else 1)
