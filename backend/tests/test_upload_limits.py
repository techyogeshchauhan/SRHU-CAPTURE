from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from bson import ObjectId
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services.upload_config_service import (
    DEFAULT_UPLOAD_LIMITS,
    REQUIREMENT_FIELDS,
    invalidate_cache,
)

SUPERADMIN = {
    "id": str(ObjectId()),
    "name": "Super Admin",
    "email": "superadmin@srhu.edu.in",
    "role": "superadmin",
}

TEACHER = {
    "id": str(ObjectId()),
    "name": "Teacher Meera",
    "email": "meera@srhu.edu.in",
    "role": "teacher",
}

# Every required field, so a test only has to state what it is actually varying.
VALID_PAYLOAD = {
    "max_photos_per_event": 5,
    "max_photo_size_mb": 15,
    "max_photo_total_mb": 50,
    "max_videos_per_event": 3,
    "max_video_size_mb": 80,
    "max_video_total_mb": 120,
    "max_documents_per_event": 20,
    "max_documents_total_mb": 25,
}


def payload(**overrides):
    return {**VALID_PAYLOAD, **overrides}


class FakeUploadConfig:
    """Stands in for the `upload_config` collection."""

    def __init__(self) -> None:
        self.doc: dict | None = None

    def find_one(self, query, *_args, **_kwargs):
        if self.doc and query.get("key") == "upload_limits":
            return dict(self.doc)
        return None

    def update_one(self, query, update, upsert=False):
        if query.get("key") == "upload_limits":
            if self.doc is None and upsert:
                self.doc = {}
            if self.doc is not None and "$set" in update:
                self.doc.update(update["$set"])
        return MagicMock()

    def delete_one(self, query):
        if query.get("key") == "upload_limits":
            self.doc = None
        return MagicMock()


class FakeAuditLogs:
    """Captures audit writes so the suite never touches a real collection."""

    def __init__(self) -> None:
        self.inserted: list[dict] = []

    def insert_one(self, document):
        self.inserted.append(document)
        return MagicMock()


class UploadLimitsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.fake_config = FakeUploadConfig()
        self.fake_audit = FakeAuditLogs()

        self.patches = [
            patch("app.database.upload_config", self.fake_config),
            patch("app.services.upload_config_service.upload_config", self.fake_config),
            patch("app.services.audit_service.audit_logs", self.fake_audit),
            # `updated_by_name` resolution is a users lookup the settings tests
            # do not otherwise care about.
            patch("app.routers.superadmin.users.find_one", return_value=None),
            # GET /upload-limits is signed-in only now, like every other route
            # in the events router; these tests are about the values it serves.
            patch("app.routers.events.get_current_user", return_value=TEACHER),
        ]
        for item in self.patches:
            item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])

        # The service caches the document; each test starts from a clean read.
        invalidate_cache()
        self.addCleanup(invalidate_cache)

    def as_superadmin(self):
        return patch("app.utils.auth.get_current_user", return_value=SUPERADMIN)

    def put(self, body):
        return self.client.put(
            "/superadmin/upload-limits",
            json=body,
            headers={"Authorization": "Bearer s"},
        )


class UploadLimitsApiTests(UploadLimitsTestCase):
    def test_public_upload_limits_returns_defaults_when_empty(self) -> None:
        response = self.client.get("/upload-limits")
        self.assertEqual(response.status_code, 200)
        limits = response.json()["limits"]
        self.assertEqual(limits["max_photos_per_event"], 10)
        self.assertEqual(limits["max_photo_size_mb"], 20)
        self.assertEqual(limits["max_video_total_mb"], 200)

    def test_public_upload_limits_includes_document_fields(self) -> None:
        limits = self.client.get("/upload-limits").json()["limits"]
        self.assertEqual(limits["max_documents_per_event"], 50)
        self.assertEqual(limits["max_documents_total_mb"], 15)

    def test_superadmin_upload_limits_requires_superadmin(self) -> None:
        with patch("app.utils.auth.get_current_user", return_value=TEACHER):
            response = self.client.get(
                "/superadmin/upload-limits", headers={"Authorization": "Bearer t"}
            )
        self.assertEqual(response.status_code, 403)

    def test_superadmin_can_fetch_upload_limits(self) -> None:
        with self.as_superadmin():
            response = self.client.get(
                "/superadmin/upload-limits", headers={"Authorization": "Bearer s"}
            )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["limits"]["max_photos_per_event"], 10)
        self.assertIn("defaults", data)

    def test_get_serves_bounds_and_deployment_ceiling(self) -> None:
        """The form validates against these, instead of its own copy of the ranges."""
        with self.as_superadmin():
            data = self.client.get(
                "/superadmin/upload-limits", headers={"Authorization": "Bearer s"}
            ).json()

        self.assertEqual(data["deployment_ceiling_mb"], settings.max_upload_size_mb)
        bounds = data["bounds"]
        # Every numeric limit; the *_required switches are booleans with no range.
        self.assertEqual(
            set(bounds), set(DEFAULT_UPLOAD_LIMITS) - set(REQUIREMENT_FIELDS.values())
        )
        self.assertEqual(bounds["max_photos_per_event"], {"min": 1, "max": 100, "unit": "count"})


