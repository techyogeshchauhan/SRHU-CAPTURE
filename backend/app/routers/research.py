"""Research portfolio: journal and conference papers, patents, books and achievements.

Who does what
-------------
* **Event Manager** (the primary operator): enters, edits and submits records
  for any teacher, and sees every record.
* **Teacher**: the same, for their own records only -- including the ones an
  Event Manager entered for them, which they can also flag as wrong.
* **Dean**: verifies what teachers submit; asks for changes, rejects, or
  withdraws a verification. Never on their own record.

What the Event Manager submits is *recorded* at once -- accepted without the
Dean's verification, as the Event Manager's events are. The record is stored
as ``verified`` with ``verified_by.role == "event_manager"``, so analytics,
showcases and exports count it like any accepted record, and the Dean has no
decision to make on it. A teacher's own submission still goes to the Dean.

A record belongs to a faculty member (`faculty_id`) and remembers who typed
it in (`created_by`). Its *outcome* (a patent filed / published / granted)
and its *verification* (draft / submitted / verified ...) are separate fields
that are never merged; see app/models/documents.py.

Paths are literal, as in events.py: ``/research/...`` for the two authoring
roles and ``/dean/research/...`` for the Dean.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import asdict
from datetime import date

from fastapi import (
    APIRouter,
    BackgroundTasks,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import JSONResponse
from pymongo import ASCENDING, DESCENDING
from pymongo.errors import DuplicateKeyError

from app.config import settings
from app.database import notifications, research_records, users
from app.models.documents import (
    RESEARCH_DELETABLE_STATUSES,
    RESEARCH_SUBMITTABLE_STATUSES,
    RESEARCH_VERIFICATION_STATUSES,
    academic_year_of,
    new_history_entry,
    new_notification_document,
    new_research_evidence,
    new_research_record_document,
)
from app.schemas.research import (
    CorrectionFlagRequest,
    DuplicateCheckRequest,
    DeanRemarksRequest,
    RequiredRemarksRequest,
    ResearchBulkDeleteRequest,
    ResearchBulkRecordRequest,
    ResearchBulkVerifyRequest,
    ResearchCreateRequest,
    ResearchUpdateRequest,
)
from app.routers.auth import find_user_by_email
from app.routers.dean_teachers import (
    ADDED_SOURCE,
    _deliver_invite,
    _existing_account_reason,
    _new_teacher_document,
    _unusable_password_hash,
)
from app.schemas.dean import DeanCreateTeacherRequest
from app.services import email_service
from app.services.audit_service import log_audit_event
from app.services.research_identifiers import identifiers_of, match_label
from app.services.research_reminders import reminders_for
from app.services.upload_config_service import get_upload_limits
from app.services.research_categories import (
    DetailsError,
    clean_details,
    get_category,
    get_display_category,
    outcome_keys,
    outcome_label,
    serialize_category,
    serialize_categories,
)
from app.services.storage_service import (
    absolutize,
    check_file_signature,
    delete_stored,
    inspect_document,
    inspect_media,
    peek_head,
    save_upload,
    stream_upload,
)
from app.utils.auth import get_current_user, require_role
from app.utils.serializers import serialize, serialize_many, to_object_id, utc_now

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Research"])

AUTHOR_ROLES = ("teacher", "event_manager")

# The panel each role opens a record in, for links in notifications and email.
RECORD_PATHS = {
    "teacher": "/teacher/research/{id}",
    "event_manager": "/event_manager/research/{id}",
    "dean": "/dean/research/{id}",
}

EVIDENCE_EXTENSIONS = (".pdf", ".jpg", ".jpeg", ".png", ".webp")

# Fields compared when a verified record is edited, and kept in the snapshot
# the Dean compares a re-verification against.
SNAPSHOT_FIELDS = ("title", "record_date", "outcome_status", "details", "abstract", "link")


# ============================================================
# HELPERS
# ============================================================

def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Research record not found")


def _conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def _bad_request(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=message)


def _author(authorization: str | None) -> dict:
    return require_role(get_current_user(authorization), *AUTHOR_ROLES)


def _dean(authorization: str | None) -> dict:
    return require_role(get_current_user(authorization), "dean")


def _scope(user: dict) -> dict:
    """What an author may see: an Event Manager's remaining records, or a
    teacher's own records."""
    if user.get("role") == "event_manager":
        return {"manager_removed_at": None}
    return {"faculty_id": user["id"]}


def _read_scope(user: dict) -> dict:
    """What an author may read: as _scope, and for a teacher also the work
    they are a co-author of -- which they see, but cannot change."""
    if user.get("role") == "event_manager":
        return _scope(user)
    return {"$and": [authored_by(user["id"])]}


def authored_by(faculty_id: str) -> dict:
    """Records a faculty member is an author of: their own, or as a co-author."""
    return {"$or": [{"faculty_id": faculty_id}, {"co_faculty_ids": faculty_id}]}


def _and(query: dict, clause: dict) -> None:
    """Add a clause to a query that may already hold an $or of its own."""
    query["$and"] = [*query.get("$and", []), clause]


def authors_of(record: dict) -> list[str]:
    """The record's faculty member first, then its co-authors."""
    first = record.get("faculty_id")
    rest = [fid for fid in record.get("co_faculty_ids") or [] if fid and fid != first]
    return [first, *rest] if first else rest


def _co_authors_or_400(ids: list[str] | None, faculty_id: str) -> list[str]:
    """The co-authors as stored: existing teachers, each once, never the
    faculty member the record belongs to."""
    wanted = [fid.strip() for fid in ids or [] if fid and fid.strip() and fid.strip() != faculty_id]
    wanted = list(dict.fromkeys(wanted))
    object_ids = [to_object_id(fid) for fid in wanted]
    if any(oid is None for oid in object_ids):
        raise _bad_request("A co-author could not be found. Choose them again.")
    found = {
        str(person["_id"])
        for person in users.find({"_id": {"$in": object_ids}, "role": "teacher"}, {"_id": 1})
    } if object_ids else set()
    if len(found) != len(wanted):
        raise _bad_request("A co-author could not be found. Choose them again.")
    return wanted


def _find_for_author(record_id: str, user: dict) -> dict:
    object_id = to_object_id(record_id)
    if object_id is None:
        raise _not_found()
    record = research_records.find_one({"_id": object_id, **_scope(user)})
    if not record:
        # Someone else's record is reported as missing, not forbidden, so a
        # teacher cannot probe which ids exist.
        raise _not_found()
    return record


def _find_for_dean(record_id: str) -> dict:
    object_id = to_object_id(record_id)
    record = research_records.find_one({"_id": object_id, "manager_removed_at": None}) if object_id else None
    # Drafts are the author's business until they are submitted.
    if not record or record.get("verification_status") == "draft":
        raise _not_found()
    return record


def _reload(record: dict) -> dict:
    """The record as stored. Always re-read after a write: MongoDB keeps
    timestamps to the millisecond, and the copy in hand has microseconds, so
    an `updated_at` handed back from memory would never match on the next
    save's conflict check."""
    fresh = research_records.find_one({"_id": record["_id"]})
    if not fresh:
        raise _not_found()
    return fresh


def _category_or_400(key: str | None):
    category = get_category(key)
    if category is None:
        raise _bad_request("Unknown research category.")
    return category


def _outcome_or_400(category, outcome: str | None) -> str:
    value = (outcome or "").strip().lower() or outcome_keys(category)[0]
    if value not in outcome_keys(category):
        raise _bad_request(f"“{outcome}” is not a status a {category.short.lower()} record can have.")
    return value


def _clean_or_400(category, details: dict | None, outcome: str, kept: dict | None = None) -> tuple[dict, list[str]]:
    try:
        return clean_details(category, details, outcome, kept)
    except DetailsError as error:
        raise _bad_request(str(error)) from None


def _missing_for_submission(record: dict) -> list[str]:
    """What still stops the record from going to the Dean."""
    category = get_category(record.get("category"))
    if category is None:
        return ["This research category is no longer available"]
    missing: list[str] = []
    if not record.get("title"):
        missing.append("Title")
    if not record.get("record_date"):
        missing.append(category.date_label if category else "Date")
    if category is not None:
        try:
            details = record.get("details")
            _, absent = clean_details(category, details, record.get("outcome_status") or "", details)
        except DetailsError:
            absent = []
        missing.extend(absent)
    return missing


def _attach_people(items: list[dict]) -> None:
    """Name the faculty member each record belongs to.

    No department: the platform serves one school (SST, see
    settings.default_host_department), so every researcher is in it.
    """
    ids = {fid for item in items for fid in authors_of(item)}
    object_ids = [oid for oid in (to_object_id(value) for value in ids) if oid is not None]
    people: dict[str, dict] = {}
    if object_ids:
        for person in users.find(
            {"_id": {"$in": object_ids}},
            {"name": 1, "email": 1, "designation": 1},
        ):
            people[str(person["_id"])] = {
                "id": str(person["_id"]),
                "name": person.get("name") or person.get("email"),
                "email": person.get("email"),
                "designation": person.get("designation"),
            }
    def card(faculty_id):
        return people.get(str(faculty_id)) or {"id": faculty_id, "name": "Unknown faculty member"}

    for item in items:
        item["faculty"] = card(item.get("faculty_id"))
        item["co_faculty"] = [card(fid) for fid in authors_of(item)[1:]]


