"""Backend test harness for the new 'Dress with Confidence' AI photo coach.

Endpoints under test (all require JWT or X-Anonymous-Id):
  POST   /api/confidence/dress-advice
  GET    /api/confidence/dress-history
  DELETE /api/confidence/dress-history/{entry_id}
  GET    /api/confidence/weather

Plus regression checks for:
  GET /api/confidence/daily, POST /api/confidence/complete (track='dress'),
  GET /api/profile, POST /api/auth/register, POST /api/auth/login.
"""

import base64
import io
import sys
import time
import traceback
import uuid

import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASSES = 0
FAILS = 0
FAILED_MSGS = []


def ok(msg):
    global PASSES
    PASSES += 1
    print(f"  ✅ {msg}")


def bad(msg):
    global FAILS
    FAILS += 1
    FAILED_MSGS.append(msg)
    print(f"  ❌ {msg}")


def section(title):
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def make_jpeg_b64(color=(80, 140, 60), w=200, h=200):
    from PIL import Image
    im = Image.new("RGB", (w, h), color)
    # add some texture so it's not a pure flat image
    for x in range(0, w, 8):
        for y in range(0, h, 8):
            im.putpixel((x, y), (200, 80, 60))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


def register(full_name, email, password):
    r = requests.post(
        f"{BASE}/auth/register",
        json={"full_name": full_name, "email": email, "password": password},
        timeout=30,
    )
    r.raise_for_status()
    j = r.json()
    return j["token"], j["user"]


