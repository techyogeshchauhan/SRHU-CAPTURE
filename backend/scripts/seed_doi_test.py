"""Save research records fetched from a list of test DOIs, and remove them again.

Every input below goes through the system's own DOI path -- the same code the
"Fill from DOI" box uses (normalize_doi, then lookup_doi against Crossref) --
and is reported as passing or failing. Each distinct paper that passes is saved
once as a research record, so the inputs that name the same paper (a bare DOI,
its doi.org link, a "DOI:" label...) give one record, not one each.

How the test data is kept apart from real data
-----------------------------------------------
* Every document this script inserts carries ``seed_batch: "doi-test"``.
* The records belong to one new test teacher, "DOI Test Faculty (Test)",
  on ``doi-test.example.com`` (reserved; never receives mail). No record is
  attached to a real teacher, and nothing existing is updated.
* The records are saved as drafts, entered by a placeholder Event Manager
  ("DOI import test (seed data)"): Crossref cannot say how the paper is
  indexed or the teacher's authorship, which a submission needs. The Event
  Manager sees them under Research -> Draft.

What ``remove`` deletes -- exact ids collected first, then only those:
* the test teacher (tagged AND on the test domain) with anything they own;
* research records that are tagged or belong to the test teacher (so records
  you add for them while testing go too), with their evidence files;
* notifications and audit-log entries about those records or that account.

Usage (from the backend directory, against the database in backend/.env):
    python scripts/seed_doi_test.py check                 # pass/fail for every input, no writes
    python scripts/seed_doi_test.py seed                  # saves the papers that pass
    python scripts/seed_doi_test.py status
    python scripts/seed_doi_test.py remove                # dry run: shows what would go
    python scripts/seed_doi_test.py remove --yes          # deletes it
``seed`` and ``remove --yes`` show the target database and ask you to type its
name first (or pass --confirm-db <name>).
"""

from __future__ import annotations

import argparse
import os
import re
import secrets
import sys
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env", override=False)
sys.path.insert(0, str(BACKEND_DIR))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from app.config import settings  # noqa: E402
from app.database import (  # noqa: E402
    _MONGODB_DB_NAME,
    _MONGODB_URI,
    audit_logs,
    notifications,
    research_records,
    users,
)
from app.models.documents import (  # noqa: E402
    new_history_entry,
    new_research_record_document,
    new_user_document,
)
from app.services.research_categories import CATEGORIES, clean_details_leniently  # noqa: E402
from app.services.research_doi import DoiError, lookup_doi  # noqa: E402
from app.services.research_identifiers import identifiers_of  # noqa: E402
from app.services.storage_service import delete_stored, delete_user_cascade  # noqa: E402
from app.utils.security import hash_password  # noqa: E402

TAG = "doi-test"
DOMAIN = "doi-test.example.com"
EMAIL_PATTERN = rf"@{re.escape(DOMAIN)}$"
ENTERED_BY = {"id": None, "name": "DOI import test (seed data)", "role": "event_manager"}
NOTE = "Test data from scripts/seed_doi_test.py"

# The inputs to test, exactly as they were given.
INPUTS = [
    "10.1038/nature14236",
    "https://doi.org/10.1038/nature14236",
    "http://doi.org/10.1038/nature14236",
    "DOI: 10.1038/nature14236",
    "doi:10.1038/nature14236",
    "https://dx.doi.org/10.1038/nature14236",
    "10.1038/nature16961",
    "https://doi.org/10.1038/nature16961",
    "DOI: https://doi.org/10.1038/nature16961",
    "10.1103/PhysRevLett.116.061102",
    "https://doi.org/10.1103/PhysRevLett.116.061102",
    "DOI: 10.1103/PhysRevLett.116.061102",
    "10.1038/nature24270",
    "https://doi.org/10.1038/nature24270",
    "DOI: https://doi.org/10.1038/nature24270",
    "Research Paper DOI: 10.1038/nature14236",
    "Please fetch this paper 10.1038/nature16961",
    "Publication DOI is 10.1038/nature24270. Please fetch details.",
    "Paper reference — DOI: 10.1103/PhysRevLett.116.061102",
    "Find metadata for https://doi.org/10.1038/nature14236",
    "The DOI is (10.1038/nature16961)",
    "DOI [10.1038/nature24270]",
    "Paper DOI: https://doi.org/10.1103/PhysRevLett.116.061102.",
    "Publication link: https://doi.org/10.1038/nature14236 — import paper",
    "Reference: 10.1038/nature16961; fetch title and authors",
    "https://www.nature.com/articles/nature14236",
    "https://www.nature.com/articles/nature16961",
    "https://www.nature.com/articles/nature24270",
    "https://link.springer.com/article/10.1007/s00134-020-06022-5",
    "https://www.science.org/doi/10.1126/science.aaa8415",
    "https://journals.plos.org/plosbiology/article?id=10.1371/journal.pbio.0000057",
    "https://doi.org/10.1038/nature14236?source=testing",
    "https://doi.org/10.1038/nature16961?utm_source=test",
    "Publisher page: https://www.nature.com/articles/nature24270",
    "Paper URL: https://www.science.org/doi/10.1126/science.aaa8415",
    "  10.1038/nature14236  ",
    " DOI: 10.1038/nature16961",
    "https://doi.org/10.1038/nature24270 ",
    "doi: 10.1103/PhysRevLett.116.061102",
    "DOI — 10.1038/nature14236",
    "Paper DOI (URL): https://doi.org/10.1038/nature16961",
    "https://dx.doi.org/10.1038/nature24270",
    "https://doi.org/10.1103/PhysRevLett.116.061102",
    "Research: https://doi.org/10.1038/nature14236 (published paper)",
    "Title unknown; DOI = 10.1038/nature16961",
    "10.9999/this-doi-does-not-exist",
    "https://doi.org/10.9999/this-doi-does-not-exist",
    "DOI: not available",
    "https://example.com/research-paper",
    "doi.org/10.1038/nature14236",
    "https://doi.org/",
    "10.",
    "10.1038",
    "https://doi.org/invalid",
    "DOI: 10.1038/nature14236; DOI: 10.1038/nature16961",
    "https://doi.org/10.1038/nature14236 and https://doi.org/10.1038/nature16961",
    "10.1038/nature14236",
    "https://doi.org/10.1038/nature14236.",
    "https://doi.org/10.1038/nature14236)",
    "DOI: https://doi.org/10.1038/nature14236 — Research Paper",
]