def _present_evidence(request: Request, entry: dict) -> dict:
    signed = absolutize(request, dict(entry), "url") or {}
    return {
        "id": entry.get("id"),
        "tag": entry.get("tag"),
        "file_name": entry.get("file_name"),
        "content_type": entry.get("content_type"),
        "file_size": entry.get("file_size"),
        "url": signed.get("url"),
        "uploaded_by_name": entry.get("uploaded_by_name"),
        "created_at": serialize({"t": entry.get("created_at")})["t"],
    }


def _visible_to(viewer: dict) -> dict:
    """Which other records a viewer may be warned about. A draft is its
    author's business, except to an Event Manager (who keeps every draft)."""
    role = viewer.get("role")
    if role == "event_manager":
        return {}
    if role == "teacher":
        return {"$or": [{"verification_status": {"$ne": "draft"}}, {"faculty_id": viewer.get("id")}]}
    return {"verification_status": {"$ne": "draft"}}


def find_duplicates(identifiers: list[str], viewer: dict, *, exclude=()) -> dict[str, list[dict]]:
    """Other records sharing an identifier, keyed by identifier."""
    if not identifiers:
        return {}
    excluded = {str(value) for value in exclude}
    query = {"identifiers": {"$in": list(identifiers)}, **_visible_to(viewer)}
    found = [
        row for row in research_records.find(
            query,
            {"title": 1, "category": 1, "faculty_id": 1, "verification_status": 1, "identifiers": 1},
        )
        if str(row["_id"]) not in excluded
    ]
    if not found:
        return {}
    names = {}
    object_ids = [oid for oid in {to_object_id(row.get("faculty_id")) for row in found} if oid is not None]
    for person in users.find({"_id": {"$in": object_ids}}, {"name": 1, "email": 1}):
        names[str(person["_id"])] = person.get("name") or person.get("email")
    by_identifier: dict[str, list[dict]] = {}
    for row in found:
        for identifier in row.get("identifiers") or []:
            if identifier in identifiers:
                by_identifier.setdefault(identifier, []).append({
                    "id": str(row["_id"]),
                    "title": row.get("title"),
                    "category": row.get("category"),
                    "faculty_id": row.get("faculty_id"),
                    "faculty_name": names.get(str(row.get("faculty_id"))) or "Unknown faculty member",
                    "verification_status": row.get("verification_status"),
                    "match": match_label(identifier),
                })
    return by_identifier


def duplicates_for(record: dict, matches: dict[str, list[dict]]) -> list[dict]:
    """One entry per other record, named by its most specific match."""
    seen: dict[str, dict] = {}
    for identifier in record.get("identifiers") or []:
        for match in matches.get(identifier, []):
            if match["id"] == str(record.get("_id")) or match["id"] in seen:
                continue
            seen[match["id"]] = {**match, "same_faculty": match["faculty_id"] == record.get("faculty_id")}
    return list(seen.values())


def _present(request: Request, records: list[dict], viewer: dict) -> list[dict]:
    items = serialize_many(records)
    _attach_people(items)
    matches = find_duplicates(sorted({i for record in records for i in record.get("identifiers") or []}), viewer)
    today = date.today()
    for raw, item in zip(records, items):
        active_category = get_category(item.get("category"))
        category = active_category or get_display_category(item.get("category"))
        if category:
            visible_detail_keys = {field.key for field in category.fields}
            item["details"] = {
                key: value
                for key, value in (item.get("details") or {}).items()
                if key in visible_detail_keys
            }
            snapshot = item.get("verified_snapshot")
            if isinstance(snapshot, dict):
                snapshot["details"] = {
                    key: value
                    for key, value in (snapshot.get("details") or {}).items()
                    if key in visible_detail_keys
                }
        item["category_label"] = category.label if category else item.get("category")
        item["category_active"] = active_category is not None
        if active_category is None and category is not None:
            # Existing project/grant records remain readable, with their old
            # labels and fields, but the metadata is never used to make forms.
            item["category_definition"] = serialize_category(category)
        item["outcome_label"] = (
            outcome_label(category, item.get("outcome_status")) if category else item.get("outcome_status")
        )
        item["evidence"] = [_present_evidence(request, entry) for entry in raw.get("evidence") or []]
        item["missing"] = _missing_for_submission(raw)
        item["recorded_by_manager"] = recorded_by_manager(raw)
        item["permissions"] = _permissions(item, viewer)
        item["duplicates"] = duplicates_for(raw, matches)
        if viewer.get("role") != "dean":
            item["reminders"] = [asdict(reminder) for reminder in reminders_for(raw, today)]
        item.pop("identifiers", None)
    return items


def _present_one(request: Request, record: dict, viewer: dict) -> dict:
    return _present(request, [record], viewer)[0]


def _permissions(item: dict, viewer: dict) -> dict:
    state = item.get("verification_status")
    if viewer.get("role") == "dean":
        own = viewer.get("id") in (item.get("faculty_id"), item.get("created_by"))
        recorded = item.get("recorded_by_manager")
        return {
            "own": own,
            "can_verify": not own and state == "submitted" and not waiting_on_manager(item),
            # Recorded by the Event Manager, or handled by them since: there is
            # nothing for the Dean to withdraw.
            "can_unverify": not own and state == "verified" and not recorded and not handled_by_manager(item),
        }
    if viewer.get("role") == "teacher" and item.get("faculty_id") != viewer.get("id"):
        # A co-author sees the record in their portfolio; it is not theirs to change.
        return {"can_edit": False, "can_submit": False, "can_delete": False, "can_flag": False, "co_author": True}
    return {
        "can_edit": get_category(item.get("category")) is not None,
        "can_submit": get_category(item.get("category")) is not None and state in RESEARCH_SUBMITTABLE_STATUSES,
        "can_delete": can_delete(item, viewer),
        # The faculty member may say an Event Manager got their record wrong.
        "can_flag": viewer.get("role") == "teacher"
        and item.get("faculty_id") == viewer.get("id")
        and item.get("created_by") != viewer.get("id"),
    }


def recorded_by_manager(record: dict) -> bool:
    """Accepted because the Event Manager submitted it, not by the Dean."""
    return record.get("verification_status") == "verified" and (record.get("verified_by") or {}).get("role") == "event_manager"


_SUBMISSION_ACTIONS = ("submitted", "resubmitted", "reverification")


def latest_submission(record: dict) -> dict | None:
    """The history entry of the record's latest submission, if any."""
    for entry in reversed(record.get("history") or []):
        if entry.get("action") in _SUBMISSION_ACTIONS:
            return entry
    return None


def handled_by_manager(record: dict) -> bool:
    """The Event Manager entered the record, or has acted on it since -- an
    edit, evidence, a submission. Such a record is the Event Manager's: the
    Dean never verifies, sends back, rejects or withdraws it."""
    if record.get("created_by_role") == "event_manager":
        return True
    return any(entry.get("actor_role") == "event_manager" for entry in record.get("history") or [])


def _manager_of(record: dict) -> dict:
    """The Event Manager behind a record: who entered it, else who last acted on it."""
    if record.get("created_by_role") == "event_manager":
        return {"id": record.get("created_by"), "name": record.get("created_by_name"), "role": "event_manager"}
    for entry in reversed(record.get("history") or []):
        if entry.get("actor_role") == "event_manager":
            return {"id": entry.get("actor_id"), "name": entry.get("actor_name"), "role": "event_manager"}
    return {"id": None, "name": "Event Manager", "role": "event_manager"}


def waiting_on_manager(record: dict) -> bool:
    """Waiting for verification although the Event Manager has handled it:
    a submission made before Event Manager submissions were recorded
    directly, or a teacher's submission the Event Manager then worked on.
    Never the Dean's to decide; it is recorded instead (_settle_for_manager)."""
    return record.get("verification_status") == "submitted" and handled_by_manager(record)


def record_waiting_manager_submissions(*, apply: bool = True) -> list[dict]:
    """Record every Event Manager submission still waiting for the Dean.

    Run at startup (main.lifespan), so records submitted before direct
    recording leave the Dean's queue without anyone running a script; also
    behind scripts/record_event_manager_research.py. Idempotent. A teacher's
    submission is never touched. Returns the records it found.
    """
    found = [r for r in research_records.find({"verification_status": "submitted"}) if waiting_on_manager(r)]
    if not apply:
        return found
    for record in found:
        _record_for_manager(record)
    return found


