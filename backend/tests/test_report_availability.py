"""POST /dean/reports/availability: which report sections an event can fill."""

from __future__ import annotations

import copy
import os
import unittest
from unittest.mock import patch

from bson import ObjectId

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


TEACHER = {"id": "teacher-1", "name": "Meera Joshi", "email": "meera@srhu.edu.in", "role": "teacher"}
DEAN = {"id": "dean-1", "name": "Aparna Sharma", "email": "dean@srhu.edu.in", "role": "dean"}
TOKENS = {"Bearer teacher": TEACHER, "Bearer dean": DEAN}


def fake_current_user(authorization):
    return TOKENS[authorization]


class FakeCursor(list):
    def sort(self, key, direction=1):
        return FakeCursor(sorted(self, key=lambda d: str(d.get(key) or ""), reverse=direction == -1))


class FakeCollection:
    """find_one by _id, and find by equality -- what reports.py reads."""

    def __init__(self, docs=None) -> None:
        self.docs = [copy.deepcopy(d) for d in (docs or [])]

    def _matches(self, doc, query):
        return all(doc.get(key) == value for key, value in query.items())

    def find_one(self, query, *_args, **_kwargs):
        return next((copy.deepcopy(d) for d in self.docs if self._matches(d, query)), None)

    def find(self, query=None, *_args, **_kwargs):
        return FakeCursor(copy.deepcopy(d) for d in self.docs if self._matches(d, query or {}))


def event(name, **extra):
    return {"_id": ObjectId(), "event_name": name, "status": "completed", "archived_at": None, **extra}


def files(event_doc, rows):
    return [{"_id": ObjectId(), "event_id": str(event_doc["_id"]), **row} for row in rows]


BLOB = '<!--CC_METADATA:{{"expectedParticipants": "{0}"}}-->'


class ReportAvailabilityTest(unittest.TestCase):
    def setUp(self) -> None:
        # Everything: photos, a video, a notice, a report document, text.
        self.full = event(
            "Full Event",
            description="A full write-up." + BLOB.format("120"),
            social_network_url="https://instagram.com/p/1",
        )
        # Nothing optional at all; its blob says 0 participants.
        self.bare = event("Bare Event", description=BLOB.format("0"))
        # An Event Manager's event, in the managed collections.
        self.recorded = event("Recorded Event", status="recorded", owner_id="manager-1")
        self.draft = event("Draft Event", status="draft", description="Hidden")

        media = files(self.full, [{"media_type": "image"}, {"media_type": "image"}, {"media_type": "video"}])
        documents = files(self.full, [{"category": "notice"}, {"category": "report"}])

        self.client = TestClient(app)
        self.patches = [
            patch("app.routers.reports.events", FakeCollection([self.full, self.bare, self.draft])),
            patch("app.routers.reports.managed_events", FakeCollection([self.recorded])),
            patch("app.routers.reports.event_media", FakeCollection(media)),
            patch("app.routers.reports.event_documents", FakeCollection(documents)),
            patch(
                "app.routers.reports.managed_event_media",
                FakeCollection(files(self.recorded, [{"media_type": "video"}])),
            ),
            patch("app.routers.reports.managed_event_documents", FakeCollection()),
            patch("app.routers.reports.get_current_user", fake_current_user),
        ]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in self.patches:
            patcher.stop()

    def post(self, ids, token="Bearer dean"):
        return self.client.post(
            "/dean/reports/availability",
            json={"event_ids": [str(i) for i in ids]},
            headers={"Authorization": token},
        )

    def test_an_event_with_everything(self):
        body = self.post([self.full["_id"]]).json()
        self.assertEqual(
            body["events"][str(self.full["_id"])],
            {
                "photos": 2,
                "videos": 1,
                "notices": 1,
                "report_documents": 1,
                "attachments": 4,  # the report document + 3 media links
                "has_description": True,
                "has_other_info": True,
            },
        )

    def test_an_event_with_nothing_optional(self):
        # The metadata blob is not a description, and "0" participants is none.
        body = self.post([self.bare["_id"]]).json()
        self.assertEqual(
            body["combined"],
            {
                "photos": 0,
                "videos": 0,
                "notices": 0,
                "report_documents": 0,
                "attachments": 0,
                "has_description": False,
                "has_other_info": False,
            },
        )

    def test_event_manager_media_counts(self):
        item = self.post([self.recorded["_id"]]).json()["events"][str(self.recorded["_id"])]
        self.assertEqual((item["photos"], item["videos"], item["attachments"]), (0, 1, 1))

    def test_combined_sums_counts_and_any_flags(self):
        body = self.post([self.full["_id"], self.bare["_id"], self.recorded["_id"]]).json()
        combined = body["combined"]
        self.assertEqual((combined["photos"], combined["videos"], combined["attachments"]), (2, 2, 5))
        self.assertTrue(combined["has_description"])
        self.assertTrue(combined["has_other_info"])

    def test_drafts_and_unknown_ids_are_left_out(self):
        body = self.post([self.draft["_id"], ObjectId(), self.bare["_id"]]).json()
        self.assertEqual(list(body["events"]), [str(self.bare["_id"])])

    def test_limits(self):
        self.assertEqual(self.post([]).status_code, 400)
        self.assertEqual(self.post([ObjectId() for _ in range(51)]).status_code, 400)

    def test_a_teacher_is_refused(self):
        self.assertEqual(self.post([self.full["_id"]], token="Bearer teacher").status_code, 403)


if __name__ == "__main__":
    unittest.main()
