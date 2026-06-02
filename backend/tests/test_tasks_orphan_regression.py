"""
Regression tests for iteration 7 backend fix:
GET /api/tasks must not raise 500 (KeyError: 'task_id') when task_logs
contains orphan documents missing the `task_id` field.

Also confirms regular task create -> complete -> list flow remains intact.
"""
import os
import datetime as dt
import pytest
import requests
from pymongo import MongoClient


BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://emergent-mobile-app-4.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "filip.cojocea122@gmail.com"
ADMIN_PASSWORD = "XL98CZW5599"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def auth(session):
    r = session.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "token" in data and "user" in data
    token = data["token"]
    user_id = data["user"]["id"]
    session.headers.update({"Authorization": f"Bearer {token}"})
    return {"token": token, "user_id": user_id}


@pytest.fixture(scope="module")
def mongo():
    client = MongoClient(MONGO_URL)
    yield client[DB_NAME]
    client.close()


def _today():
    return dt.date.today().isoformat()


# --- tests ---

class TestTasksOrphanRegression:
    """Iteration 7: GET /api/tasks must tolerate orphan task_logs"""

    def test_get_tasks_today_returns_200(self, session, auth):
        r = session.get(f"{BASE_URL}/api/tasks?date={_today()}", timeout=20)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        body = r.json()
        # Verify response shape
        assert "date" in body
        assert "tasks" in body and isinstance(body["tasks"], list)
        assert "adaptive_order" in body
        assert "order_source_date" in body

    def test_get_tasks_with_orphan_log_does_not_500(self, session, auth, mongo):
        """The critical regression scenario: a task_log doc with no task_id."""
        user_id = auth["user_id"]
        today = _today()

        # Insert an orphan log for TODAY (missing task_id) -> exercises done_ids branch
        orphan_today = {
            "user_id": user_id,
            "date": today,
            "completed_at": dt.datetime.utcnow().isoformat(),
            "_test_marker": "ORPHAN_REGRESSION_TODAY",
        }
        # Insert an orphan log for YESTERDAY -> exercises rank_map branch
        yesterday = (dt.date.today() - dt.timedelta(days=1)).isoformat()
        orphan_yesterday = {
            "user_id": user_id,
            "date": yesterday,
            "completed_at": dt.datetime.utcnow().isoformat(),
            "_test_marker": "ORPHAN_REGRESSION_YESTERDAY",
        }

        ins_today = mongo.task_logs.insert_one(orphan_today)
        ins_yest = mongo.task_logs.insert_one(orphan_yesterday)

        try:
            r = session.get(f"{BASE_URL}/api/tasks?date={today}", timeout=20)
            assert r.status_code == 200, (
                f"Orphan log triggered failure! Expected 200, got "
                f"{r.status_code}: {r.text}"
            )
            body = r.json()
            assert "tasks" in body
            # Endpoint must not blow up even when prior-day rank source is the orphan day
            assert isinstance(body["adaptive_order"], bool)
        finally:
            mongo.task_logs.delete_one({"_id": ins_today.inserted_id})
            mongo.task_logs.delete_one({"_id": ins_yest.inserted_id})

    def test_create_complete_and_list_flow(self, session, auth, mongo):
        """Confirm regular task create -> complete -> GET shows completed=true."""
        user_id = auth["user_id"]
        today = _today()

        create_payload = {
            "title": "TEST_orphan_regression_task",
            "description": "regression",
            "focus_area": "mindset",
            "time_slot": "morning",
            "xp_value": 10,
            "recurring": True,
            "reminder_enabled": False,
        }
        cr = session.post(f"{BASE_URL}/api/tasks", json=create_payload, timeout=20)
        # Admin may bypass cap; assert successful create
        assert cr.status_code == 200, f"Create failed: {cr.status_code} {cr.text}"
        task = cr.json()
        task_id = task["id"]
        assert task["title"] == create_payload["title"]

        try:
            # Complete the task
            cmp = session.post(
                f"{BASE_URL}/api/tasks/{task_id}/complete",
                json={"date": today},
                timeout=20,
            )
            assert cmp.status_code == 200, f"Complete failed: {cmp.status_code} {cmp.text}"

            # List tasks - find ours with completed: true
            lr = session.get(f"{BASE_URL}/api/tasks?date={today}", timeout=20)
            assert lr.status_code == 200
            tasks = lr.json()["tasks"]
            mine = next((t for t in tasks if t["id"] == task_id), None)
            assert mine is not None, "Created task not present in list"
            assert mine["completed"] is True, "Completed task not marked completed"
        finally:
            # cleanup task + logs
            session.delete(f"{BASE_URL}/api/tasks/{task_id}", timeout=20)
            mongo.task_logs.delete_many({"task_id": task_id, "user_id": user_id})

    def test_orphan_log_plus_real_completion_coexist(self, session, auth, mongo):
        """Orphan log + a real completion on same day -> still 200 and real one is counted."""
        user_id = auth["user_id"]
        today = _today()

        # Create a task and complete it
        cr = session.post(
            f"{BASE_URL}/api/tasks",
            json={
                "title": "TEST_orphan_coexist",
                "description": "x",
                "focus_area": "fitness",
                "time_slot": "morning",
                "xp_value": 10,
                "recurring": True,
                "reminder_enabled": False,
            },
            timeout=20,
        )
        assert cr.status_code == 200
        task_id = cr.json()["id"]

        # Inject orphan + complete real one
        ins = mongo.task_logs.insert_one({
            "user_id": user_id,
            "date": today,
            "completed_at": dt.datetime.utcnow().isoformat(),
            "_test_marker": "ORPHAN_COEXIST",
        })
        try:
            cmp = session.post(
                f"{BASE_URL}/api/tasks/{task_id}/complete",
                json={"date": today},
                timeout=20,
            )
            assert cmp.status_code == 200

            r = session.get(f"{BASE_URL}/api/tasks?date={today}", timeout=20)
            assert r.status_code == 200, f"got {r.status_code}: {r.text}"
            tasks = r.json()["tasks"]
            mine = next((t for t in tasks if t["id"] == task_id), None)
            assert mine is not None
            assert mine["completed"] is True
        finally:
            mongo.task_logs.delete_one({"_id": ins.inserted_id})
            session.delete(f"{BASE_URL}/api/tasks/{task_id}", timeout=20)
            mongo.task_logs.delete_many({"task_id": task_id, "user_id": user_id})
