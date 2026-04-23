"""Library+ mini-apps purchase flow + Gratitude Journal tests."""
import os
import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://xp-confidence.preview.emergentagent.com').rstrip('/')
API = f"{BASE_URL}/api"

APP_IDS = ["anxiety", "posture", "affirmations", "cold-shower", "gratitude"]
EXPECTED_PRICES = {
    "anxiety": "$2.99",
    "posture": "$1.99",
    "affirmations": "$1.99",
    "cold-shower": "$1.49",
    "gratitude": "$2.49",
}


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module", autouse=True)
def _cleanup(client):
    # Pre-cleanup: refund all apps to ensure fresh state
    for aid in APP_IDS:
        client.post(f"{API}/library/refund/{aid}")
    yield
    # Post-cleanup
    for aid in APP_IDS:
        client.post(f"{API}/library/refund/{aid}")


# -------- Library Apps --------
class TestLibraryApps:
    def test_list_apps_has_five(self, client):
        r = client.get(f"{API}/library/apps")
        assert r.status_code == 200
        data = r.json()
        assert data["total"] == 5
        assert len(data["apps"]) == 5
        ids = [a["id"] for a in data["apps"]]
        for aid in APP_IDS:
            assert aid in ids

    def test_prices_correct(self, client):
        r = client.get(f"{API}/library/apps")
        apps = {a["id"]: a for a in r.json()["apps"]}
        for aid, price in EXPECTED_PRICES.items():
            assert apps[aid]["price_label"] == price

    def test_fresh_all_unpurchased(self, client):
        r = client.get(f"{API}/library/apps")
        for a in r.json()["apps"]:
            assert a["purchased"] is False
        assert r.json()["purchased_count"] == 0

    def test_purchase_anxiety(self, client):
        r = client.post(f"{API}/library/purchase/anxiety")
        assert r.status_code == 200
        data = r.json()
        assert data["purchased"] is True
        assert data["app"]["id"] == "anxiety"
        assert "anxiety" in data["profile"]["purchased_apps"]

    def test_purchased_reflected_in_list(self, client):
        r = client.get(f"{API}/library/apps")
        apps = {a["id"]: a for a in r.json()["apps"]}
        assert apps["anxiety"]["purchased"] is True
        # Others still false
        for aid in ["posture", "affirmations", "cold-shower", "gratitude"]:
            assert apps[aid]["purchased"] is False

    def test_purchase_unknown_404(self, client):
        r = client.post(f"{API}/library/purchase/unknown-id")
        assert r.status_code == 404

    def test_purchase_idempotent(self, client):
        # Should not duplicate (addToSet)
        client.post(f"{API}/library/purchase/anxiety")
        r = client.get(f"{API}/profile")
        prof = r.json()
        assert prof["purchased_apps"].count("anxiety") == 1

    def test_refund_anxiety(self, client):
        r = client.post(f"{API}/library/refund/anxiety")
        assert r.status_code == 200
        assert "anxiety" not in r.json()["profile"]["purchased_apps"]
        r2 = client.get(f"{API}/library/apps")
        apps = {a["id"]: a for a in r2.json()["apps"]}
        assert apps["anxiety"]["purchased"] is False


# -------- Gratitude --------
class TestGratitude:
    def test_create_gratitude(self, client):
        payload = {"items": ["TEST_family", "TEST_health", "TEST_work"]}
        r = client.post(f"{API}/gratitude", json=payload)
        assert r.status_code == 200
        data = r.json()
        assert "id" in data
        assert data["items"] == payload["items"]
        assert "date" in data
        assert "created_at" in data

    def test_gratitude_persists_newest_first(self, client):
        # Create a marker entry
        marker = f"TEST_marker_{os.urandom(4).hex()}"
        r1 = client.post(f"{API}/gratitude", json={"items": [marker]})
        assert r1.status_code == 200
        r = client.get(f"{API}/gratitude")
        assert r.status_code == 200
        entries = r.json()["entries"]
        assert len(entries) >= 1
        # Newest first: our marker should be in the first few
        assert entries[0]["items"][0] == marker
        # Newest-first check: check created_at descending
        times = [e["created_at"] for e in entries]
        assert times == sorted(times, reverse=True)

    def test_gratitude_empty_returns_400(self, client):
        r = client.post(f"{API}/gratitude", json={"items": []})
        assert r.status_code == 400

    def test_gratitude_whitespace_only_returns_400(self, client):
        r = client.post(f"{API}/gratitude", json={"items": ["", "   "]})
        assert r.status_code == 400

    def test_gratitude_truncates_to_three(self, client):
        r = client.post(f"{API}/gratitude", json={"items": ["a", "b", "c", "d", "e"]})
        assert r.status_code == 200
        assert len(r.json()["items"]) == 3
