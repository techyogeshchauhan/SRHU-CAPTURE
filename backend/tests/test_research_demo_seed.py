"""scripts/seed_research_demo.py: the demo batch is valid, varied, and only
ever identifiable -- and removable -- as demo data."""

from __future__ import annotations

import importlib.util
import os
import unittest
from datetime import date
from pathlib import Path

from bson import ObjectId

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from app.services.research_categories import CATEGORIES, clean_details  # noqa: E402

_PATH = Path(__file__).resolve().parents[1] / "scripts" / "seed_research_demo.py"
_spec = importlib.util.spec_from_file_location("seed_research_demo", _PATH)
seed = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(seed)

FACULTY = [{"id": str(ObjectId()), "name": f"Dr. Demo {n} (Demo)"} for n in range(8)]


class DemoBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.records = seed.build_batch(80, FACULTY, today=date(2026, 10, 11))

    def test_every_record_is_marked_as_demo_data(self) -> None:
        for record in self.records:
            self.assertEqual(record["seed_batch"], seed.TAG)
            self.assertTrue(record["title"].startswith("[Demo] "))
            self.assertIn(record["faculty_id"], {f["id"] for f in FACULTY})  # never a real teacher
            if record["details"].get("doi"):
                self.assertTrue(record["details"]["doi"].startswith("10.5555/"))
            self.assertEqual(record["history"][0]["note"], seed.SEED_NOTE)

    def test_submitted_records_pass_the_apis_own_validation(self) -> None:
        for record in self.records:
            if record["verification_status"] == "draft":
                continue
            category = CATEGORIES[record["category"]]
            _, missing = clean_details(category, record["details"], record["outcome_status"])
            self.assertEqual(missing, [], record["title"])
            self.assertLessEqual(record["record_date"], "2026-10-11")

    def test_the_batch_covers_every_stage_and_category(self) -> None:
        states = {r["verification_status"] for r in self.records}
        self.assertEqual(states, {"draft", "submitted", "changes_requested", "rejected", "verified"})
        self.assertEqual({r["category"] for r in self.records}, set(CATEGORIES))
        manager = [r for r in self.records if (r.get("verified_by") or {}).get("role") == "event_manager"]
        dean = [r for r in self.records if r["verification_status"] == "verified" and r not in manager]
        self.assertTrue(manager and dean)
        # The Dean's queue holds only teacher submissions: an Event Manager's
        # would be recorded at startup (record_waiting_manager_submissions).
        for record in self.records:
            if record["verification_status"] == "submitted":
                self.assertEqual(record["history"][-1]["actor_role"], "teacher")

    def test_history_is_in_order_and_signed_by_placeholders_or_demo_faculty(self) -> None:
        demo_ids = {f["id"] for f in FACULTY}
        for record in self.records:
            stamps = [entry["created_at"] for entry in record["history"]]
            self.assertEqual(stamps, sorted(stamps))
            for entry in record["history"]:
                self.assertTrue(entry["actor_id"] is None or entry["actor_id"] in demo_ids)

    def test_demo_addresses_pass_the_sign_in_forms_validation(self) -> None:
        from pydantic import TypeAdapter, EmailStr

        TypeAdapter(EmailStr).validate_python(f"aarav.mehta@{seed.DOMAIN}")

    def test_count_is_respected(self) -> None:
        self.assertEqual(len(seed.build_batch(50, FACULTY)), 50)
        self.assertEqual(len(seed.build_batch(100, FACULTY)), 100)


class RemovalScopeTests(unittest.TestCase):
    def test_demo_accounts_need_the_tag_and_the_reserved_domain(self) -> None:
        from tests.fake_users import FakeUsers
        from unittest.mock import patch

        demo = {"_id": ObjectId(), "email": f"a@{seed.DOMAIN}", "seed_batch": seed.TAG}
        tag_only = {"_id": ObjectId(), "email": "real.teacher@srhu.edu.in", "seed_batch": seed.TAG}
        domain_only = {"_id": ObjectId(), "email": f"b@{seed.DOMAIN}"}
        real = {"_id": ObjectId(), "email": "neelmani@srhu.edu.in"}
        with patch.object(seed, "users", FakeUsers(demo, tag_only, domain_only, real)):
            self.assertEqual(seed.demo_user_ids(), [str(demo["_id"])])


if __name__ == "__main__":
    unittest.main()
