"""Backend test for Critique AI / LevelUp Tasks API.

Focuses on the updated Tasks endpoints:
  - default task locked-field enforcement
  - default task delete protection
  - custom task CRUD including moving between time_slots
"""
import os
import sys
import json
import uuid
import requests
from pathlib import Path

# Resolve the public backend URL from frontend/.env (EXPO_PUBLIC_BACKEND_URL)
FRONTEND_ENV = Path("/app/frontend/.env")
BASE_URL = None
for line in FRONTEND_ENV.read_text().splitlines():
    if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
        BASE_URL = line.split("=", 1)[1].strip().strip('"')
        break
if not BASE_URL:
    print("ERROR: EXPO_PUBLIC_BACKEND_URL not found in frontend/.env")
    sys.exit(1)

API = f"{BASE_URL}/api"
print(f"Using API base: {API}")

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}")
    if detail:
        print(f"    -> {detail}")


def pretty(obj):
    try:
        return json.dumps(obj, indent=2)[:800]
    except Exception:
        return str(obj)[:800]


def get_tasks():
    r = requests.get(f"{API}/tasks", timeout=30)
    r.raise_for_status()
    return r.json()


def ensure_seed_and_custom():
    data = get_tasks()
    tasks = data.get("tasks", [])
    default_task = next((t for t in tasks if t.get("is_default")), None)
    if not default_task:
        # Legacy tasks exist without is_default flag (seeded before migration).
        # Reset to get a clean state and re-seed so defaults are properly tagged.
        print("No default tasks found — resetting profile & re-seeding to get tagged defaults...")
        rr = requests.post(f"{API}/profile/reset", timeout=30)
        rr.raise_for_status()
        seed = requests.post(f"{API}/seed", timeout=30).json()
        print("Seed response:", seed)
        data = get_tasks()
        tasks = data.get("tasks", [])
        default_task = next((t for t in tasks if t.get("is_default")), None)

    custom_task = next((t for t in tasks if not t.get("is_default")), None)
    if not custom_task:
        payload = {
            "title": "Test Custom Quest",
            "description": "Created by backend_test.py",
            "focus_area": "fitness",
            "time_slot": "morning",
            "xp_value": 20,
            "recurring": True,
            "reminder_enabled": True,
        }
        r = requests.post(f"{API}/tasks", json=payload, timeout=30)
        r.raise_for_status()
        custom_task = r.json()
        # Re-fetch to include is_default absence check
        data = get_tasks()
        tasks = data.get("tasks", [])
        custom_task = next((t for t in tasks if t.get("id") == custom_task["id"]), custom_task)

    return default_task, custom_task, tasks


def test_1_list_and_identify():
    try:
        default_task, custom_task, tasks = ensure_seed_and_custom()
        has_default = any(t.get("is_default") for t in tasks)
        record(
            "1. GET /api/tasks returns tasks with default + custom",
            has_default and custom_task is not None and default_task is not None,
            f"default_id={default_task['id'] if default_task else None}, custom_id={custom_task['id'] if custom_task else None}, total={len(tasks)}",
        )
        return default_task, custom_task
    except Exception as e:
        record("1. GET /api/tasks", False, f"Exception: {e}")
        raise


def test_2_default_allowed_edits(default_id):
    body = {
        "title": "New title",
        "description": "x",
        "xp_value": 30,
        "reminder_enabled": True,
    }
    # Capture pre-state
    before = requests.get(f"{API}/tasks", timeout=30).json()["tasks"]
    before_task = next((t for t in before if t["id"] == default_id), {})
    orig_focus = before_task.get("focus_area")
    orig_slot = before_task.get("time_slot")

    r = requests.put(f"{API}/tasks/{default_id}", json=body, timeout=30)
    ok = r.status_code == 200
    detail = ""
    if ok:
        data = r.json()
        ok = (
            data.get("title") == "New title"
            and data.get("xp_value") == 30
            and data.get("description") == "x"
            and data.get("reminder_enabled") is True
            and data.get("focus_area") == orig_focus
            and data.get("time_slot") == orig_slot
        )
        if not ok:
            detail = f"Response mismatch. body={pretty(data)} orig_focus={orig_focus} orig_slot={orig_slot}"
        else:
            detail = f"title/xp/desc updated; focus_area={data.get('focus_area')} time_slot={data.get('time_slot')} unchanged"
    else:
        detail = f"HTTP {r.status_code} body={pretty(r.text)}"
    record("2. Default task: allowed edits (title/desc/xp/reminder)", ok, detail)