class UploadLimitsAuthOrderingTests(UploadLimitsTestCase):
    def test_unauthenticated_write_is_401_not_a_schema_dump(self) -> None:
        """Auth must resolve before the body binds.

        While the role check lived inside the handler body, Pydantic ran first and
        an anonymous caller got a 422 listing every field, its constraints and
        their own echoed input.
        """
        for body in ({}, payload(max_photos_per_event=0)):
            with self.subTest(body=body):
                response = self.client.put("/superadmin/upload-limits", json=body)
                self.assertEqual(response.status_code, 401)
                self.assertNotIn("max_photos_per_event", response.text)

    def test_unauthenticated_reset_is_401(self) -> None:
        self.assertEqual(
            self.client.post("/superadmin/upload-limits/reset").status_code, 401
        )


class UploadLimitsValidationTests(UploadLimitsTestCase):
    def test_rejects_values_outside_bounds(self) -> None:
        with self.as_superadmin():
            self.assertEqual(self.put(payload(max_photos_per_event=0)).status_code, 422)

    def test_rejects_photo_total_below_single_photo(self) -> None:
        with self.as_superadmin():
            response = self.put(payload(max_photo_size_mb=20, max_photo_total_mb=10))
        self.assertEqual(response.status_code, 422)

    def test_rejects_video_size_above_video_total(self) -> None:
        with self.as_superadmin():
            response = self.put(payload(max_video_size_mb=150, max_video_total_mb=100))
        self.assertEqual(response.status_code, 422)

    # Pinned, and below every per-file schema bound (the smallest is
    # max_photo_size_mb at 100 MB) so the ceiling check is what rejects the
    # value rather than the field's own range. Held here rather than read from
    # the environment so the assertion holds whatever .env a developer has.
    CEILING_MB = 50

    def with_ceiling(self, megabytes: int = CEILING_MB):
        return patch.object(settings, "max_upload_size_mb", megabytes)

    @staticmethod
    def under_ceiling(**overrides):
        """A payload whose every per-file cap sits below CEILING_MB."""
        base = {
            "max_photo_size_mb": 10,
            "max_photo_total_mb": 40,
            "max_video_size_mb": 40,
            "max_video_total_mb": 45,
            "max_documents_total_mb": 30,
        }
        return payload(**{**base, **overrides})

    def test_rejects_per_file_limit_above_deployment_ceiling(self) -> None:
        """Per-file limits replace the global backstop on the upload path.

        stream_upload() receives them as max_bytes instead of
        settings.max_upload_size_bytes, so a larger value would promise teachers
        an upload the deployment cannot physically accept.
        """
        over = self.CEILING_MB + 1

        # Only the field under test breaches the ceiling; its partner total is
        # raised alongside so a relationship rule cannot reject it first.
        cases = {
            "max_photo_size_mb": self.under_ceiling(
                max_photo_size_mb=over, max_photo_total_mb=over + 10
            ),
            "max_video_size_mb": self.under_ceiling(
                max_video_size_mb=over, max_video_total_mb=over + 10
            ),
            "max_documents_total_mb": self.under_ceiling(max_documents_total_mb=over),
        }

        with self.as_superadmin(), self.with_ceiling():
            for field, body in cases.items():
                with self.subTest(field=field):
                    response = self.put(body)
                    self.assertEqual(response.status_code, 422, response.text)
                    self.assertIn("deployment upload ceiling", response.text)
                    self.assertIn(field, response.text)

    def test_accepts_per_file_limit_exactly_at_the_ceiling(self) -> None:
        with self.as_superadmin(), self.with_ceiling():
            response = self.put(
                self.under_ceiling(
                    max_video_size_mb=self.CEILING_MB,
                    max_video_total_mb=self.CEILING_MB,
                )
            )
        self.assertEqual(response.status_code, 200, response.text)

    def test_get_bounds_are_unaffected_by_the_ceiling(self) -> None:
        """Bounds describe the schema; the ceiling is reported separately."""
        with self.as_superadmin(), self.with_ceiling():
            data = self.client.get(
                "/superadmin/upload-limits", headers={"Authorization": "Bearer s"}
            ).json()
        self.assertEqual(data["deployment_ceiling_mb"], self.CEILING_MB)
        self.assertEqual(data["bounds"]["max_video_size_mb"]["max"], 1000)


