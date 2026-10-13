"""Event Manager role: events, files, report photos and reports (no Dean review)."""

from __future__ import annotations

import copy
import io
import itertools
import os
import re
import unittest
from datetime import timedelta
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from bson import ObjectId  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

from app.main import app  # noqa: E402
from app.models.documents import ROLES  # noqa: E402
from app.schemas.events import campus_now  # noqa: E402
from app.services.managed_report_pdf import (  # noqa: E402
    BLOCK_MAX_HEIGHT,
    CONTENT_WIDTH,
    PHOTO_GAP,
    ROW_MAX_HEIGHT,
    Attachment,
    ReportEntry,
    build_managed_report_pdf,
    fit_within,
    layout_photos,
    orientation_of,
    prepare_photo,
)

MANAGER = {"id": "mgr1", "role": "event_manager", "name": "Asha Verma", "email": "asha@srhu.edu.in"}
OTHER_MANAGER = {"id": "mgr2", "role": "event_manager", "name": "B", "email": "b@srhu.edu.in"}
TEACHER = {"id": "t1", "role": "teacher", "name": "T", "email": "t@srhu.edu.in"}
DEAN = {"id": "d1", "role": "dean", "name": "D", "email": "d@srhu.edu.in"}
TOKENS = {"Bearer mgr": MANAGER, "Bearer mgr2": OTHER_MANAGER, "Bearer teacher": TEACHER, "Bearer dean": DEAN}


def past_date(days: int = 5) -> str:
    return (campus_now() - timedelta(days=days)).strftime("%Y-%m-%d")


# The Teacher form's body: department and expected participants ride in the
# description's metadata blob.
EVENT = {
    "event_name": "Himalayan Robotics Expo",
    "event_date": past_date(),
    "event_type": "Seminar",
    "location": "Main Auditorium",
    "description": 'Student robots on show.\n\n<!--CC_METADATA:{"department":"SST","expectedParticipants":"150 students"}-->',
    "start_time": "10:00",
    "end_time": "13:30",
    "organizer": "Dr. Rao",
    "coordinator_contact": "9876543210",
    "social_network_url": "https://www.instagram.com/p/abc/",
}

LIMITS = {
    "max_photos_per_event": 10,
    "max_photo_size_bytes": 20 * 1024 * 1024,
    "max_photo_total_bytes": None,
    "max_videos_per_event": None,
    "max_video_size_bytes": 200 * 1024 * 1024,
    "max_video_total_bytes": 200 * 1024 * 1024,
    "max_documents_per_event": 50,
    "max_documents_total_bytes": 15 * 1024 * 1024,
    "photos_required": True,
    "videos_required": False,
    "documents_required": True,
}


def image_bytes(width: int, height: int, fmt: str = "PNG", shade: int = 90) -> bytes:
    buffer = io.BytesIO()
    PILImage.new("RGB", (width, height), (40, shade, 160)).save(buffer, format=fmt)
    return buffer.getvalue()


# ---------------------------------------------------------------- fakes

def _matches(doc: dict, query: dict) -> bool:
    for key, cond in query.items():
        if key == "$or":
            if not any(_matches(doc, sub) for sub in cond):
                return False
            continue
        value = doc.get(key)
        if isinstance(cond, dict):
            if "$in" in cond and value not in cond["$in"]:
                return False
            if "$regex" in cond:
                flags = re.I if "i" in cond.get("$options", "") else 0
                if not isinstance(value, str) or not re.search(cond["$regex"], value, flags):
                    return False
        elif value != cond:
            return False
    return True


class FakeCursor(list):
    def sort(self, key, direction=None):
        keys = key if isinstance(key, list) else [(key, direction or 1)]
        for field, order in reversed(keys):
            super().sort(key=lambda d: (d.get(field) is None, d.get(field) or ""), reverse=order == -1)
        return self

    def skip(self, n):
        return FakeCursor(self[n:])

    def limit(self, n):
        return FakeCursor(self[:n])


class FakeCollection:
    def __init__(self):
        self.docs: dict[ObjectId, dict] = {}

    def insert_one(self, document):
        document.setdefault("_id", ObjectId())
        self.docs[document["_id"]] = copy.deepcopy(document)

        class Result:
            inserted_id = document["_id"]
        return Result()

    def find(self, query=None, projection=None):
        return FakeCursor(
            copy.deepcopy(d) for _id, d in sorted(self.docs.items()) if _matches(d, query or {})
        )

    def find_one(self, query=None, projection=None):
        found = self.find(query)
        return found[0] if found else None

    def count_documents(self, query):
        return len(self.find(query))

    def replace_one(self, query, replacement, upsert=False):
        doc = self.find_one(query)
        if doc:
            rep = copy.deepcopy(replacement)
            rep["_id"] = doc["_id"]
            self.docs[doc["_id"]] = rep
        elif upsert:
            self.insert_one(copy.deepcopy(replacement))

    def update_one(self, query, update):
        doc = self.find_one(query)
        if not doc:
            return None
        stored = self.docs[doc["_id"]]
        stored.update(copy.deepcopy(update.get("$set", {})))
        for field, value in update.get("$pull", {}).items():
            stored[field] = [item for item in stored.get(field) or [] if item != value]
        for field, value in update.get("$push", {}).items():
            stored.setdefault(field, []).append(copy.deepcopy(value))
        return stored

    def find_one_and_update(self, query, update, return_document=False):
        stored = self.update_one(query, update)
        return copy.deepcopy(stored) if stored else None

    def delete_one(self, query):
        doc = self.find_one(query)
        if doc:
            del self.docs[doc["_id"]]

    def delete_many(self, query):
        for doc in self.find(query):
            del self.docs[doc["_id"]]


