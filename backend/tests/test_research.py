"""Research portfolio: who may record what, and the Dean's verification."""

from __future__ import annotations

import copy
import os
import re
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from bson import ObjectId

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.models.documents import academic_year_of  # noqa: E402


# ---------------------------------------------------------------- the fake

_MISSING = object()


def _get(doc, path):
    value = doc
    for part in path.split("."):
        if isinstance(value, list):
            try:
                value = value[int(part)]
            except (ValueError, IndexError):
                return _MISSING
        elif isinstance(value, dict):
            value = value.get(part, _MISSING)
        else:
            return _MISSING
        if value is _MISSING:
            return _MISSING
    return value


def _matches(doc, query):
    for key, wanted in query.items():
        if key == "$or":
            if not any(_matches(doc, clause) for clause in wanted):
                return False
            continue
        value = _get(doc, key)
        if isinstance(wanted, dict) and any(op.startswith("$") for op in wanted):
            for op, arg in wanted.items():
                present = value is not _MISSING
                actual = value if present else None
                # On an array field, as in MongoDB, any element may match.
                values = actual if isinstance(actual, list) else [actual]
                if op == "$in" and not any(v in arg for v in values):
                    return False
                if op == "$nin" and any(v in arg for v in values):
                    return False
                if op == "$ne" and actual == arg:
                    return False
                if op == "$gte" and not (actual is not None and actual >= arg):
                    return False
                if op == "$lte" and not (actual is not None and actual <= arg):
                    return False
                if op == "$exists" and present != bool(arg):
                    return False
                if op == "$regex":
                    flags = re.I if "i" in wanted.get("$options", "") else 0
                    if not re.search(arg, str(actual or ""), flags):
                        return False
        else:
            actual = None if value is _MISSING else value
            if actual != wanted:
                return False
    return True


class FakeCursor(list):
    def sort(self, key, direction=1):
        keys = key if isinstance(key, list) else [(key, direction)]
        result = list(self)
        for field, order in reversed(keys):
            result.sort(key=lambda d: (d.get(field) is None, str(d.get(field) or "")), reverse=order == -1)
        return FakeCursor(result)

    def skip(self, n):
        return FakeCursor(self[n:])

    def limit(self, n):
        return FakeCursor(self[:n]) if n else self


class FakeCollection:
    def aggregate(self, pipeline):
        from tests.fake_aggregation import aggregate_rows
        return iter(aggregate_rows(self.docs, pipeline, _matches))

    def __init__(self, docs=None):
        self.docs = [copy.deepcopy(d) for d in (docs or [])]

    def find(self, query=None, *_args, **_kwargs):
        return FakeCursor(copy.deepcopy(d) for d in self.docs if _matches(d, query or {}))

    def find_one(self, query=None, *_args, **_kwargs):
        found = self.find(query)
        return found[0] if found else None

    def count_documents(self, query):
        return len(self.find(query))

    def insert_one(self, doc):
        doc = copy.deepcopy(doc)
        doc.setdefault("_id", ObjectId())
        # As MongoDB does: timestamps are kept to the millisecond.
        for key, value in list(doc.items()):
            if isinstance(value, datetime):
                doc[key] = value.replace(microsecond=value.microsecond // 1000 * 1000)
        self.docs.append(doc)
        return SimpleNamespace(inserted_id=doc["_id"])

    def update_one(self, query, update):
        for doc in self.docs:
            if _matches(doc, query):
                for key, value in (update.get("$set") or {}).items():
                    if isinstance(value, datetime):
                        value = value.replace(microsecond=value.microsecond // 1000 * 1000)
                    doc[key] = copy.deepcopy(value)
                for key, value in (update.get("$push") or {}).items():
                    doc.setdefault(key, []).append(copy.deepcopy(value))
                for key, cond in (update.get("$pull") or {}).items():
                    doc[key] = [item for item in doc.get(key, []) if not _matches(item, cond)]
                return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)

    def delete_one(self, query):
        for index, doc in enumerate(self.docs):
            if _matches(doc, query):
                del self.docs[index]
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)


# ---------------------------------------------------------------- people

TEACHER_ID = ObjectId()
OTHER_TEACHER_ID = ObjectId()
MANAGER_ID = ObjectId()
DEAN_ID = ObjectId()
SECOND_DEAN_ID = ObjectId()

PEOPLE = [
    {"_id": TEACHER_ID, "name": "Meera Joshi", "email": "meera@srhu.edu.in", "role": "teacher",
     "department": "Pharmacy"},
    {"_id": OTHER_TEACHER_ID, "name": "Arjun Rawat", "email": "arjun@srhu.edu.in", "role": "teacher",
     "department": "Nursing"},
    {"_id": MANAGER_ID, "name": "Vishal Tomar", "email": "vishal@srhu.edu.in", "role": "event_manager"},
    {"_id": DEAN_ID, "name": "Aparna Sharma", "email": "dean@srhu.edu.in", "role": "dean"},
    {"_id": SECOND_DEAN_ID, "name": "Rakesh Negi", "email": "dean2@srhu.edu.in", "role": "dean"},
]


def _user(person):
    return {"id": str(person["_id"]), "name": person["name"], "email": person["email"], "role": person["role"]}


TOKENS = {
    "Bearer teacher": _user(PEOPLE[0]),
    "Bearer other-teacher": _user(PEOPLE[1]),
    "Bearer manager": _user(PEOPLE[2]),
    "Bearer dean": _user(PEOPLE[3]),
}

PDF = b"%PDF-1.4\n%evidence\n" + b"0" * 200

PATENT = {
    "category": "patent",
    "title": "Herbal wound dressing",
    "record_date": "2026-03-10",
    "outcome_status": "filed",
    "details": {
        "inventors": "Meera Joshi, Arjun Rawat",
        "office": "India (IPO)",
        "application_number": "202611012345",
        "not_a_field": "dropped",
    },
}


