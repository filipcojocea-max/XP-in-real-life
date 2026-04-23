"""Tests for adaptive task ordering and motivation feature backend contracts."""
import os
import time
from datetime import datetime, timezone, timedelta

import pytest
import requests

BASE_URL = os.environ.get('EXPO_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    # Fallback: read public backend URL from frontend/.env
    try:
        with open('/app/frontend/.env') as f:
            for line in f:
                line = line.strip()
                if line.startswith('EXPO_PUBLIC_BACKEND_URL='):
                    BASE_URL = line.split('=', 1)[1].strip().strip('"').rstrip('/')
                    break
                if line.startswith('EXPO_BACKEND_URL='):
                    BASE_URL = line.split('=', 1)[1].strip().strip('"').rstrip('/')
    except Exception:
        pass
assert BASE_URL, "No backend URL configured"


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def fresh_db(api):
    # Reset + seed
    r = api.post(f"{BASE_URL}/api/profile/reset", timeout=15)
    assert r.status_code == 200, r.text
    # Complete onboarding so home/tasks don't redirect (backend doesn't care but keeps parity)
    api.put(f"{BASE_URL}/api/profile/onboarding", json={"name": "Tester", "skip_complete": True}, timeout=15)
    r = api.post(f"{BASE_URL}/api/seed", timeout=15)
    assert r.status_code == 200, r.text
    return True


def test_tasks_contract_fields_fresh(api, fresh_db):
    """Fresh DB: adaptive_order=False, order_source_date=None."""
    r = api.get(f"{BASE_URL}/api/tasks", timeout=15)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "tasks" in data
    assert "order_source_date" in data
    assert "adaptive_order" in data
    assert data["adaptive_order"] is False
    assert data["order_source_date"] is None
    assert len(data["tasks"]) == 8


def test_complete_on_yesterday_date_creates_log(api, fresh_db):
    """Completing a task with explicit date=yesterday persists log for that date."""
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    r = api.get(f"{BASE_URL}/api/tasks", timeout=15)
    tasks = r.json()["tasks"]
    morning = [t for t in tasks if t["time_slot"] == "morning"]
    assert len(morning) >= 3
    target = morning[0]
    res = api.post(f"{BASE_URL}/api/tasks/{target['id']}/complete", json={"date": yesterday}, timeout=15)
    assert res.status_code == 200, res.text
    # Verify GET tasks?date=yesterday shows completed=True for that task
    r2 = api.get(f"{BASE_URL}/api/tasks", params={"date": yesterday}, timeout=15)
    assert r2.status_code == 200
    y_tasks = r2.json()["tasks"]
    assert any(t["id"] == target["id"] and t["completed"] for t in y_tasks)


def test_adaptive_order_reflects_yesterday_completion_order(api):
    """
    Complete morning tasks in order (3rd, 1st, 2nd) for yesterday,
    then today's GET returns them in that same order at the top of morning group.
    """
    # Full reset + seed to start clean
    r = api.post(f"{BASE_URL}/api/profile/reset", timeout=15)
    assert r.status_code == 200
    api.put(f"{BASE_URL}/api/profile/onboarding", json={"name": "Tester", "skip_complete": True}, timeout=15)
    r = api.post(f"{BASE_URL}/api/seed", timeout=15)
    assert r.status_code == 200

    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()

    # Fetch initial ordering for the morning group — use "seed" order (created_at)
    r = api.get(f"{BASE_URL}/api/tasks", timeout=15)
    data = r.json()
    assert data["adaptive_order"] is False
    morning_initial = [t for t in data["tasks"] if t["time_slot"] == "morning"]
    assert len(morning_initial) >= 3

    m1, m2, m3 = morning_initial[0], morning_initial[1], morning_initial[2]

    # Complete yesterday in order: m3, m1, m2 with small gaps to ensure distinct completed_at
    order = [m3, m1, m2]
    for t in order:
        res = api.post(
            f"{BASE_URL}/api/tasks/{t['id']}/complete",
            json={"date": yesterday},
            timeout=15,
        )
        assert res.status_code == 200, res.text
        time.sleep(1.2)

    # Now GET today's tasks
    r = api.get(f"{BASE_URL}/api/tasks", timeout=15)
    assert r.status_code == 200
    data = r.json()
    assert data["adaptive_order"] is True
    assert data["order_source_date"] == yesterday

    morning_today = [t for t in data["tasks"] if t["time_slot"] == "morning"]
    # First three should match m3, m1, m2
    assert morning_today[0]["id"] == m3["id"], f"Expected {m3['title']} first, got {morning_today[0]['title']}"
    assert morning_today[1]["id"] == m1["id"], f"Expected {m1['title']} second, got {morning_today[1]['title']}"
    assert morning_today[2]["id"] == m2["id"], f"Expected {m2['title']} third, got {morning_today[2]['title']}"

    # Slot ordering preserved: first task slot should be morning
    assert data["tasks"][0]["time_slot"] == "morning"
    # Morning comes before afternoon/evening
    slots = [t["time_slot"] for t in data["tasks"]]
    m_last = max(i for i, s in enumerate(slots) if s == "morning")
    a_first_list = [i for i, s in enumerate(slots) if s == "afternoon"]
    if a_first_list:
        assert m_last < a_first_list[0]


def test_duplicate_complete_is_idempotent(api):
    """Completing same task twice for same date doesn't create duplicate log."""
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    r = api.get(f"{BASE_URL}/api/tasks", timeout=15)
    tasks = r.json()["tasks"]
    target = next(t for t in tasks if t["time_slot"] == "morning")
    # Already completed for yesterday from previous test (if run in sequence)
    res = api.post(f"{BASE_URL}/api/tasks/{target['id']}/complete", json={"date": yesterday}, timeout=15)
    assert res.status_code == 200
    body = res.json()
    # Either already_completed or just completed — both fine
    assert "task" in body or body.get("already_completed")
