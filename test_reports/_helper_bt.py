#!/usr/bin/env python3
"""Helper for Playwright tests to mutate Mongo state for the Buried Treasure app."""
import sys
from pymongo import MongoClient
db = MongoClient("mongodb://localhost:27017").test_database
ADMIN_ID = "03618ecf-464f-45db-9270-944d92d1b4a0"
INVITE_GID = "TEST_BT_INV_GROUP_FE"

action = sys.argv[1] if len(sys.argv) > 1 else ""

if action == "wipe":
    backup = db.bt_player_settings.find_one({"_id": ADMIN_ID})
    db["bt_test_backup"].replace_one({"_id": ADMIN_ID}, backup or {"_id": ADMIN_ID, "_none": True}, upsert=True)
    db.bt_player_settings.delete_one({"_id": ADMIN_ID})
    print("wiped")
elif action == "restore":
    bk = db["bt_test_backup"].find_one({"_id": ADMIN_ID}) or {}
    bk.pop("_none", None)
    if "lat" in bk:
        db.bt_player_settings.replace_one({"_id": ADMIN_ID}, bk, upsert=True)
    db["bt_test_backup"].delete_one({"_id": ADMIN_ID})
    print("restored")
elif action == "seed_invite":
    # Create a fake group and invite admin to it
    db.bt_groups.replace_one({"_id": INVITE_GID}, {
        "_id": INVITE_GID,
        "name": "TEST_BT_GRP_FE_invite",
        "creator_id": "SOMEONE_ELSE",
        "status": "lobby",
        "members": [
            {"user_id": "SOMEONE_ELSE", "role": "creator", "status": "accepted"},
            {"user_id": ADMIN_ID, "role": "member", "status": "pending"},
        ],
        "lat": 0, "lng": 0, "radius_m": 1000.0,
        "created_at": "2026-01-01T00:00:00+00:00",
    }, upsert=True)
    db.bt_invites.replace_one(
        {"group_id": INVITE_GID, "user_id": ADMIN_ID},
        {
            "group_id": INVITE_GID, "user_id": ADMIN_ID,
            "requires_view": True, "opened_at": None,
            "creator_name": "Someone Else", "group_name": "TEST_BT_GRP_FE_invite",
        },
        upsert=True,
    )
    print("invite_seeded")
elif action == "get_invite_gid":
    print(INVITE_GID)
elif action == "cleanup_invite":
    db.bt_invites.delete_many({"group_id": INVITE_GID})
    db.bt_groups.delete_one({"_id": INVITE_GID})
    print("invite_cleaned")
else:
    print(f"unknown action: {action}")
    sys.exit(1)
