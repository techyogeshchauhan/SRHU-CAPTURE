"""Photo-read failure recovery, bounded concurrency, and real PDF responses."""
import threading
import unittest
from io import BytesIO
from unittest.mock import patch

from bson import ObjectId
from fastapi import HTTPException

from app.services import report_files
from tests.test_event_manager import EventManagerTestCase, image_bytes, pdf_text


class PhotoReadTests(unittest.TestCase):
    def test_streaming_read_closes_and_returns_complete_bytes(self):
        data = image_bytes(20, 30)
        response = BytesIO(data)
        response.headers = {"Content-Length": str(len(data))}
        with patch("app.services.report_files.r2_service._client") as client, patch("app.services.report_files.urlopen", return_value=response):
            client.return_value.generate_presigned_url.return_value = "http://storage.test/photo"
            self.assertEqual(report_files.read_file_bytes({"object_key": "photo"}, None), data)
        self.assertTrue(response.closed)

    def test_storage_timeout_is_not_silently_converted_to_a_missing_photo(self):
        with patch("app.services.report_files.r2_service._client"), patch("app.services.report_files.urlopen", side_effect=TimeoutError("stalled")):
            with self.assertRaises(HTTPException) as caught:
                report_files.read_file_bytes({"object_key": "photo"}, None)
        self.assertEqual(caught.exception.status_code, 504)

    def test_continuous_trickle_hits_total_read_deadline(self):
        response = BytesIO(b"a")
        response.headers = {}
        with patch("app.services.report_files.r2_service._client"), patch("app.services.report_files.urlopen", return_value=response), patch("app.services.report_files.time.monotonic", side_effect=[0, 1, 30, 31]):
            with self.assertRaises(HTTPException) as caught:
                report_files.read_file_bytes({"object_key": "photo"}, None)
        self.assertEqual(caught.exception.status_code, 504)
        self.assertTrue(response.closed)

    def test_large_camera_original_can_finish_after_twenty_seconds(self):
        data = image_bytes(20, 30)
        response = BytesIO(data)
        response.headers = {"Content-Length": str(len(data))}
        with patch("app.services.report_files.r2_service._client"), patch("app.services.report_files.urlopen", return_value=response), patch("app.services.report_files.time.monotonic", side_effect=[0, 1, 30]):
            self.assertEqual(report_files.read_file_bytes({"object_key": "photo", "file_size": 14 * 1024 * 1024}, None), data)
        self.assertTrue(response.closed)

    def test_content_length_allows_large_legacy_photo_without_size_metadata(self):
        data = b"x" * (14 * 1024 * 1024)
        response = BytesIO(data)
        response.headers = {"Content-Length": str(len(data))}
        # First chunk arrives after the old 20-second limit, then the rest
        # finishes within the size-based allowance.
        with patch("app.services.report_files.r2_service._client"), patch("app.services.report_files.urlopen", return_value=response), patch("app.services.report_files.time.monotonic", side_effect=[0] + [30] * 225):
            self.assertEqual(report_files.read_file_bytes({"object_key": "photo"}, None), data)

    def test_large_continuous_trickle_still_hits_hard_deadline(self):
        response = BytesIO(b"a")
        response.headers = {}
        with patch("app.services.report_files.r2_service._client"), patch("app.services.report_files.urlopen", return_value=response), patch("app.services.report_files.time.monotonic", side_effect=[0, 1, 181, 182]):
            with self.assertRaises(HTTPException) as caught:
                report_files.read_file_bytes({"object_key": "photo", "file_size": 200 * 1024 * 1024}, None)
        self.assertEqual(caught.exception.status_code, 504)
        self.assertTrue(response.closed)

    def test_truncated_photo_response_fails_instead_of_becoming_a_partial_pdf(self):
        response = BytesIO(b"incomplete")
        response.headers = {"Content-Length": "1000"}
        with patch("app.services.report_files.r2_service._client"), patch("app.services.report_files.urlopen", return_value=response):
            with self.assertRaises(HTTPException) as caught:
                report_files.read_file_bytes({"object_key": "photo"}, None)
        self.assertEqual(caught.exception.status_code, 504)

    def test_parallel_preparation_preserves_selection_order_and_missing_counts(self):
        barrier = threading.Barrier(4)
        def read(row, _fs):
            barrier.wait(timeout=3)
            return row["number"]
        with patch("app.services.report_files.read_file_bytes", side_effect=read):
            photos, failures = report_files.prepare_report_photos([{"number": n} for n in range(1, 5)], None, lambda data: data)
        self.assertEqual(photos, [1, 2, 3, 4])
        self.assertEqual(failures, 0)
        self.assertEqual(report_files.prepare_report_photos([None], None, lambda data: data), ([], 1))


class ReportRecoveryEndpointTests(EventManagerTestCase):
    def test_storage_failure_resets_request_and_retry_returns_a_real_pdf(self):
        event = self.recorded()
        key = event["id"]
        self.events.update_one({"_id": ObjectId(key)}, {"$set": {"status": "approved"}})
        with patch("app.services.report_files.read_file_bytes", side_effect=HTTPException(504, "Could not load report photos. Please try again.")):
            failed = self.call("POST", f"/event-manager/events/{key}/report", json={"include_photos": True})
        self.assertEqual(failed.status_code, 504, failed.text)
        self.assertNotIn("application/pdf", failed.headers["content-type"])
        self.assertIsNone(self.reports.find_one({"event_id": key}))
        retry = self.call("POST", f"/event-manager/events/{key}/report", json={"include_photos": True})
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertTrue(retry.content.startswith(b"%PDF-"))
        self.assertIn("Event Photos", pdf_text(retry.content))
