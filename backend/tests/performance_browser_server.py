"""Loopback performance fixture: real routes/auth, disposable in-memory data.

Run from backend with PERFORMANCE_SESSION_FILE set to a temporary JSON path.
Never runs the application lifespan or touches the configured database.
"""
import json
import os
from pathlib import Path

from tests.gallery_research_browser_server import configure, app
from tests.test_research import PEOPLE, PATENT, _user
from app import database
from app.models.documents import new_research_record_document
from app.utils.security import create_access_token
from app.utils.serializers import serialize


def seed():
    configure()
    sessions = {}
    for person in PEOPLE:
        user = serialize(database.users.find_one({"_id": person["_id"]}))
        token, expires = create_access_token(user["id"], role=user["role"])
        sessions[user["role"]] = {"access_token": token, "user": user, "expires_in": expires}
    manager = _user(PEOPLE[2])
    for number in range(60):
        record = new_research_record_document(
            faculty_id=str(PEOPLE[0]["_id"]), created_by=manager,
            category="patent", title=f"Performance patent {number:02d}",
            record_date="2026-10-01", outcome_status="filed", details=PATENT["details"],
        )
        record.update(verification_status="verified", verified_by=manager)
        database.research_records.insert_one(record)
    Path(os.environ["PERFORMANCE_SESSION_FILE"]).write_text(json.dumps({"sessions": sessions}), encoding="utf8")


if __name__ == "__main__":
    import uvicorn
    seed()
    uvicorn.run(app, host="127.0.0.1", port=8765, lifespan="off", access_log=False)
