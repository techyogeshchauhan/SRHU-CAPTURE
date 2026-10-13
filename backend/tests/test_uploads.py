"""Upload validation and bookkeeping (B-2, B-14, B-29), against in-memory
collections: no database, GridFS or R2 is touched."""

from __future__ import annotations

import copy
import io
import os
import unittest
from unittest.mock import MagicMock, patch

from bson import ObjectId

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.services.storage_service import (  # noqa: E402
    content_disposition,
    read_upload,
    serving_policy,
)
from tests.test_event_history import EVENT_PAYLOAD, FakeEvents, NoUsers  # noqa: E402


# The event-types service binds its collection at import time, so a test that
# creates an event would otherwise reach for a real MongoDB.
_event_types_patcher = None


def setUpModule() -> None:
    global _event_types_patcher
    from unittest.mock import patch as _patch

    from tests.fake_event_types import FakeEventTypes

    _event_types_patcher = _patch(
        "app.services.event_types.event_types", FakeEventTypes()
    )
    _event_types_patcher.start()


def tearDownModule() -> None:
    if _event_types_patcher is not None:
        _event_types_patcher.stop()




TEACHER = {"id": str(ObjectId()), "name": "Meera", "email": "m@srhu.edu.in", "role": "teacher"}

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
PDF = b"%PDF-1.7\n" + b"\x00" * 64
DOCX = b"PK\x03\x04" + b"\x00" * 64
DOC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64   # OLE: Word 97-2003
RTF = b"{\\rtf1\\ansi Agenda \\par}"
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'


class FakeCursor(list):
    def sort(self, key, direction=1):
        return FakeCursor(sorted(self, key=lambda d: d.get(key), reverse=direction == -1))


class FakeFiles:
    """event_media / event_documents."""

    def __init__(self) -> None:
        self.docs: list[dict] = []
        self.fail_insert = False

    def _matches(self, doc, query):
        for key, wanted in query.items():
            if key == "$or":
                if not any(self._matches(doc, clause) for clause in wanted):
                    return False
            elif doc.get(key) != wanted:
                return False
        return True

    def count_documents(self, query):
        return sum(1 for d in self.docs if self._matches(d, query))

    def find_one(self, query, *_args, **_kwargs):
        return next(
            (copy.deepcopy(d) for d in self.docs if self._matches(d, query)), None
        )

    def insert_one(self, document):
        if self.fail_insert:
            raise RuntimeError("database down")
        document.setdefault("_id", ObjectId())
        self.docs.append(copy.deepcopy(document))
        return MagicMock(inserted_id=document["_id"])

    def find(self, query, *_args, **_kwargs):
        return FakeCursor(copy.deepcopy(d) for d in self.docs if self._matches(d, query))

    def delete_one(self, query):
        before = len(self.docs)
        self.docs = [d for d in self.docs if not self._matches(d, query)]
        return MagicMock(deleted_count=before - len(self.docs))

    def find_one_and_delete(self, query):
        for d in self.docs:
            if self._matches(d, query):
                self.docs.remove(d)
                return d
        return None


class UploadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.events = FakeEvents()
        self.media = FakeFiles()
        self.documents = FakeFiles()
        self.deleted: list[dict] = []
        self.saved: list[dict] = []

        def fake_save(data, *, file_name, content_type, kind, event_id, teacher_id):
            # save_upload now takes a rewound stream so large uploads are never
            # held in memory; bytes are still accepted for other callers.
            payload = data if isinstance(data, bytes) else data.read()
            file_id = str(ObjectId())
            self.saved.append({
                "content_type": content_type,
                "file_name": file_name,
                "size": len(payload),
            })
            return {"storage": "gridfs", "object_key": None, "file_id": file_id, "url": f"/files/{file_id}"}

        self.patches = [
            patch("app.routers.events.events", self.events),
            patch("app.routers.events.event_media", self.media),
            patch("app.routers.events.event_documents", self.documents),
            patch("app.routers.events.event_reports", MagicMock()),
            patch("app.routers.events.notifications", MagicMock()),
            patch("app.routers.events.users", NoUsers()),
            patch("app.routers.events.get_current_user", lambda _auth: TEACHER),
            patch("app.routers.events.save_upload", side_effect=fake_save),
            patch("app.routers.events.delete_stored", side_effect=self.deleted.append),
        ]
        for item in self.patches:
            item.start()
        self.addCleanup(lambda: [p.stop() for p in reversed(self.patches)])

        created = self.client.post(
            "/teacher/events", json={**EVENT_PAYLOAD, "save_as_draft": True}, headers=self.auth
        )
        self.assertEqual(created.status_code, 201, created.text)
        self.event_id = created.json()["event"]["id"]

    auth = {"Authorization": "Bearer teacher"}

    def upload(self, name, data, content_type, kind="media"):
        return self.client.post(
            f"/teacher/events/{self.event_id}/{kind}",
            files={"file": (name, io.BytesIO(data), content_type)},
            headers=self.auth,
        )

    # ---- B-2: type whitelist ------------------------------------------

    def test_svg_upload_is_rejected(self) -> None:
        response = self.upload("logo.svg", SVG, "image/svg+xml")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.saved, [])

    def test_svg_disguised_as_png_is_rejected(self) -> None:
        response = self.upload("logo.png", SVG, "image/png")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.saved, [])

    def test_extension_and_type_must_agree(self) -> None:
        self.assertEqual(self.upload("photo.png", PNG, "video/mp4").status_code, 400)
        self.assertEqual(self.upload("page.pdf", PDF, "text/html", kind="documents").status_code, 400)
        self.assertEqual(self.upload("page.html", PDF, "application/pdf", kind="documents").status_code, 400)

    def test_valid_photo_is_stored_with_the_canonical_type(self) -> None:
        response = self.upload("photo.JPG", JPEG, "image/jpeg")
        self.assertEqual(response.status_code, 201, response.text)
        media = response.json()["media"]
        self.assertEqual(media["media_type"], "image")
        self.assertEqual(media["content_type"], "image/jpeg")
        self.assertRegex(media["media_url"], r"/files/[0-9a-f]{24}\?exp=\d+&sig=[0-9a-f]{64}$")

    def test_document_with_generic_declared_type_is_accepted(self) -> None:
        response = self.upload("report.docx", DOCX, "application/octet-stream", kind="documents")
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(
            self.saved[-1]["content_type"],
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )

    def test_pdf_must_look_like_a_pdf(self) -> None:
        response = self.upload("fake.pdf", b"<html><script>x</script></html>", "application/pdf", kind="documents")
        self.assertEqual(response.status_code, 400)

    # ---- B-14: per-event caps ------------------------------------------

    def test_photo_count_cap(self) -> None:
        # PRD 7: ten photos per event.
        for index in range(settings.max_photos_per_event):
            self.assertEqual(
                self.upload(f"p{index}.png", PNG, "image/png").status_code, 201
            )

        extra = self.upload("one-too-many.png", PNG, "image/png")

        self.assertEqual(extra.status_code, 400)
        self.assertIn(f"{settings.max_photos_per_event} photos", extra.json()["detail"])

    def test_oversize_photo_is_rejected(self) -> None:
        # PRD 7: 20 MB per photo.
        big = PNG + b"\x00" * settings.max_photo_size_bytes

        response = self.upload("huge.png", big, "image/png")

        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.saved, [])

    def test_videos_have_no_count_cap(self) -> None:
        # PRD 11 caps videos by combined size, not by number of files.
        for index in range(6):
            self.assertEqual(
                self.upload(f"v{index}.mp4", MP4, "video/mp4").status_code, 201
            )

    def test_video_total_size_cap(self) -> None:
        # Fill the budget with a stubbed size, then prove the next one is
        # refused with the exact wording PRD 11 specifies.
        self.media.docs.append({
            "_id": ObjectId(),
            "event_id": self.event_id,
            "media_type": "video",
            "file_size": settings.max_video_total_bytes,
        })

        response = self.upload("last.mp4", MP4, "video/mp4")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["detail"],
            "You have exceeded the limit. Maximum allowed video size is 200 MB.",
        )

    def test_photos_and_videos_have_separate_budgets(self) -> None:
        # A full video budget must not block a photo.
        self.media.docs.append({
            "_id": ObjectId(),
            "event_id": self.event_id,
            "media_type": "video",
            "file_size": settings.max_video_total_bytes,
        })

        self.assertEqual(self.upload("p.png", PNG, "image/png").status_code, 201)

    def test_document_total_size_cap(self) -> None:
        # PRD 9: no per-file cap, one combined 15 MB budget.
        self.documents.docs.append({
            "_id": ObjectId(),
            "event_id": self.event_id,
            "file_size": settings.max_documents_total_bytes,
        })

        response = self.upload("report.pdf", PDF, "application/pdf", kind="documents")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["detail"],
            "You have exceeded the limit. Maximum allowed document size is 15 MB.",
        )

    def test_heic_is_no_longer_accepted(self) -> None:
        # PRD 7 narrows photos to JPG/PNG/WEBP/GIF.
        heic = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 64

        response = self.upload("photo.heic", heic, "image/heic")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.saved, [])

    def test_already_stored_heic_is_still_servable(self) -> None:
        # Narrowing the accept list must not turn existing photos into
        # downloads, so the legacy types stay in the servable set.
        from app.services.storage_service import serving_policy

        servable, disposition = serving_policy("image/heic")

        self.assertTrue(servable)
        self.assertEqual(disposition, "inline")

    def test_uploads_record_the_original_name(self) -> None:
        # PRD 10 compares on this, so it must survive sanitising.
        self.assertEqual(self.upload("My Poster .png", PNG, "image/png").status_code, 201)

        record = self.media.docs[-1]
        self.assertEqual(record["original_name"], "My Poster .png")
        self.assertEqual(record["name_key"], "my poster .png")

    # ---- mandatory evidence: a submitted event keeps a photo and a document --

    def submit(self):
        return self.client.patch(
            f"/teacher/events/{self.event_id}",
            json={**EVENT_PAYLOAD, "save_as_draft": False},
            headers=self.auth,
        )

    def remove(self, kind, record_id):
        return self.client.delete(
            f"/teacher/events/{self.event_id}/{kind}/{record_id}", headers=self.auth
        )

    def test_submit_needs_a_photo_and_a_document(self) -> None:
        response = self.submit()
        self.assertEqual(response.status_code, 400)
        self.assertIn("photo", response.json()["detail"])

        self.upload("poster.png", PNG, "image/png")
        response = self.submit()
        self.assertEqual(response.status_code, 400)
        self.assertIn("document", response.json()["detail"])

        self.upload("agenda.pdf", PDF, "application/pdf", kind="documents")
        response = self.submit()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["event"]["status"], "pending")

    def test_a_video_does_not_count_as_the_photo(self) -> None:
        self.upload("clip.mp4", MP4, "video/mp4")
        self.upload("agenda.pdf", PDF, "application/pdf", kind="documents")
        response = self.submit()
        self.assertEqual(response.status_code, 400)
        self.assertIn("photo", response.json()["detail"])

    def test_pending_event_keeps_its_last_photo_and_document(self) -> None:
        photo = self.upload("poster.png", PNG, "image/png").json()["media"]["id"]
        doc = self.upload("agenda.pdf", PDF, "application/pdf", kind="documents").json()["document"]["id"]
        self.assertEqual(self.submit().status_code, 200)

        for kind, record_id, label, collection in (
            ("media", photo, "photo", self.media),
            ("documents", doc, "document", self.documents),
        ):
            with self.subTest(label=label):
                response = self.remove(kind, record_id)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn(f"at least one {label}", response.json()["detail"])
                # Put back, and its bytes left alone.
                self.assertEqual(collection.count_documents({"event_id": self.event_id}), 1)
        self.assertEqual(self.deleted, [])

    def test_pending_event_can_swap_a_photo(self) -> None:
        first = self.upload("poster.png", PNG, "image/png").json()["media"]["id"]
        self.upload("agenda.pdf", PDF, "application/pdf", kind="documents")
        self.assertEqual(self.submit().status_code, 200)
        self.upload("banner.jpg", JPEG, "image/jpeg")

        self.assertEqual(self.remove("media", first).status_code, 200)
        self.assertEqual(len(self.deleted), 1)

    def test_pending_event_can_drop_its_only_video(self) -> None:
        self.upload("poster.png", PNG, "image/png")
        self.upload("agenda.pdf", PDF, "application/pdf", kind="documents")
        clip = self.upload("clip.mp4", MP4, "video/mp4").json()["media"]["id"]
        self.assertEqual(self.submit().status_code, 200)

        self.assertEqual(self.remove("media", clip).status_code, 200)

    def test_a_draft_may_be_emptied(self) -> None:
        # Not in front of the Dean yet; submitting re-checks.
        photo = self.upload("poster.png", PNG, "image/png").json()["media"]["id"]
        self.assertEqual(self.remove("media", photo).status_code, 200)

    # ---- B-29: no orphans -----------------------------------------------

    def test_failed_insert_deletes_the_stored_file(self) -> None:
        self.media.fail_insert = True
        with self.assertRaises(RuntimeError):
            self.upload("photo.png", PNG, "image/png")
        self.assertEqual(len(self.deleted), 1)

    def test_event_deleted_during_upload_rolls_back(self) -> None:
        original = self.events.find_one

        def vanished(query, *args, **kwargs):
            # The post-insert re-check sees the event gone.
            if isinstance(query.get("status"), dict):
                return None
            return original(query, *args, **kwargs)

        with patch.object(self.events, "find_one", side_effect=vanished):
            response = self.upload("photo.png", PNG, "image/png")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.media.docs, [])
        self.assertEqual(len(self.deleted), 1)


