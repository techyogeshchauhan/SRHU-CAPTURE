"""Photo previews: made small, stored beside the original, handed out as
preview_url, deleted with the photo -- and never in the way of an upload."""

import unittest
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from bson import ObjectId
from PIL import Image

from app.services import media_previews, storage_service
from app.services.media_previews import PREVIEW_EDGE, attach_preview, build_preview, present_media


def image_bytes(size=(2400, 1600), fmt="JPEG", mode="RGB", color="#3a6ea5", **save) -> bytes:
    out = BytesIO()
    Image.new(mode, size, color).save(out, format=fmt, **save)
    return out.getvalue()


def read(data: bytes) -> Image.Image:
    image = Image.open(BytesIO(data))
    image.load()
    return image


class FakeMedia:
    def __init__(self, *docs):
        self.docs = list(docs)

    def update_one(self, query, update):
        for doc in self.docs:
            if doc["_id"] == query["_id"] and doc.get("preview") == query.get("preview"):
                doc.update(update["$set"])
                return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)


class BuildPreviewTests(unittest.TestCase):
    def test_a_large_photo_becomes_a_small_webp(self):
        original = image_bytes()
        preview = build_preview(original)
        image = read(preview)
        self.assertEqual(image.format, "WEBP")
        self.assertEqual(max(image.size), PREVIEW_EDGE)
        self.assertEqual(image.size, (640, 427))
        self.assertLess(len(preview), len(original))

    def test_a_file_object_is_read_from_its_start(self):
        stream = BytesIO(image_bytes((800, 800)))
        stream.seek(100)
        self.assertEqual(read(build_preview(stream)).size, (640, 640))

    def test_the_camera_orientation_is_applied(self):
        exif = Image.Exif()
        exif[0x0112] = 6  # rotate 90 degrees clockwise
        image = read(build_preview(image_bytes((1200, 600), exif=exif.tobytes())))
        self.assertEqual(image.size, (320, 640))

    def test_a_small_photo_is_not_enlarged(self):
        self.assertEqual(read(build_preview(image_bytes((300, 200)))).size, (300, 200))

    def test_transparency_and_palettes_survive(self):
        # Half-transparent: the alpha is kept (a fully opaque one is dropped).
        self.assertEqual(read(build_preview(image_bytes((900, 900), "PNG", "RGBA", (58, 110, 165, 128)))).mode, "RGBA")
        self.assertIsNotNone(build_preview(image_bytes((900, 900), "GIF", "P")))

    def test_what_cannot_be_read_has_no_preview(self):
        for data in (b"", b"\xff\xd8\xff\xe0" + b"\x00" * 64, b"not an image at all"):
            self.assertIsNone(build_preview(data))


class AttachPreviewTests(unittest.TestCase):
    def setUp(self):
        self.saved = []
        enabled = patch.object(media_previews.settings, "media_previews_enabled", True)
        enabled.start()
        self.addCleanup(enabled.stop)

        def fake_save(data, *, file_name, content_type, kind, event_id, teacher_id):
            self.saved.append({"kind": kind, "content_type": content_type, "file_name": file_name, "size": len(data)})
            file_id = str(ObjectId())
            return {"storage": "gridfs", "object_key": None, "file_id": file_id, "url": f"/files/{file_id}"}

        self.deleted = []
        for target, value in (
            ("app.services.media_previews.save_upload", fake_save),
            ("app.services.media_previews.delete_stored", self.deleted.append),
        ):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def photo(self, **fields):
        return {"_id": ObjectId(), "media_type": "image", "file_name": "stage.jpg", "file_id": str(ObjectId()), **fields}

    def test_a_built_preview_is_stored_and_recorded(self):
        record = self.photo()
        media = FakeMedia(record)
        preview = attach_preview(media, record, event_id="e1", owner_id="t1", data=build_preview(image_bytes()))
        self.assertEqual(self.saved[0]["kind"], "preview")
        self.assertEqual(self.saved[0]["content_type"], "image/webp")
        self.assertEqual(self.saved[0]["file_name"], "stage-preview.webp")
        self.assertEqual(media.docs[0]["preview"], preview)
        self.assertEqual(preview["file_size"], self.saved[0]["size"])

    def test_without_data_the_original_is_read_back_from_storage(self):
        record = self.photo()
        with patch.object(media_previews.fs, "get", return_value=BytesIO(image_bytes())) as get:
            self.assertIsNotNone(attach_preview(FakeMedia(record), record, event_id="e1", owner_id="t1"))
        get.assert_called_once()

    def test_videos_and_photos_with_a_preview_are_left_alone(self):
        self.assertIsNone(attach_preview(FakeMedia(), self.photo(media_type="video"), event_id="e", owner_id="t"))
        self.assertIsNone(attach_preview(FakeMedia(), self.photo(preview={"file_id": "x"}), event_id="e", owner_id="t"))
        self.assertEqual(self.saved, [])

    def test_a_photo_deleted_meanwhile_takes_its_new_preview_with_it(self):
        record = self.photo()
        preview = attach_preview(FakeMedia(), record, event_id="e1", owner_id="t1", data=build_preview(image_bytes()))
        self.assertIsNone(preview)
        self.assertEqual(len(self.deleted), 1)  # the stored preview, not left behind

    def test_an_unreadable_original_simply_has_no_preview(self):
        record = self.photo()
        with patch.object(media_previews.fs, "get", side_effect=RuntimeError("gone")):
            self.assertIsNone(attach_preview(FakeMedia(record), record, event_id="e1", owner_id="t1"))
        self.assertEqual(self.saved, [])


class PresentAndDeleteTests(unittest.TestCase):
    def test_present_media_signs_both_links_and_hides_the_storage_fields(self):
        request = MagicMock(base_url="http://api.test/")
        preview_id = str(ObjectId())
        item = present_media(request, {
            "id": "m1", "media_type": "image", "file_id": str(ObjectId()), "media_url": "/files/x",
            "preview": {"storage": "gridfs", "file_id": preview_id, "url": f"/files/{preview_id}"},
        })
        self.assertNotIn("preview", item)
        self.assertTrue(item["media_url"].startswith("http://api.test/files/"))
        self.assertTrue(item["preview_url"].startswith(f"http://api.test/files/{preview_id}?"))
        plain = present_media(request, {"id": "m2", "file_id": str(ObjectId()), "media_url": "/files/y"})
        self.assertNotIn("preview_url", plain)

    def test_deleting_a_photo_deletes_its_preview(self):
        removed = []
        with patch.object(storage_service, "delete_file", side_effect=removed.append):
            storage_service.delete_stored({"file_id": "original", "preview": {"file_id": "small"}})
        self.assertEqual(removed, ["original", "small"])


if __name__ == "__main__":
    unittest.main()