def _record_for_manager(record: dict) -> bool:
    """Take a waiting record the Event Manager has handled out of the Dean's
    queue: recorded, accepted on the Event Manager's behalf."""
    manager = _manager_of(record)
    now = utc_now()
    result = research_records.update_one(
        # Re-checked in the filter, so a record decided meanwhile is left alone.
        {"_id": record["_id"], "verification_status": "submitted"},
        {
            "$set": {
                "verification_status": "verified",
                "verified_at": now,
                "verified_by": manager,
                "verified_snapshot": _snapshot(record),
                "dean_remarks": None,
                "updated_at": now,
            },
            "$push": {"history": new_history_entry(
                action="recorded",
                status="verified",
                from_status="submitted",
                actor=manager,
                note="Recorded by the Event Manager; research the Event Manager handles does not need Dean verification.",
            )},
        },
    )
    return bool(result.matched_count)


def _settle_for_manager(record: dict) -> None:
    """After a change: if the record is waiting for the Dean although the
    Event Manager has now handled it, record it instead."""
    fresh = research_records.find_one({"_id": record["_id"]})
    if fresh and waiting_on_manager(fresh):
        _record_for_manager(fresh)


def can_delete(record: dict, user: dict) -> bool:
    """Who may delete what.

    Anyone with the record: a draft or a rejected record. The Event Manager,
    who records without review, also: a record sent back for changes and
    anything they recorded. A teacher's submission with the Dean, or a record
    the Dean verified, is never deleted from here -- it is the Dean's.
    """
    state = record.get("verification_status")
    if state in RESEARCH_DELETABLE_STATUSES:
        return True
    if user.get("role") != "event_manager":
        return False
    return state == "changes_requested" or recorded_by_manager(record)


def _keeps_acceptance(record: dict, user: dict) -> bool:
    """Whether a change by `user` leaves an accepted record accepted.

    The Event Manager records without review, so their own changes do not
    send anything to the Dean; nor does a teacher's change to a record the
    Event Manager has handled, which is never the Dean's to decide. Any other
    change to an accepted record goes back to the Dean.
    """
    return record.get("verification_status") == "verified" and (
        user.get("role") == "event_manager" or handled_by_manager(record)
    )


def _refresh_snapshot(record: dict) -> None:
    """After the Event Manager changes an accepted record, what was accepted
    is the record as it now stands."""
    fresh = research_records.find_one({"_id": record["_id"]})
    if fresh:
        research_records.update_one({"_id": record["_id"]}, {"$set": {"verified_snapshot": _snapshot(fresh)}})


def _snapshot(record: dict) -> dict:
    snap = {key: record.get(key) for key in SNAPSHOT_FIELDS}
    snap["evidence"] = [
        {"id": entry.get("id"), "file_name": entry.get("file_name"), "tag": entry.get("tag")}
        for entry in record.get("evidence") or []
    ]
    return serialize(snap)


def _status_counts(base: dict, statuses) -> dict:
    counts = {key: research_records.count_documents({**base, "verification_status": key}) for key in statuses}
    counts["all"] = sum(counts.values())
    return counts


def _search_clause(q: str | None, *, include_people: bool) -> dict | None:
    text = (q or "").strip()
    if not text:
        return None
    pattern = {"$regex": re.escape(text), "$options": "i"}
    clauses: list[dict] = [{"title": pattern}]
    if include_people:
        ids = [
            str(person["_id"])
            for person in users.find(
                {"role": "teacher", "$or": [{"name": pattern}, {"email": pattern}]},
                {"_id": 1},
            )
        ]
        if ids:
            clauses.append({"faculty_id": {"$in": ids}})
            clauses.append({"co_faculty_ids": {"$in": ids}})
    return {"$or": clauses}


def apply_date_range(query: dict, start_date: str | None, end_date: str | None) -> None:
    """Records whose research date (publication, filing, presentation or start
    date) falls in [start_date, end_date]. Dates are "YYYY-MM-DD" strings and
    compare as strings."""
    span: dict = {}
    for key, value in (("$gte", start_date), ("$lte", end_date)):
        if not value:
            continue
        try:
            date.fromisoformat(value)
        except ValueError:
            raise _bad_request("Dates must use the YYYY-MM-DD format.") from None
        span[key] = value
    if start_date and end_date and start_date > end_date:
        raise _bad_request("The start date cannot be after the end date.")
    if span:
        query["record_date"] = span


def _apply_filters(query: dict, *, category: str | None, academic_year: str | None, faculty_id: str | None) -> None:
    if category:
        query["category"] = _category_or_400(category).key
    if academic_year:
        query["academic_year"] = academic_year.strip()
    if faculty_id:
        # One faculty member's research: what is theirs and what they co-authored.
        _and(query, authored_by(faculty_id.strip()))


def _page(cursor, skip: int, limit: int):
    if skip:
        cursor = cursor.skip(skip)
    return cursor.limit(limit)


def _academic_years(base: dict) -> list[str]:
    years = {
        row.get("academic_year")
        for row in research_records.find(base, {"academic_year": 1})
        if row.get("academic_year")
    }
    return sorted(years, reverse=True)


# ------------------------------------------------------------ notifications

def _notify(user_id: str | None, notification_type: str, title: str, message: str, record: dict) -> None:
    """An in-app notification. Never blocks the action that caused it."""
    if not user_id:
        return
    try:
        notifications.insert_one(
            new_notification_document(
                user_id=str(user_id),
                event_id=None,
                notification_type=notification_type,
                title=title,
                message=message,
                data={
                    "research_id": str(record["_id"]),
                    "research_title": record.get("title", ""),
                    "category": record.get("category", ""),
                },
            )
        )
    except Exception as error:  # noqa: BLE001 -- see docstring
        logger.warning("research_notification_failed user_id=%s type=%s error=%s", user_id, notification_type, error)


def _notify_deans(record: dict, *, title: str, message: str) -> None:
    for dean in users.find({"role": "dean"}, {"_id": 1}):
        _notify(str(dean["_id"]), "research_submitted", title, message, record)


def _send_decision_email(person: dict, record: dict, decision: str, remarks: str | None) -> None:
    path = RECORD_PATHS.get(person.get("role") or "", RECORD_PATHS["teacher"]).format(id=record["_id"])
    try:
        email_service.send_research_status_email(
            person["email"],
            person.get("name") or "there",
            record.get("title") or "Research record",
            decision,
            remarks,
            link_path=path,
        )
    except email_service.EmailDeliveryError:
        logger.warning("research_status_email_failed decision=%s", decision)


def _notify_people(
    background_tasks: BackgroundTasks,
    record: dict,
    *,
    decision: str,
    title: str,
    message: str,
    remarks: str | None,
    actor: dict,
) -> None:
    """Tell the faculty member and whoever entered the record -- once each,
    and never the Dean who made the decision."""
    recipients = []
    for user_id in (record.get("faculty_id"), record.get("created_by")):
        if user_id and user_id not in recipients and user_id != actor.get("id"):
            recipients.append(user_id)
    for user_id in recipients:
        _notify(user_id, decision, title, message, record)

    if not email_service.is_configured():
        return
    object_ids = [oid for oid in (to_object_id(value) for value in recipients) if oid is not None]
    if not object_ids:
        return
    for person in users.find({"_id": {"$in": object_ids}}, {"email": 1, "name": 1, "role": 1}):
        if person.get("email"):
            background_tasks.add_task(_send_decision_email, person, record, decision, remarks)


def _who(user: dict) -> str:
    return user.get("name") or user.get("email") or "Someone"


# ============================================================
# SHARED
# ============================================================

def evidence_limits() -> dict:
    """The evidence limits in force: the Super Admin's, or config.py's."""
    limits = get_upload_limits()
    return {
        "max_evidence_files": limits["max_research_evidence_files"],
        "max_evidence_total_mb": limits["max_research_evidence_total_mb"],
        "max_evidence_total_bytes": limits["max_research_evidence_total_bytes"],
        # Super Admin's switch: off means a record can be submitted without any.
        "evidence_required": bool(limits.get("research_evidence_required", False)),
        "evidence_extensions": list(EVIDENCE_EXTENSIONS),
    }


@router.get("/research/categories")
def list_categories(authorization: str | None = Header(default=None)):
    """Every category's fields, outcomes and evidence tags, for the forms."""
    get_current_user(authorization)
    return {
        "success": True,
        "categories": serialize_categories(),
        "statuses": list(RESEARCH_VERIFICATION_STATUSES),
        "limits": evidence_limits(),
    }


# ============================================================
# AUTHORS: EVENT MANAGER (ANY TEACHER) AND TEACHER (THEMSELVES)
# ============================================================

