import io
import unittest
from bson import ObjectId
from fastapi.testclient import TestClient

from app.database import (
    event_reports,
    fs,
    managed_event_documents,
    managed_event_media,
    managed_events,
    notifications,
    users,
)
from app.main import app
from app.utils.security import create_access_token
from app.utils.serializers import utc_now


PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc\xf8\xff\x9f"
    b"\x01\x01\x04\x00\x00\xff\xff\x02\x04\x01\x0b\xeb\x15\xad\x00\x00\x00\x00IEND\xaeB`\x82"
)
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


class TestEventManagerApprovalWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.dean_user = {
            "_id": ObjectId(),
            "name": "Dr. Dean",
            "email": "dean.workflow@srhu.edu.in",
            "role": "dean",
            "is_active": True,
            "token_version": 0,
        }
        cls.manager_user = {
            "_id": ObjectId(),
            "name": "Event Specialist",
            "email": "manager.workflow@srhu.edu.in",
            "role": "event_manager",
            "is_active": True,
            "token_version": 0,
        }
        users.insert_many([cls.dean_user, cls.manager_user])
        cls.dean_token, _ = create_access_token(str(cls.dean_user["_id"]), "dean")
        cls.manager_token, _ = create_access_token(str(cls.manager_user["_id"]), "event_manager")

    @classmethod
    def tearDownClass(cls):
        users.delete_many({"_id": {"$in": [cls.dean_user["_id"], cls.manager_user["_id"]]}})

    def setUp(self):
        self.created_managed_ids = []
        self.dean_headers = {"Authorization": f"Bearer {self.dean_token}"}
        self.manager_headers = {"Authorization": f"Bearer {self.manager_token}"}

    def tearDown(self):
        if self.created_managed_ids:
            managed_events.delete_many({"_id": {"$in": self.created_managed_ids}})
            keys = [str(oid) for oid in self.created_managed_ids]
            managed_event_media.delete_many({"event_id": {"$in": keys}})
            managed_event_documents.delete_many({"event_id": {"$in": keys}})
            event_reports.delete_many({"event_id": {"$in": keys}})
            notifications.delete_many({"event_id": {"$in": keys}})

    def test_complete_approval_rejection_correction_workflow(self):
        """End-to-end verification of the full workflow:
        1. Manager creates draft and attaches evidence
        2. Manager submits for Dean approval -> status moves to pending
        3. Dean views pending queue -> event appears with Approve and Reject options
        4. Dean rejects with remark -> remark saved and notified
        5. Manager sees rejection remark and edits to correct issues
        6. Manager resubmits -> status returns to pending and appears in Dean queue
        7. Dean approves -> status updates to approved and editing is locked
        """
        # Step 1: Create draft
        draft_payload = {
            "event_name": "Annual Robotics Symposium",
            "event_date": "2026-10-10",
            "event_type": "Workshop",
            "location": "Auditorium Hall",
            "description": "Initial robotics symposium details.",
            "organizer": "Robotics Club",
            "save_as_draft": True,
        }
        res_create = self.client.post("/event-manager/events", json=draft_payload, headers=self.manager_headers)
        self.assertEqual(res_create.status_code, 201)
        event_id = res_create.json()["event"]["id"]
        self.created_managed_ids.append(ObjectId(event_id))
        self.assertEqual(res_create.json()["event"]["status"], "draft")

        # Attach photo and document required before submitting
        res_photo = self.client.post(
            f"/event-manager/events/{event_id}/media",
            headers=self.manager_headers,
            files={"file": ("symposium.png", PNG, "image/png")},
        )
        self.assertEqual(res_photo.status_code, 201)

        res_doc = self.client.post(
            f"/event-manager/events/{event_id}/documents",
            headers=self.manager_headers,
            files={"file": ("schedule.pdf", PDF, "application/pdf")},
            data={"category": "notice"},
        )
        self.assertEqual(res_doc.status_code, 201)

        # Step 2: Submit for Dean approval
        submit_payload = {
            **draft_payload,
            "save_as_draft": False,
        }
        res_submit = self.client.patch(
            f"/event-manager/events/{event_id}",
            json=submit_payload,
            headers=self.manager_headers,
        )
        self.assertEqual(res_submit.status_code, 200)
        submitted_event = res_submit.json()["event"]
        self.assertEqual(submitted_event["status"], "pending")
        self.assertEqual(submitted_event["history"][-1]["action"], "submitted")

        # Step 3: Dean views pending review list
        res_dean_pending = self.client.get("/dean/events?status_bucket=pending", headers=self.dean_headers)
        self.assertEqual(res_dean_pending.status_code, 200)
        pending_ids = [ev["id"] for ev in res_dean_pending.json()["events"]]
        self.assertIn(event_id, pending_ids)

        # Step 4: Dean attempts to reject without remark -> required error
        res_reject_empty = self.client.patch(
            f"/dean/events/{event_id}/reject",
            json={"rejection_reason": "   "},
            headers=self.dean_headers,
        )
        self.assertEqual(res_reject_empty.status_code, 400)
        self.assertIn("Rejection reason is required", res_reject_empty.json()["detail"])

        # Dean rejects with remark explaining reason
        rejection_remark = "Please clarify the schedule details and venue capacity."
        res_reject = self.client.patch(
            f"/dean/events/{event_id}/reject",
            json={"rejection_reason": rejection_remark},
            headers=self.dean_headers,
        )
        self.assertEqual(res_reject.status_code, 200)
        rejected_event = res_reject.json()["event"]
        self.assertEqual(rejected_event["status"], "rejected")
        self.assertEqual(rejected_event["rejection_reason"], rejection_remark)

        # Step 5: Event Manager views rejected event and sees rejection remark
        res_mgr_get = self.client.get(f"/event-manager/events/{event_id}", headers=self.manager_headers)
        self.assertEqual(res_mgr_get.status_code, 200)
        mgr_view = res_mgr_get.json()["event"]
        self.assertEqual(mgr_view["status"], "rejected")
        self.assertEqual(mgr_view["rejection_reason"], rejection_remark)

        # Event Manager edits the event to correct issues and resubmits
        corrected_payload = {
            **draft_payload,
            "description": "Updated details: Schedule finalized 10am-4pm, capacity 250 seats.",
            "location": "Auditorium Hall (250 Capacity)",
            "save_as_draft": False,
        }
        res_resubmit = self.client.patch(
            f"/event-manager/events/{event_id}",
            json=corrected_payload,
            headers=self.manager_headers,
        )
        self.assertEqual(res_resubmit.status_code, 200)
        resubmitted_event = res_resubmit.json()["event"]
        self.assertEqual(resubmitted_event["status"], "pending")
        self.assertIsNone(resubmitted_event.get("rejection_reason"))
        self.assertEqual(resubmitted_event["history"][-1]["action"], "resubmitted")
        self.assertEqual(resubmitted_event["history"][-1]["from_status"], "rejected")

        # Step 6: Event returns to Dean's pending approval list
        res_dean_pending_again = self.client.get("/dean/events?status_bucket=pending", headers=self.dean_headers)
        self.assertEqual(res_dean_pending_again.status_code, 200)
        pending_ids_again = [ev["id"] for ev in res_dean_pending_again.json()["events"]]
        self.assertIn(event_id, pending_ids_again)

        # Step 7: Dean approves the event
        res_approve = self.client.patch(f"/dean/events/{event_id}/approve", headers=self.dean_headers)
        self.assertEqual(res_approve.status_code, 200)
        approved_event = res_approve.json()["event"]
        self.assertEqual(approved_event["status"], "approved")
        self.assertEqual(approved_event["history"][-1]["action"], "approved")

        # Verify event is in Dean's approved list
        res_dean_approved = self.client.get("/dean/events?status_bucket=approved", headers=self.dean_headers)
        self.assertEqual(res_dean_approved.status_code, 200)
        approved_ids = [ev["id"] for ev in res_dean_approved.json()["events"]]
        self.assertIn(event_id, approved_ids)

        # Verify editing is now locked for the approved event
        res_edit_locked = self.client.patch(
            f"/event-manager/events/{event_id}",
            json={**corrected_payload, "event_name": "Should Not Allow Editing"},
            headers=self.manager_headers,
        )
        self.assertEqual(res_edit_locked.status_code, 400)
        self.assertIn("approved", res_edit_locked.json()["detail"].lower())

        # Verify report can be generated for approved event
        res_report = self.client.get(f"/event-manager/events/{event_id}/report", headers=self.manager_headers)
        self.assertEqual(res_report.status_code, 200)
        self.assertEqual(res_report.headers["content-type"], "application/pdf")


if __name__ == "__main__":
    unittest.main()
