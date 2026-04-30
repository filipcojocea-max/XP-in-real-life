"""Backend regression + new-feature test harness.

Covers the 5 new/modified capabilities from the 2026-04-29 review request:
  1. Spot Photo Editing (/spot/edit/preview, /spot/edit/save)
  2. Spot Vision Check optimized latency (regression)
  3. Leaderboard Admin Display (is_admin_view + level=999 sentinel)
  4. Push Token Registration (loud logging + extended response body)
  5. Debug endpoint /api/debug/health-connect-error

Plus targeted regression smoke:
  /api/auth/register, /api/auth/login, /api/profile, /api/spot/feed,
  /api/friends/list.
"""

import sys
import uuid
import base64
import io
import traceback
import urllib.request
import ssl

import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

PASSES = 0
FAILS = 0


def ok(msg):
    global PASSES
    PASSES += 1
    print(f"  ✅ {msg}")


def bad(msg):
    global FAILS
    FAILS += 1
    print(f"  ❌ {msg}")


def section(title):
    print(f"\n=== {title} ===")


def h(token=None, anon=None):
    out = {"Content-Type": "application/json"}
    if token:
        out["Authorization"] = f"Bearer {token}"
    if anon:
        out["X-Anonymous-Id"] = anon
    return out


def register(full_name, email, password):
    r = requests.post(f"{BASE}/auth/register", json={
        "full_name": full_name, "email": email, "password": password,
    }, timeout=30)
    r.raise_for_status()
    d = r.json()
    return d["token"], d["user"]


def login(email, password):
    r = requests.post(f"{BASE}/auth/login", json={
        "email": email, "password": password,
    }, timeout=30)
    r.raise_for_status()
    d = r.json()
    return d["token"], d["user"]


def fresh_email(tag):
    return f"sdet_{tag}_{uuid.uuid4().hex[:10]}@gmail.com"


def download_loremflickr(keyword="leaf", w=320, h=240):
    url = f"https://loremflickr.com/{w}/{h}/{keyword}"
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "sdet/1.0"})
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        data = resp.read()
    return base64.b64encode(data).decode("ascii")


def make_tiny_jpeg_b64():
    from PIL import Image
    im = Image.new("RGB", (200, 160), (80, 140, 60))
    for x in range(0, 200, 10):
        for y in range(0, 160, 10):
            im.putpixel((x, y), (200, 80, 60))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def is_valid_jpeg_b64(b64):
    try:
        raw = base64.b64decode(b64)
        if raw[:3] != b"\xff\xd8\xff":
            return False
        from PIL import Image
        Image.open(io.BytesIO(raw)).verify()
        return True
    except Exception:
        return False


section("0. Admin login")
admin_token, admin_user = None, None
try:
    admin_token, admin_user = login(ADMIN_EMAIL, ADMIN_PASSWORD)
    ok(f"Admin login → 200, admin_id={admin_user['id']}")
except Exception as e:
    bad(f"Admin login failed: {e}")

ADMIN_ID = admin_user["id"] if admin_user else None

# ══════════════════════════════════════════════════════════════════
# 1. SPOT PHOTO EDITING (HIGHEST PRIORITY)
# ══════════════════════════════════════════════════════════════════
section("1. Spot Photo Editing — /spot/edit/preview & /spot/edit/save")

owner_email = fresh_email("owner")
other_email = fresh_email("other")
owner_token = other_token = None
owner_id = other_id = None

try:
    owner_token, ouser = register("Maya Patel", owner_email, "StrongPass99!")
    owner_id = ouser["id"]
    ok(f"Owner registered id={owner_id}")
except Exception as e:
    bad(f"Owner register failed: {e}")

try:
    other_token, xuser = register("Ryan Chen", other_email, "AnotherPwd88!")
    other_id = xuser["id"]
    ok(f"Other registered id={other_id}")
except Exception as e:
    bad(f"Other register failed: {e}")

