from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock, patch

from bson import ObjectId
from fastapi.testclient import TestClient

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from app.main import app

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
    "phone": "9876543210",
    "department": "Computer Science",
    "is_active": True,
}


class SuperAdminFeaturesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_toggle_user_active(self) -> None:
        user_id = str(ObjectId())
        target_user = {
            "_id": ObjectId(user_id),
            "id": user_id,
            "name": "Prof Smith",
            "email": "smith@srhu.edu.in",
            "role": "teacher",
            "is_active": True,
            "token_version": 0,
        }

        with patch("app.utils.auth.get_current_user", return_value=SUPERADMIN), \
             patch("app.routers.superadmin.users.find_one", return_value=target_user), \
             patch("app.routers.superadmin.users.find_one_and_update", return_value={**target_user, "is_active": False, "token_version": 1}), \
             patch("app.services.audit_service.audit_logs.insert_one") as mock_audit:
            response = self.client.patch(
                f"/superadmin/users/{user_id}/toggle-active",
                headers={"Authorization": "Bearer token"},
            )
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertTrue(data["success"])
            self.assertFalse(data["user"]["is_active"])
            mock_audit.assert_called_once()

    def test_update_user_profile(self) -> None:
        user_id = str(ObjectId())
        target_user = {
            "_id": ObjectId(user_id),
            "id": user_id,
            "name": "Prof Smith",
            "email": "smith@srhu.edu.in",
            "role": "teacher",
            "phone": "9876543210",
            "department": "CSE",
        }

        with patch("app.utils.auth.get_current_user", return_value=SUPERADMIN), \
             patch("app.routers.superadmin.users.find_one", return_value=target_user), \
             patch("app.routers.superadmin.users.find_one_and_update", return_value={**target_user, "name": "Dr. Smith", "department": "Data Science"}), \
             patch("app.services.audit_service.audit_logs.insert_one"):
            response = self.client.patch(
                f"/superadmin/users/{user_id}/profile",
                json={"name": "Dr. Smith", "department": "Data Science"},
                headers={"Authorization": "Bearer token"},
            )
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertTrue(data["success"])
            self.assertEqual(data["user"]["name"], "Dr. Smith")

    def test_reset_user_password(self) -> None:
        user_id = str(ObjectId())
        target_user = {
            "_id": ObjectId(user_id),
            "id": user_id,
            "name": "Prof Smith",
            "email": "smith@srhu.edu.in",
            "role": "teacher",
        }

        # The send is patched out: with a real SMTP .env present this test
        # otherwise mails a credentials email to the address above.
        with patch("app.utils.auth.get_current_user", return_value=SUPERADMIN), \
             patch("app.routers.superadmin.users.find_one", return_value=target_user), \
             patch("app.routers.superadmin.users.update_one") as mock_update, \
             patch("app.services.email_service.send_teacher_credentials_email"), \
             patch("app.services.audit_service.audit_logs.insert_one"):
            response = self.client.post(
                f"/superadmin/users/{user_id}/reset-password",
                json={},
                headers={"Authorization": "Bearer token"},
            )
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertTrue(data["success"])
            self.assertIn("temporary_password", data)
            mock_update.assert_called_once()

    def test_audit_logs_listing(self) -> None:
        log_doc = {
            "_id": ObjectId(),
            "actor_id": str(ObjectId()),
            "actor_name": "Super Admin",
            "actor_email": "superadmin@srhu.edu.in",
            "action": "role_change",
            "target_type": "user",
            "details": {"old_role": "teacher", "new_role": "dean"},
            "created_at": "2026-09-19T10:00:00Z",
        }

        with patch("app.utils.auth.get_current_user", return_value=SUPERADMIN), \
             patch("app.routers.superadmin.audit_logs.find") as mock_find, \
             patch("app.routers.superadmin._safe_count", return_value=1):
            mock_find.return_value.sort.return_value = [log_doc]
            response = self.client.get(
                "/superadmin/audit-logs",
                headers={"Authorization": "Bearer token"},
            )
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertTrue(data["success"])
            self.assertEqual(len(data["logs"]), 1)

    def test_events_export_csv(self) -> None:
        event_doc = {
            "_id": ObjectId(),
            "event_name": "AI Workshop",
            "event_type": "Workshop",
            "status": "approved",
            "event_date": "2026-09-20",
            "location": "Auditorium",
            "teacher_id": str(ObjectId()),
        }

        with patch("app.utils.auth.get_current_user", return_value=SUPERADMIN), \
             patch("app.routers.superadmin.events.find") as mock_find, \
             patch("app.routers.superadmin.users.find", return_value=[]), \
             patch("app.services.audit_service.audit_logs.insert_one"):
            mock_find.return_value.sort.return_value = [event_doc]
            response = self.client.get(
                "/superadmin/events/export",
                headers={"Authorization": "Bearer token"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "text/csv; charset=utf-8")
            self.assertIn("AI Workshop", response.text)
            self.assertIn("Event ID,Event Name", response.text)

    def test_dashboard_analytics(self) -> None:
        with patch("app.utils.auth.get_current_user", return_value=SUPERADMIN), \
             patch("app.routers.superadmin.events.count_documents", return_value=10), \
             patch("app.routers.superadmin.users.count_documents", return_value=5), \
             patch("app.routers.superadmin.event_media.count_documents", return_value=20), \
             patch("app.routers.superadmin.events.aggregate", return_value=[]), \
             patch("app.routers.superadmin.users.find", return_value=[]), \
             patch("app.routers.superadmin.events.find", return_value=[]):
            response = self.client.get(
                "/superadmin/dashboard/analytics",
                headers={"Authorization": "Bearer token"},
            )
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertTrue(data["success"])
            self.assertEqual(data["kpis"]["total_events"], 10)
            self.assertIn("monthly_trends", data)
            self.assertIn("category_distribution", data)
