from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import quote

# Provide the settings the app needs even when no .env is present.
os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.routers.reports import build_dean_report  # noqa: E402
from app.services.report_pdf import (  # noqa: E402
    LOGO_PATH,
    approval_record,
    split_description,
    verbatim_markup,
)
from tests.test_event_manager import image_bytes, pdf_links, pdf_text  # noqa: E402


def file_link(kind: str, file_id: str) -> str:
    return f"https://api.example/reports/files/{kind}/{file_id}?exp=1&sig=a"


def build_event_report_pdf(event: dict, teacher: dict, media: list, documents: list):
    return build_dean_report(event, teacher, media, documents, file_link=file_link)

TEACHER_TEXT = "Line one & <two>\n\n  Indented   with  gaps\nLast line"
META = '{"startTime":"09:30","endTime":"16:45","department":"CSE"}'


def approved_event(**overrides) -> dict:
    event = {
        "id": "6aac7ecbee2ad335979f1268",
        "event_name": "AI Workshop",
        "event_type": "Workshop",
        "event_date": "2026-10-15",
        "location": "Main Auditorium",
        "description": f"{TEACHER_TEXT}\n\n<!--CC_METADATA:{META}-->",
        "social_network_url": "https://example.com/post",
        "status": "approved",
        "history": [{"action": "approved", "actor_name": "Dr. Dean", "created_at": "2026-09-18T10:00:00+00:00"}],
    }
    event.update(overrides)
    return event


def completed_event(**overrides) -> dict:
    """An event the Dean has marked Completed: the only kind with a report."""
    return approved_event(**{"status": "completed", **overrides})


class DescriptionTests(unittest.TestCase):
    def test_teacher_text_is_returned_unchanged(self) -> None:
        text, meta = split_description(approved_event()["description"])
        self.assertEqual(text, TEACHER_TEXT)
        self.assertEqual(meta["department"], "CSE")

    def test_description_without_metadata(self) -> None:
        self.assertEqual(split_description("Just text")[0], "Just text")
        self.assertEqual(split_description(None), ("", {}))

    def test_markup_keeps_breaks_spaces_and_escapes(self) -> None:
        markup = verbatim_markup(TEACHER_TEXT)
        self.assertIn("&amp; &lt;two&gt;", markup)
        self.assertEqual(markup.count("<br/>"), 3)
        self.assertIn("<br/>&nbsp;&nbsp;Indented &nbsp;&nbsp;with &nbsp;gaps<br/>", markup)

    def test_approval_uses_latest_history_entry(self) -> None:
        self.assertEqual(approval_record(approved_event()), ("Dr. Dean", "18 September 2026"))
        self.assertEqual(approval_record(approved_event(history=[]))[0], "Dean")