class ReadUploadTests(unittest.TestCase):
    def test_stops_reading_past_the_cap(self) -> None:
        upload = MagicMock()
        upload.size = None
        upload.file = io.BytesIO(b"x" * (3 * 1024 * 1024))
        with self.assertRaises(HTTPException) as caught:
            read_upload(upload, max_bytes=1024 * 1024)
        self.assertEqual(caught.exception.status_code, 413)
        # Aborted after at most two 1 MB chunks, not the whole body.
        self.assertLessEqual(upload.file.tell(), 2 * 1024 * 1024)

    def test_declared_size_is_checked_first(self) -> None:
        upload = MagicMock()
        upload.size = 10 ** 10
        with self.assertRaises(HTTPException) as caught:
            read_upload(upload, max_bytes=1024)
        self.assertEqual(caught.exception.status_code, 413)
        upload.file.read.assert_not_called()


class ServingPolicyTests(unittest.TestCase):
    def test_policy(self) -> None:
        self.assertEqual(serving_policy("image/png"), ("image/png", "inline"))
        self.assertEqual(serving_policy("image/png", download=True), ("image/png", "attachment"))
        self.assertEqual(serving_policy("application/pdf"), ("application/pdf", "inline"))
        self.assertEqual(serving_policy("text/csv"), ("text/csv", "attachment"))
        self.assertEqual(serving_policy("image/svg+xml"), ("application/octet-stream", "attachment"))
        self.assertEqual(serving_policy("text/html"), ("application/octet-stream", "attachment"))
        self.assertEqual(serving_policy(None), ("application/octet-stream", "attachment"))

    def test_content_disposition_is_latin1_safe(self) -> None:
        value = content_disposition("attachment", "रिपोर्ट.pdf")
        value.encode("latin-1")
        self.assertIn('filename="download.pdf"', value)
        self.assertIn("filename*=UTF-8''", value)


