"""Manager organizer persistence, validation, ownership, bulk flow and PDFs."""
from bson import ObjectId

from tests.test_event_manager import EventManagerTestCase, EVENT, pdf_text


class EventOrganizerTests(EventManagerTestCase):
    def test_single_legacy_request_is_compatible(self):
        event = self.draft()
        self.assertEqual(event["organizers"], [EVENT["organizer"]])
        self.assertEqual(event["organizer"], EVENT["organizer"])

    def test_create_normalizes_names_and_uses_array_as_authority(self):
        event = self.draft(organizers=[" Dr. Rao ", "Dr. Verma", "dr. rao"], organizer="Ignored name")
        self.assertEqual(event["organizers"], ["Dr. Rao", "Dr. Verma"])
        self.assertEqual(event["organizer"], "Dr. Rao; Dr. Verma")
        stored = self.events.find_one({"_id": ObjectId(event["id"])})
        self.assertEqual(stored["organizers"], event["organizers"])
        for path in ["/event-manager/events", f"/event-manager/events/{event['id']}"]:
            body = self.call("GET", path).json()
            item = body.get("event") or body["events"][0]
            self.assertEqual(item["organizer"], "Dr. Rao; Dr. Verma")

    def test_invalid_or_empty_selections_never_write(self):
        for names in [[], [" "], [None], [12], "Dr. Rao", ["x" * 121], [f"Name {n}" for n in range(21)]]:
            with self.subTest(names=names):
                response = self.call("POST", "/event-manager/events", json={**EVENT, "organizers": names, "save_as_draft": True})
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.events.docs, {})
        missing = self.call("POST", "/event-manager/events", json={**EVENT, "organizer": None, "save_as_draft": True})
        self.assertEqual(missing.status_code, 422)

    def test_edit_replaces_selection_and_empty_edit_preserves_existing_data(self):
        event = self.draft(organizers=["Dr. Rao", "Dr. Verma"])
        updated = self.save(event["id"], save_as_draft=True, organizers=["Dr. Verma", "Guest Coordinator"])
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["event"]["organizer"], "Dr. Verma; Guest Coordinator")
        failed = self.save(event["id"], save_as_draft=True, organizers=[])
        self.assertEqual(failed.status_code, 422)
        self.assertEqual(self.events.find_one({"_id": ObjectId(event["id"])})["organizers"], ["Dr. Verma", "Guest Coordinator"])
        self.assertEqual(self.call("PATCH", f"/event-manager/events/{event['id']}", "mgr2", json={**EVENT, "organizers": ["Other"], "save_as_draft": True}).status_code, 404)

    def test_long_combined_names_submit_in_single_and_bulk_flows(self):
        names = ["Professor " + "A" * 85, "Professor " + "B" * 85]
        for bulk in [False, True]:
            event = self.draft(organizers=names)
            self.photo(event["id"])
            self.document(event["id"])
            response = self.call("POST", "/event-manager/events/bulk-submit", json={"event_ids": [event["id"]]}) if bulk else self.save(event["id"], organizers=names)
            self.assertEqual(response.status_code, 200, response.text)
            stored = self.events.find_one({"_id": ObjectId(event["id"])})
            self.assertEqual(stored["status"], "pending", response.text)
            self.assertEqual(stored["organizers"], names)

    def test_customized_pdf_contains_every_selected_organizer(self):
        names = ["Dr. Rao", "Dr. Verma", "Guest Coordinator"]
        event = self.draft(organizers=names)
        self.events.update_one({"_id": ObjectId(event["id"])}, {"$set": {"status": "approved"}})
        response = self.call("POST", f"/event-manager/events/{event['id']}/report", json={"include_basic_details": True, "include_photos": False})
        self.assertEqual(response.status_code, 200, response.text)
        for name in names:
            self.assertIn(name, pdf_text(response.content))

    def test_existing_event_without_array_remains_editable(self):
        event = self.draft()
        self.events.docs[ObjectId(event["id"])].pop("organizers")
        updated = self.save(event["id"], save_as_draft=True)
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["event"]["organizers"], [EVENT["organizer"]])
