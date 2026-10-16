"""Seed demo research data for testing the Research workflow, and remove it again.

Creates about 80 dummy research records (50-100 with --count) across every
category and every stage of the workflow: drafts, records waiting for the
Dean, records sent back for changes, rejected, verified by the Dean, and
recorded by the Event Manager. The records belong to eight demo faculty
members, and two demo showcases (one sent to the Dean) use them. The
frontend reads all of it through the normal API; nothing is hardcoded in the
UI.

How the dummy data is kept apart from real data
-----------------------------------------------
* Every document this script inserts carries ``seed_batch: "research-demo"``.
* The demo faculty are new accounts with addresses on
  ``research-demo.example.com`` (example.com is reserved by IANA and never
  receives mail; ``.invalid`` would be safer still, but the sign-in form's
  email validation refuses it, so demo teachers could not log in), named
  "... (Demo)". No record is ever attached to a real teacher.
* Every title starts with "[Demo]" and every DOI uses 10.5555, Crossref's
  test prefix, so nothing collides with a real paper.
* The Dean and Event Manager steps in the records' history are signed by
  placeholder actors ("Demo Dean (seed data)"), never by a real account.
* Nothing existing is updated. The script only inserts, and ``remove`` only
  deletes what it can prove is demo data (see below).

What ``remove`` deletes
-----------------------
It first collects exact ids, then deletes only those:
* the demo faculty accounts -- tagged AND on the reserved domain -- with
  anything they own (via the standard user cascade);
* research records that are tagged, or that belong to a demo faculty member
  (so records you add for them while testing go too), with their evidence
  files;
* showcases that are tagged or owned by a demo faculty member;
* notifications to the demo faculty or about a demo record, and audit-log
  entries about a demo record or account.
A showcase of yours that lists a demo record is reported and left alone
(showcases skip records that no longer exist).

Usage (from the backend directory, against the database in backend/.env):
    python scripts/seed_research_demo.py status
    python scripts/seed_research_demo.py seed [--count 80] [--password ...]
    python scripts/seed_research_demo.py remove            # dry run: shows what would go
    python scripts/seed_research_demo.py remove --yes      # deletes it
``seed`` and ``remove --yes`` show the target database and ask you to type
its name before writing (or pass --confirm-db <name> to skip the prompt).
"""

from __future__ import annotations

import argparse
import os
import random
import re
import secrets
import sys
from datetime import date, datetime, time, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings  # noqa: E402
from app.database import (  # noqa: E402
    _MONGODB_DB_NAME,
    _MONGODB_URI,
    audit_logs,
    notifications,
    research_records,
    research_showcases,
    users,
)
from app.models.documents import (  # noqa: E402
    new_history_entry,
    new_research_record_document,
    new_user_document,
)
from app.routers.research import _snapshot  # noqa: E402
from app.services.research_categories import CATEGORIES, clean_details  # noqa: E402
from app.services.research_identifiers import identifiers_of  # noqa: E402
from app.services.storage_service import delete_stored, delete_user_cascade  # noqa: E402
from app.utils.security import hash_password  # noqa: E402

TAG = "research-demo"
DOMAIN = "research-demo.example.com"
EMAIL_PATTERN = rf"@{re.escape(DOMAIN)}$"
TITLE_PREFIX = "[Demo] "
SEED_NOTE = "Demo data from scripts/seed_research_demo.py"

DEMO_DEAN = {"id": None, "name": "Demo Dean (seed data)", "role": "dean"}
DEMO_MANAGER = {"id": None, "name": "Demo Event Manager (seed data)", "role": "event_manager"}

FACULTY = [
    ("Dr. Aarav Mehta", "Professor", "aarav.mehta"),
    ("Dr. Ishita Rawat", "Associate Professor", "ishita.rawat"),
    ("Dr. Kabir Negi", "Assistant Professor", "kabir.negi"),
    ("Dr. Meenakshi Bisht", "Professor", "meenakshi.bisht"),
    ("Dr. Rohan Joshi", "Assistant Professor", "rohan.joshi"),
    ("Dr. Sana Qureshi", "Associate Professor", "sana.qureshi"),
    ("Dr. Tanvi Pant", "Assistant Professor", "tanvi.pant"),
    ("Dr. Vikram Thapliyal", "Professor", "vikram.thapliyal"),
]

