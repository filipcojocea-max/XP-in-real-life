"""
Tests for: Feedback → Admin notifications
POST /api/feedback should insert a row into db.admin_reports so it surfaces
in the Creator's notification bell + /admin/reports inbox.

Public ingress base: https://xp-confidence.preview.emergentagent.com/api
"""
import os
import sys
import time
import uuid
import json
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASS = "XL98CZW5599"

PASS = []
FAIL = []


def _assert(cond, msg):
    if cond:
        PASS.append(msg)
        print(f"  PASS: {msg}")
    else:
        FAIL.append(msg)
        print(f"  FAIL: {msg}")


def section(name):
    print(f"\n=== {name} ===")


def reg_user(name, email_prefix):
    email = f"{email_prefix}+{uuid.uuid4().hex[:8]}@gmail.com"
    pw = "TestPass123!"
    r = requests.post(f"{BASE}/auth/register", json={
        "full_name": name, "email": email, "password": pw,
    }, timeout=30)
    if r.status_code != 200:
        print(f"register {email} failed: {r.status_code} {r.text}")
        sys.exit(1)
    body = r.json()
    token = body.get("token") or body.get("access_token")
    user = body.get("user") or {}
    user_id = user.get("id") or user.get("user_id")
    print(f"  Registered {email} → user_id={user_id}")
    return {"email": email, "name": name, "password": pw, "token": token, "user_id": user_id}


def admin_login():
    r = requests.post(f"{BASE}/auth/login", json={
        "email": ADMIN_EMAIL, "password": ADMIN_PASS,
    }, timeout=30)
    if r.status_code != 200:
        print(f"admin login failed: {r.status_code} {r.text}")
        sys.exit(1)
    body = r.json()
    return body.get("token") or body.get("access_token")


def admin_get_reports(admin_token):
    r = requests.get(f"{BASE}/admin/reports",
                     headers={"Authorization": f"Bearer {admin_token}"},
                     timeout=30)
    return r


def find_feedback_rows_for(reports, user_id):
    return [r for r in reports if r.get("kind") == "feedback" and r.get("reported_user_id") == user_id]