class FakeGridOut:
    def __init__(self, data: bytes):
        self._data, self.length = io.BytesIO(data), len(data)

    def read(self, size=-1):
        return self._data.read(size)


class FakeFS:
    def __init__(self):
        self.files: dict[str, bytes] = {}

    def get(self, object_id):
        return FakeGridOut(self.files[str(object_id)])


class EventManagerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.events = FakeCollection()
        self.media = FakeCollection()
        self.documents = FakeCollection()
        self.reports = FakeCollection()
        self.fs = FakeFS()
        self.deleted: list[dict] = []

        def fake_save(buffer, *, file_name, content_type, kind, event_id, teacher_id):
            file_id = str(ObjectId())
            self.fs.files[file_id] = buffer.read()
            return {"storage": "gridfs", "object_key": None, "file_id": file_id, "url": f"/files/{file_id}"}

        from tests.fake_event_types import FakeEventTypes

        for target, value in (
            ("app.routers.event_manager.managed_events", self.events),
            ("app.routers.event_manager.managed_event_media", self.media),
            ("app.routers.event_manager.managed_event_documents", self.documents),
            ("app.routers.event_manager.event_reports", self.reports),
            ("app.routers.event_manager.fs", self.fs),
            ("app.routers.event_manager.save_upload", fake_save),
            ("app.routers.event_manager.delete_stored", self.deleted.append),
            ("app.routers.event_manager.get_upload_limits", lambda: dict(LIMITS)),
            ("app.services.event_types.event_types", FakeEventTypes()),
            ("app.routers.event_manager.get_current_user", self._user),
        ):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def _user(authorization):
        from fastapi import HTTPException

        user = TOKENS.get(authorization or "")
        if not user:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return user

    def call(self, method, path, token="mgr", **kwargs):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return self.client.request(method, path, headers=headers, **kwargs)

    def draft(self, token="mgr", **overrides):
        response = self.call("POST", "/event-manager/events", token, json={**EVENT, "save_as_draft": True, **overrides})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["event"]

    def photo(self, event_id, name="a.png", data=None, mime="image/png", token="mgr"):
        return self.call(
            "POST", f"/event-manager/events/{event_id}/media", token,
            files={"file": (name, data if data is not None else image_bytes(40, 30), mime)},
        )

    def document(self, event_id, name="agenda.pdf", token="mgr"):
        return self.call(
            "POST", f"/event-manager/events/{event_id}/documents", token,
            files={"file": (name, b"%PDF-1.4\n%%EOF\n", "application/pdf")},
        )

    def save(self, event_id, token="mgr", **overrides):
        return self.call("PATCH", f"/event-manager/events/{event_id}", token, json={**EVENT, **overrides})

    def recorded(self, token="mgr", **overrides):
        event = self.draft(token, **overrides)
        self.photo(event["id"], token=token)
        self.document(event["id"], token=token)
        response = self.save(event["id"], token, **overrides)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["event"]


# ============================================================
# ROLE AND ACCESS
# ============================================================

class RoleTests(EventManagerTestCase):
    def test_role_is_registered_alongside_the_existing_ones(self) -> None:
        self.assertEqual(ROLES, ("teacher", "dean", "superadmin", "event_manager"))

    def test_other_roles_are_refused(self) -> None:
        for token in ("teacher", "dean"):
            with self.subTest(token=token):
                self.assertEqual(self.call("GET", "/event-manager/events", token).status_code, 403)
                self.assertEqual(
                    self.call("POST", "/event-manager/events", token, json={**EVENT, "save_as_draft": True}).status_code,
                    403,
                )

    def test_signed_out_is_refused(self) -> None:
        self.assertEqual(self.call("GET", "/event-manager/events", token=None).status_code, 401)

    def test_a_manager_sees_only_their_own_events(self) -> None:
        mine = self.draft()
        self.draft(token="mgr2", event_name="Someone else's")
        listed = self.call("GET", "/event-manager/events").json()
        self.assertEqual([e["id"] for e in listed["events"]], [mine["id"]])
        self.assertEqual(self.call("GET", f"/event-manager/events/{mine['id']}", "mgr2").status_code, 404)


# ============================================================
# EVENTS: the teacher flow, recorded instead of pending
# ============================================================