@router.get("/research/faculty")
def list_faculty(
    authorization: str | None = Header(default=None),
    q: str | None = Query(default=None, max_length=80),
    limit: int = Query(default=20, ge=1, le=50),
):
    """Teachers an Event Manager can enter research for."""
    user = _author(authorization)
    if user.get("role") != "event_manager":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only an Event Manager picks the faculty member.")

    query: dict = {"role": "teacher", "is_active": {"$ne": False}}
    text = (q or "").strip()
    if text:
        pattern = {"$regex": re.escape(text), "$options": "i"}
        query["$or"] = [{"name": pattern}, {"email": pattern}]
    people = users.find(query, {"name": 1, "email": 1, "designation": 1}).sort(
        "name", ASCENDING
    ).limit(limit)
    return {
        "success": True,
        "faculty": [
            {
                "id": str(person["_id"]),
                "name": person.get("name") or person.get("email"),
                "email": person.get("email"),
                "designation": person.get("designation"),
            }
            for person in people
        ],
    }


def _faculty_card(person: dict) -> dict:
    return {
        "id": str(person["_id"]),
        "name": person.get("name") or person.get("email"),
        "email": person.get("email"),
        "designation": person.get("designation"),
    }


@router.post("/research/faculty", status_code=status.HTTP_201_CREATED)
def add_faculty(payload: DeanCreateTeacherRequest, authorization: str | None = Header(default=None)):
    """An Event Manager adds a faculty member who has no account yet, from
    the research form, so their research can be recorded.

    The same Teacher account the Dean's "Add teacher" creates (the Dean's
    helpers, so the two cannot drift): no usable password until the teacher
    accepts an invitation, listed in the Dean's Teachers page as added. An
    email that already belongs to a teacher selects that teacher instead of
    failing; any other existing account is refused with the reason.
    """
    user = _author(authorization)
    if user.get("role") != "event_manager":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only an Event Manager adds faculty members here.")

    existing = find_user_by_email(payload.email)
    if existing:
        if existing.get("role") == "teacher" and not existing.get("removed_at"):
            if existing.get("is_active") is False:
                raise _conflict("This teacher's account is deactivated. Ask the Dean to activate it first.")
            return JSONResponse(status_code=status.HTTP_200_OK, content={
                "success": True,
                "existing": True,
                "message": f"{existing.get('name') or existing.get('email')} is already in the faculty list, and has been selected.",
                "faculty": _faculty_card(existing),
            })
        raise _conflict(_existing_account_reason(existing))

    now = utc_now()
    # The one school the platform serves, as every event is reported under.
    payload = payload.model_copy(update={"department": payload.department or settings.default_host_department})
    document = _new_teacher_document(payload, name=payload.name, password_hash=_unusable_password_hash(), extra={
        "onboarded_via": ADDED_SOURCE,
        "added_by": user.get("id"),
        "added_by_role": "event_manager",
        "added_at": now,
    })
    try:
        inserted = users.insert_one(document)
    except DuplicateKeyError:
        raise _conflict("Someone with this email was added a moment ago. Search for them instead.") from None
    document["_id"] = inserted.inserted_id

    invite: dict = {"status": "not_sent", "reason": None}
    if payload.send_invite:
        if not email_service.is_configured():
            invite["reason"] = "Email is not configured on the server, so no invitation was sent."
        else:
            outcome, reason = _deliver_invite(
                document,
                user,
                added_by="The Event Manager",
                purpose="where your research portfolio and events are kept",
            )
            invite = {"status": outcome, "reason": reason}

    log_audit_event(
        actor=user,
        action="teacher_created",
        target_type="user",
        target_id=str(document["_id"]),
        details={
            "via": "event_manager_research",
            "target_name": document.get("name"),
            "target_email": document.get("email"),
            "target_role": "teacher",
            "source": ADDED_SOURCE,
            "invite": invite["status"],
        },
    )

    name = document.get("name")
    if invite["status"] == "sent":
        message = f"{name} was added and invited to set a password."
    elif invite["status"] == "failed":
        message = f"{name} was added, but the invitation could not be sent: {invite['reason']} The Dean can resend it from Teachers."
    elif invite["reason"]:
        message = f"{name} was added. {invite['reason']}"
    else:
        message = f"{name} was added. The Dean can invite them from Teachers whenever they should sign in."
    return {"success": True, "existing": False, "message": message, "faculty": _faculty_card(document), "invite": invite}


def _list_query(user: dict, status_filter, category, academic_year, faculty_id, q) -> tuple[dict, dict]:
    """(the filters without the status tab, the full query) for an author's
    list -- one definition, so "select all matching" picks exactly what the
    list shows."""
    base = _read_scope(user)
    _apply_filters(
        base,
        category=category,
        academic_year=academic_year,
        # A teacher's scope already pins faculty_id; they cannot widen it.
        faculty_id=faculty_id if user.get("role") == "event_manager" else None,
    )
    search = _search_clause(q, include_people=user.get("role") == "event_manager")
    if search:
        base = {**base, **search}

    query = dict(base)
    wanted = (status_filter or "all").strip().lower()
    if wanted != "all":
        if wanted not in RESEARCH_VERIFICATION_STATUSES:
            raise _bad_request("Unknown status filter.")
        query["verification_status"] = wanted
    return base, query


@router.get("/research/records")
def list_records(
    request: Request,
    authorization: str | None = Header(default=None),
    status_filter: str | None = Query(default=None, alias="status", max_length=30),
    category: str | None = Query(default=None, max_length=30),
    academic_year: str | None = Query(default=None, max_length=10),
    faculty_id: str | None = Query(default=None, max_length=40),
    q: str | None = Query(default=None, max_length=200),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=25, ge=1, le=100),
):
    user = _author(authorization)
    base, query = _list_query(user, status_filter, category, academic_year, faculty_id, q)
    counts = _status_counts(base, RESEARCH_VERIFICATION_STATUSES)

    total = research_records.count_documents(query)
    cursor = research_records.find(query).sort([("updated_at", DESCENDING)])
    records = list(_page(cursor, skip, limit))
    items = _present(request, records, user)
    return {
        "success": True,
        "records": items,
        "total": total,
        "count": len(items),
        "has_more": skip + len(items) < total,
        "skip": skip,
        "limit": limit,
        "counts": counts,
        "academic_years": _academic_years(_read_scope(user)),
    }


# Records one bulk action (and "select all") may cover.
MAX_BULK_ACTIONS = 500


def _manager(authorization: str | None) -> dict:
    user = _author(authorization)
    if user.get("role") != "event_manager":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Event Manager access required")
    return user


@router.get("/research/records/deletable-ids")
def deletable_record_ids(
    authorization: str | None = Header(default=None),
    status_filter: str | None = Query(default=None, alias="status", max_length=30),
    category: str | None = Query(default=None, max_length=30),
    academic_year: str | None = Query(default=None, max_length=10),
    faculty_id: str | None = Query(default=None, max_length=40),
    q: str | None = Query(default=None, max_length=200),
):
    """Every record matching the register's filters that the Event Manager may
    delete, as ids and titles: "Select all" for a bulk delete, in one light
    request. Records waiting for the Dean or verified by the Dean are left
    out -- they cannot be deleted from here."""
    user = _manager(authorization)
    _, query = _list_query(user, status_filter, category, academic_year, faculty_id, q)
    rows = research_records.find(query, {"title": 1, "verification_status": 1, "verified_by": 1}).sort(
        [("updated_at", DESCENDING)]
    )
    found = [
        {
            "id": str(row["_id"]),
            "title": row.get("title"),
            "can_submit": row.get("verification_status") in RESEARCH_SUBMITTABLE_STATUSES,
        }
        for row in rows
        if can_delete(row, user)
    ]
    return {"success": True, "records": found[:MAX_BULK_ACTIONS], "total": len(found), "limit": MAX_BULK_ACTIONS}


@router.post("/research/records/bulk-delete")
def bulk_delete_records(payload: ResearchBulkDeleteRequest, authorization: str | None = Header(default=None)):
    """Delete the selected records, each by the same rules as deleting one.
    A record that cannot be deleted (with the Dean, verified by the Dean,
    changed meanwhile, or gone) is reported with the reason; the rest go."""
    user = _manager(authorization)
    deleted: list[dict] = []
    skipped: list[dict] = []
    for record_id in dict.fromkeys(payload.ids):
        object_id = to_object_id(record_id)
        record = research_records.find_one({"_id": object_id, **_scope(user)}) if object_id else None
        if not record:
            skipped.append({"id": record_id, "title": None, "reason": "Not found."})
            continue
        try:
            _delete_record(record, user)
            deleted.append({"id": record_id, "title": record.get("title")})
        except HTTPException as error:
            skipped.append({"id": record_id, "title": record.get("title"), "reason": error.detail})
    logger.info("research_bulk_deleted count=%d skipped=%d by=%s", len(deleted), len(skipped), user.get("id"))
    return {
        "success": True,
        "message": f"{len(deleted)} research record{'s' if len(deleted) != 1 else ''} deleted"
        + (f", {len(skipped)} skipped" if skipped else "") + ".",
        "deleted": deleted,
        "skipped": skipped,
    }


