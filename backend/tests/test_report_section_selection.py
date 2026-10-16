"""Customized reports must not leak deselected or unavailable optional data."""
import unittest
from unittest.mock import patch

from bson import ObjectId
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.reports import SECTION_KEYS, normalize_customization
from app.services.managed_report_pdf import ReportEntry, build_managed_report_pdf
from tests.test_event_manager import EventManagerTestCase, pdf_text
from tests.test_event_report import completed_event


def only(*sections):
    return normalize_customization({key: key in sections for key in SECTION_KEYS})


class PdfSectionSelectionTests(unittest.TestCase):
    def test_only_schedule_does_not_include_basic_details(self):
        entry = ReportEntry(event={"event_name": "PRIVATE EVENT NAME", "event_type": "PRIVATE TYPE", "organizer": "PRIVATE ORGANIZER", "event_date": "2026-10-01", "location": "Selected Venue"}, customization=only("include_schedule_venue"), omit_empty_fields=True)
        text = pdf_text(build_managed_report_pdf([entry]).getvalue())
        self.assertIn("Selected Venue", text)
        for hidden in ("PRIVATE EVENT NAME", "PRIVATE TYPE", "PRIVATE ORGANIZER"):
            self.assertNotIn(hidden, text)

    def test_zero_participants_are_supplied_data(self):
        entry = ReportEntry(event={"expected_participants": 0}, customization=only("include_other_info"))
        text = pdf_text(build_managed_report_pdf([entry]).getvalue())
        self.assertIn("No. of Participants", text)
        self.assertIn("0", text)

    def test_empty_description_does_not_produce_placeholder_in_customized_pdf(self):
        entry = ReportEntry(event={"event_name": "Data Test", "description": "  "}, customization=only("include_basic_details", "include_description"))
        text = pdf_text(build_managed_report_pdf([entry]).getvalue())
        self.assertIn("Data Test", text)
        self.assertNotIn("Event Description", text)
        self.assertNotIn("No description provided", text)


class ManagerSectionEndpointTests(EventManagerTestCase):
    def seed_sparse(self):
        key = ObjectId()
        self.events.insert_one({"_id": key, "owner_id": "mgr1", "status": "approved", "event_name": "Sparse Event", "description": '<!--CC_METADATA:{"department":"SST"}-->'})
        return str(key)

    def test_customized_single_pdf_omits_all_missing_sections(self):
        key = self.seed_sparse()
        response = self.call("POST", f"/event-manager/events/{key}/report", json=normalize_customization({}))
        self.assertEqual(response.status_code, 200, response.text)
        text = pdf_text(response.content)
        for hidden in ("Venue", "Event Date", "Event Description", "Event Photos", "Uploaded Notices", "Uploaded Attachments", "No description provided"):
            self.assertNotIn(hidden, text)

    def test_customized_consolidated_pdf_omits_description_for_event_without_it(self):
        sparse = self.seed_sparse()
        full = self.seed_sparse()
        self.events.update_one({"_id": ObjectId(full)}, {"$set": {"description": "Supplied description"}})
        response = self.call("POST", "/event-manager/reports", json={"event_ids": [sparse, full], "customization": only("include_description")})
        self.assertEqual(response.status_code, 200, response.text)
        text = pdf_text(response.content)
        self.assertEqual(text.count("Event Description & Objectives"), 1)
        self.assertIn("Supplied description", text)
        self.assertNotIn("No description provided", text)


class DeanSectionEndpointTests(unittest.TestCase):
    def test_posted_selection_overrides_stored_report_choices(self):
        event = completed_event(event_name="Selection Test", description="CONFIDENTIAL DESCRIPTION", location="Selected Venue")
        with patch("app.routers.reports.get_current_user", return_value={"id": "d1", "role": "dean"}), patch("app.routers.reports.get_event", return_value=event), patch("app.routers.reports.get_report", return_value={"customization": {"include_description": True}}), patch("app.routers.reports.get_event_media", return_value=[]), patch("app.routers.reports.get_event_documents", return_value=[]), patch("app.routers.reports.get_teacher", return_value={}):
            response = TestClient(app).post(f"/dean/events/{event['id']}/report/download", json=only("include_schedule_venue"))
        self.assertEqual(response.status_code, 200, response.text)
        text = pdf_text(response.content)
        self.assertIn("Selected Venue", text)
        self.assertNotIn("CONFIDENTIAL DESCRIPTION", text)
        self.assertNotIn("Event Description", text)
