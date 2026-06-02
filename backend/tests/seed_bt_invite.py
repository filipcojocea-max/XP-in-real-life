"""Seed a bt_invites doc for the admin user and print its group_id.

Run: python /app/backend/tests/seed_bt_invite.py [--cleanup]
"""
import os
import sys
import uuid
from datetime import datetime, timezone
from pymongo import MongoClient

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
ADMIN_EMAIL = "filip.cojocea122@gmail.com"

mongo = MongoClient(MONGO_URL)[DB_NAME]
admin = mongo.users.find_one({"email": ADMIN_EMAIL})
if not admin:
    print("ADMIN_NOT_FOUND")
    sys.exit(1)
admin_id = admin["_id"]

if "--cleanup" in sys.argv:
    mongo.bt_invites.delete_many({"_id": {"$regex": "^TEST_BT_INV_"}})
    print(f"CLEANED admin={admin_id}")
    sys.exit(0)

gid = f"TEST_BT_GRP_{uuid.uuid4().hex[:8]}"
doc_id = f"TEST_BT_INV_{uuid.uuid4().hex[:8]}"
doc = {
    "_id": doc_id,
    "user_id": admin_id,
    "group_id": gid,
    "group_name": "Test Treasure Squad",
    "group_code": "ABC123",
    "creator_id": "TEST_BT_CREATOR",
    "creator_name": "Test Buddy",
    "created_at": datetime.now(timezone.utc).isoformat(),
    "opened_at": None,
    "requires_view": True,
}
mongo.bt_invites.update_one({"_id": doc_id}, {"$set": doc}, upsert=True)
print(f"SEEDED admin_id={admin_id} group_id={gid} invite_doc_id={doc_id}")