def main():
    print(f"BASE = {BASE}")

    # ── Step 1
    section("Step 1: Register user A and POST /feedback (rating=5)")
    A = reg_user("Maya Patel", "maya.patel")
    headers_A = {"Authorization": f"Bearer {A['token']}"}

    payload1 = {"rating": 5, "text": "Love this app, please add dark theme",
                "level_at_submit": 3, "platform": "ios"}
    r = requests.post(f"{BASE}/feedback", json=payload1, headers=headers_A, timeout=30)
    _assert(r.status_code == 200, f"POST /feedback (5 stars) → 200 (got {r.status_code})")
    body1 = r.json() if r.status_code == 200 else {}
    _assert(body1.get("saved") is True, f"response.saved == True (got {body1.get('saved')})")
    fb1_id = body1.get("id")
    _assert(isinstance(fb1_id, str) and len(fb1_id) >= 8, f"response.id is uuid-like (got {fb1_id})")

    # ── Step 2
    section("Step 2: Admin login + GET /admin/reports")
    admin_token = admin_login()
    print(f"  admin token acquired (len={len(admin_token)})")
    r = admin_get_reports(admin_token)
    _assert(r.status_code == 200, f"GET /admin/reports as admin → 200 (got {r.status_code})")
    body = r.json() if r.status_code == 200 else {}
    reports = body.get("reports", [])
    _assert(isinstance(reports, list), f"reports is list (got {type(reports).__name__})")
    nc1 = body.get("new_count", 0)
    print(f"  total reports in inbox: {len(reports)}, new_count: {nc1}")

    # ── Step 3
    section("Step 3: Find row for user A, validate fields")
    a_rows = find_feedback_rows_for(reports, A["user_id"])
    _assert(len(a_rows) >= 1, f"At least one feedback row for user A (found {len(a_rows)})")
    if not a_rows:
        print("Cannot continue, no feedback row for A")
        return summarize()
    row1 = a_rows[0]  # newest first per .sort
    print(f"  Row keys: {sorted(row1.keys())}")
    _assert(row1.get("kind") == "feedback", f"kind == 'feedback' (got {row1.get('kind')!r})")
    _assert(row1.get("severity") == "info", f"severity == 'info' (got {row1.get('severity')!r})")
    _assert(row1.get("rating") == 5, f"rating == 5 (got {row1.get('rating')!r})")
    _assert(row1.get("stars") == "★★★★★", f"stars == '★★★★★' (got {row1.get('stars')!r})")
    _assert(row1.get("excerpt") == "Love this app, please add dark theme",
            f"excerpt matches (got {row1.get('excerpt')!r})")
    reason = row1.get("reason") or ""
    _assert(reason.startswith("In-app feedback (5/5 stars)"),
            f"reason starts with 'In-app feedback (5/5 stars)' (got {reason!r})")
    _assert(row1.get("level_at_submit") == 3, f"level_at_submit == 3 (got {row1.get('level_at_submit')!r})")
    _assert(row1.get("platform") == "ios", f"platform == 'ios' (got {row1.get('platform')!r})")
    _assert(row1.get("viewed_at") is None, f"viewed_at is None (got {row1.get('viewed_at')!r})")
    _assert(row1.get("reported_email") == A["email"],
            f"reported_email == A.email (got {row1.get('reported_email')!r})")

    # ── Step 4
    section("Step 4: new_count >= 1 and includes our row")
    _assert(nc1 >= 1, f"new_count >= 1 (got {nc1})")
    # Our row's viewed_at is None so it counts toward new_count.
    _assert(row1.get("viewed_at") is None,
            f"row1 viewed_at is None (so it's counted in new_count)")

    # ── Step 5: Edge cases — invalid POSTs MUST NOT add admin_reports rows
    section("Step 5: Invalid POSTs do not create admin_reports rows")
    baseline_count = len(find_feedback_rows_for(reports, A["user_id"]))
    print(f"  baseline feedback rows for A: {baseline_count}")
    invalid_cases = [
        ("rating=0", {"rating": 0}),
        ("rating=6", {"rating": 6}),
        ("missing rating", {"text": "abc"}),
    ]
    for label, body_inv in invalid_cases:
        r = requests.post(f"{BASE}/feedback", json=body_inv, headers=headers_A, timeout=30)
        _assert(r.status_code == 400,
                f"POST /feedback {label} → 400 (got {r.status_code} body={r.text[:200]!r})")
        # Re-fetch admin reports
        rr = admin_get_reports(admin_token)
        if rr.status_code == 200:
            cur_count = len(find_feedback_rows_for(rr.json().get("reports", []), A["user_id"]))
            _assert(cur_count == baseline_count,
                    f"After invalid {label}, feedback rows for A still {baseline_count} (got {cur_count})")

    # ── Step 6: Empty text
    section("Step 6: Empty text → excerpt='(no comment)' and stars='★★★☆☆'")
    payload6 = {"rating": 3, "text": ""}
    r = requests.post(f"{BASE}/feedback", json=payload6, headers=headers_A, timeout=30)
    _assert(r.status_code == 200, f"POST /feedback rating=3 empty text → 200 (got {r.status_code})")
    rr = admin_get_reports(admin_token)
    if rr.status_code == 200:
        a_rows2 = find_feedback_rows_for(rr.json().get("reports", []), A["user_id"])
        _assert(len(a_rows2) == baseline_count + 1,
                f"feedback rows for A grew by 1 (was {baseline_count}, now {len(a_rows2)})")
        # newest row first (sorted by created_at desc)
        newest = a_rows2[0]
        _assert(newest.get("rating") == 3, f"newest.rating == 3 (got {newest.get('rating')})")
        _assert(newest.get("excerpt") == "(no comment)",
                f"newest.excerpt == '(no comment)' (got {newest.get('excerpt')!r})")
        _assert(newest.get("stars") == "★★★☆☆",
                f"newest.stars == '★★★☆☆' (got {newest.get('stars')!r})")

    # ── Step 7
    section("Step 7: GET /feedback/me as A → submitted=True")
    r = requests.get(f"{BASE}/feedback/me", headers=headers_A, timeout=30)
    _assert(r.status_code == 200, f"GET /feedback/me → 200 (got {r.status_code})")
    bm = r.json() if r.status_code == 200 else {}
    _assert(bm.get("submitted") is True, f"submitted == True (got {bm.get('submitted')!r})")
    _assert(isinstance(bm.get("submitted_at"), str) and len(bm.get("submitted_at") or "") > 8,
            f"submitted_at is iso string (got {bm.get('submitted_at')!r})")

    # ── Step 8
    section("Step 8: 2nd submission creates a SECOND admin_reports row (no dedupe)")
    payload8 = {"rating": 4, "text": "Second piece of feedback"}
    r = requests.post(f"{BASE}/feedback", json=payload8, headers=headers_A, timeout=30)
    _assert(r.status_code == 200, f"POST /feedback rating=4 → 200 (got {r.status_code})")
    rr = admin_get_reports(admin_token)
    if rr.status_code == 200:
        a_rows3 = find_feedback_rows_for(rr.json().get("reports", []), A["user_id"])
        _assert(len(a_rows3) >= 3,
                f"≥3 feedback rows for A (got {len(a_rows3)})")
        ratings = sorted([r.get("rating") for r in a_rows3])
        _assert(set([3, 4, 5]).issubset(set(ratings)),
                f"feedback rows include ratings 3,4,5 (got {ratings})")

    # ── Step 9: Anonymous user flow
    section("Step 9: Anonymous user feedback via X-Anonymous-Id")
    anon_id = f"anon-feedback-{uuid.uuid4().hex[:12]}"
    headers_anon = {"X-Anonymous-Id": anon_id}
    payload9 = {"rating": 2, "text": "Anonymous user feedback"}
    r = requests.post(f"{BASE}/feedback", json=payload9, headers=headers_anon, timeout=30)
    _assert(r.status_code == 200, f"Anon POST /feedback → 200 (got {r.status_code} body={r.text[:200]!r})")
    rr = admin_get_reports(admin_token)
    if rr.status_code == 200:
        all_reports = rr.json().get("reports", [])
        # anon user_id is "anon-<header value>" per get_user_or_legacy convention
        # Find the most recent feedback row with rating==2 and reported_email==""
        anon_candidates = [
            r for r in all_reports
            if r.get("kind") == "feedback"
            and r.get("rating") == 2
            and (r.get("reported_email") or "") == ""
            and r.get("excerpt") == "Anonymous user feedback"
        ]
        _assert(len(anon_candidates) >= 1,
                f"Anonymous feedback row exists with rating=2, reported_email='' (found {len(anon_candidates)})")
        if anon_candidates:
            an = anon_candidates[0]
            print(f"  anon row: reported_user_id={an.get('reported_user_id')!r} reported_name={an.get('reported_name')!r}")
            _assert(an.get("reported_email") == "",
                    f"reported_email == '' (got {an.get('reported_email')!r})")
            name_ok = an.get("reported_name") in ("Anonymous", "main") or isinstance(an.get("reported_name"), str)
            _assert(name_ok, f"reported_name is set (got {an.get('reported_name')!r})")

    # ── Step 10: Regression — admin/reports flow
    section("Step 10: Regression /admin/reports view + dismiss")
    # Non-admin user
    r = requests.get(f"{BASE}/admin/reports", headers=headers_A, timeout=30)
    _assert(r.status_code == 403, f"Non-admin GET /admin/reports → 403 (got {r.status_code})")
    if r.status_code == 403:
        detail = r.json().get("detail", "") if r.headers.get("content-type", "").startswith("application/json") else ""
        _assert("Admin only" in str(detail), f"403 detail contains 'Admin only' (got {detail!r})")

    # Pick a fresh feedback report for A and view it
    rr = admin_get_reports(admin_token)
    pre_reports = rr.json().get("reports", [])
    pre_new_count = rr.json().get("new_count", 0)
    a_unviewed = [r for r in pre_reports
                  if r.get("kind") == "feedback"
                  and r.get("reported_user_id") == A["user_id"]
                  and r.get("viewed_at") is None]
    _assert(len(a_unviewed) >= 1, f"At least one unviewed feedback row for A (got {len(a_unviewed)})")
    if a_unviewed:
        target = a_unviewed[0]
        target_id = target.get("id")
        print(f"  viewing report id={target_id}")
        r = requests.post(f"{BASE}/admin/reports/{target_id}/view",
                          headers={"Authorization": f"Bearer {admin_token}"}, timeout=30)
        _assert(r.status_code == 200, f"admin view → 200 (got {r.status_code})")
        _assert(r.json().get("ok") is True, f"view body.ok == True (got {r.json()})")
        # Re-fetch
        rr2 = admin_get_reports(admin_token)
        post_reports = rr2.json().get("reports", [])
        post_new_count = rr2.json().get("new_count", 0)
        match = [r for r in post_reports if r.get("id") == target_id]
        _assert(len(match) == 1, f"viewed report still in inbox (found {len(match)})")
        if match:
            _assert(match[0].get("viewed_at") is not None,
                    f"viewed_at is set after view (got {match[0].get('viewed_at')!r})")
        _assert(post_new_count == pre_new_count - 1,
                f"new_count decremented by 1 ({pre_new_count} → {post_new_count})")

        # Now dismiss
        r = requests.post(f"{BASE}/admin/reports/{target_id}/dismiss",
                          headers={"Authorization": f"Bearer {admin_token}"}, timeout=30)
        _assert(r.status_code == 200, f"admin dismiss → 200 (got {r.status_code})")
        _assert(r.json().get("ok") is True, f"dismiss body.ok == True (got {r.json()})")
        rr3 = admin_get_reports(admin_token)
        post_reports2 = rr3.json().get("reports", [])
        match2 = [r for r in post_reports2 if r.get("id") == target_id]
        _assert(len(match2) == 0, f"dismissed report removed from inbox (still found {len(match2)})")

    # ── Step 11: Regression smoke
    section("Step 11: Sanity smoke — /profile, /stats/weekly, /library/ratings")
    r = requests.get(f"{BASE}/profile", headers=headers_A, timeout=30)
    _assert(r.status_code == 200, f"/profile → 200 (got {r.status_code})")
    r = requests.get(f"{BASE}/stats/weekly", headers=headers_A, timeout=30)
    _assert(r.status_code == 200, f"/stats/weekly → 200 (got {r.status_code})")
    r = requests.get(f"{BASE}/library/ratings", headers=headers_A, timeout=30)
    _assert(r.status_code == 200, f"/library/ratings → 200 (got {r.status_code})")

    return summarize()


def summarize():
    total = len(PASS) + len(FAIL)
    print(f"\n=== SUMMARY ===")
    print(f"  PASS: {len(PASS)}/{total}")
    print(f"  FAIL: {len(FAIL)}/{total}")
    for f in FAIL:
        print(f"    ❌ {f}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