LIMITS = {
    "research_evidence_required": False,
    "max_research_evidence_files": 5,
    "max_research_evidence_total_mb": 10,
    "max_research_evidence_total_bytes": 10 * 1024 * 1024,
}


def stored_upload(*_args, **_kwargs):
    file_id = str(ObjectId())
    return {"storage": "gridfs", "object_key": None, "file_id": file_id, "url": f"/files/{file_id}"}


class ResearchFixture:
    """Fakes, patches and helpers shared by the research test modules. Not a
    TestCase itself, so importing it never re-runs these tests elsewhere."""

    extra_patches: tuple = ()

    def setUp(self):
        self.records = FakeCollection()
        self.users = FakeCollection(PEOPLE)
        self.notifications = FakeCollection()
        self.deleted = []
        self.client = TestClient(app)
        self.patches = [
            patch("app.routers.research.research_records", self.records),
            patch("app.routers.research.users", self.users),
            patch("app.routers.research.notifications", self.notifications),
            patch("app.routers.research.get_current_user", lambda authorization: dict(TOKENS[authorization])),
            patch("app.routers.research.save_upload", stored_upload),
            patch("app.routers.research.delete_stored", self.deleted.append),
            patch("app.routers.research.log_audit_event", lambda **_: None),
            patch("app.routers.research.email_service.is_configured", lambda: False),
            patch("app.routers.research.get_upload_limits", lambda: dict(LIMITS)),
        ]
        self.patches += [patch(target, value) for target, value in self.extra_patches]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self):
        for patcher in self.patches:
            patcher.stop()

    # ------------------------------------------------------------ helpers

    def call(self, method, path, who, expect=200, **kwargs):
        response = self.client.request(method, path, headers={"Authorization": f"Bearer {who}"}, **kwargs)
        self.assertEqual(response.status_code, expect, response.text)
        return response.json()

    def create(self, who="manager", **overrides):
        body = {**copy.deepcopy(PATENT), **overrides}
        if who == "manager":
            body.setdefault("faculty_id", str(TEACHER_ID))
        return self.call("POST", "/research/records", who, 201, json=body)["record"]

    def attach(self, record_id, who="manager", tag="Filing receipt", name="receipt.pdf", data=PDF, expect=201,
               content_type="application/pdf"):
        return self.call(
            "POST", f"/research/records/{record_id}/evidence", who, expect,
            files={"file": (name, data, content_type)}, data={"tag": tag},
        )

    def submitted(self, who="teacher"):
        """A record waiting in the Dean's queue: a teacher's own submission.
        (What the Event Manager submits is recorded without the Dean.)"""
        record = self.create(who)
        self.attach(record["id"], who)
        return self.call("POST", f"/research/records/{record['id']}/submit", who)["record"]

    def accepted(self, who="manager", **overrides):
        """An accepted record: recorded by the Event Manager, or a teacher's
        verified by the Dean."""
        record = self.create(who, **overrides)
        self.attach(record["id"], who)
        done = self.call("POST", f"/research/records/{record['id']}/submit", who)["record"]
        if done["verification_status"] != "verified":
            done = self.call("PATCH", f"/dean/research/records/{record['id']}/verify", "dean")["record"]
        return done

    def notes_for(self, person_id, kind=None):
        return [
            n for n in self.notifications.docs
            if n["user_id"] == str(person_id) and (kind is None or n["notification_type"] == kind)
        ]