class EventFlowTests(EventManagerTestCase):
    def test_create_is_a_draft_like_the_teacher_wizard(self) -> None:
        refused = self.call("POST", "/event-manager/events", json=EVENT)
        self.assertEqual(refused.status_code, 400)
        event = self.draft()
        self.assertEqual(event["status"], "draft")
        for key in ("event_name", "event_date", "location", "organizer", "coordinator_contact", "start_time"):
            self.assertEqual(event[key], EVENT[key], key)

    def test_saving_records_the_event_without_any_review(self) -> None:
        event = self.draft()
        self.photo(event["id"])
        self.document(event["id"])
        response = self.save(event["id"])
        self.assertEqual(response.status_code, 200, response.text)
        saved = response.json()["event"]
        self.assertEqual(saved["status"], "recorded")
        self.assertEqual(saved["history"][-1]["action"], "recorded")

    def test_mandatory_photo_and_document_as_for_teachers(self) -> None:
        event = self.draft()
        response = self.save(event["id"])
        self.assertEqual(response.status_code, 400)
        self.assertIn("photo", response.json()["detail"])
        self.photo(event["id"])
        self.assertIn("document", self.save(event["id"]).json()["detail"])

    def test_future_dates_are_refused_like_the_teacher_form(self) -> None:
        future = (campus_now() + timedelta(days=3)).strftime("%Y-%m-%d")
        response = self.call("POST", "/event-manager/events", json={**EVENT, "event_date": future, "save_as_draft": True})
        self.assertEqual(response.status_code, 422)

    def test_recorded_event_stays_editable_but_not_a_draft_again(self) -> None:
        event = self.recorded()
        edit = self.save(event["id"], location="Hall B")
        self.assertEqual(edit.status_code, 200)
        self.assertEqual(edit.json()["event"]["location"], "Hall B")
        self.assertEqual(edit.json()["event"]["history"][-1]["action"], "updated")
        again = self.save(event["id"], save_as_draft=True)
        self.assertEqual(again.status_code, 400)

    def test_detail_has_media_documents_and_report_photos(self) -> None:
        event = self.recorded()
        body = self.call("GET", f"/event-manager/events/{event['id']}").json()
        self.assertEqual(len(body["media"]), 1)
        self.assertEqual(len(body["documents"]), 1)
        self.assertEqual(body["event"]["report_photo_ids"], [body["media"][0]["id"]])
        self.assertTrue(body["media"][0]["media_url"].startswith("http"))

    def test_delete_removes_the_event_and_its_files(self) -> None:
        event = self.recorded()
        self.assertEqual(self.call("DELETE", f"/event-manager/events/{event['id']}").status_code, 200)
        self.assertEqual((self.events.docs, self.media.docs, self.documents.docs), ({}, {}, {}))
        self.assertEqual(len(self.deleted), 2)

    def test_recorded_event_keeps_its_last_mandatory_file(self) -> None:
        event = self.recorded()
        media_id = next(iter(self.media.docs))
        response = self.call("DELETE", f"/event-manager/events/{event['id']}/media/{media_id}")
        self.assertEqual(response.status_code, 400)
        self.photo(event["id"], name="b.png", data=image_bytes(50, 30))
        self.assertEqual(self.call("DELETE", f"/event-manager/events/{event['id']}/media/{media_id}").status_code, 200)

    def test_duplicate_name_check(self) -> None:
        event = self.draft()
        self.photo(event["id"], name="stage.png")
        body = self.call("GET", f"/event-manager/events/{event['id']}/uploads/check-name?file_name=stage.png&file_name=new.png").json()
        self.assertEqual(body["duplicates"], {"stage.png": True, "new.png": False})

    def test_a_fake_image_is_refused(self) -> None:
        event = self.draft()
        self.assertEqual(self.photo(event["id"], data=b"not an image").status_code, 400)


class BulkDeleteTests(EventManagerTestCase):
    def test_deletes_several_events_and_their_files_in_one_request(self) -> None:
        first = self.recorded(event_name="First")
        second = self.recorded(event_name="Second")
        keep = self.draft(event_name="Keep")
        response = self.call("POST", "/event-manager/events/bulk-delete", json={"event_ids": [first["id"], second["id"]]})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["deleted_count"], body["not_found_count"]), (2, 0))
        self.assertEqual([str(i) for i in self.events.docs], [keep["id"]])
        self.assertEqual((self.media.docs, self.documents.docs), ({}, {}))
        self.assertEqual(len(self.deleted), 4)  # a photo and a document each

    def test_other_managers_events_and_unknown_ids_are_not_touched(self) -> None:
        mine = self.draft()
        theirs = self.draft(token="mgr2", event_name="Theirs")
        response = self.call("POST", "/event-manager/events/bulk-delete",
                             json={"event_ids": [mine["id"], theirs["id"], "not-an-id"]}).json()
        statuses = {r["event_id"]: r["status"] for r in response["results"]}
        self.assertEqual(statuses[mine["id"]], "deleted")
        self.assertEqual(statuses[theirs["id"]], "not_found")
        self.assertEqual(statuses["not-an-id"], "not_found")
        self.assertEqual([str(i) for i in self.events.docs], [theirs["id"]])

    def test_other_roles_are_refused(self) -> None:
        event = self.draft()
        for token in ("teacher", "dean"):
            response = self.call("POST", "/event-manager/events/bulk-delete", token, json={"event_ids": [event["id"]]})
            self.assertEqual(response.status_code, 403)
        self.assertEqual(len(self.events.docs), 1)