@router.post("/research/records/bulk-record")
def bulk_record_records(
    payload: ResearchBulkRecordRequest,
    request: Request,
    authorization: str | None = Header(default=None),
):
    """Record several Event Manager submissions in one action. Each record
    is checked independently; incomplete records are reported and skipped."""
    user = _manager(authorization)
    recorded: list[str] = []
    skipped: list[dict] = []
    for record_id in dict.fromkeys(payload.ids):
        object_id = to_object_id(record_id)
        record = research_records.find_one({"_id": object_id, **_scope(user)}) if object_id else None
        if not record:
            skipped.append({"id": record_id, "title": None, "reason": "Not found."})
            continue
        current = record.get("verification_status")
        if current not in RESEARCH_SUBMITTABLE_STATUSES:
            skipped.append({"id": record_id, "title": record.get("title"), "reason": "This record is no longer ready to be recorded."})
            continue
        if get_category(record.get("category")) is None:
            skipped.append({"id": record_id, "title": record.get("title"), "reason": "This research category is no longer available."})
            continue
        missing = _missing_for_submission(record)
        if missing:
            skipped.append({
                "id": record_id,
                "title": record.get("title"),
                "reason": "Fill in before recording: " + ", ".join(missing) + ".",
            })
            continue
        try:
            _record_directly(request, record, current, user)
            recorded.append(record_id)
        except HTTPException as error:
            skipped.append({"id": record_id, "title": record.get("title"), "reason": error.detail})

    logger.info("research_bulk_recorded count=%d skipped=%d by=%s", len(recorded), len(skipped), user.get("id"))
    return {
        "success": True,
        "message": f"{len(recorded)} research record{'s' if len(recorded) != 1 else ''} recorded"
        + (f", {len(skipped)} skipped" if skipped else "") + ".",
        "recorded": recorded,
        "skipped": skipped,
    }


@router.post("/research/records", status_code=status.HTTP_201_CREATED)
def create_record(
    payload: ResearchCreateRequest,
    request: Request,
    authorization: str | None = Header(default=None),
):
    user = _author(authorization)
    category = _category_or_400(payload.category)

    if user.get("role") == "event_manager":
        faculty_id = (payload.faculty_id or "").strip()
        object_id = to_object_id(faculty_id)
        faculty = users.find_one({"_id": object_id, "role": "teacher"}) if object_id else None
        if not faculty:
            raise _bad_request("Choose the teacher this research belongs to.")
        faculty_id = str(faculty["_id"])
    else:
        # A teacher records their own work only.
        if payload.faculty_id and payload.faculty_id != user["id"]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Teachers can only add research to their own portfolio.",
            )
        faculty_id = user["id"]
        faculty = None
    if payload.co_faculty_ids and user.get("role") != "event_manager":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the Event Manager names co-authors.")
    co_faculty_ids = _co_authors_or_400(payload.co_faculty_ids, faculty_id)

    outcome = _outcome_or_400(category, payload.outcome_status)
    details, _ = _clean_or_400(category, payload.details, outcome)

    document = new_research_record_document(
        faculty_id=faculty_id,
        created_by=user,
        category=category.key,
        title=payload.title,
        record_date=payload.record_date,
        outcome_status=outcome,
        details=details,
        link=payload.link,
    )
    document["co_faculty_ids"] = co_faculty_ids
    document["identifiers"] = identifiers_of(category.key, document["title"], details)
    document["history"] = [new_history_entry(action="created", status="draft", actor=user)]
    result = research_records.insert_one(document)
    document["_id"] = result.inserted_id

    if faculty_id != user["id"]:
        _notify(
            faculty_id,
            "research_added",
            "Research added to your portfolio",
            f'{_who(user)} added the {category.short.lower()} record "{payload.title}" to your research portfolio.',
            document,
        )
    _notify_co_authors(co_faculty_ids, user, category, payload.title, document)

    return {
        "success": True,
        "message": "Research record saved as a draft",
        "record": _present_one(request, _reload(document), user),
    }


def _notify_co_authors(co_faculty_ids: list[str], user: dict, category, title: str, document: dict) -> None:
    for co_author in co_faculty_ids:
        if co_author != user["id"]:
            _notify(
                co_author,
                "research_added",
                "Research added to your portfolio",
                f'{_who(user)} named you a co-author of the {category.short.lower()} record "{title}".',
                document,
            )


@router.get("/research/records/{record_id}")
def get_record(record_id: str, request: Request, authorization: str | None = Header(default=None)):
    user = _author(authorization)
    object_id = to_object_id(record_id)
    record = research_records.find_one({"_id": object_id, **_read_scope(user)}) if object_id else None
    if not record:
        raise _not_found()
    return {"success": True, "record": _present_one(request, record, user)}


def _send_back_if_verified(record: dict, changes: dict) -> str:
    """Editing a verified record sends it back to the Dean.

    Returns the history action to record. The snapshot of what was verified
    stays, so the Dean sees exactly what changed.
    """
    if record.get("verification_status") != "verified":
        return "updated"
    changes["verification_status"] = "submitted"
    changes["submitted_at"] = utc_now()
    return "reverification"


@router.patch("/research/records/{record_id}")
def update_record(
    record_id: str,
    payload: ResearchUpdateRequest,
    request: Request,
    authorization: str | None = Header(default=None),
):
    user = _author(authorization)
    record = _find_for_author(record_id, user)
    category = _category_or_400(record.get("category"))

    if payload.expected_updated_at and payload.expected_updated_at != serialize(
        {"t": record.get("updated_at")}
    )["t"]:
        raise _conflict("This record was changed by someone else. Reload it to see their changes.")

    fields = payload.model_dump(exclude_unset=True)
    fields.pop("expected_updated_at", None)

    changes: dict = {}
    if "title" in fields:
        if not fields["title"]:
            raise _bad_request("Give the record a title.")
        changes["title"] = fields["title"]
    if "record_date" in fields:
        changes["record_date"] = fields["record_date"]
        changes["academic_year"] = academic_year_of(fields["record_date"])
    if "link" in fields:
        changes["link"] = fields["link"]
    if fields.get("co_faculty_ids") is not None:
        if user.get("role") != "event_manager":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the Event Manager names co-authors.")
        changes["co_faculty_ids"] = _co_authors_or_400(fields["co_faculty_ids"], record.get("faculty_id"))

    outcome = record.get("outcome_status")
    # An older record's retired status (a journal paper still "accepted")
    # may be sent back unchanged.
    if "outcome_status" in fields and fields["outcome_status"] != outcome:
        outcome = _outcome_or_400(category, fields["outcome_status"])
        changes["outcome_status"] = outcome
    if "details" in fields:
        changes["details"], _ = _clean_or_400(category, fields["details"], outcome, record.get("details"))

    if "title" in changes or "details" in changes:
        changes["identifiers"] = identifiers_of(
            category.key, changes.get("title", record.get("title")), changes.get("details", record.get("details"))
        )

    # Only what actually differs counts: saving an untouched form must not
    # send a verified record back to the Dean.
    changes = {
        key: value for key, value in changes.items()
        if record.get(key, [] if key == "co_faculty_ids" else None) != value
    }
    if not changes:
        return {"success": True, "message": "Nothing changed", "record": _present_one(request, record, user)}

    keep = _keeps_acceptance(record, user)
    action = "updated" if keep else _send_back_if_verified(record, changes)
    changes["updated_at"] = utc_now()
    entry = new_history_entry(
        action=action,
        status=changes.get("verification_status", record.get("verification_status")),
        from_status=record.get("verification_status"),
        actor=user,
    )
    result = research_records.update_one(
        {"_id": record["_id"], "updated_at": record.get("updated_at")},
        {"$set": changes, "$push": {"history": entry}},
    )
    if not result.matched_count:
        raise _conflict("This record was changed by someone else. Reload it to see their changes.")
    if keep:
        _refresh_snapshot(record)
    _settle_for_manager(record)

    if action == "reverification":
        _notify_deans(
            record,
            title="Verified research updated",
            message=f'{_who(user)} changed the verified record "{changes.get("title", record.get("title"))}"; it needs verifying again.',
        )
    if "co_faculty_ids" in changes:
        added = [fid for fid in changes["co_faculty_ids"] if fid not in (record.get("co_faculty_ids") or [])]
        _notify_co_authors(added, user, category, changes.get("title", record.get("title")), record)

    return {
        "success": True,
        "message": "Sent back to the Dean for verification" if action == "reverification" else "Research record updated",
        "record": _present_one(request, _reload(record), user),
    }


