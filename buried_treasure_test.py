"""
v1.0.29 Buried Treasure — Phase 1 backend test
Tests all 23 assertions from the brief in test_result.md.
"""
import math
import os
import time
import uuid as _uuid

import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"

ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

results = []  # list of (label, passed:bool, detail:str)


def record(label, passed, detail=""):
    results.append((label, bool(passed), detail))
    status = "PASS" if passed else "FAIL"
    print(f"[{status}] {label}{' — ' + detail if detail else ''}")


def assert_eq(label, actual, expected):
    record(label, actual == expected, f"actual={actual!r} expected={expected!r}")


def assert_true(label, cond, detail=""):
    record(label, bool(cond), detail)


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6_371_000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def register_user(name, email, password):
    r = requests.post(
        f"{BASE}/auth/register",
        json={"email": email, "password": password, "full_name": name},
        timeout=30,
    )
    if r.status_code != 200:
        print("register failed:", r.status_code, r.text[:200])
    r.raise_for_status()
    body = r.json()
    return body["token"], body["user"]["user_id"] if "user_id" in body["user"] else body["user"].get("id") or body["user"].get("_id")


def login(email, password):
    r = requests.post(
        f"{BASE}/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    user = body["user"]
    uid = user.get("user_id") or user.get("id") or user.get("_id")
    return body["token"], uid


def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


def main():
    # (1) Register fresh user A + admin login
    suffix = _uuid.uuid4().hex[:10]
    a_email = f"buried.hunter.{suffix}@gmail.com"
    a_pass = "BTreasureHunter#2026"
    a_name = "Bria Treasury"
    a_token, a_user_id = register_user(a_name, a_email, a_pass)
    record("(1) register fresh user A", bool(a_user_id), f"user_id={a_user_id}")

    admin_token, admin_user_id = login(ADMIN_EMAIL, ADMIN_PASSWORD)
    record("(1) admin login", bool(admin_user_id), f"admin_id={admin_user_id}")

    h_a = auth_headers(a_token)
    h_admin = auth_headers(admin_token)

    # (2) GET /bt/location → 200 {location:null}
    r = requests.get(f"{BASE}/bt/location", headers=h_a, timeout=30)
    record("(2) GET /bt/location → 200", r.status_code == 200, f"status={r.status_code}")
    j = r.json() if r.status_code == 200 else {}
    record("(2) location == null", j.get("location") is None, f"got={j}")

    # (3) GET /bt/chest/today → 400 (no area set)
    r = requests.get(f"{BASE}/bt/chest/today", headers=h_a, timeout=30)
    record("(3) chest/today before area → 400", r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")

    # (4) POST /bt/location Brisbane radius 5000
    body4 = {"lat": -27.4698, "lng": 153.0251, "radius_m": 5000, "label": "Brisbane", "tz_offset_minutes": 600}
    r = requests.post(f"{BASE}/bt/location", json=body4, headers=h_a, timeout=30)
    record("(4) POST /bt/location → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    record("(4) saved:true", r.json().get("saved") is True if r.status_code == 200 else False)

    # (5) GET /bt/location → 200 with fields back
    r = requests.get(f"{BASE}/bt/location", headers=h_a, timeout=30)
    loc = (r.json() or {}).get("location") if r.status_code == 200 else None
    ok = bool(loc) and abs(loc.get("lat", 0) - (-27.4698)) < 1e-6 and abs(loc.get("lng", 0) - 153.0251) < 1e-6 and int(loc.get("radius_m", 0)) == 5000 and loc.get("label") == "Brisbane"
    record("(5) GET /bt/location returns saved fields", ok, f"loc={loc}")

    # (6) lat=200 out of range → 400
    r = requests.post(f"{BASE}/bt/location", json={"lat": 200, "lng": 0, "radius_m": 5000}, headers=h_a, timeout=30)
    record("(6) lat=200 → 400 out of range", r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")

    # (7) radius too small → 400
    r = requests.post(f"{BASE}/bt/location", json={"lat": 0, "lng": 0, "radius_m": 50}, headers=h_a, timeout=30)
    record("(7) radius_m=50 → 400 (below MIN)", r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")

    # (8) radius too large → 400
    r = requests.post(f"{BASE}/bt/location", json={"lat": 0, "lng": 0, "radius_m": 50000}, headers=h_a, timeout=30)
    record("(8) radius_m=50000 → 400 (above MAX)", r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")

    # (9) GET /bt/chest/today → 200 with required chest fields. OSM may be slow
    r = requests.get(f"{BASE}/bt/chest/today", headers=h_a, timeout=60)
    record("(9) chest/today → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:300]}")
    chest = (r.json() or {}).get("chest") if r.status_code == 200 else None
    record("(9) chest dict present", isinstance(chest, dict), f"chest={chest}")
    if isinstance(chest, dict):
        cid = chest.get("id")
        record("(9) chest.id non-empty", bool(cid), f"id={cid}")
        record("(9) chest.date non-empty", bool(chest.get("date")), f"date={chest.get('date')}")
        c_lat = chest.get("lat")
        c_lng = chest.get("lng")
        record("(9) chest.lat/lng numeric", isinstance(c_lat, (int, float)) and isinstance(c_lng, (int, float)))
        # Inside the 5000m circle of Brisbane centre
        if isinstance(c_lat, (int, float)) and isinstance(c_lng, (int, float)):
            d = haversine_m(-27.4698, 153.0251, c_lat, c_lng)
            record("(9) chest inside coverage circle (≤5000m)", d <= 5001.0, f"dist_m={int(d)}")
        record("(9) chest.hint non-empty", bool(chest.get("hint")), f"hint={chest.get('hint')}")
        record("(9) spawn_source ∈ {osm_park, fallback_random}", chest.get("spawn_source") in ("osm_park", "fallback_random"), f"spawn_source={chest.get('spawn_source')}")
        record("(9) chest.status == 'hidden'", chest.get("status") == "hidden", f"status={chest.get('status')}")
        record("(9) chest.daylight_only == False", chest.get("daylight_only") is False, f"daylight_only={chest.get('daylight_only')}")
        chest_id_saved = cid
        chest_lat_saved = c_lat
        chest_lng_saved = c_lng
    else:
        chest_id_saved = None
        chest_lat_saved = None
        chest_lng_saved = None

    # (10) GET again → same chest_id
    r = requests.get(f"{BASE}/bt/chest/today", headers=h_a, timeout=30)
    c2 = (r.json() or {}).get("chest") if r.status_code == 200 else None
    same = isinstance(c2, dict) and c2.get("id") == chest_id_saved
    record("(10) chest idempotent (same id on 2nd call)", same, f"id2={c2.get('id') if c2 else None}")

    # (11) POST /bt/chest/find with far coords → 400 'Still NNNN m away…'
    r = requests.post(f"{BASE}/bt/chest/find", json={"lat": -90, "lng": 90}, headers=h_a, timeout=30)
    record("(11) find from far away → 400", r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")
    detail = ""
    try:
        detail = (r.json() or {}).get("detail", "")
    except Exception:
        detail = r.text
    record("(11) detail contains 'away'", "away" in (detail or "").lower(), f"detail={detail!r}")

    # Profile total_xp before find — capture
    pre_xp = None
    try:
        rp = requests.get(f"{BASE}/profile", headers=h_a, timeout=30)
        if rp.status_code == 200:
            pre_xp = (rp.json() or {}).get("total_xp")
    except Exception:
        pre_xp = None

    # (12) POST /bt/chest/find {chest.lat, chest.lng} → 200 found + xp_awarded:50
    if chest_lat_saved is not None and chest_lng_saved is not None:
        r = requests.post(
            f"{BASE}/bt/chest/find",
            json={"lat": chest_lat_saved, "lng": chest_lng_saved},
            headers=h_a,
            timeout=30,
        )
        record("(12) find with exact coords → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
        if r.status_code == 200:
            jj = r.json() or {}
            ch = jj.get("chest") or {}
            record("(12) chest.status == 'found'", ch.get("status") == "found", f"status={ch.get('status')}")
            record("(12) xp_awarded == 50", jj.get("xp_awarded") == 50, f"xp_awarded={jj.get('xp_awarded')}")
            # profile total_xp +50
            try:
                rp = requests.get(f"{BASE}/profile", headers=h_a, timeout=30)
                new_xp = (rp.json() or {}).get("total_xp") if rp.status_code == 200 else None
                if pre_xp is not None and new_xp is not None:
                    record("(12) profile.total_xp delta == +50", (new_xp - pre_xp) == 50, f"pre={pre_xp} new={new_xp}")
                else:
                    record("(12) profile.total_xp delta == +50", False, f"pre={pre_xp} new={new_xp}")
            except Exception as e:
                record("(12) profile.total_xp delta == +50", False, f"err={e!r}")
    else:
        record("(12) find with exact coords → 200", False, "no chest captured in step 9")

    # (13) find again → already_found:true
    if chest_lat_saved is not None and chest_lng_saved is not None:
        r = requests.post(
            f"{BASE}/bt/chest/find",
            json={"lat": chest_lat_saved, "lng": chest_lng_saved},
            headers=h_a,
            timeout=30,
        )
        record("(13) find again → 200 already_found:true", r.status_code == 200 and (r.json() or {}).get("already_found") is True, f"status={r.status_code} body={r.text[:200]}")
    else:
        record("(13) find again → 200 already_found:true", False, "no chest")

    # (14) GET /bt/finds → 1 row with chest_id, lat, lng, found_at, has_photo:false
    r = requests.get(f"{BASE}/bt/finds", headers=h_a, timeout=30)
    finds = (r.json() or {}).get("finds") if r.status_code == 200 else None
    record("(14) GET /bt/finds → 200 list", r.status_code == 200 and isinstance(finds, list), f"status={r.status_code}")
    if isinstance(finds, list) and finds:
        row = finds[0]
        ok = (
            bool(row.get("chest_id"))
            and isinstance(row.get("lat"), (int, float))
            and isinstance(row.get("lng"), (int, float))
            and bool(row.get("found_at"))
            and row.get("has_photo") is False
        )
        record("(14) finds[0] has required shape", ok, f"row keys={list(row.keys())} has_photo={row.get('has_photo')}")
    else:
        record("(14) finds[0] has required shape", False, f"finds={finds}")

    # (15) POST /bt/settings daylight_only:true → GET → true
    r = requests.post(f"{BASE}/bt/settings", json={"daylight_only": True}, headers=h_a, timeout=30)
    record("(15) POST /bt/settings → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    r = requests.get(f"{BASE}/bt/settings", headers=h_a, timeout=30)
    val = (((r.json() or {}).get("settings") or {}).get("daylight_only"))
    record("(15) GET /bt/settings.daylight_only == True", val is True, f"value={val}")

    # (16) POST /bt/no-go-zones with 3-pt polygon → 200 with id; GET → 1 zone
    polygon = [
        {"lat": -27.46, "lng": 153.02},
        {"lat": -27.46, "lng": 153.03},
        {"lat": -27.47, "lng": 153.025},
    ]
    r = requests.post(
        f"{BASE}/bt/no-go-zones",
        json={"name": "School", "polygon": polygon},
        headers=h_a,
        timeout=30,
    )
    record("(16) POST /bt/no-go-zones → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    zone_id = (r.json() or {}).get("id") if r.status_code == 200 else None
    record("(16) zone id returned", bool(zone_id), f"zone_id={zone_id}")
    r = requests.get(f"{BASE}/bt/no-go-zones", headers=h_a, timeout=30)
    zones = (r.json() or {}).get("zones") if r.status_code == 200 else None
    record("(16) GET /bt/no-go-zones has 1 zone", isinstance(zones, list) and len(zones) == 1, f"zones_count={len(zones) if isinstance(zones, list) else None}")

    # (17) POST /bt/no-go-zones with 1-point polygon → 400
    r = requests.post(
        f"{BASE}/bt/no-go-zones",
        json={"polygon": [{"lat": 1, "lng": 1}]},
        headers=h_a,
        timeout=30,
    )
    record("(17) polygon<3 → 400", r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")

    # (18) DELETE /bt/no-go-zones/{zone_id} → 200 deleted:1; GET → empty
    if zone_id:
        r = requests.delete(f"{BASE}/bt/no-go-zones/{zone_id}", headers=h_a, timeout=30)
        record("(18) DELETE /bt/no-go-zones/{id} → 200 deleted:1", r.status_code == 200 and (r.json() or {}).get("deleted") == 1, f"status={r.status_code} body={r.text[:200]}")
        r = requests.get(f"{BASE}/bt/no-go-zones", headers=h_a, timeout=30)
        zones = (r.json() or {}).get("zones") if r.status_code == 200 else None
        record("(18) zones empty after delete", isinstance(zones, list) and len(zones) == 0, f"zones={zones}")
    else:
        record("(18) DELETE /bt/no-go-zones/{id} → 200 deleted:1", False, "no zone_id")
        record("(18) zones empty after delete", False, "no zone_id")

    # (19) POST /bt/report kind:object → 200 with id + sent_to_admin_count:1
    r = requests.post(
        f"{BASE}/bt/report",
        json={"kind": "object", "message": "Chest was fenced off behind private property."},
        headers=h_a,
        timeout=30,
    )
    record("(19) POST /bt/report kind=object → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:300]}")
    rep = r.json() if r.status_code == 200 else {}
    record("(19) report id returned", bool(rep.get("id")), f"id={rep.get('id')}")
    record("(19) sent_to_admin_count == 1", rep.get("sent_to_admin_count") == 1, f"count={rep.get('sent_to_admin_count')}")

    # (20) Admin GET /messages/thread/{A.user_id} → sees DM
    # Give the DB a tiny moment for index/flush
    time.sleep(0.5)
    r = requests.get(f"{BASE}/messages/thread/{a_user_id}", headers=h_admin, timeout=30)
    record("(20) Admin GET /messages/thread/{A} → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    msgs = (r.json() or {}).get("messages") if r.status_code == 200 else []
    # Look for the BT report message
    found_dm = False
    for m in msgs or []:
        text = (m.get("text") or m.get("refined_text") or m.get("original_text") or "")
        if "Buried Treasure report" in text and "fenced" in text.lower():
            found_dm = True
            break
    record("(20) admin sees BT report DM in thread", found_dm, f"thread_size={len(msgs or [])}")

    # (21) POST /bt/report kind:'invalid' → 400
    r = requests.post(
        f"{BASE}/bt/report",
        json={"kind": "invalid", "message": "x"},
        headers=h_a,
        timeout=30,
    )
    record("(21) POST /bt/report kind=invalid → 400", r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")

    # (22) POST /bt/report kind:'object' message:'' (no other field) → 400
    r = requests.post(
        f"{BASE}/bt/report",
        json={"kind": "object", "message": ""},
        headers=h_a,
        timeout=30,
    )
    record("(22) POST /bt/report empty → 400", r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")

    # (23) Regression /library/pricing still OK (all 4 apps + duo_offer + has_override)
    r = requests.get(f"{BASE}/library/pricing", headers=h_a, timeout=30)
    record("(23) GET /library/pricing → 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        pricing = (r.json() or {}).get("pricing") or {}
        expected_apps = {"sleep", "challenges", "spot", "confidence"}
        record("(23) /library/pricing has all 4 apps", set(pricing.keys()) >= expected_apps, f"keys={list(pricing.keys())}")
        all_have_fields = True
        missing = []
        for aid in expected_apps:
            ap = pricing.get(aid, {})
            if "duo_offer" not in ap or "has_override" not in ap:
                all_have_fields = False
                missing.append(aid)
        record("(23) every app has duo_offer + has_override keys", all_have_fields, f"missing={missing}")

    # ---- Summary ----
    total = len(results)
    passed = sum(1 for _, p, _ in results if p)
    print(f"\n=== TOTAL: {passed}/{total} PASS ===")
    failed = [(lbl, dt) for lbl, p, dt in results if not p]
    if failed:
        print("\nFAILED:")
        for lbl, dt in failed:
            print(f"  - {lbl} :: {dt}")
    return passed, total


if __name__ == "__main__":
    main()
