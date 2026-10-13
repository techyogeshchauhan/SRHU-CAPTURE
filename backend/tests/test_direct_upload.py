"""Direct browser-to-R2 uploads (services/direct_upload.py and the
/uploads routes), against in-memory collections and an in-memory R2: no
database or object storage is touched."""

from __future__ import annotations

import copy
import itertools
import os
import unittest
from datetime import timedelta
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlsplit

from bson import ObjectId

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from botocore.exceptions import ClientError  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.services import direct_upload, r2_service  # noqa: E402
from app.utils.serializers import utc_now  # noqa: E402
from tests.test_event_history import EVENT_PAYLOAD, FakeEvents, NoUsers  # noqa: E402
from tests.test_event_manager import EVENT, EventManagerTestCase, LIMITS  # noqa: E402
from tests.test_uploads import FakeFiles  # noqa: E402


TEACHER = {"id": str(ObjectId()), "name": "Meera", "email": "m@srhu.edu.in", "role": "teacher"}
OTHER_TEACHER = {"id": str(ObjectId()), "name": "Ravi", "email": "r@srhu.edu.in", "role": "teacher"}
USERS = {"Bearer teacher": TEACHER, "Bearer other": OTHER_TEACHER}

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
MP4_HEAD = b"\x00\x00\x00\x18ftypmp42"
DOCX = b"PK\x03\x04" + b"\x00" * 64

# The tests shrink "a megabyte" to a kilobyte so multipart files stay small:
# the 16 MB threshold becomes 16 KB and a part 8 KB.
KB = 1024


def mp4(size: int) -> bytes:
    return MP4_HEAD + b"\x01" * (size - len(MP4_HEAD))


# ---------------------------------------------------------------- fakes

def _matches(doc: dict, query: dict) -> bool:
    for key, cond in query.items():
        value = doc.get(key)
        if isinstance(cond, dict) and any(op.startswith("$") for op in cond):
            for op, arg in cond.items():
                if op == "$in" and value not in arg:
                    return False
                if op == "$gt" and not (value is not None and value > arg):
                    return False
                if op == "$lt" and not (value is not None and value < arg):
                    return False
        elif value != cond:
            return False
    return True


class FakeSessionCursor(list):
    def limit(self, n):
        return FakeSessionCursor(self[:n])


class FakeSessions:
    """upload_sessions: equality, $in, $gt and $lt; $set updates."""

    def __init__(self) -> None:
        self.docs: dict[ObjectId, dict] = {}

    def insert_one(self, document):
        document.setdefault("_id", ObjectId())
        self.docs[document["_id"]] = copy.deepcopy(document)
        return MagicMock(inserted_id=document["_id"])

    def find(self, query, *_args, **_kwargs):
        return FakeSessionCursor(copy.deepcopy(d) for d in self.docs.values() if _matches(d, query))

    def find_one(self, query, *_args, **_kwargs):
        found = self.find(query)
        return found[0] if found else None

    def update_one(self, query, update):
        doc = next((d for d in self.docs.values() if _matches(d, query)), None)
        if doc is not None:
            doc.update(copy.deepcopy(update.get("$set", {})))
        return MagicMock(modified_count=int(doc is not None))

    def find_one_and_update(self, query, update, return_document=False):
        doc = next((d for d in self.docs.values() if _matches(d, query)), None)
        if doc is None:
            return None
        before = copy.deepcopy(doc)
        doc.update(copy.deepcopy(update.get("$set", {})))
        return copy.deepcopy(doc if return_document else before)


def _no_such_upload() -> ClientError:
    return ClientError({"Error": {"Code": "NoSuchUpload"}}, "ListParts")