# ---------------------------------------------------------------- helpers

def _target() -> str:
    rest = _MONGODB_URI.split("://", 1)[-1]
    host = rest.split("/", 1)[0].split("?", 1)[0].rsplit("@", 1)[-1]  # never the credentials
    return f"{host} / database '{_MONGODB_DB_NAME}'"


def _confirm(action: str, given: str | None) -> bool:
    print(f"Target: {_target()}")
    if given is not None:
        if given == _MONGODB_DB_NAME:
            return True
        print(f"--confirm-db {given!r} does not match the target database {_MONGODB_DB_NAME!r}. Nothing done.")
        return False
    answer = input(f"Type the database name ({_MONGODB_DB_NAME}) to {action}: ").strip()
    if answer != _MONGODB_DB_NAME:
        print("Not confirmed. Nothing done.")
        return False
    return True


def check_inputs() -> tuple[list[dict], dict[str, dict]]:
    """(one row per input, the passing papers by DOI). Read-only."""
    rows, papers = [], {}
    for n, raw in enumerate(INPUTS, 1):
        try:
            found = lookup_doi(raw)
        except DoiError as error:
            rows.append({"n": n, "input": raw, "ok": False, "why": str(error)})
            continue
        rows.append({"n": n, "input": raw, "ok": True, "doi": found["doi"], "title": found.get("title")})
        papers.setdefault(found["doi"], found)
    return rows, papers


def _print_check(rows: list[dict]) -> None:
    for row in rows:
        shown = row["input"].strip()[:70]
        if row["ok"]:
            print(f"PASS {row['n']:2}  {shown!r:74} -> {row['doi']}")
        else:
            print(f"FAIL {row['n']:2}  {shown!r:74} -> {row['why']}")
    passed = sum(1 for row in rows if row["ok"])
    print(f"\n{passed} passed, {len(rows) - passed} failed, of {len(rows)} inputs.")


def test_user_ids() -> list[str]:
    """The test teacher: tagged AND on the test domain -- both, never one."""
    return [str(u["_id"]) for u in users.find({"seed_batch": TAG, "email": {"$regex": EMAIL_PATTERN}}, {"_id": 1})]


def removal_plan() -> dict:
    people = test_user_ids()
    records = list(research_records.find(
        {"$or": [{"seed_batch": TAG}, {"faculty_id": {"$in": people}}]}, {"_id": 1, "evidence": 1, "title": 1}
    ))
    record_ids = [str(r["_id"]) for r in records]
    note_query = {"$or": [{"user_id": {"$in": people}}, {"data.research_id": {"$in": record_ids}}]}
    audit_query = {"target_id": {"$in": record_ids + people}}
    anything = bool(people or record_ids)
    return {
        "people": people, "records": records, "record_ids": record_ids,
        "note_query": note_query, "audit_query": audit_query,
        "notification_count": notifications.count_documents(note_query) if anything else 0,
        "audit_count": audit_logs.count_documents(audit_query) if anything else 0,
    }


# ------------------------------------------------------------- commands

def cmd_check(_args) -> int:
    rows, papers = check_inputs()
    _print_check(rows)
    print(f"{len(papers)} distinct papers would be saved by `seed`.")
    return 0


