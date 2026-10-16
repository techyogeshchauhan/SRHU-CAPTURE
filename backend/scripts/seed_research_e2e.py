"""Insert an idempotent 225-record Event Manager Research E2E batch.

Run from ``backend``::

    python scripts/seed_research_e2e.py status
    python scripts/seed_research_e2e.py seed                 # defaults to 225
    python scripts/seed_research_e2e.py seed --count 200

Seed and cleanup scripts share one dedicated marker. The seed operation adds
research records only and associates them with existing teachers; it never
creates or updates user accounts. The regular Research API powers the UI.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import _MONGODB_DB_NAME, _MONGODB_URI, research_records, users  # noqa: E402
from seed_research_demo import build_batch  # noqa: E402

SEED_BATCH = "research-e2e-2026-10-v1"
TITLE_PREFIX = "[E2E] "


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
    answer = input(f"Type the database name ({_MONGODB_DB_NAME}) to {action}: ").strip()
    if answer != _MONGODB_DB_NAME:
        print("Not confirmed. Nothing done.")
        return False
    return True


def _seeded() -> list[dict]:
    return list(research_records.find({"seed_batch": SEED_BATCH}, {"_id": 1, "category": 1, "verification_status": 1}))


def cmd_status(_args: argparse.Namespace) -> int:
    rows = _seeded()
    print(f"Target: {_target()}")
    print(f"Seed batch: {SEED_BATCH}")
    print(f"Seeded research records: {len(rows)}")
    print(f"By category: {dict(sorted(Counter(r['category'] for r in rows).items()))}")
    print(f"By workflow status: {dict(sorted(Counter(r['verification_status'] for r in rows).items()))}")
    return 0


def cmd_seed(args: argparse.Namespace) -> int:
    if not 200 <= args.count <= 250:
        print("--count must be between 200 and 250.")
        return 2

    existing = _seeded()
    if existing:
        if len(existing) == args.count:
            print(f"Target: {_target()}")
            print(f"This batch already contains {len(existing)} records. No duplicates created.")
            return 0
        print(
            f"This batch already contains {len(existing)} records, not {args.count}. "
            "Run cleanup_research_e2e.py --yes before reseeding."
        )
        return 1

    if not _confirm(f"insert {args.count} Event Manager E2E research records", args.confirm_db):
        print("Not confirmed. Nothing inserted.")
        return 1

    faculty = [
        {"id": str(user["_id"]), "name": user.get("name") or user.get("email") or "Faculty member"}
        for user in users.find({"role": "teacher", "is_active": {"$ne": False}}, {"_id": 1, "name": 1, "email": 1})
    ]
    if not faculty:
        print("No active teacher accounts exist in this database. Nothing inserted.")
        return 1

    records = build_batch(args.count, faculty)
    for number, record in enumerate(records, start=1):
        record["seed_batch"] = SEED_BATCH
        title = record["title"].removeprefix("[Demo] ")
        record["title"] = f"{TITLE_PREFIX}{number:03d} {title}"

    inserted_ids = research_records.insert_many(records, ordered=True).inserted_ids
    seeded = _seeded()
    categories = Counter(row["category"] for row in seeded)
    statuses = Counter(row["verification_status"] for row in seeded)
    print(f"Target: {_target()}")
    print(f"Inserted {len(inserted_ids)} marked records across {len(categories)} categories.")
    print(f"By category: {dict(sorted(categories.items()))}")
    print(f"By workflow status: {dict(sorted(statuses.items()))}")
    print("Every title begins [E2E]; genuine records and user accounts were not modified.")
    print("Cleanup: python scripts/cleanup_research_e2e.py --yes")
    return 0 if len(seeded) == args.count and len(categories) == 6 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="Count the marked E2E records in the configured database")
    seed = sub.add_parser("seed", help="Insert 200-250 demo research records")
    seed.add_argument("--count", type=int, default=225)
    seed.add_argument("--confirm-db", help="Database name confirmation (still requires a test target)")
    args = parser.parse_args()
    return cmd_status(args) if args.command == "status" else cmd_seed(args)


if __name__ == "__main__":
    sys.exit(main())