@router.post("/research/duplicates")
def check_duplicates(payload: DuplicateCheckRequest, authorization: str | None = Header(default=None)):
    """Records that already claim the work being typed into the form, so the
    author is warned before saving rather than after."""
    user = _author(authorization)
    category = _category_or_400(payload.category)
    try:
        details, _ = clean_details(category, payload.details, outcome_keys(category)[0])
    except DetailsError:
        details = {}
    identifiers = identifiers_of(category.key, payload.title, details)
    matches = find_duplicates(identifiers, user, exclude=[payload.exclude_id] if payload.exclude_id else [])
    probe = {
        "_id": payload.exclude_id or "",
        "identifiers": identifiers,
        "faculty_id": payload.faculty_id or user["id"],
    }
    return {"success": True, "duplicates": duplicates_for(probe, matches)}


@router.post("/research/records/{record_id}/submit")
def submit_record(record_id: str, request: Request, authorization: str | None = Header(default=None)):
    user = _author(authorization)
    record = _find_for_author(record_id, user)
    if get_category(record.get("category")) is None:
        raise _conflict("This research category is no longer available for submission.")
    current = record.get("verification_status")

    if current not in RESEARCH_SUBMITTABLE_STATUSES:
        if current == "submitted":
            raise _conflict("This record is already waiting for the Dean.")
        raise _conflict("This record has already been verified.")

    missing = _missing_for_submission(record)
    if missing:
        raise _bad_request("Fill in before submitting: " + ", ".join(missing) + ".")
    # No evidence is asked for: research forms no longer take uploads.

    if user.get("role") == "event_manager":
        return _record_directly(request, record, current, user)
    # A teacher submitting what the Event Manager entered or worked on: the
    # Event Manager's research, recorded without the Dean.
    if handled_by_manager(record):
        return _record_directly(request, record, current, user, keeper=_manager_of(record))

    action = "resubmitted" if record.get("submitted_at") else "submitted"
    now = utc_now()
    result = research_records.update_one(
        {"_id": record["_id"], "verification_status": current},
        {
            "$set": {"verification_status": "submitted", "submitted_at": now, "updated_at": now},
            "$push": {
                "history": new_history_entry(action=action, status="submitted", from_status=current, actor=user)
            },
        },
    )
    if not result.matched_count:
        raise _conflict("This record was changed by someone else. Reload it to see their changes.")

    _notify_deans(
        record,
        title="Research resubmitted" if action == "resubmitted" else "Research submitted",
        message=f'{_who(user)} {action} "{record.get("title")}" for verification.',
    )
    return {
        "success": True,
        "message": "Sent to the Dean for verification",
        "record": _present_one(request, _reload(record), user),
    }


def _record_directly(request: Request, record: dict, current: str, user: dict, *, keeper: dict | None = None) -> dict:
    """The Event Manager's submission: accepted at once, never queued for the
    Dean (as the Event Manager's events are recorded without review).

    `keeper` is the Event Manager it is recorded for when a teacher submits a
    record the Event Manager entered or worked on; by default, the user."""
    keeper = keeper or user
    now = utc_now()
    result = research_records.update_one(
        {"_id": record["_id"], "verification_status": current},
        {
            "$set": {
                "verification_status": "verified",
                "submitted_at": now,
                "verified_at": now,
                "verified_by": {"id": keeper.get("id"), "name": keeper.get("name") or keeper.get("email"), "role": "event_manager"},
                "verified_snapshot": _snapshot(record),
                "dean_remarks": None,
                "updated_at": now,
            },
            "$push": {
                "history": new_history_entry(
                    action="recorded",
                    status="verified",
                    from_status=current,
                    actor=user,
                    note=(
                        "Recorded by the Event Manager; no Dean verification needed."
                        if keeper is user
                        else "Entered by the Event Manager, so recorded without Dean verification."
                    ),
                )
            },
        },
    )
    if not result.matched_count:
        raise _conflict("This record was changed by someone else. Reload it to see their changes.")

    if record.get("faculty_id") and record.get("faculty_id") != user.get("id"):
        _notify(
            record.get("faculty_id"),
            "research_verified",
            "Research recorded in your portfolio",
            f'{_who(user)} recorded "{record.get("title")}" in your research portfolio.',
            record,
        )
    return {
        "success": True,
        "message": "Recorded in the research portfolio",
        "record": _present_one(request, _reload(record), user),
    }


@router.delete("/research/records/{record_id}")
def delete_record(record_id: str, authorization: str | None = Header(default=None)):
    user = _author(authorization)
    _delete_record(_find_for_author(record_id, user), user)
    return {"success": True, "message": "Research record deleted"}


@router.delete("/dean/research/records/{record_id}")
def dean_delete_record(record_id: str, authorization: str | None = Header(default=None)):
    """Permanently remove one non-draft record from the Dean's research view."""
    user = _dean(authorization)
    record = _find_for_dean(record_id)
    _delete_record_permanently(record, user)
    return {"success": True, "message": "Research record deleted"}


@router.post("/dean/research/bulk-delete")
def dean_bulk_delete_records(
    payload: ResearchBulkDeleteRequest,
    authorization: str | None = Header(default=None),
):
    """Delete selected Dean-visible records; report any that changed meanwhile."""
    user = _dean(authorization)
    deleted: list[dict] = []
    skipped: list[dict] = []
    for record_id in dict.fromkeys(payload.ids):
        record = None
        try:
            record = _find_for_dean(record_id)
            _delete_record_permanently(record, user)
            deleted.append({"id": record_id, "title": record.get("title")})
        except HTTPException as error:
            skipped.append({"id": record_id, "title": record.get("title") if record else None, "reason": error.detail})

    return {
        "success": True,
        "message": f"{len(deleted)} research record{'s' if len(deleted) != 1 else ''} deleted"
        + (f", {len(skipped)} skipped" if skipped else "."),
        "deleted": deleted,
        "skipped": skipped,
    }


def _delete_record(record: dict, user: dict) -> None:
    """Delete one record by the rules of can_delete, with its evidence files,
    an audit entry and a notice to the faculty member. HTTPException (409)
    when it may not be deleted or changed meanwhile.

    Event Manager records are deletable by their author. Deleting a submitted
    record removes it from both panels and removes its evidence as well."""
    state = record.get("verification_status")
    if not can_delete(record, user):
        if user.get("role") == "event_manager":
            raise _conflict("A record waiting for the Dean, or verified by the Dean, cannot be deleted.")
        raise _conflict("Only a draft or a rejected record can be deleted.")

    _delete_record_permanently(record, user)


def _delete_record_permanently(record: dict, user: dict) -> None:
    """Permanently remove one record and its stored evidence after a state check."""
    state = record.get("verification_status")
    # Filtered on the state that was checked, so a record decided meanwhile
    # is not deleted out from under the author or Dean.
    result = research_records.delete_one({"_id": record["_id"], "verification_status": state})
    if not result.deleted_count:
        raise _conflict("This record was changed by someone else. Reload it to see their changes.")
    for entry in record.get("evidence") or []:
        delete_stored(entry)

    if state != "draft":
        log_audit_event(
            actor=user,
            action="research_deleted",
            target_type="research_record",
            target_id=str(record["_id"]),
            details={"title": record.get("title"), "category": record.get("category"),
                     "faculty_id": record.get("faculty_id"), "status": state},
        )
    if record.get("faculty_id") and record.get("faculty_id") != user.get("id"):
        _notify(
            record.get("faculty_id"),
            "research_removed",
            "Research removed from your portfolio",
            f'{_who(user)} deleted "{record.get("title")}" from your research portfolio.',
            record,
        )


@router.post("/research/records/{record_id}/flag")
def flag_record(
    record_id: str,
    payload: CorrectionFlagRequest,
    request: Request,
    authorization: str | None = Header(default=None),
):
    """The faculty member tells whoever entered the record that it is wrong."""
    user = _author(authorization)
    record = _find_for_author(record_id, user)
    if user.get("role") != "teacher" or record.get("created_by") == user["id"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the faculty member can flag a record someone else entered for them.",
        )

    research_records.update_one(
        {"_id": record["_id"]},
        {
            "$set": {"updated_at": utc_now()},
            "$push": {
                "history": new_history_entry(
                    action="correction_flagged",
                    status=record.get("verification_status"),
                    actor=user,
                    note=payload.note,
                )
            },
        },
    )
    _notify(
        record.get("created_by"),
        "research_flagged",
        "Correction requested on a research record",
        f'{_who(user)} says "{record.get("title")}" needs a correction: {payload.note}',
        record,
    )
    return {
        "success": True,
        "message": "Correction sent",
        "record": _present_one(request, _reload(record), user),
    }


# ------------------------------------------------------------ evidence

def _inspect_evidence(upload: UploadFile) -> dict:
    extension = os.path.splitext(upload.filename or "")[1].lower()
    if extension not in EVIDENCE_EXTENSIONS:
        raise _bad_request("Evidence must be a PDF, or a JPG, PNG or WebP image.")
    if extension == ".pdf":
        info = inspect_document(upload)
    else:
        info = inspect_media(upload)
        if info.get("kind") != "image":
            raise _bad_request("Evidence must be a PDF, or a JPG, PNG or WebP image.")
    return {"extension": extension, "content_type": info["content_type"]}