CO_AUTHORS = [
    "A. Sharma", "P. Verma", "R. Kumar", "S. Gupta", "N. Chauhan", "M. Dobhal", "K. Uniyal",
    "D. Semwal", "H. Rana", "L. Nautiyal", "J. Fernandes", "T. Okafor", "Y. Tanaka", "E. Müller",
]

TOPICS = [
    "Machine learning models for early detection of landslides in the Garhwal Himalaya",
    "Low-cost IoT sensor network for monitoring spring discharge in hill villages",
    "Green synthesis of silver nanoparticles from Rhododendron arboreum petals",
    "Deep learning based diabetic retinopathy grading on smartphone fundus images",
    "Biochar from pine needles for heavy-metal removal from mountain streams",
    "Federated learning for privacy-preserving hospital readmission prediction",
    "Solar-assisted cold storage for apple growers in Uttarakhand",
    "Antimicrobial activity of Himalayan medicinal plant extracts against MRSA",
    "Blockchain-backed academic credential verification for Indian universities",
    "Spatio-temporal analysis of glacier retreat using Sentinel-2 imagery",
    "Graphene oxide membranes for low-energy water desalination",
    "Natural language processing for Garhwali speech transcription",
    "Microbial fuel cells from agricultural waste for rural electrification",
    "Edge computing framework for real-time traffic management on hill roads",
    "CRISPR-based detection of plant pathogens in millet crops",
    "Explainable AI for credit-risk assessment in microfinance",
    "Phytochemical profiling of Berberis aristata root extracts",
    "Lightweight cryptography for wearable health monitors",
    "Seismic vulnerability assessment of heritage temples in Kedarnath valley",
    "Drone-based precision spraying for terrace farming",
    "Polymer composites reinforced with hemp fibre for low-cost housing",
    "Quantum-inspired optimisation for hospital nurse rostering",
    "Air quality forecasting in Dehradun using LSTM networks",
    "Biodegradable packaging films from mandua (finger millet) starch",
    "Cyber-physical security of smart micro-grids in remote villages",
]

JOURNALS = [
    ("Journal of Mountain Science", "Springer", "1672-6316"),
    ("Environmental Monitoring and Assessment", "Springer", "0167-6369"),
    ("Scientific Reports", "Nature Portfolio", "2045-2322"),
    ("IEEE Access", "IEEE", "2169-3536"),
    ("Journal of Cleaner Production", "Elsevier", "0959-6526"),
    ("Current Science", "Current Science Association", "0011-3891"),
    ("Indian Journal of Chemistry", "NISCAIR", "0975-0983"),
    ("Computers in Biology and Medicine", "Elsevier", "0010-4825"),
]

CONFERENCES = [
    ("International Conference on Sustainable Mountain Technologies (ICSMT)", "IIT Roorkee", "Roorkee, India"),
    ("IEEE International Conference on Computing, Communication and Automation", "IEEE UP Section", "Greater Noida, India"),
    ("National Conference on Himalayan Biodiversity", "GB Pant National Institute", "Almora, India"),
    ("International Symposium on Green Chemistry", "Royal Society of Chemistry", "Online"),
    ("ACM India Joint International Conference on Data Science", "ACM India", "Bengaluru, India"),
    ("International Conference on Smart Grids and Energy Systems", "IEEE PES", "Singapore"),
]

PUBLISHERS = ["Springer Nature", "CRC Press", "Elsevier", "Wiley", "Narosa Publishing House", "IGI Global"]

OTHER_KINDS = [
    ("Award / honour", "Indian Science Congress Association"),
    ("Fellowship", "Indian National Science Academy"),
    ("PhD supervision", "Swami Rama Himalayan University"),
    ("Editorial board / reviewer", "Journal of Mountain Science"),
    ("Consultancy", "Uttarakhand Jal Sansthan"),
    ("Copyright / design registration", "Copyright Office, Government of India"),
    ("Invited talk", "IIT Mandi"),
    ("MoU / collaboration", "Wadia Institute of Himalayan Geology"),
]

# The share of each workflow stage, and of each category, in a batch.
PLANS = (
    ["verified_dean"] * 25 + ["recorded_manager"] * 20 + ["submitted"] * 12 + ["resubmitted"] * 3
    + ["changes_requested"] * 6 + ["rejected"] * 4 + ["draft_teacher"] * 6 + ["draft_manager"] * 4
)
CATEGORY_MIX = ["journal"] * 28 + ["conference"] * 16 + ["patent"] * 10 + ["book"] * 8 + ["other"] * 8

