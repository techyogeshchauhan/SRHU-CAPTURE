"""Dry-run or remove only records created by seed_research_ui_demo.py.

Run from ``backend`` (see ``docs/research-ui-demo-seed.md``). By default this
prints the exact tagged batch and changes nothing. Deletion requires ``--yes``
plus typing the configured database name, unless ``--confirm-db`` supplies an
exact match. Non-test databases also require ``--allow-non-test-db``.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import _MONGODB_DB_NAME, _MONGODB_URI, research_records  # noqa: E402
from app.services.storage_service import delete_stored  # noqa: E402
from seed_research_ui_demo import SEED_BATCH, SEED_MARKER, TITLE_PREFIX, confirm_write  # noqa: E402


def seed_query() -> dict:
    """The cleanup boundary: batch marker, script marker, and visible title prefix."""
    return {
        "seed_batch": SEED_BATCH,
        "seed_generated_by": SEED_MARKER,
        "title": {"$regex": f"^{re.escape(TITLE_PREFIX)} "},
    }


def delete_seed_records(collection, delete_file=delete_stored) -> tuple[int, int]:
    """Remove matching records and their attached storage objects only."""
    query = seed_query()
    rows = list(collection.find(query, {"_id": 1, "evidence": 1}))
    evidence = [entry for row in rows for entry in row.get("evidence", [])]
    for entry in evidence:
        delete_file(entry)
    if not rows:
        return 0, 0
    result = collection.delete_many({"_id": {"$in": [row["_id"] for row in rows]}, **query})
    return result.deleted_count, len(evidence)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--yes", action="store_true", help="Delete only the matching tagged records")
    parser.add_argument("--confirm-db", help="Exact target database name confirmation")
    parser.add_argument("--allow-non-test-db", action="store_true", help="Allow a non-test target after explicit database confirmation")
    args = parser.parse_args()

    query = seed_query()
    rows = list(research_records.find(query, {"category": 1, "verification_status": 1, "evidence": 1}))
    categories = Counter(row.get("category", "unknown") for row in rows)
    evidence_count = sum(len(row.get("evidence") or []) for row in rows)
    authority = _MONGODB_URI.split("://", 1)[-1].split("/", 1)[0].split("?", 1)[0]
    host = authority.rsplit("@", 1)[-1]
    print(f"Target: {host} / database '{_MONGODB_DB_NAME}'")
    print(f"Seed batch: {SEED_BATCH}")
    print(f"Matching research records: {len(rows)} {dict(sorted(categories.items()))}")
    print(f"Evidence objects attached to the matching records: {evidence_count}")
    if not rows:
        print("Nothing to remove.")
        return 0
    if not args.yes:
        print("Dry run only. Pass --yes to remove this marked batch and its evidence objects.")
        return 0
    if not confirm_write("delete this marked sample-data batch", args.confirm_db, args.allow_non_test_db):
        print("Not confirmed. Nothing was deleted.")
        return 1

    # Re-read at deletion time, and keep both the marker and the collected IDs
    # in the delete predicate. Real research without every seed marker is out.
    deleted, deleted_evidence = delete_seed_records(research_records)
    remaining = research_records.count_documents(query)
    print(f"Deleted {deleted} marked research records and {deleted_evidence} attached evidence objects.")
    print(f"Matching sample records remaining: {remaining}")
    return 0 if remaining == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
