"""Import the research dashboard test workbook into MongoDB safely.

Run from any directory::

    python backend/scripts/import_research_dashboard_test.py --dry-run
    python backend/scripts/import_research_dashboard_test.py --import
    python backend/scripts/import_research_dashboard_test.py --import --confirm-db campus_capture_test

The workbook's rows must use the exact seed batch ID defined below. Imports
are idempotent: a matching complete batch is left unchanged; a partial or
different existing batch is refused. Writes require an explicitly named local
or test database. No user accounts are created or modified.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - listed in backend/requirements.txt
    load_dotenv = None
if load_dotenv:
    load_dotenv(BACKEND_DIR / ".env", override=False)
sys.path.insert(0, str(BACKEND_DIR))

from bson import ObjectId  # noqa: E402
from openpyxl import load_workbook  # noqa: E402

from app.database import (  # noqa: E402
    _MONGODB_DB_NAME,
    _MONGODB_URI,
    research_records,
    research_showcases,
    users,
)
from app.models.documents import new_history_entry, new_research_record_document  # noqa: E402
from app.routers.research import _snapshot  # noqa: E402
from app.schemas.research import ResearchCreateRequest  # noqa: E402
from app.services.research_categories import CATEGORIES, clean_details  # noqa: E402
from app.services.research_identifiers import identifiers_of  # noqa: E402
from app.utils.serializers import utc_now  # noqa: E402

SEED_BATCH = "research-dashboard-test-2026-10-v1"
DEFAULT_WORKBOOK = BACKEND_DIR.parent / "outputs" / "research-dashboard-test-20261013" / "research_dashboard_test_dataset.xlsx"
MANAGER = {"id": None, "name": "Research Dashboard Test (seed data)", "role": "event_manager"}
DEAN = {"id": None, "name": "Research Dashboard Test Dean (seed data)", "role": "dean"}
VALID_STATES = {"draft", "submitted", "verified", "changes_requested", "rejected"}
FIXED_HEADERS = {
    "test_batch_id", "test_record_id", "faculty_slot", "category", "title",
    "record_date", "outcome_status", "verification_status", "entered_by_role",
    "abstract", "link", "dean_remarks",
}


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
    return input(f"Type the database name ({_MONGODB_DB_NAME}) to import this test batch: ").strip() == _MONGODB_DB_NAME


def _as_text(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    return text or None


def _rows(path: Path) -> tuple[list[dict], str]:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    workbook = load_workbook(path, read_only=True, data_only=True)
    if "Records" not in workbook.sheetnames:
        raise ValueError("Workbook must contain a sheet named 'Records'.")
    sheet = workbook["Records"]
    iterator = sheet.iter_rows(values_only=True)
    headers = [str(value or "").strip() for value in next(iterator, ())]
    if not headers or len(set(headers)) != len(headers):
        raise ValueError("Records sheet must have unique, non-empty column headers.")
    missing = FIXED_HEADERS - set(headers)
    if missing:
        raise ValueError(f"Records sheet is missing required columns: {', '.join(sorted(missing))}")
    rows = []
    for row_number, values in enumerate(iterator, start=2):
        data = dict(zip(headers, values))
        if all(value is None or str(value).strip() == "" for value in values):
            continue
        if data.get("test_batch_id") != SEED_BATCH:
            raise ValueError(f"Row {row_number}: test_batch_id must equal {SEED_BATCH}.")
        category_key = _as_text(data.get("category"))
        category = CATEGORIES.get(category_key or "")
        if not category:
            raise ValueError(f"Row {row_number}: unsupported category {category_key!r}.")
        status = _as_text(data.get("verification_status"))
        if status not in VALID_STATES:
            raise ValueError(f"Row {row_number}: unsupported verification_status {status!r}.")
        outcome = _as_text(data.get("outcome_status"))
        if outcome not in {key for key, _ in category.outcomes}:
            raise ValueError(f"Row {row_number}: unsupported outcome {outcome!r} for {category_key}.")
        entered_by_role = _as_text(data.get("entered_by_role")) or "teacher"
        if entered_by_role not in ("teacher", "event_manager"):
            raise ValueError(f"Row {row_number}: entered_by_role must be teacher or event_manager.")
        details = {}
        for field in category.fields:
            value = data.get(f"detail__{field.key}")
            if field.type == "date":
                value = _as_text(value)
            if isinstance(value, str):
                value = value.strip() or None
                if value and field.type == "multiselect":
                    value = [part.strip() for part in value.split("|") if part.strip()]
            if value is not None:
                details[field.key] = value
        details, missing_fields = clean_details(category, details, outcome)
        if missing_fields and status != "draft":
            raise ValueError(f"Row {row_number}: required details missing: {', '.join(missing_fields)}")
        record_date = _as_text(data.get("record_date"))
        if record_date:
            try:
                date.fromisoformat(record_date)
            except ValueError:
                raise ValueError(f"Row {row_number}: record_date must be YYYY-MM-DD.") from None
        title = _as_text(data.get("title"))
        abstract = _as_text(data.get("abstract"))
        link = _as_text(data.get("link"))
        try:
            ResearchCreateRequest(
                category=category_key,
                title=title,
                record_date=record_date,
                outcome_status=outcome,
                details=details,
                abstract=abstract,
                link=link,
            )
        except Exception as exc:
            raise ValueError(f"Row {row_number}: record fields are invalid: {exc}") from None
        faculty_slot = int(data.get("faculty_slot") or 1)
        if faculty_slot < 1:
            raise ValueError(f"Row {row_number}: faculty_slot must be a positive integer.")
        record_id = _as_text(data.get("test_record_id"))
        if not record_id or not re.fullmatch(r"RDT-\d{3,}", record_id):
            raise ValueError(f"Row {row_number}: test_record_id must look like RDT-001.")
        rows.append({
            "excel_row": row_number,
            "test_record_id": record_id,
            "faculty_slot": faculty_slot,
            "category": category_key,
            "title": title,
            "record_date": record_date,
            "outcome_status": outcome,
            "verification_status": status,
            "entered_by_role": entered_by_role,
            "abstract": abstract,
            "link": link,
            "dean_remarks": _as_text(data.get("dean_remarks")),
            "details": details,
        })
    workbook.close()
    if not 250 <= len(rows) <= 500:
        raise ValueError(f"Workbook must contain 250-500 data rows; found {len(rows)}.")
    missing_categories = set(CATEGORIES) - {row["category"] for row in rows}
    if missing_categories:
        raise ValueError(f"Workbook must include every supported category; missing: {', '.join(sorted(missing_categories))}.")
    ids = [row["test_record_id"] for row in rows]
    if len(set(ids)) != len(ids):
        raise ValueError("test_record_id values must be unique.")
    return rows, digest


def _history(record: dict, row: dict, owner: dict) -> list[dict]:
    state = row["verification_status"]
    entered_as_manager = row["entered_by_role"] == "event_manager"
    creator = MANAGER if entered_as_manager else {"id": str(owner["_id"]), "name": owner.get("name"), "role": "teacher"}
    now = utc_now()
    start = now - timedelta(days=14 + (int(row["test_record_id"][-3:]) % 45))

    def entry(action: str, new_state: str, actor: dict, after_days: int, from_status: str | None = None, note: str | None = None):
        result = new_history_entry(action=action, status=new_state, actor=actor, from_status=from_status, note=note)
        result["created_at"] = start + timedelta(days=after_days)
        return result

    history = [entry("created", "draft", creator, 0, note="Created by research dashboard test importer.")]
    if state == "draft":
        return history
    submitted = entry("submitted", "submitted", creator, 1, from_status="draft")
    history.append(submitted)
    record["submitted_at"] = submitted["created_at"]
    if state == "submitted":
        return history
    if state == "changes_requested":
        note = row["dean_remarks"] or "Please review the test record details."
        history.append(entry("changes_requested", state, DEAN, 3, from_status="submitted", note=note))
        record["dean_remarks"] = note
        return history
    if state == "rejected":
        note = row["dean_remarks"] or "Test rejection status for workflow coverage."
        history.append(entry("rejected", state, DEAN, 3, from_status="submitted", note=note))
        record["dean_remarks"] = note
        return history
    if entered_as_manager:
        recorded = entry("recorded", "verified", MANAGER, 2, from_status="draft",
                         note="Recorded by the Event Manager; no Dean verification needed.")
        history = [history[0], recorded]
        record.update(submitted_at=recorded["created_at"], verified_at=recorded["created_at"],
                      verified_by={"id": None, "name": MANAGER["name"], "role": "event_manager"})
    else:
        verified = entry("verified", "verified", DEAN, 4, from_status="submitted")
        history.append(verified)
        record.update(verified_at=verified["created_at"], verified_by={"id": None, "name": DEAN["name"], "role": "dean"})
    return history


def _prepare(rows: list[dict], faculty: list[dict]) -> list[dict]:
    records = []
    for row in rows:
        owner = faculty[(row["faculty_slot"] - 1) % len(faculty)]
        category = CATEGORIES[row["category"]]
        created_by = MANAGER if row["entered_by_role"] == "event_manager" else {
            "id": str(owner["_id"]), "name": owner.get("name"), "role": "teacher"
        }
        record = new_research_record_document(
            faculty_id=str(owner["_id"]), created_by=created_by, category=row["category"],
            title=row["title"], record_date=row["record_date"], outcome_status=row["outcome_status"],
            details=row["details"], abstract=row["abstract"], link=row["link"],
        )
        record["verification_status"] = row["verification_status"]
        record["dean_remarks"] = row["dean_remarks"]
        record["history"] = _history(record, row, owner)
        if record["history"]:
            record["created_at"] = record["history"][0]["created_at"]
            record["updated_at"] = record["history"][-1]["created_at"]
        record["identifiers"] = identifiers_of(row["category"], row["title"], row["details"])
        record["seed_batch"] = SEED_BATCH
        record["seed_record_id"] = row["test_record_id"]
        if row["verification_status"] == "verified":
            record["verified_snapshot"] = _snapshot(record)
        records.append(record)
    return records


def _insert_showcases(records: list[dict], faculty: list[dict]) -> int:
    verified_by_owner: dict[str, list[dict]] = {}
    for row in records:
        if row.get("verification_status") == "verified":
            verified_by_owner.setdefault(row["faculty_id"], []).append(row)
    ranked = sorted(verified_by_owner.items(), key=lambda pair: len(pair[1]), reverse=True)
    now = utc_now()
    docs = []
    for index, (title, status) in enumerate((("[TEST] Research highlights for Dean review", "sent"),
                                             ("[TEST] Patents and grants working set", "draft"))):
        if index >= len(ranked):
            break
        owner_id, owner_records = ranked[index]
        chosen = owner_records[:8]
        ids = [str(row["_id"]) for row in chosen]
        person = next((p for p in faculty if str(p["_id"]) == owner_id), {})
        docs.append({
            "title": title, "description": "Seeded research dashboard test showcase.",
            "owner_id": owner_id, "owner_name": person.get("name"), "owner_role": "teacher",
            "record_ids": ids, "highlight_ids": ids[:2], "status": status,
            "sent_at": now if status == "sent" else None, "sent_count": 1 if status == "sent" else 0,
            "viewed_by": [], "created_at": now, "updated_at": now, "seed_batch": SEED_BATCH,
        })
    if docs:
        research_showcases.insert_many(docs, ordered=True)
    return len(docs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Validate workbook and show counts without writing")
    mode.add_argument("--import", dest="do_import", action="store_true", help="Insert records and showcases")
    parser.add_argument("--confirm-db", help="Database name confirmation (still requires a test target)")
    parser.add_argument(
        "--allow-campus-capture",
        action="store_true",
        help="Explicitly permit writing to the exact 'campus_capture' database (use only when authorized)",
    )
    args = parser.parse_args()
    try:
        rows, digest = _rows(args.workbook)
    except Exception as exc:
        print(f"Workbook validation failed: {exc}")
        return 2
    print(f"Configured database target: {_target()}")
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["category"]] = counts.get(row["category"], 0) + 1
    print(f"Workbook: {args.workbook}")
    print(f"Rows: {len(rows)}; SHA-256: {digest}")
    print(f"By category: {dict(sorted(counts.items()))}")
    if args.dry_run:
        print("Dry run complete. No database writes performed.")
        return 0
    if not _confirm(args.confirm_db, args.allow_campus_capture):
        print("Not confirmed. Nothing inserted.")
        return 1

    existing = list(research_records.find({"seed_batch": SEED_BATCH}, {"_id": 1, "seed_dataset_sha256": 1}))
    existing_shows = research_showcases.count_documents({"seed_batch": SEED_BATCH})
    if existing:
        if (len(existing) == len(rows) and existing_shows >= 1
                and all(r.get("seed_dataset_sha256") == digest for r in existing)):
            print(f"This exact dataset is already imported ({len(existing)} records, {existing_shows} showcases). No duplicates created.")
            return 0
        print(f"A conflicting or partial batch already exists ({len(existing)} records). Clean it up before importing.")
        return 1
    if existing_shows:
        print(f"A partial batch already has {existing_shows} showcase documents. Clean it up before importing.")
        return 1

    faculty = list(users.find({"role": "teacher", "is_active": {"$ne": False}},
                              {"_id": 1, "name": 1, "email": 1}).sort([("name", 1), ("email", 1)]))
    if not faculty:
        print("No active teacher accounts exist in this database. Nothing inserted.")
        return 1
    records = _prepare(rows, faculty)
    for record in records:
        record["seed_dataset_sha256"] = digest
    inserted = research_records.insert_many(records, ordered=True).inserted_ids
    showcase_count = _insert_showcases(records, faculty)
    inserted_rows = list(research_records.find({"seed_batch": SEED_BATCH}, {"category": 1, "verification_status": 1}))
    final_counts: dict[str, int] = {}
    state_counts: dict[str, int] = {}
    for row in inserted_rows:
        final_counts[row["category"]] = final_counts.get(row["category"], 0) + 1
        state_counts[row["verification_status"]] = state_counts.get(row["verification_status"], 0) + 1
    print(f"Inserted {len(inserted)} research records and {showcase_count} showcases.")
    print(f"By category: {dict(sorted(final_counts.items()))}")
    print(f"By workflow state: {dict(sorted(state_counts.items()))}")
    print(f"Mapped Faculty Slot values across {len(faculty)} active teacher accounts; no accounts were created or changed.")
    print("Cleanup: python backend/scripts/cleanup_research_dashboard_test.py --yes")
    return 0 if len(inserted_rows) == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