CHANGE_NOTES = [
    "Please attach the acceptance letter and correct the page numbers.",
    "The ISSN does not match the journal; please check it.",
    "Add the sanction order number from the letter.",
    "Indexing proof is missing for Scopus.",
]
REJECT_NOTES = [
    "This is a duplicate of an existing record.",
    "A conference attendance certificate is not a paper presentation.",
    "The work was published before joining SRHU.",
]


# ---------------------------------------------------------------- helpers

def _target() -> str:
    # mongodb[+srv]://[user:password@]host[:port][/db][?options] -> host only;
    # the credentials are never printed.
    rest = _MONGODB_URI.split("://", 1)[-1]
    host = rest.split("/", 1)[0].split("?", 1)[0].rsplit("@", 1)[-1]
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


def _stamp(day: date, rng: random.Random) -> datetime:
    """A moment on `day` (UTC), never in the future."""
    moment = datetime.combine(day, time(rng.randint(4, 12), rng.randint(0, 59)), tzinfo=timezone.utc)
    return min(moment, datetime.now(timezone.utc) - timedelta(minutes=5))


def _day(rng: random.Random, start: date, end: date) -> date:
    return start + timedelta(days=rng.randint(0, max(0, (end - start).days)))


def _authors(rng: random.Random, faculty_name: str) -> tuple[str, str]:
    """(author list, the faculty member's position on it)."""
    me = faculty_name.removeprefix("Dr. ")
    others = rng.sample(CO_AUTHORS, rng.randint(1, 4))
    position = rng.choice(["First author", "First author", "Corresponding author", "Co-author"])
    if position == "Co-author":
        others.insert(rng.randint(1, len(others)), me)
        names = others
    else:
        names = [me, *others]
    return ", ".join(names), position


# ------------------------------------------------------- record contents

def _journal(rng, n, faculty_name, today, final):
    day = _day(rng, date(2022, 7, 1), today)
    journal, publisher, issn = rng.choice(JOURNALS)
    authors, position = _authors(rng, faculty_name)
    outcome = rng.choice(["published", "published", "published", "in_press", "accepted"])
    first = rng.randint(1, 900)
    indexing = rng.sample(["Scopus", "Web of Science", "UGC-CARE", "PubMed", "Google Scholar"], rng.randint(1, 3))
    details = {
        "authors": authors, "author_position": position, "journal": journal, "publisher": publisher,
        "issn": issn, "indexing": indexing, "quartile": rng.choice(["Q1", "Q2", "Q2", "Q3"]),
        "impact_factor": round(rng.uniform(1.2, 6.8), 2),
    }
    if outcome == "published":
        details.update(volume=str(rng.randint(8, 80)), issue=str(rng.randint(1, 12)),
                       pages=f"{first}–{first + rng.randint(8, 20)}", doi=f"10.5555/srhu-demo.{day.year}.{n:03d}")
    if rng.random() < 0.15:
        details["indexing"] = [*indexing, "Other"]
        details["indexing_other"] = rng.choice(["DOAJ", "EBSCO", "Index Copernicus"])
    if not final and rng.random() < 0.5:
        details.pop("author_position")  # an unfinished draft
    return rng.choice(TOPICS), day, outcome, details


def _conference(rng, n, faculty_name, today, final):
    day = _day(rng, date(2022, 7, 1), today - timedelta(days=3))
    name, organiser, venue = rng.choice(CONFERENCES)
    authors, _ = _authors(rng, faculty_name)
    outcome = rng.choice(["presented", "published", "published", "accepted"])
    details = {
        "presentation_type": rng.choice(["Oral presentation", "Oral presentation", "Poster", "Invited talk", "Keynote"]),
        "authors": authors, "conference": name, "organiser": organiser,
        "level": "National" if "National" in name else "International",
        "venue": venue, "mode": "Online" if venue == "Online" else rng.choice(["In person", "Hybrid"]),
        "end_date": (day + timedelta(days=rng.randint(1, 3))).isoformat(),
    }
    if outcome == "published":
        details.update(proceedings=f"Proceedings of the {name}", isbn=f"978-81-{rng.randint(10000, 99999)}-{rng.randint(10, 99)}-{rng.randint(0, 9)}",
                       doi=f"10.5555/srhu-demo.conf.{day.year}.{n:03d}")
    return rng.choice(TOPICS), day, outcome, details


