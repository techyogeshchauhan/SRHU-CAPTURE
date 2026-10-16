"""Run against an explicitly supplied, disposable MongoDB replica set.

TEST_EVENT_TYPES_URI=mongodb://127.0.0.1:27028/?replicaSet=eventTypeTests
Each test owns a fresh database; the configured application database is unused.
"""
import copy
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from uuid import uuid4

from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pymongo import MongoClient
from pymongo.errors import OperationFailure

from app.models.documents import new_event_type_document
from app.routers.directory import router
from app.services import event_type_management as management
from app.services import event_types as catalog
from app.utils.security import create_access_token


@unittest.skipUnless(os.getenv("TEST_EVENT_TYPES_URI"), "Requires isolated TEST_EVENT_TYPES_URI replica set")
class EventTypeManagementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mongo = MongoClient(os.environ["TEST_EVENT_TYPES_URI"], serverSelectionTimeoutMS=5000)
        cls.mongo.admin.command("ping")

    @classmethod
    def tearDownClass(cls):
        cls.mongo.close()

    def setUp(self):
        self.db = self.mongo["event_type_test_" + uuid4().hex]
        self.addCleanup(self.mongo.drop_database, self.db.name)
        for target, value in (("app.services.event_types.event_types", self.db.event_types),
                              ("app.services.event_type_management.events", self.db.events),
                              ("app.services.event_type_management.managed_events", self.db.managed_events),
                              ("app.utils.auth.users", self.db.users)):
            p = patch(target, value)
            p.start()
            self.addCleanup(p.stop)
        catalog.ensure_event_type_indexes()
        catalog.seed_default_event_types()
        self.user = {"id": str(ObjectId()), "role": "event_manager", "name": "Manager"}
        self.other = {"id": str(ObjectId()), "role": "event_manager", "name": "Other"}
        for user in (self.user, self.other):
            self.db.users.insert_one({"_id": ObjectId(user["id"]), "role": user["role"],
                                      "name": user["name"], "is_active": True, "email_verified": True})
        self.token = create_access_token(self.user["id"], role="event_manager")[0]
        app = FastAPI()
        app.include_router(router)
        self.http = TestClient(app)
        self.source = self.add_type("Tech Fest")
        self.destination = self.add_type("Science Fair", self.other["id"])

    def add_type(self, name, owner=None):
        catalog.resolve_event_type(name, created_by=owner or self.user["id"])
        return catalog.find_event_type(name)

    def request(self, method, path="", payload=None, token=None):
        return self.http.request(method, "/event-types" + path, json=payload,
                                 headers={"Authorization": "Bearer " + (token or self.token)})

    def seed_events(self):
        for collection in (self.db.events, self.db.managed_events):
            for i, status in enumerate(("draft", "pending", "approved", "rejected", "archived")):
                collection.insert_one({"event_type": "Tech Fest" if i % 2 else "tech fest",
                                       "status": status, "owner_id": self.other["id"],
                                       "description": "preserve", "history": [{"action": "created"}],
                                       "report_photo_ids": ["photo"], "is_archived": status == "archived"})
            collection.insert_one({"event_type": "Workshop", "status": "draft"})

    def snapshot(self):
        return {c: list(self.db[c].find().sort("_id")) for c in ("event_types", "events", "managed_events")}

    def test_authenticated_management_list_only_flags_owners_custom_types(self):
        response = self.request("GET", "/manage")
        self.assertEqual(response.status_code, 200, response.text)
        manageable = [r["name"] for r in response.json()["event_types"] if r["can_manage"]]
        self.assertEqual(manageable, ["Tech Fest"])
        self.assertNotIn("created_by", response.text)

    def test_wrong_role_and_missing_auth_are_blocked(self):
        teacher = {"_id": ObjectId(), "role": "teacher"}
        self.db.users.insert_one(teacher)
        token = create_access_token(str(teacher["_id"]), role="teacher")[0]
        for method, path, payload in (("GET", "/manage", None), ("GET", f'/{self.source["_id"]}/usage', None),
                                      ("PATCH", f'/{self.source["_id"]}', {"name": "New"}),
                                      ("DELETE", f'/{self.source["_id"]}', {"destination_id": None})):
            self.assertEqual(self.request(method, path, payload, token).status_code, 403)
        self.assertEqual(self.http.get("/event-types/manage").status_code, 401)

    def test_other_owner_and_default_types_are_protected(self):
        for row in (self.destination, catalog.find_event_type("Workshop")):
            for method, suffix, data in (("PATCH", "", {"name": "New"}),
                                          ("DELETE", "", {"destination_id": None}), ("GET", "/usage", None)):
                self.assertEqual(self.request(method, f'/{row["_id"]}{suffix}', data).status_code, 403)

    def test_usage_counts_both_collections_and_every_status(self):
        self.seed_events()
        response = self.request("GET", f'/{self.source["_id"]}/usage')
        self.assertEqual(response.json(), {"success": True, "total": 10, "teacher_events": 5, "managed_events": 5})

    def test_rename_preserves_every_event_field_and_resolves_old_name(self):
        self.seed_events()
        before = self.snapshot()
        response = self.request("PATCH", f'/{self.source["_id"]}', {"name": "Innovation Fest"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["events_moved"], 10)
        for c in ("events", "managed_events"):
            expected = copy.deepcopy(before[c])
            for row in expected:
                if row["event_type"].lower() == "tech fest":
                    row["event_type"] = "Innovation Fest"
            self.assertEqual(list(self.db[c].find().sort("_id")), expected)
        self.assertEqual(catalog.resolve_event_type("TECH FEST"), "Innovation Fest")
        self.assertEqual(catalog.resolve_event_type("tech fest", create=False), "Innovation Fest")

    def test_delete_moves_to_another_owners_existing_type_then_removes_source(self):
        self.seed_events()
        response = self.request("DELETE", f'/{self.source["_id"]}', {"destination_id": str(self.destination["_id"])})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["events_moved"], 10)
        self.assertIsNone(self.db.event_types.find_one({"_id": self.source["_id"]}))
        for c in (self.db.events, self.db.managed_events):
            self.assertEqual(c.count_documents({"event_type": "Science Fair"}), 5)
            self.assertEqual(c.count_documents({"event_type": "Workshop"}), 1)
            self.assertEqual(c.count_documents({}), 6)
        self.assertEqual(catalog.resolve_event_type("Tech Fest"), "Science Fair")

    def test_uncategorized_is_created_protected_and_reused_for_zero_events(self):
        for row in (self.source, self.add_type("Second type")):
            response = self.request("DELETE", f'/{row["_id"]}', {"destination_id": None})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["event_type"], "Uncategorized")
        self.assertEqual(self.db.event_types.count_documents({"key": "uncategorized"}), 1)
        uncategorized = catalog.find_event_type("Uncategorized")
        self.assertEqual(self.request("DELETE", f'/{uncategorized["_id"]}', {"destination_id": None}).status_code, 403)

    def test_invalid_names_duplicate_names_and_destination_do_not_mutate(self):
        before = self.snapshot()
        for name, code in ((" ", 422), ("x" * 61, 422), ("Workshop", 409), ("science fair", 409), ("Uncategorized", 409)):
            self.assertEqual(self.request("PATCH", f'/{self.source["_id"]}', {"name": name}).status_code, code)
        for destination, code in ((str(self.source["_id"]), 409), (str(ObjectId()), 404), ("invalid", 404)):
            self.assertEqual(self.request("DELETE", f'/{self.source["_id"]}', {"destination_id": destination}).status_code, code)
        self.assertEqual(self.request("DELETE", f'/{self.source["_id"]}', {}).status_code, 422)
        self.assertEqual(self.snapshot(), before)

    def test_failed_second_collection_move_rolls_back_first_move_and_catalog(self):
        self.seed_events()
        for delete in (False, True):
            before = self.snapshot()
            with patch.object(management.managed_events, "update_many", side_effect=OperationFailure("forced failure", 121)):
                result = self.request("DELETE" if delete else "PATCH", f'/{self.source["_id"]}',
                                      {"destination_id": None} if delete else {"name": "Updated"})
            self.assertEqual(result.status_code, 503, result.text)
            self.assertEqual(self.snapshot(), before)

    def test_incomplete_move_is_detected_and_rolled_back(self):
        self.seed_events()
        before = self.snapshot()
        class Result:
            matched_count = 5
        with patch.object(management.managed_events, "update_many", return_value=Result()):
            response = self.request("DELETE", f'/{self.source["_id"]}', {"destination_id": None})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.snapshot(), before)

    def test_missing_transaction_support_never_partially_moves_or_deletes(self):
        self.seed_events()
        before = self.snapshot()
        with patch.object(self.mongo, "start_session", side_effect=OperationFailure("standalone", 20)):
            response = self.request("DELETE", f'/{self.source["_id"]}', {"destination_id": None})
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("replica set", response.text)
        self.assertEqual(self.snapshot(), before)

    def test_event_save_still_works_without_transaction_support(self):
        def save(name, session):
            self.assertIsNone(session)
            return self.db.events.insert_one({"event_type": name})
        with patch.object(self.mongo, "start_session", side_effect=OperationFailure("standalone", 20)):
            catalog.write_event_with_type(self.db.events, "Tech Fest", created_by=self.user["id"], operation=save)
        self.assertEqual(self.db.events.count_documents({"event_type": "Tech Fest"}), 1)

    def test_case_only_rename_and_regex_characters(self):
        row = self.add_type("Fest (A+B)?")
        self.db.events.insert_one({"event_type": row["name"]})
        self.db.events.insert_one({"event_type": "Fest AAB"})
        result = self.request("PATCH", f'/{row["_id"]}', {"name": "FEST (A+B)?"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["events_moved"], 1)
        self.assertEqual(self.db.events.count_documents({"event_type": "Fest AAB"}), 1)

    def test_stale_event_save_after_rename_and_delete_uses_destination(self):
        self.request("PATCH", f'/{self.source["_id"]}', {"name": "New Fest"})
        self.request("DELETE", f'/{self.source["_id"]}', {"destination_id": None})
        def save(name, session):
            return self.db.events.insert_one({"event_type": name, "status": "draft"}, session=session)
        catalog.write_event_with_type(self.db.events, "Tech Fest", created_by=self.user["id"], operation=save)
        self.assertEqual(self.db.events.find_one()["event_type"], "Uncategorized")
        self.assertEqual(catalog.resolve_event_type("New Fest"), "Uncategorized")

    def test_concurrent_save_is_retried_when_type_deleted(self):
        ready, proceed = threading.Event(), threading.Event()
        attempts = []
        def save(name, session):
            attempts.append(name)
            if len(attempts) == 1:
                ready.set()
                self.assertTrue(proceed.wait(10))
            return self.db.events.insert_one({"event_type": name}, session=session)
        with ThreadPoolExecutor() as pool:
            future = pool.submit(catalog.write_event_with_type, self.db.events, "Tech Fest",
                                 created_by=self.user["id"], operation=save)
            self.assertTrue(ready.wait(10))
            # The writer holds the source lock. Let it commit, then delete must
            # retry its snapshot and include the newly saved event.
            deletion = pool.submit(management.migrate_event_type, str(self.source["_id"]), self.user,
                                   destination_id=None, delete=True)
            proceed.set()
            future.result(timeout=15)
            deletion.result(timeout=15)
        self.assertEqual(self.db.events.count_documents({"event_type": "Uncategorized"}), 1)
        self.assertEqual(self.db.events.count_documents({"event_type": "Tech Fest"}), 0)


if __name__ == "__main__":
    unittest.main()
