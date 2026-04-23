"""Comprehensive backend API tests for LevelUp app."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "https://xp-confidence.preview.emergentagent.com"
BASE_URL = BASE_URL.rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module", autouse=True)
def reset_and_seed(s):
    # Clean slate
    r = s.post(f"{API}/profile/reset", timeout=20)
    assert r.status_code == 200
    # Seed defaults
    r = s.post(f"{API}/seed", timeout=20)
    assert r.status_code == 200
    yield


# ------------ Profile ------------
class TestProfile:
    def test_get_profile_default(self, s):
        r = s.get(f"{API}/profile")
        assert r.status_code == 200
        d = r.json()
        for k in ["name", "total_xp", "level", "xp_in_level", "xp_to_next",
                  "current_streak", "longest_streak", "tasks_completed",
                  "goals_created", "goals_completed", "achievements_unlocked"]:
            assert k in d, f"missing {k}"
        assert d["total_xp"] == 0
        assert d["level"] == 1

    def test_update_name(self, s):
        r = s.put(f"{API}/profile", json={"name": "TEST_Hero"})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Hero"


# ------------ Seed ------------
class TestSeed:
    def test_seed_idempotent(self, s):
        r = s.post(f"{API}/seed")
        assert r.status_code == 200
        body = r.json()
        assert body["seeded"] is False

    def test_seed_count_is_8(self, s):
        r = s.get(f"{API}/tasks")
        assert r.status_code == 200
        assert len(r.json()["tasks"]) == 8


# ------------ Tasks ------------
class TestTasks:
    def test_list_tasks_has_completed_flag(self, s):
        r = s.get(f"{API}/tasks")
        assert r.status_code == 200
        data = r.json()
        assert "date" in data and "tasks" in data
        for t in data["tasks"]:
            assert "completed" in t
            assert t["completed"] is False
            assert t["focus_area"] in ("social", "fitness", "appearance", "mindset")
            assert t["time_slot"] in ("morning", "afternoon", "evening")

    def test_create_custom_task(self, s):
        payload = {"title": "TEST_Custom", "description": "test", "focus_area": "social",
                   "time_slot": "afternoon", "xp_value": 25}
        r = s.post(f"{API}/tasks", json=payload)
        assert r.status_code == 200
        t = r.json()
        assert t["title"] == "TEST_Custom"
        assert t["xp_value"] == 25
        # Verify via GET
        r2 = s.get(f"{API}/tasks")
        ids = [x["id"] for x in r2.json()["tasks"]]
        assert t["id"] in ids
        pytest.custom_task_id = t["id"]

    def test_complete_task_awards_xp(self, s):
        r = s.get(f"{API}/tasks")
        tasks = r.json()["tasks"]
        # Find a seeded task with xp_value=40 (workout)
        workout = next((t for t in tasks if t["xp_value"] == 40), tasks[0])
        r = s.post(f"{API}/tasks/{workout['id']}/complete", json={})
        assert r.status_code == 200
        body = r.json()
        assert body["xp_awarded"] == workout["xp_value"]
        assert "leveled_up" in body
        assert "new_level" in body
        assert body["profile"]["total_xp"] >= workout["xp_value"]
        assert body["profile"]["tasks_completed"] >= 1
        # streak should now be 1
        assert body["profile"]["current_streak"] >= 1

    def test_double_complete_idempotent(self, s):
        r = s.get(f"{API}/tasks")
        tid = r.json()["tasks"][0]["id"]
        s.post(f"{API}/tasks/{tid}/complete", json={})
        r2 = s.post(f"{API}/tasks/{tid}/complete", json={})
        # second call should be a no-op (already_completed) or still 200
        assert r2.status_code == 200

    def test_uncomplete_task_subtracts_xp(self, s):
        # Get current state
        pr = s.get(f"{API}/profile").json()
        xp_before = pr["total_xp"]
        r = s.get(f"{API}/tasks")
        completed = [t for t in r.json()["tasks"] if t["completed"]]
        assert completed, "expected at least one completed task"
        t = completed[0]
        r = s.post(f"{API}/tasks/{t['id']}/uncomplete", json={})
        assert r.status_code == 200
        new_xp = r.json()["profile"]["total_xp"]
        assert new_xp == xp_before - t["xp_value"]
        assert new_xp >= 0

    def test_xp_never_negative(self, s):
        # Repeatedly uncomplete all and ensure xp stays >=0
        r = s.get(f"{API}/tasks")
        for t in r.json()["tasks"]:
            if t.get("completed"):
                s.post(f"{API}/tasks/{t['id']}/uncomplete", json={})
        pr = s.get(f"{API}/profile").json()
        assert pr["total_xp"] >= 0

    def test_delete_task(self, s):
        tid = getattr(pytest, "custom_task_id", None)
        if not tid:
            pytest.skip("no custom task")
        r = s.delete(f"{API}/tasks/{tid}")
        assert r.status_code == 200
        r2 = s.get(f"{API}/tasks")
        ids = [x["id"] for x in r2.json()["tasks"]]
        assert tid not in ids


# ------------ Achievements ------------
class TestAchievements:
    def test_all_12_achievements_returned(self, s):
        r = s.get(f"{API}/achievements")
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == 12
        assert len(body["achievements"]) == 12
        for a in body["achievements"]:
            assert "unlocked" in a

    def test_first_task_unlocks(self, s):
        # Complete one task
        r = s.get(f"{API}/tasks")
        tid = r.json()["tasks"][0]["id"]
        s.post(f"{API}/tasks/{tid}/complete", json={})
        r = s.get(f"{API}/achievements")
        first = next(a for a in r.json()["achievements"] if a["id"] == "first_task")
        assert first["unlocked"] is True

    def test_level_3_unlocks_at_250_xp(self, s):
        # Reset first
        s.post(f"{API}/profile/reset")
        s.post(f"{API}/seed")
        # Seeded total = 160 XP; create a big task to push >= 250
        r = s.post(f"{API}/tasks", json={"title": "TEST_big", "focus_area": "fitness",
                                          "time_slot": "morning", "xp_value": 200})
        assert r.status_code == 200
        big_id = r.json()["id"]
        # Complete all tasks
        r = s.get(f"{API}/tasks")
        for t in r.json()["tasks"]:
            s.post(f"{API}/tasks/{t['id']}/complete", json={})
        pr = s.get(f"{API}/profile").json()
        assert pr["total_xp"] >= 250
        assert pr["level"] >= 3
        r = s.get(f"{API}/achievements")
        lvl3 = next(a for a in r.json()["achievements"] if a["id"] == "level_3")
        assert lvl3["unlocked"] is True


# ------------ Stats ------------
class TestStats:
    def test_daily_rings(self, s):
        r = s.get(f"{API}/stats/daily")
        assert r.status_code == 200
        d = r.json()
        assert "rings" in d and "xp_today" in d
        for area in ("social", "fitness", "appearance", "mindset"):
            assert area in d["rings"]
            assert {"total", "done", "progress"} <= set(d["rings"][area].keys())

    def test_weekly_7_days(self, s):
        r = s.get(f"{API}/stats/weekly")
        assert r.status_code == 200
        assert len(r.json()["days"]) == 7

    def test_by_area(self, s):
        r = s.get(f"{API}/stats/by-area")
        assert r.status_code == 200
        ba = r.json()["by_area"]
        for area in ("social", "fitness", "appearance", "mindset"):
            assert area in ba
            assert isinstance(ba[area], int)


# ------------ Goals ------------
class TestGoals:
    def test_create_goal(self, s):
        payload = {"title": "TEST_Goal", "description": "t", "focus_area": "fitness", "target_value": 10, "unit": "reps"}
        r = s.post(f"{API}/goals", json=payload)
        assert r.status_code == 200
        g = r.json()
        assert g["title"] == "TEST_Goal"
        assert g["target_value"] == 10
        assert g["current_value"] == 0
        assert g["completed"] is False
        pytest.goal_id = g["id"]

    def test_list_goals(self, s):
        r = s.get(f"{API}/goals")
        assert r.status_code == 200
        assert any(g["id"] == pytest.goal_id for g in r.json()["goals"])

    def test_progress_and_completion_bonus(self, s):
        gid = pytest.goal_id
        pr_before = s.get(f"{API}/profile").json()["total_xp"]
        r = s.post(f"{API}/goals/{gid}/progress", json={"current_value": 10})
        assert r.status_code == 200
        g = r.json()
        assert g["completed"] is True
        pr_after = s.get(f"{API}/profile").json()["total_xp"]
        assert pr_after - pr_before == 100

    def test_delete_goal(self, s):
        gid = pytest.goal_id
        r = s.delete(f"{API}/goals/{gid}")
        assert r.status_code == 200
        r = s.get(f"{API}/goals")
        assert not any(g["id"] == gid for g in r.json()["goals"])


# ------------ Reset ------------
class TestReset:
    def test_reset_wipes(self, s):
        r = s.post(f"{API}/profile/reset")
        assert r.status_code == 200
        pr = r.json()
        assert pr["total_xp"] == 0
        assert pr["tasks_completed"] == 0
        r = s.get(f"{API}/tasks")
        assert r.json()["tasks"] == []
