import unittest
from bson import ObjectId
from fastapi.testclient import TestClient

from app.database import (
    event_reports,
    events,
    fs,
    managed_event_documents,
    managed_event_media,
    managed_events,
    users,
)
from app.main import app
from app.utils.security import create_access_token
from app.utils.serializers import utc_now


class FakeFS:
    def __init__(self, files=None):
        self.files = dict(files or {})

    def get(self, file_id):
        raw = self.files.get(str(file_id))
        if raw is None:
            raise KeyError(file_id)

        class Chunk:
            def read(self_chunk):
                return raw

        return Chunk()

    def delete(self, file_id):
        self.files.pop(str(file_id), None)


class TestEventManagerDeanVisibility(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.dean_user = {
            "_id": ObjectId(),
            "name": "Dr. Dean",
            "email": "dean.test@srhu.edu.in",
            "role": "dean",
            "is_active": True,
            "token_version": 0,
        }
        cls.manager_user = {
            "_id": ObjectId(),
            "name": "Event Specialist",
            "email": "events.test@srhu.edu.in",
            "role": "event_manager",
            "is_active": True,
            "token_version": 0,
        }
        cls.teacher_user = {
            "_id": ObjectId(),
            "name": "Prof. Sharma",
            "email": "sharma.test@srhu.edu.in",
            "role": "teacher",
            "is_active": True,
            "token_version": 0,
        }
        users.insert_many([cls.dean_user, cls.manager_user, cls.teacher_user])
        token_dean, _ = create_access_token(str(cls.dean_user["_id"]), "dean")
        cls.dean_token = token_dean
        token_mgr, _ = create_access_token(str(cls.manager_user["_id"]), "event_manager")
        cls.manager_token = token_mgr
        token_teacher, _ = create_access_token(str(cls.teacher_user["_id"]), "teacher")
        cls.teacher_token = token_teacher

    @classmethod
    def tearDownClass(cls):
        users.delete_many({"_id": {"$in": [cls.dean_user["_id"], cls.manager_user["_id"], cls.teacher_user["_id"]]}})

    def setUp(self):
        self.created_managed_ids = []
        self.created_event_ids = []

    def tearDown(self):
        if self.created_managed_ids:
            managed_events.delete_many({"_id": {"$in": self.created_managed_ids}})
            keys = [str(oid) for oid in self.created_managed_ids]
            managed_event_media.delete_many({"event_id": {"$in": keys}})
            managed_event_documents.delete_many({"event_id": {"$in": keys}})
            event_reports.delete_many({"event_id": {"$in": keys}})
        if self.created_event_ids:
            events.delete_many({"_id": {"$in": self.created_event_ids}})
            keys = [str(oid) for oid in self.created_event_ids]
            event_reports.delete_many({"event_id": {"$in": keys}})

    def test_dean_sees_event_manager_event_and_report(self):
        # 1. Event Manager creates a recorded event
        now = utc_now()
        event_id = ObjectId()
        self.created_managed_ids.append(event_id)

        managed_events.insert_one({
            "_id": event_id,
            "event_name": "Annual Convocation 2026",
            "event_type": "Academic",
            "event_date": "2026-11-10",
            "location": "Main Auditorium",
            "description": "Grand convocation ceremony",
            "status": "recorded",
            "owner_id": str(self.manager_user["_id"]),
            "owner_name": self.manager_user["name"],
            "owner_email": self.manager_user["email"],
            "created_at": now,
            "updated_at": now,
            "recorded_at": now,
            "social_network_url": None,
        })

        # Add media and document
        media_id = ObjectId()
        doc_id = ObjectId()
        file_storage_id = ObjectId()
        managed_event_media.insert_one({
            "_id": media_id,
            "event_id": str(event_id),
            "file_id": str(file_storage_id),
            "media_type": "image",
            "file_name": "stage.jpg",
            "original_name": "stage.jpg",
            "file_size": 1024,
            "content_type": "image/jpeg",
            "created_at": now,
        })
        managed_event_documents.insert_one({
            "_id": doc_id,
            "event_id": str(event_id),
            "file_id": str(file_storage_id),
            "file_name": "schedule.pdf",
            "original_name": "schedule.pdf",
            "file_size": 2048,
            "content_type": "application/pdf",
            "created_at": now,
        })

        # 2. Dean lists events: should see the event
        headers = {"Authorization": f"Bearer {self.dean_token}"}
        res = self.client.get("/dean/events", headers=headers)
        self.assertEqual(res.status_code, 200, res.text)
        data = res.json()
        ids = [ev["id"] for ev in data.get("events", [])]
        self.assertIn(str(event_id), ids)

        # Search by event name or owner name:
        res_search_title = self.client.get("/dean/events?q=Convocation", headers=headers)
        self.assertEqual(res_search_title.status_code, 200)
        self.assertIn(str(event_id), [ev["id"] for ev in res_search_title.json().get("events", [])])

        res_search_owner = self.client.get("/dean/events?q=Specialist", headers=headers)
        self.assertEqual(res_search_owner.status_code, 200)
        self.assertIn(str(event_id), [ev["id"] for ev in res_search_owner.json().get("events", [])])

        # In approved filter bucket:
        res_approved = self.client.get("/dean/events?status=approved", headers=headers)
        self.assertEqual(res_approved.status_code, 200)
        approved_ids = [ev["id"] for ev in res_approved.json().get("events", [])]
        self.assertIn(str(event_id), approved_ids)

        # 3. Dean dashboard stats include the recorded event in approved
        stats_res = self.client.get("/dean/dashboard/stats", headers=headers)
        self.assertEqual(stats_res.status_code, 200)
        self.assertGreater(stats_res.json()["approved_events"], 0)
        # Per-type counts come with the stats, adding up to the same total.
        by_type = stats_res.json()["event_types"]
        self.assertEqual(sum(by_type.values()), stats_res.json()["total_events"])

        # 4. Dean views single event details
        detail_res = self.client.get(f"/dean/events/{event_id}", headers=headers)
        self.assertEqual(detail_res.status_code, 200, detail_res.text)
        event_obj = detail_res.json()["event"]
        self.assertEqual(event_obj["event_name"], "Annual Convocation 2026")
        self.assertEqual(event_obj["status"], "recorded")
        self.assertEqual(event_obj["teacher_name"], "Event Specialist")

        # Dean can update social link on managed event
        social_res = self.client.patch(
            f"/dean/events/{event_id}/social-link",
            headers=headers,
            json={"social_network_url": "https://instagram.com/convocation2026"},
        )
        self.assertEqual(social_res.status_code, 200)

        # 5. Dean views media & documents
        media_res = self.client.get(f"/dean/events/{event_id}/media", headers=headers)
        self.assertEqual(media_res.status_code, 200)
        self.assertEqual(len(media_res.json()["media"]), 1)

        doc_res = self.client.get(f"/dean/events/{event_id}/documents", headers=headers)
        self.assertEqual(doc_res.status_code, 200)
        self.assertEqual(len(doc_res.json()["documents"]), 1)

        # 6. Dean views report status initially (before report generation)
        status_res = self.client.get(f"/dean/events/{event_id}/report-status", headers=headers)
        self.assertEqual(status_res.status_code, 200)
        self.assertFalse(status_res.json()["report_generated"])

        # 7. Event manager generates report
        mgr_headers = {"Authorization": f"Bearer {self.manager_token}"}
        report_gen_res = self.client.get(f"/event-manager/events/{event_id}/report", headers=mgr_headers)
        self.assertEqual(report_gen_res.status_code, 200)
        self.assertTrue(report_gen_res.content.startswith(b"%PDF"))

        # 8. Dean views report status after generation: should be True
        status_after = self.client.get(f"/dean/events/{event_id}/report-status", headers=headers)
        self.assertEqual(status_after.status_code, 200)
        self.assertTrue(status_after.json()["report_generated"])
        self.assertIsNotNone(status_after.json()["generated_at"])

        # 9. Dean downloads report
        dean_dl = self.client.get(f"/dean/events/{event_id}/report/download", headers=headers)
        self.assertEqual(dean_dl.status_code, 200)
        self.assertEqual(dean_dl.headers["content-type"], "application/pdf")
        self.assertTrue(dean_dl.content.startswith(b"%PDF"))

        # 10. Dean can also generate/regenerate report
        gen_res = self.client.post(f"/dean/events/{event_id}/generate-report", headers=headers)
        self.assertEqual(gen_res.status_code, 200)
        self.assertTrue(gen_res.json()["success"])

        # 11. Dean can archive the managed event
        archive_res = self.client.patch(
            f"/dean/events/{event_id}/archive",
            headers=headers,
            json={"remarks": "Shelving event"},
        )
        self.assertEqual(archive_res.status_code, 200)
        archived_doc = managed_events.find_one({"_id": event_id})
        self.assertIsNotNone(archived_doc.get("archived_at"))

        # 12. Dean can restore the managed event
        restore_res = self.client.patch(f"/dean/events/{event_id}/restore", headers=headers)
        self.assertEqual(restore_res.status_code, 200)
        restored_doc = managed_events.find_one({"_id": event_id})
        self.assertIsNone(restored_doc.get("archived_at"))

        # 13. Dean can delete the managed event permanently
        del_res = self.client.delete(f"/dean/events/{event_id}", headers=headers)
        self.assertEqual(del_res.status_code, 200)
        self.assertEqual(del_res.json()["message"], "Event deleted permanently")
        self.assertIsNone(managed_events.find_one({"_id": event_id}))
        self.assertEqual(managed_event_media.count_documents({"event_id": str(event_id)}), 0)
        self.assertEqual(managed_event_documents.count_documents({"event_id": str(event_id)}), 0)
        self.assertEqual(event_reports.count_documents({"event_id": str(event_id)}), 0)

    def test_dean_bulk_delete_managed_events(self):
        now = utc_now()
        event_id1 = ObjectId()
        event_id2 = ObjectId()
        self.created_managed_ids.extend([event_id1, event_id2])

        managed_events.insert_many([
            {
                "_id": event_id1,
                "event_name": "Bulk Event 1",
                "event_type": "Workshop",
                "event_date": "2026-11-11",
                "location": "Auditorium",
                "status": "recorded",
                "owner_id": str(self.manager_user["_id"]),
                "owner_name": self.manager_user["name"],
                "owner_email": self.manager_user["email"],
                "created_at": now,
                "updated_at": now,
            },
            {
                "_id": event_id2,
                "event_name": "Bulk Event 2",
                "event_type": "Workshop",
                "event_date": "2026-11-12",
                "location": "Auditorium",
                "status": "recorded",
                "owner_id": str(self.manager_user["_id"]),
                "owner_name": self.manager_user["name"],
                "owner_email": self.manager_user["email"],
                "created_at": now,
                "updated_at": now,
            },
        ])

        headers = {"Authorization": f"Bearer {self.dean_token}"}
        res = self.client.post(
            "/dean/events/bulk-delete",
            headers=headers,
            json={"event_ids": [str(event_id1), str(event_id2)]},
        )
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["deleted_count"], 2)
        self.assertIsNone(managed_events.find_one({"_id": event_id1}))
        self.assertIsNone(managed_events.find_one({"_id": event_id2}))

    def test_dean_deletes_teacher_event(self):
        now = utc_now()
        t_id = ObjectId()
        self.created_event_ids.append(t_id)

        events.insert_one({
            "_id": t_id,
            "event_name": "Teacher Physics Workshop",
            "event_type": "Workshop",
            "event_date": "2026-11-15",
            "location": "Physics Lab",
            "status": "approved",
            "teacher_id": str(self.teacher_user["_id"]),
            "teacher_name": self.teacher_user["name"],
            "teacher_email": self.teacher_user["email"],
            "created_at": now,
            "updated_at": now,
        })

        headers = {"Authorization": f"Bearer {self.dean_token}"}
        del_res = self.client.delete(f"/dean/events/{t_id}", headers=headers)
        self.assertEqual(del_res.status_code, 200, del_res.text)
        self.assertEqual(del_res.json()["message"], "Event deleted permanently")
        self.assertIsNone(events.find_one({"_id": t_id}))

    def test_dean_bulk_delete_mixed_teacher_and_managed_events(self):
        now = utc_now()
        t_id = ObjectId()
        m_id = ObjectId()
        self.created_event_ids.append(t_id)
        self.created_managed_ids.append(m_id)

        events.insert_one({
            "_id": t_id,
            "event_name": "Teacher Chemistry Seminar",
            "event_type": "Seminar",
            "event_date": "2026-11-20",
            "location": "Auditorium",
            "status": "submitted",
            "teacher_id": str(self.teacher_user["_id"]),
            "created_at": now,
            "updated_at": now,
        })
        managed_events.insert_one({
            "_id": m_id,
            "event_name": "Manager Sports Meet",
            "event_type": "Sports",
            "event_date": "2026-11-21",
            "location": "Sports Ground",
            "status": "recorded",
            "owner_id": str(self.manager_user["_id"]),
            "created_at": now,
            "updated_at": now,
        })

        headers = {"Authorization": f"Bearer {self.dean_token}"}
        res = self.client.post(
            "/dean/events/bulk-delete",
            headers=headers,
            json={"event_ids": [str(t_id), str(m_id)]},
        )
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["deleted_count"], 2)
        self.assertIsNone(events.find_one({"_id": t_id}))
        self.assertIsNone(managed_events.find_one({"_id": m_id}))

    def test_teacher_event_management_preserved(self):
        # Teacher creates draft event
        now = utc_now()
        draft_id = ObjectId()
        self.created_event_ids.append(draft_id)

        events.insert_one({
            "_id": draft_id,
            "event_name": "Teacher Draft Event",
            "event_type": "Workshop",
            "event_date": "2026-11-25",
            "status": "draft",
            "teacher_id": str(self.teacher_user["_id"]),
            "created_at": now,
            "updated_at": now,
        })

        # Draft event is NOT visible or deletable by Dean
        dean_headers = {"Authorization": f"Bearer {self.dean_token}"}
        dean_del_draft = self.client.delete(f"/dean/events/{draft_id}", headers=dean_headers)
        self.assertEqual(dean_del_draft.status_code, 404)

        # Teacher can delete own editable draft event
        teacher_headers = {"Authorization": f"Bearer {self.teacher_token}"}
        teacher_del = self.client.delete(f"/teacher/events/{draft_id}", headers=teacher_headers)
        self.assertEqual(teacher_del.status_code, 200)
        self.assertIsNone(events.find_one({"_id": draft_id}))

    def test_event_manager_event_management_preserved(self):
        # Event Manager creates event
        now = utc_now()
        m_id = ObjectId()
        self.created_managed_ids.append(m_id)

        managed_events.insert_one({
            "_id": m_id,
            "event_name": "Manager Own Event",
            "event_type": "Workshop",
            "event_date": "2026-11-30",
            "status": "draft",
            "owner_id": str(self.manager_user["_id"]),
            "created_at": now,
            "updated_at": now,
        })

        # Event Manager can delete own event
        mgr_headers = {"Authorization": f"Bearer {self.manager_token}"}
        mgr_del = self.client.delete(f"/event-manager/events/{m_id}", headers=mgr_headers)
        self.assertEqual(mgr_del.status_code, 200)
        self.assertIsNone(managed_events.find_one({"_id": m_id}))

    def test_archived_event_manager_event_is_on_the_shelf_and_restorable(self):
        # Archiving hides the event from the live list, so the shelf is the
        # only way back to it -- single and bulk archive alike.
        now = utc_now()
        m_id, t_id = ObjectId(), ObjectId()
        self.created_managed_ids.append(m_id)
        self.created_event_ids.append(t_id)
        managed_events.insert_one({
            "_id": m_id, "event_name": "Shelved Seminar", "event_type": "Seminar",
            "event_date": "2026-09-01", "status": "recorded",
            "owner_id": str(self.manager_user["_id"]), "owner_name": self.manager_user["name"],
            "created_at": now, "updated_at": now, "recorded_at": now,
        })
        events.insert_one({
            "_id": t_id, "event_name": "Shelved Talk", "event_type": "Seminar",
            "event_date": "2026-09-01", "status": "approved",
            "teacher_id": str(self.teacher_user["_id"]),
            "created_at": now, "updated_at": now, "submitted_at": now,
        })
        headers = {"Authorization": f"Bearer {self.dean_token}"}

        def shelf_ids():
            response = self.client.get("/dean/archive/events", headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            return {row["id"] for row in response.json()["events"]}

        self.assertEqual(self.client.patch(f"/dean/events/{m_id}/archive", headers=headers).status_code, 200)
        self.assertIn(str(m_id), shelf_ids())
        live = self.client.get("/dean/events", headers=headers).json()["events"]
        self.assertNotIn(str(m_id), {row["id"] for row in live})

        self.assertEqual(self.client.patch(f"/dean/events/{m_id}/restore", headers=headers).status_code, 200)
        self.assertNotIn(str(m_id), shelf_ids())

        response = self.client.post(
            "/dean/events/bulk-archive", json={"event_ids": [str(m_id), str(t_id)]}, headers=headers
        )
        self.assertEqual(response.json()["archived_count"], 2, response.text)
        shelf = self.client.get("/dean/archive/events", headers=headers).json()
        self.assertTrue({str(m_id), str(t_id)} <= {row["id"] for row in shelf["events"]})
        self.assertGreaterEqual(shelf["total"], 2)
        by_id = {row["id"]: row for row in shelf["events"]}
        self.assertEqual(by_id[str(m_id)]["teacher_name"], self.manager_user["name"])

    def test_dean_sees_who_each_event_came_from_and_can_filter_by_it(self):
        now = utc_now()
        t_id, m_id = ObjectId(), ObjectId()
        self.created_event_ids.append(t_id)
        self.created_managed_ids.append(m_id)
        events.insert_one({
            "_id": t_id, "event_name": "Source Teacher Talk", "event_type": "Seminar",
            "event_date": "2026-09-01", "status": "pending", "teacher_id": str(self.teacher_user["_id"]),
            "created_at": now, "submitted_at": now,
        })
        managed_events.insert_one({
            "_id": m_id, "event_name": "Source Manager Seminar", "event_type": "Seminar",
            "event_date": "2026-09-02", "status": "recorded", "owner_id": str(self.manager_user["_id"]),
            "owner_name": self.manager_user["name"], "created_at": now, "recorded_at": now,
        })
        headers = {"Authorization": f"Bearer {self.dean_token}"}

        def listed(query=""):
            response = self.client.get(f"/dean/events{query}", headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            return {row["id"]: row for row in response.json()["events"]}, response.json()

        rows, _ = listed()
        self.assertEqual(rows[str(t_id)]["submitted_by_role"], "teacher")
        self.assertEqual(rows[str(t_id)]["teacher_name"], self.teacher_user["name"])
        self.assertEqual(rows[str(m_id)]["submitted_by_role"], "event_manager")
        self.assertEqual(rows[str(m_id)]["teacher_name"], self.manager_user["name"])

        rows, body = listed("?source=teacher")
        self.assertIn(str(t_id), rows)
        self.assertNotIn(str(m_id), rows)
        self.assertEqual(body["counts"]["all"], body["total"])
        rows, body = listed("?source=event_manager")
        self.assertIn(str(m_id), rows)
        self.assertNotIn(str(t_id), rows)
        self.assertTrue(all(row["submitted_by_role"] == "event_manager" for row in rows.values()))

        self.assertEqual(self.client.get("/dean/events?source=robots", headers=headers).status_code, 400)

        ids = self.client.get("/dean/events/ids?source=event_manager", headers=headers).json()["events"]
        self.assertIn(str(m_id), {row["id"] for row in ids})
        self.assertNotIn(str(t_id), {row["id"] for row in ids})

        detail = self.client.get(f"/dean/events/{m_id}", headers=headers).json()["event"]
        self.assertEqual(detail["submitted_by_role"], "event_manager")
        detail = self.client.get(f"/dean/events/{t_id}", headers=headers).json()["event"]
        self.assertEqual(detail["submitted_by_role"], "teacher")
