"""r2_service.object_url: a photo keeps one URL long enough to be cached."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from app.services import r2_service  # noqa: E402


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def generate_presigned_url(self, operation, *, Params, ExpiresIn):
        self.calls.append(dict(Params, ExpiresIn=ExpiresIn))
        return f"https://r2.example/{Params['Key']}?sig={len(self.calls)}"


class SignedUrlReuseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = FakeClient()
        self.clock = [1000.0]
        r2_service._signed_urls.clear()
        self.patches = [
            patch.object(r2_service, "_client", lambda: self.client),
            patch.object(r2_service.settings, "r2_public_url", None),
            patch.object(r2_service.settings, "r2_signed_url_expiry", 6 * 60 * 60),
            patch.object(r2_service.time, "monotonic", lambda: self.clock[0]),
        ]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in self.patches:
            patcher.stop()
        r2_service._signed_urls.clear()

    def url(self, key="events/1/photo.jpg", **kwargs):
        return r2_service.object_url(key, content_type="image/jpeg", **kwargs)

    def test_the_same_object_keeps_its_url_while_young(self):
        first = self.url()
        self.clock[0] += 30 * 60
        self.assertEqual(self.url(), first)
        self.assertEqual(len(self.client.calls), 1)

    def test_an_old_url_is_signed_afresh(self):
        first = self.url()
        # A quarter of six hours, capped at an hour.
        self.clock[0] += 60 * 60
        self.assertNotEqual(self.url(), first)
        self.assertEqual(len(self.client.calls), 2)

    def test_objects_and_names_are_signed_apart(self):
        self.assertNotEqual(self.url("events/1/a.jpg"), self.url("events/1/b.jpg"))
        self.assertNotEqual(self.url(file_name="one.jpg"), self.url(file_name="two.jpg"))

    def test_the_url_asks_the_browser_to_cache(self):
        self.url()
        self.assertEqual(self.client.calls[0]["ResponseCacheControl"], "private, max-age=21600")

    def test_a_public_bucket_is_never_signed(self):
        with patch.object(r2_service.settings, "r2_public_url", "https://cdn.example"):
            self.assertEqual(self.url(), "https://cdn.example/events/1/photo.jpg")
        self.assertEqual(self.client.calls, [])


if __name__ == "__main__":
    unittest.main()
