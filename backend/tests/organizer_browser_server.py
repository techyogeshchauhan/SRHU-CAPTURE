"""Loopback-only organizer workflow fixture; all database writes are in memory."""
import os
import json
from pathlib import Path
from bson import ObjectId

os.environ["BUGFIX_SESSION_FILE"] = os.environ["ORGANIZER_SESSION_FILE"]
from tests.report_bugfix_browser_server import configure, app
from tests.fake_event_types import FakeEventTypes
from app import database
from app.models.documents import new_faculty_coordinator_document
from app.services import event_types


def seed():
    configure()
    event_types.event_types = FakeEventTypes()
    for name, phone in [("Dr. Rao", "9876543210"), ("Dr. Verma", "9876543211")]:
        database.faculty_coordinators.insert_one(new_faculty_coordinator_document(name=name, phone=phone))
    path = Path(os.environ["ORGANIZER_SESSION_FILE"])
    fixture = json.loads(path.read_text(encoding="utf8"))
    for label, status, names in [("organizers", "approved", ["Dr. Rao", "Dr. Verma", "Guest Organizer"]),
                                  ("legacy", "draft", None)]:
        event = {"_id": ObjectId(), "event_name": f"Organizer fixture {label}", "event_type": "Seminar",
                 "event_date": "2026-10-01", "start_time": "10:00", "end_time": "11:00",
                 "location": "Test room", "description": "Organizer report validation.",
                 "organizer": "; ".join(names) if names else "Legacy Organizer",
                 "owner_id": fixture["sessions"]["event_manager"]["user"]["id"],
                 "status": status, "report_approval_required": True, "history": [],
                 "created_at": "2026-10-01T09:00:00Z"}
        if names:
            event["organizers"] = names
        database.managed_events.insert_one(event)
        fixture["events"][label] = str(event["_id"])
    path.write_text(json.dumps(fixture), encoding="utf8")


if __name__ == "__main__":
    import uvicorn
    seed()
    uvicorn.run(app, host="127.0.0.1", port=8767, lifespan="off", access_log=False)