if __name__ == "__main__":
    unittest.main()


class DuplicateNameTests(UploadTests):
    """PRD 10: warn before uploading a name the event already has."""

    def check(self, *names, kind="media"):
        query = "&".join(f"file_name={name}" for name in names)
        return self.client.get(
            f"/teacher/events/{self.event_id}/uploads/check-name?{query}&kind={kind}",
            headers=self.auth,
        )

    def test_unknown_name_is_not_a_duplicate(self) -> None:
        body = self.check("poster.png").json()

        self.assertEqual(body["duplicates"], {"poster.png": False})
        self.assertFalse(body["any"])

    def test_uploaded_name_is_reported_as_duplicate(self) -> None:
        self.upload("poster.png", PNG, "image/png")

        body = self.check("poster.png").json()

        self.assertTrue(body["duplicates"]["poster.png"])
        self.assertTrue(body["any"])

    def test_match_ignores_case(self) -> None:
        self.upload("Poster.PNG", PNG, "image/png")

        self.assertTrue(self.check("poster.png").json()["duplicates"]["poster.png"])

    def test_several_names_in_one_request(self) -> None:
        self.upload("a.png", PNG, "image/png")

        body = self.check("a.png", "b.png", "c.png").json()

        self.assertEqual(
            body["duplicates"], {"a.png": True, "b.png": False, "c.png": False}
        )
        self.assertTrue(body["any"])

    def test_media_and_documents_are_checked_separately(self) -> None:
        self.upload("brief.pdf", PDF, "application/pdf", kind="documents")

        self.assertTrue(
            self.check("brief.pdf", kind="documents").json()["duplicates"]["brief.pdf"]
        )
        # The same name on the media side is not a clash.
        self.assertFalse(self.check("brief.pdf", kind="media").json()["duplicates"]["brief.pdf"])

    def test_duplicates_are_still_allowed_to_upload(self) -> None:
        # The check only warns; storage keys every object with a uuid prefix,
        # so two files may legitimately share a name.
        self.upload("poster.png", PNG, "image/png")

        self.assertEqual(self.upload("poster.png", PNG, "image/png").status_code, 201)

    def test_legacy_record_without_a_name_key_still_matches(self) -> None:
        # Records stored before name_key existed fall back to file_name, so no
        # backfill is needed.
        self.media.docs.append({
            "_id": ObjectId(),
            "event_id": self.event_id,
            "media_type": "image",
            "file_name": "old-poster.png",
            "file_size": 10,
        })

        self.assertTrue(self.check("old-poster.png").json()["duplicates"]["old-poster.png"])