def _patent(rng, n, faculty_name, today, final):
    day = _day(rng, date(2021, 1, 1), today - timedelta(days=30))
    me = faculty_name.removeprefix("Dr. ")
    outcome = rng.choice(["filed", "filed", "published", "published", "granted"])
    details = {
        "inventors": ", ".join([me, *rng.sample(CO_AUTHORS, rng.randint(1, 3))]),
        "office": rng.choice(["India (IPO)", "India (IPO)", "India (IPO)", "PCT / WIPO"]),
        "application_number": f"{day.year}11{rng.randint(1000000, 9999999)}",
        "applicant": "Swami Rama Himalayan University",
    }
    if outcome in ("published", "granted"):
        published = min(day + timedelta(days=rng.randint(200, 540)), today)
        details.update(publication_date=published.isoformat(), journal_number=f"{rng.randint(1, 52)}/{published.year}")
    if outcome == "granted":
        granted = min(day + timedelta(days=rng.randint(700, 1300)), today)
        details.update(grant_date=granted.isoformat(), patent_number=str(rng.randint(400000, 560000)))
    topic = rng.choice(TOPICS)
    return f"A system and method for {topic[0].lower()}{topic[1:]}", day, outcome, details


def _project(rng, n, faculty_name, today, final):
    day = _day(rng, date(2021, 7, 1), today - timedelta(days=20))
    outcome = rng.choice(["sanctioned", "ongoing", "ongoing", "completed", "applied"])
    details = {
        "role": rng.choice(["Principal Investigator", "Principal Investigator", "Co-Principal Investigator"]),
        "end_date": (day + timedelta(days=rng.choice([365, 730, 1095]))).isoformat(),
    }
    return rng.choice(TOPICS), day, outcome, details


def _book(rng, n, faculty_name, today, final):
    day = _day(rng, date(2022, 1, 1), today)
    authors, _ = _authors(rng, faculty_name)
    kind = rng.choice(["Book chapter", "Book chapter", "Authored book", "Edited book"])
    outcome = rng.choice(["published", "published", "accepted"])
    topic = rng.choice(TOPICS)
    details = {
        "book_type": kind, "authors": authors, "publisher": rng.choice(PUBLISHERS),
        "level": rng.choice(["International", "National"]),
    }
    if kind == "Book chapter":
        details.update(book_title=f"Advances in {rng.choice(['Mountain Ecology', 'Applied AI', 'Green Chemistry', 'Smart Infrastructure'])}",
                       pages=f"{rng.randint(1, 300)}–{rng.randint(301, 340)}")
    else:
        details["edition"] = rng.choice(["1st", "2nd"])
    if outcome == "published":
        details["isbn"] = f"978-93-{rng.randint(10000, 99999)}-{rng.randint(10, 99)}-{rng.randint(0, 9)}"
    title = topic if kind == "Book chapter" else f"{topic.split(' for ')[0]}: Principles and Practice"
    return title, day, outcome, details


def _other(rng, n, faculty_name, today, final):
    day = _day(rng, date(2022, 7, 1), today)
    kind, body = rng.choice(OTHER_KINDS)
    titles = {
        "Award / honour": "Young Scientist Award", "Fellowship": "Visiting Fellowship",
        "PhD supervision": "PhD awarded to research scholar", "Editorial board / reviewer": "Reviewer for journal",
        "Consultancy": "Water quality consultancy", "Copyright / design registration": "Copyright for learning software",
        "Invited talk": "Invited talk on AI for the Himalaya", "MoU / collaboration": "Research collaboration MoU",
    }
    details = {"kind": kind, "awarded_by": body, "level": rng.choice(["International", "National", "State"]),
               "description": f"{titles[kind]} ({body})."}
    return titles[kind], day, "recorded", details


MAKERS = {
    "journal": _journal, "conference": _conference, "patent": _patent,
    "project": _project, "book": _book, "other": _other,
}


# ------------------------------------------------------------ building