# ============================================================
# REPORT PHOTOS
# ============================================================

class ReportPhotoTests(EventManagerTestCase):
    def photos(self, event_id, count):
        return [
            self.photo(event_id, name=f"{n}.png", data=image_bytes(40, 30, shade=10 * n)).json()["media"]["id"]
            for n in range(count)
        ]

    def test_default_is_the_first_four(self) -> None:
        event = self.draft()
        ids = self.photos(event["id"], 5)
        detail = self.call("GET", f"/event-manager/events/{event['id']}").json()["event"]
        self.assertEqual(detail["report_photo_ids"], ids[:4])
        self.assertFalse(detail["report_photos_chosen"])

    def test_choosing_report_photos(self) -> None:
        event = self.draft()
        ids = self.photos(event["id"], 5)
        response = self.call("PUT", f"/event-manager/events/{event['id']}/report-photos", json={"photo_ids": [ids[4], ids[1]]})
        self.assertEqual(response.status_code, 200, response.text)
        detail = self.call("GET", f"/event-manager/events/{event['id']}").json()["event"]
        self.assertEqual(detail["report_photo_ids"], [ids[4], ids[1]])
        self.assertTrue(detail["report_photos_chosen"])

    def test_four_can_be_chosen(self) -> None:
        event = self.draft()
        ids = self.photos(event["id"], 6)
        chosen = [ids[5], ids[0], ids[3], ids[2]]
        response = self.call("PUT", f"/event-manager/events/{event['id']}/report-photos", json={"photo_ids": chosen})
        self.assertEqual(response.status_code, 200, response.text)
        detail = self.call("GET", f"/event-manager/events/{event['id']}").json()["event"]
        self.assertEqual(detail["report_photo_ids"], chosen)

    def test_any_number_can_be_chosen(self) -> None:
        event = self.draft()
        ids = self.photos(event["id"], 6)
        response = self.call("PUT", f"/event-manager/events/{event['id']}/report-photos", json={"photo_ids": ids})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["report_photo_ids"], ids)

    def test_a_choice_beyond_any_event_is_refused(self) -> None:
        from app.schemas.event_manager import MAX_REPORT_PHOTO_CHOICE

        event = self.draft()
        ids = [str(ObjectId()) for _ in range(MAX_REPORT_PHOTO_CHOICE + 1)]
        response = self.call("PUT", f"/event-manager/events/{event['id']}/report-photos", json={"photo_ids": ids})
        self.assertEqual(response.status_code, 422)

    def test_only_photos_of_this_event(self) -> None:
        event = self.draft()
        doc = self.document(event["id"]).json()["document"]["id"]
        response = self.call("PUT", f"/event-manager/events/{event['id']}/report-photos", json={"photo_ids": [doc]})
        self.assertEqual(response.status_code, 400)

    def test_deleting_a_chosen_photo_drops_it(self) -> None:
        event = self.draft()
        ids = self.photos(event["id"], 3)
        self.call("PUT", f"/event-manager/events/{event['id']}/report-photos", json={"photo_ids": ids})
        self.call("DELETE", f"/event-manager/events/{event['id']}/media/{ids[0]}")
        detail = self.call("GET", f"/event-manager/events/{event['id']}").json()["event"]
        self.assertEqual(detail["report_photo_ids"], ids[1:])


# ============================================================
# REPORTS
# ============================================================

def pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover - optional in deployments
        raise unittest.SkipTest("pypdf not installed")
    return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages)


def pdf_links(data: bytes) -> list[str]:
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover - optional in deployments
        raise unittest.SkipTest("pypdf not installed")

    links = []
    for page in PdfReader(io.BytesIO(data)).pages:
        for annot in page.get("/Annots") or []:
            action = annot.get_object().get("/A") or {}
            if action.get("/URI"):
                links.append(str(action["/URI"]))
    return links


