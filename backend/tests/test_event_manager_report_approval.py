"""Approval must precede every Event Manager PDF build and status write."""
from unittest.mock import patch

from bson import ObjectId

from app.models.documents import APPROVED_STAGES
from tests.test_event_manager import EventManagerTestCase, FakeCollection, pdf_text

DRAFT_DETAIL = "Draft events cannot be included in the report. Please select only non-draft events to generate the report."
APPROVAL_DETAIL = "Report unavailable."
BLOCKED = ("draft", "pending", "submitted", "under_review", "rejected", "revoked", "recorded", "resubmitted", "needs_correction", "unknown", "", None)


class ManagerReportApprovalTests(EventManagerTestCase):
    def seed(self, state, owner="mgr1", policy=True, **overrides):
        key = ObjectId()
        self.events.insert_one({"_id": key, "owner_id": owner, "event_name": "Approval restricted report", "status": state, "description": "Selected report description", "location": "Approved venue", **({"report_approval_required": policy} if policy is not None else {}), **overrides})
        return str(key)

    def test_every_single_report_method_blocks_unapproved_statuses_before_work(self):
        for state in BLOCKED:
            key = self.seed(state, report_generated_at="2026-10-01", history=[{"action": "approved"}])
            for method in ("GET", "POST"):
                with self.subTest(status=state, method=method), patch("app.routers.event_manager._report_entry") as entry, patch("app.routers.event_manager.build_managed_report_pdf") as build, patch("app.routers.event_manager._record_reports") as record:
                    response = self.call(method, f"/event-manager/events/{key}/report", **({"json": {"include_description": True}} if method == "POST" else {}))
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertEqual(response.json()["detail"], DRAFT_DETAIL if state == "draft" else APPROVAL_DETAIL)
                    entry.assert_not_called()
                    build.assert_not_called()
                    record.assert_not_called()

    def test_mixed_bulk_selection_is_rejected_atomically(self):
        approved = self.seed("approved")
        for state in BLOCKED:
            with self.subTest(status=state), patch("app.routers.event_manager._report_entry") as entry, patch("app.routers.event_manager.build_managed_report_pdf") as build, patch("app.routers.event_manager._record_reports") as record:
                blocked = self.seed(state)
                response = self.call("POST", "/event-manager/reports", json={"event_ids": [approved, blocked], "customization": {"include_description": True}})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["detail"], DRAFT_DETAIL if state == "draft" else APPROVAL_DETAIL)
                entry.assert_not_called()
                build.assert_not_called()
                record.assert_not_called()

    def test_approved_stages_generate_customized_pdf(self):
        for state in APPROVED_STAGES:
            for method in ("GET", "POST"):
                with self.subTest(status=state, method=method):
                    key = self.seed(state)
                    response = self.call(method, f"/event-manager/events/{key}/report", **({"json": {"include_description": False}} if method == "POST" else {}))
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.headers["content-type"], "application/pdf")
                    self.assertEqual("Selected report description" in pdf_text(response.content), method == "GET")

    def test_approved_bulk_report_succeeds(self):
        keys = [self.seed("approved"), self.seed("completed")]
        response = self.call("POST", "/event-manager/reports", json={"event_ids": keys, "customization": {"include_description": True}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("CONSOLIDATED EVENT REPORT", pdf_text(response.content))

    def test_existing_eligible_events_keep_single_and_bulk_report_access(self):
        keys = []
        for state in (*APPROVED_STAGES, "recorded"):
            key = self.seed(state, policy=None)
            keys.append(key)
            for method in ("GET", "POST"):
                with self.subTest(status=state, method=method):
                    response = self.call(method, f"/event-manager/events/{key}/report", **({"json": {"include_description": False}} if method == "POST" else {}))
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.headers["content-type"], "application/pdf")
                    self.assertEqual("Selected report description" in pdf_text(response.content), method == "GET")
        response = self.call("POST", "/event-manager/reports", json={"event_ids": keys})
        self.assertEqual(response.status_code, 200, response.text)

    def test_legacy_refused_or_pending_event_is_not_grandfathered_by_previous_report(self):
        for state in (s for s in BLOCKED if s != "recorded"):
            with self.subTest(status=state):
                key = self.seed(state, policy=None, report_generated_at="2026-10-01")
                self.assertEqual(self.call("GET", f"/event-manager/events/{key}/report").status_code, 400)

    def test_new_event_policy_is_server_owned_and_survives_edits(self):
        event = self.draft(report_approval_required=False)
        self.assertIs(event["report_approval_required"], True)
        self.assertEqual(self.call("GET", f'/event-manager/events/{event["id"]}/report').status_code, 400)
        response = self.save(event["id"], save_as_draft=True, report_approval_required=False)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIs(response.json()["event"]["report_approval_required"], True)
        self.events.update_one({"_id": ObjectId(event["id"])}, {"$set": {"status": "recorded"}})
        self.assertEqual(self.call("GET", f'/event-manager/events/{event["id"]}/report').status_code, 400)
        legacy = self.seed("recorded", policy=None)
        self.assertEqual(self.call("POST", "/event-manager/reports", json={"event_ids": [legacy, event["id"]]}).status_code, 400)

    def test_revoking_approval_blocks_a_previously_generated_report(self):
        key = self.seed("approved")
        self.assertEqual(self.call("GET", f"/event-manager/events/{key}/report").status_code, 200)
        self.events.update_one({"_id": ObjectId(key)}, {"$set": {"status": "revoked"}})
        self.assertEqual(self.call("GET", f"/event-manager/events/{key}/report").status_code, 400)
        self.assertEqual(self.call("POST", "/event-manager/reports", json={"event_ids": [key]}).status_code, 400)

    def test_approval_does_not_bypass_ownership_or_role_authorization(self):
        key = self.seed("approved", owner="mgr2")
        self.assertEqual(self.call("GET", f"/event-manager/events/{key}/report").status_code, 404)
        self.assertEqual(self.call("POST", "/event-manager/reports", json={"event_ids": [key]}).status_code, 404)
        self.assertEqual(self.call("GET", f"/event-manager/events/{key}/report", token="teacher").status_code, 403)

    def test_real_dean_approval_and_revocation_control_manager_download(self):
        key = self.seed("pending")
        with patch("app.routers.events.events", FakeCollection()), patch("app.routers.events.managed_events", self.events), patch("app.routers.events.event_reports", self.reports), patch("app.routers.events.get_current_user", self._user), patch("app.routers.events.notify_teacher"):
            self.assertEqual(self.call("GET", f"/event-manager/events/{key}/report").status_code, 400)
            self.assertEqual(self.call("PATCH", f"/dean/events/{key}/approve").status_code, 403)
            approved = self.call("PATCH", f"/dean/events/{key}/approve", token="dean")
            self.assertEqual(approved.status_code, 200, approved.text)
            self.assertEqual(approved.json()["event"]["history"][-1]["actor_role"], "dean")
            report = self.call("POST", f"/event-manager/events/{key}/report", json={"include_description": False})
            self.assertEqual(report.status_code, 200, report.text)
            self.assertNotIn("Selected report description", pdf_text(report.content))
            revoked = self.call("PATCH", f"/dean/events/{key}/revoke", token="dean", json={"revocation_reason": "Approval withdrawn for correction"})
            self.assertEqual(revoked.status_code, 200, revoked.text)
            self.assertEqual(self.call("POST", f"/event-manager/events/{key}/report", json={}).status_code, 400)
            self.assertIsNone(self.reports.find_one({"event_id": key}))
