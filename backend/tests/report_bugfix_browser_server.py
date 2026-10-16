"""Loopback-only fixture: real auth/routes/PDF builder, in-memory database.

Run with BUGFIX_SESSION_FILE pointing at a temporary JSON file for Playwright.
R2 success/fault cases use the local Postman simulation on port 4907.
"""
import json
import os
import sys
from pathlib import Path

os.environ["MONGODB_URI"] = "mongodb://127.0.0.1:27017"
os.environ["JWT_SECRET_KEY"] = "bugfix-browser-test-secret-only-2026"
os.environ["FRONTEND_URL"] = "http://127.0.0.1:5183"
os.environ["LOG_TO_FILES"] = "false"
os.environ["R2_ACCOUNT_ID"] = "test"
os.environ["R2_ACCESS_KEY_ID"] = "test"
os.environ["R2_SECRET_ACCESS_KEY"] = "test"
os.environ["R2_BUCKET_NAME"] = "fixture"
os.environ["R2_ENDPOINT"] = "http://127.0.0.1:4907/storage"
os.environ["R2_PUBLIC_URL"] = ""

from bson import ObjectId
from pymongo.collection import Collection
from app import database
from app.main import app
from app.models.documents import new_user_document
from app.utils.security import create_access_token
from app.utils.serializers import serialize
from tests.test_event_manager import FakeCollection, FakeFS, image_bytes


def configure():
    replacements = {}
    file_store = FakeFS()
    original_fs = database.fs
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and module is not None:
            for key, value in list(vars(module).items()):
                if isinstance(value, Collection):
                    setattr(module, key, replacements.setdefault(id(value), FakeCollection()))
                elif value is original_fs:
                    setattr(module, key, file_store)
    database.client.close()  # Unpatched accesses cannot reach any real database.
    sessions = {}
    for role in ("teacher", "event_manager", "dean"):
        user = new_user_document(name=f"Bugfix {role}", email=f"{role}@example.test",
                                 role=role, password_hash="unused", email_verified=True)
        user["_id"] = ObjectId()
        database.users.insert_one(user)
        token, expires = create_access_token(str(user["_id"]), role=role)
        sessions[role] = {"access_token": token, "user": serialize(user), "expires_in": expires}

    event_ids = {}
    for label, role, state, storage in (("manager", "event_manager", "approved", "gridfs"),
                                       ("teacher", "teacher", "completed", "gridfs"),
                                       ("r2", "event_manager", "approved", "r2"),
                                       ("large", "event_manager", "approved", "large"),
                                       ("timeout", "event_manager", "approved", "hung"),
                                       ("drip", "event_manager", "approved", "drip")):
        event_id = ObjectId()
        key = str(event_id)
        event_ids[label] = key
        managed = role == "event_manager"
        events = database.managed_events if managed else database.events
        media = database.managed_event_media if managed else database.event_media
        events.insert_one({"_id": event_id, "event_name": f"Bugfix {label} workshop", "event_type": "Workshop",
                           "event_date": "2026-10-01", "status": state, "description": "Report download regression evidence.",
                           "location": "Test room", "history": [], "report_photo_ids": None,
                           "created_at": "2026-10-01T09:00:00Z",
                           "owner_id" if managed else "teacher_id": sessions[role]["user"]["id"]})
        for number in range(4 if label in ("manager", "r2", "large") else 1):
            file_id = ObjectId()
            content = image_bytes(60 + number, 40)
            file_store.files[str(file_id)] = content
            row = {"_id": ObjectId(), "event_id": key, "file_name": f"photo-{number}.png", "file_size": len(content),
                   "media_type": "image", "file_type": "image/png", "file_id": str(file_id),
                   "created_at": "2026-10-01T09:00:00Z"}
            if storage != "gridfs":
                row["object_key"] = f"{storage}-{number}.png"
                if storage == "large":
                    row["file_size"] = 14 * 1024 * 1024
            media.insert_one(row)
    payload = {"sessions": sessions, "events": event_ids}
    Path(os.environ["BUGFIX_SESSION_FILE"]).write_text(json.dumps(payload), encoding="utf8")


if __name__ == "__main__":
    import uvicorn
    configure()
    uvicorn.run(app, host="127.0.0.1", port=8767, lifespan="off")