class ResearchTest(ResearchFixture, unittest.TestCase):
    # ------------------------------------------------------------ categories

    def test_categories_describe_every_kind_of_research(self):
        body = self.call("GET", "/research/categories", "teacher")
        keys = [c["key"] for c in body["categories"]]
        self.assertEqual(keys, ["journal", "conference", "patent", "book", "other"])
        self.assertNotIn("project", keys)
        patent = next(c for c in body["categories"] if c["key"] == "patent")
        self.assertEqual([o["key"] for o in patent["outcomes"]][:3], ["filed", "published", "granted"])
        self.assertIn("Grant certificate", patent["evidence_tags"])
        self.assertEqual(body["limits"]["max_evidence_files"], 5)

    def test_retired_project_category_cannot_be_created(self):
        self.call(
            "POST",
            "/research/records",
            "manager",
            400,
            json={**PATENT, "category": "project", "faculty_id": str(TEACHER_ID)},
        )
        self.assertEqual(self.records.docs, [])

    def test_each_active_category_accepts_a_minimal_record(self):
        samples = {
            "journal": {"author_position": "First author", "journal": "Clinical Research", "indexing": ["Scopus"]},
            "conference": {
                "presentation_type": "Oral presentation", "conference": "Health Research Summit",
                "organiser": "SRHU", "level": "National",
            },
            "patent": {"inventors": "Meera Joshi", "office": "India (IPO)", "application_number": "202611012345"},
            "book": {"book_type": "Authored book", "authors": "Meera Joshi", "publisher": "SRHU Press"},
            "other": {"kind": "Fellowship", "awarded_by": "Research Council"},
        }
        for index, (category, details) in enumerate(samples.items()):
            with self.subTest(category=category):
                record = self.call(
                    "POST",
                    "/research/records",
                    "manager",
                    201,
                    json={
                        "category": category,
                        "title": f"Active {category} record {index}",
                        "record_date": "2026-10-01",
                        "details": details,
                        "faculty_id": str(TEACHER_ID),
                    },
                )["record"]
                self.assertEqual(record["category"], category)
                self.assertEqual(record["verification_status"], "draft")
                recorded = self.call("POST", f"/research/records/{record['id']}/submit", "manager")["record"]
                self.assertEqual(recorded["verification_status"], "verified")
                self.assertTrue(recorded["recorded_by_manager"])

    def test_existing_project_record_remains_readable_but_is_read_only(self):
        record = self.create()
        stored = self.records.docs[0]
        stored["category"] = "project"
        stored["outcome_status"] = "ongoing"
        stored["details"] = {"role": "Principal Investigator", "end_date": "2026-12-31"}

        visible = self.call("GET", f"/research/records/{record['id']}", "manager")["record"]
        self.assertEqual(visible["category_label"], "Research project / grant")
        self.assertEqual(visible["category_definition"]["fields"][0]["key"], "role")
        self.assertEqual(visible["details"]["role"], "Principal Investigator")
        self.assertFalse(visible["category_active"])
        self.assertFalse(visible["permissions"]["can_edit"])
        self.assertFalse(visible["permissions"]["can_submit"])

        self.call("PATCH", f"/research/records/{record['id']}", "manager", 400, json={"title": "Changed"})
        self.call("POST", f"/research/records/{record['id']}/submit", "manager", 409)
        self.assertEqual(len(self.records.docs), 1)
        self.assertEqual(self.records.docs[0]["category"], "project")

    def test_academic_year_runs_july_to_june(self):
        self.assertEqual(academic_year_of("2026-06-30"), "2025-26")
        self.assertEqual(academic_year_of("2026-07-01"), "2026-27")
        self.assertIsNone(academic_year_of(None))

    # ------------------------------------------------------------ authoring

    def test_event_manager_records_research_for_a_teacher(self):
        record = self.create()
        self.assertEqual(record["verification_status"], "draft")
        self.assertEqual(record["faculty_id"], str(TEACHER_ID))
        self.assertEqual(record["faculty"]["name"], "Meera Joshi")
        self.assertEqual(record["created_by_role"], "event_manager")
        self.assertEqual(record["academic_year"], "2025-26")
        self.assertNotIn("not_a_field", record["details"])
        # The teacher is told something was added to their portfolio.
        self.assertEqual(len(self.notes_for(TEACHER_ID, "research_added")), 1)

    def test_event_manager_must_name_a_teacher(self):
        body = {**PATENT}
        self.call("POST", "/research/records", "manager", 400, json=body)
        self.call("POST", "/research/records", "manager", 400, json={**body, "faculty_id": str(DEAN_ID)})

    def test_a_teacher_records_only_their_own_research(self):
        record = self.create("teacher")
        self.assertEqual(record["faculty_id"], str(TEACHER_ID))
        self.assertEqual(self.notes_for(TEACHER_ID), [])
        self.call("POST", "/research/records", "teacher", 403, json={**PATENT, "faculty_id": str(OTHER_TEACHER_ID)})

    def test_a_teacher_sees_only_their_own_portfolio(self):
        mine = self.create()
        self.create(faculty_id=str(OTHER_TEACHER_ID), title="Someone else's patent")
        listed = self.call("GET", "/research/records", "teacher")
        self.assertEqual([r["id"] for r in listed["records"]], [mine["id"]])
        self.call("GET", f"/research/records/{mine['id']}", "other-teacher", 404)
        self.assertEqual(self.call("GET", "/research/records", "manager")["total"], 2)

    def test_other_indexing_is_named_only_when_other_is_ticked(self):
        from app.services.research_categories import CATEGORIES, clean_details, indexing_text

        journal = CATEGORIES["journal"]
        base = {"authors": "M", "author_position": "First author", "journal": "J"}
        cleaned, missing = clean_details(journal, {**base, "indexing": ["Scopus", "Other"]}, "published")
        self.assertIn("Other indexing platform", missing)
        cleaned, missing = clean_details(
            journal, {**base, "indexing": ["Scopus", "Other"], "indexing_other": "DOAJ"}, "published")
        self.assertEqual(missing, [])
        self.assertEqual(indexing_text(cleaned), "Scopus, Other (DOAJ)")
        # Untick Other: the name is dropped, and no longer asked for.
        cleaned, missing = clean_details(
            journal, {**base, "indexing": ["Scopus"], "indexing_other": "DOAJ"}, "published")
        self.assertNotIn("indexing_other", cleaned)
        self.assertEqual(missing, [])

    def test_malformed_details_are_refused(self):
        bad = copy.deepcopy(PATENT)
        bad["details"]["office"] = "Moon"
        self.call("POST", "/research/records", "manager", 400, json={**bad, "faculty_id": str(TEACHER_ID)})
        self.call("POST", "/research/records", "manager", 400,
                  json={**PATENT, "faculty_id": str(TEACHER_ID), "outcome_status": "dreamt"})
        self.call("POST", "/research/records", "manager", 400,
                  json={**PATENT, "faculty_id": str(TEACHER_ID), "category": "poetry"})

    # ------------------------------------------------------------ evidence

    def test_evidence_must_be_a_pdf_or_an_image_with_a_known_tag(self):
        record = self.create()
        self.attach(record["id"], name="notes.docx", expect=400,
                    content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.attach(record["id"], tag="Selfie", expect=400)
        self.attach(record["id"], data=b"not really a pdf", expect=400)
        added = self.attach(record["id"])["record"]
        self.assertEqual(added["evidence"][0]["tag"], "Filing receipt")
        self.assertIn("sig=", added["evidence"][0]["url"])

    def test_evidence_is_capped_per_record(self):
        record = self.create()
        for _ in range(5):
            self.attach(record["id"])
        self.attach(record["id"], expect=400)

    # ------------------------------------------------------------ submitting

    def test_evidence_is_optional_unless_the_super_admin_requires_it(self):
        record = self.create("teacher")
        self.assertFalse(self.call("GET", "/research/categories", "teacher")["limits"]["evidence_required"])
        done = self.call("POST", f"/research/records/{record['id']}/submit", "teacher")["record"]
        self.assertEqual(done["verification_status"], "submitted")
        recorded = self.call("POST", f"/research/records/{self.create()['id']}/submit", "manager")["record"]
        self.assertTrue(recorded["recorded_by_manager"])

    def test_with_evidence_required_the_last_file_cannot_be_removed(self):
        record = self.accepted()
        evidence_id = record["evidence"][0]["id"]
        with patch("app.routers.research.get_upload_limits", lambda: {**LIMITS, "research_evidence_required": True}):
            self.call("DELETE", f"/research/records/{record['id']}/evidence/{evidence_id}", "teacher", 409)
        # Optional: removing it is fine.
        self.call("DELETE", f"/research/records/{record['id']}/evidence/{evidence_id}", "teacher")

    def test_manager_can_record_without_evidence_even_when_teacher_policy_requires_it(self):
        with patch(
            "app.routers.research.get_upload_limits",
            lambda: {**LIMITS, "research_evidence_required": True},
        ):
            record = self.create("manager")
            done = self.call("POST", f"/research/records/{record['id']}/submit", "manager")["record"]
            self.assertTrue(done["recorded_by_manager"])
            self.assertEqual(done["evidence"], [])

            queued = self.create("manager")
            bulk = self.call(
                "POST",
                "/research/records/bulk-record",
                "manager",
                json={"ids": [queued["id"]]},
            )
            self.assertEqual(bulk["recorded"], [queued["id"]])
            self.assertEqual(bulk["skipped"], [])

    def test_submission_needs_complete_details_and_evidence(self):
        self.patches.append(patch("app.routers.research.get_upload_limits", lambda: {**LIMITS, "research_evidence_required": True}))
        self.patches[-1].start()
        record = self.create("teacher", record_date=None)
        message = self.call("POST", f"/research/records/{record['id']}/submit", "teacher", 400)["detail"]
        self.assertIn("Filing date", message)

        self.call("PATCH", f"/research/records/{record['id']}", "teacher", json={"record_date": "2026-03-10"})
        message = self.call("POST", f"/research/records/{record['id']}/submit", "teacher", 400)["detail"]
        self.assertIn("evidence", message)

        self.attach(record["id"], "teacher")
        done = self.call("POST", f"/research/records/{record['id']}/submit", "teacher")["record"]
        self.assertEqual(done["verification_status"], "submitted")
        self.assertEqual(len(self.notes_for(DEAN_ID, "research_submitted")), 1)
        self.assertEqual(len(self.notes_for(SECOND_DEAN_ID, "research_submitted")), 1)

    def test_a_granted_patent_needs_its_grant_details(self):
        record = self.create(outcome_status="granted")
        self.attach(record["id"])
        message = self.call("POST", f"/research/records/{record['id']}/submit", "manager", 400)["detail"]
        for label in ("Grant date", "Patent number", "Publication date"):
            self.assertIn(label, message)
        # A refused patent is off the line, so it is not asked for any of them.
        self.call("PATCH", f"/research/records/{record['id']}", "manager", json={"outcome_status": "refused"})
        self.call("POST", f"/research/records/{record['id']}/submit", "manager")

    def test_submitting_twice_is_a_conflict(self):
        record = self.submitted()
        self.call("POST", f"/research/records/{record['id']}/submit", "manager", 409)

    # ------------------------------------------------------------ the Dean

    def test_drafts_are_invisible_to_the_dean(self):
        draft = self.create()
        self.call("GET", f"/research/records/{draft['id']}", "dean", 403)  # not an author route
        self.call("GET", f"/dean/research/records/{draft['id']}", "dean", 404)
        self.assertEqual(self.call("GET", "/dean/research/records", "dean")["total"], 0)

    def test_the_queue_is_oldest_first(self):
        first = self.submitted()
        second = self.submitted()
        self.records.docs[0]["submitted_at"] = datetime.now(timezone.utc) - timedelta(days=2)
        queue = self.call("GET", "/dean/research/records", "dean")
        self.assertEqual([r["id"] for r in queue["records"]], [first["id"], second["id"]])
        self.assertEqual(queue["counts"]["submitted"], 2)

    def test_verifying_tells_the_teacher(self):
        # A teacher's own submission: the Dean decides.
        record = self.submitted()
        verified = self.call("PATCH", f"/dean/research/records/{record['id']}/verify", "dean",
                             json={"remarks": "Checked with IPO."})["record"]
        self.assertEqual(verified["verification_status"], "verified")
        self.assertEqual(verified["verified_snapshot"]["outcome_status"], "filed")
        self.assertEqual(len(self.notes_for(TEACHER_ID, "research_verified")), 1)
        self.call("PATCH", f"/dean/research/records/{record['id']}/verify", "dean", 409)

    # ---------------------------- what the Event Manager handles is never the Dean's

    def stored(self, record_id):
        return next(d for d in self.records.docs if str(d["_id"]) == record_id)

    def assert_not_the_deans(self, record_id):
        seen = self.call("GET", f"/dean/research/records/{record_id}", "dean")["record"]
        self.assertFalse(seen["permissions"]["can_verify"] or seen["permissions"]["can_unverify"])
        for verb in ("verify", "request-changes", "reject", "unverify"):
            self.call("PATCH", f"/dean/research/records/{record_id}/{verb}", "dean", 409,
                      json={"remarks": "Please attach the grant certificate."})
        queue = self.call("GET", "/dean/research/records?status=submitted", "dean")
        self.assertNotIn(record_id, [r["id"] for r in queue["records"]])

    def test_a_record_the_event_manager_entered_is_recorded_when_the_teacher_submits_it(self):
        """It went to the Dean's queue, with Verify / Request changes / Reject."""
        record = self.create()
        self.attach(record["id"])
        done = self.call("POST", f"/research/records/{record['id']}/submit", "teacher")
        self.assertEqual(done["message"], "Recorded in the research portfolio")
        self.assertEqual(done["record"]["verification_status"], "verified")
        self.assertTrue(done["record"]["recorded_by_manager"])
        self.assertEqual(done["record"]["verified_by"]["id"], str(MANAGER_ID))
        self.assertEqual(self.notes_for(DEAN_ID, "research_submitted"), [])
        self.assert_not_the_deans(record["id"])

    def test_a_teachers_submission_leaves_the_queue_once_the_event_manager_works_on_it(self):
        edited = self.submitted()
        moved = self.call("PATCH", f"/research/records/{edited['id']}", "manager",
                          json={"title": "Herbal wound dressing, corrected title"})["record"]
        self.assertEqual(moved["verification_status"], "verified")
        self.assertTrue(moved["recorded_by_manager"])
        self.assert_not_the_deans(edited["id"])

        evidenced = self.submitted()
        added = self.attach(evidenced["id"], "manager", tag="Grant certificate", name="grant.pdf")["record"]
        self.assertEqual(added["verification_status"], "verified")
        self.assert_not_the_deans(evidenced["id"])

    def test_the_dean_cannot_withdraw_a_verification_the_event_manager_has_worked_on(self):
        record = self.submitted()
        self.call("PATCH", f"/dean/research/records/{record['id']}/verify", "dean")
        before = self.call("GET", f"/dean/research/records/{record['id']}", "dean")["record"]
        self.assertTrue(before["permissions"]["can_unverify"])  # the Dean's own verification, untouched
        self.attach(record["id"], "manager", tag="Grant certificate", name="grant.pdf")
        self.assert_not_the_deans(record["id"])

    def test_startup_records_teacher_submissions_the_event_manager_worked_on(self):
        from app.routers.research import record_waiting_manager_submissions

        mine = self.submitted()
        handled = self.submitted()
        # As left by older code: waiting with the Dean after an Event Manager edit.
        self.stored(handled["id"])["history"].append(
            {"action": "updated", "status": "submitted", "actor_id": str(MANAGER_ID),
             "actor_name": "Vishal Tomar", "actor_role": "event_manager"})
        found = record_waiting_manager_submissions()
        self.assertEqual([str(r["_id"]) for r in found], [handled["id"]])
        self.assertEqual(self.stored(handled["id"])["verification_status"], "verified")
        self.assertEqual(self.stored(mine["id"])["verification_status"], "submitted")

    def test_a_dean_never_decides_on_their_own_record(self):
        dean_as_faculty = _user(PEOPLE[3])
        record = self.submitted()
        self.records.docs[0]["faculty_id"] = dean_as_faculty["id"]
        self.call("PATCH", f"/dean/research/records/{record['id']}/verify", "dean", 403)

    def test_changes_need_remarks_and_come_back_as_a_resubmission(self):
        record = self.submitted()
        self.call("PATCH", f"/dean/research/records/{record['id']}/request-changes", "dean", 422, json={})
        back = self.call("PATCH", f"/dean/research/records/{record['id']}/request-changes", "dean",
                         json={"remarks": "Attach the filing receipt with the stamp."})["record"]
        self.assertEqual(back["verification_status"], "changes_requested")
        self.assertEqual(back["dean_remarks"], "Attach the filing receipt with the stamp.")

        again = self.call("POST", f"/research/records/{record['id']}/submit", "teacher")["record"]
        self.assertEqual(again["verification_status"], "submitted")
        self.assertEqual(again["history"][-1]["action"], "resubmitted")

    def test_editing_a_verified_record_sends_it_back(self):
        record = self.submitted()
        self.call("PATCH", f"/dean/research/records/{record['id']}/verify", "dean")
        before = len(self.notes_for(DEAN_ID))

        # Saving the form untouched changes nothing.
        same = self.call("PATCH", f"/research/records/{record['id']}", "manager",
                         json={"title": PATENT["title"]})["record"]
        self.assertEqual(same["verification_status"], "verified")

        details = {**PATENT["details"], "publication_date": "2026-09-01", "journal_number": "36/2026"}
        moved = self.call("PATCH", f"/research/records/{record['id']}", "teacher",
                          json={"outcome_status": "published", "details": details})["record"]
        self.assertEqual(moved["verification_status"], "submitted")
        self.assertEqual(moved["history"][-1]["action"], "reverification")
        # What was verified is kept, so the Dean can see what changed.
        self.assertEqual(moved["verified_snapshot"]["outcome_status"], "filed")
        self.assertEqual(len(self.notes_for(DEAN_ID)), before + 1)

    def test_the_event_managers_submission_is_recorded_without_the_dean(self):
        record = self.create()
        self.attach(record["id"])
        done = self.call("POST", f"/research/records/{record['id']}/submit", "manager")
        self.assertEqual(done["message"], "Recorded in the research portfolio")
        recorded = done["record"]
        self.assertEqual(recorded["verification_status"], "verified")
        self.assertTrue(recorded["recorded_by_manager"])
        self.assertEqual(recorded["verified_by"]["role"], "event_manager")
        self.assertEqual(recorded["history"][-1]["action"], "recorded")
        # Not in the Dean's queue, and no Dean is asked to look.
        self.assertEqual(self.call("GET", "/dean/research/records", "dean")["total"], 0)
        self.assertEqual(self.notes_for(DEAN_ID, "research_submitted"), [])
        # The teacher is told it is in their portfolio.
        self.assertEqual(len(self.notes_for(TEACHER_ID, "research_verified")), 1)
        # The Dean can read it, but has no decision to make on it.
        seen = self.call("GET", f"/dean/research/records/{record['id']}", "dean")["record"]
        self.assertFalse(seen["permissions"]["can_verify"] or seen["permissions"]["can_unverify"])
        self.call("PATCH", f"/dean/research/records/{record['id']}/unverify", "dean", 409,
                  json={"remarks": "Not mine to withdraw."})

    def test_the_event_managers_changes_keep_a_recording_accepted(self):
        record = self.accepted()
        details = {**PATENT["details"], "publication_date": "2026-09-01", "journal_number": "36/2026"}
        moved = self.call("PATCH", f"/research/records/{record['id']}", "manager",
                          json={"outcome_status": "published", "details": details})["record"]
        self.assertEqual(moved["verification_status"], "verified")
        self.assertEqual(moved["verified_snapshot"]["outcome_status"], "published")
        more = self.attach(record["id"], tag="Publication extract")["record"]
        self.assertEqual(more["verification_status"], "verified")
        self.assertEqual(len(more["verified_snapshot"]["evidence"]), 2)
        self.assertEqual(self.notes_for(DEAN_ID, "research_submitted"), [])

    def test_a_teachers_change_to_a_recording_stays_recorded(self):
        """The Event Manager's research never goes to the Dean -- not even
        when the teacher it belongs to edits it."""
        record = self.accepted()
        moved = self.call("PATCH", f"/research/records/{record['id']}", "teacher",
                          json={"title": "Herbal wound dressing, revised claims"})["record"]
        self.assertEqual(moved["verification_status"], "verified")
        self.assertEqual(moved["verified_snapshot"]["title"], "Herbal wound dressing, revised claims")
        self.assertEqual(self.notes_for(DEAN_ID, "research_submitted"), [])
        self.assert_not_the_deans(record["id"])

    def test_a_teachers_change_to_their_own_verified_record_goes_back_to_the_dean(self):
        record = self.accepted(who="teacher")
        asked = len(self.notes_for(DEAN_ID, "research_submitted"))
        moved = self.call("PATCH", f"/research/records/{record['id']}", "teacher",
                          json={"title": "Herbal wound dressing, revised claims"})["record"]
        self.assertEqual(moved["verification_status"], "submitted")
        self.assertEqual(moved["history"][-1]["action"], "reverification")
        self.assertEqual(len(self.notes_for(DEAN_ID, "research_submitted")), asked + 1)

    def test_the_migration_records_only_the_event_managers_waiting_submissions(self):
        from scripts import record_event_manager_research as migration

        teachers = self.submitted("teacher")
        # As stored before the change: the Event Manager's submission queued.
        managers = self.create()
        self.attach(managers["id"])
        doc = next(d for d in self.records.docs if str(d["_id"]) == managers["id"])
        doc["verification_status"] = "submitted"
        doc["history"].append({"action": "submitted", "actor_role": "event_manager", "actor_id": "m", "actor_name": "Vishal Tomar"})

        # Before it is settled, the Dean has no decision to make on it.
        seen = self.call("GET", f"/dean/research/records/{managers['id']}", "dean")["record"]
        self.assertFalse(seen["permissions"]["can_verify"])
        self.call("PATCH", f"/dean/research/records/{managers['id']}/verify", "dean", 409)

        with patch("sys.argv", ["x", "--apply"]):
            migration.main()
        states = {str(d["_id"]): d["verification_status"] for d in self.records.docs}
        self.assertEqual(states[managers["id"]], "verified")
        self.assertEqual(states[teachers["id"]], "submitted")
        self.assertEqual(doc["verified_by"]["role"], "event_manager")

    def test_a_stale_edit_is_refused(self):
        record = self.create()
        self.call("PATCH", f"/research/records/{record['id']}", "teacher", json={"title": "Newer title"})
        self.call("PATCH", f"/research/records/{record['id']}", "manager", 409,
                  json={"title": "Older edit", "expected_updated_at": record["updated_at"]})

    def test_an_edit_against_the_latest_version_goes_through(self):
        # The stamp handed out must match the stored one exactly: MongoDB
        # keeps milliseconds, so a stamp taken from memory never would.
        record = self.create()
        first = self.call("PATCH", f"/research/records/{record['id']}", "manager",
                          json={"title": "First", "expected_updated_at": record["updated_at"]})["record"]
        self.call("PATCH", f"/research/records/{record['id']}", "teacher",
                  json={"title": "Second", "expected_updated_at": first["updated_at"]})

    def test_event_manager_and_teacher_delete_permissions_and_evidence_cleanup(self):
        record = self.submitted()
        self.call("DELETE", f"/research/records/{record['id']}", "manager", 409)
        self.call("PATCH", f"/dean/research/records/{record['id']}/reject", "dean",
                  json={"remarks": "Duplicate of an earlier record."})
        # Event Manager delete removes it from the shared database and cleans
        # its evidence, including when the Dean has requested changes.
        self.call("DELETE", f"/research/records/{record['id']}", "manager")
        self.call("GET", f"/research/records/{record['id']}", "manager", 404)
        self.call("GET", f"/dean/research/records/{record['id']}", "dean", 404)
        self.assertEqual(self.records.docs, [])
        self.assertEqual(len(self.deleted), 1)
        # A teacher can still delete their own rejected record.
        teacher_record = self.submitted()
        self.call("PATCH", f"/dean/research/records/{teacher_record['id']}/reject", "dean",
                  json={"remarks": "Duplicate."})
        self.call("DELETE", f"/research/records/{teacher_record['id']}", "teacher")
        self.assertEqual(self.records.docs, [])
        self.assertEqual(len(self.deleted), 2)  # both evidence files

    def test_the_event_manager_deletes_several_records_at_once(self):
        draft = self.create(title="Draft patent to delete")
        recorded = self.accepted(title="Recorded patent to delete")
        waiting = self.submitted()                       # a teacher's, with the Dean
        verified = self.accepted(who="teacher", title="Dean-verified patent")
        body = self.call("POST", "/research/records/bulk-delete", "manager", json={
            "ids": [draft["id"], recorded["id"], waiting["id"], verified["id"], str(ObjectId()), "nonsense"]})
        self.assertEqual({d["id"] for d in body["deleted"]}, {draft["id"], recorded["id"]})
        reasons = {s["id"]: s["reason"] for s in body["skipped"]}
        self.assertIn("waiting for the Dean", reasons[waiting["id"]])
        self.assertIn("verified by the Dean", reasons[verified["id"]])
        self.assertEqual(reasons["nonsense"], "Not found.")
        # Both manager-owned records, including the submitted record, are
        # physically gone; unrelated teacher records remain untouched.
        self.assertEqual({str(r["_id"]) for r in self.records.docs}, {waiting["id"], verified["id"]})
        listed = self.call("GET", "/research/records", "manager")["records"]
        self.assertNotIn(recorded["id"], [r["id"] for r in listed])
        self.call("GET", f"/dean/research/records/{recorded['id']}", "dean", 404)
        self.assertIn("2 research records deleted, 4 skipped", body["message"])

    def test_select_all_finds_only_what_the_event_manager_may_delete(self):
        draft = self.create(title="A draft patent for select all")
        recorded = self.accepted(title="A recorded patent for select all")
        self.submitted()  # the Dean's: not offered
        found = self.call("GET", "/research/records/deletable-ids", "manager")
        self.assertEqual({r["id"] for r in found["records"]}, {draft["id"], recorded["id"]})
        drafts = self.call("GET", "/research/records/deletable-ids?status=draft", "manager")
        self.assertEqual([r["id"] for r in drafts["records"]], [draft["id"]])
        searched = self.call("GET", "/research/records/deletable-ids?q=recorded%20patent", "manager")
        self.assertEqual([r["id"] for r in searched["records"]], [recorded["id"]])

    def test_bulk_delete_is_the_event_managers(self):
        record = self.create("teacher")
        self.call("POST", "/research/records/bulk-delete", "teacher", 403, json={"ids": [record["id"]]})
        self.call("GET", "/research/records/deletable-ids", "teacher", 403)
        self.call("POST", "/research/records/bulk-delete", "dean", 403, json={"ids": [record["id"]]})

    def test_the_event_manager_can_delete_what_they_recorded(self):
        recorded = self.accepted()
        self.assertTrue(self.call("GET", f"/research/records/{recorded['id']}", "manager")["record"]["permissions"]["can_delete"])
        # The teacher cannot: it is an accepted record.
        self.assertFalse(self.call("GET", f"/research/records/{recorded['id']}", "teacher")["record"]["permissions"]["can_delete"])
        self.call("DELETE", f"/research/records/{recorded['id']}", "teacher", 409)
        self.call("DELETE", f"/research/records/{recorded['id']}", "manager")
        # Removed from the database, the Event Manager's list, and select-all...
        self.call("GET", f"/research/records/{recorded['id']}", "manager", 404)
        self.assertEqual(self.call("GET", "/research/records/deletable-ids", "manager")["records"], [])
        # The Dean can no longer fetch it, and its evidence is removed too.
        self.call("GET", f"/dean/research/records/{recorded['id']}", "dean", 404)
        self.assertEqual(len(self.deleted), 1)
        self.assertEqual(len(self.notes_for(TEACHER_ID, "research_removed")), 1)

    def test_event_manager_deletion_removes_each_active_research_category(self):
        cases = (
            ("journal", "published", "Full paper", {
                "author_position": "First author", "journal": "Journal of Testing", "indexing": ["Scopus"],
            }),
            ("conference", "presented", "Certificate", {
                "presentation_type": "Oral presentation", "conference": "Test Conference",
                "organiser": "SRHU", "level": "National",
            }),
            ("patent", "filed", "Filing receipt", {"inventors": "Meera Joshi", "office": "India (IPO)", "application_number": "2026000123"}),
            ("book", "published", "Cover page", {
                "book_type": "Authored book", "authors": "Meera Joshi", "publisher": "Test Press",
            }),
            ("other", "recorded", "Certificate", {"kind": "Award / honour", "awarded_by": "SRHU"}),
        )

        for category, outcome, evidence_tag, details in cases:
            with self.subTest(category=category):
                record = self.create(
                    category=category,
                    title=f"Delete {category} record",
                    outcome_status=outcome,
                    details=details,
                )
                self.attach(record["id"], tag=evidence_tag)
                submitted = self.call("POST", f"/research/records/{record['id']}/submit", "manager")["record"]
                self.assertEqual(submitted["verification_status"], "verified")
                self.call("GET", f"/dean/research/records/{record['id']}", "dean")

                self.call("DELETE", f"/research/records/{record['id']}", "manager")

                self.call("GET", f"/research/records/{record['id']}", "manager", 404)
                self.call("GET", f"/dean/research/records/{record['id']}", "dean", 404)
                self.assertEqual(self.records.docs, [])
        self.assertEqual(len(self.deleted), len(cases))

    def test_legacy_manager_removed_records_are_excluded_from_dean_lists_and_counts(self):
        removed = self.accepted(title="Legacy removed record")
        removed_doc = next(doc for doc in self.records.docs if str(doc["_id"]) == removed["id"])
        removed_doc["manager_removed_at"] = datetime.now(timezone.utc)

        listed = self.call("GET", "/dean/research/records?status=all", "dean")
        overview = self.call("GET", "/dean/research/overview", "dean")
        summary = self.call("GET", "/dean/research/summary", "dean")

        self.assertEqual(listed["records"], [])
        self.assertEqual(listed["counts"]["all"], 0)
        self.assertEqual(overview["total"], 0)
        self.assertEqual(summary["by_category"], {})
        self.call("GET", f"/dean/research/records/{removed['id']}", "dean", 404)

    def test_the_deans_overview_and_date_filter_cover_the_event_managers_submissions(self):
        older = self.accepted(title="Patent filed in January", record_date="2026-01-15")
        newer = self.accepted(title="Patent filed in March", record_date="2026-03-20")
        self.submitted()                      # a teacher's own: not in the Dean's view
        self.create(title="A draft patent")   # a draft: never shown to the Dean
        overview = self.call("GET", "/dean/research/overview", "dean")
        self.assertEqual((overview["total"], overview["faculty_count"]), (2, 1))
        self.assertEqual(overview["patents"], {"filed": 2})
        self.assertEqual(overview["by_category"], {"patent": 2})
        march = self.call("GET", "/dean/research/overview?start_date=2026-03-01&end_date=2026-03-31", "dean")
        self.assertEqual(march["total"], 1)
        # The category filter narrows the figures, not the category counts.
        journals = self.call("GET", "/dean/research/overview?category=journal", "dean")
        self.assertEqual((journals["total"], journals["by_category"]), (0, {"patent": 2}))

        listed = self.call("GET", "/dean/research/records?status=event_manager", "dean")["records"]
        self.assertEqual([r["id"] for r in listed], [newer["id"], older["id"]])  # newest research date first
        january = self.call("GET", "/dean/research/records?status=event_manager&end_date=2026-01-31", "dean")
        self.assertEqual([r["id"] for r in january["records"]], [older["id"]])
        self.call("GET", "/dean/research/records?status=event_manager&start_date=31-01-2026", "dean", 400)
        self.call("GET", "/dean/research/records?start_date=2026-03-01&end_date=2026-01-01", "dean", 400)
        response = self.client.get(
            "/dean/research/export.xlsx?status=event_manager&start_date=2026-03-01",
            headers={"Authorization": "Bearer dean"},
        )
        self.assertEqual(response.status_code, 200)

    def test_the_dean_sees_event_manager_submissions_without_verification_statuses(self):
        recorded = self.accepted()                 # the Event Manager's submission
        verified = self.accepted(who="teacher")    # a teacher's, verified by the Dean
        waiting = self.submitted()
        mine = self.call("GET", "/dean/research/records?status=event_manager", "dean")
        self.assertEqual([r["id"] for r in mine["records"]], [recorded["id"]])
        counts = mine["counts"]
        self.assertEqual((counts["event_manager"], counts["verified"], counts["submitted"], counts["all"]), (1, 1, 1, 3))
        in_verified = self.call("GET", "/dean/research/records?status=verified", "dean")["records"]
        self.assertEqual([r["id"] for r in in_verified], [verified["id"]])
        everything = self.call("GET", "/dean/research/records?status=all", "dean")["records"]
        self.assertEqual({r["id"] for r in everything}, {recorded["id"], verified["id"], waiting["id"]})
        summary = self.call("GET", "/dean/research/summary", "dean")["counts"]
        self.assertEqual((summary["verified"], summary["event_manager"]), (1, 1))
        # The Event Manager's delete removes it from the shared portfolio.
        self.call("DELETE", f"/research/records/{recorded['id']}", "manager")
        again = self.call("GET", "/dean/research/records?status=event_manager", "dean")
        self.assertEqual(again["records"], [])
        self.assertEqual((again["counts"]["event_manager"], again["counts"]["all"]), (0, 2))
        self.call("GET", f"/dean/research/records/{recorded['id']}", "dean", 404)
        # The Dean has no delete.
        self.call("DELETE", f"/research/records/{recorded['id']}", "dean", 403)

    def test_what_is_the_deans_cannot_be_deleted_by_the_event_manager(self):
        waiting = self.submitted("teacher")
        self.call("DELETE", f"/research/records/{waiting['id']}", "manager", 409)
        verified = self.accepted("teacher")  # verified by the Dean
        self.assertFalse(self.call("GET", f"/research/records/{verified['id']}", "manager")["record"]["permissions"]["can_delete"])
        self.call("DELETE", f"/research/records/{verified['id']}", "manager", 409)
        self.assertEqual(len(self.records.docs), 2)

    def test_the_teacher_can_flag_what_the_event_manager_entered(self):
        record = self.create()
        self.call("POST", f"/research/records/{record['id']}/flag", "manager", 403, json={"note": "Wrong"})
        flagged = self.call("POST", f"/research/records/{record['id']}/flag", "teacher",
                            json={"note": "The application number is wrong."})["record"]
        self.assertEqual(flagged["history"][-1]["action"], "correction_flagged")
        self.assertEqual(len(self.notes_for(MANAGER_ID, "research_flagged")), 1)

    def test_bulk_verify_reports_what_it_skipped(self):
        first = self.submitted()
        second = self.submitted()
        self.call("PATCH", f"/dean/research/records/{second['id']}/verify", "dean")
        body = self.call("POST", "/dean/research/bulk-verify", "dean", json={"ids": [first["id"], second["id"]]})
        self.assertEqual(body["verified"], [first["id"]])
        self.assertEqual(body["failed"][0]["id"], second["id"])

    def test_dean_can_delete_one_visible_research_record_and_its_evidence(self):
        record = self.accepted("manager")

        body = self.call("DELETE", f"/dean/research/records/{record['id']}", "dean")

        self.assertEqual(body["message"], "Research record deleted")
        self.assertEqual(len(self.deleted), 1)
        self.call("GET", f"/dean/research/records/{record['id']}", "dean", 404)

    def test_dean_bulk_delete_reports_deleted_and_inaccessible_records(self):
        accepted = self.accepted("manager", title="Delete this accepted record")
        draft = self.create("manager", title="Keep this draft private")

        body = self.call(
            "POST",
            "/dean/research/bulk-delete",
            "dean",
            json={"ids": [accepted["id"], draft["id"]]},
        )

        self.assertEqual([item["id"] for item in body["deleted"]], [accepted["id"]])
        self.assertEqual([item["id"] for item in body["skipped"]], [draft["id"]])
        self.assertEqual(len(self.deleted), 1)
        self.call("GET", f"/dean/research/records/{accepted['id']}", "dean", 404)
        self.call("GET", f"/research/records/{draft['id']}", "manager")

    def test_summary_counts_verified_by_default(self):
        verified = self.submitted()
        self.call("PATCH", f"/dean/research/records/{verified['id']}/verify", "dean")
        self.submitted()
        only_verified = self.call("GET", "/dean/research/summary", "dean")
        self.assertEqual(only_verified["by_category"], {"patent": 1})
        self.assertEqual(only_verified["patents"], {"filed": 1})
        with_pending = self.call("GET", "/dean/research/summary?include_pending=true", "dean")
        self.assertEqual(with_pending["by_category"], {"patent": 2})

    def test_roles_stay_in_their_lane(self):
        self.call("GET", "/dean/research/records", "teacher", 403)
        self.call("GET", "/dean/research/records", "manager", 403)
        self.call("GET", "/research/records", "dean", 403)
        self.call("DELETE", "/dean/research/records/000000000000000000000001", "manager", 403)
        self.call("POST", "/dean/research/bulk-delete", "manager", 403, json={"ids": ["000000000000000000000001"]})
        self.call("GET", "/research/faculty", "teacher", 403)
        faculty = self.call("GET", "/research/faculty?q=meera", "manager")["faculty"]
        self.assertEqual([f["name"] for f in faculty], ["Meera Joshi"])


if __name__ == "__main__":
    unittest.main()