def login(email, password):
    r = requests.post(
        f"{BASE}/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    r.raise_for_status()
    j = r.json()
    return j["token"], j["user"]


# ────────────────────────────────────────────────────────────────────
# Setup: register two fresh users (A and B) on gmail.com
# ────────────────────────────────────────────────────────────────────
section("0. Setup — register A & B (gmail.com)")
sfx = uuid.uuid4().hex[:8]
A_NAME = "Maya Patel"
A_EMAIL = f"maya.patel.{sfx}@gmail.com"
A_PASSWORD = "DressTest!231"
B_NAME = "Ryan Chen"
B_EMAIL = f"ryan.chen.{sfx}@gmail.com"
B_PASSWORD = "DressTest!232"

a_token = None
b_token = None
a_user = None
b_user = None
try:
    a_token, a_user = register(A_NAME, A_EMAIL, A_PASSWORD)
    ok(f"Registered A {A_EMAIL}; verified={a_user.get('verified')}")
except Exception as e:
    bad(f"Could not register A: {e}")
    print(traceback.format_exc())
    sys.exit(1)

try:
    b_token, b_user = register(B_NAME, B_EMAIL, B_PASSWORD)
    ok(f"Registered B {B_EMAIL}; verified={b_user.get('verified')}")
except Exception as e:
    bad(f"Could not register B: {e}")
    print(traceback.format_exc())
    sys.exit(1)

# Sanity: GET /profile auth
try:
    r = requests.get(f"{BASE}/profile", headers=auth_headers(a_token), timeout=15)
    if r.status_code == 200:
        ok("GET /profile (A authed) → 200")
    else:
        bad(f"GET /profile A → {r.status_code} {r.text[:200]}")
except Exception as e:
    bad(f"GET /profile A error: {e}")


# ────────────────────────────────────────────────────────────────────
# 1) POST /api/confidence/dress-advice
# ────────────────────────────────────────────────────────────────────
section("1. POST /api/confidence/dress-advice")

# 1a — with photo + message + event + weather
photo_b64 = make_jpeg_b64(color=(110, 90, 70), w=240, h=240)
entry_id_with_photo = None
try:
    payload = {
        "photo_base64": photo_b64,
        "message": "Is this good for an office meeting?",
        "event_context": "office",
        "weather_hint": "15°C, light rain",
    }
    r = requests.post(
        f"{BASE}/confidence/dress-advice",
        headers=auth_headers(a_token),
        json=payload,
        timeout=90,
    )
    if r.status_code == 200:
        j = r.json()
        reply = j.get("reply", "")
        entry_id_with_photo = j.get("entry_id")
        if isinstance(reply, str) and len(reply.strip()) >= 20:
            ok(f"with-photo: 200 reply len={len(reply)} chars")
        else:
            bad(f"with-photo: reply too short or non-string: {reply!r}")
        if isinstance(entry_id_with_photo, str) and len(entry_id_with_photo) >= 20:
            ok(f"with-photo: entry_id is uuid-ish ({entry_id_with_photo[:8]}…)")
        else:
            bad(f"with-photo: entry_id missing/invalid: {entry_id_with_photo!r}")
        # sanity reply length
        if 50 <= len(reply) <= 2200:
            ok("with-photo: reply is reasonably sized")
        else:
            bad(f"with-photo: reply length {len(reply)} not in expected band")
    elif r.status_code == 503:
        bad(f"with-photo: 503 — LLM key likely missing in .env. body={r.text[:200]}")
    else:
        bad(f"with-photo: HTTP {r.status_code} body={r.text[:300]}")
except Exception as e:
    bad(f"with-photo: error {e}")
    print(traceback.format_exc())

# 1b — text-only (no photo)
entry_id_text_only = None
try:
    r = requests.post(
        f"{BASE}/confidence/dress-advice",
        headers=auth_headers(a_token),
        json={"message": "What should I wear to a date?"},
        timeout=60,
    )
    if r.status_code == 200:
        j = r.json()
        reply = j.get("reply", "")
        entry_id_text_only = j.get("entry_id")
        if isinstance(reply, str) and len(reply.strip()) >= 20:
            ok(f"text-only: 200 reply len={len(reply)}")
        else:
            bad(f"text-only: reply too short: {reply!r}")
        if isinstance(entry_id_text_only, str) and len(entry_id_text_only) >= 20:
            ok(f"text-only: entry_id uuid ({entry_id_text_only[:8]}…)")
        else:
            bad(f"text-only: entry_id missing")
    else:
        bad(f"text-only: HTTP {r.status_code} body={r.text[:300]}")
except Exception as e:
    bad(f"text-only: error {e}")

# 1c — missing message → 422
try:
    r = requests.post(
        f"{BASE}/confidence/dress-advice",
        headers=auth_headers(a_token),
        json={"photo_base64": photo_b64},
        timeout=30,
    )
    if r.status_code == 422:
        ok("missing message → 422 Pydantic validation")
    else:
        bad(f"missing message expected 422 got {r.status_code} body={r.text[:200]}")
except Exception as e:
    bad(f"missing-message: error {e}")

# 1d — empty body → 422
try:
    r = requests.post(
        f"{BASE}/confidence/dress-advice",
        headers=auth_headers(a_token),
        json={},
        timeout=30,
    )
    if r.status_code == 422:
        ok("empty body → 422")
    else:
        bad(f"empty body expected 422 got {r.status_code}")
except Exception as e:
    bad(f"empty body: error {e}")


# ────────────────────────────────────────────────────────────────────
# 2) GET /api/confidence/dress-history
# ────────────────────────────────────────────────────────────────────
section("2. GET /api/confidence/dress-history")

required_keys = {
    "id", "message", "reply", "event_context", "weather_hint",
    "thumbnail_base64", "has_photo", "created_at",
}

# 2a — A history reflects 2 entries
try:
    r = requests.get(
        f"{BASE}/confidence/dress-history?limit=30",
        headers=auth_headers(a_token),
        timeout=20,
    )
    if r.status_code == 200:
        j = r.json()
        items = j.get("items")
        if isinstance(items, list):
            ok(f"A history shape: items list length={len(items)}")
            if len(items) >= 2:
                ok("A history contains both entries (>=2)")
            else:
                bad(f"A history expected >=2 items, got {len(items)}")
            # Each item has all required keys
            missing_anywhere = []
            for i, it in enumerate(items):
                miss = required_keys - set(it.keys())
                if miss:
                    missing_anywhere.append((i, miss))
            if not missing_anywhere:
                ok(f"A history items all have required keys {sorted(required_keys)}")
            else:
                bad(f"A history items missing keys: {missing_anywhere}")
            # newest-first ordering
            if len(items) >= 2:
                t0 = items[0].get("created_at")
                t1 = items[1].get("created_at")
                if t0 and t1 and t0 >= t1:
                    ok(f"A history sorted newest-first (created_at[0]>=[1])")
                else:
                    bad(f"A history not newest-first: t0={t0} t1={t1}")
            # Find the photo-attached one and the text-only one
            photo_entry = None
            text_entry = None
            for it in items:
                if it.get("id") == entry_id_with_photo:
                    photo_entry = it
                if it.get("id") == entry_id_text_only:
                    text_entry = it
            if photo_entry:
                if photo_entry.get("has_photo") is True:
                    ok("photo entry: has_photo=True")
                else:
                    bad(f"photo entry has_photo not True: {photo_entry.get('has_photo')!r}")
                tn = photo_entry.get("thumbnail_base64")
                if isinstance(tn, str) and len(tn) > 100:
                    ok(f"photo entry: thumbnail_base64 non-empty (len={len(tn)})")
                else:
                    bad(f"photo entry: thumbnail missing/short: type={type(tn).__name__}")
            else:
                bad(f"photo entry id={entry_id_with_photo} NOT found in history")
            if text_entry:
                if text_entry.get("has_photo") is False:
                    ok("text entry: has_photo=False")
                else:
                    bad(f"text entry has_photo not False: {text_entry.get('has_photo')!r}")
                if text_entry.get("thumbnail_base64") in (None, ""):
                    ok("text entry: thumbnail_base64 is null/empty")
                else:
                    bad(f"text entry: thumbnail_base64 unexpectedly populated")
            else:
                bad(f"text entry id={entry_id_text_only} NOT found in history")
        else:
            bad(f"A history items is not a list: {type(items).__name__}")
    else:
        bad(f"A history: HTTP {r.status_code} body={r.text[:200]}")
except Exception as e:
    bad(f"A history: error {e}")

# 2b — limit=1 → at most 1 item
try:
    r = requests.get(
        f"{BASE}/confidence/dress-history?limit=1",
        headers=auth_headers(a_token),
        timeout=20,
    )
    if r.status_code == 200:
        items = r.json().get("items", [])
        if isinstance(items, list) and len(items) <= 1:
            ok(f"limit=1 → {len(items)} item")
        else:
            bad(f"limit=1: got {len(items)} items")
    else:
        bad(f"limit=1: HTTP {r.status_code}")
except Exception as e:
    bad(f"limit=1: error {e}")

# 2c — User scoping: B's history empty
try:
    r = requests.get(
        f"{BASE}/confidence/dress-history",
        headers=auth_headers(b_token),
        timeout=20,
    )
    if r.status_code == 200:
        items = r.json().get("items", [])
        if isinstance(items, list) and len(items) == 0:
            ok("B history empty (user scoping correct)")
        else:
            bad(f"B history not empty: len={len(items)} (data leak across users!)")
    else:
        bad(f"B history: HTTP {r.status_code}")
except Exception as e:
    bad(f"B history: error {e}")


# ────────────────────────────────────────────────────────────────────
# 3) DELETE /api/confidence/dress-history/{entry_id}
# ────────────────────────────────────────────────────────────────────
section("3. DELETE /api/confidence/dress-history/{id}")

# 3a — B trying to delete A's entry → 200 {deleted:0}
if entry_id_with_photo:
    try:
        r = requests.delete(
            f"{BASE}/confidence/dress-history/{entry_id_with_photo}",
            headers=auth_headers(b_token),
            timeout=20,
        )
        if r.status_code == 200:
            j = r.json()
            if j.get("deleted") == 0:
                ok("B delete A's entry → 200 {deleted:0} (silent no-op, correct scoping)")
            else:
                bad(f"B delete A's entry → 200 but deleted={j.get('deleted')} (CRITICAL: B deleted A's data!)")
        else:
            bad(f"B delete A's entry: HTTP {r.status_code} body={r.text[:200]}")
    except Exception as e:
        bad(f"B delete A's entry: error {e}")

# 3b — Bogus id → 200 {deleted:0}
bogus_id = f"bogus-{uuid.uuid4().hex}"
try:
    r = requests.delete(
        f"{BASE}/confidence/dress-history/{bogus_id}",
        headers=auth_headers(a_token),
        timeout=20,
    )
    if r.status_code == 200:
        j = r.json()
        if j.get("deleted") == 0:
            ok("Bogus id → 200 {deleted:0}")
        else:
            bad(f"Bogus id deleted={j.get('deleted')}")
    else:
        bad(f"Bogus id: HTTP {r.status_code}")
except Exception as e:
    bad(f"Bogus id: error {e}")

# 3c — A (owner) deletes own → 200 {deleted:1}
if entry_id_with_photo:
    try:
        r = requests.delete(
            f"{BASE}/confidence/dress-history/{entry_id_with_photo}",
            headers=auth_headers(a_token),
            timeout=20,
        )
        if r.status_code == 200:
            j = r.json()
            if j.get("deleted") == 1:
                ok("A delete own entry → 200 {deleted:1}")
            else:
                bad(f"A delete own → 200 but deleted={j.get('deleted')}")
        else:
            bad(f"A delete own: HTTP {r.status_code} body={r.text[:200]}")
    except Exception as e:
        bad(f"A delete own: error {e}")

    # 3d — verify entry is gone from history
    try:
        r = requests.get(
            f"{BASE}/confidence/dress-history",
            headers=auth_headers(a_token),
            timeout=20,
        )
        if r.status_code == 200:
            items = r.json().get("items", [])
            ids = [it.get("id") for it in items]
            if entry_id_with_photo not in ids:
                ok("Deleted entry no longer present in history")
            else:
                bad("Deleted entry STILL present in history")
        else:
            bad(f"post-delete history: HTTP {r.status_code}")
    except Exception as e:
        bad(f"post-delete history: error {e}")


# ────────────────────────────────────────────────────────────────────
# 4) GET /api/confidence/weather
# ────────────────────────────────────────────────────────────────────
section("4. GET /api/confidence/weather")

weather_required = {"temperature_c", "condition", "precipitation_mm", "wind_kmh", "hint"}
expected_conditions = {
    "clear", "mostly clear", "partly cloudy", "overcast",
    "foggy", "light drizzle", "drizzle", "heavy drizzle",
    "light rain", "rain", "heavy rain",
    "light snow", "snow", "heavy snow",
    "rain showers", "heavy showers",
    "thunderstorm", "thunderstorm with hail", "severe thunderstorm",
    "unknown",
}

# 4a — London
try:
    r = requests.get(
        f"{BASE}/confidence/weather?lat=51.5&lon=0.1",
        headers=auth_headers(a_token),
        timeout=20,
    )
    if r.status_code == 200:
        j = r.json()
        miss = weather_required - set(j.keys())
        if not miss:
            ok(f"London weather shape OK: {j}")
        else:
            bad(f"London weather missing keys: {miss}")
        cond = j.get("condition")
        if isinstance(cond, str) and (cond in expected_conditions or len(cond) > 0):
            ok(f"London condition='{cond}' (acceptable)")
        else:
            bad(f"London condition unexpected: {cond!r}")
        hint = j.get("hint")
        if isinstance(hint, str) and len(hint) > 0:
            ok(f"London hint non-empty: '{hint}'")
        else:
            bad(f"London hint empty/missing: {hint!r}")
    else:
        bad(f"London weather: HTTP {r.status_code} body={r.text[:200]}")
except Exception as e:
    bad(f"London weather: error {e}")

# 4b — lat=0,lon=0 (oceans)
try:
    r = requests.get(
        f"{BASE}/confidence/weather?lat=0&lon=0",
        headers=auth_headers(a_token),
        timeout=20,
    )
    if r.status_code == 200:
        ok(f"lat=0,lon=0 → 200 (open-meteo handles oceans)")
    else:
        bad(f"lat=0,lon=0: HTTP {r.status_code} body={r.text[:200]}")
except Exception as e:
    bad(f"lat=0,lon=0: error {e}")


# ────────────────────────────────────────────────────────────────────
# 5) Regression — existing endpoints
# ────────────────────────────────────────────────────────────────────
section("5. Regression — existing /api/confidence/*")

# 5a — daily
try:
    r = requests.get(
        f"{BASE}/confidence/daily",
        headers=auth_headers(a_token),
        timeout=15,
    )
    if r.status_code == 200:
        j = r.json()
        if all(k in j for k in ["date", "social", "physical", "gratitude"]):
            ok(f"GET /confidence/daily → 200 with {{date,social,physical,gratitude}}")
        else:
            bad(f"daily missing keys: {list(j.keys())}")
    else:
        bad(f"daily: HTTP {r.status_code}")
except Exception as e:
    bad(f"daily: error {e}")

# 5b — complete with track="dress"
try:
    r = requests.post(
        f"{BASE}/confidence/complete",
        headers=auth_headers(a_token),
        json={"track": "dress"},
        timeout=15,
    )
    if r.status_code == 200:
        j = r.json()
        if j.get("ok"):
            ok(f"POST /confidence/complete track='dress' → 200 (already_done={j.get('already_done')})")
        else:
            bad(f"complete dress: ok=False {j}")
    else:
        bad(f"complete dress: HTTP {r.status_code} body={r.text[:200]}")
except Exception as e:
    bad(f"complete dress: error {e}")

# 5c — auth/login (gmail.com) for A
try:
    r = requests.post(
        f"{BASE}/auth/login",
        json={"email": A_EMAIL, "password": A_PASSWORD},
        timeout=15,
    )
    if r.status_code == 200 and r.json().get("token"):
        ok("POST /auth/login (correct creds) → 200 with token")
    else:
        bad(f"login A: HTTP {r.status_code} body={r.text[:200]}")
except Exception as e:
    bad(f"login A: error {e}")

# 5d — admin login still works (creds from /app/memory/test_credentials.md)
try:
    r = requests.post(
        f"{BASE}/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    if r.status_code == 200 and r.json().get("token"):
        ok("Admin login still healthy")
    else:
        bad(f"Admin login: HTTP {r.status_code}")
except Exception as e:
    bad(f"Admin login: error {e}")


# ────────────────────────────────────────────────────────────────────
print(f"\n{'=' * 72}\nRESULT: {PASSES} passed, {FAILS} failed\n{'=' * 72}")
if FAILS:
    print("\nFailed assertions:")
    for m in FAILED_MSGS:
        print(f"  - {m}")
sys.exit(0 if FAILS == 0 else 1)
