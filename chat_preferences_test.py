#!/usr/bin/env python3
"""
Tests for the v1.0.29 chat_preferences backend module
Target: https://xp-confidence.preview.emergentagent.com/api
"""
import os
import random
import sys
import time
import uuid
from datetime import datetime

import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASS = "XL98CZW5599"

PASS = 0
FAIL = 0
FAIL_DETAILS = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        FAIL_DETAILS.append(f"{name} — {detail}")
        print(f"  ❌ {name}  — {detail}")


def section(t):
    print(f"\n=== {t} ===")


def reg(name=None):
    """Register a new gmail.com user and return (token, user_id, email)."""
    suffix = uuid.uuid4().hex[:10]
    email = f"chatpref.{suffix}@gmail.com"
    full = name or f"ChatPref {suffix[:4].upper()}"
    r = requests.post(
        f"{BASE}/auth/register",
        json={"full_name": full, "email": email, "password": "TestPassw0rd!"},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"register failed {r.status_code} {r.text[:200]}")
    j = r.json()
    return j["token"], j["user"]["id"], email


def login(email, password):
    r = requests.post(f"{BASE}/auth/login", json={"email": email, "password": password}, timeout=30)
    r.raise_for_status()
    j = r.json()
    return j["token"], j["user"]["id"]


def H(tok):
    return {"Authorization": f"Bearer {tok}"}


