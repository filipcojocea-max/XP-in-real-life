"""Focused re-verification of POST /api/leaderboard/report end-to-end after fix."""
from __future__ import annotations
import json
import sys
import uuid
import requests


def _read_backend_url() -> str:
    with open("/app/frontend/.env") as f:
        for line in f:
            line = line.strip()
            if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("EXPO_PUBLIC_BACKEND_URL not found")


BASE = _read_backend_url().rstrip("/") + "/api"
print(f"Testing against {BASE}")

PASS, FAIL = [], []


def chk(label, cond, info=""):
    if cond:
        PASS.append(label)
        print(f"  ✓ {label}")
    else:
        FAIL.append(f"{label} :: {info}")
        print(f"  ✗ {label} :: {info}")


def hauth(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def register(name):
    suffix = uuid.uuid4().hex[:10]
    email = f"{name.lower().replace(' ', '.')}.{suffix}@gmail.com"
    pwd = f"Pwd-{suffix}-XYZ"
    r = requests.post(
        f"{BASE}/auth/register",
        headers={"Content-Type": "application/json"},
        data=json.dumps({"full_name": name, "email": email, "password": pwd}),
    )
    if r.status_code != 200:
        raise RuntimeError(f"register failed: {r.status_code} {r.text[:300]}")
    body = r.json()
    return body["user"]["id"], body["token"]


def main():
    a_id, a_tok = register("Alice Reporter")
    b_id, b_tok = register("Bob Reportee")
    chk("registered Alice", bool(a_id and a_tok))
    chk("registered Bob", bool(b_id and b_tok))

    # Friend A & B
    r = requests.post(f"{BASE}/friends/request", headers=hauth(a_tok),
                      data=json.dumps({"user_id": b_id}))
    chk("A→B friend request 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{BASE}/friends/accept", headers=hauth(b_tok),
                      data=json.dumps({"user_id": a_id}))
    chk("B accepts → friends", r.status_code == 200 and r.json().get("status") == "friends",
        f"{r.status_code} {r.text[:200]}")

    # POST /leaderboard/report
    r = requests.post(f"{BASE}/leaderboard/report", headers=hauth(a_tok),
                      data=json.dumps({"reported_user_id": b_id,
                                        "reason": "Suspicious XP gain"}))
    chk("A reports B → 200 (no 500)", r.status_code == 200,
        f"got {r.status_code}: {r.text[:400]}")
    report_id = None
    report_doc = None
    if r.ok:
        body = r.json()
        report_doc = body.get("report")
        chk("response has 'report' key", isinstance(report_doc, dict), str(body)[:300])
        if isinstance(report_doc, dict):
            report_id = report_doc.get("id")
            chk("report.id present", bool(report_id), str(report_doc))
            # Confirm no ObjectId/_id leaks; entire payload should be JSON-serializable
            chk("report has no '_id' field (no ObjectId leak)",
                "_id" not in report_doc, f"keys={list(report_doc.keys())}")
            try:
                json.dumps(report_doc)
                chk("report payload is JSON serializable", True)
            except Exception as e:
                chk("report payload is JSON serializable", False, str(e))
            chk("reporter_id == A", report_doc.get("reporter_id") == a_id, str(report_doc))
            chk("reported_user_id == B", report_doc.get("reported_user_id") == b_id, str(report_doc))
            chk("reason persisted", report_doc.get("reason") == "Suspicious XP gain", str(report_doc))
            chk("week_key present", bool(report_doc.get("week_key")), str(report_doc))
            chk("reporter A in supporters",
                a_id in (report_doc.get("supporters") or []), str(report_doc.get("supporters")))

    if not report_id:
        print("\nABORT — no report_id, cannot continue support flow")
        sys.exit(1)

    # B supports the report
    r = requests.post(f"{BASE}/leaderboard/report/{report_id}/support",
                      headers=hauth(b_tok))
    chk("B supports report → 200", r.status_code == 200,
        f"{r.status_code} {r.text[:300]}")
    if r.ok:
        body = r.json()
        chk("supporters_count == 2 after B supports",
            body.get("supporters_count") == 2, f"got {body.get('supporters_count')} body={body}")

    # GET /friends/leaderboard from A
    r = requests.get(f"{BASE}/friends/leaderboard?tz=0", headers=hauth(a_tok))
    chk("A GET /friends/leaderboard → 200", r.status_code == 200,
        f"{r.status_code} {r.text[:200]}")
    if r.ok:
        body = r.json()
        reports = body.get("reports", [])
        ids = [rep.get("id") for rep in reports]
        chk("reports[] surfaces the report", report_id in ids,
            f"ids={ids}, expected={report_id}")
        match = next((rep for rep in reports if rep.get("id") == report_id), None)
        if match:
            chk("supporters_count == 2 in leaderboard payload",
                match.get("supporters_count") == 2, str(match))
            chk("viewer_is_reporter == true for A",
                match.get("viewer_is_reporter") is True, str(match))

    print("\n" + "=" * 60)
    print(f"PASS: {len(PASS)}  FAIL: {len(FAIL)}")
    if FAIL:
        print("\nFAILURES:")
        for f in FAIL:
            print(f"  - {f}")
        sys.exit(1)
    print("\nAll report-flow assertions passed.")


if __name__ == "__main__":
    main()
