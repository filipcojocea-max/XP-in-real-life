"""
Backend test for: Challenge Tasks — exclude completed + per-day shuffle
Tests the live ingress URL (EXPO_PUBLIC_BACKEND_URL + /api).

Scenarios:
  A. Two fresh anonymous users (X-Anonymous-Id header).
  B. user1: GET /challenge/today → non-empty challenge.id (id1).
  C. user1: GET /challenge/today again → idempotent (== id1).
  D. user2: GET /challenge/today → non-empty (id2).
  E. user1: POST /challenge/accept then POST /challenge/complete → 200.
  F. user1: GET /challenge/past → contains entry with challenge_id == id1, completed=true.
  G. Shape regression on GET /challenge/today.
"""

import json
import os
import sys
import time
import uuid
from typing import Tuple

import requests

BASE = os.environ.get("BACKEND_URL") or "https://xp-confidence.preview.emergentagent.com"
API = f"{BASE}/api"

results = []
fails = 0


def assertion(name, cond, detail=""):
    global fails
    status = "PASS" if cond else "FAIL"
    line = f"[{status}] {name}"
    if detail:
        line += f" — {detail}"
    print(line)
    results.append((status, name, detail))
    if not cond:
        fails += 1
    return cond


def headers_for(anon_id: str) -> dict:
    return {
        "X-Anonymous-Id": anon_id,
        "Content-Type": "application/json",
    }