class UploadLimitsPersistenceTests(UploadLimitsTestCase):
    def test_update_persists_and_reaches_the_public_endpoint(self) -> None:
        with self.as_superadmin():
            response = self.put(payload())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["limits"]["max_photos_per_event"], 5)

        public = self.client.get("/upload-limits").json()["limits"]
        self.assertEqual(public["max_photos_per_event"], 5)
        self.assertEqual(public["max_videos_per_event"], 3)
        self.assertEqual(public["max_documents_total_mb"], 25)

    def test_update_returns_server_side_metadata(self) -> None:
        """The page showed a browser-clock timestamp because this was missing."""
        with self.as_superadmin():
            data = self.put(payload()).json()
        self.assertIsNotNone(data["updated_at"])
        self.assertEqual(data["updated_by"], SUPERADMIN["id"])

    def test_reset_deletes_the_document_so_defaults_apply_again(self) -> None:
        """Reset used to $set the defaults into the document.

        Because reads prefer stored values, a later change to the environment
        defaults could then never take effect.
        """
        with self.as_superadmin():
            self.put(payload())
            self.assertIsNotNone(self.fake_config.doc)

            response = self.client.post(
                "/superadmin/upload-limits/reset",
                headers={"Authorization": "Bearer s"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.fake_config.doc)
        self.assertEqual(response.json()["limits"]["max_photos_per_event"], 10)
        self.assertIsNone(response.json()["updated_at"])

    def test_requirement_switches_default_to_photo_and_document(self) -> None:
        public = self.client.get("/upload-limits").json()["limits"]
        self.assertIs(public["photos_required"], True)
        self.assertIs(public["videos_required"], False)
        self.assertIs(public["documents_required"], True)

    def test_requirement_switches_round_trip(self) -> None:
        with self.as_superadmin():
            response = self.put(payload(
                photos_required=False, videos_required=True, documents_required=False,
            ))
        self.assertEqual(response.status_code, 200, response.text)

        public = self.client.get("/upload-limits").json()["limits"]
        self.assertIs(public["photos_required"], False)
        self.assertIs(public["videos_required"], True)
        self.assertIs(public["documents_required"], False)

    def test_explicit_nulls_survive_a_round_trip(self) -> None:
        """`None` means "no cap" for these two, so a stored null must win."""
        with self.as_superadmin():
            self.put(payload(max_photo_total_mb=None, max_videos_per_event=None))

        public = self.client.get("/upload-limits").json()["limits"]
        self.assertIsNone(public["max_photo_total_mb"])
        self.assertIsNone(public["max_videos_per_event"])

    def test_document_stored_before_documents_were_configurable_still_reads(self) -> None:
        """Rows written by the previous version lack the two document fields."""
        self.fake_config.doc = {
            "key": "upload_limits",
            "max_photos_per_event": 4,
            "max_photo_size_mb": 8,
            "max_photo_total_mb": None,
            "max_videos_per_event": None,
            "max_video_size_mb": 100,
            "max_video_total_mb": 150,
        }
        invalidate_cache()

        limits = self.client.get("/upload-limits").json()["limits"]
        self.assertEqual(limits["max_photos_per_event"], 4)
        self.assertEqual(limits["max_documents_per_event"], 50)
        self.assertEqual(limits["max_documents_total_mb"], 15)


class UploadLimitsCacheTests(UploadLimitsTestCase):
    def test_writes_invalidate_the_cache(self) -> None:
        self.client.get("/upload-limits")  # warm it

        with self.as_superadmin():
            self.put(payload(max_photos_per_event=7))

        self.assertEqual(
            self.client.get("/upload-limits").json()["limits"]["max_photos_per_event"], 7
        )

    def test_read_failure_serves_last_known_good_rather_than_defaults(self) -> None:
        """Failing open would silently *raise* a limit the admin had tightened."""
        with self.as_superadmin():
            self.put(payload(max_photos_per_event=2))
        self.client.get("/upload-limits")  # warm the cache with the tightened value

        with patch.object(
            self.fake_config, "find_one", side_effect=RuntimeError("mongo down")
        ):
            with patch(
                "app.services.upload_config_service.CACHE_TTL_SECONDS", -1
            ):  # force a re-read
                limits = self.client.get("/upload-limits").json()["limits"]

        self.assertEqual(limits["max_photos_per_event"], 2)


class UploadLimitsAuditTests(UploadLimitsTestCase):
    def test_update_audits_only_what_changed(self) -> None:
        """Logging the raw payload left no way to see what a change actually did."""
        only_photos = {**DEFAULT_UPLOAD_LIMITS, "max_photos_per_event": 5}

        with self.as_superadmin():
            self.assertEqual(self.put(only_photos).status_code, 200)

        entry = self.fake_audit.inserted[-1]
        self.assertEqual(entry["action"], "upload_limits_updated")
        self.assertEqual(
            entry["details"]["changed"], {"max_photos_per_event": {"from": 10, "to": 5}}
        )

    def test_reset_audits_the_same_shape(self) -> None:
        with self.as_superadmin():
            self.put(payload(max_photos_per_event=5))
            self.client.post(
                "/superadmin/upload-limits/reset",
                headers={"Authorization": "Bearer s"},
            )

        entry = self.fake_audit.inserted[-1]
        self.assertEqual(entry["action"], "upload_limits_reset")
        self.assertEqual(
            entry["details"]["changed"]["max_photos_per_event"], {"from": 5, "to": 10}
        )


if __name__ == "__main__":
    unittest.main()