class PdfTests(unittest.TestCase):
    def test_logo_asset_is_bundled(self) -> None:
        self.assertTrue(LOGO_PATH.is_file())

    def test_builds_a_pdf(self) -> None:
        pdf = build_event_report_pdf(approved_event(), {"name": "T", "email": "t@x.in"}, [], []).getvalue()
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertIn(b"/Image", pdf)  # the SRHU crest is embedded


    def test_long_description_runs_over_several_pages(self) -> None:
        # B-3: ~20,000 characters used to raise LayoutError (one-cell table).
        paragraph = ("The workshop covered supervised learning in depth. " * 40).strip()
        long_text = "\n\n".join([paragraph] * 8)[:20000]
        one_line = "word " * 4000  # a single line with no breaks at all
        for description in (long_text, one_line):
            with self.subTest(lines=description.count("\n")):
                pdf = build_event_report_pdf(
                    approved_event(description=description), {"name": "T"}, [], []
                ).getvalue()
                self.assertTrue(pdf.startswith(b"%PDF"))
                self.assertGreater(pdf.count(b"/Type /Page\n") + pdf.count(b"/Type /Page "), 1)

    def test_numeric_and_odd_metadata_values_do_not_crash(self) -> None:
        # B-12: {"startTime": 930} raised AttributeError on .strip().
        meta = '{"startTime":930,"endTime":1645.5,"department":["x"],"organizer":null,"contactInfo":true}'
        event = approved_event(description=f"Text\n<!--CC_METADATA:{meta}-->")
        _, parsed = split_description(event["description"])
        self.assertEqual(parsed, {"startTime": "930", "endTime": "1645.5"})
        pdf = build_event_report_pdf(event, {"name": "T"}, [], []).getvalue()
        self.assertTrue(pdf.startswith(b"%PDF"))

    def test_non_http_social_link_is_not_clickable(self) -> None:
        pdf = build_event_report_pdf(
            approved_event(social_network_url="javascript:alert(1)"), {"name": "T"}, [], []
        ).getvalue()
        self.assertNotIn(b"/URI", pdf)  # no link annotation at all

        linked = build_event_report_pdf(approved_event(), {"name": "T"}, [], []).getvalue()
        self.assertIn(b"/URI", linked)


    def test_missing_social_link_renders_not_provided(self) -> None:
        # PRD 17: the link is optional, so its absence must not blank the row
        # or crash the build -- it reads "Not provided" and is not a link.
        pdf = build_event_report_pdf(
            approved_event(social_network_url=None), {"name": "T"}, [], []
        ).getvalue()
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertNotIn(b"/URI", pdf)

    def test_signed_by_shows_the_deans_full_designation(self) -> None:
        from reportlab.platypus import Table

        from app.services.report_pdf import _signature_block, _styles

        block = _signature_block(_styles())
        table = next(item for item in block._content if isinstance(item, Table))
        label, value = table._cellvalues[-1]
        self.assertEqual(label.text, "Signed by:")
        self.assertEqual(
            value.text.split("<br/>"),
            ["Dean", "School of Science and Technology", "Swami Rama Himalayan University"],
        )


def download(event: dict):
    client = TestClient(app)
    with patch("app.routers.reports.get_current_user", return_value={"role": "dean"}), \
            patch("app.routers.reports.get_event", return_value=event), \
            patch("app.routers.reports.get_report", return_value={"event_id": "x"}), \
            patch("app.routers.reports.get_event_media", return_value=[]), \
            patch("app.routers.reports.get_event_documents", return_value=[]), \
            patch("app.routers.reports.get_teacher", return_value={"name": "T"}):
        return client.get(
            "/dean/events/6aac7ecbee2ad335979f1268/report/download",
            headers={"Authorization": "Bearer t"},
        )


class DownloadEndpointTests(unittest.TestCase):
    def test_dean_downloads_the_report(self) -> None:
        response = download(completed_event())

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["content-type"], "application/pdf")
        self.assertTrue(response.content.startswith(b"%PDF"))
        disposition = response.headers["content-disposition"]
        # Named after the event: the real name in filename*, ASCII in filename.
        self.assertIn("filename*=UTF-8''AI%20Workshop.pdf", disposition)
        self.assertIn('filename="AI_Workshop.pdf"', disposition)

    def test_hindi_event_name_download_header(self) -> None:
        # B-11: a Devanagari name raised UnicodeEncodeError in the header.
        response = download(completed_event(event_name="वार्षिक खेल दिवस"))
        self.assertEqual(response.status_code, 200, response.text)
        disposition = response.headers["content-disposition"]
        disposition.encode("latin-1")  # the header must be encodable
        self.assertTrue(disposition.startswith("attachment;"))
        self.assertIn('filename="', disposition)
        fallback = disposition.split('filename="')[1].split('"')[0]
        self.assertTrue(fallback.isascii() and fallback.endswith(".pdf"), fallback)
        self.assertIn(
            "filename*=UTF-8''" + quote("वार्षिक खेल दिवस.pdf", safe=""), disposition
        )

    def test_numeric_start_time_downloads(self) -> None:
        event = completed_event(description='Text\n<!--CC_METADATA:{"startTime":930}-->')
        self.assertEqual(download(event).status_code, 200)

    def test_download_without_social_link(self) -> None:
        # PRD 17: previously 400 "Social Network Link is required".
        for missing in (None, "", "   "):
            with self.subTest(social=missing):
                response = download(completed_event(social_network_url=missing))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.content.startswith(b"%PDF"))


