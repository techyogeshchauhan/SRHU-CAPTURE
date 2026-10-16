"""Bounded dashboards preserve counts, authorization and legacy timestamps."""
from datetime import timedelta
from unittest.mock import patch
from bson import ObjectId
from tests.test_event_manager import EventManagerTestCase, MANAGER, TEACHER
from tests.test_research import FakeCollection
from app.schemas.events import campus_now
from app.services.event_dashboard import dashboard_events


class DashboardPerformanceTests(EventManagerTestCase):
    def test_manager_summary_is_bounded_and_counts_the_entire_owned_set(self):
        for n in range(1200):
            self.events.insert_one({"event_name": f"Event {n}", "owner_id": MANAGER["id"],
                                    "status": ["draft", "recorded", "pending", "approved"][n % 4],
                                    "created_at": f"2026-10-{1 + n % 15:02d}T09:00:00Z"})
        self.events.insert_one({"owner_id": "someone-else", "status": "recorded"})
        body = self.call("GET", "/event-manager/events?dashboard=true").json()
        self.assertEqual(body["count"], 6)
        self.assertEqual(body["dashboard"], {"all": 1200, "draft": 300, "recorded": 300,
                                             "pending": 300, "approved": 300, "rejected": 0})
        self.assertTrue(body["has_more"])
        self.assertEqual(self.call("GET", "/event-manager/events?dashboard=true", "teacher").status_code, 403)
        self.assertEqual(self.call("GET", "/event-manager/events?limit=25").json()["count"], 25)

    def test_teacher_summary_keeps_archive_scope_and_status_buckets(self):
        rows = [{"_id": ObjectId(), "teacher_id": TEACHER["id"], "status": status,
                 "created_at": "2026-10-01T09:00:00Z"} for status in
                ["draft", "pending", "submitted", "under_review", "approved", "in_progress", "completed", "published", "rejected", "revoked"]]
        rows += [{"teacher_id": TEACHER["id"], "archived_at": "2026-10-02", "status": "approved"}]
        with patch("app.routers.events.events", FakeCollection(rows)), patch("app.routers.events.get_current_user", return_value=TEACHER):
            body = self.client.get("/teacher/events?dashboard=true").json()
        self.assertEqual(body["dashboard"], {"all": 10, "draft": 1, "pending": 3, "approved": 4, "rejected": 2, "recorded": 0})
        self.assertEqual(body["count"], 6)

    def test_recent_order_uses_updated_or_created_with_legacy_iso_dates(self):
        rows = [{"_id": ObjectId(), "owner_id": "x", "event_name": "Created recently", "status": "draft",
                 "created_at": "2026-10-12T09:00:00Z", "updated_at": ""},
                {"_id": ObjectId(), "owner_id": "x", "event_name": "Updated recently", "status": "approved",
                 "created_at": "2026-01-01T09:00:00Z", "updated_at": campus_now()},
                {"_id": ObjectId(), "owner_id": "x", "event_name": "Old", "status": "revoked",
                 "created_at": "2026-01-01T09:00:00Z"}]
        result = dashboard_events(FakeCollection(rows), {"owner_id": "x"})
        self.assertEqual([row["event_name"] for row in result["events"]], ["Updated recently", "Created recently", "Old"])
        self.assertTrue(all("_recent_at" not in row for row in result["events"]))
        self.assertEqual(dashboard_events(FakeCollection(), {"owner_id": "x"})["dashboard"]["all"], 0)

    def test_reminders_only_fetch_today_tomorrow_in_the_owners_active_scope(self):
        today = campus_now().date()
        rows = []
        for days, state, owner, archived in [(0, "pending", TEACHER["id"], None), (1, "approved", TEACHER["id"], None),
                                             (-1, "approved", TEACHER["id"], None), (2, "approved", TEACHER["id"], None),
                                             (0, "draft", TEACHER["id"], None), (0, "rejected", TEACHER["id"], None),
                                             (0, "approved", "other", None), (0, "approved", TEACHER["id"], "archived")]:
            rows.append({"_id": ObjectId(), "teacher_id": owner, "event_date": (today + timedelta(days=days)).isoformat(),
                         "status": state, "archived_at": archived, "event_name": f"Event {len(rows)}"})
        with patch("app.routers.events.events", FakeCollection(rows)), patch("app.routers.events.get_current_user", return_value=TEACHER):
            body = self.client.get("/teacher/events?reminders=true").json()
        self.assertEqual([row["event_name"] for row in body["events"]], ["Event 0", "Event 1"])