class StreamingTests(UploadTests):
    """The upload path must not hold a whole file in memory (see PRD 11).

    A 200 MB video read into a bytes object is roughly 200 MB of RSS per
    concurrent upload, which OOM-kills a small container. stream_upload spools
    past a threshold instead.
    """

    def test_large_uploads_spool_to_disk(self) -> None:
        import io as _io
        from unittest.mock import MagicMock

        from app.services.storage_service import _SPOOL_THRESHOLD, stream_upload

        upload = MagicMock()
        upload.size = None
        upload.file = _io.BytesIO(b"\x00" * (_SPOOL_THRESHOLD * 2))

        buffer, size = stream_upload(upload, _SPOOL_THRESHOLD * 4)
        try:
            self.assertEqual(size, _SPOOL_THRESHOLD * 2)
            self.assertNotIsInstance(
                buffer._file, _io.BytesIO, "large upload stayed in memory"
            )
        finally:
            buffer.close()

    def test_small_uploads_stay_in_memory(self) -> None:
        import io as _io
        from unittest.mock import MagicMock

        from app.services.storage_service import stream_upload

        upload = MagicMock()
        upload.size = None
        upload.file = _io.BytesIO(b"\x00" * 1024)

        buffer, size = stream_upload(upload, 1024 * 1024)
        try:
            self.assertEqual(size, 1024)
            self.assertIsInstance(buffer._file, _io.BytesIO)
        finally:
            buffer.close()

    def test_the_buffer_is_rewound_for_the_caller(self) -> None:
        import io as _io
        from unittest.mock import MagicMock

        from app.services.storage_service import stream_upload

        upload = MagicMock()
        upload.size = None
        upload.file = _io.BytesIO(b"abcdef")

        buffer, _size = stream_upload(upload, 1024)
        try:
            self.assertEqual(buffer.read(), b"abcdef")
        finally:
            buffer.close()

    def test_oversize_aborts_before_reading_everything(self) -> None:
        import io as _io
        from unittest.mock import MagicMock

        from app.services.storage_service import stream_upload

        upload = MagicMock()
        upload.size = None
        upload.file = _io.BytesIO(b"\x00" * (4 * 1024 * 1024))

        with self.assertRaises(Exception) as caught:
            stream_upload(upload, 1024)
        self.assertEqual(getattr(caught.exception, "status_code", None), 413)

    # ---- Super Admin dynamic upload limits ----

    def test_dynamic_photo_count_limit(self) -> None:
        custom_limits = {
            "max_photos_per_event": 2,
            "max_photo_size_mb": 20,
            "max_photo_total_mb": None,
            "max_videos_per_event": None,
            "max_video_size_mb": 200,
            "max_video_total_mb": 200,
            "max_photo_size_bytes": 20 * 1024 * 1024,
            "max_photo_total_bytes": None,
            "max_video_size_bytes": 200 * 1024 * 1024,
            "max_video_total_bytes": 200 * 1024 * 1024,
        }
        with patch("app.routers.events.get_upload_limits", return_value=custom_limits):
            self.assertEqual(self.upload("p1.png", PNG, "image/png").status_code, 201)
            self.assertEqual(self.upload("p2.png", PNG, "image/png").status_code, 201)
            extra = self.upload("p3.png", PNG, "image/png")
            self.assertEqual(extra.status_code, 400)
            self.assertIn("at most 2 photos", extra.json()["detail"])

    def test_dynamic_photo_size_limit(self) -> None:
        custom_limits = {
            "max_photos_per_event": 10,
            "max_photo_size_mb": 1,
            "max_photo_total_mb": None,
            "max_videos_per_event": None,
            "max_video_size_mb": 200,
            "max_video_total_mb": 200,
            "max_photo_size_bytes": 1 * 1024 * 1024,
            "max_photo_total_bytes": None,
            "max_video_size_bytes": 200 * 1024 * 1024,
            "max_video_total_bytes": 200 * 1024 * 1024,
        }
        big_photo = PNG + b"\x00" * (1 * 1024 * 1024)
        with patch("app.routers.events.get_upload_limits", return_value=custom_limits):
            response = self.upload("big.png", big_photo, "image/png")
            self.assertEqual(response.status_code, 413)
            self.assertIn("Photos must be smaller than 1 MB", response.json()["detail"])

    def test_dynamic_video_count_limit(self) -> None:
        custom_limits = {
            "max_photos_per_event": 10,
            "max_photo_size_mb": 20,
            "max_photo_total_mb": None,
            "max_videos_per_event": 1,
            "max_video_size_mb": 200,
            "max_video_total_mb": 200,
            "max_photo_size_bytes": 20 * 1024 * 1024,
            "max_photo_total_bytes": None,
            "max_video_size_bytes": 200 * 1024 * 1024,
            "max_video_total_bytes": 200 * 1024 * 1024,
        }
        with patch("app.routers.events.get_upload_limits", return_value=custom_limits):
            self.assertEqual(self.upload("v1.mp4", MP4, "video/mp4").status_code, 201)
            extra = self.upload("v2.mp4", MP4, "video/mp4")
            self.assertEqual(extra.status_code, 400)
            self.assertIn("at most 1 videos", extra.json()["detail"])

    def test_dynamic_video_total_size_limit(self) -> None:
        custom_limits = {
            "max_photos_per_event": 10,
            "max_photo_size_mb": 20,
            "max_photo_total_mb": None,
            "max_videos_per_event": None,
            "max_video_size_mb": 50,
            "max_video_total_mb": 50,
            "max_photo_size_bytes": 20 * 1024 * 1024,
            "max_photo_total_bytes": None,
            "max_video_size_bytes": 50 * 1024 * 1024,
            "max_video_total_bytes": 50 * 1024 * 1024,
        }
        self.media.docs.append({
            "_id": ObjectId(),
            "event_id": self.event_id,
            "media_type": "video",
            "file_size": 50 * 1024 * 1024,
        })
        with patch("app.routers.events.get_upload_limits", return_value=custom_limits):
            response = self.upload("extra.mp4", MP4, "video/mp4")
            self.assertEqual(response.status_code, 400)
            self.assertEqual(
                response.json()["detail"],
                "You have exceeded the limit. Maximum allowed video size is 50 MB.",
            )


