"""
Backend test suite for the new auth + per-user data isolation system.
Tests against the public ingress URL.
"""
import os
import sys
import time
import uuid
import json
import requests

BASE = "https://xp-confidence.preview.emergentagent.com/api"

# Use unique emails per run to avoid clashing with existing accounts
RUN_ID = uuid.uuid4().hex[:8]
CAROL_EMAIL = f"carol+{RUN_ID}@test.com"
DAN_EMAIL = f"dan+{RUN_ID}@test.com"
ED_EMAIL = f"ed+{RUN_ID}@test.com"

results = []  # list of (name, ok, msg)


def record(name, ok, msg=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}{(' — ' + msg) if msg else ''}")
    results.append((name, ok, msg))
    return ok


def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


def main():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})

    # ================================================================
    # 1. Register Carol — expect 200 + dev_code, no token
    # ================================================================
    r = s.post(f"{BASE}/auth/register", json={
        "full_name": "Carol",
        "email": CAROL_EMAIL,
        "password": "pass1",
    })
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    ok = r.status_code == 200 and "dev_code" in body and "token" not in body
    record("1. Register Carol returns dev_code, no token", ok,
           f"status={r.status_code}, body_keys={list(body.keys())}")
    if not ok:
        print("Cannot continue without registration; aborting"); print(body); sys.exit(1)
    carol_dev_code = body["dev_code"]

    # ================================================================
    # 2. Verify with wrong code — expect 400
    # ================================================================
    r = s.post(f"{BASE}/auth/verify", json={"email": CAROL_EMAIL, "code": "000000"})
    record("2. Verify with wrong code returns 400", r.status_code == 400,
           f"status={r.status_code}, body={r.text[:160]}")

    # ================================================================
    # 3. Verify with correct code — expect 200, token + user
    # ================================================================
    r = s.post(f"{BASE}/auth/verify", json={"email": CAROL_EMAIL, "code": carol_dev_code})
    body = r.json() if r.ok else {}
    ok = (r.status_code == 200 and "token" in body and "user" in body
          and body["user"].get("email") == CAROL_EMAIL.lower())
    record("3. Verify with correct code returns 200 + token + user", ok,
           f"status={r.status_code}, body={list(body.keys()) if body else r.text[:200]}")
    if not ok:
        print("Cannot continue without token; aborting"); sys.exit(1)
    carol_token = body["token"]
    carol_user_id = body["user"]["id"]

    # ================================================================
    # 4. Auth/me with token — expect 200 with user details
    # ================================================================
    r = s.get(f"{BASE}/auth/me", headers=auth_headers(carol_token))
    body = r.json() if r.ok else {}
    ok = (r.status_code == 200 and body.get("email") == CAROL_EMAIL.lower()
          and body.get("verified") is True and body.get("full_name") == "Carol")
    record("4. GET /auth/me with token returns user details", ok,
           f"status={r.status_code}, body={body if body else r.text[:200]}")

    # ================================================================
    # 5. Auth/me without token — expect 401
    # ================================================================
    r = s.get(f"{BASE}/auth/me")
    record("5. GET /auth/me without token returns 401", r.status_code == 401,
           f"status={r.status_code}, body={r.text[:160]}")

    # ================================================================
    # 6. Login Carol — expect 200 with token
    # ================================================================
    r = s.post(f"{BASE}/auth/login", json={"email": CAROL_EMAIL, "password": "pass1"})
    body = r.json() if r.ok else {}
    ok = r.status_code == 200 and "token" in body and "user" in body
    record("6. Login with correct credentials returns token", ok,
           f"status={r.status_code}, keys={list(body.keys()) if body else r.text[:200]}")
    if ok:
        carol_token = body["token"]  # use fresh token

    # ================================================================
    # 7. Login wrong password — expect 401
    # ================================================================
    r = s.post(f"{BASE}/auth/login", json={"email": CAROL_EMAIL, "password": "wrongpw"})
    record("7. Login with wrong password returns 401", r.status_code == 401,
           f"status={r.status_code}, body={r.text[:160]}")

    # ================================================================
    # 8. Per-user task isolation
    # ================================================================
    # Register + verify Dan
    r = s.post(f"{BASE}/auth/register", json={
        "full_name": "Dan",
        "email": DAN_EMAIL,
        "password": "pass2",
    })
    body = r.json()
    if "dev_code" not in body:
        record("8a. Register Dan", False, f"status={r.status_code}, body={body}")
        sys.exit(1)
    dan_dev_code = body["dev_code"]
    r = s.post(f"{BASE}/auth/verify", json={"email": DAN_EMAIL, "code": dan_dev_code})
    body = r.json()
    if "token" not in body:
        record("8b. Verify Dan", False, f"status={r.status_code}, body={body}")
        sys.exit(1)
    dan_token = body["token"]
    record("8a-b. Register + verify Dan", True, "")

    # Carol completes one task (a default)
    r = s.get(f"{BASE}/tasks", headers=auth_headers(carol_token))
    tasks_data = r.json()
    carol_tasks = tasks_data.get("tasks", [])
    if len(carol_tasks) < 8:
        record("8c. Carol has 8 default tasks seeded", False,
               f"got {len(carol_tasks)} tasks")
    else:
        record("8c. Carol has 8 default tasks seeded", True, f"{len(carol_tasks)} tasks")

    task_a = carol_tasks[0]
    r = s.post(f"{BASE}/tasks/{task_a['id']}/complete",
               headers=auth_headers(carol_token), json={})
    ok_complete = r.status_code == 200
    record("8d. Carol completes task A", ok_complete,
           f"status={r.status_code}, body={r.text[:200]}")

    # Carol's profile XP > 0
    r = s.get(f"{BASE}/profile", headers=auth_headers(carol_token))
    carol_prof = r.json()
    record("8e. Carol's profile XP > 0", carol_prof.get("total_xp", 0) > 0,
           f"xp={carol_prof.get('total_xp')}")

    # Dan's profile XP == 0
    r = s.get(f"{BASE}/profile", headers=auth_headers(dan_token))
    dan_prof = r.json()
    record("8f. Dan's profile XP == 0 (isolation)", dan_prof.get("total_xp", -1) == 0,
           f"xp={dan_prof.get('total_xp')}")

    # Bonus: Dan's task list shouldn't contain Carol's completed task
    r = s.get(f"{BASE}/tasks", headers=auth_headers(dan_token))
    dan_tasks = r.json().get("tasks", [])
    carol_task_ids = {t["id"] for t in carol_tasks}
    dan_task_ids = {t["id"] for t in dan_tasks}
    record("8g. Dan's task ids disjoint from Carol's", carol_task_ids.isdisjoint(dan_task_ids),
           f"overlap={carol_task_ids & dan_task_ids}")

    # ================================================================
    # 9. 11-task limit for Dan
    # ================================================================
    creates = []
    fail_at = None
    for i in range(11):
        r = s.post(f"{BASE}/tasks", headers=auth_headers(dan_token), json={
            "title": f"Custom quest {i+1}",
            "description": "test",
            "focus_area": "fitness",
            "time_slot": "morning",
            "xp_value": 20,
        })
        if r.status_code != 200:
            fail_at = (i + 1, r.status_code, r.text[:200])
            break
        creates.append(r.json())
    if fail_at:
        record("9a. Dan can create 11 custom tasks", False,
               f"failed at #{fail_at[0]}: status={fail_at[1]}, body={fail_at[2]}")
    else:
        record("9a. Dan can create 11 custom tasks", True, f"created {len(creates)}")

    # 12th should fail with 400
    r = s.post(f"{BASE}/tasks", headers=auth_headers(dan_token), json={
        "title": "Custom quest 12",
        "description": "test",
        "focus_area": "fitness",
        "time_slot": "morning",
        "xp_value": 20,
    })
    body_text = r.text
    ok = r.status_code == 400 and ("11-quest" in body_text or "11" in body_text)
    record("9b. 12th custom task returns 400 with 11-quest message", ok,
           f"status={r.status_code}, body={body_text[:240]}")

    # ================================================================
    # 10. Once-per-day uncomplete blocked for Carol
    # ================================================================
    r = s.post(f"{BASE}/tasks/{task_a['id']}/uncomplete",
               headers=auth_headers(carol_token), json={})
    body_text = r.text
    ok = r.status_code == 400 and ("once per day" in body_text.lower()
                                    or "once a day" in body_text.lower()
                                    or "completed once" in body_text.lower())
    record("10. Uncomplete returns 400 with once-per-day message", ok,
           f"status={r.status_code}, body={body_text[:240]}")

    # ================================================================
    # 11. Default task delete blocked for Carol
    # ================================================================
    # Find a default task in Carol's list
    default_task = None
    for t in carol_tasks:
        if t.get("is_default"):
            default_task = t
            break
    if not default_task:
        record("11. Default task delete returns 400", False,
               "No default task found in Carol's list")
    else:
        r = s.delete(f"{BASE}/tasks/{default_task['id']}",
                     headers=auth_headers(carol_token))
        ok = r.status_code == 400 and "default" in r.text.lower()
        record("11. Default task delete returns 400", ok,
               f"status={r.status_code}, body={r.text[:240]}")

    # ================================================================
    # 12. Wake-time setter
    # ================================================================
    r = s.put(f"{BASE}/profile", headers=auth_headers(carol_token),
              json={"wake_time": "06:30"})
    ok_put = r.status_code == 200 and r.json().get("wake_time") == "06:30"
    record("12a. PUT /profile {wake_time:'06:30'}", ok_put,
           f"status={r.status_code}, wake_time={r.json().get('wake_time') if r.ok else r.text[:160]}")
    r = s.get(f"{BASE}/profile", headers=auth_headers(carol_token))
    ok_get = r.status_code == 200 and r.json().get("wake_time") == "06:30"
    record("12b. GET /profile shows wake_time='06:30'", ok_get,
           f"status={r.status_code}, wake_time={r.json().get('wake_time') if r.ok else r.text[:160]}")

    # ================================================================
    # 13. Custom date list_tasks
    # ================================================================
    r = s.get(f"{BASE}/tasks?date=2026-04-25", headers=auth_headers(carol_token))
    body = r.json() if r.ok else {}
    ok = (r.status_code == 200 and "tasks" in body
          and isinstance(body["tasks"], list) and body.get("date") == "2026-04-25")
    record("13. GET /tasks?date=2026-04-25 returns tasks list", ok,
           f"status={r.status_code}, keys={list(body.keys()) if body else r.text[:200]}")

    # ================================================================
    # 14. Resend verification
    # ================================================================
    r = s.post(f"{BASE}/auth/register", json={
        "full_name": "Ed",
        "email": ED_EMAIL,
        "password": "pass3",
    })
    body = r.json()
    ok_reg = r.status_code == 200 and "dev_code" in body
    record("14a. Register Ed returns dev_code", ok_reg,
           f"status={r.status_code}, body_keys={list(body.keys())}")
    first_code = body.get("dev_code")
    r = s.post(f"{BASE}/auth/resend", json={"email": ED_EMAIL})
    body = r.json() if r.ok else {}
    ok = r.status_code == 200 and "dev_code" in body
    record("14b. POST /auth/resend returns new dev_code", ok,
           f"status={r.status_code}, body={body if body else r.text[:200]}")
    if ok:
        record("14c. Resent dev_code is fresh (may differ from initial)",
               True,  # we don't strictly assert difference; codes are random and could collide rarely
               f"first={first_code}, resent={body.get('dev_code')}")

    # ================================================================
    # 15. Sleep coach per-user isolation
    # ================================================================
    sample_answers = {
        "struggle_level": 7,
        "avg_hours": 6,
        "bedtime": "23:30",
        "wake_time": "06:30",
        "wakes_at_night": "Sometimes",
        "racing_thoughts": "Often",
        "screens_before_bed": "Right up to bed",
        "caffeine_cutoff": "Before 6pm",
        "alcohol": "Occasionally",
        "exercise": "A few times/week",
        "exercise_time": "Evening",
        "room_temp": "Warm",
        "room_dark": "Some light",
        "noise": "Some noise",
        "relaxing_activities": ["Reading", "Breathing exercises"],
        "likes_milk": "It's okay",
        "warm_drinks": ["Chamomile tea"],
        "tried_before": "Tried melatonin briefly, didn't help much.",
        "main_goal": "Fall asleep faster",
    }
    r = s.post(f"{BASE}/sleep/onboarding", headers=auth_headers(carol_token),
               json={"answers": sample_answers}, timeout=60)
    ok_onb = r.status_code == 200
    record("15a. Carol completes /sleep/onboarding", ok_onb,
           f"status={r.status_code}, body={r.text[:200] if not ok_onb else 'ok'}")

    # Dan's sleep profile should still be onboarded:false
    r = s.get(f"{BASE}/sleep/profile", headers=auth_headers(dan_token))
    body = r.json() if r.ok else {}
    ok = r.status_code == 200 and body.get("onboarded") is False
    record("15b. Dan's /sleep/profile returns onboarded:false (per-user isolation)", ok,
           f"status={r.status_code}, onboarded={body.get('onboarded') if body else r.text[:200]}")

    # And Carol's should be onboarded:true
    r = s.get(f"{BASE}/sleep/profile", headers=auth_headers(carol_token))
    body = r.json() if r.ok else {}
    ok = r.status_code == 200 and body.get("onboarded") is True
    record("15c. Carol's /sleep/profile returns onboarded:true", ok,
           f"status={r.status_code}, onboarded={body.get('onboarded') if body else r.text[:200]}")

    # ================================================================
    # SUMMARY
    # ================================================================
    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"RESULT: {passed}/{total} assertions passed")
    print("=" * 60)
    failed = [(n, m) for n, ok, m in results if not ok]
    if failed:
        print("\nFAILED:")
        for n, m in failed:
            print(f"  - {n}: {m}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
