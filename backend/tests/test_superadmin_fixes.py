"""Super Admin behaviour that used to be wrong: the export's filters, deleting
accounts that own events, the CSV roster, clearing a phone number, and a Dean
deciding on an event they submitted themselves."""

import csv
import io
import unittest

from bson import ObjectId
from fastapi.testclient import TestClient

from app.database import events, managed_events, users
from app.main import app
from app.utils.security import create_access_token
from app.utils.serializers import utc_now


def _user(role: str, name: str) -> dict:
    return {
        "_id": ObjectId(), "name": name, "email": f"{role}-{ObjectId()}@srhu.edu.in",
        "role": role, "is_active": True, "email_verified": True, "token_version": 0,
    }


class SuperAdminFixesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.superadmin = _user("superadmin", "Root")
        self.dean = _user("dean", "Dean Rao")
        self.teacher = _user("teacher", "Asha Teacher")
        self.manager = _user("event_manager", "Eva Manager")
        self.people = [self.superadmin, self.dean, self.teacher, self.manager]
        users.insert_many(self.people)
        self.event_ids: list[ObjectId] = []
        self.managed_ids: list[ObjectId] = []

    def tearDown(self) -> None:
        users.delete_many({"_id": {"$in": [p["_id"] for p in self.people]}})
        users.delete_many({"email": {"$regex": "^roster-"}})
        events.delete_many({"_id": {"$in": self.event_ids}})
        managed_events.delete_many({"_id": {"$in": self.managed_ids}})

    def auth(self, person: dict) -> dict:
        token, _ = create_access_token(str(person["_id"]), person["role"])
        return {"Authorization": f"Bearer {token}"}

    def event(self, name: str, status: str, **fields) -> str:
        oid = ObjectId()
        now = utc_now()
        events.insert_one({
            "_id": oid, "event_name": name, "event_type": "Seminar", "event_date": "2026-09-10",
            "location": "Hall", "status": status, "teacher_id": str(self.teacher["_id"]),
            "description": "Talk.\n\n<!--CC_METADATA:{\"department\":\"SST\"}-->",
            "created_at": now, "submitted_at": now, **fields,
        })
        self.event_ids.append(oid)
        return str(oid)

    def managed(self, name: str) -> str:
        oid = ObjectId()
        managed_events.insert_one({
            "_id": oid, "event_name": name, "event_type": "Seminar", "event_date": "2026-09-11",
            "location": "Hall", "status": "recorded", "owner_id": str(self.manager["_id"]),
            "owner_name": self.manager["name"], "created_at": utc_now(),
        })
        self.managed_ids.append(oid)
        return str(oid)

    def export(self, **params) -> list[list[str]]:
        response = self.client.get("/superadmin/events/export", params=params, headers=self.auth(self.superadmin))
        self.assertEqual(response.status_code, 200, response.text)
        return list(csv.reader(io.StringIO(response.text)))[1:]

    def test_export_matches_the_events_page(self) -> None:
        self.event("Zeta Completed Talk", "completed")
        self.event("Zeta Pending Talk", "submitted")
        self.event("Zeta Revoked Talk", "revoked")
        self.event("Zeta Draft Talk", "draft")
        self.event("Zeta Archived Talk", "approved", archived_at=utc_now())
        self.managed("Zeta Recorded Seminar")

        names = lambda rows: {row[1] for row in rows if row[1].startswith("Zeta")}  # noqa: E731
        self.assertEqual(
            names(self.export(status="approved")), {"Zeta Completed Talk", "Zeta Recorded Seminar"}
        )  # the tab's group, Event Manager events included
        self.assertEqual(names(self.export(status="pending")), {"Zeta Pending Talk"})
        self.assertEqual(names(self.export(status="rejected")), {"Zeta Revoked Talk"})
        self.assertEqual(names(self.export(q="Recorded Seminar")), {"Zeta Recorded Seminar"})
        self.assertNotIn("Zeta Draft Talk", names(self.export()))
        self.assertEqual(names(self.export(status="draft")), set())
        self.assertIn("Zeta Archived Talk", names(self.export(include_archived="true")))
        # The description is the teacher's text, without the form's metadata.
        row = next(r for r in self.export(q="Completed") if r[1] == "Zeta Completed Talk")
        self.assertEqual(row[-1], "Talk.")

    def test_accounts_with_events_cannot_be_deleted(self) -> None:
        self.event("Kept", "approved")
        self.managed("Kept Too")
        for person in (self.teacher, self.manager):
            response = self.client.delete(f"/superadmin/users/{person['_id']}", headers=self.auth(self.superadmin))
            self.assertEqual(response.status_code, 409, response.text)
            self.assertIn("Deactivate", response.json()["detail"])
            self.assertIsNotNone(users.find_one({"_id": person["_id"]}))
        self.assertEqual(events.count_documents({"_id": {"$in": self.event_ids}}), 1)

        response = self.client.delete(f"/superadmin/users/{self.dean['_id']}", headers=self.auth(self.superadmin))
        self.assertEqual(response.status_code, 200, response.text)

    def test_csv_roster_reports_bad_rows_instead_of_failing(self) -> None:
        roster = "Faculty,Mail ID\nRoster Good,roster-good@srhu.edu.in\nRoster Bad,not-an-email\n"
        response = self.client.post(
            "/superadmin/teachers/bulk-onboard-file",
            files={"file": ("roster.csv", roster, "text/csv")},
            data={"send_email": "false"},
            headers=self.auth(self.superadmin),
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["created_count"], 1)
        self.assertTrue(any(s.get("email") == "not-an-email" for s in body["skipped"]))

        too_many = "name,email\n" + "\n".join(f"R{i},roster-{i}@srhu.edu.in" for i in range(501))
        response = self.client.post(
            "/superadmin/teachers/bulk-onboard-file",
            files={"file": ("big.csv", too_many, "text/csv")},
            data={"send_email": "false"},
            headers=self.auth(self.superadmin),
        )
        self.assertEqual(response.status_code, 400, response.text)

    def test_a_phone_number_can_be_cleared(self) -> None:
        path = f"/superadmin/users/{self.teacher['_id']}/profile"
        self.client.patch(path, json={"phone": "9876543210"}, headers=self.auth(self.superadmin))
        response = self.client.patch(path, json={"phone": None}, headers=self.auth(self.superadmin))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(users.find_one({"_id": self.teacher["_id"]}).get("phone"))
        # A request that does not mention the phone leaves it alone.
        self.client.patch(path, json={"phone": "9876543210"}, headers=self.auth(self.superadmin))
        self.client.patch(path, json={"name": "Asha T"}, headers=self.auth(self.superadmin))
        self.assertEqual(users.find_one({"_id": self.teacher["_id"]}).get("phone"), "9876543210")

    def test_a_dean_never_decides_on_their_own_event(self) -> None:
        own = self.event("Own Talk", "pending")
        promoted = {**self.teacher, "role": "dean"}
        users.update_one({"_id": self.teacher["_id"]}, {"$set": {"role": "dean"}})
        for method, path in (
            ("patch", f"/dean/events/{own}/approve"),
            ("patch", f"/dean/events/{own}/reject?rejection_reason=x"),
        ):
            response = getattr(self.client, method)(path, headers=self.auth(promoted))
            self.assertEqual(response.status_code, 403, response.text)
        response = self.client.patch(f"/dean/events/{own}/approve", headers=self.auth(self.dean))
        self.assertEqual(response.status_code, 200, response.text)
        response = self.client.patch(f"/dean/events/{own}/stage?stage=completed", headers=self.auth(promoted))
        self.assertEqual(response.status_code, 403, response.text)

    def test_the_events_page_downloads_as_excel(self) -> None:
        from openpyxl import load_workbook

        self.event("Xeno Completed Talk", "completed")
        self.event("Xeno Pending Talk", "submitted")
        self.managed("Xeno Recorded Seminar")
        response = self.client.get(
            "/superadmin/events/export.xlsx", params={"status": "approved", "q": "Xeno"}, headers=self.auth(self.superadmin)
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn(".xlsx", response.headers["content-disposition"])
        sheet = load_workbook(io.BytesIO(response.content)).active
        names = {row[1].value for row in sheet.iter_rows(min_row=5)}
        self.assertEqual(names, {"Xeno Completed Talk", "Xeno Recorded Seminar"})

        dean = self.client.get("/dean/events/export.xlsx", params={"q": "Xeno", "status_bucket": "pending"},
                               headers=self.auth(self.dean))
        self.assertEqual(dean.status_code, 200, dean.text)
        sheet = load_workbook(io.BytesIO(dean.content)).active
        self.assertEqual([row[0].value for row in sheet.iter_rows(min_row=5)], ["Xeno Pending Talk"])
        self.assertEqual(sheet["M5"].value, "Asha Teacher")


if __name__ == "__main__":
    unittest.main()