def test_3_default_blocked_edits(default_id):
    cases = [
        ("focus_area", {"focus_area": "social"}),
        ("time_slot", {"time_slot": "evening"}),
        ("scheduled_time", {"scheduled_time": "10:00"}),
    ]
    for field, body in cases:
        r = requests.put(f"{API}/tasks/{default_id}", json=body, timeout=30)
        ok = r.status_code == 400
        detail = f"status={r.status_code} body={pretty(r.text)}"
        record(f"3. Default task: BLOCKED edit of {field} returns 400", ok, detail)


def test_4_default_blocked_delete(default_id):
    r = requests.delete(f"{API}/tasks/{default_id}", timeout=30)
    ok_status = r.status_code == 400
    detail = f"status={r.status_code} body={pretty(r.text)}"
    record("4a. DELETE default task returns 400", ok_status, detail)

    # Verify still exists
    data = get_tasks()
    still_exists = any(t["id"] == default_id for t in data.get("tasks", []))
    record("4b. Default task still exists after blocked DELETE", still_exists,
           "" if still_exists else "Task was deleted despite protection!")


def test_5_custom_full_edit(custom_id):
    body = {
        "title": "Updated",
        "time_slot": "evening",
        "focus_area": "mindset",
        "scheduled_time": "20:00",
    }
    r = requests.put(f"{API}/tasks/{custom_id}", json=body, timeout=30)
    ok = r.status_code == 200
    detail = ""
    if ok:
        data = r.json()
        ok = (
            data.get("title") == "Updated"
            and data.get("time_slot") == "evening"
            and data.get("focus_area") == "mindset"
            and data.get("scheduled_time") == "20:00"
        )
        detail = pretty(data) if not ok else f"All fields updated: {data.get('title')}, {data.get('time_slot')}, {data.get('focus_area')}, {data.get('scheduled_time')}"
    else:
        detail = f"HTTP {r.status_code} body={pretty(r.text)}"
    record("5. Custom task: full edit (title/slot/focus/scheduled_time)", ok, detail)


def test_6_custom_move_slot(custom_id):
    body = {"time_slot": "afternoon", "scheduled_time": "13:00"}
    r = requests.put(f"{API}/tasks/{custom_id}", json=body, timeout=30)
    ok1 = r.status_code == 200
    record("6a. Custom task: move to afternoon slot", ok1,
           f"status={r.status_code} body={pretty(r.text)}")
    if not ok1:
        return

    data = get_tasks()
    tasks = data.get("tasks", [])
    t = next((x for x in tasks if x["id"] == custom_id), None)
    ok2 = t is not None and t.get("time_slot") == "afternoon" and t.get("scheduled_time") == "13:00"
    record("6b. Custom task appears in afternoon bucket on GET /api/tasks",
           ok2,
           f"task_found={t is not None} time_slot={t.get('time_slot') if t else None}")


def test_7_custom_delete(custom_id):
    r = requests.delete(f"{API}/tasks/{custom_id}", timeout=30)
    ok1 = r.status_code == 200
    body = {}
    try:
        body = r.json()
    except Exception:
        pass
    ok1 = ok1 and body.get("deleted") is True
    record("7a. DELETE custom task returns 200 {deleted: true}", ok1,
           f"status={r.status_code} body={pretty(r.text)}")

    data = get_tasks()
    gone = not any(t["id"] == custom_id for t in data.get("tasks", []))
    record("7b. Custom task no longer in GET /api/tasks", gone,
           "" if gone else "Task still present after DELETE!")


def main():
    try:
        default_task, custom_task = test_1_list_and_identify()
    except Exception:
        print_summary()
        sys.exit(1)

    default_id = default_task["id"]
    custom_id = custom_task["id"]

    test_2_default_allowed_edits(default_id)
    test_3_default_blocked_edits(default_id)
    test_4_default_blocked_delete(default_id)
    test_5_custom_full_edit(custom_id)
    test_6_custom_move_slot(custom_id)
    test_7_custom_delete(custom_id)

    print_summary()


def print_summary():
    print("\n================ SUMMARY ================")
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    for name, ok, detail in results:
        s = "PASS" if ok else "FAIL"
        print(f"[{s}] {name}")
    print(f"\nTotal: {len(results)}  Passed: {passed}  Failed: {failed}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