class ReportPhotoChoiceTests(UploadTests):
    """The teacher picks the Dean report's photos while uploading, exactly as
    the Event Manager does (PUT .../report-photos, at most four)."""

    def photos(self, count: int) -> list[str]:
        ids = []
        for n in range(count):
            response = self.upload(f"p{n}.png", PNG, "image/png")
            self.assertEqual(response.status_code, 201, response.text)
            ids.append(response.json()["media"]["id"])
        return ids

    def detail(self) -> dict:
        return self.client.get(f"/teacher/events/{self.event_id}", headers=self.auth).json()["event"]

    def choose(self, ids):
        return self.client.put(
            f"/teacher/events/{self.event_id}/report-photos", json={"photo_ids": ids}, headers=self.auth
        )

    def test_default_is_the_first_four(self) -> None:
        ids = self.photos(5)
        event = self.detail()
        self.assertEqual(event["report_photo_ids"], ids[:4])
        self.assertFalse(event["report_photos_chosen"])

    def test_choosing_saves_the_order(self) -> None:
        ids = self.photos(5)
        response = self.choose([ids[4], ids[0], ids[2]])
        self.assertEqual(response.status_code, 200, response.text)
        event = self.detail()
        self.assertEqual(event["report_photo_ids"], [ids[4], ids[0], ids[2]])
        self.assertTrue(event["report_photos_chosen"])

    def test_any_number_chosen_but_foreign_ids_are_refused(self) -> None:
        ids = self.photos(5)
        response = self.choose(ids)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.detail()["report_photo_ids"], ids)
        document = self.upload("a.pdf", PDF, "application/pdf", kind="documents").json()["document"]["id"]
        self.assertEqual(self.choose([document]).status_code, 400)

    def test_deleting_a_chosen_photo_drops_it(self) -> None:
        ids = self.photos(3)
        self.choose(ids)
        self.client.delete(f"/teacher/events/{self.event_id}/media/{ids[0]}", headers=self.auth)
        self.assertEqual(self.detail()["report_photo_ids"], ids[1:])

    def test_not_after_approval(self) -> None:
        ids = self.photos(1)
        self.events.set_status(self.event_id, "approved")
        self.assertIn(self.choose(ids).status_code, (400, 403, 409))