class FakeR2:
    """Multipart uploads and objects, with the r2_service signatures."""

    def __init__(self) -> None:
        self.uploads: dict[str, dict] = {}
        self.objects: dict[str, dict] = {}
        self.aborted: list[str] = []
        self.deleted: list[str] = []
        self.signed: list[tuple[int, int]] = []
        self._ids = itertools.count(1)

    # --- what the API calls
    def create_multipart_upload(self, key, *, content_type, content_disposition=None, metadata=None):
        upload_id = f"up{next(self._ids)}"
        self.uploads[upload_id] = {
            "key": key, "parts": {}, "content_type": content_type,
            "disposition": content_disposition, "metadata": metadata,
        }
        return upload_id

    def presign_upload_part(self, key, *, upload_id, part_number, content_length, expires_in):
        self.signed.append((part_number, content_length))
        return f"https://r2.test/{key}?uploadId={upload_id}&partNumber={part_number}"

    def list_parts(self, key, *, upload_id):
        if upload_id not in self.uploads:
            raise _no_such_upload()
        return [
            {"PartNumber": n, "ETag": f'"etag{n}"', "Size": len(data)}
            for n, data in sorted(self.uploads[upload_id]["parts"].items())
        ]

    def complete_multipart_upload(self, key, *, upload_id, parts):
        upload = self.uploads.pop(upload_id)
        data = b"".join(upload["parts"][p["PartNumber"]] for p in parts)
        self.objects[key] = {"data": data, "content_type": upload["content_type"]}

    def abort_multipart_upload(self, key, *, upload_id):
        self.aborted.append(upload_id)
        self.uploads.pop(upload_id, None)
        return True

    def head_object(self, key):
        obj = self.objects.get(key)
        if obj is None:
            return None
        return {"ContentLength": len(obj["data"]), "ContentType": obj["content_type"]}

    def read_range(self, key, *, length):
        return self.objects[key]["data"][:length]

    def delete_object(self, key):
        self.deleted.append(key)
        self.objects.pop(key, None)
        return True

    def object_url(self, key, *, file_name=None, content_type=None):
        return f"https://r2.test/{key}?signature=get"

    # --- what the browser does
    def put(self, url: str, data: bytes) -> None:
        query = parse_qs(urlsplit(url).query)
        upload_id, number = query["uploadId"][0], int(query["partNumber"][0])
        if upload_id not in self.uploads:
            raise AssertionError("PUT to an upload that no longer exists")
        self.uploads[upload_id]["parts"][number] = data


def send_parts(r2: FakeR2, started: dict, data: bytes, skip=()) -> None:
    """The browser's side: PUT each part's slice to its URL."""
    size = started["part_size"]
    for part in started["parts"]:
        n = part["part_number"]
        if n in skip:
            continue
        r2.put(part["url"], data[(n - 1) * size:(n - 1) * size + part["size"]])


