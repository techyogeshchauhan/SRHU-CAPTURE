"""Whole-platform read fixture; real handlers/JWT, only disposable collections."""
import json
import os
from pathlib import Path
from bson import ObjectId
from fastapi.responses import Response
from tests.performance_browser_server import seed, app
from app import database
from app.models.documents import new_user_document
from app.utils.security import create_access_token
from app.utils.serializers import serialize


@app.get("/__platform_test__/clip.mp4", include_in_schema=False)
def clip():
    return Response(Path(os.environ["PLATFORM_VIDEO_FILE"]).read_bytes(), media_type="video/mp4")


def configure():
    seed()
    path = Path(os.environ["PERFORMANCE_SESSION_FILE"])
    fixture = json.loads(path.read_text(encoding="utf8"))
    admin = new_user_document(name="Performance Admin", email="performance-admin@example.test", role="superadmin",
                              password_hash="unused", email_verified=True)
    admin["_id"] = ObjectId()
    database.users.insert_one(admin)
    token, expires = create_access_token(str(admin["_id"]), role="superadmin")
    fixture["sessions"]["superadmin"] = {"access_token": token, "user": serialize(admin), "expires_in": expires}
    for role in ("teacher", "event_manager"):
        collection = database.events if role == "teacher" else database.managed_events
        for n in range(120):
            collection.insert_one({"_id": ObjectId(), "event_name": f"Platform {role} {n:03d}",
                "teacher_id" if role == "teacher" else "owner_id": fixture["sessions"][role]["user"]["id"],
                "status": ["draft", "pending", "approved", "rejected", "revoked", "completed"][n % 6],
                "event_type": ["Workshop", "Seminar", "Community Outreach"][(n // 6) % 3],
                "event_date": f"2026-10-{1 + n % 8:02d}",
                "created_at": f"2026-10-{1 + n % 8:02d}T09:{n % 60:02d}:00Z",
                "description": "Performance fixture description. " * 40, "location": "Test room", "history": []})
    video_event = {"_id": ObjectId(), "event_name": "Platform video previews", "event_type": "Workshop",
                   "event_date": "2026-10-01", "created_at": "2026-10-01T09:00:00Z", "status": "approved",
                   "owner_id": fixture["sessions"]["event_manager"]["user"]["id"], "location": "Test room", "history": []}
    database.managed_events.insert_one(video_event)
    fixture["video_event"] = str(video_event["_id"])
    for n in range(100):
        database.managed_event_media.insert_one({"_id": ObjectId(), "event_id": str(video_event["_id"]),
            "media_type": "video", "file_name": f"clip-{n}.mp4", "content_type": "video/mp4",
            "media_url": f"http://127.0.0.1:8765/__platform_test__/clip.mp4?i={n}",
            "created_at": f"2026-10-01T09:{n // 60:02d}:{n % 60:02d}Z"})
    path.write_text(json.dumps(fixture), encoding="utf8")


if __name__ == "__main__":
    import uvicorn
    configure()
    uvicorn.run(app, host="127.0.0.1", port=8765, lifespan="off", access_log=False)
