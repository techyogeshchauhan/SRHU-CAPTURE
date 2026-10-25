"""Bulk actions on My Events: submit / record several drafts at once, and a
teacher's bulk delete -- each draft checked exactly as the form checks it."""

import unittest
from unittest.mock import patch

from bson import ObjectId
from fastapi.testclient import TestClient

from app.database import (
    event_documents,
    event_media,
    events,
    managed_event_documents,
    managed_event_media,
    managed_events,
    users,
)
from app.main import app
from app.utils.security import create_access_token
from app.utils.serializers import utc_now

DETAILS = {
    "event_type": "Seminar", "event_date": "2026-09-10", "location": "Hall",
    "description": "Talk.", "start_time": "10:00", "end_time": "11:00", "organizer": "CS",
}


def _user(role: str) -> dict:
    return {"_id": ObjectId(), "name": role.title(), "email": f"{role}-{ObjectId()}@srhu.edu.in",
            "role": role, "is_active": True, "email_verified": True, "token_version": 0}


class BulkDraftTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.teacher, self.other, self.manager = _user("teacher"), _user("teacher"), _user("event_manager")
        users.insert_many([self.teacher, self.other, self.manager])
        self.ids: list[ObjectId] = []
        self.managed: list[ObjectId] = []
        # Deans are told about each submission; the test does not send email.
        patcher = patch("app.routers.events.announce_to_deans")
        self.announce = patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        users.delete_many({"_id": {"$in": [self.teacher["_id"], self.other["_id"], self.manager["_id"]]}})
        keys = [str(i) for i in self.ids]
        events.delete_many({"_id": {"$in": self.ids}})
        event_media.delete_many({"event_id": {"$in": keys}})
        event_documents.delete_many({"event_id": {"$in": keys}})
        mkeys = [str(i) for i in self.managed]
        managed_events.delete_many({"_id": {"$in": self.managed}})
        managed_event_media.delete_many({"event_id": {"$in": mkeys}})
        managed_event_documents.delete_many({"event_id": {"$in": mkeys}})

    def auth(self, person: dict) -> dict:
        token, _ = create_access_token(str(person["_id"]), person["role"])
        return {"Authorization": f"Bearer {token}"}

    def draft(self, name: str, *, owner=None, status="draft", evidence=True, **fields) -> str:
        oid = ObjectId()
        events.insert_one({"_id": oid, "event_name": name, "status": status,
                           "teacher_id": str((owner or self.teacher)["_id"]),
                           "created_at": utc_now(), **DETAILS, **fields})
        self.ids.append(oid)
        if evidence:
            event_media.insert_one({"event_id": str(oid), "media_type": "image", "file_name": "a.png"})
            event_documents.insert_one({"event_id": str(oid), "file_name": "n.pdf"})
        return str(oid)

    def test_bulk_submit_sends_ready_drafts_and_explains_the_rest(self) -> None:
        ready = self.draft("Ready One")
        ready2 = self.draft("Ready Two")
        bare = self.draft("No Files", evidence=False)
        future = self.draft("Future Date", event_date="2099-01-01")
        submitted = self.draft("Already Sent", status="pending")
        theirs = self.draft("Not Mine", owner=self.other)

        response = self.client.post(
            "/teacher/events/bulk-submit",
            json={"event_ids": [ready, ready2, bare, future, submitted, theirs, "junk"]},
            headers=self.auth(self.teacher),
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        by_id = {r["event_id"]: r for r in body["results"]}
        self.assertEqual(body["submitted_count"], 2)
        self.assertEqual({by_id[ready]["status"], by_id[ready2]["status"]}, {"submitted"})
        self.assertIn("photo", by_id[bare]["reason"])
        self.assertIn("Complete the event details", by_id[future]["reason"])
        self.assertEqual(by_id[submitted]["status"], "skipped")
        self.assertEqual(by_id[theirs]["status"], "not_found")
        self.assertEqual(by_id["junk"]["status"], "not_found")

        stored = events.find_one({"_id": ObjectId(ready)})
        self.assertEqual(stored["status"], "pending")
        self.assertIsNotNone(stored.get("submitted_at"))
        self.assertEqual(stored["history"][-1]["action"], "submitted")
        self.assertEqual(events.find_one({"_id": ObjectId(bare)})["status"], "draft")
        self.assertEqual(self.announce.call_count, 2)  # the Deans hear about each one

    def test_teacher_bulk_delete_keeps_approved_events(self) -> None:
        d1 = self.draft("Draft")
        pending = self.draft("Waiting", status="pending")
        approved = self.draft("Approved", status="approved")
        response = self.client.post(
            "/teacher/events/bulk-delete",
            json={"event_ids": [d1, pending, approved]},
            headers=self.auth(self.teacher),
        )
        body = response.json()
        self.assertEqual(body["deleted_count"], 2, body)
        self.assertIsNone(events.find_one({"_id": ObjectId(d1)}))
        self.assertIsNone(events.find_one({"_id": ObjectId(pending)}))
        self.assertEqual(event_media.count_documents({"event_id": d1}), 0)  # files go with it
        self.assertIsNotNone(events.find_one({"_id": ObjectId(approved)}))
        by_id = {r["event_id"]: r for r in body["results"]}
        self.assertIn("approved", by_id[approved]["reason"])

    def test_only_teachers_use_the_teacher_routes(self) -> None:
        d1 = self.draft("Draft")
        for path in ("/teacher/events/bulk-submit", "/teacher/events/bulk-delete"):
            response = self.client.post(path, json={"event_ids": [d1]}, headers=self.auth(self.manager))
            self.assertEqual(response.status_code, 403, response.text)

    def test_event_manager_bulk_record(self) -> None:
        def managed(name, evidence=True, status="draft"):
            oid = ObjectId()
            managed_events.insert_one({"_id": oid, "event_name": name, "status": status,
                                       "owner_id": str(self.manager["_id"]), "created_at": utc_now(), **DETAILS})
            self.managed.append(oid)
            if evidence:
                managed_event_media.insert_one({"event_id": str(oid), "media_type": "image", "file_name": "a.png"})
                managed_event_documents.insert_one({"event_id": str(oid), "file_name": "n.pdf"})
            return str(oid)

        ready, bare, done = managed("Ready"), managed("Bare", evidence=False), managed("Done", status="recorded")
        response = self.client.post(
            "/event-manager/events/bulk-record",
            json={"event_ids": [ready, bare, done]},
            headers=self.auth(self.manager),
        )
        body = response.json()
        self.assertEqual(body["recorded_count"], 1, body)
        stored = managed_events.find_one({"_id": ObjectId(ready)})
        # Event Manager events now go to the Dean for approval, like a teacher's.
        self.assertEqual(stored["status"], "pending")
        self.assertIsNotNone(stored.get("submitted_at"))
        by_id = {r["event_id"]: r for r in body["results"]}
        self.assertIn("photo", by_id[bare]["reason"])
        self.assertEqual(by_id[done]["reason"], "Already submitted.")


if __name__ == "__main__":
    unittest.main()