entry_id = None
target = "leaf"
if owner_token:
    try:
        r = requests.get(f"{BASE}/spot/object", headers=h(owner_token), timeout=30)
        if r.status_code == 200:
            target = r.json().get("object") or "leaf"
            ok(f"/spot/object → 200 target={target!r}")
        else:
            bad(f"/spot/object → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"/spot/object failed: {e}")

    try:
        photo = make_tiny_jpeg_b64()
        r = requests.post(f"{BASE}/spot/complete", headers=h(owner_token), json={
            "target_object": target,
            "photo_base64": photo,
            "success": True,
            "remaining_seconds": 0,
            "mode": "solo_constant",
        }, timeout=30)
        if r.status_code == 200:
            d = r.json()
            entry_id = (d.get("entry") or {}).get("id")
            if entry_id:
                ok(f"/spot/complete → 200 entry_id={entry_id}")
            else:
                bad(f"/spot/complete 200 but no entry_id: {d}")
        else:
            bad(f"/spot/complete → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"/spot/complete failed: {e}")
        traceback.print_exc()

preview_results = {}
if entry_id and owner_token:
    for flt in ["painting", "bw", "auto"]:
        try:
            r = requests.post(f"{BASE}/spot/edit/preview", headers=h(owner_token), json={
                "entry_id": entry_id, "filter": flt,
            }, timeout=60)
            if r.status_code != 200:
                bad(f"/spot/edit/preview {flt} → {r.status_code} {r.text[:200]}")
                continue
            b64 = r.json().get("edited_base64")
            if not b64:
                bad(f"/spot/edit/preview {flt}: no edited_base64")
                continue
            if is_valid_jpeg_b64(b64):
                ok(f"/spot/edit/preview filter={flt} → valid JPEG ({len(b64)} b64 chars)")
                preview_results[flt] = b64
            else:
                bad(f"/spot/edit/preview {flt}: base64 not a valid JPEG")
        except Exception as e:
            bad(f"/spot/edit/preview {flt} failed: {e}")

if entry_id and owner_token and "auto" in preview_results:
    saved_b64 = preview_results["auto"]
    try:
        r = requests.post(f"{BASE}/spot/edit/save", headers=h(owner_token), json={
            "entry_id": entry_id, "edited_base64": saved_b64,
        }, timeout=30)
        if r.status_code == 200 and r.json().get("ok") is True:
            ok("/spot/edit/save owner → 200 {ok:true}")
        else:
            bad(f"/spot/edit/save → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"/spot/edit/save failed: {e}")

    try:
        r = requests.get(f"{BASE}/spot/{entry_id}", headers=h(owner_token), timeout=30)
        if r.status_code == 200:
            d = r.json()
            if d.get("photo_base64") == saved_b64:
                ok("GET /spot/{id}.photo_base64 == saved edited_base64")
            else:
                bad(f"photo_base64 mismatch (stored_len={len(d.get('photo_base64') or '')}, saved_len={len(saved_b64)})")
            if d.get("edited_at"):
                ok(f"GET /spot/{{id}}.edited_at set ({d['edited_at']})")
            else:
                bad("GET /spot/{id}.edited_at NOT set")
        else:
            bad(f"GET /spot/{{id}} → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"GET /spot/{{id}} failed: {e}")

# 1e: Other cannot preview → 403
if entry_id and other_token:
    try:
        r = requests.post(f"{BASE}/spot/edit/preview", headers=h(other_token), json={
            "entry_id": entry_id, "filter": "bw",
        }, timeout=30)
        if r.status_code == 403:
            ok("Other /spot/edit/preview on owner entry → 403")
        else:
            bad(f"Other preview → {r.status_code} expected 403")
    except Exception as e:
        bad(f"Other preview failed: {e}")

# 1f: Other cannot save → 403
if entry_id and other_token and "bw" in preview_results:
    try:
        r = requests.post(f"{BASE}/spot/edit/save", headers=h(other_token), json={
            "entry_id": entry_id, "edited_base64": preview_results["bw"],
        }, timeout=30)
        if r.status_code == 403:
            ok("Other /spot/edit/save on owner entry → 403")
        else:
            bad(f"Other save → {r.status_code} expected 403")
    except Exception as e:
        bad(f"Other save failed: {e}")

# 1g: Bogus id preview → 404
if owner_token:
    try:
        r = requests.post(f"{BASE}/spot/edit/preview", headers=h(owner_token), json={
            "entry_id": "does-not-exist", "filter": "painting",
        }, timeout=30)
        if r.status_code == 404:
            ok("/spot/edit/preview bogus id → 404")
        else:
            bad(f"/spot/edit/preview bogus → {r.status_code} expected 404")
    except Exception as e:
        bad(f"bogus preview failed: {e}")

# 1h: Bogus id save → 404
if owner_token:
    try:
        r = requests.post(f"{BASE}/spot/edit/save", headers=h(owner_token), json={
            "entry_id": "does-not-exist", "edited_base64": "xxx",
        }, timeout=30)
        if r.status_code == 404:
            ok("/spot/edit/save bogus id → 404")
        else:
            bad(f"/spot/edit/save bogus → {r.status_code} expected 404")
    except Exception as e:
        bad(f"bogus save failed: {e}")

# 1i: Invalid filter → 422
if owner_token and entry_id:
    try:
        r = requests.post(f"{BASE}/spot/edit/preview", headers=h(owner_token), json={
            "entry_id": entry_id, "filter": "sepia",
        }, timeout=30)
        if r.status_code == 422:
            ok("/spot/edit/preview filter='sepia' → 422 (Pydantic Literal)")
        else:
            bad(f"/spot/edit/preview filter=sepia → {r.status_code} expected 422")
    except Exception as e:
        bad(f"invalid filter failed: {e}")

# 1j: Empty save → 400
if owner_token and entry_id:
    try:
        r = requests.post(f"{BASE}/spot/edit/save", headers=h(owner_token), json={
            "entry_id": entry_id, "edited_base64": "",
        }, timeout=30)
        if r.status_code == 400:
            ok("/spot/edit/save empty → 400")
        else:
            bad(f"/spot/edit/save empty → {r.status_code} expected 400")
    except Exception as e:
        bad(f"empty save failed: {e}")

# 1k: >12M save → 400
if owner_token and entry_id:
    try:
        big = "A" * 12_000_001
        r = requests.post(f"{BASE}/spot/edit/save", headers=h(owner_token), json={
            "entry_id": entry_id, "edited_base64": big,
        }, timeout=60)
        if r.status_code == 400:
            ok("/spot/edit/save >12M → 400")
        else:
            bad(f"/spot/edit/save >12M → {r.status_code} expected 400")
    except Exception as e:
        bad(f"big save failed: {e}")


# ══════════════════════════════════════════════════════════════════
# 2. SPOT VISION CHECK regression
# ══════════════════════════════════════════════════════════════════
section("2. Spot Vision Check — /spot/object + /spot/check regression")

if owner_token:
    try:
        r = requests.get(f"{BASE}/spot/object", headers=h(owner_token), timeout=30)
        if r.status_code == 200 and r.json().get("object") and r.json().get("challenge_id"):
            ok("/spot/object → 200 with {object, challenge_id}")
        else:
            bad(f"/spot/object → {r.status_code}")
    except Exception as e:
        bad(f"/spot/object failed: {e}")

    try:
        r = requests.post(f"{BASE}/spot/check", headers=h(owner_token), json={
            "target_object": "leaf", "photo_base64": "",
        }, timeout=30)
        if r.status_code == 400:
            ok("/spot/check empty photo → 400")
        else:
            bad(f"/spot/check empty → {r.status_code} expected 400")
    except Exception as e:
        bad(f"/spot/check empty failed: {e}")

    try:
        leaf_b64 = download_loremflickr("leaf", 320, 240)
        r = requests.post(f"{BASE}/spot/check", headers=h(owner_token), json={
            "target_object": "leaf", "photo_base64": leaf_b64,
        }, timeout=60)
        if r.status_code == 200:
            d = r.json()
            required = {"detected", "confidence", "reason", "distance", "can_capture"}
            if required.issubset(d.keys()):
                ok(f"/spot/check leaf/leaf → shape OK detected={d['detected']} conf={d['confidence']}")
            else:
                bad(f"/spot/check leaf keys missing: {list(d.keys())}")
            if bool(d.get("can_capture")) == bool(d.get("detected") and d.get("confidence", 0) >= 0.55):
                ok("/spot/check can_capture invariant holds")
            else:
                bad(f"/spot/check invariant BROKEN: {d}")
        else:
            bad(f"/spot/check → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"/spot/check leaf failed: {e}")

    try:
        leaf_b64 = download_loremflickr("leaf", 320, 240)
        r = requests.post(f"{BASE}/spot/check", headers=h(owner_token), json={
            "target_object": "chair", "photo_base64": leaf_b64,
        }, timeout=60)
        if r.status_code == 200:
            d = r.json()
            if {"detected", "confidence", "can_capture"}.issubset(d.keys()):
                ok(f"/spot/check chair/leaf shape OK detected={d['detected']} conf={d['confidence']}")
            else:
                bad(f"/spot/check chair/leaf shape bad: {d}")
        else:
            bad(f"/spot/check chair/leaf → {r.status_code}")
    except Exception as e:
        bad(f"/spot/check chair/leaf failed: {e}")


# ══════════════════════════════════════════════════════════════════
# 3. LEADERBOARD ADMIN DISPLAY
# ══════════════════════════════════════════════════════════════════
section("3. Leaderboard Admin Display (is_admin_view / level=999)")

B_email = fresh_email("lbB")
B_token = None
B_id = None
try:
    B_token, B_u = register("Priya Sharma", B_email, "LeaderboardB22!")
    B_id = B_u["id"]
    ok(f"B registered id={B_id}")
except Exception as e:
    bad(f"B register failed: {e}")

if B_token and ADMIN_ID and admin_token:
    try:
        r = requests.post(f"{BASE}/friends/request", headers=h(B_token), json={"user_id": ADMIN_ID}, timeout=30)
        if r.status_code == 200:
            ok("B→admin /friends/request → 200")
        else:
            bad(f"B→admin request → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"friend request failed: {e}")

    try:
        r = requests.post(f"{BASE}/friends/accept", headers=h(admin_token), json={"user_id": B_id}, timeout=30)
        if r.status_code == 200:
            ok("admin accepts B → 200")
        else:
            bad(f"admin accept → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"accept failed: {e}")

if B_token:
    try:
        r = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=h(B_token), timeout=30)
        if r.status_code == 200:
            d = r.json()
            rows = d.get("rows", [])
            if len(rows) >= 2:
                ok(f"B leaderboard rows={len(rows)}")
            else:
                bad(f"B leaderboard rows={len(rows)} (expected >=2)")

            admin_row = next((x for x in rows if x.get("user_id") == ADMIN_ID), None)
            self_row = next((x for x in rows if x.get("user_id") == B_id), None)

            if admin_row:
                if admin_row.get("name") == "Admin · Creator":
                    ok("Admin row name == 'Admin · Creator'")
                else:
                    bad(f"Admin row name → {admin_row.get('name')!r}")
                if admin_row.get("level") == 999:
                    ok("Admin row level == 999")
                else:
                    bad(f"Admin row level → {admin_row.get('level')}")
                if admin_row.get("total_xp") == -1:
                    ok("Admin row total_xp == -1")
                else:
                    bad(f"Admin row total_xp → {admin_row.get('total_xp')}")
                if admin_row.get("is_admin") is True:
                    ok("Admin row is_admin=true")
                else:
                    bad(f"Admin row is_admin → {admin_row.get('is_admin')}")
                if admin_row.get("is_admin_view") is True:
                    ok("Admin row is_admin_view=true")
                else:
                    bad(f"Admin row is_admin_view → {admin_row.get('is_admin_view')}")
            else:
                bad(f"Admin row missing from B lb; ids={[x.get('user_id') for x in rows]}")

            if self_row:
                if self_row.get("is_admin") is False:
                    ok("B self is_admin=false")
                else:
                    bad(f"B self is_admin → {self_row.get('is_admin')}")
                if self_row.get("is_admin_view") is False:
                    ok("B self is_admin_view=false")
                else:
                    bad(f"B self is_admin_view → {self_row.get('is_admin_view')}")
                if isinstance(self_row.get("level"), int) and self_row.get("level") < 999:
                    ok(f"B self level is real ({self_row.get('level')})")
                else:
                    bad(f"B self level → {self_row.get('level')}")
            else:
                bad("B self row missing")
        else:
            bad(f"B leaderboard → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"B leaderboard failed: {e}")

if admin_token:
    try:
        r = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=h(admin_token), timeout=30)
        if r.status_code == 200:
            rows = r.json().get("rows", [])
            admin_self = next((x for x in rows if x.get("user_id") == ADMIN_ID), None)
            if admin_self:
                if admin_self.get("is_admin_view") is False:
                    ok("Admin self-view is_admin_view=false")
                else:
                    bad(f"Admin self-view is_admin_view → {admin_self.get('is_admin_view')}")
                if admin_self.get("level") != 999:
                    ok(f"Admin self-view level is real ({admin_self.get('level')})")
                else:
                    bad("Admin self-view level == 999 (should be real)")
                if admin_self.get("total_xp") != -1:
                    ok(f"Admin self-view total_xp real ({admin_self.get('total_xp')})")
                else:
                    bad("Admin self-view total_xp == -1")
                ok(f"Admin self-view name={admin_self.get('name')!r}")
            else:
                bad("Admin self row missing from admin lb")
        else:
            bad(f"Admin lb → {r.status_code}")
    except Exception as e:
        bad(f"Admin lb failed: {e}")


# ══════════════════════════════════════════════════════════════════
# 4. PUSH TOKEN
# ══════════════════════════════════════════════════════════════════
section("4. /push/register-token")

if owner_token:
    token_str = "ExponentPushToken[testtest]"
    try:
        r = requests.post(f"{BASE}/push/register-token", headers=h(owner_token), json={
            "token": token_str, "platform": "android",
        }, timeout=30)
        if r.status_code == 200:
            d = r.json()
            if d.get("ok") is True:
                ok("/push/register-token first → 200 ok:true")
            else:
                bad(f"/push/register-token first missing ok: {d}")
            for key in ("matched", "modified", "upserted"):
                if key in d:
                    ok(f"response has {key}={d[key]}")
                else:
                    bad(f"response missing {key}")
        else:
            bad(f"/push/register-token first → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"push first failed: {e}")

    try:
        r = requests.post(f"{BASE}/push/register-token", headers=h(owner_token), json={
            "token": token_str, "platform": "android",
        }, timeout=30)
        if r.status_code == 200:
            d = r.json()
            if d.get("upserted") is False:
                ok("2nd call upserted=false")
            else:
                bad(f"2nd call upserted → {d.get('upserted')}")
            if d.get("matched", 0) >= 1:
                ok(f"2nd call matched={d.get('matched')}")
            else:
                bad(f"2nd call matched → {d.get('matched')}")
        else:
            bad(f"2nd call → {r.status_code}")
    except Exception as e:
        bad(f"push 2nd failed: {e}")

    try:
        r = requests.post(f"{BASE}/push/register-token", headers=h(owner_token), json={
            "token": "", "platform": "android",
        }, timeout=30)
        if r.status_code == 400:
            ok("/push/register-token empty → 400")
        else:
            bad(f"/push/register-token empty → {r.status_code}")
    except Exception as e:
        bad(f"empty push failed: {e}")

try:
    r = requests.post(f"{BASE}/push/register-token", json={
        "token": "ExponentPushToken[anonanon]", "platform": "ios",
    }, headers={"Content-Type": "application/json"}, timeout=30)
    if r.status_code == 200 and r.json().get("ok") is True:
        ok("/push/register-token anonymous → 200 (legacy main)")
    else:
        bad(f"anon push → {r.status_code} {r.text[:200]}")
except Exception as e:
    bad(f"anon push failed: {e}")


# ══════════════════════════════════════════════════════════════════
# 5. DEBUG ENDPOINT
# ══════════════════════════════════════════════════════════════════
section("5. /debug/health-connect-error")

if owner_token:
    try:
        r = requests.post(f"{BASE}/debug/health-connect-error", headers=h(owner_token), json={
            "stage": "initialize", "message": "test", "platform": "android", "os_version": "35",
        }, timeout=30)
        if r.status_code == 200 and r.json().get("ok") is True:
            ok("/debug/health-connect-error authed → 200 ok:true")
        else:
            bad(f"HC authed → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"HC authed failed: {e}")

    try:
        r = requests.post(f"{BASE}/debug/health-connect-error", headers=h(owner_token), json={
            "stage": "availability",
        }, timeout=30)
        if r.status_code == 200:
            ok("HC (only stage, no extra) → 200")
        else:
            bad(f"HC minimal → {r.status_code} {r.text[:200]}")
    except Exception as e:
        bad(f"HC minimal failed: {e}")

try:
    r = requests.post(f"{BASE}/debug/health-connect-error", headers={"Content-Type": "application/json"}, json={
        "stage": "anon_check", "message": "hello",
    }, timeout=30)
    if r.status_code == 200 and r.json().get("ok") is True:
        ok("HC anonymous → 200 ok:true")
    else:
        bad(f"HC anon → {r.status_code} {r.text[:200]}")
except Exception as e:
    bad(f"HC anon failed: {e}")


# ══════════════════════════════════════════════════════════════════
# REGRESSION
# ══════════════════════════════════════════════════════════════════
section("R. Regression smoke")

reg_email = fresh_email("reg")
try:
    r = requests.post(f"{BASE}/auth/register", json={
        "full_name": "Regression Rita", "email": reg_email, "password": "RegPass1234!",
    }, timeout=30)
    if r.status_code == 200 and r.json().get("token"):
        ok("/auth/register (gmail) → 200 + token")
    else:
        bad(f"/auth/register → {r.status_code}")
except Exception as e:
    bad(f"auth/register regression failed: {e}")

try:
    r = requests.post(f"{BASE}/auth/login", json={
        "email": ADMIN_EMAIL, "password": ADMIN_PASSWORD,
    }, timeout=30)
    if r.status_code == 200 and r.json().get("token"):
        ok("/auth/login admin → 200")
    else:
        bad(f"/auth/login admin → {r.status_code}")
except Exception as e:
    bad(f"admin login regression failed: {e}")

if owner_token:
    try:
        r = requests.get(f"{BASE}/profile", headers=h(owner_token), timeout=30)
        if r.status_code == 200 and r.json().get("name"):
            ok("/profile (JWT) → 200")
        else:
            bad(f"/profile → {r.status_code}")
    except Exception as e:
        bad(f"/profile failed: {e}")

if owner_token:
    try:
        r = requests.get(f"{BASE}/spot/feed?limit=50", headers=h(owner_token), timeout=30)
        if r.status_code == 200 and "entries" in r.json():
            ok(f"/spot/feed → 200 entries={len(r.json()['entries'])}")
        else:
            bad(f"/spot/feed → {r.status_code}")
    except Exception as e:
        bad(f"/spot/feed failed: {e}")

if B_token:
    try:
        r = requests.get(f"{BASE}/friends/list", headers=h(B_token), timeout=30)
        if r.status_code == 200:
            body = r.json()
            if isinstance(body, list) or (isinstance(body, dict) and isinstance(body.get("friends"), list)):
                ok("/friends/list → 200 (list)")
            else:
                bad(f"/friends/list shape unexpected: {type(body).__name__}")
        else:
            bad(f"/friends/list → {r.status_code}")
    except Exception as e:
        bad(f"/friends/list failed: {e}")


print(f"\n==================== {PASSES} passed / {FAILS} failed ====================")
sys.exit(0 if FAILS == 0 else 1)