class ReportTests(EventManagerTestCase):
    def seeded(self, **overrides):
        event = self.draft(**overrides)
        self.photo(event["id"], name="portrait.png", data=image_bytes(300, 600))
        self.photo(event["id"], name="landscape.jpg", data=image_bytes(800, 450, "JPEG"), mime="image/jpeg")
        self.document(event["id"])
        self.assertEqual(self.save(event["id"], **overrides).status_code, 200)
        return event

    def test_single_report_has_details_photos_and_links_but_no_approval(self) -> None:
        event = self.seeded()
        response = self.call("GET", f"/event-manager/events/{event['id']}/report")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["content-type"], "application/pdf")
        text = pdf_text(response.content)
        for expected in ("Himalayan Robotics Expo", "Main Auditorium", "Dr. Rao", "150 students", "SST",
                         "10:00 AM", "Student robots on show.", "Event Photos", "Uploaded Notices", "Uploaded Attachments",
                         "agenda.pdf", "Asha Verma"):
            self.assertIn(expected, text)
        self.assertNotIn("CC_METADATA", text)
        for word in ("Approv", "Pending", "Rejected", "Status"):
            self.assertNotIn(word, text)
        self.assertIn("Swami Rama Himalayan University", text.split("Signed by:")[-1])
        self.assertIn("S. No.", text)                      # attachments table header
        self.assertNotIn("Ref.", text)                     # no reference number
        self.assertNotIn("Event Documentation", text)      # no "Campus Capture" line up top
        links = [u for u in pdf_links(response.content) if "/event-manager/files/" in u]
        self.assertEqual(len(links), 3)

    def test_download_link_serves_the_file_without_login(self) -> None:
        event = self.seeded()
        report = self.call("GET", f"/event-manager/events/{event['id']}/report")
        link = next(u for u in pdf_links(report.content) if "/event-manager/files/documents/" in u)
        path = link.split("://", 1)[1].split("/", 1)[1]
        response = self.client.get("/" + path)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("attachment", response.headers["content-disposition"])

    def test_tampered_or_expired_link_is_refused(self) -> None:
        self.seeded()
        file_id = str(next(iter(self.documents.docs)))
        self.assertEqual(self.client.get(f"/event-manager/files/documents/{file_id}?exp=9999999999&sig=00").status_code, 403)
        from app.services.report_files import link_signature

        expired = link_signature("managed", "documents", file_id, 1000)
        self.assertEqual(self.client.get(f"/event-manager/files/documents/{file_id}?exp=1000&sig={expired}").status_code, 403)
        # A link signed for one kind does not open the other.
        other = link_signature("managed", "media", file_id, 9999999999)
        self.assertEqual(self.client.get(f"/event-manager/files/documents/{file_id}?exp=9999999999&sig={other}").status_code, 403)
        # Nor does a link from a Dean report (teacher files) open a managed file.
        dean = link_signature("event", "documents", file_id, 9999999999)
        self.assertEqual(self.client.get(f"/event-manager/files/documents/{file_id}?exp=9999999999&sig={dean}").status_code, 403)
        good = link_signature("managed", "documents", file_id, 9999999999)
        self.assertEqual(self.client.get(f"/event-manager/files/documents/{file_id}?exp=9999999999&sig={good}").status_code, 200)

    def test_multi_event_report_in_one_request(self) -> None:
        first = self.seeded(event_name="First Talk")
        second = self.seeded(event_name="Second Talk", event_date=past_date(9))
        response = self.call("POST", "/event-manager/reports", json={"event_ids": [second["id"], first["id"]]})
        self.assertEqual(response.status_code, 200, response.text)
        text = pdf_text(response.content)
        self.assertIn("CONSOLIDATED EVENT REPORT", text)
        self.assertLess(text.index("EVENT 1 OF 2"), text.index("EVENT 2 OF 2"))
        self.assertLess(text.rindex("Second Talk"), text.rindex("First Talk"))
        self.assertNotIn("Approv", text)

    def test_multi_report_file_name(self) -> None:
        first = self.seeded(event_name="First Talk")
        second = self.seeded(event_name="Second Talk")
        response = self.call("POST", "/event-manager/reports", json={"event_ids": [first["id"], second["id"]]})
        self.assertRegex(
            response.headers["content-disposition"],
            r"filename\*=UTF-8''Consolidated_Event_Report_\d{4}-\d{2}-\d{2}\.pdf",
        )
        self.assertIn("Asha Verma", pdf_text(response.content).split("Contents")[0])  # the requester

    def test_multi_report_refuses_someone_elses_event(self) -> None:
        mine = self.draft()
        theirs = self.draft(token="mgr2")
        response = self.call("POST", "/event-manager/reports", json={"event_ids": [mine["id"], theirs["id"]]})
        self.assertEqual(response.status_code, 404)

    def test_teacher_cannot_generate_a_manager_report(self) -> None:
        event = self.draft()
        self.assertEqual(self.call("GET", f"/event-manager/events/{event['id']}/report", "teacher").status_code, 403)

    def test_manager_report_customization_filtering(self) -> None:
        event = self.seeded()
        payload = {
            "include_basic_details": True,
            "include_schedule_venue": True,
            "include_description": False,
            "include_other_info": True,
            "include_photos": False,
            "include_documents": True,
        }
        response = self.call("POST", f"/event-manager/events/{event['id']}/report", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["content-type"], "application/pdf")
        text = pdf_text(response.content)
        self.assertNotIn("Event Description & Objectives", text)
        self.assertNotIn("Event Photos", text)
        self.assertIn("1. Event Details", text)
        self.assertIn("Himalayan Robotics Expo", text)

    def test_manager_report_notice_and_report_filtering(self) -> None:
        event = self.draft()
        self.call(
            "POST", f"/event-manager/events/{event['id']}/documents", "mgr",
            files={"file": ("notice.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")},
            data={"category": "notice"},
        )
        self.call(
            "POST", f"/event-manager/events/{event['id']}/documents", "mgr",
            files={"file": ("summary_report.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")},
            data={"category": "report"},
        )
        self.save(event["id"])

        # Include notices only:
        resp = self.call("POST", f"/event-manager/events/{event['id']}/report", json={
            "include_notices": True,
            "include_reports": False,
        })
        self.assertEqual(resp.status_code, 200)
        text = pdf_text(resp.content)
        self.assertIn("Uploaded Notices", text)
        self.assertIn("notice.pdf", text)
        self.assertNotIn("Uploaded Attachments", text)
        self.assertNotIn("summary_report.pdf", text)

        # Include reports only:
        resp2 = self.call("POST", f"/event-manager/events/{event['id']}/report", json={
            "include_notices": False,
            "include_reports": True,
        })
        self.assertEqual(resp2.status_code, 200)
        text2 = pdf_text(resp2.content)
        self.assertNotIn("Uploaded Notices", text2)
        self.assertNotIn("notice.pdf", text2)
        self.assertIn("Uploaded Attachments", text2)
        self.assertIn("summary_report.pdf", text2)

    def test_manager_report_selected_photo_ids(self) -> None:
        event = self.draft()
        photo_resp = self.photo(event["id"])
        self.assertEqual(photo_resp.status_code, 201)
        photo_id = photo_resp.json()["media"]["id"]
        self.save(event["id"])

        payload = {
            "include_photos": True,
            "selected_photo_ids": [photo_id, "nonexistent_id"],
        }
        response = self.call("POST", f"/event-manager/events/{event['id']}/report", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["content-type"], "application/pdf")
        text = pdf_text(response.content)
        self.assertIn("Event Photos", text)

    def test_manager_report_all_false_rejected(self) -> None:
        event = self.seeded()
        payload = {
            "include_basic_details": False,
            "include_schedule_venue": False,
            "include_description": False,
            "include_other_info": False,
            "include_photos": False,
            "include_documents": False,
        }
        response = self.call("POST", f"/event-manager/events/{event['id']}/report", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("select at least one section", response.json()["detail"])

    def test_manager_multi_event_customization(self) -> None:
        first = self.seeded(event_name="Alpha Talk")
        second = self.seeded(event_name="Beta Talk")
        payload = {
            "event_ids": [first["id"], second["id"]],
            "customization": {
                "include_description": False,
                "include_photos": False,
            },
        }
        response = self.call("POST", "/event-manager/reports", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        text = pdf_text(response.content)
        self.assertNotIn("Event Description & Objectives", text)
        self.assertNotIn("Event Photos", text)
        self.assertIn("Alpha Talk", text)
        self.assertIn("Beta Talk", text)


class PhotoLayoutTests(unittest.TestCase):
    def test_orientation(self) -> None:
        self.assertEqual(orientation_of(300, 600), "portrait")
        self.assertEqual(orientation_of(800, 450), "landscape")

    def test_aspect_ratio_is_kept(self) -> None:
        for size in ((300, 600), (800, 450), (500, 500), (4000, 1000)):
            w, h = fit_within(*size, (84, 60))
            self.assertAlmostEqual(w / h, size[0] / size[1], places=6)
            self.assertLessEqual(w, 84 + 1e-9)
            self.assertLessEqual(h, 60 + 1e-9)

    def test_rows_fit_the_page(self) -> None:
        for sizes in (
            [(300, 600)] * 3, [(800, 450)] * 3, [(800, 450), (300, 600), (300, 600)],
            [(300, 600)] * 4, [(800, 450)] * 4, [(800, 450), (300, 600), (300, 600), (800, 450)],
        ):
            rows = layout_photos(sizes)
            self.assertEqual(sum(len(r) for r in rows), len(sizes))
            for row in rows:
                width = sum(w for _, w, _ in row) + PHOTO_GAP * (len(row) - 1)
                self.assertLessEqual(width, CONTENT_WIDTH + 1e-6)

    def test_three_portraits_share_one_row(self) -> None:
        self.assertEqual(len(layout_photos([(300, 600)] * 3)), 1)


    SHAPES = {
        "P": (1200, 1600), "L": (1600, 1200),   # 3:4 / 4:3 phone photos
        "p": (900, 1600), "l": (1600, 900),     # 9:16 / 16:9
        "S": (1000, 1000),
    }

    def every_mix(self):
        """Every portrait/landscape sequence of one to four photos, plus
        the other common aspect ratios mixed in."""
        for count in range(1, 5):
            for combo in itertools.product("PL", repeat=count):
                yield "".join(combo)
        yield from ("pppp", "llll", "plll", "ppll", "SSSS", "SPLl", "lll", "pll", "pLlP")

    def test_every_mix_is_one_clean_block(self) -> None:
        for combo in self.every_mix():
            sizes = [self.SHAPES[c] for c in combo]
            rows = layout_photos(sizes)
            with self.subTest(combo=combo):
                # Each photo exactly once, at its own aspect ratio.
                placed = sorted(i for row in rows for i, _, _ in row)
                self.assertEqual(placed, list(range(len(sizes))))
                for row in rows:
                    for i, w, h in row:
                        self.assertAlmostEqual(w / h, sizes[i][0] / sizes[i][1], places=6)
                # Justified: one height per row, and every row the same width,
                # so there is no blank space inside or beside the block.
                widths = []
                for row in rows:
                    self.assertAlmostEqual(max(h for _, _, h in row), min(h for _, _, h in row), places=6)
                    widths.append(sum(w for _, w, _ in row) + PHOTO_GAP * (len(row) - 1))
                    self.assertLessEqual(row[0][2], ROW_MAX_HEIGHT + 1e-6)
                self.assertAlmostEqual(max(widths), min(widths), places=4)
                self.assertLessEqual(widths[0], CONTENT_WIDTH + 1e-6)
                height = sum(row[0][2] for row in rows) + PHOTO_GAP * (len(rows) - 1)
                self.assertLessEqual(height, BLOCK_MAX_HEIGHT + 1e-6)

    def test_up_to_three_photos_share_one_full_width_row(self) -> None:
        for count in (2, 3):
            for combo in itertools.product("PL", repeat=count):
                rows = layout_photos([self.SHAPES[c] for c in combo])
                self.assertEqual(len(rows), 1, combo)
        mixed = layout_photos([self.SHAPES[c] for c in "PLL"])[0]
        self.assertAlmostEqual(sum(w for _, w, _ in mixed) + 2 * PHOTO_GAP, CONTENT_WIDTH)

    def test_mixed_four_pair_a_portrait_with_a_landscape(self) -> None:
        # In chosen order this would be a tall portrait row over a thin
        # landscape row; one of each per row gives two even rows instead.
        rows = layout_photos([self.SHAPES[c] for c in "PPLL"])
        self.assertEqual([sorted(i for i, _, _ in row) for row in rows], [[0, 2], [1, 3]])
        self.assertAlmostEqual(rows[0][0][2], rows[1][0][2], places=4)

    def test_chosen_order_is_kept_when_it_lays_out_well(self) -> None:
        for combo in ("LLLL", "PPPP", "PLPL", "LLL", "PL"):
            rows = layout_photos([self.SHAPES[c] for c in combo])
            order = [i for row in rows for i, _, _ in row]
            self.assertEqual(order, list(range(len(combo))), combo)

    def test_four_landscapes_make_a_two_by_two_grid(self) -> None:
        for shape in ("L", "l"):
            self.assertEqual([len(r) for r in layout_photos([self.SHAPES[shape]] * 4)], [2, 2])

    def test_four_portraits_make_one_compact_row(self) -> None:
        rows = layout_photos([self.SHAPES["P"]] * 4)
        self.assertEqual([len(r) for r in rows], [4])

    def test_a_lone_photo_is_not_page_sized(self) -> None:
        for shape in ("P", "L"):
            (_, w, h), = layout_photos([self.SHAPES[shape]])[0]
            self.assertLessEqual(h, ROW_MAX_HEIGHT + 1e-6)
            self.assertLessEqual(w, CONTENT_WIDTH + 1e-6)

    def test_exif_rotation_decides_orientation(self) -> None:
        # Stored landscape, tagged "rotate 90": people saw it as portrait.
        image = PILImage.new("RGB", (800, 450), "white")
        exif = image.getexif()
        exif[0x0112] = 6
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", exif=exif)
        _, width, height = prepare_photo(buffer.getvalue())
        self.assertEqual(orientation_of(width, height), "portrait")

    def test_unreadable_photo_is_skipped(self) -> None:
        self.assertIsNone(prepare_photo(b"nope"))

    def test_report_embeds_every_chosen_photo(self) -> None:
        # Distinct pixels: ReportLab stores identical images only once.
        photos = [prepare_photo(image_bytes(80, 60, shade=20 * n)) for n in range(9)]
        pdf = build_managed_report_pdf([ReportEntry(event={"event_name": "X"}, photos=photos)]).getvalue()
        self.assertEqual(pdf.count(b"/Subtype /Image"), 9 + 1)  # nine photos + the crest
        self.assertEqual(pdf_text(pdf).count("Event Photos"), 1)  # one section, several blocks

    def test_photo_groups_are_small_and_even(self) -> None:
        from app.services.managed_report_pdf import PHOTOS_PER_BLOCK, photo_groups

        self.assertEqual(photo_groups(0), [])
        self.assertEqual([len(g) for g in photo_groups(4)], [4])
        self.assertEqual([len(g) for g in photo_groups(5)], [3, 2])  # never 4 + a lone photo
        self.assertEqual([len(g) for g in photo_groups(9)], [3, 3, 3])
        for count in range(1, 60):
            groups = photo_groups(count)
            self.assertEqual([i for g in groups for i in g], list(range(count)))  # order kept
            self.assertLessEqual(max(map(len, groups)), PHOTOS_PER_BLOCK)
            self.assertLessEqual(max(map(len, groups)) - min(map(len, groups)), 1)

    def test_photo_row_shrinks_into_the_space_left(self) -> None:
        from app.services.managed_report_pdf import MIN_PHOTO_SCALE, _PhotoGrid

        buffer, width, height = prepare_photo(image_bytes(300, 600))
        draw_w, draw_h = fit_within(width, height, (54, 70))
        row = _PhotoGrid([[(buffer, draw_w, draw_h)]])
        _, natural = row.wrap(500, 10_000)
        _, squeezed = row.wrap(500, natural * 0.7)
        self.assertLessEqual(squeezed, natural * 0.7 + 1e-6)
        self.assertAlmostEqual(row._scale, 0.7, places=3)
        # Too little room even at the smallest scale: it keeps its size and
        # the frame moves it to the next page.
        _, moved = row.wrap(500, natural * (MIN_PHOTO_SCALE - 0.1))
        self.assertAlmostEqual(moved, natural)

    def test_photo_rows_shrink_together(self) -> None:
        """Two rows share one scale, so the second never ends up smaller."""
        from app.services.managed_report_pdf import _PhotoGrid

        buffer, width, height = prepare_photo(image_bytes(300, 400))
        draw_w, draw_h = fit_within(width, height, (54, 70))
        grid = _PhotoGrid([[(buffer, draw_w, draw_h)] * 2] * 2)
        _, natural = grid.wrap(500, 10_000)
        self.assertAlmostEqual(natural, 2 * draw_h + 2 * PHOTO_GAP)
        _, squeezed = grid.wrap(500, natural * 0.8)
        self.assertAlmostEqual(grid._scale, 0.8, places=3)
        self.assertLessEqual(squeezed, natural * 0.8 + 1e-6)

    def test_event_without_files_has_no_empty_sections(self) -> None:
        pdf = build_managed_report_pdf([ReportEntry(event={"event_name": "Bare"})]).getvalue()
        text = pdf_text(pdf)
        self.assertNotIn("Event Photos", text)
        self.assertNotIn("Attachments", text)
        self.assertIn("2. Event Description", text)

    def test_consolidated_report_structure(self) -> None:
        try:
            from pypdf import PdfReader
        except ImportError:  # pragma: no cover - optional in deployments
            raise unittest.SkipTest("pypdf not installed")

        entries = [
            ReportEntry(
                event={"event_name": f"Talk {n}", "event_date": "2026-09-0" + str(n), "description": "Short."},
                recorded_by={"name": "Owner", "email": "owner@srhu.edu.in"},
            )
            for n in range(1, 5)
        ]
        pdf = build_managed_report_pdf(entries, prepared_by={"name": "Asha Verma", "email": "asha@srhu.edu.in"})
        reader = PdfReader(io.BytesIO(pdf.getvalue()))
        pages = [page.extract_text() or "" for page in reader.pages]

        # Cover, contents, then one page per event.
        self.assertEqual(len(pages), 6)
        self.assertIn("CONSOLIDATED EVENT REPORT", pages[0])
        self.assertIn("4 events", pages[0])
        self.assertIn("Asha Verma", pages[0])           # whoever generated it
        self.assertNotIn("Ref", "".join(pages))            # no reference anywhere
        self.assertIn("1 - 4 September 2026", pages[0])  # the period covered
        self.assertIn("Contents", pages[1])
        for number in range(1, 5):
            self.assertIn(f"EVENT {number} OF 4", pages[number + 1])
            self.assertIn(f"{number}. Talk {number}", pages[1])
        # Contents page numbers and PDF bookmarks both point at the events.
        self.assertEqual(re.findall(r"\.{5,}(\d+)", pages[1].replace(" ", "")), ["3", "4", "5", "6"])
        outline = {o.title: reader.get_destination_page_number(o) + 1 for o in reader.outline}
        self.assertEqual(outline, {"Cover": 1, "Contents": 2, "1. Talk 1": 3, "2. Talk 2": 4, "3. Talk 3": 5, "4. Talk 4": 6})
        # Every page carries the footer with the right total.
        for number, text in enumerate(pages, start=1):
            self.assertIn(f"Page {number} of 6", text)

    def test_single_report_has_no_cover_or_contents(self) -> None:
        pdf = build_managed_report_pdf([ReportEntry(event={"event_name": "Solo"})]).getvalue()
        text = pdf_text(pdf)
        self.assertIn("EVENT REPORT", text)
        self.assertNotIn("CONSOLIDATED", text)
        self.assertNotIn("Contents", text)

    def test_attachment_rows_carry_links(self) -> None:
        entry = ReportEntry(
            event={"event_name": "X"},
            attachments=[Attachment("notes.pdf", "document", 2048, "https://api.example/event-manager/files/1?exp=1&sig=a")],
        )
        pdf = build_managed_report_pdf([entry]).getvalue()
        self.assertIn("https://api.example/event-manager/files/1?exp=1&sig=a", pdf_links(pdf))


if __name__ == "__main__":
    unittest.main()