def build_batch(count: int, faculty: list[dict], *, seed: int = 2026, today: date | None = None) -> list[dict]:
    """The demo records (not yet inserted). Every non-draft passes the same
    validation the API applies before a submission."""
    rng = random.Random(seed)
    today = today or date.today()
    plans = [PLANS[i % len(PLANS)] for i in range(count)]
    categories = [CATEGORY_MIX[i % len(CATEGORY_MIX)] for i in range(count)]
    rng.shuffle(plans)
    rng.shuffle(categories)

    records = []
    for n, (plan, key) in enumerate(zip(plans, categories), start=1):
        category = CATEGORIES[key]
        # Signed as the teacher they are, as the API's history would be.
        owner = {**faculty[n % len(faculty)], "role": "teacher"}
        final = not plan.startswith("draft")
        title, day, outcome, raw = MAKERS[key](rng, n, owner["name"].removesuffix(" (Demo)"), today, final)
        details, missing = clean_details(category, raw, outcome)
        if final and missing:
            raise AssertionError(f"demo record {n} ({key}) is missing {missing}")

        by_manager = plan in ("recorded_manager", "draft_manager")
        author = DEMO_MANAGER if by_manager else owner
        record = new_research_record_document(
            faculty_id=owner["id"],
            created_by=author,
            category=key,
            title=f"{TITLE_PREFIX}{title}",
            record_date=day.isoformat(),
            outcome_status=outcome,
            details=details,
            abstract=(f"Demo abstract. This study examines {title[0].lower()}{title[1:]}, "
                      "with field data from Uttarakhand." if key in ("journal", "conference") else None),
            link=f"https://doi.org/{details['doi']}" if details.get("doi") else None,
        )
        record["seed_batch"] = TAG
        record["identifiers"] = identifiers_of(key, record["title"], details)

        # A believable history, oldest first, never in the future.
        created = _stamp(min(day + timedelta(days=rng.randint(2, 40)), today), rng)
        clock = [created]

        def at(days: int) -> datetime:
            clock[0] = min(clock[0] + timedelta(days=days, hours=rng.randint(1, 9)),
                           datetime.now(timezone.utc) - timedelta(minutes=1))
            return clock[0]

        def entry(action: str, status: str, actor: dict, moment: datetime, *, from_status=None, note=None) -> dict:
            item = new_history_entry(action=action, status=status, actor=actor, from_status=from_status, note=note)
            item["created_at"] = moment
            return item

        history = [entry("created", "draft", author, created, note=SEED_NOTE)]
        state = "draft"
        if plan == "recorded_manager":
            moment = at(rng.randint(0, 3))
            history.append(entry("recorded", "verified", DEMO_MANAGER, moment, from_status="draft",
                                 note="Recorded by the Event Manager; no Dean verification needed."))
            state = "verified"
            record.update(submitted_at=moment, verified_at=moment,
                          verified_by={"id": None, "name": DEMO_MANAGER["name"], "role": "event_manager"})
        elif not plan.startswith("draft"):
            moment = at(rng.randint(1, 10))
            history.append(entry("submitted", "submitted", owner, moment, from_status="draft"))
            record["submitted_at"] = moment
            state = "submitted"
            if plan == "resubmitted":
                note = rng.choice(CHANGE_NOTES)
                history.append(entry("changes_requested", "changes_requested", DEMO_DEAN, at(rng.randint(1, 6)),
                                     from_status="submitted", note=note))
                moment = at(rng.randint(1, 6))
                history.append(entry("resubmitted", "submitted", owner, moment, from_status="changes_requested"))
                record["submitted_at"] = moment
            elif plan in ("changes_requested", "rejected", "verified_dean"):
                moment = at(rng.randint(1, 15))
                if plan == "verified_dean":
                    history.append(entry("verified", "verified", DEMO_DEAN, moment, from_status="submitted"))
                    record.update(verified_at=moment, verified_by={"id": None, "name": DEMO_DEAN["name"]})
                    state = "verified"
                else:
                    note = rng.choice(CHANGE_NOTES if plan == "changes_requested" else REJECT_NOTES)
                    history.append(entry(plan, plan, DEMO_DEAN, moment, from_status="submitted", note=note))
                    record["dean_remarks"] = note
                    state = plan

        record["verification_status"] = state
        record["history"] = history
        record["created_at"] = created
        record["updated_at"] = history[-1]["created_at"]
        if state == "verified":
            record["verified_snapshot"] = _snapshot(record)
        records.append(record)
    return records


def _faculty_documents(password: str) -> list[dict]:
    password_hash = hash_password(password)
    documents = []
    for name, designation, handle in FACULTY:
        doc = new_user_document(
            name=f"{name} (Demo)",
            email=f"{handle}@{DOMAIN}",
            password_hash=password_hash,
            role="teacher",
            email_verified=True,
            designation=designation,
            department=settings.default_host_department,
        )
        doc["seed_batch"] = TAG
        documents.append(doc)
    return documents


