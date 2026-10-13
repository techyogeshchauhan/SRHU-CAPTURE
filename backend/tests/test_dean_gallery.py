"""GET /dean/gallery: one album per event with photos or videos."""

from __future__ import annotations

import copy
import os
import re
import unittest
from unittest.mock import patch

from bson import ObjectId

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


_event_types_patcher = None


def setUpModule() -> None:
    # _dean_event_query resolves the type filter through this service, which
    # binds its collection at import.
    global _event_types_patcher
    from tests.fake_event_types import FakeEventTypes

    _event_types_patcher = patch("app.services.event_types.event_types", FakeEventTypes())
    _event_types_patcher.start()


def tearDownModule() -> None:
    if _event_types_patcher is not None:
        _event_types_patcher.stop()


TEACHER = {"id": "teacher-1", "name": "Meera Joshi", "email": "meera@srhu.edu.in", "role": "teacher"}
DEAN = {"id": "dean-1", "name": "Aparna Sharma", "email": "dean@srhu.edu.in", "role": "dean"}
TOKENS = {"Bearer teacher": TEACHER, "Bearer dean": DEAN}


def fake_current_user(authorization):
    return TOKENS[authorization]


def _matches(doc: dict, query: dict) -> bool:
    """Equality, None-as-missing, $in, $ne, $gte/$lte, $or and $regex."""
    for key, wanted in query.items():
        if key == "$or":
            if not any(_matches(doc, clause) for clause in wanted):
                return False
            continue
        value = doc.get(key)
        if isinstance(wanted, dict):
            for op, arg in wanted.items():
                if op == "$in" and value not in arg:
                    return False
                if op == "$ne" and value == arg:
                    return False
                if op == "$gte" and not (value is not None and value >= arg):
                    return False
                if op == "$lte" and not (value is not None and value <= arg):
                    return False
                if op == "$regex" and not re.search(arg, str(value or ""), re.I if "i" in wanted.get("$options", "") else 0):
                    return False
        elif value != wanted:
            return False
    return True


class FakeCursor(list):
    def sort(self, key, direction=1):
        return FakeCursor(sorted(self, key=lambda d: str(d.get(key) or ""), reverse=direction == -1))


class FakeCollection:
    """The find() surface the gallery reads; the projection is ignored."""

    def __init__(self, docs=None) -> None:
        self.docs = [copy.deepcopy(d) for d in (docs or [])]

    def find(self, query=None, *_args, **_kwargs):
        return FakeCursor(copy.deepcopy(d) for d in self.docs if _matches(d, query or {}))


class FakeUsers(FakeCollection):
    pass


def event(name, date, status="approved", **extra):
    return {
        "_id": ObjectId(),
        "event_name": name,
        "event_type": extra.pop("event_type", "Workshop"),
        "event_date": date,
        "status": status,
        "location": "LT-06",
        "archived_at": extra.pop("archived_at", None),
        "created_at": f"{date}T09:00:00",
        **extra,
    }


def media(event_doc, kind="image", n=1):
    return [
        {
            "_id": ObjectId(),
            "event_id": str(event_doc["_id"]),
            "media_type": kind,
            "file_id": str(ObjectId()),
            "file_name": f"{kind}-{i}.jpg",
            "media_url": f"/files/{ObjectId()}",
            "storage": "gridfs",
            "created_at": f"2026-01-01T00:00:0{i}",
        }
        for i in range(n)
    ]


class DeanGalleryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.workshop = event("AI Workshop", "2026-08-21", teacher_id="teacher-1")
        self.seminar = event("Ethics Seminar", "2026-09-05", status="pending", teacher_id="teacher-1",
                             event_type="Seminar")
        self.rejected = event("Cancelled Fest", "2026-07-01", status="rejected", teacher_id="teacher-1")
        self.no_media = event("Quiet Talk", "2026-09-30", teacher_id="teacher-1")
        self.draft = event("Draft Idea", "2026-10-01", status="draft", teacher_id="teacher-1")
        self.archived = event("Old Expo", "2026-06-01", archived_at="2026-09-01T00:00:00", teacher_id="teacher-1")
        self.convocation = event("Convocation", "2026-10-02", status="recorded", owner_id="manager-1",
                                 owner_name="Vishal Tomar", owner_email="vishal@srhu.edu.in",
                                 event_type="Academic")

        teacher_events = [self.workshop, self.seminar, self.rejected, self.no_media, self.draft, self.archived]
        teacher_media = (
            media(self.workshop, "image", 3) + media(self.workshop, "video", 1)
            + media(self.seminar, "image", 2)
            + media(self.rejected, "video", 1)
            + media(self.draft, "image", 1)
            + media(self.archived, "image", 1)
        )

        self.client = TestClient(app)
        self.patches = [
            patch("app.routers.events.events", FakeCollection(teacher_events)),
            patch("app.routers.events.managed_events", FakeCollection([self.convocation])),
            patch("app.routers.events.event_media", FakeCollection(teacher_media)),
            patch("app.routers.events.managed_event_media", FakeCollection(media(self.convocation, "image", 4))),
            patch("app.routers.events.users", FakeUsers([{"_id": "teacher-1", "name": "Meera Joshi"}])),
            patch("app.routers.events.get_current_user", fake_current_user),
        ]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in self.patches:
            patcher.stop()

    def get(self, **params):
        response = self.client.get("/dean/gallery", params=params, headers={"Authorization": "Bearer dean"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def album(self, body, name):
        return next(group for group in body["groups"] if group["event"]["event_name"] == name)

    def names(self, body):
        return [group["event"]["event_name"] for group in body["groups"]]

    def test_groups_only_events_with_media_newest_first(self):
        body = self.get()
        self.assertEqual(
            self.names(body),
            ["Convocation", "Ethics Seminar", "AI Workshop", "Cancelled Fest"],
        )
        self.assertEqual(body["totals"], {"events": 4, "photos": 9, "videos": 2})
        workshop = body["groups"][2]
        self.assertEqual((workshop["photos"], workshop["videos"]), (3, 1))

    def test_albums_carry_a_cover_not_their_media(self):
        # The point of albums: opening the gallery must not fetch every file.
        for group in self.get()["groups"]:
            self.assertNotIn("media", group)
        self.assertEqual(self.album(self.get(), "AI Workshop")["cover"]["file_name"], "image-0.jpg")

    def test_video_only_album_has_no_cover(self):
        self.assertIsNone(self.album(self.get(), "Cancelled Fest")["cover"])

    def test_cover_is_a_photo_even_under_the_video_filter(self):
        body = self.get(media_type="video")
        workshop = self.album(body, "AI Workshop")
        self.assertEqual((workshop["photos"], workshop["videos"]), (0, 1))
        self.assertEqual(workshop["cover"]["file_name"], "image-0.jpg")

    def test_never_shows_drafts_or_archived_events(self):
        names = self.names(self.get())
        self.assertNotIn("Draft Idea", names)
        self.assertNotIn("Old Expo", names)
        self.assertNotIn("Quiet Talk", names)

    def test_cover_links_are_signed(self):
        url = self.get()["groups"][0]["cover"]["media_url"]
        self.assertTrue(url.startswith("http"), url)
        self.assertIn("sig=", url)

    def test_media_type_filter(self):
        body = self.get(media_type="video")
        self.assertEqual(self.names(body), ["AI Workshop", "Cancelled Fest"])
        self.assertEqual(body["totals"], {"events": 2, "photos": 0, "videos": 2})

    def test_unknown_media_type_is_refused(self):
        response = self.client.get(
            "/dean/gallery", params={"media_type": "audio"}, headers={"Authorization": "Bearer dean"}
        )
        self.assertEqual(response.status_code, 400)

    def test_status_type_source_and_date_filters(self):
        self.assertEqual(self.names(self.get(status_bucket="pending")), ["Ethics Seminar"])
        self.assertEqual(self.names(self.get(event_type="Seminar")), ["Ethics Seminar"])
        self.assertEqual(self.names(self.get(source="event_manager")), ["Convocation"])
        self.assertNotIn("Convocation", self.names(self.get(source="teacher")))
        self.assertEqual(
            self.names(self.get(start_date="2026-08-01", end_date="2026-09-30")),
            ["Ethics Seminar", "AI Workshop"],
        )

    def test_event_manager_media_carries_its_submitter(self):
        group = self.get(source="event_manager")["groups"][0]
        self.assertEqual(group["event"]["teacher_name"], "Vishal Tomar")
        self.assertEqual(group["event"]["submitted_by_role"], "event_manager")
        self.assertEqual(group["photos"], 4)

    def test_pages_by_event(self):
        first = self.get(limit=3)
        self.assertEqual(first["count"], 3)
        self.assertEqual(first["total"], 4)
        self.assertTrue(first["has_more"])
        second = self.get(limit=3, skip=3)
        self.assertEqual(self.names(second), ["Cancelled Fest"])
        self.assertFalse(second["has_more"])

    def photos(self, **params):
        response = self.client.get("/dean/gallery/photos", params=params, headers={"Authorization": "Bearer dean"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_photo_wall_lists_every_file_newest_event_first(self):
        body = self.photos()
        self.assertEqual(body["total"], 11)  # 9 photos + 2 videos, as the album totals say
        names = [item["event"]["event_name"] for item in body["items"]]
        self.assertEqual(names[:4], ["Convocation"] * 4)
        self.assertEqual(names[-1], "Cancelled Fest")
        self.assertTrue(all("sig=" in item["media_url"] for item in body["items"]))

    def test_photo_wall_pages_across_events(self):
        first = self.photos(limit=5)
        second = self.photos(limit=5, skip=5)
        third = self.photos(limit=5, skip=10)
        ids = [i["id"] for page in (first, second, third) for i in page["items"]]
        self.assertEqual(len(ids), 11)
        self.assertEqual(len(set(ids)), 11)  # nothing repeated, nothing skipped
        self.assertTrue(first["has_more"])
        self.assertFalse(third["has_more"])
        # Convocation has 4 files and Ethics Seminar 2, so page two starts on
        # the seminar's second file -- mid-event, not at an event boundary.
        self.assertEqual(second["items"][0]["event"]["event_name"], "Ethics Seminar")
        self.assertEqual(second["items"][1]["event"]["event_name"], "AI Workshop")

    def test_photo_wall_follows_the_filters(self):
        videos = self.photos(media_type="video")
        self.assertEqual(videos["total"], 2)
        self.assertTrue(all(item["media_type"] == "video" for item in videos["items"]))
        self.assertEqual(self.photos(source="event_manager")["total"], 4)

    def test_a_teacher_is_refused(self):
        response = self.client.get("/dean/gallery", headers={"Authorization": "Bearer teacher"})
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
