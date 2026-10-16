"""Insert marked sample records for the current Event Manager Research UI.

Run from ``backend`` (see ``docs/research-ui-demo-seed.md``). This creates
only verified Event Manager records, so they appear in the Event Manager
portfolio and the Dean's Event Manager submissions view without creating an
approval workflow. Existing users and records are never updated.
"""

from __future__ import annotations

import argparse
import os
import random
import re
import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import _MONGODB_DB_NAME, _MONGODB_URI, research_records, users  # noqa: E402
from app.models.documents import new_history_entry, new_research_record_document  # noqa: E402
from app.services.research_categories import CATEGORIES, clean_details  # noqa: E402

SEED_BATCH = "research-ui-sample-20261013-v1"
SEED_MARKER = "seed_research_ui_demo.py"
TITLE_PREFIX = "[RESEARCH UI SAMPLE]"
DEFAULT_COUNT = 125
MIN_COUNT = 100
MAX_COUNT = 500
CATEGORY_KEYS = ("journal", "conference", "patent", "book", "other")

TOPICS = (
    "Himalayan medicinal plants and antimicrobial resistance",
    "machine learning for early detection of diabetic retinopathy",
    "spring-water monitoring in Uttarakhand mountain communities",
    "pine-needle biochar for removing metals from river water",
    "renewable energy systems for remote Himalayan villages",
    "privacy-preserving analytics for regional hospital networks",
    "climate-resilient crops for high-altitude agriculture",
    "low-cost diagnostic tools for community health programmes",
    "earthquake resilience in traditional mountain construction",
    "biodiversity conservation in the western Himalaya",
    "smart irrigation for terrace farming",
    "digital learning access in rural communities",
    "sustainable materials for affordable housing",
    "air-quality forecasting for growing hill towns",
    "biodegradable packaging made from local agricultural crops",
)

JOURNALS = (
    "Journal of Mountain Science",
    "Environmental Monitoring and Assessment",
    "Indian Journal of Public Health Research",
    "International Journal of Sustainable Engineering",
    "Himalayan Journal of Applied Sciences",
)
CONFERENCES = (
    ("International Conference on Sustainable Mountain Development", "IIT Roorkee", "International"),
    ("National Symposium on Himalayan Biodiversity", "Wildlife Institute of India", "National"),
    ("Conference on Digital Health and Rural Care", "AIIMS Rishikesh", "National"),
    ("International Forum on Clean Energy Systems", "IEEE India Council", "International"),
    ("Uttarakhand Research and Innovation Conference", "SRHU", "State"),
)
PUBLISHERS = ("Springer Nature", "Wiley", "Elsevier", "Routledge", "Oxford University Press", "Sage")
ACHIEVEMENTS = (
    ("Award / honour", "Uttarakhand State Science Council", "Recognition for applied research and community impact"),
    ("Fellowship", "Indian National Science Academy", "Research fellowship in interdisciplinary health sciences"),
    ("PhD supervision", "Swami Rama Himalayan University", "Doctoral scholar completed a study in public health"),
    ("Editorial board / reviewer", "Journal of Mountain Science", "Invited editorial and peer-review contribution"),
    ("Consultancy", "Uttarakhand Jal Sansthan", "Technical advice for community water-quality monitoring"),
    ("Copyright / design registration", "Copyright Office, Government of India", "Educational resource for rural health training"),
    ("Invited talk", "IIT Mandi", "Invited lecture on resilient mountain communities"),
    ("MoU / collaboration", "Wadia Institute of Himalayan Geology", "Collaborative research programme in the western Himalaya"),
)
COAUTHORS = (
    "A. Sharma", "P. Verma", "R. Kumar", "S. Gupta", "N. Chauhan", "M. Dobhal",
    "K. Uniyal", "D. Semwal", "H. Rana", "L. Nautiyal", "J. Fernandes", "T. Okafor",
)


def _display_target() -> str:
    # Do not print credentials from mongodb://user:password@host URIs.
    authority = _MONGODB_URI.split("://", 1)[-1].split("/", 1)[0].split("?", 1)[0]
    host = authority.rsplit("@", 1)[-1]
    return f"{host} / database '{_MONGODB_DB_NAME}'"


def _is_local_or_test_target() -> bool:
    name = _MONGODB_DB_NAME.casefold()
    authority = _MONGODB_URI.split("://", 1)[-1].split("/", 1)[0].split("?", 1)[0]
    host = authority.rsplit("@", 1)[-1].casefold()
    named_test_target = bool(re.search(r"(^|[_-])(test|dev|demo|sandbox|local)([_-]|$)", name))
    local_host = host.startswith(("localhost", "127.0.0.1", "[::1]"))
    return named_test_target or local_host