class R2Fixture:
    """Configure R2, and swap in the fake R2 and sessions collection."""

    def install_r2(self) -> None:
        self.r2 = FakeR2()
        self.sessions = FakeSessions()
        targets = [
            (settings, "r2_account_id", "acct"),
            (settings, "r2_access_key_id", "key"),
            (settings, "r2_secret_access_key", "secret"),
            (settings, "r2_bucket_name", "bucket"),
            (settings, "r2_public_url", None),
            (settings, "r2_direct_upload_enabled", True),
            (direct_upload, "MB", KB),
            (direct_upload, "upload_sessions", self.sessions),
            (direct_upload, "_last_sweep", float("inf")),  # no background sweep
        ]
        for name in (
            "create_multipart_upload", "presign_upload_part", "list_parts",
            "complete_multipart_upload", "abort_multipart_upload", "head_object",
            "read_range", "delete_object", "object_url",
        ):
            targets.append((r2_service, name, getattr(self.r2, name)))
        for target, attribute, value in targets:
            patcher = patch.object(target, attribute, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def only_session(self) -> dict:
        (session,) = self.sessions.docs.values()
        return session


# ---------------------------------------------------------------- teacher

class TeacherDirectUploadTests(R2Fixture, unittest.TestCase):
    auth = {"Authorization": "Bearer teacher"}

    def setUp(self) -> None:
        self.client = TestClient(app)
        self.events = FakeEvents()
        self.media = FakeFiles()
        self.documents = FakeFiles()
        self.install_r2()

        from tests.fake_event_types import FakeEventTypes

        for target, value in (
            ("app.routers.events.events", self.events),
            ("app.routers.events.event_media", self.media),
            ("app.routers.events.event_documents", self.documents),
            ("app.services.direct_upload.event_media", self.media),
            ("app.services.direct_upload.event_documents", self.documents),
            ("app.services.direct_upload.managed_event_media", FakeFiles()),
            ("app.services.direct_upload.managed_event_documents", FakeFiles()),
            ("app.routers.events.event_reports", MagicMock()),
            ("app.routers.events.notifications", MagicMock()),
            ("app.routers.events.users", NoUsers()),
            ("app.routers.events.get_current_user", lambda auth: USERS[auth]),
            ("app.routers.events.get_upload_limits", lambda: dict(LIMITS)),
            ("app.services.event_types.event_types", FakeEventTypes()),
        ):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        created = self.client.post(
            "/teacher/events", json={**EVENT_PAYLOAD, "save_as_draft": True}, headers=self.auth
        )
        self.assertEqual(created.status_code, 201, created.text)
        self.event_id = created.json()["event"]["id"]
        self.base = f"/teacher/events/{self.event_id}/uploads"

    def start(self, name, size, content_type, kind="media", category="notice", headers=None):
        return self.client.post(
            self.base,
            json={"kind": kind, "file_name": name, "content_type": content_type, "size": size, "category": category},
            headers=headers or self.auth,
        )

    def complete(self, session_id, headers=None):
        return self.client.post(f"{self.base}/{session_id}/complete", headers=headers or self.auth)

    def upload(self, name, data, content_type, kind="media", category="notice"):
        """start -> PUT every part -> complete."""
        started = self.start(name, len(data), content_type, kind, category=category)
        self.assertEqual(started.status_code, 200, started.text)
        send_parts(self.r2, started.json(), data)
        return self.complete(started.json()["session_id"])

    # ---- start ----------------------------------------------------------

    def test_without_r2_the_browser_is_told_to_post_the_file(self) -> None:
        with patch.object(settings, "r2_bucket_name", None):
            response = self.start("a.png", len(PNG), "image/png")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"success": True, "direct": False})
        self.assertEqual(self.sessions.docs, {})

    def test_the_kill_switch_falls_back_to_posting(self) -> None:
        with patch.object(settings, "r2_direct_upload_enabled", False):
            self.assertFalse(self.start("a.png", len(PNG), "image/png").json()["direct"])

    def test_a_small_file_is_one_part_with_an_exact_signed_length(self) -> None:
        body = self.start("a.png", len(PNG), "image/png").json()
        self.assertTrue(body["direct"])
        self.assertEqual(body["part_count"], 1)
        self.assertEqual([(p["part_number"], p["size"]) for p in body["parts"]], [(1, len(PNG))])
        self.assertEqual(self.r2.signed, [(1, len(PNG))])

        session = self.only_session()
        self.assertEqual(session["status"], "pending")
        self.assertTrue(session["object_key"].startswith(f"events/{self.event_id}/media/"))
        upload = self.r2.uploads[session["upload_id"]]
        # Type, disposition and metadata are fixed server side, not by the browser.
        self.assertEqual(upload["content_type"], "image/png")
        self.assertTrue(upload["disposition"].startswith("inline;"))
        self.assertEqual(upload["metadata"], {"event_id": self.event_id, "teacher_id": TEACHER["id"]})

    def test_a_large_file_is_split_into_equal_parts(self) -> None:
        body = self.start("talk.mp4", 40 * KB + 5, "video/mp4").json()
        self.assertEqual((body["part_size"], body["part_count"]), (8 * KB, 6))
        self.assertEqual([p["size"] for p in body["parts"]], [8 * KB] * 5 + [5])

    def test_start_applies_the_proxied_upload_checks(self) -> None:
        cases = [
            (("logo.svg", 100, "image/svg+xml"), 400),
            (("photo.png", 100, "image/jpeg"), 400),      # type disagrees with extension
            (("photo.png", 0, "image/png"), 400),         # empty
            (("photo.png", 21 * 1024 * 1024, "image/png"), 413),  # past the 20 MB photo cap
        ]
        for args, expected in cases:
            with self.subTest(args=args):
                self.assertEqual(self.start(*args).status_code, expected)
        self.assertEqual(self.r2.uploads, {})
        self.assertEqual(self.sessions.docs, {})

    def test_start_refuses_once_the_photo_count_cap_is_reached(self) -> None:
        for _ in range(LIMITS["max_photos_per_event"]):
            self.media.insert_one({"event_id": self.event_id, "media_type": "image", "file_size": 1})
        response = self.start("one-more.png", len(PNG), "image/png")
        self.assertEqual(response.status_code, 400)
        self.assertIn("at most 10 photos", response.json()["detail"])
        self.assertEqual(self.r2.uploads, {})

    def test_start_refuses_a_video_past_the_budget_with_the_prd_message(self) -> None:
        self.media.insert_one({
            "event_id": self.event_id, "media_type": "video", "file_size": 150 * 1024 * 1024,
        })
        response = self.start("talk.mp4", 60 * 1024 * 1024, "video/mp4")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["detail"],
            "You have exceeded the limit. Maximum allowed video size is 200 MB.",
        )

    def test_start_refuses_an_approved_event(self) -> None:
        self.events.docs[ObjectId(self.event_id)]["status"] = "approved"
        self.assertEqual(self.start("a.png", len(PNG), "image/png").status_code, 400)

    def test_another_teachers_event_is_forbidden(self) -> None:
        response = self.start("a.png", len(PNG), "image/png", headers={"Authorization": "Bearer other"})
        self.assertEqual(response.status_code, 403)

    # ---- complete -------------------------------------------------------

    def test_photo_round_trip_records_the_same_shape_as_a_posted_one(self) -> None:
        response = self.upload("My Photo.png", PNG, "image/png")
        self.assertEqual(response.status_code, 201, response.text)
        media = response.json()["media"]
        self.assertEqual(response.json()["message"], "Media uploaded successfully")
        self.assertEqual(media["storage"], "r2")
        self.assertEqual(media["media_type"], "image")
        self.assertEqual(media["content_type"], "image/png")
        self.assertEqual(media["file_size"], len(PNG))
        self.assertEqual(media["file_name"], "My_Photo.png")
        self.assertEqual(media["original_name"], "My Photo.png")
        self.assertTrue(media["media_url"].endswith("?signature=get"))  # signed GET

        (record,) = self.media.docs
        self.assertEqual(self.r2.objects[record["object_key"]]["data"], PNG)
        session = self.only_session()
        self.assertEqual(session["status"], "completed")
        self.assertEqual(session["record_id"], str(record["_id"]))
        self.assertIn("purge_at", session)

    def test_multipart_video_is_assembled_in_part_order(self) -> None:
        data = mp4(40 * KB + 5)
        started = self.start("talk.mp4", len(data), "video/mp4").json()
        # Parts may arrive in any order; the browser sends several at once.
        started["parts"].reverse()
        send_parts(self.r2, started, data)
        response = self.complete(started["session_id"])
        self.assertEqual(response.status_code, 201, response.text)
        (record,) = self.media.docs
        self.assertEqual(self.r2.objects[record["object_key"]]["data"], data)
        self.assertEqual(record["media_type"], "video")

    def test_document_keeps_its_name_and_accepts_a_generic_type(self) -> None:
        response = self.upload("Minutes (final).docx", DOCX, "", kind="documents")
        self.assertEqual(response.status_code, 201, response.text)
        document = response.json()["document"]
        self.assertEqual(response.json()["message"], "Document uploaded successfully")
        self.assertEqual(document["file_name"], "Minutes (final).docx")
        self.assertEqual(
            document["file_type"],
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        self.assertEqual(document.get("category"), "notice")
        self.assertIn("/documents/", self.only_session()["object_key"])

    def test_document_saves_category_notice_and_report(self) -> None:
        # 1. Direct upload with category="report"
        started = self.start("Report.docx", len(DOCX), "", kind="documents", category="report").json()
        send_parts(self.r2, started, DOCX)
        resp = self.complete(started["session_id"])
        self.assertEqual(resp.status_code, 201, resp.text)
        doc = resp.json()["document"]
        self.assertEqual(doc["category"], "report")

        # 2. Proxied upload with category="report"
        with patch.object(settings, "r2_bucket_name", None):
            proxied = self.client.post(
                f"/teacher/events/{self.event_id}/documents",
                files={"file": ("Event_Report.docx", DOCX, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
                data={"category": "report"},
                headers=self.auth,
            )
            self.assertEqual(proxied.status_code, 201, proxied.text)
            self.assertEqual(proxied.json()["document"]["category"], "report")

    def test_missing_parts_leave_the_upload_retryable(self) -> None:
        data = mp4(40 * KB)
        started = self.start("talk.mp4", len(data), "video/mp4").json()
        send_parts(self.r2, started, data, skip={3})

        early = self.complete(started["session_id"])
        self.assertEqual(early.status_code, 409)
        self.assertIn("1 of 5 parts", early.json()["detail"])
        self.assertEqual(self.only_session()["status"], "pending")

        send_parts(self.r2, {**started, "parts": [started["parts"][2]]}, data)
        self.assertEqual(self.complete(started["session_id"]).status_code, 201)

    def test_contents_that_do_not_match_the_type_are_refused_and_freed(self) -> None:
        fake_png = b"<html>" + b"\x00" * 64
        response = self.upload("photo.png", fake_png, "image/png")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "The file's contents do not match its type")
        self.assertEqual(self.media.docs, [])
        self.assertEqual(self.r2.objects, {})
        self.assertEqual(self.only_session()["status"], "failed")

    def test_a_part_of_the_wrong_size_is_refused_and_aborted(self) -> None:
        started = self.start("a.png", len(PNG), "image/png").json()
        self.r2.put(started["parts"][0]["url"], PNG + b"extra")
        response = self.complete(started["session_id"])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.r2.aborted, [self.only_session()["upload_id"]])
        self.assertEqual(self.media.docs, [])

    def test_completing_twice_records_once(self) -> None:
        started = self.start("a.png", len(PNG), "image/png").json()
        send_parts(self.r2, started, PNG)
        self.assertEqual(self.complete(started["session_id"]).status_code, 201)
        again = self.complete(started["session_id"])
        self.assertEqual(again.status_code, 409)
        self.assertEqual(len(self.media.docs), 1)

    def test_storage_errors_leave_the_upload_retryable(self) -> None:
        started = self.start("a.png", len(PNG), "image/png").json()
        send_parts(self.r2, started, PNG)
        failing = ClientError({"Error": {"Code": "InternalError"}}, "HeadObject")
        with patch.object(r2_service, "head_object", side_effect=failing):
            self.assertEqual(self.complete(started["session_id"]).status_code, 502)
        session = self.only_session()
        self.assertEqual(session["status"], "pending")
        self.assertTrue(session["assembled"])
        # The retry goes straight to verification: the parts are already one object.
        self.assertEqual(self.complete(started["session_id"]).status_code, 201)

    def test_racing_uploads_past_the_cap_lose_in_insertion_order(self) -> None:
        for _ in range(LIMITS["max_photos_per_event"] - 1):
            self.media.insert_one({"event_id": self.event_id, "media_type": "image", "file_size": 1})
        # Both pass the up-front check: nine photos, one slot left.
        first = self.start("a.png", len(PNG), "image/png").json()
        second = self.start("b.png", len(PNG), "image/png").json()
        send_parts(self.r2, first, PNG)
        send_parts(self.r2, second, PNG)

        self.assertEqual(self.complete(first["session_id"]).status_code, 201)
        lost = self.complete(second["session_id"])
        self.assertEqual(lost.status_code, 400)
        self.assertIn("at most 10 photos", lost.json()["detail"])
        self.assertEqual(len(self.media.docs), 10)
        # The loser's object is gone, the winner's kept.
        self.assertEqual(len(self.r2.objects), 1)
        statuses = sorted(s["status"] for s in self.sessions.docs.values())
        self.assertEqual(statuses, ["completed", "failed"])

    def test_event_approved_mid_upload_frees_the_bytes(self) -> None:
        started = self.start("a.png", len(PNG), "image/png").json()
        send_parts(self.r2, started, PNG)
        self.events.docs[ObjectId(self.event_id)]["status"] = "approved"
        self.assertEqual(self.complete(started["session_id"]).status_code, 400)
        self.assertEqual(self.r2.aborted, [self.only_session()["upload_id"]])
        self.assertEqual(self.only_session()["status"], "failed")
        self.assertEqual(self.media.docs, [])

    def test_another_teacher_cannot_complete_the_session(self) -> None:
        started = self.start("a.png", len(PNG), "image/png").json()
        send_parts(self.r2, started, PNG)
        response = self.complete(started["session_id"], headers={"Authorization": "Bearer other"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.only_session()["status"], "pending")

    def test_an_expired_session_is_refused_and_freed(self) -> None:
        started = self.start("a.png", len(PNG), "image/png").json()
        send_parts(self.r2, started, PNG)
        self.sessions.docs[ObjectId(started["session_id"])]["expires_at"] = utc_now() - timedelta(seconds=1)
        self.assertEqual(self.complete(started["session_id"]).status_code, 410)
        self.assertEqual(self.only_session()["status"], "aborted")
        self.assertEqual(self.r2.uploads, {})

    def test_malformed_ids_are_not_found(self) -> None:
        self.assertEqual(self.complete("not-an-id").status_code, 404)

    # ---- sign and abort -------------------------------------------------

    def test_sign_reissues_urls_for_the_requested_parts(self) -> None:
        started = self.start("talk.mp4", 40 * KB, "video/mp4").json()
        response = self.client.post(
            f"{self.base}/{started['session_id']}/sign", json={"part_numbers": [2, 5]}, headers=self.auth
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([p["part_number"] for p in response.json()["parts"]], [2, 5])

        bad = self.client.post(
            f"{self.base}/{started['session_id']}/sign", json={"part_numbers": [6]}, headers=self.auth
        )
        self.assertEqual(bad.status_code, 400)

    def test_abort_frees_the_parts_and_ends_the_session(self) -> None:
        started = self.start("talk.mp4", 40 * KB, "video/mp4").json()
        response = self.client.delete(f"{self.base}/{started['session_id']}", headers=self.auth)
        self.assertEqual(response.json(), {"success": True, "aborted": True})
        self.assertEqual(self.r2.uploads, {})
        self.assertEqual(self.only_session()["status"], "aborted")

        # A finished session can be neither re-signed nor completed.
        sign = self.client.post(f"{self.base}/{started['session_id']}/sign", headers=self.auth)
        self.assertEqual(sign.status_code, 410)
        self.assertEqual(self.complete(started["session_id"]).status_code, 410)
        again = self.client.delete(f"{self.base}/{started['session_id']}", headers=self.auth)
        self.assertEqual(again.json()["aborted"], False)

    def test_abort_works_after_the_event_is_deleted(self) -> None:
        started = self.start("a.png", len(PNG), "image/png").json()
        del self.events.docs[ObjectId(self.event_id)]
        response = self.client.delete(f"{self.base}/{started['session_id']}", headers=self.auth)
        self.assertTrue(response.json()["aborted"])

    def test_only_the_owner_can_abort(self) -> None:
        started = self.start("a.png", len(PNG), "image/png").json()
        response = self.client.delete(
            f"{self.base}/{started['session_id']}", headers={"Authorization": "Bearer other"}
        )
        self.assertFalse(response.json()["aborted"])
        self.assertEqual(self.only_session()["status"], "pending")

    # ---- sweep ----------------------------------------------------------

    def test_sweep_aborts_only_expired_unfinished_sessions(self) -> None:
        stale = self.start("stale.png", len(PNG), "image/png").json()
        fresh = self.start("fresh.png", len(PNG), "image/png").json()
        self.sessions.docs[ObjectId(stale["session_id"])]["expires_at"] = utc_now() - timedelta(minutes=1)

        self.assertEqual(direct_upload.sweep_expired_sessions(), 1)
        self.assertEqual(self.sessions.docs[ObjectId(stale["session_id"])]["status"], "aborted")
        self.assertEqual(self.sessions.docs[ObjectId(fresh["session_id"])]["status"], "pending")
        self.assertEqual(len(self.r2.aborted), 1)

    def test_sweep_never_deletes_a_file_that_was_recorded(self) -> None:
        # A /complete that died after inserting the record, before finishing.
        started = self.start("a.png", len(PNG), "image/png").json()
        send_parts(self.r2, started, PNG)
        session = direct_upload.claim_session(
            started["session_id"], scope="teacher", owner_id=TEACHER["id"], event_id=self.event_id
        )
        direct_upload.finalize_object(session, per_file_bytes=None, what="Photos")
        self.media.insert_one(direct_upload.new_record(session)[0])
        self.sessions.docs[session["_id"]]["expires_at"] = utc_now() - timedelta(minutes=1)

        self.assertEqual(direct_upload.sweep_expired_sessions(), 0)
        self.assertEqual(self.sessions.docs[session["_id"]]["status"], "completed")
        self.assertIn(session["object_key"], self.r2.objects)

    def test_sweep_deletes_an_assembled_but_unrecorded_object(self) -> None:
        started = self.start("a.png", len(PNG), "image/png").json()
        send_parts(self.r2, started, PNG)
        session = direct_upload.claim_session(
            started["session_id"], scope="teacher", owner_id=TEACHER["id"], event_id=self.event_id
        )
        direct_upload.finalize_object(session, per_file_bytes=None, what="Photos")
        self.sessions.docs[session["_id"]]["expires_at"] = utc_now() - timedelta(minutes=1)

        self.assertEqual(direct_upload.sweep_expired_sessions(), 1)
        self.assertEqual(self.r2.objects, {})

    def test_claiming_extends_the_deadline_past_the_sweep(self) -> None:
        started = self.start("a.png", len(PNG), "image/png").json()
        self.sessions.docs[ObjectId(started["session_id"])]["expires_at"] = utc_now() + timedelta(seconds=5)
        session = direct_upload.claim_session(
            started["session_id"], scope="teacher", owner_id=TEACHER["id"], event_id=self.event_id
        )
        self.assertGreater(session["expires_at"], utc_now() + timedelta(minutes=10))


# ---------------------------------------------------------------- event manager

class EventManagerDirectUploadTests(R2Fixture, EventManagerTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.install_r2()
        for target, value in (
            ("app.services.direct_upload.managed_event_media", self.media),
            ("app.services.direct_upload.managed_event_documents", self.documents),
            ("app.services.direct_upload.event_media", FakeFiles()),
            ("app.services.direct_upload.event_documents", FakeFiles()),
            # The teacher routes, for the scope test below.
            ("app.routers.events.get_current_user", lambda auth: {"Bearer teacher": {"id": "t1", "role": "teacher"}}[auth]),
        ):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.event = self.draft()
        self.base = f"/event-manager/events/{self.event['id']}/uploads"

    def start(self, name, data, content_type, kind="media", category="notice", token="mgr"):
        return self.call(
            "POST", self.base, token,
            json={"kind": kind, "file_name": name, "content_type": content_type, "size": len(data), "category": category},
        )

    def test_round_trip_records_in_the_managed_collections(self) -> None:
        started = self.start("stage photo.png", PNG, "image/png").json()
        send_parts(self.r2, started, PNG)
        response = self.call("POST", f"{self.base}/{started['session_id']}/complete")
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["media"]["file_name"], "stage_photo.png")
        self.assertEqual(len(self.media.docs), 1)

        # And the recorded file satisfies the save rule like a posted one, preserving category.
        document = self.start("agenda.docx", DOCX, "", kind="documents", category="report").json()
        send_parts(self.r2, document, DOCX)
        comp = self.call("POST", f"{self.base}/{document['session_id']}/complete")
        self.assertEqual(comp.status_code, 201)
        self.assertEqual(comp.json()["document"]["category"], "report")
        saved = self.save(self.event["id"])
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["event"]["status"], "recorded")

    def test_another_manager_cannot_use_the_session(self) -> None:
        started = self.start("a.png", PNG, "image/png").json()
        send_parts(self.r2, started, PNG)
        response = self.call("POST", f"{self.base}/{started['session_id']}/complete", token="mgr2")
        self.assertEqual(response.status_code, 404)

    def test_a_teacher_route_cannot_complete_a_managed_session(self) -> None:
        started = self.start("a.png", PNG, "image/png").json()
        send_parts(self.r2, started, PNG)
        response = self.client.post(
            f"/teacher/events/{self.event['id']}/uploads/{started['session_id']}/complete",
            headers={"Authorization": "Bearer teacher"},
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.media.docs, {})


if __name__ == "__main__":
    unittest.main()