class LegacyOfficeUploadTests(UploadTests):
    """A genuine .doc was refused unless the browser declared exactly
    application/msword -- WPS Office and several OSes use other names."""

    def test_doc_is_accepted_under_every_name_it_is_declared_with(self) -> None:
        for declared in (
            "application/msword", "application/vnd.ms-word", "application/x-msword",
            "application/wps-office.doc", "application/kswps", "application/x-ole-storage",
            "application/CDFV2", "application/octet-stream",
        ):
            response = self.upload("agenda.doc", DOC, declared, kind="documents")
            self.assertEqual(response.status_code, 201, f"{declared}: {response.text}")
            self.assertEqual(self.saved[-1]["content_type"], "application/msword")

    def test_rtf_or_renamed_docx_named_doc_is_accepted(self) -> None:
        # Both open in Word as ".doc"; stored as the canonical Word type.
        for data in (RTF, DOCX):
            response = self.upload("agenda.doc", data, "application/msword", kind="documents")
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(self.saved[-1]["content_type"], "application/msword")

    def test_html_is_still_refused_whatever_it_is_called(self) -> None:
        html = b"<html><script>alert(1)</script></html>"
        self.assertEqual(self.upload("agenda.doc", html, "application/msword", kind="documents").status_code, 400)
        self.assertEqual(self.upload("agenda.doc", DOC, "text/html", kind="documents").status_code, 400)

    def test_xls_and_ppt_accept_their_common_names(self) -> None:
        for name, declared in (
            ("sheet.xls", "application/wps-office.xls"), ("sheet.xls", "application/x-msexcel"),
            ("slides.ppt", "application/wps-office.ppt"), ("slides.ppt", "application/mspowerpoint"),
        ):
            response = self.upload(name, DOC, declared, kind="documents")
            self.assertEqual(response.status_code, 201, f"{name} {declared}: {response.text}")

    def test_xls_and_ppt_still_need_ole_contents(self) -> None:
        for name in ("sheet.xls", "slides.ppt"):
            self.assertEqual(self.upload(name, RTF, "application/octet-stream", kind="documents").status_code, 400)