def confirm_write(action: str, database_confirmation: str | None, allow_non_test_db: bool) -> bool:
    print(f"Target: {_display_target()}")
    safe_target = _is_local_or_test_target()
    if not safe_target and not allow_non_test_db:
        print("Refusing to write to a non-test target. Pass --allow-non-test-db to opt in explicitly.")
        return False
    if database_confirmation is not None:
        if database_confirmation == _MONGODB_DB_NAME:
            return True
        print(f"Database confirmation did not match {_MONGODB_DB_NAME!r}. Nothing changed.")
        return False
    answer = input(f"Type the database name ({_MONGODB_DB_NAME}) to {action}: ").strip()
    if answer != _MONGODB_DB_NAME:
        print("Not confirmed. Nothing changed.")
        return False
    return True


def _day_for(index: int, rng: random.Random, today: date) -> date:
    if (index - 1) % len(CATEGORY_KEYS) == 2:
        # Leave enough time for the sample grants' publication and grant dates.
        first = date(2021, 1, 1)
        last = date(2023, 12, 31)
    else:
        first = date(2022, 1, 1)
        last = today - timedelta(days=1)
    return first + timedelta(days=rng.randrange((last - first).days + 1))


def _record_content(category_key: str, number: int, faculty_name: str, record_day: date, rng: random.Random):
    topic = TOPICS[(number * 7) % len(TOPICS)]
    category = CATEGORIES[category_key]

    if category_key == "journal":
        outcome = rng.choice(("accepted", "in_press", "published"))
        details = {
            "author_position": rng.choice(category.fields[0].options),
            "journal": rng.choice(JOURNALS),
            "indexing": rng.sample(("Scopus", "Web of Science", "UGC-CARE", "PubMed", "Google Scholar"), rng.randint(1, 3)),
            "quartile": rng.choice(("Q1", "Q2", "Q3", "Q4")),
        }
        if number % 3 == 0:
            details["doi"] = f"10.5555/srhu-ui-sample.{number:04d}"
        title = f"A study of {topic}"
    elif category_key == "conference":
        outcome = rng.choice(("accepted", "presented", "published"))
        conference, organiser, level = rng.choice(CONFERENCES)
        details = {
            "presentation_type": rng.choice(CATEGORIES[category_key].fields[0].options),
            "conference": conference,
            "organiser": organiser,
            "level": level,
            "end_date": (record_day + timedelta(days=rng.randint(1, 2))).isoformat(),
        }
        title = f"{topic.title()} at {conference}"
    elif category_key == "patent":
        latest_patent_outcome = "granted" if record_day.year <= 2022 else "published" if record_day.year <= 2024 else "filed"
        outcome = rng.choice(("filed", "published", latest_patent_outcome))
        faculty_short = faculty_name.removeprefix("Dr. ")
        details = {
            "inventors": f"{faculty_short}, {rng.choice(COAUTHORS)} and {rng.choice(COAUTHORS)}",
            "office": "India (IPO)",
            "application_number": f"IN{record_day.year}{number:07d}",
        }
        if outcome in ("published", "granted"):
            publication_day = min(record_day + timedelta(days=365), date.today())
            details["publication_date"] = publication_day.isoformat()
        if outcome == "granted":
            grant_day = min(record_day + timedelta(days=900), date.today())
            details.update(grant_date=grant_day.isoformat(), patent_number=f"IN-{record_day.year}-{number:06d}")
        title = f"A system for {topic}"
    elif category_key == "book":
        outcome = rng.choice(("accepted", "published"))
        book_type = rng.choice(CATEGORIES[category_key].fields[0].options)
        details = {
            "book_type": book_type,
            "authors": f"{faculty_name}, {rng.choice(COAUTHORS)}",
            "publisher": rng.choice(PUBLISHERS),
        }
        if book_type == "Book chapter":
            details["book_title"] = f"Advances in {topic}"
            title = f"Chapter: {topic.title()}"
        else:
            title = f"{topic.title()}: Research and Practice"
    else:
        outcome = "recorded"
        kind, organisation, description = ACHIEVEMENTS[(number * 3) % len(ACHIEVEMENTS)]
        details = {"kind": kind, "awarded_by": organisation, "description": description}
        details["level"] = rng.choice(CATEGORIES[category_key].fields[2].options)
        title = f"{kind}: {topic.title()}"

    cleaned, missing = clean_details(category, details, outcome)
    if missing:
        raise ValueError(f"Generated {category_key} record is incomplete: {', '.join(missing)}")
    return category, outcome, cleaned, title


