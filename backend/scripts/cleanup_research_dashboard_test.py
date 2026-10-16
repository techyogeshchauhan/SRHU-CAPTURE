"""Dry-run or remove the research dashboard spreadsheet test batch.

Usage from any working directory::

    python backend/scripts/cleanup_research_dashboard_test.py
    python backend/scripts/cleanup_research_dashboard_test.py --yes
    python backend/scripts/cleanup_research_dashboard_test.py --yes --confirm-db campus_capture_test
    python backend/scripts/cleanup_research_dashboard_test.py --yes --allow-campus-capture --confirm-db campus_capture

Only research records and showcases carrying this script's exact marker are
removed. Evidence files attached to those records are removed as well. User
accounts, untagged records, and unrelated application data are never deleted.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - listed in backend/requirements.txt
    load_dotenv = None
if load_dotenv:
    load_dotenv(BACKEND_DIR / ".env", override=False)
sys.path.insert(0, str(BACKEND_DIR))

from app.database import (  # noqa: E402
    _MONGODB_DB_NAME,
    _MONGODB_URI,
    research_records,
    research_showcases,
)
from app.services.storage_service import delete_stored  # noqa: E402

SEED_BATCH = "research-dashboard-test-2026-10-v1"


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


def _confirm(given: str | None, allow_campus_capture: bool = False) -> bool:
    print(f"Target: {_target()}")
    explicitly_allowed = allow_campus_capture and _MONGODB_DB_NAME == "campus_capture"
    if not _is_test_target() and not explicitly_allowed:
        print("Refusing to write: the configured target is not clearly a local or test database.")
        return False
    if given is not None:
        if given == _MONGODB_DB_NAME:
            return True
        print(f"--confirm-db {given!r} does not match {_MONGODB_DB_NAME!r}. Nothing done.")
        return False
    return input(f"Type the database name ({_MONGODB_DB_NAME}) to delete this test batch: ").strip() == _MONGODB_DB_NAME


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--yes", action="store_true", help="Delete only rows carrying the test batch marker")
    parser.add_argument("--confirm-db", help="Database name confirmation (still requires a test target or explicit Campus Capture opt-in)")
    parser.add_argument(
        "--allow-campus-capture",
        action="store_true",
        help="Explicitly permit cleanup against the exact 'campus_capture' database (use only when authorized)",
    )
    args = parser.parse_args()

    print(f"Target: {_target()}")
    explicitly_allowed = args.allow_campus_capture and _MONGODB_DB_NAME == "campus_capture"
    if not _is_test_target() and not explicitly_allowed:
        print("Refusing to access this cleanup batch: the configured target is not clearly a local or test database.")
        return 1
    query = {"seed_batch": SEED_BATCH}
    records = list(research_records.find(query, {"_id": 1, "category": 1, "evidence": 1}))
    showcases = list(research_showcases.find(query, {"_id": 1, "title": 1}))
    print(f"Seed batch: {SEED_BATCH}")
    print(f"Research records: {len(records)} {dict(sorted(Counter(r.get('category', 'unknown') for r in records).items()))}")
    print(f"Research showcases: {len(showcases)}")
    if not records and not showcases:
        print("Nothing to remove.")
        return 0
    if not args.yes:
        print("Dry run: nothing deleted. Pass --yes to remove only these marked records and showcases.")
        return 0
    if not _confirm(args.confirm_db, args.allow_campus_capture):
        print("Not confirmed. Nothing deleted.")
        return 1

    # Re-fetch by the exact batch marker immediately before deleting.
    records = list(research_records.find(query, {"_id": 1, "evidence": 1}))
    showcases = list(research_showcases.find(query, {"_id": 1}))
    evidence = [item for row in records for item in row.get("evidence", [])]
    for item in evidence:
        delete_stored(item)
    deleted_records = research_records.delete_many(query).deleted_count
    deleted_showcases = research_showcases.delete_many(query).deleted_count
    remaining = research_records.count_documents(query) + research_showcases.count_documents(query)
    print(f"Deleted {deleted_records} research records, {deleted_showcases} showcases, and {len(evidence)} attached evidence files.")
    print(f"Marked documents remaining: {remaining}")
    return 0 if remaining == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
