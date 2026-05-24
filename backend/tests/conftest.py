import os
import pytest
import requests
from pathlib import Path


def _load_public_url() -> str:
    """Read the public preview URL from frontend/.env so we test what the
    user is hitting through the ingress, not localhost."""
    env_path = Path("/app/frontend/.env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            # Support both names — repo defines EXPO_PUBLIC_BACKEND_URL
            if k in ("EXPO_BACKEND_URL", "EXPO_PUBLIC_BACKEND_URL"):
                return v.rstrip("/")
    raise RuntimeError("EXPO_BACKEND_URL / EXPO_PUBLIC_BACKEND_URL missing from frontend/.env")


BASE_URL = _load_public_url()


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def admin_credentials():
    return {
        "email": "filip.cojocea122@gmail.com",
        "password": "XL98CZW5599",
    }


@pytest.fixture(scope="session")
def admin_token(api_client, admin_credentials):
    r = api_client.post(f"{BASE_URL}/api/auth/login", json=admin_credentials, timeout=30)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "token" in data, f"No token in login response: {data}"
    return data["token"]


@pytest.fixture(scope="session")
def admin_auth_header(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}
