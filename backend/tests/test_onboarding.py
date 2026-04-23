"""Tests for onboarding, avatar, bio, task scheduled_time/reminder_enabled and seed."""
import os
import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://xp-confidence.preview.emergentagent.com').rstrip('/')
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module", autouse=True)
def reset_state(client):
    # Fresh DB state at start
    r = client.post(f"{API}/profile/reset")
    assert r.status_code == 200, r.text
    yield


# ---------- Profile / Onboarding ----------
class TestProfileFresh:
    def test_fresh_profile_has_flags(self, client):
        r = client.get(f"{API}/profile")
        assert r.status_code == 200
        d = r.json()
        assert d["onboarding_complete"] is False
        assert d["bio"] == ""
        assert d["avatar_base64"] is None
        assert d["name"] == "Hero"


class TestOnboardingUpdate:
    def test_partial_onboarding_builds_bio(self, client):
        payload = {
            "name": "TEST_Alex",
            "main_goals": ["Productive", "Get Fit"],
            "experience_level": "Beginner",
            "productivity_score": 7,
            "loves": ["Reading", "Gaming"],
            "focused_time": "Morning",
            "focused_window": "early",
            "good_habits": ["Reading"],
            "bad_habits": ["Scrolling Social Media"],
            "age_range": "21-25",
            "gender": "Boy",
        }
        r = client.put(f"{API}/profile/onboarding", json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["onboarding_complete"] is True
        assert d["bio"], "bio should be non-empty"
        bio = d["bio"].lower()
        # Verify bio contains several expected tokens
        assert "21-25" in bio
        assert "boy" in bio
        assert "beginner" in bio
        assert "productive" in bio or "get fit" in bio
        assert "reading" in bio
        assert "morning" in bio
        assert "7/10" in d["bio"]
        assert d["name"] == "TEST_Alex"

    def test_get_after_onboarding_persists(self, client):
        r = client.get(f"{API}/profile")
        d = r.json()
        assert d["onboarding_complete"] is True
        assert len(d["bio"]) > 20


class TestAvatar:
    def test_set_avatar_persists(self, client):
        b64 = "data:image/jpeg;base64,TEST_AVATAR_BASE64_CONTENT"
        r = client.post(f"{API}/profile/avatar", json={"avatar_base64": b64})
        assert r.status_code == 200, r.text
        assert r.json()["avatar_base64"] == b64
        # GET verify
        g = client.get(f"{API}/profile").json()
        assert g["avatar_base64"] == b64


class TestReset:
    def test_reset_clears_onboarding(self, client):
        r = client.post(f"{API}/profile/reset")
        assert r.status_code == 200
        d = r.json()
        assert d["onboarding_complete"] is False
        assert d["avatar_base64"] is None
        assert d["bio"] == ""


# ---------- Tasks with scheduled_time ----------
class TestTaskReminders:
    created_id = None

    def test_create_task_with_scheduled_time(self, client):
        body = {
            "title": "TEST_Reminder Task",
            "focus_area": "fitness",
            "time_slot": "morning",
            "xp_value": 25,
            "scheduled_time": "09:00",
            "reminder_enabled": True,
        }
        r = client.post(f"{API}/tasks", json=body)
        assert r.status_code == 200, r.text
        t = r.json()
        assert t["scheduled_time"] == "09:00"
        assert t["reminder_enabled"] is True
        TestTaskReminders.created_id = t["id"]

    def test_list_returns_scheduled_fields(self, client):
        r = client.get(f"{API}/tasks")
        assert r.status_code == 200
        tasks = r.json()["tasks"]
        mine = [t for t in tasks if t["id"] == TestTaskReminders.created_id]
        assert mine, "created task not found in list"
        assert mine[0]["scheduled_time"] == "09:00"
        assert mine[0]["reminder_enabled"] is True

    def test_cleanup_created_task(self, client):
        if TestTaskReminders.created_id:
            r = client.delete(f"{API}/tasks/{TestTaskReminders.created_id}")
            assert r.status_code == 200


class TestSeedDefaults:
    def test_seed_creates_reminded_tasks(self, client):
        # Reset to ensure tasks cleared, then seed
        client.post(f"{API}/profile/reset")
        r = client.post(f"{API}/seed")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["seeded"] is True
        assert d["count"] == 8

        tl = client.get(f"{API}/tasks").json()["tasks"]
        assert len(tl) == 8
        for t in tl:
            assert t.get("scheduled_time"), f"task {t['title']} missing scheduled_time"
            assert t.get("reminder_enabled") is True, f"task {t['title']} reminder_enabled not True"

    def test_seed_idempotent(self, client):
        r = client.post(f"{API}/seed")
        d = r.json()
        assert d["seeded"] is False
