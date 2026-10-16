"""Full host department names in single/consolidated reports for both roles."""
import io
import json
import unittest
from unittest.mock import patch

from bson import ObjectId
from pypdf import PdfReader

from app.routers.reports import build_dean_report, build_dean_report_entry
from app.services.managed_report_pdf import ReportEntry, _details_rows, build_managed_report_pdf
from app.services.report_pdf import metadata_value, report_department
from tests.test_event_manager import EventManagerTestCase, MANAGER, pdf_text
from tests.test_event_report import completed_event, download, file_link


FULL_DEPARTMENT = "Computer Science and Engineering, School of Science and Technology"


def normalized_text(data):
    return " ".join(pdf_text(data).split())


class DepartmentRenderingTests(unittest.TestCase):
    def test_legacy_alias_and_default_expand_to_exact_requested_name(self):
        for value in (None, "", "  ", "SST", " sst "):
            with self.subTest(value=value):
                self.assertEqual(report_department(value), FULL_DEPARTMENT)
                self.assertEqual(metadata_value({"department": value}, "department"), FULL_DEPARTMENT)

    def test_other_departments_and_configured_defaults_are_preserved(self):
        for value in ("Computer Science", "Medical College", "SST Research"):
            self.assertEqual(report_department(value), value)
        with patch("app.services.report_pdf.settings.default_host_department", "Medical College"):
            self.assertEqual(report_department(), "Medical College")
            self.assertEqual(report_department("SST"), FULL_DEPARTMENT)

    def test_single_report_expands_saved_value_without_mutating_event(self):
        event = {"event_name": "Department workshop", "department": "SST"}
        text = normalized_text(build_managed_report_pdf([ReportEntry(event=event)]).getvalue())
        self.assertIn(FULL_DEPARTMENT, text)
        self.assertNotIn("SST", text)
        self.assertEqual(event["department"], "SST")

    def test_missing_department_keeps_existing_customized_omission_behavior(self):
        entry = ReportEntry(event={"event_name": "Sparse event"}, omit_empty_fields=True)
        self.assertNotIn("Department", dict(_details_rows(entry)))

    def test_consolidated_cover_normalizes_and_deduplicates_department_names(self):
        entries = [ReportEntry(event={"event_name": f"Event {n}", "department": department})
                   for n, department in enumerate(("SST", FULL_DEPARTMENT, "Medical College"))]
        data = build_managed_report_pdf(entries).getvalue()
        cover = " ".join(PdfReader(io.BytesIO(data)).pages[0].extract_text().split())
        self.assertEqual(cover.count(FULL_DEPARTMENT), 1)
        self.assertIn("Medical College", cover)
        self.assertNotIn("SST", normalized_text(data))

    def test_consolidated_cover_has_full_default_without_department_metadata(self):
        entries = [ReportEntry(event={"event_name": f"Event {n}"}) for n in range(2)]
        data = build_managed_report_pdf(entries).getvalue()
        self.assertIn(FULL_DEPARTMENT, normalized_text(data))
        self.assertNotIn("SST", normalized_text(data))

    def test_dean_single_and_consolidated_reports_expand_saved_metadata(self):
        events = [completed_event(event_name=f"Dean workshop {n}",
                                  description='<!--CC_METADATA:{"department":"SST"}-->') for n in range(2)]
        single = build_dean_report(events[0], {"name": "Faculty"}, [], [], file_link=file_link).getvalue()
        self.assertIn(FULL_DEPARTMENT, normalized_text(single))
        entries = [build_dean_report_entry(event, {"name": "Faculty"}, [], [], file_link=file_link) for event in events]
        consolidated = build_managed_report_pdf(entries).getvalue()
        self.assertIn(FULL_DEPARTMENT, normalized_text(consolidated))
        self.assertNotIn("SST", normalized_text(single))
        self.assertNotIn("SST", normalized_text(consolidated))

    def test_dean_http_download_uses_the_full_department(self):
        response = download(completed_event(description='<!--CC_METADATA:{"department":"SST"}-->'))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/pdf")
        self.assertIn(FULL_DEPARTMENT, normalized_text(response.content))


class ManagerDepartmentEndpointTests(EventManagerTestCase):
    def test_single_and_consolidated_http_downloads_expand_saved_and_missing_department(self):
        ids = []
        for department in ("SST", None):
            key = ObjectId()
            event = {"_id": key, "owner_id": MANAGER["id"], "status": "approved",
                     "event_name": "Department test", "description": "Department report"}
            if department:
                event["description"] += "<!--CC_METADATA:" + json.dumps({"department": department}) + "-->"
            self.events.insert_one(event)
            ids.append(str(key))
            response = self.call("POST", f"/event-manager/events/{key}/report", json={"include_basic_details": True})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn(FULL_DEPARTMENT, normalized_text(response.content))
            self.assertNotIn("SST", normalized_text(response.content))
        response = self.call("POST", "/event-manager/reports", json={"event_ids": ids})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn(FULL_DEPARTMENT, normalized_text(response.content))
        self.assertNotIn("SST", normalized_text(response.content))
