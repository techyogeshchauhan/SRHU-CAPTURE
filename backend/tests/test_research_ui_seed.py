"""Research UI seed data is schema-valid and cleanup stays on its own batch."""

from __future__ import annotations

import importlib.util
import os
import unittest
import sys
from collections import Counter
from copy import deepcopy
from datetime import date
from pathlib import Path
from types import SimpleNamespace
import re

from bson import ObjectId

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from app.services.research_categories import CATEGORIES, clean_details  # noqa: E402
from app.models.documents import academic_year_of  # noqa: E402

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


seed = _load("seed_research_ui_demo", SCRIPTS / "seed_research_ui_demo.py")
cleanup = _load("cleanup_research_ui_demo", SCRIPTS / "cleanup_research_ui_demo.py")


class FakeCollection:
    def __init__(self, records):
        self.records = deepcopy(records)

    def find(self, query, _projection=None):
        title_pattern = query["title"]["$regex"]
        return [
            deepcopy(row)
            for row in self.records
            if row.get("seed_batch") == query["seed_batch"]
            and row.get("seed_generated_by") == query["seed_generated_by"]
            and re.search(title_pattern, row.get("title", ""))
        ]

    def delete_many(self, query):
        ids = set(query["_id"]["$in"])
        batch = query["seed_batch"]
        marker = query["seed_generated_by"]
        title_pattern = query["title"]["$regex"]
        before = len(self.records)
        self.records = [
            row for row in self.records
            if not (
                row.get("_id") in ids
                and row.get("seed_batch") == batch
                and row.get("seed_generated_by") == marker
                and re.search(title_pattern, row.get("title", ""))
            )
        ]
        return SimpleNamespace(deleted_count=before - len(self.records))


class ResearchUiSeedTests(unittest.TestCase):
    def setUp(self):
        self.faculty = [
            {"id": str(ObjectId()), "name": f"Dr. Sample Faculty {n}"}
            for n in range(1, 6)
        ]
        self.manager = {"id": str(ObjectId()), "name": "Sample Event Manager", "role": "event_manager"}

    def test_default_size_batch_covers_five_categories_with_schema_valid_data(self):
        records = seed.build_records(125, self.faculty, self.manager, today=date(2026, 10, 13))

        self.assertEqual(len(records), 125)
        self.assertEqual(Counter(row["category"] for row in records), Counter({key: 25 for key in seed.CATEGORY_KEYS}))
        self.assertEqual({row["verification_status"] for row in records}, {"verified"})
        self.assertTrue(all(row["verified_by"]["role"] == "event_manager" for row in records))
        self.assertTrue(all(row["created_by"] == self.manager["id"] for row in records))
        for row in records:
            self.assertEqual(row["seed_batch"], seed.SEED_BATCH)
            self.assertEqual(row["seed_generated_by"], seed.SEED_MARKER)
            self.assertTrue(row["title"].startswith(seed.TITLE_PREFIX))
            category = CATEGORIES[row["category"]]
            _, missing = clean_details(category, row["details"], row["outcome_status"])
            self.assertEqual(missing, [], row["title"])
            self.assertLessEqual(row["record_date"], "2026-10-13")
            self.assertEqual(row["academic_year"], academic_year_of(row["record_date"]))

    def test_count_below_one_hundred_is_rejected(self):
        with self.assertRaises(ValueError):
            seed.build_records(99, self.faculty, self.manager, today=date(2026, 10, 13))

    def test_cleanup_deletes_only_records_with_all_seed_markers(self):
        seeded = {
            "_id": ObjectId(),
            "seed_batch": seed.SEED_BATCH,
            "seed_generated_by": seed.SEED_MARKER,
            "title": f"{seed.TITLE_PREFIX} 0001 | Sample journal record",
            "evidence": [{"storage": "gridfs", "file_id": "sample-file"}],
        }
        genuine_with_title = {"_id": ObjectId(), "title": f"{seed.TITLE_PREFIX} genuine record"}
        wrong_marker = {
            "_id": ObjectId(),
            "seed_batch": seed.SEED_BATCH,
            "seed_generated_by": "another_script.py",
            "title": f"{seed.TITLE_PREFIX} 0002 | Different script",
        }
        collection = FakeCollection([seeded, genuine_with_title, wrong_marker])
        removed_files = []

        deleted, evidence_deleted = cleanup.delete_seed_records(collection, removed_files.append)

        self.assertEqual((deleted, evidence_deleted), (1, 1))
        self.assertEqual(removed_files, seeded["evidence"])
        self.assertEqual({row["_id"] for row in collection.records}, {genuine_with_title["_id"], wrong_marker["_id"]})


if __name__ == "__main__":
    unittest.main()