def _evidence_bytes(record: dict) -> int:
    return sum(int(entry.get("file_size") or 0) for entry in record.get("evidence") or [])


@router.post("/research/records/{record_id}/evidence", status_code=status.HTTP_201_CREATED)
def add_evidence(
    record_id: str,
    request: Request,
    file: UploadFile = File(...),
    tag: str = Form(default="Other"),
    authorization: str | None = Header(default=None),
):
    user = _author(authorization)
    record = _find_for_author(record_id, user)
    category = _category_or_400(record.get("category"))

    label = " ".join((tag or "").split()) or "Other"
    if label not in category.evidence_tags:
        raise _bad_request(f"“{label}” is not a kind of evidence for this record.")

    limits = evidence_limits()
    max_files = limits["max_evidence_files"]
    max_bytes = limits["max_evidence_total_bytes"]
    max_mb = limits["max_evidence_total_mb"]
    if len(record.get("evidence") or []) >= max_files:
        raise _bad_request(f"A record can carry at most {max_files} evidence files. Remove one first.")
    remaining = max_bytes - _evidence_bytes(record)
    if remaining <= 0:
        raise _bad_request(
            f"This record's evidence already uses its {max_mb} MB. Remove a file first."
        )

    info = _inspect_evidence(file)
    buffer, size = stream_upload(file, remaining, what="Evidence")
    try:
        check_file_signature(info["extension"], peek_head(buffer))
        file_name = (file.filename or "evidence").strip()[:255] or "evidence"
        stored = save_upload(
            buffer,
            file_name=file_name,
            content_type=info["content_type"],
            kind="evidence",
            event_id=f"research-{record['_id']}",
            teacher_id=record.get("faculty_id") or user["id"],
        )
    finally:
        buffer.close()

    entry = new_research_evidence(
        tag=label,
        file_name=file_name,
        content_type=info["content_type"],
        file_size=size,
        stored=stored,
        uploaded_by=user,
    )

    changes: dict = {"updated_at": utc_now()}
    action = "evidence_added"
    keep = _keeps_acceptance(record, user)
    if record.get("verification_status") == "verified" and not keep:
        _send_back_if_verified(record, changes)
        action = "reverification"
    history = new_history_entry(
        action=action,
        status=changes.get("verification_status", record.get("verification_status")),
        from_status=record.get("verification_status"),
        actor=user,
        note=f"{label}: {file_name}",
    )
    # The count is checked again in the write itself, so two uploads racing
    # for the last slot cannot both land.
    result = research_records.update_one(
        {"_id": record["_id"], f"evidence.{max_files - 1}": {"$exists": False}},
        {"$push": {"evidence": entry, "history": history}, "$set": changes},
    )
    if not result.matched_count:
        delete_stored(entry)
        raise _bad_request(f"A record can carry at most {max_files} evidence files. Remove one first.")

    # And the combined size after the write, for the same reason: whichever
    # upload pushed the record over its budget is the one taken back out.
    if keep:
        _refresh_snapshot(record)
    _settle_for_manager(record)
    fresh = _reload(record)
    if _evidence_bytes(fresh) > max_bytes:
        research_records.update_one({"_id": record["_id"]}, {"$pull": {"evidence": {"id": entry["id"]}}})
        delete_stored(entry)
        raise _bad_request(
            f"That file would take this record's evidence past {max_mb} MB."
        )

    if action == "reverification":
        _notify_deans(
            record,
            title="Verified research updated",
            message=f'{_who(user)} added evidence to the verified record "{record.get("title")}"; it needs verifying again.',
        )

    return {
        "success": True,
        "message": "Evidence attached",
        "record": _present_one(request, fresh, user),
    }


@router.delete("/research/records/{record_id}/evidence/{evidence_id}")
def remove_evidence(
    record_id: str,
    evidence_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
):
    user = _author(authorization)
    record = _find_for_author(record_id, user)
    evidence = record.get("evidence") or []
    entry = next((item for item in evidence if item.get("id") == evidence_id), None)
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evidence file not found")

    state = record.get("verification_status")

    changes: dict = {"updated_at": utc_now()}
    action = "evidence_removed"
    keep = _keeps_acceptance(record, user)
    if state == "verified" and not keep:
        _send_back_if_verified(record, changes)
        action = "reverification"
    research_records.update_one(
        {"_id": record["_id"]},
        {
            "$pull": {"evidence": {"id": evidence_id}},
            "$push": {
                "history": new_history_entry(
                    action=action,
                    status=changes.get("verification_status", state),
                    from_status=state,
                    actor=user,
                    note=f"Removed {entry.get('tag')}: {entry.get('file_name')}",
                )
            },
            "$set": changes,
        },
    )
    delete_stored(entry)
    if keep:
        _refresh_snapshot(record)
    _settle_for_manager(record)

    if action == "reverification":
        _notify_deans(
            record,
            title="Verified research updated",
            message=f'{_who(user)} removed evidence from the verified record "{record.get("title")}"; it needs verifying again.',
        )

    return {
        "success": True,
        "message": "Evidence removed",
        "record": _present_one(request, _reload(record), user),
    }


# ============================================================
# DEAN
# ============================================================

DEAN_VISIBLE = {"verification_status": {"$ne": "draft"}, "manager_removed_at": None}
DEAN_STATUSES = tuple(s for s in RESEARCH_VERIFICATION_STATUSES if s != "draft")

# What the Event Manager submitted: shown to the Dean as it is, in its own
# list, with no verification status. The verification lists leave it out.
MANAGER_SUBMISSIONS = "event_manager"
FROM_MANAGER = {
    "verification_status": "verified",
    "verified_by.role": "event_manager",
    "manager_removed_at": None,
}
NOT_FROM_MANAGER = {"verified_by.role": {"$ne": "event_manager"}, "manager_removed_at": None}


def dean_status_query(wanted: str) -> dict:
    """The Dean's list filter for a tab: a verification status (without the
    Event Manager's submissions), the Event Manager's submissions, or all."""
    if wanted == "all":
        return dict(DEAN_VISIBLE)
    if wanted == MANAGER_SUBMISSIONS:
        return dict(FROM_MANAGER)
    if wanted not in DEAN_STATUSES:
        raise _bad_request("Unknown status filter.")
    return {"verification_status": wanted, **NOT_FROM_MANAGER}


def _dean_counts(base: dict) -> dict:
    counts = {
        key: research_records.count_documents({**base, **dean_status_query(key)})
        for key in (*DEAN_STATUSES, MANAGER_SUBMISSIONS)
    }
    counts["all"] = sum(counts.values())
    return counts


@router.get("/dean/research/records")
def dean_list_records(
    request: Request,
    authorization: str | None = Header(default=None),
    status_filter: str | None = Query(default="submitted", alias="status", max_length=30),
    category: str | None = Query(default=None, max_length=30),
    academic_year: str | None = Query(default=None, max_length=10),
    faculty_id: str | None = Query(default=None, max_length=40),
    q: str | None = Query(default=None, max_length=200),
    start_date: str | None = Query(default=None, max_length=10),
    end_date: str | None = Query(default=None, max_length=10),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=25, ge=1, le=100),
):
    user = _dean(authorization)
    base: dict = {}
    _apply_filters(base, category=category, academic_year=academic_year, faculty_id=faculty_id)
    apply_date_range(base, start_date, end_date)
    search = _search_clause(q, include_people=True)
    if search:
        base.update(search)

    counts = _dean_counts(base)

    wanted = (status_filter or "all").strip().lower()
    query = {**base, **dean_status_query(wanted)}

    # The queue is worked oldest first; the Event Manager's submissions by
    # research date, newest first; everything else newest change first.
    if wanted == "submitted":
        sort = [("submitted_at", ASCENDING)]
    elif wanted == MANAGER_SUBMISSIONS:
        sort = [("record_date", DESCENDING), ("updated_at", DESCENDING)]
    else:
        sort = [("updated_at", DESCENDING)]
    total = research_records.count_documents(query)
    records = list(_page(research_records.find(query).sort(sort), skip, limit))
    items = _present(request, records, user)
    return {
        "success": True,
        "records": items,
        "total": total,
        "count": len(items),
        "has_more": skip + len(items) < total,
        "skip": skip,
        "limit": limit,
        "counts": counts,
        "academic_years": _academic_years(DEAN_VISIBLE),
    }