def _showcases(records: list[dict], faculty: list[dict]) -> list[dict]:
    """Two demo showcases: one sent to the Dean, one still a draft."""
    by_owner: dict[str, list[dict]] = {}
    for record in records:
        if record["verification_status"] == "verified":
            by_owner.setdefault(record["faculty_id"], []).append(record)
    ranked = sorted(by_owner.items(), key=lambda item: len(item[1]), reverse=True)
    names = {person["id"]: person["name"] for person in faculty}
    now = datetime.now(timezone.utc)
    shows = []
    for (owner_id, mine), (title, sent) in zip(ranked, [
        ("[Demo] Research highlights 2025–26", True),
        ("[Demo] Patents and grants portfolio", False),
    ]):
        ids = [str(r["_id"]) for r in mine[:8]]
        shows.append({
            "title": title,
            "description": "Demo showcase from scripts/seed_research_demo.py.",
            "owner_id": owner_id, "owner_name": names.get(owner_id), "owner_role": "teacher",
            "record_ids": ids, "highlight_ids": ids[:2],
            "status": "sent" if sent else "draft",
            "sent_at": now if sent else None, "sent_count": 1 if sent else 0,
            "viewed_by": [], "created_at": now, "updated_at": now,
            "seed_batch": TAG,
        })
    return shows


# ------------------------------------------------------------- actions

def demo_user_ids() -> list[str]:
    """Demo accounts: tagged AND on the reserved domain -- both, never one."""
    return [str(u["_id"]) for u in users.find({"seed_batch": TAG, "email": {"$regex": EMAIL_PATTERN}}, {"_id": 1})]


def removal_plan() -> dict:
    """Exact ids of everything `remove` would delete."""
    people = demo_user_ids()
    record_query = {"$or": [{"seed_batch": TAG}, {"faculty_id": {"$in": people}}]}
    records = list(research_records.find(record_query, {"_id": 1, "evidence": 1, "seed_batch": 1}))
    record_ids = [str(r["_id"]) for r in records]
    showcase_query = {"$or": [{"seed_batch": TAG}, {"owner_id": {"$in": people}}]}
    showcases = [s["_id"] for s in research_showcases.find(showcase_query, {"_id": 1})]
    note_query = {"$or": [{"user_id": {"$in": people}}, {"data.research_id": {"$in": record_ids}}]}
    audit_query = {"target_id": {"$in": record_ids + people}}
    # Showcases that are not demo data but list a demo record: reported, not touched.
    elsewhere = list(research_showcases.find(
        {"_id": {"$nin": showcases}, "record_ids": {"$in": record_ids}}, {"title": 1, "owner_name": 1}
    )) if record_ids else []
    return {
        "people": people, "records": records, "record_ids": record_ids, "showcases": showcases,
        "note_query": note_query, "audit_query": audit_query, "elsewhere": elsewhere,
        "notification_count": notifications.count_documents(note_query) if people or record_ids else 0,
        "audit_count": audit_logs.count_documents(audit_query) if people or record_ids else 0,
        "added_while_testing": sum(1 for r in records if r.get("seed_batch") != TAG),
        "evidence_files": sum(len(r.get("evidence") or []) for r in records),
    }


def cmd_status(_args) -> int:
    print(f"Target: {_target()}")
    plan = removal_plan()
    by_state: dict[str, int] = {}
    for row in research_records.find({"_id": {"$in": [r["_id"] for r in plan["records"]]}}, {"verification_status": 1}):
        by_state[row["verification_status"]] = by_state.get(row["verification_status"], 0) + 1
    print(f"Demo faculty accounts:  {len(plan['people'])}")
    print(f"Demo research records:  {len(plan['record_ids'])}  {dict(sorted(by_state.items()))}")
    print(f"  added while testing:  {plan['added_while_testing']}")
    print(f"Demo showcases:         {len(plan['showcases'])}")
    print(f"Real research records:  {research_records.count_documents({'_id': {'$nin': [r['_id'] for r in plan['records']]}})} (never touched)")
    return 0


