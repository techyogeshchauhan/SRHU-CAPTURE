"""Loopback-only browser fixture: real routes/JWT auth, in-memory collections.

Run from backend: python -m tests.gallery_research_browser_server
Never starts MongoDB indexes, migrations, email, or application seed scripts.
"""

import os
import sys

os.environ["MONGODB_URI"] = "mongodb://127.0.0.1:27017"
os.environ["TEST_MONGODB_URI"] = "mongodb://127.0.0.1:27017"
os.environ["TEST_MONGODB_DB_NAME"] = "campus_capture_test"
os.environ["ALLOW_TESTS_ON_CONFIGURED_DB"] = "0"
os.environ["JWT_SECRET_KEY"] = "gallery-research-browser-test-secret-only"
os.environ["FRONTEND_URL"] = "http://127.0.0.1:5179"
os.environ["REQUIRE_EMAIL_VERIFICATION"] = "false"
os.environ["LOG_TO_FILES"] = "false"

from bson import ObjectId
from fastapi import Response
from pymongo.collection import Collection

from tests.test_research import FakeCollection as ResearchCollection, PEOPLE, LIMITS
from app import database
from app.main import app
from app.models.documents import new_user_document
from app.routers import research
from app.services import email_service
from app.utils.security import hash_password


class FakeCollection(ResearchCollection):
    pass


def configure():
    # Patch every already-imported collection handle, including aliases in
    # services/auth. Authentication itself and all authorization stay real.
    replacements = {}
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and module is not None:
            for key, value in list(vars(module).items()):
                if isinstance(value, Collection):
                    replacement = replacements.setdefault(id(value), FakeCollection())
                    setattr(module, key, replacement)
    # Any accidentally unpatched database access now fails instead of writing.
    database.client.close()
    password_hash = hash_password("Browser-test-only-123!")
    for person in PEOPLE:
        document = new_user_document(
            name=person["name"], email=person["email"], role=person["role"],
            password_hash=password_hash, email_verified=True,
        )
        document["_id"] = person["_id"]
        database.users.insert_one(document)
    research.get_upload_limits = lambda: dict(LIMITS)
    email_service.is_configured = lambda: False

    for number, title in enumerate(("Gallery browser workshop", "Gallery browser seminar")):
        event_id = ObjectId()
        database.events.insert_one({
            "_id": event_id, "event_name": title, "event_type": "Workshop",
            "event_date": "2026-10-01", "status": "approved", "archived_at": None,
            "created_at": "2026-10-01T09:00:00", "teacher_id": str(PEOPLE[0]["_id"]),
            "location": "Browser test room",
        })
        for photo in range(2):
            database.event_media.insert_one({
                "_id": ObjectId(), "event_id": str(event_id), "media_type": "image",
                "file_name": f"fixture-{number}-{photo}.svg",
                "media_url": "http://127.0.0.1:8765/__gallery_research_test__/image.svg",
                "created_at": f"2026-10-01T09:00:0{photo}",
            })


@app.get("/__gallery_research_test__/image.svg", include_in_schema=False)
def fixture_image():
    return Response(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">'
        '<rect width="800" height="600" fill="#244b65"/>'
        '<text x="80" y="300" fill="white" font-size="32">Gallery browser fixture</text></svg>',
        media_type="image/svg+xml",
    )


if __name__ == "__main__":
    import uvicorn

    configure()
    # app.main's real startup creates indexes and settles old research records;
    # this test fixture deliberately skips that lifespan and binds loopback only.
    uvicorn.run(app, host="127.0.0.1", port=8765, lifespan="off", access_log=False)