@router.get("/dean/research/summary")
def dean_research_summary(
    authorization: str | None = Header(default=None),
    include_pending: bool = Query(default=False),
):
    """Counts for the Dean's research overview.

    Verified records only by default, so the numbers can be quoted; with
    ``include_pending`` the ones waiting for verification count too.
    """
    _dean(authorization)
    counted = ("verified", "submitted") if include_pending else ("verified",)
    rows = research_records.find(
        {"verification_status": {"$in": list(counted)}, "manager_removed_at": None},
        {"category": 1, "outcome_status": 1, "academic_year": 1},
    )
    by_category: dict[str, int] = {}
    patents: dict[str, int] = {}
    for row in rows:
        key = row.get("category") or "other"
        by_category[key] = by_category.get(key, 0) + 1
        if key == "patent":
            outcome = row.get("outcome_status") or "filed"
            patents[outcome] = patents.get(outcome, 0) + 1

    return {
        "success": True,
        "include_pending": include_pending,
        "counts": _dean_counts({}),
        "by_category": by_category,
        "patents": patents,
    }


@router.get("/dean/research/overview")
def dean_research_overview(
    authorization: str | None = Header(default=None),
    category: str | None = Query(default=None, max_length=30),
    academic_year: str | None = Query(default=None, max_length=10),
    q: str | None = Query(default=None, max_length=200),
    start_date: str | None = Query(default=None, max_length=10),
    end_date: str | None = Query(default=None, max_length=10),
    faculty_id: str | None = Query(default=None, max_length=40),
):
    """The Dean's figures for the research the Event Manager has submitted,
    under the page's filters: how many records, from how many faculty, the
    journal papers and the patent pipeline -- and the count
    per category (ignoring the category filter, so every chip keeps its count)."""
    _dean(authorization)
    base: dict = dict(FROM_MANAGER)
    _apply_filters(base, category=None, academic_year=academic_year, faculty_id=faculty_id)
    apply_date_range(base, start_date, end_date)
    search = _search_clause(q, include_people=True)
    if search:
        base.update(search)
    wanted = _category_or_400(category).key if category else None

    by_category: dict[str, int] = {}
    chosen: list[dict] = []
    for row in research_records.find(base, {"category": 1, "outcome_status": 1, "faculty_id": 1, "co_faculty_ids": 1}):
        key = row.get("category") or "other"
        by_category[key] = by_category.get(key, 0) + 1
        if not wanted or key == wanted:
            chosen.append(row)

    patents: dict[str, int] = {}
    for row in chosen:
        if row.get("category") == "patent":
            outcome = row.get("outcome_status") or "filed"
            patents[outcome] = patents.get(outcome, 0) + 1

    return {
        "success": True,
        "total": len(chosen),
        "faculty_count": len({fid for row in chosen for fid in authors_of(row)}),
        "journal_papers": sum(1 for row in chosen if row.get("category") == "journal"),
        "patents": patents,
        "by_category": by_category,
        "academic_years": _academic_years(FROM_MANAGER),
    }


@router.get("/dean/research/records/{record_id}")
def dean_get_record(record_id: str, request: Request, authorization: str | None = Header(default=None)):
    user = _dean(authorization)
    record = _find_for_dean(record_id)
    return {"success": True, "record": _present_one(request, record, user)}


# What each Dean action may act on, and what to say when it cannot -- the
# research twin of DEAN_VERBS in routers/events.py.
RESEARCH_VERBS = {
    "verify": (("submitted",), "Only a record waiting for verification can be verified."),
    "request changes": (("submitted",), "Changes can only be requested on a record waiting for verification."),
    "reject": (("submitted",), "Only a record waiting for verification can be rejected."),
    "unverify": (("verified",), "Only a verified record can have its verification withdrawn."),
}


def research_transition(
    record_id: str,
    *,
    verb: str,
    changes: dict,
    history_action: str,
    new_status: str,
    user: dict,
    note: str | None = None,
) -> dict:
    """Move a record to `new_status`, atomically (see dean_transition)."""
    record = _find_for_dean(record_id)
    if user.get("id") in (record.get("faculty_id"), record.get("created_by")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This is your own research record, so another Dean has to decide on it.",
        )

    current = record.get("verification_status")
    if verb != "unverify" and waiting_on_manager(record):
        raise _conflict("The Event Manager has handled this record, so it is recorded without a Dean decision.")
    if verb == "unverify" and (recorded_by_manager(record) or handled_by_manager(record)):
        raise _conflict("This record was recorded by the Event Manager without Dean verification, so there is nothing to withdraw.")
    allowed_from, message = RESEARCH_VERBS[verb]
    if current not in allowed_from:
        if verb == "verify" and current == "verified":
            raise _conflict("This record is already verified.")
        if verb == "reject" and current == "rejected":
            raise _conflict("This record has already been rejected.")
        raise _conflict(message)

    now = utc_now()
    result = research_records.update_one(
        {"_id": record["_id"], "verification_status": current},
        {
            "$set": {**changes, "verification_status": new_status, "updated_at": now},
            "$push": {
                "history": new_history_entry(
                    action=history_action,
                    status=new_status,
                    from_status=current,
                    actor=user,
                    note=note,
                )
            },
        },
    )
    if not result.matched_count:
        raise _conflict("This record was updated by someone else. Please reload it.")

    log_audit_event(
        actor=user,
        action=f"research_{history_action}",
        target_type="research_record",
        target_id=str(record["_id"]),
        details={"title": record.get("title"), "category": record.get("category"), "faculty_id": record.get("faculty_id")},
    )
    return _reload(record)


def _decide(
    record_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    user: dict,
    *,
    verb: str,
    new_status: str,
    history_action: str,
    decision: str,
    title: str,
    sentence: str,
    remarks: str | None,
    message: str,
) -> dict:
    changes: dict = {"dean_remarks": remarks}
    if verb == "verify":
        record = _find_for_dean(record_id)
        changes.update(
            verified_at=utc_now(),
            verified_by={"id": user.get("id"), "name": user.get("name") or user.get("email")},
            verified_snapshot=_snapshot(record),
        )
    updated = research_transition(
        record_id,
        verb=verb,
        changes=changes,
        history_action=history_action,
        new_status=new_status,
        user=user,
        note=remarks,
    )
    _notify_people(
        background_tasks,
        updated,
        decision=decision,
        title=title,
        message=f'"{updated.get("title")}" {sentence}' + (f" Remarks: {remarks}" if remarks else ""),
        remarks=remarks,
        actor=user,
    )
    return {"success": True, "message": message, "record": _present_one(request, updated, user)}


@router.patch("/dean/research/records/{record_id}/verify")
def verify_record(
    record_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    payload: DeanRemarksRequest | None = None,
    authorization: str | None = Header(default=None),
):
    user = _dean(authorization)
    return _decide(
        record_id, request, background_tasks, user,
        verb="verify", new_status="verified", history_action="verified",
        decision="research_verified", title="Research verified",
        sentence="has been verified by the Dean.",
        remarks=payload.remarks if payload else None,
        message="Research record verified",
    )


@router.patch("/dean/research/records/{record_id}/request-changes")
def request_record_changes(
    record_id: str,
    payload: RequiredRemarksRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
):
    user = _dean(authorization)
    return _decide(
        record_id, request, background_tasks, user,
        verb="request changes", new_status="changes_requested", history_action="changes_requested",
        decision="research_changes", title="Research needs changes",
        sentence="needs a correction before it can be verified.",
        remarks=payload.remarks,
        message="Changes requested",
    )


@router.patch("/dean/research/records/{record_id}/reject")
def reject_record(
    record_id: str,
    payload: RequiredRemarksRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
):
    user = _dean(authorization)
    return _decide(
        record_id, request, background_tasks, user,
        verb="reject", new_status="rejected", history_action="rejected",
        decision="research_rejected", title="Research rejected",
        sentence="was not accepted by the Dean.",
        remarks=payload.remarks,
        message="Research record rejected",
    )


@router.patch("/dean/research/records/{record_id}/unverify")
def unverify_record(
    record_id: str,
    payload: RequiredRemarksRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
):
    user = _dean(authorization)
    return _decide(
        record_id, request, background_tasks, user,
        verb="unverify", new_status="changes_requested", history_action="unverified",
        decision="research_unverified", title="Research verification withdrawn",
        sentence="had its verification withdrawn and needs a correction.",
        remarks=payload.remarks,
        message="Verification withdrawn",
    )


@router.post("/dean/research/bulk-verify")
def bulk_verify(
    payload: ResearchBulkVerifyRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
):
    """Verify several records at once. Each is decided on its own: one that
    cannot be verified (already decided, or the Dean's own) is reported back
    and does not stop the rest."""
    user = _dean(authorization)
    verified: list[str] = []
    failed: list[dict] = []
    for record_id in dict.fromkeys(payload.ids):
        try:
            _decide(
                record_id, request, background_tasks, user,
                verb="verify", new_status="verified", history_action="verified",
                decision="research_verified", title="Research verified",
                sentence="has been verified by the Dean.",
                remarks=None,
                message="",
            )
            verified.append(record_id)
        except HTTPException as error:
            failed.append({"id": record_id, "detail": error.detail})
    return {
        "success": True,
        "message": f"{len(verified)} verified" + (f", {len(failed)} skipped" if failed else ""),
        "verified": verified,
        "failed": failed,
    }