def main():
    # A. Two fresh anonymous users
    user1 = f"anon-test-{uuid.uuid4()}"
    user2 = f"anon-test-{uuid.uuid4()}"
    print(f"\n=== Setup ===\nUSER1={user1}\nUSER2={user2}\nBASE={API}\n")

    # B. user1 GET /challenge/today
    print("=== B. user1 GET /challenge/today ===")
    r = requests.get(f"{API}/challenge/today", headers=headers_for(user1), timeout=30)
    assertion("B.1 GET /challenge/today user1 → 200",
              r.status_code == 200,
              f"status={r.status_code} body={r.text[:300]}")
    if r.status_code != 200:
        return
    body1 = r.json()

    challenge1 = body1.get("challenge") or {}
    id1 = challenge1.get("id")
    assertion("B.2 response.challenge.id is non-empty string",
              isinstance(id1, str) and len(id1) > 0,
              f"id1={id1!r}")
    print(f"id1 = {id1}")

    # G. Shape regression on /challenge/today
    print("\n=== G. Shape regression ===")
    expected_keys = ["date", "greeting", "quote", "challenge", "status", "completed_id", "wake_time"]
    for k in expected_keys:
        assertion(f"G.{k} key present", k in body1,
                  f"keys={list(body1.keys())}")
    quote = body1.get("quote") or {}
    assertion("G.quote.text non-empty",
              isinstance(quote.get("text"), str) and len(quote["text"]) > 0,
              f"quote={quote}")
    assertion("G.quote.author non-empty",
              isinstance(quote.get("author"), str) and len(quote["author"]) > 0,
              f"quote={quote}")
    # challenge has id and a title (or text)
    assertion("G.challenge.id non-empty",
              isinstance(challenge1.get("id"), str) and len(challenge1["id"]) > 0)
    has_title_or_text = (
        isinstance(challenge1.get("title"), str) and len(challenge1["title"]) > 0
    ) or (
        isinstance(challenge1.get("text"), str) and len(challenge1["text"]) > 0
    )
    assertion("G.challenge has title or text", has_title_or_text,
              f"challenge keys={list(challenge1.keys())}")
    assertion("G.status is string", isinstance(body1.get("status"), str),
              f"status={body1.get('status')!r}")
    # completed_id may be null
    assertion("G.completed_id present (may be null)",
              "completed_id" in body1)
    assertion("G.wake_time present",
              "wake_time" in body1)

    # C. Same-day idempotency
    print("\n=== C. user1 GET /challenge/today AGAIN (idempotent) ===")
    r2 = requests.get(f"{API}/challenge/today", headers=headers_for(user1), timeout=30)
    assertion("C.1 second GET → 200", r2.status_code == 200,
              f"status={r2.status_code}")
    if r2.status_code == 200:
        body1b = r2.json()
        id1b = (body1b.get("challenge") or {}).get("id")
        assertion("C.2 same-day idempotency: id1 == id1b",
                  id1 == id1b,
                  f"id1={id1} id1b={id1b}")

    # D. user2 GET /challenge/today
    print("\n=== D. user2 GET /challenge/today ===")
    r3 = requests.get(f"{API}/challenge/today", headers=headers_for(user2), timeout=30)
    assertion("D.1 GET /challenge/today user2 → 200",
              r3.status_code == 200,
              f"status={r3.status_code} body={r3.text[:200]}")
    id2 = None
    if r3.status_code == 200:
        body2 = r3.json()
        ch2 = body2.get("challenge") or {}
        id2 = ch2.get("id")
        assertion("D.2 user2 response.challenge.id non-empty",
                  isinstance(id2, str) and len(id2) > 0,
                  f"id2={id2!r}")
        if id2 == id1:
            print(f"  [info] id2 == id1 ({id1}) — same challenge picked, not a failure.")
        else:
            print(f"  [info] user2 got different challenge: id2={id2}")

    # E. user1 POST /challenge/accept then complete
    print("\n=== E. user1 POST /challenge/accept + complete ===")
    ra = requests.post(f"{API}/challenge/accept", headers=headers_for(user1), timeout=30)
    assertion("E.1 POST /challenge/accept → 200",
              ra.status_code == 200,
              f"status={ra.status_code} body={ra.text[:300]}")
    if ra.status_code == 200:
        accept_body = ra.json()
        accepted_ch_id = (accept_body.get("challenge") or {}).get("id")
        assertion("E.2 accepted challenge.id matches id1",
                  accepted_ch_id == id1,
                  f"accepted={accepted_ch_id} id1={id1}")

    # POST /challenge/complete with the canonical body
    complete_body = {
        "completed": True,
        "difficulty": "easy",
        "rating": 5,
        "how_text": "Tested by SDET",
        "experience_text": "Felt good",
    }
    rc = requests.post(
        f"{API}/challenge/complete",
        headers=headers_for(user1),
        data=json.dumps(complete_body),
        timeout=30,
    )
    assertion("E.3 POST /challenge/complete → 200",
              rc.status_code == 200,
              f"status={rc.status_code} body={rc.text[:300]}")
    if rc.status_code == 200:
        cb = rc.json()
        assertion("E.4 awarded_xp == 30 for easy",
                  cb.get("awarded_xp") == 30,
                  f"awarded_xp={cb.get('awarded_xp')}")
        comp = cb.get("completion") or {}
        assertion("E.5 completion.challenge_id == id1",
                  comp.get("challenge_id") == id1,
                  f"completion.challenge_id={comp.get('challenge_id')} id1={id1}")
        assertion("E.6 completion.completed == true",
                  comp.get("completed") is True,
                  f"completed={comp.get('completed')}")

    # F. GET /challenge/past
    print("\n=== F. user1 GET /challenge/past ===")
    rp = requests.get(f"{API}/challenge/past", headers=headers_for(user1), timeout=30)
    assertion("F.1 GET /challenge/past → 200",
              rp.status_code == 200,
              f"status={rp.status_code} body={rp.text[:300]}")
    if rp.status_code == 200:
        past = rp.json()
        # response could be list or dict
        if isinstance(past, dict):
            entries = past.get("past") or past.get("entries") or past.get("history") or past.get("items") or []
            # check if there's a list-typed value
            if not entries:
                for v in past.values():
                    if isinstance(v, list):
                        entries = v
                        break
        elif isinstance(past, list):
            entries = past
        else:
            entries = []
        assertion("F.2 past entries is a list",
                  isinstance(entries, list),
                  f"type={type(past).__name__} keys={list(past.keys()) if isinstance(past, dict) else 'N/A'}")
        # find entry with challenge_id == id1
        match = None
        for e in entries:
            if isinstance(e, dict) and e.get("challenge_id") == id1:
                match = e
                break
        assertion("F.3 entry with challenge_id == id1 found in past",
                  match is not None,
                  f"id1={id1}, num_entries={len(entries)}, sample={entries[:1] if entries else 'EMPTY'}")
        if match:
            assertion("F.4 entry.completed == true",
                      match.get("completed") is True,
                      f"completed={match.get('completed')}")

    print("\n=== SUMMARY ===")
    total = len(results)
    passed = total - fails
    print(f"PASSED: {passed}/{total}, FAILED: {fails}")
    return fails


if __name__ == "__main__":
    rc = main()
    sys.exit(0 if rc == 0 else 1)