class GenerateWithoutSocialLinkTests(unittest.TestCase):
    """PRD 17: a missing Social Network Link no longer blocks generation."""

    def test_generate_succeeds_without_social_link(self) -> None:
        client = TestClient(app)
        reports = MagicMock()
        with patch("app.routers.reports.get_current_user", return_value={"role": "dean"}), \
                patch("app.routers.reports.get_event",
                      return_value=completed_event(social_network_url=None)), \
                patch("app.routers.reports.get_event_media", return_value=[]), \
                patch("app.routers.reports.get_event_documents", return_value=[]), \
                patch("app.routers.reports.get_teacher", return_value={"name": "T"}), \
                patch("app.routers.reports.event_reports", reports):
            response = client.post(
                "/dean/events/6aac7ecbee2ad335979f1268/generate-report",
                headers={"Authorization": "Bearer t"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(reports.replace_one.called)

    def test_generate_is_refused_until_the_event_is_completed(self) -> None:
        client = TestClient(app)
        reports = MagicMock()
        for status_value in ("approved", "pending", "revoked"):
            with self.subTest(status=status_value), \
                    patch("app.routers.reports.get_current_user", return_value={"role": "dean"}), \
                    patch("app.routers.reports.get_event", return_value=approved_event(status=status_value)), \
                    patch("app.routers.reports.event_reports", reports):
                response = client.post(
                    "/dean/events/6aac7ecbee2ad335979f1268/generate-report",
                    headers={"Authorization": "Bearer t"},
                )
            self.assertEqual(response.status_code, 400)
            self.assertIn("Completed", response.json()["detail"])
        self.assertFalse(reports.replace_one.called)

    def test_download_is_refused_until_the_event_is_completed(self) -> None:
        # Also covers a report generated before the rule, while only approved.
        response = download(approved_event())
        self.assertEqual(response.status_code, 400)
        self.assertIn("Completed", response.json()["detail"])

    def test_generated_body_says_not_provided(self) -> None:
        from app.routers.reports import build_report_content

        body = build_report_content(
            approved_event(social_network_url=None), {"name": "T", "email": "t@x"}, [], []
        )
        self.assertIn("Not provided", body)


class DraftVisibilityTests(unittest.TestCase):
    """B-28: report endpoints treat a draft as missing, like GET /dean/events/{id}."""

    def test_report_status_and_documents_hide_drafts(self) -> None:
        from bson import ObjectId

        draft_id = ObjectId()
        fake_events = MagicMock()
        fake_events.find_one.return_value = {"_id": draft_id, "status": "draft"}
        client = TestClient(app)
        with patch("app.routers.reports.get_current_user", return_value={"role": "dean"}), \
                patch("app.routers.reports.check_event_viewer"), \
                patch("app.routers.reports.events", fake_events):
            for path in ("report-status", "documents"):
                with self.subTest(path=path):
                    response = client.get(
                        f"/dean/events/{draft_id}/{path}", headers={"Authorization": "Bearer t"}
                    )
                    self.assertEqual(response.status_code, 404)


class HostDepartmentTests(unittest.TestCase):
    """Reports print the full name of the default host department."""

    def test_missing_department_reports_as_full_host_name(self) -> None:
        from app.services.report_pdf import metadata_value

        expected = "Computer Science and Engineering, School of Science and Technology"
        self.assertEqual(metadata_value({}, "department"), expected)
        self.assertEqual(metadata_value({"department": "   "}, "department"), expected)

    def test_a_saved_department_is_kept(self) -> None:
        from app.services.report_pdf import metadata_value

        self.assertEqual(metadata_value({"department": "Computer Science"}, "department"), "Computer Science")

    def test_other_fields_get_no_default(self) -> None:
        from app.services.report_pdf import metadata_value

        self.assertEqual(metadata_value({}, "expectedParticipants"), "")


if __name__ == "__main__":
    unittest.main()


# ============================================================
# SAME DESIGN AS THE EVENT MANAGER'S REPORT
# ============================================================

class FakeFS:
    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files

    def get(self, file_id):
        import io

        data = self.files[str(file_id)]
        out = io.BytesIO(data)
        out.length = len(data)  # like GridOut
        return out


def photo_row(file_id: str, n: int) -> dict:
    return {"id": f"66aa0000000000000000000{n}", "media_type": "image", "file_id": file_id,
            "file_name": f"photo{n}.png", "file_size": 100}


class DeanReportDesignTests(unittest.TestCase):
    def setUp(self) -> None:
        from bson import ObjectId

        self.media, files = [], {}
        for n in range(6):
            file_id = str(ObjectId())
            files[file_id] = image_bytes(80, 60, shade=30 * n)
            self.media.append(photo_row(file_id, n))
        patcher = patch("app.routers.reports.fs", FakeFS(files))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.documents = [{"id": "66bb00000000000000000001", "file_name": "agenda.pdf", "file_size": 2048}]

    def build(self, **event_overrides) -> bytes:
        return build_event_report_pdf(
            approved_event(**event_overrides), {"name": "Prof. T", "email": "t@srhu.edu.in"},
            self.media, self.documents,
        ).getvalue()

    def test_sections_match_the_event_manager_report_plus_approval(self) -> None:
        text = pdf_text(self.build())
        # The document predates the Notice / Report split, so it is a notice;
        # the photo links are listed under Reports.
        headings = [
            "1. Event Details", "2. Event Description", "3. Event Photos",
            "4. Uploaded Notices", "5. Uploaded Attachments", "6. Approval",
        ]
        positions = [text.index(h) for h in headings]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("Submitted by", text)
        self.assertNotIn("Recorded by", text)
        # No reference number, and no product line under the letterhead.
        self.assertNotIn("Ref.", text)
        self.assertNotIn("Event Documentation", text)
        self.assertIn("S. No.", text)
        self.assertNotIn("Supporting Material", text)

    def test_default_photos_are_the_first_four(self) -> None:
        pdf = self.build()
        self.assertEqual(pdf.count(b"/Subtype /Image"), 4 + 1)  # four photos + the crest

    def test_the_teachers_choice_is_used(self) -> None:
        chosen = [self.media[5]["id"], self.media[2]["id"]]
        pdf = self.build(report_photo_ids=chosen)
        self.assertEqual(pdf.count(b"/Subtype /Image"), 2 + 1)

    def test_every_file_is_listed_with_a_download_link(self) -> None:
        links = pdf_links(self.build())
        files = [u for u in links if "/reports/files/" in u]
        self.assertEqual(len(files), len(self.media) + len(self.documents))
        self.assertTrue(any("/reports/files/documents/66bb00000000000000000001" in u for u in files))

    def test_no_photo_section_without_photos(self) -> None:
        text = pdf_text(build_event_report_pdf(approved_event(), {"name": "T"}, [], []).getvalue())
        self.assertNotIn("Event Photos", text)
        self.assertNotIn("Attachments", text)
        self.assertIn("3. Approval", text)


class DeanReportLinkTests(unittest.TestCase):
    def test_signed_link_downloads_and_tampering_is_refused(self) -> None:
        from bson import ObjectId

        from app.services.report_files import link_signature

        client = TestClient(app)
        doc_id, file_id = ObjectId(), str(ObjectId())
        row = {"_id": doc_id, "file_id": file_id, "file_name": "agenda.pdf", "content_type": "application/pdf"}
        documents = MagicMock()
        documents.find_one.side_effect = lambda query: row if query == {"_id": doc_id} else None
        with patch("app.routers.reports.event_documents", documents), \
                patch("app.routers.reports.fs", FakeFS({file_id: b"%PDF-1.4 test"})):
            good = link_signature("event", "documents", str(doc_id), 9999999999)
            response = client.get(f"/reports/files/documents/{doc_id}?exp=9999999999&sig={good}")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.content, b"%PDF-1.4 test")

            for sig in (
                "00",
                link_signature("managed", "documents", str(doc_id), 9999999999),  # an Event Manager link
                link_signature("event", "media", str(doc_id), 9999999999),        # the other kind
            ):
                self.assertEqual(
                    client.get(f"/reports/files/documents/{doc_id}?exp=9999999999&sig={sig}").status_code, 403
                )
            expired = link_signature("event", "documents", str(doc_id), 1000)
            self.assertEqual(client.get(f"/reports/files/documents/{doc_id}?exp=1000&sig={expired}").status_code, 403)


class ReportCustomizationTests(unittest.TestCase):
    """Dean and Event Manager report customization tests."""

    def test_dean_generate_with_customization_saves_options(self) -> None:
        client = TestClient(app)
        reports = MagicMock()
        payload = {
            "include_basic_details": True,
            "include_schedule_venue": True,
            "include_description": False,
            "include_other_info": False,
            "include_photos": False,
            "include_documents": False,
        }
        with patch("app.routers.reports.get_current_user", return_value={"role": "dean"}), \
                patch("app.routers.reports.get_event", return_value=completed_event()), \
                patch("app.routers.reports.get_event_media", return_value=[]), \
                patch("app.routers.reports.get_event_documents", return_value=[]), \
                patch("app.routers.reports.get_teacher", return_value={"name": "Prof Sharma"}), \
                patch("app.routers.reports.event_reports", reports):
            response = client.post(
                "/dean/events/6aac7ecbee2ad335979f1268/generate-report",
                json=payload,
                headers={"Authorization": "Bearer token"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(reports.replace_one.called)
        saved_doc = reports.replace_one.call_args[0][1]
        expected = {**payload, "include_notices": False, "include_reports": False, "selected_photo_ids": None}
        self.assertEqual(saved_doc.get("customization"), expected)
        self.assertEqual(response.json()["customization"], expected)

    def test_dean_generate_all_false_rejected(self) -> None:
        client = TestClient(app)
        payload = {
            "include_basic_details": False,
            "include_schedule_venue": False,
            "include_description": False,
            "include_other_info": False,
            "include_photos": False,
            "include_documents": False,
        }
        with patch("app.routers.reports.get_current_user", return_value={"role": "dean"}), \
                patch("app.routers.reports.get_event", return_value=completed_event()):
            response = client.post(
                "/dean/events/6aac7ecbee2ad335979f1268/generate-report",
                json=payload,
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 400)
        self.assertIn("select at least one section", response.json()["detail"])

    def test_dean_download_customization_filtering(self) -> None:
        client = TestClient(app)
        ev = completed_event()
        with patch("app.routers.reports.get_current_user", return_value={"role": "dean"}), \
                patch("app.routers.reports.get_event", return_value=ev), \
                patch("app.routers.reports.get_report", return_value={"customization": {"include_description": False}}), \
                patch("app.routers.reports.get_event_media", return_value=[]), \
                patch("app.routers.reports.get_event_documents", return_value=[]), \
                patch("app.routers.reports.get_teacher", return_value={"name": "Prof Sharma"}):
            response = client.get(
                f"/dean/events/{ev['id']}/report/download",
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 200)
        text = pdf_text(response.content)
        self.assertNotIn("Event Description & Objectives", text)
        self.assertIn("1. Event Details", text)

    def test_dean_download_notice_and_report_sections_filtering(self) -> None:
        client = TestClient(app)
        ev = completed_event()
        mock_docs = [
            {"id": "doc1", "file_name": "notice.pdf", "original_name": "notice.pdf", "file_size": 1024, "category": "notice"},
            {"id": "doc2", "file_name": "report.pdf", "original_name": "report.pdf", "file_size": 2048, "category": "report"},
        ]
        # Only include notices
        with patch("app.routers.reports.get_current_user", return_value={"role": "dean"}), \
                patch("app.routers.reports.get_event", return_value=ev), \
                patch("app.routers.reports.get_report", return_value={"customization": {"include_notices": True, "include_reports": False}}), \
                patch("app.routers.reports.get_event_media", return_value=[]), \
                patch("app.routers.reports.get_event_documents", return_value=mock_docs), \
                patch("app.routers.reports.get_teacher", return_value={"name": "Prof Sharma"}):
            response = client.get(
                f"/dean/events/{ev['id']}/report/download",
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 200)
        text = pdf_text(response.content)
        self.assertIn("Uploaded Notices", text)
        self.assertIn("notice.pdf", text)
        self.assertNotIn("Uploaded Attachments", text)
        self.assertNotIn("report.pdf", text)

        # Only include reports
        with patch("app.routers.reports.get_current_user", return_value={"role": "dean"}), \
                patch("app.routers.reports.get_event", return_value=ev), \
                patch("app.routers.reports.get_report", return_value={"customization": {"include_notices": False, "include_reports": True}}), \
                patch("app.routers.reports.get_event_media", return_value=[]), \
                patch("app.routers.reports.get_event_documents", return_value=mock_docs), \
                patch("app.routers.reports.get_teacher", return_value={"name": "Prof Sharma"}):
            response = client.get(
                f"/dean/events/{ev['id']}/report/download",
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 200)
        text = pdf_text(response.content)
        self.assertNotIn("Uploaded Notices", text)
        self.assertNotIn("notice.pdf", text)
        self.assertIn("Uploaded Attachments", text)
        self.assertIn("report.pdf", text)


class ReportAttachmentChoiceTests(unittest.TestCase):
    """Which file links a customised report lists."""

    media = [
        {"id": "66aa00000000000000000001", "media_type": "image", "file_name": "stage.png", "file_size": 10},
        {"id": "66aa00000000000000000002", "media_type": "video", "file_name": "teaser.mp4", "file_size": 10},
    ]
    documents = [
        {"id": "66bb00000000000000000001", "file_name": "circular.pdf", "file_size": 10, "category": "notice"},
        {"id": "66bb00000000000000000002", "file_name": "summary.pdf", "file_size": 10, "category": "report"},
        {"id": "66bb00000000000000000003", "file_name": "legacy.pdf", "file_size": 10},
    ]

    def listed(self, **options) -> str:
        from app.schemas.reports import normalize_customization

        pdf = build_dean_report(
            approved_event(), {"name": "T"}, self.media, self.documents,
            file_link=lambda kind, file_id: f"https://api.example/{kind}/{file_id}",
            customization=normalize_customization(options),
        )
        return pdf_text(pdf.getvalue())

    def test_everything_by_default(self) -> None:
        text = self.listed()
        for name in ("stage.png", "teaser.mp4", "circular.pdf", "summary.pdf", "legacy.pdf"):
            self.assertIn(name, text)

    def test_photos_off_drops_the_photo_links_too(self) -> None:
        text = self.listed(include_photos=False)
        self.assertNotIn("stage.png", text)
        self.assertIn("teaser.mp4", text)
        self.assertIn("circular.pdf", text)

    def test_notices_off_keeps_videos_and_reports(self) -> None:
        text = self.listed(include_notices=False)
        self.assertNotIn("circular.pdf", text)
        self.assertNotIn("legacy.pdf", text)  # no category: a notice
        self.assertIn("summary.pdf", text)
        self.assertIn("teaser.mp4", text)
        self.assertIn("stage.png", text)
        self.assertIn("Uploaded Attachments", text)
        self.assertNotIn("Uploaded Notices", text)

    def test_the_notice_section_holds_only_notices(self) -> None:
        text = self.listed()
        notices = text[text.index("Uploaded Notices"):text.index("Uploaded Attachments")]
        reports = text[text.index("Uploaded Attachments"):]
        for name in ("circular.pdf", "legacy.pdf"):
            self.assertIn(name, notices)
            self.assertNotIn(name, reports)
        for name in ("summary.pdf", "stage.png", "teaser.mp4"):
            self.assertIn(name, reports)
            self.assertNotIn(name, notices)

    def test_reports_off_leaves_only_the_notices(self) -> None:
        text = self.listed(include_reports=False)
        self.assertIn("circular.pdf", text)
        for name in ("summary.pdf", "stage.png", "teaser.mp4"):
            self.assertNotIn(name, text)
        self.assertNotIn("Uploaded Attachments", text)

    def test_no_document_sections_lists_no_files(self) -> None:
        text = self.listed(include_notices=False, include_reports=False)
        for name in ("stage.png", "teaser.mp4", "circular.pdf", "summary.pdf"):
            self.assertNotIn(name, text)

    def test_empty_description_still_has_its_section(self) -> None:
        text = pdf_text(build_event_report_pdf(approved_event(description=""), {"name": "T"}, [], []).getvalue())
        self.assertIn("2. Event Description", text)
        self.assertIn("No description provided.", text)

    def test_query_flags_and_stored_options_mean_the_same(self) -> None:
        from app.services.report_files import resolve_customization

        from_query = resolve_customization(None, {"include_documents": False, "include_photos": None})
        self.assertFalse(from_query["include_notices"])
        self.assertFalse(from_query["include_reports"])
        self.assertTrue(from_query["include_photos"])
        stored = resolve_customization(None, {}, stored={"include_description": False})
        self.assertFalse(stored["include_description"])
        self.assertIsNone(resolve_customization(None, {}))
