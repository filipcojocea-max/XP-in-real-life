"""
Backend tests for the Sleep Coach mini-app endpoints.
Tests run against the public ingress URL.
"""
import sys
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"

PASS = []
FAIL = []


def ok(name, detail=""):
    PASS.append(name)
    print(f"PASS  {name}  {detail}")


def fail(name, detail=""):
    FAIL.append((name, detail))
    print(f"FAIL  {name}  {detail}")


def section(title):
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)


def assert_true(cond, name, detail=""):
    if cond:
        ok(name, detail)
    else:
        fail(name, detail)
    return cond


def main():
    section("0. Reset sleep state")
    r = requests.post(f"{BASE}/sleep/reset", timeout=30)
    assert_true(r.status_code == 200, "POST /sleep/reset returns 200", str(r.status_code))
    assert_true(r.json().get("reset") is True, "reset payload contains reset:true", str(r.json()))

    section("1. GET /sleep/profile (not onboarded)")
    r = requests.get(f"{BASE}/sleep/profile", timeout=30)
    assert_true(r.status_code == 200, "GET /sleep/profile returns 200", str(r.status_code))
    j = r.json()
    assert_true(j.get("onboarded") is False, "onboarded == false", str(j.get("onboarded")))
    qs = j.get("questions") or []
    assert_true(isinstance(qs, list) and len(qs) == 19,
                f"questions array has 19 items (got {len(qs)})")
    types_seen = set()
    schema_ok = True
    for q in qs:
        if not all(k in q for k in ("id", "type", "q")):
            schema_ok = False
            fail("question schema (id/type/q)", str(q))
            break
        types_seen.add(q["type"])
    if schema_ok:
        ok("each question has id/type/q")
    expected_types = {"scale", "time", "single", "multi", "text"}
    assert_true(expected_types.issubset(types_seen),
                "all expected question types present", str(types_seen))

    section("2. POST /sleep/onboarding")
    answers = {
        "struggle_level": 7,
        "avg_hours": 6,
        "bedtime": "11:30 PM",
        "wake_time": "7:00 AM",
        "wakes_at_night": "Sometimes",
        "racing_thoughts": "Often",
        "screens_before_bed": "In bed",
        "caffeine_cutoff": "Before 6pm",
        "alcohol": "Occasionally",
        "exercise": "A few times/week",
        "exercise_time": "Evening",
        "room_temp": "Comfortable",
        "room_dark": "Some light",
        "noise": "Some noise",
        "relaxing_activities": ["Reading", "Stretching", "Tea"],
        "likes_milk": "Love it",
        "warm_drinks": ["Chamomile tea", "Warm milk"],
        "tried_before": "Melatonin worked briefly",
        "main_goal": "Fall asleep faster",
    }
    r = requests.post(f"{BASE}/sleep/onboarding", json={"answers": answers}, timeout=120)
    assert_true(r.status_code == 200, "POST /sleep/onboarding returns 200", str(r.status_code))
    j = r.json()
    profile = j.get("profile") or {}
    plan = profile.get("plan", "")
    routine = profile.get("routine", [])
    assert_true(isinstance(plan, str) and len(plan) > 100,
                f"plan is non-empty string > 100 chars (len={len(plan)})")
    assert_true(isinstance(routine, list) and len(routine) >= 4,
                f"routine has >= 4 items (got {len(routine)})")
    if routine:
        first = routine[0]
        keys_ok = all(k in first for k in ("time", "title", "description", "icon"))
        assert_true(keys_ok, "routine items have time/title/description/icon", str(first))
    assert_true(profile.get("check_ins") == [], "check_ins initialized empty",
                str(profile.get("check_ins")))
    assert_true(profile.get("answers", {}).get("main_goal") == "Fall asleep faster",
                "answers persisted")
    print(f"     plan preview: {plan[:200]}…")

    section("3. GET /sleep/profile (after onboarding)")
    r = requests.get(f"{BASE}/sleep/profile", timeout=30)
    assert_true(r.status_code == 200, "GET /sleep/profile returns 200")
    j = r.json()
    assert_true(j.get("onboarded") is True, "onboarded == true after onboarding")
    assert_true(isinstance(j.get("profile"), dict), "profile object present")
    assert_true(isinstance(j.get("questions"), list) and len(j["questions"]) == 19,
                "questions array still returned (19)")
    assert_true(j.get("show_checkin_prompt") is True,
                "show_checkin_prompt is true (no check-in today yet)",
                str(j.get("show_checkin_prompt")))

    section("4. POST /sleep/checkin")
    r = requests.post(f"{BASE}/sleep/checkin",
                     json={"rating": 8, "hours": 7.5, "notes": "Slept well"},
                     timeout=30)
    assert_true(r.status_code == 200, "POST /sleep/checkin returns 200", str(r.status_code))
    j = r.json()
    assert_true(j.get("saved") is True, "saved == true")
    entry = j.get("entry") or {}
    for k in ("date", "rating", "hours", "notes", "ts"):
        assert_true(k in entry, f"entry has '{k}' key")
    assert_true(entry.get("rating") == 8, "entry.rating == 8")
    assert_true(entry.get("hours") == 7.5, "entry.hours == 7.5")

    r = requests.get(f"{BASE}/sleep/profile", timeout=30)
    j = r.json()
    cis = (j.get("profile") or {}).get("check_ins", [])
    assert_true(len(cis) == 1, f"check_ins length == 1 (got {len(cis)})")
    assert_true(j.get("show_checkin_prompt") is False,
                "show_checkin_prompt is false after check-in",
                str(j.get("show_checkin_prompt")))

    section("5. POST /sleep/chat (first message)")
    r = requests.post(f"{BASE}/sleep/chat",
                     json={"message": "What if I can't fall asleep tonight?"},
                     timeout=120)
    assert_true(r.status_code == 200, "POST /sleep/chat returns 200", str(r.status_code))
    j = r.json()
    user = j.get("user") or {}
    asst = j.get("assistant") or {}
    assert_true(user.get("role") == "user", f"user.role == 'user' (got {user.get('role')})")
    assert_true(bool(user.get("content")), "user.content non-empty")
    assert_true(asst.get("role") == "assistant",
                f"assistant.role == 'assistant' (got {asst.get('role')})")
    asst_content = asst.get("content", "")
    assert_true(len(asst_content) >= 50,
                f"assistant.content is helpful (>= 50 chars, got {len(asst_content)})")
    if "hiccup connecting" in asst_content.lower() or "llm key not configured" in asst_content.lower():
        fail("LLM responded successfully (not a fallback error message)", asst_content[:200])
    else:
        ok("assistant content does not look like LLM fallback error")
    print(f"     assistant preview: {asst_content[:200]}…")

    section("6. GET /sleep/chat (history with 2 msgs)")
    r = requests.get(f"{BASE}/sleep/chat", timeout=30)
    assert_true(r.status_code == 200, "GET /sleep/chat returns 200")
    msgs = (r.json() or {}).get("messages") or []
    assert_true(len(msgs) == 2, f"history has 2 messages (got {len(msgs)})")
    if len(msgs) == 2:
        assert_true(msgs[0]["role"] == "user" and msgs[1]["role"] == "assistant",
                    "messages ordered user→assistant")

    section("7. POST /sleep/chat (second turn) + history grows to 4")
    r = requests.post(f"{BASE}/sleep/chat",
                     json={"message": "Should I take a nap?"},
                     timeout=120)
    assert_true(r.status_code == 200, "POST /sleep/chat (turn 2) returns 200")
    j = r.json()
    asst2 = (j.get("assistant") or {}).get("content", "")
    assert_true(len(asst2) >= 30, f"second assistant reply non-empty (got {len(asst2)})")
    print(f"     assistant preview: {asst2[:200]}…")
    r = requests.get(f"{BASE}/sleep/chat", timeout=30)
    msgs = (r.json() or {}).get("messages") or []
    assert_true(len(msgs) == 4, f"history has 4 messages (got {len(msgs)})")

    section("8. POST /sleep/regenerate")
    r = requests.get(f"{BASE}/sleep/profile", timeout=30)
    pre = (r.json() or {}).get("profile") or {}
    pre_plan = pre.get("plan", "")
    pre_routine_len = len(pre.get("routine", []))

    r = requests.post(f"{BASE}/sleep/regenerate",
                     json={"message": "milk gives me indigestion, find an alternative"},
                     timeout=120)
    assert_true(r.status_code == 200, "POST /sleep/regenerate returns 200", str(r.status_code))
    j = r.json()
    profile2 = j.get("profile") or {}
    new_plan = profile2.get("plan", "")
    new_routine = profile2.get("routine", [])
    assert_true(isinstance(new_plan, str) and len(new_plan) > 100,
                f"regenerated plan non-empty (len={len(new_plan)})")
    assert_true(isinstance(new_routine, list) and len(new_routine) >= 4,
                f"regenerated routine has >= 4 items (got {len(new_routine)})")
    print(f"     plan changed: {new_plan != pre_plan}")
    print(f"     pre routine len={pre_routine_len}, new routine len={len(new_routine)}")
    cis2 = profile2.get("check_ins", [])
    assert_true(len(cis2) == 1, f"check_ins preserved after regenerate (got {len(cis2)})")

    section("9. GET /sleep/health-mock")
    r = requests.get(f"{BASE}/sleep/health-mock", timeout=30)
    assert_true(r.status_code == 200, "GET /sleep/health-mock returns 200")
    j = r.json()
    assert_true(j.get("connected") is False, "connected == false")
    assert_true(j.get("source") == "Simulated data",
                f"source == 'Simulated data' (got {j.get('source')})")
    nights = j.get("nights") or []
    assert_true(len(nights) == 7, f"nights has 7 entries (got {len(nights)})")
    if nights:
        first = nights[0]
        for k in ("date", "day", "total_hours", "deep_hours", "rem_hours", "light_hours", "score"):
            assert_true(k in first, f"night entry has '{k}'")
    for k in ("avg_total_hours", "avg_score", "best_night", "worst_night"):
        assert_true(k in j, f"top-level field '{k}' present")

    section("10. POST /sleep/reset")
    r = requests.post(f"{BASE}/sleep/reset", timeout=30)
    assert_true(r.status_code == 200, "POST /sleep/reset returns 200")
    r = requests.get(f"{BASE}/sleep/profile", timeout=30)
    j = r.json()
    assert_true(j.get("onboarded") is False, "onboarded == false after reset",
                str(j.get("onboarded")))
    r = requests.get(f"{BASE}/sleep/chat", timeout=30)
    msgs = (r.json() or {}).get("messages") or []
    assert_true(len(msgs) == 0, f"chat cleared after reset (got {len(msgs)})")

    section("RESULTS")
    print(f"PASSED: {len(PASS)}")
    print(f"FAILED: {len(FAIL)}")
    if FAIL:
        for n, d in FAIL:
            print(f" - {n}: {d}")
        sys.exit(1)


if __name__ == "__main__":
    main()