def cmd_seed(args) -> int:
    if users.count_documents({"seed_batch": TAG}) or research_records.count_documents({"seed_batch": TAG}):
        print("DOI test data is already in this database. Run `remove --yes` first to seed it afresh.")
        return 1
    rows, papers = check_inputs()
    _print_check(rows)
    if not papers:
        print("No input passed, so nothing to save.")
        return 1
    if not _confirm(f"save {len(papers)} research records from these DOIs", args.confirm_db):
        return 1

    email = f"doi.test.faculty@{DOMAIN}"
    if users.find_one({"email": email}):
        print(f"{email} already has an account, so nothing was saved.")
        return 1
    password = args.password or f"Test-{secrets.token_urlsafe(9)}"
    teacher = new_user_document(
        name="DOI Test Faculty (Test)", email=email, password_hash=hash_password(password), role="teacher",
        email_verified=True, designation="Assistant Professor", department=settings.default_host_department,
    )
    teacher["seed_batch"] = TAG
    faculty_id = str(users.insert_one(teacher).inserted_id)

    saved = []
    for doi, found in papers.items():
        category = CATEGORIES[found["category"]]
        details = clean_details_leniently(category, found["details"], found["outcome_status"])
        record = new_research_record_document(
            faculty_id=faculty_id,
            created_by=ENTERED_BY,
            category=category.key,
            title=found.get("title") or doi,
            record_date=found.get("record_date"),
            outcome_status=found.get("outcome_status") or category.outcomes[0][0],
            details=details,
            abstract=found.get("abstract"),
            link=found.get("link"),
        )
        record["seed_batch"] = TAG
        record["identifiers"] = identifiers_of(category.key, record["title"], details)
        record["history"] = [new_history_entry(action="created", status="draft", actor=ENTERED_BY, note=NOTE)]
        research_records.insert_one(record)
        saved.append((doi, category.short, record["title"]))

    print(f"\nSaved {len(saved)} research records (drafts) for DOI Test Faculty (Test):")
    for doi, kind, title in saved:
        print(f"    {doi:34} {kind:11} {title[:70]}")
    print(f"\nThe test teacher can sign in as {email} with: {password}")
    print("When you have finished testing:  python scripts/seed_doi_test.py remove --yes")
    return 0


def cmd_status(_args) -> int:
    print(f"Target: {_target()}")
    plan = removal_plan()
    print(f"Test teacher accounts: {len(plan['people'])}")
    print(f"Test research records: {len(plan['record_ids'])}")
    for record in plan["records"]:
        print(f"    {record.get('title', '')[:80]}")
    return 0


def cmd_remove(args) -> int:
    plan = removal_plan()
    print(f"Target: {_target()}")
    print(f"Test teacher accounts:    {len(plan['people'])} (with anything they own)")
    print(f"Test research records:    {len(plan['record_ids'])}")
    print(f"Notifications about them: {plan['notification_count']}")
    print(f"Audit entries about them: {plan['audit_count']}")
    if not (plan["people"] or plan["record_ids"]):
        print("\nNo DOI test data here. Nothing to remove.")
        return 0
    if not args.yes:
        print("\nDry run: nothing deleted. Run with --yes to delete exactly the above.")
        return 0
    if not _confirm("delete the DOI test data listed above", args.confirm_db):
        return 1

    for record in plan["records"]:
        for evidence in record.get("evidence") or []:
            delete_stored(evidence)
    gone = research_records.delete_many({"_id": {"$in": [r["_id"] for r in plan["records"]]}}).deleted_count
    notes = notifications.delete_many(plan["note_query"]).deleted_count
    audits = audit_logs.delete_many(plan["audit_query"]).deleted_count
    for user_id in plan["people"]:
        delete_user_cascade(user_id)
    left = users.count_documents({"seed_batch": TAG}) + research_records.count_documents({"seed_batch": TAG})
    print(f"\nDeleted {gone} records, {notes} notifications, {audits} audit entries "
          f"and {len(plan['people'])} test account(s).")
    return 0 if not left else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="Pass/fail for every input (no writes)")
    seed = sub.add_parser("seed", help="Save the papers that pass")
    seed.add_argument("--password", help="Password for the test teacher (default: a random one)")
    seed.add_argument("--confirm-db", help="Skip the prompt: the target database's name")
    sub.add_parser("status", help="Count the DOI test data in the database")
    remove = sub.add_parser("remove", help="Delete the DOI test data (a dry run without --yes)")
    remove.add_argument("--yes", action="store_true", help="Delete (default: only show what would go)")
    remove.add_argument("--confirm-db", help="Skip the prompt: the target database's name")
    args = parser.parse_args()
    return {"check": cmd_check, "seed": cmd_seed, "status": cmd_status, "remove": cmd_remove}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