def build_records(count: int, faculty: list[dict], manager: dict, *, today: date | None = None) -> list[dict]:
    """Create valid, deterministic-by-count records without touching MongoDB."""
    if count < MIN_COUNT or count > MAX_COUNT:
        raise ValueError(f"count must be between {MIN_COUNT} and {MAX_COUNT}")
    if not faculty:
        raise ValueError("At least one active teacher account is required")
    if manager.get("role") != "event_manager" or not manager.get("id"):
        raise ValueError("A real Event Manager account is required")

    current_day = today or datetime.now(timezone.utc).date()
    rng = random.Random(20261013 + count)
    records: list[dict] = []
    for number in range(1, count + 1):
        category_key = CATEGORY_KEYS[(number - 1) % len(CATEGORY_KEYS)]
        faculty_member = faculty[(number - 1) % len(faculty)]
        record_day = _day_for(number, rng, current_day)
        category, outcome, details, title = _record_content(category_key, number, faculty_member["name"], record_day, rng)
        marked_title = f"{TITLE_PREFIX} {number:04d} | {title}"
        record = new_research_record_document(
            faculty_id=faculty_member["id"],
            created_by=manager,
            category=category_key,
            title=marked_title,
            record_date=record_day.isoformat(),
            outcome_status=outcome,
            details=details,
            abstract=f"Sample research record for interface review: {topic_sentence(title)}",
        )
        now = datetime.now(timezone.utc)
        record.update(
            seed_batch=SEED_BATCH,
            seed_generated_by=SEED_MARKER,
            seed_created_at=now,
            verification_status="verified",
            submitted_at=now,
            verified_at=now,
            verified_by={"id": manager["id"], "name": manager["name"], "role": "event_manager"},
        )
        record["history"] = [
            new_history_entry(action="created", status="draft", actor=manager, note="Created as marked UI sample data."),
            new_history_entry(
                action="recorded",
                status="verified",
                from_status="draft",
                actor=manager,
                note="Seeded as an Event Manager record; no Dean approval is required.",
            ),
        ]
        snapshot_keys = ("title", "record_date", "outcome_status", "details", "abstract", "link")
        record["verified_snapshot"] = {key: record.get(key) for key in snapshot_keys}
        record["verified_snapshot"]["evidence"] = []
        records.append(record)
    return records


def topic_sentence(title: str) -> str:
    return f"{title.rstrip('.')} is represented here with sample metadata for checking the existing Research pages."


def _active_users() -> tuple[list[dict], dict | None]:
    faculty = [
        {"id": str(user["_id"]), "name": user.get("name") or user.get("email") or "Faculty member"}
        for user in users.find(
            {"role": "teacher", "is_active": {"$ne": False}},
            {"_id": 1, "name": 1, "email": 1},
        )
    ]
    event_manager = users.find_one(
        {"role": "event_manager", "is_active": {"$ne": False}},
        {"_id": 1, "name": 1, "email": 1},
    )
    manager = (
        {"id": str(event_manager["_id"]), "name": event_manager.get("name") or event_manager.get("email"), "role": "event_manager"}
        if event_manager
        else None
    )
    return faculty, manager


def _marked_records() -> list[dict]:
    return list(research_records.find({"seed_batch": SEED_BATCH, "seed_generated_by": SEED_MARKER}, {"category": 1, "verification_status": 1}))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("status", help="Show this seed batch's current record count")
    seed = subparsers.add_parser("seed", help=f"Insert {MIN_COUNT}-{MAX_COUNT} sample records")
    seed.add_argument("--count", type=int, default=DEFAULT_COUNT)
    seed.add_argument("--confirm-db", help="Exact target database name confirmation")
    seed.add_argument("--allow-non-test-db", action="store_true", help="Allow a non-test target after explicit database confirmation")
    args = parser.parse_args()

    if args.command == "status":
        rows = _marked_records()
        print(f"Target: {_display_target()}")
        print(f"Seed batch: {SEED_BATCH}; records: {len(rows)}")
        print(f"By category: {dict(sorted(Counter(row.get('category', 'unknown') for row in rows).items()))}")
        return 0

    if not MIN_COUNT <= args.count <= MAX_COUNT:
        parser.error(f"--count must be between {MIN_COUNT} and {MAX_COUNT}")
    if _marked_records():
        print(f"Seed batch {SEED_BATCH} already exists. Run the cleanup script before reseeding.")
        return 1
    if not confirm_write("insert this sample-data batch", args.confirm_db, args.allow_non_test_db):
        return 1

    faculty, manager = _active_users()
    if not faculty:
        print("No active teacher accounts were found. Nothing was inserted.")
        return 1
    if not manager:
        print("No active Event Manager account was found. Nothing was inserted.")
        return 1

    records = build_records(args.count, faculty, manager)
    inserted = research_records.insert_many(records, ordered=True).inserted_ids
    seeded = _marked_records()
    by_category = Counter(row.get("category", "unknown") for row in seeded)
    print(f"Target: {_display_target()}")
    print(f"Inserted {len(inserted)} marked Event Manager records across {len(by_category)} categories.")
    print(f"By category: {dict(sorted(by_category.items()))}")
    print("All records are verified by the Event Manager and visible through the existing panels.")
    print("Cleanup dry run: python scripts/cleanup_research_ui_demo.py")
    return 0 if len(inserted) == args.count and set(by_category) == set(CATEGORY_KEYS) else 1


if __name__ == "__main__":
    sys.exit(main())