def main():
    section("Step 1 — Register fresh users A + B (gmail.com)")
    a_tok, a_id, a_email = reg("Alice Chatcolor")
    b_tok, b_id, b_email = reg("Bob Mutey")
    print(f"  A={a_email} ({a_id})")
    print(f"  B={b_email} ({b_id})")
    check("A registered", bool(a_tok and a_id))
    check("B registered", bool(b_tok and b_id))

    section("Step 2 — A GET /chat/preferences (bulk, empty)")
    r = requests.get(f"{BASE}/chat/preferences", headers=H(a_tok), timeout=20)
    check("bulk 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
    j = r.json() if r.status_code == 200 else {}
    check("bulk has 'preferences' key", "preferences" in j)
    check("bulk preferences is empty list", j.get("preferences") == [], f"got {j!r}")

    section("Step 3 — A GET /chat/preferences/<B> defaults")
    r = requests.get(f"{BASE}/chat/preferences/{b_id}", headers=H(a_tok), timeout=20)
    check("default get 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
    p = r.json() if r.status_code == 200 else {}
    check("default sent_bubble_color #00E1FF",
          (p.get("sent_bubble_color") or "").upper() == "#00E1FF", f"got {p.get('sent_bubble_color')!r}")
    check("default sent_text_color #0A0A0F",
          (p.get("sent_text_color") or "").upper() == "#0A0A0F", f"got {p.get('sent_text_color')!r}")
    check("default received_bubble_color #1A1A24",
          (p.get("received_bubble_color") or "").upper() == "#1A1A24", f"got {p.get('received_bubble_color')!r}")
    check("default received_text_color #E6E6F0",
          (p.get("received_text_color") or "").upper() == "#E6E6F0", f"got {p.get('received_text_color')!r}")
    check("default muted=false", p.get("muted") is False, f"got {p.get('muted')!r}")
    check("default blocked=false", p.get("blocked") is False, f"got {p.get('blocked')!r}")
    check("default updated_at=null", p.get("updated_at") is None, f"got {p.get('updated_at')!r}")

    section("Step 4 — A POST /chat/preferences/<B> {sent_bubble_color, muted}")
    r = requests.post(
        f"{BASE}/chat/preferences/{b_id}",
        headers=H(a_tok),
        json={"sent_bubble_color": "#FF6FB5", "muted": True},
        timeout=20,
    )
    check("upsert 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
    p = r.json() if r.status_code == 200 else {}
    check("upsert sent_bubble_color=#FF6FB5", (p.get("sent_bubble_color") or "").upper() == "#FF6FB5",
          f"got {p.get('sent_bubble_color')!r}")
    check("upsert muted=true", p.get("muted") is True, f"got {p.get('muted')!r}")
    check("upsert blocked=false", p.get("blocked") is False, f"got {p.get('blocked')!r}")
    ua = p.get("updated_at")
    iso_ok = False
    try:
        datetime.fromisoformat(ua.replace("Z", "+00:00") if ua and ua.endswith("Z") else ua)
        iso_ok = bool(ua)
    except Exception:
        iso_ok = False
    check("upsert updated_at is non-null ISO", iso_ok, f"got {ua!r}")

    section("Step 5 — A GET /chat/preferences (bulk after upsert)")
    r = requests.get(f"{BASE}/chat/preferences", headers=H(a_tok), timeout=20)
    check("bulk 200 (post-upsert)", r.status_code == 200)
    j = r.json() if r.status_code == 200 else {}
    prefs = j.get("preferences", [])
    check("bulk has 1 entry", len(prefs) == 1, f"got {len(prefs)} entries: {prefs!r}")
    if prefs:
        e = prefs[0]
        check("bulk entry friend_id == B", e.get("friend_id") == b_id, f"got {e.get('friend_id')!r}")
        check("bulk entry sent_bubble_color=#FF6FB5",
              (e.get("sent_bubble_color") or "").upper() == "#FF6FB5", f"got {e.get('sent_bubble_color')!r}")
        check("bulk entry muted=true", e.get("muted") is True)
        check("bulk entry blocked=false", e.get("blocked") is False)

    section("Step 6 — A POST /chat/preferences/<B> invalid hex → 422")
    r = requests.post(
        f"{BASE}/chat/preferences/{b_id}",
        headers=H(a_tok),
        json={"sent_bubble_color": "#ZZZZZZ"},
        timeout=20,
    )
    check("invalid hex 422", r.status_code == 422, f"got {r.status_code} {r.text[:200]}")

    section("Step 7 — A POST /chat/preferences/<B>/mute {value:false}")
    r = requests.post(
        f"{BASE}/chat/preferences/{b_id}/mute",
        headers=H(a_tok),
        json={"value": False},
        timeout=20,
    )
    check("mute=false 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
    p = r.json() if r.status_code == 200 else {}
    check("after mute=false: muted=false", p.get("muted") is False)
    check("after mute=false: sent_bubble_color preserved #FF6FB5",
          (p.get("sent_bubble_color") or "").upper() == "#FF6FB5", f"got {p.get('sent_bubble_color')!r}")

    section("Step 8 — A POST /chat/preferences/<B>/block {value:true}")
    r = requests.post(
        f"{BASE}/chat/preferences/{b_id}/block",
        headers=H(a_tok),
        json={"value": True},
        timeout=20,
    )
    check("block=true 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
    p = r.json() if r.status_code == 200 else {}
    check("after block=true: blocked=true", p.get("blocked") is True)
    check("after block=true: muted=false", p.get("muted") is False)

    section("Step 9 — Make A & B friends")
    r = requests.post(f"{BASE}/friends/request", headers=H(b_tok), json={"user_id": a_id}, timeout=20)
    check("B → A friend request 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
    r = requests.post(f"{BASE}/friends/accept", headers=H(a_tok), json={"user_id": b_id}, timeout=20)
    check("A accepts B 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
    j = r.json() if r.status_code == 200 else {}
    check("status=friends", j.get("status") == "friends", f"got {j!r}")

    section("Step 10 — B sends DM to A (A has B blocked)")
    r = requests.post(
        f"{BASE}/messages/send",
        headers=H(b_tok),
        json={"to_user_id": a_id, "refined_text": "hello A", "original_text": "hello A"},
        timeout=30,
    )
    check("B→A send 200", r.status_code == 200, f"got {r.status_code} {r.text[:300]}")
    mj = r.json() if r.status_code == 200 else {}
    msg = mj.get("message") or {}
    check("message inserted with id", bool(msg.get("id")))
    check("message text == 'hello A'", (msg.get("refined_text") or msg.get("text")) == "hello A",
          f"got {msg!r}")

    section("Step 11 — A GET /messages/unread-summary (B blocked → suppressed)")
    r = requests.get(f"{BASE}/messages/unread-summary", headers=H(a_tok), timeout=20)
    check("unread-summary 200", r.status_code == 200)
    j = r.json() if r.status_code == 200 else {}
    ubf = j.get("unread_by_friend") or {}
    check("blocked B NOT in unread_by_friend", b_id not in ubf, f"got keys={list(ubf.keys())}")
    check("total_unread excludes B (=0 from B-only)",
          isinstance(j.get("total_unread"), int) and j.get("total_unread", 0) == 0,
          f"total_unread={j.get('total_unread')} ubf={ubf}")

    section("Step 12 — A GET /messages/threads (B row: unread=0, blocked:true)")
    r = requests.get(f"{BASE}/messages/threads", headers=H(a_tok), timeout=20)
    check("threads 200", r.status_code == 200)
    j = r.json() if r.status_code == 200 else {}
    threads = j.get("threads") or []
    b_row = next((t for t in threads if t.get("friend_id") == b_id), None)
    check("B thread present", b_row is not None, f"threads={threads!r}")
    if b_row:
        check("B row unread_count == 0", b_row.get("unread_count") == 0,
              f"got {b_row.get('unread_count')}")
        check("B row blocked:true", b_row.get("blocked") is True,
              f"got blocked={b_row.get('blocked')!r}")

    section("Step 13 — A GET /messages/thread/<B> (soft-block: history readable)")
    r = requests.get(f"{BASE}/messages/thread/{b_id}", headers=H(a_tok), timeout=20)
    check("thread/B 200", r.status_code == 200, f"got {r.status_code}")
    j = r.json() if r.status_code == 200 else {}
    msgs = j.get("messages") or []
    has_hello = any((m.get("refined_text") or m.get("text") or "") == "hello A" for m in msgs)
    check("B's 'hello A' message visible to A", has_hello, f"got msgs={msgs!r}")

    section("Step 14 — Unblock B → unread badge now appears")
    r = requests.post(
        f"{BASE}/chat/preferences/{b_id}/block",
        headers=H(a_tok),
        json={"value": False},
        timeout=20,
    )
    check("unblock=false 200", r.status_code == 200)
    p = r.json() if r.status_code == 200 else {}
    check("after unblock: blocked=false", p.get("blocked") is False)
    r = requests.get(f"{BASE}/messages/unread-summary", headers=H(a_tok), timeout=20)
    check("unread-summary 200 (post-unblock)", r.status_code == 200)
    j = r.json() if r.status_code == 200 else {}
    ubf = j.get("unread_by_friend") or {}
    check("B now IN unread_by_friend (>=1)", b_id in ubf and ubf.get(b_id, 0) >= 1,
          f"got {ubf!r}")

    section("Step 15 — Mute-only: badge still accrues")
    r = requests.post(
        f"{BASE}/chat/preferences/{b_id}/mute",
        headers=H(a_tok),
        json={"value": True},
        timeout=20,
    )
    check("mute=true 200", r.status_code == 200)
    p = r.json() if r.status_code == 200 else {}
    check("muted=true now", p.get("muted") is True)
    r = requests.get(f"{BASE}/messages/unread-summary", headers=H(a_tok), timeout=20)
    j = r.json() if r.status_code == 200 else {}
    ubf = j.get("unread_by_friend") or {}
    check("mute does NOT suppress: B still in unread_by_friend", b_id in ubf,
          f"got {ubf!r}")
    # Clear mute
    r = requests.post(
        f"{BASE}/chat/preferences/{b_id}/mute",
        headers=H(a_tok),
        json={"value": False},
        timeout=20,
    )
    check("mute=false (cleanup) 200", r.status_code == 200)

    section("Step 16 — friend_id == self → 400")
    r = requests.post(
        f"{BASE}/chat/preferences/{a_id}",
        headers=H(a_tok),
        json={"muted": True},
        timeout=20,
    )
    check("self friend_id 400", r.status_code == 400, f"got {r.status_code} {r.text[:200]}")
    try:
        detail = r.json().get("detail")
    except Exception:
        detail = None
    check("self friend_id detail == 'Invalid friend id.'",
          detail == "Invalid friend id.", f"got {detail!r}")

    section("Step 17 — Regression: D→C send still 200 with no chat_preferences row")
    c_tok, c_id, _ = reg("Charlie Clean")
    d_tok, d_id, _ = reg("Dana Default")
    r = requests.post(f"{BASE}/friends/request", headers=H(d_tok), json={"user_id": c_id}, timeout=20)
    check("D→C req 200", r.status_code == 200)
    r = requests.post(f"{BASE}/friends/accept", headers=H(c_tok), json={"user_id": d_id}, timeout=20)
    check("C accepts D 200", r.status_code == 200)
    r = requests.post(
        f"{BASE}/messages/send",
        headers=H(d_tok),
        json={"to_user_id": c_id, "refined_text": "hi C", "original_text": "hi C"},
        timeout=30,
    )
    check("D→C send 200 (no pref row)", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
    r = requests.get(f"{BASE}/messages/unread-summary", headers=H(c_tok), timeout=20)
    j = r.json() if r.status_code == 200 else {}
    ubf = j.get("unread_by_friend") or {}
    check("C sees D in unread_by_friend (no prefs → no suppression)", d_id in ubf,
          f"got {ubf!r}")

    section("Step 18 — Admin push exception (admin → A, A blocks admin)")
    try:
        admin_tok, admin_id = login(ADMIN_EMAIL, ADMIN_PASS)
        print(f"  admin login OK; admin_id={admin_id}")
        check("admin login 200", True)
    except Exception as e:
        check("admin login 200", False, f"{e}")
        admin_tok = None
        admin_id = None
    if admin_tok and admin_id:
        # A blocks admin via chat_preferences
        r = requests.post(
            f"{BASE}/chat/preferences/{admin_id}/block",
            headers=H(a_tok),
            json={"value": True},
            timeout=20,
        )
        check("A blocks admin 200", r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
        p = r.json() if r.status_code == 200 else {}
        check("A: admin blocked=true", p.get("blocked") is True)
        # Admin sends to A
        r = requests.post(
            f"{BASE}/messages/send",
            headers=H(admin_tok),
            json={"to_user_id": a_id, "refined_text": "admin ping", "original_text": "admin ping"},
            timeout=30,
        )
        check("admin → A send 200 (push exception)",
              r.status_code == 200, f"got {r.status_code} {r.text[:200]}")
        am = (r.json() or {}).get("message") if r.status_code == 200 else {}
        check("admin message inserted with id", bool((am or {}).get("id")))
        # Verify visibility on A's side
        r = requests.get(f"{BASE}/messages/thread/{admin_id}", headers=H(a_tok), timeout=20)
        check("A GET thread/admin 200", r.status_code == 200)
        msgs = (r.json() or {}).get("messages", []) if r.status_code == 200 else []
        admin_has_ping = any((m.get("refined_text") or m.get("text") or "") == "admin ping" for m in msgs)
        check("A sees 'admin ping' in admin thread (db insert verified)",
              admin_has_ping, f"got {msgs!r}")

    # ── Summary ─────────────────────────────────────
    print("\n" + "=" * 60)
    print(f"PASSED: {PASS}")
    print(f"FAILED: {FAIL}")
    if FAIL_DETAILS:
        print("\nFAILURES:")
        for d in FAIL_DETAILS:
            print(f"  - {d}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
