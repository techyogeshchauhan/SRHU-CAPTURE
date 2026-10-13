"""Safely remove the dedicated Event Manager research E2E seed batch.

Run from ``backend``::

    python scripts/cleanup_research_e2e.py                 # dry run
    python scripts/cleanup_research_e2e.py --yes            # confirm interactively
    python scripts/cleanup_research_e2e.py --yes --confirm-db campus_capture_test

Only research records carrying this seed operation's exact batch marker are
deleted. Evidence attached to those records is removed from storage as well.
No users, showcases, genuine records, audit logs, or notifications are touched.
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

SEED_BATCH = "research-e2e-2026-10-v1"


def _target() -> str:
    rest = _MONGODB_URI.split("://", 1)[-1]
    host = rest.split("/", 1)[0].split("?", 1)[0].rsplit("@", 1)[-1]
    return f"{host} / database '{_MONGODB_DB_NAME}'"


def _is_test_target() -> bool:
    name = _MONGODB_DB_NAME.casefold()
    rest = _MONGODB_URI.split("://", 1)[-1]
    host = rest.split("/", 1)[0].split("?", 1)[0].rsplit("@", 1)[-1].casefold()
    return bool(re.search(r"(^|[_-])(test|dev|demo|sandbox|local)([_-]|$)", name)) or host.startswith(
        ("localhost", "127.0.0.1", "[::1]")
    )


def _confirm(action: str, given: str | None) -> bool:
    print(f"Target: {_target()}")
    if not _is_test_target():
        print("Refusing to write: the configured target is not clearly a local or test database.")
        return False
    if given is not None:
        if given == _MONGODB_DB_NAME:
            return True
        print(f"--confirm-db {given!r} does not match {_MONGODB_DB_NAME!r}. Nothing done.")
        return False
    return input(f"Type the database name ({_MONGODB_DB_NAME}) to {action}: ").strip() == _MONGODB_DB_NAME


def _records() -> list[dict]:
    return list(research_records.find({"seed_batch": SEED_BATCH}, {"_id": 1, "category": 1, "evidence": 1}))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--yes", action="store_true", help="Delete the tagged seed records")
    parser.add_argument("--confirm-db", help="Database name confirmation (still requires a test target)")
    args = parser.parse_args()

    rows = _records()
    by_category = Counter(row.get("category", "unknown") for row in rows)
    evidence = [entry for row in rows for entry in row.get("evidence", [])]
    print(f"Target: {_target()}")
    print(f"Seed batch: {SEED_BATCH}")
    print(f"Seeded research records: {len(rows)} {dict(sorted(by_category.items()))}")
    print(f"Evidence files attached to those records: {len(evidence)}")
    if not rows:
        print("Nothing to remove.")
        return 0
    if not args.yes:
        print("Dry run: nothing deleted. Pass --yes to remove only these tagged records and their evidence files.")
        return 0
    if not _confirm("delete this seed batch", args.confirm_db):
        print("Not confirmed. Nothing deleted.")
        return 1

    # Re-read immediately before deletion and keep the query restricted to the
    # dedicated marker. Records without that marker are never included.
    rows = _records()
    record_ids = [row["_id"] for row in rows]
    evidence = [entry for row in rows for entry in row.get("evidence", [])]
    for row in rows:
        for entry in row.get("evidence", []):
            delete_stored(entry)
    result = research_records.delete_many({"_id": {"$in": record_ids}, "seed_batch": SEED_BATCH})
    remaining = research_records.count_documents({"seed_batch": SEED_BATCH})
    print(f"Deleted {result.deleted_count} seeded research records and {len(evidence)} attached evidence files.")
    print(f"Seeded research records remaining: {remaining}")
    return 0 if remaining == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