def cmd_seed(args) -> int:
    if not 50 <= args.count <= 100:
        print("--count must be between 50 and 100.")
        return 2
    if users.count_documents({"seed_batch": TAG}) or research_records.count_documents({"seed_batch": TAG}):
        print("Demo research data is already in this database. Run `remove --yes` first to seed it afresh.")
        return 1
    if not _confirm(f"insert {args.count} demo research records", args.confirm_db):
        return 1

    password = args.password or f"Demo-{secrets.token_urlsafe(9)}"
    faculty_docs = _faculty_documents(password)
    existing = {u["email"] for u in users.find({"email": {"$in": [d["email"] for d in faculty_docs]}}, {"email": 1})}
    if existing:
        print(f"These addresses already have accounts, so nothing was seeded: {sorted(existing)}")
        return 1
    result = users.insert_many(faculty_docs)
    faculty = [{"id": str(oid), "name": doc["name"]} for oid, doc in zip(result.inserted_ids, faculty_docs)]

    records = build_batch(args.count, faculty)
    inserted = research_records.insert_many(records).inserted_ids
    for record, oid in zip(records, inserted):
        record["_id"] = oid
    shows = _showcases(records, faculty)
    if shows:
        research_showcases.insert_many(shows)

    counts: dict[str, int] = {}
    for record in records:
        counts[record["verification_status"]] = counts.get(record["verification_status"], 0) + 1
    print(f"\nSeeded {len(records)} demo research records {dict(sorted(counts.items()))},")
    print(f"{len(faculty)} demo faculty accounts and {len(shows)} demo showcases.")
    print("\nDemo faculty can sign in (Teacher panel) with this password:")
    print(f"    {password}")
    for doc in faculty_docs:
        print(f"    {doc['email']}")
    print("\nWhen you have finished testing:  python scripts/seed_research_demo.py remove --yes")
    return 0


def cmd_remove(args) -> int:
    plan = removal_plan()
    print(f"Target: {_target()}")
    print(f"Demo faculty accounts:      {len(plan['people'])} (with anything they own)")
    print(f"Demo research records:      {len(plan['record_ids'])} ({plan['added_while_testing']} added while testing)")
    print(f"  evidence files on them:   {plan['evidence_files']}")
    print(f"Demo showcases:             {len(plan['showcases'])}")
    print(f"Notifications about them:   {plan['notification_count']}")
    print(f"Audit entries about them:   {plan['audit_count']}")
    for show in plan["elsewhere"]:
        print(f"  Left alone: showcase {show.get('title')!r} by {show.get('owner_name')} lists demo records "
              "(they will simply no longer appear in it).")
    if not (plan["people"] or plan["record_ids"] or plan["showcases"]):
        print("\nNo demo research data here. Nothing to remove.")
        return 0
    if not args.yes:
        print("\nDry run: nothing deleted. Run with --yes to delete exactly the above.")
        return 0
    if not _confirm("delete the demo research data listed above", args.confirm_db):
        return 1

    for record in plan["records"]:
        for evidence in record.get("evidence") or []:
            delete_stored(evidence)
    gone_records = research_records.delete_many({"_id": {"$in": [r["_id"] for r in plan["records"]]}}).deleted_count
    gone_shows = research_showcases.delete_many({"_id": {"$in": plan["showcases"]}}).deleted_count
    gone_notes = notifications.delete_many(plan["note_query"]).deleted_count
    gone_audit = audit_logs.delete_many(plan["audit_query"]).deleted_count
    for user_id in plan["people"]:
        delete_user_cascade(user_id)  # their events, notifications and the account
    left = users.count_documents({"seed_batch": TAG})
    print(f"\nDeleted {gone_records} records, {gone_shows} showcases, {gone_notes} notifications, "
          f"{gone_audit} audit entries and {len(plan['people']) - left} demo accounts.")
    return 0 if not left else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="Count the demo data in the database")
    seed = sub.add_parser("seed", help="Insert the demo research data")
    seed.add_argument("--count", type=int, default=80, help="How many records, 50-100 (default 80)")
    seed.add_argument("--password", help="Password for the demo faculty accounts (default: a random one)")
    seed.add_argument("--confirm-db", help="Skip the prompt: the target database's name")
    remove = sub.add_parser("remove", help="Delete the demo research data (a dry run without --yes)")
    remove.add_argument("--yes", action="store_true", help="Delete (default: only show what would go)")
    remove.add_argument("--confirm-db", help="Skip the prompt: the target database's name")
    args = parser.parse_args()
    return {"status": cmd_status, "seed": cmd_seed, "remove": cmd_remove}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
